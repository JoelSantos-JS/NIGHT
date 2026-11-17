// Produto low-ticket (L01 + L02): conteúdo dos PDFs com validação e parecer, conversão
// Markdown -> HTML/PDF e gravação no ArtifactStore. Gerador, conselheiro e processo do
// navegador são falsos: nada aqui chama modelo nem abre o Edge.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { AdvisorInput } from '../src/advisor/opinion.ts';
import type { ConsultResult } from '../src/advisor/service.ts';
import { ArtifactStore } from '../src/artifacts/store.ts';
import { generateProductContent } from '../src/lowticket/content.ts';
import type { ProductAdvisor } from '../src/lowticket/content.ts';
import {
  buildProductPdfs,
  CHROME_CANDIDATES,
  EDGE_CANDIDATES,
  fileUrl,
  findBrowser,
  htmlToPdf,
  markdownToHtml,
} from '../src/lowticket/pdf.ts';
import type { PdfRunner } from '../src/lowticket/pdf.ts';
import { PROPOSAL_VERSION } from '../src/radar/offer.ts';
import type { OfferProposal, ProposalMessage } from '../src/radar/offer.ts';

// --- Falsos ---

/** Gerador falso: responde pela função dada e guarda as mensagens de cada chamada. */
class FakeGenerator {
  readonly calls: ProposalMessage[][] = [];

  constructor(private readonly responder: (chamada: number) => string) {}

  async generate(mensagens: ProposalMessage[]): Promise<string> {
    this.calls.push([...mensagens]);
    return this.responder(this.calls.length);
  }
}

/** Conselheiro falso: guarda a entrada e responde pela função dada. */
class FakeAdvisor implements ProductAdvisor {
  readonly calls: { pointId: string; input: AdvisorInput }[] = [];

  constructor(private readonly responder: (input: AdvisorInput) => ConsultResult) {}

  async consult(pointId: string, input: AdvisorInput): Promise<ConsultResult> {
    this.calls.push({ pointId, input });
    return this.responder(input);
  }
}

function parecerOk(input: AdvisorInput): ConsultResult {
  return {
    status: 'ok',
    entryId: 'parecer-1',
    opinion: {
      version: 'parecer/1',
      jobId: input.jobId,
      fase: input.fase,
      recomendacao: 'revisar',
      motivos: ['faltam fontes em uma afirmação do capítulo 2'],
      evidencias: [],
      contrapontos: [],
      lacunas: ['afirmação sem link no capítulo 2'],
      proximoTeste: 'citar a fonte do capítulo 2',
      confianca: 'media',
    },
  };
}

// --- Dados de teste ---

/** Recheio neutro para passar das 600 palavras sem cair em termo proibido. */
const RECHEIO = Array.from({ length: 650 }, (_, i) => `passo${i + 1}`).join(' ');

function markdownValido(titulo = 'Guia Prático', extra = ''): string {
  return [
    `# ${titulo}`,
    '',
    'Um guia curto para organizar a rotina em casa.',
    '',
    '## Entenda o problema',
    '',
    `Este capítulo apresenta o começo. ${RECHEIO}`,
    '',
    '### Um detalhe importante',
    '',
    'Use **negrito** para destacar e *itálico* para dar ênfase.',
    '',
    '## Monte o seu plano',
    '',
    '- primeiro item do plano',
    '- segundo item do plano',
    '',
    '## Checklist prático',
    '',
    '1. conferir o primeiro passo',
    '2. conferir o segundo passo',
    '',
    '## Próximos passos',
    '',
    'Revise o que aprendeu e escolha um passo por dia.',
    extra,
    '',
  ].join('\n');
}

