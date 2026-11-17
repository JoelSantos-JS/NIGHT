import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { NightCoordinator } from '../src/app/coordinator.ts';
import { PgMemory } from '../src/memory/pg-memory.ts';
import { NightRouter, ruleIntent } from '../src/router/router.ts';
import { detectRunner, findFolders, matchScore, type RunPlan } from '../src/tools/projects.ts';
import { FakeLlm, resetTestDb, TEST_URL, truncateAll } from './helpers.ts';

describe('achar pasta e rodar projeto (uso real 04/11)', () => {
  let root: string;
  before(() => {
    root = mkdtempSync(path.join(tmpdir(), 'night-pc-'));
    mkdirSync(path.join(root, 'Desktop', 'AWS PREP', 'aws-ai-practitioner'), { recursive: true });
    writeFileSync(path.join(root, 'Desktop', 'AWS PREP', 'aws-ai-practitioner', 'index.html'), '<h1>oi</h1>');
    mkdirSync(path.join(root, 'Desktop', 'site-node'), { recursive: true });
    writeFileSync(path.join(root, 'Desktop', 'site-node', 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }));
    writeFileSync(path.join(root, 'Desktop', 'site-node', 'pnpm-lock.yaml'), '');
    mkdirSync(path.join(root, 'Desktop', 'P'), { recursive: true });
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  test('"AWS Prepping" acha "AWS PREP"; pasta de 1 letra não casa', () => {
    assert.ok(matchScore('AWS PREP', 'AWS Prepping') >= 80);
    assert.equal(matchScore('P', 'AWS Prepping'), 0);
    const hits = findFolders('AWS Prepping', [path.join(root, 'Desktop')]);
    assert.equal(hits[0]!.name, 'AWS PREP');
    assert.equal(hits.length, 1);
  });

  test('descobre como rodar: site estático na subpasta, Node pelo script dev', () => {
    const s = detectRunner(path.join(root, 'Desktop', 'AWS PREP'));
    assert.equal(s.kind, 'static');
    assert.match(s.dir, /aws-ai-practitioner$/);
    const n = detectRunner(path.join(root, 'Desktop', 'site-node'));
    assert.deepEqual(n.kind === 'node' && [n.command, n.needsInstall], ['pnpm install; pnpm dev', true]);
  });

  test('roteador: rodar e procurar, com o nome do alvo', () => {
    const r = ruleIntent('Eu quero que você procure uma parte chamada AWS Prepping. Eu quero que você roda o AWS Prepping pra mim.', []);
    assert.deepEqual(r, { kind: 'run-project', target: 'AWS Prepping' });
    assert.deepEqual(ruleIntent('procura a pasta crypto arbitrage no desktop', []), { kind: 'find-folder', target: 'crypto arbitrage' });
    assert.deepEqual(ruleIntent('você vai procurar aqui no meu PC as pastas, no desktop', []), { kind: 'find-folder', target: '' });
    assert.equal(ruleIntent('abre uma ideia nova: app de receitas', [])?.kind, 'save-idea');
  });

  describe('no coordenador', () => {
    let mem: PgMemory;
    const launched: RunPlan[] = [];
    const launcher = { async launch(plan: RunPlan) { launched.push(plan); return { ok: true, detail: 'janela aberta' }; } };
    const make = () => {
      const llm = new FakeLlm();
      return new NightCoordinator(mem, new NightRouter(llm, async () => (await mem.listProjects()).map((p) => p.name)), llm, {
        launcher,
        folderSearch: (s) => findFolders(s, [path.join(root, 'Desktop')]),
      });
    };
    before(async () => { await resetTestDb(); mem = await PgMemory.open(TEST_URL); });
    after(async () => { await mem?.close(); });
    beforeEach(async () => { await truncateAll(); launched.length = 0; });

    test('acha, cadastra, pergunta e só roda depois do "pode"', async () => {
      const n = make();
      const ask = await n.handle('roda o AWS Prepping pra mim');
      assert.match(ask.text, /^Achei o AWS PREP em .*aws-ai-practitioner\. É um site estático.* Posso rodar\?$/);
      assert.equal(launched.length, 0, 'não roda sem confirmar');
      assert.ok(await mem.findProjectByName('AWS PREP'), 'virou projeto');
      const ok = await n.handle('pode');
      assert.match(ok.text, /^Abri o AWS PREP numa janela própria/);
      assert.equal(launched.length, 1);
    });

    test('"não" ou outra coisa não roda; "roda o outro" não confirma', async () => {
      const n = make();
      await n.handle('roda o AWS Prepping pra mim');
      await n.handle('não, deixa pra depois');
      assert.equal(launched.length, 0);
      await n.handle('roda o AWS Prepping pra mim');
      await n.handle('roda o site node');
      assert.equal(launched.length, 0, '"roda o site node" pergunta de novo, não confirma o anterior');
    });

    test('procurar sem nome pergunta qual', async () => {
      assert.equal((await make().handle('procura aqui no meu PC as pastas')).text, 'Qual pasta? Fala o nome dela.');
    });
  });
});
