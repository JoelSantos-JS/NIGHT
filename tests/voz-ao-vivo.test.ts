import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, test } from 'node:test';
import {
  compararVersao,
  explicarErro,
  limparDelegacao,
  paraVoz,
  resumoFalado,
  VozAoVivo,
  type EventoVoz,
  type RespostaNight,
  type RpcCliente,
  type RpcMensagem,
  type VozAoVivoDeps,
} from '../src/app/voz-ao-vivo.ts';

// ---------- Processo do Codex falso ----------

interface FakeOpcoes {
  /** Resposta de cada método do JSON-RPC (o que não estiver aqui responde {}). */
  respostas?: Record<string, Record<string, unknown>>;
  /** SDP que a "OpenAI" devolve; null = nunca responde (para testar o prazo). */
  sdp?: string | null;
}

/** Faz o papel do `codex app-server`: grava tudo o que recebeu e responde por método. */
class FakeRpc extends EventEmitter implements RpcCliente {
  readonly acoes: string[] = [];
  readonly pedidos: { method: string; params: object }[] = [];
  readonly avisos: { method: string; params?: object }[] = [];
  readonly respondeu: { id: number | string; result: object }[] = [];
  readonly erros: { id: number | string; code: number; message: string }[] = [];
  paradas = 0;
  private readonly sdp: string | null;
  private readonly porMetodo: Record<string, Record<string, unknown>>;

  constructor(opcoes: FakeOpcoes = {}) {
    super();
    this.sdp = opcoes.sdp === undefined ? 'v=0 resposta' : opcoes.sdp;
    this.porMetodo = {
      initialize: {},
      'config/read': { config: { mcp_servers: { codegraph: {} } } },
      'model/list': { data: [{ id: 'm1', isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }] },
      'thread/start': { thread: { id: 't1' } },
      'thread/realtime/start': {},
      ...(opcoes.respostas ?? {}),
    };
  }

  iniciar(): void { this.acoes.push('iniciar'); }

  async pedir(method: string, params: object): Promise<Record<string, unknown>> {
    this.acoes.push('pedir:' + method);
    this.pedidos.push({ method, params });
    if (method === 'thread/realtime/start' && this.sdp !== null) {
      const threadId = (params as { threadId?: string }).threadId ?? 't1';
      const sdp = this.sdp;
      // A OpenAI responde a oferta logo depois; a sessão já sabe o threadId quando isto chega.
      setImmediate(() => this.notificar({ method: 'thread/realtime/sdp', params: { threadId, sdp } }));
    }
    return this.porMetodo[method] ?? {};
  }

  avisar(method: string, params?: object): void {
    this.acoes.push('avisar:' + method);
    this.avisos.push(params === undefined ? { method } : { method, params });
  }

  responder(id: number | string, result: object): void {
    this.acoes.push('responder:' + id);
    this.respondeu.push({ id, result });
  }

  responderErro(id: number | string, code: number, message: string): void {
    this.acoes.push('erro:' + id);
    this.erros.push({ id, code, message });
  }

  parar(): void { this.acoes.push('parar'); this.paradas += 1; }

  /** O teste manda eventos à mão, como se viessem do processo. */
  notificar(m: RpcMensagem): void { this.emit('notificacao', m); }
  pedido(m: RpcMensagem): void { this.emit('pedido', m); }
  saiu(motivo: string): void { this.emit('saiu', motivo); }
}

function pedidoRpc(id: number, texto: string, extra: { method?: string; threadId?: string; namespace?: string; tool?: string } = {}): RpcMensagem {
  return {
    id,
    method: extra.method ?? 'item/tool/call',
    params: {
      threadId: extra.threadId ?? 't1',
      namespace: extra.namespace ?? 'night',
      tool: extra.tool ?? 'pedir_ao_night',
      arguments: { pedido: texto },
    },
  };
}

async function esperarAte(condicao: () => boolean, ms = 2_000): Promise<void> {
  const inicio = Date.now();
  while (!condicao()) {
    if (Date.now() - inicio > ms) throw new Error('tempo esgotado esperando a condição');
    await new Promise((ok) => setTimeout(ok, 5));
  }
}

interface Bancada {
  voz: VozAoVivo;
  falso: FakeRpc;
  pedidosAoNight: string[];
}

function bancada(opcoes: {
  falso?: FakeRpc;
  esperaMs?: number;
  esperaSdpMs?: number;
  pedir?: (texto: string) => Promise<RespostaNight>;
} = {}): Bancada {
  const falso = opcoes.falso ?? new FakeRpc();
  const pedidosAoNight: string[] = [];
  const pedir = opcoes.pedir ?? (async (texto: string) => ({ texto: 'resposta: ' + texto }));
  const deps: VozAoVivoDeps = {
    pedir: (texto) => { pedidosAoNight.push(texto); return pedir(texto); },
    criarCliente: () => falso,
    esperaMs: opcoes.esperaMs ?? 2_000,
    esperaSdpMs: opcoes.esperaSdpMs ?? 2_000,
  };
  return { voz: new VozAoVivo(deps), falso, pedidosAoNight };
}