function ofertaCom(pdfs: number, bonus: string[] = []): OfferProposal {
  return {
    version: PROPOSAL_VERSION,
    nome: 'Rotina Leve',
    posicionamento: 'Guia curto para organizar o dia',
    publico: 'Pessoas que trabalham em casa',
    problema: 'O dia termina sem foco',
    promessa: 'Montar uma rotina semanal com um modelo para preencher',
    diferencial: 'Modelo próprio de uma página',
    entregaveis: Array.from({ length: pdfs }, (_, i) => ({
      titulo: `Guia ${i + 1}`,
      formato: 'pdf' as const,
      descricao: `Parte ${i + 1} da rotina`,
    })),
    bonus: [...bonus],
    precoHipotese: { valor: 19.9, moeda: 'BRL', justificativa: 'Faixa de entrada', ehHipotese: true },
    paginaDeVendas: ['promessa', 'problema', 'entregáveis', 'preço', 'dúvidas'],
    angulosCriativo: ['antes e depois', 'erros comuns', 'rotina real', 'pergunta direta', 'checklist'],
    objecoes: [],
    evidencias: [],
    duvidas: [],
    motivoParaDescartar: 'Se a rotina mudar, o guia perde utilidade',
    alternativas: [],
  };
}

/** O caminho que o navegador falso deve gravar, lido do argumento --print-to-pdf. */
function alvoDoArgs(args: string[]): string {
  const arg = args.find((valor) => valor.startsWith('--print-to-pdf='));
  assert.ok(arg, 'faltou o argumento --print-to-pdf');
  return arg.slice('--print-to-pdf='.length);
}

