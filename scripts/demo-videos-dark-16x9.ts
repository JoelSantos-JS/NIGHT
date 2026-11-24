// Demonstração completa em 16:9 (1920x1080) para os dois novos templates de YouTube Dark:
// 1. psych-explainer-16x9  -> D:\NIGHT-data\video-demos\psych-memoria-16x9\psych-memoria-16x9-final.mp4
// 2. dark-philosophy-16x9  -> D:\NIGHT-data\video-demos\filosofia-clareza-16x9\filosofia-clareza-16x9-final.mp4
//
// Ambos usam a voz Brian da ElevenLabs (voiceId: nPczCjzI2devNBz1zQrb, eleven_multilingual_v2).
// Uso:
//   node --import tsx scripts/demo-videos-dark-16x9.ts
//   node --import tsx scripts/demo-videos-dark-16x9.ts --only=psych --images=auto --quality=medium
//   node --import tsx scripts/demo-videos-dark-16x9.ts --write-flow-prompts

import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ArtifactStore } from '../src/artifacts/store.ts';
import { WORKER_CONTRACT } from '../src/jobs/worker.ts';
import { VideoAgent } from '../src/video/agent.ts';
import { buildBrief } from '../src/video/brief.ts';
import {
  DEFAULT_ELEVENLABS_MODEL,
  ElevenLabsCredentials,
  createElevenLabsSynth,
  type ElevenLabsVoiceSettings,
} from '../src/video/elevenlabs.ts';
import { createImageProvider, type ImageProviderMode } from '../src/video/image-providers.ts';
import { MANIFEST_VERSION, validateManifest, type Scene, type VideoManifest } from '../src/video/manifest.ts';
import { Narrator } from '../src/video/narrate.ts';
import type { OpenAiImageQuality } from '../src/video/openai-image.ts';
import { buildDeliveryPackage } from '../src/video/package.ts';

/** Brian - Deep, Resonant and Comforting (estilo narrador psicologia/dark explainer). */
const BRIAN_VOICE_ID = 'nPczCjzI2devNBz1zQrb';
const DEMOS_BASE_DIR = 'D:/NIGHT-data/video-demos';

interface DarkDemoSpec {
  key: 'psych' | 'philosophy';
  jobId: string;
  finalFilename: string;
  tema: string;
  publico: string;
  objetivo: string;
  titulo: string;
  templateId: 'psych-explainer-16x9' | 'dark-philosophy-16x9';
  duracaoAlvoSeg: number;
  voiceSettings: Partial<ElevenLabsVoiceSettings>;
  cenas: Array<
    Pick<Scene, 'n' | 'narracao' | 'duracaoEstimadaSeg' | 'visual' | 'cenario' | 'transicao'> & {
      textoNaTela?: string;
      assets?: string[];
      pose?: string;
      expressao?: string;
    }
  >;
}

