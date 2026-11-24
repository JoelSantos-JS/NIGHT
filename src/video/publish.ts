// Publicação multirrede focada no ecossistema Meta (Facebook Reels, Instagram Reels e Threads).
// Nasce sempre como rascunho (publicationEnabled: false); nenhuma chamada de rede ocorre sem
// aprovação explícita nem antes de validar o pacote/hash do MP4 no ArtifactStore.
// Publicação em massa / criação automática de contas não existem aqui: apenas contas autorizadas.

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { inspect } from 'node:util';
import type { ArtifactStore } from '../artifacts/store.ts';
import { redactSecrets } from '../jobs/credentials.ts';
import { loadPackage, type DeliveryPackage } from './package.ts';

export const PUBLISH_CONTRACT = 'publicacao-meta/1' as const;
export const THREADS_MAX_CAPTION_CHARS = 500;
export const META_PUBLISH_PLATFORMS = ['facebook_reels', 'instagram_reels', 'threads'] as const;

export type MetaPublishPlatform = (typeof META_PUBLISH_PLATFORMS)[number];
export type DestinationStatus = 'draft' | 'not_authorized' | 'processing' | 'published' | 'failed';
export type PublishManifestStatus = 'draft' | 'approved' | 'publishing' | 'published' | 'partial' | 'failed';

export const META_PUBLISH_ENV: Readonly<Record<MetaPublishPlatform, string>> = {
  facebook_reels: 'NIGHT_META_FB_PAGE_TOKEN',
  instagram_reels: 'NIGHT_META_IG_TOKEN',
  threads: 'NIGHT_META_THREADS_TOKEN',
};

const PLATFORM_LABELS: Readonly<Record<MetaPublishPlatform, string>> = {
  facebook_reels: 'token da Página do Facebook',
  instagram_reels: 'token do Instagram profissional',
  threads: 'token do Threads',
};

export interface PublishCredentialStatus {
  platform: MetaPublishPlatform;
  available: boolean;
  missing: string | null;
}

/**
 * Credenciais isoladas para publicação Meta. Nunca vaza segredos em JSON, inspect ou erros.
 */
export class MetaPublishCredentials {
  private readonly env: NodeJS.ProcessEnv;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.env = env;
  }

  status(platform: MetaPublishPlatform): PublishCredentialStatus {
    const envVar = META_PUBLISH_ENV[platform];
    const available = this.readToken(platform) !== null;
    return {
      platform,
      available,
      missing: available ? null : `falta o ${PLATFORM_LABELS[platform]}: defina ${envVar}`,
    };
  }

  get(platform: MetaPublishPlatform): string {
    const token = this.readToken(platform);
    if (token === null) {
      throw new Error(`falta o ${PLATFORM_LABELS[platform]}: defina ${META_PUBLISH_ENV[platform]}`);
    }
    return token;
  }

  allTokens(): string[] {
    return META_PUBLISH_PLATFORMS.map((p) => this.readToken(p)).filter((t): t is string => t !== null);
  }

  toJSON(): Record<MetaPublishPlatform, { available: boolean }> {
    return {
      facebook_reels: { available: this.status('facebook_reels').available },
      instagram_reels: { available: this.status('instagram_reels').available },
      threads: { available: this.status('threads').available },
    };
  }

  [inspect.custom](): string {
    return `MetaPublishCredentials ${JSON.stringify(this.toJSON())}`;
  }

  private readToken(platform: MetaPublishPlatform): string | null {
    const raw = this.env[META_PUBLISH_ENV[platform]];
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    return trimmed === '' ? null : trimmed;
  }
}

export interface PublishDestination {
  platform: MetaPublishPlatform;
  accountId: string | null;
  variant: string;
  idempotencyKey: string;
  title: string;
  caption: string;
  hashtags: string[];
  /** Obrigatória (HTTPS pública) para instagram_reels e threads; opcional para facebook_reels. */
  videoUrl: string | null;
  shareToFeed?: boolean;
  aiDisclosure: boolean;
  status: DestinationStatus;
  providerPostId: string | null;
  publicUrl: string | null;
  publishedAt: string | null;
  lastError: string | null;
}

export interface PublishManifest {
  version: number;
  contract: typeof PUBLISH_CONTRACT;
  jobId: string;
  packageVersion: number;
  assetFile: string;
  assetSha256: string;
  createdAt: string;
  status: PublishManifestStatus;
  approvalMode: 'review_before_publish';
  publicationEnabled: boolean;
  approvedAt: string | null;
  approvedBy: string | null;
  destinations: PublishDestination[];
}

