// Adaptador real do MCP da Meta com um executor falso: nenhuma rede, nenhum Claude de verdade.
// Prova que cada etapa libera UMA ferramenta, que ferramentas de status/orçamento são recusadas
// e que a saída do modelo é validada (id inválido, erro de login e recusa da Meta).

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
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
  test('criar campanha libera só a ferramenta de criar campanha e pede PAUSED', async () => {
    const f = fake('{"id": "120000001"}');
    const w = new ClaudeMcpMetaWriter({ workDir: dir, run: f.run, bin: 'claude' });
    assert.deepEqual(await w.createCampaign({ adAccountId: 'act_1', nome: 'NIGHT abc · X', objetivo: 'OUTCOME_SALES', status: 'PAUSED' }), { id: '120000001' });
    const args = f.calls[0]!;
    assert.equal(allowed(args), 'mcp__meta-ads__ads_create_campaign');
    assert.ok(args.includes('--strict-mcp-config'));
    assert.match(args[1]!, /status PAUSED/);
    assert.match(args[1]!, /Nunca ative/);
  });

  test('conjunto leva o orçamento aprovado em centavos e anúncio leva a URL', async () => {
    const f = fake('```json\n{"id": "2"}\n```');
    const w = new ClaudeMcpMetaWriter({ workDir: dir, run: f.run, bin: 'claude' });
    await w.createAdSet({ adAccountId: 'act_1', campaignId: '1', nome: 'c', orcamentoDiarioCentavos: 2000, publico: { pais: 'BR', idadeMin: 18, idadeMax: 65, descricao: 'x' }, status: 'PAUSED' });
    assert.match(f.calls[0]![1]!, /2000 centavos/);
    await w.createAd({ adAccountId: 'act_1', adSetId: '2', nome: 'a', destinoUrl: 'https://p', status: 'PAUSED', criativo: { angulo: 'a', textoPrincipal: 't', titulo: 'ti', imagemUrl: 'https://i/x.png' } });
    assert.equal(allowed(f.calls[1]!), 'mcp__meta-ads__ads_create_ad');
    assert.match(f.calls[1]![1]!, /https:\/\/i\/x\.png/);
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
    assert.equal(await w3.getAdSetDailyBudgetCentavos('9'), 2000);
    await assert.rejects(w2.getStatus('outro'), /outro id/);
    await assert.rejects(w3.getAdSetDailyBudgetCentavos('outro'), /conferir o orçamento/);
  });

  test('id inválido, recusa da Meta, falta de login e limite viram erros claros', async () => {
    const mk = (r: string, code = 0) => new ClaudeMcpMetaWriter({ workDir: dir, run: fake(r, code).run, bin: 'claude' });
    const camp = { adAccountId: 'act_1', nome: 'n', objetivo: 'OUTCOME_SALES', status: 'PAUSED' as const };
    await assert.rejects(mk('{"id": "x; drop"}').createCampaign(camp), /id válido/);
    await assert.rejects(mk('{"error": "Permission denied: create campaigns blocked"}').createCampaign(camp), /a Meta recusou/);
    await assert.rejects(mk('{"error": "OAuth token expired"}').createCampaign(camp), /não está logado/);
    await assert.rejects(mk('Please login', 1).createCampaign(camp), /não está logado/);
    await assert.rejects(mk('rate limit', 1).createCampaign(camp), /limite de uso/);
    await assert.rejects(mk('não sei').createCampaign(camp), /fora do formato/);
  });
});
