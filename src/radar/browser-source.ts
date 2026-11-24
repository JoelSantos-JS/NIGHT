// Fonte do Radar pela PÁGINA da Biblioteca de Anúncios, como no PDF de referência (pág. 3): o conector da Meta
// (ads_library_search) só devolve o título do anúncio; o formato fica no texto e o preço pode aparecer no anúncio
// ou na página de destino. Sem o texto, o Radar trazia McDonald's, crédito e loja de roupa (teste real 21/11).
//
// - Navegador sem login (Chrome instalado, sem perfil do Joel): nenhuma conta dele é usada, e a Biblioteca
//   abre sem login. Destinos públicos dos hosts de descoberta são lidos para conferir página de teste e preço.
// - Consulta `domínio + tag` com search_type=keyword_unordered (host isolado traz dezenas de milhares de
//   anúncios de vendedores diferentes; `vercel.app atividades pdf` traz ~250 no teste real do Codex).
// - Tudo que vira nota sai do texto da página, lido por código (sem modelo): texto de anúncio é de terceiro e
//   não consegue "pedir" um ponto. Número que não aparece fica "não visível".
// - Não gasta Claude, Codex nem DeepSeek: cada consulta é uma página (~20 s), limitada por execução.
// - Host compartilhado (vercel.app, kiwify, lowify) é pista de descoberta: o total do host nunca é do vendedor.

import type { AdSource, RawAd } from './collect.ts';
import type { NicheScanResult } from './meta-mcp-source.ts';
import { precoDosTitulos } from './meta-mcp-source.ts';
import { ehDominioDescoberta, ehHostCompartilhado, planejarConsultasBiblioteca } from './search-terms.ts';

/** Abre a URL e devolve o texto visível da página (depois de rolar). Injetável nos testes. */
export type AbrirPagina = (url: string) => Promise<string>;

export interface BrowserAdSourceOptions {
  country?: string;
  abrir?: AbrirPagina;
  /** Leitura de páginas públicas de destino; null desliga a verificação. */
  verificarDestino?: AbrirPagina | null;
  /** Quantos grupos (anunciantes) por busca viram candidato. */
  maxPaginas?: number;
  /** Quantas consultas (páginas) por termo nesta execução. Cada uma é uma abertura do navegador. */
  maxBuscas?: number;
  /** Data de hoje, para os testes. */
  hoje?: () => Date;
}

export interface CardBiblioteca {
  id: string;
  /** YYYY-MM-DD */
  inicio: string | null;
  pagina: string;
  corpo: string;
  /** Host completo, sem www ("cliente.vercel.app"). É a pista de destino, não a identidade do vendedor. */
  host: string | null;
  /** Domínio registrável ("vercel.app", "marca.com.br"). Em host compartilhado, não identifica o vendedor. */
  dominio: string | null;
  /** URL de destino quando a linha do anúncio trouxe o caminho. */
  destino: string | null;
  /** Host de hospedagem/checkout compartilhado: agrupar por página, nunca somar o host inteiro. */
  compartilhado: boolean;
  titulo: string;
  /** "3 anúncios usam esse criativo e esse texto" → 3; ausente → 1. */
  copias: number;
}

const MESES: Record<string, number> = {
  jan: 1, fev: 2, mar: 3, abr: 4, mai: 5, jun: 6, jul: 7, ago: 8, set: 9, out: 10, nov: 11, dez: 12,
};

