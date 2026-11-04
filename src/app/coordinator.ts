// NightCoordinator: texto do dono → roteador → ação → resposta (curta, para ser falada).
//
// Regras do blueprint que moram aqui:
// - "Salvei" só depois que o banco confirmou (§6).
// - Status vem do banco, nunca do modelo (§8).
// - Tarefa de código nunca é feita pelo modelo local (§12, teste 4): vai para o Claude/Codex numa worktree.
// - Nada é aprovado/cancelado por palpite do modelo: esses intents só vêm das regras do roteador.

import { randomUUID } from 'node:crypto';
import type { Intent, LocalLlm, Memory, ModelRouter } from '../core/interfaces.ts';
import type { ConversationTurn, Language, Project, Task } from '../core/types.ts';
import { FINAL_TASK_STATUSES } from '../core/types.ts';
import type { ResearchAgent } from '../agents/research.ts';
import { QuotaError } from '../agents/research.ts';
import { buildSharedContext } from '../agents/shared-context.ts';
import type { ChatAgent } from '../agents/chat.ts';
import { diffStat, otherAgent, type TaskScheduler } from '../agents/scheduler.ts';
import { detectLanguage, normalize, ruleIntent } from '../router/router.ts';
import { describePlan, detectRunner, findFolders, WindowLauncher, type FolderHit, type Launcher, type RunPlan } from '../tools/projects.ts';

export interface Reply {
  text: string;
  language: Language;
  intent: Intent['kind'];
  model: string;
  /** Resposta que chega depois (pesquisa): quem chamou fala/mostra quando resolver. */
  followUp?: Promise<Reply>;
  /** Texto longo para a tela, não para a voz (ex.: o diff). */
  detail?: string;
}

const HISTORY_TURNS = 6;
const QWEN_HISTORY_TURNS = 3;

