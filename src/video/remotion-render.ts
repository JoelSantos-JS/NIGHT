// Ponte do agente de vídeos para o estúdio visual em Remotion (services/video-studio).
// Converte RenderPlan + VideoManifest em props determinísticas e aciona o CLI isolado.

import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { VideoManifest } from './manifest.ts';
import { buildSrt, type RenderPlan, type RenderResult } from './render.ts';
import {
  getVideoTemplate,
  resolveTemplateForStyle,
  type FontMood,
  type SceneTransition,
} from './templates.ts';

export interface RemotionStudioTheme {
  background: string;
  primary: string;
  accent: string;
  text: string;
  fontMood: FontMood;
}

export interface RemotionStudioScene {
  n: number;
  durationSec: number;
  narracao: string;
  textoNaTela?: string;
  acao?: string;
  transicao?: SceneTransition;
  assets?: string[];
  pose?: string;
  expressao?: string;
  cenario?: string;
  imageUrl?: string | null;
  videoUrl?: string | null;
  videoStartSec?: number;
  audioUrl?: string | null;
  cta?: boolean;
}

export interface RemotionStudioProps {
  jobId: string;
  titulo: string;
  width: number;
  height: number;
  fps: number;
  preview: boolean;
  templateId: string;
  theme: RemotionStudioTheme;
  musicUrl?: string | null;
  baseVideoUrl?: string | null;
  muteBaseVideo?: boolean;
  scenes: RemotionStudioScene[];
}

export type RemotionRunner = (bin: string, args: string[]) => Promise<{ code: number; stderr: string }>;

export interface RemotionRenderOptions {
  studioDir?: string;
  nodeBin?: string;
  /** Injetável nos testes para não abrir o Chromium/Remotion. */
  run?: RemotionRunner;
}

const DEFAULT_STUDIO_DIR = resolve(import.meta.dirname, '..', '..', 'services', 'video-studio');

/** Monta o JSON de props consumido pelo Composition do Remotion. */
export function buildRemotionProps(plan: RenderPlan, manifest: VideoManifest): RemotionStudioProps {
  const template =
    getVideoTemplate(manifest.templateVisual) ??
    resolveTemplateForStyle(manifest.brief.estilo) ??
    getVideoTemplate('editorial-flow')!;

  const palette = manifest.styleRecipe?.palette;
  const theme: RemotionStudioTheme = {
    background: palette?.background ?? template.temaPadrao.background,
    primary: palette?.primary ?? template.temaPadrao.primary,
    accent: palette?.accent ?? template.temaPadrao.accent,
    text: palette?.text ?? template.temaPadrao.text,
    fontMood: manifest.styleRecipe?.fontMood ?? template.temaPadrao.fontMood,
  };

  const cenasPorNumero = new Map(manifest.cenas.map((c) => [c.n, c]));
  const totalCenas = plan.scenes.length;
  const manifestBaseVideo =
    typeof manifest.videoBase === 'string' && manifest.videoBase.trim() !== ''
      ? manifest.videoBase
      : null;

  let offsetSec = 0;
  const scenes: RemotionStudioScene[] = plan.scenes.map((scene, idx) => {
    const origem = cenasPorNumero.get(scene.n);
    const imageUrl = scene.imagePath.trim() === '' ? null : scene.imagePath;
    const sceneOwnVideo =
      typeof origem?.videoBase === 'string' && origem.videoBase.trim() !== ''
        ? origem.videoBase
        : null;
    const videoUrl = sceneOwnVideo ?? manifestBaseVideo;
    const videoStartSec =
      origem?.videoStartSec !== undefined
        ? origem.videoStartSec
        : sceneOwnVideo !== null
          ? 0
          : manifestBaseVideo !== null
            ? offsetSec
            : undefined;
    offsetSec += scene.durationSec;

    return {
      n: scene.n,
      durationSec: scene.durationSec,
      narracao: scene.caption,
      imageUrl,
      ...(videoUrl !== null ? { videoUrl } : {}),
      ...(videoStartSec !== undefined ? { videoStartSec } : {}),
      audioUrl: scene.audioPath,
      ...(origem?.textoNaTela !== undefined ? { textoNaTela: origem.textoNaTela } : {}),
      ...(origem?.acao !== undefined ? { acao: origem.acao } : {}),
      ...(origem?.transicao !== undefined ? { transicao: origem.transicao } : {}),
      ...(origem?.assets !== undefined ? { assets: origem.assets } : {}),
      ...(origem?.pose !== undefined ? { pose: origem.pose } : {}),
      ...(origem?.expressao !== undefined ? { expressao: origem.expressao } : {}),
      ...(origem?.cenario !== undefined ? { cenario: origem.cenario } : {}),
      ...(template.id === 'ad-creative' && idx === totalCenas - 1 ? { cta: true } : {}),
    };
  });

  return {
    jobId: manifest.jobId,
    titulo: manifest.titulo,
    width: plan.width,
    height: plan.height,
    fps: plan.fps,
    preview: plan.preview,
    templateId: template.id,
    theme,
    musicUrl: manifest.trilhaAudio ?? null,
    baseVideoUrl: manifestBaseVideo,
    muteBaseVideo: manifest.mutarVideoBase ?? true,
    scenes,
  };
}

