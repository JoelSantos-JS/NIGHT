// Renderizador determinístico de vídeo com FFmpeg (V05, docs/PLANO_MESTRE_NIGHT.md).
// Código puro: recebe o manifesto de cenas e os caminhos dos assets e devolve um plano
// verificável (resolução, duração por cena, SRT e argumentos do FFmpeg). O processo é
// injetável para testar sem rodar o FFmpeg de verdade.
//
// Escolhas que importam para o resultado ser reproduzível:
// - o áudio manda na duração da cena; sem áudio, usa a estimativa do manifesto;
// - cena sem imagem é erro: o render não inventa imagem;
// - o zoompan é calculado a partir do número da cena (par/ímpar), então o mesmo
//   manifesto gera o mesmo vídeo, sem sorte nem estado escondido;
// - os argumentos vão em array (spawn sem shell): nada de aspas manuais em caminhos.

import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { FormatoVideo } from './brief.ts';
import type { Scene, VideoManifest } from './manifest.ts';

export const FPS_RENDER = 30 as const;
/** Zoom máximo do movimento leve de câmera: 1.0 → 1.06 ao longo da cena. */
export const ZOOM_MAX = 1.06;
/** Limite de caracteres por linha de legenda (cabe na tela sem encolher demais). */
export const MAX_LINHA_LEGENDA = 42;
/** No máximo duas linhas por bloco de legenda; acima disso, a cena vira vários blocos. */
export const MAX_LINHAS_BLOCO = 2;

export interface RenderScene {
  n: number;
  imagePath: string;
  audioPath: string | null;
  durationSec: number;
  caption: string;
}

export interface RenderPlan {
  width: number;
  height: number;
  fps: 30;
  scenes: RenderScene[];
  outPath: string;
  subtitlesPath: string;
  preview: boolean;
}

/** Fontes de assets do job; o manifesto só guarda a referência, não o caminho. */
export interface RenderAssets {
  imagePathFor(n: number): string;
  audioFor(n: number): { path: string; durationSec: number } | null;
}

export interface PlanRenderOptions {
  outDir: string;
  preview?: boolean;
  /** Templates programáticos do Remotion podem renderizar sem imagem importada por cena. */
  allowMissingImages?: boolean;
}

export interface RenderResult {
  outPath: string;
  durationSec: number;
  args: string[];
}

export type FfmpegRunner = (bin: string, args: string[]) => Promise<{ code: number; stderr: string }>;

export interface RenderVideoOptions {
  ffmpegBin?: string;
  /** Injetável nos testes; o padrão roda o FFmpeg de verdade. */
  run?: FfmpegRunner;
}

/** Formatos do briefing (V01) em pixels; a prévia usa metade da resolução. */
const RESOLUCOES: Record<FormatoVideo, { width: number; height: number }> = {
  vertical: { width: 1080, height: 1920 },
  horizontal: { width: 1920, height: 1080 },
};

/** Pega o caminho da imagem; cena sem imagem não vira tela preta por acidente. */
function imagePathDe(cena: Scene, assets: RenderAssets, allowMissingImages = false): string {
  let imagePath: string;
  try {
    imagePath = assets.imagePathFor(cena.n);
  } catch (error) {
    if (allowMissingImages) return '';
    const motivo = error instanceof Error ? error.message : String(error);
    throw new Error(`cena ${cena.n}: sem imagem para o render: ${motivo}`);
  }
  if (typeof imagePath !== 'string' || imagePath.trim() === '') {
    if (allowMissingImages) return '';
    throw new Error(`cena ${cena.n}: sem imagem para o render (o render não inventa imagem)`);
  }
  return imagePath;
}

/**
 * Monta o plano de render a partir do manifesto: formato do briefing define a resolução,
 * o áudio define a duração quando existe e a legenda é a própria narração.
 */
