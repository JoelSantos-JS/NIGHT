import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { BRIEF_VERSION, buildBrief, validateBrief, type VideoBrief } from '../src/video/brief.ts';
import {
  MANIFEST_VERSION,
  estimateDuration,
  readyForFinalRender,
  sceneCacheKey,
  validateManifest,
  type ManifestProblem,
  type VideoManifest,
} from '../src/video/manifest.ts';

/** Briefing de 90 s (horizontal) para os manifestos de teste. */
function briefYoutube(extra: Record<string, unknown> = {}): VideoBrief {
  return buildBrief({
    tema: 'Como funciona o Pix',
    publico: 'adultos curiosos',
    plataforma: 'youtube',
    duracaoAlvoSeg: 90,
    estilo: 'documental',
    objetivo: 'explicar em 90 segundos',
    ...extra,
  });
}

/** Manifesto de 4 cenas, 20 s cada (80 s, dentro dos 90 s ±25%), sem avisos. */
function manifestoValido(): any {
  return {
    version: MANIFEST_VERSION,
    jobId: 'video-1',
    brief: briefYoutube(),
    titulo: 'Pix em 90 segundos',
    fontes: [
      { id: 'bcb', url: 'https://www.bcb.gov.br/pix', titulo: 'Banco Central — Pix', acessadoEm: '2026-11-17T20:00:00Z' },
      { id: 'artigo', url: 'http://exemplo.org/artigo', titulo: 'Artigo de apoio', acessadoEm: '2026-11-17' },
    ],
    cenas: [1, 2, 3, 4].map((n) => ({
      n,
      narracao: `Narração da cena ${n}`,
      duracaoEstimadaSeg: 20,
      afirmacoes: [{ texto: `Afirmação ${n}`, fonte: n === 1 ? null : 'bcb', duvida: n === 1 }],
      visual: `Descrição visual ${n}`,
      promptImagem: `imagem única ${n}`,
      papelImagem: 'ilustracao',
      realistaGeradaPorIA: false,
      assetRef: `assets/cena-${n}.png`,
    })),
  };
}

function manifestoDe(raw: unknown): VideoManifest {
  const r = validateManifest(raw);
  if (!r.ok) throw new Error('manifesto deveria ser válido: ' + JSON.stringify(r.errors));
  return r.manifest;
}

function errosDe(raw: unknown): ManifestProblem[] {
  const r = validateManifest(raw);
  if (r.ok) throw new Error('manifesto deveria falhar');
  return r.errors;
}

function avisosDe(raw: unknown): string[] {
  const r = validateManifest(raw);
  if (!r.ok) throw new Error('manifesto deveria ser válido: ' + JSON.stringify(r.errors));
  return r.avisos;
}

