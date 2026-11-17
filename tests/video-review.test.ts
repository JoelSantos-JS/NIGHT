import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildBrief, type VideoBrief } from '../src/video/brief.ts';
import { MANIFEST_VERSION, validateManifest, type VideoManifest } from '../src/video/manifest.ts';
import {
  parseProbe,
  parseSilence,
  probeArgs,
  reviewRender,
  runReview,
  silencedetectArgs,
  summarizeForJoel,
  type ProbeInfo,
  type RunCommand,
} from '../src/video/review.ts';

/** Saída real típica do ffprobe para um short vertical de 60 s com h264 + aac. */
const PROBE_VERTICAL = JSON.stringify({
  streams: [
    {
      index: 0,
      codec_name: 'h264',
      codec_long_name: 'H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10',
      profile: 'High',
      codec_type: 'video',
      codec_tag_string: 'avc1',
      width: 1080,
      height: 1920,
      pix_fmt: 'yuv420p',
      r_frame_rate: '30/1',
      avg_frame_rate: '30/1',
      time_base: '1/15360',
      duration: '60.000000',
      bit_rate: '1320000',
      nb_frames: '1800',
    },
    {
      index: 1,
      codec_name: 'aac',
      codec_long_name: 'AAC (Advanced Audio Coding)',
      profile: 'LC',
      codec_type: 'audio',
      sample_fmt: 'fltp',
      sample_rate: '48000',
      channels: 2,
      channel_layout: 'stereo',
      duration: '60.032000',
      bit_rate: '128000',
    },
  ],
  format: {
    filename: 'C:\\temp\\night\\video-final.mp4',
    nb_streams: 2,
    format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
    format_long_name: 'QuickTime / MOV',
    start_time: '0.000000',
    duration: '60.033333',
    size: '12345678',
    bit_rate: '1645731',
  },
});

/** stderr real típico do ffmpeg com silencedetect (4,2 s de silêncio no fim). */
const STDERR_SILENCIO_FIM = `ffmpeg version 7.1-full_build-www.gyan.dev Copyright (c) 2000-2024 the FFmpeg developers
  built with gcc 14.2.0 (Rev3, Built by MSYS2 project)
  libavutil      59. 39.100 / 59. 39.100
  libavcodec     61. 19.100 / 61. 19.100
Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'video-final.mp4':
  Duration: 00:01:00.03, start: 0.000000, bitrate: 1645 kb/s
Stream mapping:
  Stream #0:0 -> #0:0 (h264 (native) -> wrapped_avframe (native))
  Stream #0:1 -> #0:1 (aac (native) -> pcm_s16le (native))
Press [q] to stop, [?] for help
[silencedetect @ 000001d2f0a1b340] silence_start: 55.833
[silencedetect @ 000001d2f0a1b340] silence_end: 60.033 | silence_duration: 4.2
size=N/A time=00:01:00.03 bitrate=N/A speed= 215x
`;

/** Briefing de short vertical de 60 s. */
function briefShorts(extra: Record<string, unknown> = {}): VideoBrief {
  return buildBrief({
    tema: 'Como funciona o Pix',
    publico: 'adultos curiosos',
    plataforma: 'shorts',
    duracaoAlvoSeg: 60,
    estilo: 'documental',
    objetivo: 'explicar em 60 segundos',
    ...extra,
  });
}

/** Manifesto de 4 cenas de 15 s (60 s no total), vertical, sem avisos. */
function manifestoValido(): any {
  return {
    version: MANIFEST_VERSION,
    jobId: 'video-1',
    brief: briefShorts(),
    titulo: 'Pix em 60 segundos',
    fontes: [
      { id: 'bcb', url: 'https://www.bcb.gov.br/pix', titulo: 'Banco Central — Pix', acessadoEm: '2026-11-17T20:00:00Z' },
    ],
    cenas: [1, 2, 3, 4].map((n) => ({
      n,
      narracao: `Narração da cena ${n}`,
      duracaoEstimadaSeg: 15,
      afirmacoes: [{ texto: `Afirmação ${n}`, fonte: n === 1 ? null : 'bcb', duvida: n === 1 }],
      visual: `Descrição visual ${n}`,
      promptImagem: `imagem única ${n}`,
      papelImagem: 'ilustracao',
      realistaGeradaPorIA: false,
      assetRef: `assets/cena-${n}.png`,
    })),
  };
}

