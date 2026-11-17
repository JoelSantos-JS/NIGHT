// Tipos do domínio do Night (blueprint §8 e §13).
// Mudar este arquivo exige revisão do outro agente (docs/PLANO_INICIAL.md §4).

export type Id = string;
/** Data/hora em ISO 8601, UTC. */
export type IsoDate = string;
export type Language = 'en' | 'pt-BR';
// DeepSeek entrou como agente de código (D12/H01): implementa na worktree e é revisado pelo Claude.
export type AgentName = 'claude' | 'codex' | 'deepseek';

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
  /** Cartão aprovado que originou a tarefa (S04); null quando o pedido foi solto. */
  cardId: string | null;
  /** Revisão do cartão importado: mudar o conteúdo exige subir este número. */
  cardRevision: number | null;
  /** Hash do conteúdo exato do cartão: prova qual versão o agente recebeu. */
  cardHash: string | null;
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

// ---------- Trabalhos (jobs): coding, radar e vídeo (F01/F02) ----------

/** Tipo do trabalho. Cada um mostra status separado; as tarefas de código continuam em Task. */
export type JobKind = 'coding' | 'radar' | 'video' | 'lowticket' | 'campanha';

export const JOB_STATUSES = [
  'queued',
  'running',
  'waiting',
  'retryable',
  'succeeded',
  'failed',
  'cancelled',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** Estado final: não sai mais dele; 'retryable' é falha recuperável, 'failed' é final. */
export const FINAL_JOB_STATUSES: readonly JobStatus[] = ['succeeded', 'failed', 'cancelled'];

/** De onde cada estado pode ir. Estado final não aceita mais nada. */
export const JOB_TRANSITIONS: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  queued: ['running', 'cancelled'],
  running: ['waiting', 'retryable', 'succeeded', 'failed', 'cancelled'],
  waiting: ['running', 'cancelled', 'failed'],
  retryable: ['running', 'failed', 'cancelled'],
  succeeded: [],
  failed: [],
  cancelled: [],
};

export function canTransition(from: JobStatus, to: JobStatus): boolean {
  return JOB_TRANSITIONS[from].includes(to);
}

export interface Job {
  id: Id;
  kind: JobKind;
  /** Número falável dentro do tipo ("vídeo 3", "oferta 2"): começa em 1 por tipo. */
  number: number;
  /** 'voz', 'texto', 'rotina'... livre: é o pedido, não o tipo. */
  origin: string;
  /** Mesma chave = mesmo trabalho: um pedido repetido não cria outro. */
  idempotencyKey: string;
  params: Record<string, unknown>;
  limits: Record<string, unknown>;
  status: JobStatus;
  /** O que falta para sair de 'waiting' (ex.: 'flow'); null quando não espera nada. */
  waitingFor: string | null;
  /** Sobe a cada transição: quem leu antes de mudar pode recusar update atrasado. */
  version: number;
  /** Tarefa de código ligada, quando kind = 'coding'. */
  taskId: Id | null;
  artifactRef: string | null;
  error: string | null;
  createdAt: IsoDate;
  updatedAt: IsoDate;
}

export type JobEventType = 'status-changed' | 'effect-confirmed' | 'progress' | 'error';

export interface JobEvent {
  id: Id;
  jobId: Id;
  timestamp: IsoDate;
  eventType: JobEventType;
  fromStatus: JobStatus | null;
  toStatus: JobStatus | null;
  /** Quem gerou: 'scheduler', 'worker', 'owner'... */
  source: string;
  message: string;
  /** Chave do efeito externo já confirmado; única por trabalho para não repetir. */
  effectKey: string | null;
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