describe('briefing de vídeo (V01)', () => {
  test('padrões por plataforma: curtas verticais e YouTube horizontal', () => {
    for (const plataforma of ['shorts', 'reels', 'tiktok'] as const) {
      const b = buildBrief({ tema: 'Um tema', plataforma });
      assert.equal(b.version, BRIEF_VERSION);
      assert.equal(b.formato, 'vertical');
      assert.equal(b.duracaoAlvoSeg, 60);
      assert.equal(b.idioma, 'pt-BR');
      assert.equal(b.limites.maxImagens, 30);
      assert.equal(b.limites.maxRenderMin, 15);
      assert.equal(b.ofertaRadar, null);
    }
    const yt = buildBrief({ tema: 'Um tema', plataforma: 'youtube' });
    assert.equal(yt.formato, 'horizontal');
    assert.equal(yt.duracaoAlvoSeg, 90);
    assert.equal(BRIEF_VERSION, 'briefing-video/1');
  });

  test('limites ausentes usam os padrões (não viram erro)', () => {
    const b = buildBrief({ tema: 'Um tema', plataforma: 'shorts' });
    assert.equal(b.limites.maxImagens, 30);
    assert.equal(b.limites.maxRenderMin, 15);
    // Limite explícito que não é objeto continua sendo erro.
    assert.throws(() => buildBrief({ tema: 'Tema', plataforma: 'shorts', limites: null }), /limites/);
    assert.throws(() => buildBrief({ tema: 'Tema', plataforma: 'shorts', limites: 30 }), /limites/);
    assert.throws(() => buildBrief({ tema: 'Tema', plataforma: 'shorts', limites: '30' }), /limites/);
  });

  test('valores informados vencem os padrões', () => {
    const b = buildBrief({
      tema: 'Tema',
      publico: 'investidores',
      plataforma: 'youtube',
      formato: 'vertical',
      duracaoAlvoSeg: 120,
      idioma: 'en',
      estilo: 'direto',
      objetivo: 'vender',
      ofertaRadar: { number: 7, version: 3 },
      limites: { maxImagens: 10, maxRenderMin: 5 },
    });
    assert.equal(b.formato, 'vertical');
    assert.equal(b.duracaoAlvoSeg, 120);
    assert.equal(b.idioma, 'en');
    assert.equal(b.publico, 'investidores');
    assert.deepEqual(b.ofertaRadar, { number: 7, version: 3 });
    assert.deepEqual(b.limites, { maxImagens: 10, maxRenderMin: 5 });
  });

  test('tema vazio é erro: o NIGHT não inventa tema', () => {
    assert.throws(() => buildBrief({ tema: '   ', plataforma: 'shorts' }), /tema/);
    assert.throws(() => buildBrief({ plataforma: 'shorts' }), /tema/);
  });

  test('campo desconhecido é erro', () => {
    assert.throws(() => buildBrief({ tema: 'Tema', plataforma: 'shorts', cor: 'azul' }), /campo desconhecido/);
    assert.throws(
      () => buildBrief({ tema: 'Tema', plataforma: 'shorts', limites: { maxImagens: 2, maxRenderMin: 5, extra: 1 } }),
      /limites\.extra: campo desconhecido/,
    );
  });

  test('validateBrief junta todos os erros por campo em português', () => {
    const r = validateBrief({
      version: 'briefing-video/2',
      tema: '',
      publico: 7,
      idioma: 'xx',
      plataforma: 'kwai',
      formato: 'quadrado',
      duracaoAlvoSeg: 5,
      estilo: 2,
      objetivo: null,
      ofertaRadar: { number: 0, version: 1.5, extra: 1 },
      limites: { maxImagens: 0, maxRenderMin: -1, extra: 1 },
      sobra: true,
    });
    assert.equal(r.ok, false);
    if (r.ok) throw new Error('deveria falhar');
    const campos = r.errors.map((e) => e.campo);
    for (const esperado of [
      'sobra', 'version', 'tema', 'publico', 'idioma', 'plataforma', 'formato', 'duracaoAlvoSeg',
      'estilo', 'objetivo', 'ofertaRadar.number', 'ofertaRadar.version', 'ofertaRadar.extra',
      'limites.maxImagens', 'limites.maxRenderMin', 'limites.extra',
    ]) {
      assert.ok(campos.includes(esperado), `faltou o erro de ${esperado}`);
    }
    assert.ok(r.errors.some((e) => e.problema.includes('desconhecido')));
    assert.ok(r.errors.some((e) => e.problema.includes('não pode ser vazio')));
  });

  test('bordas de duração e de limite de imagens', () => {
    assert.equal(buildBrief({ tema: 'T', plataforma: 'shorts', duracaoAlvoSeg: 15 }).duracaoAlvoSeg, 15);
    assert.equal(buildBrief({ tema: 'T', plataforma: 'shorts', duracaoAlvoSeg: 600 }).duracaoAlvoSeg, 600);
    assert.throws(() => buildBrief({ tema: 'T', plataforma: 'shorts', duracaoAlvoSeg: 14.9 }), /duracaoAlvoSeg/);
    assert.throws(() => buildBrief({ tema: 'T', plataforma: 'shorts', duracaoAlvoSeg: 600.1 }), /duracaoAlvoSeg/);
    assert.equal(buildBrief({ tema: 'T', plataforma: 'shorts', limites: { maxImagens: 1, maxRenderMin: 1 } }).limites.maxImagens, 1);
    assert.equal(buildBrief({ tema: 'T', plataforma: 'shorts', limites: { maxImagens: 60, maxRenderMin: 1 } }).limites.maxImagens, 60);
    assert.throws(() => buildBrief({ tema: 'T', plataforma: 'shorts', limites: { maxImagens: 0, maxRenderMin: 1 } }), /maxImagens/);
    assert.throws(() => buildBrief({ tema: 'T', plataforma: 'shorts', limites: { maxImagens: 61, maxRenderMin: 1 } }), /maxImagens/);
  });

  test('validateBrief aceita um briefing completo e devolve o mesmo objeto', () => {
    const b = briefYoutube();
    const r = validateBrief(b);
    assert.equal(r.ok, true);
    if (!r.ok) throw new Error('deveria valer');
    assert.deepEqual(r.brief, b);
  });
});

