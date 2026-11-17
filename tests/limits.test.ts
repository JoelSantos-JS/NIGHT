// Testes de F05 sem banco e sem rede: limites por trabalho e credenciais por integração.
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { inspect } from 'node:util';
import { CredentialStore, INTEGRATIONS, redactSecrets } from '../src/jobs/credentials.ts';
import { DEFAULT_LIMITS, LimitExceededError, LimitTracker, parseLimits } from '../src/jobs/limits.ts';

const MB = 1024 * 1024;
const SEGREDO = 'sk-TESTE-999';

/** Relógio falso: o teste manda no tempo sem esperar. */
function relogio(inicio = 1_000_000): { now: () => number; passar: (ms: number) => void } {
  let agora = inicio;
  return { now: () => agora, passar: (ms) => { agora += ms; } };
}

/** Store com env e arquivos falsos: nada toca o disco de verdade. */
function storeFalsa(env: NodeJS.ProcessEnv = {}, arquivos: Record<string, string> = {}): CredentialStore {
  return new CredentialStore({
    env,
    exists: (caminho) => caminho in arquivos,
    readFile: (caminho) => arquivos[caminho] ?? '',
  });
}

describe('parseLimits', () => {
  test('junta os ajustes com o padrão do tipo de trabalho', () => {
    assert.deepEqual(parseLimits(undefined, 'radar'), DEFAULT_LIMITS.radar);
    assert.deepEqual(parseLimits(null, 'video'), DEFAULT_LIMITS.video);
    assert.deepEqual(parseLimits({}, 'coding'), DEFAULT_LIMITS.coding);
    assert.deepEqual(parseLimits({ maxCalls: 5 }, 'radar'), { ...DEFAULT_LIMITS.radar, maxCalls: 5 });
  });

  test('padrões são conservadores e completos', () => {
    assert.deepEqual(DEFAULT_LIMITS.radar, {
      maxCalls: 50,
      maxMs: 20 * 60_000,
      maxStorageBytes: 50 * MB,
      maxCostUsd: 0.5,
    });
    assert.deepEqual(DEFAULT_LIMITS.video, {
      maxCalls: 200,
      maxMs: 60 * 60_000,
      maxStorageBytes: 2 * 1024 ** 3,
      maxCostUsd: 1,
    });
    assert.deepEqual(DEFAULT_LIMITS.coding, {
      maxCalls: 100,
      maxMs: 30 * 60_000,
      maxStorageBytes: 200 * MB,
      maxCostUsd: 0.5,
    });
  });

  test('recusa negativo, NaN, texto e campo desconhecido', () => {
    assert.throws(() => parseLimits({ maxCalls: -1 }, 'radar'), /número maior ou igual a zero/);
    assert.throws(() => parseLimits({ maxMs: Number.NaN }, 'radar'), /número maior ou igual a zero/);
    assert.throws(() => parseLimits({ maxStorageBytes: Number.POSITIVE_INFINITY }, 'radar'), /maior ou igual a zero/);
    assert.throws(() => parseLimits({ maxCostUsd: '1' }, 'radar'), /número maior ou igual a zero/);
    assert.throws(() => parseLimits({ maxCall: 10 }, 'radar'), /limite desconhecido: maxCall/);
    assert.throws(() => parseLimits('50', 'radar'), /esperava um objeto/);
  });
});

describe('LimitTracker', () => {
  test('estoura chamadas só depois de passar do teto', () => {
    const t = new LimitTracker({ maxCalls: 2 });
    assert.deepEqual(t.check(), { ok: true });
    t.call();
    t.call();
    assert.deepEqual(t.check(), { ok: true }, 'igual ao teto ainda passou');
    t.call();
    assert.deepEqual(t.check(), { ok: false, limit: 'calls', detail: 'passou do limite de 2 chamadas' });
  });

  test('assertWithin conta a próxima chamada: teto 2 barra a terceira', () => {
    const t = new LimitTracker({ maxCalls: 2 });
    t.assertWithin(); // nenhuma chamada ainda: a próxima seria a 1ª
    t.call();
    t.assertWithin(); // 1 chamada: a próxima seria a 2ª, permitida
    t.call();
    assert.throws(
      () => t.assertWithin(),
      (err: unknown) => err instanceof LimitExceededError && err.limit === 'calls'
        && /a próxima chamada passaria do limite de 2 chamadas/.test(err.message),
      'com 2 chamadas a próxima passaria do teto',
    );
    // check() continua relatando o que já aconteceu: no teto ainda não estourou.
    assert.deepEqual(t.check(), { ok: true });
    assert.equal(t.usage().calls, 2, 'assertWithin não conta a chamada recusada');
  });

  test('estoura armazenamento', () => {
    const t = new LimitTracker({ maxStorageBytes: 2 * MB });
    t.addStorage(MB);
    t.addStorage(MB);
    assert.deepEqual(t.check(), { ok: true });
    t.addStorage(1);
    assert.deepEqual(t.check(), { ok: false, limit: 'storage', detail: 'passou do limite de 2 MB' });
  });

  test('estoura custo', () => {
    const t = new LimitTracker({ maxCostUsd: 0.5 });
    t.addCost(0.25);
    t.addCost(0.25);
    assert.deepEqual(t.check(), { ok: true });
    t.addCost(0.01);
    assert.deepEqual(t.check(), { ok: false, limit: 'cost', detail: 'passou do limite de US$ 0,50' });
  });

  test('estoura tempo contado desde a criação do tracker', () => {
    const r = relogio();
    const t = new LimitTracker({ maxMs: 60_000 }, r.now);
    r.passar(60_000);
    assert.deepEqual(t.check(), { ok: true });
    r.passar(1);
    assert.deepEqual(t.check(), { ok: false, limit: 'time', detail: 'passou do limite de 1 minuto' });
  });

  test('assertWithin lança LimitExceededError com .limit certo', () => {
    const t = new LimitTracker({ maxCalls: 1 });
    t.call(2);
    assert.throws(
      () => t.assertWithin(),
      (err: unknown) => {
        assert.ok(err instanceof LimitExceededError);
        assert.equal(err.limit, 'calls');
        assert.equal(err.name, 'LimitExceededError');
        assert.match(err.message, /limite de 1 chamada/);
        return true;
      },
    );
    const r = relogio();
    const lento = new LimitTracker({ maxMs: 1000 }, r.now);
    r.passar(1001);
    assert.throws(
      () => lento.assertWithin(),
      (err: unknown) => err instanceof LimitExceededError && err.limit === 'time',
    );
  });

  test('usage resume o que foi gasto', () => {
    const r = relogio();
    const t = new LimitTracker({}, r.now);
    t.call(3);
    t.addStorage(7);
    t.addCost(0.125);
    r.passar(250);
    assert.deepEqual(t.usage(), { calls: 3, ms: 250, storageBytes: 7, costUsd: 0.125 });
  });

  test('recusa contagem e gastos inválidos', () => {
    const t = new LimitTracker({});
    assert.throws(() => t.call(0), /ao menos 1/);
    assert.throws(() => t.addStorage(-1), /maior ou igual a zero/);
    assert.throws(() => t.addCost(Number.NaN), /maior ou igual a zero/);
  });
});

