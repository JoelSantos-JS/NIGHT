// Serviço de consulta do DeepSeek (D09): decide se consulta, reaproveita cache,
// respeita teto por ponto e grava TODO resultado no diário.
// Falha nunca vira aprovação: ou o parecer existe, ou fica parecer_indisponivel.

import { createHash } from 'node:crypto';
import type { AdvisorFailureReason, AdvisorResult } from './deepseek-client.ts';
import type { AdvisorJournal, AdvisorRole } from './journal.ts';
import { shouldConsult } from './matrix.ts';
import type { Impacto } from './matrix.ts';
import type { AdvisorInput, Opinion } from './opinion.ts';

/** O que o serviço precisa do conselheiro; DeepSeekAdvisor cumpre este contrato. */
export interface OpinionAdvisor {
  ask(input: AdvisorInput): Promise<AdvisorResult>;
  model: string;
}

/** 'erro' cobre um advisor trocado que lance, fora do contrato do cliente. */
export type ConsultFailureReason = AdvisorFailureReason | 'erro';

export interface ConsultContext {
  impacto?: Impacto;
  simples?: boolean;
  role?: AdvisorRole;
}

export type ConsultResult =
  | { status: 'dispensado'; motivo: string }
  | { status: 'cache'; opinion: Opinion; entryId: string }
  | { status: 'ok'; opinion: Opinion; entryId: string }
  | { status: 'em_andamento'; motivo: string }
  | { status: 'parecer_indisponivel'; reason: ConsultFailureReason; detail: string; entryId: string }
  | { status: 'teto'; motivo: string };

/** JSON com chaves ordenadas: a mesma entrada lógica gera sempre o mesmo hash. */
function stableJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function inputHash(input: AdvisorInput): string {
  return createHash('sha256').update(stableJson(input)).digest('hex');
}

export class AdvisorService {
  /** Mesmo hash da função exportada; fica na instância para diagnóstico e testes. */
  readonly inputHash: (input: AdvisorInput) => string = inputHash;

  // O modelo é o do advisor recebido. Escolher flash/pro pelo limite.modelo do ponto
  // é responsabilidade de quem monta o advisor (uma fábrica advisorFor(modelo) pode fazer isso).
  constructor(
    private readonly advisor: OpinionAdvisor,
    private readonly journal: AdvisorJournal,
  ) {}

  async consult(pointId: string, input: AdvisorInput, ctx: ConsultContext = {}): Promise<ConsultResult> {
    const decision = shouldConsult(pointId, { impacto: ctx.impacto, simples: ctx.simples });
    if (!decision.consultar || !decision.point) {
      return { status: 'dispensado', motivo: decision.motivo };
    }
    const point = decision.point;
    const hash = inputHash(input);
    const role: AdvisorRole = ctx.role ?? 'conselheiro';

    // Reserva atômica ANTES de pagar a API: cache, chamada em andamento ou teto.
    const reserva = await this.journal.reserve(
      input.jobId, pointId, hash, point.limite.maxChamadas,
    );
    if (reserva.kind === 'cache') {
      // Cache só existe com parecer; falha nunca vira aprovação repetida.
      const opinion = reserva.entry.opinion;
      if (opinion) return { status: 'cache', opinion, entryId: reserva.entry.id };
    }
    if (reserva.kind === 'em_andamento') {
      return {
        status: 'em_andamento',
        motivo: `outra consulta da mesma entrada já está em andamento em ${pointId}; parecer não refeito`,
      };
    }
    if (reserva.kind === 'teto') {
      return {
        status: 'teto',
        motivo: `teto de ${point.limite.maxChamadas} chamada(s) para ${pointId} já atingido neste trabalho; parecer não refeito`,
      };
    }
    // Sem reserva válida (cache sem parecer não deveria acontecer): não chama a API sem reserva.
    if (reserva.kind !== 'reservado') {
      return {
        status: 'em_andamento',
        motivo: `reserva indisponível para ${pointId}; parecer não refeito`,
      };
    }

    let result: AdvisorResult;
    try {
      result = await this.advisor.ask(input);
    } catch {
      // O contrato do cliente é não lançar; se um advisor trocado lançar, registra a falha
      // em vez de deixar o erro subir e virar aprovação silenciosa.
      const entry = await this.journal.complete(reserva.reservationId, {
        jobId: input.jobId, pointId, inputHash: hash, model: this.advisor.model,
        ok: false, reason: 'erro', opinion: null, promptTokens: null, completionTokens: null,
        ms: 0, role,
      });
      return {
        status: 'parecer_indisponivel',
        reason: 'erro',
        detail: 'falha inesperada do conselheiro; o parecer não foi feito',
        entryId: entry.id,
      };
    }

    if (result.ok) {
      const entry = await this.journal.complete(reserva.reservationId, {
        jobId: input.jobId, pointId, inputHash: hash, model: this.advisor.model,
        ok: true, reason: null, opinion: result.opinion,
        promptTokens: result.usage?.promptTokens ?? null,
        completionTokens: result.usage?.completionTokens ?? null,
        ms: result.ms, role,
      });
      return { status: 'ok', opinion: result.opinion, entryId: entry.id };
    }

    // Falha fica registrada com motivo e tempo; nunca é convertida em 'ok'.
    const entry = await this.journal.complete(reserva.reservationId, {
      jobId: input.jobId, pointId, inputHash: hash, model: this.advisor.model,
      ok: false, reason: result.reason, opinion: null, promptTokens: null, completionTokens: null,
      ms: result.ms, role,
    });
    return { status: 'parecer_indisponivel', reason: result.reason, detail: result.detail, entryId: entry.id };
  }
}
