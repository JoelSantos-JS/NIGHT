// Comandos de voz/texto do low-ticket e da campanha (seções L e M): roteamento e coordenador com MCP falso.
// O que se prova: "aprovo montar a campanha…" nunca vira aprovação de oferta nem de merge; sem valor,
// sem conta ou com oferta não aprovada nada chega à Meta; a campanha nasce pausada e repetir não duplica.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, test } from 'node:test';
import type { MetaAdsWriter } from '../src/ads/campaign.ts';
import type { CampaignInsights, InsightsPeriod, MetaInsightsReader } from '../src/ads/meta-reader.ts';
import { NightCoordinator } from '../src/app/coordinator.ts';
import { PgOfferLinks } from '../src/lowticket/links.ts';
import { PgMemory } from '../src/memory/pg-memory.ts';
import { PgRadarStore } from '../src/radar/store.ts';
import { NightRouter, ruleIntent } from '../src/router/router.ts';
import { FakeLlm, resetTestDb, TEST_URL, truncateAll } from './helpers.ts';

describe('regras de low-ticket e campanha', () => {
  const r = (t: string) => ruleIntent(t, []);

  test('links da oferta saem com a URL original', () => {
    assert.deepEqual(r('a página da oferta 2 é https://Loja.example/Rotina'),
      { kind: 'offer-link', number: 2, field: 'pagina', urls: ['https://Loja.example/Rotina'] });
    assert.deepEqual(r('o checkout da oferta dois é https://pay.example/x.'),
      { kind: 'offer-link', number: 2, field: 'checkout', urls: ['https://pay.example/x'] });
    assert.deepEqual(r('as imagens da oferta 3 são https://a.example/1.png, https://a.example/2.png'),
      { kind: 'offer-link', number: 3, field: 'imagens', urls: ['https://a.example/1.png', 'https://a.example/2.png'] });
    assert.equal(r('a página da oferta 2 é http://inseguro.example')?.kind === 'offer-link', false, 'só https vira link');
  });

  test('produto, rascunho e montagem', () => {
    assert.deepEqual(r('gera o produto da oferta 2'), { kind: 'product-create', number: 2 });
    assert.deepEqual(r('monta a campanha da oferta 2'), { kind: 'campaign-draft', number: 2 });
    assert.deepEqual(r('aprovo montar a campanha da oferta 2 com R$ 20 por dia'), { kind: 'campaign-build', number: 2, budgetBRL: 20 });
    assert.deepEqual(r('aprovo montar a campanha da oferta 2 com 35,50 reais por dia'), { kind: 'campaign-build', number: 2, budgetBRL: 35.5 });
    assert.deepEqual(r('aprovo montar a campanha da oferta 2'), { kind: 'campaign-build', number: 2, budgetBRL: null });
  });

  test('status da campanha (M07) sai por regra em PT e EN', () => {
    assert.deepEqual(r('como está a campanha da oferta 2?'), { kind: 'campaign-status', number: 2 });
    assert.deepEqual(r('desempenho da campanha da oferta dois'), { kind: 'campaign-status', number: 2 });
    assert.deepEqual(r('status da campanha da oferta 3'), { kind: 'campaign-status', number: 3 });
    assert.deepEqual(r('how is the campaign for offer 2'), { kind: 'campaign-status', number: 2 });
    assert.notEqual(r('aprovo montar a campanha da oferta 2 com R$ 20 por dia')?.kind, 'campaign-status');
    assert.notEqual(r('monta a campanha da oferta 2')?.kind, 'campaign-status');
  });

  test('segurança: não confunde com aprovar oferta nem merge, e negação não monta', () => {
    assert.equal(r('aprovo montar a campanha da oferta 2 com R$ 20 por dia')?.kind, 'campaign-build');
    assert.equal(r('aprova a oferta 2')?.kind, 'offer-decision');
    assert.equal(r('aprovo')?.kind, 'approval');
    assert.notEqual(r('não aprovo montar a campanha da oferta 2 com R$ 20 por dia')?.kind, 'campaign-build');
    assert.notEqual(r('aprovo montar a campanha da oferta 2?')?.kind, 'campaign-build');
  });
});

