// Revisão automática do vídeo renderizado (V06, docs/PLANO_MESTRE_NIGHT.md).
// Código puro: nada aqui abre processo, banco ou rede por conta própria. Quem lê o
// arquivo é o executor injetado em runReview (ffprobe/ffmpeg neste PC, falso nos testes).
//
// A revisão acontece antes de o vídeo chegar ao Joel. Dois níveis, como no manifesto:
// - FALHA impede a entrega: vídeo/áudio ausente, duração contra a real informada,
//   resolução ou codec errados, trecho contínuo de silêncio no meio;
// - AVISO não impede, mas precisa aparecer: os mesmos avisos do manifesto, as pendências
//   do render final e a identificação de conteúdo realista gerado por IA, que o YouTube
//   pode exigir na publicação.
// Silêncio no fim é tolerado de propósito: vídeos costumam fechar com fade ou cauda.

import type { FormatoVideo } from './brief.ts';
import { readyForFinalRender, validateManifest, type VideoManifest } from './manifest.ts';

/** Resultado da leitura do ffprobe, já normalizado. */
export interface ProbeInfo {
  durationSec: number;
  width: number;
  height: number;
  hasVideo: boolean;
  hasAudio: boolean;
  videoCodec: string | null;
  audioCodec: string | null;
  /** Quadros por segundo; null quando o ffprobe não informa. */
  fps: number | null;
}

/** Trecho de silêncio contínuo medido pelo filtro silencedetect. */
export interface SilenceSpan {
  start: number;
  end: number;
}

export interface ReviewOptions {
  /** Prévia: aceita a metade da resolução do formato, além da resolução cheia. */
  preview?: boolean;
  silenceSpans?: SilenceSpan[];
  /**
   * Soma das durações do RenderPlan, que vêm do áudio real. Sem ele a comparação usa
   * a estimativa do texto, que pode divergir da voz e só rende aviso.
   */
  expectedDurationSec?: number;
}

/** runReview monta o ReviewOptions por dentro; aqui só o que o chamador informa. */
export interface RunReviewOptions {
  /** Prévia: aceita a metade da resolução do formato, além da resolução cheia. */
  preview?: boolean;
  expectedDurationSec?: number;
}

export interface ReviewResult {
  ok: boolean;
  falhas: string[];
  avisos: string[];
}

export interface ReviewSummary {
  /** Texto curto para a voz. */
  voz: string;
  /** Lista completa para a tela, com o nível em cada linha. */
  tela: string[];
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Executor injetável: nos testes devolve saídas falsas, no PC roda o binário de verdade. */
export type RunCommand = (bin: string, args: string[]) => Promise<RunResult>;

const RESOLUCAO_POR_FORMATO: Record<FormatoVideo, { width: number; height: number }> = {
  vertical: { width: 1080, height: 1920 },
  horizontal: { width: 1920, height: 1080 },
};

const TOLERANCIA_DURACAO = 0.1;
const MIN_SILENCIO_FALHA_SEG = 3;
/** Folga para considerar um silêncio "no fim" (o ffprobe e o ffmpeg arredondam). */
const TOLERANCIA_FIM_SEG = 0.5;
const CODEC_VIDEO = 'h264';
const CODEC_AUDIO = 'aac';
const AVISO_IA = 'marcar conteúdo gerado por IA ao publicar (YouTube exige para cenas realistas)';

/** Argumentos do ffprobe: lê formato e streams em JSON, sem barulho no stderr. */
export function probeArgs(file: string): string[] {
  return ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file];
}

/**
 * Argumentos do ffmpeg para medir silêncio. O silencedetect escreve no stderr em nível
 * de informação; por isso não se usa "-v error" aqui, senão o trecho não apareceria.
 */
export function silencedetectArgs(file: string): string[] {
  return ['-hide_banner', '-nostats', '-i', file, '-af', 'silencedetect=noise=-40dB:d=1', '-f', 'null', '-'];
}

