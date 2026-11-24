import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { inspect } from 'node:util';
import { ArtifactStore } from '../src/artifacts/store.ts';
import { WORKER_CONTRACT, type WorkerRequest } from '../src/jobs/worker.ts';
import { VideoAgent, type ReviewContext } from '../src/video/agent.ts';
import { buildBrief } from '../src/video/brief.ts';
import { FlowFolderProvider, writePromptSheet } from '../src/video/flow-folder.ts';
import { CompositeImageProvider, createImageProvider } from '../src/video/image-providers.ts';
import { MANIFEST_VERSION, validateManifest, type Scene, type VideoManifest } from '../src/video/manifest.ts';
import { Narrator, type Synth } from '../src/video/narrate.ts';
import {
  DEFAULT_OPENAI_IMAGE_MODEL,
  OpenAiImageCredentials,
  OpenAiImageProvider,
  buildImagePromptForScene,
  selectOpenAiImageSize,
  type OpenAiImageHttpClient,
  type OpenAiImageHttpRequest,
} from '../src/video/openai-image.ts';
import type { RenderResult } from '../src/video/render.ts';
import type { ReviewResult } from '../src/video/review.ts';

function openAiCredsWith(env: NodeJS.ProcessEnv = {}, files: Record<string, string> = {}): OpenAiImageCredentials {
  return new OpenAiImageCredentials({
    env,
    exists: (p) => p in files,
    readFile: (p) => files[p] ?? '',
  });
}

function makeManifest(
  templateVisual: 'psych-explainer-16x9' | 'dark-philosophy-16x9' = 'psych-explainer-16x9',
  formato: 'horizontal' | 'vertical' = 'horizontal',
): VideoManifest {
  const brief = buildBrief({
    tema: 'Como lembrar do que estuda',
    publico: 'estudantes',
    plataforma: formato === 'horizontal' ? 'youtube' : 'reels',
    duracaoAlvoSeg: 30,
    estilo: templateVisual,
    objetivo: 'explicar com clareza',
  });
  const res = validateManifest({
    version: MANIFEST_VERSION,
    jobId: 'vid-gpt-flow-1',
    brief,
    titulo: 'Teste GPT + Flow',
    motorVisual: 'remotion',
    templateVisual,
    fontes: [],
    cenas: [1, 2].map((n) => ({
      n,
      narracao: `Narração da cena ${n}`,
      duracaoEstimadaSeg: 15,
      afirmacoes: [],
      visual: `Estudante na mesa de madeira cena ${n}`,
      promptImagem: '',
      papelImagem: 'ilustracao',
      realistaGeradaPorIA: false,
      assetRef: null,
      cenario: templateVisual === 'psych-explainer-16x9' ? 'panic-desk' : 'chiaroscuro',
      textoNaTela: n === 1 ? 'ILUSÃO DA LEITURA' : undefined,
      transicao: 'cut',
    })),
  });
  if (!res.ok) throw new Error('manifest inválido: ' + JSON.stringify(res.errors));
  return res.manifest;
}

