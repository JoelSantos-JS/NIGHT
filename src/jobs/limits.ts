// Limites por trabalho (F05), em código puro: sem banco, sem rede, sem relógio global.
// Cada tipo de trabalho tem um teto conservador de chamadas, tempo, armazenamento e custo.
// O objetivo é parar cedo, antes de gastar dinheiro ou encher o disco sem o Joel perceber.

import type { JobKind } from '../core/types.ts';

export interface JobLimits {
  maxCalls?: number;
  maxMs?: number;
  maxStorageBytes?: number;
  maxCostUsd?: number;
}

/** Teto padrão por tipo de trabalho. Valores conservadores de propósito: subir é decisão do dono. */
export const DEFAULT_LIMITS: Readonly<Record<JobKind, Required<JobLimits>>> = {
  // Radar é pesquisa barata e repetitiva: 50 chamadas dão para varrer o nicho sem exagerar.
  radar: { maxCalls: 50, maxMs: 20 * 60_000, maxStorageBytes: 50 * 1024 * 1024, maxCostUsd: 0.5 },
  // Vídeo gasta mais: 200 chamadas e 2 GB cobrem um render por trabalho, ainda com folga.
  video: { maxCalls: 200, maxMs: 60 * 60_000, maxStorageBytes: 2 * 1024 ** 3, maxCostUsd: 1 },
  // Codar envolve mais idas e voltas: 100 chamadas e 30 minutos, com 200 MB de artefatos.
  coding: { maxCalls: 100, maxMs: 30 * 60_000, maxStorageBytes: 200 * 1024 * 1024, maxCostUsd: 0.5 },
  // Produto low-ticket: 5 textos (4 PDFs + bônus) com até 2 tentativas cada, mais o parecer.
  lowticket: { maxCalls: 15, maxMs: 20 * 60_000, maxStorageBytes: 100 * 1024 * 1024, maxCostUsd: 0.3 },
  // Campanha: poucas chamadas à Meta, uma por item, sem repetição automática (M06).
  campanha: { maxCalls: 20, maxMs: 15 * 60_000, maxStorageBytes: 5 * 1024 * 1024, maxCostUsd: 0 },
};

export type LimitName = 'calls' | 'time' | 'storage' | 'cost';

export type LimitCheck = { ok: true } | { ok: false; limit: LimitName; detail: string };

export interface UsageSummary {
  calls: number;
  ms: number;
  storageBytes: number;
  costUsd: number;
}

/** Erro lançado por assertWithin: quem chama sabe qual teto estourou sem ler a mensagem. */
export class LimitExceededError extends Error {
  readonly limit: LimitName;
  constructor(limit: LimitName, detail: string) {
    super(detail);
    this.name = 'LimitExceededError';
    this.limit = limit;
  }
}

function descrever(valor: unknown): string {
  return typeof valor === 'number' ? String(valor) : `${typeof valor} ${String(valor)}`;
}

/**
 * Junta os ajustes pedidos com o padrão do tipo de trabalho.
 * Negativo/NaN/não número lança: limite inválido não pode virar "sem limite" por acidente.
 * Campo desconhecido também lança: é quase sempre erro de digitação (maxCall em vez de maxCalls).
 */
export function parseLimits(raw: unknown, kind: JobKind): JobLimits {
  const base = DEFAULT_LIMITS[kind];
  if (!base) throw new Error(`trabalho desconhecido: ${String(kind)}`);
  const out: Required<JobLimits> = { ...base };
  if (raw === undefined || raw === null) return out;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`limites inválidos: esperava um objeto, recebi ${descrever(raw)}`);
  }
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new Error(`limite ${key} inválido: esperava número maior ou igual a zero, recebi ${descrever(value)}`);
    }
    switch (key) {
      case 'maxCalls':
        out.maxCalls = value;
        break;
      case 'maxMs':
        out.maxMs = value;
        break;
      case 'maxStorageBytes':
        out.maxStorageBytes = value;
        break;
      case 'maxCostUsd':
        out.maxCostUsd = value;
        break;
      default:
        throw new Error(`limite desconhecido: ${key}`);
    }
  }
  return out;
}

