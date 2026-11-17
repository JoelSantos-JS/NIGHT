// Executor de tarefas de código (blueprint §8). Quem guarda o estado é o banco, não o modelo:
// todo passo vira status/evento em `tasks`/`task_events`, e o "o que tá rodando?" lê de lá.
//
// Ciclo: queued → planning (worktree) → running (agente) → testing (diff + revisão do outro agente)
//        → review-ready → awaiting-approval → accepted (merge) / rejected (descarta) / failed / cancelled
// Uma tarefa por vez. Cancelar mata o processo de verdade. Ao reiniciar, nada que estava rodando volta
// sozinho: vira `failed` com o motivo (blueprint §8, "resume only tasks that are safe").

import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { decide, type DivergenceParecer } from '../advisor/divergence.ts';
import { getDecisionPoint } from '../advisor/matrix.ts';
import type { Opinion } from '../advisor/opinion.ts';
import type { AdvisorService } from '../advisor/service.ts';
import type { Card } from '../cards/card.ts';
import { cardReference, checkDiffAgainstCard } from '../cards/import.ts';
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
/**
 * Revisor de quem implementou (D12/H01): o autor NUNCA revisa o próprio diff.
 * deepseek → claude (o QA da construção), claude ↔ codex como antes.
 */
const other = (a: AgentName): AgentName => (a === 'deepseek' || a === 'codex' ? 'claude' : 'codex');

/** Nome falado e o que falta para ligar cada agente; a mensagem de erro tem que dizer o que fazer. */
const AGENT_LABEL: Readonly<Record<AgentName, string>> = { claude: 'Claude', codex: 'Codex', deepseek: 'DeepSeek' };
const AGENT_SETUP: Readonly<Record<AgentName, string>> = {
  claude: 'a CLI do Claude Code não está instalada ou não está logada',
  codex: 'a CLI do Codex não está instalada ou não está logada',
  deepseek: 'falta a chave da API DeepSeek (defina DEEPSEEK_API_KEY ou crie ~/.deepseek/api_key)',
};

/**
 * Veredito explícito da revisão (o reviewPrompt pede "VEREDITO: aprovar" ou "VEREDITO: corrigir").
 * O modelo varia caixa, acento e separador ("Veredito - aprovado"), então compara normalizado.
 * Sem essas palavras não há veredito: parecer inconclusivo nunca pode ser falado como aprovação.
 */
export function reviewVerdict(texto: string): 'aprovar' | 'corrigir' | null {
  const t = texto.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  if (/veredito\s*[-–—:=]*\s*corrig/.test(t)) return 'corrigir';
  if (/veredito\s*[-–—:=]*\s*aprov/.test(t)) return 'aprovar';
  return null;
}

