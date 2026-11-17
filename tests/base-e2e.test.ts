// Verificação de ponta a ponta da base de trabalhos (plano mestre F08).
// Cada cenário usa o banco de teste, uma pasta temporária de artefatos e pollMs pequeno.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { NightCoordinator, type CoordinatorOptions } from '../src/app/coordinator.ts';
import { ArtifactStore } from '../src/artifacts/store.ts';
import type { Job, JobKind } from '../src/core/types.ts';
import { JobRunner } from '../src/jobs/runner.ts';
import type { JobWorker, WorkerRequest, WorkerResult } from '../src/jobs/worker.ts';
import { FakeWorker, WORKER_CONTRACT } from '../src/jobs/worker.ts';
import { PgMemory } from '../src/memory/pg-memory.ts';
import { NightRouter } from '../src/router/router.ts';
import { FakeLlm, resetTestDb, TEST_URL, truncateAll } from './helpers.ts';

const POLL_MS = 5;

/**
 * Trabalhador de teste que começa de verdade: no start grava o artefato (o efeito externo já
 * aconteceu) e devolve um runId estável por trabalho. `outcome` diz o que o status responde e
 * `statusErrors` faz o status lançar DEPOIS do start — a falha parcial que o F08 precisa cobrir.
 */
class TrabalhadorDeTeste implements JobWorker {
  readonly name = 'teste-f08';
  /** Execuções reais começadas: start repetido (mesmo jobId) não conta. */
  startedRuns = 0;
  startCalls = 0;
  cancelCalls = 0;
  outcome: 'running' | 'succeeded' = 'running';
  /** Quantos status() lançam antes de voltar a responder. */
  statusErrors = 0;
  private readonly runByJob = new Map<string, string>();
  private readonly jobByRun = new Map<string, string>();
  private readonly artifactsByRun = new Map<string, { name: string; sha256: string }[]>();

  constructor(private readonly store: ArtifactStore) {}

  async start(request: WorkerRequest): Promise<{ runId: string }> {
    this.startCalls += 1;
    const existing = this.runByJob.get(request.jobId);
    // Mesmo contrato do FakeWorker: start idempotente por jobId.
    if (existing) return { runId: existing };
    const runId = `run-${this.startedRuns + 1}`;
    this.startedRuns += 1;
    this.runByJob.set(request.jobId, runId);
    this.jobByRun.set(runId, request.jobId);
    const item = await this.store.add(request.jobId, {
      name: 'saida.txt', data: `saída de ${request.jobId}\n`, origin: this.name,
    });
    this.artifactsByRun.set(runId, [{ name: item.name, sha256: item.sha256 }]);
    return { runId };
  }

  async status(runId: string): Promise<{ state: 'running' | 'succeeded'; message: string }> {
    this.jobOf(runId);
    if (this.statusErrors > 0) {
      this.statusErrors -= 1;
      throw new Error('status caiu depois do start');
    }
    return { state: this.outcome, message: this.outcome === 'succeeded' ? 'concluído' : 'em execução' };
  }

  async result(runId: string): Promise<WorkerResult> {
    const jobId = this.jobOf(runId);
    if (this.outcome !== 'succeeded') throw new Error(`execução ${runId} ainda está rodando`);
    return {
      contract: WORKER_CONTRACT, jobId, state: 'succeeded',
      artifacts: this.artifactsByRun.get(runId) ?? [], error: null,
    };
  }

  async cancel(runId: string): Promise<{ cancelled: boolean; detail: string }> {
    this.cancelCalls += 1;
    this.jobOf(runId);
    return { cancelled: true, detail: 'cancelado pelo teste' };
  }

  private jobOf(runId: string): string {
    const jobId = this.jobByRun.get(runId);
    if (!jobId) throw new Error(`runId desconhecido: ${runId}`);
    return jobId;
  }
}

