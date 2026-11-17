// Briefing do agente de vídeos (V01, docs/PLANO_MESTRE_NIGHT.md).
// Código puro: sem banco, sem modelo e sem rede. O briefing é o contrato que separa
// a produção de vídeo da tarefa de código ou do Radar; mudar um briefing não toca neles.
//
// Regras:
// - plataforma define os padrões de formato e duração (o canal manda);
// - tema vazio é erro: o NIGHT não inventa o assunto do vídeo;
// - campo desconhecido é erro, para não aceitar typo em silêncio;
// - a oferta do Radar, quando existe, guarda a versão aprovada (mudar a oferta depois
//   não muda o roteiro por acidente).

export const BRIEF_VERSION = 'briefing-video/1';

export type IdiomaVideo = 'pt-BR' | 'en';
export type PlataformaVideo = 'youtube' | 'shorts' | 'reels' | 'tiktok' | 'outra';
export type FormatoVideo = 'vertical' | 'horizontal';

/** Versão congelada da oferta aprovada no Radar, quando o vídeo nasce de uma oferta. */
export interface OfertaRadarRef {
  number: number;
  version: number;
}

export interface LimitesBrief {
  /** Imagens que podem ser geradas: 1..60. O padrão é 30, não a cota máxima do Flow. */
  maxImagens: number;
  /** Tempo máximo de render em minutos. */
  maxRenderMin: number;
}

export interface VideoBrief {
  version: typeof BRIEF_VERSION;
  tema: string;
  publico: string;
  idioma: IdiomaVideo;
  plataforma: PlataformaVideo;
  formato: FormatoVideo;
  duracaoAlvoSeg: number;
  estilo: string;
  objetivo: string;
  /** null quando o vídeo não vem de uma oferta do Radar. */
  ofertaRadar: OfertaRadarRef | null;
  limites: LimitesBrief;
}

export interface BriefProblem {
  campo: string;
  problema: string;
}

const IDIOMAS: readonly IdiomaVideo[] = ['pt-BR', 'en'];
const PLATAFORMAS: readonly PlataformaVideo[] = ['youtube', 'shorts', 'reels', 'tiktok', 'outra'];
const FORMATOS: readonly FormatoVideo[] = ['vertical', 'horizontal'];

const BRIEF_KEYS = new Set([
  'version', 'tema', 'publico', 'idioma', 'plataforma', 'formato', 'duracaoAlvoSeg',
  'estilo', 'objetivo', 'ofertaRadar', 'limites',
]);
const LIMITE_KEYS = new Set(['maxImagens', 'maxRenderMin']);
const OFERTA_KEYS = new Set(['number', 'version']);

const DURACAO_MIN = 15;
const DURACAO_MAX = 600;
const IMAGENS_MIN = 1;
const IMAGENS_MAX = 60;

/** Padrões por plataforma; "outra" segue o padrão curto vertical. */
const PADROES: Record<PlataformaVideo, { formato: FormatoVideo; duracaoAlvoSeg: number }> = {
  youtube: { formato: 'horizontal', duracaoAlvoSeg: 90 },
  shorts: { formato: 'vertical', duracaoAlvoSeg: 60 },
  reels: { formato: 'vertical', duracaoAlvoSeg: 60 },
  tiktok: { formato: 'vertical', duracaoAlvoSeg: 60 },
  outra: { formato: 'vertical', duracaoAlvoSeg: 60 },
};

const MAX_IMAGENS_PADRAO = 30;
const MAX_RENDER_PADRAO = 15;

/** Objeto simples: sem array, sem null e sem classe — só o que vem do JSON. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function ehPlataforma(value: unknown): value is PlataformaVideo {
  return typeof value === 'string' && (PLATAFORMAS as readonly string[]).includes(value);
}

/**
 * Valida um briefing já completo (sem aplicar padrões) e junta todos os erros por campo.
 * Campos ausentes contam como inválidos: quem completa é o buildBrief.
 */
