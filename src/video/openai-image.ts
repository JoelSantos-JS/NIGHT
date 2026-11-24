// Provedor de imagens com OpenAI GPT Image (gpt-image-1) para o agente de vídeos do NIGHT.
// Implementa ImageProvider com cache determinístico por prompt/tamanho/qualidade, teto de
// imagens por execução, leitura isolada da chave (OPENAI_API_KEY ou ~/.openai/api_key)
// e redação de segredos em qualquer erro ou log.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { redactSecrets, type ExistsSyncLike, type ReadFileSyncLike } from '../jobs/credentials.ts';
import type { ImageProvider } from './agent.ts';
import type { FormatoVideo } from './brief.ts';
import type { Scene, VideoManifest } from './manifest.ts';

export const DEFAULT_OPENAI_IMAGE_MODEL = 'gpt-image-1' as const;

export type OpenAiImageQuality = 'low' | 'medium' | 'high' | 'auto';
export type OpenAiImageSize = '1536x1024' | '1024x1536' | '1024x1024';

export interface OpenAiImageCredentialStatus {
  available: boolean;
  missing: string | null;
}

export interface OpenAiImageCredentialsOptions {
  env?: NodeJS.ProcessEnv;
  exists?: ExistsSyncLike;
  readFile?: ReadFileSyncLike;
}

function defaultOpenAiKeyFile(): string {
  return join(homedir(), '.openai', 'api_key');
}

const MISSING_OPENAI_KEY_MSG =
  'falta a chave da OpenAI: defina OPENAI_API_KEY ou crie ~/.openai/api_key';

/** Credenciais isoladas da OpenAI. Nunca serializa nem imprime a chave. */
export class OpenAiImageCredentials {
  private readonly env: NodeJS.ProcessEnv;
  private readonly exists: ExistsSyncLike;
  private readonly readFile: ReadFileSyncLike;

  constructor(opts: OpenAiImageCredentialsOptions = {}) {
    this.env = opts.env ?? process.env;
    this.exists = opts.exists ?? existsSync;
    this.readFile = opts.readFile ?? ((p, enc) => readFileSync(p, enc));
  }

  status(): OpenAiImageCredentialStatus {
    const available = this.resolve() !== null;
    return {
      available,
      missing: available ? null : MISSING_OPENAI_KEY_MSG,
    };
  }

  get(): string {
    const key = this.resolve();
    if (key === null) throw new Error(MISSING_OPENAI_KEY_MSG);
    return key;
  }

  toJSON(): { available: boolean } {
    return { available: this.status().available };
  }

  [inspect.custom](): string {
    return `OpenAiImageCredentials ${JSON.stringify(this.toJSON())}`;
  }

  private resolve(): string | null {
    const fromEnv = this.env.OPENAI_API_KEY;
    if (typeof fromEnv === 'string' && fromEnv.trim() !== '') {
      return fromEnv.trim();
    }
    const keyFile = defaultOpenAiKeyFile();
    if (!this.exists(keyFile)) return null;
    try {
      const text = this.readFile(keyFile, 'utf8').trim();
      return text === '' ? null : text;
    } catch {
      return null;
    }
  }
}

export interface OpenAiImageHttpRequest {
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
}

export interface OpenAiImageHttpResponse {
  status: number;
  ok: boolean;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}

export type OpenAiImageHttpClient = (
  url: string,
  init: OpenAiImageHttpRequest,
) => Promise<OpenAiImageHttpResponse>;

const defaultHttpClient: OpenAiImageHttpClient = async (url, init) => {
  const res = await fetch(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
  });
  return {
    status: res.status,
    ok: res.ok,
    arrayBuffer: () => res.arrayBuffer(),
    text: () => res.text(),
  };
};

/** Escolhe a proporção suportada pelo gpt-image-1 mais adequada ao formato do vídeo. */
export function selectOpenAiImageSize(formato?: FormatoVideo): OpenAiImageSize {
  if (formato === 'horizontal') return '1536x1024';
  return '1024x1536';
}

const TEMPLATE_STYLE_HINTS: Readonly<Record<string, string>> = {
  'psych-explainer-16x9':
    '2D vector cartoon psychology explainer illustration, clean uniform ~3px bold black ink outlines, flat pastel studio background, friendly learner cartoon character, keep bottom 18% uncluttered for captions',
  'dark-philosophy-16x9':
    'fine-art museum aesthetic (Baroque chiaroscuro oil painting or 17th-century sepia copperplate engraving on aged parchment), deep warm umber shadows, golden warm highlights, ZERO text, ZERO letters',
  'comic-explainer-16x9':
    '2D hand-drawn comic strip illustration, crisp black ink outlines, muted ochre and olive earthy flat cel coloring, keep bottom 16% uncluttered',
  'cozy-story-16x9':
    'warm golden-hour 2D digital storybook interior illustration, fine dark-brown linework, cozy atmospheric lighting, sage green and warm oak palette',
  'dark-science-2d':
    'dramatic 2D atmospheric science graphic novel illustration, bold ink linework, deep slate-teal (#13262F) mood with warm amber rim light',
  'editorial-flow': 'refined editorial documentary photography or crisp editorial artwork, clean visual focus',
};

/**
 * Monta o prompt de geração de imagem para uma cena. Preserva prompts já preenchidos no roteiro
 * e enriquece cenas de templates programáticos usando visual, cenário e direção do template.
 */