class FakeWriter implements MetaAdsWriter {
  calls: string[] = [];
  private n = 0;
  async findCampaignByName() { this.calls.push('find'); return null; }
  async createCampaign() { this.calls.push('campaign'); return { id: `c${++this.n}` }; }
  async createAdSet(i: { orcamentoDiarioCentavos: number }) { this.calls.push(`adset:${i.orcamentoDiarioCentavos}`); return { id: `s${++this.n}` }; }
  async createAd() { this.calls.push('ad'); return { id: `a${++this.n}` }; }
  async getStatus() { return 'PAUSED'; }
}

/** Leitor falso do M07: devolve números fixos e guarda o id e o período pedidos. */
class FakeReader implements MetaInsightsReader {
  calls: { campaignId: string; periodo: InsightsPeriod }[] = [];
  constructor(private readonly dados: Partial<CampaignInsights> = {}) {}
  async insights(campaignId: string, periodo: InsightsPeriod): Promise<CampaignInsights> {
    this.calls.push({ campaignId, periodo });
    return {
      campaignId, status: 'PAUSED', gastoBRL: 45.2, impressoes: 3200, cliques: 51, ctr: 1.6, cpc: 0.89,
      alcance: 2500, compras: 3, periodo, lidoEm: '2026-11-17T12:00:00.000Z', ...this.dados,
    };
  }
}

