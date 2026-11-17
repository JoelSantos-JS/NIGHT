-- Base do Radar de Ofertas (R02/R03): cursores de coleta, candidatos, ofertas e conversa.
-- O pedido e o estado do trabalho ficam em jobs (kind = 'radar'); não há radar_jobs.
-- job_id amarra a coleta ao trabalho que a fez; sem ele, o dado continua válido.

CREATE TABLE radar_cursors (
  job_id     text NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  keyword    text NOT NULL,
  source     text NOT NULL,
  -- Último ponto de coleta; null = começar do início.
  cursor     text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id, keyword, source)
);

CREATE TABLE radar_candidates (
  id               text PRIMARY KEY,
  source           text NOT NULL,
  external_id      text NOT NULL,
  country          text,
  advertiser       text,
  domain           text,
  ad_url           text,
  landing_url      text,
  landing_url_norm text,
  first_seen_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  -- Início do anúncio na fonte; só a data, porque a hora não é confiável.
  started_at       date,
  keywords         text[] NOT NULL DEFAULT '{}',
  raw              jsonb NOT NULL,
  -- Campos que a fonte não mostrou: ausente não vira zero nem palpite.
  unknown_fields   text[] NOT NULL DEFAULT '{}',
  score            jsonb,
  job_id           text REFERENCES jobs (id) ON DELETE SET NULL,
  -- O mesmo anúncio da mesma fonte não entra duas vezes.
  UNIQUE (source, external_id)
);
-- Dedup por página de destino (ignora rastreio) e agrupamento por domínio.
CREATE INDEX radar_candidates_landing ON radar_candidates (landing_url_norm);
CREATE INDEX radar_candidates_domain ON radar_candidates (domain);

CREATE TABLE radar_offers (
  id           text PRIMARY KEY,
  candidate_id text REFERENCES radar_candidates (id),
  -- Número que o Joel fala ("oferta 2"); cada revisão mantém o número e sobe a versão.
  number       integer NOT NULL,
  version      integer NOT NULL,
  status       text NOT NULL CHECK (status IN ('rascunho', 'discutindo', 'aprovada', 'rejeitada')),
  proposal     jsonb NOT NULL,
  sources      jsonb NOT NULL DEFAULT '[]',
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- Versões antigas ficam guardadas: a mesma oferta pode ter várias linhas.
  -- O índice de (number, version) já serve para achar a versão mais nova.
  UNIQUE (number, version)
);

CREATE TABLE radar_feedback (
  id                text PRIMARY KEY,
  offer_number      integer NOT NULL,
  offer_version     integer NOT NULL,
  at                timestamptz NOT NULL DEFAULT clock_timestamp(),
  kind              text NOT NULL CHECK (kind IN ('pergunta', 'objecao', 'correcao', 'aprovacao', 'rejeicao')),
  -- "text" entre aspas por ser nome de tipo; o campo guarda a fala do Joel.
  "text"            text NOT NULL,
  -- Versão criada por causa deste retorno; null quando nada mudou.
  resulting_version integer
);
CREATE INDEX radar_feedback_offer ON radar_feedback (offer_number, offer_version, at);
