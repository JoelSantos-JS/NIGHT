import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { ArtifactStore } from '../src/artifacts/store.ts';
import { WORKER_CONTRACT, type WorkerRequest } from '../src/jobs/worker.ts';
import { VideoAgent, type ImageProvider, type ReviewContext } from '../src/video/agent.ts';
import { buildBrief } from '../src/video/brief.ts';
import {
  MANIFEST_VERSION,
  readyForFinalRender,
  sceneCacheKey,
  validateManifest,
  type VideoManifest,
} from '../src/video/manifest.ts';
import { Narrator, type Synth } from '../src/video/narrate.ts';
import { buildRemotionProps, renderWithRemotion } from '../src/video/remotion-render.ts';
import { planRender, type RenderPlan, type RenderResult } from '../src/video/render.ts';
import type { ReviewResult } from '../src/video/review.ts';
import { buildScriptPrompt } from '../src/video/script.ts';
import {
  getVideoTemplate,
  listVideoTemplates,
  resolveTemplateForStyle,
  templateRequiresImages,
} from '../src/video/templates.ts';

function manifestoStickman(jobId = 'video-stickman-1'): VideoManifest {
  const brief = buildBrief({
    tema: 'E se a gravidade sumisse por 10 segundos?',
    publico: 'curiosos',
    plataforma: 'shorts',
    duracaoAlvoSeg: 45,
    estilo: 'stickman-2d',
    objetivo: 'engajar e explicar',
  });
  const res = validateManifest({
    version: MANIFEST_VERSION,
    jobId,
    brief,
    titulo: '10 segundos sem gravidade',
    motorVisual: 'remotion',
    templateVisual: 'stickman-2d',
    styleRecipe: {
      cutsPerMinute: 12,
      hookMaxSec: 3,
      fontMood: 'handwritten',
      palette: { accent: '#2563EB' },
      sourceNote: 'teste',
    },
    fontes: [],
    cenas: [1, 2, 3].map((n) => ({
      n,
      narracao: `Narração da cena ${n}`,
      duracaoEstimadaSeg: 15,
      afirmacoes: [],
      visual: `Stickman em cena ${n}`,
      promptImagem: '',
      papelImagem: 'ilustracao',
      realistaGeradaPorIA: false,
      assetRef: null,
      textoNaTela: `CENA ${n}`,
      acao: `Personagem faz ação ${n}`,
      transicao: n === 1 ? 'cut' : 'fade',
      assets: n === 1 ? ['ball'] : ['clock'],
      pose: n === 1 ? 'floating' : 'pointing',
      expressao: n === 1 ? 'surprised' : 'happy',
      cenario: n === 1 ? 'cosmos-pov' : 'lab',
    })),
  });
  if (!res.ok) throw new Error('manifesto stickman inválido: ' + JSON.stringify(res.errors));
  return res.manifest;
}