function propsPathPara(outPath: string): string {
  return /\.mp4$/i.test(outPath)
    ? outPath.replace(/\.mp4$/i, '-props.json')
    : `${outPath}-props.json`;
}

function fimDoStderr(stderr: string, max = 2000): string {
  const limpo = stderr.trim();
  if (limpo === '') return 'sem stderr';
  return limpo.length <= max ? limpo : `…${limpo.slice(-max)}`;
}

function runNodeCli(bin: string, args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolveRun, rejectRun) => {
    const filho = spawn(bin, args, { shell: false });
    let stderr = '';
    filho.stderr.setEncoding('utf8');
    filho.stderr.on('data', (trecho: string) => {
      stderr += trecho;
      if (stderr.length > 64_000) stderr = stderr.slice(-64_000);
    });
    filho.on('error', (erro) => rejectRun(new Error(`não consegui executar ${bin}: ${erro.message}`)));
    filho.on('close', (codigo) => resolveRun({ code: codigo ?? -1, stderr }));
  });
}

/**
 * Grava o SRT e o JSON de props e chama o estúdio Remotion isolado para renderizar o MP4.
 */
export async function renderWithRemotion(
  plan: RenderPlan,
  manifest: VideoManifest,
  opts: RemotionRenderOptions = {},
): Promise<RenderResult> {
  if (plan.scenes.length === 0) throw new Error('plano sem cenas: nada para renderizar');

  await mkdir(dirname(plan.subtitlesPath), { recursive: true });
  await writeFile(plan.subtitlesPath, buildSrt(plan), 'utf8');
  await mkdir(dirname(plan.outPath), { recursive: true });

  const props = buildRemotionProps(plan, manifest);
  const propsPath = propsPathPara(plan.outPath);
  await writeFile(propsPath, `${JSON.stringify(props, null, 2)}\n`, 'utf8');

  const studioDir = opts.studioDir ?? DEFAULT_STUDIO_DIR;
  const cliPath = join(studioDir, 'render-cli.mjs');
  const bin = opts.nodeBin ?? process.execPath;
  const args = [cliPath, '--props', propsPath, '--out', plan.outPath];
  const run = opts.run ?? runNodeCli;

  const res = await run(bin, args);
  if (res.code !== 0) {
    throw new Error(`Remotion falhou (código ${res.code}): ${fimDoStderr(res.stderr)}`);
  }
  const durationSec = plan.scenes.reduce((soma, cena) => soma + cena.durationSec, 0);
  return { outPath: plan.outPath, durationSec, args };
}
