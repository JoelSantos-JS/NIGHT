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

const PT_HINTS = /\b(que|nao|voce|essa|esse|isso|para|pra|minha|meu|ta|esta|como|qual|quais|uma|um|tarefa|ideia|salva|obrigado|oi|ola|projeto|faz|tem|de|do|da|no|na|com|eu|hoje|agora|muito|estou|sou|vou|me|mim|bom|dia)\b/g;
// "to" fica de fora: sem acento, "tô" vira "to" e o português passava por inglês.
const EN_HINTS = /\b(the|is|what|you|this|that|my|and|for|how|which|task|idea|save|thanks|hi|hello|project|are|please|can|i|im|it|of|in|do)\b/g;

/** Palpite de idioma pelo texto. Empate fica em português, que é o padrão do dono. */
export function detectLanguage(text: string): Language {
  const raw = text.toLowerCase();
  const n = normalize(text);
  const pt = (n.match(PT_HINTS)?.length ?? 0) + (/[ãõçáàâéêíóôú]/.test(raw) ? 2 : 0);
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

const SAVE_IDEA = /\b(salva|salve|salvar|guarda|guarde|anota|anote|registra|registre)\b.{0,20}\bideia\b|\b(save|note|record|jot down)\b.{0,15}\bidea\b|\bnova ideia\b|\bideia nova\b|\bnew idea\b/;
const FIND_IDEAS = /\b(quais|mostra|mostre|lista|liste|lembra|busca|procura)\b.{0,25}\bideias?\b|\b(list|show|find|what|which|recall)\b.{0,20}\bideas\b|\bminhas ideias\b|\bmy ideas\b/;
const STATUS = /\b(ta|esta|ainda|ja) (pesquisando|precisando)\b|\b(ja )?(achou|terminou a pesquisa)\b|\bstill (searching|looking)\b|\bo que (voce )?(esta|ta) (fazendo|rodando)\b|\b(o que|que) (esta|ta) rodando\b|\bwhat('?s| is| are)( you)? (running|doing|working on)\b|\bstatus\b|\bcomo (esta|ta|anda|vai) (a |o )?(tarefa|trabalho|experimento)\b|\bhow is\b.{0,40}\b(task|going)\b|\bprogress\b|\bandamento\b/;
const STOP_SPEAKING = /^(para|pare|parar) de falar\b|^(stop|quit) talking\b|^silencio\b|^(shut up|be quiet|quiet)\b|^chega\b/;
// Cancelar só como ORDEM, no começo da frase: "cancela a tarefa", "para todos os agentes", "stop the task".
// "Como cancelar a tarefa?" é pergunta e não pode matar nada (2ª revisão do Codex, 04/11).
const CANCEL = /^(por favor |pode |agora |ok |entao )?(cancela|cancele|cancelar|interrompe|interrompa|interromper|para|pare|parar|mata)\b.{0,40}\b(tarefa|task|agentes?|tudo)\b|^(please |now |ok )?(cancel|stop|kill|abort)\b.{0,40}\b(task|agents?|everything|job)\b/;
// Pergunta não é comando de controle.
const QUESTION = /\?\s*$|^(como|por que|porque|pra que|quando|onde|da pra|e se|sera que|how|why|when|where|what if|can i|could i|should i)\b/;
// Aprovar/rejeitar só com a frase INTEIRA no formato esperado: "aprovo", "aprovo o merge", "aprovo a do Night",
// "approve it". "Aprovo a ideia" ou "aprova esse texto" não podem virar merge (revisão do Codex, 04/11).
const DECISION_TAIL = /( (o |a |as |os |the )?(merge|tarefa|task|mudancas?|alteracoes|changes?|isso|it|tudo|everything))?( ((a|o) )?(do|da|no|na|de|for|in|on) (projeto |project )?[\w-]+)?[.!]?$/.source;
const APPROVE = new RegExp(`^(eu )?(aprovo|aprova|aprovar|aprovado|pode fazer o merge|pode juntar|approve|approved)${DECISION_TAIL}`);
const REJECT = new RegExp(`^(eu )?(rejeito|rejeita|rejeitar|descarta|descarte|descartar|reject|discard)${DECISION_TAIL}`);
// "Não cancela", "não aprova", "don't cancel": negação nunca vira comando de controle.
const NEGATED = /\b(nao|nunca|nem|jamais|do not|never|dont|don['’ ]?t)\b/;
const CODE_VERB = /\b(implementa|implemente|implementar|cria|crie|criar|escreve|escreva|escrever|corrige|corrija|corrigir|refatora|refatore|conserta|conserte|adiciona|adicione|build|implement|write|fix|refactor|create|add)\b/;
const CODE_NOUN = /\b(codigo|code|feature|funcao|function|parser|bug|testes?|tests?|branch|modulo|module|api|endpoint|script|classe|class|componente|component|docker|deploy|migracao|migration)\b/;
const DELEGATE = /\b(pede|peca|pedir|manda|mande|fala|diz)\b.{0,6}\b(pro|para o|ao|o)\b.{0,3}\b(claude|codex)\b|\b(ask|tell|have|use|let)\b.{0,6}\b(claude|codex)\b|\b(use|usa|usar|com o)\b.{0,3}\b(claude|codex)\b/;
// Pedido explícito de pesquisa, ou pergunta sobre algo que muda (preço, notícia, resultado...).
// "hoje"/"agora" sozinhos não contam: "tô cansado hoje" não é pesquisa.
const RESEARCH = new RegExp([
  /\b(pesquisa|pesquise|pesquisar|procura|procure|busca|busque|googla|googlar)\b.{0,30}\b(internet|web|google|sobre|pra mim|para mim)\b/.source,
  // "pesquisa" em qualquer lugar, com algo depois ("você consegue pesquisar o preço…", "faz uma pesquisa sobre…")
  /\b(pesquisa|pesquise|pesquisar|faz uma pesquisa|fazer uma pesquisa)\b\s+\S+/.source,
  // O Whisper troca "pesquisar" por "precisar": "você consegue precisar pra mim?" não existe em português.
  /\b(consegue|pode|poderia|da pra) (precisar|pesquisar|procurar)\b|\bprecis(ar|a) (isso )?(pra|para) mim\b/.source,
  /^(pesquisa|pesquise|search|look up|research|google)\b/.source,
  /\b(search|look up|research|google)\b.{0,20}\b(for|about|the|on)\b/.source,
  /\b(qual|quais|quanto|quanta|quem|quando|como (esta|ta)|o que)\b.{0,40}\b(cotacao|preco|noticias?|ultim[ao]s?|recentes?|atual|atualmente|lancamento|lancou|resultado|placar|previsao do tempo|dolar|bitcoin)\b/.source,
  /\b(what|who|when|how much|how is)\b.{0,40}\b(price|news|latest|recent|current|currently|released|score|weather|forecast)\b/.source,
].join('|'));

// Pergunta sobre FATO vai para o Codex/Claude, não para o Qwen 1.7B: medido em 04/11, ele inventa mesmo instruído
// a não inventar ("o CEO da Nvidia é Jensen Nuhra", "a reunião do GoPom vai discutir o código").
// Conceito e explicação ("o que é uma API", "me explica", "diferença entre") continuam locais (blueprint §5).
const FACT_QUESTION = /^(quem|quando|onde|quanto|quantos|quantas|who|when|where|how much|how many)\b|\b(o que|como) (voce acha que )?(vai|iria|deve) (acontecer|ser|rolar)\b|\bwhat (will|is going to) happen\b/;
const CONCEPT = /\b(o que e|o que sao|o que significa|me explica|explica|como funciona|diferenca entre|para que serve|pra que serve|what is|what are|explain|how does|difference between)\b/;
const ADDRESS_WORDS = new Set(['night', 'claude', 'codex', 'joel', 'eu', 'i', 'ok', 'oi', 'hey']);
/** Nome próprio no meio da frase ("reunião do GoPom", "CEO da Nvidia"), sem contar o Night e os agentes. */
function hasProperNoun(original: string, projectNames: string[]): boolean {
  const own = new Set(projectNames.map(normalize)); // falar do próprio projeto não é pesquisa na internet
  const tokens = original.split(/\s+/);
  return tokens.some((raw, i) => {
    if (i === 0 || /[.?!:]$/.test(tokens[i - 1]!)) return false; // começo de frase tem maiúscula por regra
    const w = raw.replace(/[^\p{L}\p{N}-]/gu, '');
    return /^\p{Lu}[\p{L}\p{N}-]+/u.test(w) && !ADDRESS_WORDS.has(normalize(w)) && !own.has(normalize(w));
  });
}

// "branch", "merge" e "status" ficam de fora: aparecem demais em pergunta comum ("o que é uma branch?").
const COMMANDISH = /\b(ideias?|ideas?|tarefas?|tasks?|projetos?|projects?|claude|codex)\b/;
const SHOW_DIFF = /\b(mostra|mostre|me mostra|quais (sao )?as|ver|veja)\b.{0,15}\b(mudancas|alteracoes|diff)\b|\bo que (o \w+ )?mudou\b|\bshow (me )?(the )?(changes|diff)\b|\bwhat changed\b/;
// Caminho do Windows no texto: "a pasta do Soaken é C:\Users\Joel\Desktop\PROFESSOR\tutor-pc"
const WIN_PATH = /([a-z]:[\\/][^\s"'<>|?*]+)/i;
const SET_PATH = /\b(pasta|repo|repositorio|caminho|folder|path)\b/;

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

/** "Night, salva..." / "Hey Night, ..." → "salva...". Chamar o Night pelo nome não é falar do projeto Night. */
export function stripWakeWord(text: string): string {
  return text.replace(/^\s*((hey|hi|oi|ola|olá|ok|e a[ií])[\s,]+)?night\b[\s,.!:;-]*/i, '').trim() || text.trim();
}

// Rodar/abrir um projeto ou achar uma pasta no PC (uso real 04/11: "roda o AWS Prepping pra mim").
const RUN = /\b(roda|rode|rodar|executa|execute|executar|inicia|inicie|iniciar|abre|abra|abrir|liga|ligue|sobe|suba|run|start|launch|open)\b/;
const FIND = /\b(procura|procure|procurar|acha|ache|achar|encontra|encontre|encontrar|localiza|localize|busca|busque|find|locate|look for)\b/;
const FOLDERISH = /\b(pasta|pastas|projeto|projetos|arquivo|arquivos|app|aplicativo|site|desktop|area de trabalho|meu pc|computador|folder|project|file)\b/;
const FILLER = /^(o|a|os|as|do|da|de|no|na|meu|minha|pra mim|para mim|projeto|pasta|parte|app|aplicativo|site|chamad[oa]|the|my|project|folder|app|called|named)\s+/i;

/** Tira o nome do alvo: "procure uma parte chamada AWS Prepping" / "roda o AWS Prepping pra mim" → "AWS Prepping". */
export function targetName(text: string, verbRe: RegExp): string {
  const called = text.match(/\b(chamad[oa]|called|named)\s+([^,.;!?]+)/i)?.[2];
  let t = called ?? '';
  if (!t) {
    const words = text.split(/\s+/);
    // depois do ÚLTIMO verbo de ação ("...eu quero que você roda o AWS Prepping pra mim")
    let idx = -1;
    words.forEach((w, i) => { if (verbRe.test(normalize(w))) idx = i; });
    t = idx >= 0 ? words.slice(idx + 1).join(' ') : '';
  }
  t = t.replace(/[,.;!?]+.*$/, '');
  t = t.replace(/\s+(pra mim|para mim|for me|no (meu )?(pc|computador|desktop)|na area de trabalho|no desktop|aqui|agora|please|por favor)\b.*$/i, '');
  for (let i = 0; i < 4; i++) t = t.replace(FILLER, '');
  t = t.replace(/\s+(projeto|project|folder|pasta|app)$/i, '').trim();
  // Sem nome de verdade ("procura aqui as pastas"): fica vazio e o Night pergunta qual.
  return /^(aqui|ali|isso|isto|as pastas|os arquivos|os projetos|tudo|it|this|that|here)?$/i.test(normalize(t)) ? '' : t;
}

/** Só as regras, sem modelo. null = nenhuma regra reconheceu. */
export function ruleIntent(rawText: string, projectNames: string[]): Intent | null {
  const text = stripWakeWord(rawText);
  const n = normalize(text);
  if (!n) return null;
  const project = projectIn(n, projectNames);

  if (STOP_SPEAKING.test(n)) return { kind: 'stop-speaking' };
  const negated = NEGATED.test(n) || QUESTION.test(n);
  if (!negated && APPROVE.test(n)) return { kind: 'approval', decision: 'approve', taskHint: project };
  if (!negated && REJECT.test(n)) return { kind: 'approval', decision: 'reject', taskHint: project };
  if (!negated && CANCEL.test(n) && !SAVE_IDEA.test(n)) return { kind: 'cancel', taskHint: project ?? (/\b(tudo|todos|all|everything)\b/.test(n) ? 'all' : null) };
  if (SAVE_IDEA.test(n)) return { kind: 'save-idea', projectHint: project, text: ideaBody(text, project) };
  if (FIND_IDEAS.test(n)) return { kind: 'find-ideas', projectHint: project, query: '' };
  // Rodar/achar pasta vem antes da pesquisa: "procura a pasta X" não é pesquisa na internet.
  // "O Ollama roda no Windows?" é pergunta; "você pode rodar o X?" e "roda o X pra mim?" são pedido.
  const askingToDo = !/\?\s*$/.test(text) || /\b(voce|pode|poderia|consegue|pra mim|para mim|can you|could you|for me|please)\b/.test(n);
  if (askingToDo && RUN.test(n) && !SAVE_IDEA.test(n) && !/\b(ideia|idea)\b/.test(n)) {
    const target = targetName(text, RUN);
    if (target && !/\b(teste|testes|test|tests)\b/i.test(target)) return { kind: 'run-project', target };
  }
  if (FIND.test(n) && FOLDERISH.test(n)) return { kind: 'find-folder', target: targetName(text, FIND) };
  const winPath = text.match(WIN_PATH)?.[1];
  if (winPath && SET_PATH.test(n)) return { kind: 'set-project-path', projectHint: project, path: winPath.replace(/[.,;]+$/, '') };
  // Pesquisa explícita antes de "o que mudou": "pesquisa o que mudou na versão X" é pesquisa.
  if (RESEARCH.test(n)) return { kind: 'research', query: text.trim() };
  const isQuestion = /\?\s*$/.test(text) || FACT_QUESTION.test(n);
  if (isQuestion && !CONCEPT.test(n) && (FACT_QUESTION.test(n) || hasProperNoun(text, projectNames))) {
    return { kind: 'research', query: text.trim() };
  }
  if (SHOW_DIFF.test(n)) return { kind: 'show-diff', taskHint: project };
  if (STATUS.test(n)) return { kind: 'status', taskHint: project };
  if (DELEGATE.test(n) || (CODE_VERB.test(n) && CODE_NOUN.test(n))) {
    return { kind: 'coding-task', projectHint: project, objective: text.trim(), agent: agentIn(n) };
  }
  return null;
}

const CLASSIFY_PROMPT = `Classifique o pedido do usuário. Responda SÓ com JSON:
{"intent": "chat" | "save-idea" | "find-ideas" | "status" | "coding-task" | "research", "text": "<a ideia ou o objetivo, se houver>"}
- save-idea: quer guardar uma ideia.
- find-ideas: quer ver ideias guardadas.
- status: pergunta sobre tarefas em andamento.
- coding-task: quer que um agente escreva ou mude código.
- research: precisa de fato atual ou de pesquisa na internet (preço, notícia, versão, evento recente).
- chat: qualquer outra coisa (pergunta, conversa, explicação).`;

const LLM_INTENTS = new Set(['chat', 'save-idea', 'find-ideas', 'status', 'coding-task', 'research']);

export class NightRouter implements ModelRouter {
  constructor(
    private readonly llm: LocalLlm,
    private readonly projectNames: () => Promise<string[]>,
  ) {}

  async route(rawText: string, _language: Language): Promise<RouteDecision> {
    const text = stripWakeWord(rawText);
    const names = await this.projectNames();
    const byRule = ruleIntent(text, names);
    // Pesquisa: a regra só reconhece; quem gasta cota e grava o modelo de verdade é o coordenador.
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
      case 'research': return { kind: 'research', query: text.trim() };
      default: return { kind: 'chat' };
    }
  }
}
