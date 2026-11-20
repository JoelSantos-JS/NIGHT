// Fonte do Radar pela Biblioteca de Anúncios da Meta (M02), com executor falso e pasta
// temporária: nada de rede nem do conector real. O que se prova aqui: a sessão do Claude
// Code roda só com as ferramentas de leitura e o MCP estrito; ferramenta de escrita é
// recusada no construtor; a resposta vira RawAd sem inventar campo; anúncio sem id é
// descartado; o cursor passa adiante; e erro de login/limite vira mensagem clara e curta.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import type { MetaMcpRun } from '../src/radar/meta-mcp-source.ts';
import { MetaMcpAdSource } from '../src/radar/meta-mcp-source.ts';

/** Executor falso: guarda a chamada e devolve o que o teste mandar. */
class FakeRun {
  calls: { bin: string; args: string[]; cwd: string; timeoutMs: number }[] = [];
  constructor(
    private readonly resposta: (args: string[]) => { code: number | null; stdout: string; stderr: string },
  ) {}

  readonly run: MetaMcpRun = async (bin, args, cwd, timeoutMs) => {
    this.calls.push({ bin, args, cwd, timeoutMs });
    return this.resposta(args);
  };
}

/** Saída do Claude CLI: JSON com o campo result, como em agents/research.ts. */
function saidaClaude(result: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: 'result', result, is_error: false, ...extra });
}

/** Resposta do modelo com os anúncios pedidos. */
function respostaMeta(payload: unknown): string {
  return saidaClaude(JSON.stringify(payload));
}

const FERRAMENTA_LEITURA = 'mcp__meta-ads__ads_library_search';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'night-meta-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

/** Fonte apontando para a pasta temporária e para o executor falso. */
function fonte(fake: FakeRun, extra: Partial<{ readTools: string[]; country: string }> = {}): MetaMcpAdSource {
  return new MetaMcpAdSource({
    run: fake.run,
    bin: 'claude-fake',
    readTools: extra.readTools ?? [FERRAMENTA_LEITURA],
    workDir: dir,
    ...(extra.country ? { country: extra.country } : {}),
  });
}

describe('sessão do Claude Code com o MCP da Meta', () => {
  test('roda com MCP estrito e só as ferramentas de leitura liberadas', async () => {
    const fake = new FakeRun(() => ({ code: 0, stdout: respostaMeta({ ads: [], nextCursor: null }), stderr: '' }));
    const source = fonte(fake);
    assert.equal(source.name, 'meta-ads-mcp');

    const r = await source.search('curso de violão', null, 10);
    assert.deepEqual(r.ads, []);
    assert.equal(r.nextCursor, null);

    const chamada = fake.calls[0]!;
    assert.equal(chamada.bin, 'claude-fake');
    assert.equal(chamada.cwd, dir, 'a sessão roda na pasta de trabalho da fonte');
    assert.equal(chamada.timeoutMs, 180_000);
    assert.ok(chamada.args.includes('--strict-mcp-config'));
    assert.ok(chamada.args.includes('--no-session-persistence'));
    assert.equal(chamada.args[chamada.args.indexOf('--output-format') + 1], 'json');
    assert.equal(chamada.args[chamada.args.indexOf('--permission-mode') + 1], 'default');

    // Config do MCP gravado na pasta de trabalho, só com o servidor da Meta.
    const configPath = chamada.args[chamada.args.indexOf('--mcp-config') + 1]!;
    assert.equal(configPath, join(dir, 'meta-mcp.json'));
    const config = JSON.parse(await readFile(configPath, 'utf8')) as unknown;
    assert.deepEqual(config, {
      mcpServers: { 'meta-ads': { type: 'http', url: 'https://mcp.facebook.com/ads' } },
    });

    // Entre --allowedTools e --disallowedTools só entram as ferramentas de leitura e a busca de ferramentas
    // (as da Meta somam mais de 200 mil tokens; sem a busca a sessão nem começa).
    const inicio = chamada.args.indexOf('--allowedTools') + 1;
    const fim = chamada.args.indexOf('--disallowedTools');
    assert.ok(inicio > 0 && fim > inicio);
    assert.deepEqual(chamada.args.slice(inicio, fim), [FERRAMENTA_LEITURA, 'ToolSearch']);

    // Nenhuma ferramenta de escrita aparece em lugar nenhum da linha de comando.
    for (const proibida of ['ads_create_campaign', 'ads_update_entity', 'ads_activate_entity']) {
      assert.ok(!chamada.args.some((arg) => arg.includes(proibida)), `${proibida} não pode ser liberada`);
    }
    const desabilitadas = chamada.args.slice(fim + 1, fim + 6);
    assert.deepEqual(desabilitadas, ['Bash', 'Edit', 'Write', 'WebFetch', 'WebSearch']);
  });

  test('ferramenta de escrita é recusada no construtor, sem rodar nada', () => {
    const fake = new FakeRun(() => ({ code: 0, stdout: '', stderr: '' }));
    const proibidas = [
      'mcp__meta-ads__ads_create_campaign',
      'mcp__meta-ads__ads_create_ad',
      'mcp__meta-ads__ads_update_entity',
      'mcp__meta-ads__ads_activate_entity',
      'mcp__meta-ads__ads_edit_creative',
      'mcp__meta-ads__ads_delete_creative',
      'mcp__meta-ads__ads_set_budget',
      'mcp__meta-ads__ads_edit_status',
    ];
    for (const tool of proibidas) {
      assert.throws(
        () => fonte(fake, { readTools: [tool] }),
        /só de leitura/,
        `${tool} precisa ser recusada`,
      );
    }
    assert.equal(fake.calls.length, 0);
  });

  test('a lista de leitura não pode vir vazia', () => {
    const fake = new FakeRun(() => ({ code: 0, stdout: '', stderr: '' }));
    assert.throws(() => fonte(fake, { readTools: [] }), /sem ferramenta de leitura/);
  });

  test('o prompt pede a palavra-chave, o país, a omissão de campo e proíbe criar/editar', async () => {
    const fake = new FakeRun(() => ({ code: 0, stdout: respostaMeta({ ads: [], nextCursor: null }), stderr: '' }));
    await fonte(fake).search('emagrecer sem academia', null, 25);

    const prompt = fake.calls[0]!.args[fake.calls[0]!.args.indexOf('-p') + 1]!;
    assert.match(prompt, /emagrecer sem academia/);
    assert.match(prompt, /país BR/);
    assert.match(prompt, /até 25 anúncios/);
    assert.match(prompt, /OMITIDO/);
    assert.match(prompt, /nunca estime/);
    assert.match(prompt, /Não crie, não edite e não ative/);
    assert.match(prompt, /dado de terceiros/);
    assert.match(prompt, /YYYY-MM-DD/);
    assert.ok(!prompt.includes('Comece pelo cursor'), 'sem cursor salvo não inventa um');
  });

  test('cursor salvo e país do construtor entram no prompt', async () => {
    const fake = new FakeRun(() => ({ code: 0, stdout: respostaMeta({ ads: [], nextCursor: 'prox' }), stderr: '' }));
    const r = await fonte(fake, { country: 'PT' }).search('x', 'pagina-2', 5);
    assert.equal(r.nextCursor, 'prox');
    const prompt = fake.calls[0]!.args[fake.calls[0]!.args.indexOf('-p') + 1]!;
    assert.match(prompt, /cursor "pagina-2"/);
    assert.match(prompt, /país PT/);
  });
});

