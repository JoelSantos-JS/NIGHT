// Demonstração completa de 10 cenas (dark-science-2d + ilustrações 9:16 + ElevenLabs ou Kokoro + Remotion + Meta draft).
// Uso:
//   node --import tsx scripts/demo-video-cientifico.ts          (usa ElevenLabs se a chave existir)
//   node --import tsx scripts/demo-video-cientifico.ts --kokoro (força Kokoro local)
// Grava saída em D:\NIGHT-data\video-demos\ciencia-tardigrado-v2\. Não publica nada em redes reais.

import { copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ArtifactStore } from '../src/artifacts/store.ts';
import { WORKER_CONTRACT } from '../src/jobs/worker.ts';
import { SpeechService } from '../src/speech/speech-service.ts';
import { VideoAgent } from '../src/video/agent.ts';
import { buildBrief } from '../src/video/brief.ts';
import {
  ELEVENLABS_MCP_URL,
  ElevenLabsCredentials,
  createElevenLabsSynth,
} from '../src/video/elevenlabs.ts';
import { FlowFolderProvider } from '../src/video/flow-folder.ts';
import { MANIFEST_VERSION, validateManifest } from '../src/video/manifest.ts';
import { Narrator, type Synth } from '../src/video/narrate.ts';
import { buildDeliveryPackage } from '../src/video/package.ts';
import {
  MetaPublishCredentials,
  buildPublishManifest,
  executePublishManifest,
  savePublishManifest,
} from '../src/video/publish.ts';

const DEMO_ROOT = 'D:/NIGHT-data/video-demos/ciencia-tardigrado-v2';
const JOB_ID = 'ciencia-tardigrado-v2';

const LEXICON: Record<string, string> = {
  '-272 °C': 'duzentos e setenta e dois graus negativos',
  '150 °C': 'cento e cinquenta graus Celsius',
  'Foton-M3': 'Fóton M três',
  TDP: 'Tê Dê Pê',
  DNA: 'Dê Ene Á',
  '10 dias': 'dez dias',
  '2007': 'dois mil e sete',
};

