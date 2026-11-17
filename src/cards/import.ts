// Importação de cartão validado para uma tarefa de código (S04).
// O cartão é o contrato do que o agente pode fazer; a tarefa guarda id, revisão e hash
// para o resumo do diff provar qual versão aprovada o agente recebeu.

import { randomUUID } from 'node:crypto';
import type { Memory } from '../core/interfaces.ts';
import type { AgentName, Id, Task } from '../core/types.ts';
import { FINAL_TASK_STATUSES } from '../core/types.ts';
import type { Card, CardError } from './card.ts';
import { cardHash, explainInvalid, isPathAllowed, validateCard } from './card.ts';

export interface ImportOptions {
  projectId: Id;
  primaryAgent: AgentName;
  reviewAgent: AgentName | null;
}

/** Inválido não cria tarefa: devolve os erros para o Joel corrigir e a frase para falar. */
export type ImportResult =
  | { ok: true; task: Task }
  | { ok: false; errors: CardError[]; mensagem: string };

/** Recusa igual na primeira leitura e depois de perder a corrida: hash diferente na mesma revisão. */
function cartaoMudou(card: Card): ImportResult {
  const problema = 'o cartão mudou sem subir a revisão';
  return {
    ok: false,
    errors: [{ campo: 'revisao', problema }],
    mensagem: `Cartão ${card.id}: ${problema}; suba a revisão para importar de novo.`,
  };
}

/** Outra importação gravou a tarefa primeiro: o índice único parcial (migração 010) barrou esta. */
function perdeuACorrida(err: unknown): boolean {
  const e = err as { code?: string; constraint?: string };
  return e?.code === '23505' && e?.constraint === 'tasks_card_open';
}

/** Tarefas do cartão e da revisão, só neste projeto: um cartão aqui não diz nada sobre outro projeto. */
async function tarefasDaRevisao(memory: Memory, projectId: Id, card: Card): Promise<Task[]> {
  const doCartao = (await memory.listTasks({ projectId })).filter((t) => t.cardId === card.id);
  return doCartao.filter((t) => t.cardRevision === card.revisao);
}

/** Bloco de lista legível; lista vazia aparece como "nenhum" em vez de sumir sem explicação. */
function bloco(titulo: string, itens: string[], vazio: string): string {
  const linhas = itens.length > 0 ? itens.map((item) => `- ${item}`) : [`- ${vazio}`];
  return `${titulo}:\n${linhas.join('\n')}`;
}

/** Texto que o agente lê: objetivo direto e escopo com tudo o que o cartão combinou. */
export function taskFieldsFromCard(card: Card): { objective: string; scope: string } {
  return {
    objective: `${card.titulo} — ${card.objetivo}`,
    scope: [
      `Escopo:\n${card.escopo}`,
      bloco('Fora do escopo', card.foraDoEscopo, 'nada declarado'),
      bloco('Arquivos permitidos', card.arquivosPermitidos, 'nenhum'),
      bloco('Critérios de pronto', card.criteriosDePronto, 'nenhum'),
      bloco('Testes', card.testes, 'nenhum'),
    ].join('\n\n'),
  };
}

/**
 * Importa o cartão para uma tarefa em 'queued'.
 * Reimportar o mesmo cartão devolve a tarefa que já existe; mudar o conteúdo sem subir
 * a revisão é recusado, porque o agente não pode receber um contrato diferente do aprovado.
 * Duas importações simultâneas: o índice único da migração 010 barra a segunda, que relê e
 * devolve a tarefa da primeira.
 */
export async function importCard(memory: Memory, raw: unknown, opts: ImportOptions): Promise<ImportResult> {
  const validacao = validateCard(raw);
  if (!validacao.ok) {
    return { ok: false, errors: validacao.errors, mensagem: explainInvalid(validacao.errors) };
  }
  const card = validacao.card;
  const hash = cardHash(card);

  const mesmaRevisao = await tarefasDaRevisao(memory, opts.projectId, card);
  if (mesmaRevisao.some((t) => t.cardHash !== hash)) return cartaoMudou(card);

  // Mesmo cartão (id, revisão e hash) já na fila: devolve a tarefa existente, sem duplicar.
  const existente = mesmaRevisao.find((t) => !FINAL_TASK_STATUSES.includes(t.status));
  if (existente) return { ok: true, task: existente };

  const { objective, scope } = taskFieldsFromCard(card);
  try {
    const task = await memory.createTask({
      id: randomUUID().slice(0, 8),
      projectId: opts.projectId,
      objective,
      scope,
      status: 'queued',
      primaryAgent: opts.primaryAgent,
      reviewAgent: opts.reviewAgent,
      worktreePath: null,
      branch: null,
      baseRef: null,
      resultSummary: null,
      approvalState: 'none',
      cardId: card.id,
      cardRevision: card.revisao,
      cardHash: hash,
    });
    return { ok: true, task };
  } catch (err) {
    if (!perdeuACorrida(err)) throw err;
    // Duas importações simultâneas não se viram na leitura: a outra criou a tarefa primeiro.
    // Reler e devolver a dela mantém a promessa de "mesmo cartão, mesma tarefa".
    const depois = await tarefasDaRevisao(memory, opts.projectId, card);
    if (depois.some((t) => t.cardHash !== hash)) return cartaoMudou(card);
    const daOutra = depois.find((t) => !FINAL_TASK_STATUSES.includes(t.status));
    if (daOutra) return { ok: true, task: daOutra };
    // Corrida improvável: a tarefa da outra terminou entre o insert recusado e esta leitura.
    throw new Error(`cartão ${card.id}: outra importação criou a tarefa e ela já terminou; importe de novo`);
  }
}

/** Confere o diff final contra o cartão: arquivo fora do escopo aparece para o Joel. */
export function checkDiffAgainstCard(card: Card, changedFiles: string[]): { ok: boolean; foraDoCartao: string[] } {
  const foraDoCartao = changedFiles.filter((arquivo) => !isPathAllowed(card, arquivo));
  return { ok: foraDoCartao.length === 0, foraDoCartao };
}

/** Referência curta para o resumo do diff: 'cartão NIGHT-12 r2 (hash abc123def456)'. */
export function cardReference(task: Pick<Task, 'cardId' | 'cardRevision' | 'cardHash'>): string | null {
  if (task.cardId === null || task.cardRevision === null || task.cardHash === null) return null;
  return `cartão ${task.cardId} r${task.cardRevision} (hash ${task.cardHash.slice(0, 12)})`;
}
