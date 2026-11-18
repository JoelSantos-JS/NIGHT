// Night por voz: `pnpm night:voz`. Automático: o microfone fica ouvindo, o Night percebe quando você
// para de falar (~1,3 s de silêncio) e responde. Pausa curta no meio continua a mesma fala.
//   Falar enquanto o Night fala → ele se cala e escuta
//   Enter                       → pausa / retoma o microfone
//   texto + Enter               → manda escrito
//   "sair"                      → fecha
import { createInterface } from 'node:readline';
import { stdin, stdout } from 'node:process';
import { normalize } from '../router/router.ts';
import { SpeechService } from '../speech/speech-service.ts';
import type { Transcript } from '../core/interfaces.ts';
import { createNight } from './bootstrap.ts';
import type { Reply } from './coordinator.ts';
import { startNightServerFor } from './server-start.ts';

const DIM = '\u001b[2m';
const RED = '\u001b[31m';
const GREEN = '\u001b[32m';
const RESET = '\u001b[0m';
const STILL_RESEARCHING_MS = 12_000;

// O Whisper "ouve" estas frases em ruído ou silêncio (vêm de legendas do treino). Não são o Joel falando.
const HALLUCINATIONS = [
  /^(obrigad[oa]( por assistir)?|tchau|valeu)[.!]*$/,
  /legendas? (pela|por) comunidade|amara\.org|inscreva-se|se inscreva/,
  /^(thank you|thanks for watching|you)[.!]*$/,
  /^[\s.…!?,-]*$/,
];

// A voz já existe antes do Night porque os vídeos usam o mesmo Kokoro para narrar.
const speech = new SpeechService();
const { memory, llm, llmOk, night, tasks, stuck, runsTasks, close, makeCoordinator, radar } = await createNight({
  synth: (text, language, file) => speech.synthesizeToFile(text, language, file),
});
if (!runsTasks) console.log('Outra janela do Night já cuida das tarefas de código; esta conversa, pesquisa e salva ideias.');
if (!llmOk) console.error(`${RED}Aviso: o Ollama não respondeu ou não tem o ${llm.model}. A conversa vai falhar até ele subir.${RESET}`);
// Telas do OpenBot e painel: só na janela que roda os trabalhos.
const server = runsTasks ? await startNightServerFor({ makeCoordinator, memory, ofertas: radar, tasks }) : null;

console.log('Carregando a voz (Kokoro + Whisper), leva uns 30 s...');
const ready = await speech.start();
console.log(`${DIM}voz pronta em ${(ready.loadMs / 1000).toFixed(0)} s · whisper ${ready.whisper} · mic: ${ready.input} · saída: ${ready.output}${RESET}`);

let lastNightText = '';
let paused = false;

function say(reply: Reply) {
  lastNightText = reply.text;
  return speech.speak(reply.text, reply.language).catch((e) => console.error(`${RED}erro na fala: ${e.message}${RESET}`));
}

/** O Night ouvindo a própria voz (caixa de som em vez de fone) — não responder a isso. */
function isEcho(text: string): boolean {
  if (!lastNightText) return false;
  const a = new Set(normalize(text).split(' '));
  const b = normalize(lastNightText).split(' ');
  const overlap = b.filter((w) => a.has(w)).length / Math.max(1, Math.min(a.size, b.length));
  return a.size >= 3 && overlap >= 0.8;
}

async function respond(text: string, language?: 'pt-BR' | 'en' | null) {
  const t = performance.now();
  const reply = await night.handle(text, language ?? undefined);
  if (reply.intent === 'stop-speaking') { speech.stop(); return; }
  console.log(`night › ${reply.text}  ${DIM}[${reply.intent} · ${reply.model} · ${((performance.now() - t) / 1000).toFixed(1)}s]${RESET}`);
  if (reply.detail) console.log(`${DIM}${reply.detail}${RESET}`);
  say(reply);
  if (!reply.followUp) return;
  // Pesquisa: a conversa continua; se demorar, avisa uma vez que ainda está procurando.
  let done = false;
  const nudge = setTimeout(() => {
    if (done) return;
    const msg = reply.language === 'en' ? 'Still looking, hang on.' : 'Ainda tô pesquisando, só um pouco.';
    console.log(`night › ${DIM}${msg}${RESET}`);
    speech.speak(msg, reply.language).catch(() => {});
  }, STILL_RESEARCHING_MS);
  reply.followUp.then((later) => {
    done = true;
    clearTimeout(nudge);
    console.log(`\nnight › ${later.text}  ${DIM}[${later.intent} · ${later.model} · ${((performance.now() - t) / 1000).toFixed(0)}s]${RESET}`);
    return say(later);
  }).catch((e) => { done = true; clearTimeout(nudge); console.error(`${RED}erro na pesquisa: ${e.message}${RESET}`); });
}

