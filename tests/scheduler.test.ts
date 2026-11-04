import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import type { AgentRun, CodingAgent, DiffReport, WorktreeManager, Worktree } from '../src/core/interfaces.ts';
import type { Approval, Project, Task } from '../src/core/types.ts';
import type { Reviewer, RunOutcome } from '../src/agents/coding.ts';
import { TaskScheduler, type TaskUpdate } from '../src/agents/scheduler.ts';
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
  async diff(wt: Worktree): Promise<DiffReport> {
    return { baseRef: wt.baseRef, headRef: 'HEAD', changedFiles: this.files, patch: '+export function parse() {}' };
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
  constructor(readonly name: 'claude' | 'codex', private readonly auto: RunOutcome | null = { exitCode: 0, summary: 'criei o parser e os testes passam' }) {}
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
  constructor(readonly name: 'claude' | 'codex', private readonly verdict = 'VEREDITO: aprovar\n- nada grave') {}
  async review(_wt: Worktree, prompt: string) { this.prompts.push(prompt); return this.verdict; }
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
    assert.match((await mem.getTask('t10'))!.resultSummary!, /não recomecei sozinho/);
    assert.equal(claude.started, 0);
  });

  test('por voz: pede, mostra as mudanças e aprova', async () => {
    const llm = new FakeLlm();
    const s = new TaskScheduler(mem, wts, { claude: new FakeAgent('claude'), codex: new FakeAgent('codex') }, { claude: new FakeReviewer('claude') });
    const n = new NightCoordinator(mem, new NightRouter(llm, async () => ['Night']), llm, [], s);

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

  test('"sem revisão" desliga o segundo agente', async () => {
    const llm = new FakeLlm();
    const s = new TaskScheduler(mem, wts, { claude: new FakeAgent('claude'), codex: new FakeAgent('codex') });
    const n = new NightCoordinator(mem, new NightRouter(llm, async () => ['Night']), llm, [], s);
    const r = await n.handle('pede pro claude corrigir o bug do roteador no Night, sem revisão');
    assert.doesNotMatch(r.text, /revisa/);
    const [task] = await mem.listTasks();
    assert.equal(task!.reviewAgent, null);
    await until(async () => (await status(task!.id)) === 'awaiting-approval');
  });
});
