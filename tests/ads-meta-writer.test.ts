// Adaptador real do MCP da Meta com um executor falso: nenhuma rede, nenhum Claude de verdade.
// Prova que cada etapa libera UMA ferramenta, que ferramentas de status/orçamento são recusadas
// que o pedido segue o teste de criativo (CBO, pixel, público, posicionamentos, UTMs, sem Advantage+)
// e que a saída do modelo é validada (id inválido, erro de login e recusa da Meta).

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { UTM_PADRAO } from '../src/ads/campaign.ts';
import { ClaudeMcpMetaWriter, type CliRunner } from '../src/ads/meta-writer.ts';

const dir = mkdtempSync(path.join(tmpdir(), 'night-meta-'));
after(() => rmSync(dir, { recursive: true, force: true }));

function fake(result: string, code = 0) {
  const calls: string[][] = [];
  const run: CliRunner = async (_bin, args) => {
    calls.push(args);
    return { code, stdout: JSON.stringify({ result }), stderr: '' };
  };
  return { run, calls };
}

const allowed = (args: string[]) => args[args.indexOf('--allowedTools') + 1];

describe('ClaudeMcpMetaWriter', () => {
  test('criar campanha libera só a ferramenta de criar campanha, pede PAUSED e põe o orçamento na campanha (CBO)', async () => {
    const f = fake('{"id": "120000001"}');
    const w = new ClaudeMcpMetaWriter({ workDir: dir, run: f.run, bin: 'claude' });
    assert.deepEqual(await w.createCampaign({
      adAccountId: 'act_1', nome: 'NIGHT abc · X', objetivo: 'OUTCOME_SALES', orcamentoDiarioCentavos: 1500, status: 'PAUSED',
    }), { id: '120000001' });
    const args = f.calls[0]!;
    assert.equal(allowed(args), 'mcp__meta-ads__ads_create_campaign');
    assert.ok(args.includes('--strict-mcp-config'));
    const p = args[1]!;
    assert.match(p, /status PAUSED/);
    assert.match(p, /Nunca ative/);
    assert.match(p, /OUTCOME_SALES/);
    assert.match(p, /orçamento diário NA CAMPANHA/);
    assert.match(p, /CBO/);
    assert.match(p, /1500 centavos/);
    assert.match(p, /campo daily_budget = 1500 \(unidade mínima da moeda, ou seja 1500 centavos = R\$ 15\.00\)/);
    assert.match(p, /LOWEST_COST_WITHOUT_CAP/);
  });

  test('todo pedido manda não criar nada diferente se um campo não for aceito', async () => {
    const f = fake('{"id": "5"}');
    const w = new ClaudeMcpMetaWriter({ workDir: dir, run: f.run, bin: 'claude' });
    await w.createCampaign({ adAccountId: 'act_1', nome: 'n', objetivo: 'OUTCOME_SALES', orcamentoDiarioCentavos: 1500, status: 'PAUSED' });
    await w.createAdSet({
      adAccountId: 'act_1', campaignId: '1', nome: 'c', status: 'PAUSED',
      publico: { pais: 'BR', idadeMin: 18, idadeMax: 65, generos: 'todos', descricao: 'x' }, pixelId: '1234567890', inicio: null,
    });
    await w.createAd({
      adAccountId: 'act_1', adSetId: '2', nome: 'a', destinoUrl: 'https://p.example/r', status: 'PAUSED', paginaFacebookId: '9876543210',
      criativo: { angulo: 'a', textoPrincipal: 't', titulo: 'ti', tipo: 'imagem', imagemUrl: 'https://i.example/x.png', videoUrl: null },
    });
    assert.equal(f.calls.length, 3);
    for (const args of f.calls) {
      assert.match(args[1]!, /Se algum campo pedido não for aceito/);
      assert.match(args[1]!, /NÃO crie nada diferente do pedido/);
      assert.match(args[1]!, /responda \{"error"/);
    }
  });

  test('orçamento da campanha inválido é recusado antes de abrir a sessão', async () => {
    const f = fake('{"id": "1"}');
    const w = new ClaudeMcpMetaWriter({ workDir: dir, run: f.run, bin: 'claude' });
    for (const v of [0, -100, 12.5, Number.NaN]) {
      await assert.rejects(w.createCampaign({ adAccountId: 'act_1', nome: 'n', objetivo: 'OUTCOME_SALES', orcamentoDiarioCentavos: v, status: 'PAUSED' }), /orçamento da campanha inválido/);
    }
    assert.equal(f.calls.length, 0);
  });

  test('conjunto sem orçamento, compra no pixel, público fixo, posicionamentos manuais e início', async () => {
    const f = fake('```json\n{"id": "2"}\n```');
    const w = new ClaudeMcpMetaWriter({ workDir: dir, run: f.run, bin: 'claude' });
    assert.deepEqual(await w.createAdSet({
      adAccountId: 'act_1', campaignId: '1', nome: 'c', status: 'PAUSED',
      publico: { pais: 'BR', idadeMin: 25, idadeMax: 55, generos: 'mulheres', descricao: 'mães que trabalham' },
      pixelId: '1234567890', inicio: '2026-11-25T00:00:00-03:00',
    }), { id: '2' });
    const args = f.calls[0]!;
    assert.equal(allowed(args), 'mcp__meta-ads__ads_create_ad_set');
    const p = args[1]!;
    assert.match(p, /status PAUSED/);
    assert.match(p, /SEM orçamento no conjunto/);
    assert.doesNotMatch(p, /\d+ centavos/);
    assert.match(p, /OFFSITE_CONVERSIONS/);
    assert.match(p, /pixel 1234567890/);
    assert.match(p, /PURCHASE/);
    assert.match(p, /advantage_audience = 0/);
    assert.match(p, /idade 25 a 55/);
    assert.match(p, /genders \[2\]/);
    assert.match(p, /país BR/);
    assert.match(p, /posicionamentos MANUAIS/);
    assert.match(p, /facebook_positions \["feed"\]/);
    assert.match(p, /instagram_positions \["stream","reels"\]/);
    assert.match(p, /start_time/);
    assert.match(p, /2026-11-25T00:00:00-03:00/);
  });

  test('conjunto para todos e sem início marcado não manda genders nem start_time', async () => {
    const f = fake('{"id": "2"}');
    const w = new ClaudeMcpMetaWriter({ workDir: dir, run: f.run, bin: 'claude' });
    await w.createAdSet({
      adAccountId: 'act_1', campaignId: '1', nome: 'c', status: 'PAUSED',
      publico: { pais: 'BR', idadeMin: 18, idadeMax: 65, generos: 'todos', descricao: 'x' }, pixelId: '1234567890', inicio: null,
    });
    const p = f.calls[0]![1]!;
    assert.match(p, /sem campo genders/);
    assert.doesNotMatch(p, /genders \[/);
    assert.doesNotMatch(p, /start_time/);
    await w.createAdSet({
      adAccountId: 'act_1', campaignId: '1', nome: 'c', status: 'PAUSED',
      publico: { pais: 'BR', idadeMin: 18, idadeMax: 65, generos: 'homens', descricao: 'x' }, pixelId: '1234567890', inicio: null,
    });
    assert.match(f.calls[1]![1]!, /genders \[1\]/);
  });

  test('anúncio de imagem leva página, imagem, LEARN_MORE, UTMs e desliga Advantage+ e contextual_multi_ads', async () => {
    const f = fake('{"id": "3"}');
    const w = new ClaudeMcpMetaWriter({ workDir: dir, run: f.run, bin: 'claude' });
    await w.createAd({
      adAccountId: 'act_1', adSetId: '2', nome: 'a', destinoUrl: 'https://p.example/r', status: 'PAUSED', paginaFacebookId: '9876543210',
      criativo: { angulo: 'a', textoPrincipal: 't', titulo: 'ti', tipo: 'imagem', imagemUrl: 'https://i.example/x.png', videoUrl: null },
    });
    const args = f.calls[0]!;
    assert.equal(allowed(args), 'mcp__meta-ads__ads_create_ad');
    const p = args[1]!;
    assert.match(p, /status PAUSED/);
    assert.match(p, /página do Facebook 9876543210/);
    assert.match(p, /imagem da URL https:\/\/i\.example\/x\.png/);
    assert.doesNotMatch(p, /vídeo da URL/);
    assert.match(p, /https:\/\/p\.example\/r/);
    assert.match(p, /LEARN_MORE/);
    assert.ok(p.includes(JSON.stringify(UTM_PADRAO)), 'url_tags exatamente o padrão');
    assert.match(p, /url_tags/);
    assert.match(p, /OPT_OUT/);
    assert.match(p, /contextual_multi_ads OPT_OUT/);
  });

  test('anúncio de vídeo leva a URL do vídeo e a da miniatura', async () => {
    const f = fake('{"id": "4"}');
    const w = new ClaudeMcpMetaWriter({ workDir: dir, run: f.run, bin: 'claude' });
    await w.createAd({
      adAccountId: 'act_1', adSetId: '2', nome: 'a', destinoUrl: 'https://p.example/r', status: 'PAUSED', paginaFacebookId: '9876543210',
      criativo: {
        angulo: 'a', textoPrincipal: 't', titulo: 'ti', tipo: 'video',
        imagemUrl: 'https://i.example/mini.jpg', videoUrl: 'https://v.example/v1.mp4',
      },
    });
    const p = f.calls[0]![1]!;
    assert.match(p, /vídeo da URL https:\/\/v\.example\/v1\.mp4 com miniatura da URL https:\/\/i\.example\/mini\.jpg/);
    assert.match(p, /LEARN_MORE/);
    assert.match(p, /contextual_multi_ads OPT_OUT/);
  });

  test('recusa configurar ferramenta que ativa, edita status ou orçamento', () => {
    assert.throws(() => new ClaudeMcpMetaWriter({ workDir: dir, bin: 'claude', tools: { createCampaign: 'mcp__meta-ads__ads_activate_entity' } }), /não pode ser usada/);
    assert.throws(() => new ClaudeMcpMetaWriter({ workDir: dir, bin: 'claude', tools: { createAd: 'mcp__meta-ads__ads_update_entity' } }), /não pode ser usada/);
    assert.throws(() => new ClaudeMcpMetaWriter({ workDir: dir, bin: 'claude', tools: { readEntities: 'mcp__meta-ads__ads_create_ad' } }), /não pode ser usada/);
  });

  test('busca por nome e leitura de status', async () => {
    const w1 = new ClaudeMcpMetaWriter({ workDir: dir, run: fake('{"found": false}').run, bin: 'claude' });
    assert.equal(await w1.findCampaignByName('act_1', 'x'), null);
    const w2 = new ClaudeMcpMetaWriter({ workDir: dir, run: fake('{"id": "9", "status": "paused"}').run, bin: 'claude' });
    assert.equal(await w2.getStatus('9'), 'PAUSED');
    const w3 = new ClaudeMcpMetaWriter({ workDir: dir, run: fake('{"id": "9", "daily_budget_centavos": 2000}').run, bin: 'claude' });
    assert.equal(await w3.getCampaignDailyBudgetCentavos('9'), 2000);
    const f3 = fake('{"id": "9", "daily_budget_centavos": 2000}');
    await new ClaudeMcpMetaWriter({ workDir: dir, run: f3.run, bin: 'claude' }).getCampaignDailyBudgetCentavos('9');
    assert.match(f3.calls[0]![1]!, /daily_budget/);
    assert.match(f3.calls[0]![1]!, /sem converter/);
    assert.match(f3.calls[0]![1]!, /Se algum campo pedido não for aceito/);
    await assert.rejects(w2.getStatus('outro'), /outro id/);
    await assert.rejects(w3.getCampaignDailyBudgetCentavos('outro'), /conferir o orçamento/);
  });

  test('id inválido, recusa da Meta, falta de login e limite viram erros claros', async () => {
    const mk = (r: string, code = 0) => new ClaudeMcpMetaWriter({ workDir: dir, run: fake(r, code).run, bin: 'claude' });
    const camp = { adAccountId: 'act_1', nome: 'n', objetivo: 'OUTCOME_SALES', orcamentoDiarioCentavos: 2000, status: 'PAUSED' as const };
    await assert.rejects(mk('{"id": "x; drop"}').createCampaign(camp), /id válido/);
    await assert.rejects(mk('{"error": "Permission denied: create campaigns blocked"}').createCampaign(camp), /a Meta recusou/);
    await assert.rejects(mk('{"error": "OAuth token expired"}').createCampaign(camp), /não está logado/);
    await assert.rejects(mk('Please login', 1).createCampaign(camp), /não está logado/);
    await assert.rejects(mk('rate limit', 1).createCampaign(camp), /limite de uso/);
    await assert.rejects(mk('não sei').createCampaign(camp), /fora do formato/);
  });
});
