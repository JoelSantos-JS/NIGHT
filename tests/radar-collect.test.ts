// Coleta do Radar: o link da Biblioteca de Anúncios não conta como domínio do anunciante.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { toCandidate } from '../src/radar/collect.ts';

describe('toCandidate', () => {
  test('link da Biblioteca (facebook.com) não vira domínio, senão as páginas se juntam numa oferta só', () => {
    const a = toCandidate({ externalId: 'page:1:x', adUrl: 'https://www.facebook.com/ads/archive/render_ad/?id=1' }, 'meta', 'x', 'j');
    const b = toCandidate({ externalId: 'page:2:x', adUrl: 'https://facebook.com/ads/library/?id=2' }, 'meta', 'x', 'j');
    assert.equal(a.domain, null);
    assert.equal(b.domain, null);
  });

  test('página de vendas de verdade continua sendo o domínio', () => {
    const c = toCandidate({ externalId: 'e', adUrl: 'https://facebook.com/ads/library/?id=3', landingUrl: 'https://www.loja.com.br/oferta?utm_source=fb' }, 'meta', 'x', 'j');
    assert.equal(c.domain, 'loja.com.br');
    assert.equal(c.landingUrlNorm, 'https://loja.com.br/oferta');
  });
});
