// Voz ao vivo: a voz da OpenAI pelo login do ChatGPT do Joel, por um processo do Codex (`codex app-server`).
//
// Como funciona (mesmo tipo de conexão que o OpenBot usa; código nosso):
// - O painel cria a conexão WebRTC e manda a oferta (SDP). Aqui, um Codex sem ferramentas abre a voz da
//   OpenAI e devolve a resposta (SDP). O ÁUDIO vai direto do navegador para a OpenAI; o NIGHT não o vê.
// - A voz entrega cada pedido falado a uma "ponte" (um modelo pequeno do Codex), que só pode chamar uma
//   ferramenta: pedir_ao_night. O NIGHT responde e a voz fala a resposta.
// - O pedido passa por modelos da OpenAI antes de chegar aqui, então entra com origem 'tela': aprovar,
//   cancelar e campanha com R$ devolvem o link do painel, nunca executam pela voz ao vivo.
// - A ponte não tem shell, arquivos, internet nem MCP do Joel: tudo desligado no thread/start, e ela roda
//   numa pasta temporária vazia, só leitura, sem aprovações.
// - Tudo o que vai para a OpenAI passa por redactKeyLike antes.

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { findCodexBin, redactKeyLike } from '../agents/research.ts';
import { forSpeech } from './coordinator.ts';

/** O que a voz ao vivo pede ao NIGHT. `depois` = resposta que chega mais tarde (pesquisa). */
export interface RespostaNight { texto: string; depois?: Promise<string> }

export interface VozAoVivoDeps {
  pedir(texto: string): Promise<RespostaNight>;
  /** Cria o processo do Codex (o de verdade ou um falso nos testes). */
  criarCliente?: () => RpcCliente;
  /** Voz da OpenAI (alloy, marin, cedar...). Vazio = a OpenAI escolhe. */
  voz?: string;
  /** Quanto a ponte espera o NIGHT antes de dizer "ainda estou trabalhando". */
  esperaMs?: number;
  /** Quanto espera a OpenAI responder a oferta. */
  esperaSdpMs?: number;
  /** Sem o painel perguntar pelos eventos por esse tempo, a voz desliga (aba fechada ou travada). */
  prazoSemPainelMs?: number;
}

export type EventoVoz =
  | { n: number; tipo: 'transcricao'; papel: 'voce' | 'night'; texto: string }
  | { n: number; tipo: 'pedido'; texto: string }
  | { n: number; tipo: 'resposta'; texto: string }
  | { n: number; tipo: 'fim'; erro: string | null };

type DistEventoVoz = EventoVoz extends infer E ? E extends EventoVoz ? Omit<E, 'n'> : never : never;

// ---------- JSON-RPC com o processo do Codex (uma mensagem JSON por linha) ----------

export interface RpcMensagem { id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { code?: number; message?: string } }

export interface RpcCliente {
  iniciar(): void;
  pedir(method: string, params: object, timeoutMs?: number): Promise<Record<string, unknown>>;
  avisar(method: string, params?: object): void;
  responder(id: number | string, result: object): void;
  responderErro(id: number | string, code: number, message: string): void;
  /** 'notificacao' (msg sem id), 'pedido' (o Codex pedindo algo a nós) e 'saiu'. */
  on(evento: 'notificacao' | 'pedido', fn: (m: RpcMensagem) => void): void;
  on(evento: 'saiu', fn: (motivo: string) => void): void;
  parar(): void;
}

export class CodexRpc extends EventEmitter implements RpcCliente {
  private proc: ChildProcess | null = null;
  private seq = 0;
  private readonly pendentes = new Map<number, { ok: (r: Record<string, unknown>) => void; falha: (e: Error) => void; timer: NodeJS.Timeout }>();

  constructor(private readonly bin: string, private readonly cwd: string) { super(); }

