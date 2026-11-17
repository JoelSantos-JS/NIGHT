import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { ArtifactStore } from '../src/artifacts/store.ts';
import { buildBrief, type VideoBrief } from '../src/video/brief.ts';
import { MANIFEST_VERSION, type Scene, type VideoManifest } from '../src/video/manifest.ts';
import {
  Narrator,
  applyLexicon,
  pronunciationReview,
  type Synth,
} from '../src/video/narrate.ts';

const brief: VideoBrief = buildBrief({ tema: 'Teste de narração', plataforma: 'shorts' });

function cena(n: number, narracao: string): Scene {
  return {
    n,
    narracao,
    duracaoEstimadaSeg: 10,
    afirmacoes: [],
    visual: `visual ${n}`,
    promptImagem: `imagem ${n}`,
    papelImagem: 'ilustracao',
    realistaGeradaPorIA: false,
    assetRef: null,
  };
}

function manifesto(jobId: string, cenas: Scene[]): VideoManifest {
  return {
    version: MANIFEST_VERSION,
    jobId,
    brief,
    titulo: 'Teste',
    fontes: [],
    cenas,
  };
}

/** Síntese falsa: grava um WAV de mentira, conta chamadas e pode falhar. */
class FakeSynth {
  readonly calls: { text: string; language: string; file: string }[] = [];
  failWhen: ((text: string) => boolean) | undefined = undefined;
  constructor(readonly seconds = 1.5) {}
  synth: Synth = async (text, language, file) => {
    this.calls.push({ text, language, file });
    if (this.failWhen?.(text)) throw new Error('voz falhou');
    await writeFile(file, Buffer.from(`RIFF-fake;${text}`, 'utf8'));
    return { audioSeconds: this.seconds };
  };
}

