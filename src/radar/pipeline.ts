// Fluxo que transforma candidatos do Radar numa proposta de oferta com parecer (D06 + R05).
// Ordem: carrega os candidatos, monta o prompt, gera, valida com correção, consulta o parecer,
// decide pela regra de divergência e grava a oferta como rascunho.
//
// Nada aqui publica, compra ou gasta além das chamadas de modelo limitadas pelo tracker.
// O parecer do DeepSeek sobre uma proposta gerada pelo DeepSeek é do MESMO autor: não conta como
// revisão independente (decide já ignora o autor do trabalho) e nunca vira aprovação; aprovar é do Joel.

import { decide } from '../advisor/divergence.ts';
import type { DivergenceParecer, DivergenceResult } from '../advisor/divergence.ts';
import { getDecisionPoint } from '../advisor/matrix.ts';
import type { AdvisorEvidence, AdvisorInput, Recomendacao } from '../advisor/opinion.ts';
import type { AdvisorService, ConsultResult } from '../advisor/service.ts';
import type { LimitTracker } from '../jobs/limits.ts';
import { buildProposalPrompt, validateProposal } from './offer.ts';
import type {
  OfferProposal,
  ProposalCandidateInput,
  ProposalContext,
  ProposalError,
  ProposalMessage,
} from './offer.ts';
import type {
  NewFeedback,
  RadarCandidate,
  RadarFeedback,
  RadarOffer,
} from './store.ts';

/** Gerador injetável: na construção é a API do DeepSeek; depois da passagem será o Claude. */
export type ProposalGenerator = (
  messages: { role: 'system' | 'user'; content: string }[],
) => Promise<string>;

/** Só o que o pipeline precisa do banco; PgRadarStore satisfaz sem acoplar à implementação. */
export interface RadarPipelineStore {
  getCandidate(id: string): Promise<RadarCandidate | null>;
  createOffer(
    candidateId: string | null,
    proposal: Record<string, unknown>,
    sources?: unknown[],
  ): Promise<RadarOffer>;
  addFeedback(feedback: NewFeedback): Promise<RadarFeedback>;
}

export interface ProposeDeps {
  store: RadarPipelineStore;
  generator: ProposalGenerator;
  advisor: AdvisorService;
  /** Teto de chamadas do trabalho; sem tracker, nada além das chamadas do gerador é contado. */
  tracker?: LimitTracker;
}

export interface ProposeInput {
  jobId: string;
  candidateIds: string[];
  nicho: string;
  /** Tentativas totais da geração (a primeira + correções); padrão 2. */
  maxTentativas?: number;
}

export type ProposeResult =
  | {
      status: 'criada';
      number: number;
      version: number;
      parecer: ConsultResult;
      decisao: DivergenceResult;
      avisos: string[];
    }
  | { status: 'invalida'; errors: ProposalError[] };

const NAO_VISIVEL = 'não visível';

/** Campos do raw que trazem o texto do anúncio e da landing, como em conversation.ts. */
const CAMPOS_ANUNCIO = ['anuncioTexto', 'adText', 'anuncio', 'texto'] as const;
const CAMPOS_LANDING = ['landingResumo', 'landingText', 'landing'] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const texto = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

/** Primeiro texto não vazio entre os campos do raw; ausente nunca vira palpite. */
function textoDoRaw(raw: Record<string, unknown>, campos: readonly string[]): string | null {
  for (const campo of campos) {
    const achado = texto(raw[campo]);
    if (achado) return achado;
  }
  return null;
}

/** Todos os textos de anúncio/landing do raw, para a checagem de cópia. */
function textosDoRaw(raw: unknown): string[] {
  if (!isRecord(raw)) return [];
  const out: string[] = [];
  for (const campo of [...CAMPOS_ANUNCIO, ...CAMPOS_LANDING]) {
    const achado = texto(raw[campo]);
    if (achado) out.push(achado);
  }
  return out;
}

/** O que vai ao prompt: o que não existe fica "não visível", nunca inventado. */
function entradaDoCandidato(candidato: RadarCandidate): ProposalCandidateInput {
  const raw = isRecord(candidato.raw) ? candidato.raw : {};
  return {
    id: candidato.id,
    score: candidato.score?.justificativa ?? NAO_VISIVEL,
    anuncioTexto: textoDoRaw(raw, CAMPOS_ANUNCIO) ?? NAO_VISIVEL,
    landingResumo: textoDoRaw(raw, CAMPOS_LANDING) ?? NAO_VISIVEL,
  };
}