describe('OpenAI GPT Image & multi-provider Flow + GPT', () => {
  let root = '';
  let workDir = '';
  let flowRoot = '';
  let gptCache = '';

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'night-openai-img-'));
    workDir = join(root, 'work');
    flowRoot = join(root, 'flow');
    gptCache = join(root, 'gpt-cache');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test('OpenAiImageCredentials lê env ou ~/.openai/api_key sem expor segredo', () => {
    const vazio = openAiCredsWith();
    assert.equal(vazio.status().available, false);
    assert.match(vazio.status().missing ?? '', /OPENAI_API_KEY/);
    assert.throws(() => vazio.get(), /falta a chave da OpenAI/);

    const secretEnv = 'sk-proj-TEST-ENV-XYZ999';
    const porEnv = openAiCredsWith({ OPENAI_API_KEY: secretEnv });
    assert.equal(porEnv.status().available, true);
    assert.equal(porEnv.get(), secretEnv);
    assert.ok(!JSON.stringify(porEnv).includes(secretEnv));
    assert.ok(!inspect(porEnv).includes(secretEnv));

    const filePath = join(homedir(), '.openai', 'api_key');
    const secretFile = 'sk-proj-TEST-FILE-ABC123';
    const porArq = openAiCredsWith({}, { [filePath]: `  ${secretFile}\n` });
    assert.equal(porArq.get(), secretFile);
    assert.ok(!JSON.stringify(porArq).includes(secretFile));
  });

  test('selectOpenAiImageSize e buildImagePromptForScene respeitam formato e template', () => {
    assert.equal(selectOpenAiImageSize('horizontal'), '1536x1024');
    assert.equal(selectOpenAiImageSize('vertical'), '1024x1536');
    assert.equal(selectOpenAiImageSize(undefined), '1024x1536');

    const mPsych = makeManifest('psych-explainer-16x9', 'horizontal');
    const p1 = buildImagePromptForScene(mPsych.cenas[0]!, mPsych);
    assert.match(p1, /16:9 horizontal widescreen/);
    assert.match(p1, /ILUSÃO DA LEITURA/);
    assert.match(p1, /no watermarks/);

    const mPhil = makeManifest('dark-philosophy-16x9', 'horizontal');
    const pPhil = buildImagePromptForScene(mPhil.cenas[0]!, mPhil);
    assert.match(pPhil, /chiaroscuro/);
    assert.match(pPhil, /ZERO text/);
    assert.ok(!pPhil.includes('ILUSÃO DA LEITURA'), 'filosofia dark não deve colocar texto diegético na pintura');

    const customScene: Scene = { ...mPsych.cenas[0]!, promptImagem: 'illustration 1, same palette' };
    assert.equal(buildImagePromptForScene(customScene, mPsych), 'illustration 1, same palette');
  });

  test('OpenAiImageProvider gera via mock HTTP, faz cache e respeita teto maxImages', async () => {
    const secret = 'sk-proj-SUPER-SECRET-888';
    const creds = openAiCredsWith({ OPENAI_API_KEY: secret });
    const manifest = makeManifest('psych-explainer-16x9', 'horizontal');
    const calls: { url: string; init: OpenAiImageHttpRequest }[] = [];

    const http: OpenAiImageHttpClient = async (url, init) => {
      calls.push({ url, init });
      const b64 = Buffer.from(`JPEG-CENA-${calls.length}`).toString('base64');
      return {
        status: 200,
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(0),
        text: async () => JSON.stringify({ data: [{ b64_json: b64 }] }),
      };
    };

    const provider = new OpenAiImageProvider({
      cacheDir: gptCache,
      credentials: creds,
      quality: 'medium',
      maxImages: 1,
      http,
    });

    const p1 = await provider.find(manifest.jobId, manifest.cenas[0]!, manifest);
    assert.ok(p1 && p1.endsWith('.jpg'));
    assert.equal((await readFile(p1, 'utf8')), 'JPEG-CENA-1');
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, 'https://api.openai.com/v1/images/generations');
    const body = JSON.parse(calls[0]!.init.body ?? '{}') as Record<string, unknown>;
    assert.equal(body.model, DEFAULT_OPENAI_IMAGE_MODEL);
    assert.equal(body.size, '1536x1024');
    assert.equal(body.quality, 'medium');

    // Segunda chamada na mesma cena reaproveita o cache sem bater na API nem contar no limite.
    const p1Cached = await provider.find(manifest.jobId, manifest.cenas[0]!, manifest);
    assert.equal(p1Cached, p1);
    assert.equal(calls.length, 1);

    // Cena 2 estoura maxImages = 1.
    await assert.rejects(
      () => provider.find(manifest.jobId, manifest.cenas[1]!, manifest),
      /limite de imagens da OpenAI atingido \(1\)/,
    );
  });

  test('OpenAiImageProvider omite segredo em falhas HTTP e suporta skipWhenUnavailable', async () => {
    const vazio = new OpenAiImageProvider({
      cacheDir: gptCache,
      credentials: openAiCredsWith(),
      skipWhenUnavailable: true,
    });
    const manifest = makeManifest();
    assert.equal(await vazio.find(manifest.jobId, manifest.cenas[0]!, manifest), null);

    const secret = 'sk-proj-LEAK-CHECK-12345';
    const failProvider = new OpenAiImageProvider({
      cacheDir: gptCache,
      credentials: openAiCredsWith({ OPENAI_API_KEY: secret }),
      http: async () => ({
        status: 401,
        ok: false,
        arrayBuffer: async () => new ArrayBuffer(0),
        text: async () => `invalid token: ${secret}`,
      }),
    });

    await assert.rejects(
      () => failProvider.find(manifest.jobId, manifest.cenas[0]!, manifest),
      (err: Error) => {
        assert.match(err.message, /HTTP 401/);
        assert.ok(!err.message.includes(secret), 'chave jamais deve aparecer no erro');
        assert.match(err.message, /\[segredo\]/);
        return true;
      },
    );
  });

  test('FlowFolderProvider.writePromptSheet gera prompts mesmo em manifestos com promptImagem vazio', async () => {
    const manifest = makeManifest('dark-philosophy-16x9', 'horizontal');
    const dir = join(flowRoot, 'pasta-teste');
    const sheet = await writePromptSheet(manifest, dir);
    const content = await readFile(sheet, 'utf8');
    assert.match(content, /^cena-1: 16:9 horizontal widescreen composition, fine-art museum aesthetic/m);
    assert.match(content, /^cena-2: 16:9 horizontal widescreen composition, fine-art museum aesthetic/m);
  });

  test('createImageProvider("auto") prioriza Flow local, usa GPT nas faltantes e registra origem no VideoAgent', async () => {
    const manifest = makeManifest('psych-explainer-16x9', 'horizontal');
    const store = new ArtifactStore(join(root, 'store'));

    // Cena 1 existe manualmente no Flow; cena 2 virá do GPT Image.
    const flowJobDir = join(flowRoot, 'scenes');
    await mkdir(flowJobDir, { recursive: true });
    await writeFile(join(flowJobDir, 'cena-1.jpg'), 'FLOW-CENA-1', 'utf8');

    const gptHttp: OpenAiImageHttpClient = async () => ({
      status: 200,
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(0),
      text: async () => JSON.stringify({ data: [{ b64_json: Buffer.from('GPT-CENA-2').toString('base64') }] }),
    });

    const composite = createImageProvider({
      mode: 'auto',
      flowRoot,
      numeroDoVideo: 'scenes',
      cacheDir: gptCache,
      openAiCredentials: openAiCredsWith({ OPENAI_API_KEY: 'sk-proj-AUTO-TEST-111' }),
      gptHttp,
    });
    assert.ok(composite instanceof CompositeImageProvider);

    const synth: Synth = async (text, _lang, file) => {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, `RIFF-${text}`, 'utf8');
      return { audioSeconds: 2.5 };
    };
    const narrator = new Narrator(synth, store, { workDir });

    const renderedPlans: Array<{ scenes: Array<{ n: number; imagePath: string }> }> = [];
    const agent = new VideoAgent({
      store,
      narrator,
      images: composite,
      workDir,
      remotionRender: async (plan): Promise<RenderResult> => {
        renderedPlans.push({ scenes: plan.scenes.map((s) => ({ n: s.n, imagePath: s.imagePath })) });
        await mkdir(dirname(plan.outPath), { recursive: true });
        await writeFile(plan.outPath, 'fake-mp4', 'utf8');
        await writeFile(plan.subtitlesPath, '1\n00:00:00,000 --> 00:00:02,500\noi\n', 'utf8');
        return { outPath: plan.outPath, durationSec: 5, args: [] };
      },
      review: async (_file: string, _m: VideoManifest, _opts: ReviewContext): Promise<ReviewResult> => ({
        ok: true,
        falhas: [],
        avisos: [],
      }),
    });

    const req: WorkerRequest = {
      contract: WORKER_CONTRACT,
      jobId: manifest.jobId,
      kind: 'video',
      params: { manifest },
      limits: {},
    };
    const { runId } = await agent.start(req);
    await agent.whenDone(runId);

    const status = await agent.status(runId);
    assert.equal(status.state, 'succeeded');

    const stored = await store.manifest(manifest.jobId);
    const img1 = stored?.items.find((i) => i.name === 'imagem-cena-1.jpg');
    const img2 = stored?.items.find((i) => i.name === 'imagem-cena-2.jpg');
    assert.equal(img1?.origin, 'flow');
    assert.equal(img2?.origin, 'openai-gpt-image');
    assert.ok(renderedPlans[0]!.scenes[0]!.imagePath.endsWith('imagem-cena-1.jpg'));
    assert.ok(renderedPlans[0]!.scenes[1]!.imagePath.endsWith('imagem-cena-2.jpg'));
  });
});
