import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { detectLanguage, ideaBody, NightRouter, ruleIntent } from '../src/router/router.ts';
import { FakeLlm } from './helpers.ts';

const PROJECTS = ['Abstrike', 'Soaken', 'Night'];
const kind = (text: string) => ruleIntent(text, PROJECTS)?.kind ?? null;

describe('regras do roteador', () => {
  const cases: [string, string | null][] = [
    // salvar ideia
    ['Salva essa ideia para o Abstrike: avisar quando o depósito atrasar', 'save-idea'],
    ['salve uma ideia', 'save-idea'],
    ['anota essa ideia pro Soaken, modo karaokê', 'save-idea'],
    ['Hey Night, save this idea for Abstrike: exchange delay alerts', 'save-idea'],
    ['new idea: a k-drama page', 'save-idea'],
    // buscar ideias
    ['Quais ideias eu tenho do Abstrike?', 'find-ideas'],
    ['me mostra as minhas ideias', 'find-ideas'],
    ['show me my ideas for Soaken', 'find-ideas'],
    // status
    ['O que você está fazendo?', 'status'],
    ['o que tá rodando', 'status'],
    ["What's running?", 'status'],
    ['How is my trading bot task going?', 'status'],
    // código
    ['Pede pro Claude implementar o parser de sinais no Abstrike', 'coding-task'],
    ['Ask Codex to review the branch', 'coding-task'],
    ['Write a parser in my project', 'coding-task'],
    ['corrige o bug do login no Soaken', 'coding-task'],
    // controle
    ['Para de falar', 'stop-speaking'],
    ['stop talking', 'stop-speaking'],
    ['Cancela a tarefa do Abstrike', 'cancel'],
    ['Stop the trading bot research task', 'cancel'],
    ['para todos os agentes', 'cancel'],
    ['Aprovo o merge', 'approval'],
    ['Reject it', 'approval'],
    ['Descarta', 'approval'],
    // conversa (nenhuma regra)
    ['Me explica o que é uma closure em JavaScript', null],
    ['Bom dia, Night!', null],
    ['What is a git branch?', null],
    ['Qual a diferença entre TCP e UDP?', null],
    ['What is a git branch?', null],
    ['o que é um merge?', null],
  ];
  for (const [text, expected] of cases) {
    test(`"${text}" → ${expected ?? 'sem regra'}`, () => assert.equal(kind(text), expected));
  }

  test('acha o projeto e o agente', () => {
    const i = ruleIntent('Pede pro Codex criar o Dockerfile do abstrike', PROJECTS);
    assert.deepEqual(i, { kind: 'coding-task', projectHint: 'Abstrike', objective: 'Pede pro Codex criar o Dockerfile do abstrike', agent: 'codex' });
  });

  test('separa a ideia do comando', () => {
    assert.equal(ideaBody('Salva essa ideia para o Abstrike: avisar quando o depósito atrasar', 'Abstrike'), 'avisar quando o depósito atrasar');
    assert.equal(ideaBody('save this idea for Abstrike: exchange delay alerts', 'Abstrike'), 'exchange delay alerts');
    assert.equal(ideaBody('salva uma ideia para o projeto Soaken', 'Soaken'), '');
    assert.equal(ideaBody('salva essa ideia que dá pra vender curso de coreano', null), 'dá pra vender curso de coreano');
  });

  test('"cancela" dentro de uma ideia não cancela nada', () => {
    assert.equal(kind('salva essa ideia: botão para cancelar tarefa pelo celular'), 'save-idea');
  });
});

describe('idioma', () => {
  test('português', () => {
    assert.equal(detectLanguage('o que você está fazendo?'), 'pt-BR');
    assert.equal(detectLanguage('salva essa ideia'), 'pt-BR');
  });
  test('inglês', () => {
    assert.equal(detectLanguage("what's running right now?"), 'en');
    assert.equal(detectLanguage('save this idea for Abstrike'), 'en');
  });
  test('sem pista fica em português', () => assert.equal(detectLanguage('Abstrike'), 'pt-BR'));
  test('"tô" é português, não "to"', () => {
    assert.equal(detectLanguage('Tô cansado de estudar hoje'), 'pt-BR');
    assert.equal(detectLanguage('tô com fome'), 'pt-BR');
  });
  test('inglês com "I" e "it"', () => assert.equal(detectLanguage("I think it works"), 'en'));
});

describe('NightRouter com modelo', () => {
  const names = async () => PROJECTS;

  test('regra resolve sem chamar o modelo', async () => {
    const llm = new FakeLlm();
    const d = await new NightRouter(llm, names).route('salva essa ideia: teste', 'pt-BR');
    assert.equal(d.intent.kind, 'save-idea');
    assert.equal(d.model, 'rules');
    assert.equal(llm.calls.length, 0);
  });

  test('pergunta sobre git não vira comando', async () => {
    const llm = new FakeLlm(() => '{"intent":"status"}');
    const d = await new NightRouter(llm, names).route('What is a git branch?', 'en');
    assert.equal(d.intent.kind, 'chat');
    assert.equal(llm.calls.length, 0);
  });

  test('conversa comum vai direto, sem classificar', async () => {
    const llm = new FakeLlm();
    const d = await new NightRouter(llm, names).route('Me explica o que é uma closure', 'pt-BR');
    assert.equal(d.intent.kind, 'chat');
    assert.equal(llm.calls.length, 0);
    assert.equal(d.usedPremiumQuota, false);
  });

  test('frase ambígua com cara de comando é classificada pelo modelo', async () => {
    const llm = new FakeLlm(() => '{"intent":"save-idea","text":"monitorar reclamações"}');
    const d = await new NightRouter(llm, names).route('tive um pensamento pro Abstrike, monitorar reclamações', 'pt-BR');
    assert.deepEqual(d.intent, { kind: 'save-idea', projectHint: 'Abstrike', text: 'monitorar reclamações' });
    assert.equal(llm.calls[0]!.json, true);
  });

  test('limpa diretiva do Qwen que vaza no texto', async () => {
    const llm = new FakeLlm(() => '{"intent":"save-idea","text":"modo karaokê /no_think"}');
    const d = await new NightRouter(llm, names).route('tive um pensamento pro Soaken, um modo karaokê', 'pt-BR');
    assert.equal(d.intent.kind === 'save-idea' && d.intent.text, 'modo karaokê');
  });

  test('o modelo não consegue aprovar nem cancelar', async () => {
    for (const evil of ['{"intent":"approval"}', '{"intent":"cancel"}', '{"intent":"merge"}']) {
      const d = await new NightRouter(new FakeLlm(() => evil), names).route('e aquela tarefa do Abstrike, hein', 'pt-BR');
      assert.equal(d.intent.kind, 'chat', evil);
    }
  });

  test('JSON quebrado ou erro do modelo vira conversa', async () => {
    for (const llm of [new FakeLlm(() => 'não é json'), new FakeLlm(() => { throw new Error('caiu'); })]) {
      const d = await new NightRouter(llm, names).route('e o projeto Soaken?', 'pt-BR');
      assert.equal(d.intent.kind, 'chat');
    }
  });
});
