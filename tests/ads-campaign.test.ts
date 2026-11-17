// Campanha na Meta (M03, M04, M06) com MCP falso e banco de teste. O que se prova: nada nasce ativo,
// o orçamento é só o aprovado (com teto), retomar não cria duas vezes, erro para sem repetir e o
// NIGHT acusa qualquer coisa que a Meta devolva fora de PAUSED.

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import {
  buildCampaignDraft, buildPausedCampaign, describeDraft, draftPendencias, ORCAMENTO_DIARIO_MAXIMO_BRL,
  parseDailyBudget, type MetaAdsWriter,
} from '../src/ads/campaign.ts';
import { PgMemory } from '../src/memory/pg-memory.ts';
import { PROPOSAL_VERSION, type OfferProposal } from '../src/radar/offer.ts';
import { resetTestDb, TEST_URL, truncateAll } from './helpers.ts';

const offer: OfferProposal = {
  version: PROPOSAL_VERSION,
  nome: 'Rotina Enxuta',
  posicionamento: 'Guia curto de rotina para quem trabalha em casa',
  publico: 'Autônomos que trabalham de casa',
  problema: 'O dia termina sem foco.',
  promessa: 'Monte uma rotina semanal em sete passos.',
  diferencial: 'Checklist de uma página',
  entregaveis: [1, 2, 3, 4].map((n) => ({ titulo: `PDF ${n}`, formato: 'pdf' as const, descricao: `parte ${n}` })),
  bonus: ['Modelo de agenda'],
  precoHipotese: { valor: 19.9, moeda: 'BRL', justificativa: 'entrada', ehHipotese: true },
  paginaDeVendas: ['promessa', 'problema', 'entregáveis', 'preço', 'dúvidas'],
  angulosCriativo: ['Antes e depois da semana', 'Três erros de quem trabalha em casa', 'Rotina real', 'Pergunta direta', 'Prova simples'],
  objecoes: [],
  evidencias: [],
  duvidas: [],
  motivoParaDescartar: 'pode ser sazonal',
  alternativas: [],
};

const IMG = 'https://exemplo.com/img.png';
const PAGINA = 'https://exemplo.com/rotina';

/** MCP falso: registra cada chamada e pode falhar ou devolver status diferente de PAUSED. */
class FakeWriter implements MetaAdsWriter {
  calls: string[] = [];
  existentes = new Map<string, string>();
  status = new Map<string, string>();
  falharEm: string | null = null;
  private n = 0;
  private novo(tipo: string) {
    if (this.falharEm === tipo) throw new Error(`Meta recusou ${tipo} (simulado)`);
    const id = `${tipo}-${++this.n}`;
    this.status.set(id, 'PAUSED');
    return { id };
  }
  async findCampaignByName(_conta: string, nome: string) {
    this.calls.push('find');
    const id = this.existentes.get(nome);
    return id ? { id, status: 'PAUSED' } : null;
  }
  async createCampaign(input: { status: 'PAUSED' }) {
    assert.equal(input.status, 'PAUSED');
    this.calls.push('campaign');
    return this.novo('campaign');
  }
  async createAdSet(input: { status: 'PAUSED'; orcamentoDiarioCentavos: number }) {
    assert.equal(input.status, 'PAUSED');
    this.calls.push(`adset:${input.orcamentoDiarioCentavos}`);
    return this.novo('adset');
  }
  async createAd(input: { status: 'PAUSED' }) {
    assert.equal(input.status, 'PAUSED');
    this.calls.push('ad');
    return this.novo('ad');
  }
  async getStatus(id: string) {
    return this.status.get(id) ?? this.existentesStatus ?? 'PAUSED';
  }
  existentesStatus: string | null = null;
}

const noSleep = async () => {};

