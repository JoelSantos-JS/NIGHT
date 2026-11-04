import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { existsSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import type { DiffReport, Worktree, WorktreeManager } from '../core/interfaces.ts';
import type { AgentName, Approval, Id, Project } from '../core/types.ts';

const execFileAsync = promisify(execFile);
const identity = ['-c', 'user.name=Night', '-c', 'user.email=night@local'];

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
    encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  });
  return stdout;
}

async function gitResult(cwd: string, args: string[]): Promise<{ code: number; output: string }> {
  try {
    return { code: 0, output: await git(cwd, args) };
  } catch (error) {
    const failure = error as Error & { code?: number; stdout?: string; stderr?: string };
    if (typeof failure.code !== 'number') throw error;
    return { code: failure.code, output: failure.stdout ?? failure.stderr ?? '' };
  }
}

function safeSegment(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) || value.endsWith('.lock')) {
    throw new Error(`${label} inválido: ${value}`);
  }
  return value;
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function samePath(a: string, b: string): boolean {
  return resolve(a).toLowerCase() === resolve(b).toLowerCase();
}

function taskFromBranch(branch: string): string | null {
  const match = /^agent\/(claude|codex)\/([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(branch);
  return match?.[2] ?? null;
}

export class GitWorktreeManager implements WorktreeManager {
  readonly root: string;

  constructor(root = 'D:/NIGHT-data/worktrees') {
    this.root = resolve(root);
  }

  private repoPath(project: Project): string {
    if (!project.repoPath) throw new Error('Projeto sem repoPath Git');
    return resolve(project.repoPath);
  }

  private async validRepo(project: Project): Promise<string> {
    const path = this.repoPath(project);
    const result = await gitResult(path, ['rev-parse', '--show-toplevel']);
    if (result.code !== 0 || !samePath(result.output.trim(), path)) {
      throw new Error(`repoPath não é a raiz de um repositório Git: ${path}`);
    }
    return path;
  }

  private async assertWorktree(project: Project, worktree: Worktree): Promise<string> {
    const repo = await this.validRepo(project);
    const path = resolve(worktree.path);
    if (!inside(this.root, path) || !taskFromBranch(worktree.branch)) {
      throw new Error('Worktree do agente fora da raiz ou branch inválida');
    }
    if (!inside(await realpath(this.root), await realpath(path))) {
      throw new Error('Worktree do agente resolve para fora da raiz');
    }
    const list = await git(repo, ['worktree', 'list', '--porcelain']);
    const registered = list.split(/\r?\n\r?\n/).some((entry) => {
      const lines = entry.split(/\r?\n/);
      const worktreeLine = lines.find((line) => line.startsWith('worktree '));
      return worktreeLine && samePath(worktreeLine.slice(9), path)
        && lines.includes(`branch refs/heads/${worktree.branch}`);
    });
    if (!registered) throw new Error('Caminho e branch não correspondem a uma worktree deste repositório');
    return repo;
  }

  async create(project: Project, taskId: Id, agent: AgentName): Promise<Worktree> {
    const repo = await this.validRepo(project);
    let existing = this.root;
    while (!existsSync(existing)) existing = dirname(existing);
    const rootLocation = resolve(await realpath(existing), relative(existing, this.root));
    if (samePath(rootLocation, repo) || inside(repo, rootLocation)) {
      throw new Error('Raiz das worktrees não pode ficar dentro do repositório do dono');
    }
    const branch = `agent/${safeSegment(agent, 'Agente')}/${safeSegment(taskId, 'taskId')}`;
    const path = resolve(this.root, safeSegment(project.id, 'projectId'), `${agent}-${taskId}`);
    if (!inside(this.root, path)) throw new Error('Caminho da worktree fora da raiz');
    if (existsSync(path)) throw new Error(`Pasta da worktree já existe: ${path}`);
    if ((await gitResult(repo, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])).code === 0) {
      throw new Error(`Branch já existe: ${branch}`);
    }
    const base = project.defaultBranch ? `refs/heads/${project.defaultBranch}` : 'HEAD';
    const baseResult = await gitResult(repo, ['rev-parse', '--verify', `${base}^{commit}`]);
    if (baseResult.code !== 0) throw new Error(`Branch base não encontrada: ${base}`);
    const baseRef = baseResult.output.trim();
    await git(repo, ['worktree', 'add', '-b', branch, path, baseRef]);
    return { path, branch, baseRef };
  }

  async diff(worktree: Worktree): Promise<DiffReport> {
    const path = resolve(worktree.path);
    const untracked = (await git(path, ['ls-files', '--others', '--exclude-standard', '-z']))
      .split('\0').filter(Boolean);
    if (untracked.length) await git(path, ['add', '-N', '--', ...untracked]);
    const names = await git(path, ['diff', '--find-renames', '--name-status', '-z', worktree.baseRef]);
    const fields = names.split('\0').filter(Boolean);
    const changedFiles: DiffReport['changedFiles'] = [];
    for (let i = 0; i < fields.length;) {
      const code = fields[i++] ?? '';
      const first = fields[i++] ?? '';
      const renamed = code.startsWith('R');
      const path = renamed ? fields[i++] ?? '' : first;
      const status = renamed ? 'renamed' : code.startsWith('A') ? 'added'
        : code.startsWith('D') ? 'deleted' : 'modified';
      changedFiles.push({ path, status });
    }
    return {
      baseRef: worktree.baseRef,
      headRef: (await git(path, ['rev-parse', 'HEAD'])).trim(),
      changedFiles,
      patch: await git(path, ['diff', '--binary', '--find-renames', worktree.baseRef]),
    };
  }

  private async commitAgentChanges(worktree: Worktree): Promise<void> {
    const path = resolve(worktree.path);
    await git(path, ['add', '-A']);
    const staged = await gitResult(path, ['diff', '--cached', '--quiet']);
    if (staged.code > 1) throw new Error(`Falha ao verificar alterações do agente: ${staged.output}`);
    if (staged.code === 1) {
      const [, agent, taskId] = worktree.branch.split('/');
      await git(path, [...identity, 'commit', '-m', `night: trabalho do agente ${agent} na tarefa ${taskId}`]);
    }
  }

  private async mergeTree(repo: string, target: string, branch: string): Promise<{ clean: boolean; tree: string; conflicts: string[] }> {
    const result = await gitResult(repo, ['merge-tree', '--write-tree', '--name-only', target, branch]);
    if (result.code !== 0 && result.code !== 1) throw new Error(`git merge-tree falhou: ${result.output}`);
    const lines = result.output.trim().split(/\r?\n/);
    const tree = lines[0] ?? '';
    const conflicts = result.code === 1
      ? lines.slice(1).filter((line) => line && !line.startsWith('Auto-merging ') && !line.startsWith('CONFLICT '))
      : [];
    return { clean: result.code === 0, tree, conflicts };
  }

  private async targetBranch(repo: string, project: Project): Promise<string> {
    if (project.defaultBranch) return project.defaultBranch;
    const result = await gitResult(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    if (result.code !== 0) throw new Error('defaultBranch ausente e HEAD destacado');
    return result.output.trim();
  }

  async checkMerge(project: Project, worktree: Worktree): Promise<{ clean: boolean; conflicts: string[] }> {
    const repo = await this.assertWorktree(project, worktree);
    await this.commitAgentChanges(worktree);
    const target = await this.targetBranch(repo, project);
    const result = await this.mergeTree(repo, `refs/heads/${target}`, worktree.branch);
    return { clean: result.clean, conflicts: result.conflicts };
  }

  async merge(project: Project, worktree: Worktree, approval: Approval): Promise<{ merged: boolean; message: string }> {
    const taskId = taskFromBranch(worktree.branch);
    if (!taskId || approval.action !== 'merge' || approval.decision !== 'approved' || approval.taskId !== taskId) {
      return { merged: false, message: 'Aprovação de merge ausente, rejeitada ou de outra tarefa' };
    }
    const repo = await this.assertWorktree(project, worktree);
    const checked = await this.checkMerge(project, worktree);
    if (!checked.clean) return { merged: false, message: `Conflitos: ${checked.conflicts.join(', ')}` };
    const target = await this.targetBranch(repo, project);
    const targetRef = `refs/heads/${target}`;
    const current = await gitResult(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    if (current.code === 0 && current.output.trim() === target) {
      const status = await git(repo, ['status', '--porcelain', '--untracked-files=all']);
      if (status.trim()) return { merged: false, message: 'Worktree do dono tem mudanças não commitadas' };
      await git(repo, [...identity, 'merge', '--no-ff', '-m', `night: merge ${worktree.branch}`, worktree.branch]);
      return { merged: true, message: `Merge em ${target}` };
    }
    const list = await git(repo, ['worktree', 'list', '--porcelain']);
    if (list.split(/\r?\n/).includes(`branch ${targetRef}`)) {
      return { merged: false, message: `Branch ${target} está em outra worktree` };
    }
    const targetSha = (await git(repo, ['rev-parse', targetRef])).trim();
    const agentSha = (await git(repo, ['rev-parse', worktree.branch])).trim();
    const tree = await this.mergeTree(repo, targetRef, worktree.branch);
    if (!tree.clean) return { merged: false, message: `Conflitos: ${tree.conflicts.join(', ')}` };
    const commit = (await git(repo, [...identity, 'commit-tree', tree.tree, '-p', targetSha, '-p', agentSha,
      '-m', `night: merge ${worktree.branch}`])).trim();
    await git(repo, ['update-ref', targetRef, commit, targetSha]);
    return { merged: true, message: `Merge em ${target} sem alterar worktrees` };
  }

  async discard(project: Project, worktree: Worktree): Promise<void> {
    const repo = await this.assertWorktree(project, worktree);
    await git(repo, ['worktree', 'remove', '--force', resolve(worktree.path)]);
    await git(repo, ['branch', '-D', worktree.branch]);
  }
}