/** "30 de jul de 2026" → 2026-07-30. */
export function dataDaBiblioteca(texto: string): string | null {
  const m = /(\d{1,2}) de ([a-zç]{3})[a-zç]*\.? de (\d{4})/i.exec(texto);
  if (!m) return null;
  const mes = MESES[m[2]!.toLowerCase()];
  const dia = Number(m[1]);
  if (!mes || dia < 1 || dia > 31) return null;
  const iso = `${m[3]}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso ? null : iso;
}

/** "~24.000 resultados" → 24000; "1 resultado" → 1; sem a frase → null. */
export function totalDeResultados(texto: string): number | null {
  const m = /~?\s*([\d.]+)\s*(mil\s+)?resultados?\b/i.exec(texto);
  if (!m) return null;
  const n = Number(m[1]!.replace(/\./g, ''));
  if (!Number.isFinite(n)) return null;
  return m[2] ? n * 1000 : n;
}

const DOMINIO_RE = /^(?:https?:\/\/)?(?:www\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?:[/?#].*)?$/i;
/** Destinos que não são o site do anunciante: o candidato fica pela página. */
const DOMINIO_DE_PLATAFORMA = /(^|\.)(facebook\.com|fb\.com|fb\.me|instagram\.com|whatsapp\.com|wa\.me|google\.com|apple\.com|youtube\.com|tiktok\.com|linktr\.ee)$/;
const LIXO = /^(​|​|plataformas|abrir menu suspenso|ver detalhes do anúncio|ver resumo|ver detalhes|patrocinado|\d+:\d+ \/ \d+:\d+|saiba mais|comprar agora|cadastre-se|assinar|enviar mensagem|baixar|inscreva-se|obter oferta|reservar|fale conosco|ver mais)$/i;

/**
 * Domínio principal: "policia.feliperesumao.com" → "feliperesumao.com"; "loja.site.com.br" → "site.com.br".
 * Sem isso, metade dos anúncios do mesmo vendedor ficava em outro grupo (teste real 21/11).
 */
export function dominioBase(host: string): string {
  const partes = host.toLowerCase().replace(/^www\./, '').split('.');
  const pais = partes.length >= 3 && /^[a-z]{2}$/.test(partes[partes.length - 1]!)
    && /^(com|net|org|gov|edu|art|blog|app|adv|eng|med|tec|ind|inf)$/.test(partes[partes.length - 2]!);
  return partes.slice(pais ? -3 : -2).join('.');
}

/** Linha que é só um domínio em caixa alta ("FELIPERESUMAO.COM", "HTTPS://SITE.COM.BR/?X=1"). */
export function dominioDaLinha(linha: string): string | null {
  const t = linha.trim();
  if (t !== t.toUpperCase() || /\s/.test(t)) return null;
  const m = DOMINIO_RE.exec(t);
  return m ? m[1]!.toLowerCase().replace(/^www\./, '') : null;
}

/** URL de destino da mesma linha, com o caminho quando ele veio ("HTTPS://X.VERCEL.APP/PRODUTO"). */
export function urlDaLinha(linha: string): string | null {
  const t = linha.trim();
  if (t !== t.toUpperCase() || /\s/.test(t) || !DOMINIO_RE.test(t)) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(t) ? t.replace(/^http:/i, 'https:') : `https://${t}`);
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
    return url.toString();
  } catch {
    return null;
  }
}

/** O texto da página vem com a lista "nome da página → ID numérico" no fim, depois deste marcador. */
export const MARCA_PAGINAS = '\n@@PAGINAS@@\n';

/** Nome da página → ID numérico (só os links que trazem o número; apelido não serve para a Biblioteca). */
export function idsDasPaginas(texto: string): Map<string, string> {
  const ids = new Map<string, string>();
  const i = texto.indexOf(MARCA_PAGINAS);
  if (i < 0) return ids;
  let lista: unknown;
  try { lista = JSON.parse(texto.slice(i + MARCA_PAGINAS.length)); } catch { return ids; }
  if (!Array.isArray(lista)) return ids;
  for (const par of lista) {
    if (!Array.isArray(par) || typeof par[0] !== 'string' || typeof par[1] !== 'string') continue;
    const m = /facebook\.com\/(\d{6,})\/?$/.exec(par[1]);
    const nome = par[0].trim().toLowerCase();
    if (m && !ids.has(nome)) ids.set(nome, m[1]!);
  }
  return ids;
}

