import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, test } from 'node:test';
import pg from 'pg';
import { forSpeech, nightDataRoot, NightCoordinator } from '../src/app/coordinator.ts';
import { QuotaError } from '../src/agents/research.ts';
import type { Job, Project } from '../src/core/types.ts';
import type { JobRunner } from '../src/jobs/runner.ts';
import type { Memory } from '../src/core/interfaces.ts';
import type { OpenBotLike } from '../src/openbot/tipos.ts';
import { PgMemory } from '../src/memory/pg-memory.ts';
import { scoreCandidate } from '../src/radar/score.ts';
import { PgRadarStore } from '../src/radar/store.ts';
import { NightRouter } from '../src/router/router.ts';
import { FakeLlm, FakeResearcher, resetTestDb, TEST_URL, truncateAll } from './helpers.ts';

const project = (id: string, name: string): Project => ({
  id, name, description: '', repoPath: `C:/repos/${id}`, defaultBranch: 'main', allowedPaths: [], status: 'active',
});

describe('forSpeech', () => {
  test('tira emoji e markdown, mantém acentos e pontuação', () => {
    assert.equal(forSpeech('Bom dia! 😊 Vamos **lá**.'), 'Bom dia! Vamos lá.');
    assert.equal(forSpeech('- item um\n- item dois 👍🏽'), 'item um\nitem dois');
    assert.equal(forSpeech('Use `git worktree` ❤️'), 'Use git worktree');
  });
});

