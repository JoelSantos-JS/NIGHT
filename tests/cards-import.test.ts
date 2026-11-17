// Testes da importação de cartão validado para tarefa (S04), com banco de teste.
// Cartão inválido não entra na fila; reimportar o mesmo cartão não duplica.
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { CARD_VERSION, cardHash } from '../src/cards/card.ts';
import type { Card } from '../src/cards/card.ts';
import { cardReference, checkDiffAgainstCard, importCard } from '../src/cards/import.ts';
import type { ImportOptions } from '../src/cards/import.ts';
import { PgMemory } from '../src/memory/pg-memory.ts';
import type { Project } from '../src/core/types.ts';
import { resetTestDb, TEST_URL, truncateAll } from './helpers.ts';

const night: Project = {
  id: 'night', name: 'Night', description: 'assistente pessoal', repoPath: null,
  defaultBranch: 'main', allowedPaths: [], status: 'active',
};

const cartao: Card = {
  version: CARD_VERSION,
  id: 'NIGHT-12',
  titulo: 'Cartão de tarefa validável',
  objetivo: 'Validar o cartão antes de entrar na fila de código.',
  escopo: 'Código puro em src/cards.',
  foraDoEscopo: ['Banco de dados'],
  criteriosDePronto: ['Cartão inválido não entra na fila'],
  testes: ['npx tsc --noEmit'],
  arquivosPermitidos: ['src/cards/card.ts', 'tests/cards.test.ts'],
  riscos: [],
  revisao: 1,
};

const opcoes: ImportOptions = { projectId: 'night', primaryAgent: 'claude', reviewAgent: 'codex' };

describe('importação de cartão', () => {
  let mem: PgMemory;

  before(async () => {
    await resetTestDb(TEST_URL);
    mem = await PgMemory.open(TEST_URL);
  });
  after(async () => { await mem?.close(); });
  beforeEach(async () => {
    await truncateAll();
    await mem.upsertProject(night);
  });

  test('cartão inválido não cria tarefa e explica o que falta', async () => {
    const r = await importCard(mem, { ...cartao, criteriosDePronto: [] }, opcoes);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.mensagem, /Cartão inválido/);
    assert.match(r.mensagem, /critérios de pronto/);
    assert.deepEqual(r.errors.map((e) => e.campo), ['criteriosDePronto']);
    assert.equal((await mem.listTasks()).length, 0);
  });

  test('cartão válido vira tarefa em queued com objetivo, escopo e campos do cartão', async () => {
    const r = await importCard(mem, cartao, opcoes);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    const t = r.task;
    assert.equal(t.status, 'queued');
    assert.equal(t.projectId, 'night');
    assert.equal(t.primaryAgent, 'claude');
    assert.equal(t.reviewAgent, 'codex');
    assert.equal(t.cardId, 'NIGHT-12');
    assert.equal(t.cardRevision, 1);
    assert.equal(t.cardHash, cardHash(cartao));
    assert.match(t.objective, /Cartão de tarefa validável/);
    assert.match(t.objective, /Validar o cartão antes de entrar na fila/);
    assert.match(t.scope, /Escopo:\nCódigo puro em src\/cards\./);
    assert.match(t.scope, /Fora do escopo:\n- Banco de dados/);
    assert.match(t.scope, /Arquivos permitidos:\n- src\/cards\/card\.ts\n- tests\/cards\.test\.ts/);
    assert.match(t.scope, /Critérios de pronto:\n- Cartão inválido não entra na fila/);
    assert.match(t.scope, /Testes:\n- npx tsc --noEmit/);
    // O cartão fica gravado de verdade: é o que prova qual versão o agente recebeu.
    const salva = await mem.getTask(t.id);
    assert.equal(salva?.cardId, 'NIGHT-12');
    assert.equal(salva?.cardRevision, 1);
    assert.equal(salva?.cardHash, cardHash(cartao));
  });

  test('reimportar o mesmo cartão devolve a mesma tarefa, sem duplicar', async () => {
    const a = await importCard(mem, cartao, opcoes);
    const b = await importCard(mem, cartao, opcoes);
    assert.ok(a.ok && b.ok);
    if (!a.ok || !b.ok) return;
    assert.equal(b.task.id, a.task.id);
    assert.equal((await mem.listTasks()).length, 1);
  });

  test('duas importações simultâneas do mesmo cartão criam uma tarefa só', async () => {
    // Sem o índice único (migração 010), as duas leem "não existe" e cada uma cria a sua.
    const [a, b] = await Promise.all([importCard(mem, cartao, opcoes), importCard(mem, cartao, opcoes)]);
    assert.ok(a.ok && b.ok);
    if (!a.ok || !b.ok) return;
    assert.equal(a.task.id, b.task.id);
    assert.equal((await mem.listTasks({ projectId: 'night' })).length, 1);
  });

  test('mudar o conteúdo sem subir a revisão é recusado', async () => {
    await importCard(mem, cartao, opcoes);
    const r = await importCard(mem, { ...cartao, objetivo: 'Outro objetivo.' }, opcoes);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.mensagem, /mudou sem subir a revisão/);
    assert.equal((await mem.listTasks()).length, 1);
  });

  test('subir a revisão cria uma nova tarefa', async () => {
    const r1 = await importCard(mem, cartao, opcoes);
    const r2 = await importCard(mem, { ...cartao, revisao: 2, objetivo: 'Outro objetivo.' }, opcoes);
    assert.ok(r1.ok && r2.ok);
    if (!r1.ok || !r2.ok) return;
    assert.notEqual(r2.task.id, r1.task.id);
    assert.equal(r2.task.cardRevision, 2);
    const salvas = await mem.listTasks({ projectId: 'night' });
    assert.equal(salvas.length, 2);
    assert.deepEqual(salvas.map((t) => t.cardRevision).sort(), [1, 2]);
  });

  test('checkDiffAgainstCard acusa arquivo fora do escopo', () => {
    const r = checkDiffAgainstCard(cartao,
      ['src/cards/card.ts', 'tests/cards.test.ts', 'src/app/coordinator.ts', '.env']);
    assert.equal(r.ok, false);
    assert.deepEqual(r.foraDoCartao, ['src/app/coordinator.ts', '.env']);
    assert.deepEqual(checkDiffAgainstCard(cartao, ['src/cards/card.ts']), { ok: true, foraDoCartao: [] });
  });

  test('cardReference aponta o cartão de origem; tarefa sem cartão devolve null', async () => {
    const r = await importCard(mem, cartao, opcoes);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    const ref = cardReference(r.task);
    assert.match(ref!, /^cartão NIGHT-12 r1 \(hash [0-9a-f]{12}\)$/);
    assert.equal(ref, `cartão NIGHT-12 r1 (hash ${cardHash(cartao).slice(0, 12)})`);

    const semCartao = await mem.createTask({
      id: 't-sem-cartao', projectId: 'night', objective: 'pedido solto', scope: '', status: 'queued',
      primaryAgent: 'claude', reviewAgent: null, worktreePath: null, branch: null, baseRef: null,
      resultSummary: null, approvalState: 'none',
    });
    assert.equal(semCartao.cardId, null);
    assert.equal(semCartao.cardRevision, null);
    assert.equal(semCartao.cardHash, null);
    assert.equal(cardReference(semCartao), null);
  });
});