function formatarBytes(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  if (Number.isInteger(gb)) return `${gb} GB`;
  const mb = bytes / 1024 ** 2;
  const texto = Number.isInteger(mb) ? String(mb) : mb.toFixed(1).replace('.', ',');
  return `${texto} MB`;
}

function formatarMs(ms: number): string {
  if (ms % 60_000 === 0) {
    const minutos = ms / 60_000;
    return `${minutos} ${minutos === 1 ? 'minuto' : 'minutos'}`;
  }
  const segundos = ms / 1000;
  return `${segundos} ${segundos === 1 ? 'segundo' : 'segundos'}`;
}

function formatarUsd(usd: number): string {
  const texto = usd.toFixed(2).replace('.', ',');
  return texto.endsWith(',00') ? texto.slice(0, -3) : texto;
}

/** Conta chamadas, tempo, armazenamento e custo de um trabalho e avisa quando passa do teto. */
export class LimitTracker {
  private readonly limits: JobLimits;
  private readonly now: () => number;
  private readonly startedAt: number;
  private calls = 0;
  private storageBytes = 0;
  private costUsd = 0;

  constructor(limits: JobLimits, now: () => number = () => Date.now()) {
    this.limits = { ...limits };
    this.now = now;
    // O tempo conta desde a criação do tracker: não há relógio global escondido.
    this.startedAt = now();
  }

  call(n = 1): void {
    if (!Number.isInteger(n) || n < 1) throw new Error('cada chamada conta ao menos 1');
    this.calls += n;
  }

  addStorage(bytes: number): void {
    if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) {
      throw new Error('armazenamento inválido: esperava número de bytes maior ou igual a zero');
    }
    this.storageBytes += bytes;
  }

  addCost(usd: number): void {
    if (typeof usd !== 'number' || !Number.isFinite(usd) || usd < 0) {
      throw new Error('custo inválido: esperava valor em dólar maior ou igual a zero');
    }
    this.costUsd += usd;
  }

  /** Primeiro teto estourado, na ordem em que o trabalho costuma gastar. */
  check(): LimitCheck {
    return this.evaluate(this.calls);
  }

  /** Chamar antes de mais uma chamada: lança em vez de deixar passar do teto. */
  assertWithin(): void {
    // A chamada que vai acontecer também conta: com calls == maxCalls ela já seria a de número
    // maxCalls + 1. Tempo, armazenamento e custo continuam valendo pelo que já foi gasto.
    const resultado = this.evaluate(this.calls + 1);
    if (!resultado.ok) throw new LimitExceededError(resultado.limit, resultado.detail);
  }

  /** Estado com a contagem de chamadas informada; assertWithin usa calls + 1 (a próxima). */
  private evaluate(calls: number): LimitCheck {
    const { maxCalls, maxMs, maxStorageBytes, maxCostUsd } = this.limits;
    if (maxCalls !== undefined && calls > maxCalls) {
      // Contagem acima da atual só vem do assertWithin: a chamada ainda não aconteceu.
      const verbo = calls > this.calls ? 'a próxima chamada passaria do' : 'passou do';
      return {
        ok: false,
        limit: 'calls',
        detail: `${verbo} limite de ${maxCalls} ${maxCalls === 1 ? 'chamada' : 'chamadas'}`,
      };
    }
    const ms = this.elapsedMs();
    if (maxMs !== undefined && ms > maxMs) {
      return { ok: false, limit: 'time', detail: `passou do limite de ${formatarMs(maxMs)}` };
    }
    if (maxStorageBytes !== undefined && this.storageBytes > maxStorageBytes) {
      return {
        ok: false,
        limit: 'storage',
        detail: `passou do limite de ${formatarBytes(maxStorageBytes)}`,
      };
    }
    if (maxCostUsd !== undefined && this.costUsd > maxCostUsd) {
      return { ok: false, limit: 'cost', detail: `passou do limite de US$ ${formatarUsd(maxCostUsd)}` };
    }
    return { ok: true };
  }

  /** Resumo para o relatório do trabalho. */
  usage(): UsageSummary {
    return {
      calls: this.calls,
      ms: this.elapsedMs(),
      storageBytes: this.storageBytes,
      costUsd: this.costUsd,
    };
  }

  private elapsedMs(): number {
    return Math.max(0, this.now() - this.startedAt);
  }
}
