// Tipos do domínio do Night (blueprint §8 e §13).
// Mudar este arquivo exige revisão do outro agente (docs/PLANO_INICIAL.md §4).

export type Id = string;
/** Data/hora em ISO 8601, UTC. */
export type IsoDate = string;
export type Language = 'en' | 'pt-BR';
export type AgentName = 'claude' | 'codex';

export interface Project {
  id: Id;
  name: string;
  description: string;
  repoPath: string | null;
  defaultBranch: string | null;
  /** Caminhos (relativos ao repo) que agentes podem ler/editar. Vazio = nada. */
  allowedPaths: string[];
  status: 'active' | 'paused' | 'archived';
}

export type IdeaStatus = 'inbox' | 'reviewed' | 'promoted' | 'discarded';

export interface Idea {
  id: Id;
  projectId: Id | null;
  title: string;
  /** Texto exatamente como foi falado/digitado. */
  transcript: string;
  notes: string;
  tags: string[];
  createdAt: IsoDate;
  status: IdeaStatus;
}

/** Ciclo de vida da tarefa (blueprint §8). */
export const TASK_STATUSES = [
  'captured',
  'queued',
  'planning',
  'running',
  'testing',
  'review-ready',
  'awaiting-approval',
  'accepted',
  'rejected',
  'failed',
  'cancelled',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const FINAL_TASK_STATUSES: readonly TaskStatus[] = ['accepted', 'rejected', 'failed', 'cancelled'];

export type ApprovalState = 'none' | 'pending' | 'approved' | 'rejected';

export interface Task {
  id: Id;
  projectId: Id;
  objective: string;
  /** Escopo aprovado: o que o agente pode tocar e o que não pode. */
  scope: string;
  status: TaskStatus;
  primaryAgent: AgentName;
  reviewAgent: AgentName | null;
  worktreePath: string | null;
  branch: string | null;
  /** Commit de onde a worktree saiu: é o que o agente "viu". */
  baseRef: string | null;
  createdAt: IsoDate;
  updatedAt: IsoDate;
  resultSummary: string | null;
  approvalState: ApprovalState;
}

export type TaskEventType =
  | 'status-changed'
  | 'progress'
  | 'agent-output'
  | 'test-result'
  | 'error'
  | 'cancel-requested'
  | 'cancel-result';

export interface TaskEvent {
  id: Id;
  taskId: Id;
  timestamp: IsoDate;
  eventType: TaskEventType;
  /** Quem gerou: 'scheduler', 'claude', 'codex', 'owner', 'tests'... */
  source: string;
  message: string;
  /** Caminho de um arquivo de log/diff guardado no disco. */
  artifactRef: string | null;
}

export type ApprovalAction = 'merge' | 'deploy' | 'publish' | 'spend' | 'delete' | 'network';

export interface Approval {
  id: Id;
  taskId: Id;
  action: ApprovalAction;
  scope: string;
  requestedAt: IsoDate;
  decision: 'pending' | 'approved' | 'rejected';
  decidedAt: IsoDate | null;
}

export interface Conversation {
  id: Id;
  language: Language;
  summary: string;
  turns: ConversationTurn[];
  /** Dias para guardar o texto; null = até o dono apagar. */
  retentionDays: number | null;
}

export interface ConversationTurn {
  role: 'owner' | 'night';
  text: string;
  at: IsoDate;
}
