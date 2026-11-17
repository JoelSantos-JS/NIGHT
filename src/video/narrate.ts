// Narração por cena com o Kokoro (V04, docs/PLANO_MESTRE_NIGHT.md).
// Cada cena vira um WAV com duração registrada no store; a chave do áudio combina a
// cena (sceneCacheKey) com o texto que vai de fato para a voz (depois do léxico), então
// mudar uma cena ou a pronúncia de uma palavra não regera as outras cenas.
//
// A voz (Kokoro) é a mesma do serviço de voz do NIGHT. Voz diferente por canal
// exige outro parâmetro no serviço Python; fica como pendência registrada, não
// é implementado aqui.

import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ArtifactStore } from '../artifacts/store.ts';
import { sceneCacheKey, type Scene, type VideoManifest } from './manifest.ts';
import type { VideoBrief } from './brief.ts';

/** Injetável nos testes; em produção é speechService.synthesizeToFile. */
export type Synth = (
  text: string,
  language: 'pt-BR' | 'en',
  file: string,
) => Promise<{ audioSeconds: number }>;

/** Léxico de pronúncia separado da voz do NIGHT: chave = como está escrito. */
export type VideoLexicon = Record<string, string>;

export interface PronunciationNote {
  trecho: string;
  motivo: string;
}

export interface NarratorOptions {
  lexicon?: VideoLexicon;
  workDir: string;
}

export interface SceneNarration {
  n: number;
  /** Caminho do WAV dentro do store (não no workDir). */
  file: string;
  durationSec: number;
  /** Chave do áudio: cena + texto efetivamente sintetizado (depois do léxico). */
  cacheKey: string;
  reused: boolean;
}

export interface NarrateAllResult {
  scenes: SceneNarration[];
  totalSec: number;
}

/** Sidecar gravado ao lado do WAV: duração para reaproveitar sem sintetizar. */
interface NarrationSidecar {
  n: number;
  cacheKey: string;
  durationSec: number;
}

/** Palavras em inglês comuns num texto pt-BR que a pronúncia costuma errar. */
const PALAVRAS_INGLES = ['app', 'site', 'online', 'download', 'link', 'feed', 'post'];

/** Escapa os caracteres especiais para montar o regex do léxico em segurança. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function lexiconHas(lexicon: VideoLexicon, term: string): boolean {
  const alvo = term.toLocaleLowerCase('pt-BR');
  return Object.keys(lexicon).some((key) => key.toLocaleLowerCase('pt-BR') === alvo);
}

/**
 * Troca palavras inteiras do texto para a síntese. Os limites usam \p{L}/\p{N}
 * para respeitar acentos: "IA" não vira "I A" dentro de "IAgo" nem de "MAIA".
 * A legenda continua com o texto original; isto vale só para a voz.
 */
export function applyLexicon(text: string, lexicon: VideoLexicon): string {
  const chaves = Object.keys(lexicon)
    .filter((chave) => chave !== '')
    .sort((a, b) => b.length - a.length);
  if (chaves.length === 0) return text;
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}_])(?:${chaves.map(escapeRegExp).join('|')})(?![\\p{L}\\p{N}_])`,
    'gu',
  );
  return text.replace(pattern, (match) => lexicon[match] ?? match);
}

/**
 * Trechos que pedem revisão humana antes da locução: sigla, número grande,
 * valor em dinheiro e palavra em inglês. O que já está no léxico fica de fora.
 */
export function pronunciationReview(text: string, lexicon: VideoLexicon): PronunciationNote[] {
  const achados: { index: number; trecho: string; motivo: string }[] = [];
  const anotar = (index: number | undefined, trecho: string, motivo: string): void => {
    achados.push({ index: index ?? 0, trecho, motivo });
  };

  // Siglas com 2+ maiúsculas, fora do léxico. "US$" não entra como sigla.
  for (const m of text.matchAll(/(?<![\p{L}\p{N}_])\p{Lu}{2,}(?![\p{L}\p{N}_$])/gu)) {
    const trecho = m[0];
    if (!lexiconHas(lexicon, trecho)) anotar(m.index, trecho, 'sigla em maiúsculas fora do léxico');
  }

  // Números com 4+ dígitos, com ou sem separador de milhar (1.234, 15000).
  for (const m of text.matchAll(/\d{1,3}(?:[.,]\d{3})+(?!\d)|\d{4,}/g)) {
    anotar(m.index, m[0], 'número com 4 ou mais dígitos');
  }

  // Valores em reais ou dólares, com o número junto quando houver.
  for (const m of text.matchAll(/(?:R|US)\$(?:\s*\d[\d.,]*)?/g)) {
    anotar(m.index, m[0], 'valor em R$/US$');
  }

  // Palavras em inglês que soariam erradas na voz pt-BR.
  for (const palavra of PALAVRAS_INGLES) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}_])${palavra}(?![\\p{L}\\p{N}_])`, 'giu');
    for (const m of text.matchAll(re)) {
      if (!lexiconHas(lexicon, m[0])) anotar(m.index, m[0], 'palavra em inglês num texto pt-BR');
    }
  }

  achados.sort((a, b) => a.index - b.index);
  return achados.map(({ trecho, motivo }) => ({ trecho, motivo }));
}

