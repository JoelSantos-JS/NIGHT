// Leitura do desempenho pelo MCP da Meta com executor falso: nenhuma rede, nenhum Claude de verdade.
// Prova que a sessão libera SÓ a ferramenta de leitura, que o JSON é validado (campanha diferente,
// número inválido) e que campo ausente fica null em vez de inventado; login e limite com aviso claro.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { ClaudeMcpMetaReader, DEFAULT_INSIGHTS_TOOL } from '../src/ads/meta-reader.ts';
import type { CliRunner } from '../src/ads/meta-writer.ts';

const dir = mkdtempSync(path.join(tmpdir(), 'night-meta-reader-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const PERIODO = { de: '2026-11-10', ate: '2026-11-16' };

function fake(result: string, code = 0) {
  const calls: string[][] = [];
  const run: CliRunner = async (_bin, args) => {
    calls.push(args);
    return { code, stdout: JSON.stringify({ result }), stderr: '' };
  };
  return { run, calls };
}

const allowed = (args: string[]) => args[args.indexOf('--allowedTools') + 1];

describe('ClaudeMcpMetaReader', () => {
  test('libera só a ferramenta de leitura e pede o período', async () => {
    const f = fake(JSON.stringify({
      campaignId: 'c1', status: 'PAUSED', gastoBRL: 45.2, impressoes: 3200, cliques: 51, ctr: 1.6, cpc: 0.885,
    }));
    const reader = new ClaudeMcpMetaReader({ workDir: dir, run: f.run, bin: 'claude' });
    const g = await reader.insights('c1', PERIODO);

    const args = f.calls[0]!;
    assert.equal(allowed(args), DEFAULT_INSIGHTS_TOOL, 'uma ferramenta só, a de leitura');
    assert.equal(args.filter((a) => a === '--allowedTools').length, 1);
    assert.ok(args.includes('--strict-mcp-config'));
    assert.match(args[1]!, /2026-11-10/);
    assert.match(args[1]!, /2026-11-16/);
    assert.match(args[1]!, /só de leitura/);
    assert.match(args[1]!, /nunca calcule venda nem lucro/);

    assert.equal(g.campaignId, 'c1');
    assert.equal(g.status, 'PAUSED');
    assert.equal(g.gastoBRL, 45.2);
    assert.equal(g.impressoes, 3200);
    assert.equal(g.cliques, 51);
    assert.equal(g.ctr, 1.6);
    assert.equal(g.cpc, 0.885);
    assert.deepEqual(g.periodo, PERIODO);
    assert.match(g.lidoEm, /^\d{4}-\d{2}-\d{2}T/);
  });

  test('campo ausente fica null (ou some), nunca vira zero', async () => {
    const f = fake(JSON.stringify({ campaignId: 'c1', gastoBRL: 10 }));
    const reader = new ClaudeMcpMetaReader({ workDir: dir, run: f.run, bin: 'claude' });
    const g = await reader.insights('c1', PERIODO);

    assert.equal(g.status, null);
    assert.equal(g.gastoBRL, 10);
    assert.equal(g.impressoes, null);
    assert.equal(g.cliques, null);
    assert.equal(g.ctr, null);
    assert.equal(g.cpc, null);
    assert.equal('alcance' in g, false, 'opcional ausente não é inventado');
    assert.equal('compras' in g, false);
  });

  test('campanha diferente da pedida é recusada', async () => {
    const f = fake(JSON.stringify({ campaignId: 'outra', gastoBRL: 10 }));
    const reader = new ClaudeMcpMetaReader({ workDir: dir, run: f.run, bin: 'claude' });
    await assert.rejects(reader.insights('c1', PERIODO), /dados da campanha outra/);
    const semId = new ClaudeMcpMetaReader({ workDir: dir, run: fake(JSON.stringify({ gastoBRL: 10 })).run, bin: 'claude' });
    await assert.rejects(semId.insights('c1', PERIODO), /não devolveu o id da campanha/);
  });

  test('número negativo ou em texto é resposta fora do formato', async () => {
    const negativo = new ClaudeMcpMetaReader({ workDir: dir, run: fake(JSON.stringify({ campaignId: 'c1', cliques: -1 })).run, bin: 'claude' });
    await assert.rejects(negativo.insights('c1', PERIODO), /"cliques" inválido/);
    const texto = new ClaudeMcpMetaReader({ workDir: dir, run: fake(JSON.stringify({ campaignId: 'c1', ctr: '1,6' })).run, bin: 'claude' });
    await assert.rejects(texto.insights('c1', PERIODO), /"ctr" inválido/);
  });

  test('login, limite, recusa da Meta e JSON inválido viram erros claros', async () => {
    const mk = (r: string, code = 0) => new ClaudeMcpMetaReader({ workDir: dir, run: fake(r, code).run, bin: 'claude' });
    await assert.rejects(mk('Please login', 1).insights('c1', PERIODO), /não está logado/);
    await assert.rejects(mk('{"error": "OAuth token expired"}').insights('c1', PERIODO), /não está logado/);
    await assert.rejects(mk('rate limit', 1).insights('c1', PERIODO), /limite de uso/);
    await assert.rejects(mk('{"error": "Permission denied: insights blocked"}').insights('c1', PERIODO), /a Meta recusou/);
    await assert.rejects(mk('não sei').insights('c1', PERIODO), /fora do formato/);
  });

  test('recusa na partida ferramenta que cria, edita, ativa ou mexe em orçamento', () => {
    for (const tool of [
      'mcp__meta-ads__ads_create_campaign',
      'mcp__meta-ads__ads_update_entity',
      'mcp__meta-ads__ads_activate_entity',
      'mcp__meta-ads__ads_set_budget',
    ]) {
      assert.throws(() => new ClaudeMcpMetaReader({ workDir: dir, bin: 'claude', tool }), /não pode ser usada/, tool);
    }
  });
});