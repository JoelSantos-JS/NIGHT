// Serviço de parecer sem internet: conselheiro falso e diário em memória.
// O diário PostgreSQL usa o banco de teste e confere gravação, cache, contagem e reabertura.

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import pg from 'pg';
import type { AdvisorFailureReason, AdvisorResult } from '../src/advisor/deepseek-client.ts';
import { decide } from '../src/advisor/divergence.ts';
import type { DivergenceInput } from '../src/advisor/divergence.ts';
import { MemoryAdvisorJournal, PgAdvisorJournal } from '../src/advisor/journal.ts';
import type { AdvisorJournalInput } from '../src/advisor/journal.ts';
import { AdvisorService, inputHash } from '../src/advisor/service.ts';
import type { OpinionAdvisor } from '../src/advisor/service.ts';
import type { AdvisorInput, Opinion, Recomendacao } from '../src/advisor/opinion.ts';
import { resetTestDb, TEST_URL, truncateAll } from './helpers.ts';

const MODEL = 'fake-flash';

function opinion(recomendacao: Recomendacao = 'prosseguir'): Opinion {
  return {
    version: 'parecer/1',
    jobId: 'job-1',
    fase: 'revisao',
    recomendacao,
    motivos: ['o teste cobre o objetivo'],
    evidencias: [{ ref: 'ev-diff', sustenta: 'o teste passa' }],
    contrapontos: [],
    lacunas: [],
    proximoTeste: 'nenhum teste novo necessário',
    confianca: 'media',
  };
}

function okResult(over: Partial<Opinion> = {}): AdvisorResult {
  return {
    ok: true,
    opinion: { ...opinion(), ...over },
    model: MODEL,
    ms: 12,
    usage: { promptTokens: 10, completionTokens: 5 },
  };
}

function failResult(reason: AdvisorFailureReason = 'timeout'): AdvisorResult {
  return {
    ok: false,
    state: 'parecer_indisponivel',
    reason,
    detail: 'DeepSeek passou do tempo; o parecer não foi feito',
    model: MODEL,
    ms: 20,
  };
}

function input(over: Partial<AdvisorInput> = {}): AdvisorInput {
  return {
    jobId: 'job-1',
    dominio: 'codigo',
    fase: 'revisao',
    objetivo: 'revisar o diff',
    pergunta: 'o diff cobre o objetivo?',
    evidencias: [{ ref: 'ev-diff', origem: 'git diff', conteudo: '+function x() {}', externa: false }],
    ...over,
  };
}

/** Conselheiro falso: guarda cada entrada e responde pela função dada. */
class FakeAdvisor implements OpinionAdvisor {
  readonly model = MODEL;
  calls: AdvisorInput[] = [];

  constructor(private readonly behave: (input: AdvisorInput, chamada: number) => AdvisorResult = () => okResult()) {}

  async ask(entrada: AdvisorInput): Promise<AdvisorResult> {
    this.calls.push(entrada);
    return this.behave(entrada, this.calls.length);
  }
}

