-- Corrida na importação de cartão (revisão do Codex): duas importações simultâneas do mesmo
-- cartão podiam não ver uma à outra e criar duas tarefas para o mesmo contrato aprovado.
-- O índice único parcial deixa o banco decidir: só uma tarefa aberta por (projeto, cartão, revisão).
-- Tarefa terminada não conta, porque reimportar depois de aceita/descartada pode ser legítimo.

CREATE UNIQUE INDEX tasks_card_open ON tasks (project_id, card_id, card_revision)
  WHERE card_id IS NOT NULL AND status NOT IN ('accepted', 'rejected', 'failed', 'cancelled');
