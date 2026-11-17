-- Diário dos pareceres do DeepSeek (D08/D09): guarda entrada, uso, resultado e papel.
-- job_id fica sem FK de propósito: o mesmo diário serve a job de código, radar ou vídeo.
CREATE TABLE advisor_opinions (
  id                text PRIMARY KEY,
  job_id            text NOT NULL,
  point_id          text NOT NULL,
  -- Hash da entrada: mesma entrada não paga duas vezes a mesma consulta.
  input_hash        text NOT NULL,
  at                timestamptz NOT NULL DEFAULT clock_timestamp(),
  model             text NOT NULL,
  ok                boolean NOT NULL,
  -- Motivo da indisponibilidade; null quando ok = true.
  reason            text,
  opinion           jsonb,
  prompt_tokens     integer,
  completion_tokens integer,
  ms                integer NOT NULL,
  author            text NOT NULL DEFAULT 'deepseek',
  role              text NOT NULL CHECK (role IN ('conselheiro', 'reserva-codex'))
);
-- Busca do cache: trabalho + ponto + entrada; sem isso o job repetido cobraria de novo.
CREATE INDEX advisor_opinions_cache ON advisor_opinions (job_id, point_id, input_hash);
-- Leitura do diário em ordem, para explicar a decisão.
CREATE INDEX advisor_opinions_job_at ON advisor_opinions (job_id, at);
