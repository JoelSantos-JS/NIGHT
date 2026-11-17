// Leitura do teste de um produto low-ticket (L05) e regra de escala como sugestão (L06).
// Código puro: sem banco, sem rede e sem modelo. O cálculo é em código; a interpretação
// é marcada como hipótese (hipotese: true) e nunca promete resultado.
//
// A escala só SUGERE. Mudar orçamento é efeito externo na conta de anúncios: exige
// aprovação 'spend' do Joel com valor e campanha (M08). O NIGHT nunca aplica sozinho.

/** Números de um teste, como o Joel informa; visitas e checkouts podem não existir. */
export interface TestNumbers {
  /** Datas ISO (AAAA-MM-DD) do período medido. */
  periodo: { de: string; ate: string };
  gastoBRL: number;
  impressoes: number;
  cliques: number;
  visitasPagina?: number | null;
  checkoutsIniciados?: number | null;
  vendas: number;
  precoBRL: number;
  reembolsos?: number | null;
}

export type OndeFuro =
  | 'criativo'
  | 'pagina'
  | 'preco_ou_oferta'
  | 'checkout'
  | 'amostra_pequena'
  | 'sem_furo_obvio';

export interface Diagnostico {
  onde: OndeFuro;
  porque: string;
  proximoTeste: string;
}

export interface Metricas {
  ctr: number;
  cpc: number;
  cpm: number;
  conversaoClique: number;
  /** null quando não há visitas informadas: sem denominador, não se inventa número. */
  conversaoPagina: number | null;
  /** null sem vendas: CPA é gasto por venda. */
  cpa: number | null;
  receitaBRL: number;
  /** null sem gasto: ROAS é receita por real gasto. */
  roas: number | null;
}

export interface TestAnalysis {
  metricas: Metricas;
  /** Um furo por vez, na ordem em que o dado deixa de sustentar o próximo passo. */
  diagnostico: Diagnostico[];
  hipotese: true;
  resumoVoz: string;
  tela: string;
}

/** Mínimo para concluir algo: abaixo disso o número oscila demais (PDF, passo 4). */
const MIN_IMPRESSOES = 1000;
const MIN_CLIQUES = 30;

/** Checkout só é apontado com volume mínimo e perda de mais da metade no pagamento. */
const MIN_CHECKOUTS = 10;
const CONVERSAO_CHECKOUT_MINIMA = 0.5;

export type NumerosBrutos = Partial<Record<keyof TestNumbers, unknown>>;

const CAMPOS_OBRIGATORIOS = ['gastoBRL', 'impressoes', 'cliques', 'vendas', 'precoBRL'] as const;

type CampoNumerico =
  | 'gastoBRL'
  | 'impressoes'
  | 'cliques'
  | 'visitasPagina'
  | 'checkoutsIniciados'
  | 'vendas'
  | 'precoBRL'
  | 'reembolsos';

/** Data ISO existe de verdade: regex sozinha aceitaria 2026-13-45. */
function dataISO(valor: unknown, campo: string, erros: string[]): string | null {
  if (typeof valor !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(valor) || !Number.isFinite(Date.parse(valor))) {
    erros.push(`periodo.${campo} precisa ser uma data ISO (AAAA-MM-DD)`);
    return null;
  }
  return valor;
}

/**
 * Junta todos os problemas de uma vez, em português, para o Joel corrigir de uma vez só.
 * Devolve lista vazia quando os números servem para analisar.
 */
