// Nota de triagem do Radar de Ofertas (R04), em código puro: sem banco, sem modelo.
// A rubrica está em docs/research/radar-de-ofertas-franklim-extracao.md (pág. 5 e 6).
//
// Duas regras do PDF valem como contrato aqui:
// - "inventar número" é proibido: valor ausente (null/undefined) NUNCA vira 0 nem é estimado;
//   a nota fica parcial e o critério entra em `faltando`.
// - a justificativa vem quebrada por critério, na mesma ordem da rubrica.
//
// Limite duplicado do 80: o PDF escreve "31-80 = 2 | 80+ = 3", repetindo o 80 nos dois lados.
// Ficou em 2 (31..80 inclusive), senão o mesmo dado poderia valer 2 ou 3 e a nota deixaria de ser
// reproduzível. Anúncios ativos também aceita 0 ("1-10 = 0" no PDF) para não travar dado real.
//
// Determinismo: nada de data/hora ou aleatoriedade; a mesma entrada devolve sempre a mesma saída.

export const RUBRIC_VERSION = 'triagem/2';
export const CORTE_TRIAGEM = 6;

export type CriterioNome =
  | 'anunciosAtivos'
  | 'diasNoAr'
  | 'anunciantesNoNicho'
  | 'precoOrigem'
  | 'entregavelEmPdf';

export interface ScoreInput {
  /** Anúncios ativos da página. null/undefined = não visível. */
  anunciosAtivos?: number | null;
  /** Dias no ar do anúncio mais antigo. null/undefined = não visível. */
  diasNoAr?: number | null;
  /** Total de anunciantes no nicho, incluindo o próprio. null/undefined = não visível. */
  anunciantesNoNicho?: number | null;
  /** Preço de origem em reais, com centavos. null/undefined = não visível. */
  precoOrigem?: number | null;
  /** Dá para entregar em PDF sem gravar vídeo. null/undefined = não visível. */
  entregavelEmPdf?: boolean | null;
}

export interface CriterioResultado {
  nome: CriterioNome;
  valor: number | boolean | null;
  /** null quando o valor não foi visto: ausente não pontua nem vira zero. */
  pontos: number | null;
  maximo: number;
}

export interface ScoreResultado {
  version: typeof RUBRIC_VERSION;
  /** Soma só dos critérios presentes. */
  nota: number;
  /** Soma dos máximos dos critérios presentes. */
  maximoPossivel: number;
  parcial: boolean;
  faltando: CriterioNome[];
  criterios: CriterioResultado[];
  justificativa: string;
}

function erro(nome: CriterioNome, esperado: string, valor: unknown): Error {
  return new Error(`${nome} inválido: esperava ${esperado}, recebi ${String(valor)}`);
}

/** Inteiro >= mínimo; NaN, Infinity e centavos são recusados. */
function inteiro(nome: CriterioNome, valor: unknown, minimo: number): number {
  if (typeof valor !== 'number' || !Number.isFinite(valor) || !Number.isInteger(valor) || valor < minimo) {
    throw erro(nome, `inteiro maior ou igual a ${minimo}`, valor);
  }
  return valor;
}

/** Preço em reais: número finito e maior que zero; centavos são permitidos. */
function preco(nome: CriterioNome, valor: unknown): number {
  if (typeof valor !== 'number' || !Number.isFinite(valor) || valor <= 0) {
    throw erro(nome, 'número maior que zero', valor);
  }
  return valor;
}

function booleano(nome: CriterioNome, valor: unknown): boolean {
  if (typeof valor !== 'boolean') throw erro(nome, 'true ou false', valor);
  return valor;
}

function ausente(nome: CriterioNome, maximo: number): CriterioResultado {
  return { nome, valor: null, pontos: null, maximo };
}

// Intervalos já resolvidos (ver comentário do topo).

/** 0..10 = 0 | 11..30 = 1 | 31..80 = 2 | 81+ = 3 */
function pontosAnunciosAtivos(n: number): number {
  if (n <= 10) return 0;
  if (n <= 30) return 1;
  if (n <= 80) return 2;
  return 3;
}

/** < 7 = 0 | 7..30 = 1 | > 30 = 2 */
function pontosDiasNoAr(n: number): number {
  if (n < 7) return 0;
  if (n <= 30) return 1;
  return 2;
}

/** 1 = 0 | 2..3 = 1 | 4+ = 2 */
function pontosAnunciantesNoNicho(n: number): number {
  if (n === 1) return 0;
  if (n <= 3) return 1;
  return 2;
}