describe('Base de trabalhos de ponta a ponta (F08)', () => {
  let mem: PgMemory;
  let root = '';
  let store: ArtifactStore;
  let llm: FakeLlm;

  /** Coordenador novo a cada uso: é o que uma janela nova do Night faz ao abrir. */
  const coordinator = (memory: PgMemory = mem, model: FakeLlm = llm, opts: CoordinatorOptions = {}): NightCoordinator =>
    new NightCoordinator(
      memory,
      new NightRouter(model, async () => (await memory.listProjects()).map((p) => p.name)),
      model,
      opts,
    );

  const makeJob = async (kind: JobKind, key: string, params: Record<string, unknown> = {}): Promise<Job> => {
    const { job } = await mem.createJob({ kind, origin: 'texto', idempotencyKey: key, params });
    return job;
  };

  const requestOf = (job: Job): WorkerRequest => ({
    contract: WORKER_CONTRACT, jobId: job.id, kind: job.kind, params: job.params, limits: job.limits,
  });

  const runnerFor = (worker: JobWorker): JobRunner =>
    new JobRunner(mem, worker, store, { pollMs: POLL_MS, maxPolls: 60 });

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
    root = await mkdtemp(join(tmpdir(), 'night-base-e2e-'));
    store = new ArtifactStore(root);
    llm = new FakeLlm(() => 'resposta do modelo local');
  });

  test('1. coding, radar e vídeo nascem pelo mesmo caminho, com número e estado próprios', async () => {
    // Mesmo createJob para os três tipos: o primeiro de cada um é o número 1.
    const coding = await makeJob('coding', 'e2e-cod-1');
    const radar = await makeJob('radar', 'e2e-rad-1', { query: 'fone bluetooth' });
    const video = await makeJob('video', 'e2e-vid-1', { topic: 'café gelado' });
    assert.deepEqual([coding.number, radar.number, video.number], [1, 1, 1]);
    assert.deepEqual([coding.status, radar.status, video.status], ['queued', 'queued', 'queued']);

    // Andar um tipo não mexe no estado dos outros.
    await mem.transitionJob(coding.id, 'running', { source: 'worker', message: 'começou' });
    await mem.transitionJob(radar.id, 'running', { source: 'worker', message: 'começou' });
    await mem.transitionJob(radar.id, 'waiting', { source: 'worker', message: 'esperando o Flow', waitingFor: 'flow' });

    assert.equal((await mem.getJobByNumber('coding', 1))?.status, 'running');
    assert.equal((await mem.getJobByNumber('radar', 1))?.status, 'waiting');
    assert.equal((await mem.getJobByNumber('video', 1))?.status, 'queued');
    assert.equal((await mem.listJobs()).length, 3);
  });

  test('2. ação concluída: radar pronto, artefato verificado e status lido do banco', async () => {
    const night = coordinator();
    const created = await night.handle('vasculha ofertas de fone bluetooth');
    assert.match(created.text, /^Registrei o Radar 1/);
    const job = await mem.getJobByNumber('radar', 1);
    assert.ok(job);

    const worker = new FakeWorker({ [job.id]: 'succeed' }, store);
    const done = await runnerFor(worker).run(job.id);
    assert.equal(done.status, 'succeeded');
    assert.equal(done.artifactRef, `artefatos:${job.id}`);
    assert.equal(worker.startedRuns, 1);
    assert.deepEqual(await store.verify(job.id), { ok: true, missing: [], changed: [], extra: [] });

    // Coordenador novo responde pelo estado gravado, sem chamar o modelo.
    const readerLlm = new FakeLlm(() => 'não deveria ser usado');
    const reader = coordinator(mem, readerLlm);
    const status = await reader.handle('como está o radar 1?');
    assert.match(status.text, /^Radar 1 está pronto\./);
    assert.ok((status.detail ?? '').includes(`artefato: artefatos:${job.id}`));
    assert.equal(readerLlm.calls.length, 0, 'status vem do banco, não do modelo');
  });

  test('3. falha depois do efeito externo: retryable e a retomada não começa outra execução', async () => {
    const job = await makeJob('radar', 'e2e-falha-1', { query: 'fone bluetooth' });
    const worker = new TrabalhadorDeTeste(store);
    worker.statusErrors = 1; // começa e registra o efeito; o status cai logo depois

    const first = await runnerFor(worker).run(job.id);
    assert.equal(first.status, 'retryable');
    assert.match(first.error ?? '', /status caiu depois do start/);
    assert.equal(worker.startedRuns, 1);
    assert.equal(
      (await mem.listJobEvents(job.id)).some((e) => (e.effectKey ?? '').startsWith('worker-start:')),
      true,
      'o efeito externo ficou registrado',
    );

    // JobRunner novo = Night reiniciado: retoma pelo mesmo runId, sem repetir o efeito.
    worker.outcome = 'succeeded';
    const done = await runnerFor(worker).run(job.id);
    assert.equal(done.status, 'succeeded');
    assert.equal(worker.startCalls, 2, 'start foi chamado de novo para retomar');
    assert.equal(worker.startedRuns, 1, 'o trabalhador não começou outra execução');
    const effects = (await mem.listJobEvents(job.id))
      .filter((e) => e.eventType === 'effect-confirmed' && (e.effectKey ?? '').startsWith('worker-start:'));
    assert.equal(effects.length, 1, 'um só efeito worker-start');
    assert.equal(done.artifactRef, `artefatos:${job.id}`);
    assert.deepEqual(await store.verify(job.id), { ok: true, missing: [], changed: [], extra: [] });
  });

  test('4. reinício no meio: fechar a memória e reabrir mantém um só worker-start e termina', async () => {
    const job = await makeJob('video', 'e2e-reinicio-1', { topic: 'café gelado' });
    const worker = new TrabalhadorDeTeste(store);
    // Estado exato de um Night que morreu logo depois de começar: running + efeito registrado.
    await mem.transitionJob(job.id, 'running', { source: 'runner', message: 'começando o trabalho' });
    const { runId } = await worker.start(requestOf(job));
    assert.deepEqual(
      await mem.recordJobEffect(job.id, `worker-start:${runId}`, 'runner', `runId=${runId}`),
      { recorded: true },
    );

    await mem.close();
    mem = await PgMemory.open(TEST_URL);
    assert.equal((await mem.getJob(job.id))?.status, 'running', 'o estado sobreviveu ao reinício');

    worker.outcome = 'succeeded';
    const done = await runnerFor(worker).run(job.id);
    assert.equal(done.status, 'succeeded');
    assert.equal(worker.startedRuns, 1, 'a execução que já existia foi retomada');
    assert.equal(worker.startCalls, 2);
    const events = await mem.listJobEvents(job.id);
    assert.equal(
      events.filter((e) => (e.effectKey ?? '').startsWith('worker-start:')).length,
      1,
      'um só efeito worker-start',
    );
    assert.equal(events.find((e) => (e.effectKey ?? '').startsWith('worker-start:'))?.message, `runId=${runId}`);
    assert.deepEqual(
      events.filter((e) => e.eventType === 'status-changed').map((e) => e.toStatus),
      ['queued', 'running', 'succeeded'],
    );
    assert.equal(done.artifactRef, `artefatos:${job.id}`);
    assert.deepEqual(await store.verify(job.id), { ok: true, missing: [], changed: [], extra: [] });
  });

  test('5. cancelamento: vídeo rodando vira cancelled pelo coordenador; queued não chama o trabalhador', async () => {
    const night = coordinator();
    const created = await night.handle('cria um vídeo sobre café gelado');
    assert.match(created.text, /^Registrei o Vídeo 1/);
    const hanging = await mem.getJobByNumber('video', 1);
    assert.ok(hanging);

    // O trabalhador já está rodando (hang): é o trabalho que o Joel quer parar.
    const worker = new FakeWorker({ [hanging.id]: 'hang' }, store);
    await mem.transitionJob(hanging.id, 'running', { source: 'runner', message: 'começando o trabalho' });
    await worker.start(requestOf(hanging));
    assert.equal(worker.startedRuns, 1);

    // Sem runner nesta janela, não dá para provar que o processo parou: só marca e diz isso.
    assert.equal((await night.handle('cancela o vídeo 1')).text,
      'Marquei o Vídeo 1 como cancelado; nenhum trabalhador ativo neste NIGHT.');
    assert.equal((await mem.getJob(hanging.id))?.status, 'cancelled');
    assert.equal(worker.startCalls, 1, 'cancelar pelo dono não começa execução nova');

    // Trabalho ainda na fila: sem roteiro no trabalhador, cancelar não pode chamá-lo.
    const second = await night.handle('cria um vídeo sobre chá gelado');
    assert.match(second.text, /^Registrei o Vídeo 2/);
    const queued = await mem.getJobByNumber('video', 2);
    assert.ok(queued);
    assert.equal((await night.handle('cancela o vídeo 2')).text, 'Cancelei o Vídeo 2.');
    assert.equal((await mem.getJob(queued.id))?.status, 'cancelled');
    assert.equal(worker.startCalls, 1, 'queued cancelado não chama o trabalhador');

    // Rodar de novo um trabalho já cancelado também não começa nada.
    const again = await runnerFor(worker).run(queued.id);
    assert.equal(again.status, 'cancelled');
    assert.equal(worker.startCalls, 1);
  });

  test('8. com runner, só diz que cancelou depois da confirmação do trabalhador', async () => {
    const job = await makeJob('video', 'e2e-cancel-confirma', { topic: 'café gelado' });
    await mem.transitionJob(job.id, 'running', { source: 'runner', message: 'começando o trabalho' });
    const worker = new FakeWorker({ [job.id]: 'hang' }, store);
    await worker.start(requestOf(job));
    const night = coordinator(mem, llm, { jobRunners: { video: runnerFor(worker) } });

    const r = await night.handle('cancela o vídeo 1');
    assert.equal(r.text, 'Cancelei o Vídeo 1.');
    assert.equal(worker.cancelCalls, 1, 'pediu ao trabalhador de verdade');
    assert.equal((await mem.getJob(job.id))?.status, 'cancelled');
  });

  test('9. sem confirmação do trabalhador, não diz que parou e deixa retryable', async () => {
    const job = await makeJob('video', 'e2e-cancel-sem-confirmar', { topic: 'chá gelado' });
    await mem.transitionJob(job.id, 'running', { source: 'runner', message: 'começando o trabalho' });
    // O trabalhador já terminou a execução: cancel() responde cancelled=false.
    const worker = new FakeWorker({ [job.id]: 'succeed' }, store);
    await worker.start(requestOf(job));
    const night = coordinator(mem, llm, { jobRunners: { video: runnerFor(worker) } });

    const r = await night.handle('cancela o vídeo 1');
    assert.match(r.text,
      /^Pedi para cancelar o Vídeo 1, mas o trabalhador não confirmou: .+\. Ele fica marcado para tentar de novo\.$/);
    assert.doesNotMatch(r.text, /^Cancelei/, 'nunca diz que parou sem confirmação');
    assert.equal(worker.cancelCalls, 1);
    assert.equal((await mem.getJob(job.id))?.status, 'retryable');
  });

  test('6. aprovação específica não vira merge e não toca em trabalho não pronto', async () => {
    const video = await makeJob('video', 'e2e-ap-video', { topic: 'café gelado' });
    await mem.transitionJob(video.id, 'running', { source: 'worker', message: 'começou' });
    await mem.transitionJob(video.id, 'succeeded', { source: 'worker', message: 'pronto' });
    const radar = await makeJob('radar', 'e2e-ap-radar', { query: 'fone bluetooth' });
    const night = coordinator();

    const approved = await night.handle('aprova o vídeo 1');
    assert.equal(approved.text, 'Aprovei o vídeo 1. Isso não publica, não gasta e não faz merge.');
    const progress = (await mem.listJobEvents(video.id)).filter((e) => e.eventType === 'progress');
    assert.equal(progress.length, 1);
    assert.equal(progress[0]!.source, 'owner');
    assert.match(progress[0]!.message, /vídeo aprovado pelo Joel/);
    assert.equal((await mem.listPendingApprovals()).length, 0, 'não cria Approval de merge');
    assert.equal((await mem.listTasks()).length, 0);

    // "aprovo" sozinho continua sendo merge e não escreve nada no trabalho.
    const before = (await mem.listJobEvents(video.id)).length;
    assert.equal((await night.handle('aprovo')).text, 'Não tem nada esperando aprovação.');
    assert.equal((await mem.listJobEvents(video.id)).length, before);

    // Oferta sem banco do Radar: não inventa decisão nem cai no job de mesmo número.
    assert.equal((await night.handle('aprova a oferta 1')).text, 'O Radar ainda não tem banco ligado.');
    assert.equal((await mem.listJobEvents(radar.id)).length, 1, 'só o evento de criação');
    assert.equal((await mem.listPendingApprovals()).length, 0);
  });

  test('7. idempotência do pedido: a mesma frase no mesmo minuto cria um trabalho só', async () => {
    const night = coordinator();
    const first = await night.handle('vasculha ofertas de fone bluetooth');
    const again = await night.handle('vasculha ofertas de fone bluetooth');
    assert.match(first.text, /^Registrei o Radar 1/);
    assert.equal(again.text, 'O Radar 1 já está registrado.');

    const jobs = await mem.listJobs({ kind: 'radar' });
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]!.number, 1);
    assert.equal((await mem.listJobEvents(jobs[0]!.id)).length, 1, 'o pedido repetido não grava evento');
    assert.equal(llm.calls.length, 0, 'nem criar nem repetir gasta modelo');
  });
});
