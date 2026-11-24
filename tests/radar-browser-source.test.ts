// Fonte do Radar pela página da Biblioteca de Anúncios. Sem Chrome e sem rede: a abertura da
// página é injetada e devolve o texto que o leitor de cards espera.
//
// O que se prova aqui (pedido do Joel, 21/11):
// - host compartilhado (vercel.app, kiwify, lowify) NÃO soma vendedores; agrupa pela página anunciante;
// - total de anúncios do host compartilhado nunca vira `activeAdsInDomain` de um vendedor;
// - preço de origem vem do que o anúncio cobra (R$ 67), não do preço alvo do Joel (R$ 9,90–19,90);
// - busca sem resultado não fabrica oferta.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BrowserAdLibrarySource, ehProdutoDigital, MARCA_PAGINAS, paginaDeTeste, precoCobrado, precoDoDestino, type CardBiblioteca } from '../src/radar/browser-source.ts';
import { PRECO_ALVO } from '../src/radar/search-terms.ts';

function card(opcoes: {
  id: string;
  pagina: string;
  dominio?: string | null;
  corpo?: string;
  titulo?: string;
  inicio?: string;
  copias?: number;
}): string {
  return [
    `Identificação da biblioteca: ${opcoes.id}`,
    `Veiculação iniciada em ${opcoes.inicio ?? '1 de out de 2026'}`,
    ...(opcoes.copias ? [`${opcoes.copias} anúncios usam esse criativo e esse texto`] : []),
    'Ativo',
    opcoes.pagina,
    'Patrocinado',
    opcoes.corpo ?? 'Apostila de atividades para imprimir, material em PDF.',
    ...(opcoes.dominio ? [opcoes.dominio.toUpperCase()] : []),
    opcoes.titulo ?? 'Apostila completa',
    '',
  ].join('\n');
}

function pagina(...cards: string[]): string {
  return cards.join('\n');
}

function comPaginas(texto: string, links: [string, string][]): string {
  return `${texto}${MARCA_PAGINAS}${JSON.stringify(links)}`;
}

/** `abrir` falso: responde por parâmetro `q` ou `view_all_page_id`; o resto é "sem resultado". */
function abridor(respostas: (url: URL) => string | undefined): (url: string) => Promise<string> {
  return async (bruta) => {
    const url = new URL(bruta);
    return respostas(url) ?? 'Nenhum resultado encontrado. Remova ou ajuste os filtros.';
  };
}

const SEM_RESULTADO = 'Nenhum resultado encontrado. Remova ou ajuste os filtros.';

test('preço e acesso no app de loja física não tornam o produto digital', () => {
  const loja: CardBiblioteca = { id: '1', inicio: null, pagina: 'Loja de Roupas',
    corpo: 'Blusinhas por R$ 19,90. Acesso imediato no app e baixe agora.',
    titulo: 'Oferta de roupas', host: null, dominio: null, destino: null, compartilhado: false, copias: 1 };
  assert.equal(ehProdutoDigital(loja), false);
  assert.equal(ehProdutoDigital({ ...loja, corpo: 'Atividades em PDF para imprimir.' }), true);
});

test('host compartilhado agrupa por página e não soma vendedores', async () => {
  const texto = pagina(
    card({
      id: '101', pagina: 'Loja A', dominio: 'CLIENTE-A.VERCEL.APP',
      corpo: 'Caderno de atividades para imprimir em PDF. de R$ 197 por R$ 67',
    }),
    card({
      id: '102', pagina: 'Loja B', dominio: 'CLIENTE-B.VERCEL.APP',
      corpo: 'Planner digital em PDF. apenas R$ 97',
    }),
  );
  const urls: string[] = [];
  const fonte = new BrowserAdLibrarySource({
    maxBuscas: 1,
    abrir: abridor((url) => {
      urls.push(url.toString());
      if (url.searchParams.get('q') === 'vercel.app atividades pdf') return texto;
      return SEM_RESULTADO;
    }),
  });

  const r = await fonte.nicheScan('vercel.app atividades pdf');
  assert.equal(r.ads.length, 2, 'cada página é um anunciante');
  assert.deepEqual(r.ads.map((a) => a.advertiser).sort(), ['Loja A', 'Loja B']);
  for (const ad of r.ads) {
    assert.ok(!String(ad.externalId).includes('dominio:vercel.app'), 'host compartilhado não é o id do vendedor');
    assert.equal('activeAdsInDomain' in ad, false, 'total do host compartilhado não é do vendedor');
  }
  // A primeira consulta usa a combinação; depois pode haver fallback por nome da página.
  assert.ok(urls.length >= 1);
  const consulta = new URL(urls[0]!);
  assert.equal(consulta.searchParams.get('q'), 'vercel.app atividades pdf');
  assert.equal(consulta.searchParams.get('search_type'), 'keyword_unordered');
});

