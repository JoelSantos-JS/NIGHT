// Leitura do desempenho da campanha pelo MCP oficial da Meta (M07), no mesmo padrão do writer:
// uma sessão do Claude Code com UMA ferramenta liberada, só de leitura. O conector ainda não foi
// ligado: os testes usam um executor falso, sem rede. Aqui nada cria, ativa, edita nem gasta.
// Venda e lucro não vêm da Meta: o NIGHT só mostra o que ela devolveu, com a data da leitura.

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { findClaudeBin, runCli } from '../agents/research.ts';
import type { CliRunner } from './meta-writer.ts';

export interface InsightsPeriod {
  /** AAAA-MM-DD, inclusive. */
  de: string;
  /** AAAA-MM-DD, inclusive. */
  ate: string;
}

export interface CampaignInsights {
  campaignId: string;
  /** Status efetivo na Meta; null quando a ferramenta não mostrou. */
  status: string | null;
  /** Números ausentes ficam null: nunca são estimados nem preenchidos com zero. */
  gastoBRL: number | null;
  impressoes: number | null;
  cliques: number | null;
  /** Em porcentagem: 1.6 = 1,6%. */
  ctr: number | null;
  /** Em reais. */
  cpc: number | null;
  alcance?: number | null;
  /** Compras atribuídas pela Meta; venda real é a que o Joel informar. */
  compras?: number | null;
  periodo: InsightsPeriod;
  /** Quando o NIGHT leu os números (ISO): a Meta não atualiza na hora. */
  lidoEm: string;
}

/** O que o coordenador precisa; o executor real é o ClaudeMcpMetaReader e nos testes é falso. */
export interface MetaInsightsReader {
  insights(campaignId: string, periodo: InsightsPeriod): Promise<CampaignInsights>;
}

/** Nome no Claude Code: mcp__<servidor>__<ferramenta>. Ajustável porque o MCP ainda está em beta. */
export const DEFAULT_INSIGHTS_TOOL = 'mcp__meta-ads__ads_insights_performance_trend';

/** Ferramenta que muda algo nunca é liberada aqui: relatório é o único uso. */
const ESCRITA_RE = /create|update|activate|edit|delete|budget|status/i;

// Mesmas mensagens do meta-writer.ts (lá as regexes são privadas): login e limite têm que soar igual.
const LIMIT_RE = /usage limit|rate limit|limite de uso|quota|429|too many requests/i;
const AUTH_RE = /login|log in|oauth|unauthori[sz]ed|not authenticated|authentication|401/i;

const SEM_LOGIN = 'o conector da Meta não está logado: rode /mcp no Claude Code e faça login';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Número válido é finito e >= 0; texto, negativo ou NaN é resposta fora do formato. */
function lerNumero(rec: Record<string, unknown>, campo: string): number | null {
  const value = rec[campo];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`resposta da Meta com "${campo}" inválido: ${String(value).slice(0, 40)}`);
  }
  return value;
}

/** Valida a resposta do modelo: confere a campanha e descarta o que não é número de verdade. */
function interpretar(resposta: Record<string, unknown>, campaignId: string, periodo: InsightsPeriod): CampaignInsights {
  const devolvido = typeof resposta.campaignId === 'string' ? resposta.campaignId.trim() : '';
  if (!devolvido) throw new Error('a Meta não devolveu o id da campanha; não dá para conferir de qual campanha são os números');
  if (devolvido !== campaignId) {
    throw new Error(`a Meta devolveu dados da campanha ${devolvido.slice(0, 40)}, não da ${campaignId}`);
  }

  let status: string | null = null;
  if (resposta.status !== undefined && resposta.status !== null) {
    if (typeof resposta.status !== 'string') throw new Error('resposta da Meta com "status" inválido');
    status = resposta.status.trim() || null;
  }

  const insights: CampaignInsights = {
    campaignId,
    status,
    gastoBRL: lerNumero(resposta, 'gastoBRL'),
    impressoes: lerNumero(resposta, 'impressoes'),
    cliques: lerNumero(resposta, 'cliques'),
    ctr: lerNumero(resposta, 'ctr'),
    cpc: lerNumero(resposta, 'cpc'),
    periodo,
    lidoEm: new Date().toISOString(),
  };
  // Campo opcional só existe se veio: ausente continua ausente, nunca vira zero.
  if (resposta.alcance !== undefined) insights.alcance = lerNumero(resposta, 'alcance');
  if (resposta.compras !== undefined) insights.compras = lerNumero(resposta, 'compras');
  return insights;
}

export class ClaudeMcpMetaReader implements MetaInsightsReader {
  private readonly run: CliRunner;
  private readonly bin: string;
  private readonly tool: string;
  private readonly configFile: string;
  private readonly timeoutMs: number;

