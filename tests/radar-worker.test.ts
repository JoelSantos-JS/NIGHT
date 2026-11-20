// Trabalhador do Radar (R03 + R04 + R05/D06) com banco de teste, fonte, gerador e
// conselheiro falsos. O que se prova aqui: sem fonte o trabalho espera sem inventar
// anúncio; o fluxo completo cria oferta e relatório; nota parcial não vira 0; nenhum
// candidato acima do corte ainda rende relatório; sem gerador o trabalho espera; a
// retomada não duplica oferta nem candidato; e start é idempotente enquanto ativo.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import type { AdvisorResult } from '../src/advisor/deepseek-client.ts';
import { MemoryAdvisorJournal } from '../src/advisor/journal.ts';
import type { AdvisorInput, Opinion } from '../src/advisor/opinion.ts';
import { AdvisorService } from '../src/advisor/service.ts';
import type { OpinionAdvisor } from '../src/advisor/service.ts';
import { ArtifactStore } from '../src/artifacts/store.ts';
import { WORKER_CONTRACT } from '../src/jobs/worker.ts';
import type { WorkerRequest } from '../src/jobs/worker.ts';
import { PgMemory } from '../src/memory/pg-memory.ts';
import type { AdSource, RawAd } from '../src/radar/collect.ts';
import type { PlanejadorNichos } from '../src/radar/nichos.ts';
import { PROPOSAL_VERSION } from '../src/radar/offer.ts';
import type { ProposalMessage } from '../src/radar/offer.ts';
import type { ProposalGenerator } from '../src/radar/pipeline.ts';
import { PgRadarStore } from '../src/radar/store.ts';
import { RadarWorker, RELATORIO_RADAR } from '../src/radar/worker.ts';
import type { RelatorioRadar } from '../src/radar/worker.ts';
import { resetTestDb, TEST_URL, truncateAll } from './helpers.ts';

const ANUNCIO =
  'Aprenda a vender todos os dias sem gastar muito dinheiro em anúncios no Instagram';

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

/** Fonte que só responde quando o teste libera: mantém a execução ativa de propósito. */
class GateSource implements AdSource {
  readonly name = 'falsa';
  private liberar!: () => void;
  private readonly portao = new Promise<void>((resolve) => { this.liberar = resolve; });
  calls = 0;

  async search(): Promise<{ ads: RawAd[]; nextCursor: string | null }> {
    await this.portao;
    this.calls += 1;
    return { ads: [ALTA], nextCursor: null };
  }

  abrir(): void {
    this.liberar();
  }
}

const ALTA: RawAd = {
  externalId: 'alta-1',
  advertiser: 'Loja Alta',
  adUrl: 'https://ads.example/alta-1',
  landingUrl: 'https://alta.example/oferta',
  country: 'BR',
  startedAt: '2026-10-01',
  activeAdsInDomain: 94,
  diasNoAr: 41,
  anunciantesNoNicho: 5,
  precoOrigem: 97,
  entregavelEmPdf: true,
  anuncioTexto: ANUNCIO,
};

/** Só anúncios ativos: o resto fica ausente e a nota tem de ser parcial, não zero. */
const PARCIAL: RawAd = {
  externalId: 'parcial-1',
  advertiser: 'Loja Parcial',
  landingUrl: 'https://parcial.example/oferta',
  country: 'BR',
  activeAdsInDomain: 94,
  anuncioTexto: ANUNCIO,
};

/** Tudo visível, mas abaixo do corte: nota 4. */
const BAIXA: RawAd = {
  externalId: 'baixa-1',
  advertiser: 'Loja Baixa',
  landingUrl: 'https://baixa.example/oferta',
  country: 'BR',
  activeAdsInDomain: 12,
  diasNoAr: 10,
  anunciantesNoNicho: 2,
  precoOrigem: 50,
  entregavelEmPdf: false,
  anuncioTexto: ANUNCIO,
};

