// Trabalhador do produto low-ticket (L07 + orquestração de L01–L03).
// Banco, links, gerador e processo do navegador são falsos: nada aqui chama Postgres,
// modelo ou Edge. O que se prova: oferta não aprovada não gera nada; sem gerador o
// trabalho espera; o fluxo completo junta PDFs, bônus, página e pacote; sem checkout o
// botão fica desabilitado; a retomada não repete o gerador; start é idempotente enquanto ativo.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { ArtifactStore } from '../src/artifacts/store.ts';
import { ArtifactStore as Store } from '../src/artifacts/store.ts';
import { WORKER_CONTRACT } from '../src/jobs/worker.ts';
import type { WorkerRequest, WorkerResult } from '../src/jobs/worker.ts';
import type { LinkField, OfferLinks, OfferLinksStore } from '../src/lowticket/links.ts';
import type { PdfRunner } from '../src/lowticket/pdf.ts';
import { LowticketWorker, PUBLICACAO_DO_PACOTE } from '../src/lowticket/worker.ts';
import type { PacoteProduto } from '../src/lowticket/worker.ts';
import { PROPOSAL_VERSION } from '../src/radar/offer.ts';
import type { OfferProposal, ProposalMessage } from '../src/radar/offer.ts';

// --- Falsos ---

interface OfertaFalsa {
  number: number;
  version: number;
  status: string;
  proposal: Record<string, unknown>;
}

/** Banco de ofertas falso: devolve a mais nova, ou a versão pedida. */
class FakeOffers {
  constructor(private readonly ofertas: OfertaFalsa[]) {}

  async getOffer(number: number, version?: number): Promise<OfertaFalsa | null> {
    const daOferta = this.ofertas.filter((oferta) => oferta.number === number);
    if (version !== undefined) return daOferta.find((oferta) => oferta.version === version) ?? null;
    return daOferta.sort((a, b) => b.version - a.version)[0] ?? null;
  }
}

/** Links falsos: só o checkout importa para a página de vendas. */
class FakeLinks implements OfferLinksStore {
  constructor(private readonly checkoutUrl: string | null = null) {}

  async get(offerNumber: number): Promise<OfferLinks> {
    return { offerNumber, paginaUrl: null, checkoutUrl: this.checkoutUrl, imagens: [] };
  }

  async set(offerNumber: number, _field: LinkField, _value: string | string[]): Promise<OfferLinks> {
    return this.get(offerNumber);
  }
}

/** Gerador falso: responde pela função dada e guarda cada chamada. */
class FakeGenerator {
  readonly calls: ProposalMessage[][] = [];

  constructor(private readonly responder: (chamada: number) => string = () => markdownValido()) {}

  async generate(mensagens: ProposalMessage[]): Promise<string> {
    this.calls.push([...mensagens]);
    return this.responder(this.calls.length);
  }
}

/** Gerador que segura a execução até o teste liberar, para provar o start idempotente. */
class GateGenerator {
  calls = 0;
  private liberar!: () => void;
  private readonly portao = new Promise<void>((resolve) => { this.liberar = resolve; });

  async generate(_mensagens: ProposalMessage[]): Promise<string> {
    this.calls += 1;
    await this.portao;
    return markdownValido();
  }

  abrir(): void {
    this.liberar();
  }
}

// --- Dados de teste ---

/** Recheio neutro para passar das 600 palavras sem cair em termo proibido. */
const RECHEIO = Array.from({ length: 650 }, (_, i) => `passo${i + 1}`).join(' ');

function markdownValido(titulo = 'Guia Prático'): string {
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
    '',
  ].join('\n');
}