export function planRender(
  manifest: VideoManifest,
  assets: RenderAssets,
  opts: PlanRenderOptions,
): RenderPlan {
  const preview = opts.preview ?? false;
  const allowMissingImages = opts.allowMissingImages ?? false;
  const base = RESOLUCOES[manifest.brief.formato];
  const width = preview ? Math.round(base.width / 2) : base.width;
  const height = preview ? Math.round(base.height / 2) : base.height;

  const scenes: RenderScene[] = manifest.cenas.map((cena) => {
    const audio = assets.audioFor(cena.n);
    let durationSec = cena.duracaoEstimadaSeg;
    if (audio !== null) {
      // O áudio manda: a legenda e o corte da imagem acompanham a voz, não a estimativa.
      if (!Number.isFinite(audio.durationSec) || audio.durationSec <= 0) {
        throw new Error(`cena ${cena.n}: duração do áudio inválida`);
      }
      durationSec = audio.durationSec;
    }
    return {
      n: cena.n,
      imagePath: imagePathDe(cena, assets, allowMissingImages),
      audioPath: audio?.path ?? null,
      durationSec,
      caption: cena.narracao,
    };
  });

  // Nome fixo por job: o mesmo manifesto e o mesmo job reaproveitam os mesmos arquivos.
  const nome = preview ? `${manifest.jobId}-preview` : manifest.jobId;
  return {
    width,
    height,
    fps: FPS_RENDER,
    scenes,
    outPath: join(opts.outDir, `${nome}.mp4`),
    subtitlesPath: join(opts.outDir, `${nome}.srt`),
    preview,
  };
}

function contarPalavras(texto: string): number {
  const limpo = texto.trim();
  return limpo === '' ? 0 : limpo.split(/\s+/).length;
}

/** Quebra o texto em linhas de no máximo MAX_LINHA_LEGENDA, sem cortar palavra. */
export function wrapCaption(texto: string, max = MAX_LINHA_LEGENDA): string[] {
  const palavras = texto.trim().split(/\s+/).filter((p) => p !== '');
  const linhas: string[] = [];
  let atual = '';
  for (const palavra of palavras) {
    if (atual === '') {
      atual = palavra;
    } else if (atual.length + 1 + palavra.length <= max) {
      atual += ` ${palavra}`;
    } else {
      linhas.push(atual);
      atual = palavra;
    }
  }
  if (atual !== '') linhas.push(atual);
  return linhas;
}

interface BlocoLegenda {
  texto: string;
  palavras: number;
}

/**
 * Blocos de legenda de uma cena: até duas linhas por bloco. Quando a narração passa
 * disso, divide em blocos de duas linhas; o tempo de cada bloco é proporcional ao
 * número de palavras, para a legenda acompanhar a fala.
 */
function blocosDaCena(cena: RenderScene): BlocoLegenda[] {
  const linhas = wrapCaption(cena.caption);
  if (linhas.length === 0) return [];
  const blocos: BlocoLegenda[] = [];
  if (linhas.length <= MAX_LINHAS_BLOCO) {
    const texto = linhas.join('\n');
    blocos.push({ texto, palavras: contarPalavras(texto) });
    return blocos;
  }
  for (let i = 0; i < linhas.length; i += MAX_LINHAS_BLOCO) {
    const grupo = linhas.slice(i, i + MAX_LINHAS_BLOCO);
    const texto = grupo.join('\n');
    blocos.push({ texto, palavras: contarPalavras(texto) });
  }
  return blocos;
}

/** Formato SRT: HH:MM:SS,mmm (vírgula nos milissegundos). */
export function formatSrtTime(segundos: number): string {
  const totalMs = Math.round(segundos * 1000);
  const ms = totalMs % 1000;
  const totalSeg = Math.floor(totalMs / 1000);
  const s = totalSeg % 60;
  const m = Math.floor(totalSeg / 60) % 60;
  const h = Math.floor(totalSeg / 3600);
  const dois = (n: number): string => String(n).padStart(2, '0');
  return `${dois(h)}:${dois(m)}:${dois(s)},${String(ms).padStart(3, '0')}`;
}

