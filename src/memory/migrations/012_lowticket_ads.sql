-- Produto low-ticket e campanha na Meta (seções L e M do plano mestre).
-- Dois tipos novos de trabalho: 'lowticket' (PDFs + página de vendas) e 'campanha' (montagem pausada na Meta).
ALTER TABLE jobs DROP CONSTRAINT jobs_kind_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_kind_check CHECK (kind IN ('coding', 'radar', 'video', 'lowticket', 'campanha'));

-- Links que só o Joel sabe (onde publicou a página, o checkout e as imagens), por número de oferta.
-- Ficam fora da proposta porque mudam sem mudar a oferta aprovada.
CREATE TABLE offer_links (
  offer_number integer PRIMARY KEY,
  pagina_url   text,
  checkout_url text,
  imagens      text[] NOT NULL DEFAULT '{}',
  updated_at   timestamptz NOT NULL DEFAULT now()
);
