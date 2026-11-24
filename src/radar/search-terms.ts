/**
 * Vocabulário mostrado pelo Joel nas capturas de 21/11/2026.
 * Os domínios são pistas de descoberta, não prova de venda nem identidade do anunciante:
 * vários vendedores podem usar o mesmo host (vercel.app, páginas da Lowify etc.).
 */
export const TAGS_OFERTA = {
  pt: {
    geral: [
      'dinâmicas', 'atividades para imprimir', 'caderno de atividades', 'material digital',
      'alfabetização', 'leitura fácil', 'estimulação cognitiva', 'neuroestimulação',
      'recursos para psicólogo', 'planner digital', 'ebook receitas', 'acesso imediato',
      'entrega imediata', 'receba no e-mail', 'pague uma vez',
    ],
    pdf: ['atividades pdf', 'pdf ilustrado', 'apostila pdf', 'kit pdf', 'material em pdf'],
    black: ['app', 'truque da', 'ritual', 'choquei', 'ganhar dinheiro'],
  },
  es: {
    geral: [
      'dinámicas', 'actividades para imprimir', 'cuaderno de actividades', 'material digital',
      'lectoescritura', 'lectura fácil', 'estimulación cognitiva', 'neuroestimulación',
      'recursos para psicólogos', 'planner digital', 'recetario digital', 'acceso inmediato',
      'entrega inmediata', 'recíbelo en tu correo', 'pago único',
    ],
    pdf: ['actividades pdf', 'pdf ilustrado', 'cuadernillo pdf', 'kit pdf', 'material en pdf'],
    black: ['app', 'el truco de', 'ritual', 'impactante', 'ganar dinero'],
  },
  en: {
    geral: [
      'group activities', 'printable activities', 'activity book', 'digital product',
      'phonics', 'easy reader', 'cognitive stimulation', 'brain training',
      'therapy worksheets', 'digital planner', 'recipe ebook', 'instant access',
      'instant download', 'sent to your email', 'one-time payment',
    ],
    pdf: ['activities pdf', 'illustrated pdf', 'workbook pdf', 'pdf bundle', 'printable pdf'],
    black: ['app', 'the trick', 'ritual', 'shocking', 'make money'],
  },
} as const;

/** Hosts das capturas. Uma consulta por host precisa ser cruzada com tag de produto e página do anunciante. */
export const DOMINIOS_DESCOBERTA = [
  // As que mais trazem low-ticket, segundo o Joel (24/11).
  'vercel.app', 'lovable.app', 'netlify.app', 'paginas.lowify.com.br',
] as const;

/**
 * Hosts que são infraestrutura de hospedagem/checkout, não identidade do vendedor.
 * O total de anúncios de um `vercel.app` (~26 mil no teste real) não é de ninguém em particular:
 * a contagem só vale por página anunciante ou quando o próprio host é exclusivo.
 */
export const HOSTS_COMPARTILHADOS = [
  ...DOMINIOS_DESCOBERTA,
  'lowify.com.br', 'kiwify.com.br', 'kiwify.app', 'hotmart.host', 'hotmart.com',
] as const;

/** Frases de busca da página 4 do PDF; o preço é da oferta de origem. */
export const PALAVRAS_PDF = [
  'apenas R$ 47', 'apenas R$ 67', 'apenas R$ 97', 'de R$ 197 por R$ 67',
  'acesso vitalício', 'curso completo passo a passo', 'método comprovado', 'garantia de 7 dias',
] as const;

/** Preço pretendido da versão original do Joel, não filtro da oferta de origem. */
export const PRECO_ALVO = { minimo: 9.9, maximo: 19.9 } as const;

/** Tags de produto para consulta: PT primeiro, depois ES e EN. Black fica fora da busca por padrão. */
export const TAGS_BUSCA = [
  ...TAGS_OFERTA.pt.pdf, ...TAGS_OFERTA.pt.geral,
  ...TAGS_OFERTA.es.pdf, ...TAGS_OFERTA.es.geral,
  ...TAGS_OFERTA.en.pdf, ...TAGS_OFERTA.en.geral,
] as const;

/** As mesmas tags, sem repetição e em ordem estável. */
export function tagsDoCatalogo(): string[] {
  return [...new Set(TAGS_BUSCA)];
}

export type TipoBuscaBiblioteca = 'keyword_exact_phrase' | 'keyword_unordered';

/** Uma consulta à Biblioteca: o texto pesquisado e o tipo de correspondência. */
export interface ConsultaBiblioteca {
  termo: string;
  tipo: TipoBuscaBiblioteca;
}

