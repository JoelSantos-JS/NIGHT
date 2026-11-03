// Comando de voz de teste, sem microfone:
//   pnpm night:teste "Salva essa ideia para o Soaken: modo karaokê"   → o Kokoro fala a frase, o Whisper
//                                                                      transcreve como se fosse você, e segue
//   pnpm night:teste --arquivo C:\caminho\audio.wav                   → usa um áudio seu (wav/flac/ogg)
//   pnpm night:teste "frase 1 | frase 2 | frase 3"                    → várias, voz carregada uma vez
//   pnpm night:teste --mudo ...                                       → não toca a resposta
// Depois da transcrição o caminho é o mesmo do modo voz: roteador → ação → resposta falada.
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SpeechService } from '../speech/speech-service.ts';
import { detectLanguage } from '../router/router.ts';
import { createNight } from './bootstrap.ts';

const DIM = '\u001b[2m';
const RESET = '\u001b[0m';

const args = process.argv.slice(2);
const mute = args.includes('--mudo');
const fileIdx = args.indexOf('--arquivo');
const file = fileIdx >= 0 ? args[fileIdx + 1] : undefined;
const phrase = args.filter((a, i) => !a.startsWith('--') && (fileIdx < 0 || i !== fileIdx + 1)).join(' ').trim();

if (!file && !phrase) {
  console.error('uso: pnpm night:teste "frase de teste"  |  pnpm night:teste --arquivo audio.wav  [--mudo]');
  process.exit(1);
}
if (file && !existsSync(file)) {
  console.error(`arquivo não existe: ${file}`);
  process.exit(1);
}

const { memory, night } = await createNight();
const speech = new SpeechService();
const dir = mkdtempSync(path.join(tmpdir(), 'night-teste-'));
try {
  console.log(`${DIM}carregando a voz...${RESET}`);
  await speech.start();

  // Várias frases separadas por "|" rodam em sequência, com a voz carregada uma vez só.
  const inputs = file ? [file] : phrase.split('|').map((p) => p.trim()).filter(Boolean);
  for (const [i, input] of inputs.entries()) {
    let audio = input;
    if (!file) {
      // A frase vira áudio com a voz do Kokoro: testa o caminho inteiro, inclusive o Whisper.
      audio = path.join(dir, `fala-${i}.wav`);
      await speech.synthesizeToFile(input, detectLanguage(input), audio);
    }

    const heard = await speech.transcribeFile(audio);
    console.log(`\nvocê (ouvido) › ${heard.text || '(nada)'}  ${DIM}[${heard.language} · ${heard.audioSeconds.toFixed(1)} s de áudio · ${(heard.ms / 1000).toFixed(1)} s para transcrever]${RESET}`);
    if (!heard.text) continue;

    const t = performance.now();
    const reply = await night.handle(heard.text, heard.language ?? undefined);
    console.log(`night › ${reply.text}  ${DIM}[${reply.intent} · ${reply.model} · ${((performance.now() - t) / 1000).toFixed(1)} s]${RESET}`);
    if (!mute) await speech.speak(reply.text, reply.language);
    if (reply.followUp) {
      const later = await reply.followUp;
      console.log(`night › ${later.text}  ${DIM}[${later.intent} · ${later.model} · ${((performance.now() - t) / 1000).toFixed(1)} s]${RESET}`);
      if (!mute) await speech.speak(later.text, later.language);
    }
  }
} finally {
  await speech.close();
  await memory.close();
  rmSync(dir, { recursive: true, force: true });
}
