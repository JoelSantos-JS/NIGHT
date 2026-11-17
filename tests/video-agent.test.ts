import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import type { AdvisorResult } from '../src/advisor/deepseek-client.ts';
import { MemoryAdvisorJournal } from '../src/advisor/journal.ts';
import type { AdvisorInput, Opinion, Recomendacao } from '../src/advisor/opinion.ts';
import { AdvisorService } from '../src/advisor/service.ts';
import type { OpinionAdvisor } from '../src/advisor/service.ts';
import { ArtifactStore } from '../src/artifacts/store.ts';
import { JobRunner } from '../src/jobs/runner.ts';
import { WORKER_CONTRACT, type JobWorker, type WorkerRequest, type WorkerState } from '../src/jobs/worker.ts';
import { PgMemory } from '../src/memory/pg-memory.ts';
import {
  VideoAgent, VoiceUnavailableError, type ImageProvider, type ReviewContext,
} from '../src/video/agent.ts';
import { buildBrief, type VideoBrief } from '../src/video/brief.ts';
import { FlowFolderProvider } from '../src/video/flow-folder.ts';
import {
  MANIFEST_VERSION,
  sceneCacheKey,
  validateManifest,
  type VideoManifest,
} from '../src/video/manifest.ts';
import { Narrator, type Synth } from '../src/video/narrate.ts';
import {
  buildDeliveryPackage,
  loadPackage,
  replaceScene,
} from '../src/video/package.ts';
import type { RenderPlan, RenderResult } from '../src/video/render.ts';
import type { ReviewResult, RunCommand, RunResult } from '../src/video/review.ts';
import type { ScriptGenerator } from '../src/video/script.ts';
import { resetTestDb, TEST_URL } from './helpers.ts';

/** Shorts de 60 s com 3 cenas de 20 s (dentro da meta do briefing). */
const brief: VideoBrief = buildBrief({
  tema: 'Piloto do agente de vídeo',
  publico: 'adultos curiosos',
  plataforma: 'shorts',
  duracaoAlvoSeg: 60,
  estilo: 'documental',
  objetivo: 'explicar em um minuto',
});

/** Manifesto válido; assetRef fica null até o agente importar as imagens. */
function manifesto(jobId: string, opts: { semFonteNaCena?: number } = {}): VideoManifest {
  const validado = validateManifest({
    version: MANIFEST_VERSION,
    jobId,
    brief,
    titulo: 'Piloto do agente',
    fontes: [{ id: 'fonte', url: 'https://exemplo.org/a', titulo: 'Fonte de teste', acessadoEm: '2026-11-17' }],
    cenas: [1, 2, 3].map((n) => ({
      n,
      narracao: `Narração da cena ${n}`,
      duracaoEstimadaSeg: 20,
      afirmacoes: [
        {
          texto: `Afirmação ${n}`,
          fonte: n === opts.semFonteNaCena ? null : 'fonte',
          // Sem fonte e sem dúvida vira pendência do render final.
          duvida: false,
        },
      ],
      visual: `Descrição visual ${n}`,
      promptImagem: `imagem única ${n}`,
      papelImagem: 'ilustracao',
      realistaGeradaPorIA: false,
      assetRef: null,
    })),
  });
  if (!validado.ok) throw new Error('manifesto de teste inválido: ' + JSON.stringify(validado.errors));
  return validado.manifest;
}

function pedido(jobId: string, manifest: VideoManifest): WorkerRequest {
  return { contract: WORKER_CONTRACT, jobId, kind: 'video', params: { manifest }, limits: {} };
}

/** Pedido sem manifesto: o agente gera o roteiro a partir do tema (V02). */
function pedidoTema(jobId: string, topic: string, extra: Record<string, unknown> = {}): WorkerRequest {
  return { contract: WORKER_CONTRACT, jobId, kind: 'video', params: { topic, ...extra }, limits: {} };
}

/** Síntese falsa: grava um WAV de mentira e conta o que foi sintetizado. */
class FakeSynth {
  readonly texts: string[] = [];
  constructor(readonly seconds = 2) {}
  synth: Synth = async (text, _language, file) => {
    this.texts.push(text);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `RIFF-fake;${text}`, 'utf8');
    return { audioSeconds: this.seconds };
  };
}

/**
 * Síntese que narra até a cena indicada e então acusa serviço de voz ausente.
 * A primeira cena fica pronta no store, para a retomada continuar de onde parou.
 */
class SynthSemVozNaCena {
  readonly texts: string[] = [];
  private chamadas = 0;
  constructor(private readonly falhaNaChamada: number) {}
  synth: Synth = async (text, _language, file) => {
    this.chamadas += 1;
    if (this.chamadas >= this.falhaNaChamada) throw new VoiceUnavailableError();
    this.texts.push(text);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `RIFF-fake;${text}`, 'utf8');
    return { audioSeconds: 2 };
  };
}

/** Provider falso: cada cena tem imagem só depois de fornecer(n). */
class FakeImages implements ImageProvider {
  readonly origin = 'flow';
  readonly calls: number[] = [];
  private readonly paths = new Map<number, string>();

  constructor(private readonly dir: string) {}

  async fornecer(n: number): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const caminho = join(this.dir, `fonte-${n}.png`);
    await writeFile(caminho, `PNG fake da cena ${n}`, 'utf8');
    this.paths.set(n, caminho);
  }

  async find(_jobId: string, scene: { n: number }): Promise<string | null> {
    this.calls.push(scene.n);
    return this.paths.get(scene.n) ?? null;
  }
}

/** Render falso: grava MP4 e SRT fake, registra o plano e pode segurar a etapa. */
class FakeRender {
  readonly calls: { preview: boolean; plan: RenderPlan }[] = [];
  gate: Promise<void> | null = null;
  entered: (() => void) | null = null;

