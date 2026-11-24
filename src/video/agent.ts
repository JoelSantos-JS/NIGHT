// Agente de vídeo local (V07 + V08, docs/PLANO_MESTRE_NIGHT.md).
// Junta as etapas já prontas — imagens do Flow, narração, render e revisão — num
// trabalhador do contrato JobWorker. As dependências são injetáveis para testar sem
// FFmpeg e sem serviço de voz: a produção usa renderVideo e runReview de verdade.
//
// Retomada: cada etapa grava artefatos com nome determinístico no ArtifactStore e só
// é refeita quando o artefato não existe (ou foi alterado). Reiniciar o NIGHT e chamar
// start de novo no mesmo job reaproveita imagens, áudio, prévia e revisão.
//
// O agente NUNCA inventa imagem: cena sem imagem importada vira dependência do Flow.
// A espera aparece em status().message como 'aguardando_flow: cenas 2, 5' e o resultado
// termina com state 'waiting' e waitingFor 'flow'; o JobRunner marca o trabalho 'waiting'
// em vez de falha final e a retomada começa uma tentativa nova no mesmo processo.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { getDecisionPoint } from '../advisor/matrix.ts';
import type { AdvisorEvidence, AdvisorInput, Opinion } from '../advisor/opinion.ts';
import type { AdvisorService, ConsultResult } from '../advisor/service.ts';
import type { ArtifactItem, ArtifactStore } from '../artifacts/store.ts';
import type { JobWorker, WorkerRequest, WorkerResult, WorkerState } from '../jobs/worker.ts';
import { WORKER_CONTRACT } from '../jobs/worker.ts';
import { buildBrief, type VideoBrief } from './brief.ts';
import { FlowFolderProvider, writePromptSheet } from './flow-folder.ts';
import { readyForFinalRender, validateManifest, type Scene, type VideoManifest } from './manifest.ts';
import type { NarrateAllResult } from './narrate.ts';
import type { Narrator } from './narrate.ts';
import { renderWithRemotion } from './remotion-render.ts';
import { generateManifest, type ScriptGenerator } from './script.ts';
import {
  planRender,
  renderVideo,
  type RenderAssets,
  type RenderPlan,
  type RenderResult,
} from './render.ts';
import {
  runReview,
  type ReviewResult,
  type RunCommand,
  type RunResult,
} from './review.ts';
import { templateRequiresImages } from './templates.ts';

/** Fonte de imagens já importadas (Flow, GPT Image ou outra): null = a cena ainda não tem imagem. */
export interface ImageProvider {
  find(jobId: string, scene: Scene, manifest?: VideoManifest): Promise<string | null>;
  /**
   * Origem gravada no store para as imagens deste provider. O padrão é 'flow';
   * providers de outra fonte declaram a origem aqui.
   */
  readonly origin?: string;
  /** Origem específica da cena quando o provider combina múltiplas fontes (ex.: Flow + GPT). */
  originFor?(jobId: string, scene: Scene): string | undefined;
  /**
   * Opcional: grava a folha de prompts no local do provider e devolve a pasta usada.
   * É o caminho manual do Flow gratuito: o Joel gera no navegador e o NIGHT retoma.
   */
  writePromptSheet?(jobId: string, manifest: VideoManifest): Promise<string | null>;
}

/**
 * O que a revisão precisa saber do render: se é prévia (metade da resolução) e a duração
 * real esperada, que é a soma das durações do RenderPlan (vem do áudio, não do texto).
 */
export interface ReviewContext {
  preview: boolean;
  expectedDurationSec: number;
  checkBlackFrames?: boolean;
  extractFramesDir?: string;
}