describe('coordenador: produto e campanha', () => {
  let mem: PgMemory;
  let radar: PgRadarStore;
  let links: PgOfferLinks;
  let writer: FakeWriter;
  let night: NightCoordinator;

  const proposta = (candidateId: string): Record<string, unknown> => ({
    version: 'oferta/1', nome: 'Rotina Enxuta', posicionamento: 'Guia curto', publico: 'Autônomos que trabalham de casa',
    problema: 'O dia termina sem foco.', promessa: 'Monte uma rotina semanal em sete passos.', diferencial: 'Checklist de uma página',
    entregaveis: [1, 2, 3, 4].map((n) => ({ titulo: `PDF ${n}`, formato: 'pdf', descricao: `parte ${n}` })),
    bonus: ['Modelo de agenda'], precoHipotese: { valor: 19.9, moeda: 'BRL', justificativa: 'entrada', ehHipotese: true },
    paginaDeVendas: ['promessa', 'problema', 'entregáveis', 'preço', 'dúvidas'],
    angulosCriativo: ['Antes e depois', 'Três erros', 'Rotina real', 'Pergunta direta', 'Prova simples'],
    objecoes: [{ objecao: 'a', resposta: 'b' }, { objecao: 'c', resposta: 'd' }, { objecao: 'e', resposta: 'f' }],
    evidencias: [{ candidateId, oQueSustenta: 'x' }], duvidas: ['x', 'y'], motivoParaDescartar: 'z', alternativas: [],
  });

  async function oferta(aprovada: boolean): Promise<number> {
    const { candidate } = await radar.upsertCandidate({ source: 't', externalId: `e-${randomUUID()}`, raw: {}, keywords: ['x'] });
    const o = await radar.createOffer(candidate.id, proposta(candidate.id), []);
    if (aprovada) await radar.setOfferStatus(o.number, o.version, 'aprovada');
    return o.number;
  }

  const make = (opts: { conta?: string | null; reader?: MetaInsightsReader } = {}) => {
    const llm = new FakeLlm();
    return new NightCoordinator(mem, new NightRouter(llm, async () => []), llm, {
      radar, links, campaign: { writer, adAccountId: opts.conta === undefined ? 'act_1' : opts.conta },
      campaignReader: opts.reader,
    });
  };

  before(async () => {
    await resetTestDb();
    mem = await PgMemory.open(TEST_URL);
    radar = await PgRadarStore.open(TEST_URL);
    links = await PgOfferLinks.open(TEST_URL);
  });
  after(async () => { await links?.close(); await radar?.close(); await mem?.close(); });
  beforeEach(async () => { await truncateAll(); writer = new FakeWriter(); night = make(); });

  test('links: guarda e recusa http', async () => {
    const n = await oferta(true);
    assert.match((await night.handle(`a página da oferta ${n} é https://loja.example/r`)).text, /Guardei página/);
    assert.equal((await links.get(n)).paginaUrl, 'https://loja.example/r');
    assert.match((await night.handle(`as imagens da oferta ${n} são https://i.example/1.png https://i.example/2.png`)).text, /2 imagem/);
  });

  test('rascunho mostra pendências e depois diz como aprovar', async () => {
    const n = await oferta(true);
    assert.match((await night.handle(`monta a campanha da oferta ${n}`)).text, /pendência/);
    await links.set(n, 'pagina', 'https://loja.example/r');
    await links.set(n, 'imagens', ['https://i.example/1.png']);
    const r = await night.handle(`monta a campanha da oferta ${n}`);
    assert.match(r.text, /aprovo montar a campanha da oferta \d+ com R\$ 20 por dia/);
    assert.match(r.detail ?? '', /PAUSADO/);
    assert.deepEqual(writer.calls, [], 'rascunho não chama a Meta');
  });

  test('oferta não aprovada: nem rascunho, nem produto, nem montagem', async () => {
    const n = await oferta(false);
    assert.match((await night.handle(`monta a campanha da oferta ${n}`)).text, /não foi aprovada/);
    assert.match((await night.handle(`gera o produto da oferta ${n}`)).text, /Aprove antes/);
    assert.match((await night.handle(`aprovo montar a campanha da oferta ${n} com R$ 20 por dia`)).text, /não está aprovada/);
    assert.deepEqual(writer.calls, []);
  });

  test('montagem: sem valor ou sem conta não chama a Meta', async () => {
    const n = await oferta(true);
    await links.set(n, 'pagina', 'https://loja.example/r');
    await links.set(n, 'imagens', ['https://i.example/1.png']);
    assert.match((await night.handle(`aprovo montar a campanha da oferta ${n}`)).text, /valor por dia/);
    assert.match((await make({ conta: null }).handle(`aprovo montar a campanha da oferta ${n} com R$ 20 por dia`)).text, /NIGHT_META_AD_ACCOUNT/);
    assert.deepEqual(writer.calls, []);
  });

  test('montagem aprovada cria pausada com o valor dito, e repetir não duplica', async () => {
    const n = await oferta(true);
    await links.set(n, 'pagina', 'https://loja.example/r');
    await links.set(n, 'imagens', ['https://i.example/1.png', 'https://i.example/2.png']);
    const r = await night.handle(`aprovo montar a campanha da oferta ${n} com R$ 25 por dia`);
    assert.match(r.text, /PAUSADA: 2 anúncio\(s\), R\$ 25 por dia/);
    assert.match(r.text, /ative você no Gerenciador/);
    assert.deepEqual(writer.calls, ['find', 'campaign', 'adset:2500', 'ad', 'ad']);
    const antes = writer.calls.length;
    await night.handle(`aprovo montar a campanha da oferta ${n} com R$ 25 por dia`);
    assert.equal(writer.calls.length, antes, 'segunda frase não cria nada');
    const [job] = await mem.listJobs({ kind: 'campanha' });
    assert.equal(job?.status, 'succeeded');
  });

  test('dois "aprovo" ao mesmo tempo (painel e voz, ou clique duplo) montam uma vez só', async () => {
    const n = await oferta(true);
    await links.set(n, 'pagina', 'https://loja.example/r');
    await links.set(n, 'imagens', ['https://i.example/1.png']);
    const painel = make();
    const [a, b] = await Promise.all([
      painel.decidir({ tipo: 'campanha', numero: n, valorBRL: 25 }),
      night.handle(`aprovo montar a campanha da oferta ${n} com R$ 25 por dia`),
    ]);
    assert.equal(writer.calls.filter((c) => c === 'campaign').length, 1, 'uma campanha só na Meta');
    assert.equal(writer.calls.filter((c) => c.startsWith('adset')).length, 1);
    const textos = [a.text, b.text];
    assert.equal(textos.filter((t) => /PAUSADA/.test(t)).length, 1, textos.join(' | '));
    assert.equal(textos.filter((t) => /já está sendo montada/.test(t)).length, 1, textos.join(' | '));
  });

  test('status da campanha: sem montagem e sem conector, nada é inventado (M07)', async () => {
    assert.match((await night.handle('como está a campanha da oferta 9?')).text, /ainda não foi montada/);
    const { job } = await mem.createJob({
      kind: 'campanha', origin: 'texto', idempotencyKey: 'campanha:teste', params: { offerNumber: 4 },
    });
    await mem.recordJobEffect(job.id, 'meta:campaign', 'meta', 'campanha id=777');
    assert.match((await night.handle('como está a campanha da oferta 4?')).text, /conector de leitura da Meta/);
  });

  test('status da campanha com job, efeito e leitor falso mostra os números em formato brasileiro', async () => {
    const { job } = await mem.createJob({
      kind: 'campanha', origin: 'texto', idempotencyKey: 'campanha:teste', params: { offerNumber: 2 },
    });
    await mem.recordJobEffect(job.id, 'meta:campaign', 'meta', 'campanha id=777');

    const reader = new FakeReader();
    const r = await make({ reader }).handle('como está a campanha da oferta 2?');
    assert.deepEqual(reader.calls.map((c) => c.campaignId), ['777'], 'lê a campanha do efeito, não da conversa');
    assert.match(r.text, /Campanha da oferta 2, últimos 7 dias/);
    assert.match(r.text, /R\$ 45,20 gastos/);
    assert.match(r.text, /3\.200 impressões/);
    assert.match(r.text, /51 cliques/);
    assert.match(r.text, /CTR 1,6%/);
    assert.match(r.text, /Status: pausada/);
    assert.doesNotMatch(r.text, /lucro|receita|venda/i, 'voz não extrapola venda nem lucro');

    const { de, ate } = reader.calls[0]!.periodo;
    assert.match(de, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(ate, /^\d{4}-\d{2}-\d{2}$/);
    const dias = (Date.parse(`${ate}T00:00:00Z`) - Date.parse(`${de}T00:00:00Z`)) / 86_400_000;
    assert.equal(dias, 6, 'últimos 7 dias contando hoje');

    const tela = r.detail ?? '';
    assert.match(tela, /id 777/);
    assert.match(tela, new RegExp(`Período: ${de} a ${ate}`));
    assert.match(tela, /lido em \d{2}\/\d{2}\/\d{4},? \d{2}:\d{2}/);
    assert.match(tela, /Gasto: R\$ 45,20/);
    assert.match(tela, /CPC: R\$ 0,89/);
    assert.match(tela, /Alcance: 2\.500/);
    assert.match(tela, /Compras atribuídas pela Meta: 3/);
    assert.match(tela, /Vendas e lucro não vêm da Meta/);
  });

  test('gerar produto de oferta aprovada registra o trabalho', async () => {
    const n = await oferta(true);
    const r = await night.handle(`gera o produto da oferta ${n}`);
    assert.match(r.text, /Produto 1: PDFs, bônus e página da oferta/);
    const [job] = await mem.listJobs({ kind: 'lowticket' });
    assert.deepEqual(job?.params, { offerNumber: n });
  });
});