describe('AdvisorService com diário em memória', () => {
  test('ponto dispensado não chama o conselheiro nem grava', async () => {
    const advisor = new FakeAdvisor();
    const journal = new MemoryAdvisorJournal();
    const service = new AdvisorService(advisor, journal);

    // codigo.cartao tem impacto baixo; caso simples é dispensado pela matriz.
    const r = await service.consult('codigo.cartao', input(), { simples: true });
    if (r.status !== 'dispensado') assert.fail(`esperava dispensado, veio ${r.status}`);
    assert.ok(r.motivo.length > 0);
    assert.equal(advisor.calls.length, 0);
    assert.equal((await journal.list('job-1')).length, 0);
  });

  test('parecer bom é gravado com uso, modelo e papel', async () => {
    const advisor = new FakeAdvisor();
    const journal = new MemoryAdvisorJournal();
    const service = new AdvisorService(advisor, journal);

    const r = await service.consult('codigo.diff-final', input(), { role: 'reserva-codex' });
    if (r.status !== 'ok') assert.fail(`esperava ok, veio ${r.status}`);
    assert.equal(r.opinion.recomendacao, 'prosseguir');

    const entries = await journal.list('job-1');
    assert.equal(entries.length, 1);
    const entry = entries[0]!;
    assert.equal(entry.id, r.entryId);
    assert.equal(entry.ok, true);
    assert.equal(entry.model, MODEL);
    assert.equal(entry.role, 'reserva-codex');
    assert.equal(entry.author, 'deepseek');
    assert.equal(entry.promptTokens, 10);
    assert.equal(entry.completionTokens, 5);
    assert.equal(entry.ms, 12);
    assert.equal(entry.opinion?.recomendacao, 'prosseguir');
    assert.equal(await journal.countCalls('job-1', 'codigo.diff-final'), 1);
  });

  test('job repetido vem do cache sem chamar o conselheiro de novo', async () => {
    const advisor = new FakeAdvisor();
    const journal = new MemoryAdvisorJournal();
    const service = new AdvisorService(advisor, journal);

    const primeiro = await service.consult('codigo.diff-final', input());
    const segundo = await service.consult('codigo.diff-final', input());
    if (primeiro.status !== 'ok') assert.fail(`esperava ok, veio ${primeiro.status}`);
    if (segundo.status !== 'cache') assert.fail(`esperava cache, veio ${segundo.status}`);

    assert.equal(advisor.calls.length, 1);
    assert.equal(segundo.entryId, primeiro.entryId);
    assert.deepEqual(segundo.opinion, primeiro.opinion);
    assert.equal((await journal.list('job-1')).length, 1);
  });

  test('duas consultas iguais simultâneas chamam o conselheiro uma vez só', async () => {
    const advisor = new FakeAdvisor();
    const journal = new MemoryAdvisorJournal();
    const service = new AdvisorService(advisor, journal);

    // A reserva atômica impede que as duas leiam o mesmo cache vazio e paguem duas vezes.
    const resultados = await Promise.all([
      service.consult('codigo.diff-final', input()),
      service.consult('codigo.diff-final', input()),
    ]);

    assert.equal(advisor.calls.length, 1);
    assert.equal(resultados.filter((r) => r.status === 'ok').length, 1);
    const outro = resultados.find((r) => r.status !== 'ok')!;
    assert.ok(
      outro.status === 'em_andamento' || outro.status === 'cache',
      `esperava em_andamento ou cache, veio ${outro.status}`,
    );
    assert.equal((await journal.list('job-1')).length, 1);
  });

  test('entrada diferente chama de novo e grava outra versão', async () => {
    const advisor = new FakeAdvisor();
    const journal = new MemoryAdvisorJournal();
    const service = new AdvisorService(advisor, journal);

    // geral.divergencia permite 2 chamadas por trabalho.
    const primeiro = await service.consult('geral.divergencia', input({ objetivo: 'primeira leitura' }));
    const segundo = await service.consult('geral.divergencia', input({ objetivo: 'leitura mudou' }));
    if (primeiro.status !== 'ok') assert.fail(`esperava ok, veio ${primeiro.status}`);
    if (segundo.status !== 'ok') assert.fail(`esperava ok, veio ${segundo.status}`);

    assert.equal(advisor.calls.length, 2);
    assert.notEqual(primeiro.entryId, segundo.entryId);
    assert.equal((await journal.list('job-1')).length, 2);
  });

  test('hash da entrada é estável e muda quando o conteúdo muda', () => {
    const base = input();
    const reordenado = input({
      evidencias: [{ externa: false, conteudo: '+function x() {}', ref: 'ev-diff', origem: 'git diff' }],
    });
    assert.equal(inputHash(base), inputHash(reordenado));
    assert.notEqual(inputHash(base), inputHash(input({ objetivo: 'outro objetivo' })));
  });

  test('teto do ponto impede nova chamada', async () => {
    const advisor = new FakeAdvisor();
    const journal = new MemoryAdvisorJournal();
    const service = new AdvisorService(advisor, journal);

    // codigo.diff-final permite 1 chamada por trabalho.
    const primeiro = await service.consult('codigo.diff-final', input());
    const segundo = await service.consult('codigo.diff-final', input({ objetivo: 'outro diff' }));
    if (primeiro.status !== 'ok') assert.fail(`esperava ok, veio ${primeiro.status}`);
    if (segundo.status !== 'teto') assert.fail(`esperava teto, veio ${segundo.status}`);

    assert.match(segundo.motivo, /teto/);
    assert.equal(advisor.calls.length, 1);
  });

  test('reserva pendente ocupa o teto mesmo sem consulta concluída', async () => {
    const advisor = new FakeAdvisor();
    const journal = new MemoryAdvisorJournal();
    const reserva = await journal.reserve('job-1', 'codigo.diff-final', 'hash-pendente', 1);
    assert.equal(reserva.kind, 'reservado');

    // codigo.diff-final permite 1 chamada; a reserva pendente de outra entrada já conta.
    const service = new AdvisorService(advisor, journal);
    const r = await service.consult('codigo.diff-final', input());
    if (r.status !== 'teto') assert.fail(`esperava teto, veio ${r.status}`);
    assert.equal(advisor.calls.length, 0);
    assert.equal(await journal.countCalls('job-1', 'codigo.diff-final'), 1);
  });

  test('reserva abandonada há mais de 10 minutos é liberada', async () => {
    let agora = Date.now();
    const journal = new MemoryAdvisorJournal(() => agora);
    const primeira = await journal.reserve('job-1', 'geral.divergencia', 'hash-1', 2);
    assert.equal(primeira.kind, 'reservado');

    // Antes do prazo a mesma reserva ainda está em andamento.
    assert.equal((await journal.reserve('job-1', 'geral.divergencia', 'hash-1', 2)).kind, 'em_andamento');

    agora += 11 * 60_000;
    const segunda = await journal.reserve('job-1', 'geral.divergencia', 'hash-1', 2);
    assert.equal(segunda.kind, 'reservado');

    const [abandonada] = await journal.list('job-1');
    assert.equal(abandonada?.reason, 'abandonada');
    assert.equal(abandonada?.ok, false);
  });

  test('falha vira parecer_indisponivel, grava motivo e não é ok', async () => {
    const advisor = new FakeAdvisor(() => failResult('timeout'));
    const journal = new MemoryAdvisorJournal();
    const service = new AdvisorService(advisor, journal);

    const r = await service.consult('codigo.diff-final', input());
    if (r.status !== 'parecer_indisponivel') assert.fail(`esperava indisponível, veio ${r.status}`);
    assert.equal(r.reason, 'timeout');
    assert.match(r.detail, /parecer não foi feito/);

    const entries = await journal.list('job-1');
    assert.equal(entries.length, 1);
    const entry = entries[0]!;
    assert.equal(entry.id, r.entryId);
    assert.equal(entry.ok, false);
    assert.equal(entry.reason, 'timeout');
    assert.equal(entry.opinion, null);
    assert.equal(entry.ms, 20);
  });

  test('falha não entra no cache: a mesma entrada tenta de novo até o teto', async () => {
    const advisor = new FakeAdvisor(() => failResult('rede'));
    const journal = new MemoryAdvisorJournal();
    const service = new AdvisorService(advisor, journal);

    // geral.divergencia permite 2 chamadas por trabalho.
    const primeira = await service.consult('geral.divergencia', input());
    const segunda = await service.consult('geral.divergencia', input());
    const terceira = await service.consult('geral.divergencia', input());
    assert.equal(primeira.status, 'parecer_indisponivel');
    assert.equal(segunda.status, 'parecer_indisponivel');
    if (terceira.status !== 'teto') assert.fail(`esperava teto, veio ${terceira.status}`);
    assert.equal(advisor.calls.length, 2);
  });

  test('conselheiro que lança também vira parecer_indisponivel', async () => {
    const advisor = new FakeAdvisor(() => {
      throw new Error('quebrou');
    });
    const journal = new MemoryAdvisorJournal();
    const service = new AdvisorService(advisor, journal);

    const r = await service.consult('codigo.diff-final', input());
    if (r.status !== 'parecer_indisponivel') assert.fail(`esperava indisponível, veio ${r.status}`);
    assert.equal(r.reason, 'erro');
    assert.equal((await journal.list('job-1'))[0]?.ok, false);
  });
});

