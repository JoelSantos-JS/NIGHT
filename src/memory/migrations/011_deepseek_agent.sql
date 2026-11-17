-- DeepSeek como executor de código (D12/H01). Os CHECKs da 001 só aceitavam claude/codex.
-- O nome é o que o Postgres gerou para cada CHECK de coluna; trocar mantém as linhas antigas.
ALTER TABLE tasks
  DROP CONSTRAINT tasks_primary_agent_check,
  DROP CONSTRAINT tasks_review_agent_check,
  ADD CONSTRAINT tasks_primary_agent_check CHECK (primary_agent IN ('claude', 'codex', 'deepseek')),
  ADD CONSTRAINT tasks_review_agent_check CHECK (review_agent IN ('claude', 'codex', 'deepseek'));