/** Objeto simples: sem array, sem null e sem classe — só o que vem do JSON. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** "30000/1001" -> 29.97; null quando a taxa não é utilizável. */
function taxaDeQuadros(valor: unknown): number | null {
  if (typeof valor !== 'string') return null;
  const [numerador, denominador] = valor.split('/');
  const cima = Number(numerador);
  const baixo = denominador === undefined ? 1 : Number(denominador);
  if (!Number.isFinite(cima) || !Number.isFinite(baixo) || baixo === 0) return null;
  const fps = cima / baixo;
  if (!Number.isFinite(fps) || fps <= 0) return null;
  return Math.round(fps * 1000) / 1000;
}

/**
 * Lê a saída JSON do ffprobe. JSON inválido ou sem lista de streams lança erro:
 * revisar um vídeo que não foi lido seria pior do que parar.
 */
export function parseProbe(json: string): ProbeInfo {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error('saída do ffprobe inválida: não é JSON');
  }
  if (!isPlainObject(raw)) throw new Error('saída do ffprobe inválida: esperava um objeto');
  const streams = raw.streams;
  if (!Array.isArray(streams)) throw new Error('saída do ffprobe inválida: sem lista de streams');

  const lista = streams.filter(isPlainObject);
  const video = lista.find((s) => s.codec_type === 'video');
  const audio = lista.find((s) => s.codec_type === 'audio');
  const formato = isPlainObject(raw.format) ? raw.format : {};

  const duracao = Number(formato.duration ?? video?.duration);

  return {
    durationSec: duracao,
    width: typeof video?.width === 'number' ? video.width : 0,
    height: typeof video?.height === 'number' ? video.height : 0,
    hasVideo: video !== undefined,
    hasAudio: audio !== undefined,
    videoCodec: typeof video?.codec_name === 'string' ? video.codec_name : null,
    audioCodec: typeof audio?.codec_name === 'string' ? audio.codec_name : null,
    fps: taxaDeQuadros(video?.r_frame_rate),
  };
}

/** Remove repetições preservando a ordem: aviso e pendência podem descrever o mesmo fato. */
function semRepetir(itens: string[]): string[] {
  return [...new Set(itens)];
}

/** Segundos curtos para mensagem: uma casa decimal, vírgula em português. */
function segundos(valor: number): string {
  return String(Math.round(valor * 10) / 10).replace('.', ',');
}

/** Última linha útil de um erro de binário, sem despejar o log inteiro. */
function erroCurto(texto: string, max = 160): string {
  const linhas = texto.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '');
  const ultima = linhas.length > 0 ? linhas[linhas.length - 1]! : 'sem mensagem';
  return ultima.length <= max ? ultima : ultima.slice(0, max - 1) + '…';
}

/** Avisos e falhas que vêm do próprio manifesto, antes de olhar o arquivo. */
function problemasDoManifesto(manifest: VideoManifest): { falhas: string[]; avisos: string[] } {
  const validado = validateManifest(manifest);
  if (!validado.ok) {
    const detalhe = validado.errors.map((e) => `${e.campo}: ${e.problema}`).join('; ');
    return { falhas: [`manifesto inválido: ${detalhe}`], avisos: [] };
  }
  const avisos = [...validado.avisos, ...readyForFinalRender(validado.manifest).pendencias];
  if (validado.manifest.cenas.some((c) => c.realistaGeradaPorIA)) avisos.push(AVISO_IA);
  return { falhas: [], avisos: semRepetir(avisos) };
}

/**
 * Confere o vídeo renderizado contra o manifesto e devolve falhas e avisos.
 * `opts.preview` aceita metade da resolução; `opts.silenceSpans` vem do silencedetect;
 * `opts.expectedDurationSec` é a duração real esperada (sem ele, usa a estimativa do texto).
 */
