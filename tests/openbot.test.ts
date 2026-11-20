import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import {
  OpenBotApi, OpenBotFechado,
  type AgenteApi, type EntregaApi, type PendentesApi,
} from '../src/openbot/api.ts';
import { acharAgente, OpenBotEspelho, textoPendencia } from '../src/openbot/espelho.ts';

/** Pasta temporária com (ou sem) os arquivos `url` e `token` que o OpenBot deixa em %APPDATA%. */
function pastaAutomacao(url: string | null, token: string | null): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'night-openbot-'));
  if (url !== null) writeFileSync(path.join(dir, 'url'), url);
  if (token !== null) writeFileSync(path.join(dir, 'token'), token);
  return dir;
}

const respostaJson = (dados: unknown, status = 200): Response =>
  new Response(JSON.stringify(dados), { status, headers: { 'content-type': 'application/json' } });

/** fetch falso: grava o que sairia para a rede e responde o que o teste mandar. */
function fetchFalso(responder: (url: string, init: RequestInit) => Response) {
  const chamadas: { url: string; init: RequestInit }[] = [];
  const f: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const opcoes = init ?? {};
    chamadas.push({ url, init: opcoes });
    return responder(url, opcoes);
  };
  return { f, chamadas };
}

describe('OpenBotApi (arquivos de automação + fetch falso)', () => {
  test('1. sem os arquivos url/token, agentes() rejeita com OpenBotFechado', async () => {
    const { f, chamadas } = fetchFalso(() => respostaJson([]));
    const api = new OpenBotApi({ pasta: pastaAutomacao(null, null), fetch: f });
    await assert.rejects(api.agentes(), OpenBotFechado);
    assert.equal(chamadas.length, 0);
  });

  test('2. url fora de 127.0.0.1/localhost rejeita e o token não sai do PC', async () => {
    const token = 'TOKEN-SECRETO-123';
    const { f, chamadas } = fetchFalso(() => respostaJson([]));
    const api = new OpenBotApi({ pasta: pastaAutomacao('http://evil.example:1', token), fetch: f });
    await assert.rejects(api.agentes(), OpenBotFechado);
    assert.equal(chamadas.length, 0, 'nenhum pedido foi feito');
    assert.doesNotMatch(JSON.stringify(chamadas), new RegExp(token));
  });

  test('3. agentes() manda o Bearer e devolve id/nome', async () => {
    const token = 'tok-abc';
    const { f, chamadas } = fetchFalso(() => respostaJson([{ id: 'a1', name: 'NIGHT Radar' }]));
    const api = new OpenBotApi({ pasta: pastaAutomacao('http://127.0.0.1:4599/', token), fetch: f });
    const agentes = await api.agentes();
    assert.deepEqual(agentes, [{ id: 'a1', name: 'NIGHT Radar' }]);
    assert.equal(chamadas.length, 1);
    const [chamada] = chamadas;
    assert.equal(chamada!.url, 'http://127.0.0.1:4599/v1/agents');
    assert.equal(chamada!.init.method, 'GET');
    assert.equal(new Headers(chamada!.init.headers).get('authorization'), `Bearer ${token}`);
  });

  test('4. enviar() faz POST na mensagem e devolve o deliveryId', async () => {
    const { f, chamadas } = fetchFalso(() => respostaJson({ deliveries: [{ id: 'd1', recipientAgentId: 'a1' }] }));
    const api = new OpenBotApi({ pasta: pastaAutomacao('http://127.0.0.1:4599', 'tok-abc'), fetch: f });
    const r = await api.enviar('a1', 'pesquisa café', 'cm-1');
    assert.deepEqual(r, { deliveryId: 'd1' });
    const [chamada] = chamadas;
    assert.equal(chamada!.url, 'http://127.0.0.1:4599/v1/agents/a1/messages');
    assert.equal(chamada!.init.method, 'POST');
    assert.equal(new Headers(chamada!.init.headers).get('content-type'), 'application/json');
    assert.deepEqual(JSON.parse(String(chamada!.init.body)), { text: 'pesquisa café', clientMessageId: 'cm-1' });
  });

  test('5. 401 vira OpenBotFechado, 429 fala de limite e o token nunca aparece no erro', async () => {
    const token = 'TOKEN-SECRETO-123';
    const pasta = pastaAutomacao('http://127.0.0.1:4599', token);

    const { f: f401 } = fetchFalso(() => respostaJson({ error: 'não autorizado' }, 401));
    await assert.rejects(new OpenBotApi({ pasta, fetch: f401 }).agentes(), (err: unknown) => {
      assert.ok(err instanceof OpenBotFechado);
      assert.doesNotMatch(err.message, new RegExp(token));
      return true;
    });

    const { f: f429 } = fetchFalso(() => respostaJson({ error: 'devagar' }, 429));
    const err = await new OpenBotApi({ pasta, fetch: f429 }).agentes().then(() => null, (e: Error) => e);
    assert.ok(err instanceof Error);
    assert.equal(err instanceof OpenBotFechado, false);
    assert.match(err.message, /limite/);
    assert.doesNotMatch(err.message, new RegExp(token));
  });
});

