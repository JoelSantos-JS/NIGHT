// Formatos da ligação NIGHT ↔ OpenBot (API local de automação do OpenBot, docs/automation.md dele).

/** O que o coordenador usa do OpenBot. */
export interface OpenBotLike {
  /**
   * Manda uma tarefa a um agente do OpenBot (por nome ou id). `texto` = resposta curta na hora
   * ("mandei para o Radar"); `depois` = a resposta do agente quando a tarefa termina.
   */
  enviar(agente: string, tarefa: string): Promise<{ texto: string; depois?: Promise<string> }>;
  /** Resumo falável: agentes, tarefas que o NIGHT mandou e o que espera o Joel. */
  resumo(): Promise<string>;
}

export type StatusEntrega = 'queued' | 'starting' | 'running' | 'completed' | 'failed' | 'interrupted' | 'cancelled';

/** O que o painel mostra na seção OpenBot (vai em /api/estado como `openbot`). */
export interface EstadoOpenBot {
  /** false = OpenBot fechado ou nenhum agente com "Local scripts" ligado. */
  ligado: boolean;
  /** Por que não está ligado, em português simples. */
  motivo: string | null;
  agentes: { id: string; nome: string }[];
  /** Tarefas que o NIGHT mandou, mais novas primeiro. */
  tarefas: { id: string; agente: string; texto: string; status: StatusEntrega; resposta: string | null; erro: string | null; em: string }[];
  /** O que um agente do OpenBot espera do Joel. Aprovação dá para aceitar/recusar no painel; pergunta, só no OpenBot. */
  pendentes: { agenteId: string; agente: string; tipo: 'aprovacao' | 'pergunta'; id: string; texto: string }[];
  /** Diário das telas: cada tela relata o que fez com a ferramenta night_relatar. */
  relatos: { tela: string; texto: string; em: string }[];
}
