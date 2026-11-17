import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { buildBrief, type FormatoVideo } from '../src/video/brief.ts';
import { MANIFEST_VERSION, validateManifest, type VideoManifest } from '../src/video/manifest.ts';
import {
  buildFfmpegArgs,
  buildSrt,
  escapeFilterPath,
  planRender,
  renderVideo,
  wrapCaption,
  type RenderAssets,
  type RenderPlan,
  type RenderScene,
} from '../src/video/render.ts';

/** Manifesto válido com cenas de duração estimada informada (sem áudio). */
function manifestoCom(formato: FormatoVideo, duracoes: number[]): VideoManifest {
  const total = duracoes.reduce((soma, d) => soma + d, 0);
  const brief = buildBrief({
    tema: 'Como funciona o Pix',
    publico: 'adultos curiosos',
    plataforma: formato === 'vertical' ? 'shorts' : 'youtube',
    formato,
    duracaoAlvoSeg: total,
    estilo: 'documental',
    objetivo: 'explicar em poucos segundos',
  });
  const validado = validateManifest({
    version: MANIFEST_VERSION,
    jobId: 'video-1',
    brief,
    titulo: 'Pix em segundos',
    fontes: [],
    cenas: duracoes.map((duracaoEstimadaSeg, i) => ({
      n: i + 1,
      narracao: `Narração da cena ${i + 1}`,
      duracaoEstimadaSeg,
      afirmacoes: [],
      visual: `Descrição visual ${i + 1}`,
      promptImagem: `imagem única ${i + 1}`,
      papelImagem: 'ilustracao',
      realistaGeradaPorIA: false,
      assetRef: `assets/cena-${i + 1}.png`,
    })),
  });
  if (!validado.ok) throw new Error('manifesto deveria ser válido: ' + JSON.stringify(validado.errors));
  return validado.manifest;
}

function assetsPadrao(extra: Partial<RenderAssets> = {}): RenderAssets {
  return {
    imagePathFor: (n) => `/tmp/noite/cena-${n}.png`,
    audioFor: () => null,
    ...extra,
  };
}

/** Plano manual com caminhos no estilo Windows, para conferir o escape do filtro. */
function planoWindows(): RenderPlan {
  const scenes: RenderScene[] = [
    { n: 1, imagePath: 'C:\\imagens\\cena-1.png', audioPath: 'C:\\audio\\cena-1.wav', durationSec: 2, caption: 'Primeira cena' },
    { n: 2, imagePath: 'C:\\imagens\\cena-2.png', audioPath: null, durationSec: 1.5, caption: 'Segunda cena' },
    { n: 3, imagePath: 'C:\\imagens\\cena-3.png', audioPath: 'C:\\audio\\cena-3.wav', durationSec: 2.5, caption: 'Terceira cena' },
  ];
  return {
    width: 1080,
    height: 1920,
    fps: 30,
    scenes,
    outPath: 'C:\\saida\\video-1.mp4',
    subtitlesPath: 'C:\\saida\\video-1.srt',
    preview: false,
  };
}

function blocosDoSrt(srt: string): string[][] {
  return srt.trim().split('\n\n').map((bloco) => bloco.split('\n'));
}

