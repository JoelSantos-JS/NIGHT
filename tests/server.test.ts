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
    assert.equal((await http(server.port, 'POST', '/mcp', 'não é json')).status, 400);
  });

  test('painel mostra pendências escapando o texto', async () => {
    const r = await http(server.port, 'GET', '/painel');
    assert.equal(r.status, 200);
    assert.match(r.body, /Ofertas para decidir/);
    assert.match(r.body, /Oferta &lt;b&gt;1&lt;\/b&gt;/);
    assert.doesNotMatch(r.body, /<b>1<\/b>/);
    assert.match(r.body, /Montar campanha na Meta \(sempre PAUSADA\)/);
    assert.match(r.body, /name="valor" type="number" min="1" max="200"/);
    assert.doesNotMatch(r.body, /name="valor"[^>]*value=/, 'sem valor sugerido');
  });

  test('painel: decidir exige Origin do painel e o token', async () => {
    const page = (await http(server.port, 'GET', '/painel')).body;
    const token = /name="token" value="([0-9a-f]+)"/.exec(page)![1]!;
    const origin = `http://127.0.0.1:${server.port}`;
    const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
    const post = (body: string, headers: Record<string, string>) =>
      http(server.port, 'POST', '/painel/decidir', body, { 'Content-Type': 'application/x-www-form-urlencoded', ...headers });

    const semOrigin = await post(form({ tipo: 'oferta', numero: '1', decisao: 'approve', token }), {});
    assert.equal(semOrigin.status, 403);
    const semToken = await post(form({ tipo: 'oferta', numero: '1', decisao: 'approve', token: 'x' }), { Origin: origin });
    assert.equal(semToken.status, 403);
    const before = coords.reduce((n, c) => n + c.decided.length, 0);

    const ok = await post(form({ tipo: 'oferta', numero: '1', decisao: 'approve', token }), { Origin: origin });
    assert.equal(ok.status, 200);
    assert.match(ok.body, /decidido: oferta/);
    const semValor = await post(form({ tipo: 'campanha', numero: '2', confirmo: 'sim', token }), { Origin: origin });
    assert.match(semValor.body, /Digite o valor por dia/);
    const semConfirmar = await post(form({ tipo: 'campanha', numero: '2', valor: '20', token }), { Origin: origin });
    assert.match(semConfirmar.body, /Marque a confirmação/);
    assert.equal(coords.reduce((n, c) => n + c.decided.length, 0), before + 1, 'só a decisão completa chegou ao coordenador');
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
    assert.equal(typeof p({ tipo: 'rodar', tela: 'banco' }), 'string');
    assert.deepEqual(p({ tipo: 'rodar', tela: 'codigo' }), { tipo: 'rodar' });
    assert.equal(typeof p({ tipo: 'apagar-tudo' }), 'string');
  });
});