function proposta(): OfferProposal {
  return {
    version: PROPOSAL_VERSION,
    nome: 'Rotina Leve',
    posicionamento: 'Guia curto para organizar o dia',
    publico: 'Pessoas que trabalham em casa',
    problema: 'O dia termina sem foco',
    promessa: 'Montar uma rotina semanal com um modelo para preencher',
    diferencial: 'Modelo próprio de uma página',
    entregaveis: [
      { titulo: 'Guia 1', formato: 'pdf', descricao: 'Parte 1 da rotina' },
      { titulo: 'Guia 2', formato: 'pdf', descricao: 'Parte 2 da rotina' },
      { titulo: 'Guia 3', formato: 'pdf', descricao: 'Parte 3 da rotina' },
      { titulo: 'Guia 4', formato: 'pdf', descricao: 'Parte 4 da rotina' },
    ],
    bonus: ['Modelo extra de agenda'],
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

function oferta(over: Partial<OfertaFalsa> = {}): OfertaFalsa {
  return {
    number: 2,
    version: 1,
    status: 'aprovada',
    proposal: proposta() as unknown as Record<string, unknown>,
    ...over,
  };
}

/** O caminho que o navegador falso deve gravar, lido do argumento --print-to-pdf. */
function alvoDoArgs(args: string[]): string {
  const arg = args.find((valor) => valor.startsWith('--print-to-pdf='));
  assert.ok(arg, 'faltou o argumento --print-to-pdf');
  return arg.slice('--print-to-pdf='.length);
}

/** Navegador falso: grava um PDF mínimo que começa com %PDF. */
const pdfRunOk: PdfRunner = async (_bin, args) => {
  const alvo = alvoDoArgs(args);
  await writeFile(alvo, `%PDF-1.4\nteste ${alvo}`);
  return { code: 0, stderr: '' };
};

/** Navegador que falha na primeira chamada: o conteúdo já fica pronto para a retomada. */
function pdfRunQueFalhaNaPrimeira(): PdfRunner {
  let primeira = true;
  return async (_bin, args) => {
    if (primeira) {
      primeira = false;
      return { code: 1, stderr: 'falha simulada na primeira chamada' };
    }
    const alvo = alvoDoArgs(args);
    await writeFile(alvo, `%PDF-1.4\nteste ${alvo}`);
    return { code: 0, stderr: '' };
  };
}

describe('trabalhador do produto low-ticket', () => {
  let base: string;
  let artifacts: ArtifactStore;

  before(async () => {
    base = await mkdtemp(join(tmpdir(), 'night-lowticket-worker-'));
    artifacts = new Store(join(base, 'artefatos'));
  });
  after(async () => {
    await rm(base, { recursive: true, force: true });
  });

  function pedido(jobId: string, offerNumber = 2): WorkerRequest {
    return {
      contract: WORKER_CONTRACT,
      jobId,
      kind: 'lowticket',
      params: { offerNumber },
      limits: {},
    };
  }

  /** start + espera o fim sem polling; devolve runId e resultado. */
  async function rodar(
    worker: LowticketWorker, request: WorkerRequest,
  ): Promise<{ runId: string; result: WorkerResult }> {
    const { runId } = await worker.start(request);
    await worker.whenDone(runId);
    return { runId, result: await worker.result(runId) };
  }

  async function lerPacote(jobId: string, versao = 1): Promise<PacoteProduto> {
    const texto = await readFile(join(artifacts.root, jobId, `pacote-produto-v${versao}.json`), 'utf8');
    return JSON.parse(texto) as PacoteProduto;
  }

  test('oferta não aprovada falha antes de chamar o gerador', async () => {
    const jobId = 'job-nao-aprovada';
    const generator = new FakeGenerator();
    const worker = new LowticketWorker({
      offers: new FakeOffers([oferta({ status: 'rascunho' })]),
      links: new FakeLinks(),
      artifacts,
      generator: (mensagens) => generator.generate(mensagens),
      workDir: join(base, jobId),
    });

    const { result } = await rodar(worker, pedido(jobId));

    assert.equal(result.state, 'failed');
    assert.match(result.error ?? '', /a oferta 2 não está aprovada: aprove antes de gerar o produto/);
    assert.equal(generator.calls.length, 0, 'oferta não aprovada nunca gera produto');
    assert.deepEqual(result.artifacts, []);
  });

  test('sem gerador: espera gerador sem gerar conteúdo', async () => {
    const jobId = 'job-sem-gerador';
    const worker = new LowticketWorker({
      offers: new FakeOffers([oferta()]),
      links: new FakeLinks(),
      artifacts,
      generator: null,
      workDir: join(base, jobId),
    });

    const { result } = await rodar(worker, pedido(jobId));

    assert.equal(result.state, 'waiting');
    assert.equal(result.waitingFor, 'gerador');
    assert.match(result.message ?? '', /falta o gerador/);
    assert.deepEqual(result.artifacts, []);
    assert.equal(await artifacts.manifest(jobId), null);
  });

  test('fluxo completo grava 4 PDFs, bônus, página e pacote com verify ok', async () => {
    const jobId = 'job-fluxo';
    const generator = new FakeGenerator();
    const worker = new LowticketWorker({
      offers: new FakeOffers([oferta()]),
      links: new FakeLinks('https://pay.exemplo.com/checkout?oferta=2'),
      artifacts,
      generator: (mensagens) => generator.generate(mensagens),
      workDir: join(base, jobId),
      pdfRun: pdfRunOk,
    });

    const { result } = await rodar(worker, pedido(jobId));

    assert.equal(result.state, 'succeeded', result.error ?? '');
    assert.equal(generator.calls.length, 5, 'uma chamada por item: 4 PDFs e o bônus');
    assert.match(result.message ?? '', /pacote da oferta 2 pronto/);

    const manifesto = await artifacts.manifest(jobId);
    assert.ok(manifesto);
    const nomes = manifesto.items.map((item) => item.name);
    for (let n = 1; n <= 5; n++) assert.ok(nomes.includes(`conteudo-${n}.md`), `falta conteudo-${n}.md`);

    const pdfs = manifesto.items.filter((item) => item.kind === 'pdf');
    assert.equal(pdfs.length, 5);
    assert.equal(pdfs.filter((item) => item.name.startsWith('produto-')).length, 4);
    assert.equal(pdfs.filter((item) => item.name.startsWith('bonus-')).length, 1);
    assert.ok(nomes.includes('pagina-vendas-v1.html'));
    assert.ok(nomes.includes('pacote-produto-v1.json'));

    assert.deepEqual(
      await artifacts.verify(jobId),
      { ok: true, missing: [], changed: [], extra: [] },
    );

    const pacote = await lerPacote(jobId);
    assert.equal(pacote.offerNumber, 2);
    assert.equal(pacote.offerVersion, 1);
    assert.equal(pacote.publicacao, PUBLICACAO_DO_PACOTE);
    assert.deepEqual(pacote.invalidos, []);
    assert.equal(pacote.arquivos.length, 11, '5 Markdowns + 5 PDFs + página antes do pacote');
    assert.ok(pacote.arquivos.some((arquivo) => arquivo.nome === 'pagina-vendas-v1.html'));
    for (const arquivo of pacote.arquivos) assert.match(arquivo.sha256, /^[a-f0-9]{64}$/);
    assert.ok(result.artifacts.some((item) => item.name === 'pacote-produto-v1.json'));
  });

  test('sem checkout: página com botão desabilitado e aviso no pacote', async () => {
    const jobId = 'job-sem-checkout';
    const generator = new FakeGenerator();
    const worker = new LowticketWorker({
      offers: new FakeOffers([oferta()]),
      links: new FakeLinks(null),
      artifacts,
      generator: (mensagens) => generator.generate(mensagens),
      workDir: join(base, jobId),
      pdfRun: pdfRunOk,
    });

    const { result } = await rodar(worker, pedido(jobId));

    assert.equal(result.state, 'succeeded', result.error ?? '');
    assert.match(result.message ?? '', /falta o link de checkout/);

    const html = await readFile(join(artifacts.root, jobId, 'pagina-vendas-v1.html'), 'utf8');
    assert.match(html, /<button[^>]*disabled[^>]*>Link de pagamento ainda não definido<\/button>/);

    const pacote = await lerPacote(jobId);
    assert.ok(pacote.avisos.some((aviso) =>
      aviso.includes('falta o link de checkout')
      && aviso.includes("o checkout da oferta 2 é https://")));
  });

  test('retomada não chama o gerador para itens já prontos', async () => {
    const jobId = 'job-retomada';
    const generator = new FakeGenerator();
    const ofertas = [oferta()];

    // Primeira tentativa: conteúdo inteiro pronto, mas o PDF falha e o trabalho termina.
    const primeira = new LowticketWorker({
      offers: new FakeOffers(ofertas),
      links: new FakeLinks('https://pay.exemplo.com/checkout?oferta=2'),
      artifacts,
      generator: (mensagens) => generator.generate(mensagens),
      workDir: join(base, jobId),
      pdfRun: pdfRunQueFalhaNaPrimeira(),
    });
    const inicial = await rodar(primeira, pedido(jobId));
    assert.equal(inicial.result.state, 'failed');
    assert.equal(generator.calls.length, 5);

    const manifestoInicial = await artifacts.manifest(jobId);
    assert.equal(
      manifestoInicial?.items.filter((item) => item.kind === 'conteudo').length, 5,
      'os Markdowns ficam prontos para a retomada',
    );
    assert.equal(manifestoInicial?.items.filter((item) => item.kind === 'pdf').length, 0);

    // Retomada: o store já tem os Markdowns, então o gerador não é chamado de novo.
    const segunda = new LowticketWorker({
      offers: new FakeOffers(ofertas),
      links: new FakeLinks('https://pay.exemplo.com/checkout?oferta=2'),
      artifacts,
      generator: (mensagens) => generator.generate(mensagens),
      workDir: join(base, jobId),
      pdfRun: pdfRunOk,
    });
    const retomada = await rodar(segunda, pedido(jobId));
    assert.equal(retomada.result.state, 'succeeded', retomada.result.error ?? '');
    assert.equal(generator.calls.length, 5, 'itens prontos não chamam o gerador de novo');

    const manifestoFinal = await artifacts.manifest(jobId);
    for (let n = 1; n <= 5; n++) {
      const conteudo = manifestoFinal?.items.find((item) => item.name === `conteudo-${n}.md`);
      assert.equal(conteudo?.version, 1, 'Markdown reaproveitado não muda de versão');
    }
    assert.equal(manifestoFinal?.items.filter((item) => item.kind === 'pdf').length, 5);
    assert.deepEqual(
      await artifacts.verify(jobId),
      { ok: true, missing: [], changed: [], extra: [] },
    );
  });

  test('start é idempotente enquanto a execução está ativa', async () => {
    const jobId = 'job-idempotente';
    const generator = new GateGenerator();
    const worker = new LowticketWorker({
      offers: new FakeOffers([oferta()]),
      links: new FakeLinks('https://pay.exemplo.com/checkout?oferta=2'),
      artifacts,
      generator: (mensagens) => generator.generate(mensagens),
      workDir: join(base, jobId),
      pdfRun: pdfRunOk,
    });

    const primeiro = await worker.start(pedido(jobId));
    const segundo = await worker.start(pedido(jobId));

    assert.equal(segundo.runId, primeiro.runId, 'execução ativa devolve o mesmo runId');
    assert.equal((await worker.status(primeiro.runId)).state, 'running');

    generator.abrir();
    await worker.whenDone(primeiro.runId);
    const result = await worker.result(primeiro.runId);

    assert.equal(result.state, 'succeeded', result.error ?? '');
    assert.equal(generator.calls, 5, 'a execução não foi iniciada duas vezes');
  });
});