describe('CredentialStore', () => {
  test('cada integração tem sua credencial e seus escopos', () => {
    assert.equal(INTEGRATIONS.deepseek.env, 'DEEPSEEK_API_KEY');
    assert.equal(INTEGRATIONS.deepseek.file, '~/.deepseek/api_key');
    assert.deepEqual([...INTEGRATIONS.deepseek.scopes], ['parecer', 'reserva', 'executor']);
    assert.deepEqual([...INTEGRATIONS.meta_ads.scopes], ['leitura']);
    assert.deepEqual([...INTEGRATIONS.executor.scopes], ['leitura']);
  });

  test('disponível pelo ambiente, sem expor o valor no status', () => {
    const s = storeFalsa({ DEEPSEEK_API_KEY: SEGREDO });
    assert.deepEqual(s.status('deepseek'), { integration: 'deepseek', available: true, missing: null });
    assert.equal(s.get('deepseek', 'parecer'), SEGREDO);
  });

  test('disponível pelo arquivo em ~/.deepseek/api_key', () => {
    const arquivo = join(homedir(), '.deepseek', 'api_key');
    const s = storeFalsa({}, { [arquivo]: `${SEGREDO}\n` });
    assert.equal(s.status('deepseek').available, true);
    assert.equal(s.get('deepseek', 'parecer'), SEGREDO);
  });

  test('faltando explica o que fazer, sem mostrar valor', () => {
    const s = storeFalsa({});
    assert.deepEqual(s.status('deepseek'), {
      integration: 'deepseek',
      available: false,
      missing: 'falta a chave do DeepSeek: defina DEEPSEEK_API_KEY ou crie ~/.deepseek/api_key',
    });
    assert.equal(s.status('meta_ads').missing, 'falta o token do Meta Ads: defina NIGHT_META_ADS_TOKEN');
    assert.equal(s.status('executor').missing, 'falta o token do executor: defina NIGHT_EXECUTOR_TOKEN');
    assert.throws(() => s.get('meta_ads', 'leitura'), /falta o token do Meta Ads/);
  });

  test('escopo fora da integração é negado', () => {
    const s = storeFalsa({ NIGHT_META_ADS_TOKEN: SEGREDO });
    assert.equal(s.get('meta_ads', 'leitura'), SEGREDO);
    assert.throws(() => s.get('meta_ads', 'publicar'), /escopo publicar não permitido para meta_ads/);
  });

  test('JSON e util.inspect não contêm o segredo', () => {
    const s = storeFalsa({
      DEEPSEEK_API_KEY: SEGREDO,
      NIGHT_META_ADS_TOKEN: SEGREDO,
      NIGHT_EXECUTOR_TOKEN: SEGREDO,
    });
    const json = JSON.stringify(s);
    assert.ok(!json.includes(SEGREDO), 'JSON vazou o segredo');
    assert.deepEqual(JSON.parse(json), {
      deepseek: { available: true },
      meta_ads: { available: true },
      executor: { available: true },
    });
    const mostrado = inspect(s, { depth: 5 });
    assert.ok(!mostrado.includes(SEGREDO), 'inspect vazou o segredo');
    assert.match(mostrado, /CredentialStore/);
  });

  test('mensagem de erro não contém o segredo', () => {
    const s = storeFalsa({ NIGHT_META_ADS_TOKEN: SEGREDO });
    assert.throws(
      () => s.get('meta_ads', 'publicar'),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(!err.message.includes(SEGREDO), 'erro vazou o segredo');
        return true;
      },
    );
  });
});

describe('redactSecrets', () => {
  test('troca todas as ocorrências de cada segredo', () => {
    const texto = `chave ${SEGREDO}; repetida ${SEGREDO}; outra OUTRO-SEGREDO`;
    assert.equal(
      redactSecrets(texto, [SEGREDO, 'OUTRO-SEGREDO']),
      'chave [segredo]; repetida [segredo]; outra [segredo]',
    );
  });

  test('ignora segredo curto demais e texto sem segredo', () => {
    assert.equal(redactSecrets('abc aparece aqui', ['abc']), 'abc aparece aqui');
    assert.equal(redactSecrets('nada a esconder', []), 'nada a esconder');
  });
});
