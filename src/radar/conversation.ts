// Conversa com o Joel sobre uma oferta do Radar (R06): contexto citável, correção versionada e decisão.
// Regras que valem aqui:
// - texto de anúncio/landing é fonte externa e entra em <<<DADOS>>>: é dado, nunca instrução;
// - corrigir cria versão nova (a antiga continua intacta) e só grava se validateProposal aceitar;
// - aprovar congela a versão como briefing; não autoriza campanha, compra nem gasto.
// Nada aqui chama modelo: montar contexto e gravar decisão são operações de banco.

import type { OfferEditField } from '../core/interfaces.ts';
import { validateProposal, type ProposalContext, type ProposalError } from './offer.ts';
import type {
  NewFeedback, RadarCandidate, RadarFeedback, RadarOffer,
} from './store.ts';

/** O que a conversa precisa do banco; PgRadarStore satisfaz sem acoplar o coordenador à implementação. */
export interface RadarConversationStore {
  getOffer(number: number, version?: number): Promise<RadarOffer | null>;
  listOfferVersions(number: number): Promise<RadarOffer[]>;
  listFeedback(offerNumber: number): Promise<RadarFeedback[]>;
  getCandidate(id: string): Promise<RadarCandidate | null>;
  reviseOffer(number: number, proposal: Record<string, unknown>, sources?: unknown[]): Promise<RadarOffer>;
  setOfferStatus(number: number, version: number, status: 'rascunho' | 'discutindo' | 'aprovada' | 'rejeitada'): Promise<void>;
  addFeedback(feedback: NewFeedback): Promise<RadarFeedback>;
}

export interface OfferContextOptions {
  /** Teto do contexto; o corte tira as seções do fim (menos importantes) e nunca parte uma fonte. */
  maxChars?: number;
}

export type OfferEdit = { campo: OfferEditField; valor: string };

export type OfferEditResult =
  | { ok: true; offer: RadarOffer; previousVersion: number }
  | { ok: false; errors: ProposalError[] };

export type OfferDecisionResult =
  | { ok: true; offer: RadarOffer; text: string }
  | { ok: false; reason: 'not-found' };

type Proposta = Record<string, unknown>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const texto = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

function listaDeTexto(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => texto(item)).filter((item): item is string => item !== null)
    : [];
}

/** Desarma cercas de bloco para o dado externo não escapar do bloco de dados. */
function dadoSeguro(conteudo: string): string {
  return conteudo.replaceAll('<<<', '< < <').replaceAll('>>>', '> > >');
}

function evidencias(proposta: unknown): { candidateId: string; oQueSustenta: string }[] {
  if (!isRecord(proposta) || !Array.isArray(proposta.evidencias)) return [];
  return proposta.evidencias.flatMap((item) => {
    if (!isRecord(item)) return [];
    const candidateId = texto(item.candidateId);
    const oQueSustenta = texto(item.oQueSustenta);
    return candidateId && oQueSustenta ? [{ candidateId, oQueSustenta }] : [];
  });
}

/** Preço brasileiro para número: "R$ 47" → 47, "47,90" → 47.9, "1.234,56" → 1234.56. */
export function parsePriceToNumber(raw: string): number | null {
  let valor = raw.replace(/r\$/gi, '').replace(/\s+/g, '');
  if (!valor) return null;
  if (valor.includes(',') && valor.includes('.')) {
    valor = valor.replace(/\./g, '').replace(',', '.');
  } else if (valor.includes(',')) {
    valor = valor.replace(',', '.');
  } else if (/^\d{1,3}(\.\d{3})+$/.test(valor)) {
    // Só pontos em grupos de três: é separador de milhar ("1.234"), não decimal.
    valor = valor.replace(/\./g, '');
  }
  const numero = Number(valor);
  return Number.isFinite(numero) && numero > 0 ? Math.round(numero * 100) / 100 : null;
}

const precoBr = (valor: number): string =>
  `R$${Number.isInteger(valor) ? String(valor) : valor.toFixed(2).replace('.', ',')}`;

