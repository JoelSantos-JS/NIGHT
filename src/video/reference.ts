// Analisador técnico de vídeo de referência autorizado (inspirado em viral-video-studio/references/reference-analysis.md).
// Mede duração, formato, cortes por minuto e extrai amostras de frames via ffprobe/ffmpeg injetáveis.
// Separa explicitamente observed, inferred e unknown e proíbe reutilizar mídia/personagens de terceiros.

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseProbe, probeArgs, type ProbeInfo, type RunCommand } from './review.ts';
import type { StyleRecipe } from './templates.ts';

export type ObservationLevel = 'observed' | 'inferred' | 'unknown';

export interface ReferenceObservation {
  level: ObservationLevel;
  fact: string;
}

export interface ReferenceCuts {
  count: number;
  timestampsSec: number[];
  cutsPerMinute: number;
}

export type VideoAspect = 'vertical' | 'horizontal' | 'square';

export interface ReferenceAnalysis {
  sourceFile: string;
  access: 'authorized-local-file';
  analyzedAt: string;
  probe: ProbeInfo;
  aspect: VideoAspect;
  cuts: ReferenceCuts;
  frames: string[];
  observations: ReferenceObservation[];
  styleRecipe: StyleRecipe;
  copyrightNotes: string;
}

export interface AnalyzeReferenceOptions {
  run: RunCommand;
  /** Quando informada, extrai frames representativos nessa pasta. */
  framesDir?: string;
  maxFrames?: number;
  sceneThreshold?: number;
}

const DEFAULT_THRESHOLD = 0.35;
const DEFAULT_MAX_FRAMES = 5;
const COPYRIGHT_NOTE =
  'Referência usada apenas como estrutura abstrata de ritmo e formato. ' +
  'Proibido reutilizar bytes, áudio, voz, marca, texto ou personagens protegidos.';

/** Argumentos do ffmpeg para detectar mudanças bruscas de cena. */
export function sceneCutDetectArgs(file: string, threshold = DEFAULT_THRESHOLD): string[] {
  return [
    '-hide_banner',
    '-nostats',
    '-i',
    file,
    '-vf',
    `select='gt(scene,${threshold})',showinfo`,
    '-an',
    '-f',
    'null',
    '-',
  ];
}

/** Lê timestamps de mudança de cena (`pts_time:`) do stderr do showinfo. */
export function parseSceneCuts(stderr: string): number[] {
  const encontrados = new Set<number>();
  for (const linha of stderr.split(/\r?\n/)) {
    const m = /\bpts_time:\s*(-?\d+(?:\.\d+)?)/.exec(linha);
    if (!m) continue;
    const valor = Number(m[1]);
    if (!Number.isFinite(valor) || valor < 0) continue;
    encontrados.add(Math.round(valor * 1000) / 1000);
  }
  return [...encontrados].sort((a, b) => a - b);
}

/** Calcula instantes representativos dentro da duração do vídeo para amostragem de frames. */
export function referenceFrameTimestamps(durationSec: number, count = DEFAULT_MAX_FRAMES): number[] {
  if (!Number.isFinite(durationSec) || durationSec <= 0 || count <= 0) return [];
  const total = Math.max(1, Math.floor(count));
  const inicio = Math.min(0.5, durationSec * 0.1);
  if (total === 1 || durationSec <= 1) {
    return [Math.round(inicio * 100) / 100];
  }
  const fim = Math.max(inicio, durationSec - Math.min(0.5, durationSec * 0.1));
  const pontos = new Set<number>();
  for (let i = 0; i < total; i++) {
    const t = inicio + ((fim - inicio) * i) / (total - 1);
    pontos.add(Math.round(t * 100) / 100);
  }
  return [...pontos].sort((a, b) => a - b);
}

/** Extrai até `maxFrames` frames JPEG para inspeção visual. */
export async function extractSampleFrames(
  file: string,
  durationSec: number,
  outDir: string,
  run: RunCommand,
  maxFrames = DEFAULT_MAX_FRAMES,
): Promise<string[]> {
  const instantes = referenceFrameTimestamps(durationSec, maxFrames);
  if (instantes.length === 0) return [];
  await mkdir(outDir, { recursive: true });
  const salvos: string[] = [];
  for (let i = 0; i < instantes.length; i++) {
    const t = instantes[i]!;
    const destino = join(outDir, `ref-frame-${i + 1}.jpg`);
    const res = await run('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-ss',
      t.toFixed(2),
      '-i',
      file,
      '-frames:v',
      '1',
      '-q:v',
      '3',
      destino,
    ]);
    if (res.code === 0) salvos.push(destino);
  }
  return salvos;
}