// Uma fala por vez, na ordem em que chegaram.
let chain: Promise<void> = Promise.resolve();
const enqueue = (job: () => Promise<void>) => {
  chain = chain.then(job).catch((e) => console.error(`${RED}erro: ${(e as Error).message}${RESET}`));
};

function onUtterance(heard: Transcript) {
  const text = heard.text.trim();
  const n = normalize(text);
  if (!text && heard.doubt) {
    // O Whisper não teve confiança: melhor não responder do que responder a uma frase inventada.
    console.log(`${DIM}(não entendi direito, confiança ${heard.confidence ?? '?'}: "${heard.doubt}" — fala de novo, mais perto do microfone)${RESET}`);
    return;
  }
  if (!text) return; // barulho que não virou palavra: nem mostra
  if (HALLUCINATIONS.some((re) => re.test(n))) {
    console.log(`${DIM}(ignorado: "${text}")${RESET}`);
    return;
  }
  if (isEcho(text)) {
    console.log(`${DIM}(ignorado, era a minha própria voz: "${text}")${RESET}`);
    return;
  }
  console.log(`\nvocê › ${text}  ${DIM}[${heard.language} · ${heard.audioSeconds.toFixed(1)} s · transcrito em ${(heard.ms / 1000).toFixed(1)} s · confiança ${heard.confidence ?? '?'}${heard.denoised ? ' · limpei ruído' : ''}]${RESET}`);
  enqueue(() => respond(text, heard.language));
}

speech.on('auto', (ev) => {
  if (ev.type === 'speech_start') process.stdout.write(`${RED}● ouvindo...${RESET}${ev.bargeIn ? ` ${DIM}(parei de falar)${RESET}` : ''}\n`);
  else if (ev.type === 'utterance') onUtterance(ev.transcript);
  else if (ev.type === 'speech_discarded') process.stdout.write(`${DIM}(curto demais, ignorei)${RESET}\n`);
  else if (ev.type === 'error') console.error(`${RED}erro na escuta: ${ev.message}${RESET}`);
});

// Tarefas de código: o Night avisa sozinho quando termina, falha ou precisa de aprovação.
tasks.on('update', (u) => {
  if (!u.important) { console.log(`${DIM}[tarefa ${u.task.id}] ${u.message}${RESET}`); return; }
  console.log(`\nnight › ${u.message}`);
  lastNightText = u.message;
  speech.speak(u.message, 'pt-BR').catch(() => {});
});
if (stuck.length) console.log(`${DIM}${stuck.length} tarefa(s) estavam rodando quando o Night fechou; marquei como falha (não recomecei sozinho).${RESET}`);

await speech.startAuto();
console.log(`\n${GREEN}🎙 Pode falar.${RESET} O Night responde quando você para (~1,3 s de silêncio).`);
console.log(`${DIM}Enter = pausar/retomar o microfone · ou digite · "sair" para fechar${RESET}`);

const rl = createInterface({ input: stdin, output: stdout });
try {
  for await (const raw of rl) {
    const line = raw.trim();
    if (/^(sair|exit|quit)$/i.test(line)) break;
    if (line) {
      enqueue(() => respond(line));
    } else if (paused) {
      await speech.startAuto();
      paused = false;
      console.log(`${GREEN}🎙 microfone ligado${RESET}`);
    } else {
      await speech.stopAuto();
      paused = true;
      console.log(`${DIM}⏸ microfone pausado (Enter para voltar)${RESET}`);
    }
  }
} finally {
  rl.close();
  await server?.close();
  await tasks.shutdown(); // mata agentes vivos antes de soltar a trava
  await chain;
  await speech.close();
  await close();
  await memory.close();
}
