// NightCoordinator: texto do dono → roteador → ação → resposta (curta, para ser falada).
//
// Regras do blueprint que moram aqui:
// - "Salvei" só depois que o banco confirmou (§6).
// - Status vem do banco, nunca do modelo (§8).
// - Tarefa de código não é executada pelo modelo local (§12, teste 4): vira tarefa registrada.
// - Nada é aprovado/cancelado por palpite do modelo: esses intents só vêm das regras do roteador.

import { randomUUID } from 'node:crypto';
import type { Intent, LocalLlm, Memory, ModelRouter } from '../core/interfaces.ts';
import type { ConversationTurn, Language, Project, Task } from '../core/types.ts';
import { FINAL_TASK_STATUSES } from '../core/types.ts';
import type { ResearchAgent } from '../agents/research.ts';
import { QuotaError } from '../agents/research.ts';
import { buildSharedContext } from '../agents/shared-context.ts';
import { detectLanguage } from '../router/router.ts';

export interface Reply {
  text: string;
  language: Language;
  intent: Intent['kind'];
  model: string;
  /** Resposta que chega depois (pesquisa): quem chamou fala/mostra quando resolver. */
  followUp?: Promise<Reply>;
}

const HISTORY_TURNS = 6;

const SYSTEM_PROMPT: Record<Language, string> = {
  'pt-BR': `Você é o Night, assistente pessoal do Joel, rodando no computador dele.
Jeito: bem-humorado, como um amigo esperto e meio debochado. Responda primeiro e direito; se couber, feche
com uma piadinha curta ou ironia leve (no máximo uma por resposta, e só se for natural).
Fale sério, sem piada, quando o assunto for erro, problema, dinheiro, segurança ou algo que preocupe o Joel.
Responda em português do Brasil, em 1 a 3 frases curtas, como fala (sem markdown, sem listas, sem emoji).
Se não souber um fato atual, diga que não sabe; não invente. Você não executa código nem tarefas por conta própria.`,
  en: `You are Night, Joel's personal assistant, running on his computer.
Style: good-humored, like a witty friend with a bit of sass. Answer first and correctly; if it fits, end with one
short joke or light irony (at most one, and only if it comes naturally).
Be serious, no jokes, when the topic is an error, a problem, money, security or something worrying Joel.
Answer in English, in 1 to 3 short spoken sentences (no markdown, no lists, no emoji).
If you don't know a current fact, say so; don't make things up. You don't run code or tasks on your own.`,
};

// Vai no COMEÇO da fala do dono. Medido em 03/11 com qwen3:1.7b, histórico em PT e pergunta em EN:
// só no system 0/3, system extra antes da pergunta 0/3, no fim da fala 0/5, no começo da fala 5/5.
const LANGUAGE_REMINDER: Record<Language, string> = {
  'pt-BR': '(Responda em português do Brasil.)',
  en: '(Reply in English.)',
};

const say = (lang: Language, pt: string, en: string) => (lang === 'en' ? en : pt);

