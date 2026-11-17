// Página de vendas estática do produto low-ticket (L03).
// Um HTML5 só, com CSS inline e sem JavaScript: abre local e no celular.
// Publicar é ação do Joel; esta função nunca inventa link de pagamento.
//
// Proibido de propósito: depoimento, número de vendas, contagem de compradores
// ("X pessoas compraram") e escassez fabricada ("só hoje", "últimas vagas").
// O produto ainda não vendeu, então qualquer número desses seria alegação falsa
// e pressão inventada. A página só descreve a oferta e deixa a decisão com quem lê.

import type { ArtifactItem, ArtifactStore } from '../artifacts/store.ts';
import type { FormatoEntregavel, OfferProposal } from '../radar/offer.ts';

export interface SalesPageOptions {
  /** URL do checkout do Joel; null desabilita o botão em vez de inventar um link. */
  checkoutUrl: string | null;
  marca?: string;
  /** Dias de reembolso mostrados na garantia; padrão 7. */
  garantiaDias?: number;
  /** Cor de destaque em hexadecimal; valor inválido cai no padrão. */
  cor?: string;
}

const COR_PADRAO = '#1f6f5f';
const GARANTIA_PADRAO = 7;

const ROTULO_FORMATO: Record<FormatoEntregavel, string> = {
  pdf: 'PDF',
  video: 'Vídeo',
  audio: 'Áudio',
  planilha: 'Planilha',
  comunidade: 'Comunidade',
  outro: 'Material',
};

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Todo texto da oferta passa por aqui: nada de HTML cru na página. */
function escapar(texto: string): string {
  return texto.replace(/[&<>"']/g, (caractere) => ESCAPES[caractere]!);
}

/**
 * Aceita só https:// válido. A página é publicada pelo Joel: um link http:// ou
 * quebrado mandaria a compra para o lugar errado, então é melhor falhar cedo.
 */
function validarCheckout(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`checkout inválido: use uma URL https:// válida (recebido: ${url})`);
  }
  if (parsed.protocol !== 'https:' || !parsed.hostname) {
    throw new Error(`checkout inválido: use uma URL https:// válida (recebido: ${url})`);
  }
  return url;
}

/** Preço no formato brasileiro: R$ 19,90 (com espaço e vírgula). */
function formatarPreco(valor: number): string {
  const [inteiro = '0', centavos = '00'] = valor.toFixed(2).split('.');
  const comMilhar = inteiro.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `R$ ${comMilhar},${centavos}`;
}

/** Marcas de acento que o NFD separa da letra (faixa U+0300..U+036F). */
const MARCAS_DE_ACENTO = new RegExp(
  '[' + String.fromCharCode(0x300) + '-' + String.fromCharCode(0x36f) + ']',
  'g',
);

function normalizarRotulo(texto: string): string {
  return texto.normalize('NFD').replace(MARCAS_DE_ACENTO, '').toLowerCase();
}

type SecaoKey =
  | 'publico' | 'problema' | 'solucao' | 'entregaveis'
  | 'preco' | 'garantia' | 'faq' | 'chamada';

type RotuloSecao = SecaoKey | 'titulo';

/** Ordem padrão usada para completar as seções que a oferta não nomear. */
const ORDEM_PADRAO: SecaoKey[] = [
  'publico', 'problema', 'solucao', 'entregaveis', 'preco', 'garantia', 'faq', 'chamada',
];

const RANK = new Map<SecaoKey, number>(
  ORDEM_PADRAO.map((key, index) => [key, index] as const),
);

/** Casa o rótulo livre de paginaDeVendas com uma seção que sabemos montar. */
function secaoDoRotulo(rotulo: string): RotuloSecao | null {
  const texto = normalizarRotulo(rotulo);
  if (/promessa|titulo|headline|abertura|hero/.test(texto)) return 'titulo';
  if (/publico|para quem|quem e/.test(texto)) return 'publico';
  if (/problema|\bdor\b|obstaculo/.test(texto)) return 'problema';
  if (/solucao|diferencial|como funciona|oferec/.test(texto)) return 'solucao';
  if (/entreg|recebe|conteudo|material|bonus/.test(texto)) return 'entregaveis';
  if (/preco|valor|investimento/.test(texto)) return 'preco';
  if (/garantia|reembolso|risco/.test(texto)) return 'garantia';
  if (/duvida|pergunta|faq|objecao/.test(texto)) return 'faq';
  if (/chamada|final|cta|convite|ultimo passo/.test(texto)) return 'chamada';
  return null;
}

/**
 * Segue a ordem pedida pela oferta e insere as seções que faltam na posição
 * canônica mais próxima, sem reordenar o que a oferta já pediu.
 */
