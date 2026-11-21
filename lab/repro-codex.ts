// Teste 21/11: uma busca do Radar pela fonte Codex, fora do servidor, guardando a saída crua.
// Uso: node --import tsx lab/repro-codex.ts "apenas R$ 19,90"
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { findCodexBin, runCli } from '../src/agents/research.ts';
import { CodexMcpAdSource } from '../src/radar/codex-mcp-source.ts';

const termo = process.argv[2] ?? 'apenas R$ 19,90';
const saida = process.env.REPRO_OUT ?? 'repro-codex-saida.txt';
const fonte = new CodexMcpAdSource({
  workDir: join('D:', 'NIGHT-data', 'meta-mcp'),
  bin: findCodexBin() ?? undefined,
  pdfClassifier: async () => null,
  timeoutMs: 600_000,
  run: async (bin, args, cwd, ms) => {
    const r = await runCli(bin, args, cwd, ms);
    await writeFile(saida, `code=${r.code}\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}\n`, 'utf8');
    return r;
  },
});
const t0 = Date.now();
try {
  const r = await fonte.nicheScan(termo);
  console.log(JSON.stringify({ total: r.estimatedTotal, anunciantes: r.anunciantesNoNicho,
    ads: r.ads.map((a) => ({ quem: a.advertiser, ativos: a.activeAdsInDomain, preco: a.precoOrigem, inicio: a.startedAt, titulos: a.titulos })),
    observacoes: r.observacoes }, null, 1));
} catch (err) {
  console.log('ERRO:', (err as Error).message);
}
console.log('levou', Math.round((Date.now() - t0) / 1000), 's; saída crua em', saida);
