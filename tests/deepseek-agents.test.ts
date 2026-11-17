// Reserva DeepSeek sem rede e sem banco: o fetch é falso e nenhuma chave real é usada (D11).

import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { describe, test } from 'node:test';
import {
  DEFAULT_BASE_URL, DEFAULT_MODEL, DeepSeekApi, DeepSeekChat, DeepSeekResearch, DeepSeekReviewer,
  MAX_DIFF_CHARS, deepSeekResearchPrompt,
} from '../src/agents/deepseek.ts';
import {
  DEEPSEEK_ANTHROPIC_URL, DEEPSEEK_BALANCE_URL, DEEPSEEK_MIN_BALANCE_USD, DeepSeekCodingAgent,
  type DeepSeekCodingAgentOptions,
} from '../src/agents/coding.ts';
import { agentEnv } from '../src/agents/env.ts';
import { QuotaError } from '../src/agents/research.ts';
import type { Worktree } from '../src/core/interfaces.ts';
import type { Task } from '../src/core/types.ts';

const KEY = 'sk-DEEPSEEK-TESTE-123';

type FetchCall = { url: string; method: string; headers: Record<string, string>; body: string };
type ChatBody = { model: string; messages: { role: string; content: string }[]; stream: boolean };

/** Fetch falso: guarda o que foi enviado e responde pelo handler. */
function fakeFetch(handler: (call: FetchCall) => Response | Promise<Response>): { fn: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    const call: FetchCall = {
      url: String(url),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: String(init?.body ?? ''),
    };
    calls.push(call);
    return handler(call);
  }) as unknown as typeof fetch;
  return { fn, calls };
}

