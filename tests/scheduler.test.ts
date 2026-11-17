import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import type { AdvisorResult } from '../src/advisor/deepseek-client.ts';
import { MemoryAdvisorJournal } from '../src/advisor/journal.ts';
import type { AdvisorInput, Recomendacao } from '../src/advisor/opinion.ts';
import { AdvisorService, type OpinionAdvisor } from '../src/advisor/service.ts';
import type { Card } from '../src/cards/card.ts';
import { taskFieldsFromCard } from '../src/cards/import.ts';
import type { AgentRun, CodingAgent, DiffReport, WorktreeManager, Worktree } from '../src/core/interfaces.ts';
import type { AgentName, Approval, Project, Task } from '../src/core/types.ts';
import type { Reviewer, RunOutcome } from '../src/agents/coding.ts';
import { QuotaError } from '../src/agents/research.ts';
import { otherAgent, TaskScheduler, type ReserveReviewer, type TaskUpdate } from '../src/agents/scheduler.ts';
import { NightCoordinator } from '../src/app/coordinator.ts';
import { PgMemory } from '../src/memory/pg-memory.ts';
import { NightRouter } from '../src/router/router.ts';
import { FakeLlm, resetTestDb, TEST_URL, truncateAll } from './helpers.ts';

class FakeWorktrees implements WorktreeManager {
  created: string[] = [];
  merged: string[] = [];
  discarded: string[] = [];
  files: DiffReport['changedFiles'] = [{ path: 'src/parser.ts', status: 'added' }];
  mergeResult = { merged: true, message: 'merge --no-ff' };
  conflicts: string[] = [];
  async create(project: Project, taskId: string, agent: string): Promise<Worktree> {
    this.created.push(taskId);
    return { path: `D:/NIGHT-data/worktrees/${project.id}/${agent}-${taskId}`, branch: `agent/${agent}/${taskId}`, baseRef: 'abc123def4567890' };
  }
  patch = '+export function parse() {}';
  /** Simula worktree sumida: reconcile não pode inventar "nada mudou" nesse caso. */
  diffError: Error | null = null;
  async diff(wt: Worktree): Promise<DiffReport> {
    if (this.diffError) throw this.diffError;
    return { baseRef: wt.baseRef, headRef: 'HEAD', changedFiles: this.files, patch: this.patch };
  }
  async checkMerge() { return { clean: this.conflicts.length === 0, conflicts: this.conflicts }; }
  async merge(_p: Project, wt: Worktree, approval: Approval) {
    assert.equal(approval.decision, 'approved', 'merge só com aprovação aprovada');
    this.merged.push(wt.branch);
    return this.mergeResult;
  }
  async discard(_p: Project, wt: Worktree) { this.discarded.push(wt.branch); }
}

/** Agente falso: termina quando o teste mandar (finish), ou quando cancelado. */
class FakeAgent implements CodingAgent {
  prompts: string[] = [];
  private resolvers = new Map<string, (o: RunOutcome) => void>();
  started = 0;
  constructor(readonly name: AgentName, private readonly auto: RunOutcome | null = { exitCode: 0, summary: 'criei o parser e os testes passam' }) {}
  async available() { return { ok: true, detail: 'fake' }; }
  async start(task: Task, _wt: Worktree, prompt: string): Promise<AgentRun> {
    this.prompts.push(prompt);
    this.started++;
    const done = new Promise<RunOutcome>((resolve) => {
      this.resolvers.set(task.id, resolve);
      if (this.auto) setTimeout(() => resolve(this.auto!), 5);
    });
    return { taskId: task.id, agent: this.name, pid: 4242, done };
  }
  finish(taskId: string, o: RunOutcome) { this.resolvers.get(taskId)?.(o); }
  async cancel(run: AgentRun) {
    this.resolvers.get(run.taskId)?.({ exitCode: null, summary: 'interrompido', killed: true });
    return { killed: true, detail: 'processo 4242 encerrado' };
  }
}

class FakeReviewer implements Reviewer {
  prompts: string[] = [];
  constructor(readonly name: AgentName, private readonly verdict = 'VEREDITO: aprovar\n- nada grave', private readonly during?: () => void | Promise<void>) {}
  async review(_wt: Worktree, prompt: string) { this.prompts.push(prompt); await this.during?.(); return this.verdict; }
}

/** Reserva (DeepSeek): devolve o veredito ou lança, e guarda o prompt recebido. */
class FakeReserveReviewer implements ReserveReviewer {
  prompts: string[] = [];
  constructor(readonly name: string, private readonly behavior: string | Error) {}
  async review(_wt: Worktree, prompt: string) {
    this.prompts.push(prompt);
    if (this.behavior instanceof Error) throw this.behavior;
    return this.behavior;
  }
}

/** Conselheiro falso do diff final: guarda a entrada e devolve o parecer pedido. */
class FakeAdvisor implements OpinionAdvisor {
  readonly model = 'fake-flash';
  readonly inputs: AdvisorInput[] = [];
  constructor(private readonly recomendacao: Recomendacao = 'revisar') {}
  async ask(input: AdvisorInput): Promise<AdvisorResult> {
    this.inputs.push(input);
    return {
      ok: true,
      opinion: {
        version: 'parecer/1',
        jobId: input.jobId,
        fase: input.fase,
        recomendacao: this.recomendacao,
        motivos: ['falta o teste do caso de erro'],
        evidencias: [],
        contrapontos: ['o caminho de erro não está coberto'],
        lacunas: [],
        proximoTeste: 'testar a entrada inválida',
        confianca: 'media',
      },
      model: this.model,
      ms: 5,
      usage: null,
    };
  }
}