describe('registro de templates visuais (src/video/templates.ts)', () => {
  test('lista os 9 templates base e resolve aliases comuns', () => {
    const ids = listVideoTemplates().map((t) => t.id);
    assert.deepEqual(ids, [
      'editorial-flow',
      'motion-graphics',
      'stickman-2d',
      'ad-creative',
      'dark-science-2d',
      'comic-explainer-16x9',
      'cozy-story-16x9',
      'dark-philosophy-16x9',
      'psych-explainer-16x9',
    ]);

    assert.equal(getVideoTemplate('stickman-2d')?.imagens, 'none');
    assert.equal(getVideoTemplate('motion-graphics')?.imagens, 'optional');
    assert.equal(getVideoTemplate('ad-creative')?.imagens, 'optional');
    assert.equal(getVideoTemplate('dark-science-2d')?.imagens, 'optional');
    assert.equal(getVideoTemplate('comic-explainer-16x9')?.imagens, 'optional');
    assert.equal(getVideoTemplate('cozy-story-16x9')?.imagens, 'optional');
    assert.equal(getVideoTemplate('dark-philosophy-16x9')?.imagens, 'optional');
    assert.equal(getVideoTemplate('psych-explainer-16x9')?.imagens, 'optional');
    assert.equal(getVideoTemplate('editorial-flow')?.imagens, 'required');
    assert.equal(getVideoTemplate('desconhecido'), null);

    assert.equal(resolveTemplateForStyle('estilo stickman divertido')?.id, 'stickman-2d');
    assert.equal(resolveTemplateForStyle('anúncio low-ticket')?.id, 'ad-creative');
    assert.equal(resolveTemplateForStyle('motion graphics')?.id, 'motion-graphics');
    assert.equal(resolveTemplateForStyle('editorial flow')?.id, 'editorial-flow');
    assert.equal(resolveTemplateForStyle('vídeo científico ilustrado')?.id, 'dark-science-2d');
    assert.equal(resolveTemplateForStyle('explicador comic')?.id, 'comic-explainer-16x9');
    assert.equal(resolveTemplateForStyle('história em quadrinhos')?.id, 'comic-explainer-16x9');
    assert.equal(resolveTemplateForStyle('narrativa quente')?.id, 'cozy-story-16x9');
    assert.equal(resolveTemplateForStyle('vídeo sobre finanças')?.id, 'cozy-story-16x9');
    assert.equal(resolveTemplateForStyle('cozy-story-16x9')?.id, 'cozy-story-16x9');
    assert.equal(resolveTemplateForStyle('filosofia dark')?.id, 'dark-philosophy-16x9');
    assert.equal(resolveTemplateForStyle('estoicismo clássico')?.id, 'dark-philosophy-16x9');
    assert.equal(resolveTemplateForStyle('estilo bygone')?.id, 'dark-philosophy-16x9');
    assert.equal(resolveTemplateForStyle('psicologia aplicada')?.id, 'psych-explainer-16x9');
    assert.equal(resolveTemplateForStyle('neurociência')?.id, 'psych-explainer-16x9');
    assert.equal(resolveTemplateForStyle('estilo deep primate')?.id, 'psych-explainer-16x9');
  });

  test('templateRequiresImages mantém comportamento legado para template ausente/desconhecido', () => {
    assert.equal(templateRequiresImages(undefined), true);
    assert.equal(templateRequiresImages(null), true);
    assert.equal(templateRequiresImages('editorial-flow'), true);
    assert.equal(templateRequiresImages('stickman-2d'), false);
    assert.equal(templateRequiresImages('motion-graphics'), false);
    assert.equal(templateRequiresImages('ad-creative'), false);
    assert.equal(templateRequiresImages('dark-science-2d'), false);
    assert.equal(templateRequiresImages('comic-explainer-16x9'), false);
    assert.equal(templateRequiresImages('cozy-story-16x9'), false);
    assert.equal(templateRequiresImages('dark-philosophy-16x9'), false);
    assert.equal(templateRequiresImages('psych-explainer-16x9'), false);
  });
});