const SYSTEM_PROMPT: Record<Language, string> = {
  'pt-BR': `Você é o Night, assistente pessoal do Joel, rodando no computador dele.
Jeito: bem-humorado, como um amigo esperto e meio debochado. Responda primeiro e direito; se couber, feche
com uma piadinha curta ou ironia leve (no máximo uma por resposta, e só se for natural).
Fale sério, sem piada, quando o assunto for erro, problema, dinheiro, segurança ou algo que preocupe o Joel.
Responda em português do Brasil, em 1 a 3 frases curtas, como fala (sem markdown, sem listas, sem emoji).
Você NÃO tem internet nem sabe nada sobre a vida do Joel, reuniões, empresas, pessoas, preços, notícias ou o futuro.
Se a pergunta depender disso, não chute: diga em uma frase que não sabe e que ele pode pedir "pesquisa isso".
Nunca diga que vai pesquisar nem que está pesquisando: quem pesquisa é outra parte do Night, não você.
Não repita a frase do Joel. Você não executa código nem tarefas por conta própria.`,
  en: `You are Night, Joel's personal assistant, running on his computer.
Style: good-humored, like a witty friend with a bit of sass. Answer first and correctly; if it fits, end with one
short joke or light irony (at most one, and only if it comes naturally).
Be serious, no jokes, when the topic is an error, a problem, money, security or something worrying Joel.
Answer in English, in 1 to 3 short spoken sentences (no markdown, no lists, no emoji).
You have NO internet and know nothing about Joel's life, meetings, companies, people, prices, news or the future.
If the question depends on that, don't guess: say in one sentence you don't know and that he can say "search for it".
Never say you will look it up or are searching: another part of Night does that, not you.
Don't repeat Joel's sentence back. You don't run code or tasks on your own.`,
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

/** "Bom dia, Night!" → "Bom dia!"; "Night, tudo bem?" → "tudo bem?". */
export function withoutVocative(text: string): string {
  return text.replace(/^\s*((hey|hi|oi|ola|olá|ok)[\s,]+)?night\b[\s,.!:;-]*/i, '').replace(/[\s,]+night\s*([.!?]*)\s*$/i, '$1').trim() || text;
}

/** Tira frases que o Night já disse nas últimas respostas: o 1.7B entra em loop repetindo a mesma frase. */
export function dropRepeats(reply: string, previous: string[]): string {
  const said = new Set(previous.flatMap(splitSentences).map((s) => s.toLowerCase()));
  return splitSentences(reply).filter((s) => !said.has(s.toLowerCase())).join(' ').trim();
}

const splitSentences = (t: string) => t.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);

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
    /** Executor das tarefas de código; sem ele, pedido de código só fica registrado. */
    private readonly tasks?: TaskScheduler,
    /** Conversa normal (alternando); vazio = só o Qwen local. */
    private readonly chatters: ChatAgent[] = [],
    /** Abre o projeto numa janela própria (só depois do "pode" do Joel). */
    private readonly launcher: Launcher = new WindowLauncher(),
    /** Procura de pastas (trocável nos testes). */
    private readonly folderSearch: (spoken: string) => FolderHit[] = (s) => findFolders(s),
  ) {}

  /** Rodar projeto espera o "pode": é uma ação no PC do Joel. */
  private pendingRun: { plan: RunPlan; title: string; at: number } | null = null;

  async handle(text: string, languageOverride?: Language): Promise<Reply> {
    const language = languageOverride ?? detectLanguage(text);
    await this.restoreHistory();

    if (this.pendingRun) {
      const pending = this.pendingRun;
      this.pendingRun = null;
      const n = normalize(withoutVocative(text));
      const fresh = Date.now() - pending.at < 5 * 60_000;
      // Só a confirmação inteira: "roda o outro projeto" não pode confirmar este.
      if (fresh && /^(sim|pode|pode sim|pode rodar|roda|rode|roda ai|manda|manda ver|confirmo|confirma|isso|ok|beleza|yes|go|go ahead|do it|sure)( sim| ai| la| pode| por favor| please)?[.!]*$/.test(n)) {
        const r = await this.launcher.launch(pending.plan, pending.title);
        const out = r.ok
          ? say(language, `Abri o ${pending.title} numa janela própria (${r.detail}). Feche a janela para parar.`, `Opened ${pending.title} in its own window (${r.detail}). Close the window to stop it.`)
          : say(language, `Não consegui rodar: ${r.detail}.`, `I couldn't run it: ${r.detail}.`);
        await this.memory.logRoute({ text, language, decision: { intent: { kind: 'run-project', target: pending.title }, model: 'rules', reason: 'confirmado pelo dono', usedPremiumQuota: false }, reply: out });
        return this.finish(text, language, out, 'run-project', 'rules');
      }
      // Qualquer outra coisa cancela o pedido de rodar e segue normal.
    }

    if (this.pendingIdea) {
      const { projectId } = this.pendingIdea;
      this.pendingIdea = null;
      // Se a próxima fala for um comando conhecido ("cancela a tarefa", "aprovo"...), é comando, não a ideia.
      const names = (await this.memory.listProjects()).map((p) => p.name);
      if (!ruleIntent(text, names)) {
        return this.finish(text, language, await this.saveIdea(text, projectId, language), 'save-idea', 'rules');
      }
    }

    const decision = await this.router.route(text, language);
    const { intent } = decision;
    if (intent.kind === 'research') {
      // O route_log desta vai depois, com o modelo que de fato respondeu e o uso de cota.
      const started = Date.now();
      this.researching.set(intent.query, started);
      const followUp = this.research(intent.query, language, decision.reason)
        .finally(() => this.researching.delete(intent.query));
      return { ...this.finish(text, language, say(language, 'Vou pesquisar isso, já te falo.', "I'll look that up, back in a moment."), 'research', 'rules'), followUp };
    }
    let out: string;
    let detail: string | undefined;
    let logged = decision;
    switch (intent.kind) {
      case 'chat': {
        const r = await this.converse(text, language);
        out = r.text;
        logged = { ...decision, model: r.model, reason: r.reason, usedPremiumQuota: r.premium };
        break;
      }
      case 'save-idea': out = await this.handleSaveIdea(intent, language); break;
      case 'find-ideas': out = await this.findIdeas(intent, language); break;
      case 'status': out = await this.status(language); break;
      case 'coding-task': out = await this.codingTask(intent, language); break;
      case 'cancel': out = await this.cancel(intent, language); break;
      case 'approval': out = await this.approval(intent, language); break;
      case 'set-project-path': out = await this.setProjectPath(intent, language); break;
      case 'show-diff': ({ text: out, detail } = await this.showDiff(intent, language)); break;
      case 'run-project': out = await this.prepareRun(intent.target, language); break;
      case 'find-folder': out = await this.findFolder(intent.target, language); break;
      case 'stop-speaking': out = ''; break;
    }
    // Grava depois de agir, com a resposta: é isso que os outros agentes vão ver no contexto.
    await this.memory.logRoute({ text, language, decision: logged, reply: out });
    return { ...this.finish(text, language, out, intent.kind, logged.model), ...(detail ? { detail } : {}) };
  }

  private chatTurn = 0;

  /**
   * Conversa: Codex gpt-6-luna e Claude Sonnet ALTERNANDO a cada mensagem (pedido do Joel, 04/11), o outro se
   * o da vez falhar, e o Qwen local só se os dois falharem (sem internet, limite de uso...).
   */
  private async converse(text: string, language: Language): Promise<{ text: string; model: string; reason: string; premium: boolean }> {
    const n = this.chatters.length;
    const failures: string[] = [];
    if (n > 0) {
      const start = this.chatTurn++ % n;
      const context = await buildSharedContext(this.memory, 'conversa', language);
      const history = this.history.slice(-10).map((t) => ({ role: t.role, text: t.text }));
      for (let i = 0; i < n; i++) {
        const agent = this.chatters[(start + i) % n]!;
        try {
          const reply = forSpeech(await agent.reply(history, withoutVocative(text), language, context));
          if (reply) return { text: reply, model: agent.id, reason: i === 0 ? 'conversa (vez dele)' : `conversa (reserva: ${failures.join('; ')})`, premium: true };
        } catch (err) {
          failures.push(`${agent.id}: ${err instanceof QuotaError ? 'no limite' : (err as Error).message.slice(0, 100)}`);
        }
      }
    }
    return { text: await this.chat(text, language), model: this.llm.model, reason: failures.length ? `conversa local (falharam: ${failures.join('; ')})` : 'conversa local', premium: false };
  }

  private restored = false;
  /** Pesquisas em andamento (pergunta → quando começou), para responder "tá pesquisando ainda?". */
  private researching = new Map<string, number>();

  /** Depois de reiniciar, a conversa recente vem do banco: o Night não "esquece" o que ele e os outros disseram. */
  private async restoreHistory(): Promise<void> {
    if (this.restored) return;
    this.restored = true;
    const past = await this.memory.recentActivity(HISTORY_TURNS);
    // As respostas antigas do próprio Qwen não voltam: o 1.7B copia a si mesmo e entra em loop ("Vou ver o
    // que é real" em toda resposta, uso real 04/11). O que os outros agentes e as regras disseram volta.
    // A troca inteira sai (pergunta e resposta): só a pergunta sozinha fazia ele responder a pergunta velha.
    this.history = past.filter((a) => a.intent !== 'chat' || !a.model.startsWith('qwen')).flatMap((a): ConversationTurn[] => [
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
    // Histórico curto para o 1.7B: com 6 trocas ele imitava respostas antigas e o formato do Codex
    // ("WEB, 4 de novembro de 2026") e repetia frases (uso real, 04/11). Fonte/data das pesquisas saem.
    const past = this.history.slice(-QWEN_HISTORY_TURNS * 2).map((t) => ({
      role: t.role === 'owner' ? ('user' as const) : ('assistant' as const),
      content: t.role === 'night' ? t.text.replace(/\s*(fonte|source|informa[cç][aã]o (do|da|consultada)|web)[:,]?[^.]*\d{4}\.?$/i, '').trim() : t.text,
    }));
    try {
      const reply = forSpeech(await this.llm.chat([
        { role: 'system', content: SYSTEM_PROMPT[language] },
        ...past,
        // Sem o "Night" de chamamento: senão o 1.7B responde "Bom dia, Night" achando que o Joel é o Night.
        { role: 'user', content: `${LANGUAGE_REMINDER[language]} ${withoutVocative(text)}` },
      ]));
      return dropRepeats(reply, this.history.filter((t) => t.role === 'night').slice(-3).map((t) => t.text)) || reply;
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
    const list = ideas.map((i, n) => `${n + 1}: ${i.title.replace(/[.!?…\s]+$/, '')}`).join('. ');
    return say(language, `${ideas.length === 1 ? 'Uma ideia' : `${ideas.length} ideias`}${project ? ` no ${project.name}` : ''}. ${list}.`,
      `${ideas.length === 1 ? 'One idea' : `${ideas.length} ideas`}${project ? ` for ${project.name}` : ''}. ${list}.`);
  }

  private async status(language: Language): Promise<string> {
    const open = (await this.memory.listTasks()).filter((t) => !FINAL_TASK_STATUSES.includes(t.status));
    const searching = [...this.researching.entries()].map(([q, at]) =>
      say(language, `pesquisando "${q.slice(0, 60)}" há ${Math.round((Date.now() - at) / 1000)} s`, `researching "${q.slice(0, 60)}" for ${Math.round((Date.now() - at) / 1000)} s`));
    const research = searching.length ? say(language, `Ainda tô ${searching.join('; ')}. `, `Still ${searching.join('; ')}. `) : '';
    if (open.length === 0) return research + say(language, 'Nenhuma tarefa aberta agora.', 'No open tasks right now.');
    if (research) return research + (await this.taskStatus(open, language));
    return this.taskStatus(open, language);
  }

  private async taskStatus(open: Task[], language: Language): Promise<string> {
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
    if (!project.repoPath) {
      return say(language,
        `O ${project.name} ainda não tem pasta cadastrada. Digite: a pasta do ${project.name} é C:\\caminho\\do\\repositório.`,
        `${project.name} has no folder yet. Type: the folder for ${project.name} is C:\\path\\to\\repo.`);
    }
    const agent = intent.agent ?? 'claude';
    // Colaboração (blueprint §8): o outro agente revisa, a não ser que o dono peça sem revisão.
    const noReview = /\bsem revis[aã]o\b|\bwithout review\b|\bno review\b/i.test(intent.objective);
    const task = await this.memory.createTask({
      id: randomUUID().slice(0, 8), projectId: project.id, objective: intent.objective, scope: '',
      status: this.tasks ? 'queued' : 'captured', primaryAgent: agent, reviewAgent: noReview ? null : otherAgent(agent),
      worktreePath: null, branch: null, baseRef: null, resultSummary: null, approvalState: 'none',
    });
    if (!this.tasks) {
      return say(language, `Registrei a tarefa ${task.id} no ${project.name} para o ${agent}, mas quem executa tarefas é a outra janela do Night que está aberta; ela pega quando essa fechar e abrir de novo.`,
        `I registered task ${task.id} in ${project.name} for ${agent}, but another open Night window runs tasks; it starts when that one is reopened.`);
    }
    await this.tasks.enqueue(task.id);
    const reviewer = task.reviewAgent ? say(language, `, e o ${task.reviewAgent} revisa`, `, and ${task.reviewAgent} reviews it`) : '';
    return say(language,
      `Mandei a tarefa ${task.id} para o ${agent} no ${project.name}${reviewer}. Trabalha numa pasta separada; te aviso quando terminar.`,
      `Sent task ${task.id} to ${agent} in ${project.name}${reviewer}. It works in a separate folder; I'll tell you when it's done.`);
  }

  private async setProjectPath(intent: Extract<Intent, { kind: 'set-project-path' }>, language: Language): Promise<string> {
    const project = await this.resolveProject(intent.projectHint);
    if (!project) return say(language, 'De qual projeto é essa pasta? Fale o nome junto.', 'Which project is that folder for? Say the name too.');
    const branch = await defaultBranchOf(intent.path);
    if (!branch.ok) return say(language, `Essa pasta não é um repositório git: ${intent.path}.`, `That folder isn't a git repository: ${intent.path}.`);
    await this.memory.upsertProject({ ...project, repoPath: intent.path, defaultBranch: branch.name });
    return say(language, `Pronto: o ${project.name} agora é ${intent.path}, branch ${branch.name}.`,
      `Done: ${project.name} is now ${intent.path}, branch ${branch.name}.`);
  }

  /** Tarefas abertas que batem com a dica (projeto ou "all"); sem dica, só se houver uma. */
  private async pickTasks(hint: string | null, pool: Task[]): Promise<Task[]> {
    if (hint === 'all') return pool;
    const project = hint ? await this.resolveProject(hint) : null;
    if (project) return pool.filter((t) => t.projectId === project.id);
    return pool.length === 1 ? pool : [];
  }

  private async cancel(intent: Extract<Intent, { kind: 'cancel' }>, language: Language): Promise<string> {
    const open = (await this.memory.listTasks()).filter((t) => !FINAL_TASK_STATUSES.includes(t.status));
    if (open.length === 0) return say(language, 'Não tem tarefa aberta para cancelar.', 'There is no open task to cancel.');
    const targets = await this.pickTasks(intent.taskHint, open);
    if (targets.length === 0) return say(language, `Tem ${open.length} tarefas abertas. Qual delas? Fale o projeto ou "cancela tudo".`,
      `There are ${open.length} open tasks. Which one? Say the project or "cancel everything".`);
    const results: string[] = [];
    for (const t of targets) {
      if (this.tasks) {
        const r = await this.tasks.cancel(t.id);
        results.push(`${t.id}: ${r.detail}`);
      } else if (t.status === 'captured') {
        // Sem executor nesta janela: só dá para cancelar o que nunca começou. Mudar o status de uma tarefa
        // viva da outra janela deixaria o processo do agente rodando.
        await this.memory.updateTaskStatus(t.id, 'cancelled', 'owner', 'cancelada por comando');
        results.push(t.id);
      } else {
        return say(language, `A tarefa ${t.id} está com a outra janela do Night; cancele por lá para o processo parar de verdade.`,
          `Task ${t.id} belongs to the other Night window; cancel it there so the process really stops.`);
      }
    }
    return say(language, `Cancelei ${targets.length === 1 ? 'a tarefa' : `${targets.length} tarefas`}${this.tasks ? ` (${results.join('; ')})` : ''}.`,
      `Cancelled ${targets.length === 1 ? 'the task' : `${targets.length} tasks`}${this.tasks ? ` (${results.join('; ')})` : ''}.`);
  }

  private async waitingTasks(): Promise<Task[]> {
    const pending = new Set((await this.memory.listPendingApprovals()).map((a) => a.taskId));
    return (await this.memory.listTasks({ status: ['awaiting-approval'] })).filter((t) => pending.has(t.id));
  }

  private async approval(intent: Extract<Intent, { kind: 'approval' }>, language: Language): Promise<string> {
    const waiting = await this.waitingTasks();
    if (waiting.length === 0) return say(language, 'Não tem nada esperando aprovação.', 'Nothing is waiting for approval.');
    if (!this.tasks) return say(language, 'Quem cuida das tarefas é a outra janela do Night; aprove por lá.', "Another Night window handles tasks; approve there.");
    const targets = await this.pickTasks(intent.taskHint, waiting);
    if (targets.length !== 1) {
      return say(language, `Tem ${waiting.length} tarefas esperando. Fale o projeto junto, por exemplo "aprovo a do ${(await this.memory.getProject(waiting[0]!.projectId))?.name ?? 'projeto'}".`,
        `${waiting.length} tasks are waiting. Say the project too.`);
    }
    try {
      const r = intent.decision === 'approve' ? await this.tasks.approve(targets[0]!.id) : await this.tasks.reject(targets[0]!.id);
      return r.message;
    } catch (err) {
      return say(language, `Não consegui: ${(err as Error).message}.`, `I couldn't: ${(err as Error).message}.`);
    }
  }

  private async showDiff(intent: Extract<Intent, { kind: 'show-diff' }>, language: Language): Promise<{ text: string; detail?: string }> {
    const candidates = (await this.memory.listTasks()).filter((t) => t.worktreePath && !FINAL_TASK_STATUSES.includes(t.status));
    if (!this.tasks || candidates.length === 0) return { text: say(language, 'Não tem mudança de agente para mostrar.', 'No agent changes to show.') };
    const [task] = await this.pickTasks(intent.taskHint, candidates);
    if (!task) return { text: say(language, `Tem ${candidates.length} tarefas com mudanças. Fale o projeto junto.`, `${candidates.length} tasks have changes. Say the project too.`) };
    const { diff } = await this.tasks.changes(task.id);
    const names = diff.changedFiles.slice(0, 5).map((f) => f.path.split('/').pop()).join(', ');
    const more = diff.changedFiles.length > 5 ? say(language, ` e mais ${diff.changedFiles.length - 5}`, ` and ${diff.changedFiles.length - 5} more`) : '';
    const text = say(language,
      `A tarefa ${task.id} mudou ${diff.changedFiles.length} arquivo${diff.changedFiles.length === 1 ? '' : 's'}: ${names}${more}. O diff completo está na tela.`,
      `Task ${task.id} changed ${diff.changedFiles.length} file${diff.changedFiles.length === 1 ? '' : 's'}: ${names}${more}. The full diff is on screen.`);
    return { text, detail: `${task.resultSummary ?? ''}\n\n${diffStat(diff)}\n\n${diff.patch}`.trim() };
  }

  /** Acha a pasta: primeiro nos projetos cadastrados, depois no PC (Desktop, Documentos, D:). */
  private async locate(target: string): Promise<{ name: string; dir: string } | { ambiguous: FolderHit[] } | null> {
    const project = await this.memory.findProjectByName(target);
    if (project?.repoPath) return { name: project.name, dir: project.repoPath };
    const hits = this.folderSearch(target);
    if (hits.length === 0) return null;
    if (hits.length > 1 && hits[0]!.score - hits[1]!.score < 5) return { ambiguous: hits.slice(0, 3) };
    const best = hits[0]!;
    // Cadastra como projeto, para depois dar para pedir código nele ("pede pro Claude ... no AWS PREP").
    const branch = await defaultBranchOf(best.path);
    const existing = await this.memory.findProjectByName(best.name);
    await this.memory.upsertProject({
      id: existing?.id ?? best.name.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
      name: existing?.name ?? best.name, description: existing?.description ?? 'achado no PC pelo Night',
      repoPath: best.path, defaultBranch: branch.ok ? branch.name : null, allowedPaths: existing?.allowedPaths ?? [], status: 'active',
    });
    return { name: best.name, dir: best.path };
  }

  private async findFolder(target: string, language: Language): Promise<string> {
    if (!target) return say(language, 'Qual pasta? Fala o nome dela.', 'Which folder? Say its name.');
    const found = await this.locate(target);
    if (!found) return say(language, `Não achei nenhuma pasta parecida com "${target}" no Desktop, em Documentos nem no D:.`, `I couldn't find a folder like "${target}" in Desktop, Documents or D:.`);
    if ('ambiguous' in found) return say(language, `Achei mais de uma: ${found.ambiguous.map((h) => h.name).join(', ')}. Qual delas?`, `I found more than one: ${found.ambiguous.map((h) => h.name).join(', ')}. Which one?`);
    return say(language, `Achei: ${found.dir}. Cadastrei como projeto ${found.name}.`, `Found it: ${found.dir}. Registered as project ${found.name}.`);
  }

  private async prepareRun(target: string, language: Language): Promise<string> {
    const found = await this.locate(target);
    if (!found) return say(language, `Não achei nenhuma pasta parecida com "${target}". Fala o nome de novo ou digite o caminho.`, `I couldn't find a folder like "${target}". Say the name again or type the path.`);
    if ('ambiguous' in found) return say(language, `Achei mais de uma: ${found.ambiguous.map((h) => h.name).join(', ')}. Qual delas?`, `I found more than one: ${found.ambiguous.map((h) => h.name).join(', ')}. Which one?`);
    const plan = detectRunner(found.dir);
    const how = describePlan(plan, language !== 'en');
    if (plan.kind === 'unknown') return say(language, `Achei ${found.dir}, mas ${how.charAt(0).toLowerCase()}${how.slice(1)}`, `Found ${found.dir}, but ${how}`);
    this.pendingRun = { plan, title: found.name, at: Date.now() };
    const where = plan.dir === found.dir ? found.dir : plan.dir;
    return say(language, `Achei o ${found.name} em ${where}. ${how} Posso rodar?`, `Found ${found.name} at ${where}. ${how} Shall I run it?`);
  }
}

/** O branch atual de um repositório (para cadastrar o projeto). */
async function defaultBranchOf(repo: string): Promise<{ ok: true; name: string } | { ok: false }> {
  const { execFile } = await import('node:child_process');
  return new Promise((resolve) => {
    execFile('git', ['-C', repo, 'symbolic-ref', '--short', 'HEAD'], { windowsHide: true }, (err, stdout) => {
      resolve(err ? { ok: false } : { ok: true, name: stdout.trim() });
    });
  });
}