export function validateNumbers(raw: NumerosBrutos): string[] {
  const erros: string[] = [];

  const numero = (campo: CampoNumerico): number | null => {
    const valor = raw[campo];
    if (valor === undefined || valor === null) {
      if ((CAMPOS_OBRIGATORIOS as readonly string[]).includes(campo)) erros.push(`${campo} é obrigatório`);
      return null;
    }
    if (typeof valor !== 'number' || !Number.isFinite(valor)) {
      erros.push(`${campo} precisa ser um número válido (recebido: ${String(valor)})`);
      return null;
    }
    if (valor < 0) {
      erros.push(`${campo} não pode ser negativo (recebido: ${valor})`);
      return null;
    }
    return valor;
  };

  numero('gastoBRL');
  const impressoes = numero('impressoes');
  const cliques = numero('cliques');
  const visitas = numero('visitasPagina');
  const checkouts = numero('checkoutsIniciados');
  const vendas = numero('vendas');
  const preco = numero('precoBRL');
  numero('reembolsos');

  if (preco !== null && preco <= 0) erros.push('precoBRL precisa ser maior que zero');

  if (impressoes !== null && cliques !== null && cliques > impressoes) {
    erros.push(`cliques (${cliques}) não pode ser maior que impressões (${impressoes})`);
  }
  if (cliques !== null && vendas !== null && vendas > cliques) {
    erros.push(`vendas (${vendas}) não pode ser maior que cliques (${cliques})`);
  }
  if (visitas !== null && visitas > 0 && checkouts !== null && checkouts > visitas) {
    erros.push(`checkoutsIniciados (${checkouts}) não pode ser maior que visitasPagina (${visitas})`);
  }

  const periodo = raw.periodo as { de?: unknown; ate?: unknown } | null | undefined;
  if (periodo === null || periodo === undefined || typeof periodo !== 'object') {
    erros.push('periodo é obrigatório (de e ate em AAAA-MM-DD)');
  } else {
    const de = dataISO(periodo.de, 'de', erros);
    const ate = dataISO(periodo.ate, 'ate', erros);
    if (de !== null && ate !== null && Date.parse(de) > Date.parse(ate)) {
      erros.push('periodo: a data "de" vem depois da data "ate"');
    }
  }

  return erros;
}

/** Reais com 2 casas e vírgula: R$ 12,34. */
function brl(valor: number): string {
  return `R$ ${valor.toFixed(2).replace('.', ',')}`;
}

/** Porcentagem com 1 casa e vírgula: 1,8%. */
function pct(fracao: number): string {
  return `${(fracao * 100).toFixed(1).replace('.', ',')}%`;
}

/** Número decimal com vírgula: 1,17. */
function decimal(valor: number): string {
  return valor.toFixed(2).replace('.', ',');
}

/** "1 venda" / "2 vendas": o resumo é falado em voz alta. */
function vendasTexto(quantidade: number): string {
  return quantidade === 1 ? '1 venda' : `${quantidade} vendas`;
}

/** Divisão que evita Infinity: sem denominador o valor fica 0 (a amostra já denuncia). */
function seguro(numerador: number, denominador: number): number {
  return denominador === 0 ? 0 : numerador / denominador;
}

export interface LimitesAnalise {
  /** CTR mínimo: abaixo disso o criativo não para o dedo. Padrão 1%. */
  ctrMinimo?: number;
  /** Conversão mínima de visitas em vendas. Padrão 2%. */
  conversaoPaginaMinima?: number;
  /** Teto do CPA como fração do preço. Padrão 1 (CPA igual ao preço já é o limite). */
  cpaMaximoFracaoPreco?: number;
}

const CTR_MINIMO = 0.01;
const CONVERSAO_PAGINA_MINIMA = 0.02;
const CPA_MAXIMO_FRACAO_PRECO = 1;

/** Cálculo puro das métricas; divulga os números antes de qualquer interpretação. */
function calcular(n: TestNumbers): Metricas {
  const receitaBRL = n.vendas * n.precoBRL;
  const visitas = n.visitasPagina ?? null;
  return {
    ctr: seguro(n.cliques, n.impressoes),
    cpc: seguro(n.gastoBRL, n.cliques),
    // Multiplica antes de dividir para não arrastar erro de ponto flutuante em centavos.
    cpm: seguro(n.gastoBRL * 1000, n.impressoes),
    conversaoClique: seguro(n.vendas, n.cliques),
    conversaoPagina: visitas !== null && visitas > 0 ? n.vendas / visitas : null,
    cpa: n.vendas > 0 ? n.gastoBRL / n.vendas : null,
    receitaBRL,
    roas: n.gastoBRL > 0 ? receitaBRL / n.gastoBRL : null,
  };
}