  constructor(opts: { workDir: string; run?: CliRunner; bin?: string; tool?: string; mcpUrl?: string; timeoutMs?: number }) {
    this.run = opts.run ?? runCli;
    this.bin = opts.bin ?? findClaudeBin();
    this.tool = opts.tool?.trim() || DEFAULT_INSIGHTS_TOOL;
    // O nome pode vir de env: qualquer verbo de escrita é recusado já na partida.
    if (ESCRITA_RE.test(this.tool.replace(/^mcp__[^_]+(?:-[^_]+)*__/, ''))) {
      throw new Error(`ferramenta ${this.tool} não pode ser usada na leitura: relatório não cria, edita, ativa nem mexe em orçamento`);
    }
    this.timeoutMs = opts.timeoutMs ?? 180_000;
    mkdirSync(opts.workDir, { recursive: true });
    this.configFile = path.join(opts.workDir, 'meta-ads-mcp.json');
    writeFileSync(this.configFile, JSON.stringify({ mcpServers: { 'meta-ads': { type: 'http', url: opts.mcpUrl ?? 'https://mcp.facebook.com/ads' } } }, null, 2));
  }

  async insights(campaignId: string, periodo: InsightsPeriod): Promise<CampaignInsights> {
    if (!/^[\w-]+$/.test(campaignId)) throw new Error(`id de campanha inválido: ${campaignId.slice(0, 40)}`);
    const r = await this.call(
      `Leia o desempenho da campanha ${campaignId} no período de ${periodo.de} a ${periodo.ate} (AAAA-MM-DD, inclusive nas duas pontas). ` +
      'Responda SÓ JSON: {"campaignId":"...","status":"...","gastoBRL":0,"impressoes":0,"cliques":0,"ctr":0,"cpc":0,"alcance":0,"compras":0}. ' +
      'gastoBRL e cpc em reais, ctr em porcentagem (1.6 significa 1,6%). ' +
      'Campo que a ferramenta não mostrar deve ser OMITIDO; nunca estime, nunca calcule venda nem lucro.');
    return interpretar(r, campaignId, periodo);
  }

  /** Uma sessão, uma ferramenta. Saída validada como JSON; erro de login e limite com mensagem clara. */
  private async call(pedido: string): Promise<Record<string, unknown>> {
    const prompt = [
      'Você opera o MCP oficial de anúncios da Meta em nome do NIGHT. Faça SOMENTE o pedido abaixo, com UMA chamada da ferramenta liberada.',
      'Esta sessão é só de leitura: nunca crie, edite, ative, pause, apague nem mexa em orçamento. Se a ferramenta falhar, não tente de novo: responda {"error": "<mensagem>"}.',
      'Não converta moeda, não some períodos e não estime venda ou lucro: só os números que a ferramenta mostrou.',
      pedido,
    ].join('\n');
    const args = [
      '-p', prompt,
      '--mcp-config', this.configFile, '--strict-mcp-config',
      // Mais de 200 mil tokens de ferramentas da Meta (20/11): só a busca carrega a de leitura.
      '--settings', '{"env":{"ENABLE_TOOL_SEARCH":"true"}}',
      '--allowedTools', this.tool, 'ToolSearch',
      '--disallowedTools', 'Bash', 'Edit', 'Write', 'WebFetch', 'WebSearch',
      '--permission-mode', 'default',
      '--output-format', 'json', '--no-session-persistence',
    ];
    const r = await this.run(this.bin, args, path.dirname(this.configFile), this.timeoutMs);
    const saida = `${r.stdout}\n${r.stderr}`;
    if (r.code !== 0) {
      if (AUTH_RE.test(saida)) throw new Error(SEM_LOGIN);
      if (LIMIT_RE.test(saida)) throw new Error('limite de uso atingido; tente mais tarde (o NIGHT não repete sozinho)');
      throw new Error(`a sessão da Meta falhou (código ${r.code}): ${saida.trim().slice(-300)}`);
    }
    let texto = '';
    try { texto = String((JSON.parse(r.stdout) as { result?: unknown }).result ?? ''); } catch { texto = r.stdout; }
    const bruto = /```(?:json)?\s*([\s\S]*?)```/.exec(texto)?.[1] ?? /\{[\s\S]*\}/.exec(texto)?.[0] ?? '';
    let obj: unknown;
    try { obj = JSON.parse(bruto); } catch { throw new Error(`resposta da Meta fora do formato: ${texto.slice(0, 200)}`); }
    if (!isRecord(obj)) throw new Error('resposta da Meta fora do formato');
    if (typeof obj.error === 'string') {
      if (AUTH_RE.test(obj.error)) throw new Error(SEM_LOGIN);
      throw new Error(`a Meta recusou: ${obj.error.slice(0, 300)}`);
    }
    return obj;
  }
}