export interface DestinationOverride {
  accountId?: string | null;
  variant?: string;
  title?: string;
  caption?: string;
  hashtags?: string[];
  videoUrl?: string | null;
  shareToFeed?: boolean;
}

export interface BuildPublishOptions {
  jobId: string;
  version?: number;
  platforms?: readonly MetaPublishPlatform[];
  caption?: string;
  hashtags?: string[];
  destinations?: Partial<Record<MetaPublishPlatform, DestinationOverride>>;
}

export interface MetaHttpResponse {
  status: number;
  ok: boolean;
  text(): Promise<string>;
}

export interface MetaHttpRequest {
  method: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string | Uint8Array;
}

export type MetaHttpClient = (url: string, init: MetaHttpRequest) => Promise<MetaHttpResponse>;

export interface ExecutePublishOptions {
  dryRun?: boolean;
  credentials?: MetaPublishCredentials;
  http?: MetaHttpClient;
  apiVersion?: string;
  maxPolls?: number;
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface DryRunCheck {
  platform: MetaPublishPlatform;
  ok: boolean;
  skipped: boolean;
  issues: string[];
}

export interface ExecutePublishResult {
  dryRun: boolean;
  ready: boolean;
  manifest: PublishManifest;
  checks: DryRunCheck[];
}

export function publishManifestName(version: number): string {
  if (!Number.isInteger(version) || version < 1) {
    throw new Error(`versão do manifesto de publicação inválida: ${version}`);
  }
  return `publish-v${version}.json`;
}

function normalizeHashtags(tags: readonly string[] = []): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of tags) {
    const clean = raw.trim().replace(/^#+/, '');
    if (clean === '') continue;
    const tag = `#${clean}`;
    const key = tag.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(tag);
    }
  }
  return out;
}

/** Formata legenda por plataforma respeitando o limite de 500 caracteres do Threads. */
export function formatCaptionForPlatform(
  platform: MetaPublishPlatform,
  baseCaption: string,
  hashtags: readonly string[] = [],
): string {
  const base = baseCaption.trim();
  const tags = normalizeHashtags(hashtags);
  const full = tags.length === 0 ? base : base === '' ? tags.join(' ') : `${base}\n\n${tags.join(' ')}`;
  if (platform !== 'threads' || full.length <= THREADS_MAX_CAPTION_CHARS) {
    return full;
  }
  return `${full.slice(0, THREADS_MAX_CAPTION_CHARS - 1).trimEnd()}…`;
}

function isPrivateOrLocalHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === '' || h === 'localhost' || h === '::1' || h === '0.0.0.0') return true;
  if (h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h)) return true;
  const m172 = /^172\.(\d{1,3})\./.exec(h);
  if (m172) {
    const second = Number(m172[1]);
    if (second >= 16 && second <= 31) return true;
  }
  return false;
}

/** Instagram e Threads exigem URL HTTPS pública para o servidor da Meta baixar o vídeo. */
export function validatePublicHttpsUrl(
  rawUrl: string | null | undefined,
): { ok: true; url: string } | { ok: false; reason: string } {
  if (typeof rawUrl !== 'string' || rawUrl.trim() === '') {
    return { ok: false, reason: 'falta videoUrl pública (HTTPS) exigida pela Meta' };
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return { ok: false, reason: 'videoUrl não é uma URL válida' };
  }
  if (parsed.protocol !== 'https:') {
    return { ok: false, reason: 'videoUrl precisa usar protocolo HTTPS' };
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return { ok: false, reason: 'videoUrl não deve conter credenciais embutidas' };
  }
  if (isPrivateOrLocalHost(parsed.hostname)) {
    return { ok: false, reason: `videoUrl não pode apontar para host local ou privado (${parsed.hostname})` };
  }
  return { ok: true, url: parsed.toString() };
}

function makeIdempotencyKey(
  jobId: string,
  platform: MetaPublishPlatform,
  accountId: string | null,
  variant: string,
  assetSha256: string,
): string {
  const material = `${jobId}|${platform}|${accountId ?? 'unlinked'}|${variant}|${assetSha256}`;
  return createHash('sha256').update(material).digest('hex').slice(0, 24);
}

/**
 * Monta o manifesto inicial de publicação sempre em modo `draft` e com
 * `publicationEnabled: false`, exigindo aprovação explícita antes de enviar.
 */
