// Matriz de decisões do DeepSeek (D01, docs/PLANO_MESTRE_NIGHT.md).
// Declarativa de propósito: cada consulta prevista tem pergunta concreta, artefato de entrada,
// limite e motivo registrável. Id fora daqui NUNCA consulta — nada de chamar o modelo às cegas.
// Perguntas e entradas vêm da tabela "Onde entra" de docs/research/plano-deepseek.md e de D05–D07.

export type Impacto = 'baixo' | 'medio' | 'alto';

export type ModeloParecer = 'deepseek-flash' | 'deepseek-v4-pro';

export interface LimiteConsulta {
  /** Chamadas no máximo para este ponto; repetir sem mudança não vale outra cobrança. */
  maxChamadas: number;
  timeoutMs: number;
  modelo: ModeloParecer;
}

export interface DecisionPoint {
  /** Ex.: 'codigo.diff-final'. Prefixo = domínio, para agrupar sem ambiguidade. */
  id: string;
  dominio: 'codigo' | 'radar' | 'video' | 'geral';
  fase: string;
  /** A pergunta concreta enviada ao DeepSeek. */
  pergunta: string;
  /** Qual artefato vai como evidência (o mínimo necessário, nunca o repositório inteiro). */
  entrada: string;
  impacto: Impacto;
  limite: LimiteConsulta;
  /** Por que consultar aqui, para o registro de decisão. */
  motivo: string;
}

/** Flash para crítica curta; pro só onde o custo de errar é alto (dito no motivo). */
const TIMEOUT_FLASH_MS = 60_000;
const TIMEOUT_PRO_MS = 90_000;

export const DECISION_POINTS: readonly DecisionPoint[] = [
  {
    id: 'geral.pedido-complexo',
    dominio: 'geral',
    fase: 'pedido',
    pergunta: 'O objetivo está claro? Falta critério de pronto ou há risco relevante antes de começar?',
    entrada: 'pedido do Joel (texto ou voz) + estado do job',
    impacto: 'medio',
    limite: { maxChamadas: 1, timeoutMs: TIMEOUT_FLASH_MS, modelo: 'deepseek-flash' },
    motivo: 'Pedido vago vira retrabalho; uma crítica curta evita perguntar a Joel o que não bloqueia o próximo passo.',
  },
  {
    id: 'codigo.cartao',
    dominio: 'codigo',
    fase: 'cartao',
    pergunta: 'O cartão é testável? Objetivo, escopo e critérios de pronto permitem verificar o resultado?',
    entrada: 'cartão (objetivo, escopo, critérios de pronto, arquivos permitidos)',
    impacto: 'baixo',
    limite: { maxChamadas: 1, timeoutMs: TIMEOUT_FLASH_MS, modelo: 'deepseek-flash' },
    motivo: 'Erro no cartão ainda aparece no plano e no diff; corrigir uma linha ou texto aqui não justifica consulta.',
  },
  {
    id: 'codigo.plano',
    dominio: 'codigo',
    fase: 'plano',
    pergunta: 'O plano cobre o objetivo do cartão sem regressão e com teste para cada mudança?',
    entrada: 'cartão aprovado + plano de execução',
    impacto: 'medio',
    limite: { maxChamadas: 1, timeoutMs: TIMEOUT_FLASH_MS, modelo: 'deepseek-flash' },
    motivo: 'Plano errado custa uma implementação inteira; crítica curta sobre o plano é a consulta mais barata para evitar isso.',
  },
  {
    id: 'codigo.diff-final',
    dominio: 'codigo',
    fase: 'diff-final',
    pergunta: 'O diff final cobre o objetivo e tem teste para o caso de erro? Há regressão ou teste faltante?',
    entrada: 'diff + resultado dos testes',
    impacto: 'alto',
    limite: { maxChamadas: 1, timeoutMs: TIMEOUT_PRO_MS, modelo: 'deepseek-v4-pro' },
    motivo: 'Antes da decisão de merge o custo de errar é alto: deepseek-v4-pro procura regressão e teste faltante que o teste verde não mostra.',
  },
  {
    id: 'radar.evidencia',
    dominio: 'radar',
    fase: 'evidencia',
    pergunta: 'A evidência realmente sustenta demanda, preço e promessa? O que falta para sustentar?',
    entrada: 'anúncios e dados coletados (trechos com origem)',
    impacto: 'medio',
    limite: { maxChamadas: 1, timeoutMs: TIMEOUT_FLASH_MS, modelo: 'deepseek-flash' },
    motivo: 'A nota é determinística e fica em código; aqui só se contesta se a evidência sustenta a leitura, sem inventar número.',
  },
  {
    id: 'radar.oferta-original',
    dominio: 'radar',
    fase: 'oferta-original',
    pergunta: 'Qual é o argumento contra a oferta? O preço é hipótese e a promessa original tem fonte?',
    entrada: 'oferta original + evidências + nota de triagem',
    impacto: 'alto',
    limite: { maxChamadas: 1, timeoutMs: TIMEOUT_PRO_MS, modelo: 'deepseek-v4-pro' },
    motivo: 'Promessa de venda ou lucro sem fonte é risco alto para Joel; deepseek-v4-pro revisa o contraponto antes de qualquer alegação.',
  },
  {
    id: 'lowticket.produto',
    dominio: 'radar',
    fase: 'produto',
    pergunta: 'O conteúdo entrega o que a promessa diz, sem promessa de renda e sem copiar concorrente? O que falta?',
    entrada: 'promessa da oferta aprovada + resumo de cada PDF (títulos de seções)',
    impacto: 'medio',
    limite: { maxChamadas: 1, timeoutMs: TIMEOUT_FLASH_MS, modelo: 'deepseek-flash' },
    motivo: 'Texto errado aparece em todos os PDFs de uma vez; uma crítica curta antes do render evita refazer o pacote sem pagar o modelo mais caro.',
  },
  {
    id: 'video.roteiro',
    dominio: 'video',
    fase: 'roteiro',
    pergunta: 'O roteiro distingue fato de ilustração? Há repetição, promessa enganosa ou fonte fraca?',
    entrada: 'roteiro + fontes citadas',
    impacto: 'medio',
    limite: { maxChamadas: 1, timeoutMs: TIMEOUT_FLASH_MS, modelo: 'deepseek-flash' },
    motivo: 'Corrigir o roteiro antes de narração e imagens evita refazer cena; crítica curta basta nesta fase.',
  },
  {
    id: 'video.antes-do-render',
    dominio: 'video',
    fase: 'antes-do-render',
    pergunta: 'Alguma afirmação importante está sem fonte ou alguma cena pode enganar? O que corrigir antes do render?',
    entrada: 'roteiro final + lista de cenas + imagens ilustrativas + fontes',
    impacto: 'alto',
    limite: { maxChamadas: 1, timeoutMs: TIMEOUT_PRO_MS, modelo: 'deepseek-v4-pro' },
    motivo: 'Render final publica afirmação factual e custa tempo; impacto alto justifica deepseek-v4-pro antes de gastar o render.',
  },
  {
    id: 'geral.divergencia',
    dominio: 'geral',
    fase: 'divergencia',
    pergunta: 'A causa provável é dados, ferramenta, escopo ou hipótese? Qual teste menor resolve a divergência?',
    entrada: 'pareceres divergentes + evidências + resultado dos testes',
    impacto: 'alto',
    limite: { maxChamadas: 2, timeoutMs: TIMEOUT_PRO_MS, modelo: 'deepseek-v4-pro' },
    motivo: 'Divergência difícil é o caso previsto para o modelo mais forte; deepseek-v4-pro vê a posição e depois compara com a do outro agente (máximo de 2 chamadas).',
  },
];

