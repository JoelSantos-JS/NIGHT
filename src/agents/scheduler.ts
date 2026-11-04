// Executor de tarefas de código (blueprint §8). Quem guarda o estado é o banco, não o modelo:
// todo passo vira status/evento em `tasks`/`task_events`, e o "o que tá rodando?" lê de lá.
//
// Ciclo: queued → planning (worktree) → running (agente) → testing (diff + revisão do outro agente)
//        → review-ready → awaiting-approval → accepted (merge) / rejected (descarta) / failed / cancelled
// Uma tarefa por vez. Cancelar mata o processo de verdade. Ao reiniciar, nada que estava rodando volta
// sozinho: vira `failed` com o motivo (blueprint §8, "resume only tasks that are safe").

import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { AgentRun, CodingAgent, DiffReport, Memory, WorktreeManager, Worktree } from '../core/interfaces.ts';
import type { AgentName, Language, Task, TaskStatus } from '../core/types.ts';
import { FINAL_TASK_STATUSES } from '../core/types.ts';
import { codingPrompt, reviewPrompt, type Reviewer, type RunOutcome } from './coding.ts';
import { buildSharedContext } from './shared-context.ts';

export interface TaskUpdate {
  task: Task;
  /** Frase curta, já pronta para ser falada. */
  message: string;
  /** Mudança que o dono precisa saber agora (terminou, falhou, precisa de aprovação). */
  important: boolean;
}

export interface ApprovalResult {
  ok: boolean;
  message: string;
}

const RUNNING: TaskStatus[] = ['planning', 'running', 'testing'];
const other = (a: AgentName): AgentName => (a === 'claude' ? 'codex' : 'claude');

export class TaskScheduler extends EventEmitter<{ update: [TaskUpdate] }> {
  private queue: string[] = [];
  private busy = false;
  private runs = new Map<string, { run: AgentRun; agent: CodingAgent }>();
  private cancelRequested = new Set<string>();
  /** Revisões em andamento: cancelar ou fechar o Night mata o revisor também (2ª revisão do Codex). */
  private reviews = new Map<string, AbortController>();

  constructor(
    private readonly memory: Memory,
    private readonly worktrees: WorktreeManager,
    private readonly agents: Record<AgentName, CodingAgent>,
    private readonly reviewers: Partial<Record<AgentName, Reviewer>> = {},
    private readonly language: Language = 'pt-BR',
  ) {
    super();
  }

  running(): string[] {
    return [...this.runs.keys()];
  }

