// Coleta incremental do Radar (R03): pagina por palavra-chave, guarda o cursor e deduplica.
// A fonte real ainda não foi provada (API da Meta), então a coleta fala com AdSource:
// o teste usa uma fonte falsa com páginas; trocar a fonte não muda esta lógica.
// Nenhum campo é inventado: o que a fonte não mandou fica null e entra em unknown_fields.

import type { NewCandidate, PgRadarStore } from './store.ts';
import { QuotaError } from '../agents/research.ts';

/** Parâmetros de rastreio que não mudam a página de destino. */
const PARAMS_EXTRA = new Set(['fbclid', 'gclid', 'ttclid']);

/** Campos que a triagem gostaria de ver; ausente é registrado, não estimado. */
const CAMPOS_ESPERADOS = ['advertiser', 'adUrl', 'landingUrl', 'country', 'startedAt', 'activeAdsInDomain'] as const;

export interface RawAd {
  externalId: string;
  advertiser?: string | null;
  adUrl?: string | null;
  landingUrl?: string | null;
  country?: string | null;
  /** Início do anúncio na fonte (ISO 8601 ou YYYY-MM-DD). */
  startedAt?: string | null;
  /** Anúncios ativos no domínio; alimenta a nota de triagem. */
  activeAdsInDomain?: number | null;
  /** Outros campos da fonte ficam em raw e não são descartados. */
  [campo: string]: unknown;
}

export interface AdSource {
  readonly name: string;
  nicheScan?(termo: string): Promise<{ ads: RawAd[]; observacoes: string[] }>;
  search(
    keyword: string, cursor: string | null, limit: number,
  ): Promise<{ ads: RawAd[]; nextCursor: string | null }>;
}

export interface CollectOptions {
  jobId: string;
  keywords: string[];
  /** Teto de anúncios vistos por palavra-chave nesta execução. */
  maxPerKeyword: number;
  /** Teto de páginas por palavra-chave nesta execução. */
  maxPages: number;
  /** Avisos da busca por nicho (anúncio ou página descartada e por quê), para o relatório. */
  onAviso?: (texto: string) => void;
  /** Conferido antes de cada palavra-chave: cancelado, para sem abrir outra sessão. */
  cancelado?: () => boolean;
}

export interface CollectCounters {
  vistos: number;
  novos: number;
  duplicados: number;
  incompletos: number;
}

/** Quem a coleta precisa do store; facilita usar um falso nos testes. */
export type CollectStore = Pick<PgRadarStore, 'getCursor' | 'setCursor' | 'upsertCandidate'>;

/**
 * Normaliza a URL de destino para deduplicar: host minúsculo e sem www, sem fragmento,
 * sem parâmetros de rastreio, sem barra final e sempre https. Inválida devolve null.
 */
export function normalizeUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;

  let host = parsed.hostname.toLowerCase();
  if (host.startsWith('www.')) host = host.slice(4);
  if (!host) return null;
  if (parsed.port) host = `${host}:${parsed.port}`;

  const caminho = parsed.pathname.replace(/\/+$/, '');
  const params = new URLSearchParams();
  for (const [nome, valor] of parsed.searchParams) {
    const chave = nome.toLowerCase();
    if (chave.startsWith('utm_') || chave.startsWith('mc_') || PARAMS_EXTRA.has(chave)) continue;
    params.append(nome, valor);
  }
  const busca = params.toString();
  return `https://${host}${caminho}${busca ? `?${busca}` : ''}`;
}

/** Domínio para agrupar candidatos: host minúsculo, sem www; inválida devolve null. */
export function domainOf(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  let host = parsed.hostname.toLowerCase();
  if (host.startsWith('www.')) host = host.slice(4);
  return host || null;
}

/** Só a data: a hora de início na fonte não é confiável. */
function dataCurta(valor: string | null | undefined): string | null {
  if (valor === null || valor === undefined) return null;
  const encontrado = /^(\d{4}-\d{2}-\d{2})/.exec(String(valor).trim());
  return encontrado ? encontrado[1]! : null;
}

/**
 * Link de anúncio da Biblioteca (facebook.com/ads/archive/…) não é o site do anunciante: usado como
 * domínio, juntava todas as páginas de um nicho numa oferta só (achado na revisão de 20/11).
 */
const HOSTS_DA_META = /(^|\.)(facebook\.com|fb\.com|fb\.me|instagram\.com)$/;