export function buildPublishManifest(pkg: DeliveryPackage, opts: BuildPublishOptions): PublishManifest {
  if (pkg.arquivos.video === null) {
    throw new Error('pacote sem vídeo final renderizado: gere o MP4 final antes de preparar publicação');
  }
  const version = opts.version ?? pkg.version;
  if (!Number.isInteger(version) || version < 1) {
    throw new Error(`versão inválida para manifesto de publicação: ${version}`);
  }
  const platforms = opts.platforms && opts.platforms.length > 0 ? opts.platforms : META_PUBLISH_PLATFORMS;
  const aiDisclosure = pkg.cenas.some((c) => c.realistaGeradaPorIA);
  const defaultCaption = (opts.caption ?? pkg.titulo).trim();
  const defaultHashtags = normalizeHashtags(opts.hashtags ?? []);
  const seen = new Set<MetaPublishPlatform>();

  const destinations: PublishDestination[] = [];
  for (const platform of platforms) {
    if (seen.has(platform)) continue;
    seen.add(platform);
    const over = opts.destinations?.[platform] ?? {};
    const accountId =
      typeof over.accountId === 'string' && over.accountId.trim() !== '' ? over.accountId.trim() : null;
    const variant = (over.variant ?? 'default').trim() || 'default';
    const tags = over.hashtags ? normalizeHashtags(over.hashtags) : defaultHashtags;
    const rawCaption = over.caption ?? defaultCaption;
    const caption = formatCaptionForPlatform(platform, rawCaption, tags);
    const title = (over.title ?? pkg.titulo).trim() || pkg.titulo;
    const videoUrl =
      typeof over.videoUrl === 'string' && over.videoUrl.trim() !== '' ? over.videoUrl.trim() : null;

    destinations.push({
      platform,
      accountId,
      variant,
      idempotencyKey: makeIdempotencyKey(opts.jobId, platform, accountId, variant, pkg.arquivos.video.sha256),
      title,
      caption,
      hashtags: tags,
      videoUrl,
      ...(platform === 'instagram_reels' ? { shareToFeed: over.shareToFeed ?? true } : {}),
      aiDisclosure,
      status: accountId ? 'draft' : 'not_authorized',
      providerPostId: null,
      publicUrl: null,
      publishedAt: null,
      lastError: null,
    });
  }

  return {
    version,
    contract: PUBLISH_CONTRACT,
    jobId: opts.jobId,
    packageVersion: pkg.version,
    assetFile: pkg.arquivos.video.arquivo,
    assetSha256: pkg.arquivos.video.sha256,
    createdAt: new Date().toISOString(),
    status: 'draft',
    approvalMode: 'review_before_publish',
    publicationEnabled: false,
    approvedAt: null,
    approvedBy: null,
    destinations,
  };
}

/** Aprova explicitamente o manifesto de publicação sem executar a postagem ainda. */
export function approvePublishManifest(manifest: PublishManifest, approvedBy: string): PublishManifest {
  const actor = approvedBy.trim();
  if (actor === '') {
    throw new Error('informe quem aprovou a publicação');
  }
  const temAutorizado = manifest.destinations.some((d) => d.accountId !== null);
  if (!temAutorizado) {
    throw new Error('nenhum destino possui accountId autorizado para publicação');
  }
  return {
    ...manifest,
    status: manifest.status === 'published' ? 'published' : 'approved',
    publicationEnabled: true,
    approvedBy: actor,
    approvedAt: new Date().toISOString(),
  };
}

export async function savePublishManifest(
  store: ArtifactStore,
  jobId: string,
  manifest: PublishManifest,
): Promise<void> {
  if (manifest.jobId !== jobId) {
    throw new Error(`manifesto de publicação é do trabalho ${manifest.jobId}, esperado ${jobId}`);
  }
  await store.add(jobId, {
    name: publishManifestName(manifest.version),
    data: `${JSON.stringify(manifest, null, 2)}\n`,
    origin: 'agente-video-publicacao',
    kind: 'publicacao',
  });
}

export async function loadPublishManifest(
  store: ArtifactStore,
  jobId: string,
  version: number,
): Promise<PublishManifest> {
  const nome = publishManifestName(version);
  const raw = await readFile(join(store.root, jobId, nome), 'utf8');
  const parsed = JSON.parse(raw) as Partial<PublishManifest>;
  if (parsed.contract !== PUBLISH_CONTRACT || parsed.jobId !== jobId || !Array.isArray(parsed.destinations)) {
    throw new Error(`${nome} inválido ou incompatível com ${jobId}`);
  }
  return parsed as PublishManifest;
}