describe('acharAgente', () => {
  const agentes: AgenteApi[] = [
    { id: 'a1', name: 'NIGHT Radar' },
    { id: 'a2', name: 'NIGHT Código' },
  ];

  test('"Radar" acha o único "NIGHT Radar"; "night" é ambíguo', () => {
    assert.deepEqual(acharAgente(agentes, 'Radar'), agentes[0]);
    assert.equal(acharAgente(agentes, 'night'), 'varios');
  });

  test('nome exato ganha e acentos/maiúsculas não importam', () => {
    const comExato: AgenteApi[] = [{ id: 'x', name: 'Radar' }, { id: 'a1', name: 'NIGHT Radar' }];
    assert.deepEqual(acharAgente(comExato, 'Radar'), comExato[0]);
    assert.deepEqual(acharAgente(agentes, 'codigo'), agentes[1]);
    assert.deepEqual(acharAgente(agentes, 'CÓDIGO'), agentes[1]);
    assert.equal(acharAgente(agentes, 'Vídeo'), null);
  });
});

describe('textoPendencia', () => {
  test('usa title/description/command', () => {
    assert.equal(textoPendencia({ title: 'Rodar npm test' }), 'Rodar npm test');
    assert.equal(textoPendencia({ description: 'Confirmar deploy' }), 'Confirmar deploy');
    assert.equal(textoPendencia({ command: 'npm run build' }), 'npm run build');
  });

  test('sem campo conhecido não copia o objeto; com chave, apaga', () => {
    assert.match(textoPendencia({ foo: 'bar' }), /Veja os detalhes no OpenBot/);
    const chave = 'sk-' + 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5';
    const texto = textoPendencia({ title: `usa a chave ${chave}` });
    assert.doesNotMatch(texto, new RegExp(chave));
    assert.match(texto, /\[chave apagada\]/);
    const textoJson = textoPendencia({ bloco: { chave } });
    assert.doesNotMatch(textoJson, new RegExp(chave));
  });
});

/** API falsa no lugar de OpenBotApi: grava as chamadas e responde o que o teste armar. */
class ApiFalsa {
  agentesLista: AgenteApi[] = [{ id: 'a1', name: 'NIGHT Radar' }];
  falhaAgentes: Error | null = null;
  enviados: { agenteId: string; texto: string; clientMessageId: string }[] = [];
  entregas: EntregaApi[] = [];
  pendentesResp: PendentesApi = { prompts: [], approvals: [] };
  aprovacoes: { agenteId: string; pedidoId: string; decisao: 'accept' | 'decline' }[] = [];