function manifestoDe(raw: unknown): VideoManifest {
  const r = validateManifest(raw);
  if (!r.ok) throw new Error('manifesto deveria ser válido: ' + JSON.stringify(r.errors));
  return r.manifest;
}

/** Probe saudável: vertical 1080x1920, 60 s, h264/aac. */
function probeBom(extra: Partial<ProbeInfo> = {}): ProbeInfo {
  return {
    durationSec: 60,
    width: 1080,
    height: 1920,
    hasVideo: true,
    hasAudio: true,
    videoCodec: 'h264',
    audioCodec: 'aac',
    fps: 30,
    ...extra,
  };
}

describe('ffprobe: argumentos e leitura (V06)', () => {
  test('probeArgs pede formato e streams em JSON', () => {
    assert.deepEqual(probeArgs('video.mp4'), [
      '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', 'video.mp4',
    ]);
  });

  test('parseProbe lê uma saída real típica', () => {
    const p = parseProbe(PROBE_VERTICAL);
    assert.equal(p.durationSec, 60.033333);
    assert.equal(p.width, 1080);
    assert.equal(p.height, 1920);
    assert.equal(p.hasVideo, true);
    assert.equal(p.hasAudio, true);
    assert.equal(p.videoCodec, 'h264');
    assert.equal(p.audioCodec, 'aac');
    assert.equal(p.fps, 30);
  });

  test('parseProbe converte r_frame_rate fracionário', () => {
    const raw = JSON.parse(PROBE_VERTICAL);
    raw.streams[0].r_frame_rate = '30000/1001';
    const p = parseProbe(JSON.stringify(raw));
    assert.equal(p.fps, 29.97);
  });

  test('parseProbe sem vídeo devolve dimensões zero e codec nulo', () => {
    const soAudio = JSON.stringify({
      streams: [{ index: 0, codec_name: 'aac', codec_type: 'audio' }],
      format: { duration: '60.000000' },
    });
    const p = parseProbe(soAudio);
    assert.equal(p.hasVideo, false);
    assert.equal(p.width, 0);
    assert.equal(p.height, 0);
    assert.equal(p.videoCodec, null);
    assert.equal(p.fps, null);
    assert.equal(p.hasAudio, true);
  });

  test('JSON inválido ou sem streams lança', () => {
    assert.throws(() => parseProbe('{quebrado'), /ffprobe inválida/);
    assert.throws(() => parseProbe('[]'), /ffprobe inválida/);
    assert.throws(() => parseProbe('{"format":{"duration":"1"}}'), /sem lista de streams/);
  });
});

describe('silencedetect: argumentos e leitura (V06)', () => {
  test('silencedetectArgs usa o filtro e a saída nula', () => {
    const args = silencedetectArgs('video.mp4');
    assert.equal(args[args.indexOf('-i') + 1], 'video.mp4');
    assert.ok(args.includes('silencedetect=noise=-40dB:d=1'));
    assert.deepEqual(args.slice(-3), ['-f', 'null', '-']);
    // O filtro fala no stderr em nível de informação; "-v error" esconderia os trechos.
    assert.equal(args.includes('-v'), false);
  });

  test('parseSilence lê silence_start/silence_end de um stderr real', () => {
    assert.deepEqual(parseSilence(STDERR_SILENCIO_FIM), [{ start: 55.833, end: 60.033 }]);
  });

  test('parseSilence trata início negativo e silêncio que vai até o fim', () => {
    const stderr = [
      '[silencedetect @ 0x1] silence_start: -0.007',
      '[silencedetect @ 0x1] silence_end: 2.5 | silence_duration: 2.507',
      '[silencedetect @ 0x1] silence_start: 58.2',
    ].join('\n');
    const spans = parseSilence(stderr);
    assert.equal(spans.length, 2);
    assert.deepEqual(spans[0], { start: 0, end: 2.5 });
    assert.equal(spans[1]!.start, 58.2);
    assert.equal(spans[1]!.end, Number.POSITIVE_INFINITY);
  });

  test('parseSilence ignora stderr sem silence_start', () => {
    assert.deepEqual(parseSilence('ffmpeg version 7.1\nsize=N/A time=00:01:00.03'), []);
  });
});

