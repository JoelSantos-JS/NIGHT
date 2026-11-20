// Estado durável do Radar de Ofertas (R02/R03) em PostgreSQL.
// Mesmo desenho de PgAdvisorJournal/PgMemory: pool próprio, migrate no open e close.
// Candidato e oferta guardam o que veio da fonte; ausente fica null/unknown, nunca vira palpite.
// Oferta mantém todas as versões: cada revisão é uma linha nova com o mesmo número.

import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { DEFAULT_DATABASE_URL, migrate } from '../memory/pg-memory.ts';
import { acimaDoCorte, type ScoreResultado } from './score.ts';

/** Trava só das ofertas: número novo e revisão não podem colidir. */
const OFFER_LOCK = 0x5241444f;

type Row = Record<string, any>;

/** Leitura do candidato com a data de início como texto, sem fuso atrapalhar o dia. */
const CANDIDATE_COLS = `id, source, external_id, country, advertiser, domain, ad_url, landing_url,
  landing_url_norm, first_seen_at, last_seen_at, started_at::text AS started_at, keywords, raw,
  unknown_fields, score, job_id`;

export type OfferStatus = 'rascunho' | 'discutindo' | 'aprovada' | 'rejeitada';

export type FeedbackKind = 'pergunta' | 'objecao' | 'correcao' | 'aprovacao' | 'rejeicao';

export interface RadarCandidate {
  id: string;
  source: string;
  externalId: string;
  country: string | null;
  advertiser: string | null;
  domain: string | null;
  adUrl: string | null;
  landingUrl: string | null;
  /** landingUrl normalizada; null quando a fonte não trouxe destino. */
  landingUrlNorm: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  /** ISO sem hora (YYYY-MM-DD) ou null quando a fonte não informou. */
  startedAt: string | null;
  keywords: string[];
  raw: Record<string, unknown>;
  /** Campos que a fonte não mostrou nesta coleta. */
  unknownFields: string[];
  score: ScoreResultado | null;
  jobId: string | null;
}

/** O que a coleta manda gravar; id e horários são do banco. */
export interface NewCandidate {
  source: string;
  externalId: string;
  country?: string | null;
  advertiser?: string | null;
  domain?: string | null;
  adUrl?: string | null;
  landingUrl?: string | null;
  landingUrlNorm?: string | null;
  startedAt?: string | null;
  keywords?: string[];
  raw: Record<string, unknown>;
  unknownFields?: string[];
  jobId?: string | null;
}

export interface RadarOffer {
  id: string;
  candidateId: string | null;
  number: number;
  version: number;
  status: OfferStatus;
  proposal: Record<string, unknown>;
  sources: unknown[];
  createdAt: string;
}

export interface NewFeedback {
  offerNumber: number;
  offerVersion: number;
  kind: FeedbackKind;
  text: string;
  resultingVersion?: number | null;
}

export interface RadarFeedback {
  id: string;
  offerNumber: number;
  offerVersion: number;
  at: string;
  kind: FeedbackKind;
  text: string;
  resultingVersion: number | null;
}

/**
 * Contagem de uma janela (R08). "Vistos" é o candidato com última observação na janela;
 * "duplicados" é o que já existia antes e foi visto de novo. A nota é a de triagem, não prova de venda.
 */
export interface RadarWeeklyCounts {
  candidatosVistos: number;
  novos: number;
  duplicados: number;
  incompletos: number;
  acimaDoCorte: number;
  propostasCriadas: number;
  discutidas: number;
  aceitas: number;
  rejeitadas: number;
}

const toCandidate = (r: Row): RadarCandidate => ({
  id: r.id,
  source: r.source,
  externalId: r.external_id,
  country: r.country,
  advertiser: r.advertiser,
  domain: r.domain,
  adUrl: r.ad_url,
  landingUrl: r.landing_url,
  landingUrlNorm: r.landing_url_norm,
  firstSeenAt: new Date(r.first_seen_at).toISOString(),
  lastSeenAt: new Date(r.last_seen_at).toISOString(),
  startedAt: r.started_at ?? null,
  keywords: r.keywords,
  raw: r.raw,
  unknownFields: r.unknown_fields,
  score: r.score ?? null,
  jobId: r.job_id,
});

const toOffer = (r: Row): RadarOffer => ({
  id: r.id,
  candidateId: r.candidate_id,
  number: r.number,
  version: r.version,
  status: r.status,
  proposal: r.proposal,
  sources: r.sources,
  createdAt: new Date(r.created_at).toISOString(),
});

