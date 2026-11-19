import assert from 'node:assert/strict';
import { request } from 'node:http';
import { after, before, describe, test } from 'node:test';
import type { Decisao, HandleOptions, Reply } from '../src/app/coordinator.ts';
import { lerDecisao, startNightServer, type CoordinatorLike, type NightServer, type ServerDeps } from '../src/app/server.ts';
import type { Job } from '../src/core/types.ts';
import type { RadarOffer } from '../src/radar/store.ts';

/** Coordenador falso: guarda o que recebeu e responde na hora (ou trava, para testar a espera). */
class FakeCoord implements CoordinatorLike {
  handled: { text: string; opts?: HandleOptions }[] = [];
  decided: Decisao[] = [];
  next: (text: string) => Promise<Reply> = async (text) => reply(`ok: ${text}`);
  handle(text: string, _l?: unknown, opts?: HandleOptions): Promise<Reply> {
    this.handled.push({ text, opts });
    return this.next(text);
  }
  async decidir(d: Decisao): Promise<Reply> {
    this.decided.push(d);
    return reply(`decidido: ${d.tipo}`);
  }
  pendingRunInfo() { return null; }
}

const reply = (text: string, extra: Partial<Reply> = {}): Reply => ({ text, language: 'pt-BR', intent: 'chat', model: 'fake', ...extra });

const job = (over: Partial<Job>): Job => ({
  id: 'j1', kind: 'radar', number: 1, origin: 'texto', idempotencyKey: 'k', params: {}, limits: {}, status: 'running',
  waitingFor: null, version: 1, taskId: null, artifactRef: null, error: null,
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...over,
});

const offer = (number: number, status: RadarOffer['status']): RadarOffer => ({
  id: `o${number}`, candidateId: null, number, version: 1, status, proposal: { nome: `Oferta <b>${number}</b>`, publico: 'autônomos' },
  sources: [], createdAt: new Date().toISOString(),
});

function http(port: number, method: string, path: string, body?: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers: { ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}), ...headers } }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