describe('conteúdo do produto low-ticket (L01)', () => {
  test('oferta com 4 PDFs e bônus gera 5 itens válidos e registra o parecer', async () => {
    const generator = new FakeGenerator(() => markdownValido());
    const advisor = new FakeAdvisor((input) => parecerOk(input));

    const resultado = await generateProductContent(
      { generator: (mensagens) => generator.generate(mensagens), advisor },
      { jobId: 'job-produto', offer: ofertaCom(4, ['Modelo extra de agenda']), concorrentes: [] },
    );

    assert.equal(resultado.itens.length, 5);
    assert.deepEqual(resultado.itens.map((item) => item.tipo), ['pdf', 'pdf', 'pdf', 'pdf', 'bonus']);
    assert.deepEqual(resultado.itens.map((item) => item.nome), [
      'Guia 1', 'Guia 2', 'Guia 3', 'Guia 4', 'Modelo extra de agenda',
    ]);
    for (const item of resultado.itens) {
      assert.equal(item.status, 'ok');
      assert.equal(item.errors, undefined);
      assert.match(item.markdown, /^# /);
    }
    assert.equal(generator.calls.length, 5, 'uma chamada por item');
    assert.ok(resultado.avisos.some((aviso) => aviso.includes('7 dias')));

    // O parecer recebe a promessa e os títulos de seções de cada item.
    assert.equal(advisor.calls.length, 1);
    assert.equal(advisor.calls[0]!.pointId, 'lowticket.produto');
    const entrada = advisor.calls[0]!.input;
    assert.equal(entrada.evidencias[0]!.conteudo, 'Montar uma rotina semanal com um modelo para preencher');
    assert.ok(entrada.proposta?.includes('promessa: Montar uma rotina semanal'));
    assert.ok(entrada.proposta?.includes('Entenda o problema'));
    assert.ok(entrada.proposta?.includes('Guia 1 (ok)'));
    assert.equal(resultado.parecer?.status, 'ok');
    assert.ok(resultado.avisos.some((aviso) => aviso.includes('decisão do Joel')));
  });

  test('primeira resposta inválida e segunda válida: devolve os erros e corrige', async () => {
    const generator = new FakeGenerator((chamada) => (chamada === 1
      ? '# Curto demais\n\n## Só uma seção\n\ntexto curto'
      : markdownValido()));

    const resultado = await generateProductContent(
      { generator: (mensagens) => generator.generate(mensagens) },
      { jobId: 'job-produto', offer: ofertaCom(1), concorrentes: [] },
    );

    assert.equal(resultado.itens.length, 1);
    assert.equal(resultado.itens[0]!.status, 'ok');
    assert.equal(generator.calls.length, 2);

    const correcao = generator.calls[1]!.at(-1)!;
    assert.equal(correcao.role, 'user');
    assert.match(correcao.content, /recusada pela validação/);
    assert.match(correcao.content, /seções/);
    assert.match(correcao.content, /palavras/);
  });

  test('duas respostas com promessa de lucro ficam inválidas com os erros', async () => {
    const generator = new FakeGenerator(
      () => markdownValido('Guia', '\n\nCom este plano você tem lucro garantido todo mês.'),
    );

    const resultado = await generateProductContent(
      { generator: (mensagens) => generator.generate(mensagens) },
      { jobId: 'job-produto', offer: ofertaCom(1), concorrentes: [], maxTentativas: 2 },
    );

    assert.equal(generator.calls.length, 2, 'as duas tentativas são usadas');
    const item = resultado.itens[0]!;
    assert.equal(item.status, 'invalido');
    assert.ok(item.errors?.some((erro) => erro.includes('promessa proibida: lucro')));
    assert.ok(item.errors?.some((erro) => erro.includes('promessa proibida: garantido')));
    assert.ok(resultado.avisos.some((aviso) => aviso.includes('1 item(ns) inválido(s)')));
  });

  test('conteúdo que copia 8 palavras do concorrente é recusado', async () => {
    const concorrente = 'Aprenda a vender todos os dias sem gastar muito dinheiro em anúncios';
    const generator = new FakeGenerator(() => markdownValido('Guia', `\n\n${concorrente}`));

    const resultado = await generateProductContent(
      { generator: (mensagens) => generator.generate(mensagens) },
      { jobId: 'job-produto', offer: ofertaCom(1), concorrentes: [concorrente], maxTentativas: 1 },
    );

    const item = resultado.itens[0]!;
    assert.equal(item.status, 'invalido');
    assert.ok(item.errors?.some((erro) => erro.includes('copia trecho de 8')));
  });
});

describe('Markdown -> HTML -> PDF (L02)', () => {
  test('markdownToHtml escapa HTML, monta capa, sumário e quebra de página', () => {
    const md = [
      '# Título do Guia',
      '',
      'Subtítulo com <script>alert(1)</script>',
      '',
      '## Primeiro capítulo',
      '',
      'Texto com <b>html cru</b> e um [link](https://exemplo.com?a=1&b=2).',
      '',
      '## Segundo capítulo',
      '',
      '- item com **negrito** e *itálico*',
      '',
      '## Terceiro capítulo',
      '',
      '> uma citação curta',
      '',
      '---',
      '',
      'Fim do material.',
    ].join('\n');

    const html = markdownToHtml(md, { titulo: 'Guia 1', marca: 'Marca NIGHT' });

    // Nada de HTML cru do modelo passa.
    assert.ok(!html.includes('<script>'), 'script não pode virar tag');
    assert.ok(!html.includes('<b>'), 'tag crua não pode passar');
    assert.ok(html.includes('&lt;script&gt;'));
    assert.ok(html.includes('&lt;b&gt;html cru&lt;/b&gt;'));

    // Capa, sumário e capítulos.
    assert.ok(html.includes('Título do Guia'));
    assert.ok(html.includes('Subtítulo com'));
    assert.ok(html.includes('Marca NIGHT'));
    assert.ok(html.includes('Sumário'));
    assert.ok(html.includes('href="#sec-1"'));
    assert.ok(html.includes('href="#sec-3"'));
    assert.ok(html.includes('<strong>negrito</strong>'));
    assert.ok(html.includes('<em>itálico</em>'));
    assert.ok(html.includes('<blockquote>uma citação curta</blockquote>'));
    assert.ok(html.includes('<hr>'));
    assert.ok(html.includes('https://exemplo.com?a=1&amp;b=2'));

    // Impressão: quebra de página antes de cada capítulo e numeração via @page.
    assert.ok(html.includes('page-break-before: always'));
    assert.ok(html.includes('@page'));
    assert.ok(html.includes('counter(page)'));
  });

  test('htmlToPdf monta os argumentos e recusa saída sem %PDF', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'night-pdf-'));
    try {
      const htmlPath = join(dir, 'guia.html');
      const pdfPath = join(dir, 'guia.pdf');
      await writeFile(htmlPath, markdownToHtml('# Guia\n\n## Um\n\n## Dois\n\n## Três', { titulo: 'Guia' }));

      let chamada: { bin: string; args: string[] } | null = null;
      const run: PdfRunner = async (bin, args) => {
        chamada = { bin, args };
        await writeFile(alvoDoArgs(args), '%PDF-1.4\nconteudo');
        return { code: 0, stderr: '' };
      };
      const navegador = 'C:/Program Files/Microsoft/Edge/Application/msedge.exe';
      await htmlToPdf(htmlPath, pdfPath, run, navegador);

      assert.equal(chamada!.bin, navegador);
      assert.deepEqual(chamada!.args, [
        '--headless',
        '--disable-gpu',
        '--no-pdf-header-footer',
        `--print-to-pdf=${pdfPath}`,
        fileUrl(htmlPath),
      ]);
      assert.match(fileUrl(htmlPath), /^file:\/\/\//);
      assert.equal(await readFile(pdfPath, 'utf8'), '%PDF-1.4\nconteudo');

      // Saída que não começa com %PDF é recusada.
      const runRuim: PdfRunner = async (_bin, args) => {
        await writeFile(alvoDoArgs(args), 'isto nao e um pdf');
        return { code: 0, stderr: '' };
      };
      await assert.rejects(
        () => htmlToPdf(htmlPath, join(dir, 'ruim.pdf'), runRuim, navegador),
        /%PDF/,
      );

      // Sem navegador, o erro diz o que fazer.
      await assert.rejects(
        () => htmlToPdf(htmlPath, join(dir, 'sem.pdf'), run, null),
        /navegador não encontrado/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('findBrowser dá prioridade ao env e depois procura Edge e Chrome', () => {
    assert.equal(
      findBrowser({ NIGHT_PDF_BROWSER: 'C:/navegador/edge.exe' }, () => false),
      'C:/navegador/edge.exe',
    );
    const edge = EDGE_CANDIDATES[0]!;
    assert.equal(findBrowser({}, (caminho) => caminho === edge), edge);
    const chrome = CHROME_CANDIDATES[0]!;
    assert.equal(findBrowser({}, (caminho) => caminho === chrome), chrome);
    assert.equal(findBrowser({}, () => false), null);
  });

  test('buildProductPdfs grava 5 PDFs no store com verify ok', async () => {
    const base = await mkdtemp(join(tmpdir(), 'night-lowticket-'));
    try {
      const store = new ArtifactStore(join(base, 'artefatos'));
      const workDir = join(base, 'pdf');
      const generator = new FakeGenerator(() => markdownValido());
      const conteudo = await generateProductContent(
        { generator: (mensagens) => generator.generate(mensagens) },
        { jobId: 'job-lowticket', offer: ofertaCom(4, ['Modelo extra de agenda']), concorrentes: [] },
      );

      const run: PdfRunner = async (_bin, args) => {
        const alvo = alvoDoArgs(args);
        await writeFile(alvo, `%PDF-1.4\nteste ${alvo}`);
        return { code: 0, stderr: '' };
      };

      const pdfs = await buildProductPdfs(store, 'job-lowticket', conteudo.itens, {
        workDir,
        marca: 'Marca NIGHT',
        run,
        browser: 'C:/fake/msedge.exe',
      });

      assert.deepEqual(pdfs.map((pdf) => pdf.arquivo), [
        'produto-1-guia-1.pdf',
        'produto-2-guia-2.pdf',
        'produto-3-guia-3.pdf',
        'produto-4-guia-4.pdf',
        'bonus-modelo-extra-de-agenda.pdf',
      ]);
      for (const pdf of pdfs) {
        assert.match(pdf.sha256, /^[0-9a-f]{64}$/);
        assert.ok(existsSync(pdf.html), `HTML deveria existir: ${pdf.html}`);
      }

      const html = await readFile(pdfs[0]!.html, 'utf8');
      assert.ok(html.includes('Marca NIGHT'));

      const manifest = await store.manifest('job-lowticket');
      assert.equal(manifest?.items.length, 5);
      for (const item of manifest!.items) {
        assert.equal(item.origin, 'lowticket');
        assert.equal(item.kind, 'pdf');
      }
      assert.deepEqual(manifest!.items.map((item) => item.sha256), pdfs.map((pdf) => pdf.sha256));
      assert.deepEqual(
        await store.verify('job-lowticket'),
        { ok: true, missing: [], changed: [], extra: [] },
      );
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
