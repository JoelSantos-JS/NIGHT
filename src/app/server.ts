// Servidor local do NIGHT: as telas do OpenBot falam com ele por MCP (HTTP), e o Joel decide no painel.
//
// Regras que moram aqui:
// - Só escuta em 127.0.0.1 e recusa Host de fora (DNS rebinding) e Origin de outro site.
// - Pedido de tela entra com origem 'tela': decisão (aprovar, cancelar, campanha com R$, "pode rodar")
//   nunca executa por esse caminho, porque quem escreve na tela é um modelo e ele pode inventar um "aprovo".
// - Decisão só pelo painel (formulário com token deste início do servidor) ou pela voz/terminal.
// - Sem dependência nova: MCP "Streamable HTTP" respondendo JSON simples, à mão.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Memory } from '../core/interfaces.ts';
import type { Job, JobKind, Language } from '../core/types.ts';
import { FINAL_JOB_STATUSES, FINAL_TASK_STATUSES } from '../core/types.ts';
import type { RadarOffer } from '../radar/store.ts';
import type { TaskUpdate } from '../agents/scheduler.ts';
import type { Decisao, HandleOptions, Reply } from './coordinator.ts';
import { ICONE_NIGHT, paginaPainel } from './painel-ui.ts';
import { VozAoVivo, type RespostaNight, type RpcCliente } from './voz-ao-vivo.ts';
import type { EstadoOpenBot } from '../openbot/tipos.ts';

/** Uma tela por agente no OpenBot; cada uma tem a sua conversa no NIGHT. */
export const TELAS = ['night', 'radar', 'produto', 'campanha', 'codigo', 'video', 'design', 'marketing'] as const;
export type Tela = (typeof TELAS)[number];

const NOME_TELA: Record<Tela, string> = {
  night: 'NIGHT', radar: 'Radar', produto: 'Produto', campanha: 'Campanha', codigo: 'Código', video: 'Vídeo',
  design: 'Design', marketing: 'Marketing',
};

const FOCO_TELA: Record<Tela, string> = {
  night: 'Conversa, pesquisa e resumo de tudo.',
  radar: 'Busca e discussão de ofertas.',
  produto: 'PDFs, bônus e página de vendas da oferta aprovada.',
  campanha: 'Campanha na Meta, sempre criada pausada.',
  codigo: 'Tarefas de código com Claude e Codex, com revisão.',
  video: 'Vídeos (parado por decisão do Joel).',
  design: 'Página de vendas e telas do produto low-ticket.',
  marketing: 'Copy, ângulos e criativos de anúncio.',
};

const FOCO_CURTO: Record<Tela, string> = {
  night: 'Conversa e pesquisa', radar: 'Ofertas', produto: 'Low-ticket', campanha: 'Meta Ads', codigo: 'Claude e Codex', video: 'Parado',
  design: 'Landing page', marketing: 'Copy e criativos',
};

const EXEMPLOS_TELA: Record<Tela, string[]> = {
  night: ['O que tá rodando?', 'Pesquisa pra mim a cotação do dólar hoje', 'Salva essa ideia: modo escuro no app'],
  radar: ['Vasculha ofertas de fone bluetooth', 'Mostra a oferta 1', 'Por que ela é boa?'],
  produto: ['Gera o produto da oferta 1', 'A página da oferta 1 é https://', 'O checkout da oferta 1 é https://'],
  campanha: ['Monta a campanha da oferta 1', 'Como está a campanha da oferta 1?'],
  codigo: ['Pede pro Claude corrigir o bug do login no meu projeto', 'Mostra as mudanças', 'Roda o meu projeto pra mim'],
  video: ['Cria um vídeo sobre café gelado', 'Como está o vídeo 1?'],
  design: ['Faz a página de vendas da oferta 1', 'Mostra no celular'],
  marketing: ['Me dá 5 ângulos para a oferta 1', 'Faz os prompts dos criativos'],
};

/** Que trabalhos cada tela acompanha ('night' vê todos). */
const KINDS_TELA: Record<Tela, JobKind[]> = {
  night: ['radar', 'lowticket', 'campanha', 'video', 'coding'],
  radar: ['radar'], produto: ['lowticket'], campanha: ['campanha'], video: ['video'], codigo: ['coding'],
  // Design e Marketing trabalham dentro do OpenBot; acompanham o produto low-ticket que estão montando.
  design: ['lowticket'], marketing: ['lowticket'],
};

export const DEFAULT_PORT = 4517;
const MAX_BODY = 64 * 1024;
const MAX_TEXTO = 4000;
const MAX_NOVIDADES = 50;
const MAX_CONVERSA = 100;
/** Resposta que passa disso vira novidade: o cliente MCP não fica pendurado num relatório longo. */
const ESPERA_RESPOSTA_MS = 90_000;
const PROTOCOLOS = ['2025-06-18', '2025-03-26', '2024-11-05'];

