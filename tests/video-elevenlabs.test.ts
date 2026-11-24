import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { inspect } from 'node:util';
import {
  DEFAULT_ELEVENLABS_MODEL,
  DEFAULT_ELEVENLABS_VOICE_ID,
  DEFAULT_ELEVENLABS_VOICE_SETTINGS,
  ELEVENLABS_MCP_URL,
  ElevenLabsCredentials,
  createElevenLabsSynth,
  listElevenLabsVoices,
  type ElevenLabsHttpClient,
  type ElevenLabsHttpRequest,
} from '../src/video/elevenlabs.ts';
import type { RunCommand } from '../src/video/review.ts';

function credsCom(env: NodeJS.ProcessEnv = {}, files: Record<string, string> = {}): ElevenLabsCredentials {
  return new ElevenLabsCredentials({
    env,
    exists: (p) => p in files,
    readFile: (p) => files[p] ?? '',
  });
}

describe('ElevenLabs TTS adapter (src/video/elevenlabs.ts)', () => {
  let dir = '';

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'night-elevenlabs-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('ElevenLabsCredentials lê env ou ~/.elevenlabs/api_key sem vazar segredo', () => {
    assert.equal(ELEVENLABS_MCP_URL, 'https://api.elevenlabs.io/v1/mcp');

    const vazio = credsCom();
    assert.equal(vazio.status().available, false);
    assert.match(vazio.status().missing ?? '', /ELEVENLABS_API_KEY/);
    assert.throws(() => vazio.get(), /falta a chave da ElevenLabs/);

    const segredoEnv = 'sk_eleven_TEST_ENV_999';
    const porEnv = credsCom({ ELEVENLABS_API_KEY: segredoEnv });
    assert.equal(porEnv.status().available, true);
    assert.equal(porEnv.get(), segredoEnv);
    assert.ok(!JSON.stringify(porEnv).includes(segredoEnv));
    assert.ok(!inspect(porEnv).includes(segredoEnv));

    const arquivo = join(homedir(), '.elevenlabs', 'api_key');
    const segredoArq = 'sk_eleven_TEST_FILE_123';
    const porArquivo = credsCom({}, { [arquivo]: `  ${segredoArq}\n` });
    assert.equal(porArquivo.get(), segredoArq);
    assert.ok(!JSON.stringify(porArquivo).includes(segredoArq));
  });

  test('createElevenLabsSynth envia parâmetros certos, converte MP3->WAV, limpa tmp e mede duração', async () => {
    const segredo = 'sk_eleven_SUPER_SECRET_777';
    const creds = credsCom({ ELEVENLABS_API_KEY: segredo });
    const wavOut = join(dir, 'cena-1.wav');

    const httpCalls: { url: string; init: ElevenLabsHttpRequest }[] = [];
    const fakeMp3 = Buffer.from('ID3-FAKE-MP3-BYTES');
    const http: ElevenLabsHttpClient = async (url, init) => {
      httpCalls.push({ url, init });
      return {
        status: 200,
        ok: true,
        arrayBuffer: async () => fakeMp3.buffer.slice(fakeMp3.byteOffset, fakeMp3.byteOffset + fakeMp3.byteLength),
        text: async () => '',
      };
    };

    const cmdCalls: { bin: string; args: string[] }[] = [];
    const run: RunCommand = async (bin, args) => {
      cmdCalls.push({ bin, args });
      if (bin === 'ffmpeg') {
        assert.ok(args.includes('-ar') && args.includes('48000'));
        assert.ok(args.includes('-ac') && args.includes('2'));
        await writeFile(args.at(-1)!, 'RIFF-FAKE-WAV', 'utf8');
        return { code: 0, stdout: '', stderr: '' };
      }
      if (bin === 'ffprobe') {
        return {
          code: 0,
          stdout: JSON.stringify({
            streams: [{ codec_type: 'audio', codec_name: 'pcm_s16le' }],
            format: { duration: '3.750000' },
          }),
          stderr: '',
        };
      }
      throw new Error(`binário inesperado: ${bin}`);
    };

    const synth = createElevenLabsSynth({ credentials: creds, http, run });
    const res = await synth('Existe um animal que sobrevive ao espaço!', 'pt-BR', wavOut);

    assert.equal(res.audioSeconds, 3.75);
    assert.equal(httpCalls.length, 1);
    assert.equal(
      httpCalls[0]!.url,
      `https://api.elevenlabs.io/v1/text-to-speech/${DEFAULT_ELEVENLABS_VOICE_ID}?output_format=mp3_44100_128`,
    );
    assert.equal(httpCalls[0]!.init.headers['xi-api-key'], segredo);
    const body = JSON.parse(httpCalls[0]!.init.body ?? '{}') as {
      text: string;
      model_id: string;
      voice_settings: typeof DEFAULT_ELEVENLABS_VOICE_SETTINGS;
    };
    assert.equal(body.model_id, DEFAULT_ELEVENLABS_MODEL);
    assert.deepEqual(body.voice_settings, DEFAULT_ELEVENLABS_VOICE_SETTINGS);
    assert.equal(cmdCalls.map((c) => c.bin).join(','), 'ffmpeg,ffprobe');
    assert.equal(existsSync(`${wavOut}.tmp.mp3`), false, 'arquivo temporário .mp3 deve ser apagado');
    assert.equal(existsSync(wavOut), true);
  });

  test('createElevenLabsSynth redige segredo se a API falhar e remove tmp se ffmpeg falhar', async () => {
    const segredo = 'sk_eleven_LEAK_GUARD_456';
    const creds = credsCom({ ELEVENLABS_API_KEY: segredo });
    const wavOut = join(dir, 'erro.wav');

    const httpErro: ElevenLabsHttpClient = async () => ({
      status: 401,
      ok: false,
      arrayBuffer: async () => new ArrayBuffer(0),
      text: async () => `invalid api key: ${segredo}`,
    });
    const synthErro = createElevenLabsSynth({
      credentials: creds,
      http: httpErro,
      run: async () => ({ code: 0, stdout: '', stderr: '' }),
    });

    await assert.rejects(
      synthErro('Olá mundo', 'pt-BR', wavOut),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(!err.message.includes(segredo), 'chave não pode aparecer na mensagem de erro');
        assert.match(err.message, /\[segredo\]/);
        return true;
      },
    );

    const httpOk: ElevenLabsHttpClient = async () => {
      const b = Buffer.from('FAKE-MP3');
      return {
        status: 200,
        ok: true,
        arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength),
        text: async () => '',
      };
    };
    const synthFfmpegFail = createElevenLabsSynth({
      credentials: creds,
      http: httpOk,
      run: async () => ({ code: 1, stdout: '', stderr: 'invalid mp3' }),
    });

    await assert.rejects(synthFfmpegFail('Olá mundo', 'pt-BR', wavOut), /ffmpeg falhou/);
    assert.equal(existsSync(`${wavOut}.tmp.mp3`), false);
  });

  test('listElevenLabsVoices analisa vozes e protege segredo em erro', async () => {
    const segredo = 'sk_eleven_VOICES_SECRET';
    const creds = credsCom({ ELEVENLABS_API_KEY: segredo });

    const voices = await listElevenLabsVoices({
      credentials: creds,
      http: async () => ({
        status: 200,
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(0),
        text: async () =>
          JSON.stringify({
            voices: [
              { voice_id: 'v1', name: 'Adam', category: 'premade' },
              { voice_id: 'v2', name: 'Narrador PT', category: 'cloned' },
            ],
          }),
      }),
    });
    assert.deepEqual(voices, [
      { voiceId: 'v1', name: 'Adam', category: 'premade' },
      { voiceId: 'v2', name: 'Narrador PT', category: 'cloned' },
    ]);

    await assert.rejects(
      listElevenLabsVoices({
        credentials: creds,
        http: async () => ({
          status: 403,
          ok: false,
          arrayBuffer: async () => new ArrayBuffer(0),
          text: async () => `forbidden token ${segredo}`,
        }),
      }),
      (err: unknown) => err instanceof Error && !err.message.includes(segredo) && /\[segredo\]/.test(err.message),
    );
  });
});
