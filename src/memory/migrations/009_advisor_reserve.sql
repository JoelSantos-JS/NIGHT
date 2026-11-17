-- Reserva atômica da consulta (achado da revisão): duas consultas iguais simultâneas
-- não podem ler o cache vazio e disparar duas chamadas pagas ao DeepSeek.
-- A linha nasce 'pendente' antes da API e vira 'concluida' ao terminar; as antigas
-- continuam 'concluida' pelo padrão.
ALTER TABLE advisor_opinions
  ADD COLUMN status text NOT NULL DEFAULT 'concluida'
    CHECK (status IN ('pendente', 'concluida')),
  -- Enquanto a reserva está pendente ainda não há modelo nem parecer.
  ALTER COLUMN model DROP NOT NULL;

-- Achar a reserva pendente do ponto sem varrer a tabela.
CREATE INDEX advisor_opinions_pendente
  ON advisor_opinions (job_id, point_id, input_hash)
  WHERE status = 'pendente';