const defaultHttpClient: MetaHttpClient = async (url, init) => {
  const body =
    init.body === undefined
      ? undefined
      : typeof init.body === 'string'
        ? init.body
        : new Uint8Array(init.body);
  const res = await fetch(url, {
    method: init.method,
    headers: init.headers,
    body,
  });
  return {
    status: res.status,
    ok: res.ok,
    text: () => res.text(),
  };
};

function defaultSleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function parseMetaJson(res: MetaHttpResponse, context: string, secrets: string[]): Promise<Record<string, unknown>> {
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(redactSecrets(`${context}: resposta não é JSON (HTTP ${res.status}): ${text.slice(0, 160)}`, secrets));
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${context}: resposta inesperada da Meta (HTTP ${res.status})`);
  }
  const rec = parsed as Record<string, unknown>;
  if (!res.ok || rec.error) {
    const errObj = typeof rec.error === 'object' && rec.error !== null ? (rec.error as Record<string, unknown>) : null;
    const detail = errObj?.message ? String(errObj.message) : text.slice(0, 180);
    throw new Error(redactSecrets(`${context}: HTTP ${res.status}: ${detail}`, secrets));
  }
  return rec;
}

function formBody(params: Record<string, string>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) sp.set(k, v);
  return sp.toString();
}

async function publishFacebookReel(
  dest: PublishDestination,
  videoBytes: Uint8Array,
  token: string,
  http: MetaHttpClient,
  apiVersion: string,
  secrets: string[],
): Promise<{ providerPostId: string }> {
  if (!dest.accountId) throw new Error('Facebook Reels exige accountId (ID da Página)');
  const base = `https://graph.facebook.com/${apiVersion}/${encodeURIComponent(dest.accountId)}/video_reels`;

  const startRes = await http(base, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: formBody({ upload_phase: 'start', access_token: token }),
  });
  const startJson = await parseMetaJson(startRes, 'Facebook Reels start', secrets);
  const videoId = typeof startJson.video_id === 'string' ? startJson.video_id : '';
  const uploadUrl = typeof startJson.upload_url === 'string' ? startJson.upload_url : '';
  if (!videoId || !uploadUrl) {
    throw new Error('Facebook Reels start não retornou video_id e upload_url');
  }

  const uploadRes = await http(uploadUrl, {
    method: 'POST',
    headers: {
      Authorization: `OAuth ${token}`,
      offset: '0',
      file_size: String(videoBytes.byteLength),
      'Content-Type': 'application/octet-stream',
    },
    body: videoBytes,
  });
  await parseMetaJson(uploadRes, 'Facebook Reels upload', secrets);

  const finishRes = await http(base, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: formBody({
      upload_phase: 'finish',
      video_id: videoId,
      video_state: 'PUBLISHED',
      description: dest.caption,
      access_token: token,
    }),
  });
  await parseMetaJson(finishRes, 'Facebook Reels finish', secrets);
  return { providerPostId: videoId };
}

async function publishInstagramReel(
  dest: PublishDestination,
  token: string,
  http: MetaHttpClient,
  apiVersion: string,
  maxPolls: number,
  pollIntervalMs: number,
  sleep: (ms: number) => Promise<void>,
  secrets: string[],
): Promise<{ providerPostId: string }> {
  if (!dest.accountId) throw new Error('Instagram Reels exige accountId (ig-user-id)');
  const urlCheck = validatePublicHttpsUrl(dest.videoUrl);
  if (!urlCheck.ok) throw new Error(urlCheck.reason);

  const mediaUrl = `https://graph.facebook.com/${apiVersion}/${encodeURIComponent(dest.accountId)}/media`;
  const createRes = await http(mediaUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: formBody({
      media_type: 'REELS',
      video_url: urlCheck.url,
      caption: dest.caption,
      share_to_feed: dest.shareToFeed === false ? 'false' : 'true',
      access_token: token,
    }),
  });
  const createJson = await parseMetaJson(createRes, 'Instagram media container', secrets);
  const containerId = typeof createJson.id === 'string' ? createJson.id : '';
  if (!containerId) throw new Error('Instagram não retornou container id');

  let finished = false;
  for (let i = 0; i < maxPolls; i++) {
    if (i > 0) await sleep(pollIntervalMs);
    const statusUrl =
      `https://graph.facebook.com/${apiVersion}/${encodeURIComponent(containerId)}` +
      `?fields=status_code,status&access_token=${encodeURIComponent(token)}`;
    const pollRes = await http(statusUrl, { method: 'GET' });
    const pollJson = await parseMetaJson(pollRes, 'Instagram status', secrets);
    const code = typeof pollJson.status_code === 'string' ? pollJson.status_code.toUpperCase() : '';
    if (code === 'FINISHED') {
      finished = true;
      break;
    }
    if (code === 'ERROR' || code === 'EXPIRED') {
      throw new Error(`Instagram container falhou (${code}): ${String(pollJson.status ?? '')}`);
    }
  }
  if (!finished) {
    throw new Error('Instagram container não finalizou processamento dentro do limite de espera');
  }

  const pubUrl = `https://graph.facebook.com/${apiVersion}/${encodeURIComponent(dest.accountId)}/media_publish`;
  const pubRes = await http(pubUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: formBody({ creation_id: containerId, access_token: token }),
  });
  const pubJson = await parseMetaJson(pubRes, 'Instagram media_publish', secrets);
  const postId = typeof pubJson.id === 'string' ? pubJson.id : '';
  if (!postId) throw new Error('Instagram media_publish não retornou id da publicação');
  return { providerPostId: postId };
}

