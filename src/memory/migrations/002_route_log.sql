-- O roteador grava modelo, motivo e uso de cota premium de cada pedido (blueprint §5, fim).
CREATE TABLE route_log (
  id            text PRIMARY KEY,
  at            timestamptz NOT NULL DEFAULT clock_timestamp(),
  language      text NOT NULL,
  text          text NOT NULL,
  intent        text NOT NULL,
  model         text NOT NULL,
  reason        text NOT NULL,
  used_premium  boolean NOT NULL,
  task_id       text REFERENCES tasks (id) ON DELETE SET NULL
);
CREATE INDEX route_log_at ON route_log (at DESC);
