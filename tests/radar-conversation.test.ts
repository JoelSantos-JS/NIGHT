import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, test } from 'node:test';
import pg from 'pg';
import {
  applyOfferEdit, approveOffer, buildOfferContext, buildProposalContext, parsePriceToNumber, rejectOffer,
} from '../src/radar/conversation.ts';
import { radarWeekly } from '../src/radar/metrics.ts';
import { scoreCandidate } from '../src/radar/score.ts';
import { PgRadarStore } from '../src/radar/store.ts';
import { resetTestDb, TEST_URL, truncateAll } from './helpers.ts';

/** Proposta completa e válida; a evidência aponta para o candidato de verdade. */
function proposta(candidateId: string): Record<string, unknown> {
  return {
    version: 'oferta/1',
    nome: 'Rotina Enxuta',
    posicionamento: 'Guia curto de rotina para quem trabalha em casa',
    publico: 'Autônomos que trabalham de casa',
    problema: 'O dia termina sem foco',
    promessa: 'Montar uma rotina semanal em sete passos, com modelos para preencher',
    diferencial: 'Checklist próprio de uma página e exemplos reais',
    entregaveis: [
      { titulo: 'PDF 1', formato: 'pdf', descricao: 'Mapa da rotina' },
      { titulo: 'PDF 2', formato: 'pdf', descricao: 'Modelos de agenda' },
      { titulo: 'PDF 3', formato: 'pdf', descricao: 'Checklist semanal' },
      { titulo: 'PDF 4', formato: 'pdf', descricao: 'Plano de ajustes' },
    ],
    bonus: ['Modelo de agenda'],
    precoHipotese: {
      valor: 19.9, moeda: 'BRL', justificativa: 'Faixa de entrada do nicho, sem prova de venda', ehHipotese: true,
    },
    paginaDeVendas: ['promessa', 'problema', 'entregáveis', 'preço', 'dúvidas'],
    angulosCriativo: ['antes e depois', 'lista de erros', 'rotina real', 'pergunta direta', 'prova simples'],
    objecoes: [
      { objecao: 'Não tenho tempo', resposta: 'Os modelos levam minutos para preencher' },
      { objecao: 'Já tentei antes', resposta: 'O guia começa por um único hábito' },
      { objecao: 'Serve para mim?', resposta: 'Há exemplos para rotinas diferentes' },
    ],
    evidencias: [{ candidateId, oQueSustenta: 'Anúncio ativo há 40 dias no nicho' }],
    duvidas: ['A demanda pode ser sazonal', 'O preço pode ser alto para o público'],
    motivoParaDescartar: 'Se a rotina mudar, o guia perde utilidade',
    alternativas: [],
  };
}

