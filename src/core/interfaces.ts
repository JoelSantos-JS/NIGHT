// Contratos entre módulos (docs/PLANO_INICIAL.md §4).
// Cada módulo implementa a sua interface; ninguém importa a implementação do outro direto.
// Mudar este arquivo exige revisão do outro agente.

import type {
  AgentName, Approval, ApprovalAction, Id, Idea, IdeaStatus, Job, JobEvent, JobEventType, JobKind, JobStatus,
  Language, Project, Task, TaskEvent, TaskEventType, TaskStatus,
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
  /** O áudio tinha ruído forte e foi limpo antes de transcrever. */
  denoised?: boolean;
  /** Não parecia a voz do dono (vídeo tocando, outra pessoa): semelhança com o perfil; nada foi transcrito. */
  otherVoice?: number;
  /** Quem transcreveu (ex.: 'groq:whisper-large-v3' ou 'small' local). */
  engine?: string;
  /** Onde a fala foi salva (só com NIGHT_SAVE_AUDIO_DIR, para calibragem). */
  audioPath?: string;
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
  /** "Roda o AWS Prep pra mim": acha a pasta, diz como vai rodar e só roda depois do "pode". */
  | { kind: 'run-project'; target: string }
  /** "Procura a pasta X no desktop": só procura e cadastra como projeto. */
  | { kind: 'find-folder'; target: string }
  /** "Mostra as mudanças" (blueprint §6). */
  | { kind: 'show-diff'; taskHint: string | null }
  /** "A pasta do projeto X é C:\..." — liga o projeto a um repositório. */
  | { kind: 'set-project-path'; projectHint: string | null; path: string }
  | { kind: 'approval'; decision: 'approve' | 'reject'; taskHint: string | null }
  | { kind: 'cancel'; taskHint: string | null }
  /** "Vasculha ofertas de X", "roda o radar de X": registra e começa o trabalho quando há trabalhador. */
  | { kind: 'radar-search'; query: string }
  /** "Cria um vídeo sobre X": registra e começa o trabalho de vídeo quando há trabalhador. */
  | { kind: 'video-create'; topic: string }
  /** "Como está o vídeo 3?", "o que o radar achou?", "status do radar 2". Sem número = resumo do tipo. */
  | { kind: 'job-status'; jobKind: 'radar' | 'video' | null; number: number | null }
  /** "Cancela o vídeo 3": só por regra e só com número; sem número cai no cancel de tarefas de código. */
  | { kind: 'job-cancel'; jobKind: 'radar' | 'video'; number: number }
  /**
   * "Continua o vídeo 3", "retoma o radar 2": retoma um trabalho que ficou esperando ou
   * parou com falha recuperável. Só por regra e só com número.
   */
  | { kind: 'job-resume'; jobKind: 'radar' | 'video'; number: number }
  /** "A página da oferta 2 é https://…", "o checkout da oferta 2 é …", "as imagens da oferta 2 são …" (L03/M05). */
  | { kind: 'offer-link'; number: number | null; field: 'pagina' | 'checkout' | 'imagens'; urls: string[] }
  /** "Gera o produto da oferta 2": PDFs, bônus e página de vendas (L01–L03, L07). */
  | { kind: 'product-create'; number: number | null }
  /** "Monta a campanha da oferta 2": só o rascunho, sem chamar a Meta (M03). */
  | { kind: 'campaign-draft'; number: number | null }
  /**
   * "Aprovo montar a campanha da oferta 2 com R$ 20 por dia": cria PAUSADA na Meta (M04).
   * Só por regra, com número e valor; ativar continua com o Joel no Gerenciador.
   */
  | { kind: 'campaign-build'; number: number | null; budgetBRL: number | null }
  /**
   * "Como está a campanha da oferta 2?": lê o desempenho pelo MCP da Meta, só leitura (M07).
   * Sem número, o coordenador pergunta qual oferta; nada é estimado além do que a Meta devolveu.
   */
  | { kind: 'campaign-status'; number: number | null }
  /**
   * "Aprova a oferta 2". number null = falou a oferta sem número: o coordenador pede o número
   * e NADA é decidido. Aprovar aqui não publica, não gasta e não faz merge.
   * ambiguous = a frase também fala de merge: o coordenador pergunta qual dos dois, sem gravar nada.
   */
  | { kind: 'offer-decision'; number: number | null; decision: 'approve' | 'reject'; ambiguous?: boolean }
  /** "Aprova o vídeo 3". Mesma regra de segurança da oferta: número null não decide nada. */
  | { kind: 'video-decision'; number: number | null; decision: 'approve' | 'reject'; ambiguous?: boolean }
  /** "Mostra a oferta 3": resumo curto para voz e o contexto completo na tela. */
  | { kind: 'offer-show'; number: number }
  /**
   * Pergunta sobre uma oferta ("por que a oferta 3 é boa?", "quais as fontes da oferta 2?").
   * Sem número, o coordenador usa a última oferta mostrada nesta conversa.
   */
  | { kind: 'offer-ask'; number: number | null; question: string }
  /** "Ajusta o público da oferta 3 para mães de primeira viagem": cria uma versão nova, não sobrescreve. */
  | { kind: 'offer-edit'; number: number | null; campo: OfferEditField; valor: string }
  | { kind: 'stop-speaking' };

/** Campos da proposta que o Joel pode corrigir por voz. */
export type OfferEditField = 'publico' | 'promessa' | 'precoHipotese' | 'nome' | 'diferencial';

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

/** Tarefa nova: o cartão é opcional, porque pedido solto continua virando tarefa. */
export type NewTask = Omit<Task, 'createdAt' | 'updatedAt' | 'cardId' | 'cardRevision' | 'cardHash'> & {
  cardId?: string | null;
  cardRevision?: number | null;
  cardHash?: string | null;
};

/** Pedido de trabalho (F01): o job em si nasce sempre em 'queued'. */
export interface NewJob {
  kind: JobKind;
  /** 'voz', 'texto', 'rotina'... */
  origin: string;
  /** Mesma chave = mesmo trabalho: o pedido repetido devolve o job que já existe. */
  idempotencyKey: string;
  params?: Record<string, unknown>;
  limits?: Record<string, unknown>;
  taskId?: Id | null;
}

export interface JobTransitionOptions {
  source: string;
  message: string;
  /** Se informada e diferente da versão atual, recusa: alguém leu estado velho. */
  expectedVersion?: number;
  error?: string | null;
  /** Estado 'waiting': o que falta (ex.: 'flow'). Fora dele, fica null. */
  waitingFor?: string | null;
  /** Referência de artefatos (ex.: 'artefatos:<id>'); sem ela, mantém a anterior. */
  artifactRef?: string;
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

  /** Campos do cartão são opcionais: quem cria tarefa hoje não precisa informá-los. */
  createTask(task: NewTask): Promise<Task>;
  getTask(id: Id): Promise<Task | null>;
  listTasks(filter?: { status?: TaskStatus[]; projectId?: Id }): Promise<Task[]>;
  /** Muda status e grava o evento 'status-changed' na mesma transação. */
  updateTaskStatus(id: Id, status: TaskStatus, source: string, message: string): Promise<Task>;
  updateTask(id: Id, patch: Partial<Pick<Task, 'worktreePath' | 'branch' | 'baseRef' | 'resultSummary' | 'approvalState'>>): Promise<Task>;
  addTaskEvent(event: { taskId: Id; eventType: TaskEventType; source: string; message: string; artifactRef?: string | null }): Promise<TaskEvent>;
  listTaskEvents(taskId: Id): Promise<TaskEvent[]>;

  /** Mesma idempotencyKey devolve o job existente com created=false, sem criar outro. */
  createJob(input: NewJob): Promise<{ job: Job; created: boolean }>;
  getJob(id: Id): Promise<Job | null>;
  /** Acha pelo número falado dentro do tipo: "vídeo 3" = kind 'video', number 3. */
  getJobByNumber(kind: JobKind, number: number): Promise<Job | null>;
  listJobs(filter?: { kind?: JobKind; status?: JobStatus[] }): Promise<Job[]>;
  /** Muda o estado e grava o evento na mesma transação. Recusa transição inválida ou versão errada. */
  transitionJob(id: Id, to: JobStatus, opts: JobTransitionOptions): Promise<Job>;
  /** Evento avulso (ex.: decisão do dono sobre oferta/vídeo pronta). Não muda o estado. */
  addJobEvent(id: Id, event: { eventType: JobEventType; source: string; message: string; effectKey?: string | null }): Promise<JobEvent>;
  /** Registra um efeito externo uma única vez por chave; repetir devolve recorded=false. */
  recordJobEffect(id: Id, effectKey: string, source: string, message: string): Promise<{ recorded: boolean }>;
  hasJobEffect(id: Id, effectKey: string): Promise<boolean>;
  listJobEvents(id: Id): Promise<JobEvent[]>;

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
