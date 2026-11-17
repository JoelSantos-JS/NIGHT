// Contrato com trabalhadores do Night (F03): local ou na nuvem, sem tocar em conta externa.
// O Night só fala por este contrato; trocar o trabalhador não muda o resto do sistema.
import type { ArtifactStore } from '../artifacts/store.ts';
import type { JobKind } from '../core/types.ts';

export const WORKER_CONTRACT = 'worker/1';

/** O que o Night manda para o trabalhador começar (ou retomar) um trabalho. */
export interface WorkerRequest {
  contract: 'worker/1';
  jobId: string;
  kind: JobKind;
  params: Record<string, unknown>;
  limits: Record<string, unknown>;
}

export type WorkerState = 'running' | 'waiting' | 'succeeded' | 'failed' | 'cancelled';

/** O que o trabalhador devolve ao terminar; artifacts aponta para o manifesto do ArtifactStore. */
export interface WorkerResult {
  contract: 'worker/1';
  jobId: string;
  /**
   * 'waiting' é espera, não falha: faltou uma dependência externa (ex.: imagens do Flow)
   * e o trabalho pode ser retomado quando ela chegar.
   */
  state: 'succeeded' | 'failed' | 'cancelled' | 'waiting';
  artifacts: { name: string; sha256: string }[];
  error: string | null;
  /** Só no estado 'waiting': o que falta (ex.: 'flow'). */
  waitingFor?: string;
  /** Texto curto para o log/status; opcional, o runner usa como mensagem da transição. */
  message?: string;
  usage?: Record<string, number>;
}

export interface JobWorker {
  readonly name: string;
  /**
   * CONTRATO: start é idempotente por jobId enquanto a execução está ATIVA ('running')
   * ou terminou com sucesso. Se a última execução daquele jobId terminou em 'waiting',
   * 'failed' ou 'cancelled', start começa uma NOVA tentativa (novo runId); o trabalhador
   * reaproveita os artefatos já verificados no ArtifactStore, sem repetir o que está pronto.
   * É isso que permite retomar depois de reiniciar o NIGHT ou de uma espera, sem duplicar
   * uma execução que ainda está viva.
   */
  start(request: WorkerRequest): Promise<{ runId: string }>;
  status(runId: string): Promise<{ state: WorkerState; message: string }>;
  result(runId: string): Promise<WorkerResult>;
  cancel(runId: string): Promise<{ cancelled: boolean; detail: string }>;
}

const JOB_KINDS: readonly JobKind[] = ['coding', 'radar', 'video', 'lowticket', 'campanha'];
const SHA256 = /^[a-f0-9]{64}$/;

/** Objeto simples: sem array, sem null e sem classe — só o que vem do JSON. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Confere o pedido antes de entregar ao trabalhador; mensagem em português para o log. */
export function validateWorkerRequest(
  x: unknown,
): { ok: true; request: WorkerRequest } | { ok: false; error: string } {
  if (!isPlainObject(x)) return { ok: false, error: 'pedido do trabalhador deve ser um objeto' };
  if (x.contract !== WORKER_CONTRACT) {
    return { ok: false, error: `contrato inválido: esperado ${WORKER_CONTRACT}` };
  }
  if (typeof x.jobId !== 'string' || x.jobId.trim() === '') {
    return { ok: false, error: 'jobId não pode ser vazio' };
  }
  if (typeof x.kind !== 'string' || !JOB_KINDS.includes(x.kind as JobKind)) {
    return { ok: false, error: `tipo de trabalho inválido: ${String(x.kind)}` };
  }
  if (!isPlainObject(x.params)) return { ok: false, error: 'params deve ser um objeto simples' };
  if (!isPlainObject(x.limits)) return { ok: false, error: 'limits deve ser um objeto simples' };
  return {
    ok: true,
    request: {
      contract: WORKER_CONTRACT,
      jobId: x.jobId,
      kind: x.kind as JobKind,
      params: x.params,
      limits: x.limits,
    },
  };
}