describe('renderizador de vídeo (V05)', () => {
  test('plano vertical usa 1080x1920 e segue o briefing', () => {
    const plan = planRender(manifestoCom('vertical', [20, 20]), assetsPadrao(), { outDir: '/tmp/noite' });
    assert.equal(plan.width, 1080);
    assert.equal(plan.height, 1920);
    assert.equal(plan.fps, 30);
    assert.equal(plan.preview, false);
    assert.deepEqual(plan.scenes.map((s) => s.durationSec), [20, 20]);
    assert.equal(plan.scenes[0]!.imagePath, '/tmp/noite/cena-1.png');
    assert.equal(plan.scenes[0]!.audioPath, null);
    assert.equal(plan.scenes[0]!.caption, 'Narração da cena 1');
    assert.match(plan.outPath, /video-1\.mp4$/);
    assert.match(plan.subtitlesPath, /video-1\.srt$/);
  });

  test('plano horizontal usa 1920x1080', () => {
    const plan = planRender(manifestoCom('horizontal', [20, 20]), assetsPadrao(), { outDir: '/tmp/noite' });
    assert.equal(plan.width, 1920);
    assert.equal(plan.height, 1080);
  });

  test('prévia usa metade da resolução e nome próprio', () => {
    const vertical = planRender(manifestoCom('vertical', [20, 20]), assetsPadrao(), { outDir: '/tmp/noite', preview: true });
    assert.deepEqual([vertical.width, vertical.height], [540, 960]);
    assert.equal(vertical.preview, true);
    assert.match(vertical.outPath, /video-1-preview\.mp4$/);
    assert.match(vertical.subtitlesPath, /video-1-preview\.srt$/);

    const horizontal = planRender(manifestoCom('horizontal', [20, 20]), assetsPadrao(), { outDir: '/tmp/noite', preview: true });
    assert.deepEqual([horizontal.width, horizontal.height], [960, 540]);
  });

  test('duração da cena vem do áudio quando existe', () => {
    const plan = planRender(
      manifestoCom('vertical', [20, 20]),
      assetsPadrao({
        audioFor: (n) => (n === 1 ? { path: '/tmp/noite/voz-1.wav', durationSec: 7.25 } : null),
      }),
      { outDir: '/tmp/noite' },
    );
    assert.equal(plan.scenes[0]!.durationSec, 7.25);
    assert.equal(plan.scenes[0]!.audioPath, '/tmp/noite/voz-1.wav');
    // Sem áudio, a estimativa do manifesto manda.
    assert.equal(plan.scenes[1]!.durationSec, 20);
    assert.equal(plan.scenes[1]!.audioPath, null);
  });

  test('cena sem imagem lança erro em português', () => {
    assert.throws(
      () => planRender(manifestoCom('vertical', [20, 20]), assetsPadrao({ imagePathFor: (n) => (n === 2 ? '' : `/tmp/cena-${n}.png`) }), { outDir: '/tmp/noite' }),
      /cena 2: sem imagem/,
    );
    assert.throws(
      () => planRender(manifestoCom('vertical', [20, 20]), assetsPadrao({
        imagePathFor: () => { throw new Error('asset ausente'); },
      }), { outDir: '/tmp/noite' }),
      /cena 1: sem imagem para o render: asset ausente/,
    );
  });

  test('SRT acumula os tempos das cenas', () => {
    const plan: RenderPlan = {
      ...planoWindows(),
      scenes: [
        { n: 1, imagePath: 'a.png', audioPath: null, durationSec: 2, caption: 'Primeira cena curta' },
        { n: 2, imagePath: 'b.png', audioPath: null, durationSec: 1.5, caption: 'Segunda cena' },
      ],
    };
    const srt = buildSrt(plan);
    assert.ok(srt.includes('1\n00:00:00,000 --> 00:00:02,000\nPrimeira cena curta'));
    assert.ok(srt.includes('2\n00:00:02,000 --> 00:00:03,500\nSegunda cena'));
    assert.ok(srt.endsWith('\n'));
  });

  test('SRT quebra linha longa em 42 caracteres', () => {
    const caption = 'Esta narração tem palavras suficientes para passar de quarenta e dois caracteres';
    const linhas = wrapCaption(caption);
    assert.ok(linhas.length > 1);
    for (const linha of linhas) assert.ok(linha.length <= 42, `linha longa: ${linha}`);
    // Nenhuma palavra é cortada.
    assert.equal(linhas.join(' '), caption);

    const plan: RenderPlan = {
      ...planoWindows(),
      scenes: [{ n: 1, imagePath: 'a.png', audioPath: null, durationSec: 3, caption }],
    };
    const blocos = blocosDoSrt(buildSrt(plan));
    const texto = blocos.flatMap((b) => b.slice(2));
    for (const linha of texto) assert.ok(linha.length <= 42);
    assert.equal(texto.join(' '), caption);
  });

  test('SRT divide cena longa em blocos proporcionais às palavras', () => {
    const palavras = Array.from({ length: 30 }, (_, i) => `palavra${String(i + 1).padStart(2, '0')}`);
    const caption = palavras.join(' ');
    const plan: RenderPlan = {
      ...planoWindows(),
      scenes: [{ n: 1, imagePath: 'a.png', audioPath: null, durationSec: 10, caption }],
    };
    const blocos = blocosDoSrt(buildSrt(plan));
    assert.ok(blocos.length > 1, 'narração longa deveria virar mais de um bloco');
    for (const bloco of blocos) {
      assert.ok(bloco.length - 2 <= 2, 'no máximo duas linhas por bloco');
      for (const linha of bloco.slice(2)) assert.ok(linha.length <= 42);
    }
    assert.match(blocos[0]![1]!, /^00:00:00,000 --> /);
    assert.match(blocos.at(-1)![1]!, /--> 00:00:10,000$/);
    // O primeiro bloco não come a cena inteira: tempos proporcionais ao número de palavras.
    assert.doesNotMatch(blocos[0]![1]!, /--> 00:00:10,000$/);
  });

  test('escape de caminho Windows para o filtro', () => {
    assert.equal(escapeFilterPath('C:\\tmp\\noite\\video.srt'), 'C\\:/tmp/noite/video.srt');
    assert.equal(escapeFilterPath('/tmp/noite/video.srt'), '/tmp/noite/video.srt');
    // Aspas simples quebrariam a citação do filtro: melhor recusar do que gerar comando errado.
    assert.throws(() => escapeFilterPath("/tmp/joel's/video.srt"), /aspas simples/);
  });

  test('argumentos do FFmpeg montam um único comando', () => {
    const plan = planoWindows();
    const args = buildFfmpegArgs(plan);

    assert.equal(args[0], '-y');
    // Uma entrada com -framerate 30 antes de -loop 1 por imagem, com a duração da cena.
    // Sem o -framerate, o padrão de 25 fps encurtava o vídeo em relação ao áudio.
    const loops = args.filter((a) => a === '-loop').length;
    assert.equal(loops, plan.scenes.length);
    const framerates = args.filter((a, i) => a === '-framerate' && args[i + 1] === '30').length;
    assert.equal(framerates, plan.scenes.length);
    plan.scenes.forEach((cena) => {
      const i = args.indexOf(cena.imagePath);
      assert.ok(i > 0, `imagem deveria ser entrada: ${cena.imagePath}`);
      assert.deepEqual(
        args.slice(i - 7, i + 1),
        ['-framerate', '30', '-loop', '1', '-t', cena.durationSec.toFixed(3), '-i', cena.imagePath],
      );
    });
    // Cena sem áudio vira silêncio com a duração da cena.
    assert.ok(args.includes('anullsrc=r=48000:cl=stereo'));
    assert.ok(args.includes('C:\\audio\\cena-1.wav'));

    const filtro = args[args.indexOf('-filter_complex') + 1]!;
    assert.ok(filtro.includes('scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920'));
    assert.ok(filtro.includes('zoompan'));
    // d=1 com entrada e saída na mesma taxa: o número de quadros bate com duração*fps.
    assert.match(filtro, /zoompan=.*:d=1:.*:fps=30/);
    // Cena ímpar aproxima, cena par afasta: o movimento alterna e é determinístico.
    assert.match(filtro, /zoompan=z='min\(1\+/);
    assert.match(filtro, /zoompan=z='max\(1\.06-/);
    assert.ok(filtro.includes('setsar=1'));
    assert.ok(filtro.includes('concat=n=3:v=1:a=0'));
    assert.ok(filtro.includes('concat=n=3:v=0:a=1'));
    // O valor entre aspas simples impede o ":" de virar separador de opção do filtro.
    assert.ok(filtro.includes("subtitles='C\\:/saida/video-1.srt'"));

    assert.ok(args.includes('libx264'));
    assert.ok(args.includes('yuv420p'));
    assert.ok(args.includes('aac'));
    assert.ok(args.includes('160k'));
    assert.ok(args.includes('+faststart'));
    // A saída é o último argumento: nada depois dela.
    assert.equal(args.at(-1), plan.outPath);
  });

  test('caminho de legenda com aspas simples é recusado', () => {
    const plan: RenderPlan = { ...planoWindows(), subtitlesPath: "C:\\saida\\joel's\\video-1.srt" };
    assert.throws(() => buildFfmpegArgs(plan), /aspas simples/);
  });

  test('renderVideo grava o SRT e roda o FFmpeg injetado', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'night-render-'));
    try {
      const plan: RenderPlan = { ...planoWindows(), outPath: join(dir, 'video-1.mp4'), subtitlesPath: join(dir, 'video-1.srt') };
      let chamada: { bin: string; args: string[] } | null = null;
      const resultado = await renderVideo(plan, {
        run: async (bin, args) => {
          chamada = { bin, args };
          return { code: 0, stderr: '' };
        },
      });

      assert.equal(chamada!.bin, 'ffmpeg');
      assert.deepEqual(chamada!.args, buildFfmpegArgs(plan));
      assert.equal(resultado.outPath, plan.outPath);
      assert.equal(resultado.durationSec, 6);
      assert.deepEqual(resultado.args, chamada!.args);
      assert.equal(await readFile(plan.subtitlesPath, 'utf8'), buildSrt(plan));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('renderVideo propaga o erro do FFmpeg com o fim do stderr', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'night-render-'));
    try {
      const plan: RenderPlan = { ...planoWindows(), outPath: join(dir, 'video-1.mp4'), subtitlesPath: join(dir, 'video-1.srt') };
      await assert.rejects(
        renderVideo(plan, {
          ffmpegBin: 'C:\\ffmpeg\\bin\\ffmpeg.exe',
          run: async (bin) => {
            assert.equal(bin, 'C:\\ffmpeg\\bin\\ffmpeg.exe');
            return { code: 1, stderr: 'frame=10 fps=0\nError: filtro inválido na cena 2' };
          },
        }),
        (erro: Error) => {
          assert.match(erro.message, /código 1/);
          assert.match(erro.message, /filtro inválido na cena 2/);
          return true;
        },
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