  async render(plan: RenderPlan): Promise<RenderResult> {
    this.calls.push({ preview: plan.preview, plan });
    this.entered?.();
    if (this.gate !== null) await this.gate;
    await mkdir(dirname(plan.outPath), { recursive: true });
    await writeFile(plan.outPath, `mp4 fake ${plan.preview ? 'previa' : 'final'}`, 'utf8');
    await writeFile(plan.subtitlesPath, '1\n00:00:00,000 --> 00:00:01,000\ncena\n', 'utf8');
    const durationSec = plan.scenes.reduce((soma, cena) => soma + cena.durationSec, 0);
    return { outPath: plan.outPath, durationSec, args: [] };
  }
}

/** Revisão falsa: sem falhas por padrão; guarda arquivos e opções de cada revisão. */
class FakeReview {
  readonly files: string[] = [];
  readonly contexts: ReviewContext[] = [];
  falhas: string[] = [];
  async review(file: string, _manifest: VideoManifest, opts: ReviewContext): Promise<ReviewResult> {
    this.files.push(file);
    this.contexts.push(opts);
    return { ok: this.falhas.length === 0, falhas: [...this.falhas], avisos: ['aviso de teste'] };
  }
}

const MODELO_PARECER = 'fake-v4-pro';

/** Parecer falso: só o campo que o agente lê é preenchido; as referências ficam vazias. */
function parecerFalso(recomendacao: Recomendacao, jobId: string): Opinion {
  return {
    version: 'parecer/1',
    jobId,
    fase: 'antes-do-render',
    recomendacao,
    motivos: ['afirmação principal sem fonte'],
    evidencias: [],
    contrapontos: ['cena 2 pode enganar'],
    lacunas: [],
    proximoTeste: 'acrescentar a fonte antes do render',
    confianca: 'alta',
  };
}

/** Conselheiro falso: guarda a entrada e responde com parecer ou falha. */
class FakeAdvisor implements OpinionAdvisor {
  readonly model = MODELO_PARECER;
  readonly calls: AdvisorInput[] = [];
  constructor(private readonly behave: (input: AdvisorInput) => AdvisorResult) {}

  async ask(input: AdvisorInput): Promise<AdvisorResult> {
    this.calls.push(input);
    return this.behave(input);
  }
}

/** AdvisorService + diário em memória: para os testes há sempre parecer ou falha limpa. */
function advisorCom(recomendacao: Recomendacao | null): {
  service: AdvisorService;
  fake: FakeAdvisor;
  journal: MemoryAdvisorJournal;
} {
  const fake = new FakeAdvisor((input) => recomendacao === null
    ? {
        ok: false,
        state: 'parecer_indisponivel',
        reason: 'timeout',
        detail: 'DeepSeek passou do tempo; o parecer não foi feito',
        model: MODELO_PARECER,
        ms: 5,
      }
    : {
        ok: true,
        opinion: parecerFalso(recomendacao, input.jobId),
        model: MODELO_PARECER,
        ms: 5,
        usage: { promptTokens: 10, completionTokens: 5 },
      });
  const journal = new MemoryAdvisorJournal();
  return { service: new AdvisorService(fake, journal), fake, journal };
}

function agenteCom(
  store: ArtifactStore,
  workDir: string,
  images: ImageProvider,
  synth: { synth: Synth },
  render: FakeRender,
  review: FakeReview,
  advisor?: AdvisorService,
  generator?: ScriptGenerator,
  semVoz = false,
): VideoAgent {
  const narrator = new Narrator(synth.synth, store, { workDir });
  return new VideoAgent({
    store,
    narrator,
    semVoz,
    render: (plan) => render.render(plan),
    review: (file, manifest, opts) => review.review(file, manifest, opts),
    images,
    workDir,
    advisor,
    generator,
  });
}

/**
 * Adapta o VideoAgent a um job do banco: o id do job só existe depois do createJob,
 * então o manifesto é injetado aqui em vez de vir de params na criação.
 */
class VideoWorker implements JobWorker {
  readonly name = 'video-teste';
  constructor(private readonly agent: VideoAgent, private readonly manifest: VideoManifest) {}

  start(request: WorkerRequest): Promise<{ runId: string }> {
    return this.agent.start({ ...request, params: { manifest: this.manifest } });
  }

  status(runId: string): Promise<{ state: WorkerState; message: string }> {
    return this.agent.status(runId);
  }

  result(runId: string): ReturnType<VideoAgent['result']> {
    return this.agent.result(runId);
  }

  cancel(runId: string): Promise<{ cancelled: boolean; detail: string }> {
    return this.agent.cancel(runId);
  }
}