/** Separa o texto da página em anúncios. Cada um começa em "Identificação da biblioteca: N". */
export function lerCards(textoCompleto: string): CardBiblioteca[] {
  const fim = textoCompleto.indexOf(MARCA_PAGINAS);
  const texto = fim >= 0 ? textoCompleto.slice(0, fim) : textoCompleto;
  const partes = texto.split(/Identificação da biblioteca:\s*(\d+)/);
  const cards: CardBiblioteca[] = [];
  for (let i = 1; i + 1 < partes.length; i += 2) {
    const id = partes[i]!;
    const linhas = partes[i + 1]!.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^[​\s]*$/.test(l));
    // O "Ativo" do próximo anúncio fica no fim deste pedaço.
    while (linhas.length && /^(ativo|inativo)$/i.test(linhas[linhas.length - 1]!)) linhas.pop();
    const inicioLinha = linhas.find((l) => /^Veiculação iniciada em/i.test(l));
    const copiasLinha = linhas.find((l) => /anúncios? usam esse criativo/i.test(l));
    const pat = linhas.findIndex((l) => /^Patrocinado$/i.test(l));
    if (pat < 1) continue;
    const pagina = linhas[pat - 1]!;
    const depois = linhas.slice(pat + 1).filter((l) => !LIXO.test(l));
    const iDominio = depois.findIndex((l) => dominioDaLinha(l) !== null);
    const corpo = (iDominio >= 0 ? depois.slice(0, iDominio) : depois).join('\n');
    const resto = iDominio >= 0 ? depois.slice(iDominio + 1) : [];
    const linhaDominio = iDominio >= 0 ? depois[iDominio]! : null;
    const host = linhaDominio ? dominioDaLinha(linhaDominio) : null;
    const destino = linhaDominio ? urlDaLinha(linhaDominio) : null;
    const dominioBruto = host ? dominioBase(host) : null;
    const plataforma = dominioBruto ? DOMINIO_DE_PLATAFORMA.test(dominioBruto) : false;
    cards.push({
      id,
      inicio: inicioLinha ? dataDaBiblioteca(inicioLinha) : null,
      pagina,
      corpo,
      host: plataforma ? null : host,
      dominio: dominioBruto && !plataforma ? dominioBruto : null,
      destino: plataforma ? null : destino,
      compartilhado: host !== null && !plataforma && ehHostCompartilhado(host),
      titulo: resto.find((l) => l !== pagina) ?? '',
      copias: copiasLinha ? Number(/(\d+)/.exec(copiasLinha)?.[1] ?? 1) : 1,
    });
  }
  return cards;
}

/**
 * Produto low-ticket do Joel (21/11): "PDF, mapas mentais, webapp, esse tipo de coisa". Tem que aparecer no texto do
 * anúncio; senão é loja, serviço ou marca grande (McDonald's, Audible, roupa) e fica de fora.
 */
const FORMATO_DIGITAL = /\b(pdf|e-?books?|apostilas? (?:em )?pdf|apostilas? digitais?|mapas? mentai?s? (?:em )?pdf|planners? digita(l|is)|cadernos? digita(l|is)|guias? digita(l|is)|kits? digita(l|is)|materia(l|is) digita(l|is)|livros? digita(l|is)|templates?|planilhas? (?:em )?pdf|checklists? (?:em )?pdf|web ?apps?|download imediato|[aá]rea de membros|flashcards? (?:em )?pdf|atividades? (para imprimir|imprim[ií]veis)|imprim[ií]ve(l|is))\b/i;
// "app" e "aplicativo" sozinhos ficaram de fora: "no App do Méqui" e banco digital passariam (teste real 21/11).
/** Entrega que exige gravar vídeo: o critério 5 do PDF é "sem gravar vídeo". */
const PRECISA_VIDEO = /\b(videoaulas?|v[ií]deo-?aulas?|aulas gravadas|aulas ao vivo|curso em v[ií]deo|mentoria|encontros? ao vivo|lives? semana(l|is))\b/i;
/** O que se entrega sem gravar vídeo (PDF, app). */
const SEM_VIDEO = /\b(pdf|e-?books?|apostilas?|mapas? menta(l|is)|planner|cadernos?|guias?|kits? digita(l|is)|livros? digita(l|is)|templates?|planilhas?|checklists?|web ?apps?|flashcards?|imprim[ií]ve(l|is)|receitu[aá]rio)\b/i;
/** Texto explícito de página de teste: preço hipotético ou checkout desativado não comprova oferta. */
export function paginaDeTeste(texto: string): boolean {
  return /checkout ainda n[aã]o est[aá] no ar|p[aá]ginas? de teste|pre[cç]o hipot[eé]tico|cta desativad[oa]|pr[eé]via das lp/i.test(texto);
}

