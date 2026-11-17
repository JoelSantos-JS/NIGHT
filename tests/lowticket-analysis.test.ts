import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  analyzeTest,
  suggestScaling,
  validateNumbers,
  type ScalingInput,
  type TestNumbers,
} from '../src/lowticket/analysis.ts';

/** Teste válido de referência; cada caso muda só o que precisa. */
const VALIDO: TestNumbers = {
  periodo: { de: '2026-11-01', ate: '2026-11-07' },
  gastoBRL: 200,
  impressoes: 2000,
  cliques: 40,
  visitasPagina: 20,
  checkoutsIniciados: 3,
  vendas: 2,
  precoBRL: 47,
};

/** Só o 'onde' do primeiro diagnóstico: é ele que a leitura conclui. */
function ondeDe(n: TestNumbers): string {
  return analyzeTest(n).diagnostico[0]!.onde;
}

describe('validateNumbers', () => {
  test('números coerentes não geram erro', () => {
    assert.deepEqual(validateNumbers(VALIDO), []);
  });

  test('junta todos os problemas de uma vez, em português', () => {
    const erros = validateNumbers({ ...VALIDO, gastoBRL: -10, cliques: 5000, vendas: 6000 });
    assert.equal(erros.length, 3);
    assert.match(erros[0]!, /gastoBRL não pode ser negativo/);
    assert.match(erros[1]!, /cliques \(5000\) não pode ser maior que impressões \(2000\)/);
    assert.match(erros[2]!, /vendas \(6000\) não pode ser maior que cliques \(5000\)/);
  });

  test('NaN e Infinity são recusados', () => {
    assert.match(validateNumbers({ ...VALIDO, gastoBRL: Number.NaN }).join('; '), /gastoBRL precisa ser um número válido/);
    assert.match(validateNumbers({ ...VALIDO, impressoes: Number.POSITIVE_INFINITY }).join('; '), /impressoes precisa ser um número válido/);
  });

  test('campos obrigatórios e preço zero', () => {
    const erros = validateNumbers({ periodo: VALIDO.periodo, gastoBRL: 10, impressoes: 100, cliques: 10, vendas: 1, precoBRL: 0 });
    assert.match(erros.join('; '), /precoBRL precisa ser maior que zero/);
    const faltando = validateNumbers({ periodo: VALIDO.periodo });
    assert.match(faltando.join('; '), /gastoBRL é obrigatório/);
    assert.match(faltando.join('; '), /vendas é obrigatório/);
  });

  test('datas do período precisam ser ISO e na ordem', () => {
    const invertidas = validateNumbers({ ...VALIDO, periodo: { de: '2026-11-07', ate: '2026-11-01' } });
    assert.match(invertidas.join('; '), /a data "de" vem depois da data "ate"/);
    const invalida = validateNumbers({ ...VALIDO, periodo: { de: '2026-13-45', ate: '2026-11-07' } });
    assert.match(invalida.join('; '), /periodo\.de precisa ser uma data ISO/);
  });

  test('checkouts não podem passar das visitas', () => {
    const erros = validateNumbers({ ...VALIDO, checkoutsIniciados: 30, visitasPagina: 20 });
    assert.match(erros.join('; '), /checkoutsIniciados \(30\) não pode ser maior que visitasPagina \(20\)/);
  });
});

describe('métricas do teste', () => {
  test('CTR, CPC, CPM, conversões, CPA e ROAS exatos', () => {
    const { metricas } = analyzeTest(VALIDO);
    assert.equal(metricas.ctr, 0.02);
    assert.equal(metricas.cpc, 5);
    assert.equal(metricas.cpm, 100);
    assert.equal(metricas.conversaoClique, 0.05);
    assert.equal(metricas.conversaoPagina, 0.1);
    assert.equal(metricas.cpa, 100);
    assert.equal(metricas.receitaBRL, 94);
    assert.equal(metricas.roas, 0.47);
  });

  test('sem visitas e sem vendas os campos ficam null, sem inventar número', () => {
    const { metricas } = analyzeTest({
      ...VALIDO, visitasPagina: null, checkoutsIniciados: null, vendas: 0,
    });
    assert.equal(metricas.conversaoPagina, null);
    assert.equal(metricas.cpa, null);
    assert.equal(metricas.roas, 0);
  });

  test('sem gasto o ROAS fica null em vez de Infinity', () => {
    const { metricas } = analyzeTest({ ...VALIDO, gastoBRL: 0 });
    assert.equal(metricas.roas, null);
  });
});