export interface VideoAgentDeps {
  store: ArtifactStore;
  narrator: Narrator;
  /**
   * Narração indisponível (modo texto). Não muda a narração: só acrescenta o aviso do
   * modo voz na espera do Flow, sem o agente tentar narrar para descobrir isso.
   */
  semVoz?: boolean;
  /** Padrão: renderVideo (FFmpeg real). */
  render?: (plan: RenderPlan) => Promise<RenderResult>;
  /** Padrão: renderWithRemotion (estúdio Remotion em services/video-studio). */
  remotionRender?: (plan: RenderPlan, manifest: VideoManifest) => Promise<RenderResult>;
  /** Ativa detecção de quadros pretos e extração de frames na revisão automática. */
  visualQa?: boolean;
  /** Padrão: revisão com runReview/reviewRender e ffprobe/ffmpeg reais. */
  review?: (file: string, manifest: VideoManifest, opts: ReviewContext) => Promise<ReviewResult>;
  /** Comando da revisão padrão; injetável nos testes para simular o ffprobe/ffmpeg. */
  run?: RunCommand;
  images: ImageProvider;
  workDir: string;
  /** Parecer independente antes do render final (D07); sem ele, o agente segue como antes. */
  advisor?: AdvisorService;
  /** Gerador do roteiro (V02); sem ele, um pedido só com tema espera 'gerador'. */
  generator?: ScriptGenerator;
}

/** Nome do JSON com a revisão da prévia reaproveitada na retomada. */
const REVISAO_PREVIA = 'revisao-previa.json';
/** Parecer que bloqueou o render final: fica gravado para consulta e retomada. */
const PARECER_ANTES_DO_RENDER = 'parecer-antes-do-render.json';
/** Roteiro gerado pela V02; reaproveitado na retomada para não chamar o modelo de novo. */
const MANIFESTO_JSON = 'manifesto.json';
const IMAGEM_CENA = /^imagem-cena-(\d+)(?:\.[^.]+)?$/;

/**
 * Marcas de voz ausente: modo texto e serviço que ainda não subiu. O Narrator embrulha
 * o erro em outro Error por cena, então o texto é o sinal que sobrevive ao embrulho.
 */
const MARCAS_SEM_VOZ = ['serviço de voz não ligado', 'serviço de voz não está rodando'] as const;

/**
 * Falta o serviço de voz (modo texto ou Kokoro fora do ar): a narração vira espera
 * 'voz', não falha. O synth de produção lança este erro para marcar a espera.
 */
export class VoiceUnavailableError extends Error {
  constructor(message = `${MARCAS_SEM_VOZ[0]}: rode pnpm night:voz para narrar`) {
    super(message);
    this.name = 'VoiceUnavailableError';
  }
}

/** O erro da síntese pede espera da voz? Outros erros de narração continuam falha. */
function semServicoDeVoz(error: unknown): boolean {
  if (error instanceof VoiceUnavailableError) return true;
  const texto = resumoErro(error);
  return MARCAS_SEM_VOZ.some((marca) => texto.includes(marca));
}

interface Run {
  jobId: string;
  state: WorkerState;
  message: string;
  result: WorkerResult | null;
  /** Cancelamento pedido; a execução para no fim da etapa corrente. */
  cancelled: boolean;
}

/** Executor real de ffprobe/ffmpeg para a revisão padrão (sem shell). */
function rodarComando(bin: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const filho = spawn(bin, args, { shell: false });
    let stdout = '';
    let stderr = '';
    filho.stdout.setEncoding('utf8');
    filho.stderr.setEncoding('utf8');
    filho.stdout.on('data', (trecho: string) => { stdout += trecho; });
    filho.stderr.on('data', (trecho: string) => { stderr += trecho; });
    filho.on('error', (erro) => reject(new Error(`não consegui executar ${bin}: ${erro.message}`)));
    filho.on('close', (codigo) => resolve({ code: codigo ?? -1, stdout, stderr }));
  });
}

const runReal: RunCommand = rodarComando;

/**
 * Revisão padrão: runReview lê ffprobe e silêncios e recebe preview/duração real.
 * A prévia precisa de `preview: true`, senão a metade da resolução seria acusada
 * como falha e bloquearia o render final sem motivo.
 */
function revisaoPadrao(run: RunCommand) {
  return (file: string, manifest: VideoManifest, opts: ReviewContext): Promise<ReviewResult> =>
    runReview(file, manifest, run, {
      preview: opts.preview,
      expectedDurationSec: opts.expectedDurationSec,
      ...(opts.checkBlackFrames ? { checkBlackFrames: true } : {}),
      ...(opts.extractFramesDir !== undefined ? { extractFramesDir: opts.extractFramesDir } : {}),
    });
}