test('volume e cópias pertencem à oferta, não ao total da página anunciante', async () => {
  const oferta = card({ id: '213', pagina: 'Loja A', dominio: 'KIT-A.VERCEL.APP',
    inicio: '15 de nov de 2026', copias: 12 });
  const outra = card({ id: '214', pagina: 'Loja A', dominio: 'KIT-B.VERCEL.APP',
    inicio: '1 de out de 2026', copias: 40 });
  const fonte = new BrowserAdLibrarySource({ maxBuscas: 1, maxPaginas: 2,
    hoje: () => new Date('2026-11-22T12:00:00Z'),
    abrir: abridor((url) => {
      if (url.searchParams.get('q') === 'vercel.app atividades pdf') return pagina(oferta, outra);
      if (url.searchParams.get('q') === 'Loja A') return `~52 resultados\n${pagina(oferta, outra)}`;
      return SEM_RESULTADO;
    }),
  });
  const r = await fonte.nicheScan('vercel.app atividades pdf');
  const a = r.ads.find((ad) => ad.landingUrl?.includes('kit-a.vercel.app'));
  assert.ok(a, JSON.stringify(r.ads));
  assert.equal(a.anunciosDaOferta, 12);
  assert.equal(a.copiasCriativo, 12);
  assert.equal(a.diasNoAr, 7);
  assert.equal(a.activeAdsInDomain, 52, 'total da página fica separado do volume da oferta');
});

test('quando o ID da página falha, conta pelo nome só se os cards confirmarem a página', async () => {
  const texto = card({ id: '214', pagina: 'Loja A', dominio: 'CLIENTE-A.VERCEL.APP',
    corpo: 'Apostila PDF por R$ 67' });
  const fonte = new BrowserAdLibrarySource({ maxBuscas: 1, maxPaginas: 1,
    abrir: abridor((url) => {
      if (url.searchParams.get('q') === 'vercel.app atividades pdf') return texto;
      if (url.searchParams.get('q') === 'Loja A') return `~12 resultados\n${texto}`;
      return SEM_RESULTADO;
    }),
  });
  const r = await fonte.nicheScan('vercel.app atividades pdf');
  assert.equal(r.ads[0]!.activeAdsInDomain, 12);
});

test('contagem por página do host compartilhado vale; total do host não', async () => {
  const texto = comPaginas(
    card({
      id: '201', pagina: 'Loja A', dominio: 'CLIENTE-A.VERCEL.APP',
      corpo: 'Apostila PDF de receitas. de R$ 197 por R$ 67',
    }),
    [['Loja A', 'https://www.facebook.com/111111111/']],
  );
  const fonte = new BrowserAdLibrarySource({
    maxBuscas: 1,
    abrir: abridor((url) => {
      if (url.searchParams.get('q') === 'vercel.app atividades pdf') return texto;
      if (url.searchParams.get('view_all_page_id') === '111111111') {
        return comPaginas(
          `~12 resultados\n${card({
            id: '202', pagina: 'Loja A', dominio: 'CLIENTE-A.VERCEL.APP',
            corpo: 'Apostila PDF de receitas. de R$ 197 por R$ 67',
          })}`,
          [['Loja A', 'https://www.facebook.com/111111111/']],
        );
      }
      return SEM_RESULTADO;
    }),
  });

  const r = await fonte.nicheScan('vercel.app atividades pdf');
  assert.equal(r.ads.length, 1);
  assert.equal(r.ads[0]!.activeAdsInDomain, 12, 'contagem da PÁGINA, não do vercel.app');
  assert.equal(r.ads[0]!.externalId, 'page:111111111:host:cliente-a.vercel.app');
});

test('consulta por domínio ignora outro host e separa produtos no mesmo anunciante', async () => {
  const texto = pagina(
    card({ id: '211', pagina: 'Loja A', dominio: 'PRODUTO-1.VERCEL.APP', corpo: 'Apostila PDF por R$ 67' }),
    card({ id: '212', pagina: 'Loja A', dominio: 'PRODUTO-2.VERCEL.APP', corpo: 'Planner digital PDF por R$ 97' }),
    card({ id: '213', pagina: 'Loja B', dominio: 'OUTRO-SITE.COM', corpo: 'Apostila PDF por R$ 67' }),
  );
  const fonte = new BrowserAdLibrarySource({ maxBuscas: 1, maxPaginas: 5,
    abrir: abridor((url) => url.searchParams.get('q') === 'vercel.app atividades pdf' ? texto : SEM_RESULTADO),
  });
  const r = await fonte.nicheScan('vercel.app atividades pdf');
  assert.equal(r.ads.length, 2);
  assert.deepEqual(r.ads.map((ad) => ad.precoOrigem).sort(), [67, 97]);
  assert.equal(new Set(r.ads.map((ad) => ad.externalId)).size, 2);
  assert.equal(r.anunciantesNoNicho, 1, 'a mesma página continua um anunciante');
});

