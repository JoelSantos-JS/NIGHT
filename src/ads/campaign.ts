// Campanha na Meta a partir de uma oferta aprovada (M03, M04, M06 do plano mestre).
// Regra central: criar é diferente de gastar. O NIGHT só cria campanha, conjunto e anúncio PAUSADOS;
// ativar fica com o Joel no Gerenciador (a chave "editar status" fica desligada na Meta), e o orçamento
// só entra com o valor que o Joel aprovou na frase. Mexe com conta de anúncios: implementado pelo Claude.

import { createHash } from 'node:crypto';
import type { Memory } from '../core/interfaces.ts';
import { promessasProibidas, type OfferProposal } from '../radar/offer.ts';

export const DRAFT_VERSION = 'campanha/1';

export interface CreativeDraft {
  angulo: string;
  textoPrincipal: string;
  titulo: string;
  /** Imagem precisa já estar numa URL: o MCP da Meta não envia arquivo local (M05). */
  imagemUrl: string | null;
}

export interface CampaignDraft {
  version: typeof DRAFT_VERSION;
  offerNumber: number;
  offerVersion: number;
  /** Vai no nome da campanha: é por ele que uma retomada acha o que já foi criado. */
  tag: string;
  nome: string;
  objetivo: 'OUTCOME_SALES' | 'OUTCOME_TRAFFIC';
  publico: { pais: 'BR'; idadeMin: number; idadeMax: number; descricao: string };
  /** Sugestão para o Joel decidir; nunca aplicada sem a aprovação com valor. */
  orcamentoDiarioSugeridoBRL: number;
  destinoUrl: string | null;
  criativos: CreativeDraft[];
  pendencias: string[];
}

/** Teste com orçamento pequeno (PDF, "a ordem certa", passo 3): começa baixo de propósito. */
const ORCAMENTO_TESTE_BRL = 20;

const isHttps = (url: string | null): url is string => {
  if (!url) return false;
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
};

/** Primeira frase curta do ângulo, para o título do anúncio (a Meta corta títulos longos). */
function tituloDoAngulo(angulo: string): string {
  const frase = angulo.split(/[.!?:]/)[0]!.trim();
  return frase.length <= 40 ? frase : `${frase.slice(0, 39).trimEnd()}…`;
}

/**
 * Rascunho a partir da proposta aprovada (M03). Não chama a Meta: é o que o Joel lê antes de
 * mandar montar. As URLs (página e imagens) vêm de fora porque só o Joel sabe onde publicou.
 */
export function buildCampaignDraft(
  offer: OfferProposal,
  opts: {
    offerNumber: number;
    offerVersion: number;
    destinoUrl: string | null;
    imagens?: (string | null)[];
    /** Textos por ângulo de src/lowticket/creatives.ts (L04); sem eles, vale problema + promessa. */
    criativos?: { titulo: string; textoPrincipal: string }[];
  },
): CampaignDraft {
  const tag = createHash('sha256')
    .update(`${opts.offerNumber}:${opts.offerVersion}:${offer.nome}`)
    .digest('hex')
    .slice(0, 8);
  const textoPadrao = `${offer.problema.trim()} ${offer.promessa.trim()}`.trim();
  const criativos = offer.angulosCriativo.map((angulo, i) => {
    const proprio = opts.criativos?.[i];
    return {
      angulo,
      textoPrincipal: proprio?.textoPrincipal ?? textoPadrao,
      titulo: proprio?.titulo ?? tituloDoAngulo(angulo),
      imagemUrl: opts.imagens?.[i] ?? null,
    };
  });
  const draft: CampaignDraft = {
    version: DRAFT_VERSION,
    offerNumber: opts.offerNumber,
    offerVersion: opts.offerVersion,
    tag,
    nome: `NIGHT ${tag} · ${offer.nome}`.slice(0, 120),
    objetivo: 'OUTCOME_SALES',
    publico: { pais: 'BR', idadeMin: 18, idadeMax: 65, descricao: offer.publico },
    orcamentoDiarioSugeridoBRL: ORCAMENTO_TESTE_BRL,
    destinoUrl: opts.destinoUrl,
    criativos,
    pendencias: [],
  };
  draft.pendencias = draftPendencias(draft);
  return draft;
}

/** O que impede montar na Meta. Lista vazia = pode pedir a aprovação. */
export function draftPendencias(draft: CampaignDraft): string[] {
  const p: string[] = [];
  if (!isHttps(draft.destinoUrl)) p.push('falta a URL https da página de vendas');
  const comImagem = draft.criativos.filter((c) => isHttps(c.imagemUrl));
  if (comImagem.length === 0) p.push('nenhum criativo tem imagem em URL https (gere no Flow e publique a imagem)');
  for (const [i, c] of draft.criativos.entries()) {
    if (c.imagemUrl !== null && !isHttps(c.imagemUrl)) p.push(`criativo ${i + 1}: imagem precisa ser URL https`);
    const proibidas = promessasProibidas(`${c.titulo} ${c.textoPrincipal}`);
    if (proibidas.length) p.push(`criativo ${i + 1}: promessa proibida (${proibidas.join(', ')})`);
  }
  return p;
}

