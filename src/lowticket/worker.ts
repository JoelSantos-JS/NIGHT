// Trabalhador local do produto low-ticket (L07 + orquestração de L01–L03).
// Junta conteúdo, PDFs, página de vendas e o pacote versionado num trabalho só, sempre a
// partir de uma oferta APROVADA. Sem oferta aprovada nada é gerado; sem gerador o trabalho
// espera. Publicar a página e vender continuam sendo ações do Joel.
//
// Retomada: cada Markdown é gravado como 'conteudo-<n>.md' e cada PDF fica no ArtifactStore.
// Reiniciar o NIGHT e chamar start de novo reaproveita o que já está pronto, sem repetir
// chamada ao gerador para item que já existe. Espera/falha/cancelamento encerram a tentativa;
// a próxima começa outra execução, como manda o contrato JobWorker.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AdvisorService, ConsultResult } from '../advisor/service.ts';
import type { ArtifactItem, ArtifactStore } from '../artifacts/store.ts';
import type { JobWorker, WorkerRequest, WorkerResult, WorkerState } from '../jobs/worker.ts';
import { WORKER_CONTRACT } from '../jobs/worker.ts';
import { normalizeForCopyCheck } from '../radar/offer.ts';
import type { OfferProposal, ProposalMessage } from '../radar/offer.ts';
import type { ProposalGenerator } from '../radar/pipeline.ts';
import { generateProductContent } from './content.ts';
import type { ContentGenerator, ProductContentItem, ProductItemType } from './content.ts';
import type { OfferLinksStore } from './links.ts';
import type { BuildPdfsOptions, PdfRunner } from './pdf.ts';
import { buildProductPdfs } from './pdf.ts';
import { buildSalesPage, saveSalesPage } from './sales-page.ts';

/** Texto exato do pacote: o NIGHT não publica nem vende por conta própria. */
export const PUBLICACAO_DO_PACOTE =
  'não publicado — publicar a página e vender são ações do Joel';

export const CONTEUDO_PREFIXO = 'conteudo-';
export const PACOTE_PREFIXO = 'pacote-produto-v';

/** O que o trabalhador precisa do banco de ofertas; PgRadarStore satisfaz. */
export interface OfertaParaProduto {
  number: number;
  version: number;
  status: string;
  proposal: Record<string, unknown>;
}

export interface OfertasParaProduto {
  /** Sem versão, a mais nova; com versão, exatamente aquela. */
  getOffer(number: number, version?: number): Promise<OfertaParaProduto | null>;
}

export interface LowticketWorkerDeps {
  offers: OfertasParaProduto;
  links: OfferLinksStore;
  artifacts: ArtifactStore;
  /** null até o gerador de conteúdo estar ligado: o trabalho espera, não inventa texto. */
  generator: ProposalGenerator | null;
  /** Parecer do conteúdo; é registro e nunca aprova sozinho. */
  advisor?: AdvisorService;
  /** Pasta dos HTML/PDF antes de irem ao store. */
  workDir: string;
  /** Processo do navegador injetável nos testes; sem ele, o Edge/Chrome é usado. */
  pdfRun?: PdfRunner;
  /** Textos dos anúncios dos candidatos, só para provar que não houve cópia. */
  concorrentes?: (offerNumber: number) => Promise<string[]>;
}

export interface PacoteArquivo {
  nome: string;
  sha256: string;
}

export interface PacoteItemInvalido {
  nome: string;
  erros: string[];
}

/** Pacote versionado do produto (L07); uma versão aprovada fica recuperável exatamente. */
export interface PacoteProduto {
  offerNumber: number;
  offerVersion: number;
  criadoEm: string;
  arquivos: PacoteArquivo[];
  invalidos: PacoteItemInvalido[];
  parecer?: ConsultResult;
  avisos: string[];
  publicacao: string;
}

interface Run {
  jobId: string;
  state: WorkerState;
  message: string;
  result: WorkerResult | null;
  /** Cancelamento pedido; a execução para no fim da etapa corrente. */
  cancelled: boolean;
}

/** Mesmo plano de itens de src/lowticket/content.ts (4 PDFs + primeiro bônus). */
interface PlanoConteudo {
  nome: string;
  tipo: ProductItemType;
  descricao: string;
}

