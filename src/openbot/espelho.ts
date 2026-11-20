// Espelho do OpenBot no NIGHT: manda tarefas aos agentes do OpenBot, acompanha até a resposta, mostra o que
// espera o Joel (perguntas e aprovações) e guarda o diário que as telas mandam por night_relatar.
//
// A API do OpenBot não mostra o histórico das conversas; o que o NIGHT vê é o que ele mandou, o que está
// pendente e o que as telas relatam.

import { randomUUID } from 'node:crypto';
import { redactKeyLike } from '../agents/research.ts';
import { OpenBotApi, OpenBotFechado, type AgenteApi } from './api.ts';
import type { EstadoOpenBot, OpenBotLike, StatusEntrega } from './tipos.ts';

const FINAIS: ReadonlySet<StatusEntrega> = new Set(['completed', 'failed', 'interrupted', 'cancelled']);
const MAX_TAREFAS = 50;
const MAX_RELATOS = 100;
const MAX_RELATO = 1000;
const MAX_TAREFA = 4000;
const MAX_RESPOSTA = 4000;
/** Quanto o NIGHT acompanha uma tarefa antes de desistir de esperar (ela continua no OpenBot). */
const PRAZO_TAREFA_MS = 30 * 60_000;

type Tarefa = EstadoOpenBot['tarefas'][number] & { agenteId: string };
type Pendente = EstadoOpenBot['pendentes'][number];

export interface EspelhoOpcoes {
  api?: OpenBotApi;
  /** De quanto em quanto tempo olha agentes e pendências (o painel pergunta a cada 5 s). */
  intervaloMs?: number;
  /** Intervalo entre consultas de uma tarefa em andamento. */
  passoTarefaMs?: number;
  prazoTarefaMs?: number;
  /** Quando uma tarefa termina ou aparece algo esperando o Joel. */
  aoNovidade?: (texto: string) => void;
}