/** Texto curto para voz e completo para tela. */
export function describeDraft(draft: CampaignDraft): { voz: string; tela: string } {
  const prontos = draft.criativos.filter((c) => isHttps(c.imagemUrl)).length;
  const voz = draft.pendencias.length
    ? `Rascunho da campanha da oferta ${draft.offerNumber}: ${draft.pendencias.length} pendência(s), a primeira é: ${draft.pendencias[0]}.`
    : `Rascunho da campanha da oferta ${draft.offerNumber} pronto: ${prontos} criativo(s), orçamento sugerido de R$ ${draft.orcamentoDiarioSugeridoBRL} por dia. Para montar pausada, diga "aprovo montar a campanha da oferta ${draft.offerNumber} com R$ ${draft.orcamentoDiarioSugeridoBRL} por dia".`;
  const tela = [
    `Campanha: ${draft.nome}`,
    `Objetivo: ${draft.objetivo} · Público: ${draft.publico.pais}, ${draft.publico.idadeMin}-${draft.publico.idadeMax}, ${draft.publico.descricao}`,
    `Destino: ${draft.destinoUrl ?? '(falta)'}`,
    `Orçamento sugerido: R$ ${draft.orcamentoDiarioSugeridoBRL}/dia (só vale o valor que você aprovar)`,
    ...draft.criativos.map((c, i) => `Criativo ${i + 1}: "${c.titulo}" — ${c.imagemUrl ?? '(sem imagem)'}`),
    ...(draft.pendencias.length ? ['Pendências:', ...draft.pendencias.map((x) => `- ${x}`)] : []),
    'Tudo é criado PAUSADO. Ativar é com você, no Gerenciador de Anúncios.',
  ].join('\n');
  return { voz, tela };
}

// ---------- Criação pausada (M04) ----------

/**
 * O que o NIGHT pede ao MCP da Meta. A implementação real roda uma sessão do Claude Code só com as
 * ferramentas de criação e leitura; nos testes é falsa. Nenhum método ativa nada.
 */
export interface MetaAdsWriter {
  /** Procura campanha pelo nome exato (a tag no nome torna a busca única). */
  findCampaignByName(adAccountId: string, nome: string): Promise<{ id: string; status: string } | null>;
  createCampaign(input: { adAccountId: string; nome: string; objetivo: string; status: 'PAUSED' }): Promise<{ id: string }>;
  createAdSet(input: {
    adAccountId: string; campaignId: string; nome: string; orcamentoDiarioCentavos: number;
    publico: CampaignDraft['publico']; status: 'PAUSED';
  }): Promise<{ id: string }>;
  createAd(input: {
    adAccountId: string; adSetId: string; nome: string; criativo: CreativeDraft; destinoUrl: string; status: 'PAUSED';
  }): Promise<{ id: string }>;
  /** Leitura de volta: o NIGHT confere o status em vez de confiar na resposta da criação. */
  getStatus(id: string): Promise<string>;
}

/** Aprovação do Joel com o valor dito na frase ("aprovo montar a campanha da oferta 2 com R$ 20 por dia"). */
export interface BuildApproval {
  offerNumber: number;
  orcamentoDiarioBRL: number;
  /** Frase original, guardada no evento para auditoria. */
  frase: string;
}

/** Teto absoluto por dia num teste: acima disso o NIGHT recusa mesmo com aprovação (proteção contra "R$ 2000" mal ouvido). */
export const ORCAMENTO_DIARIO_MAXIMO_BRL = 200;

export type BuildResult =
  | { status: 'criada'; campaignId: string; adSetId: string; adIds: string[]; reaproveitada: boolean }
  | { status: 'recusada'; motivo: string }
  | { status: 'parada'; motivo: string; criados: Record<string, string> };

const EFFECT = {
  campaign: 'meta:campaign',
  adSet: 'meta:adset',
  ad: (i: number) => `meta:ad:${i}`,
  start: 'meta:build-started',
};

async function effectValue(memory: Memory, jobId: string, key: string): Promise<string | null> {
  const ev = (await memory.listJobEvents(jobId)).find((e) => e.effectKey === key);
  if (!ev) return null;
  const m = /id=(\S+)/.exec(ev.message);
  return m ? m[1]! : '';
}

/**
 * Cria campanha, conjunto e anúncios PAUSADOS, um passo por vez (M06: sem rajada e sem repetir em erro).
 * Cada criação vira efeito externo com chave única: retomar nunca cria duas vezes. Qualquer erro PARA
 * e devolve o que já existe; não há laço de tentativas.
 */
