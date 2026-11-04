// Teste de ponta a ponta com agentes DE VERDADE (gasta um pouco da cota do Claude e do Codex).
// Cria um repositório descartável, pede uma mudança por "voz" (texto), espera o agente fazer e o outro
// revisar, mostra o diff, aprova, e confere que a pasta do dono só mudou depois da aprovação.
// Roda: pnpm e2e:agentes [claude|codex]
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createNight } from '../src/app/bootstrap.ts';
import type { TaskUpdate } from '../src/agents/scheduler.ts';

const agent = process.argv[2] === 'codex' ? 'Codex' : 'Claude';
const REPO = 'D:/NIGHT-data/sandbox-repo';
const git = (...args: string[]) => execFileSync('git', ['-C', REPO, ...args], { encoding: 'utf8' }).trim();

// 1. repositório descartável, com um teste que passa
if (existsSync(REPO)) {
  try { execFileSync('git', ['-C', REPO, 'worktree', 'prune']); } catch { /* sem worktrees */ }
  rmSync(REPO, { recursive: true, force: true });
}
mkdirSync(REPO, { recursive: true });
execFileSync('git', ['init', '-b', 'main', REPO]);
writeFileSync(path.join(REPO, 'package.json'), JSON.stringify({ name: 'sandbox', type: 'module', scripts: { test: 'node --test' } }, null, 2));
writeFileSync(path.join(REPO, 'math.js'), 'export function dobro(n) {\n  return n * 2;\n}\n');
writeFileSync(path.join(REPO, 'math.test.js'), "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { dobro } from './math.js';\n\ntest('dobro', () => assert.equal(dobro(3), 6));\n");
git('add', '-A');
git('-c', 'user.name=Night', '-c', 'user.email=night@local', 'commit', '-m', 'inicial');
const before = { head: git('rev-parse', 'HEAD'), math: readFileSync(path.join(REPO, 'math.js'), 'utf8') };

// 2. o Night, com o projeto cadastrado
const { memory, night, tasks, runsTasks } = await createNight();
if (!runsTasks) {
  console.error('Outra janela do Night está aberta e cuida das tarefas. Feche ela e rode de novo.');
  await memory.close();
  process.exit(1);
}
await memory.upsertProject({ id: 'sandbox', name: 'Sandbox', description: 'repositório descartável de teste', repoPath: REPO, defaultBranch: 'main', allowedPaths: [], status: 'active' });
const t0 = Date.now();
const secs = () => `${((Date.now() - t0) / 1000).toFixed(0)}s`;
const finished = new Promise<TaskUpdate>((resolve) => {
  tasks.on('update', (u) => {
    console.log(`  [${secs()}] ${u.task.status}: ${u.message}`);
    if (['awaiting-approval', 'failed', 'cancelled'].includes(u.task.status) && u.important) resolve(u);
  });
});

try {
  const ask = `Pede pro ${agent} adicionar uma função triplo em math.js, com teste, no Sandbox`;
  console.log(`você › ${ask}`);
  console.log(`night › ${(await night.handle(ask)).text}`);
  const end = await finished;
  if (end.task.status !== 'awaiting-approval') throw new Error(`a tarefa terminou em ${end.task.status}`);

  const untouched = git('rev-parse', 'HEAD') === before.head && readFileSync(path.join(REPO, 'math.js'), 'utf8') === before.math;
  console.log(`\nPasta do dono intacta antes de aprovar: ${untouched ? 'SIM' : 'NÃO (falha grave)'}`);

  const diff = await night.handle('mostra as mudanças');
  console.log(`você › mostra as mudanças\nnight › ${diff.text}\n${diff.detail ?? ''}`);
  const ok = await night.handle('aprovo');
  console.log(`você › aprovo\nnight › ${ok.text}`);

  const merged = readFileSync(path.join(REPO, 'math.js'), 'utf8');
  const testRun = execFileSync('node', ['--test'], { cwd: REPO, encoding: 'utf8' });
  console.log(`\nDepois do merge: math.js tem triplo? ${/triplo/.test(merged) ? 'SIM' : 'NÃO'} · testes: ${/# fail 0/.test(testRun) ? 'passam' : 'FALHAM'}`);
  console.log(`Log: ${git('log', '--oneline', '-5').split('\n').join(' | ')}`);
  console.log(`Tempo total: ${secs()}`);
} finally {
  await tasks.shutdown();
  await memory.close();
}
