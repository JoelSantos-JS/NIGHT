// Calibragem da transcrição com a voz do Joel (blueprint §17: "10 EN + 10 PT-BR short commands from owner").
//   pnpm night:calibrar            → microfone padrão do Windows
//   pnpm night:calibrar Iriun      → outro microfone (pedaço do nome)
// Mostra cada frase, você lê em voz alta, e guarda o áudio + o esperado em D:\NIGHT-data\calibragem\<mic>\.
// Depois: services/speech/.venv/Scripts/python services/speech/bench_stt.py  compara modelos com esses áudios.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { SpeechService } from '../speech/speech-service.ts';
import type { Transcript } from '../core/interfaces.ts';

const PHRASES: { lang: 'pt-BR' | 'en'; text: string }[] = [
  { lang: 'pt-BR', text: 'Night, pesquisa pra mim a cotação do dólar hoje.' },
  { lang: 'pt-BR', text: 'Salva essa ideia para o Soaken: um modo karaokê com as músicas do usuário.' },
  { lang: 'pt-BR', text: 'Pede pro Claude corrigir o bug do login no Night, e o Codex revisa.' },
  { lang: 'pt-BR', text: 'O que você acha que vai acontecer na reunião do Copom hoje?' },
  { lang: 'pt-BR', text: 'Roda o AWS Prep pra mim.' },
  { lang: 'pt-BR', text: 'Mostra as mudanças, e depois eu aprovo.' },
  { lang: 'pt-BR', text: 'Tô meio cansado hoje, estudei a manhã inteira e não rendeu nada.' },
  { lang: 'pt-BR', text: 'Procura os comentários sobre o último episódio da série Um Amor Diferente do Seu.' },
  { lang: 'pt-BR', text: 'Cancela a tarefa do Night, por favor.' },
  { lang: 'pt-BR', text: 'Me explica o que é uma API em poucas palavras.' },
  { lang: 'en', text: 'Night, search for the latest news about the Ollama project.' },
  { lang: 'en', text: 'Ask Codex to write a parser for trading signals.' },
  { lang: 'en', text: 'What do you think I should study next for the AWS exam?' },
];

const mic = process.argv[2] ?? '';
const label = (mic || 'padrao').replace(/[^\w-]+/g, '_');
const dir = path.join('D:/NIGHT-data/calibragem', label);
const speech = new SpeechService({ NIGHT_SAVE_AUDIO_DIR: dir, NIGHT_SAVE_AUDIO_KEEP: '200', ...(mic ? { NIGHT_MIC: mic } : {}) });

console.log('Carregando a voz...');
const ready = await speech.start();
console.log(`microfone: ${ready.input} · whisper ${ready.whisper}`);
console.log('\nLeia cada frase em voz alta, do seu jeito normal de falar. Depois de cada uma, espere ~2 s em silêncio.\n');

let resolveNext: ((t: Transcript) => void) | null = null;
speech.on('auto', (ev) => {
  if (ev.type === 'utterance' && resolveNext && ev.transcript.audioPath) {
    const r = resolveNext;
    resolveNext = null;
    r(ev.transcript);
  }
});
await speech.startAuto();

const results: { expected: string; lang: string; audio: string; heard: string; confidence: number | null }[] = [];
for (const [i, p] of PHRASES.entries()) {
  console.log(`[${i + 1}/${PHRASES.length}] Leia:  \u001b[1m${p.text}\u001b[0m`);
  const heard = await new Promise<Transcript>((r) => { resolveNext = r; });
  const text = heard.text || heard.doubt || '';
  console.log(`        ouvi: ${text}  \u001b[2m(confiança ${heard.confidence ?? '?'})\u001b[0m\n`);
  results.push({ expected: p.text, lang: p.lang, audio: heard.audioPath!, heard: text, confidence: heard.confidence ?? null });
}
await speech.stopAuto();
writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ mic: ready.input, whisper: ready.whisper, at: new Date().toISOString(), results }, null, 2));
console.log(`Pronto. ${results.length} áudios em ${dir}. Pode avisar o Claude.`);
await speech.close();