describe('rascunho de campanha (M03)', () => {
  test('sai da oferta com 5 criativos, orçamento sugerido e pendências claras', () => {
    const d = buildCampaignDraft(offer, { offerNumber: 2, offerVersion: 1, destinoUrl: null });
    assert.equal(d.criativos.length, 5);
    assert.match(d.nome, /^NIGHT [0-9a-f]{8} · Rotina Enxuta$/);
    assert.ok(d.pendencias.some((p) => /URL https da página/.test(p)));
    assert.ok(d.pendencias.some((p) => /nenhum criativo tem imagem/.test(p)));
    assert.match(describeDraft(d).voz, /pendência/);
  });

  test('com página e imagem não tem pendência e a voz diz como aprovar', () => {
    const d = buildCampaignDraft(offer, { offerNumber: 2, offerVersion: 1, destinoUrl: PAGINA, imagens: [IMG] });
    assert.deepEqual(d.pendencias, []);
    assert.match(describeDraft(d).voz, /aprovo montar a campanha da oferta 2 com R\$ 20 por dia/);
    assert.match(describeDraft(d).tela, /PAUSADO/);
  });

  test('promessa proibida no anúncio vira pendência', () => {
    const d = buildCampaignDraft({ ...offer, promessa: 'Renda garantida em 7 dias' }, { offerNumber: 1, offerVersion: 1, destinoUrl: PAGINA, imagens: [IMG] });
    assert.ok(draftPendencias(d).some((p) => /promessa proibida/.test(p)));
  });

  test('a mesma oferta e versão geram a mesma tag (busca por nome na retomada)', () => {
    const a = buildCampaignDraft(offer, { offerNumber: 2, offerVersion: 1, destinoUrl: PAGINA });
    const b = buildCampaignDraft(offer, { offerNumber: 2, offerVersion: 1, destinoUrl: PAGINA });
    const c = buildCampaignDraft(offer, { offerNumber: 2, offerVersion: 2, destinoUrl: PAGINA });
    assert.equal(a.tag, b.tag);
    assert.notEqual(a.tag, c.tag);
  });

  test('com os textos por ângulo (L04), o anúncio usa os textos novos em vez de problema + promessa', () => {
    const textos = offer.angulosCriativo.map((_, i) => ({
      titulo: `Gancho ${i + 1}`,
      textoPrincipal: `Gancho ${i + 1}. ${offer.problema} ${offer.promessa}`,
    }));
    const d = buildCampaignDraft(offer, {
      offerNumber: 2, offerVersion: 1, destinoUrl: PAGINA, imagens: [IMG], criativos: textos,
    });
    assert.deepEqual(d.criativos.map((c) => c.angulo), offer.angulosCriativo);
    assert.deepEqual(d.criativos.map((c) => c.titulo), textos.map((t) => t.titulo));
    assert.deepEqual(d.criativos.map((c) => c.textoPrincipal), textos.map((t) => t.textoPrincipal));
    assert.deepEqual(d.pendencias, []);
  });

  test('sem os textos por ângulo, o rascunho continua com problema + promessa', () => {
    const d = buildCampaignDraft(offer, { offerNumber: 2, offerVersion: 1, destinoUrl: PAGINA, imagens: [IMG] });
    for (const c of d.criativos) assert.equal(c.textoPrincipal, `${offer.problema} ${offer.promessa}`);
    assert.equal(d.criativos[0]!.titulo, 'Antes e depois da semana');
  });

  test('texto por ângulo que faltar cai no padrão, sem quebrar o rascunho', () => {
    const d = buildCampaignDraft(offer, {
      offerNumber: 2, offerVersion: 1, destinoUrl: PAGINA,
      criativos: [{ titulo: 'Só o primeiro', textoPrincipal: 'Um texto curto.' }],
    });
    assert.equal(d.criativos[0]!.titulo, 'Só o primeiro');
    assert.equal(d.criativos[1]!.textoPrincipal, `${offer.problema} ${offer.promessa}`);
  });

  test('lê o orçamento falado', () => {
    assert.equal(parseDailyBudget('aprovo montar a campanha da oferta 2 com R$ 20 por dia'), 20);
    assert.equal(parseDailyBudget('com 35 reais por dia'), 35);
    assert.equal(parseDailyBudget('R$ 12,50/dia'), 12.5);
    assert.equal(parseDailyBudget('aprovo montar a campanha da oferta 2'), null);
  });
});

