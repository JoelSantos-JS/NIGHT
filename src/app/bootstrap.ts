// Monta o Night: memória, modelo local, roteador, pesquisadores, executor de tarefas e coordenador.
// Usado pelo modo texto, pelo modo voz e pelo teste de voz.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DeepSeekAdvisor } from '../advisor/deepseek-client.ts';
import { PgAdvisorJournal } from '../advisor/journal.ts';
import { AdvisorService } from '../advisor/service.ts';
import {
  ClaudeCodingAgent, ClaudeReviewer, CodexCodingAgent, CodexReviewer, DeepSeekCodingAgent, type Reviewer,
} from '../agents/coding.ts';
import { ClaudeChat, CodexChat } from '../agents/chat.ts';
import { DeepSeekApi, DeepSeekChat, DeepSeekResearch, DeepSeekReviewer } from '../agents/deepseek.ts';
import { ClaudeLocalResearch, ClaudeResearch, CodexLocalResearch, CodexResearch } from '../agents/research.ts';
import { TaskScheduler } from '../agents/scheduler.ts';
import { ArtifactStore } from '../artifacts/store.ts';
import type { CodingAgent, Memory } from '../core/interfaces.ts';
import type { AgentName, Job } from '../core/types.ts';
import { CredentialStore } from '../jobs/credentials.ts';
import { JobRunner } from '../jobs/runner.ts';
import { OllamaLlm } from '../local-llm/ollama.ts';
import { PgMemory } from '../memory/pg-memory.ts';
import { PgRadarStore } from '../radar/store.ts';
import { PlanejadorComPesquisa } from '../radar/nichos.ts';
import { RadarWorker } from '../radar/worker.ts';
import { NightRouter } from '../router/router.ts';
import { VideoAgent, VoiceUnavailableError, type ImageProvider } from '../video/agent.ts';
import { FlowFolderProvider } from '../video/flow-folder.ts';
import type { Scene, VideoManifest } from '../video/manifest.ts';
import { Narrator, type Synth } from '../video/narrate.ts';
import { GitWorktreeManager } from '../workspaces/worktree-manager.ts';
import { nightDataRoot, NightCoordinator, type CoordinatorOptions } from './coordinator.ts';
import { ClaudeMcpMetaWriter } from '../ads/meta-writer.ts';
import { ClaudeMcpMetaReader } from '../ads/meta-reader.ts';
import { PgOfferLinks } from '../lowticket/links.ts';
import { LowticketWorker } from '../lowticket/worker.ts';
import { MetaMcpAdSource } from '../radar/meta-mcp-source.ts';
import { OpenBotEspelho } from '../openbot/espelho.ts';

/** Pasta de dados do NIGHT; cada parte fica fora do repositório. */
export interface NightPaths {
  data: string;
  artifacts: string;
  videoWork: string;
  flowImages: string;
}

/** Caminhos puros (testáveis sem banco): artefatos, trabalho de vídeo e imagens do Flow. */
export function nightPaths(dataRoot: string = nightDataRoot()): NightPaths {
  return {
    data: dataRoot,
    artifacts: join(dataRoot, 'artefatos'),
    videoWork: join(dataRoot, 'video-work'),
    flowImages: join(dataRoot, 'flow-import'),
  };
}

/** Modo texto: não há Kokoro carregado; o erro marcado faz o vídeo esperar o modo voz. */
const synthSemVoz: Synth = async () => {
  throw new VoiceUnavailableError();
};

/** Junta as mensagens do roteirista/proposta num prompt só da API de texto do DeepSeek. */
function deepSeekTextGenerator(api: DeepSeekApi) {
  return async (mensagens: { role: 'system' | 'user'; content: string }[]): Promise<string> =>
    api.ask(mensagens.map((m) => `${m.role === 'system' ? 'Instruções' : 'Pedido'}:\n${m.content}`).join('\n\n'));
}

/**
 * Imagens do Flow na pasta do NÚMERO falado ("vídeo 3" → flow-import/3). O agente só recebe
 * o jobId, então o provider descobre o número no banco; a pasta do jobId continua aceita.
 */
class FlowImagesPorNumero implements ImageProvider {
  readonly origin = 'flow';
  private readonly numeros = new Map<string, number | null>();

  constructor(
    private readonly root: string,
    private readonly numeroDoJob: (jobId: string) => Promise<number | null>,
  ) {}

