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
  tipo: 'imagem' | 'video';
  /** Imagem do anúncio, ou miniatura do vídeo. Precisa já estar numa URL: o MCP da Meta não envia arquivo local (M05). */
  imagemUrl: string | null;
  videoUrl: string | null;
}

/**
 * Regras do teste de criativo de cada oferta (o Joel define; ficam em offer_links.campanha).
 * Estrutura que vale com pouco dinheiro: uma campanha por par vídeo + imagem, orçamento na campanha,
 * otimização para compra no pixel, público e posicionamentos fixos, nada automático da Meta.
 */
export interface CampaignSettings {
  pixelId: string | null;
  /** Página do Facebook que assina o anúncio; no Instagram vale a conta ligada a ela. */
  paginaFacebookId: string | null;
  generos: 'todos' | 'mulheres' | 'homens';
  idadeMin: number;
  idadeMax: number;
  /** Início marcado, ISO com fuso (2026-11-25T00:00:00-03:00). Null: começa quando o Joel ativar. */
  inicio: string | null;
  /** Vídeos já publicados em https, cada um com a miniatura em https. */
  videos: { url: string; miniatura: string }[];
  /**
   * 'uma-campanha': uma campanha (orçamento inteiro nela) com um conjunto por teste — como a COREANO1 do Joel.
   * 'campanha-por-teste': uma campanha por teste, orçamento dividido igual — como no vídeo de referência.
   */
  estrutura: 'uma-campanha' | 'campanha-por-teste';
  /** 'stories-reels' (Stories e Reels do Facebook e do Instagram, como a COREANO1) ou 'feed-reels'. */
  posicionamentos: keyof typeof POSICIONAMENTOS_OPCOES;
}

export const SETTINGS_PADRAO: CampaignSettings = {
  pixelId: null, paginaFacebookId: null, generos: 'todos', idadeMin: 18, idadeMax: 65, inicio: null, videos: [],
  estrutura: 'uma-campanha', posicionamentos: 'stories-reels',
};

/** Lê as regras gravadas (jsonb livre) campo a campo; o que vier no formato errado volta ao padrão. */
export function settingsValidas(raw: Partial<CampaignSettings> | null | undefined): CampaignSettings {
  const r = (raw ?? {}) as Record<string, unknown>;
  const texto = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const inteiro = (v: unknown, padrao: number) => (typeof v === 'number' && Number.isInteger(v) ? v : padrao);
  const videos = Array.isArray(r.videos)
    ? r.videos.flatMap((v) => {
      const o = (v ?? {}) as Record<string, unknown>;
      return typeof o.url === 'string' && typeof o.miniatura === 'string' ? [{ url: o.url, miniatura: o.miniatura }] : [];
    })
    : [];
  return {
    pixelId: texto(r.pixelId),
    paginaFacebookId: texto(r.paginaFacebookId),
    generos: r.generos === 'mulheres' || r.generos === 'homens' ? r.generos : 'todos',
    idadeMin: inteiro(r.idadeMin, SETTINGS_PADRAO.idadeMin),
    idadeMax: inteiro(r.idadeMax, SETTINGS_PADRAO.idadeMax),
    inicio: texto(r.inicio),
    videos,
    estrutura: r.estrutura === 'campanha-por-teste' ? 'campanha-por-teste' : 'uma-campanha',
    posicionamentos: r.posicionamentos === 'feed-reels' ? 'feed-reels' : 'stories-reels',
  };
}

/** Posicionamentos manuais: só onde costuma vender com pouco orçamento. */
export const POSICIONAMENTOS_OPCOES = {
  'feed-reels': { facebook: ['feed'], instagram: ['stream', 'reels'] },
  'stories-reels': { facebook: ['story', 'facebook_reels'], instagram: ['story', 'reels'] },
} as const;
export type Posicionamentos = { facebook: readonly string[]; instagram: readonly string[] };
/** Padrão quando o pedido não diz (feed + Reels). */
export const POSICIONAMENTOS: Posicionamentos = POSICIONAMENTOS_OPCOES['feed-reels'];