/** Confere o resultado; jobId diferente do pedido é recusado para não trocar trabalhos. */
export function validateWorkerResult(
  x: unknown, jobId: string,
): { ok: true; result: WorkerResult } | { ok: false; error: string } {
  if (!isPlainObject(x)) return { ok: false, error: 'resultado do trabalhador deve ser um objeto' };
  if (x.contract !== WORKER_CONTRACT) {
    return { ok: false, error: `contrato inválido: esperado ${WORKER_CONTRACT}` };
  }
  if (x.jobId !== jobId) {
    return { ok: false, error: `resultado é de outro trabalho (${String(x.jobId)}), esperado ${jobId}` };
  }
  if (x.state !== 'succeeded' && x.state !== 'failed' && x.state !== 'cancelled' && x.state !== 'waiting') {
    return { ok: false, error: `estado final inválido: ${String(x.state)}` };
  }
  let waitingFor: string | undefined;
  if (x.state === 'waiting') {
    if (typeof x.waitingFor !== 'string' || x.waitingFor.trim() === '') {
      return { ok: false, error: 'estado waiting exige waitingFor' };
    }
    waitingFor = x.waitingFor.trim();
  }
  if (x.message !== undefined && typeof x.message !== 'string') {
    return { ok: false, error: 'message deve ser texto' };
  }
  if (!Array.isArray(x.artifacts)) return { ok: false, error: 'artifacts deve ser uma lista' };
  const artifacts: { name: string; sha256: string }[] = [];
  for (const item of x.artifacts) {
    if (!isPlainObject(item)) return { ok: false, error: 'cada artefato deve ser um objeto' };
    if (typeof item.name !== 'string' || item.name.trim() === '') {
      return { ok: false, error: 'artefato sem nome' };
    }
    if (typeof item.sha256 !== 'string' || !SHA256.test(item.sha256)) {
      return { ok: false, error: `artefato ${item.name} com sha256 inválido` };
    }
    artifacts.push({ name: item.name, sha256: item.sha256 });
  }
  if (x.error !== null && typeof x.error !== 'string') {
    return { ok: false, error: 'error deve ser texto ou null' };
  }
  let usage: Record<string, number> | undefined;
  if (x.usage !== undefined) {
    if (!isPlainObject(x.usage)) return { ok: false, error: 'usage deve ser um objeto simples' };
    usage = {};
    for (const [key, value] of Object.entries(x.usage)) {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return { ok: false, error: `usage.${key} deve ser um número` };
      }
      usage[key] = value;
    }
  }
  return {
    ok: true,
    result: {
      contract: WORKER_CONTRACT,
      jobId,
      state: x.state,
      artifacts,
      error: x.error,
      ...(waitingFor !== undefined ? { waitingFor } : {}),
      ...(typeof x.message === 'string' ? { message: x.message } : {}),
      ...(usage ? { usage } : {}),
    },
  };
}

export type FakeBehavior = 'succeed' | 'fail' | 'hang';

interface FakeRun {
  jobId: string;
  state: WorkerState;
  message: string;
  artifacts: { name: string; sha256: string }[];
  error: string | null;
}

const FAKE_ARTIFACT = 'resultado.txt';

/**
 * Trabalhador falso para testes e para a verificação da base (F08).
 * Segue o roteiro por jobId e não acessa rede nem conta externa.
 */
export class FakeWorker implements JobWorker {
  readonly name = 'fake';
  /** Execuções reais começadas: repetir o start da mesma execução ativa/sucedida não conta. */
  startedRuns = 0;
  /** Quantas vezes start foi chamado, inclusive as repetições idempotentes. */
  startCalls = 0;
  /** Quantas vezes cancel foi chamado; os testes usam para provar o pedido de cancelamento. */
  cancelCalls = 0;
  private readonly runIdByJob = new Map<string, string>();
  private readonly runs = new Map<string, FakeRun>();

  constructor(
    private readonly script: Record<string, FakeBehavior>,
    private readonly store?: ArtifactStore,
  ) {}

  async start(request: WorkerRequest): Promise<{ runId: string }> {
    this.startCalls += 1;
    const existing = this.runIdByJob.get(request.jobId);
    if (existing) {
      const anterior = this.runOf(existing);
      // Ativa ou concluída com sucesso: mesma execução. Waiting/failed/cancelled
      // terminaram a tentativa; a retomada começa outra (o store guarda o que já foi feito).
      if (anterior.state === 'running' || anterior.state === 'succeeded') {
        return { runId: existing };
      }
    }

    const behavior = this.script[request.jobId];
    if (!behavior) throw new Error(`sem roteiro para o trabalho ${request.jobId}`);

    const runId = `run-${this.startedRuns + 1}`;
    const run: FakeRun = {
      jobId: request.jobId, state: 'running', message: 'em execução', artifacts: [], error: null,
    };
    this.runIdByJob.set(request.jobId, runId);
    this.runs.set(runId, run);
    this.startedRuns += 1;

    if (behavior === 'succeed') {
      if (this.store) {
        const item = await this.store.add(request.jobId, {
          name: FAKE_ARTIFACT,
          data: `resultado de ${request.jobId}\n`,
          origin: this.name,
        });
        run.artifacts = [{ name: item.name, sha256: item.sha256 }];
      }
      run.state = 'succeeded';
      run.message = 'concluído';
    } else if (behavior === 'fail') {
      run.state = 'failed';
      run.message = 'falhou';
      run.error = 'falha simulada pelo trabalhador falso';
    }
    return { runId };
  }

  async status(runId: string): Promise<{ state: WorkerState; message: string }> {
    const run = this.runOf(runId);
    return { state: run.state, message: run.message };
  }

  async result(runId: string): Promise<WorkerResult> {
    const run = this.runOf(runId);
    const state = run.state;
    if (state === 'running') throw new Error(`execução ${runId} ainda está rodando`);
    return {
      contract: WORKER_CONTRACT,
      jobId: run.jobId,
      state,
      artifacts: run.artifacts,
      error: run.error,
    };
  }

  async cancel(runId: string): Promise<{ cancelled: boolean; detail: string }> {
    this.cancelCalls += 1;
    const run = this.runOf(runId);
    if (run.state !== 'running') {
      return { cancelled: false, detail: `execução já terminou (${run.state})` };
    }
    run.state = 'cancelled';
    run.message = 'cancelado';
    return { cancelled: true, detail: 'cancelado pelo pedido do NIGHT' };
  }

  private runOf(runId: string): FakeRun {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`runId desconhecido: ${runId}`);
    return run;
  }
}