const toFeedback = (r: Row): RadarFeedback => ({
  id: r.id,
  offerNumber: r.offer_number,
  offerVersion: r.offer_version,
  at: new Date(r.at).toISOString(),
  kind: r.kind,
  text: r.text,
  resultingVersion: r.resulting_version,
});

export class PgRadarStore {
  private constructor(private readonly pool: pg.Pool) {}

  /** Conecta e aplica as migrações pendentes, como PgMemory.open. */
  static async open(connectionString = process.env.NIGHT_DATABASE_URL ?? DEFAULT_DATABASE_URL): Promise<PgRadarStore> {
    const pool = new pg.Pool({ connectionString, max: 5 });
    try {
      await migrate(pool);
    } catch (err) {
      await pool.end();
      throw err;
    }
    return new PgRadarStore(pool);
  }

  private async tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  // ---------- Candidatos ----------

  /**
   * Deduplica por (source, external_id); se não achar, tenta o destino normalizado,
   * porque o mesmo anúncio pode aparecer com outro ID e os mesmos UTM.
   * Campo já conhecido nunca é apagado por null/undefined; keywords só crescem.
   */
  async upsertCandidate(c: NewCandidate): Promise<{ candidate: RadarCandidate; created: boolean }> {
    return this.tx(async (client) => {
      let row: Row | undefined = (await client.query(
        `SELECT ${CANDIDATE_COLS} FROM radar_candidates
         WHERE source = $1 AND external_id = $2 FOR UPDATE`,
        [c.source, c.externalId],
      )).rows[0];
      let aliasNovo = false;

      if (!row && c.landingUrlNorm) {
        row = (await client.query(
          `SELECT ${CANDIDATE_COLS} FROM radar_candidates
           WHERE source = $1 AND landing_url_norm = $2
           ORDER BY first_seen_at LIMIT 1 FOR UPDATE`,
          [c.source, c.landingUrlNorm],
        )).rows[0];
        aliasNovo = !!row;
      }

      if (!row) {
        // Primeira observação: o contador começa em 1 e o horário marca a revisão.
        const rawInicial = {
          ...c.raw,
          observacoes: 1,
          ultimaObservacao: new Date().toISOString(),
        };
        const { rows } = await client.query(
          `INSERT INTO radar_candidates
             (id, source, external_id, country, advertiser, domain, ad_url, landing_url,
              landing_url_norm, started_at, keywords, raw, unknown_fields, job_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
           RETURNING ${CANDIDATE_COLS}`,
          [
            randomUUID(), c.source, c.externalId, c.country ?? null, c.advertiser ?? null,
            c.domain ?? null, c.adUrl ?? null, c.landingUrl ?? null, c.landingUrlNorm ?? null,
            c.startedAt ?? null, c.keywords ?? [], rawInicial, c.unknownFields ?? [], c.jobId ?? null,
          ],
        );
        return { candidate: toCandidate(rows[0]!), created: true };
      }

      // O raw é o retrato da última observação: valor novo conhecido substitui o antigo,
      // mas ausente/null nunca apaga o que já sabíamos (ex.: activeAdsInDomain, preço).
      const rawAntigo: Record<string, any> = { ...(row.raw ?? {}) };
      const rawNovo: Record<string, unknown> = c.raw ?? {};
      const raw: Record<string, any> = { ...rawAntigo };
      for (const [campo, valor] of Object.entries(rawNovo)) {
        if (valor !== null && valor !== undefined) raw[campo] = valor;
      }
      // Aliases são união: o que já existia + o ID novo (dedup por destino) + os da observação.
      const aliases = new Set<string>();
      for (const a of Array.isArray(rawAntigo.aliases) ? rawAntigo.aliases : []) aliases.add(String(a));
      for (const a of Array.isArray(rawNovo.aliases) ? rawNovo.aliases : []) aliases.add(String(a));
      if (aliasNovo) aliases.add(c.externalId);
      if (aliasNovo || aliases.size > 0) raw.aliases = [...aliases];
      const anteriores = Number.isInteger(rawAntigo.observacoes) ? rawAntigo.observacoes : 0;
      raw.observacoes = anteriores + 1;
      raw.ultimaObservacao = new Date().toISOString();

      const keywords = [...new Set([...(row.keywords ?? []), ...(c.keywords ?? [])])];

      const { rows } = await client.query(
        `UPDATE radar_candidates SET
           country          = COALESCE($2, country),
           advertiser       = COALESCE($3, advertiser),
           domain           = COALESCE($4, domain),
           ad_url           = COALESCE($5, ad_url),
           landing_url      = COALESCE($6, landing_url),
           landing_url_norm = COALESCE($7, landing_url_norm),
           started_at       = COALESCE($8, started_at),
           keywords         = $9,
           raw              = $10,
           unknown_fields   = $11,
           job_id           = COALESCE($12, job_id),
           -- Visto de novo com números novos (ativos da página, anunciantes): a nota velha não vale mais.
           -- Recalcular é código puro, sem modelo.
           score            = NULL,
           last_seen_at     = now()
         WHERE id = $1
         RETURNING ${CANDIDATE_COLS}`,
        [
          row.id, c.country ?? null, c.advertiser ?? null, c.domain ?? null, c.adUrl ?? null,
          c.landingUrl ?? null, c.landingUrlNorm ?? null, c.startedAt ?? null, keywords, raw,
          c.unknownFields ?? [], c.jobId ?? null,
        ],
      );
      return { candidate: toCandidate(rows[0]!), created: false };
    });
  }