function destinoDoAnuncio(ad: RawAd): { landingUrl: string | null; landingUrlNorm: string | null; domain: string | null } {
  const landingUrl = ad.landingUrl ?? null;
  const alvo = landingUrl ?? ad.adUrl ?? null;
  const domain = alvo ? domainOf(alvo) : null;
  return {
    landingUrl,
    landingUrlNorm: landingUrl ? normalizeUrl(landingUrl) : null,
    domain: domain !== null && HOSTS_DA_META.test(domain) ? null : domain,
  };
}

/** Traduz o anúncio da fonte para o candidato; ausentes viram unknown_fields. */
export function toCandidate(ad: RawAd, source: string, keyword: string, jobId: string): NewCandidate {
  const destino = destinoDoAnuncio(ad);
  const unknownFields = CAMPOS_ESPERADOS.filter((campo) => ad[campo] === null || ad[campo] === undefined);
  return {
    source,
    externalId: ad.externalId,
    country: ad.country ?? null,
    advertiser: ad.advertiser ?? null,
    domain: destino.domain,
    adUrl: ad.adUrl ?? null,
    landingUrl: destino.landingUrl,
    landingUrlNorm: destino.landingUrlNorm,
    startedAt: dataCurta(ad.startedAt),
    keywords: [keyword],
    raw: { ...ad },
    unknownFields: [...unknownFields],
    jobId,
  };
}

/**
 * Coleta por palavra-chave, continuando do cursor salvo. Salva o cursor depois de cada
 * página processada; assim uma execução interrompida não recomeça do zero.
 * Devolve os contadores por palavra-chave.
 */
export async function collect(
  store: CollectStore, source: AdSource, opts: CollectOptions,
): Promise<Record<string, CollectCounters>> {
  const porPalavra: Record<string, CollectCounters> = {};
  let falhas = 0;
  let ultimaFalha: unknown = null;

  for (const keyword of opts.keywords) {
    if (opts.cancelado?.()) break;
    const conta: CollectCounters = { vistos: 0, novos: 0, duplicados: 0, incompletos: 0 };
    if (source.nicheScan) {
      // Uma sessão por nicho; cursor não existe nesta ferramenta.
      // Nicho que falha vira aviso e o Radar segue com os outros (teste real 21/11: um nicho derrubava tudo).
      // Limite de uso para na hora: os próximos nichos bateriam no mesmo limite.
      let scan: Awaited<ReturnType<NonNullable<AdSource['nicheScan']>>>;
      try {
        scan = await source.nicheScan(keyword);
      } catch (err) {
        if (err instanceof QuotaError) throw err;
        falhas++;
        ultimaFalha = err;
        opts.onAviso?.(`${keyword}: a busca falhou (${(err as Error).message.slice(0, 200)})`);
        porPalavra[keyword] = conta;
        continue;
      }
      const { ads, observacoes } = scan;
      for (const o of observacoes) opts.onAviso?.(`${keyword}: ${o}`);
      for (const ad of ads) {
        const novo = toCandidate(ad, source.name, keyword, opts.jobId);
        const { created } = await store.upsertCandidate(novo);
        conta.vistos++;
        if (created) conta.novos++; else conta.duplicados++;
        if (novo.unknownFields?.length) conta.incompletos++;
      }
      porPalavra[keyword] = conta;
      continue;
    }
    let cursor = await store.getCursor(opts.jobId, keyword, source.name);
    let paginas = 0;

    while (paginas < opts.maxPages && conta.vistos < opts.maxPerKeyword) {
      const limite = opts.maxPerKeyword - conta.vistos;
      const { ads, nextCursor } = await source.search(keyword, cursor, limite);
      paginas++;

      for (const ad of ads) {
        const novo = toCandidate(ad, source.name, keyword, opts.jobId);
        const { created } = await store.upsertCandidate(novo);
        conta.vistos++;
        if (created) conta.novos++;
        else conta.duplicados++;
        if (novo.unknownFields && novo.unknownFields.length > 0) conta.incompletos++;
      }

      cursor = nextCursor;
      await store.setCursor(opts.jobId, keyword, source.name, cursor);
      // Página vazia encerra: sem isso, uma fonte que devolve cursor sem anúncios prenderia o laço.
      if (ads.length === 0 || cursor === null) break;
    }

    porPalavra[keyword] = conta;
  }

  // Todos os nichos falharam: o Radar falha com o motivo, em vez de dizer "0 ofertas".
  if (falhas > 0 && falhas === opts.keywords.length) throw ultimaFalha;
  return porPalavra;
}
