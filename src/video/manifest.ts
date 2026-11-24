// Manifesto de cenas do agente de vídeos (V02, docs/PLANO_MESTRE_NIGHT.md).
// Código puro: sem banco, sem modelo e sem rede. O roteiro vira uma lista de cenas
// verificável: cada afirmação importante tem fonte ou é marcada como dúvida.
//
// Dois níveis de problema, de propósito:
// - ERRO impede montar o manifesto (estrutura, sequência, fonte inexistente, URL,
//   duração fora da meta, imagens acima do limite);
// - AVISO não impede a montagem, mas o NIGHT mostra ao Joel e o render final só
//   libera quando as pendências de readyForFinalRender forem resolvidas.
// O aviso de imagem realista gerada existe porque a plataforma pode exigir
// identificação de conteúdo realista gerado por IA (ver plano de vídeos).

import { createHash } from 'node:crypto';
import { validateBrief, type IdiomaVideo, type VideoBrief } from './brief.ts';
import {
  FONT_MOODS,
  SCENE_TRANSITIONS,
  VISUAL_ENGINES,
  getVideoTemplate,
  templateRequiresImages,
  type FontMood,
  type SceneTransition,
  type StylePalette,
  type StyleRecipe,
  type VisualEngine,
} from './templates.ts';

export const MANIFEST_VERSION = 'cenas/1';

/** Ritmo médio de leitura por idioma, usado para estimar a duração sem áudio. */
export const PALAVRAS_POR_SEGUNDO: Record<IdiomaVideo, number> = { 'pt-BR': 2.5, en: 2.7 };

export type PapelImagem = 'ilustracao' | 'registro_real';

export interface Source {
  id: string;
  url: string;
  titulo: string;
  /** Data de acesso em ISO 8601. */
  acessadoEm: string;
}

export interface Afirmacao {
  texto: string;
  /** id de Source; null quando não há fonte. */
  fonte: string | null;
  /** true quando o próprio roteiro assume que o dado não foi confirmado. */
  duvida: boolean;
}

export interface Scene {
  /** 1..N, sem buraco e na ordem do vídeo. */
  n: number;
  narracao: string;
  duracaoEstimadaSeg: number;
  afirmacoes: Afirmacao[];
  visual: string;
  promptImagem: string;
  papelImagem: PapelImagem;
  realistaGeradaPorIA: boolean;
  /** null até a imagem ser gerada/anexada. */
  assetRef: string | null;
  /** Campos visuais opcionais para templates do estúdio Remotion. */
  textoNaTela?: string;
  acao?: string;
  transicao?: SceneTransition;
  assets?: string[];
  pose?: string;
  expressao?: string;
  cenario?: string;
}

export interface VideoManifest {
  version: typeof MANIFEST_VERSION;
  jobId: string;
  brief: VideoBrief;
  titulo: string;
  fontes: Source[];
  cenas: Scene[];
  /** Seleção opcional de motor e template visual do estúdio. */
  motorVisual?: VisualEngine;
  templateVisual?: string;
  styleRecipe?: StyleRecipe;
  trilhaAudio?: string | null;
}

export interface ManifestProblem {
  campo: string;
  problema: string;
}

const PAPEIS: readonly PapelImagem[] = ['ilustracao', 'registro_real'];
const DATA_ISO = /^\d{4}-\d{2}-\d{2}(T.*)?$/;
const TOLERANCIA_DURACAO = 0.25;
const MIN_REPETICAO_IMAGEM = 3;
const STYLE_RECIPE_KEYS = new Set(['palette', 'cutsPerMinute', 'hookMaxSec', 'fontMood', 'sourceNote']);
const PALETTE_KEYS = new Set(['background', 'primary', 'accent', 'text']);

