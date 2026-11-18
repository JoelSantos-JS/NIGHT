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

/** Uma tela por agente no OpenBot; cada uma tem a sua conversa no NIGHT. */
export const TELAS = ['night', 'radar', 'produto', 'campanha', 'codigo', 'video'] as const;
export type Tela = (typeof TELAS)[number];

const NOME_TELA: Record<Tela, string> = {
  night: 'NIGHT', radar: 'Radar', produto: 'Produto', campanha: 'Campanha', codigo: 'Código', video: 'Vídeo',
};

/** Que trabalhos cada tela acompanha ('night' vê todos). */
const KINDS_TELA: Record<Tela, JobKind[]> = {
  night: ['radar', 'lowticket', 'campanha', 'video', 'coding'],
  radar: ['radar'], produto: ['lowticket'], campanha: ['campanha'], video: ['video'], codigo: ['coding'],
};

export const DEFAULT_PORT = 4517;
const MAX_BODY = 64 * 1024;
const MAX_TEXTO = 4000;
const MAX_NOVIDADES = 50;
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
}

export interface ServerOptions {
  /** 0 = porta livre qualquer (testes). */
  port?: number;
  /** Teste: espera menor antes de virar novidade. */
  esperaRespostaMs?: number;
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
] as const;

export async function startNightServer(deps: ServerDeps, opts: ServerOptions = {}): Promise<NightServer> {
  const token = randomBytes(24).toString('hex');
  const espera = opts.esperaRespostaMs ?? ESPERA_RESPOSTA_MS;
  const coordenadores = new Map<Tela | 'painel', CoordinatorLike>();
  const coord = (t: Tela | 'painel') => {
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

  async function painel(msg?: string): Promise<string> {
    const blocos: string[] = [];

    const pendentes = new Set((await deps.memory.listPendingApprovals()).map((a) => a.taskId));
    const tarefas = (await deps.memory.listTasks({ status: ['awaiting-approval'] })).filter((t) => pendentes.has(t.id));
    if (tarefas.length) {
      const itens = await Promise.all(tarefas.map(async (t) => {
        const projeto = (await deps.memory.getProject(t.projectId))?.name ?? 'projeto';
        return item(`${esc(projeto)}: ${esc(t.objective)}`, 'Aprovar faz o merge na pasta do projeto.',
          botoes({ tipo: 'tarefa', taskId: t.id }));
      }));
      blocos.push(secao('Código esperando aprovação', itens.join('')));
    }

    for (const tela of TELAS) {
      const run = coordenadores.get(tela)?.pendingRunInfo();
      if (run) {
        blocos.push(secao('Rodar projeto', item(`${esc(run.title)}`, `Abre ${esc(run.dir)} numa janela própria. Pedido da tela ${NOME_TELA[tela]}; vence em 5 minutos.`,
          form({ tipo: 'rodar', tela }, '<button class="sim">Pode rodar</button>'))));
      }
    }

    const ofertas = deps.ofertas ? await deps.ofertas.listLatestOffers() : [];
    const emDiscussao = ofertas.filter((o) => o.status === 'rascunho' || o.status === 'discutindo');
    if (emDiscussao.length) {
      blocos.push(secao('Ofertas para decidir', emDiscussao.map((o) => item(
        `Oferta ${o.number} (versão ${o.version})`, esc(resumoOferta(o)) + ' Aprovar vale como briefing; não autoriza campanha nem gasto.',
        botoes({ tipo: 'oferta', numero: String(o.number) }),
      )).join('')));
    }
    const aprovadas = ofertas.filter((o) => o.status === 'aprovada');
    if (aprovadas.length) {
      blocos.push(secao('Montar campanha na Meta (sempre PAUSADA)', aprovadas.map((o) => item(
        `Oferta ${o.number} (versão ${o.version})`,
        'Cria campanha, conjunto e anúncios PAUSADOS. Ativar continua com você no Gerenciador. Teto: R$ 200 por dia.',
        form({ tipo: 'campanha', numero: String(o.number) },
          '<label>Valor por dia (R$) <input name="valor" type="number" min="1" max="200" step="1" required inputmode="numeric"></label>'
          + '<label class="conf"><input type="checkbox" name="confirmo" value="sim" required> Confirmo criar PAUSADA com esse valor por dia</label>'
          + '<button class="sim">Montar pausada</button>'),
      )).join('')));
    }

    const videos = (await deps.memory.listJobs({ kind: 'video', status: ['succeeded'] })).slice(0, 5);
    if (videos.length) {
      blocos.push(secao('Vídeos prontos', videos.map((j) => item(`Vídeo ${j.number}`, 'Aprovar não publica nem gasta.',
        botoes({ tipo: 'video', numero: String(j.number) }))).join('')));
    }

    const ativos = [
      ...await deps.memory.listJobs({ kind: 'radar' }),
      ...await deps.memory.listJobs({ kind: 'video' }),
    ].filter((j) => !FINAL_JOB_STATUSES.includes(j.status));
    if (ativos.length) {
      blocos.push(secao('Trabalhos em andamento', ativos.map((j) => item(
        `${j.kind === 'radar' ? 'Radar' : 'Vídeo'} ${j.number}`, esc(estado(j)),
        form({ tipo: 'cancelar-trabalho', kind: j.kind, numero: String(j.number) }, '<button class="nao">Cancelar</button>'),
      )).join('')));
    }

    const corpo = blocos.length ? blocos.join('') : '<p class="vazio">Nada esperando decisão agora.</p>';
    return pagina('Painel do NIGHT', `${msg ? `<p class="msg">${esc(msg)}</p>` : ''}${corpo}`);
  }

  function form(campos: Record<string, string>, conteudo: string): string {
    const ocultos = Object.entries({ ...campos, token })
      .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('');
    return `<form method="post" action="/painel/decidir">${ocultos}${conteudo}</form>`;
  }

  function botoes(campos: Record<string, string>): string {
    return `<div class="botoes">${form({ ...campos, decisao: 'approve' }, '<button class="sim">Aprovar</button>')}`
      + `${form({ ...campos, decisao: 'reject' }, '<button class="nao">Rejeitar</button>')}</div>`;
  }

  async function decidirDoPainel(campos: URLSearchParams): Promise<string> {
    const d = lerDecisao(campos);
    if (typeof d === 'string') return d;
    const quem = d.tipo === 'rodar' ? coord(campos.get('tela') as Tela) : coord('painel');
    const r = await quem.decidir(d);
    return r.detail ? `${r.text} (${r.detail})` : r.text;
  }

  // ---------- HTTP ----------

  async function atender(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const host = req.headers.host ?? '';
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return enviar(res, 403, 'text/plain', 'host não permitido');
    const origin = req.headers.origin;
    if (origin !== undefined && !origemPropria().includes(origin)) return enviar(res, 403, 'text/plain', 'origem não permitida');
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);

    if (url.pathname === '/mcp') {
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
    if (url.pathname === '/painel' && req.method === 'GET') return enviar(res, 200, 'text/html; charset=utf-8', await painel());
    if (url.pathname === '/painel/decidir' && req.method === 'POST') {
      // Formulário do painel: precisa vir do próprio painel (Origin) e trazer o token deste início.
      if (origin === undefined) return enviar(res, 403, 'text/plain', 'origem ausente');
      let campos: URLSearchParams;
      try {
        campos = new URLSearchParams(await lerCorpo(req));
      } catch (err) {
        return enviar(res, 413, 'text/plain', (err as Error).message);
      }
      if (!tokenConfere(campos.get('token'), token)) return enviar(res, 403, 'text/plain', 'token inválido; recarregue o painel');
      const msg = await decidirDoPainel(campos);
      return enviar(res, 200, 'text/html; charset=utf-8', await painel(msg));
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
    close: () => new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    }),
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
    case 'rodar': {
      const tela = c.get('tela') ?? '';
      if (!(TELAS as readonly string[]).includes(tela)) return 'tela inválida';
      return { tipo };
    }
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

const secao = (titulo: string, conteudo: string) => `<section><h2>${esc(titulo)}</h2>${conteudo}</section>`;
const item = (titulo: string, texto: string, acoes: string) =>
  `<div class="item"><h3>${titulo}</h3><p>${texto}</p>${acoes}</div>`;

function pagina(titulo: string, corpo: string): string {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(titulo)}</title>
<style>
:root{--bg:#f6f6f4;--card:#fff;--txt:#1d1d1b;--sub:#5b5b57;--borda:#e2e2dd;--sim:#1f6f43;--nao:#9b2c2c;--msg:#fff7d6}
@media (prefers-color-scheme:dark){:root{--bg:#141414;--card:#1e1e1d;--txt:#ececea;--sub:#a3a39e;--borda:#33332f;--sim:#3d9a66;--nao:#c45656;--msg:#3a3420}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--txt);font:16px/1.45 system-ui,sans-serif}
main{max-width:720px;margin:0 auto;padding:16px}h1{font-size:1.4rem;margin:8px 0 16px}h2{font-size:1.05rem;margin:24px 0 8px;color:var(--sub)}
h3{font-size:1rem;margin:0 0 4px}.item{background:var(--card);border:1px solid var(--borda);border-radius:10px;padding:12px;margin:8px 0}
.item p{margin:0 0 10px;color:var(--sub)}.botoes{display:flex;gap:8px;flex-wrap:wrap}form{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:0}
button{border:0;border-radius:8px;padding:10px 16px;font:inherit;color:#fff;cursor:pointer}.sim{background:var(--sim)}.nao{background:var(--nao)}
input[type=number]{width:7em;padding:8px;font:inherit;border:1px solid var(--borda);border-radius:6px;background:var(--card);color:var(--txt)}
label{display:flex;gap:6px;align-items:center}.conf{flex-basis:100%}.msg{background:var(--msg);padding:12px;border-radius:8px}.vazio{color:var(--sub)}
a{color:inherit}
</style></head><body><main><h1>${esc(titulo)}</h1>${corpo}<p class="vazio"><a href="/painel">Atualizar</a></p></main></body></html>`;
}
