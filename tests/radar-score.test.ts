import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { RUBRIC_VERSION, acimaDoCorte, scoreCandidate, type CriterioNome, type ScoreInput } from '../src/radar/score.ts';

test('corte único aceita 3+?+2+?+1 e recusa outro critério ausente', () => {
  const parcial = scoreCandidate({ anunciosAtivos: 90, anunciantesNoNicho: 4, entregavelEmPdf: true });
  assert.equal(parcial.version, 'triagem/2');
  assert.equal(parcial.justificativa.startsWith('3+?+2+?+1 = 6 (parcial, máx. 6).'), true);
  assert.equal(acimaDoCorte(parcial), true);
  assert.equal(acimaDoCorte(scoreCandidate({ anunciosAtivos: 90, entregavelEmPdf: true })), false);
});

const COMPLETO: ScoreInput = { anunciosAtivos: 94, diasNoAr: 41, anunciantesNoNicho: 5, precoOrigem: 97, entregavelEmPdf: true };

/** Pontos de um critério isolado; os outros ficam ausentes de propósito. */
function pontos(nome: CriterioNome, valor: number | boolean): number | null {
  const criterio = scoreCandidate({ [nome]: valor } as ScoreInput).criterios.find((c) => c.nome === nome);
  assert.ok(criterio, `critério ${nome} deveria existir`);
  return criterio.pontos;
}