describe('conversa com a oferta do Radar (R06)', () => {
  let store: PgRadarStore;

  before(async () => {
    await resetTestDb();
    store = await PgRadarStore.open(TEST_URL);
  });
  after(async () => { await store?.close(); });
  beforeEach(async () => { await truncateAll(); });

  async function criarOferta(score = { anunciosAtivos: 94, diasNoAr: 41, anunciantesNoNicho: 5, precoOrigem: 97, entregavelEmPdf: true }) {
    const { candidate } = await store.upsertCandidate({
      source: 'teste', externalId: `e-${randomUUID()}`, advertiser: 'Loja do Curso',
      country: 'BR', adUrl: 'https://ads.example/1', landingUrl: 'https://loja.example/oferta',
      raw: {
        externalId: 'e',
        anuncioTexto: 'Aprenda a organizar sua rotina com um método simples',
        landingResumo: 'Página de vendas do concorrente',
      },
      keywords: ['rotina'],
    });
    await store.setScore(candidate.id, scoreCandidate(score));
    const offer = await store.createOffer(candidate.id, proposta(candidate.id), [{ fonte: 'teste' }]);
    return { candidate, offer };
  }

  test('contexto traz versão, status, nota, fontes, bloco de dados, dúvidas e feedback', async () => {
    const { candidate } = await criarOferta();
    await store.addFeedback({ offerNumber: 1, offerVersion: 1, kind: 'objecao', text: 'preço alto' });

    const ctx = await buildOfferContext(store, 1);
    assert.match(ctx, /Oferta 1: versão atual 1 de 1 versão\(ões\); status rascunho/);
    assert.match(ctx, /Proposta:/);
    assert.match(ctx, /nome: Rotina Enxuta/);
    assert.match(ctx, new RegExp(candidate.id));
    assert.match(ctx, /Anúncio ativo há 40 dias no nicho/);
    assert.match(ctx, /<<<DADOS id=/);
    assert.match(ctx, /<<<FIM DADOS>>>/);
    assert.match(ctx, /texto do anúncio: Aprenda a organizar sua rotina/);
    assert.match(ctx, /resumo da landing: Página de vendas do concorrente/);
    assert.match(ctx, /Nota de triagem: 10/);
    assert.match(ctx, /Justificativa:/);
    assert.match(ctx, /Dúvidas:/);
    assert.match(ctx, /Motivo para descartar: Se a rotina mudar/);
    assert.match(ctx, /preço alto/);
  });

  test('corte tira as seções do fim e nunca parte um bloco de fonte', async () => {
    await criarOferta();
    await store.addFeedback({ offerNumber: 1, offerVersion: 1, kind: 'objecao', text: 'preço alto' });

    const cheio = await buildOfferContext(store, 1);
    const inicioFeedback = cheio.indexOf('Últimos feedbacks do Joel');
    assert.ok(inicioFeedback > 0, 'o feedback completo está no contexto cheio');

    const semFeedback = await buildOfferContext(store, 1, { maxChars: inicioFeedback - 1 });
    assert.ok(semFeedback.length <= inicioFeedback - 1);
    assert.ok(!semFeedback.includes('preço alto'), 'o feedback (fim) foi cortado primeiro');
    assert.equal((semFeedback.match(/<<<DADOS/g) ?? []).length, (semFeedback.match(/<<<FIM DADOS>>>/g) ?? []).length);

    const inicioFonte = cheio.indexOf('<<<DADOS');
    const semFonte = await buildOfferContext(store, 1, { maxChars: inicioFonte + 10 });
    assert.ok(!semFonte.includes('<<<DADOS'), 'bloco de fonte entra inteiro ou não entra');
    assert.ok(!semFonte.includes('<<<FIM DADOS>>>'));
  });

  test('edição cria versão 2, preserva a 1 e registra feedback de correção', async () => {
    const { offer } = await criarOferta();
    const ctx = await buildProposalContext(store, offer);

    const r = await applyOfferEdit(store, 1, { campo: 'publico', valor: 'Mães de primeira viagem' }, ctx);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.offer.version, 2);
    assert.equal(r.previousVersion, 1);

    const v1 = await store.getOffer(1, 1);
    const v2 = await store.getOffer(1);
    assert.equal((v1?.proposal as Record<string, unknown>).publico, 'Autônomos que trabalham de casa');
    assert.equal((v2?.proposal as Record<string, unknown>).publico, 'Mães de primeira viagem');
    assert.deepEqual((await store.listOfferVersions(1)).map((o) => o.version), [1, 2]);

    const [feedback] = await store.listFeedback(1);
    assert.equal(feedback!.kind, 'correcao');
    assert.equal(feedback!.resultingVersion, 2);
  });

  test('edição inválida não grava versão nem feedback', async () => {
    const { offer } = await criarOferta();
    const ctx = await buildProposalContext(store, offer);

    const r = await applyOfferEdit(store, 1, { campo: 'promessa', valor: 'Renda garantida de R$ 10 mil por mês' }, ctx);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.ok(r.errors.some((e) => e.campo === 'promessa'), JSON.stringify(r.errors));
    assert.equal((await store.listOfferVersions(1)).length, 1);
    assert.equal((await store.listFeedback(1)).length, 0);
  });

  test('preço aceita "R$ 47" e "47,90" e continua hipótese', async () => {
    for (const [entrada, esperado] of [['R$ 47', 47], ['47,90', 47.9], ['1.234,56', 1234.56]] as const) {
      assert.equal(parsePriceToNumber(entrada), esperado, entrada);
    }
    assert.equal(parsePriceToNumber('abacaxi'), null);

    const { offer } = await criarOferta();
    const ctx = await buildProposalContext(store, offer);
    const r = await applyOfferEdit(store, 1, { campo: 'precoHipotese', valor: 'R$ 47' }, ctx);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    const preco = (await store.getOffer(1))!.proposal.precoHipotese as Record<string, unknown>;
    assert.equal(preco.valor, 47);
    assert.equal(preco.ehHipotese, true);
    assert.equal(preco.moeda, 'BRL');
  });

  test('aprovação congela a versão e diz que não autoriza gasto', async () => {
    await criarOferta();
    const r = await approveOffer(store, 1);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.text, 'Oferta 1 versão 1 aprovada como briefing. Isso não autoriza campanha, compra nem gasto.');
    assert.equal((await store.getOffer(1))?.status, 'aprovada');
    assert.equal((await store.getOffer(1, 1))?.status, 'aprovada');
    const [feedback] = await store.listFeedback(1);
    assert.equal(feedback!.kind, 'aprovacao');
  });

  test('rejeição congela a versão sem publicar nem gastar', async () => {
    await criarOferta();
    const r = await rejectOffer(store, 1);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.match(r.text, /rejeitada\. Nada foi publicado nem gasto\./);
    assert.equal((await store.getOffer(1))?.status, 'rejeitada');
    assert.equal((await store.listFeedback(1))[0]!.kind, 'rejeicao');
  });

  test('oferta inexistente devolve not-found, sem gravar nada', async () => {
    assert.deepEqual(await approveOffer(store, 9), { ok: false, reason: 'not-found' });
    assert.deepEqual(await rejectOffer(store, 9), { ok: false, reason: 'not-found' });
  });
});

