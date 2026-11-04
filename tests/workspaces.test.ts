import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { GitWorktreeManager } from '../src/workspaces/worktree-manager.ts';
import type { Approval, Project } from '../src/core/types.ts';

const execFileAsync = promisify(execFile);

async function git(repo: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  return stdout.trim();
}

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const temp = await mkdtemp(join(tmpdir(), 'night workspaces '));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const repo = join(temp, 'repo com espaço');
  await mkdir(repo);
  await git(repo, 'init', '-b', 'main');
  await git(repo, 'config', 'user.name', 'Teste');
  await git(repo, 'config', 'user.email', 'teste@local');
  await git(repo, 'config', 'core.autocrlf', 'false');
  await writeFile(join(repo, 'tracked.txt'), 'base\n');
  await writeFile(join(repo, 'renamed.txt'), 'conteúdo para renomear\n');
  await writeFile(join(repo, 'removed.txt'), 'conteúdo para remover\n');
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-m', 'base');
  const project: Project = {
    id: 'projeto-1', name: 'Teste', description: '', repoPath: repo,
    defaultBranch: 'main', allowedPaths: [], status: 'active',
  };
  return { temp, repo, project, manager: new GitWorktreeManager(join(temp, 'worktrees com espaço')) };
}

async function ownerSnapshot(repo: string) {
  return {
    tracked: await readFile(join(repo, 'tracked.txt'), 'utf8'),
    status: await git(repo, 'status', '--porcelain', '--untracked-files=all'),
    index: await git(repo, 'ls-files', '--stage'),
    head: await git(repo, 'rev-parse', 'HEAD'),
    branch: await git(repo, 'symbolic-ref', '--short', 'HEAD'),
  };
}

function approval(taskId: string, decision: Approval['decision'] = 'approved', action: Approval['action'] = 'merge'): Approval {
  return { id: 'approval-1', taskId, action, scope: '', requestedAt: '', decision, decidedAt: '' };
}

test('create, diff, checkMerge e discard preservam arquivos, status, HEAD e branch do dono sujo', async (t) => {
  const { repo, project, manager } = await fixture(t);
  await writeFile(join(repo, 'tracked.txt'), 'edição do dono\n');
  await writeFile(join(repo, 'novo do dono.txt'), 'privado\n');
  await writeFile(join(repo, 'staged do dono.txt'), 'staged\n');
  await git(repo, 'add', '--', 'staged do dono.txt');
  const before = await ownerSnapshot(repo);
  const worktree = await manager.create(project, 'tarefa-1', 'codex');
  assert.equal(worktree.baseRef, before.head);
  await writeFile(join(worktree.path, 'tracked.txt'), 'edição do agente\n');
  await writeFile(join(worktree.path, 'novo agente.txt'), 'novo\n');
  const report = await manager.diff(worktree);
  assert.deepEqual(report.changedFiles, [
    { path: 'novo agente.txt', status: 'added' },
    { path: 'tracked.txt', status: 'modified' },
  ]);
  assert.match(report.patch, /novo agente/);
  assert.match(report.patch, /edição do agente/);
  assert.deepEqual(await manager.checkMerge(project, worktree), { clean: true, conflicts: [] });
  assert.equal(await git(worktree.path, 'log', '-1', '--format=%s'), 'night: trabalho do agente codex na tarefa tarefa-1');
  await manager.discard(project, worktree);
  assert.deepEqual(await ownerSnapshot(repo), before);
  assert.equal(await readFile(join(repo, 'novo do dono.txt'), 'utf8'), 'privado\n');
  assert.equal(await readFile(join(repo, 'staged do dono.txt'), 'utf8'), 'staged\n');
});

test('diff classifica arquivos removidos e renomeados', async (t) => {
  const { project, manager } = await fixture(t);
  const worktree = await manager.create(project, 'tipos', 'codex');
  await git(worktree.path, 'mv', 'renamed.txt', 'renomeado.txt');
  await git(worktree.path, 'rm', 'removed.txt');
  const report = await manager.diff(worktree);
  assert.deepEqual(report.changedFiles, [
    { path: 'removed.txt', status: 'deleted' },
    { path: 'renomeado.txt', status: 'renamed' },
  ]);
  assert.match(report.patch, /rename from renamed.txt/);
  assert.match(report.patch, /deleted file mode/);
});

