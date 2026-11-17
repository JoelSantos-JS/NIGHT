// Criativos do teste a partir da oferta aprovada (L04, docs/PLANO_MESTRE_NIGHT.md).
// Os 5 ângulos da proposta viram textos de anúncio (um por ângulo) e uma folha de prompts
// para o Joel gerar as imagens no Flow, no mesmo estilo da folha do vídeo (V03).
// Código puro e determinístico: sem rede e sem modelo; a mesma oferta gera a mesma folha.
//
// Regras editoriais: nada de número de ganho, print de pagamento, depoimento inventado,
// "últimas vagas" nem promessa proibida (a mesma lista de src/radar/offer.ts).

import type { ArtifactItem, ArtifactStore } from '../artifacts/store.ts';
import { normalizeForCopyCheck, promessasProibidas, type OfferProposal } from '../radar/offer.ts';

export type FormatoImagem = '1:1' | '4:5' | '9:16';

export interface CreativesOptions {
  /** Assinatura da marca; sem ela, a descrição fala do que vem no material. */
  marca?: string;
  /** Formato da imagem pedido ao Flow; padrão 4:5 (vertical de feed). */
  formato?: FormatoImagem;
}

export interface CreativeSpec {
  n: number;
  /** Ângulo da proposta de origem (é o que liga o criativo à oferta). */
  angulo: string;
  /** Até 40 caracteres: a Meta corta títulos longos. */
  titulo: string;
  /** Gancho do ângulo + problema + promessa verificável. */
  textoPrincipal: string;
  /** Até 30 caracteres. */
  descricao: string;
  cta: 'Saiba mais';
  /** Inglês, descritivo, com o mesmo estilo visual em todos os criativos. */
  promptImagem: string;
}

/**
 * Trecho de estilo repetido em todos os prompts: paleta, luz e proibições iguais.
 * Exportado para o teste conferir que nenhum criativo sai do mesmo visual.
 */
export const ESTILO_PROMPT_IMAGEM =
  'soft natural window light, muted warm palette of cream, deep green and terracotta, shallow depth of field, '
  + "honest documentary mood, no text, no logos, no people's faces identifiable, "
  + 'no before-and-after money scenes, no earnings screenshots';

const FORMATO_PADRAO: FormatoImagem = '4:5';

/** Corta no limite sem partir palavra; o "…" ocupa o último caractere. */
function cortar(texto: string, maximo: number): string {
  const limpo = texto.trim();
  if (limpo.length <= maximo) return limpo;
  const corte = limpo.slice(0, maximo - 1);
  const espaco = corte.lastIndexOf(' ');
  const base = (espaco >= Math.floor(maximo / 2) ? corte.slice(0, espaco) : corte).trimEnd();
  return base + '…';
}

/** Título curto e frase de gancho: primeira frase do ângulo, com ponto final. */
function fraseDoAngulo(angulo: string): string {
  const frase = angulo.split(/[.!?:]/)[0]!.trim() || angulo.trim() || 'Criativo';
  const comPonto = /[.!?]$/.test(frase) ? frase : frase + '.';
  return comPonto.charAt(0).toUpperCase() + comPonto.slice(1);
}

/** Frase terminada em ponto: o texto principal é lido em voz alta pelo anúncio. */
function frase(texto: string): string {
  const limpo = texto.trim();
  if (!limpo) return '';
  return /[.!?]$/.test(limpo) ? limpo : limpo + '.';
}

/**
 * Cena em inglês ligada ao ângulo. Sem modelo aqui, o mapa é curto de propósito:
 * o ângulo que não casar cai na cena padrão da sua posição.
 */
const CENAS_POR_ANGULO: { chave: RegExp; cena: string }[] = [
  {
    chave: /antes|depois|mudanca|virada/,
    cena: 'a tidy desk at dawn, messy notes being set aside while a clean one-page weekly plan stays in the light',
  },
  {
    chave: /erro|falha|armadilha/,
    cena: 'three crumpled sticky notes beside a single clear printed checklist on a wooden table',
  },
  {
    chave: /rotina|dia a dia|semana|real/,
    cena: 'a calm home-office corner with a paper calendar, a pen and a cup of coffee in soft morning light',
  },
  {
    chave: /pergunta|duvida|escolha/,
    cena: 'the hands of an adult writing one short question on a blank notepad beside a closed laptop',
  },
  {
    chave: /prova|resultado|simples|checklist/,
    cena: 'a small stack of printed pages with a plant and a pencil on a clean shelf, no screens',
  },
];

/** Cena neutra por posição, quando nenhuma palavra-chave do ângulo casa. */
const CENAS_PADRAO = [
  'a quiet home desk with a notebook, pen and morning coffee',
  'a close view of hands organizing paper cards on a wooden table',
  'a sunlit kitchen table with a closed laptop and a glass of water',
  'a simple paper checklist pinned above a tidy desk',
  'a shelf with printed pages and a small plant in soft light',
];