async function publishThreadsVideo(
  dest: PublishDestination,
  token: string,
  http: MetaHttpClient,
  maxPolls: number,
  pollIntervalMs: number,
  sleep: (ms: number) => Promise<void>,
  secrets: string[],
): Promise<{ providerPostId: string }> {
  if (!dest.accountId) throw new Error('Threads exige accountId (threads-user-id)');
  if (dest.caption.length > THREADS_MAX_CAPTION_CHARS) {
    throw new Error(`Threads limita legenda a ${THREADS_MAX_CAPTION_CHARS} caracteres (atual: ${dest.caption.length})`);
  }
  const urlCheck = validatePublicHttpsUrl(dest.videoUrl);
  if (!urlCheck.ok) throw new Error(urlCheck.reason);

  const createUrl = `https://graph.threads.net/v1.0/${encodeURIComponent(dest.accountId)}/threads`;
  const createRes = await http(createUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: formBody({
      media_type: 'VIDEO',
      video_url: urlCheck.url,
      text: dest.caption,
      access_token: token,
    }),
  });
  const createJson = await parseMetaJson(createRes, 'Threads container', secrets);
  const containerId = typeof createJson.id === 'string' ? createJson.id : '';
  if (!containerId) throw new Error('Threads não retornou container id');

  let finished = false;
  for (let i = 0; i < maxPolls; i++) {
    if (i > 0) await sleep(pollIntervalMs);
    const statusUrl =
      `https://graph.threads.net/v1.0/${encodeURIComponent(containerId)}` +
      `?fields=status,error_message&access_token=${encodeURIComponent(token)}`;
    const pollRes = await http(statusUrl, { method: 'GET' });
    const pollJson = await parseMetaJson(pollRes, 'Threads status', secrets);
    const status = typeof pollJson.status === 'string' ? pollJson.status.toUpperCase() : '';
    if (status === 'FINISHED') {
      finished = true;
      break;
    }
    if (status === 'ERROR' || status === 'EXPIRED') {
      throw new Error(`Threads container falhou (${status}): ${String(pollJson.error_message ?? '')}`);
    }
  }
  if (!finished) {
    throw new Error('Threads container não finalizou processamento dentro do limite de espera');
  }

  const pubUrl = `https://graph.threads.net/v1.0/${encodeURIComponent(dest.accountId)}/threads_publish`;
  const pubRes = await http(pubUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: formBody({ creation_id: containerId, access_token: token }),
  });
  const pubJson = await parseMetaJson(pubRes, 'Threads publish', secrets);
  const postId = typeof pubJson.id === 'string' ? pubJson.id : '';
  if (!postId) throw new Error('Threads publish não retornou id da publicação');
  return { providerPostId: postId };
}

function checkDestination(dest: PublishDestination, creds: MetaPublishCredentials): DryRunCheck {
  if (dest.accountId === null) {
    return {
      platform: dest.platform,
      ok: false,
      skipped: true,
      issues: ['conta de destino não vinculada (accountId ausente)'],
    };
  }
  const issues: string[] = [];
  const credStatus = creds.status(dest.platform);
  if (!credStatus.available && credStatus.missing) {
    issues.push(credStatus.missing);
  }
  if (dest.platform === 'instagram_reels' || dest.platform === 'threads') {
    const urlCheck = validatePublicHttpsUrl(dest.videoUrl);
    if (!urlCheck.ok) issues.push(urlCheck.reason);
  }
  if (dest.platform === 'threads' && dest.caption.length > THREADS_MAX_CAPTION_CHARS) {
    issues.push(`legenda do Threads passa de ${THREADS_MAX_CAPTION_CHARS} caracteres`);
  }
  return { platform: dest.platform, ok: issues.length === 0, skipped: false, issues };
}