const DEMO_SPECS: readonly DarkDemoSpec[] = [
  {
    key: 'psych',
    jobId: 'psych-memoria-16x9',
    finalFilename: 'psych-memoria-16x9-final.mp4',
    tema: 'Por que você esquece tudo o que estuda (e como dobrar sua memória)',
    publico: 'estudantes e autodidatas no YouTube',
    objetivo: 'ensinar recordação ativa e técnica Feynman em ritmo ágil',
    titulo: 'Por que você esquece tudo o que estuda',
    templateId: 'psych-explainer-16x9',
    duracaoAlvoSeg: 52,
    voiceSettings: {
      stability: 0.45,
      similarity_boost: 0.8,
      style: 0.3,
      use_speaker_boost: true,
      speed: 1.06,
    },
    cenas: [
      {
        n: 1,
        narracao:
          'Você já passou horas estudando um assunto e deu branco total na hora que alguém te fez uma pergunta?',
        duracaoEstimadaSeg: 6.5,
        visual: 'Aluno sobrecarregado na mesa com laptop, caneca e cartaz na parede',
        cenario: 'panic-desk',
        textoNaTela: 'ILUSÃO DA LEITURA',
        transicao: 'cut',
        pose: 'panicking',
        expressao: 'surprised',
      },
      {
        n: 2,
        narracao:
          'O problema não é falta de inteligência. É que reler e grifar cria uma ilusão de domínio no cérebro.',
        duracaoEstimadaSeg: 6.5,
        visual: 'Livro didático coberto de marca-texto neon sobre a mesa e quadro no fundo',
        cenario: 'highlighter-book',
        textoNaTela: 'RELER ≠ APRENDER',
        transicao: 'cut',
      },
      {
        n: 3,
        narracao:
          'Quando você só relê, seu cérebro reconhece a frase e acha que já sabe, mas não construiu o caminho de resgate.',
        duracaoEstimadaSeg: 6.5,
        visual: 'Diagrama cerebral colorido com balão de fala explicando familiaridade',
        cenario: 'brain-diagram',
        textoNaTela: 'FAMILIARIDADE ≠ MEMÓRIA',
        transicao: 'cut',
        pose: 'pointing',
        expressao: 'happy',
      },
      {
        n: 4,
        narracao:
          'É aí que entra a recordação ativa: fechar o caderno e forçar a mente a puxar a resposta do zero.',
        duracaoEstimadaSeg: 6.5,
        visual: 'Cartão comparativo Passivo Reler vs Ativo Lembrar',
        cenario: 'flashcard',
        textoNaTela: 'RECORDAÇÃO ATIVA',
        assets: ['compare', 'PASSIVO: RELER', 'ATIVO: LEMBRAR'],
        transicao: 'cut',
      },
      {
        n: 5,
        narracao:
          'Cada vez que você faz esse esforço de lembrar, você engrossa a conexão neural, como abrir uma trilha no mato.',
        duracaoEstimadaSeg: 6.5,
        visual: 'Metáfora de trilha estreita virando estrada larga entre sinapses',
        cenario: 'neural-trail',
        textoNaTela: 'TRILHA NEURAL',
        transicao: 'cut',
      },
      {
        n: 6,
        narracao:
          'Quer acelerar ainda mais? Tente explicar o tema em voz alta como se estivesse ensinando uma criança de dez anos.',
        duracaoEstimadaSeg: 6.5,
        visual: 'Personagem explicando fluxo simples para um pequeno robô ouvinte',
        cenario: 'feynman-teach',
        textoNaTela: 'TÉCNICA FEYNMAN',
        transicao: 'cut',
      },
      {
        n: 7,
        narracao:
          'Onde você travar na explicação é exatamente o ponto onde sua memória ainda está fraca.',
        duracaoEstimadaSeg: 6.5,
        visual: 'Interrogações vermelhas se transformando em lâmpadas amarelas acima da mesa',
        cenario: 'gap-lightbulbs',
        textoNaTela: 'ENCONTRE AS LACUNAS',
        transicao: 'cut',
      },
      {
        n: 8,
        narracao:
          'Menos tempo passando marca-texto, mais tempo testando o cérebro. Em uma semana, você aprende o dobro na metade do tempo.',
        duracaoEstimadaSeg: 6.5,
        visual: 'Quadro resumo prático com três passos confirmados em verde',
        cenario: 'flashcard',
        textoNaTela: 'RESUMO PRÁTICO',
        assets: ['1. FECHE', '2. PUXE', '3. EXPLIQUE'],
        transicao: 'cut',
      },
    ],
  },
  {
    key: 'philosophy',
    jobId: 'filosofia-clareza-16x9',
    finalFilename: 'filosofia-clareza-16x9-final.mp4',
    tema: 'A Arte de Falar com Clareza (Por que poucos convencem)',
    publico: 'pessoas em busca de articulação, calma e presença intelectual',
    objetivo: 'transmitir filosofia clássica da clareza em estética 2.39:1 silenciosa',
    titulo: 'A Arte de Falar com Clareza',
    templateId: 'dark-philosophy-16x9',
    duracaoAlvoSeg: 56,
    voiceSettings: {
      stability: 0.5,
      similarity_boost: 0.8,
      style: 0.25,
      use_speaker_boost: true,
      speed: 0.99,
    },
    cenas: [
      {
        n: 1,
        narracao:
          'Os limites da sua linguagem são os limites do seu mundo. Mas falar bem nunca foi sobre usar palavras difíceis.',
        duracaoEstimadaSeg: 7,
        visual: 'Cena barroca chiaroscuro com vela acesa e manuscrito antigo',
        cenario: 'chiaroscuro',
        textoNaTela: 'I. OS LIMITES DA LINGUAGEM',
        transicao: 'fade',
      },
      {
        n: 2,
        narracao:
          'Quando a mente está confusa, a boca corre para preencher o vazio. O excesso de palavras quase sempre esconde a falta de clareza.',
        duracaoEstimadaSeg: 7,
        visual: 'Gravura clássica em cobre com medalhão laureado sobre pergaminho',
        cenario: 'engraving',
        transicao: 'fade',
      },
      {
        n: 3,
        narracao:
          'Os antigos retóricos sabiam de um segredo simples: você não articula na hora em que fala, você articula na hora em que pensa.',
        duracaoEstimadaSeg: 7,
        visual: 'Biblioteca clássica silenciosa banhada por feixes dourados pela janela em arco',
        cenario: 'library-hall',
        transicao: 'fade',
      },
      {
        n: 4,
        narracao:
          'Escrever com calma destila o ruído. Uma ideia que cabe em uma frase limpa vale mais do que dez minutos de discurso apressado.',
        duracaoEstimadaSeg: 7,
        visual: 'Plano fechado de pergaminho, tinteiro de bronze, pena branca e lacre vermelho',
        cenario: 'quill-manuscript',
        transicao: 'fade',
      },
      {
        n: 5,
        narracao:
          'Repare nas pessoas mais respeitadas em qualquer sala: elas nunca têm pressa para responder.',
        duracaoEstimadaSeg: 7,
        visual: 'Gravura sépia de ampulheta antiga sobre volumes encadernados',
        cenario: 'hourglass-engraving',
        textoNaTela: 'II. O PODER DA PAUSA',
        transicao: 'fade',
      },
      {
        n: 6,
        narracao:
          'Dois segundos de silêncio antes de abrir a boca transformam ansiedade em autoridade. A pausa faz o outro inclinar o ouvido.',
        duracaoEstimadaSeg: 7,
        visual: 'Pórtico neoclássico ao entardecer com colinas suaves ao fundo',
        cenario: 'classical-hall',
        transicao: 'fade',
      },
      {
        n: 7,
        narracao:
          'Corte os rodeios, escolha o verbo exato e termine a frase com firmeza. Quem domina a própria voz não precisa levantar o tom.',
        duracaoEstimadaSeg: 7,
        visual: 'Anfiteatro de pedra clássico iluminado por um único feixe zenital',
        cenario: 'amphitheater',
        transicao: 'fade',
      },
      {
        n: 8,
        narracao:
          'Refine o pensamento em silêncio, e cada palavra sua passará a carregar o peso de uma ideia inteira.',
        duracaoEstimadaSeg: 7,
        visual: 'Natureza-morta em luz dourada matinal com livro antigo aberto sobre mesa de carvalho',
        cenario: 'still-life-book',
        transicao: 'fade',
      },
    ],
  },
];