/** Bloco de dados com o que veio da fonte externa; só entra o que existe, sem completar com palpite. */
async function blocoDaFonte(store: RadarConversationStore, candidateId: string): Promise<string | null> {
  const candidato = await store.getCandidate(candidateId);
  if (!candidato) return null;
  const raw = isRecord(candidato.raw) ? candidato.raw : {};
  const anuncio = texto(raw.anuncioTexto) ?? texto(raw.adText) ?? texto(raw.anuncio) ?? texto(raw.texto);
  const landing = texto(raw.landingResumo) ?? texto(raw.landingText) ?? texto(raw.landing);
  const linhas = [
    `anunciante: ${candidato.advertiser ?? 'não informado'}`,
    ...(candidato.country ? [`país: ${candidato.country}`] : []),
    ...(candidato.startedAt ? [`início do anúncio: ${candidato.startedAt}`] : []),
    ...(candidato.adUrl ? [`anúncio: ${candidato.adUrl}`] : []),
    ...(candidato.landingUrl ? [`destino: ${candidato.landingUrl}`] : []),
    ...(anuncio ? [`texto do anúncio: ${anuncio}`] : []),
    ...(landing ? [`resumo da landing: ${landing}`] : []),
    ...(candidato.unknownFields.length ? [`campos que a fonte não mostrou: ${candidato.unknownFields.join(', ')}`] : []),
  ];
  return `<<<DADOS id=${dadoSeguro(candidateId)}>>>\n${dadoSeguro(linhas.join('\n'))}\n<<<FIM DADOS>>>`;
}

function resumoDaProposta(proposta: Proposta): string[] {
  const linhas = ['Proposta:'];
  const campos: [string, unknown][] = [
    ['nome', proposta.nome],
    ['posicionamento', proposta.posicionamento],
    ['público', proposta.publico],
    ['problema', proposta.problema],
    ['promessa', proposta.promessa],
    ['diferencial', proposta.diferencial],
  ];
  for (const [rotulo, valor] of campos) {
    const t = texto(valor);
    if (t) linhas.push(`- ${rotulo}: ${t}`);
  }
  const preco = isRecord(proposta.precoHipotese) ? proposta.precoHipotese : null;
  if (preco && typeof preco.valor === 'number' && preco.valor > 0) {
    const justificativa = texto(preco.justificativa);
    linhas.push(`- preço (hipótese, não aprovado): ${precoBr(preco.valor)}${justificativa ? ` — ${justificativa}` : ''}`);
  }
  const entregaveis = Array.isArray(proposta.entregaveis) ? proposta.entregaveis.length : 0;
  if (entregaveis > 0) linhas.push(`- entregáveis: ${entregaveis}`);
  return linhas;
}

/**
 * Texto para o modelo responder perguntas sobre a oferta pelo número. As seções vão da mais para a
 * menos importante; se passar do teto, as últimas saem inteiras (uma fonte nunca é cortada no meio).
 */
export async function buildOfferContext(
  store: RadarConversationStore, number: number, opts: OfferContextOptions = {},
): Promise<string> {
  const maxChars = opts.maxChars ?? 6000;
  const offer = await store.getOffer(number);
  if (!offer) throw new Error(`oferta ${number} não existe`);
  const [versoes, feedbacks] = await Promise.all([
    store.listOfferVersions(number),
    store.listFeedback(number),
  ]);
  const proposta = isRecord(offer.proposal) ? offer.proposal : {};
  const fontes = evidencias(proposta);
  const candidateId = offer.candidateId ?? fontes[0]?.candidateId ?? null;
  const candidato = candidateId ? await store.getCandidate(candidateId) : null;

  const partes: string[] = [];

  partes.push(`Oferta ${number}: versão atual ${offer.version} de ${versoes.length} versão(ões); status ${offer.status}.`);
  partes.push(resumoDaProposta(proposta).join('\n'));

  const nota = candidato?.score;
  partes.push(nota
    ? `Nota de triagem: ${nota.nota}${nota.parcial ? ` (parcial, máximo ${nota.maximoPossivel})` : ''}. Justificativa: ${nota.justificativa}`
    : 'Nota de triagem: não disponível; não invente nota.');

  if (fontes.length > 0) {
    for (const [i, fonte] of fontes.entries()) {
      const linhas: string[] = [];
      if (i === 0) linhas.push('Fontes:');
      linhas.push(`- ${fonte.candidateId}: ${fonte.oQueSustenta}`);
      const bloco = await blocoDaFonte(store, fonte.candidateId);
      if (bloco) linhas.push(bloco);
      partes.push(linhas.join('\n'));
    }
  } else {
    partes.push('Fontes: nenhuma registrada na proposta.');
  }

  const duvidas = listaDeTexto(proposta.duvidas);
  partes.push(duvidas.length
    ? `Dúvidas:\n${duvidas.map((d) => `- ${d}`).join('\n')}`
    : 'Dúvidas: nenhuma registrada.');

  partes.push(`Motivo para descartar: ${texto(proposta.motivoParaDescartar) ?? 'não registrado'}`);

  const ultimos = feedbacks.slice(-5);
  partes.push(ultimos.length
    ? `Últimos feedbacks do Joel:\n${ultimos.map((f) => `- v${f.offerVersion} ${f.kind}: ${f.text}`).join('\n')}`
    : 'Últimos feedbacks do Joel: nenhum.');

  const saida: string[] = [];
  for (const parte of partes) {
    if (saida.length > 0 && [...saida, parte].join('\n\n').length > maxChars) break;
    saida.push(parte);
  }
  const resultado = saida.join('\n\n');
  // Só corta texto próprio (cabeçalho/proposta); um bloco <<<DADOS>>> nunca chega aqui pela metade.
  return resultado.length > maxChars ? resultado.slice(0, maxChars).trimEnd() : resultado;
}