function summarizeManifestStatus(destinations: readonly PublishDestination[]): PublishManifestStatus {
  const authorized = destinations.filter((d) => d.accountId !== null);
  if (authorized.length === 0) return 'failed';
  const published = authorized.filter((d) => d.status === 'published').length;
  const failed = authorized.filter((d) => d.status === 'failed').length;
  if (published === authorized.length && destinations.every((d) => d.status === 'published')) return 'published';
  if (published > 0 && (failed > 0 || published < destinations.length)) return 'partial';
  if (published === authorized.length) return 'partial';
  if (failed > 0) return 'failed';
  return 'approved';
}

/**
 * Executa (ou simula com `dryRun: true`) o manifesto de publicação nas redes Meta selecionadas.
 * Nunca publica sem `publicationEnabled: true` nem se o MP4 do pacote tiver sido adulterado.
 */
export async function executePublishManifest(
  store: ArtifactStore,
  jobId: string,
  version: number,
  opts: ExecutePublishOptions = {},
): Promise<ExecutePublishResult> {
  const manifest = await loadPublishManifest(store, jobId, version);
  const pkg = await loadPackage(store, jobId, manifest.packageVersion);
  if (pkg.arquivos.video === null || pkg.arquivos.video.sha256 !== manifest.assetSha256) {
    throw new Error('vídeo do pacote não corresponde ao hash aprovado para publicação');
  }

  const dryRun = opts.dryRun ?? false;
  const creds = opts.credentials ?? new MetaPublishCredentials();
  const checks = manifest.destinations.map((dest) => checkDestination(dest, creds));

  if (dryRun) {
    const actionable = checks.filter((c) => !c.skipped);
    const ready = actionable.length > 0 && actionable.every((c) => c.ok);
    return { dryRun: true, ready, manifest, checks };
  }

  if (!manifest.publicationEnabled) {
    throw new Error('publicação bloqueada: manifesto ainda está em rascunho sem aprovação explícita');
  }

  const http = opts.http ?? defaultHttpClient;
  const apiVersion = opts.apiVersion ?? 'v21.0';
  const maxPolls = opts.maxPolls ?? 10;
  const pollIntervalMs = opts.pollIntervalMs ?? 2000;
  const sleep = opts.sleep ?? defaultSleep;
  const secrets = creds.allTokens();
  const videoBytes = await readFile(join(store.root, jobId, pkg.arquivos.video.arquivo));

  let current: PublishManifest = {
    ...manifest,
    status: 'publishing',
    destinations: manifest.destinations.map((d) => ({ ...d })),
  };

  for (let i = 0; i < current.destinations.length; i++) {
    const dest = current.destinations[i]!;
    if (dest.status === 'published') continue; // Idempotência: nunca republica sucesso anterior.
    if (dest.accountId === null) {
      dest.status = 'not_authorized';
      continue;
    }

    try {
      const token = creds.get(dest.platform);
      const tokenSecrets = secrets.includes(token) ? secrets : [...secrets, token];
      let res: { providerPostId: string };
      if (dest.platform === 'facebook_reels') {
        res = await publishFacebookReel(dest, videoBytes, token, http, apiVersion, tokenSecrets);
      } else if (dest.platform === 'instagram_reels') {
        res = await publishInstagramReel(dest, token, http, apiVersion, maxPolls, pollIntervalMs, sleep, tokenSecrets);
      } else {
        res = await publishThreadsVideo(dest, token, http, maxPolls, pollIntervalMs, sleep, tokenSecrets);
      }
      dest.status = 'published';
      dest.providerPostId = res.providerPostId;
      dest.publishedAt = new Date().toISOString();
      dest.lastError = null;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      dest.status = 'failed';
      dest.lastError = redactSecrets(msg, secrets);
    }

    await savePublishManifest(store, jobId, current);
  }

  current = {
    ...current,
    status: summarizeManifestStatus(current.destinations),
  };
  await savePublishManifest(store, jobId, current);

  const ready = current.status === 'published';
  return { dryRun: false, ready, manifest: current, checks };
}
