import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, test } from 'node:test';
import { PgMemory } from '../src/memory/pg-memory.ts';
import { collect, domainOf, normalizeUrl, type AdSource, type RawAd } from '../src/radar/collect.ts';
import { scoreCandidate } from '../src/radar/score.ts';
import { PgRadarStore, type NewCandidate } from '../src/radar/store.ts';
import { resetTestDb, TEST_URL, truncateAll } from './helpers.ts';

/** Fonte falsa: entrega as páginas em ordem e aponta o cursor para a próxima. */
class FakeSource implements AdSource {
  readonly name = 'falsa';
  calls: { keyword: string; cursor: string | null; limit: number }[] = [];
  constructor(private readonly paginas: RawAd[][]) {}

  async search(
    keyword: string, cursor: string | null, limit: number,
  ): Promise<{ ads: RawAd[]; nextCursor: string | null }> {
    this.calls.push({ keyword, cursor, limit });
    const indice = cursor === null ? 0 : Number(cursor.slice(1));
    const pagina = this.paginas[indice] ?? [];
    const proximo = indice + 1 < this.paginas.length ? `p${indice + 1}` : null;
    return { ads: pagina.slice(0, limit), nextCursor: proximo };
  }
}

const PAGINA_1: RawAd[] = [
  {
    externalId: 'a1', advertiser: 'Loja A', adUrl: 'https://ads.com/a1',
    landingUrl: 'https://lojaa.com/oferta?utm_source=x', country: 'BR',
    startedAt: '2026-10-01T10:00:00Z', activeAdsInDomain: 94,
  },
  // Só o essencial: o resto tem de aparecer em unknown_fields.
  { externalId: 'a2', advertiser: 'Loja B', country: 'BR' },
];
const PAGINA_2: RawAd[] = [
  {
    externalId: 'a3', advertiser: 'Loja C', adUrl: 'https://ads.com/a3',
    landingUrl: 'https://lojac.com/venda', country: 'BR', startedAt: '2026-10-02',
    activeAdsInDomain: 12,
  },
];

function baseCandidate(externalId: string, extra: Partial<NewCandidate> = {}): NewCandidate {
  return { source: 'falsa', externalId, raw: { externalId }, keywords: ['curso'], ...extra };
}

