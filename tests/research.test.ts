import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import pg from 'pg';
import { QuotaError, researchPrompt } from '../src/agents/research.ts';
import { NightCoordinator } from '../src/app/coordinator.ts';
import { PgMemory } from '../src/memory/pg-memory.ts';
import { NightRouter, ruleIntent } from '../src/router/router.ts';
import { FakeLlm, FakeResearcher, resetTestDb, TEST_URL, truncateAll } from './helpers.ts';

describe('o que é pesquisa', () => {
  const kind = (t: string) => ruleIntent(t, ['Soaken'])?.kind ?? null;
  const yes = [
    'Pesquisa pra mim o preço do Kokoro TTS',
    'pesquisa sobre o Qwen 3',
    'Qual a cotação do dólar hoje?',
    'Quanto tá o bitcoin agora?',
    'Quais as últimas notícias sobre o Ollama?',
    'Search for the latest Ollama release',
    "What's the price of bitcoin right now?",
    'look up the weather forecast for São Paulo',
  ];
  const no = ['Tô cansado de estudar hoje', 'O que é uma API?', 'What is a git branch?', 'Bom dia, Night!', 'busca minhas ideias do Soaken'];
  for (const t of yes) test(`pesquisa: "${t}"`, () => assert.equal(kind(t), 'research'));
  for (const t of no) test(`não é pesquisa: "${t}"`, () => assert.notEqual(kind(t), 'research'));

  test('o prompt pede resposta falada, curta, com fonte e sem executar nada', () => {
    const p = researchPrompt('cotação do dólar', 'pt-BR');
    assert.match(p, /no máximo 4 frases/);
    assert.match(p, /nome do site/);
    assert.match(p, /Não execute comandos/);
    assert.match(researchPrompt('x', 'en'), /answer in English/);
  });
});

describe('pesquisa no coordenador', () => {
  let mem: PgMemory;
  const llm = new FakeLlm(() => 'conversa local');
  const night = (...r: FakeResearcher[]) => new NightCoordinator(mem, new NightRouter(llm, async () => []), llm, r);
  const routeLog = async () => {
    const c = new pg.Client({ connectionString: TEST_URL });
    await c.connect();
    const { rows } = await c.query('SELECT model, used_premium, reason FROM route_log ORDER BY at');
    await c.end();
    return rows;
  };

  before(async () => { await resetTestDb(); mem = await PgMemory.open(TEST_URL); });
  after(async () => { await mem?.close(); });
  beforeEach(async () => { await truncateAll(); llm.calls = []; });

  test('responde na hora e a pesquisa chega depois, pelo primeiro pesquisador', async () => {
    const codex = new FakeResearcher('codex:gpt-6-luna', 'O dólar fechou em 5 reais, segundo o Banco Central. 😊');
    const claude = new FakeResearcher('claude:haiku', 'não devia ser chamado');
    const r = await night(codex, claude).handle('Qual a cotação do dólar hoje?');
    assert.equal(r.text, 'Vou pesquisar isso, já te falo.');
    const later = await r.followUp!;
    assert.equal(later.text, 'O dólar fechou em 5 reais, segundo o Banco Central.');
    assert.equal(later.model, 'codex:gpt-6-luna');
    assert.equal(claude.questions.length, 0);
    assert.equal(llm.calls.length, 0, 'o modelo local não responde pesquisa');
    const [log] = await routeLog();
    assert.equal(log.model, 'codex:gpt-6-luna');
    assert.equal(log.used_premium, true);
  });

  test('Codex no limite: vai para o Claude', async () => {
    const codex = new FakeResearcher('codex:gpt-6-luna', new QuotaError('try again at 7:22 PM'));
    const claude = new FakeResearcher('claude:haiku', 'Resposta do Claude.');
    const later = await (await night(codex, claude).handle('pesquisa sobre o Qwen 3')).followUp!;
    assert.equal(later.text, 'Resposta do Claude.');
    assert.equal(later.model, 'claude:haiku');
  });

  test('os dois falham: diz que não conseguiu e não chuta', async () => {
    const r = await night(
      new FakeResearcher('codex:gpt-6-luna', new QuotaError('limite')),
      new FakeResearcher('claude:haiku', new Error('sem internet')),
    ).handle('Search for the latest Ollama release');
    assert.equal(r.text, "I'll look that up, back in a moment.");
    const later = await r.followUp!;
    assert.equal(later.text, "I couldn't look it up right now: Codex is at its usage limit and Claude failed. And I won't guess.");
    assert.equal(llm.calls.length, 0, 'não caiu para o modelo local inventar');
    const [log] = await routeLog();
    assert.equal(log.model, 'none');
    assert.equal(log.used_premium, false);
    assert.match(log.reason, /claude:haiku: sem internet/, 'o detalhe técnico fica no registro');
  });

  test('a pergunta entra uma vez só no histórico', async () => {
    const n = night(new FakeResearcher('codex:gpt-6-luna', 'Resposta.'));
    await (await n.handle('pesquisa sobre o Qwen 3')).followUp;
    await n.handle('e você, tudo bem?');
    const sent = llm.calls[0]!.messages.map((m) => m.content);
    assert.equal(sent.filter((c) => c === 'pesquisa sobre o Qwen 3').length, 1);
    assert.ok(sent.includes('Resposta.'));
  });
});

describe('continuação de pesquisa (uso real 04/11)', () => {
  let mem: PgMemory;
  before(async () => { await resetTestDb(); mem = await PgMemory.open(TEST_URL); });
  after(async () => { await mem?.close(); });
  beforeEach(async () => { await truncateAll(); });

  test('logo depois de uma pesquisa, "traz os comentários" volta para o Codex, não para a conversa', async () => {
    const llm = new FakeLlm(() => 'conversa');
    const codex = new FakeResearcher('codex:gpt-6-luna', 'resposta da pesquisa');
    const n = new NightCoordinator(mem, new NightRouter(llm, async () => []), llm, [codex]);
    await (await n.handle('pesquisa o que acharam do último episódio de Um Amor Diferente do Seu')).followUp;
    const r = await n.handle('é isso, mas me traz a opinião de cada comentário que o pessoal deixou');
    assert.equal(r.intent, 'research');
    await r.followUp;
    assert.equal(codex.questions.length, 2);
    assert.match(codex.contexts[1]!, /Um Amor Diferente do Seu/, 'leva a pesquisa anterior no contexto');
    const chat = await n.handle('valeu, tudo bem com você?');
    assert.equal(chat.intent, 'chat', 'conversa normal continua conversa');
  });
});
