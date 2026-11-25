// Adaptador do MetaAdsWriter pela Graph API da Meta, com o token do usuário de sistema (NIGHT_META_TOKEN).
// É o mesmo contrato do adaptador do MCP, sem modelo no meio: cada etapa é uma chamada com campos fixos.
// Cria campanha, conjunto e anúncio sempre PAUSED; nenhum método ativa, muda status, orçamento ou apaga.
// O token nunca aparece em erro, log ou resposta.

import { POSICIONAMENTOS, UTM_PADRAO, type CampaignDraft, type CreativeDraft, type MetaAdsWriter, type Posicionamentos } from './campaign.ts';

export const GRAPH_VERSION = 'v22.0';

/** Recursos de melhoria automática do criativo (Advantage+); todos desligados no teste de criativo. */
export const MELHORIAS_DESLIGADAS = [
  'adapt_to_placement', 'add_text_overlay', 'creative_stickers', 'description_automation', 'enhance_cta',
  'image_animation', 'image_background_gen', 'image_brightness_and_contrast', 'image_templates',
  'image_text_translation', 'image_touchups', 'image_uncrop', 'inline_comment', 'media_type_automation',
  'product_extensions', 'reveal_details_over_time', 'text_optimizations', 'text_translation',
  'translate_voiceover', 'video_auto_crop', 'video_filtering', 'video_uncrop',
] as const;

export type GraphFetch = (url: string, init?: { method?: string; body?: URLSearchParams }) => Promise<{ json(): Promise<unknown> }>;

const ID_RE = /^[\w-]+$/;

export class GraphMetaWriter implements MetaAdsWriter {
  private readonly token: string;
  private readonly fetch: GraphFetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly base: string;
  /** Conta do Instagram de cada página (a ligada ou a "vinculada à página"), lida uma vez. */
  private readonly igDaPagina = new Map<string, string | null>();

  constructor(opts: { token: string; fetch?: GraphFetch; sleep?: (ms: number) => Promise<void>; version?: string }) {
    if (!opts.token?.trim()) throw new Error('falta o token da Meta (NIGHT_META_TOKEN)');
    this.token = opts.token.trim();
    this.fetch = opts.fetch ?? ((url, init) => fetch(url, init));
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.base = `https://graph.facebook.com/${opts.version ?? GRAPH_VERSION}`;
  }

  async findCampaignByName(adAccountId: string, nome: string) {
    const r = await this.get(`${conta(adAccountId)}/campaigns`, {
      fields: 'id,name,status',
      filtering: JSON.stringify([{ field: 'name', operator: 'EQUAL', value: nome }]),
      limit: '50',
    }) as { data?: { id: string; name: string; status: string }[] };
    const achada = (r.data ?? []).find((c) => c.name === nome);
    return achada ? { id: achada.id, status: achada.status } : null;
  }

  async createCampaign(input: { adAccountId: string; nome: string; objetivo: string; orcamentoDiarioCentavos: number; status: 'PAUSED' }) {
    if (!Number.isSafeInteger(input.orcamentoDiarioCentavos) || input.orcamentoDiarioCentavos <= 0) throw new Error('orçamento da campanha inválido');
    return this.created(await this.post(`${conta(input.adAccountId)}/campaigns`, {
      name: input.nome,
      objective: input.objetivo,
      status: 'PAUSED',
      special_ad_categories: [],
      buying_type: 'AUCTION',
      // Orçamento na campanha (CBO), na unidade mínima da moeda: centavos de BRL.
      daily_budget: String(input.orcamentoDiarioCentavos),
      bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
    }));
  }