describe('NightCoordinator', () => {
  let mem: PgMemory;
  let llm: FakeLlm;
  let night: NightCoordinator;

  before(async () => {
    await resetTestDb();
    mem = await PgMemory.open(TEST_URL);
  });
  after(async () => { await mem?.close(); });
  beforeEach(async () => {
    await truncateAll();
    await mem.upsertProject(project('abstrike', 'Abstrike'));
    await mem.upsertProject(project('soaken', 'Soaken'));
    llm = new FakeLlm(() => 'resposta do modelo local');
    night = new NightCoordinator(mem, new NightRouter(llm, async () => (await mem.listProjects()).map((p) => p.name)), llm);
  });

  test('teste 1 do blueprint: salva ideia do Abstrike e depois recupera', async () => {
    const r = await night.handle('Save an idea for Abstrike: alert when an exchange delays a deposit');
    assert.equal(r.text, 'Saved the idea under Abstrike.');
    assert.equal(r.language, 'en');
    const ideas = await mem.findIdeas({ projectId: 'abstrike' });
    assert.equal(ideas.length, 1);
    assert.equal(ideas[0]!.transcript, 'alert when an exchange delays a deposit');

    const back = await night.handle('Quais ideias eu tenho do Abstrike?');
    assert.match(back.text, /Uma ideia no Abstrike\. 1: alert when an exchange delays a deposit/);
    assert.equal(llm.calls.length, 0, 'nada disso precisou do modelo');
  });

  test('ideia sem texto: pergunta e salva a próxima fala', async () => {
    const ask = await night.handle('salva uma ideia para o Soaken');
    assert.equal(ask.text, 'Pode falar a ideia para o Soaken.');
    assert.equal((await mem.findIdeas({})).length, 0);
    const done = await night.handle('modo karaokê com as músicas do usuário');
    assert.equal(done.text, 'Salvei a ideia no Soaken.');
    assert.equal((await mem.findIdeas({ projectId: 'soaken' }))[0]!.transcript, 'modo karaokê com as músicas do usuário');
  });

  test('não diz "salvei" se o banco falhar', async () => {
    const broken = Object.create(mem) as PgMemory;
    broken.saveIdea = async () => { throw new Error('conexão caiu'); };
    const n = new NightCoordinator(broken, new NightRouter(llm, async () => ['Abstrike']), llm);
    const r = await n.handle('salva essa ideia: qualquer coisa');
    assert.match(r.text, /^Não salvei/);
  });

  test('conversa vai para o modelo local com instrução no idioma certo', async () => {
    const r = await night.handle('Me explica o que é uma closure');
    assert.equal(r.text, 'resposta do modelo local');
    assert.equal(r.intent, 'chat');
    assert.match(llm.calls[0]!.messages[0]!.content, /português do Brasil/);
  });

  test('lembrete do idioma vai no começo da fala, e o histórico guarda a fala original', async () => {
    await night.handle('Bom dia, Night');
    await night.handle('What is a git worktree?');
    const msgs = llm.calls[1]!.messages;
    assert.deepEqual(msgs.at(-1), { role: 'user', content: '(Reply in English.) What is a git worktree?' });
    assert.equal(msgs[1]!.content, 'Bom dia, Night');
  });

  test('a conversa leva o histórico', async () => {
    await night.handle('Meu nome é Joel');
    await night.handle('Qual é o meu nome?');
    const sent = llm.calls[1]!.messages.map((m) => m.content);
    assert.ok(sent.includes('Meu nome é Joel'));
    assert.ok(sent.includes('resposta do modelo local'));
  });

  test('teste 4 do blueprint: pedido de código vira tarefa, o modelo local não escreve código', async () => {
    const r = await night.handle('Pede pro Codex escrever um parser no Abstrike');
    assert.equal(r.intent, 'coding-task');
    assert.match(r.text, /Registrei a tarefa \w+ no Abstrike para o codex, mas quem executa tarefas é a outra janela/);
    const [task] = await mem.listTasks();
    assert.equal(task!.status, 'captured');
    assert.equal(task!.primaryAgent, 'codex');
    assert.equal(llm.calls.length, 0);
  });

  test('pedido de código sem projeto pergunta qual', async () => {
    const r = await night.handle('write a parser for trading signals');
    assert.match(r.text, /^Which project\? I have: Abstrike, Soaken\./);
    assert.equal((await mem.listTasks()).length, 0);
  });

  test('status vem do banco', async () => {
    assert.equal((await night.handle('o que tá rodando?')).text, 'Nenhuma tarefa aberta agora.');
    await night.handle('pede pro claude corrigir o bug do login no Soaken');
    assert.match((await night.handle('o que tá rodando?')).text, /^1 tarefa aberta: .*\(claude, captured\)/);
  });

  test('cancelar muda o status de verdade', async () => {
    await night.handle('pede pro claude corrigir o bug do login no Soaken');
    assert.equal((await night.handle('cancela a tarefa do Soaken')).text, 'Cancelei a tarefa.');
    assert.equal((await mem.listTasks())[0]!.status, 'cancelled');
    assert.equal((await night.handle('cancela a tarefa')).text, 'Não tem tarefa aberta para cancelar.');
  });

  test('"aprovo" sem nada pendente não aprova nada', async () => {
    assert.equal((await night.handle('aprovo o merge')).text, 'Não tem nada esperando aprovação.');
  });

  test('toda decisão do roteador fica registrada, sem cota premium', async () => {
    await night.handle('Bom dia');
    await night.handle('salva essa ideia: x');
    const c = new pg.Client({ connectionString: TEST_URL });
    await c.connect();
    const { rows } = await c.query('SELECT intent, model, used_premium FROM route_log ORDER BY at');
    await c.end();
    assert.deepEqual(rows, [
      { intent: 'chat', model: 'fake-local', used_premium: false },
      { intent: 'save-idea', model: 'rules', used_premium: false },
    ]);
  });

  test('registra Radar e Vídeo na fila, com número falável e sem chamar o modelo', async () => {
    const r = await night.handle('vasculha ofertas de fone bluetooth');
    assert.equal(r.intent, 'radar-search');
    assert.equal(r.text, 'Registrei o Radar 1: ofertas de fone bluetooth. Ainda não há trabalhador ligado, ele fica na fila.');
    const [radar] = await mem.listJobs({ kind: 'radar' });
    assert.equal(radar!.number, 1);
    assert.equal(radar!.status, 'queued');
    assert.deepEqual(radar!.params, { query: 'fone bluetooth' });

    const v = await night.handle('cria um vídeo sobre café gelado');
    assert.equal(v.text, 'Registrei o Vídeo 1: café gelado. Ainda não há trabalhador ligado, ele fica na fila.');
    const [video] = await mem.listJobs({ kind: 'video' });
    assert.equal(video!.number, 1);
    assert.equal(llm.calls.length, 0, 'registrar trabalho não gasta modelo');
  });

  test('pedido repetido no mesmo minuto não cria outro trabalho', async () => {
    const first = await night.handle('vasculha ofertas de fone bluetooth');
    const again = await night.handle('vasculha ofertas de fone bluetooth');
    assert.match(first.text, /^Registrei o Radar 1/);
    assert.equal(again.text, 'O Radar 1 já está registrado.');
    assert.equal((await mem.listJobs({ kind: 'radar' })).length, 1);
  });

  /**
   * Runner falso: guarda os ids que começaram, devolve o job do banco e responde
   * isRunning como o JobRunner de verdade. `segurar` imita uma execução demorada.
   */
  function runnerFalso(segurar?: Promise<void>): { runner: JobRunner; runs: string[] } {
    const runs: string[] = [];
    const running = new Set<string>();
    const runner = {
      isRunning(jobId: string): boolean {
        return running.has(jobId);
      },
      async run(jobId: string): Promise<Job> {
        runs.push(jobId);
        running.add(jobId);
        try {
          if (segurar) await segurar;
          const job = await mem.getJob(jobId);
          if (!job) throw new Error(`trabalho ${jobId} não existe`);
          return job;
        } finally {
          running.delete(jobId);
        }
      },
      async cancel(): Promise<{ job: Job; confirmed: boolean; detail: string }> {
        const [job] = await mem.listJobs();
        return { job: job!, confirmed: true, detail: 'ok' };
      },
    } as unknown as JobRunner;
    return { runner, runs };
  }

  test('pedido repetido não dispara outro run no trabalho que já está rodando', async () => {
    let liberar!: () => void;
    const portao = new Promise<void>((resolve) => { liberar = resolve; });
    const { runner, runs } = runnerFalso(portao);
    const comRunner = new NightCoordinator(mem, new NightRouter(llm, async () => []), llm, {
      jobRunners: { video: runner },
    });

    const first = await comRunner.handle('cria um vídeo sobre café gelado');
    assert.match(first.text, /^Comecei o vídeo 1/);
    const again = await comRunner.handle('cria um vídeo sobre café gelado');
    assert.equal(again.text, 'O Vídeo 1 já está registrado.');
    assert.equal(runs.length, 1, 'o pedido repetido não começou outra execução');

    liberar();
    await portao;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(runs.length, 1, 'nada novo depois que a execução termina');
    assert.equal((await mem.listJobs({ kind: 'video' })).length, 1);
  });

  test('"continua o vídeo" duas vezes seguidas dispara uma execução só', async () => {
    let liberar!: () => void;
    const portao = new Promise<void>((resolve) => { liberar = resolve; });
    const { runner, runs } = runnerFalso(portao);
    const comRunner = new NightCoordinator(mem, new NightRouter(llm, async () => []), llm, {
      jobRunners: { video: runner },
    });

    const { job } = await mem.createJob({
      kind: 'video', origin: 'texto', idempotencyKey: 'jr-duplo', params: { topic: 'x' },
    });
    await mem.transitionJob(job.id, 'running', { source: 'worker', message: 'começou' });
    await mem.transitionJob(job.id, 'waiting', {
      source: 'worker', message: 'esperando o Flow', waitingFor: 'flow',
    });

    const primeiro = await comRunner.handle('continua o vídeo 1');
    assert.equal(primeiro.text, 'Retomei o vídeo 1.');
    const segundo = await comRunner.handle('continua o vídeo 1');
    assert.equal(segundo.text, 'O vídeo 1 já está rodando.');
    assert.deepEqual(runs, [job.id], 'uma execução só');

    liberar();
    await portao;
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(runs, [job.id]);
  });

  test('createWork com runner começa o trabalho e responde "Comecei"', async () => {
    const { runner, runs } = runnerFalso();
    const comRunner = new NightCoordinator(mem, new NightRouter(llm, async () => []), llm, {
      jobRunners: { video: runner },
    });

    const r = await comRunner.handle('cria um vídeo sobre café gelado');
    assert.equal(r.intent, 'video-create');
    assert.equal(r.text, "Comecei o vídeo 1: café gelado. Pergunte 'como está o vídeo 1?'");
    await new Promise((resolve) => setImmediate(resolve));
    const [job] = await mem.listJobs({ kind: 'video' });
    assert.deepEqual(runs, [job!.id], 'o runner começou o trabalho criado');
  });

  test('job-resume de waiting chama o runner; succeeded não é retomado', async () => {
    const { runner, runs } = runnerFalso();
    const comRunner = new NightCoordinator(mem, new NightRouter(llm, async () => []), llm, {
      jobRunners: { video: runner },
    });

    const { job: esperando } = await mem.createJob({
      kind: 'video', origin: 'texto', idempotencyKey: 'jr-1', params: { topic: 'x' },
    });
    await mem.transitionJob(esperando.id, 'running', { source: 'worker', message: 'começou' });
    await mem.transitionJob(esperando.id, 'waiting', {
      source: 'worker', message: 'esperando o Flow', waitingFor: 'flow',
    });
    const resume = await comRunner.handle('continua o vídeo 1');
    assert.equal(resume.intent, 'job-resume');
    assert.equal(resume.text, 'Retomei o vídeo 1.');
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(runs, [esperando.id]);

    const { job: pronto } = await mem.createJob({
      kind: 'video', origin: 'texto', idempotencyKey: 'jr-2', params: { topic: 'y' },
    });
    await mem.transitionJob(pronto.id, 'running', { source: 'worker', message: 'começou' });
    await mem.transitionJob(pronto.id, 'succeeded', { source: 'worker', message: 'pronto' });
    const nao = await comRunner.handle('retoma o vídeo 2');
    assert.equal(nao.text, 'Não retomei o vídeo 2: está pronto.');
    assert.deepEqual(runs, [esperando.id], 'succeeded não é retomado');
  });

  test('jobStatus explica cada espera: Flow, voz, fonte e gerador', async () => {
    async function esperando(kind: 'radar' | 'video', key: string, waitingFor: string): Promise<Job> {
      const { job } = await mem.createJob({ kind, origin: 'texto', idempotencyKey: key });
      await mem.transitionJob(job.id, 'running', { source: 'worker', message: 'começou' });
      return mem.transitionJob(job.id, 'waiting', {
        source: 'worker', message: `esperando ${waitingFor}`, waitingFor,
      });
    }
    await esperando('video', 'wf-1', 'flow');
    await esperando('video', 'wf-2', 'voz');
    await esperando('radar', 'wf-3', 'fonte');
    await esperando('radar', 'wf-4', 'gerador');

    const flow = await night.handle('como está o vídeo 1?');
    assert.ok(
      flow.text.includes(`Faltam imagens do Flow: veja ${nightDataRoot()}/flow-import/1/prompts-flow.txt`),
      flow.text,
    );
    const voz = await night.handle('como está o vídeo 2?');
    assert.match(voz.text, /rode "pnpm night:voz" para narrar/);
    const fonte = await night.handle('como está o radar 1?');
    assert.match(fonte.text, /fonte de anúncios/);
    const gerador = await night.handle('como está o radar 2?');
    assert.match(gerador.text, /chave do DeepSeek/);
  });

  test('status do trabalho vem do banco, com número', async () => {
    const { job } = await mem.createJob({ kind: 'video', origin: 'texto', idempotencyKey: 'st-1', params: { topic: 'x' } });
    assert.match((await night.handle('como está o vídeo 1?')).text, /^Vídeo 1 está na fila\./);
    await mem.transitionJob(job.id, 'running', { source: 'worker', message: 'começou' });
    assert.match((await night.handle('status do vídeo 1')).text, /^Vídeo 1 está rodando\./);
    await mem.transitionJob(job.id, 'waiting', { source: 'worker', message: 'esperando o Flow', waitingFor: 'flow' });
    const waiting = await night.handle('como está o vídeo 1?');
    assert.match(waiting.text, /esperando flow/);
    assert.match(waiting.detail ?? '', /esperando o Flow/);
  });

  test('status sem número resume os últimos do tipo; inexistente não inventa', async () => {
    assert.equal((await night.handle('o que o radar achou?')).text, 'Não achei nenhum Radar ainda.');
    await mem.createJob({ kind: 'radar', origin: 'texto', idempotencyKey: 'st-r1' });
    const r = await night.handle('o que o radar achou?');
    assert.match(r.text, /^Últimos: Radar 1 está na fila\./);
    assert.match(r.detail ?? '', /Radar 1/);
    assert.equal((await night.handle('como está o vídeo 9?')).text, 'Não achei o Vídeo 9.');
  });

  test('cancela trabalho pelo número; já final só informa o estado', async () => {
    const { job } = await mem.createJob({ kind: 'video', origin: 'texto', idempotencyKey: 'cx-1' });
    assert.equal((await night.handle('cancela o vídeo 1')).text, 'Cancelei o Vídeo 1.');
    assert.equal((await mem.getJob(job.id))?.status, 'cancelled');
    const again = await night.handle('cancela o vídeo 1');
    assert.equal(again.text, 'O Vídeo 1 foi cancelado; não há o que cancelar.');
    assert.equal((await mem.getJob(job.id))?.status, 'cancelled');

    // waiting/retryable sem runner: nada está rodando, então cancelar basta.
    const { job: waiting } = await mem.createJob({ kind: 'video', origin: 'texto', idempotencyKey: 'cx-2' });
    await mem.transitionJob(waiting.id, 'running', { source: 'worker', message: 'começou' });
    await mem.transitionJob(waiting.id, 'waiting', { source: 'worker', message: 'esperando o Flow', waitingFor: 'flow' });
    assert.equal((await night.handle('cancela o vídeo 2')).text, 'Cancelei o Vídeo 2.');
    assert.equal((await mem.getJob(waiting.id))?.status, 'cancelled');
    assert.equal((await night.handle('cancela o radar 9')).text, 'Não achei o Radar 9.');
  });

  test('decisão sem banco do Radar não grava nada, nem no job de mesmo número', async () => {
    assert.equal((await night.handle('aprova a oferta 1')).text, 'O Radar ainda não tem banco ligado.');
    const { job } = await mem.createJob({ kind: 'radar', origin: 'texto', idempotencyKey: 'd-0' });
    assert.equal((await night.handle('aprova a oferta 1')).text, 'O Radar ainda não tem banco ligado.');
    assert.equal((await mem.listJobEvents(job.id)).length, 1, 'só o evento de criação');
    assert.equal((await mem.listPendingApprovals()).length, 0);
  });

  test('decisão de oferta sem banco do Radar não cai no job radar de mesmo número', async () => {
    const { job } = await mem.createJob({ kind: 'radar', origin: 'texto', idempotencyKey: 'd-1' });
    await mem.transitionJob(job.id, 'running', { source: 'worker', message: 'começou' });
    await mem.transitionJob(job.id, 'succeeded', { source: 'worker', message: 'pronto' });

    const r = await night.handle('aprova a oferta 1');
    assert.equal(r.text, 'O Radar ainda não tem banco ligado.');
    const progress = (await mem.listJobEvents(job.id)).filter((e) => e.eventType === 'progress');
    assert.equal(progress.length, 0, 'não gravou no job só porque o número é igual');
    assert.equal((await mem.listPendingApprovals()).length, 0, 'aprovar oferta não é aprovação de merge');
    assert.equal((await mem.listTasks()).length, 0);
  });

  test('decisão de vídeo pronto grava evento e não publica', async () => {
    const { job } = await mem.createJob({ kind: 'video', origin: 'texto', idempotencyKey: 'd-2' });
    await mem.transitionJob(job.id, 'running', { source: 'worker', message: 'começou' });
    await mem.transitionJob(job.id, 'succeeded', { source: 'worker', message: 'pronto' });

    const r = await night.handle('rejeita o vídeo 1');
    assert.equal(r.text, 'Rejeitei o vídeo 1. Nada foi publicado nem gasto.');
    const progress = (await mem.listJobEvents(job.id)).filter((e) => e.eventType === 'progress');
    assert.equal(progress.length, 1);
    assert.match(progress[0]!.message, /vídeo rejeitado pelo Joel/);
    assert.equal((await mem.listPendingApprovals()).length, 0);
  });

  test('decisão vinda de tela do OpenBot não executa e aponta o painel', async () => {
    const { job } = await mem.createJob({ kind: 'video', origin: 'texto', idempotencyKey: 'tela-v1' });
    await mem.transitionJob(job.id, 'running', { source: 'worker', message: 'começou' });
    await mem.transitionJob(job.id, 'succeeded', { source: 'worker', message: 'pronto' });
    const tela = { origem: 'tela' as const, painelUrl: 'http://127.0.0.1:4517/painel' };

    for (const frase of [
      'aprova o vídeo 1', 'rejeita o vídeo 1', 'aprova a oferta 1', 'aprovo',
      'aprovo montar a campanha da oferta 1 com R$ 20 por dia', 'cancela o vídeo 1', 'cancela a tarefa',
    ]) {
      const r = await night.handle(frase, undefined, tela);
      assert.match(r.text, /^Essa decisão é do Joel e não vale pela tela\. Decida no painel do NIGHT http:\/\/127\.0\.0\.1:4517\/painel/, frase);
      assert.equal(r.model, 'rules');
    }
    const progress = (await mem.listJobEvents(job.id)).filter((e) => e.eventType === 'progress');
    assert.equal(progress.length, 0, 'nenhuma decisão gravada');
    assert.equal((await mem.getJob(job.id))?.status, 'succeeded');
    assert.equal((await mem.listJobs({ kind: 'campanha' })).length, 0);
    const log = await mem.recentActivity(1);
    assert.equal(log[0]!.text, 'cancela a tarefa');
    assert.match(log[0]!.reply ?? '', /não vale pela tela/, 'tentativa fica registrada');
  });

  test('duas falas juntas no começo não perdem o histórico; tela começa sem a conversa dos outros', async () => {
    await night.handle('Meu nome é Joel');
    const n = new NightCoordinator(mem, new NightRouter(llm, async () => (await mem.listProjects()).map((p) => p.name)), llm);
    await Promise.all([n.handle('primeira pergunta'), n.handle('segunda pergunta')]);
    await n.handle('terceira pergunta');
    const sent = llm.calls.at(-1)!.messages.map((m) => m.content);
    assert.ok(sent.includes('Meu nome é Joel'), 'histórico do banco entrou');
    assert.ok(sent.includes('primeira pergunta') && sent.includes('segunda pergunta'), 'falas simultâneas não sumiram');

    const tela = new NightCoordinator(mem, new NightRouter(llm, async () => []), llm, { restoreRecent: false });
    await tela.handle('oi, tela', undefined, { origem: 'tela' });
    const daTela = llm.calls.at(-1)!.messages.map((m) => m.content);
    assert.ok(!daTela.includes('Meu nome é Joel'), 'tela não herda a conversa da voz');
  });

  test('pedido comum vindo de tela funciona igual', async () => {
    const r = await night.handle('Salva uma ideia para o Soaken: modo escuro', undefined, { origem: 'tela' });
    assert.equal(r.text, 'Salvei a ideia no Soaken.');
  });

  test('painel decide pelo mesmo tratador da voz', async () => {
    const { job } = await mem.createJob({ kind: 'video', origin: 'texto', idempotencyKey: 'painel-v1' });
    await mem.transitionJob(job.id, 'running', { source: 'worker', message: 'começou' });
    await mem.transitionJob(job.id, 'succeeded', { source: 'worker', message: 'pronto' });

    const r = await night.decidir({ tipo: 'video', numero: 1, decisao: 'approve' });
    assert.equal(r.text, 'Aprovei o vídeo 1. Isso não publica, não gasta e não faz merge.');
    const progress = (await mem.listJobEvents(job.id)).filter((e) => e.eventType === 'progress');
    assert.equal(progress.length, 1);
    assert.match(progress[0]!.message, /vídeo aprovado pelo Joel/);
    const log = await mem.recentActivity(1);
    assert.equal(log[0]!.text, 'aprovo o vídeo 1 (painel)');
  });

  test('painel: campanha sem valor válido é recusada antes de tudo', async () => {
    for (const valorBRL of [0, -5, Number.NaN]) {
      const r = await night.decidir({ tipo: 'campanha', numero: 1, valorBRL });
      assert.equal(r.text, 'Preciso do valor por dia, maior que zero.');
    }
    assert.equal((await mem.listJobs({ kind: 'campanha' })).length, 0);
  });

  test('painel: tarefa que não está esperando aprovação não é decidida', async () => {
    const r = await night.decidir({ tipo: 'tarefa', taskId: 'nao-existe', decisao: 'approve' });
    assert.equal(r.text, 'Essa tarefa não está esperando aprovação.');
  });

  test('merge misturado com vídeo fica ambíguo: pergunta e não grava evento nem Approval', async () => {
    const { job } = await mem.createJob({ kind: 'video', origin: 'texto', idempotencyKey: 'amb-v1' });
    await mem.transitionJob(job.id, 'running', { source: 'worker', message: 'começou' });
    await mem.transitionJob(job.id, 'succeeded', { source: 'worker', message: 'pronto' });
    const before = (await mem.listJobEvents(job.id)).length;

    const r = await night.handle('aprovo o merge do vídeo 1');
    assert.equal(r.intent, 'video-decision');
    assert.equal(r.text, "Ficou ambíguo: você quer aprovar o vídeo 1 ou o merge de código? Diga 'aprova o vídeo 1' ou 'aprovo o merge'.");
    assert.equal((await mem.listJobEvents(job.id)).length, before, 'nenhum evento novo');
    assert.equal((await mem.listPendingApprovals()).length, 0);
    assert.equal((await mem.listTasks()).length, 0);
  });

  test('merge misturado com oferta fica ambíguo: pergunta e não grava nada', async () => {
    const { job } = await mem.createJob({ kind: 'radar', origin: 'texto', idempotencyKey: 'amb-o1' });
    await mem.transitionJob(job.id, 'running', { source: 'worker', message: 'começou' });
    await mem.transitionJob(job.id, 'succeeded', { source: 'worker', message: 'pronto' });
    const before = (await mem.listJobEvents(job.id)).length;

    const r = await night.handle('aprova a oferta 1 e faz o merge');
    assert.equal(r.intent, 'offer-decision');
    assert.equal(r.text, "Ficou ambíguo: você quer aprovar a oferta 1 ou o merge de código? Diga 'aprova a oferta 1' ou 'aprovo o merge'.");
    assert.equal((await mem.listJobEvents(job.id)).length, before, 'nenhum evento novo');
    assert.equal((await mem.listPendingApprovals()).length, 0);
    assert.equal((await mem.listTasks()).length, 0);
  });

  test('aprovar oferta sem número pede o número e não grava; "aprovo" continua merge', async () => {
    const { job } = await mem.createJob({ kind: 'radar', origin: 'texto', idempotencyKey: 'd-3' });
    await mem.transitionJob(job.id, 'running', { source: 'worker', message: 'começou' });
    await mem.transitionJob(job.id, 'succeeded', { source: 'worker', message: 'pronto' });

    const ask = await night.handle('aprova a oferta');
    assert.match(ask.text, /^Qual oferta\?/);
    assert.equal((await mem.listJobEvents(job.id)).filter((e) => e.eventType === 'progress').length, 0);

    const merge = await night.handle('aprovo');
    assert.equal(merge.text, 'Não tem nada esperando aprovação.');
    assert.equal((await mem.listJobEvents(job.id)).filter((e) => e.eventType === 'progress').length, 0);
  });

  test('status genérico de tarefas acrescenta a linha dos trabalhos ativos', async () => {
    await mem.createJob({ kind: 'radar', origin: 'texto', idempotencyKey: 'st-g' });
    const r = await night.handle('o que tá rodando?');
    assert.equal(r.text, 'Nenhuma tarefa aberta agora. Trabalhos ativos: Radar 1 (está na fila).');
  });
});