export function semAcento(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Acha o agente pelo nome: igual; senão um único que contenha o nome ("Radar" acha "NIGHT Radar"). */
export function acharAgente(agentes: AgenteApi[], pedido: string): AgenteApi | 'varios' | null {
  const p = semAcento(pedido);
  const exato = agentes.find((a) => a.id === pedido || semAcento(a.name) === p);
  if (exato) return exato;
  const parecidos = agentes.filter((a) => semAcento(a.name).split(' ').includes(p) || semAcento(a.name).includes(p));
  if (parecidos.length === 1) return parecidos[0]!;
  return parecidos.length > 1 ? 'varios' : null;
}

/**
 * Texto de uma pendência do OpenBot, sem confiar no formato exato (a API não o documenta por campo). O que o
 * agente vai EXECUTAR (comando, descrição) vem antes do título: é o que o Joel precisa ver para aceitar.
 * Só campos conhecidos: o objeto inteiro nunca é copiado (pode ter token com outro nome).
 */
export function textoPendencia(item: unknown): string {
  const x = (item ?? {}) as Record<string, unknown>;
  const partes: string[] = [];
  for (const k of ['command', 'description', 'question', 'title', 'summary', 'reason', 'message', 'text']) {
    const v = x[k];
    if (typeof v === 'string' && v.trim() && !partes.includes(v.trim())) partes.push(v.trim());
    if (partes.length === 2) break;
  }
  return partes.length ? redactKeyLike(partes.join(' — ')).slice(0, 600) : 'Pedido sem descrição. Veja os detalhes no OpenBot antes de aceitar.';
}

function idPendencia(item: unknown): string | null {
  const x = (item ?? {}) as Record<string, unknown>;
  const id = x.requestId ?? x.id ?? x.approvalId ?? x.promptId;
  return typeof id === 'string' ? id : null;
}

export class OpenBotEspelho implements OpenBotLike {
  private readonly api: OpenBotApi;
  private agentes: AgenteApi[] = [];
  private pendentes: Pendente[] = [];
  private tarefas: Tarefa[] = [];
  private relatos: EstadoOpenBot['relatos'] = [];
  private motivo: string | null = 'Ainda não consultei o OpenBot.';
  private timer: NodeJS.Timeout | null = null;
  private vistos = new Set<string>();
  private readonly ouvintes: ((texto: string) => void)[] = [];
  /** parar() solta as tarefas acompanhadas: sem isso continuariam consultando o OpenBot por até 30 min. */
  private parado = false;
  private atualizando = false;

  constructor(private readonly opts: EspelhoOpcoes = {}) {
    this.api = opts.api ?? new OpenBotApi();
  }

  /** Quem quer saber das novidades (o servidor põe na conversa do painel e nas novidades da tela NIGHT). */
  ouvir(fn: (texto: string) => void): void { this.ouvintes.push(fn); }

  private avisar(texto: string): void {
    this.opts.aoNovidade?.(texto);
    for (const fn of this.ouvintes) { try { fn(texto); } catch { /* um ouvinte com erro não para os outros */ } }
  }

  iniciar(): void {
    if (this.timer) return;
    this.parado = false;
    void this.atualizar();
    this.timer = setInterval(() => void this.atualizar(), this.opts.intervaloMs ?? 15_000);
    this.timer.unref();
  }

  parar(): void {
    this.parado = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Olha agentes e pendências. Falha não derruba nada: vira o "motivo" do painel. */
  async atualizar(): Promise<void> {
    // Uma consulta por vez: uma lenta não pode atropelar a seguinte com dados velhos.
    if (this.atualizando) return;
    this.atualizando = true;
    try {
      this.agentes = await this.api.agentes();
      const novos: Pendente[] = [];
      for (const a of this.agentes) {
        const p = await this.api.pendentes(a.id);
        for (const [tipo, lista] of [['aprovacao', p.approvals], ['pergunta', p.prompts]] as const) {
          for (const item of lista) {
            const id = idPendencia(item);
            if (id) novos.push({ agenteId: a.id, agente: a.name, tipo, id, texto: textoPendencia(item) });
          }
        }
      }
      for (const p of novos) {
        const chave = `${p.agenteId}:${p.id}`;
        if (!this.vistos.has(chave)) {
          this.vistos.add(chave);
          this.avisar(`O agente ${p.agente} do OpenBot espera você: ${p.texto}`);
        }
      }
      this.pendentes = novos;
      this.motivo = this.agentes.length ? null : 'Nenhum agente do OpenBot tem "Local scripts" ligado.';
    } catch (err) {
      this.agentes = [];
      this.pendentes = [];
      this.motivo = redactKeyLike(err instanceof OpenBotFechado ? err.message : `Erro ao ler o OpenBot: ${(err as Error).message}`);
    } finally {
      this.atualizando = false;
    }
  }

  estado(): EstadoOpenBot {
    return {
      ligado: this.motivo === null,
      motivo: this.motivo,
      agentes: this.agentes.map((a) => ({ id: a.id, nome: a.name })),
      tarefas: this.tarefas.map(({ agenteId: _a, ...t }) => t),
      pendentes: this.pendentes,
      relatos: this.relatos,
    };
  }

  /** night_relatar: uma tela conta o que fez. */
  relatar(tela: string, texto: string): void {
    const limpo = redactKeyLike(texto.trim()).slice(0, MAX_RELATO);
    if (!limpo) return;
    this.relatos = [{ tela, texto: limpo, em: new Date().toISOString() }, ...this.relatos].slice(0, MAX_RELATOS);
  }

  async enviar(agente: string, tarefa: string): Promise<{ texto: string; depois?: Promise<string> }> {
    const t = tarefa.trim().slice(0, MAX_TAREFA);
    if (!t) return { texto: 'Faltou dizer a tarefa.' };
    let agentes: AgenteApi[];
    try {
      agentes = await this.api.agentes();
    } catch (err) {
      return { texto: redactKeyLike((err as Error).message) };
    }
    this.agentes = agentes;
    const alvo = acharAgente(agentes, agente);
    const nomes = agentes.map((a) => a.name).join(', ') || 'nenhum';
    if (alvo === 'varios') return { texto: `Mais de um agente do OpenBot tem "${agente}" no nome. Diga o nome inteiro (${nomes}).` };
    if (!alvo) return { texto: `Não achei o agente "${agente}" no OpenBot. Com "Local scripts" ligado: ${nomes}.` };
    let deliveryId: string | null;
    try {
      ({ deliveryId } = await this.api.enviar(alvo.id, t, randomUUID()));
    } catch (err) {
      return { texto: redactKeyLike((err as Error).message) };
    }
    if (!deliveryId) return { texto: `Mandei para o ${alvo.name} do OpenBot, mas ele não devolveu como acompanhar. Veja no OpenBot.` };
    const tarefaReg: Tarefa = { id: deliveryId, agenteId: alvo.id, agente: alvo.name, texto: redactKeyLike(t), status: 'queued', resposta: null, erro: null, em: new Date().toISOString() };
    this.tarefas = [tarefaReg, ...this.tarefas].slice(0, MAX_TAREFAS);
    const depois = this.acompanhar(tarefaReg);
    return { texto: `Mandei para o ${alvo.name} do OpenBot. Te aviso quando ele responder.`, depois };
  }

  /** Consulta a entrega até terminar; devolve o texto para falar/mostrar. */
  private async acompanhar(t: Tarefa): Promise<string> {
    const fim = Date.now() + (this.opts.prazoTarefaMs ?? PRAZO_TAREFA_MS);
    const passo = this.opts.passoTarefaMs ?? 5_000;
    let falhas = 0;
    while (Date.now() < fim && !this.parado) {
      await new Promise((ok) => setTimeout(ok, passo).unref());
      if (this.parado) break;
      try {
        const e = await this.api.entrega(t.agenteId, t.id);
        if (typeof e?.status !== 'string') throw new Error('entrega sem status');
        falhas = 0;
        t.status = e.status;
        if (!FINAIS.has(e.status)) continue;
        const resposta = typeof e.answer === 'string' ? redactKeyLike(e.answer).slice(0, MAX_RESPOSTA) : null;
        if (e.status === 'completed') {
          t.resposta = resposta;
          const texto = resposta ? `O ${t.agente} do OpenBot respondeu: ${resposta}` : `O ${t.agente} do OpenBot terminou, sem texto de resposta.`;
          this.avisar(texto);
          return texto;
        }
        t.erro = redactKeyLike(e.error ?? STATUS_PT[e.status]).slice(0, 1000);
        const texto = `A tarefa do ${t.agente} do OpenBot ${STATUS_PT[e.status]}: ${t.erro}`;
        this.avisar(texto);
        return texto;
      } catch {
        // OpenBot reiniciando: tenta mais algumas vezes antes de desistir.
        if (++falhas >= 12) break;
      }
    }
    return `Parei de acompanhar a tarefa do ${t.agente} no OpenBot; ela continua lá. Veja no OpenBot.`;
  }

  async responderAprovacao(agenteId: string, pedidoId: string, decisao: 'accept' | 'decline'): Promise<string> {
    const p = this.pendentes.find((x) => x.agenteId === agenteId && x.id === pedidoId && x.tipo === 'aprovacao');
    if (!p) return 'Esse pedido de aprovação não está mais pendente.';
    try {
      await this.api.responderAprovacao(agenteId, pedidoId, decisao);
    } catch (err) {
      return redactKeyLike((err as Error).message);
    }
    this.pendentes = this.pendentes.filter((x) => x !== p);
    return decisao === 'accept' ? `Aceito no ${p.agente} do OpenBot.` : `Recusado no ${p.agente} do OpenBot.`;
  }

  async resumo(): Promise<string> {
    await this.atualizar();
    if (this.motivo) return this.motivo;
    const partes = [`Agentes do OpenBot com automação: ${this.agentes.map((a) => a.name).join(', ')}.`];
    const andando = this.tarefas.filter((t) => !FINAIS.has(t.status));
    if (andando.length) partes.push(`Tarefas que mandei e ainda rodam: ${andando.map((t) => `${t.agente} (${t.texto.slice(0, 60)})`).join('; ')}.`);
    const prontas = this.tarefas.filter((t) => t.status === 'completed').slice(0, 3);
    if (prontas.length) partes.push(`Últimas prontas: ${prontas.map((t) => `${t.agente}: ${t.texto.slice(0, 60)}`).join('; ')}.`);
    if (this.pendentes.length) partes.push(`${this.pendentes.length} coisa(s) esperando você no painel, seção OpenBot.`);
    // O texto dos relatos fica só no painel: o /mcp não tem token, então qualquer programa local escreve nele,
    // e o resumo pode ir para a voz ao vivo (OpenAI).
    if (this.relatos.length) partes.push(`As telas relataram ${this.relatos.length} coisa(s); estão no painel, seção OpenBot.`);
    return partes.join(' ');
  }
}

const STATUS_PT: Record<StatusEntrega, string> = {
  queued: 'está na fila', starting: 'está começando', running: 'está rodando', completed: 'terminou',
  failed: 'falhou', interrupted: 'foi interrompida', cancelled: 'foi cancelada',
};