/**
 * Gera o SRT com os tempos acumulados das cenas. Uma cena curta vira um bloco;
 * narração longa vira vários blocos dentro da mesma cena.
 */
export function buildSrt(plan: RenderPlan): string {
  const saida: string[] = [];
  let inicioCena = 0;
  let indice = 0;
  for (const cena of plan.scenes) {
    const blocos = blocosDaCena(cena);
    const totalPalavras = blocos.reduce((soma, b) => soma + b.palavras, 0);
    let palavrasAcumuladas = 0;
    for (const bloco of blocos) {
      const inicio = totalPalavras === 0
        ? inicioCena
        : inicioCena + cena.durationSec * (palavrasAcumuladas / totalPalavras);
      palavrasAcumuladas += bloco.palavras;
      const fim = totalPalavras === 0
        ? inicioCena + cena.durationSec
        : inicioCena + cena.durationSec * (palavrasAcumuladas / totalPalavras);
      indice += 1;
      saida.push(`${indice}\n${formatSrtTime(inicio)} --> ${formatSrtTime(fim)}\n${bloco.texto}`);
    }
    inicioCena += cena.durationSec;
  }
  return saida.length === 0 ? '' : `${saida.join('\n\n')}\n`;
}

/**
 * Escapa caminho para dentro do filtro do FFmpeg: o Windows vem com "\" e "C:",
 * e ":" separa opções do filtro, então vira "C\:/...". Aspas simples são recusadas
 * porque quebrariam a citação do valor; falhar é melhor que gerar comando errado.
 */
export function escapeFilterPath(caminho: string): string {
  if (caminho.includes("'")) {
    throw new Error(`caminho de legenda com aspas simples quebraria o filtro do FFmpeg: ${caminho}`);
  }
  return caminho.replace(/\\/g, '/').replace(/:/g, '\\:');
}

/** Segundos com 3 casas: evita ruído de ponto flutuante nos argumentos. */
function seg(segundos: number): string {
  return segundos.toFixed(3);
}

/**
 * Argumentos de um único comando FFmpeg: imagens em loop, voz (ou silêncio), zoompan
 * determinístico, concatenação, legendas queimadas e saída H.264/AAC para plataformas.
 */
export function buildFfmpegArgs(plan: RenderPlan): string[] {
  const n = plan.scenes.length;
  if (n === 0) throw new Error('plano sem cenas: nada para renderizar');

  const args: string[] = ['-y'];

  // Entradas de imagem: -framerate alinha o loop à taxa da saída (o padrão de 25 fps
  // encurtava o vídeo), -loop 1 segura o quadro e -t define o tempo da cena.
  for (const cena of plan.scenes) {
    if (cena.imagePath.trim() === '') {
      throw new Error(`cena ${cena.n}: sem imagem para o render FFmpeg`);
    }
    args.push('-framerate', String(plan.fps), '-loop', '1', '-t', seg(cena.durationSec), '-i', cena.imagePath);
  }
  // Uma entrada de áudio por cena, depois das imagens: WAV quando existe; silêncio
  // anullsrc com a duração da cena quando não existe, para o concat não desalinhar.
  for (const cena of plan.scenes) {
    if (cena.audioPath !== null) {
      args.push('-i', cena.audioPath);
    } else {
      args.push('-f', 'lavfi', '-t', seg(cena.durationSec), '-i', 'anullsrc=r=48000:cl=stereo');
    }
  }

  const filtros: string[] = [];
  const { width: w, height: h, fps } = plan;
  plan.scenes.forEach((cena, i) => {
    const quadros = Math.max(1, Math.round(cena.durationSec * fps));
    const passo = (ZOOM_MAX - 1) / quadros;
    // Cena ímpar aproxima (1.0 → 1.06); par afasta (1.06 → 1.0). Depende só da cena,
    // então o mesmo manifesto gera exatamente o mesmo movimento.
    const zoom = cena.n % 2 === 1
      ? `min(1+${passo.toFixed(8)}*on,${ZOOM_MAX})`
      : `max(${ZOOM_MAX}-${passo.toFixed(8)}*on,1)`;
    filtros.push(
      `[${i}:v]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},` +
      `zoompan=z='${zoom}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${w}x${h}:fps=${fps},setsar=1[v${i}]`,
    );
  });

  const videoEntradas = plan.scenes.map((_, i) => `[v${i}]`).join('');
  filtros.push(`${videoEntradas}concat=n=${n}:v=1:a=0[vconcat]`);
  // Legenda queimada no vídeo: o valor vai entre aspas simples (com o ":" escapado)
  // para o "C:" não ser lido como separador de opção do filtro.
  filtros.push(`[vconcat]subtitles='${escapeFilterPath(plan.subtitlesPath)}'[vout]`);

  // Áudio uniforme (48 kHz, estéreo) por cena e concatenação na mesma ordem do vídeo.
  const audioEntradas: string[] = [];
  plan.scenes.forEach((cena, i) => {
    const indice = n + i;
    filtros.push(
      `[${indice}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,` +
      `atrim=0:${seg(cena.durationSec)},asetpts=PTS-STARTPTS[a${i}]`,
    );
    audioEntradas.push(`[a${i}]`);
  });
  filtros.push(`${audioEntradas.join('')}concat=n=${n}:v=0:a=1[aout]`);

  args.push(
    '-filter_complex', filtros.join(';'),
    '-map', '[vout]',
    '-map', '[aout]',
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', '20',
    '-pix_fmt', 'yuv420p',
    '-r', String(fps),
    '-c:a', 'aac',
    '-b:a', '160k',
    '-movflags', '+faststart',
    plan.outPath,
  );
  return args;
}