function reply(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** Resposta da consulta de saldo: balance_infos com o total em dólar. */
function saldo(usd: string): Response {
  return new Response(JSON.stringify({ balance_infos: [{ currency: 'USD', total_balance: usd }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const sentBody = (call: FetchCall) => JSON.parse(call.body) as ChatBody;

function chat(fn: typeof fetch, over: { model?: string; timeoutMs?: number } = {}): DeepSeekChat {
  return new DeepSeekChat({ apiKey: () => KEY, fetchImpl: fn, ...over });
}

describe('cliente da API DeepSeek', () => {
  test('conversa: manda a persona e devolve o texto', async () => {
    const { fn, calls } = fakeFetch(() => reply('  Oi, Joel!  '));
    const r = await chat(fn).reply([], 'Bom dia', 'pt-BR', 'contexto do Night');
    assert.equal(r, 'Oi, Joel!');
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, `${DEFAULT_BASE_URL}/chat/completions`);
    assert.equal(calls[0]!.method, 'POST');
    assert.equal(calls[0]!.headers.authorization, `Bearer ${KEY}`);
    const body = sentBody(calls[0]!);
    assert.equal(body.model, DEFAULT_MODEL);
    assert.equal(body.stream, false);
    assert.match(body.messages[0]!.content, /Você é o Night/);
    assert.match(body.messages[0]!.content, /Você não tem internet nesta conversa/);
    assert.match(body.messages[0]!.content, /Bom dia/);
    assert.match(body.messages[0]!.content, /contexto do Night/);
  });

  test('id identifica o modelo efetivo da reserva', () => {
    const fn = fakeFetch(() => reply('x')).fn;
    assert.equal(new DeepSeekChat({ apiKey: () => KEY, fetchImpl: fn, model: 'deepseek-flash' }).id, 'deepseek:deepseek-flash');
    assert.equal(chat(fn, { model: 'deepseek-v4-pro' }).id, 'deepseek:deepseek-v4-pro');
  });

  test('modelo padrão vem de NIGHT_DEEPSEEK_MODEL', () => {
    const before = process.env.NIGHT_DEEPSEEK_MODEL;
    try {
      delete process.env.NIGHT_DEEPSEEK_MODEL;
      assert.equal(new DeepSeekApi({ apiKey: () => KEY }).model, 'deepseek-flash');
      process.env.NIGHT_DEEPSEEK_MODEL = 'deepseek-v4-pro';
      assert.equal(new DeepSeekApi({ apiKey: () => KEY }).model, 'deepseek-v4-pro');
    } finally {
      if (before === undefined) delete process.env.NIGHT_DEEPSEEK_MODEL;
      else process.env.NIGHT_DEEPSEEK_MODEL = before;
    }
  });

  test('402 (sem saldo) vira QuotaError: o NIGHT tenta o próximo', async () => {
    const { fn } = fakeFetch(() => new Response('sem saldo', { status: 402 }));
    await assert.rejects(chat(fn).reply([], 'oi', 'pt-BR', ''), (err: unknown) => err instanceof QuotaError);
  });

  test('429 (limite) vira QuotaError', async () => {
    const { fn } = fakeFetch(() => new Response('limite', { status: 429 }));
    await assert.rejects(chat(fn).reply([], 'oi', 'pt-BR', ''), (err: unknown) => err instanceof QuotaError);
  });

  test('timeout cobre a leitura do corpo, não só os cabeçalhos', async () => {
    // O fetch responde, mas o corpo nunca termina: o AbortController precisa encerrar mesmo assim.
    const fn = (async () => ({ ok: true, status: 200, json: () => new Promise<never>(() => {}) })) as unknown as typeof fetch;
    await assert.rejects(chat(fn, { timeoutMs: 30 }).reply([], 'oi', 'pt-BR', ''), /passou de 30 ms/);
  });

  test('erro nunca mostra a chave', async () => {
    const http = fakeFetch(() => new Response('erro', { status: 500 })).fn;
    await assert.rejects(chat(http).reply([], 'oi', 'pt-BR', ''), (err: Error) => {
      assert.match(err.message, /HTTP 500/);
      assert.ok(!err.message.includes(KEY), 'a chave vazou na mensagem');
      return true;
    });
    const network = (async () => { throw new Error(`falha de rede com ${KEY}`); }) as unknown as typeof fetch;
    await assert.rejects(chat(network).reply([], 'oi', 'pt-BR', ''), (err: Error) => {
      assert.ok(!err.message.includes(KEY), 'a chave vazou no erro de rede');
      return true;
    });
  });
});

describe('pesquisa da reserva (sem internet)', () => {
  test('o prompt manda avisar que não houve busca e não inventar', async () => {
    const prompt = deepSeekResearchPrompt('cotação do dólar', 'pt-BR');
    assert.match(prompt, /sem busca na internet; pode estar desatualizado/);
    assert.match(prompt, /Nunca invente número, data ou fonte/);
    assert.match(deepSeekResearchPrompt('x', 'en'), /without internet search; it may be outdated/);
  });

  test('a pergunta vai no prompt e a resposta volta como está', async () => {
    const { fn, calls } = fakeFetch(() => reply('Sem busca na internet; pode estar desatualizado. Acho que é 5 reais.'));
    const r = await new DeepSeekResearch({ apiKey: () => KEY, fetchImpl: fn }).ask('cotação do dólar', 'pt-BR');
    assert.match(r.answer, /^Sem busca na internet/);
    assert.equal(r.ms >= 0, true);
    assert.match(sentBody(calls[0]!).messages[0]!.content, /sem busca na internet; pode estar desatualizado/);
    assert.match(sentBody(calls[0]!).messages[0]!.content, /cotação do dólar/);
  });
});

describe('revisor da reserva', () => {
  const worktree: Worktree = { path: 'D:/NIGHT-data/worktrees/night/deepseek-t1', branch: 'agent/deepseek/t1', baseRef: 'abc123def456' };

  test('lê o diff da worktree e devolve o texto da revisão', async () => {
    const seen: Worktree[] = [];
    const { fn, calls } = fakeFetch(() => reply('VEREDITO: aprovar\n- nada grave'));
    const reviewer = new DeepSeekReviewer({
      apiKey: () => KEY, fetchImpl: fn,
      diff: async (wt) => { seen.push(wt); return '+export function parse() {}'; },
    });
    const r = await reviewer.review(worktree, 'revise o diff');
    assert.equal(r, 'VEREDITO: aprovar\n- nada grave');
    assert.deepEqual(seen, [worktree]);
    const prompt = sentBody(calls[0]!).messages[0]!.content;
    assert.match(prompt, /revise o diff/);
    assert.match(prompt, /\+export function parse/);
    assert.doesNotMatch(prompt, /foi cortado/);
  });

  test('diff grande é cortado e o prompt avisa', async () => {
    const big = 'x'.repeat(MAX_DIFF_CHARS + 1000);
    const { fn, calls } = fakeFetch(() => reply('VEREDITO: corrigir'));
    const reviewer = new DeepSeekReviewer({ apiKey: () => KEY, fetchImpl: fn, diff: async () => big });
    await reviewer.review(worktree, 'revise isso');
    const prompt = sentBody(calls[0]!).messages[0]!.content;
    assert.match(prompt, new RegExp(`passou de ${MAX_DIFF_CHARS} caracteres e foi cortado`));
    assert.match(prompt, /<diff_da_worktree>/);
    assert.ok(prompt.length < big.length, 'o diff inteiro não foi enviado');
  });
});

describe('executor DeepSeek em modo --bare (D12/H01)', () => {
  const worktree: Worktree = { path: 'D:/NIGHT-data/worktrees/night/deepseek-t1', branch: 'agent/deepseek/t1', baseRef: 'abc123def456' };
  const task = { id: 't1', projectId: 'night', objective: 'mudar o parser' } as Task;

  const executor = (over: DeepSeekCodingAgentOptions = {}) =>
    new DeepSeekCodingAgent({ bin: 'C:/fake/claude.exe', apiKey: () => KEY, fetchImpl: fakeFetch(() => saldo('10.00')).fn, ...over });

  /** Os métodos não são públicos; o teste lê o que o processo filho receberia. */
  const internals = (agent: DeepSeekCodingAgent) =>
    agent as unknown as {
      command(prompt: string): { bin: string | null; args: string[] };
      env(): NodeJS.ProcessEnv;
    };

  test('args: mesma CLI em --bare, sem commit/add e sem a chave', () => {
    const { bin, args } = internals(executor()).command('mude o parser');
    assert.equal(bin, 'C:/fake/claude.exe');
    const all = args.join(' ');
    assert.match(all, /--bare/);
    assert.match(all, /--strict-mcp-config/);
    assert.match(all, /-p mude o parser/);
    assert.match(all, /--model deepseek-flash/);
    assert.ok(!all.includes(KEY), 'a chave não pode ir nos args');
    // --allowedTools é o que ele PODE fazer: sem git add e sem git commit (quem versiona é o NIGHT).
    const allowed = args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--disallowedTools')).join(' ');
    assert.doesNotMatch(allowed, /git (add|commit|push)/);
    assert.match(allowed, /Bash\(git diff:\*\)/);
    // O que é proibido fica explícito.
    const disallowed = args.slice(args.indexOf('--disallowedTools') + 1).join(' ');
    for (const tool of ['WebFetch', 'WebSearch', 'Bash(git push:*)', 'Bash(git commit:*)', 'Bash(git reset:*)',
      'Bash(git checkout:*)', 'Bash(git switch:*)', 'Bash(rm:*)', 'Bash(curl:*)', 'Bash(ssh:*)']) {
      assert.ok(disallowed.includes(tool), `${tool} deveria estar proibido`);
    }
  });

  test('env do filho aponta para a API do DeepSeek e leva a chave; o env padrão continua sem ela', () => {
    const env = internals(executor()).env();
    assert.equal(env.ANTHROPIC_BASE_URL, DEEPSEEK_ANTHROPIC_URL);
    assert.equal(env.ANTHROPIC_API_KEY, KEY);
    assert.equal(env.ANTHROPIC_MODEL, 'deepseek-flash');
    assert.equal(env.ANTHROPIC_SMALL_FAST_MODEL, 'deepseek-flash');
    assert.match(env.CLAUDE_CONFIG_DIR!, /\.deepseek[\\/]claude-config$/);
    assert.equal(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, '1');
    assert.equal(env.DISABLE_TELEMETRY, '1');
    assert.equal(env.DISABLE_AUTOUPDATER, '1');
    // O gancho padrão (Claude/Codex) não herda chave nenhuma.
    const padrao = agentEnv({ PATH: 'C:\\Windows', ANTHROPIC_API_KEY: KEY, DEEPSEEK_API_KEY: KEY } as NodeJS.ProcessEnv);
    assert.equal(padrao.ANTHROPIC_API_KEY, undefined);
    assert.equal(padrao.DEEPSEEK_API_KEY, undefined);
  });

  test('modelo do executor vem de NIGHT_CODE_DEEPSEEK_MODEL', () => {
    const before = process.env.NIGHT_CODE_DEEPSEEK_MODEL;
    try {
      delete process.env.NIGHT_CODE_DEEPSEEK_MODEL;
      assert.equal(internals(executor()).env().ANTHROPIC_MODEL, 'deepseek-flash');
      process.env.NIGHT_CODE_DEEPSEEK_MODEL = 'deepseek-v4-pro';
      assert.equal(internals(executor()).env().ANTHROPIC_MODEL, 'deepseek-v4-pro');
    } finally {
      if (before === undefined) delete process.env.NIGHT_CODE_DEEPSEEK_MODEL;
      else process.env.NIGHT_CODE_DEEPSEEK_MODEL = before;
    }
  });

  test('saldo abaixo de US$ 0,05 recusa começar, sem rodar o CLI', async () => {
    const { fn, calls } = fakeFetch(() => saldo('0.01'));
    const agent = new DeepSeekCodingAgent({ bin: 'C:/nao-existe/claude.exe', apiKey: () => KEY, fetchImpl: fn });
    await assert.rejects(agent.start(task, worktree, 'mude o parser'), (err: Error) => {
      assert.match(err.message, /abaixo do mínimo/);
      assert.ok(!err.message.includes(KEY), 'a chave vazou na mensagem');
      return true;
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, DEEPSEEK_BALANCE_URL);
    assert.equal(calls[0]!.headers.authorization, `Bearer ${KEY}`);
  });

  test('available() também confere o saldo e explica o que falta', async () => {
    const agent = new DeepSeekCodingAgent({
      bin: process.execPath, apiKey: () => KEY, fetchImpl: fakeFetch(() => saldo('0.00')).fn,
    });
    const r = await agent.available();
    assert.equal(r.ok, false);
    assert.match(r.detail, /abaixo do mínimo/);
  });

  test('o resumo leva o custo pela diferença de saldo antes/depois', async () => {
    let n = 0;
    const { fn, calls } = fakeFetch(() => saldo(n++ === 0 ? '1.00' : '0.90'));
    // CLI falsa: só imprime o JSON que o readResult espera. Nada de rede nem do Claude de verdade.
    class CliFalsa extends DeepSeekCodingAgent {
      protected command() {
        return { bin: process.execPath, args: ['-e', 'process.stdout.write(JSON.stringify({result:"fiz o parser"}))'] };
      }
    }
    const agent = new CliFalsa({ apiKey: () => KEY, fetchImpl: fn, timeoutMs: 20_000 });
    // A CLI falsa roda de verdade: precisa de uma pasta que exista como cwd.
    const run = await agent.start(task, { ...worktree, path: tmpdir() }, 'faz');
    const outcome = await run.done as { exitCode: number | null; summary: string };
    assert.equal(outcome.exitCode, 0);
    assert.match(outcome.summary, /fiz o parser/);
    assert.match(outcome.summary, new RegExp(`custo DeepSeek: US\\$ 0\\.1000`));
    assert.equal(calls.length, 2, 'saldo antes e depois');
    assert.ok(calls.every((c) => c.url === DEEPSEEK_BALANCE_URL && !c.body.includes(KEY)), 'nada de chave no corpo');
  });

  test('o mínimo configurado é US$ 0,05', () => {
    assert.equal(DEEPSEEK_MIN_BALANCE_USD, 0.05);
  });
});
