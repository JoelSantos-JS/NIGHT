-- Cartão de origem da tarefa (S04): guarda qual cartão aprovado o agente recebeu.
-- A revisão sobe quando o conteúdo muda; o hash prova o conteúdo exato importado.
-- Tarefa nascida de pedido solto continua válida: os três campos ficam null.

ALTER TABLE tasks
  ADD COLUMN card_id       text,
  ADD COLUMN card_revision integer,
  ADD COLUMN card_hash     text;

-- Achar a tarefa de um cartão sem varrer a tabela (reimportação não duplica).
CREATE INDEX tasks_card ON tasks (card_id);
