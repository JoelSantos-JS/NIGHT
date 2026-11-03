import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { buildSharedContext, MAX_CONTEXT_CHARS } from '../src/agents/shared-context.ts';
import { NightCoordinator } from '../src/app/coordinator.ts';
import { PgMemory } from '../src/memory/pg-memory.ts';
import { NightRouter } from '../src/router/router.ts';
import { FakeLlm, FakeResearcher, resetTestDb, TEST_URL, truncateAll } from './helpers.ts';

describe('agentes sabem uns dos outros', () => {
  let mem: PgMemory;
  const llm = new FakeLlm(() => 'resposta do qwen');
  const names = async () => (await mem.listProjects()).map((p) => p.name);

  before(async () => { await resetTestDb(); mem = await PgMemory.open(TEST_URL); });
  after(async () => { await mem?.close(); });
  beforeEach(async () => {
    await truncateAll();
    llm.calls = [];
    await mem.upsertProject({ id: 'soaken', name: 'Soaken', description: '', repoPath: null, defaultBranch: null, allowedPaths: [], status: 'active' });
  });

  test('o Claude recebe o que o Codex respondeu, as tarefas abertas e quem ele é', async () => {
    const codex = new FakeResearcher('codex:gpt-6-luna', 'O Ollama 0.40.14 saiu hoje, segundo o GitHub.');
    const night1 = new NightCoordinator(mem, new NightRouter(llm, names), llm, [codex]);
    await (await night1.handle('Pesquisa pra mim a versão mais nova do Ollama')).followUp;
    await night1.handle('pede pro claude corrigir o bug do login no Soaken');

    const claude = new FakeResearcher('claude:haiku', 'Custa zero, é gratuito.');
    const night2 = new NightCoordinator(mem, new NightRouter(llm, names), llm, [claude]);
    await (await night2.handle('pesquisa quanto custa ele')).followUp;

    const ctx = claude.contexts[0]!;
    assert.match(ctx, /Você é claude:haiku, um dos agentes do Night\./);
    assert.match(ctx, /o Codex \(gpt-6-luna para pesquisa/);
    assert.match(ctx, /Joel: Pesquisa pra mim a versão mais nova do Ollama → codex:gpt-6-luna: O Ollama 0\.40\.14 saiu hoje/);
    assert.match(ctx, /Tarefas abertas:\n- \w+ \(claude, captured\): pede pro claude corrigir o bug do login no Soaken/);
  });

  test('Night reiniciado lembra da conversa, inclusive do que outro agente respondeu', async () => {
    const codex = new FakeResearcher('codex:gpt-6-luna', 'O dólar fechou em cinco reais.');
    await (await new NightCoordinator(mem, new NightRouter(llm, names), llm, [codex]).handle('Qual a cotação do dólar hoje?')).followUp;

    const restarted = new NightCoordinator(mem, new NightRouter(llm, names), llm, []);
    await restarted.handle('e isso é caro ou barato?');
    const sent = llm.calls[0]!.messages.map((m) => m.content);
    assert.ok(sent.includes('Qual a cotação do dólar hoje?'));
    assert.ok(sent.includes('O dólar fechou em cinco reais.'));
  });

  test('o contexto tem tamanho limitado e corta o mais antigo primeiro', async () => {
    const n = new NightCoordinator(mem, new NightRouter(llm, names), new FakeLlm(() => 'x'.repeat(400)), []);
    for (let i = 0; i < 12; i++) await n.handle(`pergunta número ${i} ${'y'.repeat(120)}`);
    const ctx = await buildSharedContext(mem, 'codex:gpt-6-luna', 'pt-BR');
    assert.ok(ctx.length <= MAX_CONTEXT_CHARS, `${ctx.length} caracteres`);
    assert.match(ctx, /pergunta número 11/);
    assert.doesNotMatch(ctx, /pergunta número 0 /);
  });
});