function buildSpecManifest(spec: DarkDemoSpec): VideoManifest {
  const brief = buildBrief({
    tema: spec.tema,
    publico: spec.publico,
    idioma: 'pt-BR',
    plataforma: 'youtube',
    duracaoAlvoSeg: spec.duracaoAlvoSeg,
    estilo: spec.templateId,
    objetivo: spec.objetivo,
  });

  const valid = validateManifest({
    version: MANIFEST_VERSION,
    jobId: spec.jobId,
    brief,
    titulo: spec.titulo,
    motorVisual: 'remotion',
    templateVisual: spec.templateId,
    fontes: [],
    cenas: spec.cenas.map((c) => ({
      n: c.n,
      narracao: c.narracao,
      duracaoEstimadaSeg: c.duracaoEstimadaSeg,
      afirmacoes: [],
      visual: c.visual,
      promptImagem: '',
      papelImagem: 'ilustracao',
      realistaGeradaPorIA: false,
      assetRef: null,
      cenario: c.cenario,
      transicao: c.transicao,
      ...(c.textoNaTela !== undefined ? { textoNaTela: c.textoNaTela } : {}),
      ...(c.assets !== undefined ? { assets: c.assets } : {}),
      ...(c.pose !== undefined ? { pose: c.pose } : {}),
      ...(c.expressao !== undefined ? { expressao: c.expressao } : {}),
    })),
  });

  if (!valid.ok) {
    throw new Error(`Manifesto inválido (${spec.jobId}): ${JSON.stringify(valid.errors, null, 2)}`);
  }
  return valid.manifest;
}

