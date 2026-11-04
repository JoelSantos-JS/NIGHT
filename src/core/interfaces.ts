// Contratos entre módulos (docs/PLANO_INICIAL.md §4).
// Cada módulo implementa a sua interface; ninguém importa a implementação do outro direto.
// Mudar este arquivo exige revisão do outro agente.

import type {
  AgentName, Approval, ApprovalAction, Id, Idea, IdeaStatus, Language, Project, Task, TaskEvent,
  TaskEventType, TaskStatus,
} from './types.ts';

// ---------- Voz (blueprint §17) ----------

export type SttResult =
  | { kind: 'partial'; text: string; startMs: number; endMs: number }
  | { kind: 'final'; text: string; startMs: number; endMs: number; language: Language | null }
  | { kind: 'error'; message: string };

export interface SpeechToText {
  readonly engine: string;
  initialize(): Promise<void>;
  /** Áudio PCM 16 kHz mono 16-bit, em pedaços. */
  transcribeStream(audioChunks: AsyncIterable<Uint8Array>, languageHint?: Language): AsyncIterable<SttResult>;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export interface Transcript {
  text: string;
  language: Language | null;
  audioSeconds: number;
  /** Tempo de transcrição depois que o microfone fechou. */
  ms: number;
  /** Quando o Whisper não teve confiança: o que ele achou que ouviu (o text fica vazio). */
  doubt?: string | null;
  /** Confiança média do Whisper (log-prob; 0 é certeza, abaixo de -1 é duvidoso). */
  confidence?: number;
}

/** Aperta-e-fala (blueprint §6): o microfone só abre entre startListening e stopListening. */
export interface PushToTalkStt {
  readonly listening: boolean;
  startListening(): void;
  stopListening(languageHint?: Language): Promise<Transcript>;
}

export interface TextToSpeech {
  readonly engine: string;
  /** Resolve quando terminou de falar ou foi interrompido por stop(). */
  speak(text: string, language: Language): Promise<{ interrupted: boolean }>;
  stop(): void;
}

// ---------- Conversa e roteamento (blueprint §5) ----------

export type Intent =
  | { kind: 'chat' }
  | { kind: 'save-idea'; projectHint: string | null; text: string }
  | { kind: 'find-ideas'; projectHint: string | null; query: string }
  | { kind: 'status'; taskHint: string | null }
  | { kind: 'coding-task'; projectHint: string | null; objective: string; agent: AgentName | null }
  /** Fato atual ou pesquisa: vai para um modelo menor do Codex/Claude com busca na internet (D-009). */
  | { kind: 'research'; query: string }
  /** "Mostra as mudanças" (blueprint §6). */
  | { kind: 'show-diff'; taskHint: string | null }
  /** "A pasta do projeto X é C:\..." — liga o projeto a um repositório. */
  | { kind: 'set-project-path'; projectHint: string | null; path: string }
  | { kind: 'approval'; decision: 'approve' | 'reject'; taskHint: string | null }
  | { kind: 'cancel'; taskHint: string | null }
  | { kind: 'stop-speaking' };

/** Para onde a resposta foi e por quê: o roteador grava isso (blueprint §5, fim). */
export interface RouteDecision {
  intent: Intent;
  model: string;
  reason: string;
  usedPremiumQuota: boolean;
}

export interface LocalLlm {
  readonly model: string;
  chat(messages: { role: 'system' | 'user' | 'assistant'; content: string }[], opts?: { json?: boolean }): Promise<string>;
}

export interface ModelRouter {
  route(text: string, language: Language): Promise<RouteDecision>;
}

// ---------- Memória (blueprint §13) ----------

export interface NewIdea {
  projectId: Id | null;
  title: string;
  transcript: string;
  notes?: string;
  tags?: string[];
}

export interface ActivityEntry {
  at: string;
  text: string;
  intent: Intent['kind'];
  /** 'rules', 'qwen3:1.7b', 'codex:gpt-6-luna', 'claude:haiku'... */
  model: string;
  reply: string | null;
}

export interface Memory {
  /** Só resolve depois de gravado de verdade: aí o Night pode dizer "salvei". */
  saveIdea(idea: NewIdea): Promise<Idea>;
  findIdeas(query: { projectId?: Id; text?: string; status?: IdeaStatus; limit?: number }): Promise<Idea[]>;
  setIdeaStatus(id: Id, status: IdeaStatus): Promise<void>;