/** Público em inglês, para a cena falar com quem o anúncio procura. */
const PUBLICO_EM_INGLES: { chave: RegExp; alvo: string }[] = [
  { chave: /autonom|freela|empreend|negocio proprio/, alvo: 'a Brazilian self-employed professional working from home' },
  { chave: /mae|pai|familia|filho/, alvo: 'a Brazilian parent balancing home and work' },
  { chave: /estudante|concurso|estudo/, alvo: 'a Brazilian adult studying at home' },
  { chave: /casa|home office|remoto/, alvo: 'a Brazilian adult working from home' },
];

function cenaDoAngulo(angulo: string, posicao: number): string {
  const chave = normalizeForCopyCheck(angulo);
  const achada = CENAS_POR_ANGULO.find((item) => item.chave.test(chave));
  return achada?.cena ?? CENAS_PADRAO[(posicao - 1) % CENAS_PADRAO.length]!;
}

function publicoEmIngles(publico: string): string {
  const chave = normalizeForCopyCheck(publico);
  const achado = PUBLICO_EM_INGLES.find((item) => item.chave.test(chave));
  return achado?.alvo ?? 'a Brazilian adult at home';
}

/** Descrição curta: marca quando o Joel informar; senão, o que vem no material (contagem factual). */
function descricaoCurta(offer: OfferProposal, marca: string): string {
  if (marca) return cortar(marca, 30);
  const pdfs = offer.entregaveis.filter((e) => e.formato === 'pdf').length;
  if (pdfs === 0) return 'Material digital';
  return offer.bonus.length > 0 ? pdfs + ' PDFs + bônus' : pdfs + ' PDFs';
}

/**
 * Um criativo por ângulo da proposta. Promessa proibida não aparece no anúncio:
 * quando o texto montado esbarra na lista de promessasProibidas, fica só o problema
 * e o convite para ver o material, sem repetir a promessa.
 */
export function buildCreatives(offer: OfferProposal, opts: CreativesOptions = {}): CreativeSpec[] {
  const formato = opts.formato ?? FORMATO_PADRAO;
  const marca = cortar(opts.marca ?? '', 30);

  return offer.angulosCriativo.map((angulo, i) => {
    const n = i + 1;
    const promessa = frase(offer.promessa);
    const problema = frase(offer.problema);
    const montado = [fraseDoAngulo(angulo), problema, promessa].filter(Boolean).join(' ');
    let textoPrincipal = montado;
    if (promessasProibidas(montado).length > 0) {
      const semPromessa = [problema, 'Veja o que vem no material.'].filter(Boolean).join(' ');
      // Se até o problema carregar termo proibido, fica só o convite neutro.
      textoPrincipal = promessasProibidas(semPromessa).length > 0
        ? 'O material desta oferta está descrito na página. Veja o que vem no material.'
        : semPromessa;
    }

    const promptImagem =
      cenaDoAngulo(angulo, n) + ', for ' + publicoEmIngles(offer.publico) + ', '
      + ESTILO_PROMPT_IMAGEM + ', ' + formato + ' aspect ratio.';

    return {
      n,
      angulo,
      titulo: cortar(fraseDoAngulo(angulo), 40),
      textoPrincipal,
      descricao: descricaoCurta(offer, marca),
      cta: 'Saiba mais',
      promptImagem,
    };
  });
}

/**
 * Folha para o Joel gerar no Flow: instruções curtas no topo e, por criativo, os textos
 * e o prompt em inglês. As imagens voltam publicadas em URL https, na mesma ordem.
 */
export async function writeCreativeSheet(
  store: ArtifactStore,
  jobId: string,
  offerNumber: number,
  specs: CreativeSpec[],
): Promise<ArtifactItem> {
  if (!Number.isInteger(offerNumber) || offerNumber < 1) {
    throw new Error('número da oferta inválido: ' + offerNumber + '; use um inteiro a partir de 1');
  }

  const blocos = specs.map((spec) => [
    '## Criativo ' + spec.n + ' — ' + spec.angulo,
    'Título: ' + spec.titulo,
    'Texto principal: ' + spec.textoPrincipal,
    'Descrição: ' + spec.descricao,
    'CTA: ' + spec.cta,
    'Prompt para o Flow: ' + spec.promptImagem,
  ].join('\n'));

  const conteudo = [
    '# Criativos da oferta ' + offerNumber,
    '',
    'Cada criativo aponta o ângulo da proposta aprovada.',
    'Gere cada imagem no Flow pelo navegador, usando o prompt do criativo, na ordem abaixo.',
    'Publique cada imagem: a campanha só aceita imagem numa URL https.',
    'Depois fale: "as imagens da oferta ' + offerNumber + ' são https://... https://..." na mesma ordem dos criativos.',
    '',
    ...blocos.flatMap((bloco) => [bloco, '']),
  ].join('\n');

  return store.add(jobId, {
    name: 'criativos-oferta-' + offerNumber + '.md',
    data: conteudo,
    origin: 'lowticket',
    kind: 'texto',
  });
}
