// Night por voz: `pnpm night:voz`.
//   Enter vazio  → abre o microfone (e cala o Night se ele estiver falando)
//   Enter de novo → fecha o microfone, transcreve, responde e fala
//   texto + Enter → mesma coisa, sem microfone
//   "sair"        → fecha
import { createInterface } from 'node:readline';
import { stdin, stdout } from 'node:process';
import { SpeechService } from '../speech/speech-service.ts';
import { createNight } from './bootstrap.ts';

const DIM = '\u001b[2m';
const RED = '\u001b[31m';
const RESET = '\u001b[0m';

const { memory, llm, llmOk, night } = await createNight();
if (!llmOk) console.error(`${RED}Aviso: o Ollama não respondeu ou não tem o ${llm.model}. A conversa vai falhar até ele subir.${RESET}`);

const speech = new SpeechService();
console.log('Carregando a voz (Kokoro + Whisper), leva uns 30 s na primeira vez...');
const ready = await speech.start();
console.log(`${DIM}voz pronta em ${(ready.loadMs / 1000).toFixed(0)} s · whisper ${ready.whisper} · mic: ${ready.input} · saída: ${ready.output}${RESET}`);
console.log('\nEnter = falar (Enter de novo para parar) · ou digite · "sair" para fechar');

async function respond(text: string, language?: 'pt-BR' | 'en' | null) {
  const t = performance.now();
  const reply = await night.handle(text, language ?? undefined);
  const secs = ((performance.now() - t) / 1000).toFixed(1);
  if (reply.intent === 'stop-speaking') { speech.stop(); return; }
  console.log(`night › ${reply.text}`);
  console.log(`${DIM}        [${reply.intent} · ${reply.model} · ${reply.language} · ${secs}s]${RESET}`);
  // Não espera terminar de falar: Enter durante a fala abre o microfone e interrompe.
  speech.speak(reply.text, reply.language).catch((e) => console.error(`${RED}erro na fala: ${e.message}${RESET}`));
  // Pesquisa: dá para continuar conversando; a resposta é mostrada e falada quando chegar.
  reply.followUp?.then((later) => {
    const total = ((performance.now() - t) / 1000).toFixed(0);
    console.log(`\nnight › ${later.text}`);
    console.log(`${DIM}        [${later.intent} · ${later.model} · ${total}s]${RESET}`);
    return speech.speak(later.text, later.language);
  }).catch((e) => console.error(`${RED}erro na pesquisa: ${e.message}${RESET}`));
}

const rl = createInterface({ input: stdin, output: stdout });
let busy = false;
try {
  for await (const raw of rl) {
    const line = raw.trim();
    if (/^(sair|exit|quit)$/i.test(line)) break;
    if (busy) continue;
    busy = true;
    try {
      if (line) {
        await respond(line);
      } else if (!speech.listening) {
        speech.startListening();
        console.log(`${RED}● ouvindo...${RESET} ${DIM}(Enter para parar)${RESET}`);
      } else {
        const heard = await speech.stopListening();
        if (!heard.text) {
          console.log(`${DIM}(não ouvi nada em ${heard.audioSeconds.toFixed(1)} s de áudio)${RESET}`);
        } else {
          console.log(`você › ${heard.text}  ${DIM}[${heard.language} · ${heard.audioSeconds.toFixed(1)} s · transcrito em ${(heard.ms / 1000).toFixed(1)} s]${RESET}`);
          await respond(heard.text, heard.language);
        }
      }
    } catch (e) {
      console.error(`${RED}erro: ${(e as Error).message}${RESET}`);
    } finally {
      busy = false;
    }
  }
} finally {
  rl.close();
  await speech.close();
  await memory.close();
}