function entryInput(over: Partial<AdvisorJournalInput> = {}): AdvisorJournalInput {
  return {
    jobId: 'job-db',
    pointId: 'codigo.diff-final',
    inputHash: 'hash-1',
    model: 'deepseek-flash',
    ok: true,
    opinion: opinion(),
    ms: 10,
    role: 'conselheiro',
    ...over,
  };
}

describe('PgAdvisorJournal no banco de teste', () => {
  let journal: PgAdvisorJournal;

  before(async () => {
    await resetTestDb(TEST_URL);
    journal = await PgAdvisorJournal.open(TEST_URL);
  });
  after(async () => { await journal?.close(); });
  beforeEach(async () => { await truncateAll(); });

  test('grava, acha no cache, conta chamadas e lista por trabalho', async () => {
    const bom = await journal.record(entryInput());
    const falha = await journal.record(entryInput({
      inputHash: 'hash-2', ok: false, reason: 'timeout', opinion: null, role: 'reserva-codex',
    }));

    assert.ok(bom.id);
    assert.ok(falha.id);
    assert.equal(bom.author, 'deepseek');
    assert.equal(bom.role, 'conselheiro');
    assert.equal(falha.role, 'reserva-codex');
    assert.equal(falha.opinion, null);
    assert.equal(falha.promptTokens, null);

    const cache = await journal.findCached('job-db', 'codigo.diff-final', 'hash-1');
    assert.equal(cache?.id, bom.id);
    assert.equal(cache?.opinion?.recomendacao, 'prosseguir');
    // Falha não vira cache, mesmo com a mesma chave de trabalho e ponto.
    assert.equal(await journal.findCached('job-db', 'codigo.diff-final', 'hash-2'), null);

    assert.equal(await journal.countCalls('job-db', 'codigo.diff-final'), 2);
    assert.equal(await journal.countCalls('job-db', 'geral.divergencia'), 0);

    const listados = await journal.list('job-db');
    assert.equal(listados.length, 2);
    assert.deepEqual(listados.map((e) => e.id).sort(), [bom.id, falha.id].sort());
  });

  test('reabrir o diário mantém as entradas', async () => {
    const salvo = await journal.record(entryInput({
      jobId: 'job-reabrir', pointId: 'geral.divergencia', inputHash: 'hash-r',
    }));

    const outra = await PgAdvisorJournal.open(TEST_URL);
    try {
      const cache = await outra.findCached('job-reabrir', 'geral.divergencia', 'hash-r');
      assert.equal(cache?.id, salvo.id);
      assert.equal((await outra.list('job-reabrir')).length, 1);
      assert.equal(await outra.countCalls('job-reabrir', 'geral.divergencia'), 1);
    } finally {
      await outra.close();
    }
  });

  test('duas consultas iguais simultâneas no banco chamam o conselheiro uma vez só', async () => {
    const advisor = new FakeAdvisor();
    const service = new AdvisorService(advisor, journal);

    // A trava por trabalho+ponto serializa as reservas: só uma vira chamada paga.
    const resultados = await Promise.all([
      service.consult('codigo.diff-final', input()),
      service.consult('codigo.diff-final', input()),
    ]);

    assert.equal(advisor.calls.length, 1);
    assert.equal(resultados.filter((r) => r.status === 'ok').length, 1);
    const outro = resultados.find((r) => r.status !== 'ok')!;
    assert.ok(
      outro.status === 'em_andamento' || outro.status === 'cache',
      `esperava em_andamento ou cache, veio ${outro.status}`,
    );
    assert.equal(await journal.countCalls('job-1', 'codigo.diff-final'), 1);
  });

  test('reserva pendente ocupa o teto no banco', async () => {
    const advisor = new FakeAdvisor();
    const reserva = await journal.reserve('job-1', 'codigo.diff-final', 'hash-pendente', 1);
    assert.equal(reserva.kind, 'reservado');

    const service = new AdvisorService(advisor, journal);
    const r = await service.consult('codigo.diff-final', input());
    if (r.status !== 'teto') assert.fail(`esperava teto, veio ${r.status}`);
    assert.equal(advisor.calls.length, 0);
  });

  test('reserva pendente antiga vira abandonada e libera nova reserva', async () => {
    const primeira = await journal.reserve('job-aband', 'geral.divergencia', 'hash-a', 2);
    assert.equal(primeira.kind, 'reservado');
    if (primeira.kind !== 'reservado') return;

    // Envelhece a reserva direto no banco: 11 minutos passam do prazo de abandono.
    const client = new pg.Client({ connectionString: TEST_URL });
    await client.connect();
    try {
      await client.query(
        `UPDATE advisor_opinions SET at = now() - interval '11 minutes' WHERE id = $1`,
        [primeira.reservationId],
      );
    } finally {
      await client.end();
    }

    const segunda = await journal.reserve('job-aband', 'geral.divergencia', 'hash-a', 2);
    assert.equal(segunda.kind, 'reservado');

    const entradas = await journal.list('job-aband');
    assert.equal(entradas.length, 2);
    assert.equal(entradas[0]!.reason, 'abandonada');
    assert.equal(entradas[0]!.ok, false);
  });
});

