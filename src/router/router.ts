// Roteador do Night (blueprint §5, "spend premium capacity only when useful").
//
// 1. Regras fixas primeiro: comandos conhecidos em PT/EN são reconhecidos sem modelo nenhum.
// 2. Aprovar, rejeitar, cancelar e "parar de falar" SÓ saem das regras. O modelo local nunca
//    produz esses intents: um erro de classificação não pode virar merge ou cancelamento.
// 3. Sem regra, mas com cara de comando (fala de ideia, tarefa, projeto, Claude/Codex): o Qwen
//    classifica em JSON, e a saída é validada. Inválida = conversa.
// 4. O resto é conversa com o Qwen local. Nada aqui usa cota premium.

import type { Intent, LocalLlm, ModelRouter, OfferEditField, RouteDecision } from '../core/interfaces.ts';
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
  // "pede pro DeepSeek mudar X no projeto Y" (D12/H01): mesma regra dos outros, só o nome muda.
  if (/\bdeepseek\b/.test(n)) return 'deepseek';
  return null;
}

/** Acha o nome de um projeto cadastrado dentro da frase. O mais longo ganha ("Abstrike Pro" > "Abstrike"). */
export function projectIn(n: string, projectNames: string[]): string | null {
  const hits = projectNames.filter((p) => new RegExp(`\\b${escapeRe(normalize(p))}\\b`).test(n));
  if (hits.length) return hits.sort((a, b) => b.length - a.length)[0]!;
  // Nome que o Whisper escreveu quase certo ("Souk"/"Soaken", "Copon"/"Copom", calibragem do Joel 04/11):
  // palavra parecida com um nome de projeto de 5+ letras, com no máximo 1 letra diferente a cada 4.
  const words = n.split(/[^a-z0-9]+/).filter((w) => w.length >= 4);
  let best: { name: string; dist: number } | null = null;
  for (const p of projectNames) {
    const target = normalize(p).replace(/[^a-z0-9]/g, '');
    if (target.length < 5) continue;
    for (const w of words) {
      const d = editDistance(w, target);
      if (d > 0 && d <= Math.floor(target.length / 4) && (!best || d < best.dist)) best = { name: p, dist: d };
    }
  }
  return best?.name ?? null;
}