describe('Qwen sem loop (uso real 04/11)', () => {
  test('tira o "Night" de chamamento', async () => {
    const { withoutVocative } = await import('../src/app/coordinator.ts');
    assert.equal(withoutVocative('Bom dia, Night!'), 'Bom dia!');
    assert.equal(withoutVocative('Night, tudo bem?'), 'tudo bem?');
    assert.equal(withoutVocative('o projeto Night tá parado'), 'o projeto Night tá parado');
  });
  test('corta frase que ele já disse', async () => {
    const { dropRepeats } = await import('../src/app/coordinator.ts');
    assert.equal(dropRepeats('Bom dia! Vou ver o que é real.', ['Estou aqui. Vou ver o que é real.']), 'Bom dia!');
    assert.equal(dropRepeats('Tudo certo.', []), 'Tudo certo.');
  });
});

describe('conversa com Sonnet e Luna alternando (pedido do Joel, 04/11)', () => {
  let mem: PgMemory;
  before(async () => { await resetTestDb(); mem = await PgMemory.open(TEST_URL); });
  after(async () => { await mem?.close(); });
  beforeEach(async () => { await truncateAll(); });

  const chatter = (id: string, behavior: string | Error, seen: string[] = []) => ({
    id,
    async reply(_h: unknown, text: string) { seen.push(text); if (behavior instanceof Error) throw behavior; return behavior; },
  });

  test('alterna a cada mensagem e grava quem respondeu', async () => {
    const llm = new FakeLlm(() => 'qwen');
    const n = new NightCoordinator(mem, new NightRouter(llm, async () => []), llm, {
      chatters: [chatter('codex:gpt-6-luna', 'resposta do luna'), chatter('claude:sonnet', 'resposta do sonnet')],
    });
    assert.equal((await n.handle('oi, tudo bem?')).model, 'codex:gpt-6-luna');
    assert.equal((await n.handle('e aí, como vai?')).model, 'claude:sonnet');
    assert.equal((await n.handle('me conta uma coisa legal')).model, 'codex:gpt-6-luna');
    assert.equal(llm.calls.length, 0, 'o Qwen não foi usado');
  });

  test('se o da vez falha, vai o outro; se os dois falham, o Qwen', async () => {
    const llm = new FakeLlm(() => 'resposta local');
    const n = new NightCoordinator(mem, new NightRouter(llm, async () => []), llm, {
      chatters: [chatter('codex:gpt-6-luna', new Error('caiu')), chatter('claude:sonnet', 'resposta do sonnet')],
    });
    const r = await n.handle('oi, tudo bem?');
    assert.equal(r.model, 'claude:sonnet');
    const both = new NightCoordinator(mem, new NightRouter(llm, async () => []), llm, {
      chatters: [chatter('codex:gpt-6-luna', new Error('caiu')), chatter('claude:sonnet', new Error('sem internet'))],
    });
    const r2 = await both.handle('oi, tudo bem?');
    assert.equal(r2.model, 'fake-local');
    assert.equal(r2.text, 'resposta local');
  });

  test('o chamamento "Night" não vai junto para o modelo', async () => {
    const seen: string[] = [];
    const llm = new FakeLlm();
    const n = new NightCoordinator(mem, new NightRouter(llm, async () => []), llm, {
      chatters: [chatter('claude:sonnet', 'oi', seen)],
    });
    await n.handle('Bom dia, Night!');
    assert.deepEqual(seen, ['Bom dia!']);
  });
});