/** Preço no destino quando o anúncio não o mostra; comparação/"de R$" não vira preço cobrado. */
export function precoDoDestino(html: string): number | null {
  if (paginaDeTeste(html)) return null;
  const texto = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/\s+/g, ' ');
  const valores = [...texto.matchAll(/\b(?:por|apenas|s[oó]|pre[cç]o(?:\s+de)?|investimento(?:\s+de)?|pague)\s*:?\s*(?:apenas\s*)?R\$\s*(\d{1,3}(?:\.\d{3})*|\d+)(?:,(\d{2}))?/gi)]
    .map((m) => Number(m[1]!.replace(/\./g, '')) + Number(m[2] ?? 0) / 100)
    .filter((v) => v >= 5);
  if (valores.length) return Math.min(...valores);
  const simples = [...texto.matchAll(/R\$\s*(\d{1,3}(?:\.\d{3})*|\d+)(?:,(\d{2}))?/gi)];
  if (simples.length !== 1) return null;
  const m = simples[0]!;
  if (/\b(?:de|economize|desconto|pr[eê]mio|sal[aá]rio|brinde)\s*$/i.test(texto.slice(Math.max(0, m.index - 25), m.index))) return null;
  const valor = Number(m[1]!.replace(/\./g, '')) + Number(m[2] ?? 0) / 100;
  return valor >= 5 ? valor : null;
}

/** Só lê destinos dos hosts de descoberta, sem redirecionar nem enviar dados do usuário. */
async function lerDestinoPublico(url: string): Promise<string> {
  const destino = new URL(url);
  if (destino.protocol !== 'https:' || !ehDominioDescoberta(destino.hostname)) throw new Error('destino fora dos hosts de descoberta');
  const resposta = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(8_000), headers: { Range: 'bytes=0-99999' } });
  if (!resposta.ok) throw new Error(`destino respondeu HTTP ${resposta.status}`);
  const tamanho = Number(resposta.headers.get('content-length'));
  if (Number.isFinite(tamanho) && tamanho > 200_000) throw new Error('página de destino muito grande');
  return (await resposta.text()).slice(0, 100_000);
}

export function textoDoCard(c: CardBiblioteca): string {
  return `${c.titulo}\n${c.corpo}`;
}

export function ehProdutoDigital(c: CardBiblioteca): boolean {
  return FORMATO_DIGITAL.test(textoDoCard(c));
}

/** true: entrega sem vídeo; false: pede vídeo; null: o texto não diz. */
export function entregavelSemVideo(textos: string[]): boolean | null {
  const tudo = textos.join('\n');
  if (PRECISA_VIDEO.test(tudo)) return false;
  return SEM_VIDEO.test(tudo) ? true : null;
}

/** Contexto em que um R$ do título não é oferta: prêmio, salário, bolsa, brinde ou "a partir de". */
const PRECO_SEM_OFERTA = /\b(?:pr[eê]mio|premia[cç][aã]o|sal[aá]rio|bolsa|gratuit[oa]s?|gr[aá]tis|brinde|a partir de|economize|desconto de)\b/i;

/**
 * Preço realmente cobrado no anúncio: no "de R$ 79 por R$ 19,90" é o 19,90.
 * Só vale o R$ que vem depois de um gatilho de oferta ("por", "apenas", "só", "investimento", "custa",
 * "pague", "sai por"). Sem gatilho, o título só conta se não falar de prêmio/salário/brinde — e, sem
 * nenhum dos dois, o preço fica ausente em vez de virar número inventado.
 */
export function precoCobrado(c: CardBiblioteca): number | null {
  const tudo = textoDoCard(c);
  const precos: number[] = [];
  for (const m of tudo.matchAll(/\b(?:por|apenas|s[oó]|investimento(?:\s+de)?|custa|pague|sai\s+por)\s*:?\s*(?:apenas\s*)?R\$\s*(\d{1,3}(?:\.\d{3})*|\d+)(?:,(\d{2}))?/gi)) {
    const v = Number(m[1]!.replace(/\./g, '')) + (m[2] ? Number(m[2]) / 100 : 0);
    if (v >= 5) precos.push(v);
  }
  if (precos.length) return Math.min(...precos);
  if (PRECO_SEM_OFERTA.test(c.titulo)) return null;
  return precoDosTitulos([c.titulo]);
}

function diasEntre(inicio: string, hoje: Date): number {
  const d = Math.floor((hoje.getTime() - new Date(`${inicio}T00:00:00Z`).getTime()) / 86_400_000);
  return Math.max(0, d);
}

const URL_BIBLIOTECA = 'https://www.facebook.com/ads/library/';

