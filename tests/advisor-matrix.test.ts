// Matriz D01 sem banco e sem internet: confere a declaração dos pontos e a regra de consulta.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  DECISION_POINTS,
  SKIPPED,
  getDecisionPoint,
  shouldConsult,
  validateDecisionPoints,
} from '../src/advisor/matrix.ts';

/** Ids que o plano e os itens D05–D07 exigem. */
const IDS_ESPERADOS = [
  'geral.pedido-complexo',
  'codigo.cartao',
  'codigo.plano',
  'codigo.diff-final',
  'radar.evidencia',
  'radar.oferta-original',
  'lowticket.produto',
  'video.roteiro',
  'video.antes-do-render',
  'geral.divergencia',
];

/** Prefixos de id que pertencem a outro domínio (o produto low-ticket vive no Radar). */
const DOMINIO_DO_PREFIXO: Record<string, string> = { lowticket: 'radar' };

describe('matriz de decisões do DeepSeek', () => {
  test('todo ponto tem pergunta, entrada e motivo, com limite positivo', () => {
    for (const point of DECISION_POINTS) {
      assert.ok(point.pergunta.trim().length > 0, `${point.id}: pergunta vazia`);
      assert.ok(point.entrada.trim().length > 0, `${point.id}: entrada vazia`);
      assert.ok(point.motivo.trim().length > 0, `${point.id}: motivo vazio`);
      assert.ok(point.fase.trim().length > 0, `${point.id}: fase vazia`);
      assert.ok(
        Number.isInteger(point.limite.maxChamadas) && point.limite.maxChamadas >= 1,
        `${point.id}: maxChamadas inválido`,
      );
      assert.ok(point.limite.timeoutMs > 0, `${point.id}: timeoutMs inválido`);
    }
  });

  test('ids são únicos e os previstos existem', () => {
    const ids = DECISION_POINTS.map((point) => point.id);
    assert.equal(new Set(ids).size, ids.length, 'há id repetido');
    for (const id of IDS_ESPERADOS) {
      const point = getDecisionPoint(id);
      assert.ok(point, `faltou o ponto ${id}`);
      // O prefixo do id tem de bater com o domínio, senão o agrupamento mente.
      const prefixo = id.slice(0, id.indexOf('.'));
      const dominioEsperado = DOMINIO_DO_PREFIXO[prefixo] ?? prefixo;
      assert.equal(point.dominio, dominioEsperado, `${id}: domínio não confere`);
    }
  });

  test('produto low-ticket pertence ao Radar e usa o modelo rápido', () => {
    const point = getDecisionPoint('lowticket.produto');
    assert.ok(point, 'faltou o ponto lowticket.produto');
    assert.equal(point.dominio, 'radar');
    assert.equal(point.fase, 'produto');
    assert.equal(point.impacto, 'medio');
    assert.equal(point.limite.modelo, 'deepseek-flash');
    assert.equal(point.limite.maxChamadas, 1);
    assert.match(point.pergunta, /promessa/);
  });

  test('modelo forte só em impacto alto, e o motivo explica', () => {
    for (const point of DECISION_POINTS) {
      if (point.impacto !== 'alto') assert.equal(point.limite.modelo, 'deepseek-flash', `${point.id}: flash esperado`);
      if (point.limite.modelo === 'deepseek-v4-pro') assert.match(point.motivo, /deepseek-v4-pro/, `${point.id}: motivo sem o modelo`);
    }
    assert.ok(
      DECISION_POINTS.some((point) => point.impacto === 'alto'),
      'a matriz precisa de ao menos um ponto de impacto alto',
    );
    assert.ok(
      DECISION_POINTS.some((point) => point.impacto === 'baixo'),
      'a matriz precisa de ao menos um ponto de impacto baixo',
    );
  });

  test('id desconhecido não consulta às cegas', () => {
    const result = shouldConsult('codigo.nao-existe', {});
    assert.equal(result.consultar, false);
    assert.equal(result.point, null);
    assert.equal(result.motivo, 'ponto de decisão não cadastrado');
    assert.equal(getDecisionPoint('codigo.nao-existe'), null);
  });

  test('caso simples em ponto de impacto baixo não consulta', () => {
    const baixo = DECISION_POINTS.find((point) => point.impacto === 'baixo');
    assert.ok(baixo, 'faltou ponto de impacto baixo para o caso simples');
    const result = shouldConsult(baixo.id, { simples: true });
    assert.equal(result.consultar, false);
    assert.equal(result.point?.id, baixo.id);
    assert.ok(result.motivo.trim().length > 0);

    // Sem "simples", o mesmo ponto consulta.
    assert.equal(shouldConsult(baixo.id, {}).consultar, true);
  });

  test('impacto informado maior que o do ponto sobe a consulta', () => {
    const medio = DECISION_POINTS.find((point) => point.impacto === 'medio');
    assert.ok(medio, 'faltou ponto de impacto médio');
    const result = shouldConsult(medio.id, { impacto: 'alto', simples: true });
    assert.equal(result.consultar, true);
    assert.equal(result.point?.id, medio.id);
  });

  test('validação na carga recusa id repetido e limite não positivo', () => {
    const base = DECISION_POINTS[0];
    assert.ok(base, 'a matriz não pode estar vazia');

    assert.throws(() => validateDecisionPoints([base, { ...base }]), /repetido/);
    assert.throws(
      () => validateDecisionPoints([{ ...base, limite: { ...base.limite, maxChamadas: 0 } }]),
      /maxChamadas/,
    );
    assert.throws(
      () => validateDecisionPoints([{ ...base, limite: { ...base.limite, timeoutMs: -1 } }]),
      /timeoutMs/,
    );
    // A matriz real passa na própria validação chamada ao carregar o módulo.
    assert.doesNotThrow(() => validateDecisionPoints(DECISION_POINTS));
  });

  test('casos dispensados têm caso e motivo documentados', () => {
    assert.ok(SKIPPED.length > 0, 'SKIPPED não pode ficar vazio');
    for (const item of SKIPPED) {
      assert.ok(item.caso.trim().length > 0, 'caso dispensado sem descrição');
      assert.ok(item.motivo.trim().length > 0, `"${item.caso}" sem motivo: não dá para registrar a dispensa`);
    }
  });
});