  async createAdSet(input: {
    adAccountId: string; campaignId: string; nome: string; publico: CampaignDraft['publico'];
    pixelId: string | null; inicio: string | null; posicionamentos?: Posicionamentos; status: 'PAUSED';
  }) {
    const pos = input.posicionamentos ?? POSICIONAMENTOS;
    const genders = { todos: undefined, mulheres: [2], homens: [1] }[input.publico.generos];
    return this.created(await this.post(`${conta(input.adAccountId)}/adsets`, {
      name: input.nome,
      campaign_id: input.campaignId,
      status: 'PAUSED',
      billing_event: 'IMPRESSIONS',
      ...(input.pixelId
        ? { optimization_goal: 'OFFSITE_CONVERSIONS', promoted_object: { pixel_id: input.pixelId, custom_event_type: 'PURCHASE' } }
        : {}),
      ...(input.inicio ? { start_time: input.inicio } : {}),
      targeting: {
        geo_locations: { countries: [input.publico.pais] },
        age_min: input.publico.idadeMin,
        age_max: input.publico.idadeMax,
        ...(genders ? { genders } : {}),
        // Público Advantage+ desligado: idade e gênero valem como limite, não como sugestão.
        targeting_automation: { advantage_audience: 0 },
        publisher_platforms: ['facebook', 'instagram'],
        facebook_positions: [...pos.facebook],
        instagram_positions: [...pos.instagram],
      },
    }));
  }

  async createAd(input: {
    adAccountId: string; adSetId: string; nome: string; criativo: CreativeDraft; destinoUrl: string;
    paginaFacebookId: string; status: 'PAUSED';
  }) {
    const c = input.criativo;
    const acct = conta(input.adAccountId);
    const ig = await this.instagramDaPagina(input.paginaFacebookId);
    const cta = { type: 'LEARN_MORE', value: { link: input.destinoUrl } };
    const imagemHash = await this.subirImagem(acct, c.imagemUrl);
    let spec: Record<string, unknown>;
    if (c.tipo === 'video') {
      if (!c.videoUrl) throw new Error('criativo de vídeo sem URL do vídeo');
      const videoId = await this.subirVideo(acct, c.videoUrl);
      spec = { video_data: { video_id: videoId, image_hash: imagemHash, message: c.textoPrincipal, title: c.titulo, call_to_action: cta } };
    } else {
      spec = { link_data: { image_hash: imagemHash, link: input.destinoUrl, message: c.textoPrincipal, name: c.titulo, call_to_action: cta } };
    }
    const criativo = this.created(await this.post(`${acct}/adcreatives`, {
      name: input.nome,
      object_story_spec: { page_id: input.paginaFacebookId, ...(ig ? { instagram_user_id: ig } : {}), ...spec },
      url_tags: UTM_PADRAO,
      degrees_of_freedom_spec: {
        creative_features_spec: Object.fromEntries(MELHORIAS_DESLIGADAS.map((f) => [f, { enroll_status: 'OPT_OUT' }])),
      },
      contextual_multi_ads: { enroll_status: 'OPT_OUT' },
    }));
    return this.created(await this.post(`${acct}/ads`, {
      name: input.nome, adset_id: input.adSetId, status: 'PAUSED', creative: { creative_id: criativo.id },
    }));
  }

  async getStatus(id: string) {
    if (!ID_RE.test(id)) throw new Error('id inválido para consulta de status');
    const r = await this.get(id, { fields: 'id,status' }) as { id?: string; status?: string };
    if (r.id !== id) throw new Error(`a Meta devolveu outro id ao ler o status de ${id}`);
    if (!r.status) throw new Error(`não consegui ler o status de ${id}`);
    return r.status.toUpperCase();
  }

  async getCampaignDailyBudgetCentavos(id: string) {
    if (!ID_RE.test(id)) throw new Error('id inválido para consulta de orçamento');
    const r = await this.get(id, { fields: 'id,daily_budget' }) as { id?: string; daily_budget?: string };
    const v = Number(r.daily_budget);
    if (r.id !== id || r.daily_budget === undefined || !Number.isSafeInteger(v) || v < 0) {
      throw new Error('não consegui conferir o orçamento diário da campanha ' + id);
    }
    return v;
  }

  // ---------- mídia e identidade ----------