/** Falta de nota ou nota parcial entra na proposta como dúvida, para o Joel ver o que falta. */
function duvidasDosCandidatos(candidatos: RadarCandidate[]): string[] {
  const duvidas: string[] = [];
  for (const candidato of candidatos) {
    if (!candidato.score) {
      duvidas.push(`candidato ${candidato.id} sem nota de triagem; a proposta não tem nota que a sustente`);
      continue;
    }
    if (candidato.score.parcial) {
      const faltando = candidato.score.faltando.length
        ? candidato.score.faltando.join(', ')
        : 'alguns critérios';
      duvidas.push(
        `nota de ${candidato.id} é parcial (${candidato.score.nota}/${candidato.score.maximoPossivel}); falta: ${faltando}`,
      );
    }
  }
  return duvidas;
}

/** Evidências do parecer: justificativa da nota (interna) e trechos do raw (externa). */
function evidenciasParaParecer(candidatos: RadarCandidate[]): AdvisorEvidence[] {
  const evidencias: AdvisorEvidence[] = [];
  for (const candidato of candidatos) {
    if (candidato.score) {
      evidencias.push({
        ref: `nota:${candidato.id}`,
        origem: 'nota de triagem (código; não é prova de venda)',
        conteudo: candidato.score.justificativa,
        externa: false,
      });
    }
    const raw = isRecord(candidato.raw) ? candidato.raw : {};
    const anuncio = textoDoRaw(raw, CAMPOS_ANUNCIO);
    if (anuncio) {
      evidencias.push({
        ref: `anuncio:${candidato.id}`,
        origem: 'texto do anúncio do concorrente',
        conteudo: anuncio,
        externa: true,
      });
    }
    const landing = textoDoRaw(raw, CAMPOS_LANDING);
    if (landing) {
      evidencias.push({
        ref: `landing:${candidato.id}`,
        origem: 'resumo da landing do concorrente',
        conteudo: landing,
        externa: true,
      });
    }
  }
  return evidencias;
}

/** Extrai o JSON do modelo; cerca de markdown é aceita porque alguns modelos embrulham a resposta. */
function lerProposta(resposta: string): { ok: true; raw: unknown } | { ok: false; errors: ProposalError[] } {
  const bruto = resposta.trim();
  const cerca = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i.exec(bruto);
  const corpo = cerca ? (cerca[1] ?? bruto).trim() : bruto;
  try {
    return { ok: true, raw: JSON.parse(corpo) };
  } catch {
    return { ok: false, errors: [{ campo: 'proposta', problema: 'não é um objeto JSON válido' }] };
  }
}

/** Devolve os erros ao gerador numa nova tentativa, como o validador os juntou. */
function mensagemDeCorrecao(errors: ProposalError[]): ProposalMessage {
  const lista = errors.map((e) => `- ${e.campo}: ${e.problema}`).join('\n');
  return {
    role: 'user',
    content:
      'A proposta anterior foi recusada pela validação. Corrija todos os pontos abaixo e envie SOMENTE o objeto JSON da proposta:\n'
      + lista,
  };
}

/** Chama o gerador contando a tentativa no tracker, se houver. */
async function chamarGerador(deps: ProposeDeps, mensagens: ProposalMessage[]): Promise<string> {
  if (!deps.tracker) return deps.generator(mensagens);
  deps.tracker.assertWithin();
  try {
    return await deps.generator(mensagens);
  } finally {
    // A tentativa conta mesmo se o modelo falhar: a chamada já foi assumida.
    deps.tracker.call();
  }
}

/** Evidências citam só candidatos coletados e têm texto: é a fonte obrigatória da oferta. */
function fontesObrigatoriasOk(proposta: OfferProposal, ctx: ProposalContext): boolean {
  return proposta.evidencias.length > 0
    && proposta.evidencias.every(
      (e) => ctx.candidateIds.has(e.candidateId) && e.oQueSustenta.trim().length > 0,
    );
}

/**
 * Gera a proposta, valida, consulta o parecer e grava a oferta como rascunho.
 * Proposta inválida nunca é gravada; parecer ausente não impede a oferta, mas também não a aprova.
 */
