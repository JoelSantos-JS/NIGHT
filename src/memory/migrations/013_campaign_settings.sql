-- Regras do teste de criativo de cada oferta (pixel, página, público, início, vídeos), ao lado dos links.
-- O Joel define; o rascunho da campanha lê daqui. Vazio = padrão do NIGHT (pendências mostram o que falta).
ALTER TABLE offer_links ADD COLUMN campanha jsonb NOT NULL DEFAULT '{}';
