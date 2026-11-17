import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { ArtifactStore } from '../src/artifacts/store.ts';
import type { OfferProposal } from '../src/radar/offer.ts';
import { buildSalesPage, saveSalesPage } from '../src/lowticket/sales-page.ts';

/** Proposta aprovada mínima; os rótulos de página vêm acentuados de propósito. */
function proposta(over: Partial<OfferProposal> = {}): OfferProposal {
  return {
    version: 'oferta/1',
    nome: 'Rotina Enxuta',
    posicionamento: 'Guia curto de rotina para quem trabalha em casa',
    publico: 'Autônomos que trabalham de casa',
    problema: 'O dia termina sem foco',
    promessa: 'Montar uma rotina semanal em sete passos, com modelos para preencher',
    diferencial: 'Checklist próprio de uma página e exemplos reais',
    entregaveis: [
      { titulo: 'Mapa da rotina', formato: 'pdf', descricao: 'Um mapa de uma página para planejar a semana' },
      { titulo: 'Modelos de agenda', formato: 'pdf', descricao: 'Modelos para preencher no papel ou no computador' },
      { titulo: 'Checklist semanal', formato: 'pdf', descricao: 'Perguntas curtas para revisar a rotina' },
      { titulo: 'Plano de ajustes', formato: 'pdf', descricao: 'Um plano simples para corrigir o que não funcionou' },
    ],
    bonus: ['Modelo de agenda extra'],
    precoHipotese: {
      valor: 19.9,
      moeda: 'BRL',
      justificativa: 'Faixa de entrada do nicho, sem prova de venda',
      ehHipotese: true,
    },
    paginaDeVendas: ['promessa', 'problema', 'entregáveis', 'preço', 'dúvidas'],
    angulosCriativo: ['antes e depois', 'lista de erros', 'rotina real', 'pergunta direta', 'prova simples'],
    objecoes: [
      { objecao: 'Não tenho tempo', resposta: 'Os modelos levam minutos para preencher' },
      { objecao: 'Já tentei antes', resposta: 'O guia começa por um único hábito' },
      { objecao: 'Serve para mim?', resposta: 'Há exemplos para rotinas diferentes' },
    ],
    evidencias: [{ candidateId: 'cand-1', oQueSustenta: 'Anúncio ativo há 40 dias no nicho' }],
    duvidas: ['A demanda pode ser sazonal', 'O preço pode ser alto para o público'],
    motivoParaDescartar: 'Se a rotina mudar, o guia perde utilidade',
    alternativas: [],
    ...over,
  };
}

