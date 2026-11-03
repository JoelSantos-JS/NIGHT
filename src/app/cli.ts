// Night por texto no terminal: `pnpm night`. A voz entra depois no lugar do readline.
import { createInterface } from 'node:readline';
import { stdin, stdout } from 'node:process';
import { OllamaLlm } from '../local-llm/ollama.ts';
import { PgMemory } from '../memory/pg-memory.ts';
import { NightRouter } from '../router/router.ts';
import { NightCoordinator } from './coordinator.ts';

const memory = await PgMemory.open();
const llm = new OllamaLlm();
if (!(await llm.available())) {
  console.error(`Aviso: o Ollama não respondeu ou não tem o modelo ${llm.model}. A conversa vai falhar até ele subir.`);
}
const router = new NightRouter(llm, async () => (await memory.listProjects()).map((p) => p.name));
const night = new NightCoordinator(memory, router, llm);

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
      const secs = ((performance.now() - t) / 1000).toFixed(1);
      console.log(`night › ${reply.text || '(em silêncio)'}`);
      console.log(`[2m        [${reply.intent} · ${reply.model} · ${reply.language} · ${secs}s][0m`);
    }
    rl.prompt();
  }
} finally {
  rl.close();
  await memory.close();
}
