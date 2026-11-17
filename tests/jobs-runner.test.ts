import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { ArtifactStore } from '../src/artifacts/store.ts';
import type { Job, JobKind } from '../src/core/types.ts';
import { JobRunner } from '../src/jobs/runner.ts';
import {
  FakeWorker, WORKER_CONTRACT, validateWorkerRequest, validateWorkerResult,
  type FakeBehavior, type JobWorker, type WorkerRequest, type WorkerResult,
} from '../src/jobs/worker.ts';
import { PgMemory } from '../src/memory/pg-memory.ts';
import { resetTestDb, TEST_URL, truncateAll } from './helpers.ts';

function requestOf(job: Job): WorkerRequest {
  return {
    contract: WORKER_CONTRACT,
    jobId: job.id,
    kind: job.kind,
    params: job.params,
    limits: job.limits,
  };
}

/** Trabalhador que não confirma o cancelamento: o runner não pode dizer que parou. */
class CancelamentoNaoConfirmado extends FakeWorker {
  constructor(
    script: Record<string, FakeBehavior>,
    store: ArtifactStore,
    private readonly mode: 'lanca' | 'recusa',
  ) {
    super(script, store);
  }

  override async cancel(_runId: string): Promise<{ cancelled: boolean; detail: string }> {
    this.cancelCalls += 1;
    if (this.mode === 'lanca') throw new Error('trabalhador não respondeu');
    return { cancelled: false, detail: 'execução seguiu rodando' };
  }
}

/** Trabalhador que já concluiu mas não entregou artefato nenhum. */
class TrabalhadorSemArtefatos implements JobWorker {
  readonly name = 'sem-artefatos';
  private jobId = '';

  async start(request: WorkerRequest): Promise<{ runId: string }> {
    this.jobId = request.jobId;
    return { runId: 'run-sem-artefatos' };
  }

  async status(): Promise<{ state: 'succeeded'; message: string }> {
    return { state: 'succeeded', message: 'concluído sem entregar nada' };
  }

  async result(_runId: string): Promise<WorkerResult> {
    return {
      contract: WORKER_CONTRACT, jobId: this.jobId, state: 'succeeded', artifacts: [], error: null,
    };
  }

  async cancel(): Promise<{ cancelled: boolean; detail: string }> {
    return { cancelled: true, detail: 'cancelado' };
  }
}

/** Trabalhador que já terminou cancelado por fora: o runner não pode marcar sucesso. */
class TrabalhadorCancelado implements JobWorker {
  readonly name = 'cancelado';
  private jobId = '';

  async start(request: WorkerRequest): Promise<{ runId: string }> {
    this.jobId = request.jobId;
    return { runId: 'run-cancelado' };
  }

  async status(): Promise<{ state: 'cancelled'; message: string }> {
    return { state: 'cancelled', message: 'cancelado por fora' };
  }

  async result(): Promise<WorkerResult> {
    return {
      contract: WORKER_CONTRACT, jobId: this.jobId, state: 'cancelled', artifacts: [], error: null,
    };
  }

  async cancel(): Promise<{ cancelled: boolean; detail: string }> {
    return { cancelled: true, detail: 'já estava cancelado' };
  }
}

/** Grava o artefato no disco (manifesto existe) mas devolve a lista de artefatos vazia. */
class ResultadoSemArtefatos extends FakeWorker {
  override async result(runId: string): Promise<WorkerResult> {
    const base = await super.result(runId);
    return { ...base, artifacts: [] };
  }
}

