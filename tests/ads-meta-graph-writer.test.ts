// Adaptador da Graph API com uma Meta falsa: nenhuma rede. Prova que tudo nasce PAUSED, que o orçamento vai
// na campanha em centavos, que o conjunto segue o teste de criativo e que o token nunca vaza em erro.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { UTM_PADRAO } from '../src/ads/campaign.ts';
import { GraphMetaWriter, MELHORIAS_DESLIGADAS, type GraphFetch } from '../src/ads/meta-graph-writer.ts';

const TOKEN = 'EAAsegredo123';

function fakeMeta(respostas: (url: string, body: Record<string, string>) => unknown) {
  const chamadas: { url: string; method: string; body: Record<string, string> }[] = [];
  const fetch: GraphFetch = async (url, init) => {
    const body = Object.fromEntries(init?.body ?? new URLSearchParams());
    chamadas.push({ url, method: init?.method ?? 'GET', body });
    return { json: async () => respostas(url, body) };
  };
  return { fetch, chamadas };
}

describe('GraphMetaWriter', () => {
  test('campanha nasce PAUSED, com CBO em centavos, menor custo e sem categoria especial', async () => {
    const m = fakeMeta(() => ({ id: '111' }));
    const w = new GraphMetaWriter({ token: TOKEN, fetch: m.fetch });
    assert.deepEqual(await w.createCampaign({ adAccountId: '123', nome: 'NIGHT x', objetivo: 'OUTCOME_SALES', orcamentoDiarioCentavos: 1500, status: 'PAUSED' }), { id: '111' });
    const c = m.chamadas[0]!;
    assert.match(c.url, /\/act_123\/campaigns$/);
    assert.equal(c.method, 'POST');
    assert.equal(c.body.status, 'PAUSED');
    assert.equal(c.body.daily_budget, '1500');
    assert.equal(c.body.bid_strategy, 'LOWEST_COST_WITHOUT_CAP');
    assert.equal(c.body.special_ad_categories, '[]');
    await assert.rejects(w.createCampaign({ adAccountId: '123', nome: 'n', objetivo: 'OUTCOME_SALES', orcamentoDiarioCentavos: 12.5, status: 'PAUSED' }), /orçamento da campanha inválido/);
    assert.equal(m.chamadas.length, 1);
  });

  test('conjunto: sem orçamento, compra no pixel, mulheres, idade, sem Advantage+, feed e Reels, início marcado', async () => {
    const m = fakeMeta(() => ({ id: '222' }));
    const w = new GraphMetaWriter({ token: TOKEN, fetch: m.fetch });
    await w.createAdSet({
      adAccountId: 'act_123', campaignId: '111', nome: 'c', status: 'PAUSED', pixelId: '999999999', inicio: '2026-11-25T00:00:00-03:00',
      publico: { pais: 'BR', idadeMin: 18, idadeMax: 44, generos: 'mulheres', descricao: 'x' },
    });
    const b = m.chamadas[0]!.body;
    assert.equal(b.status, 'PAUSED');
    assert.equal(b.daily_budget, undefined);
    assert.equal(b.optimization_goal, 'OFFSITE_CONVERSIONS');
    assert.deepEqual(JSON.parse(b.promoted_object!), { pixel_id: '999999999', custom_event_type: 'PURCHASE' });
    assert.equal(b.start_time, '2026-11-25T00:00:00-03:00');
    const t = JSON.parse(b.targeting!);
    assert.deepEqual(t.genders, [2]);
    assert.equal(t.age_min, 18);
    assert.equal(t.age_max, 44);
    assert.deepEqual(t.targeting_automation, { advantage_audience: 0 });
    assert.deepEqual(t.facebook_positions, ['feed']);
    assert.deepEqual(t.instagram_positions, ['stream', 'reels']);
  });

  test('anúncio de vídeo: sobe o vídeo, espera ficar pronto, criativo sem melhorias e sem vários anunciantes, anúncio PAUSED', async () => {
    let leituras = 0;
    const m = fakeMeta((url) => {
      if (url.includes('/1479?') ) return { instagram_business_account: { id: '17841' } };
      if (url.endsWith('/adimages')) return { images: { x: { hash: 'h1' } } };
      if (url.endsWith('/advideos')) return { id: '555' };
      if (url.includes('/555?')) return { status: { video_status: ++leituras < 2 ? 'processing' : 'ready' } };
      if (url.endsWith('/adcreatives')) return { id: '666' };
      if (url.endsWith('/ads')) return { id: '777' };
      return {};
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(new Uint8Array([1, 2, 3]))) as typeof fetch;
    try {
      const w = new GraphMetaWriter({ token: TOKEN, fetch: m.fetch, sleep: async () => {} });
      const r = await w.createAd({
        adAccountId: '123', adSetId: '222', nome: 'a', destinoUrl: 'https://p.example/', paginaFacebookId: '1479', status: 'PAUSED',
        criativo: { angulo: 'a', textoPrincipal: 't', titulo: 'ti', tipo: 'video', imagemUrl: 'https://i.example/m.png', videoUrl: 'https://v.example/v.mp4' },
      });
      assert.deepEqual(r, { id: '777' });
    } finally {
      globalThis.fetch = originalFetch;
    }
    const video = m.chamadas.find((c) => c.url.endsWith('/advideos'))!;
    assert.equal(video.body.file_url, 'https://v.example/v.mp4');
    const cr = m.chamadas.find((c) => c.url.endsWith('/adcreatives'))!.body;
    const spec = JSON.parse(cr.object_story_spec!);
    assert.equal(spec.page_id, '1479');
    assert.equal(spec.instagram_user_id, '17841');
    assert.equal(spec.video_data.video_id, '555');
    assert.equal(spec.video_data.image_hash, 'h1');
    assert.equal(spec.video_data.call_to_action.type, 'LEARN_MORE');
    assert.equal(cr.url_tags, UTM_PADRAO);
    const feats = JSON.parse(cr.degrees_of_freedom_spec!).creative_features_spec;
    for (const f of MELHORIAS_DESLIGADAS) assert.deepEqual(feats[f], { enroll_status: 'OPT_OUT' });
    assert.deepEqual(JSON.parse(cr.contextual_multi_ads!), { enroll_status: 'OPT_OUT' });
    const ad = m.chamadas.find((c) => c.url.endsWith('/ads'))!.body;
    assert.equal(ad.status, 'PAUSED');
    assert.deepEqual(JSON.parse(ad.creative!), { creative_id: '666' });
  });

  test('leituras de status, orçamento e busca por nome', async () => {
    const m = fakeMeta((url) => {
      if (url.includes('fields=id%2Cstatus')) return { id: '9', status: 'paused' };
      if (url.includes('daily_budget')) return { id: '9', daily_budget: '1500' };
      if (url.includes('/campaigns')) return { data: [{ id: '8', name: 'NIGHT x', status: 'PAUSED' }] };
      return {};
    });
    const w = new GraphMetaWriter({ token: TOKEN, fetch: m.fetch });
    assert.equal(await w.getStatus('9'), 'PAUSED');
    assert.equal(await w.getCampaignDailyBudgetCentavos('9'), 1500);
    assert.deepEqual(await w.findCampaignByName('123', 'NIGHT x'), { id: '8', status: 'PAUSED' });
    assert.equal(await w.findCampaignByName('123', 'outra'), null);
    await assert.rejects(w.getStatus('x; drop'), /id inválido/);
  });

  test('erro da Meta vira mensagem clara e o token nunca aparece', async () => {
    const recusa = fakeMeta(() => ({ error: { code: 100, error_user_msg: `app em modo de desenvolvimento ${TOKEN}` } }));
    const w = new GraphMetaWriter({ token: TOKEN, fetch: recusa.fetch });
    const e = await w.createCampaign({ adAccountId: '123', nome: 'n', objetivo: 'OUTCOME_SALES', orcamentoDiarioCentavos: 1500, status: 'PAUSED' }).catch((x: Error) => x);
    assert.match(String(e), /a Meta recusou: app em modo de desenvolvimento/);
    assert.doesNotMatch(String(e), /EAAsegredo/);
    const expirado = new GraphMetaWriter({ token: TOKEN, fetch: fakeMeta(() => ({ error: { code: 190, message: 'expired' } })).fetch });
    await assert.rejects(expirado.getStatus('9'), /token da Meta expirou/);
    assert.throws(() => new GraphMetaWriter({ token: ' ' }), /falta o token/);
  });
});