/** < 37 = 0 | 37..67 = 1 | > 67 = 2 */
function pontosPrecoOrigem(p: number): number {
  if (p < 37) return 0;
  if (p <= 67) return 1;
  return 2;
}

/** Preço no formato brasileiro: R$97 inteiro, R$67,90 com centavos. */
function precoBr(valor: number): string {
  const texto = Number.isInteger(valor) ? String(valor) : valor.toFixed(2).replace('.', ',');
  return `R$${texto}`;
}

/** Texto do critério como no PDF; ausente vira "não visível", nunca número inventado. */
const DESCREVE: Record<CriterioNome, (valor: number | boolean | null) => string> = {
  anunciosAtivos: (v) => (v === null ? 'anúncios ativos da página não visível' : `${v} anúncios ativos da página`),
  diasNoAr: (v) => (v === null ? 'dias no ar não visível' : `${v} dias no ar`),
  anunciantesNoNicho: (v) => (v === null ? 'anunciantes no nicho não visível' : `${v} anunciantes no nicho`),
  precoOrigem: (v) => (v === null ? 'origem não visível' : `origem ${precoBr(v as number)}`),
  entregavelEmPdf: (v) => (v === null ? 'entregável não visível' : v ? 'entregável em PDF' : 'não entregável em PDF'),
};

export function scoreCandidate(input: ScoreInput): ScoreResultado {
  const criterios: CriterioResultado[] = [
    input.anunciosAtivos === null || input.anunciosAtivos === undefined
      ? ausente('anunciosAtivos', 3)
      : { nome: 'anunciosAtivos', valor: input.anunciosAtivos, maximo: 3, pontos: pontosAnunciosAtivos(inteiro('anunciosAtivos', input.anunciosAtivos, 0)) },
    input.diasNoAr === null || input.diasNoAr === undefined
      ? ausente('diasNoAr', 2)
      : { nome: 'diasNoAr', valor: input.diasNoAr, maximo: 2, pontos: pontosDiasNoAr(inteiro('diasNoAr', input.diasNoAr, 0)) },
    input.anunciantesNoNicho === null || input.anunciantesNoNicho === undefined
      ? ausente('anunciantesNoNicho', 2)
      : {
          nome: 'anunciantesNoNicho',
          valor: input.anunciantesNoNicho,
          maximo: 2,
          pontos: pontosAnunciantesNoNicho(inteiro('anunciantesNoNicho', input.anunciantesNoNicho, 1)),
        },
    input.precoOrigem === null || input.precoOrigem === undefined
      ? ausente('precoOrigem', 2)
      : { nome: 'precoOrigem', valor: input.precoOrigem, maximo: 2, pontos: pontosPrecoOrigem(preco('precoOrigem', input.precoOrigem)) },
    input.entregavelEmPdf === null || input.entregavelEmPdf === undefined
      ? ausente('entregavelEmPdf', 1)
      : { nome: 'entregavelEmPdf', valor: input.entregavelEmPdf, maximo: 1, pontos: booleano('entregavelEmPdf', input.entregavelEmPdf) ? 1 : 0 },
  ];

  const faltando = criterios.filter((c) => c.pontos === null).map((c) => c.nome);
  const nota = criterios.reduce((soma, c) => soma + (c.pontos ?? 0), 0);
  const maximoPossivel = criterios.reduce((soma, c) => soma + (c.pontos === null ? 0 : c.maximo), 0);
  const parcial = faltando.length > 0;

  const soma = criterios.map((c) => (c.pontos === null ? '?' : String(c.pontos))).join('+');
  const detalhe = criterios.map((c) => DESCREVE[c.nome](c.valor)).join(', ');
  const justificativa = `${soma} = ${nota}${parcial ? ` (parcial, máx. ${maximoPossivel})` : ''}. ${detalhe}.`;

  return { version: RUBRIC_VERSION, nota, maximoPossivel, parcial, faltando, criterios, justificativa };
}

/** Parcial só passa com os três critérios visíveis da busca da Meta. */
export function acimaDoCorte(score: ScoreResultado): boolean {
  if (!score.parcial) return score.nota >= CORTE_TRIAGEM;
  if (score.maximoPossivel === 0 || score.nota / score.maximoPossivel < CORTE_TRIAGEM / 10) return false;
  return score.faltando.every((nome) => nome === 'diasNoAr' || nome === 'precoOrigem');
}