  async getCandidate(id: string): Promise<RadarCandidate | null> {
    const { rows } = await this.pool.query(
      `SELECT ${CANDIDATE_COLS} FROM radar_candidates WHERE id = $1`, [id],
    );
    return rows[0] ? toCandidate(rows[0]) : null;
  }

  /** Total de candidatos: útil para provar que a segunda coleta não duplicou nada. */
  async countCandidates(): Promise<number> {
    const { rows } = await this.pool.query('SELECT count(*)::int AS n FROM radar_candidates');
    return rows[0]?.n ?? 0;
  }

  async setScore(candidateId: string, score: ScoreResultado | null): Promise<void> {
    const r = await this.pool.query('UPDATE radar_candidates SET score = $2 WHERE id = $1', [candidateId, score]);
    if (r.rowCount === 0) throw new Error(`candidato ${candidateId} não existe`);
  }

  // ---------- Cursores ----------

  async getCursor(jobId: string, keyword: string, source: string): Promise<string | null> {
    const { rows } = await this.pool.query(
      'SELECT cursor FROM radar_cursors WHERE job_id = $1 AND keyword = $2 AND source = $3',
      [jobId, keyword, source],
    );
    return rows[0]?.cursor ?? null;
  }

  async setCursor(jobId: string, keyword: string, source: string, cursor: string | null): Promise<void> {
    await this.pool.query(
      `INSERT INTO radar_cursors (job_id, keyword, source, cursor, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (job_id, keyword, source)
       DO UPDATE SET cursor = EXCLUDED.cursor, updated_at = now()`,
      [jobId, keyword, source, cursor],
    );
  }

  // ---------- Ofertas ----------