describe('diagnóstico do teste', () => {
  test('amostra pequena vem primeiro e não conclui mais nada', () => {
    // CTR de 0,5% e página ruim, mas com 400 impressões nada disso é conclusivo.
    const { diagnostico, resumoVoz } = analyzeTest({
      ...VALIDO, gastoBRL: 20, impressoes: 400, cliques: 2, visitasPagina: 1,
      checkoutsIniciados: null, vendas: 0,
    });
    assert.equal(diagnostico.length, 1);
    assert.equal(diagnostico[0]!.onde, 'amostra_pequena');
    assert.match(diagnostico[0]!.porque, /400 impressões e 2 cliques/);
    assert.match(resumoVoz, /amostra ainda é pequena/);
  });

  test('cliques abaixo de 30 também são amostra pequena', () => {
    assert.equal(ondeDe({ ...VALIDO, impressoes: 5000, cliques: 29, visitasPagina: 10, vendas: 0 }), 'amostra_pequena');
  });

  test('CTR abaixo do mínimo acusa o criativo antes da página', () => {
    // CTR 0,8% e conversão da página 0,5%: o tráfego ruim contamina a página, então o furo é o criativo.
    const { diagnostico } = analyzeTest({
      ...VALIDO, gastoBRL: 200, impressoes: 5000, cliques: 40, visitasPagina: 200, vendas: 1,
    });
    assert.equal(diagnostico.length, 1);
    assert.equal(diagnostico[0]!.onde, 'criativo');
    assert.match(diagnostico[0]!.porque, /CTR de 0,8% abaixo do mínimo de 1,0%/);
  });

  test('CTR bom com página fraca acusa a página', () => {
    const { diagnostico } = analyzeTest({
      ...VALIDO, gastoBRL: 500, impressoes: 5000, cliques: 200, visitasPagina: 100, vendas: 1,
    });
    assert.equal(diagnostico[0]!.onde, 'pagina');
    assert.match(diagnostico[0]!.porque, /1,0% das visitas viram venda/);
  });

  test('checkout cheio com poucas vendas acusa o checkout', () => {
    const { diagnostico } = analyzeTest({
      ...VALIDO, gastoBRL: 500, impressoes: 5000, cliques: 200, visitasPagina: 100,
      checkoutsIniciados: 20, vendas: 2,
    });
    assert.equal(diagnostico[0]!.onde, 'checkout');
    assert.match(diagnostico[0]!.porque, /20 checkouts iniciados e 2 venda/);
  });

  test('vende, mas CPA acima do preço, acusa preço ou oferta', () => {
    const { diagnostico } = analyzeTest({
      ...VALIDO, gastoBRL: 200, impressoes: 5000, cliques: 200, visitasPagina: 100,
      checkoutsIniciados: 5, vendas: 5, precoBRL: 20,
    });
    assert.equal(diagnostico[0]!.onde, 'preco_ou_oferta');
    assert.match(diagnostico[0]!.porque, /CPA de R\$ 40,00 acima do preço de R\$ 20,00/);
  });

  test('tudo dentro do mínimo fica sem furo óbvio', () => {
    const { diagnostico } = analyzeTest({
      ...VALIDO, gastoBRL: 100, impressoes: 5000, cliques: 200, visitasPagina: 100,
      checkoutsIniciados: 5, vendas: 5, precoBRL: 100,
    });
    assert.equal(diagnostico[0]!.onde, 'sem_furo_obvio');
  });

  test('limites podem ser ajustados por quem chama', () => {
    const n: TestNumbers = {
      ...VALIDO, gastoBRL: 100, impressoes: 5000, cliques: 75, visitasPagina: 100,
      checkoutsIniciados: null, vendas: 2, precoBRL: 200,
    };
    assert.equal(ondeDe(n), 'sem_furo_obvio');
    assert.equal(analyzeTest(n, { ctrMinimo: 0.02 }).diagnostico[0]!.onde, 'criativo');
  });

  test('a análise é hipótese marcada e usa formato brasileiro', () => {
    const { hipotese, resumoVoz, tela } = analyzeTest(VALIDO);
    assert.equal(hipotese, true);
    assert.match(resumoVoz, /^Hipótese:/);
    assert.match(resumoVoz, /R\$ \d+,\d{2}/);
    assert.match(tela, /Hipótese:/);
    assert.match(tela, /\d+,\d%/);
    // Ponto decimal só no número cru; dinheiro e porcentagem saem com vírgula.
    assert.doesNotMatch(resumoVoz, /R\$ \d+\.\d/);
    assert.doesNotMatch(tela, /R\$ \d+\.\d/);
  });

  test('números inválidos são recusados em vez de analisados', () => {
    assert.throws(() => analyzeTest({ ...VALIDO, vendas: 5000 }), /números do teste inválidos: vendas \(5000\)/);
  });
});

