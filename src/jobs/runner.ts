// Executor de trabalhos (F03): conduz o Job pelo contrato com o trabalhador e só marca
// sucesso depois de conferir os artefatos no disco. A base de jobs fica na memória (F01/F02).
import type { ArtifactStore } from '../artifacts/store.ts';
import type { JobTransitionOptions, Memory } from '../core/interfaces.ts';
import type { Job, JobStatus } from '../core/types.ts';
import { canTransition, FINAL_JOB_STATUSES } from '../core/types.ts';
import type { JobWorker, WorkerRequest, WorkerResult } from './worker.ts';
import { WORKER_CONTRACT, validateWorkerRequest, validateWorkerResult } from './worker.ts';

export interface JobRunnerOptions {
  /** Intervalo entre consultas de status; padrão 1s. */
  pollMs?: number;
  /** Quantas consultas antes de devolver 'retryable'; padrão 120 (~2 min com 1s). */
  maxPolls?: number;
}

/**
 * Efeito por tentativa: cada runId tem a sua chave, para uma retomada depois de espera/
 * falha começar outra tentativa sem parecer repetição da anterior. A mesma tentativa
 * (start repetido com o mesmo runId) continua gravando uma vez só.
 */
const START_EFFECT_PREFIX = 'worker-start:';
const startEffectKey = (runId: string): string => `${START_EFFECT_PREFIX}${runId}`;

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requestFrom(job: Job): WorkerRequest {
  return {
    contract: WORKER_CONTRACT,
    jobId: job.id,
    kind: job.kind,
    params: job.params,
    limits: job.limits,
  };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class JobRunner {
  private readonly pollMs: number;
  private readonly maxPolls: number;
  /**
   * Execuções vivas NESTE runner, por jobId. Dois laços no mesmo job brigariam nas
   * transições: quem pede de novo recebe a Promise da execução que já está em andamento.
   */
  private readonly running = new Map<string, Promise<Job>>();

  constructor(
    private readonly memory: Memory,
    private readonly worker: JobWorker,
    private readonly store: ArtifactStore,
    opts: JobRunnerOptions = {},
  ) {
    this.pollMs = opts.pollMs ?? 1000;
    this.maxPolls = opts.maxPolls ?? 120;
  }

  /** Leva o trabalho do estado atual até o fim (ou até uma falha recuperável). */
  run(jobId: string): Promise<Job> {
    const emAndamento = this.running.get(jobId);
    if (emAndamento !== undefined) return emAndamento;
    // Registra ANTES do primeiro await: a segunda chamada já encontra a execução viva.
    const execucao = this.runOnce(jobId);
    this.running.set(jobId, execucao);
    // Só apaga a própria entrada: outra execução pode ter começado depois desta.
    void execucao
      .finally(() => {
        if (this.running.get(jobId) === execucao) this.running.delete(jobId);
      })
      .catch(() => undefined);
    return execucao;
  }

  /** Há execução deste job em andamento neste runner? O coordenador usa para não disparar outra. */
  isRunning(jobId: string): boolean {
    return this.running.has(jobId);
  }

  private async runOnce(jobId: string): Promise<Job> {
    const job = await this.memory.getJob(jobId);
    if (!job) throw new Error(`trabalho ${jobId} não existe`);
    // Final não muda: repetir run() devolve o mesmo estado, sem novo evento.
    if (FINAL_JOB_STATUSES.includes(job.status)) return job;
    try {
      return await this.execute(job);
    } catch (error) {
      // Erro inesperado (do trabalhador ou da memória): falha recuperável, nunca sucesso.
      return this.toRetryable(jobId, describe(error));
    }
  }

  /**
   * Pede o cancelamento ao trabalhador. Só marca 'cancelled' com a confirmação dele (ou se a
   * execução nunca começou): o trabalhador pode seguir produzindo efeito depois do pedido.
   */
  async cancel(jobId: string): Promise<{ job: Job; confirmed: boolean; detail: string }> {
    const job = await this.memory.getJob(jobId);
    if (!job) throw new Error(`trabalho ${jobId} não existe`);
    if (FINAL_JOB_STATUSES.includes(job.status)) {
      // Já terminou: não há execução viva para parar.
      return { job, confirmed: true, detail: `já está em ${job.status}` };
    }

    // 'waiting' não tem execução viva: a última tentativa terminou esperando. Cancelar
    // direto evita pedir start de novo (o contrato criaria uma tentativa nova, não desejada).
    if (job.status === 'waiting') {
      const detail = `cancelado enquanto esperava ${job.waitingFor ?? 'uma dependência'}`;
      const done = await this.finish(jobId, 'cancelled', { source: 'runner', message: detail });
      return { job: done, confirmed: true, detail };
    }

    // Só chama o trabalhador se a execução pode existir: 'running' cobre o intervalo entre o
    // start e o registro do efeito (start é idempotente, repetir devolve o mesmo runId) e um
    // 'worker-start' registrado prova que ela começou. Queued/retryable sem efeito nunca
    // começaram: começar um trabalho só para cancelá-lo teria custo e efeito externo.
    const mayHaveRun = job.status === 'running' || (await this.hasWorkerStart(job.id));
    if (!mayHaveRun) {
      const done = await this.finish(jobId, 'cancelled', {
        source: 'runner',
        message: 'cancelado antes de o trabalhador começar',
      });
      return { job: done, confirmed: true, detail: 'cancelado antes de o trabalhador começar' };
    }

    let detail: string;
    let cancelled = false;
    const checked = validateWorkerRequest(requestFrom(job));
    if (!checked.ok) {
      detail = `pedido inválido para cancelar: ${checked.error}`;
    } else {
      try {
        // start é idempotente: devolve o mesmo runId se a execução já começou.
        const { runId } = await this.worker.start(checked.request);
        const answer = await this.worker.cancel(runId);
        cancelled = answer.cancelled;
        detail = answer.detail;
      } catch (error) {
        detail = `cancelamento do trabalhador falhou: ${describe(error)}`;
      }
    }

    if (cancelled) {
      const done = await this.finish(jobId, 'cancelled', { source: 'runner', message: detail });
      return { job: done, confirmed: true, detail };
    }

    // Sem confirmação o trabalhador pode seguir: nunca dizer que parou. O evento 'error' e o
    // estado 'retryable' deixam o pedido visível e permitem tentar cancelar de novo.
    const error = `cancelamento não confirmado pelo trabalhador: ${detail}`;
    await this.memory.addJobEvent(jobId, { eventType: 'error', source: 'runner', message: error });
    const current = await this.memory.getJob(jobId);
    if (!current) throw new Error(`trabalho ${jobId} não existe`);
    if (current.status === 'running') {
      const retryable = await this.memory.transitionJob(jobId, 'retryable', {
        source: 'runner', message: 'cancelamento não confirmado', error,
      });
      return { job: retryable, confirmed: false, detail };
    }
    // Outro estado que não aceita 'retryable' (ex.: waiting): o evento já registrou o motivo.
    return { job: current, confirmed: false, detail };
  }

  private async execute(job: Job): Promise<Job> {
    let current = job;
    if (current.status !== 'running') {
      // queued, retryable e waiting podem voltar a rodar: o runner foi chamado de propósito.
      const message = current.status === 'retryable'
        ? 'retomando após falha recuperável'
        : current.status === 'waiting'
          ? 'retomando depois da espera'
          : 'começando o trabalho';
      current = await this.memory.transitionJob(job.id, 'running', { source: 'runner', message });
    }

    const checked = validateWorkerRequest(requestFrom(current));
    if (!checked.ok) return this.toFailed(current.id, `pedido inválido: ${checked.error}`);

    const { runId } = await this.worker.start(checked.request);
    // Efeito externo registrado uma vez por tentativa: repetir o start da mesma execução
    // (retomada) não duplica; uma tentativa nova tem runId novo e ganha a sua chave.
    await this.memory.recordJobEffect(current.id, startEffectKey(runId), 'runner', `runId=${runId}`);

    let state = await this.worker.status(runId);
    let polls = 1;
    while (state.state === 'running') {
      if (polls >= this.maxPolls) {
        // Não cancela: o trabalhador externo pode seguir; só marcamos para retomar depois.
        return this.memory.transitionJob(current.id, 'retryable', {
          source: 'runner',
          message: 'tempo esgotado',
          error: 'tempo esgotado esperando o trabalhador',
        });
      }
      await sleep(this.pollMs);
      state = await this.worker.status(runId);
      polls += 1;
    }

    const checkedResult = validateWorkerResult(await this.worker.result(runId), current.id);
    if (!checkedResult.ok) return this.toFailed(current.id, `resultado inválido: ${checkedResult.error}`);

    const result = checkedResult.result;
    if (result.state === 'waiting') {
      // Espera não é falha: o trabalho guarda o que falta e pode ser retomado depois.
      const waitingFor = result.waitingFor ?? 'dependência externa';
      return this.memory.transitionJob(current.id, 'waiting', {
        source: 'runner',
        message: result.message ?? `aguardando ${waitingFor}`,
        waitingFor,
      });
    }
    if (result.state === 'failed') {
      return this.toFailed(current.id, result.error ?? 'trabalhador falhou sem detalhe');
    }
    if (result.state === 'cancelled') {
      return this.finish(current.id, 'cancelled', { source: 'runner', message: 'trabalhador cancelado' });
    }
    return this.succeed(current.id, result);
  }

  /** Só marca sucesso com artefatos conferidos: arquivo faltando ou alterado vira falha. */
  private async succeed(jobId: string, result: WorkerResult): Promise<Job> {
    // Concluir sem entregar nada não é sucesso: exige manifesto no disco e ao menos um artefato.
    const manifest = await this.store.manifest(jobId);
    if (!manifest || result.artifacts.length === 0) {
      return this.toFailed(jobId, 'trabalhador não entregou artefatos');
    }
    const problems: string[] = [];
    const verify = await this.store.verify(jobId);
    if (!verify.ok) {
      if (verify.missing.length) problems.push(`faltando: ${verify.missing.join(', ')}`);
      if (verify.changed.length) problems.push(`alterado: ${verify.changed.join(', ')}`);
      if (verify.extra.length) problems.push(`fora do manifesto: ${verify.extra.join(', ')}`);
    }
    // O que o trabalhador diz ter produzido precisa estar no manifesto com o mesmo hash.
    for (const artifact of result.artifacts) {
      const item = manifest.items.find((candidate) => candidate.name === artifact.name);
      if (!item) problems.push(`resultado aponta artefato ausente do manifesto: ${artifact.name}`);
      else if (item.sha256 !== artifact.sha256) problems.push(`artefato mudou: ${artifact.name}`);
    }
    if (problems.length) {
      return this.toFailed(jobId, `artefatos não conferem; ${problems.join('; ')}`);
    }
    return this.finish(jobId, 'succeeded', {
      source: 'runner',
      message: 'concluído com artefatos verificados',
      artifactRef: this.store.ref(jobId),
    });
  }

  private async toFailed(jobId: string, error: string): Promise<Job> {
    return this.finish(jobId, 'failed', { source: 'runner', message: 'falhou', error });
  }

  /** Falha recuperável: pode ser retomada por outro run() sem repetir o efeito já registrado. */
  private async toRetryable(jobId: string, error: string): Promise<Job> {
    const current = await this.memory.getJob(jobId);
    if (!current) throw new Error(`trabalho ${jobId} não existe`);
    if (FINAL_JOB_STATUSES.includes(current.status)) return current;
    // Estado que não aceita 'retryable' (ex.: queued) fica como está: nunca vira sucesso.
    if (!canTransition(current.status, 'retryable')) {
      if (!canTransition(current.status, 'failed')) return current;
      return this.memory.transitionJob(jobId, 'failed', { source: 'runner', message: 'falhou', error });
    }
    return this.memory.transitionJob(jobId, 'retryable', {
      source: 'runner', message: 'falha recuperável', error,
    });
  }

  /**
   * Alguma tentativa já começou? O efeito é por tentativa, então hasJobEffect (chave exata)
   * não serve; procuramos o prefixo nos eventos. Qualquer 'worker-start:' prova o começo.
   */
  private async hasWorkerStart(jobId: string): Promise<boolean> {
    const events = await this.memory.listJobEvents(jobId);
    return events.some((event) => (event.effectKey ?? '').startsWith(START_EFFECT_PREFIX));
  }

  /** Transição final tolerante: se alguém já terminou o trabalho, devolve o estado atual. */
  private async finish(jobId: string, to: JobStatus, opts: JobTransitionOptions): Promise<Job> {
    const current = await this.memory.getJob(jobId);
    if (!current) throw new Error(`trabalho ${jobId} não existe`);
    if (FINAL_JOB_STATUSES.includes(current.status)) return current;
    return this.memory.transitionJob(jobId, to, opts);
  }
}