/** A resposta vai ser falada: o Qwen 1.7B põe emoji e markdown mesmo mandado não pôr. */
export function forSpeech(text: string): string {
  return text
    .replace(/[\p{Extended_Pictographic}\p{Emoji_Modifier}\u{FE0F}\u{200D}]/gu, '')
    .replace(/\*\*?|__|`+|^#+\s*/gm, '')
    .replace(/^\s*[-•]\s+/gm, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s+([.,!?])/g, '$1')
    .trim();
}

export class NightCoordinator {
  private history: ConversationTurn[] = [];
  /** "Salva uma ideia para o Abstrike" sem a ideia: a próxima fala é a ideia. */
  private pendingIdea: { projectId: string | null } | null = null;

  constructor(
    private readonly memory: Memory,
    private readonly router: ModelRouter,
    private readonly llm: LocalLlm,
    /** Em ordem de preferência; o próximo só entra se o anterior falhar ou estiver no limite. */
    private readonly researchers: ResearchAgent[] = [],
  ) {}

  async handle(text: string, languageOverride?: Language): Promise<Reply> {
    const language = languageOverride ?? detectLanguage(text);
    await this.restoreHistory();

    if (this.pendingIdea) {
      const { projectId } = this.pendingIdea;
      this.pendingIdea = null;
      return this.finish(text, language, await this.saveIdea(text, projectId, language), 'save-idea', 'rules');
    }

    const decision = await this.router.route(text, language);
    const { intent } = decision;
    if (intent.kind === 'research') {
      // O route_log desta vai depois, com o modelo que de fato respondeu e o uso de cota.
      const followUp = this.research(intent.query, language, decision.reason);
      return { ...this.finish(text, language, say(language, 'Vou pesquisar isso, já te falo.', "I'll look that up, back in a moment."), 'research', 'rules'), followUp };
    }
    let out: string;
    switch (intent.kind) {
      case 'chat': out = await this.chat(text, language); break;
      case 'save-idea': out = await this.handleSaveIdea(intent, language); break;
      case 'find-ideas': out = await this.findIdeas(intent, language); break;
      case 'status': out = await this.status(language); break;
      case 'coding-task': out = await this.codingTask(intent, language); break;
      case 'cancel': out = await this.cancel(intent, language); break;
      case 'approval': out = await this.approval(intent, language); break;
      case 'stop-speaking': out = ''; break;
    }
    // Grava depois de agir, com a resposta: é isso que os outros agentes vão ver no contexto.
    await this.memory.logRoute({ text, language, decision, reply: out });
    return this.finish(text, language, out, intent.kind, decision.model);
  }

  private restored = false;

  /** Depois de reiniciar, a conversa recente vem do banco: o Night não "esquece" o que ele e os outros disseram. */
  private async restoreHistory(): Promise<void> {
    if (this.restored) return;
    this.restored = true;
    const past = await this.memory.recentActivity(HISTORY_TURNS);
    this.history = past.flatMap((a): ConversationTurn[] => [
      { role: 'owner', text: a.text, at: a.at },
      ...(a.reply ? [{ role: 'night' as const, text: a.reply, at: a.at }] : []),
    ]).slice(-HISTORY_TURNS * 2);
  }

  /** Resposta que chega depois: a pergunta já está no histórico, só entra a fala do Night. */
  private lateReply(language: Language, text: string, intent: Intent['kind'], model: string): Reply {
    this.history.push({ role: 'night', text, at: new Date().toISOString() });
    this.history = this.history.slice(-HISTORY_TURNS * 2);
    return { text, language, intent, model };
  }

  private finish(input: string, language: Language, text: string, intent: Intent['kind'], model: string): Reply {
    const at = new Date().toISOString();
    this.history.push({ role: 'owner', text: input, at }, { role: 'night', text, at });
    this.history = this.history.slice(-HISTORY_TURNS * 2);
    return { text, language, intent, model };
  }

  private async chat(text: string, language: Language): Promise<string> {
    const past = this.history.map((t) => ({
      role: t.role === 'owner' ? ('user' as const) : ('assistant' as const), content: t.text,
    }));
    try {
      return forSpeech(await this.llm.chat([
        { role: 'system', content: SYSTEM_PROMPT[language] },
        ...past,
        { role: 'user', content: `${LANGUAGE_REMINDER[language]} ${text}` },
      ]));
    } catch (err) {
      return say(language, `Não consegui falar com o modelo local: ${(err as Error).message}`,
        `I couldn't reach the local model: ${(err as Error).message}`);
    }
  }

  /** Tenta cada pesquisador em ordem. Nunca cai para modelo pago por API: só as CLIs da assinatura. */
  private async research(query: string, language: Language, routeReason: string): Promise<Reply> {
    const failures: string[] = []; // detalhe técnico: vai para o route_log
    const spoken: string[] = []; // curto: vai para a voz
    for (const agent of this.researchers) {
      try {
        // Cada agente recebe o contexto compartilhado: quem ele é, os outros, a conversa e as tarefas.
        const context = await buildSharedContext(this.memory, agent.id, language);
        const { answer, ms } = await agent.ask(query, language, context);
        const spokenAnswer = forSpeech(answer);
        await this.memory.logRoute({
          text: query, language, reply: spokenAnswer,
          decision: { intent: { kind: 'research', query }, model: agent.id, reason: `${routeReason}; respondeu em ${(ms / 1000).toFixed(0)} s`, usedPremiumQuota: true },
        });
        return this.lateReply(language, spokenAnswer, 'research', agent.id);
      } catch (err) {
        const quota = err instanceof QuotaError;
        failures.push(`${agent.id}: ${quota ? 'no limite de uso' : (err as Error).message.slice(0, 200)}`);
        const name = agent.id.startsWith('codex') ? 'o Codex' : agent.id.startsWith('claude') ? 'o Claude' : agent.id;
        spoken.push(say(language, `${name} ${quota ? 'está no limite de uso' : 'deu erro'}`,
          `${name.replace(/^o /, '')} ${quota ? 'is at its usage limit' : 'failed'}`));
      }
    }
    await this.memory.logRoute({
      text: query, language,
      decision: { intent: { kind: 'research', query }, model: 'none', reason: `pesquisa falhou: ${failures.join(' | ') || 'nenhum pesquisador configurado'}`, usedPremiumQuota: false },
    });
    const why = spoken.length ? spoken.join(say(language, ' e ', ' and ')) : say(language, 'não tem pesquisador configurado', 'no researcher is configured');
    return this.lateReply(language,
      say(language, `Não consegui pesquisar agora: ${why}. E não vou chutar a resposta.`, `I couldn't look it up right now: ${why}. And I won't guess.`),
      'research', 'none');
  }

  private async resolveProject(hint: string | null): Promise<Project | null> {
    return hint ? this.memory.findProjectByName(hint) : null;
  }

  private async handleSaveIdea(intent: Extract<Intent, { kind: 'save-idea' }>, language: Language): Promise<string> {
    const project = await this.resolveProject(intent.projectHint);
    if (!intent.text) {
      this.pendingIdea = { projectId: project?.id ?? null };
      return say(language, project ? `Pode falar a ideia para o ${project.name}.` : 'Pode falar a ideia.',
        project ? `Go ahead with the idea for ${project.name}.` : 'Go ahead with the idea.');
    }
    return this.saveIdea(intent.text, project?.id ?? null, language, project);
  }

  private async saveIdea(body: string, projectId: string | null, language: Language, project?: Project | null): Promise<string> {
    const title = body.length > 70 ? `${body.slice(0, 67).trimEnd()}...` : body;
    try {
      await this.memory.saveIdea({ projectId, title, transcript: body });
    } catch (err) {
      return say(language, `Não salvei: deu erro no banco (${(err as Error).message}).`,
        `I did not save it: database error (${(err as Error).message}).`);
    }
    const name = project?.name ?? (projectId ? (await this.memory.getProject(projectId))?.name : null);
    return say(language, name ? `Salvei a ideia no ${name}.` : 'Salvei a ideia, sem projeto.',
      name ? `Saved the idea under ${name}.` : 'Saved the idea, with no project.');
  }

  private async findIdeas(intent: Extract<Intent, { kind: 'find-ideas' }>, language: Language): Promise<string> {
    const project = await this.resolveProject(intent.projectHint);
    const ideas = await this.memory.findIdeas({ projectId: project?.id, text: intent.query || undefined, status: 'inbox', limit: 5 });
    if (ideas.length === 0) {
      return say(language, project ? `Não tem ideia guardada no ${project.name}.` : 'Não tem ideia guardada.',
        project ? `No saved ideas for ${project.name}.` : 'No saved ideas.');
    }
    const list = ideas.map((i, n) => `${n + 1}: ${i.title}`).join('. ');
    return say(language, `${ideas.length === 1 ? 'Uma ideia' : `${ideas.length} ideias`}${project ? ` no ${project.name}` : ''}. ${list}.`,
      `${ideas.length === 1 ? 'One idea' : `${ideas.length} ideas`}${project ? ` for ${project.name}` : ''}. ${list}.`);
  }

  private async status(language: Language): Promise<string> {
    const open = (await this.memory.listTasks()).filter((t) => !FINAL_TASK_STATUSES.includes(t.status));
    if (open.length === 0) return say(language, 'Nenhuma tarefa aberta agora.', 'No open tasks right now.');
    const describe = (t: Task) => `${t.objective.slice(0, 60)} (${t.primaryAgent}, ${t.status})`;
    return say(language, `${open.length} tarefa${open.length > 1 ? 's' : ''} aberta${open.length > 1 ? 's' : ''}: ${open.map(describe).join('; ')}.`,
      `${open.length} open task${open.length > 1 ? 's' : ''}: ${open.map(describe).join('; ')}.`);
  }

  private async codingTask(intent: Extract<Intent, { kind: 'coding-task' }>, language: Language): Promise<string> {
    const project = await this.resolveProject(intent.projectHint);
    if (!project) {
      const names = (await this.memory.listProjects()).map((p) => p.name).join(', ');
      return say(language, `Para qual projeto? ${names ? `Tenho: ${names}.` : 'Ainda não tem projeto cadastrado.'}`,
        `Which project? ${names ? `I have: ${names}.` : 'No projects registered yet.'}`);
    }
    const agent = intent.agent ?? 'claude';
    const task = await this.memory.createTask({
      id: randomUUID().slice(0, 8), projectId: project.id, objective: intent.objective, scope: '',
      status: 'captured', primaryAgent: agent, reviewAgent: null, worktreePath: null, branch: null,
      baseRef: null, resultSummary: null, approvalState: 'none',
    });
    // Os adaptadores dos agentes (M5) ainda não existem: a tarefa fica registrada, sem executar.
    return say(language,
      `Registrei a tarefa ${task.id} no ${project.name} para o ${agent}. Ainda não consigo rodar agentes, então ela fica parada até essa parte existir.`,
      `I registered task ${task.id} in ${project.name} for ${agent}. I can't run agents yet, so it stays on hold until that part exists.`);
  }

  private async cancel(intent: Extract<Intent, { kind: 'cancel' }>, language: Language): Promise<string> {
    const open = (await this.memory.listTasks()).filter((t) => !FINAL_TASK_STATUSES.includes(t.status));
    const project = intent.taskHint && intent.taskHint !== 'all' ? await this.resolveProject(intent.taskHint) : null;
    const targets = project ? open.filter((t) => t.projectId === project.id) : intent.taskHint === 'all' ? open : open.length === 1 ? open : [];
    if (open.length === 0) return say(language, 'Não tem tarefa aberta para cancelar.', 'There is no open task to cancel.');
    if (targets.length === 0) return say(language, `Tem ${open.length} tarefas abertas. Qual delas? Fale o projeto ou "cancela tudo".`,
      `There are ${open.length} open tasks. Which one? Say the project or "cancel everything".`);
    // Nenhum agente roda ainda (M5), então cancelar é só mudar o status: não há processo para matar.
    for (const t of targets) await this.memory.updateTaskStatus(t.id, 'cancelled', 'owner', 'cancelada por comando');
    return say(language, `Cancelei ${targets.length === 1 ? 'a tarefa' : `${targets.length} tarefas`}.`,
      `Cancelled ${targets.length === 1 ? 'the task' : `${targets.length} tasks`}.`);
  }

  private async approval(_intent: Extract<Intent, { kind: 'approval' }>, language: Language): Promise<string> {
    const pending = await this.memory.listPendingApprovals();
    if (pending.length === 0) return say(language, 'Não tem nada esperando aprovação.', 'Nothing is waiting for approval.');
    // Decidir merge depende do WorktreeManager (M4, Codex). Até lá, não decide nada por voz.
    return say(language, `Tem ${pending.length} pedido${pending.length > 1 ? 's' : ''} esperando, mas a aprovação por voz ainda não está ligada.`,
      `${pending.length} request${pending.length > 1 ? 's are' : ' is'} waiting, but voice approval isn't wired up yet.`);
  }
}