describe('manifesto e roteiro estendidos para estúdio visual', () => {
  test('manifesto stickman-2d valida campos visuais opcionais e libera render final sem imagens', () => {
    const manifest = manifestoStickman();
    assert.equal(manifest.motorVisual, 'remotion');
    assert.equal(manifest.templateVisual, 'stickman-2d');
    assert.equal(manifest.cenas[0]?.pose, 'floating');
    assert.equal(manifest.cenas[0]?.transicao, 'cut');

    const prontidao = readyForFinalRender(manifest);
    assert.deepEqual(prontidao, { pronto: true, pendencias: [] });
  });

  test('validateManifest rejeita templateVisual ou transicao inválidos', () => {
    const bruto = JSON.parse(JSON.stringify(manifestoStickman())) as Record<string, unknown>;
    bruto.templateVisual = 'template-que-nao-existe';
    const cenas = bruto.cenas as Array<Record<string, unknown>>;
    cenas[0]!.transicao = 'estrela';

    const res = validateManifest(bruto);
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.ok(res.errors.some((e) => e.campo === 'templateVisual'));
    assert.ok(res.errors.some((e) => e.campo === 'cenas[0].transicao'));
  });

  test('sceneCacheKey invalida só a cena quando direção visual muda', () => {
    const m = manifestoStickman();
    const k1 = sceneCacheKey(m.cenas[0]!, m.brief);
    const k2 = sceneCacheKey({ ...m.cenas[0]!, pose: 'celebrating' }, m.brief);
    assert.notEqual(k1, k2);
  });

  test('buildScriptPrompt inclui orientações do template quando brief.estilo combina', () => {
    const brief = buildBrief({
      tema: 'Como organizar finanças',
      plataforma: 'shorts',
      estilo: 'stickman',
      duracaoAlvoSeg: 45,
    });
    const msgs = buildScriptPrompt({ jobId: 'vid-1', brief });
    assert.match(msgs[0]!.content, /templateVisual": "stickman-2d"/);
    assert.match(msgs[0]!.content, /pose/);
    assert.match(msgs[0]!.content, /textoNaTela/);
    assert.match(msgs[1]!.content, /template visual: stickman-2d/);
  });
});

describe('ponte Remotion e execução do VideoAgent sem Flow', () => {
  let root = '';
  let workDir = '';
  let outDir = '';
  let store: ArtifactStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'night-studio-store-'));
    workDir = await mkdtemp(join(tmpdir(), 'night-studio-work-'));
    outDir = await mkdtemp(join(tmpdir(), 'night-studio-out-'));
    store = new ArtifactStore(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(workDir, { recursive: true, force: true });
    await rm(outDir, { recursive: true, force: true });
  });

  test('buildRemotionProps mapeia manifesto, palette e CTA do ad-creative', () => {
    const manifest = manifestoStickman();
    const plan = planRender(
      manifest,
      {
        imagePathFor: () => '',
        audioFor: (n) => ({ path: `/tmp/audio-${n}.wav`, durationSec: 3.5 }),
      },
      { outDir, preview: true, allowMissingImages: true },
    );

    const props = buildRemotionProps(plan, manifest);
    assert.equal(props.templateId, 'stickman-2d');
    assert.equal(props.width, 540);
    assert.equal(props.height, 960);
    assert.equal(props.preview, true);
    assert.equal(props.theme.accent, '#2563EB'); // veio do styleRecipe.palette
    assert.equal(props.theme.background, '#F8FAFC'); // veio do tema padrão
    assert.equal(props.scenes.length, 3);
    assert.equal(props.scenes[0]?.imageUrl, null);
    assert.equal(props.scenes[0]?.audioUrl, '/tmp/audio-1.wav');
    assert.equal(props.scenes[0]?.pose, 'floating');
    assert.equal(props.scenes[0]?.cenario, 'cosmos-pov');
  });

  test('renderWithRemotion grava SRT e props JSON e chama CLI injetado', async () => {
    const manifest = manifestoStickman();
    const plan = planRender(
      manifest,
      { imagePathFor: () => '', audioFor: () => null },
      { outDir, preview: true, allowMissingImages: true },
    );

    let calledBin = '';
    let calledArgs: string[] = [];
    const res = await renderWithRemotion(plan, manifest, {
      studioDir: 'D:\\fake\\studio',
      nodeBin: 'node',
      run: async (bin, args) => {
        calledBin = bin;
        calledArgs = args;
        return { code: 0, stderr: '' };
      },
    });

    assert.equal(calledBin, 'node');
    assert.equal(calledArgs[0], join('D:\\fake\\studio', 'render-cli.mjs'));
    const propsPath = calledArgs[calledArgs.indexOf('--props') + 1]!;
    const propsJson = JSON.parse(await readFile(propsPath, 'utf8')) as { templateId: string; scenes: unknown[] };
    assert.equal(propsJson.templateId, 'stickman-2d');
    assert.equal(propsJson.scenes.length, 3);
    assert.equal(res.outPath, plan.outPath);
  });

  test('VideoAgent com stickman-2d não trava no Flow e aciona remotionRender', async () => {
    const jobId = 'video-remotion-1';
    const manifest = manifestoStickman(jobId);

    const synth: Synth = async (text, _lang, file) => {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, `RIFF-fake;${text}`, 'utf8');
      return { audioSeconds: 2.5 };
    };
    const narrator = new Narrator(synth, store, { workDir });

    const images: ImageProvider = {
      origin: 'flow',
      find: async () => null, // Nenhuma imagem do Flow!
    };

    const ffmpegCalls: RenderPlan[] = [];
    const remotionCalls: { preview: boolean; templateId?: string }[] = [];

    const agent = new VideoAgent({
      store,
      narrator,
      images,
      workDir,
      render: async (plan) => {
        ffmpegCalls.push(plan);
        return { outPath: plan.outPath, durationSec: 7.5, args: [] };
      },
      remotionRender: async (plan, m): Promise<RenderResult> => {
        remotionCalls.push({ preview: plan.preview, templateId: m.templateVisual });
        await mkdir(dirname(plan.outPath), { recursive: true });
        await writeFile(plan.outPath, 'fake-mp4', 'utf8');
        await writeFile(plan.subtitlesPath, '1\n00:00:00,000 --> 00:00:02,500\noi\n', 'utf8');
        return { outPath: plan.outPath, durationSec: 7.5, args: [] };
      },
      review: async (_file: string, _m: VideoManifest, _opts: ReviewContext): Promise<ReviewResult> => ({
        ok: true,
        falhas: [],
        avisos: [],
      }),
    });

    const req: WorkerRequest = {
      contract: WORKER_CONTRACT,
      jobId,
      kind: 'video',
      params: { manifest },
      limits: {},
    };
    const { runId } = await agent.start(req);
    await agent.whenDone(runId);

    const status = await agent.status(runId);
    assert.equal(status.state, 'succeeded');
    assert.equal(ffmpegCalls.length, 0, 'não deve chamar o render FFmpeg legado');
    assert.deepEqual(remotionCalls, [
      { preview: true, templateId: 'stickman-2d' },
      { preview: false, templateId: 'stickman-2d' },
    ]);
  });

  test('templates 16:9 geram planos 960x540/1920x1080 e roteiro guiado', () => {
    const scenariosByTemplate: Record<
      'comic-explainer-16x9' | 'cozy-story-16x9' | 'dark-philosophy-16x9' | 'psych-explainer-16x9',
      [string, string]
    > = {
      'comic-explainer-16x9': ['nested-zoom', 'tree-roots'],
      'cozy-story-16x9': ['office', 'research'],
      'dark-philosophy-16x9': ['engraving', 'chiaroscuro'],
      'psych-explainer-16x9': ['panic-desk', 'brain-diagram'],
    };

    for (const templateId of [
      'comic-explainer-16x9',
      'cozy-story-16x9',
      'dark-philosophy-16x9',
      'psych-explainer-16x9',
    ] as const) {
      const brief = buildBrief({
        tema: `História em formato ${templateId}`,
        publico: 'curiosos no YouTube',
        plataforma: 'youtube',
        duracaoAlvoSeg: 30,
        estilo: templateId,
        objetivo: 'reter audiência',
      });
      assert.equal(brief.formato, 'horizontal');

      const promptMsgs = buildScriptPrompt({ jobId: `vid-${templateId}`, brief });
      assert.match(promptMsgs[0]!.content, new RegExp(`templateVisual": "${templateId}"`));
      assert.match(promptMsgs[1]!.content, new RegExp(`template visual: ${templateId}`));

      const res = validateManifest({
        version: MANIFEST_VERSION,
        jobId: `vid-${templateId}`,
        brief,
        titulo: `Teste ${templateId}`,
        motorVisual: 'remotion',
        templateVisual: templateId,
        fontes: [],
        cenas: [1, 2].map((n) => ({
          n,
          narracao: n === 1 ? 'Antes de *crescer* sem alarde' : 'Todo mundo tem raiz nesse plano',
          duracaoEstimadaSeg: 15,
          afirmacoes: [],
          visual: `Cena 16:9 número ${n}`,
          promptImagem: '',
          papelImagem: 'ilustracao',
          realistaGeradaPorIA: false,
          assetRef: null,
          transicao: n === 1 ? 'zoom' : 'cut',
          cenario: scenariosByTemplate[templateId][n - 1],
        })),
      });
      if (!res.ok) throw new Error(`manifesto inválido para ${templateId}: ${JSON.stringify(res.errors)}`);

      assert.deepEqual(readyForFinalRender(res.manifest), { pronto: true, pendencias: [] });

      const previewPlan = planRender(
        res.manifest,
        { imagePathFor: () => '', audioFor: () => ({ path: `/tmp/${templateId}.wav`, durationSec: 3 }) },
        { outDir, preview: true, allowMissingImages: true },
      );
      assert.equal(previewPlan.width, 960);
      assert.equal(previewPlan.height, 540);

      const finalPlan = planRender(
        res.manifest,
        { imagePathFor: () => '', audioFor: () => ({ path: `/tmp/${templateId}.wav`, durationSec: 3 }) },
        { outDir, preview: false, allowMissingImages: true },
      );
      assert.equal(finalPlan.width, 1920);
      assert.equal(finalPlan.height, 1080);

      const props = buildRemotionProps(finalPlan, res.manifest);
      assert.equal(props.templateId, templateId);
      assert.equal(props.width, 1920);
      assert.equal(props.height, 1080);
      assert.equal(props.scenes.length, 2);
    }
  });

  test('ad-creative (overlay-proprio vs inspiracao): exige videoBase autorizado e mapeia trim/mute', () => {
    const brief = buildBrief({
      tema: 'Criativo com vídeo-base próprio',
      publico: 'gestores',
      plataforma: 'reels',
      duracaoAlvoSeg: 30,
      estilo: 'ad-creative',
      objetivo: 'testar ganchos mantendo vídeo próprio',
    });

    const baseManifest = {
      version: MANIFEST_VERSION,
      jobId: 'ad-overlay-1',
      brief,
      titulo: 'Oferta com overlay próprio',
      motorVisual: 'remotion',
      templateVisual: 'ad-creative',
      fontes: [],
      cenas: [
        {
          n: 1,
          narracao: 'Gancho rápido em cima do vídeo próprio.',
          duracaoEstimadaSeg: 15,
          afirmacoes: [],
          visual: 'Sobreposição de gancho',
          promptImagem: '',
          papelImagem: 'ilustracao',
          realistaGeradaPorIA: false,
          assetRef: null,
          textoNaTela: 'PARE DE PERDER TEMPO',
          assets: ['MODELO PRONTO', 'ACESSO IMEDIATO'],
        },
        {
          n: 2,
          narracao: 'Veja os detalhes e clique abaixo.',
          duracaoEstimadaSeg: 15,
          afirmacoes: [],
          visual: 'Sobreposição de CTA',
          promptImagem: '',
          papelImagem: 'ilustracao',
          realistaGeradaPorIA: false,
          assetRef: null,
          textoNaTela: 'CONHEÇA O GUIA',
          videoStartSec: 8,
        },
      ],
    };

    // Sem videoBase, modo overlay-proprio é recusado.
    const semBase = validateManifest({ ...baseManifest, modoCampanha: 'overlay-proprio' });
    assert.equal(semBase.ok, false);
    if (!semBase.ok) {
      assert.ok(semBase.errors.some((e) => e.campo === 'videoBase'));
    }

    // Com videoBase mas sem videoBaseAutorizado: true, emite aviso e trava entrega final.
    const naoAutorizado = validateManifest({
      ...baseManifest,
      modoCampanha: 'overlay-proprio',
      videoBase: 'D:\\videos\\produto-base.mp4',
    });
    assert.equal(naoAutorizado.ok, true);
    if (naoAutorizado.ok) {
      assert.ok(naoAutorizado.avisos.some((a) => a.includes('videoBaseAutorizado')));
      const finalCheck = readyForFinalRender(naoAutorizado.manifest);
      assert.equal(finalCheck.pronto, false);
      assert.ok(finalCheck.pendencias.some((p) => p.includes('videoBaseAutorizado')));
    }

    // Autorizado: libera entrega final e repassa baseVideoUrl / mute / offsets cumulativos e override.
    const autorizado = validateManifest({
      ...baseManifest,
      modoCampanha: 'overlay-proprio',
      videoBase: 'D:\\videos\\produto-base.mp4',
      videoBaseAutorizado: true,
      mutarVideoBase: true,
    });
    assert.equal(autorizado.ok, true);
    if (!autorizado.ok) return;
    assert.deepEqual(readyForFinalRender(autorizado.manifest), { pronto: true, pendencias: [] });

    const plan = planRender(
      autorizado.manifest,
      {
        imagePathFor: () => '',
        audioFor: (n) => ({ path: `/tmp/ad-${n}.wav`, durationSec: n === 1 ? 3.2 : 2.8 }),
      },
      { outDir, preview: true, allowMissingImages: true },
    );

    const props = buildRemotionProps(plan, autorizado.manifest);
    assert.equal(props.baseVideoUrl, 'D:\\videos\\produto-base.mp4');
    assert.equal(props.muteBaseVideo, true);
    assert.equal(props.scenes[0]?.videoUrl, 'D:\\videos\\produto-base.mp4');
    assert.equal(props.scenes[0]?.videoStartSec, 0);
    assert.equal(props.scenes[1]?.videoUrl, 'D:\\videos\\produto-base.mp4');
    assert.equal(props.scenes[1]?.videoStartSec, 8);
    assert.equal(props.scenes[1]?.cta, true);

    // Sem override na cena 2, usa offset acumulado da cena 1 (3.2s).
    const semOverride = validateManifest({
      ...baseManifest,
      modoCampanha: 'overlay-proprio',
      videoBase: 'D:\\videos\\produto-base.mp4',
      videoBaseAutorizado: true,
      cenas: [baseManifest.cenas[0]!, { ...baseManifest.cenas[1]!, videoStartSec: undefined }],
    });
    assert.equal(semOverride.ok, true);
    if (semOverride.ok) {
      const propsAcum = buildRemotionProps(plan, semOverride.manifest);
      assert.equal(propsAcum.scenes[1]?.videoStartSec, 3.2);
    }

    // sceneCacheKey reage a alterações de videoBase e videoStartSec.
    const k1 = sceneCacheKey(autorizado.manifest.cenas[0]!, autorizado.manifest.brief);
    const k2 = sceneCacheKey({ ...autorizado.manifest.cenas[0]!, videoBase: 'D:\\videos\\outro.mp4' }, autorizado.manifest.brief);
    const k3 = sceneCacheKey({ ...autorizado.manifest.cenas[0]!, videoStartSec: 4 }, autorizado.manifest.brief);
    assert.notEqual(k1, k2);
    assert.notEqual(k1, k3);
  });
});
