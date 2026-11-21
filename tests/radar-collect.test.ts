// Coleta do Radar: o link da Biblioteca de Anúncios não conta como domínio do anunciante.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { collect, toCandidate, type AdSource, type CollectStore } from '../src/radar/collect.ts';
import { QuotaError } from '../src/agents/research.ts';

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

describe('collect por nicho com falha (teste real 21/11)', () => {
  const store = {
    getCursor: async () => null,
    setCursor: async () => undefined,
    upsertCandidate: async () => ({ created: true }),
  } as unknown as CollectStore;
  const opts = (keywords: string[], avisos: string[]) => ({ jobId: 'j', keywords, maxPerKeyword: 10, maxPages: 1, onAviso: (t: string) => avisos.push(t) });
  const fonte = (falha: (k: string) => Error | null): AdSource => ({
    name: 'nicho-falso',
    search: async () => ({ ads: [], nextCursor: null, observacoes: [] }),
    nicheScan: async (k: string) => {
      const e = falha(k);
      if (e) throw e;
      return { ads: [{ externalId: `page:${k}`, advertiser: 'P', country: 'BR' }], observacoes: [] };
    },
  });

  test('um nicho que falha vira aviso e os outros seguem', async () => {
    const avisos: string[] = [];
    const r = await collect(store, fonte((k) => (k === 'a' ? new Error('passou de 360 s') : null)), opts(['a', 'b'], avisos));
    assert.equal(r.b?.novos, 1);
    assert.equal(r.a?.vistos, 0);
    assert.match(avisos.join('\n'), /^a: a busca falhou \(passou de 360 s\)/);
  });

  test('todos falham: o Radar falha com o motivo', async () => {
    await assert.rejects(collect(store, fonte(() => new Error('sem ferramenta da Meta')), opts(['a', 'b'], [])), /sem ferramenta da Meta/);
  });

  test('limite de uso para na hora', async () => {
    let chamadas = 0;
    const f = fonte(() => { chamadas++; return new QuotaError('limite de uso'); });
    await assert.rejects(collect(store, f, opts(['a', 'b'], [])), QuotaError);
    assert.equal(chamadas, 1);
  });
});

test('cancelado: não abre o próximo nicho (teste real 21/11)', async () => {
  let chamadas = 0;
  let cancelado = false;
  const store = { getCursor: async () => null, setCursor: async () => undefined, upsertCandidate: async () => ({ created: true }) } as unknown as CollectStore;
  const fonte: AdSource = {
    name: 'nicho-falso',
    search: async () => ({ ads: [], nextCursor: null, observacoes: [] }),
    nicheScan: async () => { chamadas++; cancelado = true; return { ads: [], observacoes: [] }; },
  };
  await collect(store, fonte, { jobId: 'j', keywords: ['a', 'b', 'c'], maxPerKeyword: 10, maxPages: 1, cancelado: () => cancelado });
  assert.equal(chamadas, 1);
});