/** O que o servidor usa do coordenador (o de verdade ou um falso nos testes). */
export interface CoordinatorLike {
  handle(text: string, language?: Language, opts?: HandleOptions): Promise<Reply>;
  decidir(d: Decisao, language?: Language): Promise<Reply>;
  pendingRunInfo(): { title: string; dir: string; at: number } | null;
}

export interface ServerDeps {
  makeCoordinator(): CoordinatorLike;
  memory: Pick<Memory, 'listJobs' | 'listTasks' | 'listPendingApprovals' | 'getProject'>;
  ofertas?: { listLatestOffers(): Promise<RadarOffer[]> };
  tasks?: { on(event: 'update', fn: (u: TaskUpdate) => void): unknown };
  /** Quadro de conexões do painel (banco, modelos, Meta, OpenBot): só "ligado / falta o quê". */
  conexoes?: () => Promise<{ nome: string; ok: boolean; detalhe: string }[]>;
  /** Espelho do OpenBot: agentes, tarefas mandadas, pendências e o diário das telas. */
  openbot?: {
    estado(): EstadoOpenBot;
    relatar(tela: string, texto: string): void;
    responderAprovacao(agenteId: string, pedidoId: string, decisao: 'accept' | 'decline'): Promise<string>;
    ouvir?(fn: (texto: string) => void): void;
  };
}

export interface ServerOptions {
  /** 0 = porta livre qualquer (testes). */
  port?: number;
  /** Teste: espera menor antes de virar novidade. */
  esperaRespostaMs?: number;
  /** Teste: Codex falso para a voz ao vivo. */
  criarClienteVoz?: () => RpcCliente;
}

export interface NightServer {
  port: number;
  mcpUrl: string;
  painelUrl: string;
  close(): Promise<void>;
}

type JsonRpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };

const TOOLS = [
  {
    name: 'night_pedir',
    description: 'Repassa ao NIGHT o pedido do Joel, exatamente como ele escreveu, e devolve a resposta do NIGHT. '
      + 'Decisões (aprovar, rejeitar, cancelar, campanha com valor, "pode rodar") não valem por aqui: o NIGHT devolve o link do painel.',
    inputSchema: {
      type: 'object',
      properties: {
        tela: { type: 'string', enum: [...TELAS], description: 'Qual tela está pedindo.' },
        texto: { type: 'string', description: 'O texto do Joel, sem reescrever.' },
      },
      required: ['tela', 'texto'],
    },
  },
  {
    name: 'night_novidades',
    description: 'O que mudou desde a última consulta desta tela: respostas de pesquisa que chegaram, trabalhos que mudaram de estado e avisos das tarefas de código.',
    inputSchema: {
      type: 'object',
      properties: { tela: { type: 'string', enum: [...TELAS] } },
      required: ['tela'],
    },
  },
  {
    name: 'night_trabalhos',
    description: 'Lista os trabalhos desta tela com número, estado e o que estão esperando. Os dados vêm do banco do NIGHT.',
    inputSchema: {
      type: 'object',
      properties: { tela: { type: 'string', enum: [...TELAS] } },
      required: ['tela'],
    },
  },
  {
    name: 'night_relatar',
    description: 'Registra no diário do NIGHT, em 1 a 3 linhas, o que esta tela acabou de fazer, para o Joel ver no painel (seção OpenBot). '
      + 'Nunca ponha chave, senha, token, e-mail ou dado de cliente.',
    inputSchema: {
      type: 'object',
      properties: {
        tela: { type: 'string', enum: [...TELAS] },
        texto: { type: 'string', description: 'Resumo curto: o que o Joel pediu e o que aconteceu.' },
      },
      required: ['tela', 'texto'],
    },
  },
] as const;