  /** A Meta não baixa imagem por URL no adimages: o NIGHT baixa e envia os bytes. */
  private async subirImagem(acct: string, url: string | null): Promise<string> {
    if (!url || !/^https:\/\//.test(url)) throw new Error('imagem do criativo precisa ser URL https');
    const res = await fetch(url);
    if (!res.ok) throw new Error(`não consegui baixar a imagem ${url} (${res.status})`);
    const bytes = Buffer.from(await res.arrayBuffer()).toString('base64');
    const r = await this.post(`${acct}/adimages`, { bytes }) as { images?: Record<string, { hash?: string }> };
    const hash = Object.values(r.images ?? {})[0]?.hash;
    if (!hash) throw new Error('a Meta não devolveu o hash da imagem');
    return hash;
  }

  /** Vídeo por URL (a Meta baixa) e espera ficar pronto: anúncio com vídeo em processamento é recusado. */
  private async subirVideo(acct: string, url: string): Promise<string> {
    if (!/^https:\/\//.test(url)) throw new Error('vídeo do criativo precisa ser URL https');
    const { id } = this.created(await this.post(`${acct}/advideos`, { file_url: url }));
    for (let i = 0; i < 60; i++) {
      const r = await this.get(id, { fields: 'status' }) as { status?: { video_status?: string } };
      const s = r.status?.video_status;
      if (s === 'ready') return id;
      if (s === 'error' || s === 'expired') throw new Error(`a Meta não processou o vídeo ${url} (${s})`);
      await this.sleep(5000);
    }
    throw new Error(`o vídeo ${url} não ficou pronto em 5 minutos; confira na biblioteca de mídia`);
  }

  /** Instagram ligado à página ou, sem ele, a conta "vinculada à página" (o anúncio sai com nome e foto da página). */
  private async instagramDaPagina(pagina: string): Promise<string | null> {
    if (this.igDaPagina.has(pagina)) return this.igDaPagina.get(pagina)!;
    const p = await this.get(pagina, { fields: 'instagram_business_account,access_token' }) as {
      instagram_business_account?: { id?: string }; access_token?: string;
    };
    let ig = p.instagram_business_account?.id ?? null;
    if (!ig && p.access_token) {
      const r = await this.get(`${pagina}/page_backed_instagram_accounts`, {}, p.access_token) as { data?: { id: string }[] };
      ig = r.data?.[0]?.id ?? null;
    }
    this.igDaPagina.set(pagina, ig);
    return ig;
  }

  // ---------- HTTP ----------

  private created(r: unknown): { id: string } {
    const id = (r as { id?: unknown })?.id;
    if (typeof id !== 'string' || !ID_RE.test(id)) throw new Error('a Meta não devolveu um id válido; confira no Gerenciador antes de tentar de novo');
    return { id };
  }

  private async get(path: string, params: Record<string, string>, token = this.token) {
    const u = new URL(`${this.base}/${path}`);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    u.searchParams.set('access_token', token);
    return this.ler(await this.fetch(u.toString()));
  }

  private async post(path: string, params: Record<string, unknown>) {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) body.set(k, typeof v === 'string' ? v : JSON.stringify(v));
    body.set('access_token', this.token);
    return this.ler(await this.fetch(`${this.base}/${path}`, { method: 'POST', body }));
  }

  private async ler(res: { json(): Promise<unknown> }): Promise<unknown> {
    const j = await res.json() as { error?: { message?: string; error_user_title?: string; error_user_msg?: string; code?: number } };
    if (j?.error) {
      const e = j.error;
      const texto = (e.error_user_msg || e.error_user_title || e.message || 'erro sem mensagem').split(this.token).join('***');
      if (e.code === 190) throw new Error('o token da Meta expirou ou é inválido; gere outro e atualize NIGHT_META_TOKEN');
      throw new Error(`a Meta recusou: ${texto.slice(0, 300)}`);
    }
    return j;
  }
}

/** "act_123" ou "123" viram "act_123". */
function conta(adAccountId: string): string {
  const id = adAccountId.trim();
  if (!/^(act_)?\d+$/.test(id)) throw new Error('conta de anúncios inválida (use act_123)');
  return id.startsWith('act_') ? id : `act_${id}`;
}