interface CliOptions {
  only?: string;
  imageMode: ImageProviderMode;
  quality: OpenAiImageQuality;
  writeFlowPrompts: boolean;
}

const VALID_MODES = new Set<ImageProviderMode>(['auto', 'flow', 'gpt', 'procedural']);
const VALID_QUALITIES = new Set<OpenAiImageQuality>(['low', 'medium', 'high', 'auto']);

function parseCliOptions(argv: string[]): CliOptions {
  const only = argv.find((a) => a.startsWith('--only='))?.slice('--only='.length);
  const rawMode = argv.find((a) => a.startsWith('--images='))?.slice('--images='.length) ?? 'auto';
  const rawQuality = argv.find((a) => a.startsWith('--quality='))?.slice('--quality='.length) ?? 'medium';
  const writeFlowPrompts = argv.includes('--write-flow-prompts');

  if (!VALID_MODES.has(rawMode as ImageProviderMode)) {
    throw new Error(`--images inválido ("${rawMode}"). Use auto, flow, gpt ou procedural.`);
  }
  if (!VALID_QUALITIES.has(rawQuality as OpenAiImageQuality)) {
    throw new Error(`--quality inválido ("${rawQuality}"). Use low, medium, high ou auto.`);
  }

  return {
    only,
    imageMode: rawMode as ImageProviderMode,
    quality: rawQuality as OpenAiImageQuality,
    writeFlowPrompts,
  };
}

async function writeFlowPromptSheetForDemo(spec: DarkDemoSpec, opts: CliOptions): Promise<string | null> {
  const demoRoot = join(DEMOS_BASE_DIR, spec.jobId);
  const scenesDir = join(demoRoot, 'scenes');
  await mkdir(scenesDir, { recursive: true });
  const manifest = buildSpecManifest(spec);
  const images = createImageProvider({
    mode: opts.imageMode,
    flowRoot: demoRoot,
    numeroDoVideo: 'scenes',
    cacheDir: join(demoRoot, 'gpt-cache'),
    gptQuality: opts.quality,
  });
  return (await images.writePromptSheet?.(spec.jobId, manifest)) ?? null;
}