describe('nota de triagem do Radar', () => {
  test('exemplo do PDF: 94, 41, 5, R$97, PDF = 10', () => {
    assert.deepEqual(scoreCandidate(COMPLETO), {
      version: 'triagem/2',
      nota: 10,
      maximoPossivel: 10,
      parcial: false,
      faltando: [],
      criterios: [
        { nome: 'anunciosAtivos', valor: 94, pontos: 3, maximo: 3 },
        { nome: 'diasNoAr', valor: 41, pontos: 2, maximo: 2 },
        { nome: 'anunciantesNoNicho', valor: 5, pontos: 2, maximo: 2 },
        { nome: 'precoOrigem', valor: 97, pontos: 2, maximo: 2 },
        { nome: 'entregavelEmPdf', valor: true, pontos: 1, maximo: 1 },
      ],
      justificativa:
        '3+2+2+2+1 = 10. 94 anúncios ativos da página, 41 dias no ar, 5 anunciantes no nicho, origem R$97, entregável em PDF.',
    });
    assert.equal(RUBRIC_VERSION, 'triagem/2');
  });

  test('bordas de anúncios ativos: 10/11, 30/31, 80/81', () => {
    assert.equal(pontos('anunciosAtivos', 0), 0);
    assert.equal(pontos('anunciosAtivos', 10), 0);
    assert.equal(pontos('anunciosAtivos', 11), 1);
    assert.equal(pontos('anunciosAtivos', 30), 1);
    assert.equal(pontos('anunciosAtivos', 31), 2);
    // O PDF repetia o 80 em "31-80 = 2 | 80+ = 3"; 80 fica em 2.
    assert.equal(pontos('anunciosAtivos', 80), 2);
    assert.equal(pontos('anunciosAtivos', 81), 3);
    assert.equal(pontos('anunciosAtivos', 500), 3);
  });

  test('bordas de dias no ar: 6/7 e 30/31', () => {
    assert.equal(pontos('diasNoAr', 0), 0);
    assert.equal(pontos('diasNoAr', 6), 0);
    assert.equal(pontos('diasNoAr', 7), 1);
    assert.equal(pontos('diasNoAr', 30), 1);
    assert.equal(pontos('diasNoAr', 31), 2);
  });

  test('bordas de anunciantes no nicho: 1, 2, 3, 4', () => {
    assert.equal(pontos('anunciantesNoNicho', 1), 0);
    assert.equal(pontos('anunciantesNoNicho', 2), 1);
    assert.equal(pontos('anunciantesNoNicho', 3), 1);
    assert.equal(pontos('anunciantesNoNicho', 4), 2);
  });

  test('bordas de preço: 36,99 / 37 / 67 / 67,01', () => {
    assert.equal(pontos('precoOrigem', 0.01), 0);
    assert.equal(pontos('precoOrigem', 36.99), 0);
    assert.equal(pontos('precoOrigem', 37), 1);
    assert.equal(pontos('precoOrigem', 67), 1);
    assert.equal(pontos('precoOrigem', 67.01), 2);
  });

  test('entregável em PDF só pontua quando true', () => {
    assert.equal(pontos('entregavelEmPdf', false), 0);
    assert.equal(pontos('entregavelEmPdf', true), 1);
  });

  test('ausente fica parcial, entra em faltando e não vira zero', () => {
    const r = scoreCandidate({ ...COMPLETO, diasNoAr: null });
    assert.equal(r.nota, 8);
    assert.equal(r.maximoPossivel, 8);
    assert.equal(r.parcial, true);
    assert.deepEqual(r.faltando, ['diasNoAr']);
    assert.deepEqual(r.criterios[1], { nome: 'diasNoAr', valor: null, pontos: null, maximo: 2 });
    assert.equal(
      r.justificativa,
      '3+?+2+2+1 = 8 (parcial, máx. 8). 94 anúncios ativos da página, dias no ar não visível, 5 anunciantes no nicho, origem R$97, entregável em PDF.',
    );
  });

  test('undefined conta como ausente, igual a null', () => {
    assert.deepEqual(scoreCandidate({}), {
      version: 'triagem/2',
      nota: 0,
      maximoPossivel: 0,
      parcial: true,
      faltando: ['anunciosAtivos', 'diasNoAr', 'anunciantesNoNicho', 'precoOrigem', 'entregavelEmPdf'],
      criterios: [
        { nome: 'anunciosAtivos', valor: null, pontos: null, maximo: 3 },
        { nome: 'diasNoAr', valor: null, pontos: null, maximo: 2 },
        { nome: 'anunciantesNoNicho', valor: null, pontos: null, maximo: 2 },
        { nome: 'precoOrigem', valor: null, pontos: null, maximo: 2 },
        { nome: 'entregavelEmPdf', valor: null, pontos: null, maximo: 1 },
      ],
      justificativa:
        '?+?+?+?+? = 0 (parcial, máx. 0). anúncios ativos da página não visível, dias no ar não visível, anunciantes no nicho não visível, origem não visível, entregável não visível.',
    });
    assert.deepEqual(scoreCandidate({}), scoreCandidate({ anunciosAtivos: null, diasNoAr: null, anunciantesNoNicho: null, precoOrigem: null, entregavelEmPdf: null }));
  });

  test('preço com centavos em formato brasileiro', () => {
    assert.ok(scoreCandidate({ ...COMPLETO, precoOrigem: 67.9 }).justificativa.includes('origem R$67,90'));
    assert.ok(scoreCandidate({ ...COMPLETO, precoOrigem: 67.01 }).justificativa.includes('origem R$67,01'));
  });

  test('entregável false aparece como "não entregável em PDF"', () => {
    const r = scoreCandidate({ ...COMPLETO, entregavelEmPdf: false });
    assert.equal(r.nota, 9);
    assert.equal(r.parcial, false);
    assert.ok(r.justificativa.endsWith(', não entregável em PDF.'));
  });

  test('valores inválidos lançam erro dizendo o critério', () => {
    const invalidos: [CriterioNome, unknown][] = [
      ['anunciosAtivos', -1],
      ['anunciosAtivos', 1.5],
      ['anunciosAtivos', NaN],
      ['anunciosAtivos', Infinity],
      ['diasNoAr', -1],
      ['diasNoAr', 2.5],
      ['diasNoAr', -Infinity],
      ['anunciantesNoNicho', 0],
      ['anunciantesNoNicho', -1],
      ['anunciantesNoNicho', 2.5],
      ['precoOrigem', 0],
      ['precoOrigem', -5],
      ['precoOrigem', NaN],
      ['precoOrigem', Infinity],
      ['entregavelEmPdf', 'sim'],
      ['entregavelEmPdf', 1],
    ];
    for (const [nome, valor] of invalidos) {
      assert.throws(
        () => scoreCandidate({ [nome]: valor } as unknown as ScoreInput),
        new RegExp(nome),
        `${nome} = ${String(valor)} deveria lançar`,
      );
    }
  });

  test('mesma entrada, mesma saída (sem data/hora)', () => {
    const entrada: ScoreInput = { ...COMPLETO, precoOrigem: 67.9 };
    assert.deepEqual(scoreCandidate(entrada), scoreCandidate({ ...entrada }));
  });
});