describe('servidor das telas e painel', () => {
  let server: NightServer;
  let coords: FakeCoord[];
  let jobs: Job[];
  let pendente: FakeCoord | null;

  const deps: ServerDeps = {
    makeCoordinator: () => { const c = pendente ?? new FakeCoord(); pendente = null; coords.push(c); return c; },
    memory: {
      listJobs: async (f) => jobs.filter((j) => (!f?.kind || j.kind === f.kind) && (!f?.status || f.status.includes(j.status))),
      listTasks: async () => [],
      listPendingApprovals: async () => [],
      getProject: async () => null,
    },
    ofertas: { listLatestOffers: async () => [offer(1, 'discutindo'), offer(2, 'aprovada')] },
    conexoes: async () => [{ nome: 'Meta & teste', ok: false, detalhe: 'falta conta' }],
  };

  const mcp = async (msg: object) => {
    const r = await http(server.port, 'POST', '/mcp', JSON.stringify(msg), { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' });
    return { status: r.status, json: r.body ? JSON.parse(r.body) : null };
  };
  const call = async (name: string, args: object) =>
    (await mcp({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: args } })).json.result;

  before(async () => {
    coords = [];
    jobs = [];
    pendente = null;
    server = await startNightServer(deps, { port: 0, esperaRespostaMs: 200 });
  });
  after(async () => { await server.close(); });

  test('MCP: initialize, notificação e lista de ferramentas', async () => {
    const init = await mcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
    assert.equal(init.status, 200);
    assert.equal(init.json.result.protocolVersion, '2025-03-26');
    assert.equal(init.json.result.serverInfo.name, 'night');
    assert.match(init.json.result.instructions, /painel/);
    const note = await mcp({ jsonrpc: '2.0', method: 'notifications/initialized' });
    assert.equal(note.status, 202);
    const list = await mcp({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    assert.deepEqual(list.json.result.tools.map((t: { name: string }) => t.name), ['night_pedir', 'night_novidades', 'night_trabalhos']);
    const nope = await mcp({ jsonrpc: '2.0', id: 3, method: 'resources/list' });
    assert.equal(nope.json.error.code, -32601);
  });

  test('night_pedir repassa o texto com origem tela e o link do painel', async () => {
    const r = await call('night_pedir', { tela: 'radar', texto: 'mostra a oferta 1' });
    assert.equal(r.isError, false);
    assert.equal(r.content[0].text, 'ok: mostra a oferta 1');
    const c = coords.at(-1)!;
    assert.equal(c.handled[0]!.opts?.origem, 'tela');
    assert.equal(c.handled[0]!.opts?.painelUrl, server.painelUrl);
    // Mesma tela, mesma conversa; outra tela, outro coordenador.
    await call('night_pedir', { tela: 'radar', texto: 'por que ela é boa?' });
    assert.equal(c.handled.length, 2);
    await call('night_pedir', { tela: 'produto', texto: 'oi' });
    assert.notEqual(coords.at(-1), c);
  });

  test('night_pedir valida tela e texto', async () => {
    assert.equal((await call('night_pedir', { tela: 'banco', texto: 'x' })).isError, true);
    assert.equal((await call('night_pedir', { tela: 'radar', texto: '  ' })).isError, true);
    assert.equal((await call('night_pedir', { tela: 'radar', texto: 'x'.repeat(4001) })).isError, true);
    assert.equal((await call('outra', { tela: 'radar' })).isError, true);
  });

  test('resposta demorada e pesquisa viram novidade da tela', async () => {
    const c = new FakeCoord();
    let solta!: (r: Reply) => void;
    c.next = () => new Promise((res) => { solta = res; });
    pendente = c;
    const r = await call('night_pedir', { tela: 'video', texto: 'demora' });
    assert.match(r.content[0].text, /Ainda estou trabalhando/);
    solta(reply('chegou tarde', { followUp: Promise.resolve(reply('pesquisa pronta')) }));
    await new Promise((res) => setTimeout(res, 20));
    const n = await call('night_novidades', { tela: 'video' });
    assert.match(n.content[0].text, /chegou tarde/);
    assert.match(n.content[0].text, /pesquisa pronta/);
    assert.equal((await call('night_novidades', { tela: 'video' })).content[0].text, 'Nada novo desde a última consulta.');
  });

  test('night_trabalhos e novidades vêm do banco, por tela', async () => {
    jobs = [job({ kind: 'radar', number: 3, status: 'waiting', waitingFor: 'fonte' }), job({ id: 'j2', kind: 'video', number: 1 })];
    const t = await call('night_trabalhos', { tela: 'radar' });
    assert.equal(t.content[0].text, 'Radar 3: waiting (esperando: fonte)');
    const n = await call('night_novidades', { tela: 'radar' });
    assert.match(n.content[0].text, /Radar 3: waiting/);
    assert.doesNotMatch(n.content[0].text, /Vídeo/);
    jobs = [];
  });

  test('recusa Host de fora e Origin de outro site', async () => {
    const host = await http(server.port, 'POST', '/mcp', '{}', { Host: 'evil.example:80' });
    assert.equal(host.status, 403);
    const origin = await http(server.port, 'POST', '/mcp', JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }), { Origin: 'https://evil.example' });
    assert.equal(origin.status, 403);
    assert.equal((await http(server.port, 'GET', '/mcp')).status, 405);
    assert.equal((await http(server.port, 'GET', '/mcp', undefined, { Accept: 'text/event-stream' })).status, 405);
    const navegador = await http(server.port, 'GET', '/mcp', undefined, { Accept: 'text/html,application/xhtml+xml' });
    assert.equal(navegador.status, 200);
    assert.match(navegador.body, /href="\/painel"/);
    assert.equal((await http(server.port, 'POST', '/mcp', 'não é json')).status, 400);
  });

  test('painel: página escura com ícone, sem dados embutidos', async () => {
    const r = await http(server.port, 'GET', '/painel');
    assert.equal(r.status, 200);
    assert.match(r.body, /<title>NIGHT<\/title>/);
    assert.match(r.body, /<meta name="color-scheme" content="dark">/);
    assert.match(r.body, /<link rel="icon" href="\/icone\.svg"/);
    assert.match(r.body, /const TOKEN = "[0-9a-f]{48}"/);
    assert.doesNotMatch(r.body, /Oferta <b>1<\/b>/, 'dados só chegam pela API e entram por textContent');
    const icone = await http(server.port, 'GET', '/icone.svg');
    assert.equal(icone.status, 200);
    assert.match(icone.body, /<rect width="64" height="64" rx="15" fill="#000"\/>/);
  });

  test('api/estado: agentes, decisões e conexões', async () => {
    jobs = [job({ kind: 'radar', number: 4, status: 'waiting', waitingFor: 'fonte' })];
    const e = JSON.parse((await http(server.port, 'GET', '/api/estado')).body);
    assert.deepEqual(e.agentes.map((a: { nome: string }) => a.nome), ['NIGHT', 'Radar', 'Produto', 'Campanha', 'Código', 'Vídeo']);
    const radar = e.agentes.find((a: { tela: string }) => a.tela === 'radar');
    assert.equal(radar.resumo, '1 esperando');
    assert.deepEqual(radar.linhas, ['Radar 4: waiting (esperando: fonte)', '2 oferta(s), 1 aprovada(s)']);
    assert.ok(radar.exemplos.length > 0);
    const grupos = e.decisoes.map((d: { grupo: string }) => d.grupo);
    assert.ok(grupos.includes('Oferta para decidir'));
    assert.ok(grupos.includes('Trabalho em andamento'));
    const campanha = e.decisoes.find((d: { grupo: string }) => d.grupo.startsWith('Montar campanha'));
    assert.equal(campanha.pedeValor, true);
    assert.deepEqual(campanha.acoes[0].campos, { tipo: 'campanha', numero: '2' });
    assert.equal(e.decisoes.find((d: { grupo: string }) => d.grupo === 'Oferta para decidir').titulo, 'Oferta 1 (versão 1)');
    assert.deepEqual(e.conexoes, [{ nome: 'Meta & teste', ok: false, detalhe: 'falta conta' }]);
    jobs = [];
  });

  const postJson = (caminho: string, dados: object, headers: Record<string, string> = {}) =>
    http(server.port, 'POST', caminho, JSON.stringify(dados), { 'Content-Type': 'application/json', ...headers });
  const tokenDoPainel = async () => /const TOKEN = "([0-9a-f]+)"/.exec((await http(server.port, 'GET', '/painel')).body)![1]!;

  test('api/pedir: conversa por agente, vale como o dono e exige token e origem', async () => {
    const token = await tokenDoPainel();
    const origin = `http://127.0.0.1:${server.port}`;
    assert.equal((await postJson('/api/pedir', { tela: 'radar', texto: 'oi', token })).status, 403, 'sem Origin');
    assert.equal((await postJson('/api/pedir', { tela: 'radar', texto: 'oi', token: 'x' }, { Origin: origin })).status, 403);
    assert.equal((await postJson('/api/pedir', { tela: 'banco', texto: 'oi', token }, { Origin: origin })).status, 400);
    const r = await postJson('/api/pedir', { tela: 'radar', texto: 'aprova a oferta 1', token }, { Origin: origin });
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(r.body).texto, 'ok: aprova a oferta 1');
    const c = coords.find((x) => x.handled.some((h) => h.text === 'aprova a oferta 1'))!;
    assert.equal(c.handled.at(-1)!.opts?.origem, 'dono');
    const e = JSON.parse((await http(server.port, 'GET', '/api/estado')).body);
    assert.deepEqual(e.conversas.radar, [{ quem: 'voce', texto: 'aprova a oferta 1' }, { quem: 'night', texto: 'ok: aprova a oferta 1' }]);
    assert.equal(e.conversas.produto, undefined, 'cada agente tem a sua conversa');
  });

  test('api/decidir: exige Origin e token; campanha só com valor e confirmação', async () => {
    const token = await tokenDoPainel();
    const origin = `http://127.0.0.1:${server.port}`;
    const antes = coords.reduce((n, c) => n + c.decided.length, 0);
    assert.equal((await postJson('/api/decidir', { tipo: 'oferta', numero: '1', decisao: 'approve', token })).status, 403);
    assert.equal((await postJson('/api/decidir', { tipo: 'oferta', numero: '1', decisao: 'approve', token: 'x' }, { Origin: origin })).status, 403);
    const ok = await postJson('/api/decidir', { tipo: 'oferta', numero: '1', decisao: 'approve', token }, { Origin: origin });
    assert.equal(JSON.parse(ok.body).texto, 'decidido: oferta');
    const semValor = await postJson('/api/decidir', { tipo: 'campanha', numero: '2', confirmo: 'sim', token }, { Origin: origin });
    assert.match(JSON.parse(semValor.body).texto, /Digite o valor por dia/);
    const semConfirmar = await postJson('/api/decidir', { tipo: 'campanha', numero: '2', valor: 20, token }, { Origin: origin });
    assert.match(JSON.parse(semConfirmar.body).texto, /Marque a confirmação/);
    const rodar = await postJson('/api/decidir', { tipo: 'rodar', chave: 'nao-existe', token }, { Origin: origin });
    assert.equal(JSON.parse(rodar.body).texto, 'Esse pedido de rodar não existe mais.');
    assert.equal(coords.reduce((n, c) => n + c.decided.length, 0), antes + 1, 'só a decisão completa chegou ao coordenador');
  });
});