describe('reviewRender (V06)', () => {
  test('vídeo saudável passa sem falhas nem avisos', () => {
    const r = reviewRender(probeBom(), manifestoDe(manifestoValido()));
    assert.equal(r.ok, true);
    assert.deepEqual(r.falhas, []);
    assert.deepEqual(r.avisos, []);
  });

  test('sem vídeo é falha', () => {
    const r = reviewRender(
      probeBom({ hasVideo: false, videoCodec: null, width: 0, height: 0, fps: null }),
      manifestoDe(manifestoValido()),
    );
    assert.equal(r.ok, false);
    assert.deepEqual(r.falhas, ['sem vídeo na saída renderizada']);
  });

  test('sem áudio é falha', () => {
    const r = reviewRender(probeBom({ hasAudio: false, audioCodec: null }), manifestoDe(manifestoValido()));
    assert.equal(r.ok, false);
    assert.deepEqual(r.falhas, ['sem áudio na saída renderizada']);
  });

  test('codec diferente de h264/aac é falha', () => {
    const video = reviewRender(probeBom({ videoCodec: 'hevc' }), manifestoDe(manifestoValido()));
    assert.ok(video.falhas.some((f) => /codec de vídeo hevc/.test(f)));
    const audio = reviewRender(probeBom({ audioCodec: 'mp3' }), manifestoDe(manifestoValido()));
    assert.ok(audio.falhas.some((f) => /codec de áudio mp3/.test(f)));
  });

  test('sem expectedDurationSec, divergência da estimativa do texto vira aviso', () => {
    // O render segue o áudio, não a estimativa: sem a duração real a divergência não bloqueia.
    const m = manifestoDe(manifestoValido()); // 60 s estimados
    assert.equal(reviewRender(probeBom({ durationSec: 54 }), m).ok, true);
    assert.equal(reviewRender(probeBom({ durationSec: 66 }), m).ok, true);
    assert.deepEqual(reviewRender(probeBom({ durationSec: 66 }), m).avisos, []);

    const longa = reviewRender(probeBom({ durationSec: 66.5 }), m);
    assert.equal(longa.ok, true);
    assert.deepEqual(longa.falhas, []);
    const aviso = longa.avisos.find((a) => /fora de ±10%/.test(a));
    assert.ok(aviso);
    assert.match(aviso, /66,5s/);
    assert.match(aviso, /\(60s\)/);
    assert.match(aviso, /duração comparada com estimativa do texto/);

    const curta = reviewRender(probeBom({ durationSec: 53.9 }), m);
    assert.equal(curta.ok, true);
    assert.ok(curta.avisos.some((a) => /fora de ±10% da soma das cenas/.test(a)));
  });

  test('com expectedDurationSec compara com a duração real do áudio', () => {
    // Narração de 70 s com texto estimado em 60 s: o vídeo correto passa pela duração real.
    const m = manifestoDe(manifestoValido());
    const real = reviewRender(probeBom({ durationSec: 70 }), m, { expectedDurationSec: 70 });
    assert.equal(real.ok, true);
    assert.deepEqual(real.falhas, []);
    assert.equal(real.avisos.some((a) => /estimativa do texto/.test(a)), false);

    // Perto da borda de ±10% de 65 s (58,5 s a 71,5 s).
    assert.equal(reviewRender(probeBom({ durationSec: 65 }), m, { expectedDurationSec: 65 }).ok, true);
    assert.equal(reviewRender(probeBom({ durationSec: 71.4 }), m, { expectedDurationSec: 65 }).ok, true);
    assert.equal(reviewRender(probeBom({ durationSec: 58.6 }), m, { expectedDurationSec: 65 }).ok, true);

    // Fora da faixa da duração real é falha, mesmo cabendo na estimativa do texto.
    const fora = reviewRender(probeBom({ durationSec: 75 }), m, { expectedDurationSec: 65 });
    assert.equal(fora.ok, false);
    const falha = fora.falhas.find((f) => /fora de ±10% da duração esperada/.test(f));
    assert.ok(falha);
    assert.match(falha, /75s/);
    assert.match(falha, /\(65s\)/);

    // Valor inutilizável é erro de chamada, não "sem duração real".
    assert.throws(
      () => reviewRender(probeBom(), m, { expectedDurationSec: Number.NaN }),
      /expectedDurationSec inválido/,
    );
  });

  test('resolução precisa casar com o formato do briefing', () => {
    const m = manifestoDe(manifestoValido()); // vertical
    const errada = reviewRender(probeBom({ width: 1920, height: 1080 }), m);
    assert.equal(errada.ok, false);
    const falha = errada.falhas.find((f) => /resolução/.test(f));
    assert.ok(falha);
    assert.match(falha, /1920x1080/);
    assert.match(falha, /vertical/);
    assert.match(falha, /1080x1920/);
  });

  test('prévia aceita metade da resolução, mas só com opts.preview', () => {
    const m = manifestoDe(manifestoValido()); // vertical 1080x1920
    const previa = reviewRender(probeBom({ width: 540, height: 960 }), m, { preview: true });
    assert.equal(previa.ok, true);
    // A resolução cheia continua aceita numa prévia.
    assert.equal(reviewRender(probeBom(), m, { preview: true }).ok, true);

    const semPrevia = reviewRender(probeBom({ width: 540, height: 960 }), m);
    assert.equal(semPrevia.ok, false);
    assert.ok(semPrevia.falhas.some((f) => /resolução 540x960/.test(f)));
  });

  test('avisos vêm do manifesto e incluem a identificação de IA', () => {
    const m = manifestoValido();
    m.cenas[0].afirmacoes[0] = { texto: 'Sem fonte', fonte: null, duvida: false };
    m.cenas[1].papelImagem = 'registro_real'; // aviso + pendência
    m.cenas[2].assetRef = null; // pendência de imagem
    m.cenas[3].realistaGeradaPorIA = true;
    const r = reviewRender(probeBom(), manifestoDe(m));

    assert.equal(r.ok, true, 'aviso não bloqueia a entrega');
    assert.ok(r.avisos.some((a) => /cena 1: afirmação sem fonte e sem dúvida/.test(a)));
    assert.ok(r.avisos.some((a) => /cena 2: papel "registro_real" com prompt/.test(a)));
    assert.ok(r.avisos.some((a) => /cena 2: "registro_real" gerado por prompt/.test(a)));
    assert.ok(r.avisos.some((a) => /cena 3: sem imagem anexada/.test(a)));
    assert.ok(
      r.avisos.includes('marcar conteúdo gerado por IA ao publicar (YouTube exige para cenas realistas)'),
    );
    // Aviso e pendência do mesmo fato não aparecem duas vezes.
    assert.equal(r.avisos.filter((a) => a.includes('afirmação sem fonte')).length, 1);
  });

  test('aviso de repetição visual vem do manifesto', () => {
    const m = manifestoValido();
    for (const i of [0, 1, 2]) m.cenas[i].promptImagem = 'mesma imagem';
    const r = reviewRender(probeBom(), manifestoDe(m));
    assert.ok(r.avisos.some((a) => /3 cenas com o mesmo prompt/.test(a)));
  });

  test('silêncio contínuo de mais de 3 s falha no meio e passa no fim', () => {
    const m = manifestoDe(manifestoValido()); // 60 s

    const meio = reviewRender(probeBom(), m, { silenceSpans: [{ start: 20, end: 24 }] });
    assert.equal(meio.ok, false);
    assert.ok(meio.falhas.some((f) => /silêncio de 4s em 20s/.test(f)));

    const fim = reviewRender(probeBom(), m, { silenceSpans: [{ start: 56, end: 60 }] });
    assert.equal(fim.ok, true);
    assert.deepEqual(fim.falhas, []);

    // Silêncio que vai até o fim do arquivo (end Infinity) também é cauda.
    const abertoNoFim = reviewRender(probeBom(), m, {
      silenceSpans: [{ start: 57, end: Number.POSITIVE_INFINITY }],
    });
    assert.equal(abertoNoFim.ok, true);

    // Exatamente 3 s ainda não é o limite ("mais de 3 s").
    const exato = reviewRender(probeBom(), m, { silenceSpans: [{ start: 20, end: 23 }] });
    assert.equal(exato.ok, true);
  });
});

