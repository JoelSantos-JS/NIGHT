// Night por texto no terminal: `pnpm night`. O modo voz é `pnpm night:voz` (src/app/voice.ts).
// Funciona digitando ou com texto vindo de um pipe (útil para testar uma conversa inteira).
import { createInterface } from 'node:readline';
import { stdin, stdout } from 'node:process';
import { createNight } from './bootstrap.ts';
import type { Reply } from './coordinator.ts';

const DIM = '\u001b[2m';
const RESET = '\u001b[0m';

const { memory, llm, llmOk, night } = await createNight();
if (!llmOk) console.error(`Aviso: o Ollama não respondeu ou não tem o modelo ${llm.model}. A conversa vai falhar até ele subir.`);

function show(reply: Reply, startedAt: number) {
  const secs = ((performance.now() - startedAt) / 1000).toFixed(1);
  console.log(`night › ${reply.text || '(em silêncio)'}`);
  console.log(`${DIM}        [${reply.intent} · ${reply.model} · ${reply.language} · ${secs}s]${RESET}`);
}

const rl = createInterface({ input: stdin, output: stdout, prompt: '\nvocê › ' });
console.log('Night (texto). Escreva em português ou inglês; "sair" para fechar.');
rl.prompt();
try {
  for await (const raw of rl) {
    const line = raw.trim();
    if (/^(sair|exit|quit)$/i.test(line)) break;
    if (line) {
      if (!stdin.isTTY) console.log(line);
      const t = performance.now();
      const reply = await night.handle(line);
      show(reply, t);
      // No modo texto a pesquisa é esperada aqui; no modo voz ela chega enquanto a conversa continua.
      if (reply.followUp) show(await reply.followUp, t);
    }
    rl.prompt();
  }
} finally {
  rl.close();
  await memory.close();
}