describe('manifesto de cenas (V02)', () => {
  test('manifesto válido de 4 cenas passa sem avisos', () => {
    const r = validateManifest(manifestoValido());
    assert.equal(r.ok, true);
    if (!r.ok) throw new Error('deveria valer');
    assert.deepEqual(r.avisos, []);
    assert.equal(MANIFEST_VERSION, 'cenas/1');
    assert.equal(r.manifest.cenas.length, 4);
    assert.deepEqual(r.manifest.cenas.map((c) => c.n), [1, 2, 3, 4]);
    assert.equal(r.manifest.fontes.length, 2);
  });

  test('estrutura inválida: não é objeto e versão errada', () => {
    assert.equal(validateManifest(null).ok, false);
    assert.equal(validateManifest('texto').ok, false);
    const m = manifestoValido();
    m.version = 'cenas/2';
    assert.ok(errosDe(m).some((e) => e.campo === 'version'));
  });

  test('cenas precisam ser sequenciais de 1 a N', () => {
    const m = manifestoValido();
    m.cenas[2].n = 7;
    assert.ok(errosDe(m).some((e) => e.campo === 'cenas[2].n'));
    const vazio = manifestoValido();
    vazio.cenas = [];
    assert.ok(errosDe(vazio).some((e) => e.campo === 'cenas'));
  });

  test('fonte citada que não existe em fontes é erro', () => {
    const m = manifestoValido();
    m.cenas[1].afirmacoes[0].fonte = 'nao-existe';
    const erro = errosDe(m).find((e) => e.campo === 'cenas[1].afirmacoes[0].fonte');
    assert.ok(erro);
    assert.match(erro.problema, /não existe/);
  });

  test('URL de fonte só aceita http ou https', () => {
    for (const url of ['ftp://exemplo.com/a', 'nao-e-url', 'javascript:alert(1)']) {
      const m = manifestoValido();
      m.fontes[0].url = url;
      assert.ok(
        errosDe(m).some((e) => e.campo === 'fontes[0].url'),
        `URL ${url} deveria falhar`,
      );
    }
  });

  test('duração total fora de ±25% da meta do briefing é erro', () => {
    const curto = manifestoValido();
    for (const cena of curto.cenas) cena.duracaoEstimadaSeg = 10; // 40 s < 67,5 s
    assert.ok(errosDe(curto).some((e) => e.campo === 'cenas.duracaoTotal'));
    const longo = manifestoValido();
    for (const cena of longo.cenas) cena.duracaoEstimadaSeg = 30; // 120 s > 112,5 s
    assert.ok(errosDe(longo).some((e) => e.campo === 'cenas.duracaoTotal'));
  });

  test('mais cenas com imagem do que o limite do briefing é erro', () => {
    const m = manifestoValido();
    m.brief = briefYoutube({ limites: { maxImagens: 2, maxRenderMin: 15 } });
    assert.ok(errosDe(m).some((e) => e.campo === 'cenas.imagens'));

    const dentro = manifestoValido();
    dentro.brief = briefYoutube({ limites: { maxImagens: 2, maxRenderMin: 15 } });
    dentro.cenas[2].promptImagem = '';
    dentro.cenas[3].promptImagem = '';
    const r = validateManifest(dentro);
    assert.equal(r.ok, true);
  });

  test('aviso: afirmação sem fonte e sem dúvida', () => {
    const m = manifestoValido();
    m.cenas[1].afirmacoes[0] = { texto: 'Dado não confirmado', fonte: null, duvida: false };
    const avisos = avisosDe(m);
    assert.ok(avisos.some((a) => /cena 2: afirmação sem fonte e sem dúvida/.test(a)));
  });

  test('aviso: papel registro_real com prompt de imagem', () => {
    const m = manifestoValido();
    m.cenas[2].papelImagem = 'registro_real';
    const avisos = avisosDe(m);
    assert.ok(avisos.some((a) => /cena 3: papel "registro_real" com prompt/.test(a)));
  });

  test('aviso: imagem realista gerada por IA pede identificação', () => {
    const m = manifestoValido();
    m.cenas[3].realistaGeradaPorIA = true;
    const avisos = avisosDe(m);
    assert.ok(avisos.some((a) => /cena 4: imagem realista gerada por IA/.test(a)));
  });

  test('aviso: mesmo prompt em 3+ cenas é repetição visual', () => {
    const m = manifestoValido();
    for (const i of [0, 1, 2]) m.cenas[i].promptImagem = 'mesma imagem';
    const avisos = avisosDe(m);
    const aviso = avisos.find((a) => a.includes('repetição visual'));
    assert.ok(aviso);
    assert.match(aviso, /3 cenas/);

    // Duas cenas iguais ainda não são repetição.
    const duas = manifestoValido();
    duas.cenas[0].promptImagem = 'mesma imagem';
    duas.cenas[1].promptImagem = 'mesma imagem';
    assert.ok(!avisosDe(duas).some((a) => a.includes('repetição visual')));
  });

  test('readyForFinalRender: pronto quando não há pendência', () => {
    const manifest = manifestoDe(manifestoValido());
    assert.deepEqual(readyForFinalRender(manifest), { pronto: true, pendencias: [] });
  });

  test('readyForFinalRender: sem fonte, registro_real gerado e cena sem imagem', () => {
    const m = manifestoValido();
    m.cenas[0].afirmacoes[0] = { texto: 'Sem fonte', fonte: null, duvida: false };
    m.cenas[1].papelImagem = 'registro_real'; // tem prompt de imagem
    m.cenas[2].assetRef = null;
    const manifest = manifestoDe(m);
    const r = readyForFinalRender(manifest);
    assert.equal(r.pronto, false);
    assert.equal(r.pendencias.length, 3);
    assert.ok(r.pendencias.some((p) => /cena 1: afirmação sem fonte/.test(p)));
    assert.ok(r.pendencias.some((p) => /cena 2: "registro_real" gerado por prompt/.test(p)));
    assert.ok(r.pendencias.some((p) => /cena 3: sem imagem/.test(p)));
  });

  test('estimateDuration: palavras por segundo e arredondamento a 0,1', () => {
    assert.equal(estimateDuration('', 'pt-BR'), 0);
    assert.equal(estimateDuration('   ', 'en'), 0);
    assert.equal(estimateDuration('uma duas três quatro cinco', 'pt-BR'), 2); // 5 / 2,5
    assert.equal(estimateDuration('uma duas três quatro', 'pt-BR'), 1.6); // 4 / 2,5
    assert.equal(estimateDuration(Array(25).fill('palavra').join(' '), 'pt-BR'), 10);
    assert.equal(estimateDuration(Array(27).fill('word').join(' '), 'en'), 10);
    assert.equal(estimateDuration('a b c d', 'en'), 1.5); // 4 / 2,7 = 1,481...
  });

  test('sceneCacheKey muda só para a cena alterada', () => {
    const manifest = manifestoDe(manifestoValido());
    const chaves = manifest.cenas.map((c) => sceneCacheKey(c, manifest.brief));
    assert.equal(new Set(chaves).size, 4);
    assert.ok(chaves.every((k) => /^[a-f0-9]{64}$/.test(k)));

    const alterada = { ...manifest.cenas[1]!, narracao: 'Narração alterada' };
    const depois = manifest.cenas.map((c, i) =>
      i === 1 ? sceneCacheKey(alterada, manifest.brief) : sceneCacheKey(c, manifest.brief),
    );
    assert.notEqual(depois[1], chaves[1]);
    assert.equal(depois[0], chaves[0]);
    assert.equal(depois[2], chaves[2]);
    assert.equal(depois[3], chaves[3]);

    // Mudar o estilo do briefing muda a chave de todas (é insumo do cache).
    const briefNovo = { ...manifest.brief, estilo: 'outro estilo' };
    assert.notEqual(sceneCacheKey(manifest.cenas[0]!, briefNovo), chaves[0]);
  });
});