test('busca por domínio e preço não inventa concorrentes do mesmo nicho', async () => {
  const texto = pagina(
    card({ id: '221', pagina: 'Loja A', dominio: 'PRODUTO-A.VERCEL.APP', corpo: 'Apostila PDF por R$ 67' }),
    card({ id: '222', pagina: 'Loja B', dominio: 'PRODUTO-B.VERCEL.APP', corpo: 'Planner digital PDF por R$ 67' }),
  );
  const fonte = new BrowserAdLibrarySource({ maxBuscas: 1, maxPaginas: 3,
    abrir: abridor((url) => url.searchParams.get('q') === 'vercel.app r$ 67' ? texto : SEM_RESULTADO),
  });
  const r = await fonte.nicheScan('vercel.app R$ 67');
  assert.equal(r.ads.length, 2);
  assert.ok(r.ads.every((ad) => ad.anunciantesNoNicho === undefined));
  assert.ok(r.observacoes.some((o) => o.includes('nichos diferentes')));
});

test('página que declara preço hipotético e checkout desativado não vira candidato', async () => {
  const texto = pagina(card({ id: '230', pagina: 'Prévia', dominio: 'TESTE.VERCEL.APP',
    corpo: 'Apostila PDF por R$ 47' }));
  const fonte = new BrowserAdLibrarySource({ maxBuscas: 1, maxPaginas: 1,
    abrir: abridor((url) => url.searchParams.get('q') === 'vercel.app r$ 47' ? texto : SEM_RESULTADO),
    verificarDestino: async () => '<h1>Páginas de teste</h1> Checkout ainda não está no ar. Preço hipotético R$ 47.',
  });
  const r = await fonte.nicheScan('vercel.app R$ 47');
  assert.deepEqual(r.ads, []);
  assert.ok(r.observacoes.some((o) => o.includes('candidato descartado')));
  assert.equal(paginaDeTeste('<h1>Kit PDF por R$ 47</h1>'), false);
});

test('preço é opcional no anúncio e pode ser lido na página; preço alto não elimina oferta', async () => {
  const texto = pagina(
    card({ id: '231', pagina: 'Oferta A', dominio: 'A.VERCEL.APP', corpo: 'Kit de atividades em PDF' }),
    card({ id: '232', pagina: 'Oferta B', dominio: 'B.VERCEL.APP', corpo: 'Kit de atividades em PDF por R$ 297' }),
    card({ id: '233', pagina: 'Oferta C', dominio: 'C.VERCEL.APP', corpo: 'Kit de atividades em PDF' }),
  );
  const fonte = new BrowserAdLibrarySource({ maxBuscas: 1, maxPaginas: 3,
    abrir: abridor((url) => url.searchParams.get('q') === 'vercel.app atividades pdf' ? texto : SEM_RESULTADO),
    verificarDestino: async (url) => url.includes('a.vercel.app')
      ? '<p>Kit PDF: de R$ 197 por apenas R$ 67</p>' : '<p>Kit de atividades em PDF</p>',
  });
  const r = await fonte.nicheScan('vercel.app atividades pdf');
  assert.equal(r.ads.length, 3);
  assert.equal(r.ads.find((a) => a.advertiser === 'Oferta A')?.precoOrigem, 67);
  assert.equal(r.ads.find((a) => a.advertiser === 'Oferta B')?.precoOrigem, 297);
  assert.equal(r.ads.find((a) => a.advertiser === 'Oferta C')?.precoOrigem, undefined);
  assert.equal(precoDoDestino('<p>economize R$ 100</p>'), null);
});

test('preço de origem é o cobrado no anúncio, separado do preço alvo', async () => {
  const doAnuncio: CardBiblioteca = {
    id: '301', inicio: '2026-10-01', pagina: 'Loja A', corpo: 'Apostila PDF. de R$ 197 por R$ 67',
    host: 'cliente-a.vercel.app', dominio: 'vercel.app', destino: null, compartilhado: true,
    titulo: 'Apostila completa', copias: 1,
  };
  assert.equal(precoCobrado(doAnuncio), 67);
  assert.ok(PRECO_ALVO.minimo <= 19.9 && PRECO_ALVO.maximo === 19.9);
  assert.notEqual(precoCobrado(doAnuncio), PRECO_ALVO.maximo);

  const semPreco: CardBiblioteca = {
    ...doAnuncio, id: '302', corpo: 'Apostila PDF de atividades.', titulo: 'Apostila completa',
  };
  assert.equal(precoCobrado(semPreco), null, 'sem preço cobrado visível, fica ausente');

  const premio: CardBiblioteca = {
    ...doAnuncio, id: '303', corpo: 'Participe do sorteio.', titulo: 'Prêmio de R$ 6.782,54',
  };
  assert.equal(precoCobrado(premio), null, 'valor de prêmio não é preço de oferta');
});

test('busca sem resultado não fabrica oferta', async () => {
  const fonte = new BrowserAdLibrarySource({
    maxBuscas: 1,
    abrir: abridor(() => SEM_RESULTADO),
  });
  const r = await fonte.nicheScan('atividades pdf');
  assert.deepEqual(r.ads, []);
  assert.equal(r.estimatedTotal, 0);
  assert.ok(r.observacoes.some((o) => o.includes('0 anúncios lidos')));
});
