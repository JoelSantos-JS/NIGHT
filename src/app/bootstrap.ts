// Monta o Night: memória, modelo local, roteador, pesquisadores, executor de tarefas e coordenador.
// Usado pelo modo texto, pelo modo voz e pelo teste de voz.
import { ClaudeCodingAgent, ClaudeReviewer, CodexCodingAgent, CodexReviewer } from '../agents/coding.ts';
import { ClaudeChat, CodexChat } from '../agents/chat.ts';
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
  // Só a instância que pega a trava executa tarefas e faz a checagem de reinício. Uma segunda janela
  // conversa, pesquisa e salva ideias, mas não mexe nas tarefas da primeira.
  const unlock = await memory.acquireTaskLock();
  // O que estava rodando quando o Night fechou não recomeça sozinho.
  const stuck = unlock ? await tasks.reconcile() : [];
  // Conversa normal: Codex gpt-6-luna e Claude Sonnet alternando (pedido do Joel, 04/11); Qwen só se os dois
  // falharem. NIGHT_CHAT=local volta para só o Qwen (sem gastar cota).
  const chatters = process.env.NIGHT_CHAT === 'local' ? [] : [new CodexChat(), new ClaudeChat()];
  const night = new NightCoordinator(memory, router, llm, researchers, unlock ? tasks : undefined, chatters);
  return { memory, llm, llmOk, tasks, stuck, runsTasks: Boolean(unlock), night };
}