function resumoErro(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Número de oferta só vale como inteiro a partir de 1; o resto é pedido inválido. */
function numeroDaOferta(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : null;
}

/** Mesma regra de content.ts: entregáveis em PDF na ordem e o primeiro bônus. */
function planosDaOferta(oferta: OfferProposal): PlanoConteudo[] {
  const planos: PlanoConteudo[] = oferta.entregaveis
    .filter((entregavel) => entregavel.formato === 'pdf')
    .map((entregavel) => ({
      nome: entregavel.titulo,
      tipo: 'pdf' as const,
      descricao: entregavel.descricao,
    }));
  const bonus = oferta.bonus[0];
  if (bonus) {
    planos.push({ nome: bonus, tipo: 'bonus', descricao: `Bônus liberado após 7 dias: ${bonus}` });
  }
  return planos;
}

/** Linha de tarefa que abre o prompt de cada item; serve para casar prompt e item. */
function tarefaDoPlano(plano: PlanoConteudo): string {
  return plano.tipo === 'pdf'
    ? `tarefa: escrever o material em PDF: ${plano.nome}`
    : `tarefa: escrever o bônus (liberado após 7 dias): ${plano.nome}`;
}

/** Índice do plano cujo prompt é a primeira mensagem do usuário; null se não casar. */
function indiceDoPlano(mensagens: ProposalMessage[], planos: PlanoConteudo[]): number | null {
  const primeira = mensagens.find((mensagem) => mensagem.role === 'user');
  if (!primeira) return null;
  for (let i = 0; i < planos.length; i++) {
    if (primeira.content.includes(tarefaDoPlano(planos[i]!))) return i;
  }
  return null;
}

/** Mesmo slug de src/lowticket/pdf.ts; só acha o PDF já gravado pelo nome do item. */
function slugDoArquivo(texto: string): string {
  const limpo = normalizeForCopyCheck(texto)
    .replace(/ +/g, '-')
    .slice(0, 40)
    .replace(/-+$/, '');
  return limpo || 'item';
}

/** PDF já presente no manifesto para este item (qualquer número, se a retomada foi parcial). */
function pdfDoItem(manifesto: { items: ArtifactItem[] } | null, item: ProductContentItem): ArtifactItem | null {
  if (!manifesto) return null;
  const slug = slugDoArquivo(item.nome);
  if (item.tipo === 'bonus') {
    return manifesto.items.find((arquivo) => arquivo.name === `bonus-${slug}.pdf`) ?? null;
  }
  return manifesto.items.find((arquivo) =>
    /^produto-\d+-/.test(arquivo.name) && arquivo.name.endsWith(`-${slug}.pdf`)) ?? null;
}

export class LowticketWorker implements JobWorker {
  readonly name = 'lowticket-local';
  private readonly offers: OfertasParaProduto;
  private readonly links: OfferLinksStore;
  private readonly artifacts: ArtifactStore;
  private readonly generator: ProposalGenerator | null;
  private readonly advisor: AdvisorService | null;
  private readonly workDir: string;
  private readonly pdfRun: PdfRunner | null;
  private readonly concorrentes: (offerNumber: number) => Promise<string[]>;

  /** runId da execução mais recente por jobId; ver start() para quando ele muda. */
  private readonly runIdByJob = new Map<string, string>();
  private readonly runs = new Map<string, Run>();
  private readonly promises = new Map<string, Promise<void>>();
  private contador = 0;

  constructor(deps: LowticketWorkerDeps) {
    this.offers = deps.offers;
    this.links = deps.links;
    this.artifacts = deps.artifacts;
    this.generator = deps.generator;
    this.advisor = deps.advisor ?? null;
    this.workDir = deps.workDir;
    this.pdfRun = deps.pdfRun ?? null;
    this.concorrentes = deps.concorrentes ?? (async () => []);
  }

  async start(request: WorkerRequest): Promise<{ runId: string }> {
    const existente = this.runIdByJob.get(request.jobId);
    if (existente) {
      const anterior = this.runOf(existente);
      // CONTRATO: ativa ou concluída com sucesso devolve o mesmo runId. Espera/falha/
      // cancelamento terminou a tentativa: a retomada começa outra e reaproveita o store.
      if (anterior.state === 'running' || anterior.state === 'succeeded') {
        return { runId: existente };
      }
    }

    this.contador += 1;
    const runId = `lowticket-${this.contador}`;
    const run: Run = {
      jobId: request.jobId,
      state: 'running',
      message: 'começando',
      result: null,
      cancelled: false,
    };
    this.runIdByJob.set(request.jobId, runId);
    this.runs.set(runId, run);
    // start volta na hora; a execução segue numa Promise guardada por runId.
    const execucao = this.execute(run, request);
    this.promises.set(runId, execucao);
    void execucao.catch(() => undefined);
    return { runId };
  }

  async status(runId: string): Promise<{ state: WorkerState; message: string }> {
    const run = this.runOf(runId);
    return { state: run.state, message: run.message };
  }

  async result(runId: string): Promise<WorkerResult> {
    const run = this.runOf(runId);
    if (run.state === 'running') throw new Error(`execução ${runId} ainda está rodando`);
    if (run.result === null) throw new Error(`execução ${runId} terminou sem resultado`);
    return run.result;
  }

  /** Pede o cancelamento; a etapa corrente termina e a próxima não começa. */
  async cancel(runId: string): Promise<{ cancelled: boolean; detail: string }> {
    const run = this.runOf(runId);
    if (run.state !== 'running') {
      return { cancelled: false, detail: `execução já terminou (${run.state})` };
    }
    run.cancelled = true;
    run.message = 'cancelamento pedido; para no fim da etapa';
    return { cancelled: true, detail: 'cancelado entre etapas' };
  }

  /** Apoio para os testes esperarem o fim sem laço de polling (não é do contrato). */
  async whenDone(runId: string): Promise<void> {
    await this.promises.get(runId);
  }

  private runOf(runId: string): Run {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`runId desconhecido: ${runId}`);
    return run;
  }

  private async execute(run: Run, request: WorkerRequest): Promise<void> {
    try {
      const numero = numeroDaOferta(request.params.offerNumber);
      if (numero === null) {
        await this.finish(
          run, 'failed', 'pedido sem número de oferta',
          'pedido sem número de oferta (params.offerNumber inteiro)',
        );
        return;
      }

      // (1) Só produto de oferta aprovada: o resto é recusado antes de qualquer geração.
      const oferta = await this.offers.getOffer(numero);
      if (!oferta) {
        await this.finish(run, 'failed', 'oferta não encontrada', `não achei a oferta ${numero}`);
        return;
      }
      if (oferta.status !== 'aprovada') {
        await this.finish(
          run, 'failed', 'oferta não aprovada',
          `a oferta ${numero} não está aprovada: aprove antes de gerar o produto`,
        );
        return;
      }

      // (2) Sem gerador, esperar é honesto: nada de conteúdo inventado.
      if (this.generator === null) {
        await this.finish(
          run, 'waiting', 'oferta aprovada; falta o gerador de conteúdo', null, 'gerador',
        );
        return;
      }

      const proposta = oferta.proposal as unknown as OfferProposal;
      const planos = planosDaOferta(proposta);
      const concorrentes = await this.concorrentes(numero);
      if (await this.parar(run)) return;

      // (3) Conteúdo: item já gravado no store não chama o gerador de novo.
      run.message = 'gerando o conteúdo dos PDFs';
      const prontos = await this.lerConteudos(run.jobId, planos);
      const conteudo = await generateProductContent(
        {
          generator: this.geradorComReaproveitamento(prontos, planos),
          ...(this.advisor ? { advisor: this.advisor } : {}),
        },
        { jobId: run.jobId, offer: proposta, concorrentes },
      );
      await this.salvarConteudosNovos(run.jobId, conteudo.itens, prontos);

      if (await this.parar(run)) return;

      // (4) PDFs: idem, só o item 'ok' que ainda não tem PDF no store.
      run.message = 'gerando os PDFs';
      const manifestoAntes = await this.artifacts.manifest(run.jobId);
      const faltando = conteudo.itens.filter((item) =>
        item.status === 'ok' && pdfDoItem(manifestoAntes, item) === null);
      if (faltando.length > 0) {
        await buildProductPdfs(this.artifacts, run.jobId, faltando, this.opcoesPdf());
      }

      if (await this.parar(run)) return;

      // (5) Página de vendas: o checkout é o do Joel; sem ele o botão fica desabilitado.
      run.message = 'montando a página de vendas';
      const links = await this.links.get(numero);
      const checkoutUrl = links.checkoutUrl;
      const avisos = [...conteudo.avisos];
      if (checkoutUrl === null) {
        avisos.push(`falta o link de checkout: diga 'o checkout da oferta ${numero} é https://...'`);
      }
      const pagina = buildSalesPage(proposta, { checkoutUrl });
      await saveSalesPage(this.artifacts, run.jobId, pagina, oferta.version);

      if (await this.parar(run)) return;

      // (6) Pacote (L07): lista os arquivos com hash e deixa explícito que nada foi publicado.
      run.message = 'fechando o pacote do produto';
      const manifesto = await this.artifacts.manifest(run.jobId);
      const arquivos = (manifesto?.items ?? []).map((item) => ({ nome: item.name, sha256: item.sha256 }));
      const invalidos = conteudo.itens
        .filter((item) => item.status === 'invalido')
        .map((item) => ({ nome: item.nome, erros: item.errors ?? [] }));
      const pacote: PacoteProduto = {
        offerNumber: numero,
        offerVersion: oferta.version,
        criadoEm: new Date().toISOString(),
        arquivos,
        invalidos,
        ...(conteudo.parecer ? { parecer: conteudo.parecer } : {}),
        avisos: [...new Set(avisos)],
        publicacao: PUBLICACAO_DO_PACOTE,
      };
      const nomeDoPacote = `${PACOTE_PREFIXO}${oferta.version}.json`;
      await this.artifacts.add(run.jobId, {
        name: nomeDoPacote,
        data: `${JSON.stringify(pacote, null, 2)}\n`,
        origin: this.name,
        kind: 'pacote',
      });

      const ok = conteudo.itens.filter((item) => item.status === 'ok').length;
      const partes = [`pacote da oferta ${numero} pronto: ${ok} item(ns) ok, página v${oferta.version}`];
      if (invalidos.length > 0) {
        partes.push(`${invalidos.length} item(ns) inválido(s); veja os erros no pacote`);
      }
      if (checkoutUrl === null) partes.push('falta o link de checkout');
      await this.finish(run, 'succeeded', partes.join('; '), null);
    } catch (error) {
      // Falha inesperada nunca vira sucesso; o motivo fica visível no resultado.
      if (run.cancelled) await this.finish(run, 'cancelled', 'cancelado entre etapas', null);
      else await this.finish(run, 'failed', 'falhou', resumoErro(error));
    }
  }

  /** true quando o cancelamento já foi aplicado e a execução deve parar. */
  private async parar(run: Run): Promise<boolean> {
    if (!run.cancelled) return false;
    await this.finish(run, 'cancelled', 'cancelado entre etapas', null);
    return true;
  }

  private async finish(
    run: Run,
    state: 'succeeded' | 'failed' | 'cancelled' | 'waiting',
    message: string,
    error: string | null,
    waitingFor?: string,
  ): Promise<void> {
    const artifacts = await this.artifactsDoStore(run.jobId);
    run.result = {
      contract: WORKER_CONTRACT,
      jobId: run.jobId,
      state,
      artifacts,
      error,
      message,
      ...(waitingFor !== undefined ? { waitingFor } : {}),
    };
    run.message = message;
    run.state = state;
  }

  private async artifactsDoStore(jobId: string): Promise<{ name: string; sha256: string }[]> {
    const manifesto = await this.artifacts.manifest(jobId);
    return (manifesto?.items ?? []).map((item) => ({ name: item.name, sha256: item.sha256 }));
  }

  /**
   * Envolve o gerador real: se o item já tem Markdown no store, devolve o texto gravado
   * e não chama o modelo. A validação continua rodando, então item inválido segue inválido.
   */
  private geradorComReaproveitamento(
    prontos: Map<number, string>,
    planos: PlanoConteudo[],
  ): ContentGenerator {
    const real = this.generator;
    if (real === null) throw new Error('gerador de conteúdo não configurado');
    return async (mensagens) => {
      const indice = indiceDoPlano(mensagens, planos);
      if (indice !== null) {
        const pronto = prontos.get(indice);
        if (pronto !== undefined) return pronto;
      }
      return real(mensagens);
    };
  }

  /** Markdowns já gravados por índice do plano; arquivo ilegível volta a ser gerado. */
  private async lerConteudos(jobId: string, planos: PlanoConteudo[]): Promise<Map<number, string>> {
    const prontos = new Map<number, string>();
    const manifesto = await this.artifacts.manifest(jobId);
    if (!manifesto) return prontos;
    const nomes = new Set(manifesto.items.map((item) => item.name));
    for (let i = 0; i < planos.length; i++) {
      const nome = `${CONTEUDO_PREFIXO}${i + 1}.md`;
      if (!nomes.has(nome)) continue;
      try {
        prontos.set(i, await readFile(join(this.artifacts.root, jobId, nome), 'utf8'));
      } catch {
        // Arquivo ilegível: melhor gerar de novo do que falhar o trabalho inteiro.
      }
    }
    return prontos;
  }

  /** Grava só o Markdown novo; item pronto não muda de versão no manifesto. */
  private async salvarConteudosNovos(
    jobId: string,
    itens: ProductContentItem[],
    prontos: Map<number, string>,
  ): Promise<void> {
    for (let i = 0; i < itens.length; i++) {
      if (prontos.has(i)) continue;
      await this.artifacts.add(jobId, {
        name: `${CONTEUDO_PREFIXO}${i + 1}.md`,
        data: itens[i]!.markdown,
        origin: this.name,
        kind: 'conteudo',
      });
    }
  }

  /** Com run injetado, o binário é só um rótulo: o teste não abre navegador nenhum. */
  private opcoesPdf(): BuildPdfsOptions {
    return this.pdfRun
      ? { workDir: this.workDir, run: this.pdfRun, browser: 'runner-injetado' }
      : { workDir: this.workDir };
  }
}