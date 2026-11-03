// Roteador do Night (blueprint §5, "spend premium capacity only when useful").
//
// 1. Regras fixas primeiro: comandos conhecidos em PT/EN são reconhecidos sem modelo nenhum.
// 2. Aprovar, rejeitar, cancelar e "parar de falar" SÓ saem das regras. O modelo local nunca
//    produz esses intents: um erro de classificação não pode virar merge ou cancelamento.
// 3. Sem regra, mas com cara de comando (fala de ideia, tarefa, projeto, Claude/Codex): o Qwen
//    classifica em JSON, e a saída é validada. Inválida = conversa.
// 4. O resto é conversa com o Qwen local. Nada aqui usa cota premium.

import type { Intent, LocalLlm, ModelRouter, RouteDecision } from '../core/interfaces.ts';
import type { AgentName, Language } from '../core/types.ts';

/** minúsculas, sem acento, espaços simples: "Salvá  ESSA" → "salva essa" */
export function normalize(text: string): string {
  return text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

const PT_HINTS = /\b(que|nao|voce|essa|esse|isso|para|pra|minha|meu|ta|esta|como|qual|quais|uma|tarefa|ideia|salva|obrigado|oi|ola|projeto|faz|tem)\b/g;
const EN_HINTS = /\b(the|is|what|you|this|that|my|and|to|for|how|which|task|idea|save|thanks|hi|hello|project|are|please|can)\b/g;

/** Palpite de idioma pelo texto. Empate fica em português, que é o padrão do dono. */
export function detectLanguage(text: string): Language {
  const raw = text.toLowerCase();
  const n = normalize(text);
  const pt = (n.match(PT_HINTS)?.length ?? 0) + (/[ãõçáéêíóú]/.test(raw) ? 2 : 0);
  const en = n.match(EN_HINTS)?.length ?? 0;
  return en > pt ? 'en' : 'pt-BR';
}

function agentIn(n: string): AgentName | null {
  if (/\bclaude\b/.test(n)) return 'claude';
  if (/\bcodex\b/.test(n)) return 'codex';
  return null;
}

/** Acha o nome de um projeto cadastrado dentro da frase. O mais longo ganha ("Abstrike Pro" > "Abstrike"). */
export function projectIn(n: string, projectNames: string[]): string | null {
  const hits = projectNames.filter((p) => new RegExp(`\\b${escapeRe(normalize(p))}\\b`).test(n));
  return hits.sort((a, b) => b.length - a.length)[0] ?? null;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const SAVE_IDEA = /\b(salva|salve|salvar|guarda|guarde|anota|anote|registra|registre)\b.{0,20}\bideia\b|\b(save|note|record|jot down)\b.{0,15}\bidea\b|\bnova ideia\b|\bnew idea\b/;
const FIND_IDEAS = /\b(quais|mostra|mostre|lista|liste|lembra|busca|procura)\b.{0,25}\bideias?\b|\b(list|show|find|what|which|recall)\b.{0,20}\bideas\b|\bminhas ideias\b|\bmy ideas\b/;
const STATUS = /\bo que (voce )?(esta|ta) (fazendo|rodando)\b|\b(o que|que) (esta|ta) rodando\b|\bwhat('?s| is| are)( you)? (running|doing|working on)\b|\bstatus\b|\bcomo (esta|ta|anda|vai) (a |o )?(tarefa|trabalho|experimento)\b|\bhow is\b.{0,40}\b(task|going)\b|\bprogress\b|\bandamento\b/;
const STOP_SPEAKING = /^(para|pare|parar) de falar\b|^(stop|quit) talking\b|^silencio\b|^(shut up|be quiet|quiet)\b|^chega\b/;
const CANCEL = /\b(cancela|cancele|cancelar|interrompe|interrompa|para|pare|parar|mata)\b.{0,40}\b(tarefa|task|agentes?|tudo)\b|\b(cancel|stop|kill|abort)\b.{0,40}\b(task|agents?|everything|job)\b/;
const APPROVE = /^(eu )?(aprovo|aprova|aprovar|aprovado|pode (fazer o )?merge|approve|approved)\b/;
const REJECT = /^(eu )?(rejeito|rejeita|rejeitar|descarta|descarte|descartar|reject|discard)\b/;
const CODE_VERB = /\b(implementa|implemente|implementar|cria|crie|criar|escreve|escreva|escrever|corrige|corrija|corrigir|refatora|refatore|conserta|conserte|adiciona|adicione|build|implement|write|fix|refactor|create|add)\b/;
const CODE_NOUN = /\b(codigo|code|feature|funcao|function|parser|bug|testes?|tests?|branch|modulo|module|api|endpoint|script|classe|class|componente|component|docker|deploy|migracao|migration)\b/;
const DELEGATE = /\b(pede|peca|pedir|manda|mande|fala|diz)\b.{0,6}\b(pro|para o|ao|o)\b.{0,3}\b(claude|codex)\b|\b(ask|tell|have|use|let)\b.{0,6}\b(claude|codex)\b|\b(use|usa|usar|com o)\b.{0,3}\b(claude|codex)\b/;
const COMMANDISH = /\b(ideias?|ideas?|tarefas?|tasks?|projetos?|projects?|claude|codex|branch|merge|status)\b/;

/** Tira o "salva essa ideia para o Abstrike:" do começo e devolve só a ideia (pode ficar vazio). */
export function ideaBody(original: string, projectName: string | null): string {
  let body = original.replace(
    /^.*?\b(ideias?|ideas?)\b\s*/i,
    '',
  );
  if (projectName) {
    body = body.replace(new RegExp(`^(\\s*(para|pro|pra|no|do|da|de|ao|em|for|to|on|about|in)\\s+)?(o\\s+|a\\s+|the\\s+)?(projeto\\s+|project\\s+)?${escapeRe(projectName)}\\b`, 'i'), '');
  }
  return body.replace(/^[\s,:;.\-–—]+/, '').replace(/^(que|that|é|e)\s+/i, '').trim();
}

/** Só as regras, sem modelo. null = nenhuma regra reconheceu. */
export function ruleIntent(text: string, projectNames: string[]): Intent | null {
  const n = normalize(text);
  if (!n) return null;
  const project = projectIn(n, projectNames);

  if (STOP_SPEAKING.test(n)) return { kind: 'stop-speaking' };
  if (APPROVE.test(n)) return { kind: 'approval', decision: 'approve', taskHint: project };
  if (REJECT.test(n)) return { kind: 'approval', decision: 'reject', taskHint: project };
  if (CANCEL.test(n) && !SAVE_IDEA.test(n)) return { kind: 'cancel', taskHint: project ?? (/\b(tudo|todos|all|everything)\b/.test(n) ? 'all' : null) };
  if (SAVE_IDEA.test(n)) return { kind: 'save-idea', projectHint: project, text: ideaBody(text, project) };
  if (FIND_IDEAS.test(n)) return { kind: 'find-ideas', projectHint: project, query: '' };
  if (STATUS.test(n)) return { kind: 'status', taskHint: project };
  if (DELEGATE.test(n) || (CODE_VERB.test(n) && CODE_NOUN.test(n))) {
    return { kind: 'coding-task', projectHint: project, objective: text.trim(), agent: agentIn(n) };
  }
  return null;
}

const CLASSIFY_PROMPT = `Classifique o pedido do usuário. Responda SÓ com JSON:
{"intent": "chat" | "save-idea" | "find-ideas" | "status" | "coding-task", "text": "<a ideia ou o objetivo, se houver>"}
- save-idea: quer guardar uma ideia.
- find-ideas: quer ver ideias guardadas.
- status: pergunta sobre tarefas em andamento.
- coding-task: quer que um agente escreva ou mude código.
- chat: qualquer outra coisa (pergunta, conversa, explicação).`;

const LLM_INTENTS = new Set(['chat', 'save-idea', 'find-ideas', 'status', 'coding-task']);

export class NightRouter implements ModelRouter {
  constructor(
    private readonly llm: LocalLlm,
    private readonly projectNames: () => Promise<string[]>,
  ) {}

  async route(text: string, _language: Language): Promise<RouteDecision> {
    const names = await this.projectNames();
    const byRule = ruleIntent(text, names);
    if (byRule) return { intent: byRule, model: 'rules', reason: 'regra fixa', usedPremiumQuota: false };

    const n = normalize(text);
    if (COMMANDISH.test(n) || projectIn(n, names)) {
      const intent = await this.classify(text, n, names);
      if (intent) return { intent, model: this.llm.model, reason: 'classificado pelo modelo local', usedPremiumQuota: false };
    }
    return { intent: { kind: 'chat' }, model: this.llm.model, reason: 'conversa', usedPremiumQuota: false };
  }

  /** Pede ao Qwen um JSON e valida. Qualquer coisa fora do esperado = null (vira conversa). */
  private async classify(text: string, n: string, names: string[]): Promise<Intent | null> {
    let raw: string;
    try {
      raw = await this.llm.chat([{ role: 'system', content: CLASSIFY_PROMPT }, { role: 'user', content: text }], { json: true });
    } catch {
      return null;
    }
    let parsed: { intent?: unknown; text?: unknown };
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    if (typeof parsed.intent !== 'string' || !LLM_INTENTS.has(parsed.intent)) return null;
    // Com think:false o Ollama põe "/no_think" na mensagem, e o Qwen às vezes devolve isso no texto.
    const body = typeof parsed.text === 'string' ? parsed.text.replace(/\s*\/(no_)?think(?![a-z])/gi, '').trim() : '';
    const project = projectIn(n, names);
    switch (parsed.intent) {
      case 'save-idea': return { kind: 'save-idea', projectHint: project, text: body || ideaBody(text, project) };
      case 'find-ideas': return { kind: 'find-ideas', projectHint: project, query: '' };
      case 'status': return { kind: 'status', taskHint: project };
      case 'coding-task': return { kind: 'coding-task', projectHint: project, objective: text.trim(), agent: agentIn(n) };
      default: return { kind: 'chat' };
    }
  }
}