export function urlDaBusca(termo: string, country: string, tipo: 'keyword_exact_phrase' | 'keyword_unordered'): string {
  const p = new URLSearchParams({
    active_status: 'active', ad_type: 'all', country, q: termo, search_type: tipo, media_type: 'all',
  });
  return `${URL_BIBLIOTECA}?${p.toString()}`;
}

/** Todos os anúncios ativos de uma página (vendedor sem site, que vende pelo WhatsApp ou Instagram). */
export function urlDaPagina(pageId: string, country: string): string {
  const p = new URLSearchParams({
    active_status: 'active', ad_type: 'all', country, view_all_page_id: pageId, search_type: 'page', media_type: 'all',
  });
  return `${URL_BIBLIOTECA}?${p.toString()}`;
}

/** Página que não carregou resultado nenhum nem "nenhum resultado": login, CAPTCHA ou bloqueio. */
function confereCarregou(texto: string, url: string): void {
  if (/Identificação da biblioteca|resultados?\b|Remova ou ajuste os filtros/i.test(texto)) return;
  throw new Error(`a Biblioteca de Anúncios não mostrou resultados (login, CAPTCHA ou bloqueio?) em ${url.slice(0, 120)}`);
}

interface Grupo {
  chave: string;
  /** Domínio registrável só quando ele identifica o vendedor; host compartilhado fica null. */
  dominio: string | null;
  host: string | null;
  compartilhado: boolean;
  pagina: string;
  cards: CardBiblioteca[];
}

/** Chave de agrupamento: host compartilhado agrupa pela PÁGINA anunciante, nunca pelo host inteiro. */
function grupoDoCard(c: CardBiblioteca): Omit<Grupo, 'cards'> {
  const pagina = c.pagina.toLowerCase();
  if (c.compartilhado) {
    // Uma página pode vender produtos diferentes em subdomínios diferentes do mesmo host compartilhado.
    return { chave: `pagina:${pagina}|host:${c.host ?? 'sem-host'}`, dominio: null, host: c.host, compartilhado: true, pagina: c.pagina };
  }
  if (c.dominio) {
    return { chave: `dominio:${c.dominio}`, dominio: c.dominio, host: c.host, compartilhado: false, pagina: c.pagina };
  }
  return { chave: `pagina:${pagina}`, dominio: null, host: null, compartilhado: false, pagina: c.pagina };
}

/** Junta cards sem repetir id (duas consultas podem trazer o mesmo anúncio). */
function juntarCards(base: CardBiblioteca[], extras: CardBiblioteca[]): CardBiblioteca[] {
  const vistos = new Set(base.map((c) => c.id));
  return [...base, ...extras.filter((c) => {
    if (vistos.has(c.id)) return false;
    vistos.add(c.id);
    return true;
  })];
}

export class BrowserAdLibrarySource implements AdSource {
  readonly name = 'meta-ads-biblioteca';
  private readonly country: string;
  private readonly abrir: AbrirPagina;
  private readonly verificarDestino: AbrirPagina | null;
  private readonly maxPaginas: number;
  private readonly maxBuscas: number;
  private readonly hoje: () => Date;

  constructor(opts: BrowserAdSourceOptions = {}) {
    this.country = opts.country ?? 'BR';
    this.abrir = opts.abrir ?? abrirComChrome;
    this.verificarDestino = opts.verificarDestino === undefined
      ? opts.abrir ? null : lerDestinoPublico
      : opts.verificarDestino;
    this.maxPaginas = opts.maxPaginas ?? 5;
    const buscas = opts.maxBuscas ?? Number(process.env.NIGHT_RADAR_BUSCAS_POR_TERMO ?? 3);
    this.maxBuscas = Number.isInteger(buscas) && buscas > 0 ? buscas : 3;
    this.hoje = opts.hoje ?? (() => new Date());
  }

  async search(): Promise<never> {
    throw new Error('a fonte da página da Biblioteca usa busca por termo, sem cursor');
  }

  /** Fallback de contagem: só aceita a busca pelo nome quando quase todos os cards são da mesma página. */
  private async contarPaginaPorNome(nome: string): Promise<{ ativos: number | null; cards: CardBiblioteca[] }> {
    const url = urlDaBusca(nome, this.country, 'keyword_exact_phrase');
    const texto = await this.abrir(url);
    confereCarregou(texto, url);
    const encontrados = lerCards(texto);
    const mesmos = encontrados.filter((c) => c.pagina.toLowerCase() === nome.toLowerCase());
    const total = totalDeResultados(texto);
    const confiavel = mesmos.length > 0 && mesmos.length / encontrados.length >= 0.8;
    return { ativos: confiavel ? total : null, cards: mesmos };
  }