export async function buildPausedCampaign(deps: {
  memory: Memory;
  writer: MetaAdsWriter;
  adAccountId: string;
  /** Pausa entre chamadas que mudam algo (M06). */
  pausaMs?: number;
  sleep?: (ms: number) => Promise<void>;
}, input: { jobId: string; draft: CampaignDraft; approval: BuildApproval }): Promise<BuildResult> {
  const { memory, writer, adAccountId } = deps;
  const { jobId, draft, approval } = input;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pausa = deps.pausaMs ?? 2000;

  if (approval.offerNumber !== draft.offerNumber) {
    return { status: 'recusada', motivo: `a aprovação é da oferta ${approval.offerNumber}, o rascunho é da oferta ${draft.offerNumber}` };
  }
  const orcamento = approval.orcamentoDiarioBRL;
  if (!Number.isFinite(orcamento) || orcamento <= 0) return { status: 'recusada', motivo: 'a aprovação não tem um valor de orçamento válido' };
  if (orcamento > ORCAMENTO_DIARIO_MAXIMO_BRL) {
    return { status: 'recusada', motivo: `R$ ${orcamento} por dia passa do teto de teste (R$ ${ORCAMENTO_DIARIO_MAXIMO_BRL}); confirme no Gerenciador se for isso mesmo` };
  }
  const pendencias = draftPendencias(draft);
  if (pendencias.length) return { status: 'recusada', motivo: `rascunho com pendências: ${pendencias.join('; ')}` };

  const criados: Record<string, string> = {};
  try {
    // A aprovação fica registrada antes de qualquer chamada à Meta.
    await memory.recordJobEffect(jobId, EFFECT.start, 'owner',
      `aprovação: "${approval.frase}" · orçamento R$ ${orcamento}/dia · tudo pausado`);

    // Campanha: efeito já registrado, ou procura pelo nome (cobre queda entre criar e registrar).
    let campaignId = await effectValue(memory, jobId, EFFECT.campaign);
    let reaproveitada = Boolean(campaignId);
    if (!campaignId) {
      const existente = await writer.findCampaignByName(adAccountId, draft.nome);
      if (existente) {
        campaignId = existente.id;
        reaproveitada = true;
      } else {
        campaignId = (await writer.createCampaign({ adAccountId, nome: draft.nome, objetivo: draft.objetivo, status: 'PAUSED' })).id;
        await sleep(pausa);
      }
      await memory.recordJobEffect(jobId, EFFECT.campaign, 'meta', `campanha id=${campaignId}`);
    }
    criados.campanha = campaignId;

    let adSetId = await effectValue(memory, jobId, EFFECT.adSet);
    if (!adSetId) {
      adSetId = (await writer.createAdSet({
        adAccountId, campaignId, nome: `${draft.nome} · conjunto`,
        orcamentoDiarioCentavos: Math.round(orcamento * 100), publico: draft.publico, status: 'PAUSED',
      })).id;
      await memory.recordJobEffect(jobId, EFFECT.adSet, 'meta', `conjunto id=${adSetId}`);
      await sleep(pausa);
    }
    criados.conjunto = adSetId;

    const adIds: string[] = [];
    for (const [i, criativo] of draft.criativos.entries()) {
      if (!isHttps(criativo.imagemUrl)) continue; // sem imagem publicada não vira anúncio
      let adId = await effectValue(memory, jobId, EFFECT.ad(i));
      if (!adId) {
        adId = (await writer.createAd({
          adAccountId, adSetId, nome: `${draft.nome} · ${i + 1}`, criativo, destinoUrl: draft.destinoUrl!, status: 'PAUSED',
        })).id;
        await memory.recordJobEffect(jobId, EFFECT.ad(i), 'meta', `anúncio id=${adId}`);
        await sleep(pausa);
      }
      adIds.push(adId);
      criados[`anuncio${i + 1}`] = adId;
    }

    // Leitura de volta: tudo tem que estar pausado. Se não estiver, para e avisa (o NIGHT não pode
    // pausar sozinho, porque a chave de status fica desligada de propósito).
    for (const [nome, id] of Object.entries(criados)) {
      const status = await writer.getStatus(id);
      if (status !== 'PAUSED') {
        return { status: 'parada', motivo: `ATENÇÃO: ${nome} ${id} está ${status}, não pausado. Pause agora no Gerenciador de Anúncios.`, criados };
      }
    }
    return { status: 'criada', campaignId, adSetId, adIds, reaproveitada };
  } catch (err) {
    // Sem repetição automática (M06): erro da Meta vai direto ao Joel com o que já existe.
    await memory.addJobEvent(jobId, { eventType: 'error', source: 'meta', message: `montagem parada: ${(err as Error).message.slice(0, 300)}` });
    return { status: 'parada', motivo: (err as Error).message.slice(0, 300), criados };
  }
}

/** Valor em reais da frase do Joel: "com R$ 20 por dia", "com 35 reais por dia", "R$ 12,50/dia". */
export function parseDailyBudget(frase: string): number | null {
  const m = /(?:r\$\s*)?(\d{1,5}(?:[.,]\d{1,2})?)\s*(?:reais)?\s*(?:por dia|\/\s*dia|ao dia|diários?|por dia)/i.exec(frase)
    ?? /r\$\s*(\d{1,5}(?:[.,]\d{1,2})?)/i.exec(frase);
  if (!m) return null;
  const v = Number(m[1]!.replace(',', '.'));
  return Number.isFinite(v) && v > 0 ? v : null;
}
