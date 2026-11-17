// Medição semanal do Radar (R08): lê o banco e monta um texto curto para o Joel comparar semanas.
// A nota é de triagem e o tempo de anúncio não prova venda: o texto deixa isso explícito.

import type { RadarWeeklyCounts } from './store.ts';

/** O que a medição precisa do banco; PgRadarStore satisfaz. */
export interface RadarMetricsStore {
  radarWeeklyCounts(from: string | Date, to: string | Date): Promise<RadarWeeklyCounts>;
}

export interface RadarWeeklyOptions {
  /** Início da janela (inclusive). */
  from: string | Date;
  /** Fim da janela (exclusive). */
  to: string | Date;
}

export interface RadarWeekly extends RadarWeeklyCounts {
  /** Mesma janela, imediatamente antes: a comparação é com a semana anterior. */
  anterior: RadarWeeklyCounts;
  /** Texto curto para a tela/voz, sem tratar tempo de anúncio como prova de venda. */
  texto: string;
}

const DIA_MS = 24 * 60 * 60 * 1000;

const comoData = (valor: string | Date): Date =>
  valor instanceof Date ? valor : new Date(valor);

const dataCurta = (valor: string | Date): string =>
  comoData(valor).toISOString().slice(0, 10);

/** Diferença falada de forma curta: "+2", "-1" ou "igual". */
function delta(atual: number, anterior: number): string {
  const d = atual - anterior;
  return d === 0 ? 'igual' : d > 0 ? `+${d}` : String(d);
}

function resumo(c: RadarWeeklyCounts): string {
  return `${c.candidatosVistos} candidato(s) visto(s) (${c.novos} novo(s), ${c.duplicados} duplicado(s), ` +
    `${c.incompletos} incompleto(s)), ${c.acimaDoCorte} acima da nota 7; ` +
    `${c.propostasCriadas} proposta(s) criada(s), ${c.discutidas} discutida(s), ` +
    `${c.aceitas} aceita(s), ${c.rejeitadas} rejeitada(s)`;
}

/**
 * Contadores da janela + comparação com a janela anterior de mesmo tamanho.
 * Não conclui venda a partir de nota ou tempo no ar: são sinais de triagem.
 */
export async function radarWeekly(
  store: RadarMetricsStore, opts: RadarWeeklyOptions,
): Promise<RadarWeekly> {
  const from = comoData(opts.from);
  const to = comoData(opts.to);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new Error('janela inválida: from e to precisam ser datas');
  }
  if (to.getTime() <= from.getTime()) {
    throw new Error('janela inválida: to precisa ser depois de from');
  }
  const duracao = to.getTime() - from.getTime();
  const anteriorFrom = new Date(from.getTime() - duracao);
  const [atual, anterior] = await Promise.all([
    store.radarWeeklyCounts(from, to),
    store.radarWeeklyCounts(anteriorFrom, from),
  ]);

  const periodo = `${dataCurta(from)} a ${dataCurta(to)}`;
  const comparacao = [
    `vistos ${delta(atual.candidatosVistos, anterior.candidatosVistos)}`,
    `novos ${delta(atual.novos, anterior.novos)}`,
    `propostas ${delta(atual.propostasCriadas, anterior.propostasCriadas)}`,
    `aceitas ${delta(atual.aceitas, anterior.aceitas)}`,
  ].join(', ');
  const texto = `Radar ${periodo}: ${resumo(atual)}. ` +
    `Comparado à janela anterior (${dataCurta(anteriorFrom)} a ${dataCurta(from)}): ${comparacao}. ` +
    'Nota e tempo de anúncio são triagem, não prova de venda.';

  return { ...atual, anterior, texto };
}

// Mantém o intervalo entre semanas explícito para quem for ler o código.
export const SEMANA_MS = 7 * DIA_MS;