/**
 * Regras do L05, em cascata: um furo por vez, e só depois que o passo anterior tem número
 * suficiente. Ordem: amostra → criativo → página → checkout → preço/oferta → sem furo.
 * Tudo é hipótese: o teste aponta onde olhar, não garante a causa.
 */
function diagnosticar(n: TestNumbers, m: Metricas, limites: Required<LimitesAnalise>): Diagnostico[] {
  // Amostra pequena primeiro: com pouco número, qualquer conclusão seria chute.
  if (n.impressoes < MIN_IMPRESSOES || n.cliques < MIN_CLIQUES) {
    return [{
      onde: 'amostra_pequena',
      porque: `${n.impressoes} impressões e ${n.cliques} cliques: abaixo do mínimo de ${MIN_IMPRESSOES} impressões e ${MIN_CLIQUES} cliques para concluir.`,
      proximoTeste: 'Deixar rodar até passar de 1.000 impressões e 30 cliques antes de mudar qualquer coisa.',
    }];
  }

  // CTR ruim aponta o criativo; não adianta culpar a página com tráfego desqualificado.
  if (m.ctr < limites.ctrMinimo) {
    return [{
      onde: 'criativo',
      porque: `CTR de ${pct(m.ctr)} abaixo do mínimo de ${pct(limites.ctrMinimo)}: o anúncio aparece e não puxa clique.`,
      proximoTeste: 'Testar ângulos novos de criativo, um por vez, mantendo página e preço.',
    }];
  }

  // CTR bom e conversão da página baixa: promessa, clareza ou prova estão falhando.
  // Sem visitas informadas a página não é medida; a leitura segue para o checkout.
  if (m.conversaoPagina !== null && m.conversaoPagina < limites.conversaoPaginaMinima) {
    return [{
      onde: 'pagina',
      porque: `CTR de ${pct(m.ctr)} está bom, mas só ${pct(m.conversaoPagina)} das visitas viram venda (mínimo ${pct(limites.conversaoPaginaMinima)}).`,
      proximoTeste: 'Testar promessa, clareza e prova na página, uma mudança por vez.',
    }];
  }

  // Muita gente começa o checkout e pouca termina: o furo tende a estar no pagamento.
  const checkouts = n.checkoutsIniciados ?? null;
  if (checkouts !== null && checkouts >= MIN_CHECKOUTS && seguro(n.vendas, checkouts) < CONVERSAO_CHECKOUT_MINIMA) {
    return [{
      onde: 'checkout',
      porque: `${checkouts} checkouts iniciados e ${vendasTexto(n.vendas)}: a maioria desiste no pagamento.`,
      proximoTeste: 'Revisar o checkout: formas de pagamento, campos e erros visíveis; uma mudança por vez.',
    }];
  }

  // Vende, mas cada venda custa mais do que o preço: o problema é preço/oferta, não mídia.
  if (m.cpa !== null && m.cpa > n.precoBRL * limites.cpaMaximoFracaoPreco) {
    return [{
      onde: 'preco_ou_oferta',
      porque: `CPA de ${brl(m.cpa)} acima do preço de ${brl(n.precoBRL)}: cada venda custa mais do que rende.`,
      proximoTeste: 'Testar preço ou oferta (novo valor, bônus ou ancoragem), sem prometer resultado.',
    }];
  }

  // Sem furo óbvio não é prova de saúde: diz apenas que nenhuma regra disparou.
  // O texto separa o que foi medido do que ficou sem dado, para não inventar saúde.
  const pagina = m.conversaoPagina === null
    ? 'sem visitas informadas a página não foi medida'
    : `página convertendo ${pct(m.conversaoPagina)}`;
  const checkout = checkouts === null ? 'checkout não informado' : 'checkout sem perda clara';
  const cpa = m.cpa === null ? 'CPA sem vendas para medir' : `CPA de ${brl(m.cpa)} dentro do preço`;
  return [{
    onde: 'sem_furo_obvio',
    porque: `CTR de ${pct(m.ctr)}, ${pagina}, ${checkout} e ${cpa} de ${brl(n.precoBRL)}: nenhuma regra disparou.`,
    proximoTeste: 'Manter o teste mais alguns dias e informar visitas e checkouts para medir melhor.',
  }];
}