describe('resposta do modelo vira RawAd', () => {
  test('JSON válido vira anúncio com todos os campos e o cursor repassado', async () => {
    const anuncio = {
      externalId: '120210000000000001',
      advertiser: 'Loja do Violão',
      adUrl: 'https://www.facebook.com/ads/library/?id=120210000000000001',
      landingUrl: 'https://lojadoviolao.com.br/curso',
      country: 'BR',
      startedAt: '2026-10-01',
      activeAdsInDomain: 42,
      anuncioTexto: 'Aprenda violão em 30 dias, sem sair de casa.',
    };
    const fake = new FakeRun(() => ({
      code: 0,
      stdout: respostaMeta({ ads: [anuncio], nextCursor: 'cursor-2', observacoes: 'a ferramenta não mostrou o gasto' }),
      stderr: '',
    }));

    const r = await fonte(fake).search('violão', null, 10);
    assert.deepEqual(r.ads, [anuncio]);
    assert.equal(r.nextCursor, 'cursor-2');
    assert.ok(r.observacoes.some((o) => o.includes('gasto')), 'observação do modelo é preservada');
  });

  test('JSON dentro de cerca markdown é aceito', async () => {
    const fake = new FakeRun(() => ({
      code: 0,
      stdout: saidaClaude(`\`\`\`json\n${JSON.stringify({ ads: [{ externalId: 'a-1' }], nextCursor: null })}\n\`\`\``),
      stderr: '',
    }));
    const r = await fonte(fake).search('x', null, 1);
    assert.deepEqual(r.ads, [{ externalId: 'a-1' }]);
  });

  test('campo com tipo errado é descartado e registrado, nunca inventado', async () => {
    const fake = new FakeRun(() => ({
      code: 0,
      stdout: respostaMeta({
        ads: [{
          externalId: 'ad-1',
          advertiser: 42,
          country: 'BR',
          startedAt: '2026-02-30',
          activeAdsInDomain: -3,
          anuncioTexto: 'texto ok',
        }],
        nextCursor: null,
      }),
      stderr: '',
    }));

    const r = await fonte(fake).search('x', null, 1);
    const [ad] = r.ads;
    assert.ok(ad);
    assert.deepEqual(ad, { externalId: 'ad-1', country: 'BR', anuncioTexto: 'texto ok' });
    assert.ok(!('advertiser' in ad), 'campo com tipo errado não vira valor');
    assert.ok(!('startedAt' in ad), 'data inexistente não vira data');
    assert.ok(!('activeAdsInDomain' in ad), 'negativo não vira zero');
    const texto = r.observacoes.join('\n');
    assert.match(texto, /advertiser/);
    assert.match(texto, /startedAt/);
    assert.match(texto, /activeAdsInDomain/);
  });

  test('activeAdsInDomain fracionário e data em outro formato também são descartados', async () => {
    const fake = new FakeRun(() => ({
      code: 0,
      stdout: respostaMeta({
        ads: [
          { externalId: 'ad-2', activeAdsInDomain: 2.5, startedAt: '01/10/2026' },
          { externalId: 'ad-3', activeAdsInDomain: '12', startedAt: '2026-11-17T10:00:00Z' },
        ],
        nextCursor: null,
      }),
      stderr: '',
    }));
    const r = await fonte(fake).search('x', null, 2);
    assert.deepEqual(r.ads, [{ externalId: 'ad-2' }, { externalId: 'ad-3', startedAt: '2026-11-17' }]);
  });

  test('anúncio sem externalId é descartado, sem ocupar a lista', async () => {
    const fake = new FakeRun(() => ({
      code: 0,
      stdout: respostaMeta({
        ads: [
          { advertiser: 'Sem id' },
          { externalId: '   ' },
          { externalId: 7 },
          'nem objeto',
          { externalId: 'bom' },
        ],
        nextCursor: null,
      }),
      stderr: '',
    }));

    const r = await fonte(fake).search('x', null, 5);
    assert.deepEqual(r.ads, [{ externalId: 'bom' }]);
    assert.ok(r.observacoes.filter((o) => o.includes('descartado')).length >= 3);
  });

  test('nextCursor ausente é null; com tipo errado é null e registrado', async () => {
    const semCursor = new FakeRun(() => ({ code: 0, stdout: respostaMeta({ ads: [] }), stderr: '' }));
    assert.equal((await fonte(semCursor).search('x', null, 1)).nextCursor, null);

    const cursorRuim = new FakeRun(() => ({
      code: 0,
      stdout: respostaMeta({ ads: [], nextCursor: 99 }),
      stderr: '',
    }));
    const r = await fonte(cursorRuim).search('x', null, 1);
    assert.equal(r.nextCursor, null);
    assert.ok(r.observacoes.some((o) => o.includes('nextCursor')));
  });

  test('resposta sem lista de anúncios é erro claro', async () => {
    const fake = new FakeRun(() => ({ code: 0, stdout: respostaMeta({ nextCursor: null }), stderr: '' }));
    await assert.rejects(fonte(fake).search('x', null, 1), /sem lista "ads"/);
  });

  test('result que não é JSON é erro claro', async () => {
    const fake = new FakeRun(() => ({ code: 0, stdout: saidaClaude('desculpa, não achei'), stderr: '' }));
    await assert.rejects(fonte(fake).search('x', null, 1), /não é JSON/);
  });
});

