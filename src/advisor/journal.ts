// Diário dos pareceres (D08/D09): registra sucesso OU falha, com uso e tempo.
// O banco é a fonte durável; a versão em memória serve a testes e a execução sem banco.
// job_id não tem FK: o diário atende job de código, radar ou vídeo.

import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { DEFAULT_DATABASE_URL, migrate } from '../memory/pg-memory.ts';
import type { Opinion } from './opinion.ts';

export type AdvisorRole = 'conselheiro' | 'reserva-codex';

export interface AdvisorJournalEntry {
  id: string;
  jobId: string;
  pointId: string;
  inputHash: string;
  /** ISO 8601; o banco usa clock_timestamp(). */
  at: string;
  /** null enquanto a reserva está pendente (o modelo só é conhecido ao concluir). */
  model: string | null;
  ok: boolean;
  /** Motivo da indisponibilidade; null quando ok = true. */
  reason: string | null;
  opinion: Opinion | null;
  promptTokens: number | null;
  completionTokens: number | null;
  ms: number;
  author: string;
  role: AdvisorRole;
}

/** O que o serviço manda gravar; id e horário são gerados pelo diário. */
export interface AdvisorJournalInput {
  jobId: string;
  pointId: string;
  inputHash: string;
  model: string;
  ok: boolean;
  reason?: string | null;
  opinion?: Opinion | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  ms: number;
  author?: string;
  /** Sem papel explícito, o parecer é do conselheiro. */
  role?: AdvisorRole;
}

/** Resultado da reserva atômica feita antes de chamar a API paga. */
export type AdvisorReservation =
  | { kind: 'reservado'; reservationId: string }
  | { kind: 'cache'; entry: AdvisorJournalEntry }
  | { kind: 'em_andamento' }
  | { kind: 'teto' };

export interface AdvisorJournal {
  record(entry: AdvisorJournalInput): Promise<AdvisorJournalEntry>;
  /**
   * Reserva a chamada de forma atômica: consultas simultâneas da mesma entrada não podem
   * ler o mesmo cache vazio e disparar duas chamadas pagas.
   */
  reserve(jobId: string, pointId: string, inputHash: string, maxChamadas: number): Promise<AdvisorReservation>;
  /** Conclui a reserva na mesma linha, com parecer ou falha, uso e tempo. */
  complete(reservationId: string, entry: AdvisorJournalInput): Promise<AdvisorJournalEntry>;
  /** Só parecer com ok = true vale como cache: falha não vira aprovação repetida. */
  findCached(jobId: string, pointId: string, inputHash: string): Promise<AdvisorJournalEntry | null>;
  /** Chamadas já feitas neste ponto do trabalho, inclusive as que falharam. */
  countCalls(jobId: string, pointId: string): Promise<number>;
  list(jobId: string): Promise<AdvisorJournalEntry[]>;
}

type Row = Record<string, any>;

const toEntry = (r: Row): AdvisorJournalEntry => ({
  id: r.id,
  jobId: r.job_id,
  pointId: r.point_id,
  inputHash: r.input_hash,
  at: new Date(r.at).toISOString(),
  model: r.model,
  ok: r.ok,
  reason: r.reason,
  opinion: r.opinion,
  promptTokens: r.prompt_tokens,
  completionTokens: r.completion_tokens,
  ms: r.ms,
  author: r.author,
  role: r.role,
});

export class PgAdvisorJournal implements AdvisorJournal {
  private constructor(private readonly pool: pg.Pool) {}

  /** Conecta e aplica as migrações pendentes, como PgMemory.open. */
  static async open(connectionString = process.env.NIGHT_DATABASE_URL ?? DEFAULT_DATABASE_URL): Promise<PgAdvisorJournal> {
    const pool = new pg.Pool({ connectionString, max: 5 });
    try {
      await migrate(pool);
    } catch (err) {
      await pool.end();
      throw err;
    }
    return new PgAdvisorJournal(pool);
  }

  async record(entry: AdvisorJournalInput): Promise<AdvisorJournalEntry> {
    const { rows } = await this.pool.query(
      `INSERT INTO advisor_opinions
         (id, job_id, point_id, input_hash, model, ok, reason, opinion,
          prompt_tokens, completion_tokens, ms, author, role)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *`,
      [
        randomUUID(), entry.jobId, entry.pointId, entry.inputHash, entry.model, entry.ok,
        entry.reason ?? null, entry.opinion ?? null, entry.promptTokens ?? null,
        entry.completionTokens ?? null, entry.ms, entry.author ?? 'deepseek', entry.role ?? 'conselheiro',
      ],
    );
    return toEntry(rows[0]!);
  }