describe('página de vendas low-ticket', () => {
  test('traz as seções pedidas, os 4 entregáveis e o bônus', () => {
    const html = buildSalesPage(proposta(), { checkoutUrl: null });
    const titulos = [
      'Para quem é',
      'O problema',
      'A solução',
      'O que você recebe',
      'Preço',
      'Garantia',
      'Perguntas frequentes',
      'Pronto para começar?',
    ];
    for (const titulo of titulos) {
      assert.ok(html.includes(titulo), `falta a seção "${titulo}"`);
    }
    for (const item of proposta().entregaveis) {
      assert.ok(html.includes(item.titulo), `falta o entregável "${item.titulo}"`);
      assert.ok(html.includes(item.descricao), `falta a descrição de "${item.titulo}"`);
    }
    assert.equal((html.match(/class="formato"/g) ?? []).length, 4);
    assert.ok(html.includes('Bônus (liberado após 7 dias)'));
    assert.ok(html.includes('Modelo de agenda extra'));
  });

  test('segue a ordem de paginaDeVendas e completa o que falta', () => {
    const html = buildSalesPage(proposta(), { checkoutUrl: null });
    const posicao = (texto: string): number => html.indexOf(texto);
    assert.ok(posicao('Para quem é') < posicao('O problema'));
    assert.ok(posicao('O problema') < posicao('O que você recebe'));
    assert.ok(posicao('O que você recebe') < posicao('Preço'));
    assert.ok(posicao('Preço') < posicao('Perguntas frequentes'));
    assert.ok(posicao('Perguntas frequentes') < posicao('Pronto para começar?'));
  });

  test('mostra o preço no formato brasileiro', () => {
    const html = buildSalesPage(proposta(), { checkoutUrl: null });
    assert.ok(html.includes('R$ 19,90'));
  });

  test('escapa todo texto vindo da oferta', () => {
    const html = buildSalesPage(proposta({
      nome: '<b>Rotina</b>',
      publico: 'Público <script>alert("xss")</script>',
      problema: '<img src=x onerror=alert(2)>',
      bonus: ['<em>bonus</em>'],
      objecoes: [{ objecao: '<iframe>pergunta</iframe>', resposta: '<svg onload=alert(3)>' }],
    }), { checkoutUrl: null });
    assert.ok(!html.includes('<script>'));
    assert.ok(!html.includes('<img src=x'));
    assert.ok(!html.includes('<em>bonus</em>'));
    assert.ok(!html.includes('<iframe>'));
    assert.ok(!html.includes('<svg onload'));
    assert.ok(html.includes('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'));
    assert.ok(html.includes('&lt;b&gt;Rotina&lt;/b&gt;'));
    assert.ok(html.includes('&lt;em&gt;bonus&lt;/em&gt;'));
  });

  test('sem checkout, o botão fica desabilitado e não inventa link', () => {
    const html = buildSalesPage(proposta(), { checkoutUrl: null });
    assert.match(html, /<button[^>]*disabled[^>]*>Link de pagamento ainda não definido<\/button>/);
    assert.ok(!/href="https?:/.test(html));
  });

  test('com checkout válido, o botão usa a URL e rel=noopener', () => {
    const html = buildSalesPage(proposta(), {
      checkoutUrl: 'https://pay.exemplo.com/checkout?oferta=2',
    });
    assert.ok(html.includes('href="https://pay.exemplo.com/checkout?oferta=2"'));
    assert.match(html, /rel="noopener"/);
    assert.ok(!html.includes('Link de pagamento ainda não definido'));
  });

  test('checkout http:// ou inválido lança erro', () => {
    assert.throws(
      () => buildSalesPage(proposta(), { checkoutUrl: 'http://pay.exemplo.com' }),
      /https/,
    );
    assert.throws(
      () => buildSalesPage(proposta(), { checkoutUrl: 'nao-e-url' }),
      /https/,
    );
    assert.throws(
      () => buildSalesPage(proposta(), { checkoutUrl: 'https://' }),
      /https/,
    );
  });

  test('perguntas frequentes vêm das objeções', () => {
    const html = buildSalesPage(proposta(), { checkoutUrl: null });
    for (const item of proposta().objecoes) {
      assert.ok(html.includes(item.objecao));
      assert.ok(html.includes(item.resposta));
    }
    assert.equal((html.match(/<details>/g) ?? []).length, 3);
  });

  test('não usa depoimento, contagem de compradores nem escassez fabricada', () => {
    const html = buildSalesPage(proposta(), { checkoutUrl: null }).toLowerCase();
    for (const proibida of ['compraram', 'só hoje', 'últimas vagas', 'depoimento']) {
      assert.ok(!html.includes(proibida), `a página não pode dizer "${proibida}"`);
    }
  });

  test('declara viewport e essenciais de um arquivo HTML', () => {
    const html = buildSalesPage(proposta(), { checkoutUrl: null });
    assert.match(html, /^<!doctype html>/);
    assert.ok(html.includes('<html lang="pt-BR">'));
    assert.ok(html.includes('<meta name="viewport" content="width=device-width, initial-scale=1">'));
    assert.ok(html.includes('<style>'));
    assert.ok(!html.includes('<script'));
    assert.ok(html.includes('Este produto não promete renda nem resultado garantido.'));
  });

  test('grava a página versionada no ArtifactStore', async () => {
    const root = await mkdtemp(join(tmpdir(), 'night-pagina-'));
    try {
      const store = new ArtifactStore(root);
      const html = buildSalesPage(proposta(), { checkoutUrl: null, marca: 'NIGHT' });
      const item = await saveSalesPage(store, 'job-pagina', html, 1);
      assert.equal(item.name, 'pagina-vendas-v1.html');
      assert.equal(item.origin, 'lowticket');
      assert.equal(item.kind, 'html');
      assert.equal(await readFile(join(root, 'job-pagina', item.name), 'utf8'), html);
      assert.deepEqual(await store.verify('job-pagina'), {
        ok: true, missing: [], changed: [], extra: [],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