  iniciar(): void {
    const proc = spawn(this.bin, ['app-server'], { cwd: this.cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.proc = proc;
    proc.stderr?.resume(); // o log do Codex pode ter dados da conta: não vai para a tela
    readline.createInterface({ input: proc.stdout! }).on('line', (linha) => this.receber(linha));
    proc.on('error', (err) => this.encerrar(`não abri o Codex: ${err.message}`));
    proc.on('exit', (code) => this.encerrar(`o processo do Codex saiu (código ${code})`));
  }

  private receber(linha: string): void {
    let m: RpcMensagem;
    try { m = JSON.parse(linha) as RpcMensagem; } catch { return; }
    if (m.id !== undefined && m.method === undefined) {
      const p = this.pendentes.get(Number(m.id));
      if (!p) return;
      this.pendentes.delete(Number(m.id));
      clearTimeout(p.timer);
      if (m.error) p.falha(new Error(m.error.message ?? 'erro do Codex'));
      else p.ok((m.result ?? {}) as Record<string, unknown>);
      return;
    }
    if (m.method) this.emit(m.id !== undefined ? 'pedido' : 'notificacao', m);
  }

  private escrever(m: object): void {
    if (this.proc?.stdin?.writable) this.proc.stdin.write(`${JSON.stringify(m)}\n`);
  }

  pedir(method: string, params: object, timeoutMs = 30_000): Promise<Record<string, unknown>> {
    const id = ++this.seq;
    return new Promise((ok, falha) => {
      const timer = setTimeout(() => { this.pendentes.delete(id); falha(new Error(`o Codex não respondeu ${method}`)); }, timeoutMs);
      this.pendentes.set(id, { ok, falha, timer });
      this.escrever({ id, method, params });
    });
  }

  avisar(method: string, params?: object): void { this.escrever(params ? { method, params } : { method }); }
  responder(id: number | string, result: object): void { this.escrever({ id, result }); }
  responderErro(id: number | string, code: number, message: string): void { this.escrever({ id, error: { code, message } }); }

  private encerrar(motivo: string): void {
    if (!this.proc) return;
    this.proc = null;
    for (const p of this.pendentes.values()) { clearTimeout(p.timer); p.falha(new Error(motivo)); }
    this.pendentes.clear();
    this.emit('saiu', motivo);
  }

  parar(): void {
    const proc = this.proc;
    if (!proc) return;
    this.proc = null;
    for (const p of this.pendentes.values()) { clearTimeout(p.timer); p.falha(new Error('voz desligada')); }
    this.pendentes.clear();
    proc.kill();
  }
}

/**
 * Codex para a voz ao vivo: NIGHT_CODEX_LIVE_BIN; senão o mais novo que o OpenBot baixou (oficial da OpenAI,
 * >= 0.156, que entrega o resultado da ferramenta direto à ponte); senão o da extensão do VS Code.
 */
export function findCodexLiveBin(): string | null {
  if (process.env.NIGHT_CODEX_LIVE_BIN) return process.env.NIGHT_CODEX_LIVE_BIN;
  const base = path.join(process.env.APPDATA ?? path.join(homedir(), 'AppData', 'Roaming'), 'OpenBot', 'provider-runtimes', 'codex', 'win32-x64');
  if (existsSync(base)) {
    const versoes = readdirSync(base).filter((v) => /^\d+\.\d+\.\d+$/.test(v) && compararVersao(v, '0.156.0') >= 0)
      .sort(compararVersao).reverse();
    for (const v of versoes) {
      const bin = path.join(base, v, 'bin', 'codex.exe');
      if (existsSync(bin)) return bin;
    }
  }
  return findCodexBin();
}

export function compararVersao(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

// ---------- A sessão de voz ----------

const NAMESPACE = 'night';
const FERRAMENTA = 'pedir_ao_night';
/** A ponte do Codex entrega à voz no máximo uns 4 KB; resposta longa vai resumida. */
const LIMITE_FALA_BYTES = 600;
const MARCA_LONGA = '[resposta longa]';
const MAX_EVENTOS = 200;
/** O resultado da ferramenta vai inteiro para a ponte: além disso é cortado (o painel tem o texto todo). */
const MAX_RESULTADO_BYTES = 3_500;
const PRAZO_SEM_PAINEL_MS = 30_000;
const MAX_PEDIDOS_MINUTO = 8;

const INSTRUCOES_PONTE = 'Você só repassa pedidos. Para cada pedido do usuário, chame pedir_ao_night uma vez, com o pedido '
  + 'exatamente como ele falou. Nunca responda por conta própria. O resultado da ferramenta é a resposta do NIGHT, e uma voz '
  + `vai falar a sua resposta. Se a primeira linha do resultado for ${MARCA_LONGA}, responda com um resumo de no máximo 80 `
  + 'palavras, no idioma da resposta, só com fatos dela, em frases simples, e termine dizendo que o resto está no painel. '
  + 'Sem essa marca, responda com o resultado inteiro, palavra por palavra.';

/** Primeira mensagem para a voz: quem ela é e que tudo vai para o NIGHT. A voz lê como se fosse do usuário. */
const REGRA_VOZ = 'Você é a voz do NIGHT, o assistente do Joel. Quando eu perguntar quem você é, você é o NIGHT. Nunca diga que '
  + 'é o ChatGPT, o Codex ou outro assistente da OpenAI. A partir de agora, entregue todo pedido meu ao agente de fundo, até '
  + 'perguntas simples e conversa à toa. Se eu parar no meio de uma frase para pensar, espere em silêncio pelo resto e entregue '
  + 'o pedido inteiro de uma vez. Nunca responda com o seu próprio conhecimento. Espere o resultado do agente e diga só o que '
  + 'ele diz, sem acrescentar fatos. Fale sempre no idioma em que eu falar: português do Brasil, a não ser que eu fale em '
  + 'inglês. Não responda a esta mensagem.';

/** Ferramentas internas do Codex: tudo desligado na ponte. */
const SEM_FERRAMENTAS: Record<string, unknown> = Object.fromEntries([
  'shell_tool', 'unified_exec', 'apply_patch_freeform', 'apps', 'plugins', 'hooks', 'multi_agent', 'multi_agent_v2',
  'js_repl', 'browser_use', 'computer_use', 'image_generation', 'memories', 'view_image', 'code_mode_host',
  'in_app_browser', 'in_app_local_automation', 'remote_plugin', 'goals', 'tool_search', 'tool_suggest', 'search_tool',
  'sleep_tool', 'standalone_web_search',
].map((f) => [f, false]));

interface Sessao {
  id: string;
  rpc: RpcCliente;
  pasta: string;
  threadId: string | null;
  viva: boolean;
  /** Fala uma de cada vez, na ordem em que as respostas chegam. */
  fila: Promise<void>;
  /** Pedidos do último minuto (limite e repetição). */
  pedidos: { texto: string; em: number }[];
  /** Última vez que o painel perguntou pelos eventos. */
  batida: number;
}

export class VozAoVivo {
  private sessao: Sessao | null = null;
  private eventos: EventoVoz[] = [];
  private n = 0;

  constructor(private readonly deps: VozAoVivoDeps) {}

  get ativa(): boolean { return this.sessao?.viva ?? false; }

  /** Eventos depois do número `desde` (o painel pergunta de tempos em tempos). */
  eventosDesde(desde: number): EventoVoz[] {
    if (this.sessao) this.sessao.batida = Date.now();
    return this.eventos.filter((e) => e.n > desde);
  }

  private registrar(e: DistEventoVoz): void {
    this.eventos.push({ ...e, n: ++this.n } as EventoVoz);
    if (this.eventos.length > MAX_EVENTOS) this.eventos = this.eventos.slice(-MAX_EVENTOS);
  }

  /** Abre a voz com a oferta do navegador; devolve a resposta SDP. Uma sessão por vez: a nova fecha a antiga. */
  async iniciar(sdpOferta: string): Promise<{ sessionId: string; sdp: string }> {
    if (this.sessao) await this.parar(this.sessao.id);
    // Sessão nova começa limpa: o "fim" da anterior não pode derrubar o painel que acabou de ligar.
    this.eventos = [];
    const pasta = mkdtempSync(path.join(tmpdir(), 'night-voz-'));
    let rpc: RpcCliente;
    try {
      rpc = this.deps.criarCliente?.() ?? this.clientePadrao(pasta);
    } catch (err) {
      apagarPasta(pasta);
      throw err;
    }
    const s: Sessao = { id: randomUUID(), rpc, pasta, threadId: null, viva: true, fila: Promise.resolve(), pedidos: [], batida: Date.now() };
    this.sessao = s;

    let entregarSdp!: (sdp: string) => void;
    let falharSdp!: (e: Error) => void;
    const sdp = new Promise<string>((ok, falha) => { entregarSdp = ok; falharSdp = falha; });
    sdp.catch(() => {});

    rpc.on('saiu', (motivo) => { falharSdp(new Error(motivo)); this.encerrar(s, `A voz caiu: ${motivo}`); });
    rpc.on('pedido', (m) => this.atenderPedido(s, m));
    rpc.on('notificacao', (m) => {
      if (!m.method?.startsWith('thread/realtime/') || m.params?.threadId !== s.threadId) return;
      const p = m.params ?? {};
      if (m.method === 'thread/realtime/sdp' && typeof p.sdp === 'string') entregarSdp(p.sdp);
      else if (m.method === 'thread/realtime/error') { const e = explicarErro(String(p.message ?? '')); falharSdp(new Error(e)); this.encerrar(s, e); }
      else if (m.method === 'thread/realtime/closed') { falharSdp(new Error('a OpenAI fechou a voz')); this.encerrar(s, null); }
      else if (m.method === 'thread/realtime/transcript/done' && typeof p.text === 'string' && p.text.trim()) {
        if (p.role === 'user' || p.role === 'assistant') this.registrar({ tipo: 'transcricao', papel: p.role === 'user' ? 'voce' : 'night', texto: p.text.trim() });
      }
    });

    try {
      rpc.iniciar();
      await rpc.pedir('initialize', { clientInfo: { name: 'night-voz', title: 'NIGHT voz ao vivo', version: '0.1.0' }, capabilities: { experimentalApi: true } });
      rpc.avisar('initialized');
      // MCP do config do Joel (codegraph etc.) fica desligado na ponte. Sem ler o config, não abre: sem a lista,
      // não dá para desligar os servidores, e eles ficariam ao alcance de quem fala com a OpenAI.
      const cfg = await rpc.pedir('config/read', { includeLayers: false });
      const config = (cfg as { config?: { mcp_servers?: unknown } }).config;
      if (!config || typeof config !== 'object') throw new Error('o Codex não mostrou a configuração; a voz não abre sem desligar os MCP');
      const servidores = config.mcp_servers && typeof config.mcp_servers === 'object' ? config.mcp_servers as Record<string, unknown> : {};
      const modelo = await escolherModelo(rpc);
      const thread = await rpc.pedir('thread/start', {
        cwd: pasta,
        ...modelo,
        ephemeral: true,
        persistSession: false,
        sandbox: 'read-only',
        approvalPolicy: 'never',
        dynamicTools: [{
          type: 'namespace', name: NAMESPACE, description: 'O NIGHT, que faz o trabalho.',
          tools: [{
            type: 'function', name: FERRAMENTA, description: 'Entrega ao NIGHT o pedido falado do usuário e devolve a resposta dele.',
            inputSchema: { type: 'object', properties: { pedido: { type: 'string', description: 'O pedido, exatamente como foi falado.' } }, required: ['pedido'], additionalProperties: false },
          }],
        }],
        baseInstructions: INSTRUCOES_PONTE,
        config: {
          web_search: 'disabled',
          mcp_servers: Object.fromEntries(Object.keys(servidores).map((nome) => [nome, { enabled: false }])),
          features: { ...SEM_FERRAMENTAS, code_mode: { enabled: false, direct_only_tool_namespaces: [NAMESPACE] } },
          agents: { enabled: false },
        },
      });
      const threadId = (thread.thread as { id?: string } | undefined)?.id;
      if (!threadId) throw new Error('o Codex não abriu a conversa da voz');
      s.threadId = threadId;
      await rpc.pedir('thread/realtime/start', {
        threadId,
        outputModality: 'audio',
        transport: { type: 'webrtc', sdp: sdpOferta },
        version: 'v3',
        includeStartupContext: false,
        ...(this.deps.voz ? { voice: this.deps.voz } : {}),
      });
      const resposta = await comPrazo(sdp, this.deps.esperaSdpMs ?? 20_000, 'a OpenAI não respondeu a tempo para abrir a voz');
      await rpc.pedir('thread/realtime/appendText', { threadId, text: REGRA_VOZ, role: 'user' });
      s.batida = Date.now();
      this.vigiar(s);
      return { sessionId: s.id, sdp: resposta };
    } catch (err) {
      const msg = explicarErro((err as Error).message);
      this.encerrar(s, msg);
      throw new Error(msg);
    }
  }

  async parar(sessionId: string): Promise<void> {
    const s = this.sessao;
    if (!s || s.id !== sessionId) return;
    if (s.threadId && s.viva) await s.rpc.pedir('thread/realtime/stop', { threadId: s.threadId }, 5_000).catch(() => {});
    this.encerrar(s, null);
  }

  /** O servidor está fechando: desliga a sessão que houver. */
  async pararTudo(): Promise<void> {
    if (this.sessao) await this.parar(this.sessao.id);
  }

  private encerrar(s: Sessao, erro: string | null): void {
    if (!s.viva) return;
    s.viva = false;
    if (this.sessao === s) this.sessao = null;
    s.rpc.parar();
    // O processo demora a soltar a pasta no Windows: apaga agora e de novo depois.
    apagarPasta(s.pasta);
    setTimeout(() => apagarPasta(s.pasta), 3_000).unref();
    this.registrar({ tipo: 'fim', erro });
  }

  /** O painel pergunta pelos eventos a cada segundo; sem pergunta por PRAZO_SEM_PAINEL_MS, a aba morreu: desliga. */
  private vigiar(s: Sessao): void {
    const timer = setInterval(() => {
      if (!s.viva) { clearInterval(timer); return; }
      if (Date.now() - s.batida > (this.deps.prazoSemPainelMs ?? PRAZO_SEM_PAINEL_MS)) {
        clearInterval(timer);
        this.encerrar(s, 'O painel parou de responder; desliguei a voz.');
      }
    }, 5_000);
    timer.unref();
  }

  /** Mic aberto pegando TV ou a ponte em loop: mesmo pedido em 10 s ou mais de 8 por minuto não passam. */
  private excesso(s: Sessao, texto: string): string | null {
    const agora = Date.now();
    s.pedidos = s.pedidos.filter((p) => agora - p.em < 60_000);
    if (s.pedidos.some((p) => p.texto === texto && agora - p.em < 10_000)) return 'Esse pedido acabou de ser feito; não repeti.';
    if (s.pedidos.length >= MAX_PEDIDOS_MINUTO) return 'Muitos pedidos seguidos pela voz. Espere um minuto ou use o painel.';
    s.pedidos.push({ texto, em: agora });
    return null;
  }

  /** O Codex só pode pedir uma coisa: pedir_ao_night. Qualquer outra (aprovação, comando) é recusada. */
  private atenderPedido(s: Sessao, m: RpcMensagem): void {
    const id = m.id!;
    const p = m.params ?? {};
    if (m.method !== 'item/tool/call' || p.threadId !== s.threadId || p.namespace !== NAMESPACE || p.tool !== FERRAMENTA) {
      s.rpc.responderErro(id, -32601, 'A voz do NIGHT só atende pedir_ao_night.');
      return;
    }
    const args = (p.arguments ?? {}) as { pedido?: unknown };
    const texto = typeof args.pedido === 'string' ? limparDelegacao(args.pedido) : '';
    if (!texto) { s.rpc.responder(id, resultado(false, 'O pedido veio vazio.')); return; }
    const recusa = this.excesso(s, texto);
    if (recusa) { s.rpc.responder(id, resultado(false, recusa)); return; }
    this.registrar({ tipo: 'pedido', texto });
    this.repassar(s, id, texto).catch((err: unknown) => {
      if (s.viva) s.rpc.responder(id, resultado(false, `O NIGHT falhou: ${redactKeyLike(String((err as Error)?.message ?? err))}`));
    });
  }

  private async repassar(s: Sessao, id: number | string, texto: string): Promise<void> {
    const trabalho = Promise.resolve().then(() => this.deps.pedir(texto));
    let timer: NodeJS.Timeout | undefined;
    const demorou = new Promise<null>((ok) => { timer = setTimeout(() => ok(null), this.deps.esperaMs ?? 45_000); });
    let r: RespostaNight | null;
    try {
      r = await Promise.race([trabalho, demorou]);
    } catch (err) {
      clearTimeout(timer);
      if (s.viva) s.rpc.responder(id, resultado(false, `O NIGHT falhou: ${redactKeyLike((err as Error).message)}`));
      return;
    }
    clearTimeout(timer);
    if (!s.viva) return;
    if (r === null) {
      s.rpc.responder(id, resultado(true, 'O NIGHT ainda está trabalhando nisso. A resposta vai ser falada quando chegar.'));
      trabalho.then((tarde) => { this.anotar(s, tarde.texto); this.falar(s, tarde.texto); this.seguir(s, tarde.depois); },
        (err: Error) => this.falar(s, `O pedido falhou: ${err.message}`));
      return;
    }
    this.anotar(s, r.texto);
    s.rpc.responder(id, resultado(true, paraVoz(r.texto)));
    this.seguir(s, r.depois);
  }

  /** Resposta de sessão que já acabou não entra nos eventos da sessão nova. */
  private anotar(s: Sessao, texto: string): void {
    if (s.viva) this.registrar({ tipo: 'resposta', texto: redactKeyLike(texto) });
  }

  private seguir(s: Sessao, depois?: Promise<string>): void {
    depois?.then((t) => { this.anotar(s, t); this.falar(s, t); }, (err: Error) => this.falar(s, `A pesquisa falhou: ${err.message}`));
  }

  /** Fala uma resposta que nenhum pedido aberto espera (chegou depois). Longa: só o começo. */
  private falar(s: Sessao, texto: string): void {
    s.fila = s.fila.then(async () => {
      if (!s.viva || !s.threadId) return;
      await s.rpc.pedir('thread/realtime/appendSpeech', { threadId: s.threadId, text: resumoFalado(texto) }).catch(() => {});
    });
  }

  private clientePadrao(pasta: string): RpcCliente {
    const bin = findCodexLiveBin();
    if (!bin) throw new Error('Codex não encontrado. Instale o Codex (ou o OpenBot) e faça login com a conta do ChatGPT.');
    return new CodexRpc(bin, pasta);
  }
}

// ---------- Ajudantes (exportados para os testes) ----------

/** Modelo da ponte: NIGHT_VOZ_LIVE_MODEL, senão o padrão do Codex, com esforço baixo (ela só repassa). */
async function escolherModelo(rpc: RpcCliente): Promise<{ model?: string; effort?: string }> {
  if (process.env.NIGHT_VOZ_LIVE_MODEL) return { model: process.env.NIGHT_VOZ_LIVE_MODEL, effort: 'low' };
  const r = await rpc.pedir('model/list', {}).catch(() => ({}));
  const lista = ((r as { data?: { id: string; isDefault?: boolean; supportedReasoningEfforts?: unknown[] }[] }).data) ?? [];
  const m = lista.find((x) => x.isDefault) ?? lista[0];
  if (!m) return {};
  const esforcos = (m.supportedReasoningEfforts ?? []).map((e) => (typeof e === 'string' ? e : (e as { reasoningEffort?: string }).reasoningEffort));
  return { model: m.id, ...(esforcos.includes('low') ? { effort: 'low' } : {}) };
}

function apagarPasta(pasta: string): void {
  try { rmSync(pasta, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* o Windows ainda segura a pasta */ }
}

function resultado(success: boolean, text: string): object {
  return { contentItems: [{ type: 'inputText', text: redactKeyLike(text) }], success };
}

/** Texto para a ponte: limpo para fala; longo ganha a marca e a ponte resume. */
export function paraVoz(texto: string): string {
  const limpo = forSpeech(redactKeyLike(texto));
  if (Buffer.byteLength(limpo) <= LIMITE_FALA_BYTES) return limpo;
  const cortado = Buffer.byteLength(limpo) > MAX_RESULTADO_BYTES
    ? `${Buffer.from(limpo).subarray(0, MAX_RESULTADO_BYTES).toString('utf8').replace(/�$/, '')}… (cortado; o texto inteiro está no painel)`
    : limpo;
  return `${MARCA_LONGA}\n${cortado}`;
}

/** Resposta que chega depois vai direto para a voz, sem a ponte: corta numa frase e manda ver o painel. */
export function resumoFalado(texto: string): string {
  const limpo = forSpeech(redactKeyLike(texto));
  if (Buffer.byteLength(limpo) <= LIMITE_FALA_BYTES) return limpo;
  const corte = limpo.slice(0, 450);
  const fim = Math.max(corte.lastIndexOf('. '), corte.lastIndexOf('? '), corte.lastIndexOf('! '));
  return `${fim > 100 ? corte.slice(0, fim + 1) : `${corte}…`} O resto está no painel.`;
}

/** A ponte às vezes copia o envelope do Codex (<realtime_delegation><input>…</input>) para a ferramenta. */
export function limparDelegacao(texto: string): string {
  const m = /^\s*<realtime_delegation>\s*(?:<source>[^<]*<\/source>\s*)?<input>([^<]*)<\/input>/.exec(texto);
  const t = m?.[1]?.trim() ? m[1].replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&') : texto;
  return t.trim().slice(0, 4000);
}

/** Erros da OpenAI/Codex em português simples. */
export function explicarErro(msg: string): string {
  if (/\b401\b/.test(msg)) return 'O login do Codex venceu. Rode "codex login" (conta do ChatGPT) e tente de novo.';
  if (/\b404\b[\s\S]*realtime\/calls/.test(msg)) return 'A conta do ChatGPT não tem a voz ao vivo liberada agora.';
  if (/realtime[\s\S]*\b403\b|\b403\b[\s\S]*realtime/i.test(msg)) return 'A OpenAI recusou a voz ao vivo (403). Tente de novo mais tarde.';
  if (/usage limit|rate limit|429/i.test(msg)) {
    const quando = /try again at ([^.]+?).?$/i.exec(msg.trim())?.[1];
    return `O limite semanal do Codex acabou e a OpenAI bloqueia a voz ao vivo até ele renovar${quando ? ` (${quando})` : ''}.`;
  }
  return redactKeyLike(msg).slice(0, 300);
}

function comPrazo<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([p, new Promise<never>((_, falha) => { timer = setTimeout(() => falha(new Error(msg)), ms); })])
    .finally(() => clearTimeout(timer));
}
