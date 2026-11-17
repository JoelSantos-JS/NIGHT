import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { PgMemory } from '../src/memory/pg-memory.ts';
import { resetTestDb, TEST_URL, truncateAll } from './helpers.ts';

describe('PgMemory: trabalhos (jobs)', () => {
  let mem: PgMemory;

  before(async () => {
    await resetTestDb(TEST_URL);
    mem = await PgMemory.open(TEST_URL);
  });
  after(async () => { await mem?.close(); });
  beforeEach(async () => { await truncateAll(); });

  test('mesma chave não cria outro job, nem com duas chamadas simultâneas', async () => {
    const first = await mem.createJob({ kind: 'radar', origin: 'texto', idempotencyKey: 'busca-1' });
    assert.equal(first.created, true);
    assert.equal(first.job.status, 'queued');
    assert.equal(first.job.version, 1);

    const again = await mem.createJob({ kind: 'radar', origin: 'voz', idempotencyKey: 'busca-1' });
    assert.equal(again.created, false);
    assert.equal(again.job.id, first.job.id);
    assert.equal(again.job.origin, 'texto', 'o pedido repetido não altera o job que já existe');

    const [a, b] = await Promise.all([
      mem.createJob({ kind: 'video', origin: 'voz', idempotencyKey: 'video-1' }),
      mem.createJob({ kind: 'video', origin: 'voz', idempotencyKey: 'video-1' }),
    ]);
    assert.equal([a.created, b.created].filter(Boolean).length, 1, 'só uma chamada cria');
    assert.equal(a.job.id, b.job.id);
    assert.equal((await mem.listJobs({ kind: 'video' })).length, 1);
    // Só o job criado ganha evento; o repetido não grava nada.
    assert.equal((await mem.listJobEvents(first.job.id)).length, 1);
  });

  test('listJobs separa coding, radar e video e filtra por status', async () => {
    const coding = await mem.createJob({ kind: 'coding', origin: 'voz', idempotencyKey: 'cod-1' });
    await mem.createJob({ kind: 'radar', origin: 'rotina', idempotencyKey: 'radar-1' });
    await mem.createJob({ kind: 'video', origin: 'texto', idempotencyKey: 'vid-1' });
    await mem.transitionJob(coding.job.id, 'running', { source: 'scheduler', message: 'começou' });

    assert.deepEqual((await mem.listJobs({ kind: 'coding' })).map((j) => j.status), ['running']);
    assert.deepEqual((await mem.listJobs({ kind: 'radar' })).map((j) => j.status), ['queued']);
    assert.deepEqual((await mem.listJobs({ kind: 'video' })).map((j) => j.status), ['queued']);
    assert.deepEqual((await mem.listJobs({ status: ['running'] })).map((j) => j.kind), ['coding']);
    assert.equal((await mem.listJobs()).length, 3);
  });

  test('transição inválida lança e não grava evento', async () => {
    const { job } = await mem.createJob({ kind: 'radar', origin: 'texto', idempotencyKey: 'pular' });
    await assert.rejects(
      mem.transitionJob(job.id, 'succeeded', { source: 'worker', message: 'pulou etapas' }),
      /não é permitido/,
    );
    const events = await mem.listJobEvents(job.id);
    assert.deepEqual(events.map((e) => e.eventType), ['status-changed']);
    assert.equal((await mem.getJob(job.id))?.status, 'queued');
  });

  test('versão errada lança e não muda nada', async () => {
    const { job } = await mem.createJob({ kind: 'radar', origin: 'texto', idempotencyKey: 'versao' });
    await assert.rejects(
      mem.transitionJob(job.id, 'running', { source: 'worker', message: 'velho', expectedVersion: 99 }),
      /versão 1, esperada 99/,
    );
    assert.equal((await mem.getJob(job.id))?.status, 'queued');
    assert.equal((await mem.listJobEvents(job.id)).length, 1);

    const ok = await mem.transitionJob(job.id, 'running', {
      source: 'worker', message: 'certo', expectedVersion: 1,
    });
    assert.equal(ok.version, 2);
  });

  test('sucesso é final: não aceita cancelamento', async () => {
    const { job } = await mem.createJob({ kind: 'coding', origin: 'voz', idempotencyKey: 'final' });
    await mem.transitionJob(job.id, 'running', { source: 'worker', message: 'começou' });
    const done = await mem.transitionJob(job.id, 'succeeded', { source: 'worker', message: 'terminou' });
    assert.equal(done.version, 3);
    await assert.rejects(
      mem.transitionJob(job.id, 'cancelled', { source: 'owner', message: 'tarde demais' }),
      /não é permitido/,
    );
    const events = await mem.listJobEvents(job.id);
    assert.deepEqual(events.map((e) => `${e.fromStatus}→${e.toStatus}`), [
      'null→queued', 'queued→running', 'running→succeeded',
    ]);
  });

  test('reabrir a memória mantém status e eventos', async () => {
    const { job } = await mem.createJob({ kind: 'radar', origin: 'rotina', idempotencyKey: 'reinicio' });
    await mem.transitionJob(job.id, 'running', { source: 'worker', message: 'começou' });

    await mem.close();
    mem = await PgMemory.open(TEST_URL);

    const reopened = await mem.getJob(job.id);
    assert.equal(reopened?.status, 'running');
    assert.equal(reopened?.version, 2);
    const events = await mem.listJobEvents(job.id);
    assert.deepEqual(events.map((e) => `${e.fromStatus}→${e.toStatus}`), ['null→queued', 'queued→running']);
  });

  test('efeito externo repetido não duplica registro', async () => {
    const { job } = await mem.createJob({ kind: 'video', origin: 'voz', idempotencyKey: 'efeito' });
    const first = await mem.recordJobEffect(job.id, 'flow:cena-3', 'worker', 'imagem da cena 3 gerada');
    const second = await mem.recordJobEffect(job.id, 'flow:cena-3', 'worker', 'tentou gerar de novo');
    assert.deepEqual(first, { recorded: true });
    assert.deepEqual(second, { recorded: false });
    assert.equal(await mem.hasJobEffect(job.id, 'flow:cena-3'), true);
    assert.equal(await mem.hasJobEffect(job.id, 'flow:cena-4'), false);
    const effects = (await mem.listJobEvents(job.id)).filter((e) => e.eventType === 'effect-confirmed');
    assert.equal(effects.length, 1);
    assert.equal(effects[0]!.effectKey, 'flow:cena-3');
  });

  test('waiting grava o que espera e limpa ao voltar', async () => {
    const { job } = await mem.createJob({ kind: 'video', origin: 'texto', idempotencyKey: 'espera' });
    await mem.transitionJob(job.id, 'running', { source: 'worker', message: 'começou' });
    const waiting = await mem.transitionJob(job.id, 'waiting', {
      source: 'worker', message: 'esperando o Flow', waitingFor: 'flow',
    });
    assert.equal(waiting.status, 'waiting');
    assert.equal(waiting.waitingFor, 'flow');
    assert.equal((await mem.getJob(job.id))?.waitingFor, 'flow');

    const resumed = await mem.transitionJob(job.id, 'running', { source: 'worker', message: 'voltou' });
    assert.equal(resumed.waitingFor, null);
  });

  test('número falável começa em 1 e é independente por tipo', async () => {
    const r1 = await mem.createJob({ kind: 'radar', origin: 'texto', idempotencyKey: 'n-r1' });
    const r2 = await mem.createJob({ kind: 'radar', origin: 'texto', idempotencyKey: 'n-r2' });
    const r3 = await mem.createJob({ kind: 'radar', origin: 'texto', idempotencyKey: 'n-r3' });
    assert.deepEqual([r1.job.number, r2.job.number, r3.job.number], [1, 2, 3]);

    const v1 = await mem.createJob({ kind: 'video', origin: 'texto', idempotencyKey: 'n-v1' });
    const v2 = await mem.createJob({ kind: 'video', origin: 'texto', idempotencyKey: 'n-v2' });
    assert.deepEqual([v1.job.number, v2.job.number], [1, 2], 'cada tipo tem a sua sequência');

    const c1 = await mem.createJob({ kind: 'coding', origin: 'texto', idempotencyKey: 'n-c1' });
    assert.equal(c1.job.number, 1);

    assert.equal((await mem.getJobByNumber('radar', 2))?.id, r2.job.id);
    assert.equal(await mem.getJobByNumber('video', 3), null);
  });

  test('números não colidem com criações simultâneas', async () => {
    const created = await Promise.all(Array.from({ length: 5 }, (_, i) =>
      mem.createJob({ kind: 'radar', origin: 'texto', idempotencyKey: `sim-${i}` })));
    const numbers = created.map((c) => c.job.number).sort((a, b) => a - b);
    assert.deepEqual(numbers, [1, 2, 3, 4, 5]);
  });

  test('pedido repetido não queima número do tipo', async () => {
    const first = await mem.createJob({ kind: 'radar', origin: 'texto', idempotencyKey: 'mesma' });
    const again = await mem.createJob({ kind: 'radar', origin: 'texto', idempotencyKey: 'mesma' });
    assert.equal(again.job.number, first.job.number);
    const next = await mem.createJob({ kind: 'radar', origin: 'texto', idempotencyKey: 'outra' });
    assert.equal(next.job.number, 2);
  });
});