  /** Número novo = maior + 1, com trava para dois pedidos simultâneos não repetirem. */
  async createOffer(
    candidateId: string | null, proposal: Record<string, unknown>, sources: unknown[] = [],
  ): Promise<RadarOffer> {
    return this.tx(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock($1)', [OFFER_LOCK]);
      const { rows: max } = await client.query('SELECT COALESCE(MAX(number), 0) + 1 AS n FROM radar_offers');
      const { rows } = await client.query(
        `INSERT INTO radar_offers (id, candidate_id, number, version, status, proposal, sources)
         VALUES ($1, $2, $3, 1, 'rascunho', $4, $5) RETURNING *`,
        // sources é jsonb: array JS viraria array do Postgres, então serializa como JSON.
        [randomUUID(), candidateId, max[0]!.n, proposal, JSON.stringify(sources)],
      );
      return toOffer(rows[0]!);
    });
  }

  /** Nova linha com version+1 e mesmo número; a versão anterior continua intacta. */
  async reviseOffer(
    number: number, proposal: Record<string, unknown>, sources: unknown[] = [],
  ): Promise<RadarOffer> {
    return this.tx(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock($1)', [OFFER_LOCK]);
      const atual = (await client.query(
        'SELECT * FROM radar_offers WHERE number = $1 ORDER BY version DESC LIMIT 1', [number],
      )).rows[0];
      if (!atual) throw new Error(`oferta ${number} não existe`);
      const { rows } = await client.query(
        `INSERT INTO radar_offers (id, candidate_id, number, version, status, proposal, sources)
         VALUES ($1, $2, $3, $4, 'rascunho', $5, $6) RETURNING *`,
        [randomUUID(), atual.candidate_id, number, atual.version + 1, proposal, JSON.stringify(sources)],
      );
      return toOffer(rows[0]!);
    });
  }

  /** Sem versão, devolve a mais nova; com versão, exatamente aquela. */
  async getOffer(number: number, version?: number): Promise<RadarOffer | null> {
    const { rows } = version === undefined
      ? await this.pool.query(
        'SELECT * FROM radar_offers WHERE number = $1 ORDER BY version DESC LIMIT 1', [number],
      )
      : await this.pool.query(
        'SELECT * FROM radar_offers WHERE number = $1 AND version = $2', [number, version],
      );
    return rows[0] ? toOffer(rows[0]) : null;
  }

  /** A versão mais nova de cada oferta, em ordem de número (para o painel). */
  async listLatestOffers(): Promise<RadarOffer[]> {
    const { rows } = await this.pool.query(
      'SELECT DISTINCT ON (number) * FROM radar_offers ORDER BY number, version DESC',
    );
    return rows.map(toOffer);
  }

  async listOfferVersions(number: number): Promise<RadarOffer[]> {
    const { rows } = await this.pool.query(
      'SELECT * FROM radar_offers WHERE number = $1 ORDER BY version', [number],
    );
    return rows.map(toOffer);
  }

  async setOfferStatus(number: number, version: number, status: OfferStatus): Promise<void> {
    const r = await this.pool.query(
      'UPDATE radar_offers SET status = $3 WHERE number = $1 AND version = $2',
      [number, version, status],
    );
    if (r.rowCount === 0) throw new Error(`oferta ${number} versão ${version} não existe`);
  }

  // ---------- Conversa ----------

  async addFeedback(f: NewFeedback): Promise<RadarFeedback> {
    const { rows } = await this.pool.query(
      `INSERT INTO radar_feedback (id, offer_number, offer_version, kind, "text", resulting_version)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [randomUUID(), f.offerNumber, f.offerVersion, f.kind, f.text, f.resultingVersion ?? null],
    );
    return toFeedback(rows[0]!);
  }

  async listFeedback(offerNumber: number): Promise<RadarFeedback[]> {
    const { rows } = await this.pool.query(
      'SELECT * FROM radar_feedback WHERE offer_number = $1 ORDER BY at, id', [offerNumber],
    );
    return rows.map(toFeedback);
  }

  // ---------- Medição (R08) ----------

  /**
   * Contadores da janela [from, to). Novos = primeira observação na janela; duplicados = candidato
   * que já existia e voltou a ser visto; acimaDoCorte usa a regra da triagem.
   * Discussão e decisão vêm do radar_feedback: aceitar/rejeitar são feedbacks, não status de anúncio.
   */
  async radarWeeklyCounts(from: string | Date, to: string | Date): Promise<RadarWeeklyCounts> {
    const { rows } = await this.pool.query(
      `SELECT
         (SELECT count(*)::int FROM radar_candidates
           WHERE last_seen_at >= $1 AND last_seen_at < $2) AS candidatos_vistos,
         (SELECT count(*)::int FROM radar_candidates
           WHERE first_seen_at >= $1 AND first_seen_at < $2) AS novos,
         (SELECT count(*)::int FROM radar_candidates
           WHERE first_seen_at < $1 AND last_seen_at >= $1 AND last_seen_at < $2) AS duplicados,
         (SELECT count(*)::int FROM radar_candidates
           WHERE last_seen_at >= $1 AND last_seen_at < $2 AND cardinality(unknown_fields) > 0) AS incompletos,
         (SELECT count(*)::int FROM radar_offers
           WHERE version = 1 AND created_at >= $1 AND created_at < $2) AS propostas_criadas,
         (SELECT count(DISTINCT offer_number)::int FROM radar_feedback
           WHERE at >= $1 AND at < $2) AS discutidas,
         (SELECT count(DISTINCT offer_number)::int FROM radar_feedback
           WHERE at >= $1 AND at < $2 AND kind = 'aprovacao') AS aceitas,
         (SELECT count(DISTINCT offer_number)::int FROM radar_feedback
           WHERE at >= $1 AND at < $2 AND kind = 'rejeicao') AS rejeitadas`,
      [from, to],
    );
    const r = rows[0]!;
    const scores = await this.pool.query(
      'SELECT score FROM radar_candidates WHERE last_seen_at >= $1 AND last_seen_at < $2 AND score IS NOT NULL',
      [from, to],
    );
    return {
      candidatosVistos: r.candidatos_vistos,
      novos: r.novos,
      duplicados: r.duplicados,
      incompletos: r.incompletos,
      acimaDoCorte: scores.rows.filter((row: Row) => acimaDoCorte(row.score as ScoreResultado)).length,
      propostasCriadas: r.propostas_criadas,
      discutidas: r.discutidas,
      aceitas: r.aceitas,
      rejeitadas: r.rejeitadas,
    };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