function ordemDasSecoes(rotulos: string[]): SecaoKey[] {
  const ordem: SecaoKey[] = [];
  for (const rotulo of rotulos) {
    const key = secaoDoRotulo(rotulo);
    if (key !== null && key !== 'titulo' && !ordem.includes(key)) ordem.push(key);
  }
  for (const key of ORDEM_PADRAO) {
    if (ordem.includes(key)) continue;
    const posicao = ordem.findIndex((outra) => (RANK.get(outra) ?? 0) > (RANK.get(key) ?? 0));
    if (posicao === -1) ordem.push(key);
    else ordem.splice(posicao, 0, key);
  }
  return ordem;
}

function secao(id: string, titulo: string, corpo: string, classe?: string): string {
  const attr = classe ? ` class="${classe}"` : '';
  return `<section id="${id}"${attr}>\n<h2>${escapar(titulo)}</h2>\n${corpo}\n</section>`;
}

function abertura(offer: OfferProposal, marca: string): string {
  const promessa = offer.promessa.trim() || offer.nome;
  return [
    '<header class="abertura">',
    `<p class="marca">${escapar(marca)}</p>`,
    `<h1>${escapar(promessa)}</h1>`,
    `<p class="produto">${escapar(offer.nome)}</p>`,
    '<a class="link-ancora" href="#preco">Ver preço e o que você recebe</a>',
    '</header>',
  ].join('\n');
}

function corpoEntregaveis(offer: OfferProposal): string {
  const itens = offer.entregaveis.map((item) => [
    '<li class="entregavel">',
    `<h3>${escapar(item.titulo)} <span class="formato">${ROTULO_FORMATO[item.formato]}</span></h3>`,
    `<p>${escapar(item.descricao)}</p>`,
    '</li>',
  ].join('\n'));
  const partes = [`<ul class="lista-entregaveis">\n${itens.join('\n')}\n</ul>`];
  if (offer.bonus.length > 0) {
    partes.push(
      '<h3 class="titulo-bonus">Bônus (liberado após 7 dias)</h3>',
      `<ul class="lista-bonus">\n${offer.bonus.map((item) => `<li>${escapar(item)}</li>`).join('\n')}\n</ul>`,
    );
  }
  return partes.join('\n');
}

function corpoFaq(offer: OfferProposal): string {
  if (offer.objecoes.length === 0) return '<p>Nenhuma dúvida registrada até agora.</p>';
  return offer.objecoes.map((item) => [
    '<details>',
    `<summary>${escapar(item.objecao)}</summary>`,
    `<p>${escapar(item.resposta)}</p>`,
    '</details>',
  ].join('\n')).join('\n');
}

function botaoCompra(checkoutUrl: string | null): string {
  if (checkoutUrl === null) {
    return '<button type="button" class="botao" disabled>Link de pagamento ainda não definido</button>';
  }
  return `<a class="botao" href="${escapar(checkoutUrl)}" target="_blank" rel="noopener">Quero receber o material</a>`;
}

/** Estilo do arquivo único: celular primeiro, sem fonte externa e sem JS. */
function cssDaPagina(cor: string): string {
  return `:root { --cor: ${cor}; --texto: #1c1c1c; --fundo: #f7f5f1; }
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  padding: 0 0 96px;
  background: var(--fundo);
  color: var(--texto);
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
  line-height: 1.6;
}
.pagina { width: 100%; max-width: 720px; margin: 0 auto; padding: 24px 20px 40px; }
.abertura { padding: 16px 0 8px; }
.marca { margin: 0 0 12px; font-size: 0.85rem; letter-spacing: 0.08em; text-transform: uppercase; color: #5b5b5b; }
h1 { margin: 0 0 12px; font-size: 1.75rem; line-height: 1.25; }
.produto { margin: 0 0 16px; font-size: 1.05rem; font-weight: 600; color: var(--cor); }
.link-ancora { display: inline-block; padding: 8px 0; color: var(--cor); font-weight: 600; }
section { margin: 16px 0; padding: 20px; border-radius: 14px; background: #fff; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.06); }
h2 { margin: 0 0 12px; font-size: 1.3rem; line-height: 1.3; }
h3 { margin: 0 0 6px; font-size: 1.05rem; }
p { margin: 0 0 12px; }
p:last-child { margin-bottom: 0; }
ul { margin: 0 0 12px; padding-left: 1.2em; }
.destaque { padding: 12px 14px; border-left: 4px solid var(--cor); background: #eef4f2; font-weight: 600; }
.lista-entregaveis, .lista-bonus { list-style: none; padding: 0; }
.entregavel { padding: 14px 0; border-top: 1px solid #e6e2db; }
.entregavel:first-child { padding-top: 0; border-top: 0; }
.formato { display: inline-block; margin-left: 6px; padding: 2px 8px; border-radius: 999px; background: #eef4f2; color: var(--cor); font-size: 0.75rem; font-weight: 700; vertical-align: middle; }
.titulo-bonus { margin-top: 18px; }
.lista-bonus li { position: relative; padding: 6px 0 6px 22px; }
.lista-bonus li::before { content: "★"; position: absolute; left: 0; color: var(--cor); }
.preco { margin: 4px 0 8px; font-size: 2rem; font-weight: 800; color: var(--cor); }
details { padding: 12px 0; border-top: 1px solid #e6e2db; }
details:first-of-type { border-top: 0; }
summary { cursor: pointer; font-weight: 600; }
details p { margin: 10px 0 0; color: #444; }
.chamada { text-align: center; }
.botao { display: block; width: 100%; min-height: 56px; padding: 16px 20px; border: 0; border-radius: 12px; background: var(--cor); color: #fff; font-size: 1.15rem; font-weight: 700; text-align: center; text-decoration: none; cursor: pointer; }
.botao[disabled] { background: #8d8d8d; cursor: not-allowed; }
.botao:focus-visible, .link-ancora:focus-visible, summary:focus-visible { outline: 3px solid #111; outline-offset: 3px; }
.rodape-fixo { position: fixed; left: 0; right: 0; bottom: 0; z-index: 10; padding: 10px 16px; background: #1c1c1c; color: #fff; font-size: 0.8rem; text-align: center; }
.rodape-fixo p { margin: 0; }
@media (min-width: 600px) {
  .pagina { padding-top: 32px; }
  h1 { font-size: 2.1rem; }
  section { padding: 24px; }
}`;
}

