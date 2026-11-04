// Monta o Night: memória, modelo local, roteador, pesquisadores, executor de tarefas e coordenador.
// Usado pelo modo texto, pelo modo voz e pelo teste de voz.
import { ClaudeCodingAgent, ClaudeReviewer, CodexCodingAgent, CodexReviewer } from '../agents/coding.ts';
import { ClaudeResearch, CodexResearch } from '../agents/research.ts';
import { TaskScheduler } from '../agents/scheduler.ts';
import { OllamaLlm } from '../local-llm/ollama.ts';
import { PgMemory } from '../memory/pg-memory.ts';
import { NightRouter } from '../router/router.ts';
import { GitWorktreeManager } from '../workspaces/worktree-manager.ts';
import { NightCoordinator } from './coordinator.ts';

export async function createNight() {
  const memory = await PgMemory.open();
  const llm = new OllamaLlm();
  const llmOk = await llm.available();
  const router = new NightRouter(llm, async () => (await memory.listProjects()).map((p) => p.name));
  // Pesquisa: modelos menores, Codex primeiro (escolha do Joel), Claude se o Codex falhar ou estiver no limite.
  const researchers = [new CodexResearch(), new ClaudeResearch()];
  // Código: modelos maiores, cada tarefa numa worktree própria, revisada pelo outro agente (D-009, D-011).
  const tasks = new TaskScheduler(
    memory,
    new GitWorktreeManager(process.env.NIGHT_WORKTREES ?? 'D:/NIGHT-data/worktrees'),
    { claude: new ClaudeCodingAgent(), codex: new CodexCodingAgent() },
    { claude: new ClaudeReviewer(), codex: new CodexReviewer() },
  );
  // O que estava rodando quando o Night fechou não recomeça sozinho.
  const stuck = await tasks.reconcile();
  return { memory, llm, llmOk, tasks, stuck, night: new NightCoordinator(memory, router, llm, researchers, tasks) };
}
