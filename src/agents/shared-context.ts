// Contexto compartilhado: o que todo agente do Night (Codex, Claude) recebe junto com o pedido, para saber
// quem ele é, quem são os outros, o que já foi conversado/respondido e quais tarefas estão abertas.
// Fonte: o banco (route_log e tasks), não a memória de nenhum modelo — sobrevive a reinício.
// Blueprint §18 A (handoff estruturado); o ai-memory pode substituir isto depois, se valer a pena.

import type { Memory } from '../core/interfaces.ts';
import type { Language } from '../core/types.ts';
import { FINAL_TASK_STATUSES } from '../core/types.ts';

export const MAX_CONTEXT_CHARS = 2500;
const ACTIVITY_ITEMS = 8;
const REPLY_CHARS = 220;

const AGENTS_PT = `Agentes do Night: o Night (qwen3:1.7b local, conversa do dia a dia), o Codex (gpt-6-luna para pesquisa,
gpt-6-astra para código) e o Claude (haiku para pesquisa, modelo maior para código). O dono é o Joel.`;
const AGENTS_EN = `Night's agents: Night (local qwen3:1.7b, everyday chat), Codex (gpt-6-luna for research, gpt-6-astra
for code) and Claude (haiku for research, a larger model for code). The owner is Joel.`;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const hhmm = (iso: string) => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Bahia' });

/** Texto curto e determinístico. `selfId` é quem vai receber ("codex:gpt-6-luna"). */
export async function buildSharedContext(memory: Memory, selfId: string, language: Language): Promise<string> {
  const pt = language !== 'en';
  const [activity, tasks] = await Promise.all([memory.recentActivity(ACTIVITY_ITEMS), memory.listTasks()]);
  const open = tasks.filter((t) => !FINAL_TASK_STATUSES.includes(t.status));

  const lines: string[] = [
    pt ? `Você é ${selfId}, um dos agentes do Night.` : `You are ${selfId}, one of Night's agents.`,
    pt ? AGENTS_PT : AGENTS_EN,
  ];
  if (activity.length) {
    lines.push(pt ? 'Conversa recente (quem respondeu o quê):' : 'Recent conversation (who answered what):');
    for (const a of activity) {
      const who = a.model === 'rules' ? 'Night' : a.model;
      lines.push(`- [${hhmm(a.at)}] Joel: ${clip(a.text, 140)}${a.reply ? ` → ${who}: ${clip(a.reply, REPLY_CHARS)}` : ''}`);
    }
  }
  lines.push(open.length
    ? (pt ? 'Tarefas abertas:' : 'Open tasks:')
    : (pt ? 'Nenhuma tarefa aberta.' : 'No open tasks.'));
  for (const t of open) lines.push(`- ${t.id} (${t.primaryAgent}, ${t.status}): ${clip(t.objective, 120)}`);

  // Corta pelo começo da conversa, que é o menos útil, até caber.
  let text = lines.join('\n');
  while (text.length > MAX_CONTEXT_CHARS) {
    const i = lines.findIndex((l) => l.startsWith('- ['));
    if (i < 0) { text = text.slice(0, MAX_CONTEXT_CHARS); break; }
    lines.splice(i, 1);
    text = lines.join('\n');
  }
  return text;
}