const normalizar = (valor: string): string => valor.trim().toLowerCase().replace(/\s+/g, ' ');
const hostNormalizado = (valor: string): string =>
  valor.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/[/?#].*$/, '').replace(/^www\./, '');

function termoEhHost(valor: string): boolean {
  const host = hostNormalizado(valor);
  // Termina em TLD alfabético: "vercel.app" é host; "5.0" de "fone bluetooth 5.0" não é.
  return /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(host);
}

export function ehDominioDescoberta(valor: string): boolean {
  const host = hostNormalizado(valor);
  return (DOMINIOS_DESCOBERTA as readonly string[]).some((dominio) => host === dominio || host.endsWith(`.${dominio}`));
}

/** Host de infraestrutura compartilhada (hospedagem, checkout, página pronta). */
export function ehHostCompartilhado(valor: string): boolean {
  const host = hostNormalizado(valor);
  return (HOSTS_COMPARTILHADOS as readonly string[]).some((dominio) => host === dominio || host.endsWith(`.${dominio}`));
}

/**
 * Uma palavra da consulta que já é um host (`vercel.app atividades pdf`): a consulta foi combinada
 * e não deve ganhar outra camada de domínio.
 */
export function termoComHost(valor: string): boolean {
  return normalizar(valor).split(' ').some(termoEhHost);
}

/** Tira preço do termo: "apenas R$ 47" e "de R$ 197 por R$ 67" não retornam anúncio na Biblioteca. */
function semPreco(valor: string): string {
  return normalizar(valor)
    .replace(/\b(?:de|por|apenas|s[oó]|at[eé])\s*R\$\s*[\d.,]+/gi, ' ')
    .replace(/\bR\$\s*[\d.,]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Palavras que não são produto: com um preço, o pedido é genérico ("ofertas de R$ 47"). */
const PALAVRA_GENERICA = /\b(?:ofertas?|produtos?|coisas?|barat[oa]s?|low[ -]?tickets?|infoprodutos?|de|por|apenas|s[oó]|at[eé])\b/gi;

/** Frase que é só preço (ou uma das frases do PDF): buscar exatamente isso devolve zero. */
export function pareceFraseDePreco(valor: string): boolean {
  const termo = normalizar(valor);
  if (!/\bR\$\s*[\d.,]+/i.test(termo)) return false;
  const resto = semPreco(termo).replace(PALAVRA_GENERICA, ' ').replace(/\s+/g, ' ').trim();
  return resto === '' || (PALAVRAS_PDF as readonly string[]).some((p) => normalizar(p) === termo);
}

/** Pedido genérico de low-ticket: o termo não é um nicho concreto, é o próprio método. */
export function ehPedidoGenerico(valor: string): boolean {
  const termo = normalizar(valor);
  if (!termo) return false;
  if (pareceFraseDePreco(termo)) return true;
  if (/^(?:ofertas?|produtos?|coisas?)(?:\s+(?:barat[oa]s?|mais barat[oa]s?))?$/.test(termo)) return true;
  return /^(?:(?:ofertas?|produtos?)\s+(?:de\s+)?)?(?:low[ -]?tickets?|infoprodutos?|produtos? digitais?)$/i.test(termo);
}

/**
 * Busca por domínio no índice; a resposta ainda precisa ser separada por anunciante.
 * `deslocamento` gira o começo da lista para as rodadas do dia cobrirem todos os hosts.
 */
export function consultasDeDominio(nicho: string, quantidade = 3, deslocamento = 0): string[] {
  const termo = nicho.trim().replace(/\s+/g, ' ');
  if (!termo) return [];
  const total = DOMINIOS_DESCOBERTA.length;
  const n = Math.min(Math.max(0, Math.trunc(quantidade)), total);
  const inicio = ((Math.trunc(deslocamento) % total) + total) % total;
  return Array.from({ length: n }, (_, i) => `${DOMINIOS_DESCOBERTA[(inicio + i) % total]!} ${termo}`);
}

/**
 * Consultas para uma execução do Radar.
 *
 * - Termo que já traz um domínio (`vercel.app atividades pdf`) é preservado como veio.
 * - Termo genérico ou frase de preço vira `domínio + tag do catálogo`, nunca um host isolado
 *   (host sozinho traz dezenas de milhares de anúncios de vendedores diferentes).
 * - Nicho explícito do Joel é preservado primeiro; as consultas seguintes combinam o nicho com
 *   hosts de descoberta, que é o que separa o produto do resto da página.
 *
 * Tudo em `keyword_unordered`: frase exata de preço do PDF devolve zero na Biblioteca real.
 */
export function planejarConsultasBiblioteca(
  termo: string, maximo = 3, deslocamento = 0,
): ConsultaBiblioteca[] {
  const limpo = normalizar(termo);
  if (!limpo) return [];
  if (termoComHost(limpo)) return [{ termo: limpo, tipo: 'keyword_unordered' }];

  const n = Math.max(1, Math.trunc(maximo));
  const consultas: ConsultaBiblioteca[] = [];
  const tagExplicita = semPreco(limpo).replace(/\s+para\s+(?:re)?vender$/, '').trim();
  // Tag já conhecida do catálogo ("atividades pdf") é a tag a combinar com o domínio.
  // Pedido genérico giro o catálogo inteiro; nicho do Joel ("fone bluetooth") é preservado primeiro.
  const generico = ehPedidoGenerico(limpo);
  const tagDoCatalogo = tagsDoCatalogo().some((tag) => normalizar(tag) === tagExplicita);
  const tags = generico || tagExplicita === '' ? tagsDoCatalogo() : [tagExplicita];

  if (!generico && !tagDoCatalogo && tagExplicita !== '') {
    consultas.push({ termo: tagExplicita, tipo: 'keyword_unordered' });
  }
  // Teto de tentativas: se as combinações acabarem, devolve as que existem em vez de girar para sempre.
  const tentativas = Math.min(n * 2, tags.length * DOMINIOS_DESCOBERTA.length);
  for (let i = 0; consultas.length < n && i < tentativas; i++) {
    const tag = tags[(deslocamento + i) % tags.length]!;
    const [comDominio] = consultasDeDominio(tag, 1, deslocamento + i);
    if (comDominio && !consultas.some((c) => c.termo === comDominio)) {
      consultas.push({ termo: comDominio, tipo: 'keyword_unordered' });
    }
  }
  return consultas;
}
