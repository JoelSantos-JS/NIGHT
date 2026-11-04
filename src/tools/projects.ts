// Achar uma pasta de projeto no PC pelo nome falado e descobrir como rodar (pedido do Joel, 04/11:
// "procura no desktop a pasta AWS Prepping e roda pra mim").
//
// Segurança: procurar só LÊ nomes de pasta em lugares conhecidos. Rodar só acontece depois do "pode" do Joel
// (o coordenador pergunta antes), numa janela própria e visível, que ele fecha quando quiser.

import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import path from 'node:path';

const SKIP = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__', 'dist', 'build', '.next', 'target', 'appdata', '$recycle.bin', 'windows', 'program files', 'program files (x86)']);

/** Onde procurar, nessa ordem. NIGHT_SEARCH_ROOTS (separado por ;) troca a lista. */
export function searchRoots(): string[] {
  if (process.env.NIGHT_SEARCH_ROOTS) return process.env.NIGHT_SEARCH_ROOTS.split(';').filter(Boolean);
  const home = homedir();
  return [path.join(home, 'Desktop'), path.join(home, 'Documents'), path.join(home, 'Projects'), 'D:/', 'D:/Joel'].filter((p) => existsSync(p));
}

const squash = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Quanto um nome de pasta bate com o que foi falado (0 = nada). "AWS Prepping" × "AWS PREP": cada palavra
 * da pasta é começo de uma palavra falada (prep → prepping). O Whisper erra palavra estrangeira, então
 * aceita prefixo nos dois sentidos.
 */
export function matchScore(folder: string, spoken: string): number {
  const f = squash(folder).split(' ').filter(Boolean);
  const s = squash(spoken).split(' ').filter(Boolean);
  if (!f.length || !s.length) return 0;
  if (f.join('') === s.join('')) return 100;
  // Pasta de 1 letra ("P", "A") casava com qualquer palavra: prefixo só vale com 2+ letras.
  const hits = f.filter((fw) => s.some((sw) => sw === fw || (fw.length >= 2 && sw.startsWith(fw)) || (sw.length >= 3 && fw.startsWith(sw))));
  if (hits.length !== f.length) return 0; // toda palavra da pasta tem que aparecer
  return 50 + Math.round((hits.length / s.length) * 40);
}

export interface FolderHit {
  path: string;
  name: string;
  score: number;
}

/** Procura pastas cujo nome bata com o falado, até 3 níveis abaixo de cada raiz. Melhores primeiro. */
export function findFolders(spoken: string, roots = searchRoots(), maxDepth = 3): FolderHit[] {
  const hits: FolderHit[] = [];
  const walk = (dir: string, depth: number) => {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      if (SKIP.has(name.toLowerCase()) || name.startsWith('.')) continue;
      const full = path.join(dir, name);
      let isDir = false;
      try { isDir = statSync(full).isDirectory(); } catch { continue; }
      if (!isDir) continue;
      const score = matchScore(name, spoken);
      if (score > 0) hits.push({ path: full, name, score: score - depth * 2 });
      if (depth < maxDepth) walk(full, depth + 1);
    }
  };
  for (const root of roots) walk(root, 1);
  return hits.sort((a, b) => b.score - a.score).slice(0, 5);
}

export type RunPlan =
  | { kind: 'node'; dir: string; command: string; needsInstall: boolean; script: string }
  | { kind: 'static'; dir: string; entry: string }
  | { kind: 'python'; dir: string; command: string }
  | { kind: 'unknown'; dir: string };

function nodePlan(dir: string): RunPlan | null {
  const file = path.join(dir, 'package.json');
  if (!existsSync(file)) return null;
  let scripts: Record<string, string> = {};
  try { scripts = (JSON.parse(readFileSync(file, 'utf8')) as { scripts?: Record<string, string> }).scripts ?? {}; } catch { return null; }
  const script = ['dev', 'start', 'serve', 'preview'].find((s) => scripts[s]);
  if (!script) return null;
  const pm = existsSync(path.join(dir, 'pnpm-lock.yaml')) ? 'pnpm' : existsSync(path.join(dir, 'yarn.lock')) ? 'yarn' : 'npm';
  const needsInstall = !existsSync(path.join(dir, 'node_modules'));
  const run = pm === 'npm' ? `npm run ${script}` : `${pm} ${script}`;
  return { kind: 'node', dir, script, needsInstall, command: needsInstall ? `${pm} install; ${run}` : run };
}

function planFor(dir: string): RunPlan | null {
  const node = nodePlan(dir);
  if (node) return node;
  if (existsSync(path.join(dir, 'index.html'))) return { kind: 'static', dir, entry: 'index.html' };
  for (const f of ['main.py', 'app.py', 'manage.py']) {
    if (existsSync(path.join(dir, f))) return { kind: 'python', dir, command: f === 'manage.py' ? 'python manage.py runserver' : `python ${f}` };
  }
  return null;
}

