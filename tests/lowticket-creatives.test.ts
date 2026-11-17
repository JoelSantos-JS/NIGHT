// Criativos do teste (L04): os 5 ângulos da oferta viram textos de anúncio e uma folha de
// prompts para o Joel gerar as imagens no Flow. Código puro: sem rede e sem modelo.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { ArtifactStore } from '../src/artifacts/store.ts';
import { buildCreatives, ESTILO_PROMPT_IMAGEM, writeCreativeSheet } from '../src/lowticket/creatives.ts';
import { promessasProibidas, PROPOSAL_VERSION, type OfferProposal } from '../src/radar/offer.ts';

const offer: OfferProposal = {
  version: PROPOSAL_VERSION,
  nome: 'Rotina Enxuta',
  posicionamento: 'Guia curto de rotina para quem trabalha em casa',
  publico: 'Autônomos que trabalham de casa',
  problema: 'O dia termina sem foco.',
  promessa: 'Monte uma rotina semanal em sete passos.',
  diferencial: 'Checklist de uma página',
  entregaveis: [1, 2, 3, 4].map((n) => ({ titulo: `PDF ${n}`, formato: 'pdf' as const, descricao: `parte ${n}` })),
  bonus: ['Modelo de agenda'],
  precoHipotese: { valor: 19.9, moeda: 'BRL', justificativa: 'entrada', ehHipotese: true },
  paginaDeVendas: ['promessa', 'problema', 'entregáveis', 'preço', 'dúvidas'],
  angulosCriativo: [
    'Antes e depois da semana',
    'Três erros de quem trabalha em casa',
    'Rotina real',
    'Pergunta direta',
    'Prova simples',
  ],
  objecoes: [],
  evidencias: [],
  duvidas: [],
  motivoParaDescartar: 'pode ser sazonal',
  alternativas: [],
};

/** Quantas frases o texto tem (o texto principal deve ter de 2 a 3). */
function contarFrases(texto: string): number {
  return texto.split(/(?<=[.!?])\s+/).filter(Boolean).length;
}

describe('criativos da oferta (L04)', () => {
  test('gera um criativo por ângulo, com título de até 40 e descrição de até 30', () => {
    const specs = buildCreatives(offer);
    assert.equal(specs.length, 5);
    assert.deepEqual(specs.map((s) => s.n), [1, 2, 3, 4, 5]);
    assert.deepEqual(specs.map((s) => s.angulo), offer.angulosCriativo);
    for (const spec of specs) {
      assert.ok(spec.titulo.length > 0 && spec.titulo.length <= 40, `título longo: "${spec.titulo}"`);
      assert.ok(spec.descricao.length > 0 && spec.descricao.length <= 30, `descrição longa: "${spec.descricao}"`);
      assert.equal(spec.cta, 'Saiba mais');
      const frases = contarFrases(spec.textoPrincipal);
      assert.ok(frases >= 2 && frases <= 3, `texto principal com ${frases} frase(s): "${spec.textoPrincipal}"`);
      assert.match(spec.textoPrincipal, /[.!?]$/);
      // Regras editoriais: nada de ganho, escassez inventada nem depoimento.
      assert.doesNotMatch(spec.textoPrincipal, /R\$|últimas vagas|depoimento/i);
      assert.deepEqual(promessasProibidas(spec.textoPrincipal), []);
    }
  });

  test('título de ângulo longo é cortado sem passar de 40 caracteres', () => {
    const longo = {
      ...offer,
      angulosCriativo: [
        'Um ângulo bem comprido para conferir o corte do título do anúncio',
        ...offer.angulosCriativo.slice(1),
      ],
    };
    const titulo = buildCreatives(longo)[0]!.titulo;
    assert.ok(titulo.length <= 40, `"${titulo}" tem ${titulo.length}`);
    assert.match(titulo, /…$/);
  });

  test('prompts em inglês compartilham o mesmo estilo e o formato pedido', () => {
    const specs = buildCreatives(offer);
    for (const spec of specs) {
      assert.ok(spec.promptImagem.includes(ESTILO_PROMPT_IMAGEM), 'prompt fora do mesmo estilo visual');
      assert.match(spec.promptImagem, /no text, no logos, no people's faces identifiable/);
      assert.match(spec.promptImagem, /4:5 aspect ratio/);
      assert.match(spec.promptImagem, /for a Brazilian self-employed professional working from home/);
      assert.doesNotMatch(spec.promptImagem, /R\$|print de ganhos/i);
    }
    // Cada ângulo tem a sua cena: os prompts não são todos iguais.
    assert.equal(new Set(specs.map((s) => s.promptImagem)).size, 5);
    const vertical = buildCreatives(offer, { formato: '9:16' });
    assert.match(vertical[0]!.promptImagem, /9:16 aspect ratio/);
    assert.doesNotMatch(vertical[0]!.promptImagem, /4:5 aspect ratio/);
  });

  test('usar a marca na descrição quando o Joel informar', () => {
    const specs = buildCreatives(offer, { marca: 'Rotina Enxuta' });
    assert.equal(specs[0]!.descricao, 'Rotina Enxuta');
    assert.ok(specs[0]!.descricao.length <= 30);
  });

  test('promessa proibida na oferta não vaza para o texto do anúncio', () => {
    const proibida = { ...offer, promessa: 'Renda garantida em 7 dias' };
    for (const spec of buildCreatives(proibida)) {
      assert.deepEqual(promessasProibidas(spec.textoPrincipal), []);
      assert.doesNotMatch(spec.textoPrincipal, /renda|garantia/i);
      assert.match(spec.textoPrincipal, /Veja o que vem no material\./);
      assert.ok(spec.textoPrincipal.includes(offer.problema), 'o problema continua no texto');
    }
  });
});

describe('folha de criativos para o Flow (L04)', () => {
  let root: string;
  let store: ArtifactStore;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'night-criativos-'));
    store = new ArtifactStore(root);
  });
  after(async () => { await rm(root, { recursive: true, force: true }); });

  test('grava a folha no ArtifactStore com as instruções e os 5 prompts', async () => {
    const specs = buildCreatives(offer);
    const item = await writeCreativeSheet(store, 'job-criativos', 2, specs);
    assert.equal(item.name, 'criativos-oferta-2.md');
    assert.equal(item.origin, 'lowticket');
    assert.equal(item.kind, 'texto');

    const conteudo = await readFile(join(root, 'job-criativos', 'criativos-oferta-2.md'), 'utf8');
    assert.match(conteudo, /# Criativos da oferta 2/);
    assert.match(conteudo, /Gere cada imagem no Flow/);
    assert.match(conteudo, /Publique cada imagem.*URL https/);
    assert.ok(conteudo.includes('"as imagens da oferta 2 são https://... https://..."'));
    assert.equal(conteudo.split('Prompt para o Flow:').length - 1, 5);
    for (const spec of specs) {
      assert.ok(conteudo.includes(`Prompt para o Flow: ${spec.promptImagem}`));
      assert.ok(conteudo.includes(`Título: ${spec.titulo}`));
      assert.ok(conteudo.includes(spec.angulo));
    }
    const manifest = await store.manifest('job-criativos');
    assert.deepEqual(manifest?.items.map((i) => i.name), ['criativos-oferta-2.md']);
    assert.equal(manifest?.items[0]?.kind, 'texto');
  });

  test('recusa número de oferta inválido em vez de inventar nome de arquivo', async () => {
    await assert.rejects(writeCreativeSheet(store, 'job-criativos', 0, []), /número da oferta inválido/);
  });
});