/** AdvisorService com diário em memória: o scheduler conversa com o contrato real. */
function advisorCom(recomendacao: Recomendacao = 'revisar'): { service: AdvisorService; fake: FakeAdvisor } {
  const fake = new FakeAdvisor(recomendacao);
  return { service: new AdvisorService(fake, new MemoryAdvisorJournal()), fake };
}

const until = async (cond: () => Promise<boolean>, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await cond()) return; await new Promise((r) => setTimeout(r, 10)); }
  throw new Error('tempo esgotado esperando a condição');
};

describe('execução de tarefas de código', () => {
  let mem: PgMemory;
  let wts: FakeWorktrees;
  const night: Project = { id: 'night', name: 'Night', description: '', repoPath: 'D:/NIGHT', defaultBranch: 'main', allowedPaths: [], status: 'active' };

  before(async () => { await resetTestDb(); mem = await PgMemory.open(TEST_URL); });
  after(async () => { await mem?.close(); });
  beforeEach(async () => {
    await truncateAll();
    await mem.upsertProject(night);
    wts = new FakeWorktrees();
  });

  const newTask = (id: string, over: Partial<Task> = {}) => mem.createTask({
    id, projectId: 'night', objective: 'criar o parser de sinais', scope: '', status: 'queued', primaryAgent: 'claude',
    reviewAgent: 'codex', worktreePath: null, branch: null, baseRef: null, resultSummary: null, approvalState: 'none', ...over,
  });
  const status = async (id: string) => (await mem.getTask(id))!.status;

  test('caminho completo: worktree → Claude faz → Codex revisa → pede aprovação', async () => {
    const claude = new FakeAgent('claude');
    const reviewer = new FakeReviewer('codex');
    const s = new TaskScheduler(mem, wts, { claude, codex: new FakeAgent('codex') }, { codex: reviewer });
    const updates: TaskUpdate[] = [];
    s.on('update', (u) => updates.push(u));
    await newTask('t1');
    await s.enqueue('t1');
    await until(async () => (await status('t1')) === 'awaiting-approval');

    const events = (await mem.listTaskEvents('t1')).filter((e) => e.eventType === 'status-changed').map((e) => e.message.split(':')[0]);
    assert.deepEqual(events, ['criada como queued', 'queued → planning', 'planning → running', 'running → testing', 'testing → review-ready', 'review-ready → awaiting-approval']);
    assert.match(claude.prompts[0]!, /Trabalhe SÓ nesta pasta: D:\/NIGHT-data\/worktrees\/night\/claude-t1/);
    assert.match(claude.prompts[0]!, /<contexto_night>/, 'o agente recebe o contexto compartilhado');
    assert.match(reviewer.prompts[0]!, /Quem implementou foi o claude/);
    assert.match(reviewer.prompts[0]!, /added: src\/parser\.ts/);
    const t = (await mem.getTask('t1'))!;
    assert.equal(t.branch, 'agent/claude/t1');
    assert.match(t.resultSummary!, /claude: criei o parser[\s\S]*revisão \(codex\): VEREDITO: aprovar/);
    assert.equal((await mem.listPendingApprovals()).length, 1);
    const last = updates.at(-1)!;
    assert.equal(last.important, true);
    assert.match(last.message, /A tarefa t1 terminou: 1 arquivo mudado\. O codex revisou e aprovou\. Quer aprovar ou descartar\?/);
  });

  test('aprovar faz o merge e apaga a worktree; rejeitar só descarta', async () => {
    const s = new TaskScheduler(mem, wts, { claude: new FakeAgent('claude'), codex: new FakeAgent('codex') });
    await newTask('t2', { reviewAgent: null });
    await newTask('t3', { reviewAgent: null });
    await s.enqueue('t2');
    await s.enqueue('t3');
    await until(async () => (await status('t3')) === 'awaiting-approval');

    assert.match((await s.approve('t2')).message, /juntei a tarefa t2 no main/);
    assert.equal(await status('t2'), 'accepted');
    assert.deepEqual(wts.merged, ['agent/claude/t2']);
    assert.match((await s.reject('t3')).message, /Descartei a tarefa t3/);
    assert.equal(await status('t3'), 'rejected');
    assert.deepEqual(wts.merged, ['agent/claude/t2'], 'rejeitar não faz merge');
    assert.deepEqual(wts.discarded, ['agent/claude/t2', 'agent/claude/t3']);
    await assert.rejects(s.approve('t3'), /não está esperando aprovação/);
  });

  test('merge recusado (dono com mudança não salva) volta a esperar aprovação', async () => {
    wts.mergeResult = { merged: false, message: 'a pasta do dono tem mudanças não commitadas' };
    const s = new TaskScheduler(mem, wts, { claude: new FakeAgent('claude'), codex: new FakeAgent('codex') });
    await newTask('t4', { reviewAgent: null });
    await s.enqueue('t4');
    await until(async () => (await status('t4')) === 'awaiting-approval');
    const r = await s.approve('t4');
    assert.equal(r.ok, false);
    assert.match(r.message, /não commitadas/);
    assert.equal(await status('t4'), 'awaiting-approval');
    assert.equal((await mem.listPendingApprovals()).length, 1, 'pedido novo para tentar de novo');
  });

  test('cancelar no meio mata o processo e marca cancelled', async () => {
    const claude = new FakeAgent('claude', null); // só termina se cancelar
    const s = new TaskScheduler(mem, wts, { claude, codex: new FakeAgent('codex') });
    await newTask('t5');
    await s.enqueue('t5');
    await until(async () => (await status('t5')) === 'running');
    await until(async () => s.running().includes('t5'));
    const r = await s.cancel('t5');
    assert.deepEqual(r, { killed: true, detail: 'processo 4242 encerrado' });
    await until(async () => (await status('t5')) === 'cancelled');
    assert.deepEqual(wts.discarded, ['agent/claude/t5']);
    const types = (await mem.listTaskEvents('t5')).map((e) => e.eventType);
    assert.ok(types.includes('cancel-requested') && types.includes('cancel-result'));
  });

  test('limite de uso, erro e "não mudou nada" viram failed com o motivo', async () => {
    const cases: [string, RunOutcome | null, DiffReport['changedFiles'], RegExp][] = [
      ['t6', { exitCode: 1, summary: 'You have hit your usage limit', quota: true }, wts.files, /bateu no limite de uso/],
      ['t7', { exitCode: 2, summary: 'TypeError na linha 3' }, wts.files, /saiu com erro: TypeError/],
      ['t8', { exitCode: 0, summary: 'olhei e está tudo certo' }, [], /terminou sem mudar nenhum arquivo/],
    ];
    for (const [id, outcome, files, why] of cases) {
      wts.files = files;
      const s = new TaskScheduler(mem, wts, { claude: new FakeAgent('claude', outcome), codex: new FakeAgent('codex') });
      await newTask(id, { reviewAgent: null });
      await s.enqueue(id);
      await until(async () => (await status(id)) === 'failed');
      assert.match((await mem.getTask(id))!.resultSummary!, why);
    }
  });

  test('projeto sem pasta falha antes de criar worktree', async () => {
    await mem.upsertProject({ ...night, id: 'sem', name: 'Sem Pasta', repoPath: null });
    const s = new TaskScheduler(mem, wts, { claude: new FakeAgent('claude'), codex: new FakeAgent('codex') });
    await newTask('t9', { projectId: 'sem' });
    await s.enqueue('t9');
    await until(async () => (await status('t9')) === 'failed');
    assert.deepEqual(wts.created, []);
  });

  test('ao reiniciar, o que estava rodando vira failed e não recomeça', async () => {
    await newTask('t10');
    await mem.updateTaskStatus('t10', 'running', 'scheduler', 'rodando antes de fechar');
    const claude = new FakeAgent('claude');
    const s = new TaskScheduler(mem, wts, { claude, codex: new FakeAgent('codex') });
    const stuck = await s.reconcile();
    assert.deepEqual(stuck.map((t) => t.id), ['t10']);
    assert.equal(await status('t10'), 'failed');
    assert.match((await mem.getTask('t10'))!.resultSummary!, /nada foi alterado; pode pedir de novo com segurança/);
    assert.equal(claude.started, 0);
  });

  test('retomada: worktree com mudanças fica failed e mantida, com a lista no evento (D13)', async () => {
    wts.files = [
      { path: 'src/parser.ts', status: 'modified' },
      { path: 'tests/parser.test.ts', status: 'added' },
    ];
    await newTask('r1', {
      worktreePath: 'D:/NIGHT-data/worktrees/night/claude-r1',
      branch: 'agent/claude/r1',
      baseRef: 'abc123def4567890',
    });
    await mem.updateTaskStatus('r1', 'running', 'scheduler', 'rodando antes de fechar');
    const s = new TaskScheduler(mem, wts, { claude: new FakeAgent('claude'), codex: new FakeAgent('codex') });
    const stuck = await s.reconcile();
    assert.deepEqual(stuck.map((t) => t.id), ['r1']);
    assert.equal(await status('r1'), 'failed');
    assert.match((await mem.getTask('r1'))!.resultSummary!,
      /worktree tem 2 arquivo\(s\) mudado\(s\) e foi mantida — confira antes de pedir de novo/);
    const ev = (await mem.listTaskEvents('r1')).find((e) => e.message.includes('worktree mantida em'));
    assert.ok(ev, 'o evento mostra a lista do que ficou na worktree');
    assert.match(ev!.message, /modified: src\/parser\.ts/);
    assert.match(ev!.message, /added: tests\/parser\.test\.ts/);
    assert.deepEqual(wts.discarded, [], 'a worktree nunca é apagada na retomada');
    assert.equal((await mem.listPendingApprovals()).length, 0, 'diff parcial não vira aprovação');
  });

  test('retomada: worktree sem mudanças diz que dá para pedir de novo (D13)', async () => {
    wts.files = [];
    await newTask('r2', {
      worktreePath: 'D:/NIGHT-data/worktrees/night/claude-r2',
      branch: 'agent/claude/r2',
      baseRef: 'abc123def4567890',
    });
    await mem.updateTaskStatus('r2', 'running', 'scheduler', 'rodando antes de fechar');
    const s = new TaskScheduler(mem, wts, { claude: new FakeAgent('claude'), codex: new FakeAgent('codex') });
    await s.reconcile();
    assert.equal(await status('r2'), 'failed');
    assert.match((await mem.getTask('r2'))!.resultSummary!, /nada foi alterado; pode pedir de novo com segurança/);
    assert.deepEqual(wts.discarded, []);
  });

  test('retomada: worktree sumida diz que não conseguiu conferir, sem apagar nada (D13)', async () => {
    wts.diffError = new Error('worktree não existe');
    await newTask('r3', {
      worktreePath: 'D:/NIGHT-data/worktrees/night/claude-r3',
      branch: 'agent/claude/r3',
      baseRef: 'abc123def4567890',
    });
    await mem.updateTaskStatus('r3', 'running', 'scheduler', 'rodando antes de fechar');
    const s = new TaskScheduler(mem, wts, { claude: new FakeAgent('claude'), codex: new FakeAgent('codex') });
    await s.reconcile();
    assert.equal(await status('r3'), 'failed');
    assert.match((await mem.getTask('r3'))!.resultSummary!,
      /não consegui conferir a worktree \(worktree não existe\) e não apaguei nada/);
    assert.deepEqual(wts.discarded, []);
  });

  test('por voz: pede, mostra as mudanças e aprova', async () => {
    const llm = new FakeLlm();
    const s = new TaskScheduler(mem, wts, { claude: new FakeAgent('claude'), codex: new FakeAgent('codex') }, { claude: new FakeReviewer('claude') });
    const n = new NightCoordinator(mem, new NightRouter(llm, async () => ['Night']), llm, { tasks: s });

    const r = await n.handle('Pede pro Codex criar o parser de sinais no Night');
    assert.match(r.text, /^Mandei a tarefa \w+ para o codex no Night, e o claude revisa\./);
    const [task] = await mem.listTasks();
    assert.equal(task!.primaryAgent, 'codex');
    assert.equal(task!.reviewAgent, 'claude');
    await until(async () => (await status(task!.id)) === 'awaiting-approval');

    assert.match((await n.handle('o que tá rodando?')).text, /\(codex, awaiting-approval\)/);
    const d = await n.handle('mostra as mudanças');
    assert.match(d.text, /mudou 1 arquivo: parser\.ts\. O diff completo está na tela\./);
    assert.match(d.detail!, /\+export function parse/);
    assert.match((await n.handle('aprovo')).text, /juntei a tarefa/);
    assert.equal(await status(task!.id), 'accepted');
    assert.equal(llm.calls.length, 0, 'nada disso passou pelo modelo local');
  });

  test('cancelar tarefa que espera aprovação recusa o pedido de merge e apaga a worktree', async () => {
    const s = new TaskScheduler(mem, wts, { claude: new FakeAgent('claude'), codex: new FakeAgent('codex') });
    await newTask('t11', { reviewAgent: null });
    await s.enqueue('t11');
    await until(async () => (await status('t11')) === 'awaiting-approval');
    await s.cancel('t11');
    assert.equal(await status('t11'), 'cancelled');
    assert.equal((await mem.listPendingApprovals()).length, 0);
    assert.deepEqual(wts.discarded, ['agent/claude/t11']);
    assert.deepEqual(wts.merged, []);
  });

  test('só uma instância pega a trava de executar tarefas', async () => {
    const other = await PgMemory.open(TEST_URL);
    try {
      const unlock = await mem.acquireTaskLock();
      assert.ok(unlock, 'a primeira pega');
      assert.equal(await other.acquireTaskLock(), null, 'a segunda não');
      await unlock!();
      const again = await other.acquireTaskLock();
      assert.ok(again, 'depois de soltar, a outra pega');
      await again!();
    } finally {
      await other.close();
    }
  });

  test('janela sem executor não "cancela de mentira" tarefa viva da outra', async () => {
    await newTask('t12');
    await mem.updateTaskStatus('t12', 'running', 'scheduler', 'rodando na outra janela');
    const llm = new FakeLlm();
    const n = new NightCoordinator(mem, new NightRouter(llm, async () => ['Night']), llm);
    assert.match((await n.handle('cancela a tarefa do Night')).text, /está com a outra janela do Night/);
    assert.equal(await status('t12'), 'running');
  });

  test('revisor que muda arquivo faz a tarefa falhar, sem pedir aprovação (revisão do Codex)', async () => {
    const reviewer = new FakeReviewer('codex', 'VEREDITO: aprovar', () => { wts.patch += '\n+// escrito pelo teste do revisor'; });
    const s = new TaskScheduler(mem, wts, { claude: new FakeAgent('claude'), codex: new FakeAgent('codex') }, { codex: reviewer });
    await newTask('t13');
    await s.enqueue('t13');
    await until(async () => (await status('t13')) === 'failed');
    assert.match((await mem.getTask('t13'))!.resultSummary!, /mudaram durante a revisão do codex/);
    assert.equal((await mem.listPendingApprovals()).length, 0);
  });

  test('mudou depois da revisão: "aprovo" não faz merge (revisão do Codex)', async () => {
    const s = new TaskScheduler(mem, wts, { claude: new FakeAgent('claude'), codex: new FakeAgent('codex') });
    await newTask('t14', { reviewAgent: null });
    await s.enqueue('t14');
    await until(async () => (await status('t14')) === 'awaiting-approval');
    wts.patch += '\n+// alguém mexeu na worktree depois';
    const r = await s.approve('t14');
    assert.equal(r.ok, false);
    assert.match(r.message, /mudou depois que foi revisada/);
    assert.deepEqual(wts.merged, []);
    assert.equal(await status('t14'), 'failed', 'nada não revisado fica esperando aprovação (2ª revisão do Codex)');
    assert.equal((await mem.listPendingApprovals()).length, 0);
    await assert.rejects(s.approve('t14'), /não está esperando aprovação/);
  });

  test('cancelar e fechar o Night matam o revisor também (2ª revisão do Codex)', async () => {
    const aborted: string[] = [];
    let reviewing = 0;
    // Revisor que só termina quando é interrompido.
    const hanging: Reviewer = {
      name: 'codex',
      review: (_wt, _p, signal) => new Promise((_, reject) => {
        reviewing++;
        signal?.addEventListener('abort', () => { aborted.push('abort'); reject(new Error('revisor encerrado')); });
      }),
    };
    const s = new TaskScheduler(mem, wts, { claude: new FakeAgent('claude'), codex: new FakeAgent('codex') }, { codex: hanging });
    await newTask('t18');
    await s.enqueue('t18');
    await until(async () => reviewing === 1);
    const r = await s.cancel('t18');
    assert.match(r.detail, /revisor encerrado/);
    await until(async () => (await status('t18')) === 'cancelled');
    assert.equal((await mem.listPendingApprovals()).length, 0);

    await newTask('t19');
    await s.enqueue('t19');
    await until(async () => reviewing === 2);
    await s.shutdown(2000);
    assert.equal(await status('t19'), 'cancelled');
    assert.equal(aborted.length, 2);
  });

  test('cancelar durante a revisão para sem pedir aprovação (revisão do Codex)', async () => {
    let s!: TaskScheduler;
    const reviewer = new FakeReviewer('codex', 'VEREDITO: aprovar', async () => { await s.cancel('t15'); });
    s = new TaskScheduler(mem, wts, { claude: new FakeAgent('claude'), codex: new FakeAgent('codex') }, { codex: reviewer });
    await newTask('t15');
    await s.enqueue('t15');
    await until(async () => (await status('t15')) === 'cancelled');
    assert.equal((await mem.listPendingApprovals()).length, 0);
    assert.deepEqual(wts.merged, []);
  });

  test('aprovar e cancelar ao mesmo tempo: um de cada vez, nunca cancelada com merge feito', async () => {
    const s = new TaskScheduler(mem, wts, { claude: new FakeAgent('claude'), codex: new FakeAgent('codex') });
    await newTask('t16', { reviewAgent: null });
    await s.enqueue('t16');
    await until(async () => (await status('t16')) === 'awaiting-approval');
    const [a, c] = await Promise.all([s.approve('t16'), s.cancel('t16')]);
    assert.equal(a.ok, true);
    assert.match(c.detail, /já estava accepted/);
    assert.equal(await status('t16'), 'accepted');
  });

  test('fechar o Night mata o agente e marca a tarefa como cancelada antes de soltar', async () => {
    const claude = new FakeAgent('claude', null);
    const s = new TaskScheduler(mem, wts, { claude, codex: new FakeAgent('codex') });
    await newTask('t17');
    await s.enqueue('t17');
    await until(async () => s.running().includes('t17'));
    await s.shutdown(2000);
    assert.equal(await status('t17'), 'cancelled');
    assert.deepEqual(s.running(), []);
  });

  test('esperando o texto da ideia, "cancela a tarefa" é comando, não ideia (revisão do Codex)', async () => {
    const llm = new FakeLlm();
    const s = new TaskScheduler(mem, wts, { claude: new FakeAgent('claude', null), codex: new FakeAgent('codex') });
    const n = new NightCoordinator(mem, new NightRouter(llm, async () => ['Night']), llm, { tasks: s });
    await n.handle('pede pro claude criar o parser de sinais no Night');
    const [task] = await mem.listTasks();
    await until(async () => s.running().includes(task!.id));
    await n.handle('salva uma ideia para o Night');
    const r = await n.handle('cancela a tarefa do Night');
    assert.match(r.text, /^Cancelei a tarefa/);
    assert.equal((await mem.findIdeas({})).length, 0, 'não virou ideia');
    await until(async () => (await status(task!.id)) === 'cancelled');
  });

  test('"sem revisão" desliga o segundo agente', async () => {
    const llm = new FakeLlm();
    const s = new TaskScheduler(mem, wts, { claude: new FakeAgent('claude'), codex: new FakeAgent('codex') });
    const n = new NightCoordinator(mem, new NightRouter(llm, async () => ['Night']), llm, { tasks: s });
    const r = await n.handle('pede pro claude corrigir o bug do roteador no Night, sem revisão');
    assert.doesNotMatch(r.text, /revisa/);
    const [task] = await mem.listTasks();
    assert.equal(task!.reviewAgent, null);
    await until(async () => (await status(task!.id)) === 'awaiting-approval');
  });

  test('revisor principal falha: a reserva DeepSeek revisa e a autoria fica certa (D11)', async () => {
    const primary: Reviewer = { name: 'codex', review: async () => { throw new QuotaError('sem cota'); } };
    const reserve = new FakeReserveReviewer('deepseek', 'VEREDITO: aprovar\n- nada grave');
    const s = new TaskScheduler(mem, wts, { claude: new FakeAgent('claude'), codex: new FakeAgent('codex') },
      { codex: primary }, 'pt-BR', reserve);
    const updates: TaskUpdate[] = [];
    s.on('update', (u) => updates.push(u));
    await newTask('t20');
    await s.enqueue('t20');
    await until(async () => (await status('t20')) === 'awaiting-approval');

    const t = (await mem.getTask('t20'))!;
    assert.match(t.resultSummary!, /revisão \(deepseek, reserva do codex\): VEREDITO: aprovar/);
    const ev = (await mem.listTaskEvents('t20')).find((e) => e.source === 'deepseek');
    assert.ok(ev, 'o evento da reserva fica registrado com source deepseek');
    assert.match(ev!.message, /revisão \(reserva do codex, motivo: sem cota\)/);
    assert.match(updates.at(-1)!.message, /O deepseek revisou e aprovou/);
  });

  test('revisor principal e reserva falham: nunca anuncia aprovação (D11)', async () => {
    const primary: Reviewer = { name: 'codex', review: async () => { throw new Error('revisor caiu'); } };
    const reserve = new FakeReserveReviewer('deepseek', new Error('API fora'));
    const s = new TaskScheduler(mem, wts, { claude: new FakeAgent('claude'), codex: new FakeAgent('codex') },
      { codex: primary }, 'pt-BR', reserve);
    const updates: TaskUpdate[] = [];
    s.on('update', (u) => updates.push(u));
    await newTask('t21');
    await s.enqueue('t21');
    await until(async () => (await status('t21')) === 'awaiting-approval');

    const last = updates.at(-1)!;
    assert.doesNotMatch(last.message, /aprovou/);
    assert.match(last.message, /A revisão não saiu \(API fora\); confira o diff antes de aprovar\./);
    assert.match((await mem.getTask('t21'))!.resultSummary!, /revisão: não saiu/);
  });

  test('revisor que lança não vira "aprovou" (bug D11)', async () => {
    const reviewer: Reviewer = { name: 'codex', review: async () => { throw new Error('revisor caiu'); } };
    const s = new TaskScheduler(mem, wts, { claude: new FakeAgent('claude'), codex: new FakeAgent('codex') },
      { codex: reviewer });
    const updates: TaskUpdate[] = [];
    s.on('update', (u) => updates.push(u));
    await newTask('t22');
    await s.enqueue('t22');
    await until(async () => (await status('t22')) === 'awaiting-approval');

    assert.doesNotMatch(updates.at(-1)!.message, /aprovou/);
    assert.match(updates.at(-1)!.message, /A revisão não saiu \(revisor caiu\)/);
  });

  test('revisão com "VEREDITO: aprovar" é falada como aprovada (aceita variação de caixa e separador)', async () => {
    const reviewer = new FakeReviewer('codex', 'Veredito - aprovado\n- nada grave');
    const s = new TaskScheduler(mem, wts, { claude: new FakeAgent('claude'), codex: new FakeAgent('codex') }, { codex: reviewer });
    const updates: TaskUpdate[] = [];
    s.on('update', (u) => updates.push(u));
    await newTask('t24');
    await s.enqueue('t24');
    await until(async () => (await status('t24')) === 'awaiting-approval');

    assert.match(updates.at(-1)!.message, /O codex revisou e aprovou\./);
  });

  test('revisão com "VEREDITO: corrigir" pede correção, não aprovação', async () => {
    const reviewer = new FakeReviewer('codex', 'VEREDITO: corrigir\n- falta teste');
    const s = new TaskScheduler(mem, wts, { claude: new FakeAgent('claude'), codex: new FakeAgent('codex') }, { codex: reviewer });
    const updates: TaskUpdate[] = [];
    s.on('update', (u) => updates.push(u));
    await newTask('t25');
    await s.enqueue('t25');
    await until(async () => (await status('t25')) === 'awaiting-approval');

    const last = updates.at(-1)!.message;
    assert.match(last, /O codex revisou e pediu correção\./);
    assert.doesNotMatch(last, /aprovou/);
  });

  test('revisão sem veredito claro não é falada como aprovação', async () => {
    const reviewer = new FakeReviewer('codex', 'Olhei o código e parece razoável, mas não sei dizer.');
    const s = new TaskScheduler(mem, wts, { claude: new FakeAgent('claude'), codex: new FakeAgent('codex') }, { codex: reviewer });
    const updates: TaskUpdate[] = [];
    s.on('update', (u) => updates.push(u));
    await newTask('t26');
    await s.enqueue('t26');
    await until(async () => (await status('t26')) === 'awaiting-approval');

    const last = updates.at(-1)!.message;
    assert.doesNotMatch(last, /aprovou/);
    assert.match(last, /O codex revisou mas não deu veredito claro; leia a revisão antes de aprovar\./);
  });

  test('a reserva não revisa o próprio código (autoria)', async () => {
    const primary: Reviewer = { name: 'codex', review: async () => { throw new Error('sem cota'); } };
    const reserve = new FakeReserveReviewer('claude', 'VEREDITO: aprovar');
    const s = new TaskScheduler(mem, wts, { claude: new FakeAgent('claude'), codex: new FakeAgent('codex') },
      { codex: primary }, 'pt-BR', reserve);
    const updates: TaskUpdate[] = [];
    s.on('update', (u) => updates.push(u));
    await newTask('t23'); // primaryAgent 'claude': a reserva 'claude' não pode revisar
    await s.enqueue('t23');
    await until(async () => (await status('t23')) === 'awaiting-approval');

    assert.equal(reserve.prompts.length, 0, 'o autor do código nunca é o revisor');
    assert.doesNotMatch(updates.at(-1)!.message, /aprovou/);
    assert.match(updates.at(-1)!.message, /A revisão não saiu/);
  });

  test('o revisor é sempre outro agente: deepseek → claude, claude ↔ codex (D12/H01)', () => {
    assert.equal(otherAgent('deepseek'), 'claude');
    assert.equal(otherAgent('claude'), 'codex');
    assert.equal(otherAgent('codex'), 'claude');
    for (const a of ['claude', 'codex', 'deepseek'] as const) {
      assert.notEqual(otherAgent(a), a, `${a} não pode revisar o próprio código`);
    }
  });

  test('DeepSeek implementa e o Claude revisa; a autoria fica registrada (D12/H01)', async () => {
    const deepseek = new FakeAgent('deepseek');
    const reviewer = new FakeReviewer('claude');
    const s = new TaskScheduler(mem, wts, { deepseek, claude: new FakeAgent('claude') }, { claude: reviewer });
    const updates: TaskUpdate[] = [];
    s.on('update', (u) => updates.push(u));
    // A migração 011 precisa aceitar primary_agent 'deepseek' no banco de teste.
    await newTask('d1', { primaryAgent: 'deepseek', reviewAgent: 'claude' });
    await s.enqueue('d1');
    await until(async () => (await status('d1')) === 'awaiting-approval');

    assert.equal(deepseek.started, 1);
    assert.match(reviewer.prompts[0]!, /Quem implementou foi o deepseek/);
    const t = (await mem.getTask('d1'))!;
    assert.equal(t.primaryAgent, 'deepseek');
    assert.equal(t.reviewAgent, 'claude');
    assert.equal(t.branch, 'agent/deepseek/d1');
    assert.match(t.resultSummary!, /deepseek: criei o parser[\s\S]*revisão \(claude\): VEREDITO: aprovar/);
    assert.match(updates.at(-1)!.message, /O claude revisou e aprovou\./);
    const ev = (await mem.listTaskEvents('d1')).find((e) => e.source === 'deepseek');
    assert.ok(ev, 'o evento do executor fica com source deepseek');
  });

  test('agente pedido que não está configurado falha com o motivo, sem criar worktree', async () => {
    const s = new TaskScheduler(mem, wts, { claude: new FakeAgent('claude') });
    await newTask('d2', { primaryAgent: 'deepseek', reviewAgent: 'claude' });
    await s.enqueue('d2');
    await until(async () => (await status('d2')) === 'failed');
    assert.match((await mem.getTask('d2'))!.resultSummary!, /o DeepSeek não está configurado: falta a chave/);
    assert.deepEqual(wts.created, []);
  });

  test('scheduler recusa tarefa cujo revisor é o próprio autor', async () => {
    const s = new TaskScheduler(mem, wts, { deepseek: new FakeAgent('deepseek'), claude: new FakeAgent('claude') });
    await newTask('d3', { primaryAgent: 'deepseek', reviewAgent: 'deepseek' });
    await s.enqueue('d3');
    await until(async () => (await status('d3')) === 'failed');
    assert.match((await mem.getTask('d3'))!.resultSummary!, /o DeepSeek não pode revisar o próprio código/);
    assert.deepEqual(wts.created, []);
  });

  test('parecer DeepSeek "revisar" aparece na frase e no evento, sem aprovar sozinho (D05)', async () => {
    const { service, fake } = advisorCom('revisar');
    const s = new TaskScheduler(mem, wts, { claude: new FakeAgent('claude'), codex: new FakeAgent('codex') },
      { codex: new FakeReviewer('codex', 'VEREDITO: aprovar') }, 'pt-BR', undefined, service);
    const updates: TaskUpdate[] = [];
    s.on('update', (u) => updates.push(u));
    await newTask('a1');
    await s.enqueue('a1');
    await until(async () => (await status('a1')) === 'awaiting-approval');

    assert.equal(fake.inputs.length, 1);
    const entrada = fake.inputs[0]!;
    assert.equal(entrada.jobId, 'a1');
    assert.equal(entrada.dominio, 'codigo');
    assert.equal(entrada.fase, 'diff-final');
    assert.equal(entrada.objetivo, 'criar o parser de sinais');
    assert.ok(entrada.evidencias.every((e) => !e.externa), 'diff e resumo são internos, nunca fonte externa');
    assert.ok(entrada.evidencias.some((e) => e.ref === 'diff' && e.conteudo.length <= 40_000));
    assert.match(entrada.outroParecer ?? '', /VEREDITO: aprovar/, 'a revisão vai como outro parecer');

    const last = updates.at(-1)!.message;
    assert.match(last, /O codex revisou e aprovou\./);
    assert.match(last, /Parecer DeepSeek: revisar — ver contrapontos\./);
    assert.match(last, /Testes não rodaram/);
    assert.match(last, /A aprovação do merge continua sendo sua/);
    const ev = (await mem.listTaskEvents('a1')).find((e) => e.source === 'deepseek' && e.message.includes('parecer DeepSeek'));
    assert.ok(ev, 'o parecer fica no evento com source deepseek');
    assert.match(ev!.message, /revisar/);
    assert.match(ev!.message, /contrapontos: o caminho de erro não está coberto/);

    assert.equal(await status('a1'), 'awaiting-approval', 'parecer não aprova nem recusa sozinho');
    assert.equal((await mem.listPendingApprovals()).length, 1, 'a aprovação continua pendente');
  });

  test('parecer do DeepSeek não conta como revisão independente quando ele é o autor (D05)', async () => {
    const { service, fake } = advisorCom('revisar');
    const s = new TaskScheduler(mem, wts, { deepseek: new FakeAgent('deepseek'), claude: new FakeAgent('claude') },
      { claude: new FakeReviewer('claude') }, 'pt-BR', undefined, service);
    await newTask('a2', { primaryAgent: 'deepseek', reviewAgent: 'claude' });
    await s.enqueue('a2');
    await until(async () => (await status('a2')) === 'awaiting-approval');

    assert.equal(fake.inputs.length, 1);
    const ev = (await mem.listTaskEvents('a2')).find((e) => e.source === 'deepseek' && e.message.includes('parecer DeepSeek'));
    assert.ok(ev);
    assert.match(ev!.message, /não conta como revisão independente: o DeepSeek é o autor do diff/);
    assert.equal(await status('a2'), 'awaiting-approval');
    assert.equal((await mem.listPendingApprovals()).length, 1);
  });

  test('sem advisor, o fluxo continua como antes e sem parecer DeepSeek (D05)', async () => {
    const s = new TaskScheduler(mem, wts, { claude: new FakeAgent('claude'), codex: new FakeAgent('codex') },
      { codex: new FakeReviewer('codex', 'VEREDITO: aprovar') });
    const updates: TaskUpdate[] = [];
    s.on('update', (u) => updates.push(u));
    await newTask('a3');
    await s.enqueue('a3');
    await until(async () => (await status('a3')) === 'awaiting-approval');

    const last = updates.at(-1)!.message;
    assert.doesNotMatch(last, /Parecer DeepSeek/);
    assert.match(last, /O codex revisou e aprovou\./);
    const eventos = (await mem.listTaskEvents('a3')).filter((e) => e.message.includes('parecer DeepSeek'));
    assert.deepEqual(eventos, []);
  });

  test('arquivos fora do cartão aparecem no resumo e na frase (D05)', async () => {
    const cartao: Card = {
      version: 'cartao/1',
      id: 'NIGHT-1',
      titulo: 'parser',
      objetivo: 'criar o parser de sinais',
      escopo: 'só o parser',
      foraDoEscopo: [],
      criteriosDePronto: ['o teste do parser passa'],
      testes: ['npm test'],
      arquivosPermitidos: ['src/parser.ts'],
      riscos: [],
      revisao: 1,
    };
    const { objective, scope } = taskFieldsFromCard(cartao);
    wts.files = [
      { path: 'src/parser.ts', status: 'modified' },
      { path: 'src/fora1.ts', status: 'added' },
      { path: 'src/fora2.ts', status: 'added' },
    ];
    const s = new TaskScheduler(mem, wts, { claude: new FakeAgent('claude'), codex: new FakeAgent('codex') },
      { codex: new FakeReviewer('codex', 'VEREDITO: aprovar') });
    const updates: TaskUpdate[] = [];
    s.on('update', (u) => updates.push(u));
    await newTask('a4', {
      objective,
      scope,
      cardId: cartao.id,
      cardRevision: cartao.revisao,
      cardHash: 'abc123def4567890'.padEnd(64, '0'),
    });
    await s.enqueue('a4');
    await until(async () => (await status('a4')) === 'awaiting-approval');

    const resumo = (await mem.getTask('a4'))!.resultSummary!;
    assert.match(resumo, /cartão NIGHT-1 r1 \(hash abc123def456\)/);
    assert.match(resumo, /2 arquivos fora do cartão: src\/fora1\.ts, src\/fora2\.ts/);
    assert.match(updates.at(-1)!.message, /2 arquivos fora do cartão: src\/fora1\.ts, src\/fora2\.ts/);
    assert.equal(await status('a4'), 'awaiting-approval', 'cartão não aprova o merge sozinho');
  });
});
