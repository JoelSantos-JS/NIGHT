import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import pg from 'pg';
import { PgMemory } from '../src/memory/pg-memory.ts';
import type { Project } from '../src/core/types.ts';

const TEST_URL = process.env.NIGHT_TEST_DATABASE_URL ?? 'postgres://night@localhost:5433/night_test';

/** Zera o schema do banco de teste. Recusa qualquer banco que não termine em _test. */
async function resetTestDb(url: string): Promise<void> {
  const db = new URL(url).pathname.slice(1);
  if (!db.endsWith('_test')) throw new Error(`recusando zerar "${db}": não é banco de teste`);
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  } finally {
    await client.end();
  }
}

const abstrike: Project = {
  id: 'abstrike', name: 'Abstrike', description: 'arbitragem cripto', repoPath: null,
  defaultBranch: 'main', allowedPaths: [], status: 'active',
};

describe('PgMemory', () => {
  let mem: PgMemory;

  before(async () => {
    await resetTestDb(TEST_URL);
    mem = await PgMemory.open(TEST_URL);
  });
  after(async () => { await mem?.close(); });
  beforeEach(async () => {
    const c = new pg.Client({ connectionString: TEST_URL });
    await c.connect();
    await c.query('TRUNCATE approvals, task_events, tasks, ideas, projects');
    await c.end();
    await mem.upsertProject(abstrike);
  });

  test('migrar de novo não reaplica nada', async () => {
    const again = await PgMemory.open(TEST_URL);
    await again.close();
  });

  test('salva ideia e recupera por projeto', async () => {
    const saved = await mem.saveIdea({
      projectId: 'abstrike', title: 'Alerta de atraso de depósito',
      transcript: 'salva essa ideia: avisar quando a exchange atrasar depósito', tags: ['alerta'],
    });
    assert.ok(saved.id);
    assert.equal(saved.status, 'inbox');
    const found = await mem.findIdeas({ projectId: 'abstrike' });
    assert.deepEqual(found.map((i) => i.id), [saved.id]);
    assert.deepEqual(found[0]!.tags, ['alerta']);
  });

  test('busca em português acha plural e singular', async () => {
    await mem.saveIdea({ projectId: 'abstrike', title: 'Monitorar exchanges', transcript: 'monitorar depósitos atrasados' });
    await mem.saveIdea({ projectId: null, title: 'Página de doramas', transcript: 'recomendações de k-drama' });
    const r = await mem.findIdeas({ text: 'depósito atrasado' });
    assert.equal(r.length, 1);
    assert.equal(r[0]!.title, 'Monitorar exchanges');
  });

  test('busca em inglês também funciona', async () => {
    await mem.saveIdea({ projectId: null, title: 'Signal parser', transcript: 'build parsers for trading signals' });
    const r = await mem.findIdeas({ text: 'parser signal' });
    assert.equal(r.length, 1);
  });

  test('acha projeto pelo nome falado, sem diferenciar maiúsculas', async () => {
    assert.equal((await mem.findProjectByName(' abstrike '))?.id, 'abstrike');
    assert.equal(await mem.findProjectByName('soaken'), null);
  });

  test('status de tarefa gera evento e não sai de estado final', async () => {
    await mem.createTask({
      id: 't1', projectId: 'abstrike', objective: 'parser', scope: 'src/parser', status: 'queued',
      primaryAgent: 'claude', reviewAgent: 'codex', worktreePath: null, branch: null, baseRef: null,
      resultSummary: null, approvalState: 'none',
    });
    await mem.updateTaskStatus('t1', 'running', 'scheduler', 'começou');
    await mem.updateTaskStatus('t1', 'cancelled', 'owner', 'pediu para parar');
    await assert.rejects(mem.updateTaskStatus('t1', 'running', 'scheduler', 'voltar'), /já terminou/);
    const events = await mem.listTaskEvents('t1');
    assert.deepEqual(events.map((e) => e.eventType), ['status-changed', 'status-changed', 'status-changed']);
    assert.match(events[2]!.message, /running → cancelled/);
  });

  test('aprovação só é decidida uma vez e atualiza a tarefa', async () => {
    await mem.createTask({
      id: 't2', projectId: 'abstrike', objective: 'docker', scope: 'infra/', status: 'awaiting-approval',
      primaryAgent: 'codex', reviewAgent: null, worktreePath: null, branch: null, baseRef: null,
      resultSummary: null, approvalState: 'none',
    });
    const a = await mem.requestApproval('t2', 'merge', 'agent/codex/t2 → main');
    assert.equal((await mem.getTask('t2'))?.approvalState, 'pending');
    assert.equal((await mem.listPendingApprovals()).length, 1);
    await mem.decideApproval(a.id, 'rejected');
    assert.equal((await mem.getTask('t2'))?.approvalState, 'rejected');
    await assert.rejects(mem.decideApproval(a.id, 'approved'), /já foi decidida/);
    assert.equal((await mem.listPendingApprovals()).length, 0);
  });

  test('recusa zerar banco que não é de teste', async () => {
    await assert.rejects(resetTestDb('postgres://night@localhost:5433/night'), /não é banco de teste/);
  });
});