describe('lerDecisao', () => {
  const p = (o: Record<string, string>) => lerDecisao(new URLSearchParams(o));
  test('campanha precisa de valor digitado e confirmação', () => {
    assert.deepEqual(p({ tipo: 'campanha', numero: '2', valor: '20,5', confirmo: 'sim' }), { tipo: 'campanha', numero: 2, valorBRL: 20.5 });
    assert.equal(typeof p({ tipo: 'campanha', numero: '2', valor: '0', confirmo: 'sim' }), 'string');
    assert.equal(typeof p({ tipo: 'campanha', numero: '2', valor: 'abc', confirmo: 'sim' }), 'string');
  });
  test('número, decisão e tipo são conferidos', () => {
    assert.deepEqual(p({ tipo: 'video', numero: '3', decisao: 'reject' }), { tipo: 'video', numero: 3, decisao: 'reject' });
    assert.equal(typeof p({ tipo: 'video', numero: '1.5', decisao: 'reject' }), 'string');
    assert.equal(typeof p({ tipo: 'oferta', numero: '1', decisao: 'talvez' }), 'string');
    assert.equal(typeof p({ tipo: 'cancelar-trabalho', kind: 'campanha', numero: '1' }), 'string');
    assert.equal(typeof p({ tipo: 'rodar' }), 'string');
    assert.deepEqual(p({ tipo: 'rodar', chave: 'painel:codigo' }), { tipo: 'rodar' });
    assert.equal(typeof p({ tipo: 'apagar-tudo' }), 'string');
  });
});

