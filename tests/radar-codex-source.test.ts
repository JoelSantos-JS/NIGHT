// Fonte do Radar pelo Codex: só a busca de leitura da Meta vale, e os números são conferidos na resposta crua.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { CodexMcpAdSource, lerCodexMeta } from '../src/radar/codex-mcp-source.ts';

const evento = (item: Record<string, unknown>) => JSON.stringify({ type: 'item.completed', item });
const meta = (dados: unknown) => evento({ type: 'mcp_tool_call', server: 'meta-ads', tool: 'ads_library_search',
  result: { content: [{ type: 'text', text: JSON.stringify(dados) }] } });

describe('fonte Codex do Radar', () => {
  test('ferramenta fora da busca de leitura derruba a sessão', () => {
    const jsonl = evento({ type: 'mcp_tool_call', server: 'meta-ads', tool: 'ads_create_campaign', result: {} });
    assert.throws(() => lerCodexMeta(jsonl), /fora da busca de leitura/);
  });

  test('sem chamada à Meta não pontua nada', async () => {
    const fonte = new CodexMcpAdSource({ workDir: 'nao-usado-pelo-run-falso', bin: 'codex-falso', pdfClassifier: async () => null,
      run: async () => ({ code: 0, stdout: evento({ type: 'agent_message', text: '{"termo":"x"}' }), stderr: '' }) });
    await assert.rejects(fonte.nicheScan('x'), /não conseguiu consultar a Meta/);
  });

  test('total que a Meta não mostrou é recusado', async () => {
    const bruto = meta({ estimated_total_count: 88, results: JSON.stringify([{ id: '11', page_id: '101' }]) });
    const resposta = evento({ type: 'agent_message', text: JSON.stringify({ termo: 'x', estimatedTotal: 7777, ads: [], paginas: [] }) });
    const fonte = new CodexMcpAdSource({ workDir: 'nao-usado-pelo-run-falso', bin: 'codex-falso', pdfClassifier: async () => null,
      run: async () => ({ code: 0, stdout: [bruto, resposta].join('\n'), stderr: '' }) });
    await assert.rejects(fonte.nicheScan('x'), /7777 não aparece/);
  });
});