/** Distância de edição (Levenshtein) entre duas palavras curtas. */
export function editDistance(a: string, b: string): number {
  const d = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0]!;
    d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = d[j]!;
      d[j] = Math.min(d[j]! + 1, d[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return d[b.length]!;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const SAVE_IDEA = /\b(salva|salve|salvar|guarda|guarde|anota|anote|registra|registre)\b.{0,20}\bideia\b|\b(save|note|record|jot down)\b.{0,15}\bidea\b|\bnova ideia\b|\bideia nova\b|\bnew idea\b/;
const FIND_IDEAS = /\b(quais|mostra|mostre|lista|liste|lembra|busca|procura)\b.{0,25}\bideias?\b|\b(list|show|find|what|which|recall)\b.{0,20}\bideas\b|\bminhas ideias\b|\bmy ideas\b/;
// "Achou" sozinho não: "o que o pessoal achou" virava status (uso real 04/11). Só "já achou?" / "achou?" curto.
const STATUS = /\b(ta|esta|ainda|ja) (pesquisando|precisando)\b|\bja (achou|terminou)\b|^achou\b|\bterminou a pesquisa\b|\bstill (searching|looking)\b|\bo que (voce )?(esta|ta) (fazendo|rodando)\b|\b(o que|que) (esta|ta) rodando\b|\bwhat('?s| is| are)( you)? (running|doing|working on)\b|\bstatus\b|\bcomo (esta|ta|anda|vai) (a |o )?(tarefa|trabalho|experimento)\b|\bhow is\b.{0,40}\b(task|going)\b|\bprogress\b|\bandamento\b/;
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
const AGENT_NAMES = 'claude|codex|deepseek';
const DELEGATE = new RegExp(`\\b(pede|peca|pedir|manda|mande|fala|diz)\\b.{0,6}\\b(pro|para o|ao|o)\\b.{0,3}\\b(${AGENT_NAMES})\\b|\\b(ask|tell|have|use|let)\\b.{0,6}\\b(${AGENT_NAMES})\\b|\\b(use|usa|usar|com o)\\b.{0,3}\\b(${AGENT_NAMES})\\b`);
// Pedido explícito de pesquisa, ou pergunta sobre algo que muda (preço, notícia, resultado...).
// "hoje"/"agora" sozinhos não contam: "tô cansado hoje" não é pesquisa.
const RESEARCH = new RegExp([
  /\b(pesquisa|pesquise|pesquisar|procura|procure|busca|busque|googla|googlar)\b.{0,30}\b(internet|web|google|sobre|pra mim|para mim)\b/.source,
  // "pesquisa" em qualquer lugar, com algo depois ("você consegue pesquisar o preço…", "faz uma pesquisa sobre…")
  // Pontuação no meio vale: "eu quero que você pesquise, não pesquise, traz os comentários" (uso real 04/11).
  /\b(pesquisa|pesquise|pesquisar|faz uma pesquisa|fazer uma pesquisa)\b[,.;:]?\s+\S+/.source,
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
const ADDRESS_WORDS = new Set(['night', 'claude', 'codex', 'deepseek', 'joel', 'eu', 'i', 'ok', 'oi', 'hey']);
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
const COMMANDISH = /\b(ideias?|ideas?|tarefas?|tasks?|projetos?|projects?|claude|codex|deepseek)\b/;
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

// ---------- Trabalhos (F06/F07): oferta, vídeo e Radar ----------

// Números falados por extenso de um a dez também valem ("vídeo três" = "vídeo 3").
const NUM_WORDS: Readonly<Record<string, number>> = {
  um: 1, dois: 2, tres: 3, quatro: 4, cinco: 5, seis: 6, sete: 7, oito: 8, nove: 9, dez: 10,
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};
const NUM_SRC = String.raw`\d{1,3}|um|dois|tres|quatro|cinco|seis|sete|oito|nove|dez|one|two|three|four|five|six|seven|eight|nine|ten`;
const NUM_PREFIX = String.raw`(?:numero\s+|number\s+|n[.º°]?\s*)?`;
const OFFER_SRC = String.raw`ofertas?|offers?`;
const VIDEO_SRC = String.raw`videos?`;
const RADAR_SRC = String.raw`radar`;

/** Número falado ("3", "três", "three"). null = sem número (ou zero, que não é número de trabalho). */
export function spokenNumber(raw: string | null | undefined): number | null {
  if (!raw) return null;
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    return n > 0 ? n : null;
  }
  return NUM_WORDS[raw] ?? null;
}

/** O número logo depois do substantivo: "vídeo 3", "oferta número dois". */
function numberAfter(n: string, noun: string): number | null {
  const m = n.match(new RegExp(`\\b(?:${noun})\\s*${NUM_PREFIX}(${NUM_SRC})\\b`));
  return spokenNumber(m?.[1]);
}

// Aprovar/rejeitar OFERTA e VÍDEO é decisão de conteúdo, não de merge: só por regra, com substantivo junto.
// "aprovo" e "aprovo o merge" continuam sendo a aprovação de merge de sempre.
const DECISION_APPROVE = /\b(aprova|aprovo|aprovar|aprovado|approve|approved)\b/;
const DECISION_REJECT = /\b(rejeita|rejeito|rejeitar|descarta|descarte|descartar|reject|discard)\b/;
// "aprovo o merge do vídeo 2" mistura decisões: a regra não pode escolher uma das duas sozinha.
const MERGE_WORD = /\b(merge|merges|mergear|juntar|junta|junte|pull requests?|pr)\b/;

/** O verbo de decisão tem que ABRIR a frase; "aprovo a ideia da oferta" não pode virar decisão da oferta. */
function decisionVerb(n: string): 'approve' | 'reject' | null {
  const start = n.replace(/^(?:por favor|pode|agora|ok|entao|please|now)[,\s]+/, '').replace(/^eu\s+/, '');
  const first = start.match(/^[\p{L}]+/u)?.[0] ?? '';
  if (DECISION_APPROVE.test(first)) return 'approve';
  if (DECISION_REJECT.test(first)) return 'reject';
  return null;
}

/** "aprova a oferta 2" / "approve offer 2". Sem número devolve number null: o coordenador pede. */
function offerDecisionIntent(n: string, negated: boolean): Intent | null {
  if (negated || !new RegExp(`\\b(?:${OFFER_SRC})\\b`).test(n)) return null;
  const decision = decisionVerb(n);
  if (!decision) return null;
  // Falou de merge junto: não dá para saber se é a oferta ou o código; o coordenador pergunta.
  if (MERGE_WORD.test(n)) return { kind: 'offer-decision', number: null, decision, ambiguous: true };
  return { kind: 'offer-decision', number: numberAfter(n, OFFER_SRC), decision };
}

// R06: conversa sobre a oferta (mostrar, perguntar, ajustar) não é decisão de merge nem decisão da oferta.
const OFFER_NOUN_RE = new RegExp(`\\b(?:${OFFER_SRC})\\b`);
const OFFER_SHOW_VERB = /\b(mostra|mostre|mostrar|abre|abra|abrir|exibe|exibir|show|open|display|view|see)\b/;
const OFFER_EDIT_VERB = /\b(ajusta|ajuste|ajustar|muda|mude|mudar|altera|altere|alterar|troca|troque|trocar|corrige|corrija|corrigir|atualiza|atualize|atualizar|edit|change|update|adjust|set)\b/;
// "por que a oferta 3 é boa?", "quais as fontes da oferta 2?", "what are the risks of offer 2?".
const OFFER_ASK_CUE = new RegExp([
  String.raw`\bpor que\b|\bporque\b`,
  String.raw`\b(quais?|qual)\b.{0,30}\b(fontes?|riscos?|duvidas?|problemas?|incertezas?)\b`,
  String.raw`\b(fontes?|riscos?|duvidas?|incertezas?)\b`,
  String.raw`\bwhy\b`,
  String.raw`\b(what|which)\b.{0,40}\b(sources?|risks?|doubts?|uncertaint\w*|problems?)\b`,
  String.raw`\b(sources?|risks?)\b`,
  String.raw`\b(e boa|e bom|vale a pena|is (it|this) good|worth it)\b`,
].join('|'));

/** "por que ela é boa?" só conta como oferta quando abre assim: pronome solto demais seria conversa. */
const OFFER_PRONOUN_ASK = /^(por que|porque)\s+ela\b/;

/** "mostra a oferta 3", "abre a oferta 3", "show offer 3". Exige número: é a oferta que o Joel vê. */
function offerShowIntent(n: string): Intent | null {
  if (!OFFER_SHOW_VERB.test(n) || !OFFER_NOUN_RE.test(n)) return null;
  const number = numberAfter(n, OFFER_SRC);
  return number === null ? null : { kind: 'offer-show', number };
}

/** "por que a oferta 3 é boa?", "quais as fontes da oferta 2?". Sem número, o coordenador usa a última mostrada. */
function offerAskIntent(text: string, n: string): Intent | null {
  if (!OFFER_ASK_CUE.test(n)) return null;
  if (!OFFER_NOUN_RE.test(n) && !OFFER_PRONOUN_ASK.test(n)) return null;
  return { kind: 'offer-ask', number: numberAfter(n, OFFER_SRC), question: text.trim() };
}

/** Campo citado na correção; null quando a frase não diz qual campo mudar. */
function offerEditField(n: string): OfferEditField | null {
  if (/\b(publico|audience|target)\b/.test(n)) return 'publico';
  if (/\b(preco|price)\b/.test(n)) return 'precoHipotese';
  if (/\b(promessa|promise)\b/.test(n)) return 'promessa';
  if (/\b(nome|titulo|name|title)\b/.test(n)) return 'nome';
  if (/\b(diferencial|differential|difference)\b/.test(n)) return 'diferencial';
  return null;
}

/**
 * "ajusta o público da oferta 3 para mães de primeira viagem", "muda o preço da oferta 2 para 47".
 * O valor é o que vem depois de "para"/"to"; sem ele, a regra não entende e devolve null.
 */
function offerEditIntent(text: string, n: string): Intent | null {
  if (!OFFER_EDIT_VERB.test(n) || !OFFER_NOUN_RE.test(n)) return null;
  const campo = offerEditField(n);
  if (!campo) return null;
  const valor = text.match(/\b(?:para|pra|to|como)\s+(.+)$/i)?.[1]?.trim().replace(/[.!?]+$/, '') ?? '';
  if (!valor) return null;
  return { kind: 'offer-edit', number: numberAfter(n, OFFER_SRC), campo, valor };
}

/** "aprova o vídeo 3" / "approve video 3". Sem número devolve number null: o coordenador pede. */
function videoDecisionIntent(n: string, negated: boolean): Intent | null {
  if (negated || !new RegExp(`\\b${VIDEO_SRC}\\b`).test(n)) return null;
  const decision = decisionVerb(n);
  if (!decision) return null;
  if (MERGE_WORD.test(n)) return { kind: 'video-decision', number: null, decision, ambiguous: true };
  return { kind: 'video-decision', number: numberAfter(n, VIDEO_SRC), decision };
}

const CANCEL_VERB = /^(?:por favor\s+|pode\s+|agora\s+|ok\s+|entao\s+|please\s+|now\s+)?(cancela|cancele|cancelar|interrompe|interrompa|interromper|para|pare|parar|mata|cancel|stop|kill|abort)\b/;

/** Cancelar TRABALHO exige o número: "cancela o vídeo 3". Sem número cai no cancel de tarefas de código. */
function jobCancelIntent(n: string, negated: boolean): Intent | null {
  if (negated || !CANCEL_VERB.test(n)) return null;
  const video = numberAfter(n, VIDEO_SRC);
  if (video !== null) return { kind: 'job-cancel', jobKind: 'video', number: video };
  const radar = numberAfter(n, RADAR_SRC);
  if (radar !== null) return { kind: 'job-cancel', jobKind: 'radar', number: radar };
  return null;
}

// Retomar trabalho também exige o número: "continua o vídeo 3", "resume video 3".
// Sem número não há como saber qual trabalho, então a regra deixa a fala seguir o fluxo normal.
const RESUME_VERB = /^(?:por favor\s+|pode\s+|agora\s+|ok\s+|entao\s+|please\s+|now\s+)?(continua|continue|continuar|retoma|retome|retomar|resume|resumir|prossegue|prosseguir)\b/;

function jobResumeIntent(n: string, negated: boolean): Intent | null {
  if (negated || !RESUME_VERB.test(n)) return null;
  const video = numberAfter(n, VIDEO_SRC);
  if (video !== null) return { kind: 'job-resume', jobKind: 'video', number: video };
  const radar = numberAfter(n, RADAR_SRC);
  if (radar !== null) return { kind: 'job-resume', jobKind: 'radar', number: radar };
  return null;
}

// ---------- Low-ticket e campanha (seções L e M) ----------
// Vêm ANTES de "aprova a oferta N": "aprovo montar a campanha da oferta 2" não é aprovar a oferta,
// e "aprovo" sozinho continua sendo o merge. URLs saem do texto original (o normalizado perde maiúsculas).

const HTTPS_URL = /https:\/\/[^\s,;"'<>]+/gi;

/** "a página da oferta 2 é https://…", "o checkout da oferta 2 é …", "as imagens da oferta 2 são …". */
function offerLinkIntent(text: string, n: string): Intent | null {
  const urls = (text.match(HTTPS_URL) ?? []).map((u) => u.replace(/[.)\]]+$/, ''));
  if (!urls.length || !new RegExp(`\\b(?:${OFFER_SRC})\\b`).test(n)) return null;
  const field = /\b(checkout|pagamento|payment)\b/.test(n) ? 'checkout'
    : /\b(imagens?|images?|fotos?|criativos?)\b/.test(n) ? 'imagens'
      : /\b(pagina|page|site|landing)\b/.test(n) ? 'pagina' : null;
  if (!field) return null;
  return { kind: 'offer-link', number: numberAfter(n, OFFER_SRC), field, urls: field === 'imagens' ? urls : urls.slice(0, 1) };
}

const CAMPAIGN_BUILD = /^(?:eu\s+)?(?:aprovo|aprova|aprovar|approve)\s+(?:montar|criar|subir|build|create)\s+(?:a\s+|the\s+)?(?:campanha|campaign)\b/;
const CAMPAIGN_DRAFT = /\b(?:monta|monte|montar|prepara|prepare|preparar|rascunho|mostra|mostre|draft|prepare)\b.{0,25}\b(?:campanha|campaign)\b/;
const PRODUCT_CREATE = /\b(?:gera|gere|gerar|cria|crie|criar|faz|faca|fazer|monta|monte|montar|generate|create|build)\b.{0,25}\b(?:produto|product|pdfs?)\b/;

/** Valor por dia na frase: "com R$ 20 por dia", "com 35 reais por dia", "R$ 12,50/dia". */
function dailyBudgetIn(text: string): number | null {
  const m = /(?:r\$\s*)?(\d{1,5}(?:[.,]\d{1,2})?)\s*(?:reais)?\s*(?:por dia|\/\s*dia|ao dia|diarios?|diários?|a day|per day)/i.exec(text)
    ?? /r\$\s*(\d{1,5}(?:[.,]\d{1,2})?)/i.exec(text);
  if (!m) return null;
  const v = Number(m[1]!.replace(',', '.'));
  return Number.isFinite(v) && v > 0 ? v : null;
}

function campaignIntent(text: string, n: string): Intent | null {
  if (CAMPAIGN_BUILD.test(n)) return { kind: 'campaign-build', number: numberAfter(n, OFFER_SRC), budgetBRL: dailyBudgetIn(text) };
  if (CAMPAIGN_DRAFT.test(n) && new RegExp(`\\b(?:${OFFER_SRC})\\b`).test(n)) {
    return { kind: 'campaign-draft', number: numberAfter(n, OFFER_SRC) };
  }
  if (PRODUCT_CREATE.test(n) && new RegExp(`\\b(?:${OFFER_SRC})\\b`).test(n)) {
    return { kind: 'product-create', number: numberAfter(n, OFFER_SRC) };
  }
  return null;
}

// M07: "como está a campanha da oferta 2?", "desempenho da campanha da oferta 2", "how is the campaign for offer 2".
// É pergunta (normalmente com "?"), então a regra roda fora do bloco que exige !negated e antes do status genérico.
const CAMPAIGN_STATUS_CUE = /\b(?:como (?:esta|ta|anda|vai)|desempenho|resultado|performance|andamento|status|how is|how's|how’s|how are|performing)\b/;

function campaignStatusIntent(n: string): Intent | null {
  if (NEGATED.test(n)) return null;
  if (!/\b(?:campanha|campaign)\b/.test(n)) return null;
  if (!new RegExp(`\\b(?:${OFFER_SRC})\\b`).test(n)) return null;
  if (!CAMPAIGN_STATUS_CUE.test(n)) return null;
  return { kind: 'campaign-status', number: numberAfter(n, OFFER_SRC) };
}

// Status de trabalho só com NÚMERO ou com frase explícita de status. Pergunta comum com "vídeo"/"radar"
// ("what is a video codec?", "como está o radar meteorológico hoje?") continua indo para conversa/pesquisa.
const JOB_STATUS_SRC = new RegExp([
  // "status do radar", "status do vídeo", "andamento do vídeo", "status of radar"
  String.raw`\b(status|andamento|progresso)\s+(do|da|de|of|for)\s+(?:${RADAR_SRC}|${VIDEO_SRC})\b`,
  // "radar status", "video status", "radar progresso"
  String.raw`\b(?:${RADAR_SRC}|${VIDEO_SRC})\s+(status|progresso)\b`,
  // "o que o radar achou", "o que o vídeo achou" (o "você" no meio não conta)
  String.raw`\bo que (?:o |a )?(?:${RADAR_SRC}|${VIDEO_SRC}) achou\b`,
  // "o radar achou alguma coisa"
  String.raw`\b(?:${RADAR_SRC}|${VIDEO_SRC}) achou (alguma coisa|algo|nada)\b`,
  // "como está o (meu|último) radar/vídeo" terminando aí (complemento depois não é status)
  String.raw`\bcomo (esta|ta|anda|vai) (?:o |a )?(?:meu |minha )?(?:ultimo |ultima )?(?:${RADAR_SRC}|${VIDEO_SRC})\s*[.!?]*$`,
  // "what did the radar find"
  String.raw`\bwhat did (?:the )?(?:${RADAR_SRC}|${VIDEO_SRC}) find\b`,
].join('|'));

/** "como está o vídeo 3?", "status do radar 2", "o que o radar achou?". Sem número = resumo do tipo. */
function jobStatusIntent(n: string): Intent | null {
  let jobKind: 'radar' | 'video' | null = null;
  if (new RegExp(`\\b${RADAR_SRC}\\b`).test(n)) jobKind = 'radar';
  else if (new RegExp(`\\b${VIDEO_SRC}\\b`).test(n)) jobKind = 'video';
  if (!jobKind) return null;
  const number = numberAfter(n, jobKind === 'radar' ? RADAR_SRC : VIDEO_SRC);
  // Número identifica o trabalho; sem ele, só a frase explícita de status vale.
  if (number === null && !JOB_STATUS_SRC.test(n)) return null;
  return { kind: 'job-status', jobKind, number };
}

/** Número do trabalho citado na frase (só para repetir na pergunta de ambiguidade; a decisão fica nula). */
export function jobNumberIn(text: string, kind: 'radar' | 'video'): number | null {
  const n = normalize(text);
  return numberAfter(n, kind === 'radar' ? OFFER_SRC : VIDEO_SRC);
}

const SEARCH_VERB = /^(?:por favor\s+|pode\s+|agora\s+|ok\s+)?(vasculha|vasculhe|vasculhar|procura|procure|procurar|busca|busque|buscar|roda|rode|rodar|search|find|look for|run)\b/;
const CREATE_VERB = /^(?:por favor\s+|pode\s+|agora\s+|ok\s+)?(cria|crie|criar|faz|faca|fazer|monta|monte|montar|gera|gere|gerar|create|make|produce|generate)\b/;

/** Tira do fim do nicho o que é pedido, não tema: "emprego pra mim" → "emprego". */
function trimQueryTail(query: string): string {
  return query
    .replace(/[.!?]+$/, '')
    .replace(/(?:\s+(?:pra mim|para mim|por favor|for me|please))+$/i, '')
    .trim();
}

/** Tira o complemento de "ofertas de X" / "radar sobre X" e devolve o nicho. */
function radarQuery(text: string): string {
  // A última ocorrência: "roda o radar para pesquisar ofertas de X" → "X", não "pesquisar ofertas de X".
  const m = text.match(/^.*\b(?:ofertas?|offers?|radar)\b\s*(?:de|do|da|dos|das|para|pra|sobre|on|for|about|em|in)\s+(.+)$/i);
  if (m?.[1]) return trimQueryTail(m[1]);
  // O ÚLTIMO verbo de busca: "faça a pesquisa pra mim. Quero que use o radar para pesquisar oferta low tickets"
  // tem dois, e o nicho vem depois do segundo (uso real 20/11: o primeiro deixava a frase toda como nicho).
  return trimQueryTail(text
    .replace(/^.*\b(?:vasculha|vasculhe|vasculhar|procura|procure|procurar|busca|busque|buscar|roda|rode|rodar|pesquisa|pesquise|pesquisar|minera|minere|minerar|search|find|look for|run)\b/i, '')
    .replace(/^\s*(?:o|a|as|os|the)\s+/i, '')
    .replace(/^\s*(?:ofertas?|offers?|radar)\b/i, '')
    .replace(/^\s*(?:de|do|da|para|pra|sobre|on|for|about)\s+/i, '')
    .replace(/^[\s,.;:!?–—-]+/u, '')
    .trim());
}

/** "vasculha ofertas de X", "procura ofertas de X", "roda o radar de X" (PT e EN). */
/** "pesquisa ofertas de X", "minera ofertas": verbo de pesquisa no começo, com "ofertas" ou "radar" na frase. */
const RADAR_RESEARCH_VERB = /^(?:por favor\s+|pode\s+|agora\s+|ok\s+)?(pesquisa|pesquise|pesquisar|minera|minere|minerar|garimpa|garimpe|garimpar)\b/;
/** "consegue pesquisar no radar de ofertas pra mim?": o nome do agente com qualquer verbo de busca (uso real 20/11). */
const RADAR_BY_NAME = /\bradar de ofertas\b/;
const ANY_SEARCH_VERB = /\b(pesquisa\w*|vasculha\w*|procura\w*|busca\w*|minera\w*|garimpa\w*|roda\w*|search|find|run)\b/;
/** O Radar é de low-ticket: sem nicho dito, o nicho é esse (os subnichos saem da pesquisa). */
const RADAR_DEFAULT_NICHE = 'low ticket';
/** "pesquisa produtos de lowticket": low-ticket é o nicho do Radar, então vale como alvo mesmo sem "ofertas". */
// Também como a transcrição da voz costuma escrever (uso real 20/11: "Logtics", "Lowtickets").
const LOW_TICKET_SRC = String.raw`low ?tickets?|lo ?tickets?|lou ?tickets?|low ?tiquetes?|logtics?|lowtics?|low ?tics?|infoprodutos?`;
const LOW_TICKET_WORD = new RegExp(`\\b(${LOW_TICKET_SRC})\\b`);
/** "Lowtickets, low tickets": a frase é só o nicho (resposta curta à pergunta do Night). */
const ONLY_LOW_TICKET = new RegExp(`^(?:(?:produtos?|ofertas?|radar)\\s+(?:de\\s+)?)?(?:${LOW_TICKET_SRC})(?:[\\s,.;!]+(?:${LOW_TICKET_SRC}))*[\\s.!]*$`);
/** "use o radar e pesquise X": o verbo no meio da frase vale quando o Radar é citado pelo nome. */
const USE_RADAR = /\b(usa|use|usar|usando|liga|ligue|abre|abra)\b.{0,10}\bradar\b/;
/** Só pedido (imperativo/infinitivo): "o radar pesquisou?" e "ainda tá rodando?" não abrem Radar novo. */
const RADAR_ORDER_VERB = /\b(pesquisa|pesquise|pesquisar|vasculha|vasculhe|vasculhar|procura|procure|procurar|busca|busque|buscar|minera|minere|minerar|garimpa|garimpe|garimpar)\b/;
const ASKING_FOR = /\b(voce|pode|poderia|consegue|quero|pra mim|para mim|can you|could you|for me|please)\b/;
/** "o que é o radar de ofertas?" é pergunta sobre o Radar, não pedido de busca. */
const ABOUT_RADAR = /\bo que (e|eh|sao)\b|\bcomo funciona\b/;
const NICHE_FILLER = /^(?:(?:no|na|o|a|pelo|pela)\s+)?(?:radar|ofertas?|offers?|produtos?|algo|alguma coisa|coisas?|tudo|pra mim|para mim)?$/i;

function radarSearchIntent(text: string, n: string): Intent | null {
  const hasTarget = new RegExp(`\\b(?:${OFFER_SRC})\\b`).test(n) || new RegExp(`\\b${RADAR_SRC}\\b`).test(n);
  if (ABOUT_RADAR.test(n)) return null;
  if (ONLY_LOW_TICKET.test(n)) return { kind: 'radar-search', query: RADAR_DEFAULT_NICHE };
  const radarWord = new RegExp(`\\b${RADAR_SRC}\\b`).test(n);
  const pedido = !/\?\s*$/.test(n) || ASKING_FOR.test(n);
  const byName = (RADAR_BY_NAME.test(n) && ANY_SEARCH_VERB.test(n))
    || (radarWord && pedido && (USE_RADAR.test(n) || RADAR_ORDER_VERB.test(n)));
  const verb = SEARCH_VERB.test(n) || RADAR_RESEARCH_VERB.test(n);
  const lowTicket = LOW_TICKET_WORD.test(n) && (verb || (pedido && RADAR_ORDER_VERB.test(n)));
  if (!byName && !lowTicket && (!hasTarget || !verb)) return null;
  const limpo = text.replace(/\bradar de ofertas\b/gi, 'radar').replace(/\s+(?:pra|para) mim\b/gi, '').replace(/[?]+$/, '')
    // "use o radar e pesquise X": o "use o radar" não é nicho.
    .replace(/\b(?:usa|use|usar|usando|liga|ligue|abre|abra)\b.{0,10}\bradar\b\s*(?:(?:e|para|pra)\s+)?/i, '');
  const query = radarQuery(limpo);
  if (NICHE_FILLER.test(query.trim())) return { kind: 'radar-search', query: RADAR_DEFAULT_NICHE };
  // "produtos de lowticket" sem subnicho: o nicho é low-ticket mesmo.
  if (new RegExp(`^(?:(?:produtos?|ofertas?|coisas?)\\s+(?:de|do|da)\\s+)?(?:${LOW_TICKET_SRC})$`, 'i').test(normalize(query))) return { kind: 'radar-search', query: RADAR_DEFAULT_NICHE };
  return { kind: 'radar-search', query };
}

/** "cria um vídeo sobre X", "faz um vídeo de X" (PT e EN). */
function videoCreateIntent(text: string, n: string): Intent | null {
  if (!new RegExp(`\\b${VIDEO_SRC}\\b`).test(n) || !CREATE_VERB.test(n)) return null;
  const m = text.match(/\b(?:videos?|vídeos?)\b\s*(?:sobre|de|do|da|dos|das|a partir de|about|of|on|from)\s+(.+)$/i);
  const topic = (m?.[1] ?? text.replace(/^.*?\b(?:videos?|vídeos?)\b\s*/i, '')).replace(/[.!?]+$/, '').trim();
  return { kind: 'video-create', topic };
}

// ---------- OpenBot (telas e agentes): só por regra e sempre com a palavra "openbot" ----------
// "manda pro Radar do OpenBot pesquisar X" não é tarefa de código nem pesquisa na internet: o pedido é
// para um agente do OpenBot. O agente e a tarefa saem do texto ORIGINAL (com acentos e maiúsculas).

const OPENBOT = /\bopen ?bot\b/;

// Status do OpenBot tem que ser explícito: "o openbot é bom?" é conversa, não status.
const OPENBOT_STATUS = new RegExp([
  // "status do openbot", "andamento do openbot", "openbot status"
  String.raw`\b(status|andamento|progresso)\b.{0,30}\bopen ?bot\b`,
  String.raw`\bopen ?bot\b.{0,20}\b(status|andamento|progresso)\b`,
  // "o que o openbot fez?", "o que o openbot está fazendo?"
  String.raw`\bo que (o |a )?open ?bot\b.{0,30}\b(fez|feito|fazendo|faz|aconteceu)\b`,
  // "como estão os agentes do OpenBot?", "como está o openbot?"
  String.raw`\bcomo (esta|estao|ta|anda|vai)\b.{0,50}\bopen ?bot\b`,
  // EN: "what did openbot do?", "how are the openbot agents?"
  String.raw`\bwhat (did|has|have)\b.{0,20}\bopen ?bot\b.{0,20}\b(do|done|doing)\b`,
  String.raw`\bhow (is|are)\b.{0,30}\bopen ?bot\b`,
].join('|'));

// Diagnóstico da ligação com o OpenBot (uso real 20/11, por voz: "verifique por quê as tentativas de comunicando com
// o OpenBot"): o Qwen mandava isso para a pesquisa na internet, que não enxerga a ligação. Precisa de um assunto de
// falha/ligação na frase; pedido de envio ("manda pro X do OpenBot verificar…") não entra aqui.
const OPENBOT_TROUBLE = /\b(comunic\w*|conex\w*|conect\w*|ligacao|recebe\w*|funcion\w*|problemas?|erros?|falh\w*|tentativas?|respond\w*|resposta)\b/;
const OPENBOT_CHECK = /\b(por ?que|porque|verifi\w*|checa\w*|cheque|confer\w*|olh\w*|testa\w*|teste|ve|veja|why|check|test)\b/;

function openbotStatusIntent(n: string): Intent | null {
  if (!OPENBOT.test(n)) return null;
  if (OPENBOT_STATUS.test(n)) return { kind: 'openbot-status' };
  if (!OPENBOT_SEND.test(n) && OPENBOT_TROUBLE.test(n) && OPENBOT_CHECK.test(n)) return { kind: 'openbot-status' };
  return null;
}

// Conector entre o agente e o OpenBot: "Radar do OpenBot", "Ada no openbot", "Radar agent in OpenBot".
const LOCATOR_TAIL = /(?:^|\s)(?:do|da|de|no|na|em|para|pra|to|in|on|of|for|the|agente|agent|com)\s*$/i;
// Nome do agente = sequência de palavras com maiúscula no fim do trecho ("Radar", "NIGHT Código").
const CAP_SEQ = /([\p{Lu}][\p{L}\p{N}-]*(?:\s+[\p{Lu}][\p{L}\p{N}-]*)*)\s*$/u;

/** Nome do agente que vem antes do "OpenBot": "manda pro Radar do OpenBot …" → "Radar". */
function agentBeforeOpenbot(before: string): string | null {
  let pre = before.replace(/[\s,;:.!?–—-]+$/u, '');
  for (let i = 0; i < 3; i++) pre = pre.replace(LOCATOR_TAIL, '');
  return CAP_SEQ.exec(pre)?.[1]?.trim() || null;
}

/** Tarefa que vem depois do "OpenBot", sem os conectores e a pontuação de separação. */
function openbotTask(after: string): string {
  return after
    .replace(/^[\s,;:.!?–—-]+/u, '')
    .replace(/^(?:to|para|pra|que)\s+/i, '')
    .replace(/[.!?]+$/u, '')
    .trim();
}

/** Separa agente e tarefa de um pedido ao OpenBot; null quando falta um dos dois. */
function openbotParts(text: string): { agent: string; task: string } | null {
  const m = /\bopen\s?bot\b/i.exec(text);
  if (!m) return null;
  const before = text.slice(0, m.index);
  const after = text.slice(m.index + m[0].length);
  // "openbot, Radar: vasculha X": o agente vem DEPOIS da palavra, antes dos dois-pontos.
  const inline = /^\s*[,;:–—-]?\s*([\p{Lu}][\p{L}\p{N}-]*(?:\s+[\p{Lu}][\p{L}\p{N}-]*)*)\s*[,:–—-]\s*(.+)$/u.exec(after);
  if (inline) {
    const task = openbotTask(inline[2]!);
    return task ? { agent: inline[1]!.trim(), task } : null;
  }
  const agent = agentBeforeOpenbot(before);
  if (!agent) return null;
  const task = openbotTask(after);
  // Pedido sem tarefa ("manda pro Radar do openbot") não vira openbot-task.
  return task ? { agent, task } : null;
}

/**
 * Verbo de envio no começo: sem ele, "o que o Radar do OpenBot está fazendo?" viraria tarefa mandada de verdade
 * (revisão de 20/11). A forma "openbot, Radar: tarefa" também vale: é endereçada.
 */
const OPENBOT_SEND = /^(manda|mande|mandar|pede|peca|pedir|fala|fale|falar|diz|diga|dizer|avisa|avise|envia|envie|enviar|passa|passe|pergunta|pergunte|tell|ask|send|have)\b/;
const OPENBOT_ADDRESSED = /^open ?bot\b\s*[,:;–—-]/;
/** Artigo ou pronome solto não é nome de agente ("O OpenBot é bom?"). */
const NOT_AGENT = /^(o|a|e|os|as|um|uma|eu|ele|ela|the|an?)$/i;

/** "manda pro Radar do OpenBot pesquisar X" só vale com a palavra "openbot"/"open bot" e um verbo de envio. */
function openbotTaskIntent(text: string, n: string): Intent | null {
  if (!OPENBOT.test(n)) return null;
  const addressed = OPENBOT_ADDRESSED.test(n);
  if (!addressed && (!OPENBOT_SEND.test(n) || QUESTION.test(n))) return null;
  const parts = openbotParts(text);
  if (!parts || parts.agent.length < 2 || NOT_AGENT.test(parts.agent)) return null;
  return { kind: 'openbot-task', agent: parts.agent, task: parts.task };
}

/** Só as regras, sem modelo. null = nenhuma regra reconheceu. */
export function ruleIntent(rawText: string, projectNames: string[]): Intent | null {
  const text = stripWakeWord(rawText);
  const n = normalize(text);
  if (!n) return null;
  const project = projectIn(n, projectNames);

  if (STOP_SPEAKING.test(n)) return { kind: 'stop-speaking' };
  // OpenBot antes de oferta, código e pesquisa: "manda pro Radar do OpenBot pesquisar X" não pode
  // virar coding-task nem research, e "status do openbot" não pode virar o status genérico.
  const openbotStatus = openbotStatusIntent(n);
  if (openbotStatus) return openbotStatus;
  if (!NEGATED.test(n)) {
    const openbot = openbotTaskIntent(text, n);
    if (openbot) return openbot;
  }
  const negated = NEGATED.test(n) || QUESTION.test(n);
  // M07: "como está a campanha da oferta 2?" vem antes de tudo que fala de oferta e do status genérico.
  const campaignStatus = campaignStatusIntent(n);
  if (campaignStatus) return campaignStatus;
  // R06: conversa sobre oferta vem antes das regras genéricas. Pergunta ("por que a oferta 3 é boa?")
  // não é comando de controle, então a regra de pergunta pode achá-la mesmo com "?".
  if (!negated) {
    // L/M: links, produto e campanha antes de tudo que fala de oferta ("aprovo montar a campanha da
    // oferta 2" não pode virar "aprova a oferta 2").
    const link = offerLinkIntent(text, n);
    if (link) return link;
    const campaign = campaignIntent(text, n);
    if (campaign) return campaign;
    const edit = offerEditIntent(text, n);
    if (edit) return edit;
  }
  const ask = offerAskIntent(text, n);
  if (ask) return ask;
  // F06: decisões de oferta/vídeo e cancelamento por número vêm ANTES de aprovar/rejeitar/cancelar.
  // "aprova a oferta 2" não é aprovação de merge; "aprovo" sozinho continua sendo.
  if (!negated) {
    const show = offerShowIntent(n);
    if (show) return show;
    const offer = offerDecisionIntent(n, negated);
    if (offer) return offer;
    const video = videoDecisionIntent(n, negated);
    if (video) return video;
    const cancelJob = jobCancelIntent(n, negated);
    if (cancelJob) return cancelJob;
    const resumeJob = jobResumeIntent(n, negated);
    if (resumeJob) return resumeJob;
  }
  if (!negated && APPROVE.test(n)) return { kind: 'approval', decision: 'approve', taskHint: project };
  if (!negated && REJECT.test(n)) return { kind: 'approval', decision: 'reject', taskHint: project };
  if (!negated && CANCEL.test(n) && !SAVE_IDEA.test(n)) return { kind: 'cancel', taskHint: project ?? (/\b(tudo|todos|all|everything)\b/.test(n) ? 'all' : null) };
  if (SAVE_IDEA.test(n)) return { kind: 'save-idea', projectHint: project, text: ideaBody(text, project) };
  if (FIND_IDEAS.test(n)) return { kind: 'find-ideas', projectHint: project, query: '' };
  // F06: criar trabalho vem antes de "rodar projeto" e de pesquisa ("procura ofertas de X" não é pasta nem fato).
  const radarSearch = radarSearchIntent(text, n);
  if (radarSearch) return radarSearch;
  const videoCreate = videoCreateIntent(text, n);
  if (videoCreate) return videoCreate;
  // F07: status do trabalho antes do status genérico de tarefas de código.
  const jobStatus = jobStatusIntent(n);
  if (jobStatus) return jobStatus;
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
  // Link colado (uso real 20/11): a conversa não tem internet e respondia "cola o texto da página aqui". Quem abre
  // página é a pesquisa. Link de oferta ("a página da oferta 1 é https://…") já saiu acima.
  const url = text.match(WEB_URL)?.[0];
  // Pedido de código com link ("corrige o parser desta URL https://…") continua tarefa de código (revisão do Codex).
  if (url && !NEGATED.test(n) && !DELEGATE.test(n) && !(CODE_VERB.test(n) && CODE_NOUN.test(n))) {
    const soLink = text.trim() === url;
    return { kind: 'research', query: soLink ? `Abre este link e me diz o que tem nele (o que é, recursos, preços, para quem é): ${url}` : text.trim() };
  }
  // "Vasculha no seu próprio código...": pesquisa no PC (só leitura), não tarefa de código (D-017).
  if (PC_SEARCH.test(n) && PC_PLACE.test(n)) return { kind: 'research', query: text.trim() };
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

/** Onde procurar: arquivos do PC (o NIGHT ou um projeto), sem internet (D-017). */
const PC_PLACE = /\b(seu|teu|nosso|meu|proprio|do night|no night)\b.{0,20}\b(codigo|repositorio|projeto|arquivos?|pastas?)\b|\bno codigo\b|\bnos arquivos\b|\bno repositorio\b|\bna pasta\b|\bno (meu )?(pc|computador)\b|\b(your|our|my) (own )?(code|codebase|repo|repository|files?)\b|\bin the (code|codebase|repo|files)\b/;
const WEB_URL = /https?:\/\/[^\s<>"']+/i;
const PC_SEARCH =/\b(vasculh\w*|procur\w*|olh\w*|verifi\w*|busc\w*|ach\w*|pesquis\w*|ve|veja|search|look|check|find)\b/;
const WEB_PLACE = /\b(na internet|na web|online|no google|em sites?|nos sites|na documentacao oficial|on the web|on the internet)\b/;
const BOTH_PLACES = /\b(os dois|ambos|nos dois|both)\b/;

/**
 * Pesquisa na internet (padrão), no PC (arquivos, sem internet) ou nos dois. "Os dois" é obedecido: roda as duas
 * pesquisas separadas e junta as respostas (nenhuma sessão lê arquivo E abre página ao mesmo tempo).
 */
export function researchScope(text: string): 'web' | 'pc' | 'ambos' {
  const n = normalize(text);
  if (!PC_PLACE.test(n)) return 'web';
  return WEB_PLACE.test(n) || BOTH_PLACES.test(n) ? 'ambos' : 'pc';
}

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