export function validateBrief(
  raw: unknown,
): { ok: true; brief: VideoBrief } | { ok: false; errors: BriefProblem[] } {
  if (!isPlainObject(raw)) {
    return { ok: false, errors: [{ campo: 'brief', problema: 'precisa ser um objeto' }] };
  }

  const errors: BriefProblem[] = [];
  const erro = (campo: string, problema: string): void => { errors.push({ campo, problema }); };

  // Typo silencioso já causou briefing errado; campo fora do contrato é erro.
  for (const chave of Object.keys(raw)) {
    if (!BRIEF_KEYS.has(chave)) erro(chave, 'campo desconhecido');
  }

  if (raw.version !== BRIEF_VERSION) {
    erro('version', `versão inválida: esperava ${BRIEF_VERSION}`);
  }

  const tema = raw.tema;
  if (typeof tema !== 'string' || tema.trim() === '') {
    erro('tema', 'não pode ser vazio (o NIGHT não inventa tema)');
  }

  if (typeof raw.publico !== 'string') erro('publico', 'deve ser texto');

  if (typeof raw.idioma !== 'string' || !(IDIOMAS as readonly string[]).includes(raw.idioma)) {
    erro('idioma', `esperava um de: ${IDIOMAS.join(', ')}`);
  }

  if (!ehPlataforma(raw.plataforma)) {
    erro('plataforma', `esperava uma de: ${PLATAFORMAS.join(', ')}`);
  }

  if (typeof raw.formato !== 'string' || !(FORMATOS as readonly string[]).includes(raw.formato)) {
    erro('formato', `esperava um de: ${FORMATOS.join(', ')}`);
  }

  const duracao = raw.duracaoAlvoSeg;
  if (typeof duracao !== 'number' || !Number.isFinite(duracao) || duracao < DURACAO_MIN || duracao > DURACAO_MAX) {
    erro('duracaoAlvoSeg', `deve ser número entre ${DURACAO_MIN} e ${DURACAO_MAX}`);
  }

  if (typeof raw.estilo !== 'string') erro('estilo', 'deve ser texto');
  if (typeof raw.objetivo !== 'string') erro('objetivo', 'deve ser texto');

  // Oferta nula é válida; quando presente, número e versão são inteiros positivos.
  let ofertaRadar: OfertaRadarRef | null = null;
  if (raw.ofertaRadar !== null && raw.ofertaRadar !== undefined) {
    if (!isPlainObject(raw.ofertaRadar)) {
      erro('ofertaRadar', 'deve ser null ou um objeto com number e version');
    } else {
      const oferta = raw.ofertaRadar;
      for (const chave of Object.keys(oferta)) {
        if (!OFERTA_KEYS.has(chave)) erro(`ofertaRadar.${chave}`, 'campo desconhecido');
      }
      const number = oferta.number;
      const version = oferta.version;
      if (typeof number !== 'number' || !Number.isInteger(number) || number < 1) {
        erro('ofertaRadar.number', 'deve ser inteiro maior ou igual a 1');
      }
      if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
        erro('ofertaRadar.version', 'deve ser inteiro maior ou igual a 1');
      }
      if (
        typeof number === 'number' && Number.isInteger(number) && number >= 1 &&
        typeof version === 'number' && Number.isInteger(version) && version >= 1
      ) {
        ofertaRadar = { number, version };
      }
    }
  }

  let limites: LimitesBrief | null = null;
  if (!isPlainObject(raw.limites)) {
    erro('limites', 'deve ser um objeto com maxImagens e maxRenderMin');
  } else {
    const limitesRaw = raw.limites;
    for (const chave of Object.keys(limitesRaw)) {
      if (!LIMITE_KEYS.has(chave)) erro(`limites.${chave}`, 'campo desconhecido');
    }
    const maxImagens = limitesRaw.maxImagens;
    if (typeof maxImagens !== 'number' || !Number.isInteger(maxImagens) || maxImagens < IMAGENS_MIN || maxImagens > IMAGENS_MAX) {
      erro('limites.maxImagens', `deve ser inteiro entre ${IMAGENS_MIN} e ${IMAGENS_MAX}`);
    }
    const maxRenderMin = limitesRaw.maxRenderMin;
    if (typeof maxRenderMin !== 'number' || !Number.isFinite(maxRenderMin) || maxRenderMin <= 0) {
      erro('limites.maxRenderMin', 'deve ser número maior que zero');
    }
    if (
      typeof maxImagens === 'number' && Number.isInteger(maxImagens) && maxImagens >= IMAGENS_MIN && maxImagens <= IMAGENS_MAX &&
      typeof maxRenderMin === 'number' && Number.isFinite(maxRenderMin) && maxRenderMin > 0
    ) {
      limites = { maxImagens, maxRenderMin };
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  // Só chega aqui com todos os campos conferidos.
  return {
    ok: true,
    brief: {
      version: BRIEF_VERSION,
      tema: tema as string,
      publico: raw.publico as string,
      idioma: raw.idioma as IdiomaVideo,
      plataforma: raw.plataforma as PlataformaVideo,
      formato: raw.formato as FormatoVideo,
      duracaoAlvoSeg: duracao as number,
      estilo: raw.estilo as string,
      objetivo: raw.objetivo as string,
      ofertaRadar,
      limites: limites as LimitesBrief,
    },
  };
}

/**
 * Completa o pedido com os padrões do canal e valida.
 * Lança Error com todos os problemas juntos; não inventa tema.
 */
export function buildBrief(partial: unknown): VideoBrief {
  if (!isPlainObject(partial)) throw new Error('briefing inválido: esperava um objeto');

  const plataforma = ehPlataforma(partial.plataforma) ? partial.plataforma : 'outra';
  const padrao = PADROES[plataforma];

  // Limites ausentes são o caso normal: aplica os padrões. Quando vêm, completa só o
  // que faltou e preserva chaves desconhecidas para que a validação as acuse; null ou
  // não-objeto passa intacto e continua sendo erro (limite explícito errado não some).
  const limites = partial.limites === undefined
    ? { maxImagens: MAX_IMAGENS_PADRAO, maxRenderMin: MAX_RENDER_PADRAO }
    : isPlainObject(partial.limites)
      ? { maxImagens: MAX_IMAGENS_PADRAO, maxRenderMin: MAX_RENDER_PADRAO, ...partial.limites }
      : partial.limites;

  const completo: Record<string, unknown> = {
    version: partial.version ?? BRIEF_VERSION,
    tema: partial.tema ?? '',
    publico: partial.publico ?? '',
    idioma: partial.idioma ?? 'pt-BR',
    plataforma: partial.plataforma ?? 'outra',
    formato: partial.formato ?? padrao.formato,
    duracaoAlvoSeg: partial.duracaoAlvoSeg ?? padrao.duracaoAlvoSeg,
    estilo: partial.estilo ?? '',
    objetivo: partial.objetivo ?? '',
    ofertaRadar: partial.ofertaRadar === undefined ? null : partial.ofertaRadar,
    limites,
  };

  const problemas: BriefProblem[] = [];
  for (const chave of Object.keys(partial)) {
    if (!BRIEF_KEYS.has(chave)) problemas.push({ campo: chave, problema: 'campo desconhecido' });
  }
  const validado = validateBrief(completo);
  if (!validado.ok) problemas.push(...validado.errors);

  if (problemas.length > 0) {
    throw new Error(problemas.map((p) => `${p.campo}: ${p.problema}`).join('; '));
  }
  if (!validado.ok) throw new Error('briefing inválido');
  return validado.brief;
}