/** Proposta mínima válida; o gerador falso troca o candidateId pelo id do prompt. */
function propostaValida(candidateId: string): Record<string, unknown> {
  return {
    version: PROPOSAL_VERSION,
    nome: 'Rotina Enxuta',
    posicionamento: 'Guia curto de rotina para quem trabalha em casa',
    publico: 'Autônomos que trabalham de casa',
    problema: 'O dia termina sem foco',
    promessa: 'Montar uma rotina semanal em sete passos, com modelos para preencher',
    diferencial: 'Checklist próprio de uma página e exemplos reais',
    entregaveis: [
      { titulo: 'PDF 1', formato: 'pdf', descricao: 'Mapa da rotina' },
      { titulo: 'PDF 2', formato: 'pdf', descricao: 'Modelos de agenda' },
      { titulo: 'PDF 3', formato: 'pdf', descricao: 'Checklist semanal' },
      { titulo: 'PDF 4', formato: 'pdf', descricao: 'Plano de ajustes' },
    ],
    bonus: ['Modelo de agenda'],
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
    evidencias: [{ candidateId, oQueSustenta: 'Anúncio ativo há 40 dias no nicho' }],
    duvidas: ['A demanda pode ser sazonal', 'O preço pode ser alto para o público'],
    motivoParaDescartar: 'Se a rotina mudar, o guia perde utilidade',
    alternativas: [],
  };
}

/** Gerador falso: lê o candidateId do prompt (o worker descobre os ids na coleta). */
function geradorFalso(): { generator: ProposalGenerator; chamadas: ProposalMessage[][] } {
  const chamadas: ProposalMessage[][] = [];
  const generator: ProposalGenerator = async (mensagens) => {
    chamadas.push([...mensagens]);
    const ultima = mensagens[mensagens.length - 1]?.content ?? '';
    const ids = [...ultima.matchAll(/candidateId: ([0-9a-f-]{36})/g)]
      .map((achado) => achado[1])
      .filter((id): id is string => id !== undefined);
    const id = ids[0];
    if (id === undefined) throw new Error('prompt sem candidateId');
    return JSON.stringify(propostaValida(id));
  };
  return { generator, chamadas };
}

/** Conselheiro falso: sempre revisa, sem contrapontos (evita feedback extra no teste). */
class FakeAdvisor implements OpinionAdvisor {
  readonly model = 'fake-flash';
  calls: AdvisorInput[] = [];

  async ask(input: AdvisorInput): Promise<AdvisorResult> {
    this.calls.push(input);
    const opinion: Opinion = {
      version: 'parecer/1',
      jobId: input.jobId,
      fase: input.fase,
      recomendacao: 'revisar',
      motivos: ['a proposta precisa de fonte para a promessa'],
      evidencias: [],
      contrapontos: [],
      lacunas: [],
      proximoTeste: 'apontar a fonte da promessa',
      confianca: 'media',
    };
    return { ok: true, opinion, model: 'fake-flash', ms: 5, usage: { promptTokens: 10, completionTokens: 5 } };
  }
}

function servicoComConselheiro(): AdvisorService {
  return new AdvisorService(new FakeAdvisor(), new MemoryAdvisorJournal());
}