/**
 * Narra cenas uma a uma e guarda WAV + sidecar no ArtifactStore. Sequencial de
 * propósito: o serviço de voz é um processo só e não deve ser paralelizado.
 */
export class Narrator {
  private readonly synth: Synth;
  private readonly store: ArtifactStore;
  private readonly lexicon: VideoLexicon;
  private readonly workDir: string;

  constructor(synth: Synth, store: ArtifactStore, opts: NarratorOptions) {
    this.synth = synth;
    this.store = store;
    this.lexicon = opts.lexicon ?? {};
    this.workDir = opts.workDir;
  }

  async narrateScene(jobId: string, scene: Scene, brief: VideoBrief): Promise<SceneNarration> {
    const texto = scene.narracao.trim();
    if (texto === '') {
      // Áudio mudo "escondido" enganaria a montagem: melhor falhar alto.
      throw new Error(`cena ${scene.n}: narração vazia; não gero áudio mudo`);
    }

    // O léxico muda a pronúncia sem mudar o manifesto. O hash do texto efetivamente
    // sintetizado entra na chave: trocar o léxico de uma palavra regera só a cena onde
    // ela aparece, em vez de reaproveitar o áudio com a pronúncia antiga.
    const entrada = applyLexicon(texto, this.lexicon);
    const cacheKey = createHash('sha256')
      .update(sceneCacheKey(scene, brief))
      .update('\0')
      .update(entrada)
      .digest('hex');
    const chave12 = cacheKey.slice(0, 12);
    const nome = `narracao-${scene.n}-${chave12}.wav`;
    const nomeSidecar = `narracao-${scene.n}-${chave12}.json`;

    // reuse() valida o jobId de verdade (via manifesto) antes de montar caminho.
    const reaproveitada = await this.reuse(jobId, scene.n, cacheKey, nome, nomeSidecar);
    const file = join(this.store.root, jobId, nome);
    if (reaproveitada !== null) {
      return { n: scene.n, file, durationSec: reaproveitada.durationSec, cacheKey, reused: true };
    }

    // Subpasta pelo hash do job: nomes de artefato não colidem entre trabalhos.
    const sub = createHash('sha256').update(jobId).digest('hex').slice(0, 12);
    const dirTrabalho = join(this.workDir, sub);
    await mkdir(dirTrabalho, { recursive: true });
    const bruto = join(dirTrabalho, nome);

    const { audioSeconds } = await this.synth(entrada, brief.idioma, bruto);
    if (!Number.isFinite(audioSeconds) || audioSeconds <= 0) {
      throw new Error(`cena ${scene.n}: duração de áudio inválida (${audioSeconds})`);
    }

    await this.store.addFile(jobId, bruto, { name: nome, origin: 'kokoro', kind: 'audio' });
    const sidecar: NarrationSidecar = { n: scene.n, cacheKey, durationSec: audioSeconds };
    await this.store.add(jobId, {
      name: nomeSidecar,
      data: `${JSON.stringify(sidecar, null, 2)}\n`,
      origin: 'kokoro',
      kind: 'narracao-meta',
    });

    return { n: scene.n, file, durationSec: audioSeconds, cacheKey, reused: false };
  }

  async narrateAll(jobId: string, manifest: VideoManifest): Promise<NarrateAllResult> {
    const scenes: SceneNarration[] = [];
    let totalSec = 0;
    for (const scene of manifest.cenas) {
      let narracao: SceneNarration;
      try {
        narracao = await this.narrateScene(jobId, scene, manifest.brief);
      } catch (error) {
        const motivo = error instanceof Error ? error.message : String(error);
        // Já prontas ficam no store; a retomada reaproveita e segue daqui.
        throw new Error(
          motivo.startsWith(`cena ${scene.n}:`)
            ? motivo
            : `cena ${scene.n}: falha na narração: ${motivo}`,
        );
      }
      scenes.push(narracao);
      totalSec += narracao.durationSec;
    }
    return { scenes, totalSec };
  }

  /** Reaproveita só quando o WAV e o sidecar estão no manifesto e íntegros. */
  private async reuse(
    jobId: string,
    n: number,
    cacheKey: string,
    nome: string,
    nomeSidecar: string,
  ): Promise<{ durationSec: number } | null> {
    const manifesto = await this.store.manifest(jobId);
    if (manifesto === null) return null;

    const nomes = new Set(manifesto.items.map((item) => item.name));
    if (!nomes.has(nome) || !nomes.has(nomeSidecar)) return null;

    const relatorio = await this.store.verify(jobId);
    const intacto = (alvo: string): boolean =>
      !relatorio.missing.includes(alvo) && !relatorio.changed.includes(alvo);
    if (!intacto(nome) || !intacto(nomeSidecar)) return null;

    try {
      const bruto = await readFile(join(this.store.root, jobId, nomeSidecar), 'utf8');
      const meta = JSON.parse(bruto) as Partial<NarrationSidecar>;
      if (meta.n !== n || meta.cacheKey !== cacheKey) return null;
      if (typeof meta.durationSec !== 'number' || !Number.isFinite(meta.durationSec) || meta.durationSec <= 0) {
        return null;
      }
      return { durationSec: meta.durationSec };
    } catch {
      // Sidecar ilegível: sintetiza de novo em vez de adivinhar a duração.
      return null;
    }
  }
}