async function runOneDemo(
  spec: DarkDemoSpec,
  elevenCreds: ElevenLabsCredentials,
  opts: CliOptions,
): Promise<void> {
  const demoRoot = join(DEMOS_BASE_DIR, spec.jobId);
  const storeRoot = join(demoRoot, 'store');
  const workDir = join(demoRoot, 'work');
  const scenesDir = join(demoRoot, 'scenes');
  const finalOut = join(demoRoot, spec.finalFilename);

  await mkdir(scenesDir, { recursive: true });
  const manifest = buildSpecManifest(spec);
  const store = new ArtifactStore(storeRoot);

  console.log(`\n=== [${spec.jobId}] (${spec.templateId}, imagens=${opts.imageMode}) ===`);
  console.log(`1/4 Sintetizando narração com ElevenLabs voz Brian (${DEFAULT_ELEVENLABS_MODEL})...`);
  const synth = createElevenLabsSynth({
    credentials: elevenCreds,
    voiceId: BRIAN_VOICE_ID,
    modelId: DEFAULT_ELEVENLABS_MODEL,
    voiceSettings: spec.voiceSettings,
  });
  const narrator = new Narrator(synth, store, { workDir });
  const narracao = await narrator.narrateAll(spec.jobId, manifest);
  console.log(`    Áudio pronto (${narracao.totalSec.toFixed(1)}s em ${narracao.scenes.length} cenas).`);

  console.log('2/4 Renderizando prévia + QA visual + vídeo final 1920x1080 no Remotion...');
  const images = createImageProvider({
    mode: opts.imageMode,
    flowRoot: demoRoot,
    numeroDoVideo: 'scenes',
    cacheDir: join(demoRoot, 'gpt-cache'),
    gptQuality: opts.quality,
  });
  await images.writePromptSheet?.(spec.jobId, manifest);

  const agent = new VideoAgent({
    store,
    narrator,
    images,
    workDir,
    visualQa: true,
  });

  const { runId } = await agent.start({
    contract: WORKER_CONTRACT,
    jobId: spec.jobId,
    kind: 'video',
    params: { manifest },
    limits: {},
  });
  await agent.whenDone(runId);
  const result = await agent.result(runId);
  if (result.state !== 'succeeded' || result.error !== null) {
    throw new Error(`VideoAgent falhou (${spec.jobId}): ${result.error ?? result.message}`);
  }
  console.log(`    Render finalizado: ${result.message}`);

  const renderedFinal = join(storeRoot, spec.jobId, `${spec.jobId}.mp4`);
  await copyFile(renderedFinal, finalOut);
  console.log(`3/4 Vídeo final salvo em: ${finalOut}`);

  const reviewRaw = await readFile(join(storeRoot, spec.jobId, 'revisao-previa.json'), 'utf8');
  const review = JSON.parse(reviewRaw) as { ok: boolean; falhas: string[]; avisos: string[] };
  console.log(`    QA técnico (revisao-previa.json): ok=${review.ok}, falhas=${review.falhas.length}, avisos=${review.avisos.length}`);

  const pkg = await buildDeliveryPackage(store, spec.jobId, manifest, 1);
  console.log(`4/4 Pacote v${pkg.version} pronto (${pkg.arquivos.video?.arquivo ?? 'sem vídeo'}).`);
}

async function main(): Promise<void> {
  const opts = parseCliOptions(process.argv.slice(2));
  const targets = opts.only
    ? DEMO_SPECS.filter((s) => s.key === opts.only)
    : DEMO_SPECS;

  if (targets.length === 0) {
    throw new Error(`Valor inválido para --only=${opts.only ?? ''}. Use --only=psych ou --only=philosophy.`);
  }

  if (opts.writeFlowPrompts) {
    for (const spec of targets) {
      const sheet = await writeFlowPromptSheetForDemo(spec, opts);
      console.log(`Flow prompts salvos: ${sheet ?? '(nenhum)'}`);
    }
    return;
  }

  const elevenCreds = new ElevenLabsCredentials();
  if (!elevenCreds.status().available) {
    throw new Error('Chave da ElevenLabs ausente em ELEVENLABS_API_KEY ou ~/.elevenlabs/api_key');
  }

  for (const spec of targets) {
    await runOneDemo(spec, elevenCreds, opts);
  }
  console.log('\nDEMOS_DARK_16X9_OK');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
