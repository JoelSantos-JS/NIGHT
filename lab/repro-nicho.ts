// Teste 21/11: roda a busca de UM nicho do Radar fora do servidor e guarda a saída crua do Claude CLI.
// Uso: node --import tsx lab/repro-nicho.ts "low ticket"
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runCli } from '../src/agents/research.ts';
import { MetaMcpAdSource } from '../src/radar/meta-mcp-source.ts';

const termo = process.argv[2] ?? 'low ticket';
const saida = process.env.REPRO_OUT ?? 'repro-nicho-saida.txt';
const fonte = new MetaMcpAdSource({
  readTools: (process.env.NIGHT_META_READ_TOOLS ?? 'mcp__meta-ads__ads_library_search').split(','),
  workDir: join(process.env.NIGHT_DATA ?? 'D:\\NIGHT-data', 'meta-mcp'),
  pdfClassifier: async () => null,
  timeoutMs: Number(process.env.REPRO_TIMEOUT ?? 600_000),
  run: async (bin, args, cwd, timeoutMs) => {
    const r = await runCli(bin, args, cwd, timeoutMs, { MCP_TIMEOUT: '120000' });
    await writeFile(saida, `code=${r.code}\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}\n`, 'utf8');
    return r;
  },
});
const t0 = Date.now();
try {
  const r = await fonte.nicheScan(termo);
  console.log(JSON.stringify({ estimatedTotal: r.estimatedTotal, anunciantes: r.anunciantesNoNicho, ads: r.ads.length, observacoes: r.observacoes }, null, 1));
} catch (err) {
  console.log('ERRO:', (err as Error).message);
}
console.log("levou", Math.round((Date.now() - t0) / 1000), "s; saída crua em", saida);
