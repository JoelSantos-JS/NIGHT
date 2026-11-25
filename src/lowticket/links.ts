// Links de uma oferta que só o Joel sabe: onde publicou a página, o checkout e as imagens dos criativos.
// Ficam fora da proposta aprovada porque mudam sem mudar a oferta (tabela offer_links, migração 012).

import pg from 'pg';
import { DEFAULT_DATABASE_URL, migrate } from '../memory/pg-memory.ts';
import type { CampaignSettings } from '../ads/campaign.ts';

export interface OfferLinks {
  offerNumber: number;
  paginaUrl: string | null;
  checkoutUrl: string | null;
  imagens: string[];
  /** Regras do teste de criativo (pixel, página, público, início, vídeos); vazio = padrão. */
  campanha: Partial<CampaignSettings>;
}

export type LinkField = 'pagina' | 'checkout' | 'imagens';

/** Só https: link http ou malformado nunca vai para página de vendas nem para anúncio. */
export function httpsOrThrow(url: string): string {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    throw new Error(`link inválido: ${url.slice(0, 80)}`);
  }
  if (u.protocol !== 'https:') throw new Error(`o link precisa começar com https: ${url.slice(0, 80)}`);
  return u.toString();
}

export interface OfferLinksStore {
  get(offerNumber: number): Promise<OfferLinks>;
  set(offerNumber: number, field: LinkField, value: string | string[]): Promise<OfferLinks>;
  /** Grava as regras da campanha (substitui as anteriores). Vídeos e miniaturas só https. */
  setCampanha(offerNumber: number, campanha: Partial<CampaignSettings>): Promise<OfferLinks>;
}

export class PgOfferLinks implements OfferLinksStore {
  private constructor(private readonly pool: pg.Pool) {}

  static async open(connectionString = process.env.NIGHT_DATABASE_URL ?? DEFAULT_DATABASE_URL): Promise<PgOfferLinks> {
    const pool = new pg.Pool({ connectionString, max: 2 });
    await migrate(pool);
    return new PgOfferLinks(pool);
  }

  async get(offerNumber: number): Promise<OfferLinks> {
    const { rows } = await this.pool.query('SELECT * FROM offer_links WHERE offer_number = $1', [offerNumber]);
    const r = rows[0];
    return {
      offerNumber, paginaUrl: r?.pagina_url ?? null, checkoutUrl: r?.checkout_url ?? null, imagens: r?.imagens ?? [],
      campanha: r?.campanha ?? {},
    };
  }

  async set(offerNumber: number, field: LinkField, value: string | string[]): Promise<OfferLinks> {
    const coluna = { pagina: 'pagina_url', checkout: 'checkout_url', imagens: 'imagens' }[field];
    const valor = field === 'imagens'
      ? (Array.isArray(value) ? value : [value]).map(httpsOrThrow)
      : httpsOrThrow(Array.isArray(value) ? value[0] ?? '' : value);
    await this.pool.query(
      `INSERT INTO offer_links (offer_number, ${coluna}) VALUES ($1, $2)
       ON CONFLICT (offer_number) DO UPDATE SET ${coluna} = EXCLUDED.${coluna}, updated_at = now()`,
      [offerNumber, valor],
    );
    return this.get(offerNumber);
  }

  async setCampanha(offerNumber: number, campanha: Partial<CampaignSettings>): Promise<OfferLinks> {
    const valor = {
      ...campanha,
      ...(campanha.videos ? { videos: campanha.videos.map((v) => ({ url: httpsOrThrow(v.url), miniatura: httpsOrThrow(v.miniatura) })) } : {}),
    };
    await this.pool.query(
      `INSERT INTO offer_links (offer_number, campanha) VALUES ($1, $2)
       ON CONFLICT (offer_number) DO UPDATE SET campanha = EXCLUDED.campanha, updated_at = now()`,
      [offerNumber, JSON.stringify(valor)],
    );
    return this.get(offerNumber);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