export function reviewRender(
  probe: ProbeInfo,
  manifest: VideoManifest,
  opts: ReviewOptions = {},
): ReviewResult {
  const doManifesto = problemasDoManifesto(manifest);
  const falhas = [...doManifesto.falhas];
  const avisos = [...doManifesto.avisos];

  if (!probe.hasVideo) {
    falhas.push('sem vídeo na saída renderizada');
  } else {
    if ((probe.videoCodec ?? '').toLowerCase() !== CODEC_VIDEO) {
      falhas.push(`codec de vídeo ${probe.videoCodec ?? 'desconhecido'}; esperava h264`);
    }
    const alvo = RESOLUCAO_POR_FORMATO[manifest.brief.formato];
    const aceitas = [{ width: alvo.width, height: alvo.height }];
    if (opts.preview) aceitas.push({ width: alvo.width / 2, height: alvo.height / 2 });
    if (!aceitas.some((r) => r.width === probe.width && r.height === probe.height)) {
      const esperado = aceitas.map((r) => `${r.width}x${r.height}`).join(' ou ');
      falhas.push(
        `resolução ${probe.width}x${probe.height} diferente do formato ${manifest.brief.formato} (esperado ${esperado})`,
      );
    }
  }

  if (!probe.hasAudio) {
    falhas.push('sem áudio na saída renderizada');
  } else if ((probe.audioCodec ?? '').toLowerCase() !== CODEC_AUDIO) {
    falhas.push(`codec de áudio ${probe.audioCodec ?? 'desconhecido'}; esperava aac`);
  }

  const cenas = Array.isArray(manifest.cenas) ? manifest.cenas : [];
  const somaCenas = cenas.reduce((total, cena) => total + cena.duracaoEstimadaSeg, 0);
  const esperado = opts.expectedDurationSec;
  if (esperado !== undefined && (!Number.isFinite(esperado) || esperado <= 0)) {
    throw new Error(`expectedDurationSec inválido: ${esperado}`);
  }
  if (esperado !== undefined || cenas.length > 0) {
    const referencia = esperado ?? somaCenas;
    const rotulo = esperado !== undefined ? 'da duração esperada' : 'da soma das cenas';
    if (!Number.isFinite(probe.durationSec)) {
      falhas.push('duração do vídeo não informada pelo ffprobe');
    } else {
      const minimo = referencia * (1 - TOLERANCIA_DURACAO);
      const maximo = referencia * (1 + TOLERANCIA_DURACAO);
      if (probe.durationSec < minimo || probe.durationSec > maximo) {
        const mensagem = `duração ${segundos(probe.durationSec)}s fora de ±10% ${rotulo} (${segundos(referencia)}s)`;
        if (esperado !== undefined) {
          // O render segue o áudio: a referência informada é a duração real da narração.
          falhas.push(mensagem);
        } else {
          // Estimativa do texto pode divergir da voz; sem a duração real, só avisa.
          avisos.push(`${mensagem}; duração comparada com estimativa do texto`);
        }
      }
    }
  }

  for (const trecho of opts.silenceSpans ?? []) {
    const duracao = trecho.end - trecho.start;
    if (!(duracao > MIN_SILENCIO_FALHA_SEG)) continue;
    // Silêncio que termina junto com o arquivo é cauda normal, não trecho vazio.
    const noFim = !Number.isFinite(trecho.end) ||
      (Number.isFinite(probe.durationSec) && probe.durationSec - trecho.end <= TOLERANCIA_FIM_SEG);
    if (noFim) continue;
    falhas.push(`silêncio de ${segundos(duracao)}s em ${segundos(trecho.start)}s (trecho vazio no meio do vídeo)`);
  }

  return { ok: falhas.length === 0, falhas, avisos };
}

/**
 * Lê silence_start/silence_end do stderr do ffmpeg. Trecho que começa e não fecha
 * (silêncio até o fim do arquivo) fica com end Infinity.
 */
