// `pnpm night:servidor`: o NIGHT sem voz e sem terminal, só para as telas do OpenBot e o painel.
// Se a voz ou o terminal já estiver aberto, quem sobe o servidor é ele (a janela com a trava).
import { createNight } from './bootstrap.ts';
import { startNightServerFor } from './server-start.ts';

const { memory, llm, llmOk, tasks, stuck, runsTasks, close, makeCoordinator, radar } = await createNight();
if (!runsTasks) {
  console.log('Outra janela do Night já roda os trabalhos; o servidor das telas sobe nela. Fechando esta.');
  await close();
  await memory.close();
  process.exit(0);
}
if (!llmOk) console.error(`Aviso: o Ollama não respondeu ou não tem o modelo ${llm.model}.`);
if (stuck.length) console.log(`${stuck.length} tarefa(s) estavam rodando quando o Night fechou; marquei como falha.`);
tasks.on('update', (u) => { if (u.important) console.log(`night › ${u.message}`); });

const server = await startNightServerFor({ makeCoordinator, memory, ofertas: radar, tasks });
if (!server) {
  await close();
  await memory.close();
  process.exit(1);
}
console.log('Ctrl+C para fechar.');

let fechando = false;
const fechar = async () => {
  if (fechando) return;
  fechando = true;
  await server.close();
  await tasks.shutdown(); // mata agentes vivos antes de soltar a trava
  await close();
  await memory.close();
  process.exit(0);
};
process.on('SIGINT', fechar);
process.on('SIGTERM', fechar);
