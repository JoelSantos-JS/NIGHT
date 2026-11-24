// Orquestração de fontes de imagem para vídeos do NIGHT (Google Flow, OpenAI GPT Image e fallback programático).

import type { ImageProvider } from './agent.ts';
import { FlowFolderProvider } from './flow-folder.ts';
import type { Scene, VideoManifest } from './manifest.ts';
import {
  OpenAiImageCredentials,
  OpenAiImageProvider,
  type OpenAiImageHttpClient,
  type OpenAiImageQuality,
} from './openai-image.ts';

export type ImageProviderMode = 'auto' | 'flow' | 'gpt' | 'procedural';

/**
 * Combina múltiplos `ImageProvider`s em ordem de prioridade (ex.: Flow local primeiro,
 * depois GPT Image da OpenAI para cenas ausentes) rastreando a origem exata de cada cena.
 */
export class CompositeImageProvider implements ImageProvider {
  readonly origin = 'composite';
  private readonly providers: readonly ImageProvider[];
  private readonly resolvedOrigins = new Map<string, string>();

  constructor(providers: readonly ImageProvider[]) {
    this.providers = providers;
  }

  async find(jobId: string, scene: Scene, manifest?: VideoManifest): Promise<string | null> {
    const key = `${jobId}:${scene.n}`;
    for (const provider of this.providers) {
      const hit = await provider.find(jobId, scene, manifest);
      if (hit !== null && hit.trim() !== '') {
        const providerOrigin = provider.originFor?.(jobId, scene) ?? provider.origin ?? 'unknown';
        this.resolvedOrigins.set(key, providerOrigin);
        return hit;
      }
    }
    this.resolvedOrigins.delete(key);
    return null;
  }

  originFor(jobId: string, scene: Scene): string | undefined {
    return this.resolvedOrigins.get(`${jobId}:${scene.n}`);
  }

  async writePromptSheet(jobId: string, manifest: VideoManifest): Promise<string | null> {
    for (const provider of this.providers) {
      if (typeof provider.writePromptSheet === 'function') {
        return await provider.writePromptSheet(jobId, manifest);
      }
    }
    return null;
  }
}

export interface CreateImageProviderOptions {
  mode?: ImageProviderMode;
  flowRoot?: string;
  numeroDoVideo?: number | string | null;
  cacheDir: string;
  openAiCredentials?: OpenAiImageCredentials;
  gptModel?: string;
  gptQuality?: OpenAiImageQuality;
  gptHttp?: OpenAiImageHttpClient;
  maxImages?: number;
}

/** Cria o provedor de imagens configurado: Flow, GPT Image, automático (Flow -> GPT -> Remotion) ou apenas código. */
export function createImageProvider(opts: CreateImageProviderOptions): ImageProvider {
  const mode = opts.mode ?? 'auto';
  const flow = new FlowFolderProvider({
    root: opts.flowRoot,
    numeroDoVideo: opts.numeroDoVideo,
  });

  if (mode === 'procedural') {
    return {
      origin: 'remotion-procedural',
      find: async () => null,
      writePromptSheet: (jobId, manifest) => flow.writePromptSheet(jobId, manifest),
    };
  }

  if (mode === 'flow') {
    return flow;
  }

  if (mode === 'gpt') {
    return new OpenAiImageProvider({
      cacheDir: opts.cacheDir,
      credentials: opts.openAiCredentials,
      model: opts.gptModel,
      quality: opts.gptQuality,
      maxImages: opts.maxImages,
      http: opts.gptHttp,
      skipWhenUnavailable: false,
    });
  }

  const gptOptional = new OpenAiImageProvider({
    cacheDir: opts.cacheDir,
    credentials: opts.openAiCredentials,
    model: opts.gptModel,
    quality: opts.gptQuality,
    maxImages: opts.maxImages,
    http: opts.gptHttp,
    skipWhenUnavailable: true,
  });

  return new CompositeImageProvider([flow, gptOptional]);
}
