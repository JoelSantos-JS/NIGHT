// Campanha na Meta (M03, M04, M06) com MCP falso e banco de teste. O que se prova: nada nasce ativo,
// o orçamento é só o aprovado (com teto), retomar não cria duas vezes, erro para sem repetir e o
// NIGHT acusa qualquer coisa que a Meta devolva fora de PAUSED.

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import {
  buildCampaignDraft, buildPausedCampaign, campaignIdsFromEvents, describeDraft, draftPendencias, ORCAMENTO_DIARIO_MAXIMO_BRL,
  parseDailyBudget, settingsValidas, SETTINGS_PADRAO, type CampaignSettings, type MetaAdsWriter,
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
const IMG2 = 'https://exemplo.com/img2.png';
const PAGINA = 'https://exemplo.com/rotina';
const VIDEOS = [
  { url: 'https://exemplo.com/v1.mp4', miniatura: 'https://exemplo.com/v1.jpg' },
  { url: 'https://exemplo.com/v2.mp4', miniatura: 'https://exemplo.com/v2.jpg' },
];
const CONFIG: Partial<CampaignSettings> = { pixelId: '1234567890', paginaFacebookId: '9876543210' };

/** MCP falso: registra cada chamada e pode falhar ou devolver status diferente de PAUSED. */
class FakeWriter implements MetaAdsWriter {
  calls: string[] = [];
  existentes = new Map<string, string>();
  status = new Map<string, string>();
  budgets = new Map<string, number>();
  nomes: string[] = [];
  adSets: { campaignId: string; pixelId: string | null; inicio: string | null }[] = [];
  ads: { adSetId: string; nome: string; paginaFacebookId: string; tipo: string }[] = [];
  falharEm: string | null = null;
  /** Falha só na n-ésima criação desse tipo (1 = primeira); null = em todas. */
  falharNaVez: number | null = null;
  private vezes = new Map<string, number>();
  private n = 0;
  private novo(tipo: string) {
    const vez = (this.vezes.get(tipo) ?? 0) + 1;
    this.vezes.set(tipo, vez);
    if (this.falharEm === tipo && (this.falharNaVez === null || this.falharNaVez === vez)) throw new Error(`Meta recusou ${tipo} (simulado)`);
    const id = `${tipo}-${++this.n}`;
    this.status.set(id, 'PAUSED');
    return { id };
  }
  async findCampaignByName(_conta: string, nome: string) {
    this.calls.push('find');
    this.nomes.push(nome);
    const id = this.existentes.get(nome);
    return id ? { id, status: 'PAUSED' } : null;
  }
  async createCampaign(input: { status: 'PAUSED'; nome: string; orcamentoDiarioCentavos: number }) {
    assert.equal(input.status, 'PAUSED');
    this.calls.push(`campaign:${input.orcamentoDiarioCentavos}`);
    const item = this.novo('campaign');
    this.budgets.set(item.id, input.orcamentoDiarioCentavos);
    return item;
  }
  async createAdSet(input: { status: 'PAUSED'; campaignId: string; pixelId: string | null; inicio: string | null }) {
    assert.equal(input.status, 'PAUSED');
    assert.ok(!('orcamentoDiarioCentavos' in input), 'conjunto não leva orçamento (está na campanha)');
    this.calls.push('adset');
    const item = this.novo('adset');
    this.adSets.push({ campaignId: input.campaignId, pixelId: input.pixelId, inicio: input.inicio });
    return item;
  }
  async createAd(input: { status: 'PAUSED'; adSetId: string; nome: string; paginaFacebookId: string; criativo: { tipo: string } }) {
    assert.equal(input.status, 'PAUSED');
    this.calls.push('ad');
    const item = this.novo('ad');
    this.ads.push({ adSetId: input.adSetId, nome: input.nome, paginaFacebookId: input.paginaFacebookId, tipo: input.criativo.tipo });
    return item;
  }
  async getStatus(id: string) {
    return this.status.get(id) ?? this.existentesStatus ?? 'PAUSED';
  }
  async getCampaignDailyBudgetCentavos(id: string) {
    const budget = this.budgets.get(id);
    if (budget === undefined) throw new Error('orçamento da campanha indisponível');
    return budget;
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
    assert.deepEqual(d.testes, []);
    assert.match(describeDraft(d).voz, /pendência/);
  });

  test('com página, imagem, pixel e página do Facebook não tem pendência e a voz diz como aprovar', () => {
    const d = buildCampaignDraft(offer, { offerNumber: 2, offerVersion: 1, destinoUrl: PAGINA, imagens: [IMG], config: CONFIG });
    assert.deepEqual(d.pendencias, []);
    assert.deepEqual(d.testes, [[0]]);
    assert.equal(d.orcamentoDiarioSugeridoBRL, 15);
    assert.equal(d.pixelId, CONFIG.pixelId);
    assert.equal(d.paginaFacebookId, CONFIG.paginaFacebookId);
    assert.match(describeDraft(d).voz, /aprovo montar a campanha da oferta 2 com R\$ 15 por dia/);
    assert.match(describeDraft(d).tela, /PAUSADO/);
  });

  test('sem pixel (objetivo de venda) e sem id da página do Facebook há pendência', () => {
    const semNada = buildCampaignDraft(offer, { offerNumber: 2, offerVersion: 1, destinoUrl: PAGINA, imagens: [IMG] });
    assert.equal(semNada.objetivo, 'OUTCOME_SALES');
    assert.ok(semNada.pendencias.some((p) => /pixel/.test(p)));
    assert.ok(semNada.pendencias.some((p) => /página do Facebook/.test(p)));
    const semPixel = buildCampaignDraft(offer, { offerNumber: 2, offerVersion: 1, destinoUrl: PAGINA, imagens: [IMG], config: { paginaFacebookId: '9876543210' } });
    assert.equal(semPixel.pendencias.length, 1);
    assert.match(semPixel.pendencias[0]!, /pixel/);
    const semPagina = buildCampaignDraft(offer, { offerNumber: 2, offerVersion: 1, destinoUrl: PAGINA, imagens: [IMG], config: { pixelId: '1234567890' } });
    assert.equal(semPagina.pendencias.length, 1);
    assert.match(semPagina.pendencias[0]!, /página do Facebook/);
    const pixelRuim = buildCampaignDraft(offer, { offerNumber: 2, offerVersion: 1, destinoUrl: PAGINA, imagens: [IMG], config: { ...CONFIG, pixelId: 'abc' } });
    assert.ok(pixelRuim.pendencias.some((p) => /pixel/.test(p)));
  });

  test('2 vídeos + 2 imagens viram 2 testes de vídeo + imagem e sugestão de R$ 30', () => {
    const d = buildCampaignDraft(offer, {
      offerNumber: 2, offerVersion: 1, destinoUrl: PAGINA, imagens: [IMG, IMG2], config: { ...CONFIG, videos: VIDEOS, estrutura: 'campanha-por-teste' },
    });
    assert.deepEqual(d.pendencias, []);
    assert.deepEqual(d.testes, [[0, 1], [2, 3]]);
    assert.deepEqual(d.criativos.map((c) => c.tipo), ['video', 'imagem', 'video', 'imagem', 'imagem']);
    assert.equal(d.criativos[0]!.videoUrl, VIDEOS[0]!.url);
    assert.equal(d.criativos[0]!.imagemUrl, VIDEOS[0]!.miniatura);
    assert.equal(d.criativos[1]!.imagemUrl, IMG);
    assert.equal(d.criativos[1]!.videoUrl, null);
    assert.equal(d.criativos[2]!.videoUrl, VIDEOS[1]!.url);
    assert.equal(d.criativos[3]!.imagemUrl, IMG2);
    assert.equal(d.criativos[4]!.imagemUrl, null, 'quinto criativo sem mídia fica fora dos testes');
    assert.equal(d.orcamentoDiarioSugeridoBRL, 30);
    assert.match(describeDraft(d).voz, /2 teste\(s\) com 4 criativo\(s\).*R\$ 30 por dia/);
  });

  test('promessa proibida no anúncio vira pendência', () => {
    const d = buildCampaignDraft({ ...offer, promessa: 'Renda garantida em 7 dias' }, { offerNumber: 1, offerVersion: 1, destinoUrl: PAGINA, imagens: [IMG], config: CONFIG });
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
      offerNumber: 2, offerVersion: 1, destinoUrl: PAGINA, imagens: [IMG], criativos: textos, config: CONFIG,
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
  const draft = buildCampaignDraft(offer, { offerNumber: 2, offerVersion: 1, destinoUrl: PAGINA, imagens: [IMG, IMG2], config: CONFIG });
  const approval = { offerNumber: 2, orcamentoDiarioBRL: 20, frase: 'aprovo montar a campanha da oferta 2 com R$ 20 por dia' };
  const draft2 = buildCampaignDraft(offer, {
    offerNumber: 2, offerVersion: 1, destinoUrl: PAGINA, imagens: [IMG, IMG2], config: { ...CONFIG, videos: VIDEOS, estrutura: 'campanha-por-teste' },
  });
  const approval30 = { offerNumber: 2, orcamentoDiarioBRL: 30, frase: 'aprovo montar a campanha da oferta 2 com R$ 30 por dia' };
  const efeitos = async () => (await mem.listJobEvents(jobId)).filter((e) => e.eventType === 'effect-confirmed').map((e) => e.effectKey);
  const novoJob = async () => {
    await truncateAll();
    jobId = (await mem.createJob({ kind: 'radar', origin: 'texto', idempotencyKey: `camp-${Date.now()}-${Math.random()}` })).job.id;
  };

  before(async () => {
    await resetTestDb(TEST_URL);
    mem = await PgMemory.open(TEST_URL);
  });
  after(async () => { await mem?.close(); });
  beforeEach(novoJob);

  test('cria campanha com o orçamento aprovado, conjunto e um anúncio por imagem, tudo pausado', async () => {
    assert.deepEqual(draft.testes, [[0, 1]]);
    const w = new FakeWriter();
    const r = await buildPausedCampaign({ memory: mem, writer: w, adAccountId: 'act_1', sleep: noSleep }, { jobId, draft, approval });
    assert.equal(r.status, 'criada');
    assert.deepEqual(w.calls, ['find', 'campaign:2000', 'adset', 'ad', 'ad']);
    assert.deepEqual(w.nomes, [draft.nome]);
    assert.deepEqual(w.adSets, [{ campaignId: 'campaign-1', pixelId: CONFIG.pixelId, inicio: null }]);
    assert.ok(w.ads.every((a) => a.paginaFacebookId === CONFIG.paginaFacebookId && a.adSetId === 'adset-2'));
    assert.deepEqual(await efeitos(), ['meta:build-started', 'meta:campaign', 'meta:adset', 'meta:ad:0', 'meta:ad:1']);
    assert.ok(r.status === 'criada');
    assert.deepEqual(r.campaignIds, ['campaign-1']);
    assert.deepEqual(r.adSetIds, ['adset-2']);
    assert.equal(r.campaignId, 'campaign-1');
    assert.equal(r.adSetId, 'adset-2');
  });

  test('2 vídeos + 2 imagens: 2 campanhas com metade do orçamento cada, na ordem e com os efeitos certos', async () => {
    const w = new FakeWriter();
    const r = await buildPausedCampaign({ memory: mem, writer: w, adAccountId: 'act_1', sleep: noSleep }, { jobId, draft: draft2, approval: approval30 });
    assert.equal(r.status, 'criada');
    assert.deepEqual(w.calls, ['find', 'campaign:1500', 'adset', 'ad', 'ad', 'find', 'campaign:1500', 'adset', 'ad', 'ad']);
    assert.deepEqual(w.nomes, [draft2.nome, `${draft2.nome} · teste 2`]);
    assert.deepEqual(w.adSets.map((s) => s.campaignId), ['campaign-1', 'campaign-5']);
    assert.deepEqual(w.ads.map((a) => [a.adSetId, a.tipo]), [
      ['adset-2', 'video'], ['adset-2', 'imagem'], ['adset-6', 'video'], ['adset-6', 'imagem'],
    ]);
    assert.deepEqual(await efeitos(), [
      'meta:build-started', 'meta:campaign', 'meta:adset', 'meta:ad:0', 'meta:ad:1',
      'meta:campaign:1', 'meta:adset:1', 'meta:ad:2', 'meta:ad:3',
    ]);
    assert.ok(r.status === 'criada');
    assert.deepEqual(r.campaignIds, ['campaign-1', 'campaign-5']);
    assert.deepEqual(r.adSetIds, ['adset-2', 'adset-6']);
    assert.equal(r.adIds.length, 4);
    assert.equal(r.campaignId, 'campaign-1');
  });

  test('valor que não divide em centavos iguais entre os testes é recusado sem chamar a Meta', async () => {
    const w = new FakeWriter();
    const r = await buildPausedCampaign({ memory: mem, writer: w, adAccountId: 'act_1', sleep: noSleep },
      { jobId, draft: draft2, approval: { ...approval30, orcamentoDiarioBRL: 15.01 } });
    assert.equal(r.status, 'recusada');
    assert.match(r.status === 'recusada' ? r.motivo : '', /não se divide/);
    assert.deepEqual(w.calls, []);
    assert.deepEqual(await efeitos(), [], 'nem a aprovação é registrada');
  });

  test('retomada no meio do teste 2 não recria o teste 1', async () => {
    const w = new FakeWriter();
    w.falharEm = 'adset';
    w.falharNaVez = 2;
    const deps = { memory: mem, writer: w, adAccountId: 'act_1', sleep: noSleep };
    const r1 = await buildPausedCampaign(deps, { jobId, draft: draft2, approval: approval30 });
    assert.equal(r1.status, 'parada');
    assert.deepEqual(w.calls, ['find', 'campaign:1500', 'adset', 'ad', 'ad', 'find', 'campaign:1500', 'adset']);
    assert.ok(r1.status === 'parada' && r1.criados.campanha2 && !r1.criados.conjunto2);
    w.falharEm = null;
    w.calls = [];
    const r2 = await buildPausedCampaign(deps, { jobId, draft: draft2, approval: approval30 });
    assert.equal(r2.status, 'criada');
    assert.deepEqual(w.calls, ['adset', 'ad', 'ad'], 'só o que faltava do teste 2');
    assert.ok(r2.status === 'criada' && r2.reaproveitada);
    assert.deepEqual(r2.status === 'criada' ? r2.campaignIds : [], ['campaign-1', 'campaign-5']);
    const ef = await efeitos();
    for (const k of ['meta:campaign', 'meta:adset', 'meta:ad:0', 'meta:ad:1', 'meta:campaign:1']) {
      assert.equal(ef.filter((e) => e === k).length, 1, `${k} registrado uma vez só`);
    }
    assert.ok(ef.includes('meta:adset:1') && ef.includes('meta:ad:2') && ef.includes('meta:ad:3'));
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
    w.budgets.set('campaign-existente', 2000);
    const r = await buildPausedCampaign({ memory: mem, writer: w, adAccountId: 'act_1', sleep: noSleep }, { jobId, draft, approval });
    assert.equal(r.status, 'criada');
    assert.ok(r.status === 'criada' && r.reaproveitada);
    assert.equal(r.status === 'criada' ? r.campaignId : '', 'campaign-existente');
    assert.ok(!w.calls.some((c) => c.startsWith('campaign')));
  });

  test('retomada para antes de criar conjunto se a campanha existente está ativa', async () => {
    const w = new FakeWriter();
    w.existentes.set(draft.nome, 'campaign-existente');
    w.budgets.set('campaign-existente', 2000);
    w.existentesStatus = 'ACTIVE';
    const r = await buildPausedCampaign({ memory: mem, writer: w, adAccountId: 'act_1', sleep: noSleep }, { jobId, draft, approval });
    assert.equal(r.status, 'parada');
    assert.match(r.status === 'parada' ? r.motivo : '', /campanha.*ACTIVE/);
    assert.deepEqual(w.calls, ['find']);
  });

  test('campanha existente com orçamento diferente do aprovado para antes do conjunto', async () => {
    const w = new FakeWriter();
    w.existentes.set(draft.nome, 'campaign-existente');
    w.budgets.set('campaign-existente', 5000);
    const r = await buildPausedCampaign({ memory: mem, writer: w, adAccountId: 'act_1', sleep: noSleep }, { jobId, draft, approval });
    assert.equal(r.status, 'parada');
    assert.match(r.status === 'parada' ? r.motivo : '', /50\.00.*20\.00/);
    assert.deepEqual(w.calls, ['find']);
  });

  test('para após criar campanha ou conjunto ativo, antes de criar o próximo item', async () => {
    for (const tipo of ['campaign', 'adset']) {
      await novoJob();
      const w = new FakeWriter();
      const original = w.getStatus.bind(w);
      w.getStatus = async (id: string) => id.startsWith(tipo + '-') ? 'ACTIVE' : original(id);
      const r = await buildPausedCampaign({ memory: mem, writer: w, adAccountId: 'act_1', sleep: noSleep }, { jobId, draft, approval });
      assert.equal(r.status, 'parada');
      assert.ok(!w.calls.includes('ad'), 'nenhum anúncio criado depois de status ativo');
      if (tipo === 'campaign') assert.ok(!w.calls.includes('adset'));
    }
  });

  test('campanha do teste 2 ativa para antes de criar o conjunto dela', async () => {
    const w = new FakeWriter();
    const original = w.getStatus.bind(w);
    w.getStatus = async (id: string) => id === 'campaign-5' ? 'ACTIVE' : original(id);
    const r = await buildPausedCampaign({ memory: mem, writer: w, adAccountId: 'act_1', sleep: noSleep }, { jobId, draft: draft2, approval: approval30 });
    assert.equal(r.status, 'parada');
    assert.match(r.status === 'parada' ? r.motivo : '', /campanha do teste 2 campaign-5 está ACTIVE/);
    assert.deepEqual(w.calls, ['find', 'campaign:1500', 'adset', 'ad', 'ad', 'find', 'campaign:1500']);
  });

  test('orçamento real divergente na retomada para antes de criar anúncios', async () => {
    const w = new FakeWriter();
    await buildPausedCampaign({ memory: mem, writer: w, adAccountId: 'act_1', sleep: noSleep }, { jobId, draft, approval });
    w.budgets.set('campaign-1', 3500);
    const antes = w.calls.length;
    const r = await buildPausedCampaign({ memory: mem, writer: w, adAccountId: 'act_1', sleep: noSleep }, { jobId, draft, approval });
    assert.equal(r.status, 'parada');
    assert.match(r.status === 'parada' ? r.motivo : '', /35\.00.*20\.00/);
    assert.equal(w.calls.length, antes);
  });

  test('orçamento real divergente logo depois de criar a campanha para antes do conjunto', async () => {
    const w = new FakeWriter();
    const real = w.createCampaign.bind(w);
    w.createCampaign = async (input) => {
      const r = await real(input);
      w.budgets.set(r.id, input.orcamentoDiarioCentavos * 10);
      return r;
    };
    const r = await buildPausedCampaign({ memory: mem, writer: w, adAccountId: 'act_1', sleep: noSleep }, { jobId, draft, approval });
    assert.equal(r.status, 'parada');
    assert.match(r.status === 'parada' ? r.motivo : '', /200\.00.*20\.00/);
    assert.ok(!w.calls.includes('adset'));
  });

  test('erro da Meta para na hora, sem tentar de novo, e conta o que já existe', async () => {
    const w = new FakeWriter();
    w.falharEm = 'adset';
    const r = await buildPausedCampaign({ memory: mem, writer: w, adAccountId: 'act_1', sleep: noSleep }, { jobId, draft, approval });
    assert.equal(r.status, 'parada');
    assert.ok(r.status === 'parada' && r.criados.campanha);
    assert.equal(w.calls.filter((c) => c === 'adset').length, 1, 'uma tentativa só: a que falhou não foi repetida');
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
    assert.equal(w.calls.filter((call) => call === 'ad').length, 1, 'não cria o segundo anúncio');
  });

  test('recusa sem tocar na Meta: oferta errada, orçamento acima do teto, sem valor, rascunho com pendência', async () => {
    const w = new FakeWriter();
    const deps = { memory: mem, writer: w, adAccountId: 'act_1', sleep: noSleep };
    assert.equal((await buildPausedCampaign(deps, { jobId, draft, approval: { ...approval, offerNumber: 3 } })).status, 'recusada');
    assert.equal((await buildPausedCampaign(deps, { jobId, draft, approval: { ...approval, orcamentoDiarioBRL: ORCAMENTO_DIARIO_MAXIMO_BRL + 1 } })).status, 'recusada');
    assert.equal((await buildPausedCampaign(deps, { jobId, draft, approval: { ...approval, orcamentoDiarioBRL: 0 } })).status, 'recusada');
    const semPagina = buildCampaignDraft(offer, { offerNumber: 2, offerVersion: 1, destinoUrl: null, imagens: [IMG], config: CONFIG });
    assert.equal((await buildPausedCampaign(deps, { jobId, draft: semPagina, approval })).status, 'recusada');
    const semPixel = buildCampaignDraft(offer, { offerNumber: 2, offerVersion: 1, destinoUrl: PAGINA, imagens: [IMG], config: { paginaFacebookId: '9876543210' } });
    assert.equal((await buildPausedCampaign(deps, { jobId, draft: semPixel, approval })).status, 'recusada');
    const semPaginaFb = buildCampaignDraft(offer, { offerNumber: 2, offerVersion: 1, destinoUrl: PAGINA, imagens: [IMG], config: { pixelId: '1234567890' } });
    assert.equal((await buildPausedCampaign(deps, { jobId, draft: semPaginaFb, approval })).status, 'recusada');
    assert.deepEqual(w.calls, []);
    assert.deepEqual(await efeitos(), []);
  });
});

describe('regras gravadas e efeitos (settingsValidas, campaignIdsFromEvents)', () => {
  test('settingsValidas lê o jsonb campo a campo e o que vier errado volta ao padrão', () => {
    assert.deepEqual(settingsValidas(null), SETTINGS_PADRAO);
    assert.deepEqual(settingsValidas(undefined), SETTINGS_PADRAO);
    assert.deepEqual(settingsValidas({}), SETTINGS_PADRAO);
    const lixo = settingsValidas({
      pixelId: '  1234567890 ', paginaFacebookId: '', generos: 'outros', idadeMin: 21.5, idadeMax: '40', inicio: 7,
      videos: 'https://v.example/1.mp4',
    } as unknown as Partial<CampaignSettings>);
    assert.equal(lixo.pixelId, '1234567890');
    assert.equal(lixo.paginaFacebookId, null);
    assert.equal(lixo.generos, 'todos');
    assert.equal(lixo.idadeMin, SETTINGS_PADRAO.idadeMin);
    assert.equal(lixo.idadeMax, SETTINGS_PADRAO.idadeMax);
    assert.equal(lixo.inicio, null);
    assert.deepEqual(lixo.videos, []);
    const mistos = settingsValidas({
      generos: 'mulheres', idadeMin: 25, idadeMax: 44,
      videos: [VIDEOS[0]!, { url: 'https://v.example/x.mp4' }, null, 3] as unknown as CampaignSettings['videos'],
    });
    assert.equal(mistos.generos, 'mulheres');
    assert.equal(mistos.idadeMin, 25);
    assert.equal(mistos.idadeMax, 44);
    assert.deepEqual(mistos.videos, [VIDEOS[0]], 'vídeo sem miniatura ou item estranho fica de fora');
  });

  test('o rascunho usa settingsValidas: jsonb quebrado não derruba e vira pendência, não teste', () => {
    const d = buildCampaignDraft(offer, {
      offerNumber: 2, offerVersion: 1, destinoUrl: PAGINA, imagens: [IMG],
      config: { ...CONFIG, videos: { url: 'x' }, generos: 'qualquer', idadeMin: '18' } as unknown as Partial<CampaignSettings>,
    });
    assert.deepEqual(d.pendencias, []);
    assert.deepEqual(d.testes, [[0]]);
    assert.equal(d.criativos[0]!.tipo, 'imagem');
    assert.equal(d.publico.generos, 'todos');
    assert.equal(d.publico.idadeMin, 18);
  });

  test('campaignIdsFromEvents devolve as campanhas na ordem dos testes', () => {
    const ids = campaignIdsFromEvents([
      { effectKey: 'meta:campaign:2', message: 'campanha id=c3' },
      { effectKey: 'meta:adset', message: 'conjunto id=s1' },
      { effectKey: 'meta:campaign', message: 'campanha id=c1' },
      { effectKey: null, message: 'campanha id=fora' },
      { effectKey: 'meta:campaign:1', message: 'campanha id=c2' },
      { effectKey: 'meta:campaign:x', message: 'campanha id=ruim' },
      { effectKey: 'meta:ad:0', message: 'anúncio id=a1 midia=https://x' },
    ]);
    assert.deepEqual(ids, ['c1', 'c2', 'c3']);
    assert.deepEqual(campaignIdsFromEvents([]), []);
  });
});

describe('retomada com rascunho mudado (M04, M06)', () => {
  let mem: PgMemory;
  let jobId: string;
  const draft = buildCampaignDraft(offer, { offerNumber: 2, offerVersion: 1, destinoUrl: PAGINA, imagens: [IMG, IMG2], config: CONFIG });
  const approval = { offerNumber: 2, orcamentoDiarioBRL: 20, frase: 'aprovo montar a campanha da oferta 2 com R$ 20 por dia' };
  const deps = (w: FakeWriter) => ({ memory: mem, writer: w, adAccountId: 'act_1', sleep: noSleep });

  before(async () => {
    await resetTestDb(TEST_URL);
    mem = await PgMemory.open(TEST_URL);
  });
  after(async () => { await mem?.close(); });
  beforeEach(async () => {
    await truncateAll();
    jobId = (await mem.createJob({ kind: 'radar', origin: 'texto', idempotencyKey: `camp-${Date.now()}-${Math.random()}` })).job.id;
  });

  test('o efeito do anúncio grava a mídia usada', async () => {
    const w = new FakeWriter();
    await buildPausedCampaign(deps(w), { jobId, draft, approval });
    const ads = (await mem.listJobEvents(jobId)).filter((e) => e.effectKey?.startsWith('meta:ad:'));
    assert.deepEqual(ads.map((e) => /midia=(\S+)/.exec(e.message)?.[1]), [IMG, IMG2]);
  });

  test('anúncio já criado com outra mídia para a retomada sem criar nada', async () => {
    const w = new FakeWriter();
    await buildPausedCampaign(deps(w), { jobId, draft, approval });
    const outra = buildCampaignDraft(offer, {
      offerNumber: 2, offerVersion: 1, destinoUrl: PAGINA, imagens: ['https://exemplo.com/nova.png', IMG2], config: CONFIG,
    });
    assert.equal(outra.nome, draft.nome);
    w.calls = [];
    const r = await buildPausedCampaign(deps(w), { jobId, draft: outra, approval });
    assert.equal(r.status, 'parada');
    assert.match(r.status === 'parada' ? r.motivo : '', /foi criado com outra mídia/);
    assert.deepEqual(w.calls, []);
  });

  test('efeito antigo de anúncio sem midia= vale como está e a retomada segue', async () => {
    const w = new FakeWriter();
    w.budgets.set('campaign-velha', 2000);
    await mem.recordJobEffect(jobId, 'meta:campaign', 'meta', 'campanha id=campaign-velha');
    await mem.recordJobEffect(jobId, 'meta:adset', 'meta', 'conjunto id=adset-velho');
    await mem.recordJobEffect(jobId, 'meta:ad:0', 'meta', 'anúncio id=ad-velho');
    const r = await buildPausedCampaign(deps(w), { jobId, draft, approval });
    assert.equal(r.status, 'criada');
    assert.deepEqual(w.calls, ['ad'], 'só o segundo anúncio, que faltava');
    assert.deepEqual(r.status === 'criada' ? r.adIds[0] : '', 'ad-velho');
  });

  test('montagem com mais campanhas do que o rascunho atual é recusada sem tocar na Meta', async () => {
    const w = new FakeWriter();
    await mem.recordJobEffect(jobId, 'meta:campaign', 'meta', 'campanha id=c1');
    await mem.recordJobEffect(jobId, 'meta:campaign:1', 'meta', 'campanha id=c2');
    const r = await buildPausedCampaign(deps(w), { jobId, draft, approval });
    assert.equal(r.status, 'recusada');
    assert.match(r.status === 'recusada' ? r.motivo : '', /já tem 2 campanhas.*rascunho agora tem 1/);
    assert.deepEqual(w.calls, []);
    assert.ok(!(await mem.listJobEvents(jobId)).some((e) => e.effectKey === 'meta:build-started'));
  });

  test('orçamento da campanha ilegível (formato antigo, orçamento no conjunto) para antes do conjunto', async () => {
    const w = new FakeWriter();
    await mem.recordJobEffect(jobId, 'meta:campaign', 'meta', 'campanha id=campaign-antiga');
    const r = await buildPausedCampaign(deps(w), { jobId, draft, approval });
    assert.equal(r.status, 'parada');
    assert.match(r.status === 'parada' ? r.motivo : '', /orçamento da campanha indisponível.*formato antigo \(orçamento no conjunto\)/);
    assert.deepEqual(w.calls, []);
  });

  test('início marcado que já passou não vai para a Meta (visto no teste real de 25/11): começa quando for ativada', async () => {
    const comInicio = buildCampaignDraft(offer, {
      offerNumber: 2, offerVersion: 1, destinoUrl: PAGINA, imagens: [IMG, IMG2], config: { ...CONFIG, inicio: '2026-11-25T00:00:00-03:00' },
    });
    const antes = new FakeWriter();
    await buildPausedCampaign({ ...deps(antes), now: () => new Date('2026-11-24T20:00:00-03:00') }, { jobId, draft: comInicio, approval });
    assert.equal(antes.adSets[0]!.inicio, '2026-11-25T00:00:00-03:00');

    jobId = (await mem.createJob({ kind: 'radar', origin: 'texto', idempotencyKey: `camp-${Date.now()}-${Math.random()}` })).job.id;
    const depois = new FakeWriter();
    await buildPausedCampaign({ ...deps(depois), now: () => new Date('2026-11-25T11:00:00-03:00') }, { jobId, draft: comInicio, approval });
    assert.equal(depois.adSets[0]!.inicio, null);
    assert.ok((await mem.listJobEvents(jobId)).some((e) => /já passou: começa quando for ativada/.test(e.message)));
  });

  test('padrão = campanha COREANO1 do Joel: 1 campanha com o valor inteiro e 1 conjunto por teste, Stories + Reels', async () => {
    const d = buildCampaignDraft(offer, {
      offerNumber: 2, offerVersion: 1, destinoUrl: PAGINA, imagens: [IMG, IMG2], config: { ...CONFIG, videos: VIDEOS },
    });
    assert.equal(d.estrutura, 'uma-campanha');
    assert.equal(d.posicionamentos, 'stories-reels');
    assert.equal(d.orcamentoDiarioSugeridoBRL, 15);
    assert.match(describeDraft(d).tela, /1 campanha com 2 conjunto\(s\)/);
    assert.match(describeDraft(d).tela, /Stories e Reels/);
    const w = new FakeWriter();
    const pos: unknown[] = [];
    const orig = w.createAdSet.bind(w);
    w.createAdSet = async (i) => { pos.push((i as { posicionamentos?: unknown }).posicionamentos); return orig(i); };
    const r = await buildPausedCampaign(deps(w), { jobId, draft: d, approval: { ...approval, orcamentoDiarioBRL: 15 } });
    assert.equal(r.status, 'criada');
    assert.deepEqual(w.calls, ['find', 'campaign:1500', 'adset', 'ad', 'ad', 'adset', 'ad', 'ad']);
    assert.ok(r.status === 'criada' && r.campaignIds.length === 1 && r.adSetIds.length === 2);
    assert.deepEqual(pos[0], { facebook: ['story', 'facebook_reels'], instagram: ['story', 'reels'] });
    const efeitos = (await mem.listJobEvents(jobId)).filter((e) => e.eventType === 'effect-confirmed').map((e) => e.effectKey);
    assert.deepEqual(efeitos, ['meta:build-started', 'meta:campaign', 'meta:adset', 'meta:ad:0', 'meta:ad:1', 'meta:adset:1', 'meta:ad:2', 'meta:ad:3']);
    // Retomar não recria nada.
    const antes = w.calls.length;
    assert.equal((await buildPausedCampaign(deps(w), { jobId, draft: d, approval: { ...approval, orcamentoDiarioBRL: 15 } })).status, 'criada');
    assert.equal(w.calls.length, antes);
  });
});
