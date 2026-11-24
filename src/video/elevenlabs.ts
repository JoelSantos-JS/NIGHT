// Adaptador TTS da ElevenLabs para o agente de vídeos do NIGHT.
// Compatível com o contrato Synth (Narrator / VideoAgent). Lê a chave apenas de
// ELEVENLABS_API_KEY ou ~/.elevenlabs/api_key e nunca a expõe em JSON, inspect ou erros.
// Suporta também referência ao servidor MCP remoto oficial (OAuth) da ElevenLabs.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { inspect } from 'node:util';
import { redactSecrets, type ExistsSyncLike, type ReadFileSyncLike } from '../jobs/credentials.ts';
import type { Synth } from './narrate.ts';
import { parseProbe, probeArgs, type RunCommand, type RunResult } from './review.ts';

export const ELEVENLABS_MCP_URL = 'https://api.elevenlabs.io/v1/mcp' as const;
export const DEFAULT_ELEVENLABS_MODEL = 'eleven_multilingual_v2' as const;
export const DEFAULT_ELEVENLABS_VOICE_ID = 'pNInz6obpgDQGcFmaJgB' as const;

export interface ElevenLabsVoiceSettings {
  stability: number;
  similarity_boost: number;
  style: number;
  use_speaker_boost: boolean;
  speed: number;
}

export const DEFAULT_ELEVENLABS_VOICE_SETTINGS: Readonly<ElevenLabsVoiceSettings> = {
  stability: 0.4,
  similarity_boost: 0.8,
  style: 0.35,
  use_speaker_boost: true,
  speed: 1.08,
};

export interface ElevenLabsCredentialStatus {
  available: boolean;
  missing: string | null;
}

export interface ElevenLabsCredentialsOptions {
  env?: NodeJS.ProcessEnv;
  exists?: ExistsSyncLike;
  readFile?: ReadFileSyncLike;
}

function defaultKeyFile(): string {
  return join(homedir(), '.elevenlabs', 'api_key');
}

const MISSING_KEY_MSG =
  'falta a chave da ElevenLabs: defina ELEVENLABS_API_KEY ou crie ~/.elevenlabs/api_key';

/**
 * Credenciais isoladas da ElevenLabs. Nunca serializa nem imprime o segredo.
 */
export class ElevenLabsCredentials {
  private readonly env: NodeJS.ProcessEnv;
  private readonly exists: ExistsSyncLike;
  private readonly readFile: ReadFileSyncLike;

  constructor(opts: ElevenLabsCredentialsOptions = {}) {
    this.env = opts.env ?? process.env;
    this.exists = opts.exists ?? existsSync;
    this.readFile = opts.readFile ?? ((p, enc) => readFileSync(p, enc));
  }

  status(): ElevenLabsCredentialStatus {
    const available = this.resolve() !== null;
    return {
      available,
      missing: available ? null : MISSING_KEY_MSG,
    };
  }

  get(): string {
    const key = this.resolve();
    if (key === null) throw new Error(MISSING_KEY_MSG);
    return key;
  }

  toJSON(): { available: boolean } {
    return { available: this.status().available };
  }

  [inspect.custom](): string {
    return `ElevenLabsCredentials ${JSON.stringify(this.toJSON())}`;
  }

  private resolve(): string | null {
    const fromEnv = this.env.ELEVENLABS_API_KEY;
    if (typeof fromEnv === 'string' && fromEnv.trim() !== '') {
      return fromEnv.trim();
    }
    const keyFile = defaultKeyFile();
    if (!this.exists(keyFile)) return null;
    try {
      const text = this.readFile(keyFile, 'utf8').trim();
      return text === '' ? null : text;
    } catch {
      return null;
    }
  }
}

export interface ElevenLabsHttpRequest {
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
}

export interface ElevenLabsHttpResponse {
  status: number;
  ok: boolean;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}

export type ElevenLabsHttpClient = (
  url: string,
  init: ElevenLabsHttpRequest,
) => Promise<ElevenLabsHttpResponse>;

export interface ElevenLabsSynthOptions {
  credentials?: ElevenLabsCredentials;
  voiceId?: string;
  modelId?: string;
  voiceSettings?: Partial<ElevenLabsVoiceSettings>;
  http?: ElevenLabsHttpClient;
  run?: RunCommand;
  baseUrl?: string;
}

export interface ElevenLabsVoice {
  voiceId: string;
  name: string;
  category: string | null;
}

const defaultHttpClient: ElevenLabsHttpClient = async (url, init) => {
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

const defaultRunCommand: RunCommand = (bin, args): Promise<RunResult> =>
  new Promise((resolveRun, rejectRun) => {
    const child = spawn(bin, args, { shell: false });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: string) => { stdout += d; });
    child.stderr.on('data', (d: string) => { stderr += d; });
    child.on('error', (err) => rejectRun(new Error(`não consegui executar ${bin}: ${err.message}`)));
    child.on('close', (code) => resolveRun({ code: code ?? -1, stdout, stderr }));
  });