/** Revisor de reserva (ex.: DeepSeek): mesma forma do Reviewer, com nome livre para a reserva. */
export interface ReserveReviewer {
  readonly name: string;
  review(worktree: Worktree, prompt: string, signal?: AbortSignal): Promise<string>;
}

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
    /** Só os agentes configurados: pedir um que não existe falha a tarefa com o motivo (D12/H01). */
    private readonly agents: Partial<Record<AgentName, CodingAgent>>,
    private readonly reviewers: Partial<Record<AgentName, Reviewer>> = {},
    private readonly language: Language = 'pt-BR',
    /** Reserva usada só se o revisor principal falhar; nunca revisa o próprio código. */
    private readonly reserveReviewer?: ReserveReviewer,
    /** Parecer do DeepSeek no diff final (D05); opcional para não quebrar quem já monta o scheduler. */
    private readonly advisor?: AdvisorService,
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
    // O autor nunca revisa o próprio diff: sem outro revisor a tarefa não pode ser aprovada por ele mesmo.
    if (task.reviewAgent === task.primaryAgent) {
      return this.fail(task, `o ${AGENT_LABEL[task.primaryAgent]} não pode revisar o próprio código; escolha outro revisor`);
    }
    const project = await this.memory.getProject(task.projectId);
    if (!project?.repoPath) {
      return this.fail(task, `o projeto ${project?.name ?? task.projectId} não tem pasta de repositório cadastrada`);
    }
    const agent = this.agents[task.primaryAgent];
    if (!agent) {
      return this.fail(task, `o ${AGENT_LABEL[task.primaryAgent]} não está configurado: ${AGENT_SETUP[task.primaryAgent]}`);
    }
    const ok = await agent.available();
    if (!ok.ok) return this.fail(task, `o ${AGENT_LABEL[task.primaryAgent]} não está disponível: ${ok.detail}`);

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
    // Texto e estado separados: uma revisão que falhou (ok=false) nunca pode ser anunciada como aprovada.
    const review: { ok: boolean; autor: string | null; texto: string; reservaDo: string | null } = {
      ok: false, autor: null, texto: '', reservaDo: null,
    };
    let reviewFailure = ''; // motivo curto da última falha
    let reviewAttempted: string | null = null; // último revisor chamado (para a mensagem de diff alterado)
    let reviewRan = false;
    const primaryName = task.reviewAgent;

    const runReview = async (name: string, reviewer: { review(w: Worktree, p: string, s?: AbortSignal): Promise<string> }) => {
      const ctx = await buildSharedContext(this.memory, `${name}:revisão`, this.language);
      const abort = new AbortController();
      this.reviews.set(task.id, abort);
      try {
        return await reviewer.review(wt, reviewPrompt(task, wt, task.primaryAgent, outcome.summary, diffStat(diff), ctx), abort.signal);
      } finally {
        this.reviews.delete(task.id);
      }
    };

    if (primaryName) {
      const primary = this.reviewers[primaryName];
      if (primary) {
        reviewRan = true;
        reviewAttempted = primaryName;
        try {
          const texto = (await runReview(primaryName, primary)).trim();
          if (!texto) throw new Error('revisão vazia');
          review.texto = texto;
          review.ok = true;
          review.autor = primaryName;
          await this.event(task, 'agent-output', primaryName, `revisão: ${review.texto.slice(0, 4000)}`);
        } catch (err) {
          reviewFailure = (err as Error).message.slice(0, 150) || 'falhou';
          await this.event(task, 'error', primaryName, `(a revisão do ${primaryName} falhou: ${reviewFailure})`);
        }
      } else {
        reviewFailure = 'revisor não configurado';
        await this.event(task, 'error', primaryName, `(a revisão do ${primaryName} não está configurada)`);
      }
    }

    // Revisor indisponível nunca vira aprovação: tenta a reserva, desde que ela não seja o autor do código.
    const reserve = this.reserveReviewer;
    if (primaryName && !review.ok && reviewFailure && reserve && reserve.name !== task.primaryAgent && !this.cancelRequested.has(task.id)) {
      reviewRan = true;
      reviewAttempted = reserve.name;
      const motivo = reviewFailure;
      try {
        const texto = (await runReview(reserve.name, reserve)).trim();
        if (!texto) throw new Error('revisão vazia');
        review.texto = texto;
        review.ok = true;
        review.autor = reserve.name;
        review.reservaDo = primaryName;
        await this.event(task, 'agent-output', reserve.name,
          `revisão (reserva do ${primaryName}, motivo: ${motivo}): ${review.texto.slice(0, 4000)}`);
      } catch (err) {
        reviewFailure = (err as Error).message.slice(0, 150) || 'falhou';
        await this.event(task, 'error', reserve.name,
          `revisão (reserva do ${primaryName}, motivo: ${motivo}) falhou: ${reviewFailure}`);
      }
    }

    if (reviewRan) {
      // O revisor deveria só ler. Se algo mudou (ex.: um teste que escreve arquivo), não dá para confiar no diff.
      const after = await this.worktrees.diff(wt);
      if (after.patch !== diff.patch) {
        const who = review.autor ?? reviewAttempted ?? primaryName ?? 'revisor';
        return this.fail(task, `os arquivos mudaram durante a revisão do ${who}; confira a worktree antes de pedir de novo`, wt);
      }
    }
    if (this.cancelRequested.has(task.id)) return this.cancelled(task, wt, 'cancelada durante a revisão');

    // D05: parecer do DeepSeek no diff final. Falha de parecer não vira aprovação nem trava a
    // tarefa: fica registrada, e a frase diz que ele não veio.
    let parecer: Opinion | null = null;
    let parecerFalhou: string | null = null;
    if (this.advisor) {
      try {
        const referencia = cardReference(task);
        const consulta = await this.advisor.consult('codigo.diff-final', {
          jobId: task.id,
          dominio: 'codigo',
          fase: 'diff-final',
          objetivo: task.objective,
          pergunta: getDecisionPoint('codigo.diff-final')?.pergunta
            ?? 'O diff final cobre o objetivo e tem teste para o caso de erro?',
          evidencias: [
            { ref: 'diff-stat', origem: 'git diff --stat', conteudo: diffStat(diff), externa: false },
            // Diff cortado: o parecer é sobre o necessário, não o repositório inteiro.
            { ref: 'diff', origem: 'git diff', conteudo: diff.patch.slice(0, 40_000), externa: false },
            { ref: 'resumo-agente', origem: `resumo do ${task.primaryAgent}`, conteudo: outcome.summary, externa: false },
            ...(referencia ? [{ ref: 'cartao', origem: referencia, conteudo: task.scope, externa: false }] : []),
          ],
          testes: 'não rodaram; o scheduler ainda não roda testes',
          outroParecer: review.ok ? review.texto.slice(0, 4000) : undefined,
        });
        if (consulta.status === 'ok' || consulta.status === 'cache') {
          parecer = consulta.opinion;
          await this.event(task, 'agent-output', 'deepseek',
            parecerParaEvento(parecer, task.primaryAgent === 'deepseek'));
        } else if (consulta.status === 'parecer_indisponivel') {
          parecerFalhou = `${consulta.reason}: ${consulta.detail}`;
          await this.event(task, 'error', 'deepseek', `parecer indisponível: ${parecerFalhou}`);
        } else {
          parecerFalhou = consulta.motivo;
          await this.event(task, 'error', 'deepseek', `parecer indisponível: ${parecerFalhou}`);
        }
      } catch (err) {
        parecerFalhou = `erro: ${(err as Error).message}`;
        await this.event(task, 'error', 'deepseek', `parecer indisponível: ${parecerFalhou}`);
      }
    }
    if (this.cancelRequested.has(task.id)) return this.cancelled(task, wt, 'cancelada durante a revisão');

    const conflicts = await this.worktrees.checkMerge(project, wt);
    if (!conflicts.clean) await this.event(task, 'progress', 'scheduler', `conflito com ${project.defaultBranch ?? 'o branch padrão'}: ${conflicts.conflicts.join(', ')}`);

    // 4. pede aprovação
    const shortFailure = (reviewFailure || 'sem motivo').replace(/\s+/g, ' ').slice(0, 120);
    const reviewLine = review.ok
      ? `revisão (${review.autor}${review.reservaDo ? `, reserva do ${review.reservaDo}` : ''}): ${review.texto}`
      : primaryName
        ? `revisão: não saiu (${shortFailure})`
        : '';
    // A tarefa guarda id/revisão/hash do cartão, não o cartão inteiro. O escopo escrito por
    // taskFieldsFromCard traz os arquivos permitidos; sem eles, não há o que conferir.
    const cartaoRef = cardReference(task);
    const arquivosDoCartao = task.cardId !== null ? arquivosPermitidosDoEscopo(task.scope) : null;
    const foraDoCartao = arquivosDoCartao
      ? checkDiffAgainstCard(
        { arquivosPermitidos: arquivosDoCartao } as Card,
        diff.changedFiles.map((f) => f.path),
      ).foraDoCartao
      : [];
    const foraFrase = foraDoCartao.length > 0
      ? `${foraDoCartao.length} arquivo${foraDoCartao.length > 1 ? 's' : ''} fora do cartão: ${foraDoCartao.join(', ')}`
      : '';
    const summary = [
      `${task.primaryAgent}: ${outcome.summary}`,
      cartaoRef,
      foraFrase,
      reviewLine,
      parecer && parecerParaEvento(parecer, task.primaryAgent === 'deepseek'),
      parecerFalhou && `parecer DeepSeek indisponível: ${parecerFalhou}`,
      !conflicts.clean && `conflito em: ${conflicts.conflicts.join(', ')}`,
    ].filter(Boolean).join('\n\n');
    task = await this.memory.updateTask(task.id, { resultSummary: summary });
    // Uma revisão indisponível NUNCA pode ser falada como aprovação; e revisão sem veredito
    // explícito também não, porque o revisor pode ter deixado um parecer inconclusivo.
    const veredito = review.ok ? reviewVerdict(review.texto) : null;
    const baseVerdict = !review.ok
      ? (primaryName ? `A revisão não saiu (${shortFailure}); confira o diff antes de aprovar.` : '')
      : veredito === 'corrigir'
        ? `O ${review.autor} revisou e pediu correção.`
        : veredito === 'aprovar'
          ? `O ${review.autor} revisou e aprovou.`
          : `O ${review.autor} revisou mas não deu veredito claro; leia a revisão antes de aprovar.`;
    const verdictParts = [baseVerdict];
    if (this.advisor) {
      verdictParts.push(parecer
        ? `Parecer DeepSeek: ${parecer.recomendacao}${parecer.contrapontos.length > 0 ? ' — ver contrapontos' : ''}.`
        : `Parecer DeepSeek indisponível${parecerFalhou ? ` (${parecerFalhou.replace(/\s+/g, ' ').slice(0, 120)})` : ''}.`);
      // D05: o scheduler ainda não roda testes, e o merge é do Joel. A regra de divergência só
      // informa o que fazer agora; ela nunca aprova sozinha.
      const pareceres: DivergenceParecer[] = [];
      if (review.ok) {
        const v = reviewVerdict(review.texto);
        pareceres.push({
          autor: review.autor ?? 'revisor',
          recomendacao: v === 'aprovar' ? 'prosseguir' : v === 'corrigir' ? 'revisar' : 'perguntar_joel',
        });
      } else if (reviewAttempted || primaryName) {
        pareceres.push({ autor: review.autor ?? reviewAttempted ?? primaryName ?? 'revisor', recomendacao: 'indisponivel' });
      }
      if (parecer) pareceres.push({ autor: 'deepseek', recomendacao: parecer.recomendacao });
      const decisao = decide({
        testes: 'nao_rodaram',
        fontesObrigatoriasOk: true,
        reservadoAoJoel: true,
        pareceres,
        autorDoTrabalho: task.primaryAgent,
      });
      verdictParts.push(`Testes não rodaram (o scheduler ainda não roda testes); decisão: ${decisao.decisao} — ${decisao.motivo}. A aprovação do merge continua sendo sua.`);
    }
    if (foraFrase) verdictParts.push(`${foraFrase}.`);
    const verdict = verdictParts.filter(Boolean).join(' ');
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

  /**
   * No início: o que estava rodando quando o Night fechou vira `failed`. Nada recomeça sozinho,
   * nenhum diff parcial vira aprovação e nenhuma worktree é apagada (D13).
   */
  async reconcile(): Promise<Task[]> {
    const stuck = await this.memory.listTasks({ status: RUNNING });
    for (const t of stuck) {
      if (!t.worktreePath) {
        await this.fail(t, 'o Night fechou durante a execução; nada foi alterado; pode pedir de novo com segurança');
        continue;
      }
      if (!t.branch || !t.baseRef) {
        // Worktree registrada pela metade não dá para conferir; não invente "nada mudou".
        await this.fail(t, 'o Night fechou durante a execução; não consegui conferir a worktree (dados incompletos) e não apaguei nada — confira antes de pedir de novo');
        continue;
      }
      const wt: Worktree = { path: t.worktreePath, branch: t.branch, baseRef: t.baseRef };
      let diff: DiffReport;
      try {
        diff = await this.worktrees.diff(wt);
      } catch (err) {
        // Worktree sumiu ou não pôde ser lida: não invente "está tudo certo" nem apague nada.
        await this.fail(t, `o Night fechou durante a execução; não consegui conferir a worktree (${(err as Error).message}) e não apaguei nada — confira antes de pedir de novo`);
        continue;
      }
      const n = diff.changedFiles.length;
      if (n === 0) {
        await this.fail(t, 'o Night fechou durante a execução; nada foi alterado; pode pedir de novo com segurança');
        continue;
      }
      await this.fail(t, `o Night fechou durante a execução; a worktree tem ${n} arquivo(s) mudado(s) e foi mantida — confira antes de pedir de novo`);
      // A lista no evento deixa o Joel conferir o que ficou sem abrir a worktree.
      await this.event(t, 'progress', 'scheduler',
        `worktree mantida em ${wt.path}: ${diff.changedFiles.map((f) => `${f.status}: ${f.path}`).join(', ')}`);
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

/** Texto curto do parecer para falar e registrar: recomendação, motivos e contrapontos. */
function parecerParaEvento(opinion: Opinion, autorEhDeepSeek: boolean): string {
  const curtos = (itens: string[]) => itens
    .slice(0, 3)
    .map((item) => item.replace(/\s+/g, ' ').slice(0, 200))
    .join('; ') || 'nenhum';
  return [
    `parecer DeepSeek: ${opinion.recomendacao}`,
    `motivos: ${curtos(opinion.motivos)}`,
    `contrapontos: ${curtos(opinion.contrapontos)}`,
    // O autor do diff nunca conta como revisão independente do próprio trabalho.
    autorEhDeepSeek ? 'não conta como revisão independente: o DeepSeek é o autor do diff' : '',
  ].filter(Boolean).join(' — ');
}

/**
 * Arquivos liberados que o cartão deixa no escopo da tarefa (`Arquivos permitidos:`, escrito por
 * taskFieldsFromCard). Sem a seção ou com "nenhum", não há cartão para conferir.
 */
function arquivosPermitidosDoEscopo(scope: string): string[] | null {
  const texto = scope.replace(/\r\n/g, '\n');
  const secao = /(?:^|\n)Arquivos permitidos:\n([\s\S]*?)(?:\n\n|$)/.exec(texto);
  if (!secao) return null;
  const arquivos = secao[1]!
    .split('\n')
    .map((linha) => /^-\s+(.+)$/.exec(linha)?.[1]?.trim() ?? '')
    .filter((item) => item !== '' && item !== 'nenhum');
  return arquivos.length > 0 ? arquivos : null;
}

export { other as otherAgent };
