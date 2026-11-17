-- Trabalhos (jobs) de qualquer tipo: coding, radar e vídeo (F01/F02).
-- Fica separado de tasks: as tarefas de código continuam com o mesmo significado.
CREATE TABLE jobs (
  id              text PRIMARY KEY,
  kind            text NOT NULL CHECK (kind IN ('coding', 'radar', 'video')),
  -- De onde veio o pedido: 'voz', 'texto', 'rotina'... livre de propósito.
  origin          text NOT NULL,
  -- Mesma chave = mesmo trabalho: impede criar dois pedidos iguais.
  idempotency_key text NOT NULL UNIQUE,
  params          jsonb NOT NULL DEFAULT '{}',
  limits          jsonb NOT NULL DEFAULT '{}',
  status          text NOT NULL CHECK (status IN ('queued', 'running', 'waiting', 'retryable',
                    'succeeded', 'failed', 'cancelled')),
  -- O que falta para sair de 'waiting' (ex.: 'flow'); null quando não espera nada.
  waiting_for     text,
  version         integer NOT NULL DEFAULT 1,
  task_id         text REFERENCES tasks (id) ON DELETE SET NULL,
  artifact_ref    text,
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_kind_status ON jobs (kind, status);

CREATE TABLE job_events (
  id           text PRIMARY KEY,
  job_id       text NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  at           timestamptz NOT NULL DEFAULT clock_timestamp(),
  event_type   text NOT NULL CHECK (event_type IN ('status-changed', 'effect-confirmed', 'progress', 'error')),
  from_status  text,
  to_status    text,
  source       text NOT NULL,
  message      text NOT NULL,
  -- Efeito externo já confirmado: a chave não se repete por trabalho.
  effect_key   text
);
-- Um efeito externo só pode ser registrado uma vez por trabalho.
CREATE UNIQUE INDEX job_events_effect ON job_events (job_id, effect_key) WHERE effect_key IS NOT NULL;
CREATE INDEX job_events_job ON job_events (job_id, at);