describe('Radar: base e coleta', () => {
  let mem: PgMemory;
  let store: PgRadarStore;

  before(async () => {
    await resetTestDb(TEST_URL);
    mem = await PgMemory.open(TEST_URL);
    store = await PgRadarStore.open(TEST_URL);
  });
  after(async () => {
    await store?.close();
    await mem?.close();
  });
  beforeEach(async () => { await truncateAll(); });

  /** As FKs de radar_candidates/radar_cursors exigem um job radar de verdade. */
  async function novoJob(): Promise<string> {
    const { job } = await mem.createJob({
      kind: 'radar', origin: 'texto', idempotencyKey: `radar-${randomUUID()}`,
    });
    return job.id;
  }

  test('mesmo anúncio da mesma fonte não duplica e amplia keywords', async () => {
    const jobId = await novoJob();
    const primeiro = await store.upsertCandidate(baseCandidate('ext-1', { jobId, advertiser: 'Loja' }));
    assert.equal(primeiro.created, true);

    const segundo = await store.upsertCandidate(
      baseCandidate('ext-1', { jobId, advertiser: 'Loja', keywords: ['pdf'] }),
    );
    assert.equal(segundo.created, false);
    assert.equal(segundo.candidate.id, primeiro.candidate.id);
    assert.deepEqual([...segundo.candidate.keywords].sort(), ['curso', 'pdf']);
    assert.equal(await store.countCandidates(), 1);
  });

  test('mesmo destino com UTM diferente deduplica e guarda o novo ID em raw.aliases', async () => {
    const jobId = await novoJob();
    const urlA = 'https://www.loja.com/oferta?utm_source=facebook';
    const urlB = 'https://loja.com/oferta?fbclid=zzz';

    const primeiro = await store.upsertCandidate(baseCandidate('ext-1', {
      jobId, landingUrl: urlA, landingUrlNorm: normalizeUrl(urlA),
    }));
    const segundo = await store.upsertCandidate(baseCandidate('ext-2', {
      jobId, landingUrl: urlB, landingUrlNorm: normalizeUrl(urlB),
    }));

    assert.equal(primeiro.created, true);
    assert.equal(segundo.created, false);
    assert.equal(segundo.candidate.id, primeiro.candidate.id);
    assert.deepEqual(segundo.candidate.raw.aliases, ['ext-2']);
    assert.equal(await store.countCandidates(), 1);

    // Outra observação do mesmo destino: o alias antigo não se perde.
    const terceiro = await store.upsertCandidate(baseCandidate('ext-3', {
      jobId, landingUrl: urlA, landingUrlNorm: normalizeUrl(urlA),
    }));
    assert.equal(terceiro.created, false);
    assert.deepEqual(terceiro.candidate.raw.aliases, ['ext-2', 'ext-3']);
  });

  test('nova observação atualiza o raw mas não apaga campo conhecido que sumiu', async () => {
    const jobId = await novoJob();
    const primeiro = await store.upsertCandidate(baseCandidate('ext-1', {
      jobId, raw: { externalId: 'ext-1', activeAdsInDomain: 12 },
    }));
    assert.equal(primeiro.candidate.raw.activeAdsInDomain, 12);
    assert.equal(primeiro.candidate.raw.observacoes, 1);

    // Valor novo conhecido substitui o antigo: a triagem não usa dado velho.
    const segundo = await store.upsertCandidate(baseCandidate('ext-1', {
      jobId, raw: { externalId: 'ext-1', activeAdsInDomain: 40 },
    }));
    assert.equal(segundo.created, false);
    assert.equal(segundo.candidate.raw.activeAdsInDomain, 40);
    assert.equal(segundo.candidate.raw.observacoes, 2);
    assert.equal(typeof segundo.candidate.raw.ultimaObservacao, 'string');

    // Terceira vista sem o campo: ausente não apaga o que já era conhecido.
    const terceiro = await store.upsertCandidate(baseCandidate('ext-1', { jobId }));
    assert.equal(terceiro.candidate.raw.activeAdsInDomain, 40);
    assert.equal(terceiro.candidate.raw.observacoes, 3);
  });

  test('campo ausente vai para unknown_fields e não apaga valor conhecido', async () => {
    const jobId = await novoJob();
    const primeiro = await store.upsertCandidate(baseCandidate('ext-1', {
      jobId, advertiser: 'Loja', country: 'BR', adUrl: 'https://ads.com/1',
    }));
    assert.deepEqual(primeiro.candidate.unknownFields, []);

    const segundo = await store.upsertCandidate(baseCandidate('ext-1', {
      jobId, unknownFields: ['advertiser', 'country'],
    }));
    assert.equal(segundo.created, false);
    assert.equal(segundo.candidate.advertiser, 'Loja');
    assert.equal(segundo.candidate.country, 'BR');
    assert.equal(segundo.candidate.adUrl, 'https://ads.com/1');
    assert.deepEqual(segundo.candidate.unknownFields, ['advertiser', 'country']);
  });

  test('setScore guarda a nota de triagem no candidato', async () => {
    const jobId = await novoJob();
    const { candidate } = await store.upsertCandidate(baseCandidate('ext-1', { jobId }));
    const nota = scoreCandidate({
      anunciosAtivos: 94, diasNoAr: 41, anunciantesNoNicho: 5, precoOrigem: 97, entregavelEmPdf: true,
    });
    await store.setScore(candidate.id, nota);

    const lido = await store.getCandidate(candidate.id);
    assert.equal(lido?.score?.nota, 10);
    assert.equal(lido?.score?.version, 'triagem/2');
  });

  test('acimaDoCorte semanal usa a mesma regra do worker', async () => {
    const jobId = await novoJob();
    const passa = await store.upsertCandidate(baseCandidate('parcial-passa', { jobId }));
    const falta = await store.upsertCandidate(baseCandidate('parcial-falta', { jobId }));
    await store.setScore(passa.candidate.id, scoreCandidate({ anunciosAtivos: 90, anunciantesNoNicho: 4, entregavelEmPdf: true }));
    await store.setScore(falta.candidate.id, scoreCandidate({ anunciosAtivos: 90, entregavelEmPdf: true }));
    const now = Date.now();
    const counts = await store.radarWeeklyCounts(new Date(now - 86_400_000), new Date(now + 86_400_000));
    assert.equal(counts.acimaDoCorte, 1);
  });

  test('coleta pagina e conta vistos, novos, duplicados e incompletos', async () => {
    const jobId = await novoJob();
    const source = new FakeSource([PAGINA_1, PAGINA_2]);

    const conta = await collect(store, source, {
      jobId, keywords: ['curso'], maxPerKeyword: 10, maxPages: 5,
    });

    assert.deepEqual(conta['curso'], { vistos: 3, novos: 3, duplicados: 0, incompletos: 1 });
    assert.equal(await store.countCandidates(), 3);
    // Fim da fonte: cursor null, para a próxima execução recomeçar do início.
    assert.equal(await store.getCursor(jobId, 'curso', source.name), null);
  });

  test('segunda execução continua do cursor e não cria duplicatas', async () => {
    const jobId = await novoJob();
    const source = new FakeSource([PAGINA_1, PAGINA_2]);

    const primeira = await collect(store, source, {
      jobId, keywords: ['curso'], maxPerKeyword: 10, maxPages: 1,
    });
    assert.deepEqual(primeira['curso'], { vistos: 2, novos: 2, duplicados: 0, incompletos: 1 });
    assert.equal(await store.getCursor(jobId, 'curso', source.name), 'p1');

    const segunda = await collect(store, source, {
      jobId, keywords: ['curso'], maxPerKeyword: 10, maxPages: 1,
    });
    assert.deepEqual(segunda['curso'], { vistos: 1, novos: 1, duplicados: 0, incompletos: 0 });
    assert.equal(source.calls[1]?.cursor, 'p1', 'a segunda execução começa do cursor salvo');
    assert.equal(await store.countCandidates(), 3);

    // Passada inteira do início só encontra repetidos.
    const terceira = await collect(store, source, {
      jobId, keywords: ['curso'], maxPerKeyword: 10, maxPages: 5,
    });
    assert.equal(terceira['curso']!.novos, 0);
    assert.equal(terceira['curso']!.duplicados, 3);
    assert.equal(await store.countCandidates(), 3);
  });

  test('ofertas: número falável sequencial, revisão preserva versão e feedback', async () => {
    const jobId = await novoJob();
    const { candidate } = await store.upsertCandidate(baseCandidate('ext-1', { jobId }));

    const primeira = await store.createOffer(candidate.id, { nome: 'Oferta A' }, [{ fonte: 'falsa' }]);
    assert.equal(primeira.number, 1);
    assert.equal(primeira.version, 1);
    assert.equal(primeira.status, 'rascunho');
    assert.deepEqual(primeira.proposal, { nome: 'Oferta A' });

    const outra = await store.createOffer(null, { nome: 'Oferta B' }, []);
    assert.equal(outra.number, 2, 'o número é o que o Joel fala e não se repete');

    const revisao = await store.reviseOffer(primeira.number, { nome: 'Oferta A revisada' }, [{ fonte: 'manual' }]);
    assert.equal(revisao.number, 1);
    assert.equal(revisao.version, 2);
    assert.equal(revisao.status, 'rascunho');

    const antiga = await store.getOffer(1, 1);
    assert.deepEqual(antiga?.proposal, { nome: 'Oferta A' }, 'a versão 1 continua intacta');
    const nova = await store.getOffer(1);
    assert.equal(nova?.version, 2, 'sem versão, devolve a mais nova');
    assert.deepEqual(nova?.proposal, { nome: 'Oferta A revisada' });
    assert.deepEqual((await store.listOfferVersions(1)).map((o) => o.version), [1, 2]);

    await store.setOfferStatus(1, 2, 'discutindo');
    assert.equal((await store.getOffer(1, 2))?.status, 'discutindo');

    const feedback = await store.addFeedback({
      offerNumber: 1, offerVersion: 2, kind: 'objecao', text: 'preço alto', resultingVersion: 3,
    });
    assert.equal(feedback.kind, 'objecao');
    assert.equal(feedback.resultingVersion, 3);
    assert.deepEqual((await store.listFeedback(1)).map((f) => f.text), ['preço alto']);
  });
});

