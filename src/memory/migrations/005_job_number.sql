-- Número falável por tipo de trabalho ("vídeo 3", "oferta 2"): F06.
ALTER TABLE jobs ADD COLUMN number integer;

-- Preenche os trabalhos que já existem em ordem de criação dentro de cada tipo.
UPDATE jobs SET number = numbered.position
FROM (
  SELECT id, row_number() OVER (PARTITION BY kind ORDER BY created_at, id) AS position
  FROM jobs
) AS numbered
WHERE jobs.id = numbered.id;

ALTER TABLE jobs ALTER COLUMN number SET NOT NULL;
-- Dois trabalhos do mesmo tipo nunca têm o mesmo número.
ALTER TABLE jobs ADD CONSTRAINT jobs_kind_number_unique UNIQUE (kind, number);