/**
 * Cria um sintetizador compatível com `Narrator` usando a API REST v1 da ElevenLabs.
 * Converte o MP3 recebido em WAV 48 kHz estéreo e mede a duração real via `ffprobe`.
 */
export function createElevenLabsSynth(opts: ElevenLabsSynthOptions = {}): Synth {
  const creds = opts.credentials ?? new ElevenLabsCredentials();
  const http = opts.http ?? defaultHttpClient;
  const run = opts.run ?? defaultRunCommand;
  const baseUrl = (opts.baseUrl ?? 'https://api.elevenlabs.io').replace(/\/+$/, '');
  const modelId = opts.modelId ?? DEFAULT_ELEVENLABS_MODEL;
  const voiceSettings: ElevenLabsVoiceSettings = {
    ...DEFAULT_ELEVENLABS_VOICE_SETTINGS,
    ...opts.voiceSettings,
  };

  return async (text, _language, file) => {
    const clean = text.trim();
    if (clean === '') throw new Error('texto vazio para síntese na ElevenLabs');

    const apiKey = creds.get();
    const envVoice = process.env.NIGHT_ELEVENLABS_VOICE_ID?.trim();
    const voiceId = opts.voiceId ?? (envVoice && envVoice !== '' ? envVoice : DEFAULT_ELEVENLABS_VOICE_ID);
    const url = `${baseUrl}/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`;

    const res = await http(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'xi-api-key': apiKey,
        Accept: 'audio/mpeg',
      },
      body: JSON.stringify({
        text: clean,
        model_id: modelId,
        voice_settings: voiceSettings,
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(
        redactSecrets(
          `ElevenLabs TTS falhou (HTTP ${res.status}): ${errText.slice(0, 200) || 'sem detalhe'}`,
          [apiKey],
        ),
      );
    }

    const audioBuf = Buffer.from(await res.arrayBuffer());
    if (audioBuf.length === 0) {
      throw new Error('ElevenLabs retornou áudio vazio');
    }

    await mkdir(dirname(file), { recursive: true });
    const tmpMp3 = `${file}.tmp.mp3`;
    await writeFile(tmpMp3, audioBuf);

    try {
      const conv = await run('ffmpeg', [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-i',
        tmpMp3,
        '-ar',
        '48000',
        '-ac',
        '2',
        file,
      ]);
      if (conv.code !== 0) {
        throw new Error(`ffmpeg falhou ao converter áudio da ElevenLabs (${conv.code}): ${conv.stderr.trim()}`);
      }

      const probed = await run('ffprobe', probeArgs(file));
      if (probed.code !== 0) {
        throw new Error(`ffprobe falhou ao ler duração do WAV (${probed.code}): ${probed.stderr.trim()}`);
      }
      const info = parseProbe(probed.stdout);
      if (!Number.isFinite(info.durationSec) || info.durationSec <= 0) {
        throw new Error(`duração inválida retornada pelo ffprobe: ${info.durationSec}`);
      }
      return { audioSeconds: info.durationSec };
    } finally {
      await rm(tmpMp3, { force: true }).catch(() => undefined);
    }
  };
}

export interface ListVoicesOptions {
  credentials?: ElevenLabsCredentials;
  http?: ElevenLabsHttpClient;
  baseUrl?: string;
}

/** Lista as vozes disponíveis na conta ElevenLabs (sem expor a chave). */
export async function listElevenLabsVoices(opts: ListVoicesOptions = {}): Promise<ElevenLabsVoice[]> {
  const creds = opts.credentials ?? new ElevenLabsCredentials();
  const http = opts.http ?? defaultHttpClient;
  const baseUrl = (opts.baseUrl ?? 'https://api.elevenlabs.io').replace(/\/+$/, '');
  const apiKey = creds.get();

  const res = await http(`${baseUrl}/v1/voices`, {
    method: 'GET',
    headers: {
      'xi-api-key': apiKey,
      Accept: 'application/json',
    },
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      redactSecrets(
        `ElevenLabs voices falhou (HTTP ${res.status}): ${text.slice(0, 200) || 'sem detalhe'}`,
        [apiKey],
      ),
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('ElevenLabs voices devolveu JSON inválido');
  }
  const voices =
    typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { voices?: unknown }).voices)
      ? (parsed as { voices: unknown[] }).voices
      : [];

  return voices.flatMap((v) => {
    if (typeof v !== 'object' || v === null) return [];
    const rec = v as Record<string, unknown>;
    const voiceId = typeof rec.voice_id === 'string' ? rec.voice_id : '';
    const name = typeof rec.name === 'string' ? rec.name : '';
    if (!voiceId || !name) return [];
    const category = typeof rec.category === 'string' ? rec.category : null;
    return [{ voiceId, name, category }];
  });
}
