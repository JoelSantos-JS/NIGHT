import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { ArtifactStore } from '../src/artifacts/store.ts';

describe('ArtifactStore', () => {
  let root: string;
  let store: ArtifactStore;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'night-artefatos-'));
    store = new ArtifactStore(root);
  });

  after(async () => { await rm(root, { recursive: true, force: true }); });

  test('add grava arquivos e verify fica ok', async () => {
    const video = await store.add('job-ok', {
      name: 'video.mp4', data: Buffer.from('bytes do vídeo'), origin: 'render', kind: 'video',
    });
    assert.equal(video.version, 1);
    await store.add('job-ok', { name: 'roteiro.txt', data: 'texto', origin: 'agente' });
    const manifest = await store.manifest('job-ok');
    assert.equal(manifest?.version, 'artefatos/1');
    assert.equal(manifest?.jobId, 'job-ok');
    assert.equal(manifest?.revision, 2);
    assert.deepEqual(manifest?.items.map((item) => item.name), ['video.mp4', 'roteiro.txt']);
    assert.equal(manifest?.items[0]?.kind, 'video');
    assert.equal(manifest?.items[1]?.kind, undefined);
    assert.deepEqual(await store.verify('job-ok'), { ok: true, missing: [], changed: [], extra: [] });
    assert.equal(store.ref('job-ok'), 'artefatos:job-ok');
  });

  test('arquivo apagado aparece em missing', async () => {
    await store.add('job-missing', { name: 'sumiu.bin', data: 'x', origin: 'teste' });
    await unlink(join(root, 'job-missing', 'sumiu.bin'));
    const report = await store.verify('job-missing');
    assert.equal(report.ok, false);
    assert.deepEqual(report.missing, ['sumiu.bin']);
    assert.deepEqual(report.changed, []);
  });

  test('arquivo alterado aparece em changed', async () => {
    await store.add('job-changed', { name: 'roteiro.txt', data: 'versão 1', origin: 'teste' });
    await writeFile(join(root, 'job-changed', 'roteiro.txt'), 'versão 2');
    const report = await store.verify('job-changed');
    assert.equal(report.ok, false);
    assert.deepEqual(report.changed, ['roteiro.txt']);
    assert.deepEqual(report.missing, []);
  });

  test('arquivo solto na pasta aparece em extra', async () => {
    await store.add('job-extra', { name: 'oficial.txt', data: 'ok', origin: 'teste' });
    await writeFile(join(root, 'job-extra', 'solto.bin'), 'sobra');
    const report = await store.verify('job-extra');
    assert.equal(report.ok, false);
    assert.deepEqual(report.extra, ['solto.bin']);
  });

  test('regravar o mesmo nome incrementa version do item e revision', async () => {
    await store.add('job-version', { name: 'cena.png', data: 'primeira', origin: 'teste' });
    const first = await store.manifest('job-version');
    const again = await store.add('job-version', { name: 'cena.png', data: 'segunda', origin: 'teste' });
    const second = await store.manifest('job-version');
    assert.equal(again.version, 2);
    assert.equal(second?.revision, (first?.revision ?? 0) + 1);
    assert.equal(second?.items.length, 1);
    assert.equal(second?.items[0]?.version, 2);
    assert.equal(second?.items[0]?.size, Buffer.byteLength('segunda'));
    assert.deepEqual(await store.verify('job-version'), { ok: true, missing: [], changed: [], extra: [] });
  });

  test('jobId e nome inválidos são recusados', async () => {
    const data = { name: 'ok.txt', data: 'x', origin: 'teste' };
    await assert.rejects(() => store.add('../x', data), /jobId inválido/);
    await assert.rejects(() => store.add('job-x', { ...data, name: 'a/b' }), /nome de artefato inválido/);
    await assert.rejects(() => store.add('job-x', { ...data, name: '..' }), /nome de artefato inválido/);
    await assert.rejects(() => store.add('job-x', { ...data, name: 'manifest.json' }), /nome de artefato inválido/);
  });

  test('add em paralelo no mesmo job não perde itens do manifesto', async () => {
    const names = Array.from({ length: 12 }, (_, index) => `cena-${index}.png`);
    await Promise.all(names.map((name) => store.add('job-paralelo', {
      name, data: `bytes de ${name}`, origin: 'agente', kind: 'image',
    })));
    const manifest = await store.manifest('job-paralelo');
    assert.equal(manifest?.revision, 12);
    assert.deepEqual(manifest?.items.map((item) => item.name).sort(), [...names].sort());
    assert.deepEqual(await store.verify('job-paralelo'), { ok: true, missing: [], changed: [], extra: [] });
  });

  test('add inválido no meio do Promise.all não impede as outras', async () => {
    const names = Array.from({ length: 6 }, (_, index) => `quadro-${index}.png`);
    const results = await Promise.allSettled([
      ...names.map((name) => store.add('job-paralelo-erro', { name, data: name, origin: 'agente' })),
      // Rejeita na validação: a fila do job precisa seguir para as próximas gravações.
      store.add('job-paralelo-erro', { name: 'a/b', data: 'x', origin: 'agente' }),
    ]);
    assert.deepEqual(results.map((result) => result.status), [...names.map(() => 'fulfilled'), 'rejected']);
    const manifest = await store.manifest('job-paralelo-erro');
    assert.equal(manifest?.revision, 6);
    assert.deepEqual(manifest?.items.map((item) => item.name).sort(), [...names].sort());
    assert.deepEqual(await store.verify('job-paralelo-erro'), { ok: true, missing: [], changed: [], extra: [] });
    // A fila esvaziou: uma gravação posterior no mesmo job continua funcionando.
    await store.add('job-paralelo-erro', { name: 'depois.png', data: 'x', origin: 'agente' });
    assert.equal((await store.manifest('job-paralelo-erro'))?.revision, 7);
  });

  test('gravações simultâneas do mesmo nome mantêm arquivo e manifesto juntos', async () => {
    // Cada gravação passa por um .tmp próprio; o rename e o manifesto acontecem na fila
    // do job, então o hash do manifesto é sempre o do conteúdo que ficou no disco.
    const contents = Array.from({ length: 10 }, (_, index) => `versão ${index} do mesmo vídeo`);
    const items = await Promise.all(contents.map((data) => store.add('job-mesmo-nome', {
      name: 'video.mp4', data, origin: 'teste',
    })));

    const manifest = await store.manifest('job-mesmo-nome');
    assert.equal(manifest?.items.length, 1);
    const final = manifest?.items[0]!;
    // Cada gravação incrementa a versão uma vez: a última é a 10ª.
    assert.deepEqual(
      items.map((item) => item.version).sort((a, b) => a - b),
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    );
    assert.equal(final.version, 10);
    // Os itens devolvidos descrevem os conteúdos enviados, cada um uma vez.
    assert.deepEqual(
      items.map((item) => item.sha256).sort(),
      contents.map((content) => createHash('sha256').update(content).digest('hex')).sort(),
    );

    const onDisk = await readFile(join(root, 'job-mesmo-nome', 'video.mp4'));
    assert.ok(contents.some((content) => Buffer.from(content).equals(onDisk)), 'o disco tem um conteúdo enviado');
    assert.equal(final.sha256, createHash('sha256').update(onDisk).digest('hex'));
    assert.equal(final.size, onDisk.length);
    assert.deepEqual(await store.verify('job-mesmo-nome'), { ok: true, missing: [], changed: [], extra: [] });
    // Nenhum temporário sobrou na pasta.
    const sobras = (await readdir(join(root, 'job-mesmo-nome'))).filter((name) => name.endsWith('.tmp'));
    assert.deepEqual(sobras, []);
  });

  test('addFile copia o arquivo e o hash bate com add dos mesmos bytes', async () => {
    const source = join(root, 'origem.mp4');
    const bytes = Buffer.from('conteúdo grande de vídeo');
    await writeFile(source, bytes);
    const copied = await store.addFile('job-copia', source, { origin: 'download', kind: 'video' });
    const added = await store.add('job-bytes', { name: 'copia.mp4', data: bytes, origin: 'teste' });
    assert.equal(copied.name, 'origem.mp4');
    assert.equal(copied.sha256, added.sha256);
    assert.equal(copied.size, bytes.length);
    assert.deepEqual(await readFile(join(root, 'job-copia', 'origem.mp4')), bytes);
    assert.deepEqual(await store.verify('job-copia'), { ok: true, missing: [], changed: [], extra: [] });
  });
});