function paramsDe(falso: FakeRpc, method: string): Record<string, any> {
  const pedido = falso.pedidos.find((p) => p.method === method);
  assert.ok(pedido, 'o cliente não pediu ' + method);
  return pedido.params as Record<string, any>;
}

// ---------- Sessão ----------

describe('voz ao vivo: sessão', () => {
  test('iniciar devolve o SDP e abre a ponte do Codex do jeito certo', async () => {
    const { voz, falso } = bancada();
    try {
      const r = await voz.iniciar('v=0 oferta');
      assert.equal(r.sdp, 'v=0 resposta');
      assert.equal(typeof r.sessionId, 'string');
      assert.ok(r.sessionId.length > 0);

      const esperada = [
        'pedir:initialize',
        'avisar:initialized',
        'pedir:thread/start',
        'pedir:thread/realtime/start',
        'pedir:thread/realtime/appendText',
      ];
      const posicoes = esperada.map((acao) => falso.acoes.indexOf(acao));
      const faltando = esperada.filter((_, i) => posicoes[i] === -1).join(', ');
      assert.ok(posicoes.every((i) => i >= 0), 'faltou: ' + faltando);
      for (let i = 1; i < posicoes.length; i++) {
        assert.ok(posicoes[i]! > posicoes[i - 1]!, esperada[i] + ' devia vir depois de ' + esperada[i - 1]);
      }
      assert.ok(falso.acoes.indexOf('iniciar') < posicoes[0]!, 'o processo abre antes do initialize');

      const thread = paramsDe(falso, 'thread/start');
      assert.equal(thread.sandbox, 'read-only');
      assert.equal(thread.approvalPolicy, 'never');
      assert.equal(thread.ephemeral, true);
      assert.equal(thread.model, 'm1');
      assert.equal(thread.effort, 'low');
      const namespace = (thread.dynamicTools as any[])[0];
      assert.equal(namespace.type, 'namespace');
      assert.equal(namespace.name, 'night');
      assert.deepEqual(namespace.tools.map((t: any) => t.name), ['pedir_ao_night']);
      assert.equal(thread.config.mcp_servers.codegraph.enabled, false);
      assert.equal(thread.config.features.shell_tool, false);

      const realtime = paramsDe(falso, 'thread/realtime/start');
      assert.equal(realtime.threadId, 't1');
      assert.deepEqual(realtime.transport, { type: 'webrtc', sdp: 'v=0 oferta' });
      assert.equal(realtime.version, 'v3');

      const texto = paramsDe(falso, 'thread/realtime/appendText');
      assert.equal(texto.threadId, 't1');
      assert.equal(texto.role, 'user');
      assert.match(texto.text, /voz do NIGHT/);
      assert.equal(voz.ativa, true);
    } finally {
      await voz.pararTudo();
    }
  });

  test('pedido pedir_ao_night vai ao NIGHT e a resposta volta para a ponte', async () => {
    const { voz, falso, pedidosAoNight } = bancada();
    try {
      await voz.iniciar('v=0 oferta');
      falso.pedido(pedidoRpc(7, 'mostra a oferta 1'));
      await esperarAte(() => falso.respondeu.length === 1);

      assert.deepEqual(pedidosAoNight, ['mostra a oferta 1']);
      const r = falso.respondeu[0]!;
      assert.equal(r.id, 7);
      const resultado = r.result as { contentItems: { type: string; text: string }[]; success: boolean };
      assert.equal(resultado.success, true);
      assert.equal(resultado.contentItems[0]!.type, 'inputText');
      assert.match(resultado.contentItems[0]!.text, /mostra a oferta 1/);
    } finally {
      await voz.pararTudo();
    }
  });

  test('resposta com mais de 600 bytes leva a marca de resposta longa', async () => {
    const { voz, falso } = bancada({ pedir: async () => ({ texto: 'a'.repeat(700) }) });
    try {
      await voz.iniciar('v=0 oferta');
      falso.pedido(pedidoRpc(8, 'conta uma história comprida'));
      await esperarAte(() => falso.respondeu.length === 1);
      const resultado = falso.respondeu[0]!.result as { contentItems: { type: string; text: string }[] };
      assert.ok(resultado.contentItems[0]!.text.startsWith('[resposta longa]'));
    } finally {
      await voz.pararTudo();
    }
  });

  test('método, thread, namespace ou ferramenta errados são recusados sem chamar o NIGHT', async () => {
    const { voz, falso, pedidosAoNight } = bancada();
    try {
      await voz.iniciar('v=0 oferta');
      falso.pedido(pedidoRpc(1, 'x', { method: 'execCommandApproval' }));
      falso.pedido(pedidoRpc(2, 'x', { namespace: 'outro' }));
      falso.pedido(pedidoRpc(3, 'x', { tool: 'outra_ferramenta' }));
      falso.pedido(pedidoRpc(4, 'x', { threadId: 't9' }));

      assert.deepEqual(falso.erros.map((e) => e.id), [1, 2, 3, 4]);
      assert.ok(falso.erros.every((e) => e.code === -32601));
      assert.deepEqual(pedidosAoNight, []);
      assert.equal(falso.respondeu.length, 0);
    } finally {
      await voz.pararTudo();
    }
  });

  test('NIGHT lento: avisa que está trabalhando e fala a resposta quando chega', async () => {
    let soltar!: (r: RespostaNight) => void;
    const { voz, falso } = bancada({
      esperaMs: 20,
      pedir: () => new Promise<RespostaNight>((ok) => { soltar = ok; }),
    });
    try {
      await voz.iniciar('v=0 oferta');
      falso.pedido(pedidoRpc(9, 'pesquisa demorada'));
      await esperarAte(() => falso.respondeu.length === 1);

      const resultado = falso.respondeu[0]!.result as { contentItems: { type: string; text: string }[]; success: boolean };
      assert.equal(resultado.success, true);
      assert.match(resultado.contentItems[0]!.text, /ainda está trabalhando/i);

      soltar({ texto: 'cheguei depois' });
      await esperarAte(() => falso.pedidos.some((p) => p.method === 'thread/realtime/appendSpeech'));
      const fala = paramsDe(falso, 'thread/realtime/appendSpeech');
      assert.equal(fala.threadId, 't1');
      assert.equal(fala.text, 'cheguei depois');
    } finally {
      await voz.pararTudo();
    }
  });

  test('resposta com depois fala o texto da pesquisa quando ela chega', async () => {
    const { voz, falso } = bancada({
      pedir: async () => ({ texto: 'pronto', depois: Promise.resolve('pesquisa pronta') }),
    });
    try {
      await voz.iniciar('v=0 oferta');
      falso.pedido(pedidoRpc(4, 'pesquisa isso'));
      await esperarAte(() => falso.pedidos.some((p) => p.method === 'thread/realtime/appendSpeech'));

      const fala = paramsDe(falso, 'thread/realtime/appendSpeech');
      assert.equal(fala.threadId, 't1');
      assert.equal(fala.text, 'pesquisa pronta');
    } finally {
      await voz.pararTudo();
    }
  });

  test('erro da OpenAI encerra a sessão, para o cliente e vira evento fim', async () => {
    const { voz, falso } = bancada();
    try {
      await voz.iniciar('v=0 oferta');
      falso.notificar({ method: 'thread/realtime/error', params: { threadId: 't1', message: 'x' } });

      assert.equal(voz.ativa, false);
      assert.equal(falso.paradas, 1);
      const fins = voz.eventosDesde(0).filter((e): e is Extract<EventoVoz, { tipo: 'fim' }> => e.tipo === 'fim');
      assert.equal(fins.length, 1);
      assert.equal(typeof fins[0]!.erro, 'string');
      assert.ok((fins[0]!.erro as string).length > 0);
    } finally {
      await voz.pararTudo();
    }
  });

  test('sem o SDP da OpenAI, iniciar falha dentro do prazo e o cliente é parado', async () => {
    const falso = new FakeRpc({ sdp: null });
    const { voz } = bancada({ falso, esperaSdpMs: 30 });
    await assert.rejects(voz.iniciar('v=0 oferta'), /não respondeu a tempo/);
    assert.equal(falso.paradas, 1);
    assert.equal(voz.ativa, false);
  });

  test('segundo iniciar fecha a primeira sessão', async () => {
    const fakes: FakeRpc[] = [];
    const voz = new VozAoVivo({
      pedir: async (texto: string) => ({ texto: 'resposta: ' + texto }),
      criarCliente: () => { const f = new FakeRpc(); fakes.push(f); return f; },
      esperaMs: 2_000,
      esperaSdpMs: 2_000,
    });
    try {
      const primeira = await voz.iniciar('v=0 oferta');
      const segunda = await voz.iniciar('v=0 outra oferta');
      assert.notEqual(primeira.sessionId, segunda.sessionId);
      assert.equal(segunda.sdp, 'v=0 resposta');
      assert.equal(fakes.length, 2);
      assert.equal(fakes[0]!.paradas, 1);
      assert.equal(fakes[1]!.paradas, 0);
      assert.equal(voz.ativa, true);
    } finally {
      await voz.pararTudo();
    }
  });

  test('transcrição do usuário vira evento com papel voce', async () => {
    const { voz, falso } = bancada();
    try {
      await voz.iniciar('v=0 oferta');
      falso.notificar({ method: 'thread/realtime/transcript/done', params: { threadId: 't1', role: 'user', text: 'oi' } });

      const transcricoes = voz.eventosDesde(0).filter((e) => e.tipo === 'transcricao');
      assert.deepEqual(transcricoes, [{ n: 1, tipo: 'transcricao', papel: 'voce', texto: 'oi' }]);
    } finally {
      await voz.pararTudo();
    }
  });
});