function validateStyleRecipe(
  raw: unknown,
  erro: (campo: string, problema: string) => void,
): StyleRecipe | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) {
    erro('styleRecipe', 'deve ser um objeto');
    return undefined;
  }
  for (const chave of Object.keys(raw)) {
    if (!STYLE_RECIPE_KEYS.has(chave)) erro(`styleRecipe.${chave}`, 'campo desconhecido');
  }
  const out: StyleRecipe = {};
  if (raw.palette !== undefined) {
    if (!isPlainObject(raw.palette)) {
      erro('styleRecipe.palette', 'deve ser um objeto');
    } else {
      const palette: Partial<StylePalette> = {};
      for (const chave of Object.keys(raw.palette)) {
        if (!PALETTE_KEYS.has(chave)) {
          erro(`styleRecipe.palette.${chave}`, 'campo desconhecido');
          continue;
        }
        const val = raw.palette[chave];
        if (typeof val !== 'string' || val.trim() === '') {
          erro(`styleRecipe.palette.${chave}`, 'deve ser texto não vazio');
        } else {
          palette[chave as keyof StylePalette] = val;
        }
      }
      out.palette = palette;
    }
  }
  if (raw.cutsPerMinute !== undefined) {
    if (typeof raw.cutsPerMinute !== 'number' || !Number.isFinite(raw.cutsPerMinute) || raw.cutsPerMinute <= 0) {
      erro('styleRecipe.cutsPerMinute', 'deve ser número maior que zero');
    } else {
      out.cutsPerMinute = raw.cutsPerMinute;
    }
  }
  if (raw.hookMaxSec !== undefined) {
    if (typeof raw.hookMaxSec !== 'number' || !Number.isFinite(raw.hookMaxSec) || raw.hookMaxSec <= 0) {
      erro('styleRecipe.hookMaxSec', 'deve ser número maior que zero');
    } else {
      out.hookMaxSec = raw.hookMaxSec;
    }
  }
  if (raw.fontMood !== undefined) {
    if (typeof raw.fontMood !== 'string' || !(FONT_MOODS as readonly string[]).includes(raw.fontMood)) {
      erro('styleRecipe.fontMood', `esperava um de: ${FONT_MOODS.join(', ')}`);
    } else {
      out.fontMood = raw.fontMood as FontMood;
    }
  }
  if (raw.sourceNote !== undefined) {
    if (typeof raw.sourceNote !== 'string') {
      erro('styleRecipe.sourceNote', 'deve ser texto');
    } else {
      out.sourceNote = raw.sourceNote;
    }
  }
  return out;
}

/** Objeto simples: sem array, sem null e sem classe — só o que vem do JSON. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function urlValida(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function dataIsoValida(value: unknown): value is string {
  if (typeof value !== 'string' || !DATA_ISO.test(value)) return false;
  return !Number.isNaN(Date.parse(value));
}

/** Texto curto para aviso/pendência, sem despejar o roteiro inteiro no log. */
function resumir(texto: string, max = 60): string {
  const limpo = texto.trim();
  return limpo.length <= max ? limpo : limpo.slice(0, max - 1) + '…';
}

/**
 * Valida o manifesto e devolve o objeto normalizado.
 * Erros bloqueiam a montagem; avisos só pedem atenção do Joel.
 */