  async reserve(jobId: string, pointId: string, inputHash: string, maxChamadas: number): Promise<AdvisorReservation> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Trava por trabalho+ponto: as leituras e a inserção da reserva ficam serializadas,
      // então duas consultas simultâneas não passam juntas pelo mesmo cache vazio.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${jobId}:${pointId}`]);
      // Reserva parada há mais de 10 min conta como abandonada e não segura o ponto.
      await client.query(
        `UPDATE advisor_opinions
            SET status = 'concluida', ok = false, reason = 'abandonada'
          WHERE job_id = $1 AND point_id = $2 AND status = 'pendente'
            AND at < now() - interval '10 minutes'`,
        [jobId, pointId],
      );
      const cache = await client.query(
        `SELECT * FROM advisor_opinions
          WHERE job_id = $1 AND point_id = $2 AND input_hash = $3 AND ok AND opinion IS NOT NULL
          ORDER BY at DESC LIMIT 1`,
        [jobId, pointId, inputHash],
      );
      if (cache.rows[0]) {
        await client.query('COMMIT');
        return { kind: 'cache', entry: toEntry(cache.rows[0]) };
      }
      const pendente = await client.query(
        `SELECT 1 FROM advisor_opinions
          WHERE job_id = $1 AND point_id = $2 AND input_hash = $3 AND status = 'pendente' LIMIT 1`,
        [jobId, pointId, inputHash],
      );
      if ((pendente.rowCount ?? 0) > 0) {
        await client.query('COMMIT');
        return { kind: 'em_andamento' };
      }
      // O teto conta concluídas e pendentes: toda tentativa custa tempo (e talvez token).
      const { rows } = await client.query(
        'SELECT count(*)::int AS n FROM advisor_opinions WHERE job_id = $1 AND point_id = $2',
        [jobId, pointId],
      );
      if ((rows[0]?.n ?? 0) >= maxChamadas) {
        await client.query('COMMIT');
        return { kind: 'teto' };
      }
      const reservationId = randomUUID();
      // Nasce pendente, sem modelo nem parecer; complete() preenche a mesma linha depois.
      await client.query(
        `INSERT INTO advisor_opinions
           (id, job_id, point_id, input_hash, model, ok, reason, opinion,
            prompt_tokens, completion_tokens, ms, author, role, status)
         VALUES ($1, $2, $3, $4, NULL, false, NULL, NULL, NULL, NULL, 0, 'deepseek', 'conselheiro', 'pendente')`,
        [reservationId, jobId, pointId, inputHash],
      );
      await client.query('COMMIT');
      return { kind: 'reservado', reservationId };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async complete(reservationId: string, entry: AdvisorJournalInput): Promise<AdvisorJournalEntry> {
    const { rows } = await this.pool.query(
      `UPDATE advisor_opinions
          SET model = $2, ok = $3, reason = $4, opinion = $5, prompt_tokens = $6,
              completion_tokens = $7, ms = $8, author = $9, role = $10, status = 'concluida'
        WHERE id = $1 RETURNING *`,
      [
        reservationId, entry.model, entry.ok, entry.reason ?? null, entry.opinion ?? null,
        entry.promptTokens ?? null, entry.completionTokens ?? null, entry.ms,
        entry.author ?? 'deepseek', entry.role ?? 'conselheiro',
      ],
    );
    const row = rows[0];
    if (!row) throw new Error(`reserva ${reservationId} não encontrada no diário`);
    return toEntry(row);
  }

  async findCached(jobId: string, pointId: string, inputHash: string): Promise<AdvisorJournalEntry | null> {
    const { rows } = await this.pool.query(
      `SELECT * FROM advisor_opinions
       WHERE job_id = $1 AND point_id = $2 AND input_hash = $3 AND ok
       ORDER BY at DESC LIMIT 1`,
      [jobId, pointId, inputHash],
    );
    return rows[0] ? toEntry(rows[0]) : null;
  }

  async countCalls(jobId: string, pointId: string): Promise<number> {
    const { rows } = await this.pool.query(
      'SELECT count(*)::int AS n FROM advisor_opinions WHERE job_id = $1 AND point_id = $2',
      [jobId, pointId],
    );
    return rows[0]?.n ?? 0;
  }