// ---------- Funções puras ----------

describe('voz ao vivo: funções puras', () => {
  test('limparDelegacao desembrulha o envelope do Codex e desfaz o escape', () => {
    assert.equal(limparDelegacao('<realtime_delegation><input>a &amp; b</input></realtime_delegation>'), 'a & b');
    assert.equal(limparDelegacao('texto comum'), 'texto comum');
  });

  test('paraVoz curto passa sem a marca', () => {
    const texto = paraVoz('oi, tudo bem?');
    assert.equal(texto, 'oi, tudo bem?');
    assert.ok(!texto.includes('[resposta longa]'));
  });

  test('resumoFalado longo termina mandando ver o painel', () => {
    const longo = 'Esta é uma frase de teste. '.repeat(60);
    assert.ok(Buffer.byteLength(longo) > 600);
    const resumo = resumoFalado(longo);
    assert.ok(resumo.endsWith('O resto está no painel.'));
    assert.ok(Buffer.byteLength(resumo) < Buffer.byteLength(longo));
  });

  test('explicarErro traduz o 401 para o login do Codex', () => {
    assert.match(explicarErro('erro 401: unauthorized'), /codex login/);
  });

  test('compararVersao ordena as versões do Codex', () => {
    assert.ok(compararVersao('0.170.0', '0.156.0') > 0);
    assert.ok(compararVersao('0.156.0', '0.170.0') < 0);
    assert.equal(compararVersao('0.156.0', '0.156.0'), 0);
  });
});