describe('trabalhador do Radar', () => {
  let mem: PgMemory;
  let store: PgRadarStore;
  let root: string;
  let artifacts: ArtifactStore;

  before(async () => {
    await resetTestDb(TEST_URL);
    mem = await PgMemory.open(TEST_URL);
    store = await PgRadarStore.open(TEST_URL);
    root = await mkdtemp(join(tmpdir(), 'night-radar-worker-'));
    artifacts = new ArtifactStore(root);
  });
  after(async () => {
    await store?.close();
    await mem?.close();
    await rm(root, { recursive: true, force: true });
  });
  beforeEach(async () => { await truncateAll(); });

  /** As FKs de radar_candidates/radar_cursors exigem um job radar de verdade. */
  async function novoJob(): Promise<string> {
    const { job } = await mem.createJob({
      kind: 'radar', origin: 'texto', idempotencyKey: `radar-worker-${randomUUID()}`,
    });
    return job.id;
  }

  function pedido(jobId: string, params: Record<string, unknown> = {}): WorkerRequest {
    return {
      contract: WORKER_CONTRACT,
      jobId,
      kind: 'radar',
      params: { query: 'organização em casa', ...params },
      limits: {},
    };
  }

  /** start + espera o fim sem polling; devolve runId e resultado. */
  async function rodar(
    worker: RadarWorker, request: WorkerRequest,
  ): Promise<{ runId: string; result: Awaited<ReturnType<RadarWorker['result']>> }> {
    const { runId } = await worker.start(request);
    await worker.whenDone(runId);
    return { runId, result: await worker.result(runId) };
  }

  async function lerRelatorio(jobId: string): Promise<RelatorioRadar> {
    const manifesto = await artifacts.manifest(jobId);
    assert.ok(
      manifesto?.items.some((item) => item.name === RELATORIO_RADAR),
      'relatório deveria estar no manifesto',
    );
    const texto = await readFile(join(root, jobId, RELATORIO_RADAR), 'utf8');
    return JSON.parse(texto) as RelatorioRadar;
  }

  test('sem fonte: espera fonte e não grava nada no banco', async () => {
    const jobId = await novoJob();
    const worker = new RadarWorker({ store, artifacts, source: null, generator: null });

    const { result } = await rodar(worker, pedido(jobId));

    assert.equal(result.state, 'waiting');
    assert.equal(result.waitingFor, 'fonte');
    assert.match(result.message ?? '', /falta provar a fonte de anúncios/);
    assert.match(result.message ?? '', /nada foi coletado/);
    assert.deepEqual(result.artifacts, []);
    assert.equal(await store.countCandidates(), 0);
  });

  test('fluxo completo: coleta, pontua, cria oferta e grava relatório', async () => {
    const jobId = await novoJob();
    const source = new FakeSource([[ALTA]]);
    const { generator, chamadas } = geradorFalso();
    const worker = new RadarWorker({
      store, artifacts, source, generator, advisor: servicoComConselheiro(),
    });

    const { result } = await rodar(worker, pedido(jobId));

    assert.equal(result.state, 'succeeded', result.error ?? '');
    assert.ok(
      result.artifacts.some((item) => item.name === RELATORIO_RADAR),
      'resultado deveria apontar o relatório',
    );
    assert.match(result.message ?? '', /relatório pronto/);
    assert.equal(chamadas.length, 1, 'uma oferta para o único domínio');

    const relatorio = await lerRelatorio(jobId);
    assert.equal(relatorio.jobId, jobId);
    assert.equal(relatorio.query, 'organização em casa');
    assert.deepEqual(relatorio.keywords, ['organização em casa']);
    assert.equal(relatorio.coleta['organização em casa']?.novos, 1);
    assert.equal(relatorio.totais.vistos, 1);
    assert.equal(relatorio.candidatosColetados.length, 1);
    assert.equal(relatorio.candidatosPontuados.length, 1);

    const pontuado = relatorio.candidatosPontuados[0]!;
    assert.equal(pontuado.dominio, 'alta.example');
    assert.equal(pontuado.nota, 10);
    assert.equal(pontuado.parcial, false);
    assert.match(pontuado.justificativa, /94 anúncios ativos/);

    const candidato = await store.getCandidate(pontuado.id);
    assert.equal(candidato?.score?.nota, 10);

    assert.equal(relatorio.ofertas.length, 1);
    assert.equal(relatorio.ofertas[0]?.number, 1);
    assert.equal(relatorio.ofertas[0]?.status, 'rascunho');
    assert.equal(relatorio.ofertas[0]?.grupo, pontuado.id);

    const oferta = await store.getOffer(1);
    assert.ok(oferta);
    assert.equal(oferta.status, 'rascunho');
    assert.equal(oferta.candidateId, pontuado.id);
  });

  test('nota parcial não vira 0 e fica registrada como parcial', async () => {
    const jobId = await novoJob();
    const source = new FakeSource([[PARCIAL]]);
    const worker = new RadarWorker({ store, artifacts, source, generator: null });

    const { result } = await rodar(worker, pedido(jobId));

    assert.equal(result.state, 'succeeded');
    assert.equal(result.message, 'nenhum candidato acima do corte');

    const relatorio = await lerRelatorio(jobId);
    const pontuado = relatorio.candidatosPontuados[0]!;
    // 94 anúncios ativos = 3 pontos; os critérios ausentes ficam null, não zero.
    assert.equal(pontuado.nota, 3);
    assert.equal(pontuado.parcial, true);
    assert.deepEqual(relatorio.ofertas, []);

    const candidato = await store.getCandidate(pontuado.id);
    assert.equal(candidato?.score?.nota, 3);
    assert.equal(candidato?.score?.parcial, true);
    const diasNoAr = candidato?.score?.criterios.find((c) => c.nome === 'diasNoAr');
    assert.equal(diasNoAr?.valor, null);
    assert.equal(diasNoAr?.pontos, null);
  });

  test('nenhum candidato acima do corte: sucesso com relatório e sem gerador chamado', async () => {
    const jobId = await novoJob();
    const source = new FakeSource([[BAIXA]]);
    const { generator, chamadas } = geradorFalso();
    const worker = new RadarWorker({ store, artifacts, source, generator });

    const { result } = await rodar(worker, pedido(jobId));

    assert.equal(result.state, 'succeeded');
    assert.equal(result.message, 'nenhum candidato acima do corte');
    assert.equal(chamadas.length, 0, 'abaixo do corte não gera oferta');
    assert.equal(await store.getOffer(1), null);

    const relatorio = await lerRelatorio(jobId);
    assert.equal(relatorio.candidatosPontuados.length, 1);
    assert.equal(relatorio.candidatosPontuados[0]?.nota, 4);
    assert.deepEqual(relatorio.ofertas, []);
  });

  test('sem gerador: espera gerador com coleta e notas prontas', async () => {
    const jobId = await novoJob();
    const source = new FakeSource([[ALTA]]);
    const worker = new RadarWorker({ store, artifacts, source, generator: null });

    const { result } = await rodar(worker, pedido(jobId));

    assert.equal(result.state, 'waiting');
    assert.equal(result.waitingFor, 'gerador');
    assert.match(result.message ?? '', /falta o gerador/);
    assert.ok(result.artifacts.some((item) => item.name === RELATORIO_RADAR));

    const relatorio = await lerRelatorio(jobId);
    assert.equal(relatorio.candidatosPontuados.length, 1);
    assert.equal(relatorio.candidatosPontuados[0]?.nota, 10);
    assert.deepEqual(relatorio.ofertas, []);
    assert.equal(await store.countCandidates(), 1);
    assert.equal(await store.getOffer(1), null);
  });

  test('planejamento junta termos, registra avisos e limita a coleta', async () => {
    const jobId = await novoJob();
    const source = new FakeSource([[], [ALTA]]);
    let chamadas = 0;
    const planejador: PlanejadorNichos = {
      async planejar(query, max) {
        chamadas += 1;
        assert.equal(query, 'organização em casa');
        assert.equal(max, 8);
        return {
          autor: 'codex:teste', avisos: ['pesquisa parcial'],
          nichos: [
            { tipo: 'nicho', nome: 'Agendas', termo: 'agenda semanal', motivo: 'demanda', fontes: ['https://example.com/1'] },
            { tipo: 'oferta', nome: 'Rotinas', termo: 'rotina doméstica', motivo: 'demanda', fontes: ['https://example.com/2'] },
          ],
        };
      },
    };
    const frases = Array.from({ length: 8 }, (_, i) => `frase ${i + 1}`);
    const request = pedido(jobId, { keywords: frases, planejarNichos: true });
    const worker = new RadarWorker({ store, artifacts, source, generator: null, planejador });
    const primeira = await rodar(worker, request);
    assert.equal(primeira.result.state, 'succeeded');
    assert.equal(chamadas, 1);
    // Com nichos, o Claude busca só os termos deles; as frases de preço ficam de reserva.
    assert.deepEqual(source.calls.map((call) => call.keyword), ['agenda semanal', 'rotina doméstica']);
    assert.ok(source.calls.every((call) => call.limit === 8 && call.cursor === null), 'teto de 15 por dia: 2 termos, 8 cada, 1 página');
    const relatorio = await lerRelatorio(jobId);
    assert.deepEqual(relatorio.keywords, ['agenda semanal', 'rotina doméstica']);
    assert.deepEqual(relatorio.nichos?.map((nicho) => nicho.nome), ['Agendas', 'Rotinas']);
    assert.ok(relatorio.avisos.includes('Nichos (codex:teste): Agendas, Rotinas'));
    assert.ok(relatorio.avisos.includes('pesquisa parcial'));

    const retomada = new RadarWorker({ store, artifacts, source: new FakeSource([[]]), generator: null, planejador });
    const segunda = await rodar(retomada, request);
    assert.equal(segunda.result.state, 'succeeded');
    assert.equal(chamadas, 1, 'o relatório guarda o plano para a retomada');
  });

  test('plano vazio usa só as frases e preserva os avisos', async () => {
    const jobId = await novoJob();
    const source = new FakeSource([[]]);
    const planejador: PlanejadorNichos = {
      async planejar() { return { autor: 'nenhum', nichos: [], avisos: ['sem fonte'] }; },
    };
    const worker = new RadarWorker({ store, artifacts, source, generator: null, planejador });
    const { result } = await rodar(worker, pedido(jobId, { keywords: ['frase'], planejarNichos: true }));
    assert.equal(result.state, 'succeeded');
    assert.deepEqual(source.calls.map((call) => call.keyword), ['frase']);
    const relatorio = await lerRelatorio(jobId);
    assert.deepEqual(relatorio.nichos, []);
    assert.ok(relatorio.avisos.includes('sem fonte'));
    assert.ok(relatorio.avisos.includes('Nichos (nenhum): '));
  });

  test('sem planejador mantém os limites e as palavras do pedido', async () => {
    const jobId = await novoJob();
    const source = new FakeSource([[], []]);
    const worker = new RadarWorker({ store, artifacts, source, generator: null });
    const { result } = await rodar(worker, pedido(jobId, { keywords: ['frase'], planejarNichos: true }));
    assert.equal(result.state, 'succeeded');
    // Caminho de sempre: teto padrão (50) e a coleta para na primeira página vazia.
    assert.deepEqual(source.calls.map((call) => [call.keyword, call.cursor, call.limit]), [['frase', null, 50]]);
    const relatorio = await lerRelatorio(jobId);
    assert.equal(relatorio.nichos, undefined);
    assert.deepEqual(relatorio.avisos, []);
  });

  test('retomada não duplica oferta nem candidato', async () => {
    const jobId = await novoJob();
    const request = pedido(jobId);

    // Primeira tentativa sem gerador: coleta e nota ficam prontas e o trabalho espera.
    const semGerador = new RadarWorker({
      store, artifacts, source: new FakeSource([[ALTA]]), generator: null,
    });
    const primeira = await rodar(semGerador, request);
    assert.equal(primeira.result.state, 'waiting');
    assert.equal(await store.countCandidates(), 1);

    // Retomada com gerador: cria a oferta uma vez.
    const { generator, chamadas } = geradorFalso();
    const comGerador = new RadarWorker({
      store, artifacts, source: new FakeSource([[ALTA]]), generator,
      advisor: servicoComConselheiro(),
    });
    const segunda = await rodar(comGerador, request);
    assert.equal(segunda.result.state, 'succeeded');
    assert.equal(chamadas.length, 1);
    assert.equal(await store.countCandidates(), 1, 'a fonte repetida não duplica candidato');
    assert.ok(await store.getOffer(1));
    assert.equal(await store.getOffer(2), null);

    // Reinício do NIGHT: instância nova relê o relatório e não refaz a mesma oferta.
    const reiniciado = new RadarWorker({
      store, artifacts, source: new FakeSource([[ALTA]]), generator,
      advisor: servicoComConselheiro(),
    });
    const terceira = await rodar(reiniciado, request);
    assert.equal(terceira.result.state, 'succeeded');
    assert.equal(chamadas.length, 1, 'o grupo já registrado no relatório não gera outra oferta');
    assert.equal(await store.getOffer(2), null);

    const relatorio = await lerRelatorio(jobId);
    assert.equal(relatorio.candidatosColetados.length, 1);
    assert.equal(relatorio.candidatosPontuados.length, 1);
    assert.equal(relatorio.ofertas.length, 1);
    assert.equal(relatorio.ofertas[0]?.number, 1);
  });

  test('start é idempotente enquanto a execução está ativa', async () => {
    const jobId = await novoJob();
    const source = new GateSource();
    const worker = new RadarWorker({ store, artifacts, source, generator: null });

    const primeiro = await worker.start(pedido(jobId));
    const segundo = await worker.start(pedido(jobId));

    assert.equal(segundo.runId, primeiro.runId, 'execução ativa devolve o mesmo runId');
    assert.equal((await worker.status(primeiro.runId)).state, 'running');

    source.abrir();
    await worker.whenDone(primeiro.runId);
    const result = await worker.result(primeiro.runId);
    assert.equal(result.state, 'waiting');
    assert.equal(source.calls, 1, 'a execução não foi iniciada duas vezes');
    assert.equal(await store.countCandidates(), 1);
  });
});