export function buildImagePromptForScene(scene: Scene, manifest?: VideoManifest): string {
  const existing = scene.promptImagem.trim();
  if (existing !== '') return existing;

  const formato = manifest?.brief.formato;
  const framing =
    formato === 'horizontal'
      ? '16:9 horizontal widescreen composition'
      : '9:16 vertical full-bleed composition';

  const templateId = manifest?.templateVisual;
  const styleHint =
    (templateId && TEMPLATE_STYLE_HINTS[templateId]) || 'clean cohesive editorial illustration';

  const parts = [
    framing,
    styleHint,
    scene.visual.trim(),
    scene.cenario ? `setting cue: ${scene.cenario}` : '',
    scene.textoNaTela?.trim() && templateId !== 'dark-philosophy-16x9'
      ? `in-scene short label reading "${scene.textoNaTela.trim()}"`
      : '',
    'no watermarks, no sparkles, no bottom subtitles',
  ].filter(Boolean);

  return parts.join(', ');
}

export interface OpenAiImageProviderOptions {
  cacheDir: string;
  credentials?: OpenAiImageCredentials;
  model?: string;
  quality?: OpenAiImageQuality;
  outputFormat?: 'jpeg' | 'png';
  maxImages?: number;
  /** Quando true, ausência de chave devolve null em vez de lançar erro (útil em fallback composito). */
  skipWhenUnavailable?: boolean;
  http?: OpenAiImageHttpClient;
  baseUrl?: string;
}

interface OpenAiImagesApiResponse {
  data?: Array<{
    b64_json?: string;
    url?: string;
  }>;
}

/**
 * Provedor compatível com `VideoAgent` que gera e faz cache local de ilustrações via OpenAI GPT Image.
 */
export class OpenAiImageProvider implements ImageProvider {
  readonly origin = 'openai-gpt-image';

  private readonly cacheDir: string;
  private readonly credentials: OpenAiImageCredentials;
  private readonly model: string;
  private readonly quality: OpenAiImageQuality;
  private readonly outputFormat: 'jpeg' | 'png';
  private readonly maxImages?: number;
  private readonly skipWhenUnavailable: boolean;
  private readonly http: OpenAiImageHttpClient;
  private readonly baseUrl: string;
  private generatedCount = 0;

  constructor(opts: OpenAiImageProviderOptions) {
    this.cacheDir = opts.cacheDir;
    this.credentials = opts.credentials ?? new OpenAiImageCredentials();
    this.model = opts.model ?? DEFAULT_OPENAI_IMAGE_MODEL;
    this.quality = opts.quality ?? 'medium';
    this.outputFormat = opts.outputFormat ?? 'jpeg';
    this.maxImages = opts.maxImages;
    this.skipWhenUnavailable = opts.skipWhenUnavailable ?? false;
    this.http = opts.http ?? defaultHttpClient;
    this.baseUrl = (opts.baseUrl ?? 'https://api.openai.com').replace(/\/+$/, '');
  }

  async find(jobId: string, scene: Scene, manifest?: VideoManifest): Promise<string | null> {
    if (!this.credentials.status().available) {
      if (this.skipWhenUnavailable) return null;
      this.credentials.get(); // lança erro padronizado sem segredo
    }

    const prompt = buildImagePromptForScene(scene, manifest);
    const size = selectOpenAiImageSize(manifest?.brief.formato);
    const hash = createHash('sha256')
      .update(`${prompt}\0${this.model}\0${size}\0${this.quality}\0${this.outputFormat}`)
      .digest('hex')
      .slice(0, 12);
    const ext = this.outputFormat === 'png' ? 'png' : 'jpg';
    const jobDir = join(this.cacheDir, jobId);
    const outFile = join(jobDir, `cena-${scene.n}-${hash}.${ext}`);

    try {
      const info = await stat(outFile);
      if (info.isFile() && info.size > 0) return outFile;
    } catch {
      // Cache miss: segue para geração.
    }

    const cap = this.maxImages ?? manifest?.brief.limites.maxImagens ?? 30;
    if (this.generatedCount >= cap) {
      throw new Error(`limite de imagens da OpenAI atingido (${cap})`);
    }

    const apiKey = this.credentials.get();
    const res = await this.http(`${this.baseUrl}/v1/images/generations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        prompt,
        size,
        quality: this.quality,
        output_format: this.outputFormat,
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(
        redactSecrets(
          `OpenAI GPT Image falhou (HTTP ${res.status}): ${errText.slice(0, 220) || 'sem detalhe'}`,
          [apiKey],
        ),
      );
    }

    let parsed: OpenAiImagesApiResponse;
    const rawBody = await res.text();
    try {
      parsed = JSON.parse(rawBody) as OpenAiImagesApiResponse;
    } catch {
      throw new Error(redactSecrets('OpenAI GPT Image devolveu JSON inválido', [apiKey]));
    }

    const first = parsed.data?.[0];
    let bytes: Buffer | null = null;
    if (typeof first?.b64_json === 'string' && first.b64_json.trim() !== '') {
      bytes = Buffer.from(first.b64_json, 'base64');
    } else if (typeof first?.url === 'string' && first.url.trim() !== '') {
      const dl = await this.http(first.url, { method: 'GET', headers: {} });
      if (!dl.ok) {
        throw new Error(redactSecrets(`Falha ao baixar imagem da OpenAI (HTTP ${dl.status})`, [apiKey]));
      }
      bytes = Buffer.from(await dl.arrayBuffer());
    }

    if (!bytes || bytes.length === 0) {
      throw new Error('OpenAI GPT Image devolveu resposta sem imagem');
    }

    await mkdir(jobDir, { recursive: true });
    await writeFile(outFile, bytes);
    this.generatedCount += 1;
    return outFile;
  }
}