describe('voz ao vivo: correções da revisão', () => {
  test('sem conseguir ler o config do Codex, a voz não abre (MCP do Joel ficariam ligados)', async () => {
    const falso = new FakeRpc({ respostas: { 'config/read': {} } });
    const { voz } = bancada({ falso });
    await assert.rejects(voz.iniciar('v=0 oferta'), /configuração/);
    assert.equal(falso.paradas, 1);
    assert.ok(!falso.pedidos.some((p) => p.method === 'thread/start'), 'não pode abrir a ponte sem desligar os MCP');
  });

  test('o mesmo pedido em seguida não vai duas vezes ao NIGHT', async () => {
    const { voz, falso, pedidosAoNight } = bancada();
    try {
      await voz.iniciar('v=0 oferta');
      falso.pedido(pedidoRpc(1, 'pesquisa o dólar'));
      falso.pedido(pedidoRpc(2, 'pesquisa o dólar'));
      await esperarAte(() => falso.respondeu.length === 2);
      assert.deepEqual(pedidosAoNight, ['pesquisa o dólar']);
      const segunda = falso.respondeu.find((r) => r.id === 2)!.result as { success: boolean };
      assert.equal(segunda.success, false);
    } finally {
      await voz.pararTudo();
    }
  });

  test('mais de 8 pedidos por minuto são recusados', async () => {
    const { voz, falso, pedidosAoNight } = bancada();
    try {
      await voz.iniciar('v=0 oferta');
      for (let i = 1; i <= 9; i++) falso.pedido(pedidoRpc(i, `pedido ${i}`));
      await esperarAte(() => falso.respondeu.length === 9);
      assert.equal(pedidosAoNight.length, 8);
      assert.equal((falso.respondeu.find((r) => r.id === 9)!.result as { success: boolean }).success, false);
    } finally {
      await voz.pararTudo();
    }
  });

  test('resposta enorme é cortada antes de ir para a ponte', () => {
    const texto = paraVoz('Frase de teste longa. '.repeat(1000));
    assert.ok(texto.startsWith('[resposta longa]'));
    assert.ok(Buffer.byteLength(texto) < 4_000);
    assert.match(texto, /cortado/);
  });

  test('sem o painel perguntar pelos eventos, a voz desliga sozinha', async () => {
    const falso = new FakeRpc();
    const voz = new VozAoVivo({ pedir: async (t) => ({ texto: t }), criarCliente: () => falso, prazoSemPainelMs: 1 });
    await voz.iniciar('v=0 oferta');
    await esperarAte(() => !voz.ativa, 8_000);
    assert.equal(falso.paradas, 1);
    assert.match(String(voz.eventosDesde(0).find((e) => e.tipo === 'fim')?.erro), /painel/);
  });
});