describe('falhas do conector', () => {
  test('"Please login" e OAuth viram mensagem clara, sem despejar a saída', async () => {
    const pedeLogin = new FakeRun(() => ({
      code: 0,
      stdout: JSON.stringify({ result: 'Please login to use the Meta Ads tools', is_error: true }),
      stderr: '',
    }));
    await assert.rejects(
      fonte(pedeLogin).search('x', null, 1),
      (erro: Error) => /não está logado/.test(erro.message) && /\/mcp/.test(erro.message),
    );

    const oauth = new FakeRun(() => ({ code: 1, stdout: '', stderr: 'OAuth token expired' }));
    await assert.rejects(fonte(oauth).search('x', null, 1), /não está logado/);
  });

  test('código diferente de zero sem pista de login vira erro com o motivo curto', async () => {
    const fake = new FakeRun(() => ({ code: 2, stdout: '', stderr: 'erro qualquer do conector' }));
    await assert.rejects(fonte(fake).search('x', null, 1), /Claude CLI falhou \(código 2\)/);
  });

  test('limite de uso vira erro de limite', async () => {
    const fake = new FakeRun(() => ({
      code: 1,
      stdout: '',
      stderr: 'Claude usage limit reached, try again at 7:22 PM',
    }));
    await assert.rejects(fonte(fake).search('x', null, 1), /limite de uso/);
  });

  test('a saída bruta na mensagem é cortada em 300 caracteres', async () => {
    const enorme = `${'x'.repeat(1000)} Please login`;
    const fake = new FakeRun(() => ({ code: 1, stdout: '', stderr: enorme }));
    await assert.rejects(fonte(fake).search('x', null, 1), (erro: Error) => {
      assert.ok(erro.message.length < 400, `mensagem longa demais: ${erro.message.length}`);
      assert.ok(!erro.message.includes('x'.repeat(301)));
      return true;
    });
  });
});