/** UTMs padrão: a venda na Cakto mostra de qual campanha, conjunto e anúncio veio. */
export const UTM_PADRAO =
  'utm_source=FB&utm_campaign={{campaign.name}}|{{campaign.id}}&utm_medium={{adset.name}}|{{adset.id}}&utm_content={{ad.name}}|{{ad.id}}&utm_term={{placement}}';

export interface CampaignDraft {
  version: typeof DRAFT_VERSION;
  offerNumber: number;
  offerVersion: number;
  /** Vai no nome da campanha: é por ele que uma retomada acha o que já foi criado. */
  tag: string;
  nome: string;
  objetivo: 'OUTCOME_SALES' | 'OUTCOME_TRAFFIC';
  publico: { pais: 'BR'; idadeMin: number; idadeMax: number; generos: CampaignSettings['generos']; descricao: string };
  pixelId: string | null;
  paginaFacebookId: string | null;
  inicio: string | null;
  estrutura: CampaignSettings['estrutura'];
  posicionamentos: CampaignSettings['posicionamentos'];
  /** Sugestão para o Joel decidir; nunca aplicada sem a aprovação com valor. */
  orcamentoDiarioSugeridoBRL: number;
  destinoUrl: string | null;
  criativos: CreativeDraft[];
  /** Índices dos criativos com mídia, dois por campanha (vídeo + imagem): cada grupo é um teste. */
  testes: number[][];
  pendencias: string[];
}

