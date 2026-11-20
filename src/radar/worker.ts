// Trabalhador local do Radar de Ofertas (R03 + R04 + R05/D06) no contrato JobWorker.
// Junta o que já está pronto — coleta, nota de triagem e proposta — num trabalho só, sem
// rede além da fonte injetada e sem inventar dado: o que a fonte não mostrou fica null.
//
// Retomada: a coleta continua do cursor salvo, a nota só é recalculada nos candidatos sem
// score e a oferta não é refeita para o mesmo conjunto de candidatos. O relatório no
// ArtifactStore guarda os ids coletados e os grupos que já viraram oferta, então reiniciar
// o NIGHT e chamar start de novo reaproveita o que já foi feito.
//
// Sem fonte provada o trabalho espera 'fonte'; sem gerador espera 'gerador'. Espera não é
// falha: o JobRunner marca o trabalho 'waiting' e a retomada começa outra tentativa.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AdvisorService, ConsultResult } from '../advisor/service.ts';
import type { ArtifactStore } from '../artifacts/store.ts';
import type { LimitTracker } from '../jobs/limits.ts';
import type { JobWorker, WorkerRequest, WorkerResult, WorkerState } from '../jobs/worker.ts';
import { WORKER_CONTRACT } from '../jobs/worker.ts';
import type { AdSource, CollectCounters, CollectStore } from './collect.ts';
import { collect } from './collect.ts';
import type { NichoPlanejado, PlanejadorNichos } from './nichos.ts';
import type { ProposalGenerator } from './pipeline.ts';
import { proposeOffer } from './pipeline.ts';
import type { ScoreInput, ScoreResultado } from './score.ts';
import { scoreCandidate } from './score.ts';
import type { NewCandidate, PgRadarStore, RadarCandidate } from './store.ts';

/** Nome do relatório que também serve de estado para a retomada. */
export const RELATORIO_RADAR = 'relatorio-radar.json';
const RELATORIO_VERSION = 'relatorio-radar/1';

/** Corte da triagem: abaixo de 7 o candidato não vira oferta. */
const CORTE = 7;
/** Teto de candidatos escolhidos por execução (as ofertas juntam candidatos do mesmo domínio). */
const MAX_ESCOLHIDOS = 3;
const MAX_POR_PALAVRA = 50;
const MAX_PAGINAS = 5;

const MENSAGEM_SEM_FONTE =
  'falta provar a fonte de anúncios (R01: API da Meta ou outra fonte permitida); nada foi coletado';

export interface CandidatoPontuado {
  id: string;
  dominio: string | null;
  nota: number;
  parcial: boolean;
  justificativa: string;
}

export interface OfertaRegistrada {
  /** Conjunto de candidatos que gerou a oferta (ids ordenados), para não duplicar na retomada. */
  grupo: string;
  number: number;
  status: string;
}

/** Relatório do trabalho; os ids e os grupos de oferta são o estado usado na retomada. */
export interface RelatorioRadar {
  version: typeof RELATORIO_VERSION;
  jobId: string;
  query: string;
  keywords: string[];
  nichos?: NichoPlanejado[];
  coleta: Record<string, CollectCounters>;
  totais: CollectCounters;
  candidatosColetados: string[];
  candidatosPontuados: CandidatoPontuado[];
  ofertas: OfertaRegistrada[];
  avisos: string[];
}

export interface RadarWorkerDeps {
  store: PgRadarStore;
  artifacts: ArtifactStore;
  /** null até a fonte de anúncios ser provada (R01): o trabalho espera, não inventa anúncio. */
  source: AdSource | null;
  /** null até o gerador de propostas estar ligado: o trabalho espera. */
  generator: ProposalGenerator | null;
  /** Parecer independente da proposta; sem ele a oferta nasce como rascunho, sem aprovação. */
  advisor?: AdvisorService;
  planejador?: PlanejadorNichos;
  /** Teto de chamadas do trabalho; a fábrica recebe o pedido para montar o tracker. */
  limits?: (request: WorkerRequest) => LimitTracker;
}

interface Run {
  jobId: string;
  state: WorkerState;
  message: string;
  result: WorkerResult | null;
  /** Cancelamento pedido; a execução para no fim da etapa corrente. */
  cancelled: boolean;
}

const CONTADORES_ZERO = (): CollectCounters => ({ vistos: 0, novos: 0, duplicados: 0, incompletos: 0 });