export async function startNightServer(deps: ServerDeps, opts: ServerOptions = {}): Promise<NightServer> {
  const token = randomBytes(24).toString('hex');
  const espera = opts.esperaRespostaMs ?? ESPERA_RESPOSTA_MS;
  // Chave: a tela do OpenBot ('radar'), a conversa do painel ('painel:radar') ou as decisões ('painel').
  const coordenadores = new Map<string, CoordinatorLike>();
  const coord = (t: string) => {
    let c = coordenadores.get(t);
    if (!c) { c = deps.makeCoordinator(); coordenadores.set(t, c); }
    return c;
  };
  const novidades = new Map<Tela, string[]>();
  const avisar = (t: Tela, msg: string) => {
    const fila = novidades.get(t) ?? [];
    fila.push(msg);
    novidades.set(t, fila.slice(-MAX_NOVIDADES));
  };
  const vistoEm = new Map<Tela, number>(TELAS.map((t) => [t, Date.now()]));
  deps.tasks?.on('update', (u) => { if (u.important) avisar('codigo', u.message); });
  // Resposta de agente do OpenBot e pendência nova vão para as novidades da tela NIGHT. A conversa do painel já
  // recebe a resposta pelo followUp do pedido, e a seção OpenBot mostra tudo; pôr aqui também duplicaria.
  deps.openbot?.ouvir?.((texto) => avisar('night', texto));

  let port = opts.port ?? DEFAULT_PORT;
  const origemPropria = () => [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
  const painelUrl = () => `http://127.0.0.1:${port}/painel`;

  // ---------- Ferramentas ----------

  async function pedir(tela: Tela, texto: string): Promise<string> {
    const c = coord(tela);
    const trabalho = c.handle(texto, undefined, { origem: 'tela', painelUrl: painelUrl() });
    const texto_ = (r: Reply) => (r.detail ? `${r.text}\n\n${r.detail}` : r.text);
    let timer: NodeJS.Timeout | undefined;
    const demorou = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), espera); });
    const r = await Promise.race([trabalho, demorou]).finally(() => clearTimeout(timer));
    if (r === null) {
      trabalho.then(
        (tarde) => { avisar(tela, texto_(tarde)); if (tarde.followUp) seguir(tela, tarde.followUp); },
        (err: Error) => avisar(tela, `Falhou: ${err.message}`),
      );
      return 'Ainda estou trabalhando nisso. A resposta vai aparecer em night_novidades.';
    }
    if (r.followUp) seguir(tela, r.followUp);
    return texto_(r);
  }

  function seguir(tela: Tela, p: Promise<Reply>): void {
    p.then((r) => avisar(tela, r.detail ? `${r.text}\n\n${r.detail}` : r.text), (err: Error) => avisar(tela, `A pesquisa falhou: ${err.message}`));
  }

  async function verNovidades(tela: Tela): Promise<string> {
    const desde = vistoEm.get(tela) ?? 0;
    vistoEm.set(tela, Date.now());
    const fila = novidades.get(tela) ?? [];
    novidades.set(tela, []);
    const mudaram = (await jobsDaTela(tela)).filter((j) => Date.parse(j.updatedAt) > desde);
    const linhas = [...fila, ...mudaram.map(linhaJob)];
    return linhas.length ? linhas.join('\n\n') : 'Nada novo desde a última consulta.';
  }

  async function jobsDaTela(tela: Tela): Promise<Job[]> {
    const listas = await Promise.all(KINDS_TELA[tela].map((kind) => deps.memory.listJobs({ kind })));
    return listas.flat().sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }

  async function listarTrabalhos(tela: Tela): Promise<string> {
    const jobs = (await jobsDaTela(tela)).filter((j) => !FINAL_JOB_STATUSES.includes(j.status) || recente(j)).slice(0, 15);
    const linhas = jobs.map(linhaJob);
    if (tela === 'codigo' || tela === 'night') {
      const abertas = (await deps.memory.listTasks()).filter((t) => !FINAL_TASK_STATUSES.includes(t.status)).slice(0, 10);
      linhas.push(...abertas.map((t) => `Tarefa de código (${t.primaryAgent}): ${t.objective} · ${t.status}`));
    }
    return linhas.length ? linhas.join('\n') : 'Nenhum trabalho aberto nem recente nesta tela.';
  }

  async function chamarFerramenta(nome: string, args: Record<string, unknown>): Promise<{ text: string; isError?: boolean }> {
    const tela = args.tela;
    if (typeof tela !== 'string' || !(TELAS as readonly string[]).includes(tela)) {
      return { text: `tela inválida; use uma de: ${TELAS.join(', ')}`, isError: true };
    }
    const t = tela as Tela;
    if (nome === 'night_pedir') {
      const texto = typeof args.texto === 'string' ? args.texto.trim() : '';
      if (!texto) return { text: 'texto vazio', isError: true };
      if (texto.length > MAX_TEXTO) return { text: `texto longo demais (máximo ${MAX_TEXTO} caracteres)`, isError: true };
      return { text: await pedir(t, texto) };
    }
    if (nome === 'night_novidades') return { text: await verNovidades(t) };
    if (nome === 'night_relatar') {
      const texto = typeof args.texto === 'string' ? args.texto.trim() : '';
      if (!texto) return { text: 'texto vazio', isError: true };
      if (texto.length > 1000) return { text: 'relato longo demais (máximo 1000 caracteres)', isError: true };
      if (!deps.openbot) return { text: 'O diário do OpenBot não está ligado neste NIGHT.', isError: true };
      deps.openbot.relatar(t, texto);
      return { text: 'Registrado no diário do NIGHT.' };
    }
    if (nome === 'night_trabalhos') return { text: await listarTrabalhos(t) };
    return { text: `ferramenta desconhecida: ${nome}`, isError: true };
  }

  async function mcp(msg: JsonRpc): Promise<object | null> {
    const id = msg.id ?? null;
    const ok = (result: object) => ({ jsonrpc: '2.0', id, result });
    const erro = (code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } });
    if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return erro(-32600, 'pedido JSON-RPC inválido');
    // Notificação (sem id) não tem resposta.
    if (msg.id === undefined) return null;
    switch (msg.method) {
      case 'initialize': {
        const pedido = msg.params?.protocolVersion;
        const versao = typeof pedido === 'string' && PROTOCOLOS.includes(pedido) ? pedido : PROTOCOLOS[0];
        return ok({
          protocolVersion: versao,
          capabilities: { tools: {} },
          serverInfo: { name: 'night', version: '0.0.1' },
          instructions: 'Repasse o pedido do Joel com night_pedir, sem reescrever, e mostre a resposta como veio. '
            + 'Depois de responder, registre em 1 linha com night_relatar o que ele pediu e o que aconteceu (sem chave, senha ou dado de cliente). '
            + `Decisões são só do Joel, no painel: ${painelUrl()}`,
        });
      }
      case 'ping': return ok({});
      case 'tools/list': return ok({ tools: TOOLS });
      case 'tools/call': {
        const nome = msg.params?.name;
        const args = msg.params?.arguments;
        if (typeof nome !== 'string') return erro(-32602, 'falta o nome da ferramenta');
        try {
          const r = await chamarFerramenta(nome, (args && typeof args === 'object' ? args : {}) as Record<string, unknown>);
          return ok({ content: [{ type: 'text', text: r.text }], isError: r.isError ?? false });
        } catch (err) {
          return ok({ content: [{ type: 'text', text: `Erro no NIGHT: ${(err as Error).message}` }], isError: true });
        }
      }
      default: return erro(-32601, `método não suportado: ${msg.method}`);
    }
  }

  // ---------- Painel ----------

  type Mensagem = { quem: 'voce' | 'night' | 'aviso'; texto: string };
  /** Conversa de cada agente no painel. Fica na memória desta execução; o histórico de verdade é o route_log. */
  const conversas = new Map<Tela, Mensagem[]>();
  const falar = (t: Tela, m: Mensagem) => {
    const lista = conversas.get(t) ?? [];
    lista.push(m);
    conversas.set(t, lista.slice(-MAX_CONVERSA));
  };
  const textoDe = (r: Reply) => (r.detail ? `${r.text}\n\n${r.detail}` : r.text);

  type Acao = { rotulo: string; estilo: 'ok' | 'perigo'; campos: Record<string, string> };
  interface DecisaoPainel { grupo: string; titulo: string; texto: string; pedeValor?: boolean; acoes: Acao[] }
  const aprovarRejeitar = (campos: Record<string, string>): Acao[] => [
    { rotulo: 'Aprovar', estilo: 'ok', campos: { ...campos, decisao: 'approve' } },
    { rotulo: 'Rejeitar', estilo: 'perigo', campos: { ...campos, decisao: 'reject' } },
  ];

  /** O que está esperando o Joel, calculado do estado real (nada fica guardado só no painel). */
  async function decisoesPendentes(): Promise<DecisaoPainel[]> {
    const lista: DecisaoPainel[] = [];
    const pendentes = new Set((await deps.memory.listPendingApprovals()).map((a) => a.taskId));
    for (const t of (await deps.memory.listTasks({ status: ['awaiting-approval'] })).filter((x) => pendentes.has(x.id))) {
      const projeto = (await deps.memory.getProject(t.projectId))?.name ?? 'projeto';
      lista.push({ grupo: 'Código esperando aprovação', titulo: `${projeto}: ${t.objective}`,
        texto: 'Aprovar faz o merge na pasta do projeto.', acoes: aprovarRejeitar({ tipo: 'tarefa', taskId: t.id }) });
    }
    for (const [chave, c] of coordenadores) {
      const run = c.pendingRunInfo();
      if (run) {
        lista.push({ grupo: 'Rodar projeto', titulo: run.title, texto: `Abre ${run.dir} numa janela própria. Vence em 5 minutos.`,
          acoes: [{ rotulo: 'Pode rodar', estilo: 'ok', campos: { tipo: 'rodar', chave } }] });
      }
    }
    const ofertas = deps.ofertas ? await deps.ofertas.listLatestOffers() : [];
    for (const o of ofertas.filter((x) => x.status === 'rascunho' || x.status === 'discutindo')) {
      lista.push({ grupo: 'Oferta para decidir', titulo: `Oferta ${o.number} (versão ${o.version})`,
        texto: `${resumoOferta(o)} Aprovar vale como briefing; não autoriza campanha nem gasto.`.trim(),
        acoes: aprovarRejeitar({ tipo: 'oferta', numero: String(o.number) }) });
    }
    for (const o of ofertas.filter((x) => x.status === 'aprovada')) {
      lista.push({ grupo: 'Montar campanha na Meta (sempre PAUSADA)', titulo: `Oferta ${o.number} (versão ${o.version})`,
        texto: 'Cria campanha, conjunto e anúncios PAUSADOS. Ativar continua com você no Gerenciador. Teto: R$ 200 por dia.',
        pedeValor: true, acoes: [{ rotulo: 'Montar pausada', estilo: 'ok', campos: { tipo: 'campanha', numero: String(o.number) } }] });
    }
    for (const j of (await deps.memory.listJobs({ kind: 'video', status: ['succeeded'] })).slice(0, 5)) {
      lista.push({ grupo: 'Vídeo pronto', titulo: `Vídeo ${j.number}`, texto: 'Aprovar não publica nem gasta.',
        acoes: aprovarRejeitar({ tipo: 'video', numero: String(j.number) }) });
    }
    const ativos = [...await deps.memory.listJobs({ kind: 'radar' }), ...await deps.memory.listJobs({ kind: 'video' })]
      .filter((j) => !FINAL_JOB_STATUSES.includes(j.status));
    for (const j of ativos) {
      lista.push({ grupo: 'Trabalho em andamento', titulo: `${NOME_KIND[j.kind]} ${j.number}`, texto: estado(j),
        acoes: [{ rotulo: 'Cancelar', estilo: 'perigo', campos: { tipo: 'cancelar-trabalho', kind: j.kind, numero: String(j.number) } }] });
    }
    return lista;
  }

  async function agentesPainel() {
    const ofertas = deps.ofertas ? await deps.ofertas.listLatestOffers() : [];
    return Promise.all(TELAS.map(async (tela) => {
      const jobs = await jobsDaTela(tela);
      const rodando = jobs.filter((j) => j.status === 'queued' || j.status === 'running').length;
      const esperando = jobs.filter((j) => j.status === 'waiting' || j.status === 'retryable').length;
      const linhas = jobs.filter((j) => !FINAL_JOB_STATUSES.includes(j.status) || recente(j)).slice(0, 5).map(linhaJob);
      if (tela === 'codigo' || tela === 'night') {
        const abertas = (await deps.memory.listTasks()).filter((t) => !FINAL_TASK_STATUSES.includes(t.status));
        linhas.push(...abertas.slice(0, 5).map((t) => `Código (${t.primaryAgent}): ${t.objective} · ${t.status}`));
      }
      if (tela === 'radar' && ofertas.length) {
        linhas.push(`${ofertas.length} oferta(s), ${ofertas.filter((o) => o.status === 'aprovada').length} aprovada(s)`);
      }
      const resumo = esperando ? `${esperando} esperando` : rodando ? `${rodando} rodando` : FOCO_CURTO[tela];
      return { tela, nome: NOME_TELA[tela], foco: FOCO_TELA[tela], exemplos: EXEMPLOS_TELA[tela], rodando, esperando, linhas, resumo };
    }));
  }

  async function estadoPainel() {
    return {
      agentes: await agentesPainel(),
      decisoes: await decisoesPendentes(),
      conexoes: deps.conexoes ? await deps.conexoes() : [],
      conversas: Object.fromEntries(conversas),
      openbot: deps.openbot?.estado() ?? null,
    };
  }

  /** Conversa do painel: é o Joel em pessoa (origem 'dono'). Cada agente tem o seu coordenador. */
  async function pedirDoPainel(tela: Tela, texto: string): Promise<string> {
    falar(tela, { quem: 'voce', texto });
    let r: Reply;
    try {
      r = await coord(`painel:${tela}`).handle(texto, undefined, { origem: 'dono' });
    } catch (err) {
      const msg = `Erro no NIGHT: ${(err as Error).message}`;
      falar(tela, { quem: 'aviso', texto: msg });
      return msg;
    }
    falar(tela, { quem: 'night', texto: textoDe(r) });
    r.followUp?.then(
      (tarde) => falar(tela, { quem: 'night', texto: textoDe(tarde) }),
      (err: Error) => falar(tela, { quem: 'aviso', texto: `A pesquisa falhou: ${err.message}` }),
    );
    return textoDe(r);
  }

  async function decidirDoPainel(campos: URLSearchParams): Promise<string> {
    const d = lerDecisao(campos);
    if (typeof d === 'string') return d;
    // "Pode rodar" volta ao coordenador que preparou o pedido (é lá que ele espera).
    const quem = d.tipo === 'rodar' ? coordenadores.get(campos.get('chave') ?? '') : coord('painel');
    if (!quem) return 'Esse pedido de rodar não existe mais.';
    const r = await quem.decidir(d);
    return r.detail ? `${r.text} (${r.detail})` : r.text;
  }

  // ---------- Voz ao vivo ----------

  /**
   * Pedido falado: passou por modelos da OpenAI, então entra com origem 'voz' (decisão volta com o link do painel).
   * A voz recebe só `text`; o `detail` (diff, relatório) fica no painel e não vai para a OpenAI.
   */
  async function pedirPorVoz(texto: string): Promise<RespostaNight> {
    falar('night', { quem: 'voce', texto: `🎙 ${texto}` });
    const r = await coord('voz').handle(texto, undefined, { origem: 'voz', painelUrl: painelUrl() });
    falar('night', { quem: 'night', texto: textoDe(r) });
    const paraVoz = (x: Reply) => (x.detail ? `${x.text} O detalhe está no painel.` : x.text);
    const depois = r.followUp?.then((tarde) => { falar('night', { quem: 'night', texto: textoDe(tarde) }); return paraVoz(tarde); });
    return { texto: paraVoz(r), depois };
  }
  const voz = new VozAoVivo({ pedir: pedirPorVoz, criarCliente: opts.criarClienteVoz, voz: process.env.NIGHT_VOZ_LIVE_VOICE });

  async function rotaVoz(rota: string, dados: Record<string, unknown>): Promise<{ status: number; corpo: object }> {
    if (rota === '/api/voz/iniciar') {
      const sdp = typeof dados.sdp === 'string' ? dados.sdp : '';
      if (!sdp.startsWith('v=0') || sdp.length > 20_000) return { status: 400, corpo: { texto: 'oferta de áudio inválida' } };
      try {
        return { status: 200, corpo: await voz.iniciar(sdp) };
      } catch (err) {
        return { status: 502, corpo: { texto: (err as Error).message } };
      }
    }
    if (rota === '/api/voz/parar') {
      await voz.parar(typeof dados.sessionId === 'string' ? dados.sessionId : '');
      return { status: 200, corpo: { ok: true } };
    }
    const desde = typeof dados.desde === 'number' ? dados.desde : 0;
    return { status: 200, corpo: { ativa: voz.ativa, eventos: voz.eventosDesde(desde) } };
  }

  // ---------- HTTP ----------

  async function atender(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const host = req.headers.host ?? '';
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return enviar(res, 403, 'text/plain', 'host não permitido');
    const origin = req.headers.origin;
    if (origin !== undefined && !origemPropria().includes(origin)) return enviar(res, 403, 'text/plain', 'origem não permitida');
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);

    if (url.pathname === '/mcp') {
      // Aberto no navegador: explica o endereço em vez de um "use POST" seco. Cliente MCP (que pede
      // text/event-stream no GET) continua recebendo 405, como manda o protocolo sem SSE.
      if (req.method === 'GET' && (req.headers.accept ?? '').includes('text/html')) {
        return enviar(res, 200, 'text/html; charset=utf-8', pagina('Endereço das telas do OpenBot',
          '<p>Este endereço não é uma página: é por onde as telas do OpenBot conversam com o NIGHT (MCP). '
          + 'Ele fica no cadastro do servidor <b>night</b> dentro do OpenBot.</p>'
          + '<p>Para ver e decidir o que está pendente, abra o <a href="/painel">painel do NIGHT</a>.</p>'));
      }
      if (req.method !== 'POST') return enviar(res, 405, 'text/plain', 'use POST', { Allow: 'POST' });
      let corpo: unknown;
      try {
        corpo = JSON.parse(await lerCorpo(req));
      } catch (err) {
        const status = (err as Error).message === 'corpo grande demais' ? 413 : 400;
        return enviar(res, status, 'application/json', JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: (err as Error).message } }));
      }
      const lista = Array.isArray(corpo) ? corpo : [corpo];
      const respostas = (await Promise.all(lista.map((m) => mcp((m ?? {}) as JsonRpc)))).filter((r) => r !== null);
      if (respostas.length === 0) return enviar(res, 202, 'text/plain', '');
      return enviar(res, 200, 'application/json', JSON.stringify(Array.isArray(corpo) ? respostas : respostas[0]));
    }

    if (url.pathname === '/' && req.method === 'GET') return enviar(res, 302, 'text/plain', '', { Location: '/painel' });
    if (url.pathname === '/painel' && req.method === 'GET') return enviar(res, 200, 'text/html; charset=utf-8', paginaPainel(token));
    if (url.pathname === '/icone.svg' && req.method === 'GET') return enviar(res, 200, 'image/svg+xml', ICONE_NIGHT);
    if (url.pathname === '/api/estado' && req.method === 'GET') return enviar(res, 200, 'application/json', JSON.stringify(await estadoPainel()));
    const rotasComToken = ['/api/pedir', '/api/decidir', '/api/voz/iniciar', '/api/voz/parar', '/api/voz/eventos', '/api/openbot/responder'];
    if (rotasComToken.includes(url.pathname) && req.method === 'POST') {
      // Só do próprio painel (Origin) e com o token deste início do servidor.
      if (origin === undefined) return enviarJson(res, 403, { texto: 'origem ausente' });
      let dados: Record<string, unknown>;
      try {
        const lido: unknown = JSON.parse(await lerCorpo(req));
        dados = lido && typeof lido === 'object' && !Array.isArray(lido) ? lido as Record<string, unknown> : {};
      } catch (err) {
        return enviarJson(res, 400, { texto: (err as Error).message });
      }
      if (!tokenConfere(typeof dados.token === 'string' ? dados.token : null, token)) {
        return enviarJson(res, 403, { texto: 'token inválido; recarregue o painel' });
      }
      if (url.pathname === '/api/openbot/responder') {
        // Aprovação de agente do OpenBot: só daqui (painel, token), nunca por tela ou voz.
        const { agenteId, pedidoId, decisao } = dados;
        if (typeof agenteId !== 'string' || typeof pedidoId !== 'string' || (decisao !== 'accept' && decisao !== 'decline')) {
          return enviarJson(res, 400, { texto: 'pedido inválido' });
        }
        if (!deps.openbot) return enviarJson(res, 400, { texto: 'O OpenBot não está ligado neste NIGHT.' });
        return enviarJson(res, 200, { texto: await deps.openbot.responderAprovacao(agenteId, pedidoId, decisao) });
      }
      if (url.pathname.startsWith('/api/voz/')) {
        const r = await rotaVoz(url.pathname, dados);
        return enviarJson(res, r.status, r.corpo);
      }
      if (url.pathname === '/api/pedir') {
        const tela = dados.tela;
        const texto = typeof dados.texto === 'string' ? dados.texto.trim() : '';
        if (typeof tela !== 'string' || !(TELAS as readonly string[]).includes(tela)) return enviarJson(res, 400, { texto: 'tela inválida' });
        if (!texto || texto.length > MAX_TEXTO) return enviarJson(res, 400, { texto: 'texto vazio ou longo demais' });
        return enviarJson(res, 200, { texto: await pedirDoPainel(tela as Tela, texto) });
      }
      const campos = new URLSearchParams(Object.entries(dados)
        .filter(([, v]) => typeof v === 'string' || typeof v === 'number').map(([k, v]) => [k, String(v)]));
      return enviarJson(res, 200, { texto: await decidirDoPainel(campos) });
    }
    return enviar(res, 404, 'text/plain', 'não encontrado');
  }

  const server: Server = createServer((req, res) => {
    atender(req, res).catch((err: Error) => {
      if (!res.headersSent) enviar(res, 500, 'text/plain', `erro: ${err.message}`);
      else res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  port = (server.address() as AddressInfo).port;

  return {
    port,
    mcpUrl: `http://127.0.0.1:${port}/mcp`,
    painelUrl: painelUrl(),
    close: async () => {
      // Espera a voz fechar: no Windows o codex.exe não morre junto com o NIGHT.
      await voz.pararTudo();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}

/** Lê a decisão do formulário; texto = motivo da recusa. Valor de campanha só se digitado e confirmado. */
export function lerDecisao(c: URLSearchParams): Decisao | string {
  const tipo = c.get('tipo');
  const numero = Number(c.get('numero'));
  const numeroOk = Number.isInteger(numero) && numero > 0;
  const decisao = c.get('decisao');
  const decisaoOk = decisao === 'approve' || decisao === 'reject';
  switch (tipo) {
    case 'tarefa': {
      const taskId = c.get('taskId') ?? '';
      if (!taskId || taskId.length > 100 || !decisaoOk) return 'decisão de tarefa incompleta';
      return { tipo, taskId, decisao };
    }
    case 'oferta':
    case 'video':
      if (!numeroOk || !decisaoOk) return 'decisão incompleta';
      return { tipo, numero, decisao };
    case 'campanha': {
      const valor = Number((c.get('valor') ?? '').replace(',', '.'));
      if (!numeroOk) return 'falta o número da oferta';
      if (!Number.isFinite(valor) || valor <= 0) return 'Digite o valor por dia (maior que zero).';
      if (c.get('confirmo') !== 'sim') return 'Marque a confirmação para montar a campanha.';
      return { tipo, numero, valorBRL: valor };
    }
    case 'cancelar-trabalho': {
      const kind = c.get('kind');
      if ((kind !== 'radar' && kind !== 'video') || !numeroOk) return 'cancelamento incompleto';
      return { tipo, kind, numero };
    }
    case 'rodar':
      if (!c.get('chave')) return 'falta o pedido de rodar';
      return { tipo };
    default:
      return 'tipo de decisão desconhecido';
  }
}

function tokenConfere(recebido: string | null, esperado: string): boolean {
  if (!recebido) return false;
  const a = Buffer.from(recebido);
  const b = Buffer.from(esperado);
  return a.length === b.length && timingSafeEqual(a, b);
}

function lerCorpo(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const partes: Buffer[] = [];
    let tamanho = 0;
    req.on('data', (p: Buffer) => {
      tamanho += p.length;
      if (tamanho > MAX_BODY) { reject(new Error('corpo grande demais')); req.destroy(); return; }
      partes.push(p);
    });
    req.on('end', () => resolve(Buffer.concat(partes).toString('utf8')));
    req.on('error', reject);
  });
}

function enviarJson(res: ServerResponse, status: number, corpo: object): void {
  enviar(res, status, 'application/json', JSON.stringify(corpo));
}

function enviar(res: ServerResponse, status: number, tipo: string, corpo: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': tipo, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra });
  res.end(corpo);
}

const recente = (j: Job) => Date.now() - Date.parse(j.updatedAt) < 24 * 3600_000;

const NOME_KIND: Record<JobKind, string> = {
  radar: 'Radar', lowticket: 'Produto', campanha: 'Campanha', video: 'Vídeo', coding: 'Código',
};

function estado(j: Job): string {
  const espera = j.status === 'waiting' && j.waitingFor ? ` (esperando: ${j.waitingFor})` : '';
  const erro = j.error ? ` · erro: ${j.error}` : '';
  return `${j.status}${espera}${erro}`;
}

function linhaJob(j: Job): string {
  return `${NOME_KIND[j.kind]} ${j.number}: ${estado(j)}`;
}

function resumoOferta(o: RadarOffer): string {
  const p = o.proposal;
  const nome = typeof p.nome === 'string' ? p.nome : '';
  const publico = typeof p.publico === 'string' ? ` Público: ${p.publico}` : '';
  return nome ? `${nome}.${publico}${publico ? '.' : ''}` : '';
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function pagina(titulo: string, corpo: string): string {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(titulo)}</title>
<style>
:root{color-scheme:dark;--bg:#0c0d10;--card:#15171c;--txt:#e9ebf1;--sub:#9096a5;--borda:#262a33;--sim:#4fc28a;--nao:#ef6b6b;--msg:#2b2616}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--txt);font:16px/1.45 system-ui,sans-serif}
main{max-width:720px;margin:0 auto;padding:16px}h1{font-size:1.4rem;margin:8px 0 16px}h2{font-size:1.05rem;margin:24px 0 8px;color:var(--sub)}
h3{font-size:1rem;margin:0 0 4px}.item{background:var(--card);border:1px solid var(--borda);border-radius:10px;padding:12px;margin:8px 0}
.item p{margin:0 0 10px;color:var(--sub)}.botoes{display:flex;gap:8px;flex-wrap:wrap}form{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:0}
button{border:0;border-radius:8px;padding:10px 16px;font:inherit;color:#fff;cursor:pointer}.sim{background:var(--sim)}.nao{background:var(--nao)}
input[type=number]{width:7em;padding:8px;font:inherit;border:1px solid var(--borda);border-radius:6px;background:var(--card);color:var(--txt)}
label{display:flex;gap:6px;align-items:center}.conf{flex-basis:100%}.msg{background:var(--msg);padding:12px;border-radius:8px}.vazio{color:var(--sub)}
a{color:inherit}textarea{flex:1;min-width:0;width:100%;padding:8px;font:inherit;border:1px solid var(--borda);border-radius:6px;background:var(--card);color:var(--txt)}
.grade{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:8px}.grade .item{margin:0}.agente ul,.conexoes{margin:6px 0 0;padding-left:18px}
.conexoes{list-style:none;padding:0}.conexoes li{margin:4px 0}.ok{color:var(--sim)}.falta{color:var(--nao)}.dica{font-size:.9rem;color:var(--sub);margin:6px 0 0}
.voce{color:var(--sub);margin:0 0 6px}.night{margin:0 0 10px;color:var(--txt)}
</style></head><body><main><h1>${esc(titulo)}</h1>${corpo}<p class="vazio"><a href="/painel">Atualizar</a></p></main></body></html>`;
}