  async list(jobId: string): Promise<AdvisorJournalEntry[]> {
    const { rows } = await this.pool.query(
      'SELECT * FROM advisor_opinions WHERE job_id = $1 ORDER BY at, id',
      [jobId],
    );
    return rows.map(toEntry);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/** Reserva pendente há mais de 10 min é abandonada, como no PgAdvisorJournal. */
const RESERVA_ABANDONADA_MS = 10 * 60_000;

/** Diário em memória: mesmo contrato, para testes e para rodar sem PostgreSQL. */
export class MemoryAdvisorJournal implements AdvisorJournal {
  private readonly rows: { entry: AdvisorJournalEntry; status: 'pendente' | 'concluida'; atMs: number }[] = [];
  /** Serializa reserve/complete: consultas simultâneas passam uma de cada vez. */
  private mutex: Promise<void> = Promise.resolve();

  /** O relógio é injetável para testar a reserva abandonada sem esperar 10 minutos. */
  constructor(private readonly now: () => number = () => Date.now()) {}

  private async withLock<T>(fn: () => T | Promise<T>): Promise<T> {
    const prev = this.mutex;
    let release!: () => void;
    this.mutex = new Promise<void>((resolve) => { release = resolve; });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  async record(entry: AdvisorJournalInput): Promise<AdvisorJournalEntry> {
    const saved = this.buildEntry(randomUUID(), new Date(this.now()).toISOString(), entry);
    this.rows.push({ entry: saved, status: 'concluida', atMs: this.now() });
    return saved;
  }

  async reserve(jobId: string, pointId: string, inputHash: string, maxChamadas: number): Promise<AdvisorReservation> {
    return this.withLock((): AdvisorReservation => {
      const limite = this.now() - RESERVA_ABANDONADA_MS;
      // Reserva parada há mais de 10 min vira abandonada e não segura o ponto.
      for (const row of this.rows) {
        if (row.status !== 'pendente' || row.atMs >= limite) continue;
        if (row.entry.jobId !== jobId || row.entry.pointId !== pointId) continue;
        row.status = 'concluida';
        row.entry.ok = false;
        row.entry.reason = 'abandonada';
      }
      const mesmaChave = (row: typeof this.rows[number]): boolean =>
        row.entry.jobId === jobId && row.entry.pointId === pointId && row.entry.inputHash === inputHash;
      for (let i = this.rows.length - 1; i >= 0; i--) {
        const row = this.rows[i]!;
        if (row.status === 'concluida' && row.entry.ok && row.entry.opinion && mesmaChave(row)) {
          return { kind: 'cache', entry: row.entry };
        }
      }
      if (this.rows.some((row) => row.status === 'pendente' && mesmaChave(row))) {
        return { kind: 'em_andamento' };
      }
      const tentativas = this.rows.filter(
        (row) => row.entry.jobId === jobId && row.entry.pointId === pointId,
      ).length;
      if (tentativas >= maxChamadas) return { kind: 'teto' };

      const at = this.now();
      const pendente: AdvisorJournalEntry = {
        id: randomUUID(),
        jobId,
        pointId,
        inputHash,
        at: new Date(at).toISOString(),
        model: null,
        ok: false,
        reason: null,
        opinion: null,
        promptTokens: null,
        completionTokens: null,
        ms: 0,
        author: 'deepseek',
        role: 'conselheiro',
      };
      this.rows.push({ entry: pendente, status: 'pendente', atMs: at });
      return { kind: 'reservado', reservationId: pendente.id };
    });
  }

  async complete(reservationId: string, entry: AdvisorJournalInput): Promise<AdvisorJournalEntry> {
    return this.withLock(() => {
      const row = this.rows.find((r) => r.entry.id === reservationId);
      if (!row) throw new Error(`reserva ${reservationId} não encontrada no diário`);
      row.entry = this.buildEntry(reservationId, row.entry.at, entry);
      row.status = 'concluida';
      row.atMs = this.now();
      return row.entry;
    });
  }

  async findCached(jobId: string, pointId: string, inputHash: string): Promise<AdvisorJournalEntry | null> {
    for (let i = this.rows.length - 1; i >= 0; i--) {
      const row = this.rows[i]!;
      const e = row.entry;
      if (row.status === 'concluida' && e.ok && e.opinion
        && e.jobId === jobId && e.pointId === pointId && e.inputHash === inputHash) return e;
    }
    return null;
  }

  async countCalls(jobId: string, pointId: string): Promise<number> {
    return this.rows.filter((r) => r.entry.jobId === jobId && r.entry.pointId === pointId).length;
  }

  async list(jobId: string): Promise<AdvisorJournalEntry[]> {
    return this.rows.filter((r) => r.entry.jobId === jobId).map((r) => r.entry);
  }

  private buildEntry(id: string, at: string, entry: AdvisorJournalInput): AdvisorJournalEntry {
    return {
      id,
      jobId: entry.jobId,
      pointId: entry.pointId,
      inputHash: entry.inputHash,
      at,
      model: entry.model,
      ok: entry.ok,
      reason: entry.reason ?? null,
      opinion: entry.opinion ?? null,
      promptTokens: entry.promptTokens ?? null,
      completionTokens: entry.completionTokens ?? null,
      ms: entry.ms,
      author: entry.author ?? 'deepseek',
      role: entry.role ?? 'conselheiro',
    };
  }
}