/** Como rodar a pasta; se ela só tiver documentos, olha as subpastas (o AWS PREP tem o app numa subpasta). */
export function detectRunner(dir: string): RunPlan {
  const here = planFor(dir);
  if (here) return here;
  let subs: string[] = [];
  try { subs = readdirSync(dir).filter((n) => !n.startsWith('.') && !SKIP.has(n.toLowerCase())); } catch { /* sem acesso */ }
  for (const name of subs) {
    const full = path.join(dir, name);
    try { if (!statSync(full).isDirectory()) continue; } catch { continue; }
    const sub = planFor(full);
    if (sub) return sub;
  }
  return { kind: 'unknown', dir };
}

/** Frase curta dizendo o que vai ser feito (para pedir o "pode"). */
export function describePlan(plan: RunPlan, pt = true): string {
  switch (plan.kind) {
    case 'node': return pt
      ? `Ele roda com "${plan.command}"${plan.needsInstall ? ', e antes precisa instalar as dependências, o que baixa pacotes da internet' : ''}.`
      : `It runs with "${plan.command}"${plan.needsInstall ? ', and it needs to install dependencies first, which downloads packages' : ''}.`;
    case 'static': return pt
      ? 'É um site estático: eu subo um servidor local, só de leitura, e abro no navegador.'
      : "It's a static site: I start a local read-only server and open it in the browser.";
    case 'python': return pt ? `Ele roda com "${plan.command}".` : `It runs with "${plan.command}".`;
    case 'unknown': return pt ? 'Não achei como rodar: não tem package.json, index.html nem main.py.' : "I couldn't tell how to run it: no package.json, index.html or main.py.";
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;

export interface Launcher {
  launch(plan: RunPlan, title: string): Promise<{ ok: boolean; detail: string }>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function answers(url: string, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (r.ok) return true;
    } catch { /* ainda subindo */ }
    await sleep(400);
  }
  return false;
}

/**
 * Abre uma janela do PowerShell própria, com título, rodando o projeto. O Joel vê e fecha quando quiser.
 * Só diz que deu certo depois de CONFERIR (04/11: as aspas quebraram, nada subiu e ele disse "abri").
 */
export class WindowLauncher implements Launcher {
  constructor(private readonly scriptsDir = path.join(process.env.NIGHT_DATA ?? 'D:/NIGHT-data', 'run')) {}

  async launch(plan: RunPlan, title: string): Promise<{ ok: boolean; detail: string }> {
    if (plan.kind === 'unknown') return { ok: false, detail: 'não sei como rodar essa pasta' };
    let command: string;
    let url: string | null = null;
    if (plan.kind === 'static') {
      const port = await freePort();
      url = `http://127.0.0.1:${port}/${plan.entry}`;
      command = `python -m http.server ${port} --bind 127.0.0.1`;
    } else {
      command = plan.command;
    }
    // O comando vai num .ps1: sem aspas aninhadas entre Node → PowerShell → nova janela.
    mkdirSync(this.scriptsDir, { recursive: true });
    const file = path.join(this.scriptsDir, `${title.replace(/[^\w-]+/g, '_')}.ps1`);
    writeFileSync(file, [
      `$Host.UI.RawUI.WindowTitle = ${psQuote(`Night: ${title}`)}`,
      `Set-Location -LiteralPath ${psQuote(plan.dir)}`,
      `Write-Host ${psQuote(`Night rodando: ${command}  (feche esta janela para parar)`)}`,
      command,
    ].join('\r\n'), 'utf8');
    const pid = await new Promise<number | null>((resolve) => {
      execFile('powershell.exe', ['-NoProfile', '-Command',
        `(Start-Process powershell -PassThru -ArgumentList @('-NoExit','-ExecutionPolicy','Bypass','-File',${psQuote(file)})).Id`],
      { windowsHide: true }, (err, stdout) => resolve(err ? null : Number(stdout.trim()) || null));
    });
    if (!pid) return { ok: false, detail: 'o Windows não abriu a janela' };

    if (url) {
      if (!(await answers(url, 8000))) {
        return { ok: false, detail: alive(pid) ? `a janela abriu, mas o servidor não respondeu em ${url}; veja a janela "Night: ${title}"` : 'a janela fechou sozinha; o comando falhou' };
      }
      spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      return { ok: true, detail: `servidor em ${url}, aberto no navegador` };
    }
    await sleep(2500);
    if (!alive(pid)) return { ok: false, detail: 'a janela fechou sozinha; o comando falhou' };
    return { ok: true, detail: `janela "Night: ${title}" rodando ${command}` };
  }
}