  private async provider(jobId: string): Promise<FlowFolderProvider> {
    if (!this.numeros.has(jobId)) this.numeros.set(jobId, await this.numeroDoJob(jobId));
    return new FlowFolderProvider({ root: this.root, numeroDoVideo: this.numeros.get(jobId) ?? null });
  }

  async find(jobId: string, scene: Scene): Promise<string | null> {
    return (await this.provider(jobId)).find(jobId, scene);
  }

  /** Devolve a pasta (não o arquivo): é nela que o Joel salva as imagens do Flow. */
  async writePromptSheet(jobId: string, manifest: VideoManifest): Promise<string> {
    const provider = await this.provider(jobId);
    await provider.writePromptSheet(jobId, manifest);
    return provider.pastaDoJob(jobId);
  }
}

/** Fire-and-forget com o erro no log do trabalho: a partida não pode cair por causa de um job. */
function runInBackground(memory: Memory, runner: JobRunner, job: Job): void {
  void runner.run(job.id).catch(async (error: unknown) => {
    try {
      await memory.addJobEvent(job.id, {
        eventType: 'error',
        source: 'runner',
        message: `falha ao executar em segundo plano: ${(error as Error).message}`,
      });
    } catch {
      // O log é melhor esforço; o trabalho já está registrado no banco.
    }
  });
}

/** Uma linha do quadro de conexões do painel. */
export interface Connection { nome: string; ok: boolean; detalhe: string }

export interface CreateNightOptions {
  /** Voz do Kokoro para narrar vídeos; sem ela (modo texto), a narração espera 'voz'. */
  synth?: Synth;
}