const RESUMO: Record<OndeFuro, string> = {
  amostra_pequena: 'a amostra ainda é pequena e não dá para apontar o furo',
  criativo: 'o furo parece estar no criativo',
  pagina: 'o furo parece estar na página',
  checkout: 'o furo parece estar no checkout',
  preco_ou_oferta: 'o furo parece estar no preço ou na oferta',
  sem_furo_obvio: 'não apareceu furo óbvio nos números',
};

/**
 * Analisa um teste (L05). Recusa números inválidos em vez de calcular em cima de lixo.
 * O diagnóstico é hipótese marcada; os números vêm do que o Joel informou (M07 + vendas).
 */
export function analyzeTest(n: TestNumbers, ref: LimitesAnalise = {}): TestAnalysis {
  const erros = validateNumbers(n);
  if (erros.length > 0) throw new Error(`números do teste inválidos: ${erros.join('; ')}`);

  const limites: Required<LimitesAnalise> = {
    ctrMinimo: ref.ctrMinimo ?? CTR_MINIMO,
    conversaoPaginaMinima: ref.conversaoPaginaMinima ?? CONVERSAO_PAGINA_MINIMA,
    cpaMaximoFracaoPreco: ref.cpaMaximoFracaoPreco ?? CPA_MAXIMO_FRACAO_PRECO,
  };

  const metricas = calcular(n);
  const diagnostico = diagnosticar(n, metricas, limites);
  const principal = diagnostico[0]!;

  const roas = metricas.roas === null ? 'sem gasto' : decimal(metricas.roas);
  const resumoVoz =
    `Hipótese: ${RESUMO[principal.onde]}. ` +
    `Gasto de ${brl(n.gastoBRL)}, ${vendasTexto(n.vendas)}, CTR de ${pct(metricas.ctr)} e ROAS ${roas}. ` +
    'É leitura dos números, não promessa de resultado.';

  const conversaoPagina =
    metricas.conversaoPagina === null ? 'sem visitas informadas' : pct(metricas.conversaoPagina);
  const cpa = metricas.cpa === null ? 'sem vendas' : brl(metricas.cpa);
  const tela = [
    `Teste de ${n.periodo.de} a ${n.periodo.ate}`,
    `gasto ${brl(n.gastoBRL)} · ${n.impressoes} impressões · ${n.cliques} cliques · ${vendasTexto(n.vendas)}`,
    `CTR ${pct(metricas.ctr)} · CPC ${brl(metricas.cpc)} · CPM ${brl(metricas.cpm)}`,
    `conversão por clique ${pct(metricas.conversaoClique)} · conversão da página ${conversaoPagina}`,
    `CPA ${cpa} · receita ${brl(metricas.receitaBRL)} · ROAS ${roas}`,
    '',
    `Hipótese: ${principal.porque}`,
    `Próximo teste: ${principal.proximoTeste}`,
  ].join('\n');

  return { metricas, diagnostico, hipotese: true, resumoVoz, tela };
}

export interface ScalingInput {
  orcamentoDiarioAtualBRL: number;
  /** null quando o orçamento nunca mudou desde o começo do teste. */
  ultimaMudancaISO: string | null;
  hojeISO: string;
  roas: number | null;
  vendasUltimos3Dias: number;
  cpaAtual: number | null;
  precoBRL: number;
}

export interface ScalingSuggestion {
  sugerir: boolean;
  novoOrcamentoBRL: number | null;
  motivo: string;
}