describe('métricas semanais do Radar (R08)', () => {
  let store: PgRadarStore;

  before(async () => {
    await resetTestDb();
    store = await PgRadarStore.open(TEST_URL);
  });
  after(async () => { await store?.close(); });
  beforeEach(async () => { await truncateAll(); });

  async function sql(query: string, params: unknown[] = []): Promise<void> {
    const client = new pg.Client({ connectionString: TEST_URL });
    await client.connect();
    try { await client.query(query, params); } finally { await client.end(); }
  }

  async function candidato(
    externalId: string, firstSeen: string, lastSeen: string,
    opts: { unknown?: string[]; score?: ReturnType<typeof scoreCandidate> } = {},
  ): Promise<string> {
    const { candidate } = await store.upsertCandidate({
      source: 'teste', externalId, advertiser: 'Loja', raw: { externalId },
      unknownFields: opts.unknown ?? [],
    });
    if (opts.score) await store.setScore(candidate.id, opts.score);
    await sql('UPDATE radar_candidates SET first_seen_at = $2, last_seen_at = $3 WHERE id = $1',
      [candidate.id, firstSeen, lastSeen]);
    return candidate.id;
  }

  test('conta a janela e compara com a anterior, sem chamar anúncio de venda', async () => {
    const nota8 = scoreCandidate({ anunciosAtivos: 40, diasNoAr: 40, anunciantesNoNicho: 5, precoOrigem: 50, entregavelEmPdf: true });
    const nota5 = scoreCandidate({ anunciosAtivos: 5, diasNoAr: 40, anunciantesNoNicho: 2, precoOrigem: 97, entregavelEmPdf: false });
    const nota9 = scoreCandidate({ anunciosAtivos: 40, diasNoAr: 40, anunciantesNoNicho: 5, precoOrigem: 97, entregavelEmPdf: true });

    const novo = await candidato('novo', '2026-11-10T12:00:00Z', '2026-11-12T12:00:00Z', { unknown: ['advertiser'], score: nota8 });
    await candidato('duplicado', '2026-11-01T12:00:00Z', '2026-11-11T12:00:00Z', { score: nota5 });
    await candidato('anterior', '2026-11-04T12:00:00Z', '2026-11-06T12:00:00Z', { score: nota9 });

    const oferta1 = await store.createOffer(novo, proposta(novo), []);
    await sql('UPDATE radar_offers SET created_at = $2 WHERE id = $1', [oferta1.id, '2026-11-11T10:00:00Z']);
    const f1 = await store.addFeedback({ offerNumber: 1, offerVersion: 1, kind: 'objecao', text: 'preço alto' });
    await sql('UPDATE radar_feedback SET at = $2 WHERE id = $1', [f1.id, '2026-11-12T10:00:00Z']);
    const f2 = await store.addFeedback({ offerNumber: 1, offerVersion: 1, kind: 'aprovacao', text: 'aprovada' });
    await sql('UPDATE radar_feedback SET at = $2 WHERE id = $1', [f2.id, '2026-11-13T10:00:00Z']);

    const oferta2 = await store.createOffer(null, proposta('cand-2'), []);
    await sql('UPDATE radar_offers SET created_at = $2 WHERE id = $1', [oferta2.id, '2026-11-14T10:00:00Z']);
    const f3 = await store.addFeedback({ offerNumber: 2, offerVersion: 1, kind: 'rejeicao', text: 'rejeitada' });
    await sql('UPDATE radar_feedback SET at = $2 WHERE id = $1', [f3.id, '2026-11-15T10:00:00Z']);

    const oferta3 = await store.createOffer(null, proposta('cand-3'), []);
    await sql('UPDATE radar_offers SET created_at = $2 WHERE id = $1', [oferta3.id, '2026-11-05T10:00:00Z']);
    const f4 = await store.addFeedback({ offerNumber: 3, offerVersion: 1, kind: 'aprovacao', text: 'aprovada antes' });
    await sql('UPDATE radar_feedback SET at = $2 WHERE id = $1', [f4.id, '2026-11-06T10:00:00Z']);

    const semana = await radarWeekly(store, { from: '2026-11-10T00:00:00Z', to: '2026-11-17T00:00:00Z' });
    assert.equal(semana.candidatosVistos, 2);
    assert.equal(semana.novos, 1);
    assert.equal(semana.duplicados, 1);
    assert.equal(semana.incompletos, 1);
    assert.equal(semana.acimaDoCorte, 1);
    assert.equal(semana.propostasCriadas, 2);
    assert.equal(semana.discutidas, 2);
    assert.equal(semana.aceitas, 1);
    assert.equal(semana.rejeitadas, 1);

    assert.equal(semana.anterior.candidatosVistos, 1);
    assert.equal(semana.anterior.novos, 1);
    assert.equal(semana.anterior.propostasCriadas, 1);
    assert.equal(semana.anterior.aceitas, 1);

    assert.match(semana.texto, /Radar 2026-11-10 a 2026-11-17/);
    assert.match(semana.texto, /2 candidato\(s\) visto\(s\)/);
    assert.match(semana.texto, /Comparado à janela anterior/);
    assert.match(semana.texto, /não prova de venda/);
  });

  test('janela inválida é recusada', async () => {
    await assert.rejects(() => radarWeekly(store, { from: '2026-11-17', to: '2026-11-10' }), /to precisa ser depois de from/);
  });
});