function resumoErro(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Texto obrigatório do pedido; vazio ou de outro tipo não vira nicho. */
function textoObrigatorio(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** Lista de palavras-chave do pedido; sem lista válida, usa o próprio nicho. */
function keywordsDoPedido(value: unknown, query: string): string[] {
  if (!Array.isArray(value)) return [query];
  const lista = value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item !== '');
  return lista.length > 0 ? [...new Set(lista)] : [query];
}

/** Teto do pedido só vale como inteiro positivo; fora disso, usa o padrão. */
function tetoDoPedido(value: unknown, padrao: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : padrao;
}

/** Inteiro >= minimo vindo do raw; ausente ou inválido é null (nunca 0 inventado). */
function inteiroDoRaw(value: unknown, minimo: number): number | null {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= minimo
    ? value
    : null;
}

/** Preço em reais: número finito e maior que zero; resto é null. */
function precoDoRaw(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/** Dias entre a data de início (YYYY-MM-DD) e hoje; data ausente/inválida é null. */
function diasDesde(data: string | null): number | null {
  if (data === null) return null;
  const inicio = Date.parse(`${data}T00:00:00Z`);
  if (!Number.isFinite(inicio)) return null;
  const dias = Math.floor((Date.now() - inicio) / 86_400_000);
  return Number.isInteger(dias) && dias >= 0 ? dias : null;
}

/**
 * Monta a entrada da nota a partir do raw da fonte. Campo ausente ou inválido fica null e
 * a nota vira parcial; nunca vira 0 nem é estimado.
 */
export function entradaDeNota(candidato: RadarCandidate): ScoreInput {
  const raw = isRecord(candidato.raw) ? candidato.raw : {};
  return {
    anunciosAtivos: inteiroDoRaw(raw.activeAdsInDomain, 0) ?? inteiroDoRaw(raw.anunciosAtivos, 0),
    diasNoAr: inteiroDoRaw(raw.diasNoAr, 0) ?? diasDesde(candidato.startedAt),
    anunciantesNoNicho: inteiroDoRaw(raw.anunciantesNoNicho, 1),
    precoOrigem: precoDoRaw(raw.precoOrigem),
    entregavelEmPdf: typeof raw.entregavelEmPdf === 'boolean' ? raw.entregavelEmPdf : null,
  };
}

/** Chave estável do grupo de candidatos que vira uma oferta. */
export function chaveDoGrupo(candidateIds: string[]): string {
  return [...candidateIds].sort().join(',');
}

/** Junta os contadores da coleta numa execução aos que já estavam no relatório. */
function acumular(
  acumulado: Record<string, CollectCounters>, novos: Record<string, CollectCounters>,
): Record<string, CollectCounters> {
  const out: Record<string, CollectCounters> = {};
  for (const [keyword, conta] of Object.entries(acumulado)) out[keyword] = { ...conta };
  for (const [keyword, conta] of Object.entries(novos)) {
    const alvo = out[keyword] ?? CONTADORES_ZERO();
    alvo.vistos += conta.vistos;
    alvo.novos += conta.novos;
    alvo.duplicados += conta.duplicados;
    alvo.incompletos += conta.incompletos;
    out[keyword] = alvo;
  }
  return out;
}

function totaisDe(coleta: Record<string, CollectCounters>): CollectCounters {
  const total = CONTADORES_ZERO();
  for (const conta of Object.values(coleta)) {
    total.vistos += conta.vistos;
    total.novos += conta.novos;
    total.duplicados += conta.duplicados;
    total.incompletos += conta.incompletos;
  }
  return total;
}

/** Relatório lido do store é estado de retomada: só a versão conhecida é aceita. */
function lerRelatorioBruto(raw: unknown): Partial<RelatorioRadar> | null {
  if (!isRecord(raw) || raw.version !== RELATORIO_VERSION) return null;
  const relatorio = { ...raw } as Partial<RelatorioRadar>;
  if (!nichosValidos(raw.nichos)) delete relatorio.nichos;
  return relatorio;
}

function nichosValidos(value: unknown): value is NichoPlanejado[] {
  return Array.isArray(value) && value.every((item) =>
    isRecord(item)
    && (item.tipo === 'nicho' || item.tipo === 'oferta')
    && typeof item.nome === 'string' && item.nome.trim() !== ''
    && typeof item.termo === 'string' && item.termo.trim() !== ''
    && typeof item.motivo === 'string'
    && Array.isArray(item.fontes)
    && item.fontes.every((fonte: unknown) => typeof fonte === 'string'));
}

function listaDeTexto(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function ofertasDe(value: unknown): OfertaRegistrada[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is OfertaRegistrada =>
    isRecord(item)
    && typeof item.grupo === 'string'
    && typeof item.number === 'number'
    && typeof item.status === 'string');
}

function coletaDe(value: unknown): Record<string, CollectCounters> {
  if (!isRecord(value)) return {};
  const out: Record<string, CollectCounters> = {};
  for (const [keyword, conta] of Object.entries(value)) {
    if (!isRecord(conta)) continue;
    out[keyword] = {
      vistos: Number.isFinite(conta.vistos) ? Number(conta.vistos) : 0,
      novos: Number.isFinite(conta.novos) ? Number(conta.novos) : 0,
      duplicados: Number.isFinite(conta.duplicados) ? Number(conta.duplicados) : 0,
      incompletos: Number.isFinite(conta.incompletos) ? Number(conta.incompletos) : 0,
    };
  }
  return out;
}

export class RadarWorker implements JobWorker {
  readonly name = 'radar-local';
  private readonly store: PgRadarStore;
  private readonly artifacts: ArtifactStore;
  private readonly source: AdSource | null;
  private readonly generator: ProposalGenerator | null;
  private readonly advisor: AdvisorService | null;
  private readonly planejador: PlanejadorNichos | null;
  private readonly limits: ((request: WorkerRequest) => LimitTracker) | null;

  /** runId da execução mais recente por jobId; ver start() para quando ele muda. */
  private readonly runIdByJob = new Map<string, string>();
  private readonly runs = new Map<string, Run>();
  private readonly promises = new Map<string, Promise<void>>();
  private contador = 0;

  constructor(deps: RadarWorkerDeps) {
    this.store = deps.store;
    this.artifacts = deps.artifacts;
    this.source = deps.source;
    this.generator = deps.generator;
    this.advisor = deps.advisor ?? null;
    this.planejador = deps.planejador ?? null;
    this.limits = deps.limits ?? null;
  }

  async start(request: WorkerRequest): Promise<{ runId: string }> {
    const existente = this.runIdByJob.get(request.jobId);
    if (existente) {
      const anterior = this.runOf(existente);
      // CONTRATO: ativa ou concluída com sucesso devolve o mesmo runId. Espera/falha/
      // cancelamento terminou a tentativa: a retomada começa outra, reaproveitando o relatório.
      if (anterior.state === 'running' || anterior.state === 'succeeded') {
        return { runId: existente };
      }
    }

    this.contador += 1;
    const runId = `radar-${this.contador}`;
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
      const query = textoObrigatorio(request.params.query);
      if (query === null) {
        await this.finish(run, 'failed', 'pedido sem nicho (params.query)', 'pedido sem nicho (params.query)');
        return;
      }
      let keywords = keywordsDoPedido(request.params.keywords, query);

      // (1) Fonte não provada: esperar é honesto; coletar seria inventar anúncio.
      if (this.source === null) {
        await this.finish(run, 'waiting', MENSAGEM_SEM_FONTE, null, 'fonte');
        return;
      }
      const source = this.source;

      // Estado da retomada: ids já coletados e ofertas já criadas vivem no relatório.
      const anterior = await this.lerRelatorio(request.jobId);
      const ids = new Set<string>(anterior?.candidatosColetados ?? []);
      const ofertas = ofertasDe(anterior?.ofertas);
      const avisos = [...listaDeTexto(anterior?.avisos)];
      let coleta = coletaDe(anterior?.coleta);
      let nichos: NichoPlanejado[] | undefined;

      if (request.params.planejarNichos === true && this.planejador !== null) {
        if (anterior?.nichos !== undefined) {
          nichos = anterior.nichos;
          if (!avisos.some((aviso) => aviso.startsWith('Nichos ('))) {
            avisos.push(`Nichos (retomada): ${nichos.map((nicho) => nicho.nome).join(', ')}`);
          }
        } else {
          run.message = 'o Codex está pesquisando os nichos';
          const plano = await this.planejador.planejar(query, 8);
          nichos = plano.nichos;
          avisos.push(...plano.avisos);
          avisos.push(`Nichos (${plano.autor}): ${nichos.map((nicho) => nicho.nome).join(', ')}`);
        }
        // O Claude busca na Biblioteca o que o Codex achou; as frases de preço do pedido ficam de reserva (sem nicho,
        // são elas que vão). Assim são até 8 buscas, não 16: cada uma é uma sessão do Claude (~1,5 min).
        if (nichos.length > 0) keywords = [...new Set(nichos.map((nicho) => nicho.termo))];
        if (await this.parar(run)) return;
      }

      if (await this.parar(run)) return;

      // (2) Coleta: continua do cursor; o wrapper lembra os ids vistos nesta execução.
      run.message = 'coletando anúncios';
      const comNichos = request.params.planejarNichos === true && this.planejador !== null;
      const maxPerKeyword = tetoDoPedido(request.limits.maxPerKeyword,
        comNichos ? Math.max(1, Math.ceil(15 / keywords.length)) : MAX_POR_PALAVRA);
      const maxPages = comNichos ? 1 : tetoDoPedido(request.limits.maxPages, MAX_PAGINAS);
      const novasContas = await collect(this.coletorQueLembra(ids), source, {
        jobId: request.jobId, keywords, maxPerKeyword, maxPages,
      });
      coleta = acumular(coleta, novasContas);
      await this.salvarRelatorio(request.jobId, this.montarRelatorio({
        jobId: request.jobId, query, keywords, nichos, coleta, ids, pontuados: [], ofertas, avisos,
      }));

      if (await this.parar(run)) return;

      // (3) Nota só nos candidatos sem score: retomada não recalcula o que já foi feito.
      run.message = 'dando nota aos candidatos';
      const pontuados: CandidatoPontuado[] = [];
      const notas = new Map<string, ScoreResultado>();
      for (const id of ids) {
        const candidato = await this.store.getCandidate(id);
        if (candidato === null) continue;
        let nota = candidato.score;
        if (nota === null) {
          nota = scoreCandidate(entradaDeNota(candidato));
          await this.store.setScore(id, nota);
        }
        notas.set(id, nota);
        pontuados.push({
          id,
          dominio: candidato.domain,
          nota: nota.nota,
          parcial: nota.parcial,
          justificativa: nota.justificativa,
        });
        if (await this.parar(run)) return;
      }
      await this.salvarRelatorio(request.jobId, this.montarRelatorio({
        jobId: request.jobId, query, keywords, nichos, coleta, ids, pontuados, ofertas, avisos,
      }));

      if (await this.parar(run)) return;

      // (4) Escolhe até 3 acima do corte. Parcial só entra se o máximo visível ainda
      // sustentar o corte, e sempre com aviso para o Joel.
      const escolhidos = pontuados
        .filter((p) => p.nota >= CORTE)
        .sort((a, b) => b.nota - a.nota || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .filter((p) => {
          const nota = notas.get(p.id);
          if (!nota) return false;
          // Parcial precisa que o que já foi visto sustente o corte; senão, fica de fora.
          return !nota.parcial || nota.maximoPossivel >= CORTE;
        })
        .slice(0, MAX_ESCOLHIDOS);

      for (const p of escolhidos) {
        const nota = notas.get(p.id);
        if (nota?.parcial) {
          const faltando = nota.faltando.length > 0 ? nota.faltando.join(', ') : 'alguns critérios';
          avisos.push(
            `candidato ${p.id} entrou com nota parcial ${nota.nota}/${nota.maximoPossivel}; falta: ${faltando}`,
          );
        }
      }

      if (escolhidos.length === 0) {
        const mensagem = 'nenhum candidato acima do corte';
        await this.salvarRelatorio(request.jobId, this.montarRelatorio({
          jobId: request.jobId, query, keywords, nichos, coleta, ids, pontuados, ofertas, avisos,
        }));
        await this.finish(run, 'succeeded', mensagem, null);
        return;
      }

      // (5) Sem gerador o trabalho espera; coleta e notas ficam prontas para a retomada.
      if (this.generator === null) {
        await this.salvarRelatorio(request.jobId, this.montarRelatorio({
          jobId: request.jobId, query, keywords, nichos, coleta, ids, pontuados, ofertas, avisos,
        }));
        await this.finish(
          run, 'waiting', 'coleta e notas prontas; falta o gerador de propostas', null, 'gerador',
        );
        return;
      }
      const generator = this.generator;
      const advisor = this.advisor ?? this.semConselheiro();
      const tracker = this.limits?.(request);

      // Uma oferta por grupo de domínio; grupos já gravados no relatório não se repetem.
      const grupos = new Map<string, string[]>();
      for (const p of escolhidos) {
        const chave = p.dominio ?? p.id;
        const lista = grupos.get(chave) ?? [];
        lista.push(p.id);
        grupos.set(chave, lista);
      }

      for (const candidateIds of grupos.values()) {
        const grupo = chaveDoGrupo(candidateIds);
        if (ofertas.some((o) => o.grupo === grupo)) continue;
        if (await this.parar(run)) return;

        run.message = `gerando oferta (${candidateIds.length} candidato(s))`;
        const resultado = await proposeOffer(
          { store: this.store, generator, advisor, ...(tracker ? { tracker } : {}) },
          { jobId: request.jobId, candidateIds, nicho: query },
        );
        if (resultado.status === 'criada') {
          const gravada = await this.store.getOffer(resultado.number);
          ofertas.push({ grupo, number: resultado.number, status: gravada?.status ?? 'rascunho' });
        } else {
          // Proposta inválida não vira oferta; o motivo fica no relatório para o Joel.
          const detalhe = resultado.errors.map((e) => `${e.campo}: ${e.problema}`).join('; ');
          avisos.push(`proposta inválida para o grupo ${grupo}: ${detalhe}`);
        }
        await this.salvarRelatorio(request.jobId, this.montarRelatorio({
          jobId: request.jobId, query, keywords, nichos, coleta, ids, pontuados, ofertas, avisos,
        }));

        if (await this.parar(run)) return;
      }

      // (6) Relatório final com coleta, notas e ofertas; o artefato também é o estado da retomada.
      await this.salvarRelatorio(request.jobId, this.montarRelatorio({
        jobId: request.jobId, query, keywords, nichos, coleta, ids, pontuados, ofertas, avisos,
      }));
      const mensagem = `relatório pronto: ${pontuados.length} candidato(s) pontuado(s), ${ofertas.length} oferta(s)`;
      await this.finish(run, 'succeeded', mensagem, null);
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

  /** Store que lembra os ids tocados pela coleta, inclusive os que já existiam (retomada). */
  private coletorQueLembra(ids: Set<string>): CollectStore {
    return {
      getCursor: (jobId, keyword, source) => this.store.getCursor(jobId, keyword, source),
      setCursor: (jobId, keyword, source, cursor) => this.store.setCursor(jobId, keyword, source, cursor),
      upsertCandidate: async (candidate: NewCandidate) => {
        const resultado = await this.store.upsertCandidate(candidate);
        ids.add(resultado.candidate.id);
        return resultado;
      },
    };
  }

  private montarRelatorio(input: {
    jobId: string;
    query: string;
    keywords: string[];
    nichos?: NichoPlanejado[];
    coleta: Record<string, CollectCounters>;
    ids: Set<string>;
    pontuados: CandidatoPontuado[];
    ofertas: OfertaRegistrada[];
    avisos: string[];
  }): RelatorioRadar {
    return {
      version: RELATORIO_VERSION,
      jobId: input.jobId,
      query: input.query,
      keywords: input.keywords,
      ...(input.nichos !== undefined ? { nichos: input.nichos } : {}),
      coleta: input.coleta,
      totais: totaisDe(input.coleta),
      candidatosColetados: [...input.ids],
      candidatosPontuados: input.pontuados,
      ofertas: input.ofertas,
      avisos: [...new Set(input.avisos)],
    };
  }

  private async salvarRelatorio(jobId: string, relatorio: RelatorioRadar): Promise<void> {
    await this.artifacts.add(jobId, {
      name: RELATORIO_RADAR,
      data: `${JSON.stringify(relatorio, null, 2)}\n`,
      origin: this.name,
      kind: 'relatorio',
    });
  }

  /** Relatório anterior (se íntegro o bastante) serve de estado para a retomada. */
  private async lerRelatorio(jobId: string): Promise<Partial<RelatorioRadar> | null> {
    const manifesto = await this.artifacts.manifest(jobId);
    if (!manifesto?.items.some((item) => item.name === RELATORIO_RADAR)) return null;
    try {
      const texto = await readFile(join(this.artifacts.root, jobId, RELATORIO_RADAR), 'utf8');
      return lerRelatorioBruto(JSON.parse(texto));
    } catch {
      // Relatório ilegível: recomeça do estado do banco em vez de confiar em arquivo quebrado.
      return null;
    }
  }

  /**
   * Sem conselheiro configurado a proposta segue, mas o parecer fica 'dispensado':
   * nunca vira aprovação e a oferta nasce como rascunho para o Joel decidir.
   */
  private semConselheiro(): AdvisorService {
    const dispensado = {
      inputHash: () => '',
      consult: async (): Promise<ConsultResult> => ({
        status: 'dispensado',
        motivo: 'sem conselheiro configurado no Radar',
      }),
    };
    return dispensado as unknown as AdvisorService;
  }
}