/** Duração total do plano; é o que o arquivo final deve ter. */
function duracaoTotal(plan: RenderPlan): number {
  return plan.scenes.reduce((soma, cena) => soma + cena.durationSec, 0);
}

/** Fim do stderr, que é onde o FFmpeg explica o erro de verdade. */
function fimDoStderr(stderr: string, max = 2000): string {
  const limpo = stderr.trim();
  if (limpo === '') return 'sem stderr';
  return limpo.length <= max ? limpo : `…${limpo.slice(-max)}`;
}

/** Executa o FFmpeg sem shell; os argumentos vão em array, um a um. */
function runFfmpeg(bin: string, args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const filho = spawn(bin, args, { shell: false });
    let stderr = '';
    filho.stderr.setEncoding('utf8');
    filho.stderr.on('data', (trecho: string) => {
      stderr += trecho;
      // O começo do log é ruído; guardar só o fim evita memória crescida em render longo.
      if (stderr.length > 64_000) stderr = stderr.slice(-64_000);
    });
    filho.on('error', (erro) => reject(new Error(`não consegui executar ${bin}: ${erro.message}`)));
    filho.on('close', (codigo) => resolve({ code: codigo ?? -1, stderr }));
  });
}

/**
 * Grava o SRT, roda o FFmpeg e devolve o resultado. Falha do FFmpeg vira Error com o
 * fim do stderr, para o Joel ver o motivo sem abrir o log inteiro.
 */
export async function renderVideo(
  plan: RenderPlan,
  opts: RenderVideoOptions = {},
): Promise<RenderResult> {
  await mkdir(dirname(plan.subtitlesPath), { recursive: true });
  await writeFile(plan.subtitlesPath, buildSrt(plan), 'utf8');
  await mkdir(dirname(plan.outPath), { recursive: true });

  const args = buildFfmpegArgs(plan);
  const bin = opts.ffmpegBin ?? 'ffmpeg';
  const run = opts.run ?? runFfmpeg;
  const resultado = await run(bin, args);
  if (resultado.code !== 0) {
    throw new Error(`FFmpeg falhou (código ${resultado.code}): ${fimDoStderr(resultado.stderr)}`);
  }
  return { outPath: plan.outPath, durationSec: duracaoTotal(plan), args };
}