  /**
   * Uma execução faz poucas consultas por termo (padrão 3). O catálogo de tags + domínios vira
   * `domínio tag` com `keyword_unordered`; host isolado nunca é consultado, porque o total do host
   * não pertence a um vendedor. Termo explícito do Joel é preservado como primeira consulta.
   */
  async nicheScan(termo: string): Promise<NicheScanResult> {
    const consultas = planejarConsultasBiblioteca(termo, this.maxBuscas);
    if (consultas.length === 0) throw new Error('consulta vazia para a Biblioteca de Anúncios');

    const observacoes: string[] = [];
    const cardsPorId = new Map<string, CardBiblioteca>();
    const textos: string[] = [];
    const totais: number[] = [];
    let ultimaFalha: unknown = null;
    let algumaResposta = false;

    for (const consulta of consultas) {
      const url = urlDaBusca(consulta.termo, this.country, consulta.tipo);
      try {
        const texto = await this.abrir(url);
        confereCarregou(texto, url);
        algumaResposta = true;
        textos.push(texto);
        // A busca unordered pode devolver anúncios que só batem na tag. Para uma consulta com domínio,
        // só aceita anúncios cujo destino visível pertence àquele host.
        const primeiro = consulta.termo.split(' ')[0] ?? '';
        const hostDaBusca = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(primeiro) ? primeiro.toLowerCase() : null;
        const lidos = lerCards(texto).filter((c) => !hostDaBusca
          || (c.host !== null && (c.host === hostDaBusca || c.host.endsWith(`.${hostDaBusca}`))));
        for (const c of lidos) if (!cardsPorId.has(c.id)) cardsPorId.set(c.id, c);
        const total = totalDeResultados(texto);
        if (total !== null) totais.push(total);
        observacoes.push(`${consulta.termo}: ${lidos.length} anúncios lidos`);
      } catch (err) {
        ultimaFalha = err;
        observacoes.push(`${consulta.termo}: a busca falhou (${(err as Error).message.slice(0, 120)})`);
      }
    }
    if (!algumaResposta) throw ultimaFalha ?? new Error('nenhuma consulta da Biblioteca respondeu');

    const todos = [...cardsPorId.values()];
    const digitais = todos.filter(ehProdutoDigital);
    observacoes.push(`${todos.length} anúncios lidos, ${digitais.length} de produto digital (PDF, apostila, mapa mental, app…)`);

    const grupos = new Map<string, Grupo>();
    for (const c of digitais) {
      const base = grupoDoCard(c);
      const g = grupos.get(base.chave) ?? { ...base, cards: [] };
      g.cards.push(c);
      grupos.set(base.chave, g);
    }
    const anunciantesNoNicho = new Set(digitais.map((c) => c.pagina.toLowerCase())).size;
    // "vercel.app R$ 67" encontra ofertas com preço, mas de nichos diferentes: a contagem de
    // páginas dessa busca não prova concorrência no MESMO nicho e não pode pontuar esse critério.
    const buscaSoPorPreco = consultas.every((c) => /^\S+\.\S+\s+r\$\s*\d+(?:[,.]\d+)?$/i.test(c.termo));
    if (buscaSoPorPreco) observacoes.push('busca por domínio e preço reúne nichos diferentes; concorrência no mesmo nicho não visível');
    const escolhidos = [...grupos.values()]
      .sort((a, b) => peso(b) - peso(a) || a.chave.localeCompare(b.chave))
      .slice(0, this.maxPaginas);

    const ads: RawAd[] = [];
    const hoje = this.hoje();
    const idsPagina = new Map<string, string>();
    for (const texto of textos) {
      for (const [nome, id] of idsDasPaginas(texto)) if (!idsPagina.has(nome)) idsPagina.set(nome, id);
    }
    for (const g of escolhidos) {
      let ativos: number | null = null;
      let cards = g.cards;
      const pageId = idsPagina.get(g.pagina.toLowerCase()) ?? null;
      try {
        if (g.compartilhado) {
          // Host compartilhado (vercel.app, kiwify…): o total do host é de todo mundo. Só conta a
          // página anunciante, e somente quando a Biblioteca devolve o ID dela.
          if (pageId) {
            const urlPagina = urlDaPagina(pageId, this.country);
            const daPagina = await this.abrir(urlPagina);
            confereCarregou(daPagina, urlPagina);
            const mesmos = lerCards(daPagina).filter((c) => c.pagina.toLowerCase() === g.pagina.toLowerCase());
            if (mesmos.length > 0) ativos = totalDeResultados(daPagina);
            else observacoes.push(`${g.pagina}: a página não mostrou os anúncios dela; anúncios ativos não visível`);
            cards = juntarCards(cards, mesmos);
          }
          if (ativos === null) {
            const porNome = await this.contarPaginaPorNome(g.pagina);
            ativos = porNome.ativos;
            cards = juntarCards(cards, porNome.cards);
            if (ativos === null) observacoes.push(`${g.pagina}: host compartilhado (${g.host ?? 'sem host'}); total do host não é do vendedor e contagem por página não visível`);
          }
        } else if (g.dominio) {
          // Anúncios ativos no domínio (critério 1): busca o domínio e lê o "~N resultados". Só conta se os
          // anúncios que vieram são mesmo desse domínio; busca solta de domínio curto pode trazer outros.
          const urlDominio = urlDaBusca(g.dominio, this.country, 'keyword_unordered');
          const doDominio = await this.abrir(urlDominio);
          confereCarregou(doDominio, urlDominio);
          const comDominio = lerCards(doDominio).filter((c) => c.dominio !== null);
          const mesmos = comDominio.filter((c) => c.dominio === g.dominio);
          if (comDominio.length > 0 && mesmos.length / comDominio.length >= 0.8) ativos = totalDeResultados(doDominio);
          else observacoes.push(`${g.dominio}: a busca do domínio trouxe outros sites; anúncios ativos não visível`);
          cards = juntarCards(cards, mesmos);
        } else if (pageId) {
          // Vendedor sem site (WhatsApp, Instagram): conta os anúncios ativos da página.
          const urlPagina = urlDaPagina(pageId, this.country);
          const daPagina = await this.abrir(urlPagina);
          confereCarregou(daPagina, urlPagina);
          const mesmos = lerCards(daPagina).filter((c) => c.pagina.toLowerCase() === g.pagina.toLowerCase());
          if (mesmos.length > 0) ativos = totalDeResultados(daPagina);
          cards = juntarCards(cards, mesmos);
          if (ativos === null) {
            const porNome = await this.contarPaginaPorNome(g.pagina);
            ativos = porNome.ativos;
            cards = juntarCards(cards, porNome.cards);
          }
        } else {
          const porNome = await this.contarPaginaPorNome(g.pagina);
          ativos = porNome.ativos;
          cards = juntarCards(cards, porNome.cards);
          if (ativos === null) observacoes.push(`${g.pagina}: sem site nem ID da página; anúncios ativos não visível`);
        }
      } catch (err) {
        observacoes.push(`${g.dominio ?? g.pagina}: não deu para contar os anúncios (${(err as Error).message.slice(0, 120)})`);
      }
      // O total da página pode incluir outros produtos. Volume, cópias e idade da OFERTA
      // vêm só dos cards do mesmo grupo (página + destino no host compartilhado).
      const inicios = g.cards.map((c) => c.inicio).filter((d): d is string => d !== null).sort();
      const anunciosDaOferta = peso(g);
      const copiasCriativo = Math.max(...g.cards.map((c) => c.copias));
      const precos = g.cards.map(precoCobrado).filter((p): p is number => p !== null);
      const principal = g.cards[0]!;
      const textosDosCards = cards.map(textoDoCard);
      const landingUrl = principal.destino ?? (g.host ? `https://${g.host}` : g.dominio ? `https://${g.dominio}` : null);
      let precoPagina: number | null = null;
      if (landingUrl && this.verificarDestino && ehDominioDescoberta(new URL(landingUrl).hostname)) {
        try {
          const pagina = await this.verificarDestino(landingUrl);
          if (paginaDeTeste(pagina)) {
            observacoes.push(`${g.pagina}: página de teste, checkout desativado ou preço hipotético; candidato descartado`);
            continue;
          }
          precoPagina = precoDoDestino(pagina);
          if (!precos.length && precoPagina !== null) observacoes.push(`${g.pagina}: preço R$ ${precoPagina} lido na página de destino`);
        } catch (err) {
          observacoes.push(`${g.pagina}: destino não verificado (${(err as Error).message.slice(0, 100)})`);
        }
      }
      ads.push({
        externalId: g.compartilhado
          ? `${pageId ? `page:${pageId}` : `pagina:${g.pagina.toLowerCase()}`}:host:${g.host ?? 'sem-host'}`
          : g.dominio ? `dominio:${g.dominio}` : pageId ? `page:${pageId}` : `pagina:${g.pagina.toLowerCase()}`,
        ...(pageId ? { page_id: pageId } : {}),
        advertiser: g.pagina,
        country: this.country,
        adUrl: `${URL_BIBLIOTECA}?id=${principal.id}`,
        ...(landingUrl ? { landingUrl } : {}),
        ...(inicios.length ? { startedAt: inicios[0], diasNoAr: diasEntre(inicios[0]!, hoje) } : {}),
        ...(ativos !== null ? { activeAdsInDomain: ativos } : {}),
        anunciosDaOferta,
        copiasCriativo,
        ...(!buscaSoPorPreco ? { anunciantesNoNicho: Math.max(1, anunciantesNoNicho) } : {}),
        ...(precos.length || precoPagina !== null ? { precoOrigem: precos.length ? Math.min(...precos) : precoPagina! } : {}),
        entregavelEmPdf: entregavelSemVideo(textosDosCards),
        titulos: [...new Set(g.cards.map((c) => c.titulo).filter(Boolean))].slice(0, 5),
        // O gerador da oferta lê o produto daqui (texto de terceiro: o gerador trata como dado).
        anuncioTexto: [principal.titulo, principal.corpo].filter(Boolean).join(' | ').slice(0, 600),
      });
    }
    if (digitais.length === 0) observacoes.push('nenhum anúncio de produto digital nesta busca');
    // Várias consultas: o total de uma não é a soma (os mesmos anúncios se repetem). Maior total observado.
    return { ads, estimatedTotal: totais.length ? Math.max(...totais) : todos.length, anunciantesNoNicho, observacoes };
  }
}