  async agentes(): Promise<AgenteApi[]> {
    if (this.falhaAgentes) throw this.falhaAgentes;
    return this.agentesLista;
  }
  async enviar(agenteId: string, texto: string, clientMessageId: string): Promise<{ deliveryId: string | null }> {
    this.enviados.push({ agenteId, texto, clientMessageId });
    return { deliveryId: 'd1' };
  }
  async entrega(): Promise<EntregaApi> {
    return this.entregas.length > 1 ? this.entregas.shift()! : this.entregas.at(-1)!;
  }
  async pendentes(): Promise<PendentesApi> {
    return this.pendentesResp;
  }
  async responderAprovacao(agenteId: string, pedidoId: string, decisao: 'accept' | 'decline'): Promise<void> {
    this.aprovacoes.push({ agenteId, pedidoId, decisao });
  }
}

const espelhoCom = (api: ApiFalsa) =>
  new OpenBotEspelho({ api: api as unknown as OpenBotApi, passoTarefaMs: 5 });

describe('OpenBotEspelho', () => {
  test('6. enviar manda a tarefa, acompanha até completed e avisa', async () => {
    const api = new ApiFalsa();
    api.entregas = [
      { id: 'd1', status: 'running' },
      { id: 'd1', status: 'completed', answer: 'achei café' },
    ];
    const espelho = espelhoCom(api);
    const novidades: string[] = [];
    espelho.ouvir((t) => novidades.push(t));

    // O espelho usa setTimeout(...).unref(): sem outro handle, o processo isolado do teste drenaria
    // antes de o acompanhamento terminar. Um intervalo referenciado o mantém vivo.
    const segura = setInterval(() => {}, 1000);
    try {
      const r = await espelho.enviar('Radar', 'pesquisa café');
      assert.match(r.texto, /^Mandei para o NIGHT Radar do OpenBot\./);
      assert.ok(r.depois);
      const depois = await r.depois!;
      assert.equal(depois, 'O NIGHT Radar do OpenBot respondeu: achei café');
      assert.ok(novidades.includes(depois), 'ouvir recebeu a novidade');
    } finally {
      clearInterval(segura);
    }

    assert.deepEqual(api.enviados.map((e) => ({ agenteId: e.agenteId, texto: e.texto })),
      [{ agenteId: 'a1', texto: 'pesquisa café' }]);
    assert.equal(typeof api.enviados[0]!.clientMessageId, 'string');
    const tarefa = espelho.estado().tarefas[0]!;
    assert.equal(tarefa.status, 'completed');
    assert.equal(tarefa.resposta, 'achei café');
  });

  test('7. entrega failed fala do erro', async () => {
    const api = new ApiFalsa();
    api.entregas = [{ id: 'd1', status: 'failed', error: 'sem internet' }];
    const espelho = espelhoCom(api);
    const segura = setInterval(() => {}, 1000);
    try {
      const r = await espelho.enviar('Radar', 'pesquisa café');
      assert.equal(await r.depois!, 'A tarefa do NIGHT Radar do OpenBot falhou: sem internet');
    } finally {
      clearInterval(segura);
    }
    const tarefa = espelho.estado().tarefas[0]!;
    assert.equal(tarefa.status, 'failed');
    assert.equal(tarefa.erro, 'sem internet');
  });

  test('8. agente inexistente lista os agentes e não manda nada', async () => {
    const api = new ApiFalsa();
    api.agentesLista = [{ id: 'a1', name: 'NIGHT Radar' }, { id: 'a2', name: 'NIGHT Código' }];
    const espelho = espelhoCom(api);
    const r = await espelho.enviar('Pesquisa', 'pesquisa café');
    assert.match(r.texto, /^Não achei o agente "Pesquisa" no OpenBot\./);
    assert.match(r.texto, /NIGHT Radar, NIGHT Código/);
    assert.equal(r.depois, undefined);
    assert.equal(api.enviados.length, 0);
  });

  test('9. atualizar mostra pendências e avisa cada novidade uma vez só', async () => {
    const api = new ApiFalsa();
    api.pendentesResp = {
      approvals: [{ requestId: 'p1', title: 'Rodar npm test' }],
      prompts: [{ id: 'q1', question: 'Qual pasta?' }],
    };
    const espelho = espelhoCom(api);
    const novidades: string[] = [];
    espelho.ouvir((t) => novidades.push(t));

    await espelho.atualizar();
    await espelho.atualizar();

    const pendentes = espelho.estado().pendentes;
    const aprovacao = pendentes.find((p) => p.tipo === 'aprovacao')!;
    const pergunta = pendentes.find((p) => p.tipo === 'pergunta')!;
    assert.equal(aprovacao.id, 'p1');
    assert.equal(aprovacao.texto, 'Rodar npm test');
    assert.equal(pergunta.id, 'q1');
    assert.equal(pergunta.texto, 'Qual pasta?');
    assert.equal(novidades.length, 2, 'cada pendência avisou uma única vez');
  });

  test('10. OpenBotFechado deixa o estado desligado com o motivo', async () => {
    const api = new ApiFalsa();
    api.falhaAgentes = new OpenBotFechado('O OpenBot está fechado ou reiniciando.');
    const espelho = espelhoCom(api);
    await espelho.atualizar();
    const estado = espelho.estado();
    assert.equal(estado.ligado, false);
    assert.equal(estado.motivo, 'O OpenBot está fechado ou reiniciando.');
    assert.deepEqual(estado.agentes, []);
  });

  test('11. responderAprovacao só chama a API para pedido ainda pendente', async () => {
    const api = new ApiFalsa();
    api.pendentesResp = { approvals: [{ requestId: 'p1', title: 'Rodar npm test' }], prompts: [] };
    const espelho = espelhoCom(api);
    await espelho.atualizar();

    const sumiu = await espelho.responderAprovacao('a1', 'nao-existe', 'accept');
    assert.equal(sumiu, 'Esse pedido de aprovação não está mais pendente.');
    assert.equal(api.aprovacoes.length, 0);

    const aceito = await espelho.responderAprovacao('a1', 'p1', 'accept');
    assert.equal(aceito, 'Aceito no NIGHT Radar do OpenBot.');
    assert.deepEqual(api.aprovacoes, [{ agenteId: 'a1', pedidoId: 'p1', decisao: 'accept' }]);
    assert.equal(espelho.estado().pendentes.length, 0);
  });

  test('12. relatar guarda no começo, corta em 1000 e apaga chave', async () => {
    const api = new ApiFalsa();
    const espelho = espelhoCom(api);

    espelho.relatar('radar', 'fez X');
    assert.deepEqual(espelho.estado().relatos[0]!.texto, 'fez X');

    espelho.relatar('produto', 'fez Y');
    const relatos = espelho.estado().relatos;
    assert.equal(relatos.length, 2);
    assert.equal(relatos[0]!.tela, 'produto', 'mais novo no começo');

    espelho.relatar('codigo', 'z'.repeat(1500));
    assert.equal(espelho.estado().relatos[0]!.texto.length, 1000);

    const chave = 'sk-' + 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5';
    espelho.relatar('night', `usei ${chave}`);
    const texto = espelho.estado().relatos[0]!.texto;
    assert.doesNotMatch(texto, new RegExp(chave));
    assert.match(texto, /\[chave apagada\]/);
  });
});

describe('espelho: correções da revisão de 20/11', () => {
  test('pendência mostra o comando antes do título e nunca copia o objeto inteiro', () => {
    assert.equal(textoPendencia({ title: 'Aprovar ação', command: 'rm -rf build' }), 'rm -rf build — Aprovar ação');
    const sem = textoPendencia({ token: 'abc123secreto', outro: 1 });
    assert.doesNotMatch(sem, /abc123secreto/);
    assert.match(sem, /Veja os detalhes no OpenBot/);
  });
});