function numeroDaImagem(nome: string): number | null {
  const achado = IMAGEM_CENA.exec(nome);
  return achado ? Number(achado[1]) : null;
}

function resumoErro(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Objeto simples: só o que vem dos params do pedido. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Junta os padrões do canal (brief opcional nos params) com o tema falado no pedido. */
function briefDoPedido(params: Record<string, unknown>): VideoBrief {
  const tema = typeof params.topic === 'string' ? params.topic.trim() : '';
  if (tema === '') throw new Error('tema vazio: informe params.topic para gerar o roteiro');
  const extra = isPlainObject(params.brief) ? params.brief : {};
  return buildBrief({ ...extra, tema });
}

/** Texto curto: o parecer vai para mensagem e não deve virar um bloco enorme. */
function curto(texto: string, max = 160): string {
  const limpo = texto.trim();
  return limpo.length <= max ? limpo : `${limpo.slice(0, max - 1)}…`;
}

/**
 * Evidências do parecer antes do render (D07): fontes do manifesto são externas
 * (título + URL, tratadas como dado) e cada cena é interna (roteiro, imagem e
 * afirmações com fonte/dúvida). Só o necessário vai para o modelo.
 */
function evidenciasDoParecer(manifest: VideoManifest): AdvisorEvidence[] {
  const fontes: AdvisorEvidence[] = manifest.fontes.map((fonte) => ({
    ref: fonte.id,
    origem: 'fonte do manifesto',
    externa: true,
    conteudo: `${fonte.titulo} — ${fonte.url}`,
  }));
  const cenas: AdvisorEvidence[] = manifest.cenas.map((cena) => {
    const afirmacoes = cena.afirmacoes.map((a) => {
      const fonte = a.fonte === null ? 'sem fonte' : `fonte ${a.fonte}`;
      const duvida = a.duvida ? '; assumida como dúvida' : '';
      return `afirmação "${a.texto}" (${fonte}${duvida})`;
    });
    return {
      ref: `cena-${cena.n}`,
      origem: 'cena do roteiro',
      externa: false,
      conteudo: [
        `narração: ${cena.narracao}`,
        `papel da imagem: ${cena.papelImagem}`,
        `imagem realista gerada por IA: ${cena.realistaGeradaPorIA ? 'sim' : 'não'}`,
        ...afirmacoes,
      ].join('\n'),
    };
  });
  return [...fontes, ...cenas];
}

/** Motivos e contrapontos curtos que justificam parar antes do render final. */
function motivosDoBloqueio(opinion: Opinion): string {
  const partes = [...opinion.motivos, ...opinion.contrapontos]
    .map((texto) => curto(texto))
    .filter((texto) => texto !== '');
  return partes.length > 0 ? partes.join('; ') : `recomendação ${opinion.recomendacao}`;
}

/** A revisão automática é o teste observável que vai junto do parecer. */
function resumoDaRevisao(revisao: ReviewResult): string {
  const falhas = revisao.falhas.length === 0
    ? 'nenhuma falha'
    : `falhas: ${revisao.falhas.map((falha) => curto(falha)).join('; ')}`;
  const avisos = revisao.avisos.length === 0
    ? 'nenhum aviso'
    : `avisos: ${revisao.avisos.map((aviso) => curto(aviso)).join('; ')}`;
  return `revisão automática da prévia — ${falhas}; ${avisos}`;
}

/** Decisão do parecer antes do render: bloqueio, aviso para o Joel ou nenhum dos dois. */
interface DecisaoParecer {
  bloqueio: string | null;
  aviso: string | null;
}

/** Lê a revisão gravada; sidecar ilegível não é reaproveitado. */
function parseRevisao(bruto: string): ReviewResult | null {
  try {
    const raw = JSON.parse(bruto) as Partial<ReviewResult>;
    if (typeof raw.ok !== 'boolean' || !Array.isArray(raw.falhas) || !Array.isArray(raw.avisos)) {
      return null;
    }
    return {
      ok: raw.ok,
      falhas: raw.falhas.map((item) => String(item)),
      avisos: raw.avisos.map((item) => String(item)),
    };
  } catch {
    return null;
  }
}

interface EtapaRender {
  video: ArtifactItem;
  legenda: ArtifactItem;
  reused: boolean;
  /** Plano usado: a soma das durações é a referência real da revisão. */
  plan: RenderPlan;
}

export class VideoAgent implements JobWorker {
  readonly name = 'video-local';
  private readonly store: ArtifactStore;
  private readonly narrator: Narrator;
  private readonly semVoz: boolean;
  private readonly render: (plan: RenderPlan) => Promise<RenderResult>;
  private readonly remotionRender: (plan: RenderPlan, manifest: VideoManifest) => Promise<RenderResult>;
  private readonly visualQa: boolean;
  private readonly review: (file: string, manifest: VideoManifest, opts: ReviewContext) => Promise<ReviewResult>;
  private readonly images: ImageProvider;
  private readonly workDir: string;
  private readonly advisor: AdvisorService | null;
  private readonly generator: ScriptGenerator | null;

  /** runId da execução mais recente por jobId; ver start() para quando ele muda. */
  private readonly runIdByJob = new Map<string, string>();
  private readonly runs = new Map<string, Run>();
  private readonly promises = new Map<string, Promise<void>>();
  private contador = 0;

  constructor(deps: VideoAgentDeps) {
    this.store = deps.store;
    this.narrator = deps.narrator;
    this.semVoz = deps.semVoz ?? false;
    this.render = deps.render ?? ((plan) => renderVideo(plan));
    this.remotionRender = deps.remotionRender ?? ((plan, manifest) => renderWithRemotion(plan, manifest));
    this.visualQa = deps.visualQa ?? false;
    this.review = deps.review ?? revisaoPadrao(deps.run ?? runReal);
    this.images = deps.images;
    this.workDir = deps.workDir;
    this.advisor = deps.advisor ?? null;
    this.generator = deps.generator ?? null;
  }

  async start(request: WorkerRequest): Promise<{ runId: string }> {
    const existente = this.runIdByJob.get(request.jobId);
    if (existente) {
      const anterior = this.runOf(existente);
      // CONTRATO: ativa ou concluída com sucesso, devolve o mesmo runId. Espera/falha/
      // cancelamento terminou a tentativa: a retomada no MESMO processo começa outra,
      // reaproveitando do store o que já foi verificado.
      if (anterior.state === 'running' || anterior.state === 'succeeded') {
        return { runId: existente };
      }
    }

    this.contador += 1;
    const runId = `video-${this.contador}`;
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

  /**
   * Pede o cancelamento. A etapa corrente termina (não mata o FFmpeg no meio nesta
   * versão); a próxima etapa não começa e o resultado vira 'cancelled'.
   */
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
      const inicial = await this.manifestoDoPedido(run, request);
      if (inicial === null) return;
      let manifest = inicial;

      if (await this.parar(run)) return;

      run.message = 'importando imagens';
      const imagens = await this.importarImagens(request.jobId, manifest);
      manifest = imagens.manifest;

      if (await this.parar(run)) return;

      // A ordem para o Joel é roteiro -> conferir imagens -> (se faltar) folha de prompts
      // -> narração. Templates programáticos (stickman-2d, motion-graphics, ad-creative)
      // não travam esperando Flow; só os que exigem imagens param aqui.
      const exigeImagens = templateRequiresImages(manifest.templateVisual);
      if (exigeImagens && imagens.faltando.length > 0) {
        const cenas = imagens.faltando.join(', ');
        // Folha com os prompts para o Joel gerar no navegador; sem provider de pasta, nada muda.
        const pasta = await this.folhaDePrompt(request.jobId, manifest);
        const onde = pasta === null ? '' : `; gere no Flow e salve as imagens em ${pasta}`;
        // No modo texto a narração não vai rodar; avisar agora evita a surpresa depois do Flow.
        const voz = this.semVoz ? '; depois, a narração precisa do modo voz (pnpm night:voz)' : '';
        // Não inventa imagem: a etapa espera o Flow e o runner marca o trabalho 'waiting'.
        await this.finish(run, 'waiting', `aguardando_flow: cenas ${cenas}${onde}${voz}`, null, 'flow');
        return;
      }

      // Com todas as imagens, a narração pode parar em espera 'voz' (modo texto ou Kokoro parado).
      run.message = 'narrando';
      let narracao: NarrateAllResult;
      try {
        narracao = await this.narrator.narrateAll(request.jobId, manifest);
      } catch (error) {
        // Sem voz (modo texto ou Kokoro parado) é espera, não falha: a retomada no modo
        // voz reaproveita as cenas já prontas e continua daqui. Os outros erros seguem falha.
        // Cancelado antes do fim da etapa continua cancelado, não espera.
        if (!semServicoDeVoz(error) || run.cancelled) throw error;
        await this.finish(
          run, 'waiting', 'falta o serviço de voz: rode pnpm night:voz para narrar', null, 'voz',
        );
        return;
      }

      if (await this.parar(run)) return;

      run.message = 'renderizando prévia';
      const previa = await this.renderizar(request.jobId, manifest, narracao, true);

      if (await this.parar(run)) return;

      run.message = 'revisando prévia';
      const revisao = await this.revisarPrevia(request.jobId, previa, manifest);

      if (await this.parar(run)) return;

      // Parecer independente antes de gastar o render final (D07). Sem parecer válido,
      // o agente NÃO aprova sozinho: segue as regras atuais e deixa o aviso para o Joel.
      run.message = 'consultando parecer antes do render';
      const parecer = await this.parecerAntesDoRender(request.jobId, manifest, revisao);

      if (await this.parar(run)) return;

      if (parecer.bloqueio !== null) {
        const motivo = `prévia pronta; render final bloqueado pelo parecer: ${parecer.bloqueio}`;
        await this.finish(run, 'succeeded', motivo, motivo);
        return;
      }

      const prontidao = readyForFinalRender(manifest);
      const pendencias = [
        ...prontidao.pendencias,
        ...revisao.falhas.map((falha) => `revisão da prévia: ${falha}`),
      ];
      if (!prontidao.pronto || revisao.falhas.length > 0) {
        const motivo = `prévia pronta; render final bloqueado: ${pendencias.join('; ')}`;
        const mensagem = parecer.aviso === null ? motivo : `${motivo}; ${parecer.aviso}`;
        // Sucesso com prévia: a pendência é editorial, não uma falha de execução.
        // O contrato não tem campo de mensagem; o motivo vai em error por falta de outro.
        await this.finish(run, 'succeeded', mensagem, mensagem);
        return;
      }

      run.message = 'renderizando final';
      await this.renderizar(request.jobId, manifest, narracao, false);

      if (await this.parar(run)) return;

      const mensagemFinal = parecer.aviso === null ? 'concluído' : `concluído; ${parecer.aviso}`;
      await this.finish(run, 'succeeded', mensagemFinal, null);
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
    const manifesto = await this.store.manifest(jobId);
    return (manifesto?.items ?? []).map((item) => ({ name: item.name, sha256: item.sha256 }));
  }

  /**
   * Manifesto do trabalho, nesta ordem: o que veio em params, o roteiro já gravado no
   * store e, por fim, a geração a partir de params.topic (V02). Devolve null quando a
   * execução já terminou em falha/espera; nesse caso quem chamou só retorna.
   */
  private async manifestoDoPedido(run: Run, request: WorkerRequest): Promise<VideoManifest | null> {
    const bruto = request.params.manifest;
    if (bruto !== undefined && bruto !== null) {
      const validado = validateManifest(bruto);
      if (!validado.ok) {
        const detalhe = validado.errors.map((e) => `${e.campo}: ${e.problema}`).join('; ');
        await this.finish(run, 'failed', 'manifesto inválido', `manifesto inválido: ${detalhe}`);
        return null;
      }
      if (validado.manifest.jobId !== request.jobId) {
        await this.finish(
          run, 'failed', 'manifesto de outro trabalho',
          `manifesto é do trabalho ${validado.manifest.jobId}, esperado ${request.jobId}`,
        );
        return null;
      }
      return validado.manifest;
    }

    // Retomada: o roteiro gerado antes é reaproveitado, sem chamar o modelo de novo.
    const armazenado = await this.manifestoArmazenado(request.jobId);
    if (armazenado !== null) return armazenado;

    const tema = typeof request.params.topic === 'string' ? request.params.topic.trim() : '';
    if (tema === '') {
      // Sem manifesto e sem tema não há roteiro; o NIGHT não inventa assunto.
      await this.finish(
        run, 'failed', 'sem roteiro',
        'informe params.manifest ou params.topic para o trabalho de vídeo',
      );
      return null;
    }
    if (this.generator === null) {
      // Falta a chave do DeepSeek: espera, não falha; a retomada gera quando a chave existir.
      await this.finish(
        run, 'waiting', 'falta o gerador de roteiro (chave do DeepSeek)', null, 'gerador',
      );
      return null;
    }

    run.message = 'roteirizando';
    let brief: VideoBrief;
    try {
      brief = briefDoPedido(request.params);
    } catch (error) {
      await this.finish(run, 'failed', 'briefing inválido', resumoErro(error));
      return null;
    }

    const gerado = await generateManifest(
      { generator: this.generator, advisor: this.advisor ?? undefined },
      { jobId: request.jobId, brief },
    );
    if (gerado.status === 'invalido') {
      const detalhe = gerado.errors.map((e) => `${e.campo}: ${e.problema}`).join('; ');
      await this.finish(run, 'failed', 'roteiro inválido', `roteiro inválido: ${detalhe}`);
      return null;
    }

    // Grava antes de importar imagens: a retomada não paga outra geração de roteiro.
    await this.store.add(request.jobId, {
      name: MANIFESTO_JSON,
      data: `${JSON.stringify(gerado.manifest, null, 2)}\n`,
      origin: 'roteirista',
      kind: 'manifesto',
    });
    return gerado.manifest;
  }

  /** Roteiro gerado presente e íntegro no store; arquivo inválido é ignorado e regerado. */
  private async manifestoArmazenado(jobId: string): Promise<VideoManifest | null> {
    const item = await this.itemIntacto(jobId, MANIFESTO_JSON);
    if (item === null) return null;
    try {
      const bruto = await readFile(join(this.store.root, jobId, MANIFESTO_JSON), 'utf8');
      const validado = validateManifest(JSON.parse(bruto));
      if (!validado.ok || validado.manifest.jobId !== jobId) return null;
      return validado.manifest;
    } catch {
      // Arquivo ilegível não trava a retomada: o roteiro é gerado de novo.
      return null;
    }
  }

  /**
   * Pede ao provider que grave a folha de prompts e devolve a pasta para a mensagem.
   * Sem provider de pasta (ou com falha ao gravar), o aviso de espera segue como antes.
   */
  private async folhaDePrompt(jobId: string, manifest: VideoManifest): Promise<string | null> {
    try {
      if (this.images instanceof FlowFolderProvider) {
        const pasta = this.images.pastaDoJob(jobId);
        await writePromptSheet(manifest, pasta);
        return pasta;
      }
      const opcional = this.images.writePromptSheet;
      if (typeof opcional === 'function') {
        return await opcional.call(this.images, jobId, manifest);
      }
    } catch {
      // A folha é ajuda, não requisito: falha ao gravar não inventa imagem nem bloqueia.
      return null;
    }
    return null;
  }

  /** Importa só imagens que ainda não estão no store; null do provider vira pendência. */
  private async importarImagens(
    jobId: string,
    manifest: VideoManifest,
  ): Promise<{ manifest: VideoManifest; faltando: number[] }> {
    const manifestoStore = await this.store.manifest(jobId);
    const importadas = new Map<number, ArtifactItem>();
    for (const item of manifestoStore?.items ?? []) {
      if (item.kind !== 'image') continue;
      const n = numeroDaImagem(item.name);
      if (n !== null) importadas.set(n, item);
    }

    // verify() confere hash e tamanho: imagem alterada é importada de novo.
    const relatorio = importadas.size > 0 ? await this.store.verify(jobId) : null;
    const intacta = (item: ArtifactItem): boolean =>
      relatorio !== null && !relatorio.missing.includes(item.name) && !relatorio.changed.includes(item.name);

    const cenas: Scene[] = [];
    const faltando: number[] = [];
    for (const cena of manifest.cenas) {
      const existente = importadas.get(cena.n);
      if (existente && intacta(existente)) {
        cenas.push({ ...cena, assetRef: existente.name });
        continue;
      }
      const caminho = await this.images.find(jobId, cena, manifest);
      if (caminho === null || caminho.trim() === '') {
        faltando.push(cena.n);
        cenas.push({ ...cena });
        continue;
      }
      const sufixo = extname(caminho) || '.png';
      const nome = `imagem-cena-${cena.n}${sufixo}`;
      const item = await this.store.addFile(jobId, caminho, {
        name: nome,
        origin: this.images.originFor?.(jobId, cena) ?? this.images.origin ?? 'flow',
        kind: 'image',
      });
      cenas.push({ ...cena, assetRef: item.name });
    }
    return { manifest: { ...manifest, cenas }, faltando };
  }

  /** Renderiza prévia ou final e importa os dois arquivos (MP4 e SRT) para o store. */
  private async renderizar(
    jobId: string,
    manifest: VideoManifest,
    narracao: NarrateAllResult,
    preview: boolean,
  ): Promise<EtapaRender> {
    const nome = preview ? `${jobId}-preview` : jobId;
    const nomeVideo = `${nome}.mp4`;
    const nomeLegenda = `${nome}.srt`;

    // O plano é barato e puro; montamos antes para ter a duração real mesmo quando o
    // render é reaproveitado (a revisão precisa dela).
    const allowMissingImages = !templateRequiresImages(manifest.templateVisual);
    const assets = this.assetsDoStore(jobId, manifest, narracao, allowMissingImages);
    const sub = createHash('sha256').update(jobId).digest('hex').slice(0, 12);
    const outDir = join(this.workDir, sub);
    const plan = planRender(manifest, assets, { outDir, preview, allowMissingImages });

    const videoExistente = await this.itemIntacto(jobId, nomeVideo);
    const legendaExistente = await this.itemIntacto(jobId, nomeLegenda);
    // Retomada: o que já está íntegro no store não é renderizado de novo.
    if (videoExistente && legendaExistente) {
      return { video: videoExistente, legenda: legendaExistente, reused: true, plan };
    }

    await mkdir(outDir, { recursive: true });
    const usarRemotion =
      manifest.motorVisual === 'remotion' ||
      (manifest.templateVisual !== undefined && manifest.motorVisual !== 'ffmpeg');
    const resultado = usarRemotion
      ? await this.remotionRender(plan, manifest)
      : await this.render(plan);

    const video = await this.store.addFile(jobId, resultado.outPath, {
      name: basename(plan.outPath),
      origin: usarRemotion ? 'remotion' : 'ffmpeg',
      kind: 'video',
    });
    const legenda = await this.store.addFile(jobId, plan.subtitlesPath, {
      name: basename(plan.subtitlesPath),
      origin: usarRemotion ? 'remotion' : 'ffmpeg',
      kind: 'legenda',
    });
    return { video, legenda, reused: false, plan };
  }

  /** Revisa a prévia; reusa a revisão gravada quando a própria prévia foi reusada. */
  private async revisarPrevia(
    jobId: string,
    previa: EtapaRender,
    manifest: VideoManifest,
  ): Promise<ReviewResult> {
    if (previa.reused) {
      const item = await this.itemIntacto(jobId, REVISAO_PREVIA);
      if (item) {
        try {
          const revisao = parseRevisao(await readFile(join(this.store.root, jobId, REVISAO_PREVIA), 'utf8'));
          if (revisao !== null) return revisao;
        } catch {
          // Revisão ilegível: refaz em vez de confiar em arquivo quebrado.
        }
      }
    }

    const arquivo = join(this.store.root, jobId, previa.video.name);
    // A revisão precisa saber que é prévia (metade da resolução) e a duração real do plano.
    const expectedDurationSec = previa.plan.scenes.reduce((soma, cena) => soma + cena.durationSec, 0);
    const sub = createHash('sha256').update(jobId).digest('hex').slice(0, 12);
    const framesDir = this.visualQa ? join(this.workDir, sub, 'qa-frames') : undefined;
    const revisao = await this.review(arquivo, manifest, {
      preview: previa.plan.preview,
      expectedDurationSec,
      ...(this.visualQa ? { checkBlackFrames: true, extractFramesDir: framesDir } : {}),
    });
    for (const framePath of revisao.qaFrames ?? []) {
      await this.store.addFile(jobId, framePath, {
        name: basename(framePath),
        origin: 'revisor',
        kind: 'qa-frame',
      });
    }
    await this.store.add(jobId, {
      name: REVISAO_PREVIA,
      data: `${JSON.stringify(revisao, null, 2)}\n`,
      origin: 'revisor',
      kind: 'revisao',
    });
    return revisao;
  }

  /**
   * Consulta o parecer antes do render final. Sem advisor configurado, nada muda.
   * 'parar'/'revisar' bloqueiam o final e gravam o parecer; falta de parecer nunca
   * bloqueia nem aprova sozinha: as regras atuais decidem e fica um aviso para o Joel.
   */
  private async parecerAntesDoRender(
    jobId: string,
    manifest: VideoManifest,
    revisao: ReviewResult,
  ): Promise<DecisaoParecer> {
    if (this.advisor === null) return { bloqueio: null, aviso: null };

    const input: AdvisorInput = {
      jobId,
      dominio: 'video',
      fase: 'antes-do-render',
      objetivo: manifest.titulo.trim() === '' ? manifest.brief.tema : manifest.titulo,
      pergunta: getDecisionPoint('video.antes-do-render')?.pergunta
        ?? 'Alguma afirmação importante está sem fonte ou alguma cena pode enganar?',
      evidencias: evidenciasDoParecer(manifest),
      testes: resumoDaRevisao(revisao),
    };

    let parecer: ConsultResult;
    try {
      parecer = await this.advisor.consult('video.antes-do-render', input);
    } catch {
      // Serviço quebrado não pode travar o vídeo nem valer como aprovação.
      return { bloqueio: null, aviso: 'render final sem parecer independente (erro no serviço)' };
    }

    if (parecer.status === 'ok' || parecer.status === 'cache') {
      const opinion = parecer.opinion;
      if (opinion.recomendacao === 'parar' || opinion.recomendacao === 'revisar') {
        await this.store.add(jobId, {
          name: PARECER_ANTES_DO_RENDER,
          data: `${JSON.stringify(opinion, null, 2)}\n`,
          origin: 'conselheiro',
          kind: 'parecer',
        });
        return { bloqueio: motivosDoBloqueio(opinion), aviso: null };
      }
      if (opinion.recomendacao === 'perguntar_joel') {
        return {
          bloqueio: null,
          aviso: `parecer antes do render pediu decisão do Joel: ${motivosDoBloqueio(opinion)}`,
        };
      }
      return { bloqueio: null, aviso: null };
    }

    return {
      bloqueio: null,
      aviso: `render final sem parecer independente (${parecer.status})`,
    };
  }

  private assetsDoStore(
    jobId: string,
    manifest: VideoManifest,
    narracao: NarrateAllResult,
    allowMissingImages = false,
  ): RenderAssets {
    const imagens = new Map<number, string>();
    for (const cena of manifest.cenas) {
      if (cena.assetRef !== null && cena.assetRef.trim() !== '') {
        imagens.set(cena.n, join(this.store.root, jobId, cena.assetRef));
      }
    }
    const audios = new Map(narracao.scenes.map((cena) => [cena.n, cena]));
    return {
      imagePathFor: (n) => {
        const caminho = imagens.get(n);
        if (caminho === undefined) {
          if (allowMissingImages) return '';
          throw new Error(`cena ${n} sem imagem importada`);
        }
        return caminho;
      },
      audioFor: (n) => {
        const audio = audios.get(n);
        return audio ? { path: audio.file, durationSec: audio.durationSec } : null;
      },
    };
  }

  /** Item do store presente e íntegro; null quando falta ou foi alterado. */
  private async itemIntacto(jobId: string, name: string): Promise<ArtifactItem | null> {
    const manifesto = await this.store.manifest(jobId);
    const item = manifesto?.items.find((candidato) => candidato.name === name);
    if (!item) return null;
    const relatorio = await this.store.verify(jobId);
    if (relatorio.missing.includes(name) || relatorio.changed.includes(name)) return null;
    return item;
  }
}