/** Mais anúncios (contando as cópias do mesmo criativo) primeiro. */
function peso(g: Grupo): number {
  return g.cards.reduce((s, c) => s + c.copias, 0);
}

/**
 * Abre a Biblioteca no Chrome instalado, sem login e sem perfil do Joel (contexto novo a cada busca), rola algumas
 * vezes para carregar mais anúncios e devolve o texto da página.
 */
export const abrirComChrome: AbrirPagina = async (url) => {
  const { chromium } = await import('playwright-core');
  const navegador = await chromium.launch({
    channel: process.env.NIGHT_RADAR_CHROME_CHANNEL ?? 'chrome',
    headless: process.env.NIGHT_RADAR_HEADLESS !== '0',
  });
  try {
    const contexto = await navegador.newContext({ locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' });
    const pagina = await contexto.newPage();
    await pagina.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await pagina.waitForFunction(
      () => /Identificação da biblioteca|Remova ou ajuste os filtros/.test(document.body?.innerText ?? ''),
      undefined, { timeout: 30_000 },
    ).catch(() => undefined);
    const configurado = Number(process.env.NIGHT_RADAR_ROLAGENS ?? 8);
    const rolagens = Number.isInteger(configurado) ? Math.min(Math.max(configurado, 0), 20) : 8;
    for (let i = 0; i < rolagens; i++) {
      await pagina.mouse.wheel(0, 5000);
      await pagina.waitForTimeout(1800);
    }
    const texto = await pagina.evaluate(() => document.body?.innerText ?? '');
    // Nome da página → link dela: quando o link traz o ID numérico, dá para contar os anúncios de quem não tem site.
    const links = await pagina.evaluate(() => [...document.querySelectorAll('a[href*="facebook.com/"]')]
      .map((a) => [(a as HTMLElement).innerText.trim(), a.getAttribute('href') ?? ''])
      .filter(([t, h]) => t && !t.includes('\n') && /^https:\/\/www\.facebook\.com\/\d+\/?$/.test(h!)));
    return `${texto}${MARCA_PAGINAS}${JSON.stringify(links)}`;
  } finally {
    await navegador.close();
  }
};