describe('voz ao vivo pelas rotas do painel', () => {
  /** Codex falso: o suficiente para abrir a voz e devolver o SDP. */
  class RpcFalso {
    pedidos: { method: string; params: object }[] = [];
    paradas = 0;
    private readonly ouvintes: Record<string, ((arg: any) => void)[]> = {};

    iniciar(): void {}
    on(evento: string, fn: (arg: any) => void): void {
      (this.ouvintes[evento] ??= []).push(fn);
    }
    async pedir(method: string, params: object): Promise<Record<string, unknown>> {
      this.pedidos.push({ method, params });
      if (method === 'config/read') return { config: {} };
      if (method === 'thread/start') return { thread: { id: 't1' } };
      if (method === 'thread/realtime/start') {
        setImmediate(() => this.emitir('notificacao', { method: 'thread/realtime/sdp', params: { threadId: 't1', sdp: 'v=0 resposta' } }));
      }
      return {};
    }
    avisar(_method: string, _params?: object): void {}
    respostas: { id: number | string; result: any }[] = [];
    responder(id: number | string, result: object): void { this.respostas.push({ id, result }); }
    responderErro(_id: number | string, _code: number, _message: string): void {}
    parar(): void { this.paradas += 1; }
    emitir(evento: string, m: object): void { for (const fn of this.ouvintes[evento] ?? []) fn(m); }
  }

  let servidor: NightServer;
  let falso: RpcFalso;
  let token: string;
  let origin: string;
  let sessionId: string;
  const coords: FakeCoord[] = [];

  const post = (caminho: string, dados: object) =>
    http(servidor.port, 'POST', caminho, JSON.stringify(dados), { 'Content-Type': 'application/json', Origin: origin });

  before(async () => {
    falso = new RpcFalso();
    const deps: ServerDeps = {
      makeCoordinator: () => { const c = new FakeCoord(); coords.push(c); return c; },
      memory: {
        listJobs: async () => [],
        listTasks: async () => [],
        listPendingApprovals: async () => [],
        getProject: async () => null,
      },
    };
    servidor = await startNightServer(deps, { port: 0, criarClienteVoz: () => falso });
    token = /const TOKEN = "([0-9a-f]+)"/.exec((await http(servidor.port, 'GET', '/painel')).body)![1]!;
    origin = 'http://127.0.0.1:' + servidor.port;
  });
  after(async () => { await servidor.close(); });

  test('a) /api/voz/iniciar sem token é recusado', async () => {
    const r = await post('/api/voz/iniciar', { sdp: 'v=0 oferta' });
    assert.equal(r.status, 403);
  });

  test('b) /api/voz/iniciar recusa oferta de áudio inválida', async () => {
    const r = await post('/api/voz/iniciar', { token, sdp: 'abc' });
    assert.equal(r.status, 400);
  });

  test('c) /api/voz/iniciar com oferta válida devolve o SDP da OpenAI', async () => {
    const r = await post('/api/voz/iniciar', { token, sdp: 'v=0 oferta' });
    assert.equal(r.status, 200);
    const corpo = JSON.parse(r.body) as { sessionId: string; sdp: string };
    assert.equal(corpo.sdp, 'v=0 resposta');
    assert.equal(typeof corpo.sessionId, 'string');
    sessionId = corpo.sessionId;
  });

  test('d) /api/voz/eventos com token mostra a sessão ativa', async () => {
    const r = await post('/api/voz/eventos', { token });
    assert.equal(r.status, 200);
    const corpo = JSON.parse(r.body) as { ativa: boolean; eventos: unknown[] };
    assert.equal(corpo.ativa, true);
    assert.ok(Array.isArray(corpo.eventos));
  });

  test('pedido falado entra como tela: decisão nunca executa pela voz ao vivo', async () => {
    falso.emitir('pedido', { id: 9, method: 'item/tool/call',
      params: { threadId: 't1', namespace: 'night', tool: 'pedir_ao_night', arguments: { pedido: 'aprovo a oferta 1' } } });
    for (let i = 0; i < 50 && !falso.respostas.some((r) => r.id === 9); i++) await new Promise((ok) => setTimeout(ok, 10));
    const pedido = coords.flatMap((c) => c.handled).find((h) => h.text === 'aprovo a oferta 1');
    assert.ok(pedido, 'o pedido falado não chegou ao coordenador');
    assert.equal(pedido.opts?.origem, 'tela');
    assert.match(pedido.opts?.painelUrl ?? '', /\/painel$/);
    assert.equal(falso.respostas.find((r) => r.id === 9)?.result.success, true);
  });

  test('rotas da voz sem Origin são recusadas', async () => {
    const r = await http(servidor.port, 'POST', '/api/voz/eventos', JSON.stringify({ token }), { 'Content-Type': 'application/json' });
    assert.equal(r.status, 403);
  });

  test('e) /api/voz/parar encerra a sessão', async () => {
    const r = await post('/api/voz/parar', { token, sessionId });
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.body), { ok: true });
    const ev = await post('/api/voz/eventos', { token });
    const corpo = JSON.parse(ev.body) as { ativa: boolean; eventos: { tipo: string }[] };
    assert.equal(corpo.ativa, false);
    assert.ok(corpo.eventos.some((e) => e.tipo === 'fim'));
  });
});