describe('narração por cena (V04)', () => {
  let root: string;
  let workDir: string;
  let store: ArtifactStore;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'night-narracao-'));
    workDir = await mkdtemp(join(tmpdir(), 'night-narracao-work-'));
    store = new ArtifactStore(root);
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(workDir, { recursive: true, force: true });
  });

  test('narra as 3 cenas e grava WAV e sidecar no store', async () => {
    const fake = new FakeSynth();
    const narrator = new Narrator(fake.synth, store, { workDir });
    const m = manifesto('job-tres', [cena(1, 'Primeira cena'), cena(2, 'Segunda cena'), cena(3, 'Terceira cena')]);

    const r = await narrator.narrateAll('job-tres', m);

    assert.equal(fake.calls.length, 3);
    assert.deepEqual(r.scenes.map((s) => s.n), [1, 2, 3]);
    assert.equal(r.totalSec, 4.5);
    assert.ok(r.scenes.every((s) => !s.reused));

    const artefatos = await store.manifest('job-tres');
    assert.ok(artefatos);
    const nomes = artefatos.items.map((item) => item.name);
    for (const s of r.scenes) {
      const prefixo = `narracao-${s.n}-${s.cacheKey.slice(0, 12)}`;
      assert.ok(nomes.includes(`${prefixo}.wav`), `faltou o WAV da cena ${s.n}`);
      assert.ok(nomes.includes(`${prefixo}.json`), `faltou o sidecar da cena ${s.n}`);
      assert.equal((await readFile(s.file, 'utf8')).startsWith('RIFF-fake;'), true);
    }
    const wavs = artefatos.items.filter((item) => item.name.endsWith('.wav'));
    assert.equal(wavs.length, 3);
    assert.ok(wavs.every((item) => item.origin === 'kokoro' && item.kind === 'audio'));
    assert.deepEqual(await store.verify('job-tres'), { ok: true, missing: [], changed: [], extra: [] });
  });

  test('segunda rodada reaproveita as 3 sem chamar a síntese', async () => {
    const fake = new FakeSynth();
    const narrator = new Narrator(fake.synth, store, { workDir });
    const m = manifesto('job-cache', [cena(1, 'Um'), cena(2, 'Dois'), cena(3, 'Três')]);
    const primeira = await narrator.narrateAll('job-cache', m);
    assert.equal(fake.calls.length, 3);

    const segunda = await narrator.narrateAll('job-cache', m);

    assert.equal(fake.calls.length, 3, 'não deveria sintetizar de novo');
    assert.ok(segunda.scenes.every((s) => s.reused));
    assert.deepEqual(segunda.scenes.map((s) => s.file), primeira.scenes.map((s) => s.file));
    assert.deepEqual(segunda.scenes.map((s) => s.durationSec), [1.5, 1.5, 1.5]);
    assert.equal(segunda.totalSec, 4.5);
  });

  test('mudar a narração da cena 2 só re-sintetiza a cena 2', async () => {
    const fake = new FakeSynth();
    const narrator = new Narrator(fake.synth, store, { workDir });
    const primeira = await narrator.narrateAll(
      'job-muda',
      manifesto('job-muda', [cena(1, 'Um'), cena(2, 'Dois'), cena(3, 'Três')]),
    );
    assert.equal(fake.calls.length, 3);

    const segunda = await narrator.narrateAll(
      'job-muda',
      manifesto('job-muda', [cena(1, 'Um'), cena(2, 'Dois alterado'), cena(3, 'Três')]),
    );

    assert.equal(fake.calls.length, 4);
    assert.equal(fake.calls.at(-1)?.text, 'Dois alterado');
    assert.deepEqual(segunda.scenes.map((s) => s.reused), [true, false, true]);
    assert.equal(segunda.scenes[0]!.cacheKey, primeira.scenes[0]!.cacheKey);
    assert.equal(segunda.scenes[2]!.cacheKey, primeira.scenes[2]!.cacheKey);
    assert.notEqual(segunda.scenes[1]!.cacheKey, primeira.scenes[1]!.cacheKey);
  });

  test('mudar o léxico de uma palavra presente na cena re-sintetiza só essa cena', async () => {
    const fake = new FakeSynth();
    const m = manifesto('job-lexico-cache', [cena(1, 'A IA explica o tema'), cena(2, 'Outra cena sem a sigla')]);

    const semLexico = new Narrator(fake.synth, store, { workDir });
    const primeira = await semLexico.narrateAll('job-lexico-cache', m);
    assert.equal(fake.calls.length, 2);

    // Léxico muda a pronúncia da cena 1, mas não o texto do manifesto.
    const comLexico = new Narrator(fake.synth, store, { workDir, lexicon: { IA: 'I A' } });
    const segunda = await comLexico.narrateAll('job-lexico-cache', m);

    assert.equal(fake.calls.length, 3, 'só a cena com a palavra do léxico deveria ser sintetizada');
    assert.equal(fake.calls.at(-1)?.text, 'A I A explica o tema');
    assert.deepEqual(segunda.scenes.map((s) => s.reused), [false, true]);
    assert.notEqual(segunda.scenes[0]!.cacheKey, primeira.scenes[0]!.cacheKey);
    assert.equal(segunda.scenes[1]!.cacheKey, primeira.scenes[1]!.cacheKey);
    assert.equal(segunda.scenes[1]!.file, primeira.scenes[1]!.file);

    // Léxico de palavra que não aparece nas cenas não força síntese nova.
    const outroLexico = new Narrator(fake.synth, store, { workDir, lexicon: { YouTube: 'iútúbi' } });
    const terceira = await outroLexico.narrateAll('job-lexico-cache', m);
    assert.equal(fake.calls.length, 3);
    assert.ok(terceira.scenes.every((s) => s.reused));
  });

  test('léxico troca palavra inteira e respeita acentos', () => {
    assert.equal(applyLexicon('IA e IAgo e MAIA', { IA: 'I A' }), 'I A e IAgo e MAIA');
    assert.equal(applyLexicon('a maçã e o MAÇÃ', { 'maçã': 'ma ssan' }), 'a ma ssan e o MAÇÃ');
    assert.equal(applyLexicon('sem troca', {}), 'sem troca');
  });

  test('léxico vale só para a voz; a narração do manifesto não muda', async () => {
    const fake = new FakeSynth();
    const narrator = new Narrator(fake.synth, store, {
      workDir,
      lexicon: { IA: 'I A', YouTube: 'iútúbi' },
    });
    const m = manifesto('job-lexico', [cena(1, 'A IA e o YouTube explicam')]);
    const antes = JSON.stringify(m);

    await narrator.narrateAll('job-lexico', m);

    assert.equal(fake.calls[0]?.text, 'A I A e o iútúbi explicam');
    assert.equal(JSON.stringify(m), antes);
    assert.equal(m.cenas[0]!.narracao, 'A IA e o YouTube explicam');
  });

  test('pronunciationReview aponta sigla, número grande, dinheiro e inglês', () => {
    const texto = 'O BCB divulgou 15000 casos; o app custa R$ 1.234,00 para download.';
    const notas = pronunciationReview(texto, {});

    assert.ok(notas.some((n) => n.trecho === 'BCB'));
    assert.ok(notas.some((n) => n.trecho === '15000'));
    assert.ok(notas.some((n) => n.trecho.startsWith('R$')));
    assert.ok(notas.some((n) => /download/i.test(n.trecho)));
    assert.ok(notas.some((n) => /app/i.test(n.trecho)));
    assert.ok(notas.some((n) => n.motivo.includes('sigla')));
    assert.ok(notas.some((n) => n.motivo.includes('número')));
    assert.ok(notas.some((n) => n.motivo.includes('R$/US$')));
    assert.ok(notas.some((n) => n.motivo.includes('inglês')));
  });

  test('pronunciationReview ignora o que já está no léxico', () => {
    const notas = pronunciationReview('O BCB pede download do app', {
      BCB: 'bê cê bê',
      download: 'daunloud',
      app: 'ápi',
    });
    assert.deepEqual(notas, []);
    // Uma letra maiúscula sozinha não é sigla.
    assert.deepEqual(pronunciationReview('A letra A', {}), []);
  });

  test('cena vazia lança e não chama a síntese', async () => {
    const fake = new FakeSynth();
    const narrator = new Narrator(fake.synth, store, { workDir });

    await assert.rejects(
      narrator.narrateScene('job-vazio', cena(2, '   '), brief),
      /cena 2: narração vazia/,
    );
    assert.equal(fake.calls.length, 0);
    assert.equal(await store.manifest('job-vazio'), null);
  });

  test('falha na cena 2 lança com o número e preserva a cena 1', async () => {
    const fake = new FakeSynth();
    fake.failWhen = (text) => text === 'falha na dois';
    const narrator = new Narrator(fake.synth, store, { workDir });
    const m = manifesto('job-falha', [
      cena(1, 'um'),
      cena(2, 'falha na dois'),
      cena(3, 'três'),
    ]);

    await assert.rejects(narrator.narrateAll('job-falha', m), /cena 2/);
    assert.equal(fake.calls.length, 2, 'não deveria chegar na cena 3');

    const artefatos = await store.manifest('job-falha');
    assert.ok(artefatos);
    const nomes = artefatos.items.map((item) => item.name);
    assert.ok(nomes.some((nome) => nome.startsWith('narracao-1-')));
    assert.ok(!nomes.some((nome) => nome.startsWith('narracao-3-')));
    assert.deepEqual(await store.verify('job-falha'), { ok: true, missing: [], changed: [], extra: [] });

    // Retomada: a cena 1 é reaproveitada e as outras duas são sintetizadas.
    fake.failWhen = undefined;
    const retomada = await narrator.narrateAll('job-falha', m);
    assert.deepEqual(retomada.scenes.map((s) => s.reused), [true, false, false]);
  });
});
