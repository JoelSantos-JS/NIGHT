import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  consultasDeDominio, DOMINIOS_DESCOBERTA, ehDominioDescoberta, ehHostCompartilhado,
  PALAVRAS_PDF, planejarConsultasBiblioteca, PRECO_ALVO, TAGS_OFERTA,
} from '../src/radar/search-terms.ts';

test('capturas: tags nos três idiomas, PDFs e domínios de descoberta', () => {
  assert.ok(TAGS_OFERTA.pt.pdf.includes('apostila pdf'));
  assert.ok(TAGS_OFERTA.es.geral.includes('lectoescritura'));
  assert.ok(TAGS_OFERTA.en.pdf.includes('workbook pdf'));
  assert.ok(DOMINIOS_DESCOBERTA.includes('paginas.lowify.com.br'));
  assert.ok(DOMINIOS_DESCOBERTA.includes('vercel.app'));
});

test('PDF: origem cara, preço alvo da versão própria entre R$ 9,90 e R$ 19,90', () => {
  assert.ok(PALAVRAS_PDF.includes('de R$ 197 por R$ 67'));
  assert.deepEqual(PRECO_ALVO, { minimo: 9.9, maximo: 19.9 });
});

test('domínio de hospedagem é pista de descoberta, inclusive subdomínio', () => {
  assert.equal(ehDominioDescoberta('https://cliente.vercel.app/produto'), true);
  assert.equal(ehDominioDescoberta('PAGINAS.LOWIFY.COM.BR'), true);
  assert.equal(ehDominioDescoberta('vercel.app.malicioso.com'), false);
  assert.equal(ehDominioDescoberta('minha-marca.com.br'), false);
  assert.deepEqual(consultasDeDominio('  atividades   pdf ', 2), [
    'vercel.app atividades pdf', 'lovable.app atividades pdf',
  ]);
});

test('host compartilhado inclui hospedagem e checkout, sem confundir domínio próprio', () => {
  assert.equal(ehHostCompartilhado('cliente.vercel.app'), true);
  assert.equal(ehHostCompartilhado('pay.kiwify.com.br'), true);
  assert.equal(ehHostCompartilhado('paginas.lowify.com.br'), true);
  assert.equal(ehHostCompartilhado('minha-marca.com.br'), false);
  assert.equal(ehHostCompartilhado('kiwify.com.br.malicioso.com'), false);
});

test('consulta domínio+tag usa keyword_unordered e nunca busca o host isolado', () => {
  const consultas = planejarConsultasBiblioteca('atividades pdf', 3, 0);
  assert.equal(consultas.length, 3);
  for (const consulta of consultas) {
    assert.equal(consulta.tipo, 'keyword_unordered');
    assert.match(consulta.termo, /^\S+\.\S+ .+$/, 'domínio + tag, não host sozinho');
  }
  assert.deepEqual(consultas.map((c) => c.termo), [
    'vercel.app atividades pdf', 'lovable.app atividades pdf', 'netlify.app atividades pdf',
  ]);
});

test('consulta já combinada é preservada; frase de preço vira domínio+tag sem R$', () => {
  assert.deepEqual(planejarConsultasBiblioteca('vercel.app atividades pdf', 3), [
    { termo: 'vercel.app atividades pdf', tipo: 'keyword_unordered' },
  ]);
  // Preço com palavras de pedido também não vira busca exata ("ofertas de R$ 47" devolveria zero).
  for (const termo of ['apenas R$ 47', 'ofertas de R$ 47', 'de R$ 197 por R$ 67']) {
    const doPreco = planejarConsultasBiblioteca(termo, 2);
    assert.equal(doPreco.length, 2, termo);
    for (const consulta of doPreco) {
      assert.equal(consulta.tipo, 'keyword_unordered');
      assert.ok(!/R\$/i.test(consulta.termo), consulta.termo);
      assert.match(consulta.termo, /^\S+\.\S+ /, consulta.termo);
    }
  }
  const nichoComPreco = planejarConsultasBiblioteca('fone bluetooth por R$ 47', 2);
  assert.deepEqual(nichoComPreco[0], { termo: 'fone bluetooth', tipo: 'keyword_unordered' });
});

test('termo explícito do usuário é preservado antes das combinações com domínio', () => {
  const consultas = planejarConsultasBiblioteca('fone bluetooth', 3);
  assert.deepEqual(consultas[0], { termo: 'fone bluetooth', tipo: 'keyword_unordered' });
  assert.equal(consultas.length, 3);
  assert.ok(consultas.slice(1).every((c) => c.termo.endsWith('fone bluetooth')));
});