/** Teste com orçamento pequeno: R$ 15 por campanha de teste (dois criativos cada). */
const ORCAMENTO_POR_TESTE_BRL = 15;
const CRIATIVOS_POR_TESTE = 2;

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
    /** Regras do teste (pixel, página, público, início, vídeos); o que faltar vem do padrão. */
    config?: Partial<CampaignSettings>;
  },
): CampaignDraft {
  const tag = createHash('sha256')
    .update(`${opts.offerNumber}:${opts.offerVersion}:${offer.nome}`)
    .digest('hex')
    .slice(0, 8);
  const textoPadrao = `${offer.problema.trim()} ${offer.promessa.trim()}`.trim();
  const cfg = settingsValidas(opts.config);
  const imagens = (opts.imagens ?? []).filter((u): u is string => u !== null);
  // Mídias na ordem dos testes: vídeo k e imagem k ficam lado a lado, cada par vira uma campanha.
  const midias: Pick<CreativeDraft, 'tipo' | 'imagemUrl' | 'videoUrl'>[] = [];
  for (let k = 0; k < Math.max(cfg.videos.length, imagens.length); k++) {
    const v = cfg.videos[k];
    if (v) midias.push({ tipo: 'video', imagemUrl: v.miniatura, videoUrl: v.url });
    if (imagens[k]) midias.push({ tipo: 'imagem', imagemUrl: imagens[k]!, videoUrl: null });
  }
  const criativos: CreativeDraft[] = offer.angulosCriativo.map((angulo, i) => {
    const proprio = opts.criativos?.[i];
    return {
      angulo,
      textoPrincipal: proprio?.textoPrincipal ?? textoPadrao,
      titulo: proprio?.titulo ?? tituloDoAngulo(angulo),
      tipo: midias[i]?.tipo ?? 'imagem',
      imagemUrl: midias[i]?.imagemUrl ?? null,
      videoUrl: midias[i]?.videoUrl ?? null,
    };
  });
  const comMidia = criativos.flatMap((c, i) => (isHttps(c.imagemUrl) ? [i] : []));
  const testes: number[][] = [];
  for (let i = 0; i < comMidia.length; i += CRIATIVOS_POR_TESTE) testes.push(comMidia.slice(i, i + CRIATIVOS_POR_TESTE));
  const draft: CampaignDraft = {
    version: DRAFT_VERSION,
    offerNumber: opts.offerNumber,
    offerVersion: opts.offerVersion,
    tag,
    nome: `NIGHT ${tag} · ${offer.nome}`.slice(0, 120),
    objetivo: 'OUTCOME_SALES',
    publico: { pais: 'BR', idadeMin: cfg.idadeMin, idadeMax: cfg.idadeMax, generos: cfg.generos, descricao: offer.publico },
    pixelId: cfg.pixelId,
    paginaFacebookId: cfg.paginaFacebookId,
    inicio: cfg.inicio,
    estrutura: cfg.estrutura,
    posicionamentos: cfg.posicionamentos,
    // Uma campanha: R$ 15 no total, a Meta escolhe o conjunto; uma por teste: R$ 15 em cada.
    orcamentoDiarioSugeridoBRL: cfg.estrutura === 'uma-campanha' ? ORCAMENTO_POR_TESTE_BRL : ORCAMENTO_POR_TESTE_BRL * Math.max(1, testes.length),
    destinoUrl: opts.destinoUrl,
    criativos,
    testes,
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
  if (draft.objetivo === 'OUTCOME_SALES' && !/^\d{6,20}$/.test(draft.pixelId ?? '')) {
    p.push('falta o pixel da Meta da oferta (otimização para compra)');
  }
  if (!/^\d{6,20}$/.test(draft.paginaFacebookId ?? '')) p.push('falta o id da página do Facebook que assina o anúncio');
  if (draft.inicio !== null && Number.isNaN(Date.parse(draft.inicio))) p.push('a data de início não é válida');
  if (draft.publico.idadeMin < 18 || draft.publico.idadeMax > 65 || draft.publico.idadeMin > draft.publico.idadeMax) {
    p.push('a faixa de idade precisa ficar entre 18 e 65');
  }
  for (const [i, c] of draft.criativos.entries()) {
    if (c.imagemUrl !== null && !isHttps(c.imagemUrl)) p.push(`criativo ${i + 1}: imagem precisa ser URL https`);
    if (c.tipo === 'video' && !isHttps(c.videoUrl)) p.push(`criativo ${i + 1}: vídeo precisa ser URL https`);
    const proibidas = promessasProibidas(`${c.titulo} ${c.textoPrincipal}`);
    if (proibidas.length) p.push(`criativo ${i + 1}: promessa proibida (${proibidas.join(', ')})`);
  }
  return p;
}

/** Texto curto para voz e completo para tela. */
export function describeDraft(draft: CampaignDraft): { voz: string; tela: string } {
  const prontos = draft.testes.flat().length;
  const genero = { todos: 'todos', mulheres: 'só mulheres', homens: 'só homens' }[draft.publico.generos];
  const voz = draft.pendencias.length
    ? `Rascunho da campanha da oferta ${draft.offerNumber}: ${draft.pendencias.length} pendência(s), a primeira é: ${draft.pendencias[0]}.`
    : `Rascunho da campanha da oferta ${draft.offerNumber} pronto: ${draft.testes.length} teste(s) com ${prontos} criativo(s), orçamento sugerido de R$ ${draft.orcamentoDiarioSugeridoBRL} por dia no total. Para montar pausada, diga "aprovo montar a campanha da oferta ${draft.offerNumber} com R$ ${draft.orcamentoDiarioSugeridoBRL} por dia".`;
  const tela = [
    `Campanha: ${draft.nome}`,
    `Objetivo: ${draft.objetivo}, otimizado para compra no pixel ${draft.pixelId ?? '(falta)'} · Público: ${draft.publico.pais}, ${draft.publico.idadeMin}-${draft.publico.idadeMax}, ${genero}, sem público Advantage+ · ${draft.publico.descricao}`,
    `Posicionamentos: ${draft.posicionamentos === 'stories-reels' ? 'Stories e Reels do Facebook e do Instagram' : 'feed do Facebook, feed do Instagram e Reels'} · melhorias automáticas e anúncios de vários anunciantes desligados · UTMs no link`,
    `Início: ${draft.inicio ?? 'quando você ativar'} · Destino: ${draft.destinoUrl ?? '(falta)'}`,
    draft.estrutura === 'uma-campanha'
      ? `Estrutura: 1 campanha com ${Math.max(1, draft.testes.length)} conjunto(s), um por teste · orçamento sugerido R$ ${draft.orcamentoDiarioSugeridoBRL}/dia na campanha (só vale o valor que você aprovar)`
      : `Orçamento sugerido: R$ ${draft.orcamentoDiarioSugeridoBRL}/dia no total, dividido igual entre ${Math.max(1, draft.testes.length)} campanha(s) (só vale o valor que você aprovar)`,
    ...draft.testes.map((t, k) => `Teste ${k + 1}: ${t.map((i) => `${draft.criativos[i]!.tipo} "${draft.criativos[i]!.titulo}"`).join(' + ')}`),
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
  /** Orçamento fica na campanha (CBO): a Meta põe o dinheiro no criativo que puxa mais. */
  createCampaign(input: {
    adAccountId: string; nome: string; objetivo: string; orcamentoDiarioCentavos: number; status: 'PAUSED';
  }): Promise<{ id: string }>;
  createAdSet(input: {
    adAccountId: string; campaignId: string; nome: string; publico: CampaignDraft['publico'];
    pixelId: string | null; inicio: string | null; posicionamentos?: Posicionamentos; status: 'PAUSED';
  }): Promise<{ id: string }>;
  createAd(input: {
    adAccountId: string; adSetId: string; nome: string; criativo: CreativeDraft; destinoUrl: string;
    paginaFacebookId: string; status: 'PAUSED';
  }): Promise<{ id: string }>;
  /** Leitura de volta: o NIGHT confere o status em vez de confiar na resposta da criação. */
  getStatus(id: string): Promise<string>;
  /** Orçamento diário real da campanha, em centavos, para conferir depois de criar e na retomada. */
  getCampaignDailyBudgetCentavos(id: string): Promise<number>;
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
  | {
    status: 'criada'; campaignId: string; adSetId: string; adIds: string[]; reaproveitada: boolean;
    /** Uma por teste; a primeira é a mesma de campaignId. */
    campaignIds: string[]; adSetIds: string[];
  }
  | { status: 'recusada'; motivo: string }
  | { status: 'parada'; motivo: string; criados: Record<string, string> };

// O teste 1 guarda as chaves de antes (meta:campaign, meta:adset): a leitura do desempenho acha por elas.
const EFFECT = {
  campaign: (k: number) => (k === 0 ? 'meta:campaign' : `meta:campaign:${k}`),
  adSet: (k: number) => (k === 0 ? 'meta:adset' : `meta:adset:${k}`),
  ad: (i: number) => `meta:ad:${i}`,
  start: 'meta:build-started',
};

/** Nome da campanha de cada teste; o do teste 1 é o do rascunho (a retomada procura por ele). */
const nomeDoTeste = (draft: CampaignDraft, k: number) => (k === 0 ? draft.nome : `${draft.nome} · teste ${k + 1}`);

async function effectValue(memory: Memory, jobId: string, key: string): Promise<string | null> {
  const ev = (await memory.listJobEvents(jobId)).find((e) => e.effectKey === key);
  if (!ev) return null;
  const m = /id=(\S+)/.exec(ev.message);
  return m ? m[1]! : '';
}

/** Mídia gravada junto do anúncio ("midia=<url>"); efeitos antigos não têm e valem como estão. */
async function effectMidia(memory: Memory, jobId: string, key: string): Promise<string | null> {
  const ev = (await memory.listJobEvents(jobId)).find((e) => e.effectKey === key);
  return ev ? /midia=(\S+)/.exec(ev.message)?.[1] ?? null : null;
}

/** Mídia principal do criativo: o vídeo, ou a imagem. */
const midiaDe = (c: CreativeDraft) => (c.tipo === 'video' ? c.videoUrl : c.imagemUrl) ?? '';

/** Ids de todas as campanhas de uma montagem, na ordem dos testes (efeitos 'meta:campaign' e 'meta:campaign:k'). */
export function campaignIdsFromEvents(events: { effectKey?: string | null; message: string }[]): string[] {
  const ids: { k: number; id: string }[] = [];
  for (const e of events) {
    const m = /^meta:campaign(?::(\d+))?$/.exec(e.effectKey ?? '');
    const id = /id=(\S+)/.exec(e.message)?.[1];
    if (m && id) ids.push({ k: m[1] ? Number(m[1]) : 0, id });
  }
  return ids.sort((a, b) => a.k - b.k).map((x) => x.id);
}

/**
 * Cria, para cada teste, campanha (com o orçamento), conjunto e anúncios PAUSADOS, um passo por vez
 * (M06: sem rajada e sem repetir em erro).
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
  /** Relógio (testes): decide se o início marcado já passou. */
  now?: () => Date;
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
  // O valor aprovado é o total do dia. Uma campanha: ele inteiro nela. Uma por teste: dividido igual, em centavos exatos.
  const umaCampanha = draft.estrutura === 'uma-campanha';
  const nCampanhas = umaCampanha ? 1 : draft.testes.length;
  const campanhaDoTeste = (k: number) => (umaCampanha ? 0 : k);
  const totalCentavos = Math.round(orcamento * 100);
  const porTesteCentavos = Math.floor(totalCentavos / nCampanhas);
  if (porTesteCentavos * nCampanhas !== totalCentavos) {
    return { status: 'recusada', motivo: `R$ ${orcamento} não se divide em partes iguais entre ${draft.testes.length} campanhas; aprove um valor que divida (ex.: R$ ${(draft.testes.length * 15)})` };
  }

  // Uma montagem anterior com mais testes deixaria campanhas fora do orçamento aprovado agora.
  const eventos = await memory.listJobEvents(jobId);
  const sobrando = eventos.filter((e) => {
    const m = /^meta:campaign:(\d+)$/.exec(e.effectKey ?? '');
    return m !== null && Number(m[1]) >= nCampanhas;
  });
  if (sobrando.length) {
    return { status: 'recusada', motivo: `esta montagem já tem ${nCampanhas + sobrando.length} campanhas na Meta e o rascunho agora tem ${nCampanhas}; pause ou apague as que sobraram no Gerenciador e monte uma nova versão da oferta` };
  }

  // Início que já passou não vale: a Meta trocaria por "agora". Sem data, começa quando o Joel ativar.
  const agora = (deps.now ?? (() => new Date()))().getTime();
  const inicio = draft.inicio !== null && Date.parse(draft.inicio) > agora ? draft.inicio : null;

  const criados: Record<string, string> = {};
  try {
    // A aprovação fica registrada antes de qualquer chamada à Meta.
    await memory.recordJobEffect(jobId, EFFECT.start, 'owner',
      `aprovação: "${approval.frase}" · orçamento R$ ${orcamento}/dia no total, ${nCampanhas} campanha(s) e ${draft.testes.length} conjunto(s) · tudo pausado` +
      (draft.inicio && !inicio ? ` · início ${draft.inicio} já passou: começa quando for ativada` : ''));

    const campaignIds: string[] = [];
    const adSetIds: string[] = [];
    const adIds: string[] = [];
    let reaproveitada = false;
    const posicionamentos = POSICIONAMENTOS_OPCOES[draft.posicionamentos];
    for (const [k, teste] of draft.testes.entries()) {
      const ck = campanhaDoTeste(k);
      const nome = nomeDoTeste(draft, ck);
      const nomeConjunto = umaCampanha ? `${draft.nome} · teste ${k + 1}` : `${nome} · conjunto`;
      const rotulo = nCampanhas > 1 ? ` do teste ${k + 1}` : '';

      // Campanha: efeito já registrado, ou procura pelo nome (cobre queda entre criar e registrar).
      let campaignId = await effectValue(memory, jobId, EFFECT.campaign(ck));
      if (campaignId) reaproveitada = true;
      let campanhaCriadaAgora = false;
      if (!campaignId) {
        const existente = await writer.findCampaignByName(adAccountId, nome);
        if (existente) {
          campaignId = existente.id;
          reaproveitada = true;
        } else {
          campaignId = (await writer.createCampaign({
            adAccountId, nome, objetivo: draft.objetivo, orcamentoDiarioCentavos: porTesteCentavos, status: 'PAUSED',
          })).id;
          campanhaCriadaAgora = true;
        }
        await memory.recordJobEffect(jobId, EFFECT.campaign(ck), 'meta', `campanha id=${campaignId}`);
      }
      if (!campaignIds.includes(campaignId)) campaignIds.push(campaignId);
      criados[ck === 0 ? 'campanha' : `campanha${ck + 1}`] = campaignId;
      // Inclusive na retomada: uma campanha ativada manualmente não pode receber novos itens.
      let status = await writer.getStatus(campaignId);
      if (status !== 'PAUSED') {
        return { status: 'parada', motivo: `ATENÇÃO: campanha${rotulo} ${campaignId} está ${status}, não pausada. Pause agora no Gerenciador de Anúncios.`, criados };
      }
      let orcamentoReal: number;
      try {
        orcamentoReal = await writer.getCampaignDailyBudgetCentavos(campaignId);
      } catch (err) {
        throw new Error(`${(err as Error).message}. Se esta montagem é do formato antigo (orçamento no conjunto), ela não continua: monte uma nova versão da oferta`);
      }
      if (orcamentoReal !== porTesteCentavos) {
        return { status: 'parada', motivo: `A campanha${rotulo} ${campaignId} tem orçamento de R$ ${(orcamentoReal / 100).toFixed(2)}/dia, diferente dos R$ ${(porTesteCentavos / 100).toFixed(2)}/dia aprovados. Confira no Gerenciador de Anúncios.`, criados };
      }
      if (campanhaCriadaAgora) await sleep(pausa);

      let adSetId = await effectValue(memory, jobId, EFFECT.adSet(k));
      let conjuntoCriadoAgora = false;
      if (!adSetId) {
        adSetId = (await writer.createAdSet({
          adAccountId, campaignId, nome: nomeConjunto, publico: draft.publico,
          pixelId: draft.pixelId, inicio, posicionamentos, status: 'PAUSED',
        })).id;
        conjuntoCriadoAgora = true;
        await memory.recordJobEffect(jobId, EFFECT.adSet(k), 'meta', `conjunto id=${adSetId}`);
      }
      adSetIds.push(adSetId);
      criados[k === 0 ? 'conjunto' : `conjunto${k + 1}`] = adSetId;
      status = await writer.getStatus(adSetId);
      if (status !== 'PAUSED') {
        return { status: 'parada', motivo: `ATENÇÃO: conjunto${rotulo} ${adSetId} está ${status}, não pausado. Pause agora no Gerenciador de Anúncios.`, criados };
      }
      if (conjuntoCriadoAgora) await sleep(pausa);

      for (const i of teste) {
        const criativo = draft.criativos[i]!;
        let adId = await effectValue(memory, jobId, EFFECT.ad(i));
        const midiaGravada = adId ? await effectMidia(memory, jobId, EFFECT.ad(i)) : null;
        if (adId && midiaGravada !== null && midiaGravada !== midiaDe(criativo)) {
          return { status: 'parada', motivo: `o anúncio ${i + 1} (${adId}) foi criado com outra mídia (${midiaGravada}); o rascunho agora pede ${midiaDe(criativo)}. Monte uma nova versão da oferta`, criados };
        }
        let anuncioCriadoAgora = false;
        if (!adId) {
          adId = (await writer.createAd({
            adAccountId, adSetId, nome: `${nomeConjunto} · ${i + 1} · ${criativo.tipo}`, criativo, destinoUrl: draft.destinoUrl!,
            paginaFacebookId: draft.paginaFacebookId!, status: 'PAUSED',
          })).id;
          anuncioCriadoAgora = true;
          await memory.recordJobEffect(jobId, EFFECT.ad(i), 'meta', `anúncio id=${adId} midia=${midiaDe(criativo)}`);
        }
        adIds.push(adId);
        criados[`anuncio${i + 1}`] = adId;
        // A conferência acontece antes de criar o próximo anúncio.
        status = await writer.getStatus(adId);
        if (status !== 'PAUSED') {
          return { status: 'parada', motivo: `ATENÇÃO: anuncio${i + 1} ${adId} está ${status}, não pausado. Pause agora no Gerenciador de Anúncios.`, criados };
        }
        if (anuncioCriadoAgora) await sleep(pausa);
      }
    }
    return { status: 'criada', campaignId: campaignIds[0]!, adSetId: adSetIds[0]!, adIds, reaproveitada, campaignIds, adSetIds };
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
