// Etapa 1 do Radar: a pesquisa de nichos (src/radar/nichos.ts), sem rede nem banco.
// O que se prova aqui: a resposta do modelo é lida como dado (JSON puro, cerca ou frase antes);
// item sem nome/termo ou sem fonte é descartado com aviso; termo repetido entra uma vez; o
// limite é respeitado; o texto é aparado e cortado; e o planejador passa de agente a agente
// quando o primeiro está no limite de uso ou não traz nicho válido.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { QuotaError, type ResearchAgent } from '../src/agents/research.ts';
import { lerNichos, PlanejadorComPesquisa, promptNichos } from '../src/radar/nichos.ts';

/** Item mínimo válido; cada teste troca só o campo que quer derrubar. */
function item(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tipo: 'nicho',
    nome: 'Receitas fit',
    termo: 'receitas fit',
    motivo: 'Ofertas sendo anunciadas todos os dias',
    fontes: ['https://exemplo.com/a'],
    ...over,
  };
}

/** Resposta do modelo no formato pedido pelo prompt. */
function resposta(itens: unknown): string {
  return JSON.stringify({ itens });
}

type AgenteFalso = { id: string; perguntas: string[]; ask: ResearchAgent['ask'] };

/** Agente de pesquisa falso: devolve a resposta, ou lança o erro, e guarda as perguntas. */
function agente(id: string, comportamento: string | Error): AgenteFalso {
  const perguntas: string[] = [];
  const ask: ResearchAgent['ask'] = async (question) => {
    perguntas.push(question);
    if (comportamento instanceof Error) throw comportamento;
    return { answer: comportamento, ms: 1 };
  };
  return { id, perguntas, ask };
}

describe('leitura da pesquisa de nichos', () => {
  test('lê JSON puro, JSON em cerca markdown e JSON com frase antes', () => {
    const cerca = String.fromCharCode(96).repeat(3);
    const itens = [item()];
    const puro = resposta(itens);
    const casos: [string, string][] = [
      ['JSON puro', puro],
      ['cerca json', cerca + 'json\n' + puro + '\n' + cerca],
      ['frase antes', 'Aqui está: ' + puro],
    ];
    for (const [rotulo, texto] of casos) {
      const lido = lerNichos(texto, 10);
      assert.equal(lido.nichos.length, 1, rotulo);
      assert.deepEqual(lido.nichos[0], {
        tipo: 'nicho',
        nome: 'Receitas fit',
        termo: 'receitas fit',
        motivo: 'Ofertas sendo anunciadas todos os dias',
        fontes: ['https://exemplo.com/a'],
      }, rotulo);
      assert.deepEqual(lido.avisos, [], rotulo);
    }
  });

  test('item sem nome ou sem termo é descartado com aviso', () => {
    const lido = lerNichos(
      resposta([
        item({ nome: 'Sem termo', termo: '' }),
        item({ nome: '', termo: 'sem nome' }),
        item({ nome: 'Válido', termo: 'válido' }),
      ]),
      10,
    );
    assert.equal(lido.nichos.length, 1);
    assert.equal(lido.nichos[0]!.nome, 'Válido');
    assert.equal(lido.avisos.filter((a) => a.includes('item sem nome ou termo')).length, 2);
  });

  test('item sem fonte http(s) é descartado com aviso que cita o nome', () => {
    const lido = lerNichos(
      resposta([
        item({ nome: 'Sem fonte', termo: 'sem fonte', fontes: [] }),
        item({ nome: 'Fonte estranha', termo: 'fonte estranha', fontes: ['ftp://x', 'www.exemplo.com'] }),
        item({ nome: 'Com fonte', termo: 'com fonte' }),
      ]),
      10,
    );
    assert.equal(lido.nichos.length, 1);
    assert.equal(lido.nichos[0]!.nome, 'Com fonte');
    const semFonte = lido.avisos.filter((a) => a.includes('sem fonte'));
    assert.equal(semFonte.length, 2);
    assert.ok(semFonte.some((a) => a.includes('Sem fonte')));
    assert.ok(semFonte.some((a) => a.includes('Fonte estranha')));
  });

  test('termo repetido (maiúsculas diferentes) entra uma vez só', () => {
    const lido = lerNichos(
      resposta([
        item({ nome: 'Receitas Fit', termo: 'Receitas Fit' }),
        item({ nome: 'Outro nome', termo: 'receitas fit' }),
      ]),
      10,
    );
    assert.equal(lido.nichos.length, 1);
    assert.equal(lido.nichos[0]!.nome, 'Receitas Fit');
    assert.deepEqual(lido.avisos, []);
  });

  test('respeita o máximo pedido', () => {
    const lido = lerNichos(
      resposta([
        item({ nome: 'Um', termo: 'termo um' }),
        item({ nome: 'Dois', termo: 'termo dois' }),
        item({ nome: 'Três', termo: 'termo três' }),
      ]),
      2,
    );
    assert.equal(lido.nichos.length, 2);
    assert.deepEqual(lido.nichos.map((n) => n.termo), ['termo um', 'termo dois']);
  });

  test("tipo 'oferta' fica 'oferta'; qualquer outro vira 'nicho'", () => {
    const lido = lerNichos(
      resposta([
        item({ tipo: 'oferta', termo: 'oferta x' }),
        item({ tipo: 'nicho', termo: 'nicho y' }),
        item({ tipo: 'outra coisa', termo: 'outro z' }),
        item({ tipo: undefined, termo: 'sem tipo w' }),
      ]),
      10,
    );
    assert.deepEqual(lido.nichos.map((n) => n.tipo), ['oferta', 'nicho', 'nicho', 'nicho']);
  });

  test('texto é aparado, espaços múltiplos viram um, e nome/termo são cortados', () => {
    const longo = 'a'.repeat(130);
    const termoLongo = 'b'.repeat(70);
    const lido = lerNichos(
      resposta([
        item({
          nome: '  Receitas   fit  ',
          termo: '  receitas \n  fit  ',
          motivo: '  demanda   alta  ',
        }),
        item({ nome: longo, termo: termoLongo }),
      ]),
      10,
    );
    assert.equal(lido.nichos[0]!.nome, 'Receitas fit');
    assert.equal(lido.nichos[0]!.termo, 'receitas fit');
    assert.equal(lido.nichos[0]!.motivo, 'demanda alta');
    assert.equal(lido.nichos[1]!.nome.length, 120);
    assert.equal(lido.nichos[1]!.nome, longo.slice(0, 120));
    assert.equal(lido.nichos[1]!.termo.length, 60);
    assert.equal(lido.nichos[1]!.termo, termoLongo.slice(0, 60));
  });

  test('resposta sem JSON avisa; JSON sem "itens" avisa', () => {
    const semJson = lerNichos('Desculpe, não encontrei nada com fonte.', 10);
    assert.deepEqual(semJson.nichos, []);
    assert.ok(semJson.avisos[0]!.includes('não veio em JSON'));

    const semLista = lerNichos(JSON.stringify({ nichos: [] }), 10);
    assert.deepEqual(semLista.nichos, []);
    assert.ok(semLista.avisos[0]!.includes('não trouxe a lista'));
  });
});