/** Casos dispensados: documentados para o registro explicar por que NÃO houve consulta. */
export interface SkippedCase {
  caso: string;
  motivo: string;
}

export const SKIPPED: readonly SkippedCase[] = [
  {
    caso: 'saudação ou conversa sem pedido',
    motivo: 'não há decisão a criticar; responder direto é mais rápido e mais barato',
  },
  {
    caso: 'pergunta simples de status',
    motivo: 'o estado vem do banco; um parecer não acrescenta verificação nem fonte',
  },
  {
    caso: 'correção de uma linha ou de texto',
    motivo: 'diff pequeno e coberto por teste; a consulta só somaria latência e custo',
  },
  {
    caso: 'pesquisa factual simples',
    motivo: 'basta a fonte consultada; parecer sem fonte nova não melhora a resposta',
  },
];

const ORDEM_IMPACTO: Record<Impacto, number> = { baixo: 0, medio: 1, alto: 2 };

/**
 * Validação na carga: id repetido ou limite não positivo é erro de programação e derruba o módulo,
 * em vez de virar uma consulta sem teto em produção.
 */
export function validateDecisionPoints(points: readonly DecisionPoint[]): void {
  const vistos = new Set<string>();
  for (const point of points) {
    if (vistos.has(point.id)) throw new Error(`ponto de decisão repetido: ${point.id}`);
    vistos.add(point.id);
    if (!Number.isInteger(point.limite.maxChamadas) || point.limite.maxChamadas < 1) {
      throw new Error(`ponto de decisão "${point.id}" com maxChamadas inválido: ${point.limite.maxChamadas}`);
    }
    if (!Number.isFinite(point.limite.timeoutMs) || point.limite.timeoutMs <= 0) {
      throw new Error(`ponto de decisão "${point.id}" com timeoutMs inválido: ${point.limite.timeoutMs}`);
    }
  }
}

validateDecisionPoints(DECISION_POINTS);

const BY_ID = new Map(DECISION_POINTS.map((point) => [point.id, point]));

export function getDecisionPoint(id: string): DecisionPoint | null {
  return BY_ID.get(id) ?? null;
}

export interface ShouldConsultContext {
  /** Impacto real do caso, quando conhecido; maior que o do ponto sobe a consulta de nível. */
  impacto?: Impacto;
  /** Caso trivial (texto, uma linha): dispensa consulta só em ponto de impacto baixo. */
  simples?: boolean;
}

export interface ShouldConsultResult {
  consultar: boolean;
  motivo: string;
  point: DecisionPoint | null;
}

/** Decide se este ponto consulta o DeepSeek. Id desconhecido nunca consulta. */
export function shouldConsult(pointId: string, ctx: ShouldConsultContext = {}): ShouldConsultResult {
  const point = getDecisionPoint(pointId);
  if (!point) return { consultar: false, motivo: 'ponto de decisão não cadastrado', point: null };

  // Impacto maior que o previsto vence o "simples": escalar é mais seguro que economizar.
  if (ctx.impacto && ORDEM_IMPACTO[ctx.impacto] > ORDEM_IMPACTO[point.impacto]) {
    return {
      consultar: true,
      motivo: `impacto informado (${ctx.impacto}) passa do impacto do ponto (${point.impacto}); a consulta sobe de nível`,
      point,
    };
  }

  if (ctx.simples) {
    if (point.impacto === 'baixo') {
      return { consultar: false, motivo: 'caso simples em ponto de impacto baixo; economiza latência e custo', point };
    }
    return { consultar: true, motivo: `caso simples não dispensa ponto de impacto ${point.impacto}`, point };
  }

  return { consultar: true, motivo: `ponto cadastrado (impacto ${point.impacto}); consulta prevista`, point };
}