describe('normalizeUrl e domainOf', () => {
  test('limpa host, rastreio, fragmento e barra final; força https', () => {
    assert.equal(
      normalizeUrl('https://WWW.Exemplo.com/Oferta/?utm_source=fb&utm_medium=x&fbclid=abc#topo'),
      'https://exemplo.com/Oferta',
    );
    assert.equal(normalizeUrl('http://exemplo.com/oferta'), 'https://exemplo.com/oferta');
    assert.equal(normalizeUrl('https://exemplo.com/oferta/'), 'https://exemplo.com/oferta');
    assert.equal(normalizeUrl('https://exemplo.com/?utm_campaign=z'), 'https://exemplo.com');
    assert.equal(normalizeUrl('https://exemplo.com'), 'https://exemplo.com');
    assert.equal(
      normalizeUrl('https://exemplo.com/a?gclid=1&id=7&mc_cid=2&ttclid=3'),
      'https://exemplo.com/a?id=7',
    );
    assert.equal(normalizeUrl('https://exemplo.com/a?b=2&utm_source=x'), 'https://exemplo.com/a?b=2');
  });

  test('URL inválida ou de outro protocolo devolve null', () => {
    assert.equal(normalizeUrl('não é uma url'), null);
    assert.equal(normalizeUrl('ftp://exemplo.com/x'), null);
    assert.equal(normalizeUrl(''), null);
  });

  test('domainOf tira www e minúsculas; inválida devolve null', () => {
    assert.equal(domainOf('https://www.Exemplo.com/x'), 'exemplo.com');
    assert.equal(domainOf('http://sub.exemplo.com:8080/x'), 'sub.exemplo.com');
    assert.equal(domainOf('nada'), null);
  });
});