/** ffprobe falso: devolve um vídeo h264/aac na resolução e duração pedidas. */
function probeFalso(width: number, height: number, durationSec: number): RunCommand {
  return async (bin: string, _args: string[]): Promise<RunResult> => {
    if (bin === 'ffprobe') {
      const streams = [
        { codec_type: 'video', codec_name: 'h264', width, height, r_frame_rate: '30/1' },
        { codec_type: 'audio', codec_name: 'aac' },
      ];
      return { code: 0, stdout: JSON.stringify({ format: { duration: String(durationSec) }, streams }), stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
}

describe('agente de vídeo local (V07 + V08)', () => {
  let root = '';
  let workDir = '';
  let imagesDir = '';
  let store: ArtifactStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'night-agente-'));
    workDir = await mkdtemp(join(tmpdir(), 'night-agente-work-'));
    imagesDir = await mkdtemp(join(tmpdir(), 'night-agente-img-'));
    store = new ArtifactStore(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(workDir, { recursive: true, force: true });
    await rm(imagesDir, { recursive: true, force: true });
  });

  test('fluxo completo termina succeeded com prévia e vídeo final', async () => {
    const jobId = 'video-completo';
    const images = new FakeImages(imagesDir);
    for (const n of [1, 2, 3]) await images.fornecer(n);
    const synth = new FakeSynth();
    const render = new FakeRender();
    const review = new FakeReview();
    const agent = agenteCom(store, workDir, images, synth, render, review);

    const { runId } = await agent.start(pedido(jobId, manifesto(jobId)));
    await agent.whenDone(runId);

    const status = await agent.status(runId);
    assert.equal(status.state, 'succeeded');
    assert.equal(status.message, 'concluído');

    const resultado = await agent.result(runId);
    assert.equal(resultado.state, 'succeeded');
    assert.equal(resultado.error, null);
    const nomes = resultado.artifacts.map((item) => item.name);
    assert.ok(nomes.includes(`${jobId}-preview.mp4`), 'faltou a prévia');
    assert.ok(nomes.includes(`${jobId}.mp4`), 'faltou o vídeo final');

    assert.equal(synth.texts.length, 3);
    assert.deepEqual(render.calls.map((c) => c.preview), [true, false], 'prévia antes, final depois');
    assert.equal(review.files.length, 1, 'só a prévia é revisada');
    // A revisão sabe que é prévia e a duração real do plano (3 cenas de 2 s do áudio).
    assert.deepEqual(review.contexts, [{ preview: true, expectedDurationSec: 6 }]);

    const manifestoStore = await store.manifest(jobId);
    const imagens = (manifestoStore?.items ?? []).filter((item) => item.kind === 'image');
    assert.equal(imagens.length, 3);
    assert.ok(imagens.every((item) => item.origin === 'flow'));
    assert.deepEqual(await store.verify(jobId), { ok: true, missing: [], changed: [], extra: [] });
  });

  test('imagem faltando para no Flow antes de narrar; retomada importa o que faltou e narra', async () => {
    const jobId = 'video-flow';
    const images = new FakeImages(imagesDir);
    await images.fornecer(1);
    const synth = new FakeSynth();
    const render = new FakeRender();
    const review = new FakeReview();
    const agent = agenteCom(store, workDir, images, synth, render, review);
    const m = manifesto(jobId);

    const { runId } = await agent.start(pedido(jobId, m));
    await agent.whenDone(runId);

    const status = await agent.status(runId);
    assert.equal(status.state, 'waiting');
    assert.equal(status.message, 'aguardando_flow: cenas 2, 3');
    const resultado = await agent.result(runId);
    assert.equal(resultado.state, 'waiting');
    assert.equal(resultado.waitingFor, 'flow');
    assert.equal(resultado.error, null);
    assert.equal(synth.texts.length, 0, 'a imagem vem antes da narração');
    assert.equal(render.calls.length, 0, 'sem todas as imagens não há render');

    // O Flow entregou o que faltava; novo NIGHT (nova instância) retoma o mesmo job.
    await images.fornecer(2);
    await images.fornecer(3);
    images.calls.length = 0;
    const synth2 = new FakeSynth();
    const render2 = new FakeRender();
    const review2 = new FakeReview();
    const retomada = agenteCom(store, workDir, images, synth2, render2, review2);

    const { runId: run2 } = await retomada.start(pedido(jobId, m));
    await retomada.whenDone(run2);

    const status2 = await retomada.status(run2);
    assert.equal(status2.state, 'succeeded');
    assert.equal(status2.message, 'concluído');
    assert.equal(synth2.texts.length, 3, 'com todas as imagens a narração roda');
    assert.deepEqual(images.calls, [2, 3], 'a cena 1 veio do store, sem consultar o Flow');
    assert.deepEqual(render2.calls.map((c) => c.preview), [true, false]);
    assert.equal(review2.files.length, 1);
  });

  test('sem serviço de voz: narração vira waiting "voz"; a retomada com voz continua de onde parou', async () => {
    const jobId = 'video-sem-voz';
    const images = new FakeImages(imagesDir);
    for (const n of [1, 2, 3]) await images.fornecer(n);
    const render = new FakeRender();
    const review = new FakeReview();
    // A cena 1 narra; a cena 2 acusa a voz ausente no meio do caminho.
    const semVoz = new SynthSemVozNaCena(2);
    const agent = agenteCom(store, workDir, images, semVoz, render, review);

    const { runId } = await agent.start(pedido(jobId, manifesto(jobId)));
    await agent.whenDone(runId);

    const status = await agent.status(runId);
    assert.equal(status.state, 'waiting');
    assert.equal(status.message, 'falta o serviço de voz: rode pnpm night:voz para narrar');
    const resultado = await agent.result(runId);
    assert.equal(resultado.state, 'waiting');
    assert.equal(resultado.waitingFor, 'voz');
    assert.equal(resultado.error, null, 'espera não é falha');
    assert.ok(
      resultado.artifacts.some((item) => /^narracao-1-/.test(item.name)),
      'a cena já narrada fica no store',
    );
    assert.equal(render.calls.length, 0, 'sem voz não há render');

    // O modo voz subiu: a retomada reaproveita a cena 1 e narra só o que faltava.
    images.calls.length = 0;
    const synth = new FakeSynth();
    const render2 = new FakeRender();
    const review2 = new FakeReview();
    const retomada = agenteCom(store, workDir, images, synth, render2, review2);

    const { runId: run2 } = await retomada.start(pedido(jobId, manifesto(jobId)));
    await retomada.whenDone(run2);

    assert.equal((await retomada.status(run2)).state, 'succeeded');
    assert.deepEqual(images.calls, [], 'as imagens já importadas não são reimportadas');
    assert.deepEqual(synth.texts, ['Narração da cena 2', 'Narração da cena 3'],
      'só as cenas que faltavam foram sintetizadas');
    assert.deepEqual(render2.calls.map((c) => c.preview), [true, false]);
    assert.equal(review2.files.length, 1);
  });

  test('sem imagens e sem voz: grava a folha, avisa o modo voz e para no Flow sem narrar', async () => {
    const jobId = 'video-flow-sem-voz';
    const flowDir = join(imagesDir, jobId);
    const images = new FlowFolderProvider({ root: imagesDir });
    let chamadas = 0;
    const semVoz: Synth = async () => {
      chamadas += 1;
      throw new VoiceUnavailableError();
    };
    const render = new FakeRender();
    // Modo texto: o agente sabe que não há narração, mas não tenta sintetizar para descobrir.
    const agent = agenteCom(
      store, workDir, images, { synth: semVoz }, render, new FakeReview(), undefined, undefined, true,
    );

    const { runId } = await agent.start(pedido(jobId, manifesto(jobId)));
    await agent.whenDone(runId);

    const status = await agent.status(runId);
    assert.equal(status.state, 'waiting');
    assert.equal(chamadas, 0, 'o agente não tenta narrar antes das imagens');
    assert.match(status.message, /aguardando_flow: cenas 1, 2, 3/);
    assert.ok(status.message.includes(flowDir), `mensagem sem a pasta: ${status.message}`);
    assert.ok(
      status.message.includes('depois, a narração precisa do modo voz (pnpm night:voz)'),
      `mensagem sem o aviso da voz: ${status.message}`,
    );

    const resultado = await agent.result(runId);
    assert.equal(resultado.state, 'waiting');
    assert.equal(resultado.waitingFor, 'flow');
    assert.equal(resultado.error, null);
    assert.equal(render.calls.length, 0);

    // A folha com os prompts é gravada antes de qualquer narração.
    const folha = await readFile(join(flowDir, 'prompts-flow.txt'), 'utf8');
    assert.match(folha, /^cena-1: imagem única 1$/m);
    assert.match(folha, /^cena-3: imagem única 3$/m);
  });

  test('imagens colocadas e sem voz: importa as imagens e só então para na voz; com voz segue sem reimportar', async () => {
    const jobId = 'video-imagens-sem-voz';
    const flowDir = join(imagesDir, jobId);
    const images = new FlowFolderProvider({ root: imagesDir });
    const m = manifesto(jobId);
    const semVoz: Synth = async () => { throw new VoiceUnavailableError(); };

    const primeiro = agenteCom(
      store, workDir, images, { synth: semVoz }, new FakeRender(), new FakeReview(),
      undefined, undefined, true,
    );
    const { runId } = await primeiro.start(pedido(jobId, m));
    await primeiro.whenDone(runId);
    assert.equal((await primeiro.result(runId)).waitingFor, 'flow');

    // O Joel gerou no Flow e salvou as imagens na pasta combinada.
    await mkdir(flowDir, { recursive: true });
    for (const n of [1, 2, 3]) await writeFile(join(flowDir, `cena-${n}.png`), `png ${n}`, 'utf8');

    const render = new FakeRender();
    const semVozDeNovo = agenteCom(
      store, workDir, images, { synth: semVoz }, render, new FakeReview(), undefined, undefined, true,
    );
    const { runId: run2 } = await semVozDeNovo.start(pedido(jobId, m));
    await semVozDeNovo.whenDone(run2);

    const status2 = await semVozDeNovo.status(run2);
    assert.equal(status2.state, 'waiting');
    assert.equal(status2.message, 'falta o serviço de voz: rode pnpm night:voz para narrar');
    const resultado2 = await semVozDeNovo.result(run2);
    assert.equal(resultado2.waitingFor, 'voz');
    assert.equal(resultado2.error, null);
    const itens = (await store.manifest(jobId))?.items ?? [];
    assert.equal(itens.filter((item) => item.kind === 'image').length, 3,
      'as imagens importadas ficam no store antes da voz');
    assert.ok(!itens.some((item) => item.kind === 'audio'), 'sem voz não há áudio');
    assert.equal(render.calls.length, 0);

    // O modo voz subiu. Sem a pasta do Flow, só o store pode fornecer as imagens: não reimporta.
    await rm(flowDir, { recursive: true, force: true });
    const synth = new FakeSynth();
    const comVoz = agenteCom(store, workDir, images, synth, new FakeRender(), new FakeReview());
    const { runId: run3 } = await comVoz.start(pedido(jobId, m));
    await comVoz.whenDone(run3);

    const status3 = await comVoz.status(run3);
    assert.equal(status3.state, 'succeeded', status3.message);
    assert.equal(synth.texts.length, 3);
  });

  test('erro comum na narração continua falha, não espera de voz', async () => {
    const jobId = 'video-erro-narracao';
    const images = new FakeImages(imagesDir);
    for (const n of [1, 2, 3]) await images.fornecer(n);
    const quebrada = {
      synth: (async () => { throw new Error('Kokoro caiu no meio'); }) as Synth,
    };
    const agent = agenteCom(store, workDir, images, quebrada, new FakeRender(), new FakeReview());

    const { runId } = await agent.start(pedido(jobId, manifesto(jobId)));
    await agent.whenDone(runId);

    const status = await agent.status(runId);
    assert.equal(status.state, 'failed');
    const resultado = await agent.result(runId);
    assert.equal(resultado.state, 'failed');
    assert.equal(resultado.waitingFor, undefined);
    assert.match(resultado.error ?? '', /Kokoro caiu no meio/);
  });

  test('pendência de fonte para na prévia e bloqueia o render final com o motivo', async () => {
    const jobId = 'video-pendencia';
    const images = new FakeImages(imagesDir);
    for (const n of [1, 2, 3]) await images.fornecer(n);
    const synth = new FakeSynth();
    const render = new FakeRender();
    const review = new FakeReview();
    const agent = agenteCom(store, workDir, images, synth, render, review);

    const { runId } = await agent.start(pedido(jobId, manifesto(jobId, { semFonteNaCena: 2 })));
    await agent.whenDone(runId);

    const status = await agent.status(runId);
    assert.equal(status.state, 'succeeded');
    assert.match(status.message, /prévia pronta; render final bloqueado/);
    assert.match(status.message, /cena 2: afirmação sem fonte/);

    const resultado = await agent.result(runId);
    assert.equal(resultado.state, 'succeeded');
    assert.match(resultado.error ?? '', /cena 2: afirmação sem fonte/);
    assert.deepEqual(render.calls.map((c) => c.preview), [true], 'não deveria renderizar o final');
    const nomes = resultado.artifacts.map((item) => item.name);
    assert.ok(nomes.includes(`${jobId}-preview.mp4`));
    assert.ok(!nomes.includes(`${jobId}.mp4`));
  });

  test('falha na revisão da prévia também bloqueia o final', async () => {
    const jobId = 'video-revisao';
    const images = new FakeImages(imagesDir);
    for (const n of [1, 2, 3]) await images.fornecer(n);
    const synth = new FakeSynth();
    const render = new FakeRender();
    const review = new FakeReview();
    review.falhas = ['áudio fora de sincronia'];
    const agent = agenteCom(store, workDir, images, synth, render, review);

    const { runId } = await agent.start(pedido(jobId, manifesto(jobId)));
    await agent.whenDone(runId);

    const resultado = await agent.result(runId);
    assert.equal(resultado.state, 'succeeded');
    assert.match(resultado.error ?? '', /revisão da prévia: áudio fora de sincronia/);
    assert.equal(render.calls.length, 1);
  });

  test('D07: parecer "parar" bloqueia o render final, grava o parecer e manda fontes como externas', async () => {
    const jobId = 'video-parecer-parar';
    const images = new FakeImages(imagesDir);
    for (const n of [1, 2, 3]) await images.fornecer(n);
    const synth = new FakeSynth();
    const render = new FakeRender();
    const review = new FakeReview();
    const { service, fake } = advisorCom('parar');
    const agent = agenteCom(store, workDir, images, synth, render, review, service);

    const { runId } = await agent.start(pedido(jobId, manifesto(jobId)));
    await agent.whenDone(runId);

    const status = await agent.status(runId);
    assert.equal(status.state, 'succeeded');
    assert.match(status.message, /^prévia pronta; render final bloqueado pelo parecer: /);
    assert.match(status.message, /afirmação principal sem fonte/);
    assert.match(status.message, /cena 2 pode enganar/);

    const resultado = await agent.result(runId);
    assert.equal(resultado.state, 'succeeded');
    const nomes = resultado.artifacts.map((item) => item.name);
    assert.ok(nomes.includes(`${jobId}-preview.mp4`), 'a prévia fica pronta');
    assert.ok(nomes.includes('parecer-antes-do-render.json'), 'o parecer bloqueante é gravado');
    assert.ok(!nomes.includes(`${jobId}.mp4`), 'não renderiza o final');
    assert.deepEqual(render.calls.map((c) => c.preview), [true]);

    // O input enviado ao conselheiro separa fontes (externas) de cenas (internas).
    assert.equal(fake.calls.length, 1);
    const input = fake.calls[0]!;
    assert.equal(input.jobId, jobId);
    assert.equal(input.dominio, 'video');
    assert.equal(input.fase, 'antes-do-render');
    assert.equal(input.objetivo, 'Piloto do agente');
    assert.match(input.pergunta, /afirmação importante está sem fonte/);
    assert.match(input.testes ?? '', /revisão automática da prévia/);

    const fonte = input.evidencias.find((ev) => ev.ref === 'fonte');
    assert.ok(fonte, 'faltou a fonte do manifesto');
    assert.equal(fonte.externa, true);
    assert.match(fonte.conteudo, /Fonte de teste/);
    assert.match(fonte.conteudo, /https:\/\/exemplo\.org\/a/);

    for (const n of [1, 2, 3]) {
      const cena = input.evidencias.find((ev) => ev.ref === `cena-${n}`);
      assert.ok(cena, `faltou cena-${n}`);
      assert.equal(cena.externa, false, 'cena é evidência interna');
      assert.match(cena.conteudo, new RegExp(`Narração da cena ${n}`));
      assert.match(cena.conteudo, /papel da imagem: ilustracao/);
    }
  });

  test('D07: parecer "revisar" também bloqueia o final', async () => {
    const jobId = 'video-parecer-revisar';
    const images = new FakeImages(imagesDir);
    for (const n of [1, 2, 3]) await images.fornecer(n);
    const render = new FakeRender();
    const { service } = advisorCom('revisar');
    const agent = agenteCom(store, workDir, images, new FakeSynth(), render, new FakeReview(), service);

    const { runId } = await agent.start(pedido(jobId, manifesto(jobId)));
    await agent.whenDone(runId);

    const resultado = await agent.result(runId);
    assert.equal(resultado.state, 'succeeded');
    assert.match(resultado.message ?? '', /render final bloqueado pelo parecer/);
    assert.deepEqual(render.calls.map((c) => c.preview), [true]);
    assert.ok(resultado.artifacts.some((item) => item.name === 'parecer-antes-do-render.json'));
  });

  test('D07: parecer "prosseguir" segue as regras atuais e renderiza o final', async () => {
    const jobId = 'video-parecer-prosseguir';
    const images = new FakeImages(imagesDir);
    for (const n of [1, 2, 3]) await images.fornecer(n);
    const render = new FakeRender();
    const { service, journal } = advisorCom('prosseguir');
    const agent = agenteCom(store, workDir, images, new FakeSynth(), render, new FakeReview(), service);

    const { runId } = await agent.start(pedido(jobId, manifesto(jobId)));
    await agent.whenDone(runId);

    const resultado = await agent.result(runId);
    assert.equal(resultado.state, 'succeeded');
    assert.equal(resultado.message, 'concluído');
    assert.deepEqual(render.calls.map((c) => c.preview), [true, false], 'a prévia passou e o final rodou');
    assert.ok(!resultado.artifacts.some((item) => item.name === 'parecer-antes-do-render.json'));
    // O parecer foi consultado e registrado no diário, mesmo sem bloquear.
    assert.equal((await journal.list(jobId)).length, 1);
  });

  test('D07: parecer "perguntar_joel" renderiza o final com aviso para o Joel', async () => {
    const jobId = 'video-parecer-joel';
    const images = new FakeImages(imagesDir);
    for (const n of [1, 2, 3]) await images.fornecer(n);
    const render = new FakeRender();
    const { service } = advisorCom('perguntar_joel');
    const agent = agenteCom(store, workDir, images, new FakeSynth(), render, new FakeReview(), service);

    const { runId } = await agent.start(pedido(jobId, manifesto(jobId)));
    await agent.whenDone(runId);

    const resultado = await agent.result(runId);
    assert.equal(resultado.state, 'succeeded');
    assert.match(resultado.message ?? '', /concluído; parecer antes do render pediu decisão do Joel/);
    assert.deepEqual(render.calls.map((c) => c.preview), [true, false]);
  });

  test('D07: parecer indisponível não bloqueia nem aprova; final roda com aviso', async () => {
    const jobId = 'video-parecer-indisponivel';
    const images = new FakeImages(imagesDir);
    for (const n of [1, 2, 3]) await images.fornecer(n);
    const render = new FakeRender();
    const { service } = advisorCom(null);
    const agent = agenteCom(store, workDir, images, new FakeSynth(), render, new FakeReview(), service);

    const { runId } = await agent.start(pedido(jobId, manifesto(jobId)));
    await agent.whenDone(runId);

    const resultado = await agent.result(runId);
    assert.equal(resultado.state, 'succeeded');
    assert.match(resultado.message ?? '', /render final sem parecer independente/);
    assert.deepEqual(render.calls.map((c) => c.preview), [true, false], 'sem parecer, as regras atuais decidem');
    assert.ok(!resultado.artifacts.some((item) => item.name === 'parecer-antes-do-render.json'));
  });

  test('cancelamento entre etapas: prévia termina, revisão e final não começam', async () => {
    const jobId = 'video-cancelado';
    const images = new FakeImages(imagesDir);
    for (const n of [1, 2, 3]) await images.fornecer(n);
    const synth = new FakeSynth();
    const render = new FakeRender();
    const review = new FakeReview();
    let liberar!: () => void;
    render.gate = new Promise<void>((resolve) => { liberar = resolve; });
    let entrou!: () => void;
    const entrouP = new Promise<void>((resolve) => { entrou = resolve; });
    render.entered = entrou;
    const agent = agenteCom(store, workDir, images, synth, render, review);

    const { runId } = await agent.start(pedido(jobId, manifesto(jobId)));
    await entrouP;
    assert.equal((await agent.status(runId)).state, 'running');

    const cancelado = await agent.cancel(runId);
    assert.equal(cancelado.cancelled, true);
    liberar();
    await agent.whenDone(runId);

    assert.equal((await agent.status(runId)).state, 'cancelled');
    const resultado = await agent.result(runId);
    assert.equal(resultado.state, 'cancelled');
    assert.equal(review.files.length, 0, 'não revisa depois do cancelamento');
    assert.deepEqual(render.calls.map((c) => c.preview), [true], 'o final não começou');
  });

  test('start é idempotente por jobId e não refaz a execução', async () => {
    const jobId = 'video-idempotente';
    const images = new FakeImages(imagesDir);
    for (const n of [1, 2, 3]) await images.fornecer(n);
    const synth = new FakeSynth();
    const render = new FakeRender();
    const review = new FakeReview();
    const agent = agenteCom(store, workDir, images, synth, render, review);

    const primeiro = await agent.start(pedido(jobId, manifesto(jobId)));
    const segundo = await agent.start(pedido(jobId, manifesto(jobId)));
    assert.equal(segundo.runId, primeiro.runId);

    await agent.whenDone(primeiro.runId);
    const terceiro = await agent.start(pedido(jobId, manifesto(jobId)));
    assert.equal(terceiro.runId, primeiro.runId, 'mesmo depois do fim, o runId não muda');

    assert.equal(synth.texts.length, 3);
    assert.equal(render.calls.length, 2);
    assert.equal((await agent.result(primeiro.runId)).state, 'succeeded');
  });

  test('revisão padrão: prévia 540x960 com a duração do plano passa e libera o final', async () => {
    const jobId = 'video-revisao-padrao';
    const images = new FakeImages(imagesDir);
    for (const n of [1, 2, 3]) await images.fornecer(n);
    const synth = new FakeSynth();
    const render = new FakeRender();
    const narrator = new Narrator(synth.synth, store, { workDir });
    // Sem deps.review: usa a revisão padrão. O run falso evita ffprobe/ffmpeg de verdade.
    const agent = new VideoAgent({
      store,
      narrator,
      render: (plan) => render.render(plan),
      run: probeFalso(540, 960, 6),
      images,
      workDir,
    });

    const { runId } = await agent.start(pedido(jobId, manifesto(jobId)));
    await agent.whenDone(runId);

    const status = await agent.status(runId);
    assert.equal(status.state, 'succeeded', status.message);
    assert.equal(status.message, 'concluído');
    assert.deepEqual(render.calls.map((c) => c.preview), [true, false], 'a prévia passou e o final rodou');
  });

  test('trabalho de vídeo: espera o Flow como waiting e a retomada no mesmo processo começa tentativa nova', async () => {
    await resetTestDb(TEST_URL);
    const mem = await PgMemory.open(TEST_URL);
    try {
      const { job } = await mem.createJob({
        kind: 'video', origin: 'texto', idempotencyKey: 'video-flow-runner',
      });
      const m = manifesto(job.id);
      const images = new FakeImages(imagesDir);
      await images.fornecer(1);
      const synth = new FakeSynth();
      const render = new FakeRender();
      const review = new FakeReview();
      const agent = agenteCom(store, workDir, images, synth, render, review);
      const worker = new VideoWorker(agent, m);
      const runner = new JobRunner(mem, worker, store, { pollMs: 5, maxPolls: 60 });

      const waiting = await runner.run(job.id);
      assert.equal(waiting.status, 'waiting');
      assert.equal(waiting.waitingFor, 'flow');
      assert.equal(waiting.error, null, 'espera não é falha');
      assert.equal(synth.texts.length, 0, 'sem todas as imagens o agente para no Flow antes de narrar');
      assert.equal(render.calls.length, 0);
      assert.ok((await mem.listJobEvents(job.id)).some(
        (e) => e.eventType === 'status-changed' && e.toStatus === 'waiting',
      ));

      // O Flow entregou o que faltava; run() de novo no mesmo processo começa outra tentativa.
      await images.fornecer(2);
      await images.fornecer(3);
      synth.texts.length = 0;
      const done = await runner.run(job.id);
      assert.equal(done.status, 'succeeded', done.error ?? 'falhou');
      assert.equal(synth.texts.length, 3, 'com todas as imagens a narração roda');
      assert.deepEqual(render.calls.map((c) => c.preview), [true, false]);
      assert.equal(review.files.length, 1);

      const starts = (await mem.listJobEvents(job.id))
        .filter((e) => (e.effectKey ?? '').startsWith('worker-start:'));
      assert.equal(starts.length, 2, 'cada tentativa tem o seu worker-start');
    } finally {
      await mem.close();
    }
  });

  test('pacote versionado grava e loadPackage recusa arquivo alterado', async () => {
    const jobId = 'video-pacote';
    const images = new FakeImages(imagesDir);
    for (const n of [1, 2, 3]) await images.fornecer(n);
    const synth = new FakeSynth();
    const render = new FakeRender();
    const review = new FakeReview();
    const agent = agenteCom(store, workDir, images, synth, render, review);
    const m = manifesto(jobId);

    const { runId } = await agent.start(pedido(jobId, m));
    await agent.whenDone(runId);

    const pacote = await buildDeliveryPackage(store, jobId, m, 1);
    assert.equal(pacote.version, 1);
    assert.ok(pacote.arquivos.video, 'faltou o vídeo final');
    assert.ok(pacote.arquivos.previa, 'faltou a prévia');
    assert.equal(pacote.arquivos.audios.length, 3);
    assert.equal(pacote.arquivos.legendas.length, 2);
    assert.equal(pacote.arquivos.imagens.length, 3);
    assert.ok(pacote.arquivos.imagens.every((imagem) => /^[a-f0-9]{64}$/.test(imagem.sha256)));
    assert.equal(pacote.roteiro.length, 3);
    assert.equal(pacote.fontes.length, 1);
    assert.equal(pacote.cenas.length, 3);
    assert.ok(pacote.creditos.length > 0);
    assert.deepEqual(pacote.avisosRevisao, ['aviso de teste']);
    assert.equal(pacote.publicacao, 'não publicado — publicar exige pedido explícito do Joel');

    const recuperado = await loadPackage(store, jobId, 1);
    assert.deepEqual(recuperado, pacote);

    // Alterar um asset aprovado invalida o pacote; nada de entregar versão trocada.
    const alvo = pacote.arquivos.imagens[0]!;
    await writeFile(join(store.root, jobId, alvo.arquivo), 'imagem adulterada', 'utf8');
    await assert.rejects(loadPackage(store, jobId, 1), /não confere|alterado/);
  });

  test('replaceScene muda só a cacheKey da cena alterada', () => {
    const m = manifesto('video-troca');
    const chavesAntes = m.cenas.map((cena) => sceneCacheKey(cena, m.brief));

    const troca = replaceScene(m, 2, { narracao: 'Narração nova da cena 2' });
    assert.equal(troca.manifest.cenas[1]!.narracao, 'Narração nova da cena 2');
    assert.equal(troca.manifest.cenas[0], m.cenas[0], 'as outras cenas seguem iguais');
    assert.equal(troca.manifest.cenas[2], m.cenas[2]);
    assert.equal(troca.cacheKeysChanged.length, 1);
    assert.equal(troca.cacheKeysChanged[0], sceneCacheKey(troca.manifest.cenas[1]!, m.brief));
    assert.notEqual(troca.cacheKeysChanged[0], chavesAntes[1]);

    // Mudança que não altera insumo do cache não invalida nada.
    const semMudanca = replaceScene(m, 1, { narracao: m.cenas[0]!.narracao });
    assert.deepEqual(semMudanca.cacheKeysChanged, []);

    assert.throws(() => replaceScene(m, 9, { narracao: 'fora' }), /cena 9 não existe/);
  });

  test('manifesto inválido falha com os erros na frente', async () => {
    const images = new FakeImages(imagesDir);
    const agent = agenteCom(store, workDir, images, new FakeSynth(), new FakeRender(), new FakeReview());

    const { runId } = await agent.start({
      contract: WORKER_CONTRACT,
      jobId: 'video-invalido',
      kind: 'video',
      params: { manifest: { version: 'errado' } },
      limits: {},
    });
    await agent.whenDone(runId);

    const status = await agent.status(runId);
    assert.equal(status.state, 'failed');
    assert.equal(status.message, 'manifesto inválido');
    const resultado = await agent.result(runId);
    assert.equal(resultado.state, 'failed');
    assert.match(resultado.error ?? '', /version: versão inválida/);
  });

  test('V02: pedido com tema gera o roteiro, grava no store e para no Flow com a folha de prompts', async () => {
    const jobId = 'video-tema';
    const flowDir = join(imagesDir, jobId);
    const images = new FlowFolderProvider({ root: imagesDir });
    const synth = new FakeSynth();
    const render = new FakeRender();
    const review = new FakeReview();
    let chamadas = 0;
    const generator: ScriptGenerator = async () => {
      chamadas += 1;
      return JSON.stringify(manifesto(jobId));
    };
    const agent = agenteCom(store, workDir, images, synth, render, review, undefined, generator);

    const { runId } = await agent.start(pedidoTema(jobId, 'Piloto do agente de vídeo'));
    await agent.whenDone(runId);

    const status = await agent.status(runId);
    assert.equal(status.state, 'waiting');
    assert.equal(chamadas, 1, 'o roteiro é gerado uma vez');
    assert.match(status.message, /aguardando_flow: cenas 1, 2, 3/);
    assert.ok(status.message.includes(flowDir), `mensagem sem a pasta: ${status.message}`);

    const resultado = await agent.result(runId);
    assert.equal(resultado.state, 'waiting');
    assert.equal(resultado.waitingFor, 'flow');
    assert.equal(resultado.error, null);
    assert.ok(resultado.artifacts.some((item) => item.name === 'manifesto.json'));
    assert.equal(synth.texts.length, 0, 'a folha do Flow vem antes da narração');
    assert.equal(render.calls.length, 0);

    const folha = await readFile(join(flowDir, 'prompts-flow.txt'), 'utf8');
    assert.match(folha, /^cena-1: imagem única 1$/m);
    assert.match(folha, /^cena-2: imagem única 2$/m);
    assert.match(folha, /^cena-3: imagem única 3$/m);
    assert.match(folha, /continua o vídeo video-tema/);
  });

  test('V02: imagens na pasta do Flow e retomada reaproveitam o manifesto sem chamar o gerador', async () => {
    const jobId = 'video-tema-retoma';
    const flowDir = join(imagesDir, jobId);
    const images = new FlowFolderProvider({ root: imagesDir });
    let geradas = 0;
    const generator: ScriptGenerator = async () => {
      geradas += 1;
      return JSON.stringify(manifesto(jobId));
    };
    const primeiro = agenteCom(
      store, workDir, images, new FakeSynth(), new FakeRender(), new FakeReview(), undefined, generator,
    );
    const { runId } = await primeiro.start(pedidoTema(jobId, 'Piloto do agente de vídeo'));
    await primeiro.whenDone(runId);
    assert.equal((await primeiro.status(runId)).state, 'waiting');
    assert.equal(geradas, 1);

    // O Joel gerou no Flow e salvou com os nomes aceitos (inclusive zero à esquerda).
    await mkdir(flowDir, { recursive: true });
    await writeFile(join(flowDir, 'cena-1.png'), 'png 1', 'utf8');
    await writeFile(join(flowDir, 'cena-02.jpg'), 'jpg 2', 'utf8');
    await writeFile(join(flowDir, 'cena-3.webp'), 'webp 3', 'utf8');
    await writeFile(join(flowDir, 'capa.png'), 'ignorar', 'utf8');

    const render = new FakeRender();
    const review = new FakeReview();
    const retomada = agenteCom(
      store, workDir, images, new FakeSynth(), render, review, undefined,
      async () => {
        geradas += 1;
        throw new Error('não deveria gerar o roteiro de novo');
      },
    );
    const { runId: run2 } = await retomada.start(pedidoTema(jobId, 'Piloto do agente de vídeo'));
    await retomada.whenDone(run2);

    const status2 = await retomada.status(run2);
    assert.equal(status2.state, 'succeeded', status2.message);
    assert.equal(geradas, 1, 'o gerador não é chamado na retomada');
    assert.deepEqual(render.calls.map((c) => c.preview), [true, false]);
    assert.equal(review.files.length, 1);

    const manifestoStore = await store.manifest(jobId);
    const imagens = (manifestoStore?.items ?? []).filter((item) => item.kind === 'image');
    assert.equal(imagens.length, 3);
  });

  test('V02: sem gerador o pedido com tema espera o gerador em vez de falhar', async () => {
    const images = new FakeImages(imagesDir);
    const agent = agenteCom(store, workDir, images, new FakeSynth(), new FakeRender(), new FakeReview());

    const { runId } = await agent.start(pedidoTema('video-sem-gerador', 'Um tema qualquer'));
    await agent.whenDone(runId);

    const status = await agent.status(runId);
    assert.equal(status.state, 'waiting');
    assert.equal(status.message, 'falta o gerador de roteiro (chave do DeepSeek)');
    const resultado = await agent.result(runId);
    assert.equal(resultado.state, 'waiting');
    assert.equal(resultado.waitingFor, 'gerador');
    assert.equal(resultado.error, null);
  });
});