export function parseSilence(stderr: string): SilenceSpan[] {
  const spans: SilenceSpan[] = [];
  let aberto: number | null = null;
  for (const linha of stderr.split(/\r?\n/)) {
    const inicio = /silence_start:\s*(-?\d+(?:\.\d+)?)/.exec(linha);
    const fim = /silence_end:\s*(-?\d+(?:\.\d+)?)/.exec(linha);
    if (inicio) aberto = Math.max(0, Number(inicio[1]));
    if (fim) {
      if (aberto === null) continue;
      spans.push({ start: aberto, end: Math.max(0, Number(fim[1])) });
      aberto = null;
    }
  }
  if (aberto !== null) spans.push({ start: aberto, end: Number.POSITIVE_INFINITY });
  return spans;
}

/**
 * Roda ffprobe e silencedetect pelo executor injetado e devolve a revisão.
 * Falha de ferramenta não vira exceção: vira falha da revisão, com o motivo na frente.
 * `opts.preview` aceita metade da resolução (prévia) e `opts.expectedDurationSec` é a
 * soma das durações do RenderPlan (do áudio real).
 */
export async function runReview(
  file: string,
  manifest: VideoManifest,
  run: RunCommand,
  opts: RunReviewOptions = {},
): Promise<ReviewResult> {
  const avisosDoManifesto = problemasDoManifesto(manifest).avisos;

  const saidaProbe = await run('ffprobe', probeArgs(file));
  if (saidaProbe.code !== 0) {
    return {
      ok: false,
      falhas: [`ffprobe não conseguiu ler o vídeo (código ${saidaProbe.code}): ${erroCurto(saidaProbe.stderr)}`],
      avisos: avisosDoManifesto,
    };
  }

  let probe: ProbeInfo;
  try {
    probe = parseProbe(saidaProbe.stdout);
  } catch (erro) {
    const motivo = erro instanceof Error ? erro.message : 'saída desconhecida';
    return { ok: false, falhas: [motivo], avisos: avisosDoManifesto };
  }

  // Sem áudio não há silêncio a medir; a falta de áudio já é falha do reviewRender.
  let silenceSpans: SilenceSpan[] = [];
  let avisoSilencio: string | null = null;
  if (probe.hasAudio) {
    const saidaSilencio = await run('ffmpeg', silencedetectArgs(file));
    if (saidaSilencio.code === 0) silenceSpans = parseSilence(saidaSilencio.stderr);
    else avisoSilencio = `não foi possível medir silêncios (ffmpeg código ${saidaSilencio.code})`;
  }

  const resultado = reviewRender(probe, manifest, {
    silenceSpans,
    ...(opts.preview !== undefined ? { preview: opts.preview } : {}),
    ...(opts.expectedDurationSec !== undefined ? { expectedDurationSec: opts.expectedDurationSec } : {}),
  });
  if (avisoSilencio !== null) resultado.avisos = semRepetir([...resultado.avisos, avisoSilencio]);
  return resultado;
}

/** Texto curto para a voz e lista completa para a tela. */
export function summarizeForJoel(result: ReviewResult): ReviewSummary {
  const nFalhas = result.falhas.length;
  const nAvisos = result.avisos.length;
  const avisosTexto = nAvisos === 0 ? 'nenhum aviso' : nAvisos === 1 ? '1 aviso' : `${nAvisos} avisos`;
  const falhasTexto = nFalhas === 0 ? 'nenhuma falha' : nFalhas === 1 ? '1 falha' : `${nFalhas} falhas`;
  const correcao = nFalhas > 0 ? ' Corrigir antes de publicar.' : '';
  return {
    voz: `Vídeo conferido: ${avisosTexto}, ${falhasTexto}.${correcao}`,
    tela: [
      ...result.falhas.map((falha) => `Falha: ${falha}`),
      ...result.avisos.map((aviso) => `Aviso: ${aviso}`),
    ],
  };
}
