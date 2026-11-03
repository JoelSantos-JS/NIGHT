// Cadastra os projetos do blueprint (§3). Sem caminho de repositório: isso o Joel informa depois.
// Roda: pnpm seed   (pode repetir; não apaga nada)
import { PgMemory } from '../src/memory/pg-memory.ts';
import type { Project } from '../src/core/types.ts';

const base = { repoPath: null, defaultBranch: null, allowedPaths: [] as string[], status: 'active' as const };
const projects: Project[] = [
  { ...base, id: 'abstrike', name: 'Abstrike', description: 'Software de arbitragem cripto; preparar deploy em VPS (sem gastar).' },
  { ...base, id: 'soaken', name: 'Soaken', description: 'App de idiomas com voz (código em Desktop/PROFESSOR/tutor-pc).' },
  { ...base, id: 'trading-signals', name: 'Sinais', description: 'Pesquisa/bot de sinais de entrada e saída em cripto; só backtest e paper trading.' },
  { ...base, id: 'social', name: 'Facebook', description: 'Páginas e conteúdo (ex.: K-dramas) para o público do Brasil.' },
  { ...base, id: 'night', name: 'Night', description: 'Este assistente.' },
];

const memory = await PgMemory.open();
for (const p of projects) await memory.upsertProject(p);
console.log('projetos:', (await memory.listProjects()).map((p) => p.name).join(', '));
await memory.close();
