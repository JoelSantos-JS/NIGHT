// Monta o Night: memória, modelo local, roteador e coordenador. Usado pelo modo texto e pelo modo voz.
import { ClaudeResearch, CodexResearch } from '../agents/research.ts';
import { OllamaLlm } from '../local-llm/ollama.ts';
import { PgMemory } from '../memory/pg-memory.ts';
import { NightRouter } from '../router/router.ts';
import { NightCoordinator } from './coordinator.ts';

export async function createNight() {
  const memory = await PgMemory.open();
  const llm = new OllamaLlm();
  const llmOk = await llm.available();
  const router = new NightRouter(llm, async () => (await memory.listProjects()).map((p) => p.name));
  // Pesquisa: modelos menores, Codex primeiro (escolha do Joel), Claude se o Codex falhar ou estiver no limite.
  const researchers = [new CodexResearch(), new ClaudeResearch()];
  return { memory, llm, llmOk, night: new NightCoordinator(memory, router, llm, researchers) };
}