export async function createNight(opts: CreateNightOptions = {}) {
  const memory = await PgMemory.open();
  const llm = new OllamaLlm();
  const llmOk = await llm.available();
  const router = new NightRouter(llm, async () => (await memory.listProjects()).map((p) => p.name));
  // Pesquisa: modelos menores, Codex primeiro (escolha do Joel), Claude se o Codex falhar ou estiver no limite.
  const researchers = [new CodexResearch(), new ClaudeResearch()];
  // Pesquisa no PC (D-017): lê arquivos sem internet. Claude primeiro (o Codex está com a cota semanal no fim).
  const pcResearchers = [new ClaudeLocalResearch(), new CodexLocalResearch()];
  // Dados fora do repositório: artefatos dos trabalhos, arquivos temporários de vídeo e imagens do Flow.
  const paths = nightPaths();
  const artifacts = new ArtifactStore(paths.artifacts);
  // Radar no mesmo banco da memória; as ofertas continuam disponíveis nas duas janelas.
  const radarStore = await PgRadarStore.open();
  // Links de cada oferta (página, checkout, imagens): o Joel informa por voz/texto.
  const offerLinks = await PgOfferLinks.open();
  // Meta (seção M): a fonte do Radar só liga com as ferramentas de leitura conhecidas (M01), e a
  // montagem de campanha só com a conta de anúncios. Sem isso, cada fluxo explica o que falta.
  // Busca da Biblioteca de Anúncios pelo MCP oficial da Meta (nome conferido em 20/11, R01: anúncios comerciais do
  // Brasil vêm). NIGHT_META_READ_TOOLS troca a lista; 'off' desliga e o Radar volta a esperar uma fonte.
  const metaReadTools = process.env.NIGHT_META_READ_TOOLS === 'off' ? []
    : (process.env.NIGHT_META_READ_TOOLS ?? 'mcp__meta-ads__ads_library_search').split(',').map((t) => t.trim()).filter(Boolean);
  const metaAdAccount = process.env.NIGHT_META_AD_ACCOUNT?.trim() || null;
  // Relatório da campanha (M07): mesma pasta do writer, e o nome da ferramenta pode mudar no beta.
  const metaInsightsTool = process.env.NIGHT_META_INSIGHTS_TOOL?.trim() || undefined;
  // D11: DeepSeek é a reserva (conversa, pesquisa e revisão), mas só liga quando a chave existe.
  const credentials = new CredentialStore();
  const hasDeepSeek = credentials.status('deepseek').available;
  // Parecer independente e geração de texto (roteiro e proposta) só existem com a chave.
  const journal = hasDeepSeek ? await PgAdvisorJournal.open() : null;
  const advisor = journal === null ? undefined : new AdvisorService(
    new DeepSeekAdvisor({ apiKey: () => credentials.get('deepseek', 'parecer') }),
    journal,
  );
  const textGenerator = hasDeepSeek ? deepSeekTextGenerator(new DeepSeekApi()) : undefined;
  // Código: modelos maiores, cada tarefa numa worktree própria, revisada pelo outro agente (D-009, D-011).
  // D12/H01: o DeepSeek entra como executor (CLI do Claude em --bare na API dele) e como revisor;
  // sem a chave ele simplesmente não é oferecido, e pedir por ele falha com o motivo.
  const agents: Partial<Record<AgentName, CodingAgent>> = { claude: new ClaudeCodingAgent(), codex: new CodexCodingAgent() };
  const reviewers: Partial<Record<AgentName, Reviewer>> = { claude: new ClaudeReviewer(), codex: new CodexReviewer() };
  if (hasDeepSeek) {
    agents.deepseek = new DeepSeekCodingAgent();
    reviewers.deepseek = new DeepSeekReviewer();
  }
  const tasks = new TaskScheduler(
    memory,
    new GitWorktreeManager(process.env.NIGHT_WORKTREES ?? 'D:/NIGHT-data/worktrees'),
    agents,
    reviewers,
    'pt-BR',
    hasDeepSeek ? new DeepSeekReviewer() : undefined,
    advisor,
  );
  // Só a instância que pega a trava executa tarefas e faz a checagem de reinício. Uma segunda janela
  // conversa, pesquisa e salva ideias, mas não mexe nas tarefas da primeira.
  const unlock = await memory.acquireTaskLock();
  // O que estava rodando quando o Night fechou não recomeça sozinho.
  const stuck = unlock ? await tasks.reconcile() : [];
  // Trabalhadores de Radar e vídeo: só a janela com a trava executa; a outra só registra pedidos.
  const jobRunners: Partial<Record<'radar' | 'video' | 'lowticket', JobRunner>> = {};
  if (unlock) {
    const narrator = new Narrator(opts.synth ?? synthSemVoz, artifacts, { workDir: paths.videoWork });
    const images = new FlowImagesPorNumero(
      paths.flowImages,
      async (jobId) => (await memory.getJob(jobId))?.number ?? null,
    );
    const video = new VideoAgent({
      store: artifacts,
      narrator,
      images,
      workDir: paths.videoWork,
      advisor,
      generator: textGenerator,
    });
    // Sem fonte (NIGHT_META_READ_TOOLS=off), o Radar espera 'fonte' em vez de inventar anúncio.
    const radar = new RadarWorker({
      store: radarStore,
      artifacts,
      planejador: new PlanejadorComPesquisa(researchers),
      source: metaReadTools.length
        ? new MetaMcpAdSource({ readTools: metaReadTools, workDir: join(paths.data, 'meta-mcp') })
        : null,
      generator: textGenerator ?? null,
      advisor,
    });
    // Vídeo pode demorar (geração, Flow, render e revisão): 2 s × 900 = 30 min por tentativa.
    const runnerOptions = { pollMs: 2000, maxPolls: 900 };
    jobRunners.radar = new JobRunner(memory, radar, artifacts, runnerOptions);
    jobRunners.video = new JobRunner(memory, video, artifacts, runnerOptions);
    // Produto low-ticket (seção L): só de oferta aprovada; PDFs pelo Edge/Chrome instalado no PC.
    const produto = new LowticketWorker({
      offers: radarStore,
      links: offerLinks,
      artifacts,
      generator: textGenerator ?? null,
      advisor,
      workDir: join(paths.data, 'lowticket-work'),
    });
    jobRunners.lowticket = new JobRunner(memory, produto, artifacts, runnerOptions);
    // Retoma só o que estava rodando quando outra sessão caiu. 'waiting' espera o dono mandar
    // "continua o vídeo N"; o contrato do runner garante que a retomada não duplica efeito.
    for (const job of await memory.listJobs({ status: ['running'] })) {
      if (job.kind === 'radar' || job.kind === 'video' || job.kind === 'lowticket') {
        const runner = jobRunners[job.kind];
        if (runner) runInBackground(memory, runner, job);
      }
    }
  }
  // Conversa normal: Codex gpt-6-luna e Claude Sonnet alternando (pedido do Joel, 04/11); Qwen só se os dois
  // falharem. NIGHT_CHAT=local volta para só o Qwen (sem gastar cota).
  const chatters = process.env.NIGHT_CHAT === 'local' ? [] : [new CodexChat(), new ClaudeChat()];
  // NIGHT_CHAT=local continua só o Qwen: a reserva de conversa só entra quando há conversa externa.
  const reserves = chatters.length > 0 && hasDeepSeek ? [new DeepSeekChat()] : [];
  const researchReserves = hasDeepSeek ? [new DeepSeekResearch()] : [];
  // Ligação com o OpenBot pela API local de automação: tarefas para os agentes dele, pendências e diário das telas.
  const openbot = new OpenBotEspelho();
  openbot.iniciar();
  const coordinatorOptions: CoordinatorOptions = {
    openbot,
    researchers,
    tasks: unlock ? tasks : undefined,
    chatters,
    reserves,
    researchReserves,
    pcResearchers,
    radar: radarStore,
    artifacts,
    jobRunners,
    links: offerLinks,
    // A montagem cria tudo PAUSADO; ativar fica com o Joel no Gerenciador (chave de status desligada na Meta).
    campaign: { writer: new ClaudeMcpMetaWriter({ workDir: join(paths.data, 'meta-mcp') }), adAccountId: metaAdAccount },
    // Relatório é só leitura: uma sessão por pergunta, com a ferramenta de insights liberada.
    campaignReader: new ClaudeMcpMetaReader({ workDir: join(paths.data, 'meta-mcp'), tool: metaInsightsTool }),
  };
  const night = new NightCoordinator(memory, router, llm, coordinatorOptions);
  // Uma conversa por coordenador: cada tela do OpenBot (e o painel) ganha o seu, com os mesmos executores
  // e lojas, começando vazio em vez de herdar a conversa da voz ou de outra tela.
  const makeCoordinator = () => new NightCoordinator(memory, router, llm, { ...coordinatorOptions, restoreRecent: false });
  // Fecha os pools abertos aqui; o da memória continua sendo fechado por quem chamou.
  // O close da memória também fecha estes: night, night:voz, night:teste e o e2e já fecham
  // a memória no fim, e sem isso o processo ficaria preso num pool esquecido.
  let fechado = false;
  const close = async (): Promise<void> => {
    if (fechado) return;
    fechado = true;
    openbot.parar();
    await Promise.allSettled([
      radarStore.close(),
      offerLinks.close(),
      ...(journal === null ? [] : [journal.close()]),
    ]);
  };
  const fecharMemoria = memory.close.bind(memory);
  memory.close = async () => {
    await close();
    await fecharMemoria();
  };
  // Situação de cada conexão para o painel: só "ligado / falta o quê", nunca o segredo.
  const connections = async (): Promise<Connection[]> => [
    { nome: 'Banco (PostgreSQL)', ok: true, detalhe: 'conectado' },
    { nome: 'Modelo local (Ollama)', ok: await llm.available(), detalhe: llm.model },
    { nome: 'DeepSeek (parecer e reserva)', ok: hasDeepSeek, detalhe: hasDeepSeek ? 'chave encontrada' : 'sem chave: defina DEEPSEEK_API_KEY ou ~/.deepseek/api_key' },
    { nome: 'Meta: leitura da Biblioteca (Radar)', ok: metaReadTools.length > 0, detalhe: metaReadTools.length ? metaReadTools.join(', ') : 'desligada (NIGHT_META_READ_TOOLS=off)' },
    { nome: 'Meta: conta de anúncios (campanha)', ok: metaAdAccount !== null, detalhe: metaAdAccount ?? 'falta NIGHT_META_AD_ACCOUNT' },
    { nome: 'OpenBot (automação)', ok: openbot.estado().ligado, detalhe: openbot.estado().motivo ?? `agentes: ${openbot.estado().agentes.map((a) => a.nome).join(', ')}` },
    { nome: 'OpenBot (telas)', ok: existsSync(join(process.env.LOCALAPPDATA ?? '', 'Programs', 'OpenBot', 'OpenBot.exe')), detalhe: 'telas pelo servidor MCP; pacote com pnpm night:telas' },
    { nome: 'Executa trabalhos nesta janela', ok: Boolean(unlock), detalhe: unlock ? 'sim' : 'outra janela do NIGHT tem a trava' },
  ];
  return { memory, llm, llmOk, tasks, stuck, runsTasks: Boolean(unlock), night, makeCoordinator, radar: radarStore, connections, openbot, close };
}