async function main(): Promise<void> {
  const forceKokoro = process.argv.includes('--kokoro');
  const elevenCreds = new ElevenLabsCredentials();
  const elevenStatus = elevenCreds.status();

  if (!forceKokoro && !elevenStatus.available) {
    console.log('Chave da ElevenLabs ainda não configurada para narrar o vídeo v2.');
    console.log('Como configurar sem expor no repositório:');
    console.log('  1. API direta (recomendado para o NIGHT): salve sua chave em C:\\Users\\Joel\\.elevenlabs\\api_key ou defina $env:ELEVENLABS_API_KEY');
    console.log(`  2. MCP remoto (OAuth no Claude/OpenBot): ${ELEVENLABS_MCP_URL}`);
    console.log('  3. Para rodar localmente sem ElevenLabs, passe: --kokoro');
    return;
  }

  const storeRoot = join(DEMO_ROOT, 'store');
  const workDir = join(DEMO_ROOT, 'work');
  const finalOut = join(DEMO_ROOT, 'tardigrado-v2-final.mp4');
  await mkdir(DEMO_ROOT, { recursive: true });

  const store = new ArtifactStore(storeRoot);
  const brief = buildBrief({
    tema: 'Como o tardígrado sobrevive ao vácuo do espaço (10 cenas)',
    publico: 'curiosos por ciência e tecnologia',
    plataforma: 'reels',
    duracaoAlvoSeg: 40,
    estilo: 'dark-science-2d',
    objetivo: 'explicar mecanismo científico comprovado com variação visual contínua',
  });

  const valid = validateManifest({
    version: MANIFEST_VERSION,
    jobId: JOB_ID,
    brief,
    titulo: 'O animal que sobrevive ao espaço',
    motorVisual: 'remotion',
    templateVisual: 'dark-science-2d',
    fontes: [
      {
        id: 'esa-foton-2008',
        url: 'https://www.sciencedirect.com/science/article/pii/S0960982208008051',
        titulo: 'Jönsson et al. (2008), Current Biology — Tardigrades survive exposure to space (FOTON-M3)',
        acessadoEm: '2026-11-23',
      },
      {
        id: 'boothby-2017',
        url: 'https://www.sciencedirect.com/science/article/pii/S1097276517301338',
        titulo: 'Boothby et al. (2017), Molecular Cell — Tardigrades Use Intrinsically Disordered Proteins',
        acessadoEm: '2026-11-23',
      },
    ],
    cenas: [
      {
        n: 1,
        narracao: 'No escuro do laboratório, uma criatura invisível desafia todas as regras da vida.',
        duracaoEstimadaSeg: 4,
        afirmacoes: [],
        visual: 'Cientista observando placa de petri luminosa no laboratório escuro',
        promptImagem: '',
        papelImagem: 'ilustracao',
        realistaGeradaPorIA: false,
        assetRef: null,
        cenario: 'lab',
        textoNaTela: 'NOITE NO LAB',
        transicao: 'cut',
      },
      {
        n: 2,
        narracao: "Esse é o tardígrado: meio milímetro de puro instinto de sobrevivência.",
        duracaoEstimadaSeg: 4,
        afirmacoes: [],
        visual: 'Lente circular do microscópio revelando o tardígrado',
        promptImagem: '',
        papelImagem: 'ilustracao',
        realistaGeradaPorIA: false,
        assetRef: null,
        cenario: 'microscope-pov',
        textoNaTela: '0,5 MILÍMETRO',
        transicao: 'zoom',
      },
      {
        n: 3,
        narracao: 'Ele resiste a -272 °C sem que suas células virem gelo destrutivo.',
        duracaoEstimadaSeg: 4,
        afirmacoes: [{ texto: 'Tardígrados suportam temperaturas próximas ao zero absoluto', fonte: 'esa-foton-2008', duvida: false }],
        visual: 'Câmara criogênica congelada com o tardígrado intacto no cilindro',
        promptImagem: '',
        papelImagem: 'ilustracao',
        realistaGeradaPorIA: false,
        assetRef: null,
        cenario: 'freeze-chamber',
        textoNaTela: '-272 °C',
        transicao: 'slide',
      },
      {
        n: 4,
        narracao: 'E aguenta até 150 °C perto de fontes extremas de calor.',
        duracaoEstimadaSeg: 4,
        afirmacoes: [{ texto: 'Tardígrados toleram calor extremo até cerca de 150 °C por curtos períodos', fonte: 'esa-foton-2008', duvida: false }],
        visual: 'Fenda térmica vulcânica abissal com ondas de calor âmbar',
        promptImagem: '',
        papelImagem: 'ilustracao',
        realistaGeradaPorIA: false,
        assetRef: null,
        cenario: 'heat-vent',
        textoNaTela: '150 °C',
        transicao: 'cut',
      },
      {
        n: 5,
        narracao: 'Mas em 2007, cientistas decidiram ir muito além da Terra.',
        duracaoEstimadaSeg: 4,
        afirmacoes: [{ texto: 'Experimento ocorreu em missão orbital em 2007', fonte: 'esa-foton-2008', duvida: false }],
        visual: 'Cientista maravilhado segurando amostra brilhante no laboratório',
        promptImagem: '',
        papelImagem: 'ilustracao',
        realistaGeradaPorIA: false,
        assetRef: null,
        cenario: 'lab',
        textoNaTela: 'MISSÃO 2007',
        transicao: 'fade',
      },
      {
        n: 6,
        narracao: 'A missão europeia Foton-M3 lançou tardígrados direto na órbita espacial.',
        duracaoEstimadaSeg: 4,
        afirmacoes: [{ texto: 'A missão ESA FOTON-M3 expôs tardígrados em órbita baixa', fonte: 'esa-foton-2008', duvida: false }],
        visual: 'Cápsula espacial orbitando sobre o horizonte azul da Terra',
        promptImagem: '',
        papelImagem: 'ilustracao',
        realistaGeradaPorIA: false,
        assetRef: null,
        cenario: 'cosmos-pov',
        textoNaTela: 'FOTON-M3',
        transicao: 'zoom',
      },
      {
        n: 7,
        narracao: 'Foram 10 dias no vácuo absoluto, sob radiação capaz de destruir nosso DNA.',
        duracaoEstimadaSeg: 4.5,
        afirmacoes: [{ texto: 'Exposição durou 10 dias no vácuo e radiação solar espacial', fonte: 'esa-foton-2008', duvida: false }],
        visual: 'Escotilha espacial com raios de radiação passando pelo tardígrado em criptobiose',
        promptImagem: '',
        papelImagem: 'ilustracao',
        realistaGeradaPorIA: false,
        assetRef: null,
        cenario: 'radiation-pulse',
        textoNaTela: '10 DIAS NO VÁCUO',
        transicao: 'slide',
      },
      {
        n: 8,
        narracao: "De volta ao laboratório, uma gota d'água trouxe muitos deles de volta à vida.",
        duracaoEstimadaSeg: 4,
        afirmacoes: [{ texto: 'Amostras desidratadas voltaram à atividade após reidratação', fonte: 'esa-foton-2008', duvida: false }],
        visual: 'Gota ciano luminosa caindo de pipeta sobre a cápsula seca do tardígrado',
        promptImagem: '',
        papelImagem: 'ilustracao',
        realistaGeradaPorIA: false,
        assetRef: null,
        cenario: 'microscope-pov',
        textoNaTela: 'REIDRATAÇÃO',
        transicao: 'fade',
      },
      {
        n: 9,
        narracao: 'O segredo são proteínas TDP, que viram um escudo de biovidro nas células.',
        duracaoEstimadaSeg: 4,
        afirmacoes: [{ texto: 'Proteínas TDP vitrificam o citoplasma formando biovidro protetor', fonte: 'boothby-2017', duvida: false }],
        visual: 'Domo hexagonal de biovidro protegendo filamentos proteicos luminosos',
        promptImagem: '',
        papelImagem: 'ilustracao',
        realistaGeradaPorIA: false,
        assetRef: null,
        cenario: 'reveal',
        textoNaTela: 'BIOVIDRO • TDP',
        transicao: 'zoom',
      },
      {
        n: 10,
        narracao: 'E essa descoberta já inspira vacinas que dispensam geladeira no futuro.',
        duracaoEstimadaSeg: 3.5,
        afirmacoes: [{ texto: 'Proteínas TDP são pesquisadas para estabilizar biológicos sem refrigeração', fonte: 'boothby-2017', duvida: false }],
        visual: 'Bancada iluminada com frascos de vacina estabilizados e cientista sorrindo',
        promptImagem: '',
        papelImagem: 'ilustracao',
        realistaGeradaPorIA: false,
        assetRef: null,
        cenario: 'vaccine-lab',
        textoNaTela: 'CIÊNCIA NA PRÁTICA',
        transicao: 'fade',
      },
    ],
  });
  if (!valid.ok) {
    throw new Error(`Manifesto inválido: ${JSON.stringify(valid.errors, null, 2)}`);
  }
  const manifest = valid.manifest;

  const images = new FlowFolderProvider({ root: DEMO_ROOT, numeroDoVideo: 'scenes' });
  let narrator: Narrator;

  if (!forceKokoro && elevenStatus.available) {
    console.log('1/4 Sintetizando narração expressiva com ElevenLabs (eleven_multilingual_v2)...');
    const synth = createElevenLabsSynth({ credentials: elevenCreds });
    narrator = new Narrator(synth, store, { workDir, lexicon: LEXICON });
    const narracao = await narrator.narrateAll(JOB_ID, manifest);
    console.log(`    Narração ElevenLabs pronta (${narracao.totalSec.toFixed(1)}s em ${narracao.scenes.length} cenas).`);
  } else {
    console.log('1/4 Sintetizando narração local com Kokoro TTS (--kokoro)...');
    const speech = new SpeechService({
      NIGHT_STT: 'local',
      NIGHT_WHISPER_MODEL: 'base',
      NIGHT_SPEAKER: 'off',
      NIGHT_SPEECH_OFFLINE: '1',
    });
    await speech.start();
    const synth: Synth = (text, language, file) => speech.synthesizeToFile(text, language, file);
    narrator = new Narrator(synth, store, { workDir, lexicon: LEXICON });
    try {
      const narracao = await narrator.narrateAll(JOB_ID, manifest);
      console.log(`    Narração Kokoro pronta (${narracao.totalSec.toFixed(1)}s em ${narracao.scenes.length} cenas).`);
    } finally {
      await speech.close();
    }
  }

  console.log('2/4 Executando VideoAgent (10 cenas ilustradas + prévia + QA visual + final 1080x1920)...');
  const agent = new VideoAgent({
    store,
    narrator,
    images,
    workDir,
    visualQa: true,
  });

  const { runId } = await agent.start({
    contract: WORKER_CONTRACT,
    jobId: JOB_ID,
    kind: 'video',
    params: { manifest },
    limits: {},
  });
  await agent.whenDone(runId);
  const result = await agent.result(runId);
  if (result.state !== 'succeeded' || result.error !== null) {
    throw new Error(`VideoAgent falhou (${result.state}): ${result.error ?? result.message}`);
  }
  console.log(`    VideoAgent concluído: ${result.message}`);

  const renderedFinal = join(storeRoot, JOB_ID, `${JOB_ID}.mp4`);
  await copyFile(renderedFinal, finalOut);
  console.log(`    Vídeo final copiado para: ${finalOut}`);

  console.log('3/4 Gerando pacote v1 e manifesto de publicação Meta (sempre rascunho)...');
  const pkg = await buildDeliveryPackage(store, JOB_ID, manifest, 1);
  const publishDraft = buildPublishManifest(pkg, {
    jobId: JOB_ID,
    caption:
      'O animal microscópico que sobreviveu a 10 dias no vácuo espacial usando um escudo natural de biovidro.',
    hashtags: ['ciencia', 'biologia', 'curiosidades', 'tardigrado'],
  });
  await savePublishManifest(store, JOB_ID, publishDraft);

  console.log('4/4 Simulando checagem dry-run da publicação Meta...');
  const dry = await executePublishManifest(store, JOB_ID, 1, {
    dryRun: true,
    credentials: new MetaPublishCredentials({}),
  });
  console.log('    Dry-run checks:', JSON.stringify(dry.checks));
  console.log('DEMO_CIENTIFICO_V2_OK');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