function divergenciaInput(over: Partial<DivergenceInput> = {}): DivergenceInput {
  return {
    testes: 'passaram',
    fontesObrigatoriasOk: true,
    reservadoAoJoel: false,
    pareceres: [
      { autor: 'codex', recomendacao: 'prosseguir' },
      { autor: 'claude', recomendacao: 'prosseguir' },
    ],
    autorDoTrabalho: 'deepseek',
    ...over,
  };
}

describe('regra de divergência', () => {
  test('tudo verde e pareceres concordando: prosseguir', () => {
    const r = decide(divergenciaInput());
    assert.equal(r.decisao, 'prosseguir');
    assert.equal(r.divergencia, false);
  });

  test('teste falhou vira corrigir mesmo com todos aprovando', () => {
    const r = decide(divergenciaInput({ testes: 'falharam' }));
    assert.equal(r.decisao, 'corrigir');
    assert.equal(r.divergencia, false);
    assert.match(r.motivo, /teste/);
  });

  test('teste que não rodou também vira corrigir', () => {
    const r = decide(divergenciaInput({ testes: 'nao_rodaram' }));
    assert.equal(r.decisao, 'corrigir');
    assert.match(r.motivo, /teste/);
  });

  test('fonte obrigatória faltando vira corrigir', () => {
    const r = decide(divergenciaInput({ fontesObrigatoriasOk: false }));
    assert.equal(r.decisao, 'corrigir');
    assert.match(r.motivo, /fonte/);
  });

  test('ação reservada a Joel vai para Joel mesmo com tudo verde', () => {
    const r = decide(divergenciaInput({ reservadoAoJoel: true }));
    assert.equal(r.decisao, 'perguntar_joel');
    assert.match(r.motivo, /Joel/);
    assert.equal(r.divergencia, false);
  });

  test('parecer do próprio autor não aprova o próprio trabalho', () => {
    const r = decide(divergenciaInput({
      pareceres: [{ autor: 'deepseek', recomendacao: 'prosseguir' }],
    }));
    assert.equal(r.decisao, 'perguntar_joel');
    assert.match(r.motivo, /sem revisão independente/);
  });

  test('parecer do próprio autor não bloqueia quando outro agente aprova', () => {
    const r = decide(divergenciaInput({
      pareceres: [
        { autor: 'deepseek', recomendacao: 'parar' },
        { autor: 'codex', recomendacao: 'prosseguir' },
      ],
    }));
    assert.equal(r.decisao, 'prosseguir');
    assert.equal(r.divergencia, false);
  });

  test('parecer indisponível não conta como aprovação', () => {
    const soIndisponivel = decide(divergenciaInput({
      pareceres: [{ autor: 'codex', recomendacao: 'indisponivel' }],
    }));
    assert.equal(soIndisponivel.decisao, 'perguntar_joel');
    assert.match(soIndisponivel.motivo, /sem revisão independente/);
    assert.match(soIndisponivel.motivo, /indispon/i);

    // Com um parecer independente válido, o indisponível não impede prosseguir.
    const comAprovacao = decide(divergenciaInput({
      pareceres: [
        { autor: 'codex', recomendacao: 'indisponivel' },
        { autor: 'claude', recomendacao: 'prosseguir' },
      ],
    }));
    assert.equal(comAprovacao.decisao, 'prosseguir');
  });

  for (const contra of ['revisar', 'parar'] as const) {
    test(`divergência entre prosseguir e ${contra} vai para Joel`, () => {
      const r = decide(divergenciaInput({
        pareceres: [
          { autor: 'codex', recomendacao: 'prosseguir' },
          { autor: 'claude', recomendacao: contra },
        ],
      }));
      assert.equal(r.decisao, 'perguntar_joel');
      assert.equal(r.divergencia, true);
      assert.match(r.motivo, /diverg/i);
    });
  }

  test('sem parecer válido de outro agente não é prosseguir', () => {
    const r = decide(divergenciaInput({ pareceres: [] }));
    assert.equal(r.decisao, 'perguntar_joel');
    assert.match(r.motivo, /sem revisão independente/);
  });

  test('pareceres independentes só pedindo revisão ou parada viram corrigir', () => {
    const r = decide(divergenciaInput({
      pareceres: [
        { autor: 'codex', recomendacao: 'revisar' },
        { autor: 'claude', recomendacao: 'parar' },
      ],
    }));
    assert.equal(r.decisao, 'corrigir');
    assert.equal(r.divergencia, false);
  });
});
