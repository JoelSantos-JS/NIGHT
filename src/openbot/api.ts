// Cliente da API local de automação do OpenBot (a mesma que o openbot-cli usa).
//
// - O OpenBot só abre a API quando algum agente tem "Local scripts" ligado; aí escreve `url` e `token` em
//   %APPDATA%\OpenBot\automation (ou OPENBOT_AUTOMATION_DIR). Lemos de novo a cada pedido: o OpenBot troca
//   porta e token quando reinicia.
// - O token só vai no cabeçalho Authorization: nunca em log, erro, painel ou prompt.
// - Só aceitamos URL em 127.0.0.1/localhost: um arquivo trocado não leva o token para fora do PC.

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { StatusEntrega } from './tipos.ts';

export class OpenBotFechado extends Error {}

export interface AgenteApi { id: string; name: string }
export interface EntregaApi { id: string; status: StatusEntrega; turnId?: string | null; error?: string | null; answer?: string | null }
export interface PendentesApi { prompts: unknown[]; approvals: unknown[]; browserTakeovers?: unknown[] }

export function pastaAutomacao(): string {
  if (process.env.OPENBOT_AUTOMATION_DIR) return process.env.OPENBOT_AUTOMATION_DIR;
  return path.join(process.env.APPDATA ?? path.join(homedir(), 'AppData', 'Roaming'), 'OpenBot', 'automation');
}

/** Só endereço deste PC. */
export function urlLocal(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost');
  } catch {
    return false;
  }
}

export interface OpenBotApiOpcoes {
  pasta?: string;
  /** Teste: troca o fetch. */
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class OpenBotApi {
  private readonly pasta: string;
  private readonly fetch: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: OpenBotApiOpcoes = {}) {
    this.pasta = opts.pasta ?? pastaAutomacao();
    this.fetch = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  private async alvo(): Promise<{ url: string; token: string }> {
    let url: string;
    let token: string;
    try {
      [url, token] = (await Promise.all([readFile(path.join(this.pasta, 'url'), 'utf8'), readFile(path.join(this.pasta, 'token'), 'utf8')]))
        .map((s) => s.trim()) as [string, string];
    } catch {
      throw new OpenBotFechado('O OpenBot está fechado ou nenhum agente tem "Local scripts" ligado.');
    }
    if (!urlLocal(url) || !token) throw new OpenBotFechado('O arquivo de automação do OpenBot não aponta para este PC; ignorei.');
    return { url: url.replace(/\/+$/, ''), token };
  }

  private async pedir<T>(metodo: 'GET' | 'POST', caminho: string, corpo?: object): Promise<T> {
    const { url, token } = await this.alvo();
    let r: Response;
    try {
      r = await this.fetch(url + caminho, {
        method: metodo,
        headers: { authorization: `Bearer ${token}`, ...(corpo ? { 'content-type': 'application/json' } : {}) },
        body: corpo ? JSON.stringify(corpo) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new OpenBotFechado('O OpenBot não respondeu (fechado ou reiniciando).');
    }
    const texto = await r.text();
    let dados: unknown = null;
    try { dados = texto ? JSON.parse(texto) : null; } catch { /* resposta sem JSON */ }
    if (!r.ok) {
      const msg = (dados as { error?: unknown } | null)?.error;
      const motivo = typeof msg === 'string' ? msg : typeof (msg as { message?: unknown })?.message === 'string' ? (msg as { message: string }).message : `HTTP ${r.status}`;
      if (r.status === 401 || r.status === 403) throw new OpenBotFechado('O OpenBot recusou o acesso (o token mudou); tento de novo no próximo ciclo.');
      if (r.status === 429) throw new Error('O OpenBot está no limite de mensagens por hora (30 por padrão).');
      throw new Error(`O OpenBot recusou: ${motivo.slice(0, 200)}`);
    }
    return dados as T;
  }

  async agentes(): Promise<AgenteApi[]> {
    const r = await this.pedir<unknown>('GET', '/v1/agents');
    const lista = Array.isArray(r) ? r : (r as { agents?: unknown[] } | null)?.agents ?? [];
    return lista.flatMap((a) => {
      const x = a as { id?: unknown; name?: unknown };
      return typeof x.id === 'string' ? [{ id: x.id, name: typeof x.name === 'string' ? x.name : x.id }] : [];
    });
  }

  async enviar(agenteId: string, texto: string, clientMessageId: string): Promise<{ deliveryId: string | null }> {
    const r = await this.pedir<{ deliveries?: { id?: string; recipientAgentId?: string }[] }>('POST',
      `/v1/agents/${encodeURIComponent(agenteId)}/messages`, { text: texto, clientMessageId });
    const d = r?.deliveries?.find((x) => !x.recipientAgentId || x.recipientAgentId === agenteId) ?? r?.deliveries?.[0];
    return { deliveryId: typeof d?.id === 'string' ? d.id : null };
  }

  entrega(agenteId: string, deliveryId: string): Promise<EntregaApi> {
    return this.pedir('GET', `/v1/agents/${encodeURIComponent(agenteId)}/deliveries/${encodeURIComponent(deliveryId)}`);
  }

  async pendentes(agenteId: string): Promise<PendentesApi> {
    const r = await this.pedir<Partial<PendentesApi> | null>('GET', `/v1/agents/${encodeURIComponent(agenteId)}/pending`);
    return { prompts: Array.isArray(r?.prompts) ? r.prompts : [], approvals: Array.isArray(r?.approvals) ? r.approvals : [] };
  }

  async responderAprovacao(agenteId: string, pedidoId: string, decisao: 'accept' | 'decline'): Promise<void> {
    await this.pedir('POST', `/v1/agents/${encodeURIComponent(agenteId)}/approvals/${encodeURIComponent(pedidoId)}/respond`, { decision: decisao });
  }
}
