// Memória do Night em PostgreSQL 18 (docs/DECISIONS.md, D-002).
// A senha nunca fica no projeto: o driver lê %APPDATA%\postgresql\pgpass.conf (scripts/setup-db.ps1).

import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type {
  ActivityEntry, JobTransitionOptions, Memory, NewIdea, NewJob, NewTask, RouteDecision,
} from '../core/interfaces.ts';
import type {
  Approval, ApprovalAction, Id, Idea, IdeaStatus, Job, JobEvent, JobEventType, JobKind, JobStatus, Language,
  Project, Task, TaskEvent, TaskEventType, TaskStatus,
} from '../core/types.ts';
import { canTransition, FINAL_TASK_STATUSES } from '../core/types.ts';

export const DEFAULT_DATABASE_URL = 'postgres://night@localhost:5433/night';

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');
/** Chave do pg_advisory_lock: impede duas instâncias migrando ao mesmo tempo. */
const MIGRATION_LOCK = 0x4e494748;
/** Chave da trava "esta instância executa tarefas". */
const TASK_LOCK = 0x4e544b31;

type Row = Record<string, any>;
type Queryable = pg.Pool | pg.PoolClient;

/** Aplica, em ordem, os arquivos de migrations/ que ainda não rodaram. Retorna os que aplicou. */
export async function migrate(pool: pg.Pool): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Set((await client.query('SELECT version FROM schema_migrations')).rows.map((r) => r.version));
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migração ${file} falhou: ${(err as Error).message}`);
      }
      applied.push(file);
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK]).catch(() => {});
    client.release();
  }
  return applied;
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

const toProject = (r: Row): Project => ({
  id: r.id, name: r.name, description: r.description, repoPath: r.repo_path,
  defaultBranch: r.default_branch, allowedPaths: r.allowed_paths, status: r.status,
});
const toIdea = (r: Row): Idea => ({
  id: r.id, projectId: r.project_id, title: r.title, transcript: r.transcript, notes: r.notes,
  tags: r.tags, createdAt: iso(r.created_at)!, status: r.status,
});
const toTask = (r: Row): Task => ({
  id: r.id, projectId: r.project_id, objective: r.objective, scope: r.scope, status: r.status,
  primaryAgent: r.primary_agent, reviewAgent: r.review_agent, worktreePath: r.worktree_path,
  branch: r.branch, baseRef: r.base_ref, cardId: r.card_id, cardRevision: r.card_revision,
  cardHash: r.card_hash, createdAt: iso(r.created_at)!, updatedAt: iso(r.updated_at)!,
  resultSummary: r.result_summary, approvalState: r.approval_state,
});
const toEvent = (r: Row): TaskEvent => ({
  id: r.id, taskId: r.task_id, timestamp: iso(r.at)!, eventType: r.event_type, source: r.source,
  message: r.message, artifactRef: r.artifact_ref,
});
const toApproval = (r: Row): Approval => ({
  id: r.id, taskId: r.task_id, action: r.action, scope: r.scope, requestedAt: iso(r.requested_at)!,
  decision: r.decision, decidedAt: iso(r.decided_at),
});
const toJob = (r: Row): Job => ({
  id: r.id, kind: r.kind, number: r.number, origin: r.origin, idempotencyKey: r.idempotency_key, params: r.params,
  limits: r.limits, status: r.status, waitingFor: r.waiting_for, version: r.version, taskId: r.task_id,
  artifactRef: r.artifact_ref, error: r.error, createdAt: iso(r.created_at)!, updatedAt: iso(r.updated_at)!,
});
const toJobEvent = (r: Row): JobEvent => ({
  id: r.id, jobId: r.job_id, timestamp: iso(r.at)!, eventType: r.event_type, fromStatus: r.from_status,
  toStatus: r.to_status, source: r.source, message: r.message, effectKey: r.effect_key,
});

export class PgMemory implements Memory {
  private constructor(private readonly pool: pg.Pool) {}

  /** Conecta e aplica as migrações pendentes. */
  static async open(connectionString = process.env.NIGHT_DATABASE_URL ?? DEFAULT_DATABASE_URL): Promise<PgMemory> {
    const pool = new pg.Pool({ connectionString, max: 5 });
    try {
      await migrate(pool);
    } catch (err) {
      await pool.end();
      throw err;
    }
    return new PgMemory(pool);
  }

  private async tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  // ---------- Ideias ----------

  async saveIdea(idea: NewIdea): Promise<Idea> {
    const { rows } = await this.pool.query(
      `INSERT INTO ideas (id, project_id, title, transcript, notes, tags)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [randomUUID(), idea.projectId, idea.title, idea.transcript, idea.notes ?? '', idea.tags ?? []],
    );
    return toIdea(rows[0]!);
  }

  async findIdeas(q: { projectId?: Id; text?: string; status?: IdeaStatus; limit?: number }): Promise<Idea[]> {
    const where: string[] = [];
    const args: unknown[] = [];
    const order = ['created_at DESC'];
    if (q.projectId) { args.push(q.projectId); where.push(`project_id = $${args.length}`); }
    if (q.status) { args.push(q.status); where.push(`status = $${args.length}`); }
    if (q.text?.trim()) {
      args.push(q.text);
      const tsq = `(websearch_to_tsquery('portuguese', $${args.length}) || websearch_to_tsquery('english', $${args.length}))`;
      where.push(`search @@ ${tsq}`);
      order.unshift(`ts_rank(search, ${tsq}) DESC`);
    }
    args.push(q.limit ?? 20);
    const { rows } = await this.pool.query(
      `SELECT * FROM ideas ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY ${order.join(', ')} LIMIT $${args.length}`,
      args,
    );
    return rows.map(toIdea);
  }

  async setIdeaStatus(id: Id, status: IdeaStatus): Promise<void> {
    const r = await this.pool.query('UPDATE ideas SET status = $2 WHERE id = $1', [id, status]);
    if (r.rowCount === 0) throw new Error(`ideia ${id} não existe`);
  }

  // ---------- Projetos ----------

  async upsertProject(p: Project): Promise<void> {
    await this.pool.query(
      `INSERT INTO projects (id, name, description, repo_path, default_branch, allowed_paths, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO UPDATE SET name = $2, description = $3, repo_path = $4, default_branch = $5,
         allowed_paths = $6, status = $7`,
      [p.id, p.name, p.description, p.repoPath, p.defaultBranch, p.allowedPaths, p.status],
    );
  }

  async getProject(id: Id): Promise<Project | null> {
    const { rows } = await this.pool.query('SELECT * FROM projects WHERE id = $1', [id]);
    return rows[0] ? toProject(rows[0]) : null;
  }

  async findProjectByName(name: string): Promise<Project | null> {
    const { rows } = await this.pool.query(
      `SELECT * FROM projects WHERE lower(name) = lower($1) OR lower(id) = lower($1)
       ORDER BY (lower(name) = lower($1)) DESC LIMIT 1`,
      [name.trim()],
    );
    return rows[0] ? toProject(rows[0]) : null;
  }

  async listProjects(): Promise<Project[]> {
    return (await this.pool.query('SELECT * FROM projects ORDER BY name')).rows.map(toProject);
  }

  // ---------- Tarefas ----------

  async createTask(t: NewTask): Promise<Task> {
    return this.tx(async (c) => {
      const { rows } = await c.query(
        `INSERT INTO tasks (id, project_id, objective, scope, status, primary_agent, review_agent,
           worktree_path, branch, base_ref, result_summary, approval_state,
           card_id, card_revision, card_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING *`,
        [t.id, t.projectId, t.objective, t.scope, t.status, t.primaryAgent, t.reviewAgent, t.worktreePath,
          t.branch, t.baseRef, t.resultSummary, t.approvalState,
          t.cardId ?? null, t.cardRevision ?? null, t.cardHash ?? null],
      );
      await this.insertEvent(c, t.id, 'status-changed', 'scheduler', `criada como ${t.status}`);
      return toTask(rows[0]!);
    });
  }

  async getTask(id: Id): Promise<Task | null> {
    const { rows } = await this.pool.query('SELECT * FROM tasks WHERE id = $1', [id]);
    return rows[0] ? toTask(rows[0]) : null;
  }

  async listTasks(filter: { status?: TaskStatus[]; projectId?: Id } = {}): Promise<Task[]> {
    const where: string[] = [];
    const args: unknown[] = [];
    if (filter.status?.length) { args.push(filter.status); where.push(`status = ANY($${args.length})`); }
    if (filter.projectId) { args.push(filter.projectId); where.push(`project_id = $${args.length}`); }
    const { rows } = await this.pool.query(
      `SELECT * FROM tasks ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at`,
      args,
    );
    return rows.map(toTask);
  }

  async updateTaskStatus(id: Id, status: TaskStatus, source: string, message: string): Promise<Task> {
    return this.tx(async (c) => {
      const cur = (await c.query('SELECT status FROM tasks WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!cur) throw new Error(`tarefa ${id} não existe`);
      if (FINAL_TASK_STATUSES.includes(cur.status)) {
        throw new Error(`tarefa ${id} já terminou (${cur.status}); não pode ir para ${status}`);
      }
      const { rows } = await c.query(
        'UPDATE tasks SET status = $2, updated_at = now() WHERE id = $1 RETURNING *', [id, status],
      );
      await this.insertEvent(c, id, 'status-changed', source, `${cur.status} → ${status}: ${message}`);
      return toTask(rows[0]!);
    });
  }

  async updateTask(
    id: Id,
    patch: Partial<Pick<Task, 'worktreePath' | 'branch' | 'baseRef' | 'resultSummary' | 'approvalState'>>,
  ): Promise<Task> {
    const columns: Record<keyof typeof patch, string> = {
      worktreePath: 'worktree_path', branch: 'branch', baseRef: 'base_ref',
      resultSummary: 'result_summary', approvalState: 'approval_state',
    };
    const sets: string[] = [];
    const args: unknown[] = [id];
    for (const [key, col] of Object.entries(columns) as [keyof typeof patch, string][]) {
      if (key in patch) { args.push(patch[key] ?? null); sets.push(`${col} = $${args.length}`); }
    }
    const { rows } = await this.pool.query(
      `UPDATE tasks SET ${[...sets, 'updated_at = now()'].join(', ')} WHERE id = $1 RETURNING *`, args,
    );
    if (!rows[0]) throw new Error(`tarefa ${id} não existe`);
    return toTask(rows[0]);
  }

  async addTaskEvent(e: { taskId: Id; eventType: TaskEventType; source: string; message: string; artifactRef?: string | null }): Promise<TaskEvent> {
    return this.insertEvent(this.pool, e.taskId, e.eventType, e.source, e.message, e.artifactRef ?? null);
  }

  private async insertEvent(
    db: Queryable, taskId: Id, type: TaskEventType, source: string, message: string, artifactRef: string | null = null,
  ): Promise<TaskEvent> {
    const { rows } = await db.query(
      `INSERT INTO task_events (id, task_id, event_type, source, message, artifact_ref)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [randomUUID(), taskId, type, source, message, artifactRef],
    );
    return toEvent(rows[0]!);
  }

  async listTaskEvents(taskId: Id): Promise<TaskEvent[]> {
    const { rows } = await this.pool.query('SELECT * FROM task_events WHERE task_id = $1 ORDER BY at', [taskId]);
    return rows.map(toEvent);
  }

  // ---------- Trabalhos (jobs) ----------

  /**
   * ON CONFLICT DO NOTHING + SELECT na mesma transação: com duas chamadas simultâneas,
   * a segunda espera a primeira terminar e devolve o job dela em vez de criar outro.
   */
  async createJob(input: NewJob): Promise<{ job: Job; created: boolean }> {
    return this.tx(async (c) => {
      // Trava por tipo enquanto calcula o próximo número: duas criações simultâneas não pegam o mesmo.
      // A trava é da transação: solta sozinha no COMMIT/ROLLBACK.
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`jobs:${input.kind}`]);
      const next = (await c.query(
        'SELECT COALESCE(MAX(number), 0) + 1 AS n FROM jobs WHERE kind = $1', [input.kind],
      )).rows[0].n as number;
      const { rows } = await c.query(
        `INSERT INTO jobs (id, kind, number, origin, idempotency_key, params, limits, status, task_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'queued', $8)
         ON CONFLICT (idempotency_key) DO NOTHING RETURNING *`,
        [randomUUID(), input.kind, next, input.origin, input.idempotencyKey, input.params ?? {}, input.limits ?? {},
          input.taskId ?? null],
      );
      if (rows[0]) {
        await this.insertJobEvent(c, rows[0].id, 'status-changed', null, 'queued', 'scheduler', 'criada como queued');
        return { job: toJob(rows[0]), created: true };
      }
      const existing = (await c.query('SELECT * FROM jobs WHERE idempotency_key = $1', [input.idempotencyKey])).rows[0];
      // A outra transação pode ter desfeito o insert: aí não existe mesmo e é erro de verdade.
      if (!existing) throw new Error(`trabalho com chave ${input.idempotencyKey} não foi criado; tente de novo`);
      return { job: toJob(existing), created: false };
    });
  }

  async getJob(id: Id): Promise<Job | null> {
    const { rows } = await this.pool.query('SELECT * FROM jobs WHERE id = $1', [id]);
    return rows[0] ? toJob(rows[0]) : null;
  }

  async getJobByNumber(kind: JobKind, number: number): Promise<Job | null> {
    const { rows } = await this.pool.query('SELECT * FROM jobs WHERE kind = $1 AND number = $2', [kind, number]);
    return rows[0] ? toJob(rows[0]) : null;
  }

  async listJobs(filter: { kind?: JobKind; status?: JobStatus[] } = {}): Promise<Job[]> {
    const where: string[] = [];
    const args: unknown[] = [];
    if (filter.kind) { args.push(filter.kind); where.push(`kind = $${args.length}`); }
    if (filter.status?.length) { args.push(filter.status); where.push(`status = ANY($${args.length})`); }
    const { rows } = await this.pool.query(
      `SELECT * FROM jobs ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY created_at DESC, id`,
      args,
    );
    return rows.map(toJob);
  }

  /** Tudo numa transação: se recusar, nada muda e nenhum evento fica gravado. */
  async transitionJob(id: Id, to: JobStatus, opts: JobTransitionOptions): Promise<Job> {
    return this.tx(async (c) => {
      const cur = (await c.query('SELECT * FROM jobs WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!cur) throw new Error(`trabalho ${id} não existe`);
      const from = cur.status as JobStatus;
      if (!canTransition(from, to)) throw new Error(`trabalho ${id}: ${from} → ${to} não é permitido`);
      if (opts.expectedVersion !== undefined && opts.expectedVersion !== cur.version) {
        throw new Error(
          `trabalho ${id} mudou (versão ${cur.version}, esperada ${opts.expectedVersion}); leia de novo antes de continuar`,
        );
      }
      const { rows } = await c.query(
        `UPDATE jobs SET status = $2, waiting_for = $3, error = $4,
                artifact_ref = COALESCE($5, artifact_ref), version = version + 1, updated_at = now()
         WHERE id = $1 RETURNING *`,
        [id, to, opts.waitingFor ?? null, opts.error ?? null, opts.artifactRef ?? null],
      );
      await this.insertJobEvent(
        c, id, 'status-changed', from, to, opts.source, `${from} → ${to}: ${opts.message}`,
      );
      return toJob(rows[0]!);
    });
  }

  /** Evento avulso, sem mudar o estado (ex.: decisão do dono sobre oferta/vídeo pronta). */
  async addJobEvent(
    id: Id,
    event: { eventType: JobEventType; source: string; message: string; effectKey?: string | null },
  ): Promise<JobEvent> {
    return this.insertJobEvent(this.pool, id, event.eventType, null, null, event.source, event.message,
      event.effectKey ?? null);
  }

  /** A chave única parcial é o que impede repetir um efeito externo já confirmado. */
  async recordJobEffect(id: Id, effectKey: string, source: string, message: string): Promise<{ recorded: boolean }> {
    const r = await this.pool.query(
      `INSERT INTO job_events (id, job_id, event_type, source, message, effect_key)
       VALUES ($1, $2, 'effect-confirmed', $3, $4, $5)
       ON CONFLICT (job_id, effect_key) WHERE effect_key IS NOT NULL DO NOTHING`,
      [randomUUID(), id, source, message, effectKey],
    );
    return { recorded: (r.rowCount ?? 0) > 0 };
  }

  async hasJobEffect(id: Id, effectKey: string): Promise<boolean> {
    const { rows } = await this.pool.query(
      'SELECT 1 FROM job_events WHERE job_id = $1 AND effect_key = $2 LIMIT 1', [id, effectKey],
    );
    return rows.length > 0;
  }

  async listJobEvents(id: Id): Promise<JobEvent[]> {
    const { rows } = await this.pool.query(
      'SELECT * FROM job_events WHERE job_id = $1 ORDER BY at, id', [id],
    );
    return rows.map(toJobEvent);
  }

  private async insertJobEvent(
    db: Queryable, jobId: Id, type: JobEventType, from: JobStatus | null, to: JobStatus | null,
    source: string, message: string, effectKey: string | null = null,
  ): Promise<JobEvent> {
    const { rows } = await db.query(
      `INSERT INTO job_events (id, job_id, event_type, from_status, to_status, source, message, effect_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [randomUUID(), jobId, type, from, to, source, message, effectKey],
    );
    return toJobEvent(rows[0]!);
  }

  // ---------- Aprovações ----------

  async requestApproval(taskId: Id, action: ApprovalAction, scope: string): Promise<Approval> {
    return this.tx(async (c) => {
      const { rows } = await c.query(
        'INSERT INTO approvals (id, task_id, action, scope) VALUES ($1, $2, $3, $4) RETURNING *',
        [randomUUID(), taskId, action, scope],
      );
      await c.query(`UPDATE tasks SET approval_state = 'pending', updated_at = now() WHERE id = $1`, [taskId]);
      return toApproval(rows[0]!);
    });
  }

  /** Só decide pedido pendente: uma aprovação não pode ser revertida depois. */
  async decideApproval(id: Id, decision: 'approved' | 'rejected'): Promise<Approval> {
    return this.tx(async (c) => {
      const { rows } = await c.query(
        `UPDATE approvals SET decision = $2, decided_at = now() WHERE id = $1 AND decision = 'pending' RETURNING *`,
        [id, decision],
      );
      if (!rows[0]) throw new Error(`aprovação ${id} não existe ou já foi decidida`);
      await c.query('UPDATE tasks SET approval_state = $2, updated_at = now() WHERE id = $1', [rows[0].task_id, decision]);
      await this.insertEvent(c, rows[0].task_id, 'progress', 'owner', `${rows[0].action}: ${decision}`);
      return toApproval(rows[0]);
    });
  }

  async listPendingApprovals(): Promise<Approval[]> {
    const { rows } = await this.pool.query(`SELECT * FROM approvals WHERE decision = 'pending' ORDER BY requested_at`);
    return rows.map(toApproval);
  }

  async logRoute(e: { text: string; language: Language; decision: RouteDecision; reply?: string; taskId?: Id | null }): Promise<void> {
    await this.pool.query(
      `INSERT INTO route_log (id, language, text, intent, model, reason, used_premium, task_id, reply)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [randomUUID(), e.language, e.text, e.decision.intent.kind, e.decision.model, e.decision.reason,
        e.decision.usedPremiumQuota, e.taskId ?? null, e.reply ?? null],
    );
  }

  async recentActivity(limit: number): Promise<ActivityEntry[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM (SELECT at, text, intent, model, reply FROM route_log ORDER BY at DESC LIMIT $1) r ORDER BY at`,
      [limit],
    );
    return rows.map((r) => ({ at: iso(r.at)!, text: r.text, intent: r.intent, model: r.model, reply: r.reply }));
  }

  /**
   * Só uma instância do Night executa tarefas por vez (a trava vive enquanto a conexão estiver aberta).
   * Sem isso, abrir uma segunda janela marcaria como "falhou" as tarefas vivas da primeira.
   * Devolve a função que solta a trava, ou null se outra instância já tem.
   */
  async acquireTaskLock(): Promise<(() => Promise<void>) | null> {
    const client = await this.pool.connect();
    const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [TASK_LOCK]);
    if (!rows[0]?.ok) {
      client.release();
      return null;
    }
    this.lockClient = client;
    return async () => {
      if (this.lockClient !== client) return;
      this.lockClient = null;
      await client.query('SELECT pg_advisory_unlock($1)', [TASK_LOCK]).catch(() => {});
      client.release();
    };
  }

  private lockClient: pg.PoolClient | null = null;

  async close(): Promise<void> {
    if (this.lockClient) {
      this.lockClient.release();
      this.lockClient = null;
    }
    await this.pool.end();
  }
}