/** Regra do PDF: subir 30% por vez, nunca dobrar. */
const AUMENTO = 0.3;
/** Espera 3 dias cheios desde a última mudança para não resetar o aprendizado da Meta. */
const MIN_DIAS_ENTRE_MUDANCAS = 3;
const MIN_VENDAS_3_DIAS = 3;

/** Dias inteiros entre a última mudança e hoje; null quando nunca houve mudança. */
function diasDesde(ultimaISO: string | null, hojeISO: string): number | null {
  if (ultimaISO === null) return null;
  const ultima = Date.parse(ultimaISO);
  const hoje = Date.parse(hojeISO);
  if (!Number.isFinite(ultima)) throw new Error(`data inválida em ultimaMudancaISO: ${ultimaISO}`);
  if (!Number.isFinite(hoje)) throw new Error(`data inválida em hojeISO: ${hojeISO}`);
  // Mudança no futuro conta como 0 dias: recente, então não sugere.
  return Math.max(0, Math.floor((hoje - ultima) / 86_400_000));
}

/**
 * Sugestão de escala (L06). Só SUGERE: mudar orçamento é uma aprovação 'spend' do Joel
 * com valor e campanha (M08); o NIGHT nunca aplica sozinho, nem arredonda a decisão dele.
 */
export function suggestScaling(input: ScalingInput): ScalingSuggestion {
  const sem = (motivo: string): ScalingSuggestion => ({ sugerir: false, novoOrcamentoBRL: null, motivo });

  if (!(input.orcamentoDiarioAtualBRL > 0)) {
    return sem('orçamento atual precisa ser maior que zero para calcular o aumento de 30%.');
  }

  const dias = diasDesde(input.ultimaMudancaISO, input.hojeISO);
  if (dias !== null && dias < MIN_DIAS_ENTRE_MUDANCAS) {
    return sem(
      `última mudança há ${dias} dia(s): espere ${MIN_DIAS_ENTRE_MUDANCAS} dias ou mais para não resetar o aprendizado.`,
    );
  }

  if (input.roas === null || input.roas < 1) {
    return sem(
      `ROAS ${input.roas === null ? 'não medido' : decimal(input.roas)} abaixo de 1: subir orçamento agora só aumenta o prejuízo.`,
    );
  }

  if (input.cpaAtual === null) {
    return sem('CPA não medido (sem vendas): sem saber se cabe no preço, não há aumento seguro.');
  }
  if (input.cpaAtual > input.precoBRL) {
    return sem(
      `CPA de ${brl(input.cpaAtual)} acima do preço de ${brl(input.precoBRL)}: cada venda custa mais do que rende.`,
    );
  }

  if (input.vendasUltimos3Dias < MIN_VENDAS_3_DIAS) {
    return sem(
      `só ${input.vendasUltimos3Dias} venda(s) nos últimos 3 dias: menos de ${MIN_VENDAS_3_DIAS} não sustenta aumento.`,
    );
  }

  // 30% arredondado para R$ 1; nunca chega ao dobro.
  const novo = Math.round(input.orcamentoDiarioAtualBRL * (1 + AUMENTO));
  if (novo <= input.orcamentoDiarioAtualBRL) {
    return sem('o aumento de 30% não muda o orçamento em reais; ajuste manual com o Joel.');
  }

  return {
    sugerir: true,
    novoOrcamentoBRL: novo,
    motivo:
      `ROAS ${decimal(input.roas)} e CPA de ${brl(input.cpaAtual)} abaixo do preço de ${brl(input.precoBRL)}; ` +
      `${input.vendasUltimos3Dias} vendas em 3 dias. Sugestão: subir 30% por vez, de ` +
      `${brl(input.orcamentoDiarioAtualBRL)} para ${brl(novo)}, nunca o dobro. ` +
      `Mudar o orçamento exige aprovação 'spend' do Joel (M08); o NIGHT não aplica sozinho.`,
  };
}
