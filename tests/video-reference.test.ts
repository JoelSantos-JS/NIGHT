import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { buildBrief } from '../src/video/brief.ts';
import { MANIFEST_VERSION, validateManifest, type VideoManifest } from '../src/video/manifest.ts';
import {
  analyzeReferenceVideo,
  parseSceneCuts,
  referenceFrameTimestamps,
  sceneCutDetectArgs,
} from '../src/video/reference.ts';
import {
  blackdetectArgs,
  parseBlackSpans,
  qaFrameTimestamps,
  reviewRender,
  runReview,
  type ProbeInfo,
  type RunCommand,
} from '../src/video/review.ts';

const PROBE_SHORT = JSON.stringify({
  streams: [
    { index: 0, codec_type: 'video', codec_name: 'h264', width: 1080, height: 1920, r_frame_rate: '30/1' },
    { index: 1, codec_type: 'audio', codec_name: 'aac' },
  ],
  format: { duration: '30.000000' },
});

const STDERR_SCENE_CUTS = `
[Parsed_showinfo_1 @ 0x1] n:   0 pts:    900 pts_time:2.500   pos:  12345
[Parsed_showinfo_1 @ 0x1] n:   1 pts:   1800 pts_time:5.000   pos:  23456
[Parsed_showinfo_1 @ 0x1] n:   2 pts:   3600 pts_time:10.000  pos:  34567
[Parsed_showinfo_1 @ 0x1] n:   3 pts:   5400 pts_time:15.000  pos:  45678
[Parsed_showinfo_1 @ 0x1] n:   4 pts:   7200 pts_time:20.000  pos:  56789
[Parsed_showinfo_1 @ 0x1] n:   5 pts:   9000 pts_time:25.000  pos:  67890
`;

function probeBom(): ProbeInfo {
  return {
    durationSec: 30,
    width: 1080,
    height: 1920,
    hasVideo: true,
    hasAudio: true,
    videoCodec: 'h264',
    audioCodec: 'aac',
    fps: 30,
  };
}

function manifestoStickman(): VideoManifest {
  const brief = buildBrief({ tema: 'Teste QA', plataforma: 'shorts', duracaoAlvoSeg: 30, estilo: 'stickman-2d' });
  const r = validateManifest({
    version: MANIFEST_VERSION,
    jobId: 'qa-1',
    brief,
    titulo: 'Teste QA',
    templateVisual: 'stickman-2d',
    motorVisual: 'remotion',
    fontes: [],
    cenas: [1, 2].map((n) => ({
      n,
      narracao: `Cena ${n}`,
      duracaoEstimadaSeg: 15,
      afirmacoes: [],
      visual: `Visual ${n}`,
      promptImagem: '',
      papelImagem: 'ilustracao',
      realistaGeradaPorIA: false,
      assetRef: null,
    })),
  });
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.manifest;
}

describe('analisador de referência (src/video/reference.ts)', () => {
  let framesDir = '';

  beforeEach(async () => {
    framesDir = await mkdtemp(join(tmpdir(), 'night-ref-frames-'));
  });

  afterEach(async () => {
    await rm(framesDir, { recursive: true, force: true });
  });

  test('parseSceneCuts extrai timestamps ordenados e referenceFrameTimestamps distribui pontos', () => {
    assert.deepEqual(parseSceneCuts(STDERR_SCENE_CUTS), [2.5, 5, 10, 15, 20, 25]);
    assert.deepEqual(referenceFrameTimestamps(30, 5), [0.5, 7.75, 15, 22.25, 29.5]);
    assert.deepEqual(referenceFrameTimestamps(0, 5), []);
  });

  test('analyzeReferenceVideo separa observed, inferred e unknown e gera styleRecipe', async () => {
    const chamadas: string[][] = [];
    const run: RunCommand = async (bin, args) => {
      chamadas.push([bin, ...args]);
      if (bin === 'ffprobe') return { code: 0, stdout: PROBE_SHORT, stderr: '' };
      if (args.includes('null')) return { code: 0, stdout: '', stderr: STDERR_SCENE_CUTS };
      return { code: 0, stdout: '', stderr: '' };
    };

    const res = await analyzeReferenceVideo('C:\\videos\\ref.mp4', {
      run,
      framesDir,
      maxFrames: 3,
    });

    assert.equal(res.aspect, 'vertical');
    assert.equal(res.cuts.count, 6);
    assert.equal(res.cuts.cutsPerMinute, 12);
    assert.equal(res.frames.length, 3);
    assert.equal(res.styleRecipe.cutsPerMinute, 12);
    assert.equal(res.styleRecipe.hookMaxSec, 3);
    assert.ok(res.observations.some((o) => o.level === 'observed' && o.fact.includes('1080x1920')));
    assert.ok(res.observations.some((o) => o.level === 'inferred' && o.fact.includes('ritmo moderado')));
    assert.ok(res.observations.some((o) => o.level === 'unknown' && o.fact.includes('transcrição')));
    assert.match(res.copyrightNotes, /Proibido reutilizar/);
    assert.ok(chamadas.some((c) => c[0] === 'ffmpeg' && c.join(' ').includes('gt(scene')));
  });

  test('sceneCutDetectArgs usa o filtro showinfo na saída nula', () => {
    const args = sceneCutDetectArgs('ref.mp4', 0.4);
    assert.ok(args.includes("select='gt(scene,0.4)',showinfo"));
  });
});

describe('QA visual: quadros pretos e amostragem de frames (src/video/review.ts)', () => {
  test('parseBlackSpans lê black_start e black_end e qaFrameTimestamps evita extremos', () => {
    const stderr = `
[blackdetect @ 0x1] black_start:12.0 black_end:13.2 black_duration:1.2
[blackdetect @ 0x1] black_start:29.7 black_end:30.0 black_duration:0.3
`;
    assert.deepEqual(parseBlackSpans(stderr), [
      { start: 12, end: 13.2 },
      { start: 29.7, end: 30 },
    ]);
    assert.deepEqual(qaFrameTimestamps(30, 4), [0.5, 10.17, 19.83, 29.5]);
  });

  test('reviewRender reprova quadro preto no meio do vídeo e tolera no fim', () => {
    const m = manifestoStickman();
    const meio = reviewRender(probeBom(), m, {
      blackSpans: [{ start: 10, end: 11.2 }],
    });
    assert.equal(meio.ok, false);
    assert.ok(meio.falhas.some((f) => /quadro preto de 1,2s em 10s/.test(f)));

    const fim = reviewRender(probeBom(), m, {
      blackSpans: [{ start: 29.3, end: 30 }],
    });
    assert.equal(fim.ok, true);
  });

  test('runReview com checkBlackFrames e extractFramesDir aciona blackdetect e salva frames', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'night-qa-frames-'));
    try {
      const calls: { bin: string; args: string[] }[] = [];
      const run: RunCommand = async (bin, args) => {
        calls.push({ bin, args });
        if (bin === 'ffprobe') return { code: 0, stdout: PROBE_SHORT, stderr: '' };
        return { code: 0, stdout: '', stderr: '' };
      };

      const res = await runReview('video.mp4', manifestoStickman(), run, {
        checkBlackFrames: true,
        extractFramesDir: outDir,
        qaFrameCount: 2,
      });

      assert.equal(res.ok, true);
      assert.equal(res.qaFrames?.length, 2);
      assert.ok(calls.some((c) => c.args.join(' ').includes(blackdetectArgs('video.mp4')[5]!)));
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });
});
