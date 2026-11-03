-- Guarda o que foi respondido, para os agentes saberem o que os outros já disseram.
ALTER TABLE route_log ADD COLUMN reply text;
