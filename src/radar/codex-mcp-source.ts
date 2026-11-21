// Fonte do Radar pelo Codex com somente ads_library_search habilitada no MCP da Meta.
// Os resultados da ferramenta são guardados separadamente da resposta do modelo para validação.
import { mkdir } from 'node:fs/promises';
import type { AdSource } from './collect.ts';
import { findCodexBin, runCli } from '../agents/research.ts';
import {
  deepSeekPdfClassifier, interpretarNicheScan, nicheScanPrompt, RespostaCrua,
  type MetaMcpRun, type NicheScanResult, type PdfClassifier,
} from './meta-mcp-source.ts';

export interface CodexMcpAdSourceOptions {
  workDir: string;
  country?: string;
  bin?: string;
  model?: string;
  timeoutMs?: number;
  pdfClassifier?: PdfClassifier;
  run?: MetaMcpRun;
}

type Evento = { type?: unknown; item?: { type?: unknown; server?: unknown; tool?: unknown; result?: unknown; error?: unknown; text?: unknown } };

function dadosDaMeta(result: unknown): string {
  if (!result || typeof result !== 'object') return '';
  const r = result as { structured_content?: unknown; content?: { type?: unknown; text?: unknown }[] };
  if (r.structured_content && typeof r.structured_content === 'object') return JSON.stringify(r.structured_content);
  return Array.isArray(r.content) ? r.content.filter((c) => c?.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text as string).join('\n') : '';
}

/** Aceita apenas saídas de chamadas bem-sucedidas da ferramenta de leitura. */
export function lerCodexMeta(jsonl: string): { resposta: string; bruto: string; chamadas: number } {
  const brutos: string[] = [];
  let resposta = '';
  let chamadas = 0;
  for (const line of jsonl.split(/\r?\n/)) {
    let e: Evento;
    try { e = JSON.parse(line) as Evento; } catch { continue; }
    if (e.type !== 'item.completed' || !e.item) continue;
    if (e.item.type === 'agent_message' && typeof e.item.text === 'string') resposta = e.item.text;
    if (e.item.type !== 'mcp_tool_call') continue;
    if (e.item.server !== 'meta-ads' || e.item.tool !== 'ads_library_search') {
      throw new Error('Codex tentou usar uma ferramenta da Meta fora da busca de leitura');
    }
    if (e.item.error) throw new Error('busca da Meta falhou no Codex');
    const bruto = dadosDaMeta(e.item.result);
    if (bruto) { brutos.push(bruto); chamadas++; }
  }
  return { resposta, bruto: brutos.join('\n'), chamadas };
}

export class CodexMcpAdSource implements AdSource {
  readonly name = 'meta-ads-mcp';
  private readonly bin: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly country: string;
  private readonly classifier: PdfClassifier;
  private readonly run: MetaMcpRun;

  constructor(private readonly opts: CodexMcpAdSourceOptions) {
    const bin = opts.bin ?? findCodexBin();
    if (!bin) throw new Error('Codex CLI não encontrado para a pesquisa do Radar');
    this.bin = bin;
    this.model = opts.model ?? process.env.NIGHT_RADAR_CODEX_MODEL ?? 'gpt-6-sol';
    this.timeoutMs = opts.timeoutMs ?? 360_000;
    this.country = opts.country ?? 'BR';
    this.classifier = opts.pdfClassifier ?? deepSeekPdfClassifier();
    this.run = opts.run ?? runCli;
  }

  // collect() usa nicheScan quando a fonte o oferece. O caminho de cursor não existe nesta fonte.
  async search(): Promise<never> {
    throw new Error('a fonte Codex do Radar usa busca por nicho, sem cursor');
  }

  async nicheScan(termo: string): Promise<NicheScanResult> {
    await mkdir(this.opts.workDir, { recursive: true });
    const prompt = `${nicheScanPrompt(termo, this.country)}\nUse somente a ferramenta ads_library_search do servidor meta-ads. Se ela não estiver disponível, explique a falha; não invente dados.`;
    const args = [
      'exec', '--json', '--ephemeral', '--sandbox', 'read-only', '--skip-git-repo-check',
      '--strict-config', '--model', this.model,
      '-c', "mcp_servers.meta-ads.enabled_tools=['ads_library_search']",
      '-c', 'mcp_servers.meta-ads.startup_timeout_sec=120',
      '-c', 'mcp_servers.meta-ads.tool_timeout_sec=180',
      '-C', this.opts.workDir, prompt,
    ];
    const r = await this.run(this.bin, args, this.opts.workDir, this.timeoutMs);
    if (r.code !== 0) throw new Error(`Codex CLI falhou (código ${r.code}): ${(r.stderr || r.stdout).slice(0, 300)}`);
    const lido = lerCodexMeta(r.stdout);
    if (lido.chamadas === 0) throw new Error(`Codex não conseguiu consultar a Meta: ${lido.resposta.slice(0, 200)}`);
    return interpretarNicheScan(lido.resposta, termo, this.country, this.classifier, new RespostaCrua(lido.bruto));
  }
}