  /** Põe na fila e começa se estiver livre. Não espera terminar. */
  async enqueue(taskId: string): Promise<void> {
    const task = await this.memory.getTask(taskId);
    if (!task) throw new Error(`tarefa ${taskId} não existe`);
    if (task.status !== 'queued') await this.setStatus(task, 'queued', 'na fila');
    this.queue.push(taskId);
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.busy) return;
    const next = this.queue.shift();
    if (!next) return;
    this.busy = true;
    try {
      await this.execute(next);
    } catch (err) {
      const task = await this.memory.getTask(next);
      if (task && !FINAL_TASK_STATUSES.includes(task.status)) {
        await this.fail(task, `erro inesperado: ${(err as Error).message}`);
      }
    } finally {
      this.busy = false;
      void this.pump();
    }
  }

  private async execute(taskId: string): Promise<void> {
    let task = (await this.memory.getTask(taskId))!;
    if (task.status !== 'queued') return; // cancelada enquanto esperava
    const project = await this.memory.getProject(task.projectId);
    if (!project?.repoPath) {
      return this.fail(task, `o projeto ${project?.name ?? task.projectId} não tem pasta de repositório cadastrada`);
    }
    const agent = this.agents[task.primaryAgent];
    const ok = await agent.available();
    if (!ok.ok) return this.fail(task, `o ${task.primaryAgent} não está disponível: ${ok.detail}`);

    // 1. worktree própria
    task = await this.setStatus(task, 'planning', 'criando a worktree');
    const wt = await this.worktrees.create(project, task.id, task.primaryAgent);
    task = await this.memory.updateTask(task.id, { worktreePath: wt.path, branch: wt.branch, baseRef: wt.baseRef });
    await this.event(task, 'progress', 'scheduler', `worktree ${wt.path} na branch ${wt.branch}, a partir de ${wt.baseRef.slice(0, 12)}`);
    if (this.cancelRequested.has(task.id)) return this.cancelled(task, wt, 'cancelada antes de começar');

    // 2. agente trabalha
    const context = await buildSharedContext(this.memory, `${task.primaryAgent}:código`, this.language);
    // Cancelado enquanto criava a worktree ou montava o contexto: o agente nem começa.
    if (this.cancelRequested.has(task.id)) return this.cancelled(task, wt, 'cancelada antes de começar');
    task = await this.setStatus(task, 'running', `o ${task.primaryAgent} começou a trabalhar`, true);
    const run = await agent.start(task, wt, codingPrompt(task, wt, context));
    this.runs.set(task.id, { run, agent });
    await this.event(task, 'progress', task.primaryAgent, `processo ${run.pid ?? '?'} rodando`);
    let outcome: RunOutcome;
    try {
      outcome = (await run.done) as RunOutcome;
    } finally {
      this.runs.delete(task.id);
    }
    await this.event(task, 'agent-output', task.primaryAgent, outcome.summary.slice(0, 4000));
    if (this.cancelRequested.has(task.id)) return this.cancelled(task, wt, 'cancelada pelo dono');
    if (outcome.quota) return this.fail(task, `o ${task.primaryAgent} bateu no limite de uso do plano`, wt);
    if (outcome.killed) return this.fail(task, `o ${task.primaryAgent} passou do tempo máximo e foi parado`, wt);
    if (outcome.exitCode !== 0) return this.fail(task, `o ${task.primaryAgent} saiu com erro: ${outcome.summary.slice(0, 200)}`, wt);

    // 3. o que mudou + revisão do outro agente
    task = await this.setStatus(task, 'testing', 'conferindo as mudanças');
    const diff = await this.worktrees.diff(wt);
    await this.event(task, 'progress', 'scheduler', `${diff.changedFiles.length} arquivo(s) mudado(s)`);
    if (diff.changedFiles.length === 0) {
      return this.fail(task, `o ${task.primaryAgent} terminou sem mudar nenhum arquivo. Disse: ${outcome.summary.slice(0, 200)}`, wt);
    }
    let review = '';
    const reviewer = task.reviewAgent ? this.reviewers[task.reviewAgent] : undefined;
    if (reviewer) {
      try {
        const ctx = await buildSharedContext(this.memory, `${reviewer.name}:revisão`, this.language);
        const abort = new AbortController();
        this.reviews.set(task.id, abort);
        try {
          review = await reviewer.review(wt, reviewPrompt(task, wt, task.primaryAgent, outcome.summary, diffStat(diff), ctx), abort.signal);
        } finally {
          this.reviews.delete(task.id);
        }
        await this.event(task, 'agent-output', reviewer.name, `revisão: ${review.slice(0, 4000)}`);
      } catch (err) {
        review = `(a revisão do ${reviewer.name} falhou: ${(err as Error).message.slice(0, 150)})`;
        await this.event(task, 'error', reviewer.name, review);
      }
      // O revisor deveria só ler. Se algo mudou (ex.: um teste que escreve arquivo), não dá para confiar no diff.
      const after = await this.worktrees.diff(wt);
      if (after.patch !== diff.patch) {
        return this.fail(task, `os arquivos mudaram durante a revisão do ${reviewer.name}; confira a worktree antes de pedir de novo`, wt);
      }
    }
    if (this.cancelRequested.has(task.id)) return this.cancelled(task, wt, 'cancelada durante a revisão');
    const conflicts = await this.worktrees.checkMerge(project, wt);
    if (!conflicts.clean) await this.event(task, 'progress', 'scheduler', `conflito com ${project.defaultBranch ?? 'o branch padrão'}: ${conflicts.conflicts.join(', ')}`);

    // 4. pede aprovação
    const summary = [
      `${task.primaryAgent}: ${outcome.summary}`,
      review && `revisão (${reviewer!.name}): ${review}`,
      !conflicts.clean && `conflito em: ${conflicts.conflicts.join(', ')}`,
    ].filter(Boolean).join('\n\n');
    task = await this.memory.updateTask(task.id, { resultSummary: summary });
    const verdict = /VEREDITO:\s*corrigir/i.test(review) ? `O ${reviewer!.name} revisou e pediu correção.` : review ? `O ${reviewer!.name} revisou e aprovou.` : '';
    // Abrir a aprovação é atômico em relação a cancel/approve/reject da mesma tarefa (2ª revisão do Codex).
    await this.exclusive(task.id, async () => {
      if (this.cancelRequested.has(task.id)) return this.cancelled(task, wt, 'cancelada antes de pedir aprovação');
      task = await this.setStatus(task, 'review-ready', 'pronta para revisão');
      await this.requestMergeApproval(task, wt, project.defaultBranch);
      await this.setStatus(task, 'awaiting-approval',
        `A tarefa ${task.id} terminou: ${diff.changedFiles.length} arquivo${diff.changedFiles.length > 1 ? 's' : ''} mudado${diff.changedFiles.length > 1 ? 's' : ''}. ${verdict} ${conflicts.clean ? '' : 'Tem conflito com o branch principal. '}Quer aprovar ou descartar?`.replace(/\s+/g, ' ').trim(),
        true);
    });
  }

  /** Aprova: faz o merge (só se não tiver conflito e a pasta do dono estiver limpa). */
  approve(taskId: string): Promise<ApprovalResult> {
    return this.exclusive(taskId, async () => {
      const { task, project, wt, approval } = await this.pendingFor(taskId);
      // O que vai entrar tem que ser exatamente o que foi mostrado e revisado.
      const now = fingerprint((await this.worktrees.diff(wt)).patch);
      if (!approval.scope.endsWith(`#${now}`)) {
        // Não abre pedido novo: o código novo não foi revisado por ninguém (2ª revisão do Codex, 04/11).
        await this.memory.decideApproval(approval.id, 'rejected');
        await this.fail(task, 'a worktree mudou depois da revisão; recusei o merge. A worktree ficou para você conferir; peça a tarefa de novo se quiser', wt);
        return { ok: false, message: `Não fiz o merge: a tarefa ${task.id} mudou depois que foi revisada, então ninguém revisou o que está lá agora. Marquei como falha; peça de novo se quiser.` };
      }
      const decided = await this.memory.decideApproval(approval.id, 'approved');
      const r = await this.worktrees.merge(project, wt, decided);
      if (!r.merged) {
        // A aprovação foi usada; volta para revisão com um pedido novo, para tentar de novo depois.
        await this.event(task, 'error', 'scheduler', `merge não feito: ${r.message}`);
        await this.setStatus(task, 'review-ready', `merge não feito: ${r.message}`);
        await this.requestMergeApproval(await this.reload(task), wt, project.defaultBranch);
        await this.setStatus(await this.reload(task), 'awaiting-approval', 'esperando nova aprovação');
        return { ok: false, message: `Não fiz o merge: ${r.message}` };
      }
      await this.setStatus(task, 'accepted', `merge feito: ${r.message}`, true);
      try { await this.worktrees.discard(project, wt); } catch (err) {
        await this.event(task, 'error', 'scheduler', `worktree não apagada: ${(err as Error).message}`);
      }
      return { ok: true, message: `Pronto, juntei a tarefa ${task.id} no ${project.defaultBranch ?? 'branch principal'}.` };
    });
  }

  /** Rejeita: apaga só a worktree e a branch do agente. O branch principal não muda. */
  reject(taskId: string): Promise<ApprovalResult> {
    return this.exclusive(taskId, async () => {
      const { task, project, wt, approval } = await this.pendingFor(taskId);
      await this.memory.decideApproval(approval.id, 'rejected');
      await this.worktrees.discard(project, wt);
      await this.setStatus(task, 'rejected', 'descartada pelo dono; o branch principal não mudou', true);
      return { ok: true, message: `Descartei a tarefa ${task.id}. Nada mudou no projeto.` };
    });
  }

  /** Pede aprovação de merge guardando a "impressão digital" do diff que o dono vai ver. */
  private async requestMergeApproval(task: Task, wt: Worktree, target: string | null): Promise<void> {
    const fp = fingerprint((await this.worktrees.diff(wt)).patch);
    await this.memory.requestApproval(task.id, 'merge', `${wt.branch} → ${target ?? 'HEAD'} #${fp}`);
  }

  /** Aprovar, rejeitar e cancelar a mesma tarefa nunca rodam ao mesmo tempo (revisão do Codex, 04/11). */
  private locks = new Map<string, Promise<unknown>>();
  private exclusive<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(taskId) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    this.locks.set(taskId, next);
    void next.finally(() => { if (this.locks.get(taskId) === next) this.locks.delete(taskId); }).catch(() => {});
    return next;
  }

  /** Resumo do que mudou (para "mostra as mudanças"). */
  async changes(taskId: string): Promise<{ task: Task; diff: DiffReport }> {
    const task = await this.memory.getTask(taskId);
    if (!task?.worktreePath || !task.branch || !task.baseRef) throw new Error(`a tarefa ${taskId} não tem worktree`);
    const diff = await this.worktrees.diff({ path: task.worktreePath, branch: task.branch, baseRef: task.baseRef });
    return { task, diff };
  }

  cancel(taskId: string): Promise<{ killed: boolean; detail: string }> {
    return this.exclusive(taskId, () => this.cancelNow(taskId));
  }

  /**
   * Ao fechar o Night: mata os agentes que estão rodando e espera eles saírem, ANTES de soltar a trava.
   * Senão outra instância assumiria e marcaria como falha uma tarefa com processo ainda vivo (revisão do Codex).
   */
  async shutdown(timeoutMs = 10_000): Promise<void> {
    this.queue = [];
    const live = [...this.runs.entries()];
    for (const [taskId, { agent, run }] of live) {
      this.cancelRequested.add(taskId);
      await agent.cancel(run).catch(() => {});
    }
    for (const [taskId, abort] of this.reviews) {
      this.cancelRequested.add(taskId);
      abort.abort();
    }
    const deadline = new Promise((r) => setTimeout(r, timeoutMs));
    await Promise.race([Promise.all(live.map(([, { run }]) => run.done.catch(() => {}))), deadline]);
    // Dá tempo do execute() gravar o "cancelled" antes de o banco fechar.
    await Promise.race([this.idle(), deadline]);
  }

  private idle(): Promise<void> {
    return new Promise((resolve) => {
      const check = () => (this.busy ? setTimeout(check, 50) : resolve());
      check();
    });
  }

  private async cancelNow(taskId: string): Promise<{ killed: boolean; detail: string }> {
    const task = await this.memory.getTask(taskId);
    if (!task) return { killed: false, detail: `tarefa ${taskId} não existe` };
    if (FINAL_TASK_STATUSES.includes(task.status)) return { killed: false, detail: `a tarefa já estava ${task.status}` };
    await this.event(task, 'cancel-requested', 'owner', 'pedido de cancelamento');
    const live = this.runs.get(taskId);
    if (live) {
      this.cancelRequested.add(taskId);
      const r = await live.agent.cancel(live.run);
      await this.event(task, 'cancel-result', 'scheduler', r.detail);
      return r; // o execute() vê o pedido e marca cancelled quando o processo morrer
    }
    if (RUNNING.includes(task.status)) {
      // Criando a worktree ou na revisão: o execute() confere o pedido no próximo passo e para.
      this.cancelRequested.add(taskId);
      const review = this.reviews.get(taskId);
      if (review) {
        review.abort(); // mata o processo do revisor agora
        return { killed: true, detail: 'revisor encerrado; a tarefa não vai pedir aprovação' };
      }
      return { killed: true, detail: 'para antes do agente começar' };
    }
    this.queue = this.queue.filter((id) => id !== taskId);
    // Esperando aprovação: o pedido de merge não pode ficar aberto depois de cancelar.
    for (const a of await this.memory.listPendingApprovals()) {
      if (a.taskId === taskId) await this.memory.decideApproval(a.id, 'rejected');
    }
    await this.setStatus(task, 'cancelled', task.status === 'awaiting-approval' ? 'cancelada; o pedido de merge foi recusado' : 'cancelada antes de rodar', true);
    if (task.worktreePath && task.branch && task.baseRef) await this.discardQuietly(task);
    return { killed: true, detail: 'não estava rodando; cancelei' };
  }

  /** No início: o que estava rodando quando o Night fechou vira `failed`. Nada recomeça sozinho. */
  async reconcile(): Promise<Task[]> {
    const stuck = await this.memory.listTasks({ status: RUNNING });
    for (const t of stuck) {
      await this.fail(t, 'o Night foi fechado durante a execução; não recomecei sozinho');
    }
    return stuck;
  }

  // ---------- internos ----------

  private async pendingFor(taskId: string) {
    const task = await this.memory.getTask(taskId);
    if (!task) throw new Error(`tarefa ${taskId} não existe`);
    const approval = (await this.memory.listPendingApprovals()).find((a) => a.taskId === taskId && a.action === 'merge');
    if (!approval) throw new Error(`a tarefa ${taskId} não está esperando aprovação`);
    const project = await this.memory.getProject(task.projectId);
    if (!project || !task.worktreePath || !task.branch || !task.baseRef) throw new Error(`a tarefa ${taskId} não tem worktree`);
    return { task, project, approval, wt: { path: task.worktreePath, branch: task.branch, baseRef: task.baseRef } as Worktree };
  }

  private reload(task: Task): Promise<Task> {
    return this.memory.getTask(task.id) as Promise<Task>;
  }

  private async setStatus(task: Task, status: TaskStatus, message: string, important = false): Promise<Task> {
    const updated = await this.memory.updateTaskStatus(task.id, status, 'scheduler', message);
    this.emit('update', { task: updated, message, important });
    return updated;
  }

  private event(task: Task, type: Parameters<Memory['addTaskEvent']>[0]['eventType'], source: string, message: string) {
    return this.memory.addTaskEvent({ taskId: task.id, eventType: type, source, message });
  }

  private async fail(task: Task, why: string, wt?: Worktree): Promise<void> {
    await this.memory.updateTask(task.id, { resultSummary: why });
    await this.setStatus(task, 'failed', `A tarefa ${task.id} falhou: ${why}.`, true);
    // A worktree fica, para o dono poder olhar o que o agente deixou; "descarta" apaga depois.
    if (wt) await this.event(task, 'progress', 'scheduler', `worktree mantida para consulta: ${wt.path}`);
  }

  private async cancelled(task: Task, wt: Worktree, why: string): Promise<void> {
    this.cancelRequested.delete(task.id);
    await this.setStatus(task, 'cancelled', `Cancelei a tarefa ${task.id}: ${why}.`, true);
    await this.discardQuietly({ ...task, worktreePath: wt.path, branch: wt.branch, baseRef: wt.baseRef });
  }

  private async discardQuietly(task: Task): Promise<void> {
    const project = await this.memory.getProject(task.projectId);
    if (!project || !task.worktreePath || !task.branch || !task.baseRef) return;
    try {
      await this.worktrees.discard(project, { path: task.worktreePath, branch: task.branch, baseRef: task.baseRef });
    } catch (err) {
      await this.event(task, 'error', 'scheduler', `worktree não apagada: ${(err as Error).message}`);
    }
  }
}

/** "Impressão digital" do diff: se mudar entre a revisão e o "aprovo", o merge é recusado. */
export function fingerprint(patch: string): string {
  return createHash('sha256').update(patch).digest('hex').slice(0, 16);
}

export function diffStat(diff: DiffReport): string {
  // Nome de arquivo com quebra de linha ou "<tag>" não pode virar instrução no prompt do revisor.
  const clean = (p: string) => p.replace(/[\u0000-\u001f<>]/g, '?');
  return diff.changedFiles.map((f) => `- ${f.status}: ${clean(f.path)}`).join('\n') || '(nada)';
}

export { other as otherAgent };