function inferAspect(width: number, height: number): VideoAspect {
  if (height > width) return 'vertical';
  if (width > height) return 'horizontal';
  return 'square';
}

/**
 * Analisa um arquivo de vídeo local autorizado com ffprobe/ffmpeg e gera
 * um `ReferenceAnalysis` com `styleRecipe` abstraído.
 */
export async function analyzeReferenceVideo(
  filePath: string,
  opts: AnalyzeReferenceOptions,
): Promise<ReferenceAnalysis> {
  const probeRes = await opts.run('ffprobe', probeArgs(filePath));
  if (probeRes.code !== 0) {
    throw new Error(`ffprobe falhou ao ler referência (${probeRes.code}): ${probeRes.stderr.trim() || 'sem detalhe'}`);
  }
  const probe = parseProbe(probeRes.stdout);
  if (!probe.hasVideo) {
    throw new Error('arquivo de referência não possui faixa de vídeo');
  }

  const aspect = inferAspect(probe.width, probe.height);
  const observations: ReferenceObservation[] = [
    {
      level: 'observed',
      fact: `formato ${probe.width}x${probe.height} (${aspect}), duração ${probe.durationSec.toFixed(1)}s`,
    },
    {
      level: 'observed',
      fact: probe.hasAudio ? `áudio presente (${probe.audioCodec ?? 'codec desconhecido'})` : 'sem faixa de áudio',
    },
  ];

  const threshold = opts.sceneThreshold ?? DEFAULT_THRESHOLD;
  const cutsRes = await opts.run('ffmpeg', sceneCutDetectArgs(filePath, threshold));
  let timestampsSec: number[] = [];
  let cutsOk = false;
  if (cutsRes.code === 0) {
    timestampsSec = parseSceneCuts(cutsRes.stderr);
    cutsOk = true;
  } else {
    observations.push({
      level: 'unknown',
      fact: `detecção automática de cortes indisponível (ffmpeg código ${cutsRes.code})`,
    });
  }

  const cutsPerMinute =
    cutsOk && Number.isFinite(probe.durationSec) && probe.durationSec > 0
      ? Math.round((timestampsSec.length / (probe.durationSec / 60)) * 10) / 10
      : 0;

  if (cutsOk) {
    observations.push({
      level: 'observed',
      fact: `${timestampsSec.length} mudanças de cena detectadas (~${cutsPerMinute} cortes/min)`,
    });
    const ritmo = cutsPerMinute >= 15
      ? 'ritmo rápido de edição'
      : cutsPerMinute >= 6
        ? 'ritmo moderado de edição'
        : 'ritmo calmo / planos mais longos';
    observations.push({ level: 'inferred', fact: ritmo });
  }

  let frames: string[] = [];
  if (opts.framesDir !== undefined) {
    frames = await extractSampleFrames(
      filePath,
      probe.durationSec,
      opts.framesDir,
      opts.run,
      opts.maxFrames ?? DEFAULT_MAX_FRAMES,
    );
  }

  if (frames.length > 0) {
    observations.push({
      level: 'observed',
      fact: `${frames.length} frames extraídos para inspeção visual`,
    });
    observations.push({
      level: 'unknown',
      fact: 'paleta, tipografia e composição dependem da inspeção dos frames extraídos',
    });
  } else {
    observations.push({
      level: 'unknown',
      fact: 'conteúdo visual quadro a quadro não observado (nenhum frame extraído)',
    });
  }

  observations.push({
    level: 'unknown',
    fact: 'transcrição da fala e música de fundo não analisadas nesta etapa',
  });

  const hookMaxSec = aspect === 'vertical' ? 3 : 5;
  observations.push({
    level: 'inferred',
    fact: `janela sugerida de gancho inicial até ${hookMaxSec}s para formato ${aspect}`,
  });

  const styleRecipe: StyleRecipe = {
    ...(cutsPerMinute > 0 ? { cutsPerMinute } : {}),
    hookMaxSec,
    fontMood: aspect === 'vertical' ? 'bold-sans' : 'editorial',
    sourceNote: 'abstração técnica de ritmo e formato (sem copiar mídia, áudio ou personagens da referência)',
  };

  return {
    sourceFile: filePath,
    access: 'authorized-local-file',
    analyzedAt: new Date().toISOString(),
    probe,
    aspect,
    cuts: {
      count: timestampsSec.length,
      timestampsSec,
      cutsPerMinute,
    },
    frames,
    observations,
    styleRecipe,
    copyrightNotes: COPYRIGHT_NOTE,
  };
}