test('create rejeita repo inválido, branch repetida e pasta repetida', async (t) => {
  const { temp, project, manager } = await fixture(t);
  await assert.rejects(manager.create({ ...project, repoPath: temp }, 'x', 'codex'), /repositório Git/);
  await assert.rejects(new GitWorktreeManager(join(project.repoPath!, 'agentes')).create(project, 'x', 'codex'),
    /dentro do repositório do dono/);
  await manager.create(project, 'x', 'codex');
  await assert.rejects(manager.create(project, 'x', 'codex'), /Pasta|Branch/);
  await git(project.repoPath!, 'worktree', 'remove', '--force', join(temp, 'worktrees com espaço', 'projeto-1', 'codex-x'));
  await assert.rejects(manager.create(project, 'x', 'codex'), /Branch já existe/);
});

test('checkMerge identifica conflito e merge não altera a branch alvo', async (t) => {
  const { repo, project, manager } = await fixture(t);
  const worktree = await manager.create(project, 'conflito', 'claude');
  await writeFile(join(worktree.path, 'tracked.txt'), 'agente\n');
  await writeFile(join(repo, 'tracked.txt'), 'dono em commit\n');
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-m', 'mudança do dono');
  const before = await ownerSnapshot(repo);
  const result = await manager.checkMerge(project, worktree);
  assert.equal(result.clean, false);
  assert.ok(result.conflicts.some((name) => name.includes('tracked.txt')));
  assert.deepEqual(await manager.merge(project, worktree, approval('conflito')), {
    merged: false, message: `Conflitos: ${result.conflicts.join(', ')}`,
  });
  assert.deepEqual(await ownerSnapshot(repo), before);
});

test('merge recusa aprovação ausente, de outra tarefa, ação errada e dono sujo', async (t) => {
  const { repo, project, manager } = await fixture(t);
  const worktree = await manager.create(project, 'aprovar', 'codex');
  await writeFile(join(worktree.path, 'novo.txt'), 'agente\n');
  const before = await ownerSnapshot(repo);
  assert.equal((await manager.merge(project, worktree, approval('aprovar', 'pending'))).merged, false);
  assert.equal((await manager.merge(project, worktree, approval('outra'))).merged, false);
  assert.equal((await manager.merge(project, worktree, approval('aprovar', 'approved', 'deploy'))).merged, false);
  assert.deepEqual(await ownerSnapshot(repo), before);
  await writeFile(join(repo, 'tracked.txt'), 'dono sujo\n');
  const dirty = await ownerSnapshot(repo);
  const result = await manager.merge(project, worktree, approval('aprovar'));
  assert.equal(result.merged, false);
  assert.match(result.message, /mudanças não commitadas/);
  assert.deepEqual(await ownerSnapshot(repo), dirty);
});

test('merge aprovado funciona com dono limpo', async (t) => {
  const { repo, project, manager } = await fixture(t);
  const worktree = await manager.create(project, 'limpo', 'codex');
  await writeFile(join(worktree.path, 'novo.txt'), 'agente\n');
  const result = await manager.merge(project, worktree, approval('limpo'));
  assert.equal(result.merged, true);
  assert.equal(await readFile(join(repo, 'novo.txt'), 'utf8'), 'agente\n');
  assert.equal(await git(repo, 'status', '--porcelain'), '');
  assert.equal(await git(repo, 'rev-list', '--parents', '-n', '1', 'HEAD').then((s) => s.split(' ').length), 3);
});

test('merge em branch não checada usa commit-tree e preserva worktree do dono', async (t) => {
  const { repo, project, manager } = await fixture(t);
  await git(repo, 'switch', '-c', 'trabalho-do-dono');
  await writeFile(join(repo, 'tracked.txt'), 'sujo na branch do dono\n');
  const before = await ownerSnapshot(repo);
  const worktree = await manager.create(project, 'sem-checkout', 'codex');
  await writeFile(join(worktree.path, 'novo.txt'), 'agente\n');
  const oldMain = await git(repo, 'rev-parse', 'main');
  const result = await manager.merge(project, worktree, approval('sem-checkout'));
  assert.equal(result.merged, true);
  assert.deepEqual(await ownerSnapshot(repo), before);
  assert.notEqual(await git(repo, 'rev-parse', 'main'), oldMain);
  assert.equal(await git(repo, 'show', 'main:novo.txt'), 'agente');
});

test('discard recusa caminho fora da raiz e preserva arquivo externo', async (t) => {
  const { repo, project, manager } = await fixture(t);
  const worktree = await manager.create(project, 'descartar', 'codex');
  const external = join(repo, 'não apagar.txt');
  await writeFile(external, 'seguro\n');
  await assert.rejects(manager.discard(project, { ...worktree, path: repo }), /fora da raiz/);
  assert.equal(await readFile(external, 'utf8'), 'seguro\n');
  await manager.discard(project, worktree);
});