export function validateManifest(
  raw: unknown,
): { ok: true; manifest: VideoManifest; avisos: string[] } | { ok: false; errors: ManifestProblem[] } {
  if (!isPlainObject(raw)) {
    return { ok: false, errors: [{ campo: 'manifesto', problema: 'precisa ser um objeto' }] };
  }

  const errors: ManifestProblem[] = [];
  const erro = (campo: string, problema: string): void => { errors.push({ campo, problema }); };

  if (raw.version !== MANIFEST_VERSION) {
    erro('version', `versão inválida: esperava ${MANIFEST_VERSION}`);
  }

  const jobId = raw.jobId;
  if (typeof jobId !== 'string' || jobId.trim() === '') erro('jobId', 'não pode ser vazio');

  const titulo = raw.titulo;
  if (typeof titulo !== 'string' || titulo.trim() === '') erro('titulo', 'não pode ser vazio');

  // O briefing é o mesmo contrato do V01; erros dele entram como brief.<campo>.
  let brief: VideoBrief | null = null;
  const briefValidado = validateBrief(raw.brief);
  if (briefValidado.ok) brief = briefValidado.brief;
  else for (const p of briefValidado.errors) erro(`brief.${p.campo}`, p.problema);

  const fontes: Source[] = [];
  const fontesIds = new Set<string>();
  if (!Array.isArray(raw.fontes)) {
    erro('fontes', 'deve ser uma lista de fontes');
  } else {
    raw.fontes.forEach((item, i) => {
      const campo = `fontes[${i}]`;
      if (!isPlainObject(item)) { erro(campo, 'fonte deve ser um objeto'); return; }
      const id = item.id;
      const url = item.url;
      const tituloFonte = item.titulo;
      const acessadoEm = item.acessadoEm;
      let okFonte = true;
      if (typeof id !== 'string' || id.trim() === '') {
        erro(`${campo}.id`, 'não pode ser vazio'); okFonte = false;
      } else if (fontesIds.has(id)) {
        erro(`${campo}.id`, `id repetido: ${id}`); okFonte = false;
      }
      if (!urlValida(url)) { erro(`${campo}.url`, 'deve ser URL http ou https'); okFonte = false; }
      if (typeof tituloFonte !== 'string' || tituloFonte.trim() === '') {
        erro(`${campo}.titulo`, 'não pode ser vazio'); okFonte = false;
      }
      if (!dataIsoValida(acessadoEm)) { erro(`${campo}.acessadoEm`, 'deve ser data ISO'); okFonte = false; }
      if (okFonte) {
        fontesIds.add(id as string);
        fontes.push({
          id: id as string,
          url: url as string,
          titulo: tituloFonte as string,
          acessadoEm: acessadoEm as string,
        });
      }
    });
  }

  const cenas: Scene[] = [];
  let totalSeg = 0;
  let duracoesOk = true;
  const listaCenas = raw.cenas;
  if (!Array.isArray(listaCenas) || listaCenas.length === 0) {
    erro('cenas', 'deve ser uma lista com pelo menos uma cena');
    duracoesOk = false;
  } else {
    listaCenas.forEach((item, i) => {
      const campo = `cenas[${i}]`;
      if (!isPlainObject(item)) {
        erro(campo, 'cena deve ser um objeto'); duracoesOk = false; return;
      }
      let okCena = true;

      const n = item.n;
      if (typeof n !== 'number' || !Number.isInteger(n)) {
        erro(`${campo}.n`, 'deve ser inteiro'); okCena = false;
      } else if (n !== i + 1) {
        erro(`${campo}.n`, `deve ser ${i + 1}: cenas em sequência, sem buraco`); okCena = false;
      }

      const narracao = item.narracao;
      if (typeof narracao !== 'string' || narracao.trim() === '') {
        erro(`${campo}.narracao`, 'não pode ser vazia'); okCena = false;
      }

      const duracao = item.duracaoEstimadaSeg;
      if (typeof duracao !== 'number' || !Number.isFinite(duracao) || duracao <= 0) {
        erro(`${campo}.duracaoEstimadaSeg`, 'deve ser número maior que zero');
        okCena = false;
        duracoesOk = false;
      }

      const afirmacoes: Afirmacao[] = [];
      if (!Array.isArray(item.afirmacoes)) {
        erro(`${campo}.afirmacoes`, 'deve ser uma lista'); okCena = false;
      } else {
        item.afirmacoes.forEach((a, j) => {
          const acampo = `${campo}.afirmacoes[${j}]`;
          if (!isPlainObject(a)) {
            erro(acampo, 'afirmação deve ser um objeto'); okCena = false; return;
          }
          let okA = true;
          const texto = a.texto;
          if (typeof texto !== 'string' || texto.trim() === '') {
            erro(`${acampo}.texto`, 'não pode ser vazio'); okA = false;
          }
          let fonte: string | null = null;
          if (a.fonte === null || a.fonte === undefined) {
            fonte = null;
          } else if (typeof a.fonte === 'string' && a.fonte.trim() !== '') {
            if (!fontesIds.has(a.fonte)) {
              erro(`${acampo}.fonte`, `fonte citada não existe em fontes: ${a.fonte}`); okA = false;
            } else {
              fonte = a.fonte;
            }
          } else {
            erro(`${acampo}.fonte`, 'deve ser null ou id de fonte'); okA = false;
          }
          const duvida = a.duvida;
          if (typeof duvida !== 'boolean') {
            erro(`${acampo}.duvida`, 'deve ser true ou false'); okA = false;
          }
          if (okA) afirmacoes.push({ texto: texto as string, fonte, duvida: duvida as boolean });
        });
      }

      const visual = item.visual;
      if (typeof visual !== 'string' || visual.trim() === '') {
        erro(`${campo}.visual`, 'não pode ser vazio'); okCena = false;
      }

      const promptImagem = item.promptImagem;
      if (typeof promptImagem !== 'string') {
        erro(`${campo}.promptImagem`, 'deve ser texto'); okCena = false;
      }

      const papelImagem = item.papelImagem;
      if (typeof papelImagem !== 'string' || !(PAPEIS as readonly string[]).includes(papelImagem)) {
        erro(`${campo}.papelImagem`, `esperava um de: ${PAPEIS.join(', ')}`); okCena = false;
      }

      const realista = item.realistaGeradaPorIA;
      if (typeof realista !== 'boolean') {
        erro(`${campo}.realistaGeradaPorIA`, 'deve ser true ou false'); okCena = false;
      }

      const assetRef = item.assetRef;
      if (assetRef !== null && assetRef !== undefined && typeof assetRef !== 'string') {
        erro(`${campo}.assetRef`, 'deve ser texto ou null'); okCena = false;
      }

      const textoNaTela = item.textoNaTela;
      if (textoNaTela !== undefined && typeof textoNaTela !== 'string') {
        erro(`${campo}.textoNaTela`, 'deve ser texto'); okCena = false;
      }

      const acao = item.acao;
      if (acao !== undefined && typeof acao !== 'string') {
        erro(`${campo}.acao`, 'deve ser texto'); okCena = false;
      }

      const transicao = item.transicao;
      if (
        transicao !== undefined &&
        (typeof transicao !== 'string' || !(SCENE_TRANSITIONS as readonly string[]).includes(transicao))
      ) {
        erro(`${campo}.transicao`, `esperava um de: ${SCENE_TRANSITIONS.join(', ')}`); okCena = false;
      }

      let assets: string[] | undefined;
      if (item.assets !== undefined) {
        if (!Array.isArray(item.assets) || item.assets.some((a) => typeof a !== 'string')) {
          erro(`${campo}.assets`, 'deve ser uma lista de textos'); okCena = false;
        } else {
          assets = [...(item.assets as string[])];
        }
      }

      const pose = item.pose;
      if (pose !== undefined && typeof pose !== 'string') {
        erro(`${campo}.pose`, 'deve ser texto'); okCena = false;
      }

      const expressao = item.expressao;
      if (expressao !== undefined && typeof expressao !== 'string') {
        erro(`${campo}.expressao`, 'deve ser texto'); okCena = false;
      }

      const cenario = item.cenario;
      if (cenario !== undefined && typeof cenario !== 'string') {
        erro(`${campo}.cenario`, 'deve ser texto'); okCena = false;
      }

      if (okCena) {
        cenas.push({
          n: n as number,
          narracao: narracao as string,
          duracaoEstimadaSeg: duracao as number,
          afirmacoes,
          visual: visual as string,
          promptImagem: promptImagem as string,
          papelImagem: papelImagem as PapelImagem,
          realistaGeradaPorIA: realista as boolean,
          assetRef: assetRef === null || assetRef === undefined ? null : (assetRef as string),
          ...(textoNaTela !== undefined ? { textoNaTela: textoNaTela as string } : {}),
          ...(acao !== undefined ? { acao: acao as string } : {}),
          ...(transicao !== undefined ? { transicao: transicao as SceneTransition } : {}),
          ...(assets !== undefined ? { assets } : {}),
          ...(pose !== undefined ? { pose: pose as string } : {}),
          ...(expressao !== undefined ? { expressao: expressao as string } : {}),
          ...(cenario !== undefined ? { cenario: cenario as string } : {}),
        });
        totalSeg += duracao as number;
      }
    });
  }

  let motorVisual: VisualEngine | undefined;
  if (raw.motorVisual !== undefined) {
    if (typeof raw.motorVisual !== 'string' || !(VISUAL_ENGINES as readonly string[]).includes(raw.motorVisual)) {
      erro('motorVisual', `esperava um de: ${VISUAL_ENGINES.join(', ')}`);
    } else {
      motorVisual = raw.motorVisual as VisualEngine;
    }
  }

  let templateVisual: string | undefined;
  if (raw.templateVisual !== undefined) {
    if (typeof raw.templateVisual !== 'string' || getVideoTemplate(raw.templateVisual) === null) {
      erro('templateVisual', 'template visual desconhecido');
    } else {
      templateVisual = raw.templateVisual.trim();
    }
  }

  const styleRecipe = validateStyleRecipe(raw.styleRecipe, erro);

  let trilhaAudio: string | null | undefined;
  if (raw.trilhaAudio !== undefined) {
    if (raw.trilhaAudio !== null && typeof raw.trilhaAudio !== 'string') {
      erro('trilhaAudio', 'deve ser texto ou null');
    } else {
      trilhaAudio = raw.trilhaAudio;
    }
  }

  // Só compara com o briefing quando ele é válido e todas as cenas têm duração.
  if (brief !== null && duracoesOk && cenas.length > 0 && cenas.length === (Array.isArray(listaCenas) ? listaCenas.length : 0)) {
    const alvo = brief.duracaoAlvoSeg;
    const minimo = alvo * (1 - TOLERANCIA_DURACAO);
    const maximo = alvo * (1 + TOLERANCIA_DURACAO);
    if (totalSeg < minimo || totalSeg > maximo) {
      erro('cenas.duracaoTotal', `duração total ${totalSeg}s fora de ±25% da meta de ${alvo}s`);
    }
    const comImagem = cenas.filter((c) => c.promptImagem.trim() !== '').length;
    if (comImagem > brief.limites.maxImagens) {
      erro('cenas.imagens', `${comImagem} cenas com imagem acima do limite de ${brief.limites.maxImagens}`);
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  if (brief === null) return { ok: false, errors: [{ campo: 'brief', problema: 'briefing ausente' }] };

  const manifest: VideoManifest = {
    version: MANIFEST_VERSION,
    jobId: jobId as string,
    brief,
    titulo: titulo as string,
    fontes,
    cenas,
    ...(motorVisual !== undefined ? { motorVisual } : {}),
    ...(templateVisual !== undefined ? { templateVisual } : {}),
    ...(styleRecipe !== undefined ? { styleRecipe } : {}),
    ...(trilhaAudio !== undefined ? { trilhaAudio } : {}),
  };

  // Avisos: não bloqueiam a montagem, mas ficam visíveis para o Joel.
  const avisos: string[] = [];
  for (const cena of cenas) {
    for (const a of cena.afirmacoes) {
      if ((a.fonte === null || a.fonte.trim() === '') && !a.duvida) {
        avisos.push(`cena ${cena.n}: afirmação sem fonte e sem dúvida: "${resumir(a.texto)}"`);
      }
    }
    if (cena.papelImagem === 'registro_real' && cena.promptImagem.trim() !== '') {
      avisos.push(`cena ${cena.n}: papel "registro_real" com prompt de imagem; imagem gerada não é registro autêntico`);
    }
    if (cena.realistaGeradaPorIA) {
      avisos.push(`cena ${cena.n}: imagem realista gerada por IA; lembrar a identificação na plataforma`);
    }
  }
  const contagem = new Map<string, number>();
  for (const cena of cenas) {
    const prompt = cena.promptImagem.trim();
    if (prompt !== '') contagem.set(prompt, (contagem.get(prompt) ?? 0) + 1);
  }
  for (const [prompt, qtd] of contagem) {
    if (qtd >= MIN_REPETICAO_IMAGEM) {
      avisos.push(`${qtd} cenas com o mesmo prompt de imagem (repetição visual): "${resumir(prompt)}"`);
    }
  }

  return { ok: true, manifest, avisos };
}

/**
 * Pronto para o render final? Diferente dos avisos, aqui o que importa é o que falta:
 * afirmação sem fonte (e sem dúvida), registro_real gerado por prompt e cena sem imagem.
 */
export function readyForFinalRender(manifest: VideoManifest): { pronto: boolean; pendencias: string[] } {
  const pendencias: string[] = [];
  const exigeImagens = templateRequiresImages(manifest.templateVisual);
  for (const cena of manifest.cenas) {
    for (const a of cena.afirmacoes) {
      if ((a.fonte === null || a.fonte.trim() === '') && !a.duvida) {
        pendencias.push(`cena ${cena.n}: afirmação sem fonte e sem dúvida: "${resumir(a.texto)}"`);
      }
    }
    if (cena.papelImagem === 'registro_real' && cena.promptImagem.trim() !== '') {
      pendencias.push(`cena ${cena.n}: "registro_real" gerado por prompt; use registro autêntico ou mude para ilustração`);
    }
    if (exigeImagens && (cena.assetRef === null || cena.assetRef.trim() === '')) {
      pendencias.push(`cena ${cena.n}: sem imagem anexada (assetRef vazio)`);
    }
  }
  return { pronto: pendencias.length === 0, pendencias };
}

/** Segundos estimados pela contagem de palavras; arredonda a 0,1 s. */
export function estimateDuration(texto: string, idioma: IdiomaVideo): number {
  const limpo = texto.trim();
  const palavras = limpo === '' ? 0 : limpo.split(/\s+/).length;
  const segundos = palavras / PALAVRAS_POR_SEGUNDO[idioma];
  return Math.round(segundos * 10) / 10;
}

/**
 * Chave de cache por cena (base do V07): muda quando muda a narração, o prompt, o estilo,
 * o idioma, o formato ou a direção visual; as outras cenas mantêm a chave e não são regeradas.
 */
export function sceneCacheKey(scene: Scene, brief: VideoBrief): string {
  const temExtraVisual =
    scene.textoNaTela !== undefined ||
    scene.acao !== undefined ||
    scene.transicao !== undefined ||
    scene.pose !== undefined ||
    scene.expressao !== undefined ||
    scene.cenario !== undefined ||
    scene.assets !== undefined;
  const material = JSON.stringify(
    temExtraVisual
      ? [
          scene.narracao,
          scene.promptImagem,
          brief.estilo,
          brief.idioma,
          brief.formato,
          {
            ...(scene.textoNaTela !== undefined ? { textoNaTela: scene.textoNaTela } : {}),
            ...(scene.acao !== undefined ? { acao: scene.acao } : {}),
            ...(scene.transicao !== undefined ? { transicao: scene.transicao } : {}),
            ...(scene.pose !== undefined ? { pose: scene.pose } : {}),
            ...(scene.expressao !== undefined ? { expressao: scene.expressao } : {}),
            ...(scene.cenario !== undefined ? { cenario: scene.cenario } : {}),
            ...(scene.assets !== undefined ? { assets: scene.assets } : {}),
          },
        ]
      : [scene.narracao, scene.promptImagem, brief.estilo, brief.idioma, brief.formato],
  );
  return createHash('sha256').update(material).digest('hex');
}