describe('suggestScaling', () => {
  const BASE: ScalingInput = {
    orcamentoDiarioAtualBRL: 20,
    ultimaMudancaISO: null,
    hojeISO: '2026-11-17',
    roas: 1.5,
    vendasUltimos3Dias: 5,
    cpaAtual: 15,
    precoBRL: 47,
  };

  test('com tudo no verde sobe 30%: 20 -> 26', () => {
    const r = suggestScaling(BASE);
    assert.equal(r.sugerir, true);
    assert.equal(r.novoOrcamentoBRL, 26);
    assert.match(r.motivo, /de R\$ 20,00 para R\$ 26,00/);
    assert.match(r.motivo, /nunca o dobro/);
    assert.match(r.motivo, /'spend'/);
    assert.match(r.motivo, /M08/);
  });

  test('não sugere com a última mudança há 2 dias', () => {
    const r = suggestScaling({ ...BASE, ultimaMudancaISO: '2026-11-15' });
    assert.equal(r.sugerir, false);
    assert.equal(r.novoOrcamentoBRL, null);
    assert.match(r.motivo, /última mudança há 2 dia/);
  });

  test('com 3 dias cheios desde a mudança já pode sugerir', () => {
    assert.equal(suggestScaling({ ...BASE, ultimaMudancaISO: '2026-11-14' }).novoOrcamentoBRL, 26);
  });

  test('não sugere com ROAS abaixo de 1 nem sem ROAS', () => {
    assert.equal(suggestScaling({ ...BASE, roas: 0.9 }).sugerir, false);
    assert.match(suggestScaling({ ...BASE, roas: 0.9 }).motivo, /ROAS 0,90 abaixo de 1/);
    assert.equal(suggestScaling({ ...BASE, roas: null }).sugerir, false);
  });

  test('não sugere com CPA acima do preço', () => {
    const r = suggestScaling({ ...BASE, cpaAtual: 50, precoBRL: 47 });
    assert.equal(r.sugerir, false);
    assert.match(r.motivo, /CPA de R\$ 50,00 acima do preço de R\$ 47,00/);
  });

  test('não sugere com menos de 3 vendas nos últimos 3 dias', () => {
    const r = suggestScaling({ ...BASE, vendasUltimos3Dias: 2 });
    assert.equal(r.sugerir, false);
    assert.match(r.motivo, /só 2 venda/);
  });

  test('nunca devolve o dobro, em nenhum orçamento', () => {
    for (const orcamento of [5, 10, 20, 33, 50, 97, 100, 250]) {
      const r = suggestScaling({ ...BASE, orcamentoDiarioAtualBRL: orcamento });
      assert.equal(r.sugerir, true, `orçamento ${orcamento} deveria sugerir`);
      assert.ok(r.novoOrcamentoBRL !== null);
      assert.ok(r.novoOrcamentoBRL < orcamento * 2, `orçamento ${orcamento} dobrou`);
      assert.equal(r.novoOrcamentoBRL, Math.round(orcamento * 1.3));
    }
  });

  test('orçamento de R$ 1 não vira R$ 2: arredondar não pode dobrar', () => {
    assert.equal(suggestScaling({ ...BASE, orcamentoDiarioAtualBRL: 1 }).sugerir, false);
  });

  test('data inválida falha cedo, em português', () => {
    assert.throws(
      () => suggestScaling({ ...BASE, ultimaMudancaISO: 'ontem' }),
      /data inválida em ultimaMudancaISO: ontem/,
    );
  });
});