export async function proposeOffer(deps: ProposeDeps, input: ProposeInput): Promise<ProposeResult> {
  const maxTentativas = input.maxTentativas ?? 2;
  if (!Number.isInteger(maxTentativas) || maxTentativas < 1) {
    throw new Error(`maxTentativas inválido: esperava inteiro de pelo menos 1, recebi ${String(maxTentativas)}`);
  }
  if (input.candidateIds.length === 0) {
    throw new Error('proposeOffer precisa de pelo menos um candidateId');
  }

  const candidatos: RadarCandidate[] = [];
  for (const id of input.candidateIds) {
    const candidato = await deps.store.getCandidate(id);
    if (!candidato) throw new Error(`candidato ${id} não existe`);
    candidatos.push(candidato);
  }

  const ctx: ProposalContext = {
    candidateIds: new Set(candidatos.map((c) => c.id)),
    textosDosConcorrentes: candidatos.flatMap((c) => textosDoRaw(c.raw)),
  };

  const mensagens: ProposalMessage[] = buildProposalPrompt({
    nicho: input.nicho,
    candidatos: candidatos.map(entradaDoCandidato),
  });

  let validada: { proposal: OfferProposal; avisos: string[] } | null = null;
  let erros: ProposalError[] = [];

  for (let tentativa = 1; tentativa <= maxTentativas; tentativa++) {
    const resposta = await chamarGerador(deps, mensagens);
    const lida = lerProposta(resposta);
    if (!lida.ok) {
      erros = lida.errors;
    } else {
      const resultado = validateProposal(lida.raw, ctx);
      if (resultado.ok) {
        validada = { proposal: resultado.proposal, avisos: resultado.avisos };
        break;
      }
      erros = resultado.errors;
    }
    if (tentativa < maxTentativas) mensagens.push(mensagemDeCorrecao(erros));
  }

  // Sem proposta válida nada é gravado: os erros voltam para quem pediu, não viram oferta.
  if (!validada) return { status: 'invalida', errors: erros };

  // Nota ausente/parcial entra como dúvida própria, sem número inventado.
  const duvidas = [...new Set([
    ...validada.proposal.duvidas,
    ...duvidasDosCandidatos(candidatos),
  ])];
  const proposta: OfferProposal = { ...validada.proposal, duvidas };

  const advisorInput: AdvisorInput = {
    jobId: input.jobId,
    dominio: 'radar',
    fase: 'oferta-original',
    objetivo: `Criar uma oferta original no nicho "${input.nicho}" sem copiar concorrente e sem promessa de venda`,
    pergunta: getDecisionPoint('radar.oferta-original')?.pergunta
      ?? 'Qual é o argumento contra a oferta? O preço é hipótese e a promessa original tem fonte?',
    evidencias: evidenciasParaParecer(candidatos),
    proposta: JSON.stringify(proposta, null, 2),
  };

  const parecer = await deps.advisor.consult('radar.oferta-original', advisorInput);

  // O parecer é do DeepSeek, mesmo autor do gerador desta construção: decide ignora o autor.
  let recomendacao: Recomendacao | 'indisponivel' = 'indisponivel';
  if (parecer.status === 'ok' || parecer.status === 'cache') recomendacao = parecer.opinion.recomendacao;
  const pareceres: DivergenceParecer[] = [{ autor: 'deepseek', recomendacao }];

  const decisao = decide({
    // A validação da proposta é o teste observável desta fase.
    testes: 'passaram',
    fontesObrigatoriasOk: fontesObrigatoriasOk(proposta, ctx),
    // Aprovar a oferta é decisão do Joel, não de modelo.
    reservadoAoJoel: true,
    pareceres,
    autorDoTrabalho: 'deepseek',
  });

  const avisos = [...validada.avisos];
  if (parecer.status === 'ok' || parecer.status === 'cache') {
    avisos.push('parecer do DeepSeek é do mesmo autor da proposta e não conta como revisão independente; a decisão é do Joel');
  } else {
    avisos.push(`sem parecer independente (${parecer.status}); a oferta é rascunho e a decisão é do Joel`);
  }

  const sources = candidatos.map((c) => ({
    candidateId: c.id,
    advertiser: c.advertiser,
    adUrl: c.adUrl,
    landingUrl: c.landingUrl,
    nota: c.score
      ? {
          nota: c.score.nota,
          maximoPossivel: c.score.maximoPossivel,
          parcial: c.score.parcial,
          version: c.score.version,
        }
      : null,
  }));

  const principal = proposta.evidencias[0]?.candidateId ?? candidatos[0]!.id;
  const oferta = await deps.store.createOffer(
    principal,
    proposta as unknown as Record<string, unknown>,
    sources,
  );

  if ((parecer.status === 'ok' || parecer.status === 'cache') && parecer.opinion.contrapontos.length > 0) {
    const contrapontos = parecer.opinion.contrapontos
      .map((contraponto, i) => `${i + 1}. ${contraponto}`)
      .join('\n');
    await deps.store.addFeedback({
      offerNumber: oferta.number,
      offerVersion: oferta.version,
      kind: 'objecao',
      text: `Contrapontos do parecer:\n${contrapontos}`,
    });
  }

  return {
    status: 'criada',
    number: oferta.number,
    version: oferta.version,
    parecer,
    decisao,
    avisos,
  };
}