describe('reservas DeepSeek (D11)', () => {
  let mem: PgMemory;
  const llm = new FakeLlm(() => 'resposta local');
  const router = () => new NightRouter(llm, async () => []);
  before(async () => { await resetTestDb(); mem = await PgMemory.open(TEST_URL); });
  after(async () => { await mem?.close(); });
  beforeEach(async () => { await truncateAll(); llm.calls = []; });

  const chatter = (id: string, behavior: string | Error) => ({
    id,
    async reply() { if (behavior instanceof Error) throw behavior; return behavior; },
  });

  const routeLog = async () => {
    const c = new pg.Client({ connectionString: TEST_URL });
    await c.connect();
    const { rows } = await c.query('SELECT model, reason FROM route_log ORDER BY at');
    await c.end();
    return rows as { model: string; reason: string }[];
  };

  test('conversa: Codex e Claude falham, a reserva responde e o motivo fica registrado', async () => {
    const n = new NightCoordinator(mem, router(), llm, {
      chatters: [chatter('codex:gpt-6-luna', new QuotaError('sem cota')), chatter('claude:sonnet', new Error('sem internet'))],
      reserves: [chatter('deepseek:deepseek-flash', '  resposta da reserva 😊')],
    });
    const r = await n.handle('oi, tudo bem?');
    assert.equal(r.intent, 'chat');
    assert.equal(r.model, 'deepseek:deepseek-flash');
    assert.equal(r.text, 'resposta da reserva');
    assert.equal(llm.calls.length, 0, 'a reserva entrou antes do Qwen');
    const [log] = await routeLog();
    assert.equal(log!.model, 'deepseek:deepseek-flash');
    assert.match(log!.reason, /^conversa \(reserva deepseek: codex:gpt-6-luna: no limite; claude:sonnet: sem internet\)$/);
  });

  test('conversa sem reserva mantém o Qwen local quando os dois falham', async () => {
    const n = new NightCoordinator(mem, router(), llm, {
      chatters: [chatter('codex:gpt-6-luna', new Error('caiu')), chatter('claude:sonnet', new Error('sem internet'))],
    });
    const r = await n.handle('oi, tudo bem?');
    assert.equal(r.model, 'fake-local');
    assert.equal(r.text, 'resposta local');
    assert.match((await routeLog())[0]!.reason, /^conversa local \(falharam:/);
  });

  test('pesquisa: Codex e Claude falham, a reserva responde com aviso de sem internet', async () => {
    const codex = new FakeResearcher('codex:gpt-6-luna', new QuotaError('limite'));
    const claude = new FakeResearcher('claude:haiku', new Error('sem internet'));
    const reserve = new FakeResearcher('deepseek:deepseek-flash', 'Acho que é 5 reais.');
    const n = new NightCoordinator(mem, router(), llm, { researchers: [codex, claude], researchReserves: [reserve] });
    const later = await (await n.handle('pesquisa sobre o Qwen 3')).followUp!;
    assert.equal(later.model, 'deepseek:deepseek-flash');
    assert.equal(later.text, 'Sem internet, respondi de cabeça e pode estar desatualizado: Acho que é 5 reais.');
    assert.equal(llm.calls.length, 0, 'o modelo local não inventa a pesquisa');
    const [log] = await routeLog();
    assert.equal(log!.model, 'deepseek:deepseek-flash');
    assert.match(log!.reason, /reserva deepseek:deepseek-flash sem internet/);
  });

  test('pesquisa sem reserva continua dizendo que não conseguiu', async () => {
    const n = new NightCoordinator(mem, router(), llm, {
      researchers: [
        new FakeResearcher('codex:gpt-6-luna', new QuotaError('limite')),
        new FakeResearcher('claude:haiku', new Error('sem internet')),
      ],
    });
    const later = await (await n.handle('pesquisa sobre o Qwen 3')).followUp!;
    assert.equal(later.model, 'none');
    assert.match(later.text, /^Não consegui pesquisar agora/);
  });

  test('pesquisa no PC (D-017): só o pesquisador de arquivos, na pasta do NIGHT, sem a internet', async () => {
    const web = new FakeResearcher('codex:gpt-6-luna', 'da internet');
    const pc = new FakeResearcher('claude:sonnet:pc', 'Os agentes estão em src/agents. Chave gsk_abcdefghijklmnopqrstu achada.');
    const n = new NightCoordinator(mem, router(), llm, { researchers: [web], pcResearchers: [pc], nightRoot: 'D:/NIGHT' });
    const later = await (await n.handle('dá uma vasculhada no seu próprio código e veja quais agentes estão disponíveis')).followUp!;
    assert.equal(later.model, 'claude:sonnet:pc');
    assert.equal(later.text, 'Os agentes estão em src/agents. Chave [chave apagada] achada.');
    assert.deepEqual(pc.roots, ['D:/NIGHT']);
    assert.equal(web.questions.length, 0, 'a pesquisa na internet não roda');
  });

  test('pesquisa no PC usa a pasta do projeto citado', async () => {
    await mem.upsertProject({ id: 'soaken', name: 'Soaken', description: '', repoPath: 'C:/repos/soaken', defaultBranch: 'main', allowedPaths: [], status: 'active' });
    const pc = new FakeResearcher('claude:sonnet:pc', 'O login fica em src/auth.ts.');
    const n = new NightCoordinator(mem, router(), llm, { pcResearchers: [pc], nightRoot: 'D:/NIGHT' });
    await (await n.handle('verifica nos arquivos do Soaken onde fica o login')).followUp!;
    assert.deepEqual(pc.roots, ['C:/repos/soaken']);
  });

  test('"os dois": internet e PC separados, juntados por um modelo sem ferramentas', async () => {
    const web = new FakeResearcher('codex:gpt-6-luna', 'O OpenBot liga o WhatsApp por QR code.');
    const pc = new FakeResearcher('claude:sonnet:pc', 'O NIGHT não tem WhatsApp ainda.');
    const seen: string[] = [];
    const n = new NightCoordinator(mem, router(), llm, {
      researchers: [web], pcResearchers: [pc], nightRoot: 'D:/NIGHT', chatters: [{ id: 'claude:sonnet', async reply(_h: unknown, text: string) { seen.push(text); return 'Resposta juntada.'; } }],
    });
    const later = await (await n.handle('procura no nosso código e na internet como configurar o WhatsApp')).followUp!;
    assert.equal(later.text, 'Resposta juntada.');
    assert.equal(later.model, 'codex:gpt-6-luna + claude:sonnet:pc + claude:sonnet');
    assert.equal(web.roots[0], undefined, 'a pesquisa na internet não recebe pasta');
    assert.deepEqual(pc.roots, ['D:/NIGHT']);
    assert.match(seen[0]!, /Dos arquivos do PC: O NIGHT não tem WhatsApp ainda\.\nDa internet: O OpenBot liga o WhatsApp por QR code\./);
  });

  test('"os dois" com uma falha ainda responde com a outra, sem modelo junta como veio', async () => {
    const n = new NightCoordinator(mem, router(), llm, {
      researchers: [new FakeResearcher('codex:gpt-6-luna', new QuotaError('limite'))],
      pcResearchers: [new FakeResearcher('claude:sonnet:pc', 'Está em src/app/server.ts.')],
    });
    const later = await (await n.handle('pesquisa os dois: no seu código e na internet onde fica o painel')).followUp!;
    assert.equal(later.text, 'Nos arquivos: Está em src/app/server.ts. Na internet: a pesquisa na internet falhou');
  });
});

describe('conversa com a oferta do Radar (R06)', () => {
  let mem: PgMemory;
  let radar: PgRadarStore;
  let llm: FakeLlm;
  let night: NightCoordinator;

  /** Proposta completa e válida; a evidência aponta para o candidato de verdade. */
  const proposta = (candidateId: string): Record<string, unknown> => ({
    version: 'oferta/1',
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
      valor: 19.9, moeda: 'BRL', justificativa: 'Faixa de entrada do nicho, sem prova de venda', ehHipotese: true,
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
  });

  before(async () => {
    await resetTestDb();
    mem = await PgMemory.open(TEST_URL);
    radar = await PgRadarStore.open(TEST_URL);
  });
  after(async () => {
    await radar?.close();
    await mem?.close();
  });
  beforeEach(async () => {
    await truncateAll();
    llm = new FakeLlm(() => 'resposta sobre a oferta');
    night = new NightCoordinator(mem, new NightRouter(llm, async () => []), llm, { radar });
  });

  async function criarOferta(jobId: string | null = null): Promise<{ candidateId: string; offerNumber: number }> {
    const { candidate } = await radar.upsertCandidate({
      source: 'teste', externalId: `e-${randomUUID()}`, advertiser: 'Loja do Curso',
      country: 'BR', landingUrl: 'https://loja.example/oferta',
      raw: { externalId: 'e', anuncioTexto: 'Aprenda a organizar sua rotina com um método simples' },
      keywords: ['rotina'], jobId,
    });
    await radar.setScore(candidate.id, scoreCandidate({
      anunciosAtivos: 94, diasNoAr: 41, anunciantesNoNicho: 5, precoOrigem: 97, entregavelEmPdf: true,
    }));
    const offer = await radar.createOffer(candidate.id, proposta(candidate.id), [{ fonte: 'teste' }]);
    return { candidateId: candidate.id, offerNumber: offer.number };
  }

  test('sem banco do Radar, comandos de oferta só avisam que falta ligação', async () => {
    const semRadar = new NightCoordinator(mem, new NightRouter(llm, async () => []), llm);
    for (const text of ['mostra a oferta 1', 'por que a oferta 1 é boa?',
      'ajusta o público da oferta 1 para mães de primeira viagem']) {
      assert.equal((await semRadar.handle(text)).text, 'O Radar ainda não tem banco ligado.', text);
    }
  });

  test('mostra resumo curto para voz e contexto completo na tela', async () => {
    const { candidateId, offerNumber } = await criarOferta();
    const r = await night.handle('mostra a oferta 1');
    assert.equal(r.intent, 'offer-show');
    assert.equal(r.text, `Oferta ${offerNumber} versão 1: Rotina Enxuta. Público: Autônomos que trabalham de casa. ` +
      'nota de triagem 10. Status: rascunho.');
    assert.match(r.detail ?? '', new RegExp(candidateId));
    assert.match(r.detail ?? '', /<<<DADOS id=/);
    assert.match(r.detail ?? '', /Fontes:/);
  });

  test('pergunta sem número usa a última oferta mostrada e leva o contexto ao chat', async () => {
    const { candidateId } = await criarOferta();
    await night.handle('mostra a oferta 1');
    const r = await night.handle('por que ela é boa?');
    assert.equal(r.intent, 'offer-ask');
    assert.equal(r.text, 'resposta sobre a oferta');
    const system = llm.calls.at(-1)!.messages[0]!.content;
    assert.match(system, new RegExp(candidateId), 'o contexto da oferta foi para o modelo');
    assert.match(system, /<<<DADOS id=/);
    assert.match(system, /não está nas fontes/, 'instrução contra inventar dado ausente');
  });

  test('pergunta sem oferta mostrada e sem número pede o número', async () => {
    const { candidateId } = await criarOferta();
    void candidateId;
    const r = await night.handle('por que a oferta é boa?');
    assert.equal(r.text, 'Qual oferta? Fala o número, por exemplo "oferta 2".');
  });

  test('edição cria versão nova e preserva a anterior', async () => {
    await criarOferta();
    const r = await night.handle('ajusta o público da oferta 1 para mães de primeira viagem');
    assert.equal(r.text, 'Oferta 1 agora está na versão 2 (antes 1), com publico atualizado.');
    const v1 = await radar.getOffer(1, 1);
    const v2 = await radar.getOffer(1);
    assert.equal((v1?.proposal as Record<string, unknown>).publico, 'Autônomos que trabalham de casa');
    assert.equal((v2?.proposal as Record<string, unknown>).publico, 'mães de primeira viagem');
    assert.equal(v2?.version, 2);
  });

  test('edição inválida não grava versão nem feedback', async () => {
    await criarOferta();
    const r = await night.handle('muda a promessa da oferta 1 para renda garantida de R$ 10 mil');
    assert.match(r.text, /^Não gravei a edição da oferta 1: promessa: promessa proibida/);
    assert.equal((await radar.listOfferVersions(1)).length, 1);
    assert.equal((await radar.listFeedback(1)).length, 0);
  });

  test('aprovar oferta existente congela a versão e continua o evento do job', async () => {
    const { job } = await mem.createJob({ kind: 'radar', origin: 'texto', idempotencyKey: 'r06-aprova' });
    await mem.transitionJob(job.id, 'running', { source: 'worker', message: 'começou' });
    await mem.transitionJob(job.id, 'succeeded', { source: 'worker', message: 'pronto' });
    await criarOferta(job.id);

    const r = await night.handle('aprova a oferta 1');
    assert.equal(r.text, 'Oferta 1 versão 1 aprovada como briefing. Isso não autoriza campanha, compra nem gasto.');
    assert.equal((await radar.getOffer(1))?.status, 'aprovada');
    const aprovacoes = (await radar.listFeedback(1)).filter((f) => f.kind === 'aprovacao');
    assert.equal(aprovacoes.length, 1);
    const progresso = (await mem.listJobEvents(job.id)).filter((e) => e.eventType === 'progress');
    assert.equal(progresso.length, 1);
    assert.match(progresso[0]!.message, /oferta aprovada pelo Joel/);
    assert.equal((await mem.listPendingApprovals()).length, 0, 'aprovar oferta não é aprovação de merge');
  });

  test('oferta 2 do candidato do job Radar 1 grava no job 1, não no job 2', async () => {
    // Números de job e de oferta são independentes: o job 2 é outro registro, não a oferta 2.
    const { job: job1 } = await mem.createJob({ kind: 'radar', origin: 'texto', idempotencyKey: 'r06-indep-1' });
    const { job: job2 } = await mem.createJob({ kind: 'radar', origin: 'texto', idempotencyKey: 'r06-indep-2' });
    for (const job of [job1, job2]) {
      await mem.transitionJob(job.id, 'running', { source: 'worker', message: 'começou' });
      await mem.transitionJob(job.id, 'succeeded', { source: 'worker', message: 'pronto' });
    }
    // A oferta 1 e a oferta 2 saem do mesmo candidato, que veio do job Radar 1.
    await criarOferta(job1.id);
    const { candidate } = await radar.upsertCandidate({
      source: 'teste', externalId: `e-${randomUUID()}`, advertiser: 'Loja do Curso',
      country: 'BR', landingUrl: 'https://loja.example/oferta-2',
      raw: { externalId: 'e2', anuncioTexto: 'Outro anúncio do mesmo job' }, jobId: job1.id,
    });
    const oferta2 = await radar.createOffer(candidate.id, proposta(candidate.id), [{ fonte: 'teste' }]);
    assert.equal(oferta2.number, 2);

    const r = await night.handle('aprova a oferta 2');
    assert.equal(r.text, 'Oferta 2 versão 1 aprovada como briefing. Isso não autoriza campanha, compra nem gasto.');
    assert.equal((await radar.getOffer(2))?.status, 'aprovada');
    const noJob1 = (await mem.listJobEvents(job1.id)).filter((e) => e.eventType === 'progress');
    const noJob2 = (await mem.listJobEvents(job2.id)).filter((e) => e.eventType === 'progress');
    assert.equal(noJob1.length, 1, 'o evento foi para o job do candidato');
    assert.match(noJob1[0]!.message, /oferta aprovada pelo Joel/);
    assert.equal(noJob2.length, 0, 'o job de mesmo número da oferta não foi tocado');
  });
});

describe('ligação com o OpenBot pelo coordenador', () => {
  /** Memória mínima: estas falas só leem a conversa recente e gravam o route_log. */
  const memoriaFalsa = () => ({
    recentActivity: async () => [],
    logRoute: async () => {},
    listProjects: async () => [],
  }) as unknown as Memory;

  class OpenBotFalso implements OpenBotLike {
    enviados: { agente: string; tarefa: string }[] = [];
    resumos = 0;
    depois = Promise.resolve('O Radar do OpenBot respondeu: café pronto');

    async enviar(agente: string, tarefa: string): Promise<{ texto: string; depois?: Promise<string> }> {
      this.enviados.push({ agente, tarefa });
      return { texto: 'Mandei para o Radar do OpenBot. Te aviso quando ele responder.', depois: this.depois };
    }

    async resumo(): Promise<string> {
      this.resumos += 1;
      return 'resumo do OpenBot';
    }
  }

  const montar = (openbot?: OpenBotLike) => {
    const llm = new FakeLlm(() => 'resposta do modelo local');
    return new NightCoordinator(memoriaFalsa(), new NightRouter(llm, async () => []), llm, openbot ? { openbot } : {});
  };

  const frase = 'manda pro Radar do OpenBot pesquisar café';

  test('a) pedido do dono manda a tarefa e o followUp traz a resposta', async () => {
    const openbot = new OpenBotFalso();
    const r = await montar(openbot).handle(frase, undefined, { origem: 'dono' });
    assert.equal(r.intent, 'openbot-task');
    assert.deepEqual(openbot.enviados, [{ agente: 'Radar', tarefa: 'pesquisar café' }]);
    assert.equal(r.text, 'Mandei para o Radar do OpenBot. Te aviso quando ele responder.');
    assert.ok(r.followUp);
    assert.equal((await r.followUp!).text, 'O Radar do OpenBot respondeu: café pronto');
  });

  test('b) pedido de tela não manda tarefa a outro agente do OpenBot', async () => {
    const openbot = new OpenBotFalso();
    const r = await montar(openbot).handle(frase, undefined, { origem: 'tela' });
    assert.match(r.text, /não manda tarefa para outro agente do OpenBot/);
    assert.equal(openbot.enviados.length, 0);
  });

  test('c) pedido da voz manda a tarefa', async () => {
    const openbot = new OpenBotFalso();
    const r = await montar(openbot).handle(frase, undefined, { origem: 'voz' });
    assert.deepEqual(openbot.enviados, [{ agente: 'Radar', tarefa: 'pesquisar café' }]);
    assert.match(r.text, /^Mandei para o Radar/);
  });

  test('d) decisão vinda da voz é bloqueada, com texto próprio', async () => {
    const painelUrl = 'http://127.0.0.1:4517/painel';
    const daVoz = await montar(new OpenBotFalso()).handle('aprovo', undefined, { origem: 'voz', painelUrl });
    const daTela = await montar(new OpenBotFalso()).handle('aprovo', undefined, { origem: 'tela', painelUrl });
    assert.match(daVoz.text, /^Decisão não vale pela voz ao vivo\./);
    assert.match(daVoz.text, new RegExp(painelUrl));
    assert.match(daTela.text, /^Essa decisão é do Joel e não vale pela tela\./);
  });

  test('e) "o que o openbot fez?" chama o resumo', async () => {
    const openbot = new OpenBotFalso();
    const r = await montar(openbot).handle('o que o openbot fez?');
    assert.equal(r.intent, 'openbot-status');
    assert.equal(openbot.resumos, 1);
    assert.equal(r.text, 'resumo do OpenBot');
  });

  test('f) sem a opção openbot, a ligação não está ligada', async () => {
    const r = await montar().handle(frase);
    assert.equal(r.text, 'A ligação com o OpenBot não está ligada neste NIGHT.');
  });
});