/**
 * Monta a página inteira a partir da oferta aprovada. O preço vem de
 * precoHipotese: é hipótese editável do Joel, não preço aprovado.
 */
export function buildSalesPage(offer: OfferProposal, opts: SalesPageOptions): string {
  const checkoutUrl = opts.checkoutUrl === null ? null : validarCheckout(opts.checkoutUrl);
  const marca = (opts.marca ?? '').trim() || offer.nome.trim() || 'NIGHT';

  const diasPedidos = opts.garantiaDias;
  const garantiaDias = typeof diasPedidos === 'number' && Number.isFinite(diasPedidos) && diasPedidos >= 1
    ? Math.floor(diasPedidos)
    : GARANTIA_PADRAO;

  const corPedida = opts.cor ?? '';
  const cor = /^#[0-9a-fA-F]{3,8}$/.test(corPedida) ? corPedida : COR_PADRAO;

  const botao = botaoCompra(checkoutUrl);
  const secoes: Record<SecaoKey, string> = {
    publico: secao('publico', 'Para quem é', `<p>${escapar(offer.publico)}</p>`),
    problema: secao('problema', 'O problema', `<p>${escapar(offer.problema)}</p>`),
    solucao: secao('solucao', 'A solução', [
      `<p>${escapar(offer.posicionamento)}</p>`,
      `<p class="destaque">${escapar(offer.diferencial)}</p>`,
    ].join('\n')),
    entregaveis: secao('entregaveis', 'O que você recebe', corpoEntregaveis(offer)),
    preco: secao('preco', 'Preço', [
      `<p class="preco">${formatarPreco(offer.precoHipotese.valor)}</p>`,
      '<p>Pagamento único pelos materiais desta página.</p>',
    ].join('\n')),
    garantia: secao('garantia', 'Garantia', [
      `<p>Você tem ${garantiaDias} dias após a compra para pedir reembolso se o material não fizer sentido para você.</p>`,
    ].join('\n')),
    faq: secao('faq', 'Perguntas frequentes', corpoFaq(offer)),
    chamada: secao('chamada', 'Pronto para começar?', [
      '<p>Veja o material e faça o pedido pelo link abaixo.</p>',
      botao,
    ].join('\n'), 'chamada'),
  };

  const ordem = ordemDasSecoes(offer.paginaDeVendas);
  const corpo = [abertura(offer, marca), ...ordem.map((key) => secoes[key])].join('\n');

  return [
    '<!doctype html>',
    '<html lang="pt-BR">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapar(offer.nome)} — ${escapar(marca)}</title>`,
    `<style>\n${cssDaPagina(cor)}\n</style>`,
    '</head>',
    '<body>',
    `<main class="pagina">\n${corpo}\n</main>`,
    `<footer class="rodape-fixo">\n<p><strong>${escapar(marca)}</strong> — Este produto não promete renda nem resultado garantido.</p>\n</footer>`,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

/** Grava a página versionada no ArtifactStore, como o resto do produto low-ticket. */
export async function saveSalesPage(
  store: ArtifactStore,
  jobId: string,
  html: string,
  versao: number,
): Promise<ArtifactItem> {
  if (!Number.isInteger(versao) || versao < 1) {
    throw new Error(`versão da página inválida: ${versao}; use um inteiro a partir de 1`);
  }
  return store.add(jobId, {
    name: `pagina-vendas-v${versao}.html`,
    data: html,
    origin: 'lowticket',
    kind: 'html',
  });
}