describe('JobRunner com trabalhador falso', () => {
  let mem: PgMemory;
  let root = '';
  let store: ArtifactStore;

  before(async () => {
    await resetTestDb(TEST_URL);
    mem = await PgMemory.open(TEST_URL);
  });
  after(async () => {
    await mem?.close();
    if (root) await rm(root, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await truncateAll();
    if (root) await rm(root, { recursive: true, force: true });
    root = await mkdtemp(join(tmpdir(), 'night-jobs-runner-'));
    store = new ArtifactStore(root);
  });

  async function makeJob(key: string, kind: JobKind = 'radar'): Promise<Job> {
    const { job } = await mem.createJob({
      kind, origin: 'texto', idempotencyKey: key, params: { alvo: key },
    });
    return job;
  }

  const runnerFor = (worker: JobWorker, opts: { pollMs?: number; maxPolls?: number } = {}): JobRunner =>
    new JobRunner(mem, worker, store, { pollMs: 5, maxPolls: 60, ...opts });

  test('conclui: succeeded com artifactRef e artefato verificado', async () => {
    const job = await makeJob('ok-1');
    const worker = new FakeWorker({ [job.id]: 'succeed' }, store);
    const done = await runnerFor(worker).run(job.id);

    assert.equal(done.status, 'succeeded');
    assert.equal(done.artifactRef, `artefatos:${job.id}`);
    assert.equal(worker.startedRuns, 1);
    assert.equal(worker.startCalls, 1);
    assert.deepEqual(await store.verify(job.id), { ok: true, missing: [], changed: [], extra: [] });

    const events = await mem.listJobEvents(job.id);
    assert.equal(events.filter((e) => e.eventType === 'effect-confirmed').length, 1);
    assert.ok(events.some((e) => e.eventType === 'status-changed' && e.toStatus === 'succeeded'));
  });

  test('falha: failed com o erro do trabalhador', async () => {
    const job = await makeJob('falha-1');
    const worker = new FakeWorker({ [job.id]: 'fail' }, store);
    const done = await runnerFor(worker).run(job.id);

    assert.equal(done.status, 'failed');
    assert.match(done.error ?? '', /falha simulada/);
    assert.equal(done.artifactRef, null);
    assert.equal(worker.startedRuns, 1);
  });

  test('sem artefatos: succeeded sem manifesto vira failed, não sucesso', async () => {
    const job = await makeJob('sem-artefatos-1');
    const done = await runnerFor(new TrabalhadorSemArtefatos()).run(job.id);

    assert.equal(done.status, 'failed');
    assert.match(done.error ?? '', /trabalhador não entregou artefatos/);
    assert.equal(done.artifactRef, null);
  });

  test('resultado com lista de artefatos vazia: failed mesmo com manifesto no disco', async () => {
    const job = await makeJob('sem-lista-1');
    const worker = new ResultadoSemArtefatos({ [job.id]: 'succeed' }, store);
    const done = await runnerFor(worker).run(job.id);

    assert.equal(done.status, 'failed');
    assert.match(done.error ?? '', /trabalhador não entregou artefatos/);
    assert.equal(done.artifactRef, null);
  });

  test('cancelar: hang vira cancelled e chama worker.cancel', async () => {
    const job = await makeJob('cancel-1');
    const worker = new FakeWorker({ [job.id]: 'hang' }, store);
    await mem.transitionJob(job.id, 'running', { source: 'runner', message: 'teste' });
    await worker.start(requestOf(job));

    const runner = runnerFor(worker, { maxPolls: 1000 });
    const result = await runner.cancel(job.id);
    assert.equal(result.confirmed, true, 'o trabalhador confirmou a parada');
    assert.equal(result.job.status, 'cancelled');
    assert.match(result.detail, /cancelado/);
    assert.equal(worker.cancelCalls, 1);
    assert.equal(worker.startedRuns, 1, 'cancelar não começa outra execução');

    // Já final: run() de novo não muda nada.
    const afterCancel = await runner.run(job.id);
    assert.equal(afterCancel.status, 'cancelled');
    assert.equal(worker.startCalls, 2, 'cancelar chamou start uma vez além da original');
  });

  test('cancelar job queued: só marca cancelled, sem começar execução', async () => {
    const job = await makeJob('cancel-queued-1');
    const worker = new FakeWorker({ [job.id]: 'hang' }, store);

    const result = await runnerFor(worker).cancel(job.id);
    assert.equal(result.confirmed, true, 'sem execução começada, não há o que confirmar');
    assert.equal(result.job.status, 'cancelled');
    assert.equal(worker.startCalls, 0, 'cancelar não pode começar a execução só para cancelá-la');
    assert.equal(worker.startedRuns, 0);
    assert.equal(worker.cancelCalls, 0, 'sem execução, não há o que cancelar no trabalhador');
  });

  test('cancelar: worker.cancel lança -> não vira cancelled e confirmed=false', async () => {
    const job = await makeJob('cancel-erro-1');
    const worker = new CancelamentoNaoConfirmado({ [job.id]: 'hang' }, store, 'lanca');
    await mem.transitionJob(job.id, 'running', { source: 'runner', message: 'teste' });
    await worker.start(requestOf(job));

    const result = await runnerFor(worker, { maxPolls: 1000 }).cancel(job.id);
    assert.equal(result.confirmed, false);
    assert.equal(result.job.status, 'retryable', 'a execução pode seguir: não é cancelled');
    assert.match(result.job.error ?? '', /cancelamento não confirmado pelo trabalhador/);
    const events = await mem.listJobEvents(job.id);
    assert.ok(events.some((e) => e.eventType === 'error'
      && /cancelamento não confirmado/.test(e.message)), 'o motivo fica no evento de erro');
  });

  test('cancelar: worker.cancel devolve cancelled=false -> não vira cancelled', async () => {
    const job = await makeJob('cancel-recusa-1');
    const worker = new CancelamentoNaoConfirmado({ [job.id]: 'hang' }, store, 'recusa');
    await mem.transitionJob(job.id, 'running', { source: 'runner', message: 'teste' });
    await worker.start(requestOf(job));

    const result = await runnerFor(worker, { maxPolls: 1000 }).cancel(job.id);
    assert.equal(result.confirmed, false);
    assert.equal(result.detail, 'execução seguiu rodando');
    assert.equal(result.job.status, 'retryable');
    assert.match(result.job.error ?? '', /execução seguiu rodando/);
    assert.equal((await mem.getJob(job.id))?.status, 'retryable');
  });

  test('trabalhador cancelado por fora: run marca cancelled', async () => {
    const job = await makeJob('cancel-2');
    const done = await runnerFor(new TrabalhadorCancelado()).run(job.id);

    assert.equal(done.status, 'cancelled');
    assert.equal(done.error, null);
  });

  test('hang com maxPolls pequeno: retryable sem cancelar o trabalhador', async () => {
    const job = await makeJob('hang-1');
    const worker = new FakeWorker({ [job.id]: 'hang' }, store);
    const done = await runnerFor(worker, { pollMs: 5, maxPolls: 2 }).run(job.id);

    assert.equal(done.status, 'retryable');
    assert.match(done.error ?? '', /tempo esgotado/);
    assert.equal(worker.cancelCalls, 0, 'não cancela: o trabalhador pode seguir');
  });

  test('duas chamadas run() simultâneas: um start só e a mesma Promise de execução', async () => {
    const job = await makeJob('duas-execucoes');
    const worker = new FakeWorker({ [job.id]: 'hang' }, store);
    const runner = runnerFor(worker, { maxPolls: 3 });

    assert.equal(runner.isRunning(job.id), false, 'nada rodando antes do primeiro pedido');
    const primeira = runner.run(job.id);
    const segunda = runner.run(job.id);
    assert.equal(primeira, segunda, 'a segunda chamada devolve a execução em andamento');
    assert.equal(runner.isRunning(job.id), true, 'a execução fica marcada enquanto roda');

    const [a, b] = await Promise.all([primeira, segunda]);
    assert.equal(a.id, job.id);
    assert.equal(b.id, job.id);
    assert.equal(a.status, 'retryable');
    assert.equal(b.status, 'retryable');
    assert.equal(a.version, b.version, 'um laço só: nenhuma transição duplicada');
    assert.equal(worker.startCalls, 1, 'o trabalhador recebeu um start só');
    assert.equal(worker.startedRuns, 1);
    assert.equal(runner.isRunning(job.id), false, 'terminou: deixa de estar em execução');

    // Depois do fim, run() volta a executar (é a retomada normal de um retryable).
    const retomada = runner.run(job.id);
    assert.equal(runner.isRunning(job.id), true);
    assert.equal((await retomada).status, 'retryable');
  });

  test('reinício: run de novo não começa outra execução nem duplica o efeito', async () => {
    const job = await makeJob('reinicio-1');
    const worker = new FakeWorker({ [job.id]: 'hang' }, store);

    const first = await runnerFor(worker, { maxPolls: 2 }).run(job.id);
    assert.equal(first.status, 'retryable');
    assert.equal(worker.startedRuns, 1);

    // JobRunner novo, mesmo trabalhador: é o que acontece ao reiniciar o NIGHT.
    const second = await runnerFor(worker, { maxPolls: 2 }).run(job.id);
    assert.equal(second.status, 'retryable');
    assert.equal(worker.startedRuns, 1, 'start repetido devolve o mesmo runId');
    assert.ok(worker.startCalls >= 2, 'start foi chamado de novo para retomar');

    const effects = (await mem.listJobEvents(job.id))
      .filter((e) => e.eventType === 'effect-confirmed' && (e.effectKey ?? '').startsWith('worker-start:'));
    assert.equal(effects.length, 1, 'o efeito worker-start foi registrado uma vez só');
  });

  test('artefato alterado no disco: failed, não succeeded', async () => {
    const job = await makeJob('alterado-1');
    const worker = new FakeWorker({ [job.id]: 'succeed' }, store);
    await mem.transitionJob(job.id, 'running', { source: 'runner', message: 'teste' });
    const { runId } = await worker.start(requestOf(job));
    assert.equal((await worker.status(runId)).state, 'succeeded');

    // O trabalhador terminou; alguém mexe no arquivo antes da verificação do runner.
    await writeFile(join(root, job.id, 'resultado.txt'), 'adulterado');

    const done = await runnerFor(worker).run(job.id);
    assert.equal(done.status, 'failed');
    assert.match(done.error ?? '', /artefatos não conferem/);
    assert.equal((await mem.getJob(job.id))?.artifactRef, null);
  });

  test('job final não muda com run() de novo', async () => {
    const job = await makeJob('final-1');
    const worker = new FakeWorker({ [job.id]: 'succeed' }, store);
    const runner = runnerFor(worker);

    const first = await runner.run(job.id);
    assert.equal(first.status, 'succeeded');
    const again = await runner.run(job.id);
    assert.equal(again.status, 'succeeded');
    assert.equal(again.version, first.version, 'não transita nem grava evento');
    assert.equal(worker.startCalls, 1);
  });

  test('validações recusam pedido e resultado ruins', () => {
    const good = { contract: WORKER_CONTRACT, jobId: 'j1', kind: 'radar', params: {}, limits: {} };
    assert.equal(validateWorkerRequest(good).ok, true);
    assert.equal(validateWorkerRequest({ ...good, contract: 'worker/0' }).ok, false);
    assert.equal(validateWorkerRequest({ ...good, jobId: ' ' }).ok, false);
    assert.equal(validateWorkerRequest({ ...good, kind: 'outro' }).ok, false);
    assert.equal(validateWorkerRequest({ ...good, params: [] }).ok, false);
    assert.equal(validateWorkerRequest({ ...good, limits: null }).ok, false);
    assert.equal(validateWorkerRequest(null).ok, false);

    const sha = 'a'.repeat(64);
    const result = {
      contract: WORKER_CONTRACT,
      jobId: 'j1',
      state: 'succeeded',
      artifacts: [{ name: 'x.txt', sha256: sha }],
      error: null,
    };
    assert.equal(validateWorkerResult(result, 'j1').ok, true);
    assert.equal(validateWorkerResult(result, 'outro').ok, false);
    assert.equal(validateWorkerResult({ ...result, state: 'running' }, 'j1').ok, false);
    assert.equal(validateWorkerResult({ ...result, artifacts: [{ name: 'x.txt', sha256: 'curto' }] }, 'j1').ok, false);
    assert.equal(validateWorkerResult({ ...result, error: 7 }, 'j1').ok, false);
    assert.equal(validateWorkerResult({ ...result, usage: { tokens: 'muitos' } }, 'j1').ok, false);
    assert.equal(validateWorkerResult({ ...result, usage: { tokens: 10 } }, 'j1').ok, true);

    // 'waiting' é espera, não falha; exige waitingFor e leva a mensagem adiante.
    const waiting = validateWorkerResult(
      { ...result, state: 'waiting', waitingFor: 'flow', message: 'aguardando_flow: cenas 2' }, 'j1',
    );
    assert.equal(waiting.ok, true);
    assert.equal(waiting.ok && waiting.result.waitingFor, 'flow');
    assert.equal(waiting.ok && waiting.result.message, 'aguardando_flow: cenas 2');
    assert.equal(validateWorkerResult({ ...result, state: 'waiting' }, 'j1').ok, false);
    assert.equal(validateWorkerResult({ ...result, state: 'waiting', waitingFor: ' ' }, 'j1').ok, false);
    assert.equal(validateWorkerResult({ ...result, message: 7 }, 'j1').ok, false);
  });

  test('trabalhador falso: nova tentativa depois de falha; mesma execução se ativa ou deu certo', async () => {
    const job = await makeJob('fake-tentativas');

    const falha = new FakeWorker({ [job.id]: 'fail' }, store);
    const primeira = await falha.start(requestOf(job));
    assert.equal((await falha.status(primeira.runId)).state, 'failed');
    const segunda = await falha.start(requestOf(job));
    assert.notEqual(segunda.runId, primeira.runId, 'falha encerrou a tentativa');
    assert.equal(falha.startedRuns, 2);

    const ativo = new FakeWorker({ [job.id]: 'hang' }, store);
    const a = await ativo.start(requestOf(job));
    const b = await ativo.start(requestOf(job));
    assert.equal(b.runId, a.runId, 'execução ativa não duplica');
    assert.equal(ativo.startedRuns, 1);

    const sucesso = new FakeWorker({ [job.id]: 'succeed' }, store);
    const c = await sucesso.start(requestOf(job));
    const d = await sucesso.start(requestOf(job));
    assert.equal(d.runId, c.runId, 'sucesso é idempotente');
    assert.equal(sucesso.startedRuns, 1);
  });
});