describe('prompt da pesquisa de nichos', () => {
  test('cita o nicho, o "até 8" e pede SÓ JSON', () => {
    const p = promptNichos('receitas fit', 8);
    assert.ok(p.includes('receitas fit'));
    assert.ok(p.includes('até 8'));
    assert.match(p, /SÓ com JSON/);
    assert.ok(p.includes('"itens"'), 'mostra o formato esperado');
  });
});

describe('planejador que passa de agente a agente', () => {
  test('o primeiro com nicho válido é o autor; o segundo não é chamado', async () => {
    const primeiro = agente('codex:gpt-6-luna', resposta([item()]));
    const segundo = agente('claude:haiku', 'não devia ser chamado');
    const plano = await new PlanejadorComPesquisa([primeiro, segundo]).planejar('receitas fit', 5);
    assert.equal(plano.autor, 'codex:gpt-6-luna');
    assert.equal(plano.nichos.length, 1);
    assert.deepEqual(plano.avisos, []);
    assert.equal(primeiro.perguntas.length, 1);
    assert.ok(primeiro.perguntas[0]!.includes('receitas fit'));
    assert.equal(segundo.perguntas.length, 0);
  });

  test('o primeiro no limite de uso (QuotaError): usa o segundo e avisa', async () => {
    const primeiro = agente('codex:gpt-6-luna', new QuotaError('try again at 7:22 PM'));
    const segundo = agente('claude:haiku', resposta([item()]));
    const plano = await new PlanejadorComPesquisa([primeiro, segundo]).planejar('receitas fit', 5);
    assert.equal(plano.autor, 'claude:haiku');
    assert.equal(plano.nichos.length, 1);
    assert.ok(plano.avisos.some((a) => a.includes('codex:gpt-6-luna') && a.includes('no limite de uso')));
    assert.equal(segundo.perguntas.length, 1);
  });

  test('o primeiro sem nicho válido: passa ao segundo e o aviso cita o primeiro', async () => {
    const primeiro = agente(
      'codex:gpt-6-luna',
      resposta([item({ nome: 'Sem fonte', termo: 'sem fonte', fontes: [] })]),
    );
    const segundo = agente('claude:haiku', resposta([item()]));
    const plano = await new PlanejadorComPesquisa([primeiro, segundo]).planejar('receitas fit', 5);
    assert.equal(plano.autor, 'claude:haiku');
    assert.equal(plano.nichos.length, 1);
    assert.ok(plano.avisos.some((a) => a.includes('codex:gpt-6-luna') && a.includes('sem fonte')));
  });

  test('os dois falham: nichos [], autor "nenhum" e avisos com os dois', async () => {
    const primeiro = agente('codex:gpt-6-luna', new QuotaError('limite'));
    const segundo = agente('claude:haiku', new Error('sem internet'));
    const plano = await new PlanejadorComPesquisa([primeiro, segundo]).planejar('receitas fit', 5);
    assert.deepEqual(plano.nichos, []);
    assert.equal(plano.autor, 'nenhum');
    assert.equal(plano.avisos.length, 2);
    assert.ok(plano.avisos.some((a) => a.includes('codex:gpt-6-luna') && a.includes('no limite de uso')));
    assert.ok(plano.avisos.some((a) => a.includes('claude:haiku') && a.includes('sem internet')));
  });
});
