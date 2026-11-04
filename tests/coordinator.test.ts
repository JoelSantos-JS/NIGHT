import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import pg from 'pg';
import { forSpeech, NightCoordinator } from '../src/app/coordinator.ts';
import type { Project } from '../src/core/types.ts';
import { PgMemory } from '../src/memory/pg-memory.ts';
import { NightRouter } from '../src/router/router.ts';
import { FakeLlm, resetTestDb, TEST_URL, truncateAll } from './helpers.ts';

const project = (id: string, name: string): Project => ({
  id, name, description: '', repoPath: `C:/repos/${id}`, defaultBranch: 'main', allowedPaths: [], status: 'active',
});

describe('forSpeech', () => {
  test('tira emoji e markdown, mantém acentos e pontuação', () => {
    assert.equal(forSpeech('Bom dia! 😊 Vamos **lá**.'), 'Bom dia! Vamos lá.');
    assert.equal(forSpeech('- item um\n- item dois 👍🏽'), 'item um\nitem dois');
    assert.equal(forSpeech('Use `git worktree` ❤️'), 'Use git worktree');
  });
});

describe('NightCoordinator', () => {
  let mem: PgMemory;
  let llm: FakeLlm;
  let night: NightCoordinator;

  before(async () => {
    await resetTestDb();
    mem = await PgMemory.open(TEST_URL);
  });
  after(async () => { await mem?.close(); });
  beforeEach(async () => {
    await truncateAll();
    await mem.upsertProject(project('abstrike', 'Abstrike'));
    await mem.upsertProject(project('soaken', 'Soaken'));
    llm = new FakeLlm(() => 'resposta do modelo local');
    night = new NightCoordinator(mem, new NightRouter(llm, async () => (await mem.listProjects()).map((p) => p.name)), llm);
  });

  test('teste 1 do blueprint: salva ideia do Abstrike e depois recupera', async () => {
    const r = await night.handle('Save an idea for Abstrike: alert when an exchange delays a deposit');
    assert.equal(r.text, 'Saved the idea under Abstrike.');
    assert.equal(r.language, 'en');
    const ideas = await mem.findIdeas({ projectId: 'abstrike' });
    assert.equal(ideas.length, 1);
    assert.equal(ideas[0]!.transcript, 'alert when an exchange delays a deposit');

    const back = await night.handle('Quais ideias eu tenho do Abstrike?');
    assert.match(back.text, /Uma ideia no Abstrike\. 1: alert when an exchange delays a deposit/);
    assert.equal(llm.calls.length, 0, 'nada disso precisou do modelo');
  });

  test('ideia sem texto: pergunta e salva a próxima fala', async () => {
    const ask = await night.handle('salva uma ideia para o Soaken');
    assert.equal(ask.text, 'Pode falar a ideia para o Soaken.');
    assert.equal((await mem.findIdeas({})).length, 0);
    const done = await night.handle('modo karaokê com as músicas do usuário');
    assert.equal(done.text, 'Salvei a ideia no Soaken.');
    assert.equal((await mem.findIdeas({ projectId: 'soaken' }))[0]!.transcript, 'modo karaokê com as músicas do usuário');
  });

  test('não diz "salvei" se o banco falhar', async () => {
    const broken = Object.create(mem) as PgMemory;
    broken.saveIdea = async () => { throw new Error('conexão caiu'); };
    const n = new NightCoordinator(broken, new NightRouter(llm, async () => ['Abstrike']), llm);
    const r = await n.handle('salva essa ideia: qualquer coisa');
    assert.match(r.text, /^Não salvei/);
  });

  test('conversa vai para o modelo local com instrução no idioma certo', async () => {
    const r = await night.handle('Me explica o que é uma closure');
    assert.equal(r.text, 'resposta do modelo local');
    assert.equal(r.intent, 'chat');
    assert.match(llm.calls[0]!.messages[0]!.content, /português do Brasil/);
  });

  test('lembrete do idioma vai no começo da fala, e o histórico guarda a fala original', async () => {
    await night.handle('Bom dia, Night');
    await night.handle('What is a git worktree?');
    const msgs = llm.calls[1]!.messages;
    assert.deepEqual(msgs.at(-1), { role: 'user', content: '(Reply in English.) What is a git worktree?' });
    assert.equal(msgs[1]!.content, 'Bom dia, Night');
  });

  test('a conversa leva o histórico', async () => {
    await night.handle('Meu nome é Joel');
    await night.handle('Qual é o meu nome?');
    const sent = llm.calls[1]!.messages.map((m) => m.content);
    assert.ok(sent.includes('Meu nome é Joel'));
    assert.ok(sent.includes('resposta do modelo local'));
  });

  test('teste 4 do blueprint: pedido de código vira tarefa, o modelo local não escreve código', async () => {
    const r = await night.handle('Pede pro Codex escrever um parser no Abstrike');
    assert.equal(r.intent, 'coding-task');
    assert.match(r.text, /Registrei a tarefa \w+ no Abstrike para o codex, mas quem executa tarefas é a outra janela/);
    const [task] = await mem.listTasks();
    assert.equal(task!.status, 'captured');
    assert.equal(task!.primaryAgent, 'codex');
    assert.equal(llm.calls.length, 0);
  });

  test('pedido de código sem projeto pergunta qual', async () => {
    const r = await night.handle('write a parser for trading signals');
    assert.match(r.text, /^Which project\? I have: Abstrike, Soaken\./);
    assert.equal((await mem.listTasks()).length, 0);
  });

  test('status vem do banco', async () => {
    assert.equal((await night.handle('o que tá rodando?')).text, 'Nenhuma tarefa aberta agora.');
    await night.handle('pede pro claude corrigir o bug do login no Soaken');
    assert.match((await night.handle('o que tá rodando?')).text, /^1 tarefa aberta: .*\(claude, captured\)/);
  });

  test('cancelar muda o status de verdade', async () => {
    await night.handle('pede pro claude corrigir o bug do login no Soaken');
    assert.equal((await night.handle('cancela a tarefa do Soaken')).text, 'Cancelei a tarefa.');
    assert.equal((await mem.listTasks())[0]!.status, 'cancelled');
    assert.equal((await night.handle('cancela a tarefa')).text, 'Não tem tarefa aberta para cancelar.');
  });

  test('"aprovo" sem nada pendente não aprova nada', async () => {
    assert.equal((await night.handle('aprovo o merge')).text, 'Não tem nada esperando aprovação.');
  });

  test('toda decisão do roteador fica registrada, sem cota premium', async () => {
    await night.handle('Bom dia');
    await night.handle('salva essa ideia: x');
    const c = new pg.Client({ connectionString: TEST_URL });
    await c.connect();
    const { rows } = await c.query('SELECT intent, model, used_premium FROM route_log ORDER BY at');
    await c.end();
    assert.deepEqual(rows, [
      { intent: 'chat', model: 'fake-local', used_premium: false },
      { intent: 'save-idea', model: 'rules', used_premium: false },
    ]);
  });
});