/** Contexto de validação da proposta: candidatos citados e textos externos para a checagem de cópia. */
export async function buildProposalContext(
  store: RadarConversationStore, offer: RadarOffer,
): Promise<ProposalContext> {
  const ids = new Set<string>();
  const textos: string[] = [];
  const citados = new Set(evidencias(offer.proposal).map((e) => e.candidateId));
  if (offer.candidateId) citados.add(offer.candidateId);
  for (const id of citados) {
    ids.add(id);
    const candidato = await store.getCandidate(id);
    if (!candidato) continue;
    const raw = isRecord(candidato.raw) ? candidato.raw : {};
    for (const campo of ['anuncioTexto', 'adText', 'anuncio', 'texto', 'landingResumo', 'landingText', 'landing']) {
      const t = texto(raw[campo]);
      if (t) textos.push(t);
    }
  }
  return { candidateIds: ids, textosDosConcorrentes: textos };
}

/**
 * Corrige um campo criando versão nova. Proposta inválida não é gravada: devolve os erros para o Joel.
 * Preço entra sempre como hipótese (ehHipotese: true), nunca como preço aprovado.
 */
export async function applyOfferEdit(
  store: RadarConversationStore, number: number, edit: OfferEdit, ctx: ProposalContext,
): Promise<OfferEditResult> {
  const atual = await store.getOffer(number);
  if (!atual) return { ok: false, errors: [{ campo: 'oferta', problema: `oferta ${number} não existe` }] };
  const proposta = isRecord(atual.proposal) ? atual.proposal : {};
  let nova: Proposta;
  if (edit.campo === 'precoHipotese') {
    const valor = parsePriceToNumber(edit.valor);
    if (valor === null) {
      return {
        ok: false,
        errors: [{ campo: 'precoHipotese', problema: 'não entendi o preço; use, por exemplo, "R$ 47" ou "47,90"' }],
      };
    }
    const precoAtual = isRecord(proposta.precoHipotese) ? proposta.precoHipotese : {};
    nova = {
      ...proposta,
      precoHipotese: {
        ...precoAtual,
        valor,
        moeda: 'BRL',
        justificativa: texto(precoAtual.justificativa) ?? 'Preço definido pelo Joel como hipótese',
        ehHipotese: true,
      },
    };
  } else {
    nova = { ...proposta, [edit.campo]: edit.valor.trim() };
  }

  const validada = validateProposal(nova, ctx);
  if (!validada.ok) return { ok: false, errors: validada.errors };

  const revisada = await store.reviseOffer(
    number, validada.proposal as unknown as Record<string, unknown>, atual.sources,
  );
  await store.addFeedback({
    offerNumber: number,
    offerVersion: atual.version,
    kind: 'correcao',
    text: `Correção em ${edit.campo}: ${edit.valor}`,
    resultingVersion: revisada.version,
  });
  return { ok: true, offer: revisada, previousVersion: atual.version };
}

/** Aprova a versão atual e congela como briefing; não é campanha, compra nem gasto. */
export async function approveOffer(store: RadarConversationStore, number: number): Promise<OfferDecisionResult> {
  const atual = await store.getOffer(number);
  if (!atual) return { ok: false, reason: 'not-found' };
  await store.setOfferStatus(number, atual.version, 'aprovada');
  await store.addFeedback({
    offerNumber: number,
    offerVersion: atual.version,
    kind: 'aprovacao',
    text: 'Joel aprovou esta versão como briefing; não autoriza campanha, compra nem gasto.',
  });
  return {
    ok: true,
    offer: { ...atual, status: 'aprovada' },
    text: `Oferta ${number} versão ${atual.version} aprovada como briefing. Isso não autoriza campanha, compra nem gasto.`,
  };
}

/** Rejeita a versão atual; nada é publicado nem gasto. */
export async function rejectOffer(store: RadarConversationStore, number: number): Promise<OfferDecisionResult> {
  const atual = await store.getOffer(number);
  if (!atual) return { ok: false, reason: 'not-found' };
  await store.setOfferStatus(number, atual.version, 'rejeitada');
  await store.addFeedback({
    offerNumber: number,
    offerVersion: atual.version,
    kind: 'rejeicao',
    text: 'Joel rejeitou esta versão; nada foi publicado nem gasto.',
  });
  return {
    ok: true,
    offer: { ...atual, status: 'rejeitada' },
    text: `Oferta ${number} versão ${atual.version} rejeitada. Nada foi publicado nem gasto.`,
  };
}