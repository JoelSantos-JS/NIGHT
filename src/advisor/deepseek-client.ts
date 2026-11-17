// Cliente da API DeepSeek para o parecer (docs/research/plano-deepseek.md, D03).
// A chave vem de fora (ambiente ou arquivo), nunca do código; não vai para erro, detalhe nem log.
// Falha de disponibilidade vira parecer_indisponivel — nunca aprovação.

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { buildAdvisorMessages, parseOpinion } from './opinion.ts';
import type { AdvisorInput, AdvisorMessage, Opinion } from './opinion.ts';

export const DEFAULT_MODEL = 'deepseek-flash';
export const DEFAULT_BASE_URL = 'https://api.deepseek.com';
export const DEFAULT_TIMEOUT_MS = 60_000;

export type AdvisorFailureReason =
  | 'sem_chave'
  | 'saldo'
  | 'limite'
  | 'timeout'
  | 'http'
  | 'resposta_invalida'
  | 'rede';

export interface AdvisorUsage {
  promptTokens: number;
  completionTokens: number;
}

export type AdvisorResult =
  | { ok: true; opinion: Opinion; model: string; ms: number; usage: AdvisorUsage | null }
  | { ok: false; state: 'parecer_indisponivel'; reason: AdvisorFailureReason; detail: string; model: string; ms: number };

export interface DeepSeekConfig {
  apiKey: () => Promise<string> | string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** Chave do ambiente ou do arquivo (~/.deepseek/api_key). O erro não mostra o conteúdo. */
export async function loadDeepSeekKey(file = path.join(homedir(), '.deepseek', 'api_key')): Promise<string> {
  const fromEnv = process.env.DEEPSEEK_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  try {
    const fromFile = (await readFile(file, 'utf8')).trim();
    if (fromFile) return fromFile;
  } catch {
    // arquivo ausente ou ilegível: cai no erro abaixo
  }
  throw new Error(`sem chave da API DeepSeek: defina DEEPSEEK_API_KEY ou crie ${file}`);
}

type ChatBody = {
  choices?: { message?: { content?: unknown } }[];
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
};

function readUsage(usage: ChatBody['usage']): AdvisorUsage | null {
  const prompt = usage?.prompt_tokens;
  const completion = usage?.completion_tokens;
  if (typeof prompt !== 'number' || typeof completion !== 'number') return null;
  return { promptTokens: prompt, completionTokens: completion };
}

function abortError(): Error {
  return Object.assign(new Error('abortado'), { name: 'AbortError' });
}

/**
 * Corrida com o abort: o tempo-limite precisa valer mesmo se o fetch ou o res.json() ignorarem o
 * signal (um corpo que nunca termina não pode segurar o parecer para sempre).
 */
function readBeforeAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function wasAborted(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error as Error | undefined)?.name === 'AbortError';
}

export class DeepSeekAdvisor {
  readonly model: string;
  private readonly apiKey: () => Promise<string> | string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: DeepSeekConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? DEFAULT_MODEL;
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    // Guardado como campo para os testes trocarem por um fetch falso.
    this.fetchImpl = config.fetchImpl ?? ((url, init) => globalThis.fetch(url, init));
  }

  /** Nunca lança; indisponibilidade fica explícita no resultado. */
  async ask(input: AdvisorInput): Promise<AdvisorResult> {
    const started = Date.now();
    const model = this.model;
    const fail = (reason: AdvisorFailureReason, detail: string): AdvisorResult => ({
      ok: false,
      state: 'parecer_indisponivel',
      reason,
      detail,
      model,
      ms: Date.now() - started,
    });

    let key = '';
    try {
      key = ((await this.apiKey()) ?? '').trim();
    } catch {
      key = '';
    }
    if (!key) return fail('sem_chave', 'sem chave da API DeepSeek; o parecer não foi feito');

    const messages: AdvisorMessage[] = buildAdvisorMessages(input);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    // O timer só é limpo no fim: o limite cobre a chamada E a leitura do corpo, não só os cabeçalhos.
    try {
      let res: Response;
      try {
        res = await readBeforeAbort(
          Promise.resolve().then(() =>
            this.fetchImpl(`${this.baseUrl}/chat/completions`, {
              method: 'POST',
              headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
              body: JSON.stringify({ model, messages, response_format: { type: 'json_object' }, stream: false }),
              signal: controller.signal,
            }),
          ),
          controller.signal,
        );
      } catch (e) {
        if (wasAborted(e, controller.signal)) {
          return fail('timeout', `DeepSeek passou de ${this.timeoutMs} ms; o parecer não foi feito`);
        }
        return fail('rede', 'falha de rede ao falar com o DeepSeek; o parecer não foi feito');
      }

      if (!res.ok) {
        if (res.status === 401) return fail('sem_chave', 'DeepSeek recusou a chave (HTTP 401)');
        if (res.status === 402) return fail('saldo', 'saldo da API DeepSeek esgotado (HTTP 402)');
        if (res.status === 429) return fail('limite', 'limite de uso da API DeepSeek atingido (HTTP 429)');
        return fail('http', `DeepSeek respondeu HTTP ${res.status}`);
      }

      let body: ChatBody;
      try {
        body = await readBeforeAbort<ChatBody>(res.json() as Promise<ChatBody>, controller.signal);
      } catch (e) {
        // Abortar no meio do corpo é timeout; JSON quebrado de verdade é resposta inválida.
        if (wasAborted(e, controller.signal)) {
          return fail('timeout', `DeepSeek passou de ${this.timeoutMs} ms; o parecer não foi feito`);
        }
        return fail('resposta_invalida', 'resposta do DeepSeek não é JSON');
      }

      const content = body.choices?.[0]?.message?.content;
      if (typeof content !== 'string') return fail('resposta_invalida', 'resposta do DeepSeek sem conteúdo');

      // Só vale citar evidência que o NIGHT mandou: ref inventada derruba o parecer.
      const allowedRefs = new Set(input.evidencias.map((ev) => ev.ref));
      const parsed = parseOpinion(content, allowedRefs);
      if (!parsed.ok) return fail('resposta_invalida', `parecer inválido: ${parsed.error}`);

      // Parecer de outro trabalho não vale: o pedido foi por um job_id e a resposta é de outro.
      if (parsed.opinion.jobId !== input.jobId) {
        return fail(
          'resposta_invalida',
          `parecer é de outro trabalho: job_id "${parsed.opinion.jobId}" não confere com "${input.jobId}"`,
        );
      }

      return { ok: true, opinion: parsed.opinion, model, ms: Date.now() - started, usage: readUsage(body.usage) };
    } finally {
      clearTimeout(timer);
    }
  }
}