describe('summarizeForJoel (V06)', () => {
  test('frase curta para a voz e lista completa para a tela', () => {
    const s = summarizeForJoel({ ok: true, falhas: [], avisos: ['aviso um', 'aviso dois'] });
    assert.equal(s.voz, 'Vídeo conferido: 2 avisos, nenhuma falha.');
    assert.deepEqual(s.tela, ['Aviso: aviso um', 'Aviso: aviso dois']);
  });

  test('sem problemas: nenhum aviso e nenhuma falha', () => {
    const s = summarizeForJoel({ ok: true, falhas: [], avisos: [] });
    assert.equal(s.voz, 'Vídeo conferido: nenhum aviso, nenhuma falha.');
    assert.deepEqual(s.tela, []);
  });

  test('com falha: pede correção e mostra falhas antes dos avisos', () => {
    const s = summarizeForJoel({
      ok: false,
      falhas: ['sem áudio na saída renderizada'],
      avisos: ['afirmação sem fonte'],
    });
    assert.equal(s.voz, 'Vídeo conferido: 1 aviso, 1 falha. Corrigir antes de publicar.');
    assert.deepEqual(s.tela, ['Falha: sem áudio na saída renderizada', 'Aviso: afirmação sem fonte']);
  });
});

describe('runReview com executor injetado (V06)', () => {
  const arquivo = 'C:\\temp\\night\\video-final.mp4';

  test('roda ffprobe e silencedetect e aprova o vídeo', async () => {
    const chamadas: { bin: string; args: string[] }[] = [];
    const run: RunCommand = async (bin, args) => {
      chamadas.push({ bin, args });
      if (bin === 'ffprobe') return { code: 0, stdout: PROBE_VERTICAL, stderr: '' };
      return { code: 0, stdout: '', stderr: STDERR_SILENCIO_FIM };
    };

    const r = await runReview(arquivo, manifestoDe(manifestoValido()), run);

    assert.equal(r.ok, true);
    assert.deepEqual(r.falhas, []);
    assert.deepEqual(chamadas.map((c) => c.bin), ['ffprobe', 'ffmpeg']);
    assert.deepEqual(chamadas[0]!.args, probeArgs(arquivo));
    assert.deepEqual(chamadas[1]!.args, silencedetectArgs(arquivo));
  });

  test('silêncio no meio detectado pelo silencedetect vira falha', async () => {
    const stderr = STDERR_SILENCIO_FIM.replace('55.833', '24.1').replace('60.033', '28.4');
    const run: RunCommand = async (bin) =>
      bin === 'ffprobe'
        ? { code: 0, stdout: PROBE_VERTICAL, stderr: '' }
        : { code: 0, stdout: '', stderr };

    const r = await runReview(arquivo, manifestoDe(manifestoValido()), run);
    assert.equal(r.ok, false);
    assert.ok(r.falhas.some((f) => /silêncio de 4,3s em 24,1s/.test(f)));
  });

  test('duração real informada em opts.expectedDurationSec é a referência', async () => {
    // Narração de 75 s com texto estimado em 60 s: sem a duração real só cabe avisar.
    const raw = JSON.parse(PROBE_VERTICAL);
    raw.format.duration = '75.000000';
    const probeLongo = JSON.stringify(raw);
    const run: RunCommand = async (bin) =>
      bin === 'ffprobe'
        ? { code: 0, stdout: probeLongo, stderr: '' }
        : { code: 0, stdout: '', stderr: '' };

    const semOpts = await runReview(arquivo, manifestoDe(manifestoValido()), run);
    assert.equal(semOpts.ok, true);
    assert.ok(semOpts.avisos.some((a) => /duração comparada com estimativa do texto/.test(a)));

    const comOpts = await runReview(arquivo, manifestoDe(manifestoValido()), run, { expectedDurationSec: 75 });
    assert.equal(comOpts.ok, true);
    assert.deepEqual(comOpts.falhas, []);
    assert.equal(comOpts.avisos.some((a) => /estimativa do texto/.test(a)), false);

    const errado = await runReview(arquivo, manifestoDe(manifestoValido()), run, { expectedDurationSec: 90 });
    assert.equal(errado.ok, false);
    assert.ok(errado.falhas.some((f) => /fora de ±10% da duração esperada \(90s\)/.test(f)));
  });

  test('ffprobe com erro vira falha da revisão, não exceção', async () => {
    const run: RunCommand = async () => ({
      code: 1,
      stdout: '',
      stderr: 'video-final.mp4: No such file or directory',
    });
    const r = await runReview(arquivo, manifestoDe(manifestoValido()), run);
    assert.equal(r.ok, false);
    const falha = r.falhas.find((f) => /ffprobe não conseguiu ler o vídeo/.test(f));
    assert.ok(falha);
    assert.match(falha, /No such file or directory/);
  });

  test('saída do ffprobe que não é JSON vira falha da revisão', async () => {
    const run: RunCommand = async () => ({ code: 0, stdout: 'não é json', stderr: '' });
    const r = await runReview(arquivo, manifestoDe(manifestoValido()), run);
    assert.equal(r.ok, false);
    assert.ok(r.falhas.some((f) => /ffprobe inválida/.test(f)));
  });

  test('falha ao medir silêncio vira aviso, sem perder a revisão', async () => {
    const run: RunCommand = async (bin) =>
      bin === 'ffprobe'
        ? { code: 0, stdout: PROBE_VERTICAL, stderr: '' }
        : { code: 1, stdout: '', stderr: 'erro no filtro' };

    const r = await runReview(arquivo, manifestoDe(manifestoValido()), run);
    assert.equal(r.ok, true);
    assert.ok(r.avisos.some((a) => /não foi possível medir silêncios/.test(a)));
  });

  test('opts.preview repassa a metade da resolução ao reviewRender', async () => {
    // Prévia de short vertical: 540x960 em vez de 1080x1920.
    const raw = JSON.parse(PROBE_VERTICAL);
    raw.streams[0].width = 540;
    raw.streams[0].height = 960;
    const probeMetade = JSON.stringify(raw);
    const run: RunCommand = async (bin) =>
      bin === 'ffprobe'
        ? { code: 0, stdout: probeMetade, stderr: '' }
        : { code: 0, stdout: '', stderr: '' };

    // Sem preview a metade da resolução é falha; com preview, passa.
    const semPreview = await runReview(arquivo, manifestoDe(manifestoValido()), run);
    assert.equal(semPreview.ok, false);
    assert.ok(semPreview.falhas.some((f) => /resolução 540x960/.test(f)));

    const comPreview = await runReview(arquivo, manifestoDe(manifestoValido()), run, { preview: true });
    assert.equal(comPreview.ok, true);
    assert.deepEqual(comPreview.falhas, []);
  });
});