describe('criação pausada (M04, M06)', () => {
  let mem: PgMemory;
  let jobId: string;
  const draft = buildCampaignDraft(offer, { offerNumber: 2, offerVersion: 1, destinoUrl: PAGINA, imagens: [IMG, IMG] });
  const approval = { offerNumber: 2, orcamentoDiarioBRL: 20, frase: 'aprovo montar a campanha da oferta 2 com R$ 20 por dia' };

  before(async () => {
    await resetTestDb(TEST_URL);
    mem = await PgMemory.open(TEST_URL);
  });
  after(async () => { await mem?.close(); });
  beforeEach(async () => {
    await truncateAll();
    jobId = (await mem.createJob({ kind: 'radar', origin: 'texto', idempotencyKey: `camp-${Date.now()}-${Math.random()}` })).job.id;
  });

  test('cria campanha, conjunto e um anúncio por imagem, tudo pausado e com o orçamento aprovado', async () => {
    const w = new FakeWriter();
    const r = await buildPausedCampaign({ memory: mem, writer: w, adAccountId: 'act_1', sleep: noSleep }, { jobId, draft, approval });
    assert.equal(r.status, 'criada');
    assert.deepEqual(w.calls, ['find', 'campaign', 'adset:2000', 'ad', 'ad']);
    const efeitos = (await mem.listJobEvents(jobId)).filter((e) => e.eventType === 'effect-confirmed').map((e) => e.effectKey);
    assert.deepEqual(efeitos, ['meta:build-started', 'meta:campaign', 'meta:adset', 'meta:ad:0', 'meta:ad:1']);
  });

  test('retomar depois de concluído não cria nada de novo', async () => {
    const w = new FakeWriter();
    await buildPausedCampaign({ memory: mem, writer: w, adAccountId: 'act_1', sleep: noSleep }, { jobId, draft, approval });
    const antes = w.calls.length;
    const r = await buildPausedCampaign({ memory: mem, writer: w, adAccountId: 'act_1', sleep: noSleep }, { jobId, draft, approval });
    assert.equal(r.status, 'criada');
    assert.equal(w.calls.length, antes, 'nenhuma chamada nova à Meta');
  });

  test('campanha criada mas não registrada (queda) é achada pelo nome e não duplicada', async () => {
    const w = new FakeWriter();
    w.existentes.set(draft.nome, 'campaign-existente');
    const r = await buildPausedCampaign({ memory: mem, writer: w, adAccountId: 'act_1', sleep: noSleep }, { jobId, draft, approval });
    assert.equal(r.status, 'criada');
    assert.ok(r.status === 'criada' && r.reaproveitada);
    assert.ok(!w.calls.includes('campaign'));
  });

  test('erro da Meta para na hora, sem tentar de novo, e conta o que já existe', async () => {
    const w = new FakeWriter();
    w.falharEm = 'adset';
    const r = await buildPausedCampaign({ memory: mem, writer: w, adAccountId: 'act_1', sleep: noSleep }, { jobId, draft, approval });
    assert.equal(r.status, 'parada');
    assert.ok(r.status === 'parada' && r.criados.campanha);
    assert.equal(w.calls.filter((c) => c.startsWith('adset')).length, 1, 'uma tentativa só: a que falhou não foi repetida');
    assert.ok(!w.calls.includes('ad'), 'depois do erro nada mais foi criado');
    assert.ok((await mem.listJobEvents(jobId)).some((e) => e.eventType === 'error' && /montagem parada/.test(e.message)));
  });

  test('qualquer coisa fora de PAUSED na leitura de volta para com alerta', async () => {
    const w = new FakeWriter();
    const orig = w.getStatus.bind(w);
    w.getStatus = async (id: string) => (id.startsWith('ad-') ? 'ACTIVE' : orig(id));
    const r = await buildPausedCampaign({ memory: mem, writer: w, adAccountId: 'act_1', sleep: noSleep }, { jobId, draft, approval });
    assert.equal(r.status, 'parada');
    assert.match(r.status === 'parada' ? r.motivo : '', /ATENÇÃO.*ACTIVE.*Pause agora/);
  });

  test('recusa sem tocar na Meta: oferta errada, orçamento acima do teto, sem valor, rascunho com pendência', async () => {
    const w = new FakeWriter();
    const deps = { memory: mem, writer: w, adAccountId: 'act_1', sleep: noSleep };
    assert.equal((await buildPausedCampaign(deps, { jobId, draft, approval: { ...approval, offerNumber: 3 } })).status, 'recusada');
    assert.equal((await buildPausedCampaign(deps, { jobId, draft, approval: { ...approval, orcamentoDiarioBRL: ORCAMENTO_DIARIO_MAXIMO_BRL + 1 } })).status, 'recusada');
    assert.equal((await buildPausedCampaign(deps, { jobId, draft, approval: { ...approval, orcamentoDiarioBRL: 0 } })).status, 'recusada');
    const semPagina = buildCampaignDraft(offer, { offerNumber: 2, offerVersion: 1, destinoUrl: null, imagens: [IMG] });
    assert.equal((await buildPausedCampaign(deps, { jobId, draft: semPagina, approval })).status, 'recusada');
    assert.deepEqual(w.calls, []);
  });
});