  upsertProject(project: Project): Promise<void>;
  getProject(id: Id): Promise<Project | null>;
  /** Acha projeto pelo nome falado ("abstrike", "Soaken"...). */
  findProjectByName(name: string): Promise<Project | null>;
  listProjects(): Promise<Project[]>;

  createTask(task: Omit<Task, 'createdAt' | 'updatedAt'>): Promise<Task>;
  getTask(id: Id): Promise<Task | null>;
  listTasks(filter?: { status?: TaskStatus[]; projectId?: Id }): Promise<Task[]>;
  /** Muda status e grava o evento 'status-changed' na mesma transação. */
  updateTaskStatus(id: Id, status: TaskStatus, source: string, message: string): Promise<Task>;
  updateTask(id: Id, patch: Partial<Pick<Task, 'worktreePath' | 'branch' | 'baseRef' | 'resultSummary' | 'approvalState'>>): Promise<Task>;
  addTaskEvent(event: { taskId: Id; eventType: TaskEventType; source: string; message: string; artifactRef?: string | null }): Promise<TaskEvent>;
  listTaskEvents(taskId: Id): Promise<TaskEvent[]>;

  requestApproval(taskId: Id, action: ApprovalAction, scope: string): Promise<Approval>;
  decideApproval(id: Id, decision: 'approved' | 'rejected'): Promise<Approval>;
  listPendingApprovals(): Promise<Approval[]>;

  /** Grava a decisão do roteador (modelo, motivo, cota premium) e o que foi respondido. */
  logRoute(entry: { text: string; language: Language; decision: RouteDecision; reply?: string; taskId?: Id | null }): Promise<void>;
  /** Últimos pedidos e quem respondeu o quê, do mais antigo para o mais novo: base do contexto compartilhado. */
  recentActivity(limit: number): Promise<ActivityEntry[]>;

  close(): Promise<void>;
}

// ---------- Worktrees e agentes (blueprint §7 e §8) — dono: Codex ----------

export interface Worktree {
  path: string;
  branch: string;
  baseRef: string;
}

export interface DiffReport {
  baseRef: string;
  headRef: string;
  changedFiles: { path: string; status: 'added' | 'modified' | 'deleted' | 'renamed' }[];
  patch: string;
}

export interface WorktreeManager {
  /** Cria branch agent/<agente>/<taskId> e worktree fora do repo do dono. Nunca toca na worktree do dono. */
  create(project: Project, taskId: Id, agent: AgentName): Promise<Worktree>;
  diff(worktree: Worktree): Promise<DiffReport>;
  /** Verifica conflito com o branch padrão sem mexer nele. */
  checkMerge(project: Project, worktree: Worktree): Promise<{ clean: boolean; conflicts: string[] }>;
  /** Só é chamado com aprovação 'merge' aprovada. */
  merge(project: Project, worktree: Worktree, approval: Approval): Promise<{ merged: boolean; message: string }>;
  /** Apaga só a worktree/branch do agente. */
  discard(project: Project, worktree: Worktree): Promise<void>;
}

export interface AgentRun {
  taskId: Id;
  agent: AgentName;
  pid: number | null;
  /** Resolve quando o processo termina. */
  done: Promise<{ exitCode: number | null; summary: string }>;
}

export interface CodingAgent {
  readonly name: AgentName;
  /** Checa se a CLI existe e está logada pelo caminho oficial. */
  available(): Promise<{ ok: boolean; detail: string }>;
  start(task: Task, worktree: Worktree, prompt: string): Promise<AgentRun>;
  /** Mata o processo de verdade; retorna se conseguiu. */
  cancel(run: AgentRun): Promise<{ killed: boolean; detail: string }>;
}

export interface JobScheduler {
  enqueue(taskId: Id): Promise<void>;
  cancel(taskId: Id): Promise<{ killed: boolean; detail: string }>;
  running(): Id[];
  /** No início: acha processos/worktrees órfãos e marca tarefas; nunca reinicia sozinho o que não é seguro. */
  reconcile(): Promise<void>;
}
