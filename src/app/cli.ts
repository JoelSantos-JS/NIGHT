// Night por texto no terminal: `pnpm night`. O modo voz é `pnpm night:voz` (src/app/voice.ts).
// Funciona digitando ou com texto vindo de um pipe (útil para testar uma conversa inteira).
import { createInterface } from 'node:readline';
import { stdin, stdout } from 'node:process';
import { createNight } from './bootstrap.ts';
import type { Reply } from './coordinator.ts';
import { startNightServerFor } from './server-start.ts';

const DIM = '\u001b[2m';
const RESET = '\u001b[0m';

const { memory, llm, llmOk, night, tasks, stuck, runsTasks, close, makeCoordinator, radar, connections } = await createNight();
if (!runsTasks) console.log('Outra janela do Night já cuida das tarefas de código; esta conversa, pesquisa e salva ideias.');
tasks.on('update', (u) => console.log(u.important ? `\nnight › ${u.message}` : `${DIM}[tarefa ${u.task.id}] ${u.message}${RESET}`));
if (stuck.length) console.log(`${stuck.length} tarefa(s) estavam rodando quando o Night fechou; marquei como falha.`);
if (!llmOk) console.error(`Aviso: o Ollama não respondeu ou não tem o modelo ${llm.model}. A conversa vai falhar até ele subir.`);
// Telas do OpenBot e painel: só na janela que roda os trabalhos.
const server = runsTasks ? await startNightServerFor({ makeCoordinator, memory, ofertas: radar, tasks, conexoes: connections }) : null;

function show(reply: Reply, startedAt: number) {
  const secs = ((performance.now() - startedAt) / 1000).toFixed(1);
  console.log(`night › ${reply.text || '(em silêncio)'}`);
  if (reply.detail) console.log(`${DIM}${reply.detail}${RESET}`);
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
  await server?.close();
  await tasks.shutdown(); // mata agentes vivos antes de soltar a trava
  await close();
  await memory.close();
}
