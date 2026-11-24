// Registro extensível de templates visuais do agente de vídeo.
// Cada novo exemplo de vídeo do Joel ganha uma entrada em VIDEO_TEMPLATES e um componente
// correspondente em services/video-studio/src/templates/. Código puro, sem banco nem rede.

export type VisualEngine = 'ffmpeg' | 'remotion';
export type TemplateImagePolicy = 'required' | 'optional' | 'none';
export type SceneTransition = 'cut' | 'fade' | 'slide' | 'zoom';
export type FontMood = 'bold-sans' | 'editorial' | 'handwritten';
export type CampaignVideoMode = 'inspiracao' | 'overlay-proprio';

export const VISUAL_ENGINES: readonly VisualEngine[] = ['ffmpeg', 'remotion'];
export const SCENE_TRANSITIONS: readonly SceneTransition[] = ['cut', 'fade', 'slide', 'zoom'];
export const FONT_MOODS: readonly FontMood[] = ['bold-sans', 'editorial', 'handwritten'];
export const CAMPAIGN_VIDEO_MODES: readonly CampaignVideoMode[] = ['inspiracao', 'overlay-proprio'];

export interface StylePalette {
  background: string;
  primary: string;
  accent: string;
  text: string;
}

export interface StyleRecipe {
  palette?: Partial<StylePalette>;
  cutsPerMinute?: number;
  hookMaxSec?: number;
  fontMood?: FontMood;
  sourceNote?: string;
}

export interface VideoTemplateSpec {
  id: string;
  nome: string;
  descricao: string;
  motorPadrao: VisualEngine;
  imagens: TemplateImagePolicy;
  formatos: readonly ('vertical' | 'horizontal')[];
  temaPadrao: StylePalette & { fontMood: FontMood };
  dicasDeRoteiro: string[];
}

export const VIDEO_TEMPLATES: Readonly<Record<string, VideoTemplateSpec>> = {
  'editorial-flow': {
    id: 'editorial-flow',
    nome: 'Editorial com Flow',
    descricao: 'Imagens geradas no Flow ou fotos próprias com câmera suave, títulos animados, legendas e zona segura.',
    motorPadrao: 'remotion',
    imagens: 'required',
    formatos: ['vertical', 'horizontal'],
    temaPadrao: {
      background: '#0F172A',
      primary: '#E2E8F0',
      accent: '#38BDF8',
      text: '#FFFFFF',
      fontMood: 'editorial',
    },
    dicasDeRoteiro: [
      'A cena 1 deve abrir com gancho visual e textoNaTela forte nos primeiros 3 segundos.',
      'Preencha textoNaTela com manchete curta (2 a 6 palavras) e promptImagem em inglês com estilo consistente.',
    ],
  },
  'motion-graphics': {
    id: 'motion-graphics',
    nome: 'Motion Graphics',
    descricao: 'Tipografia cinética, cartões animados, destaques visuais e legenda dinâmica sem depender de imagens externas.',
    motorPadrao: 'remotion',
    imagens: 'optional',
    formatos: ['vertical', 'horizontal'],
    temaPadrao: {
      background: '#0B1020',
      primary: '#A855F7',
      accent: '#22D3EE',
      text: '#F8FAFC',
      fontMood: 'bold-sans',
    },
    dicasDeRoteiro: [
      'Use textoNaTela curto e marcante (até 5 palavras em caixa alta ou destaque) em cada cena.',
      'Descreva o movimento em acao e escolha transicao entre cut, fade, slide e zoom.',
      'promptImagem pode ser vazio ("") quando a cena for totalmente gráfica.',
    ],
  },
  'stickman-2d': {
    id: 'stickman-2d',
    nome: 'Stickman 2D',
    descricao: 'Personagem stickman vetorial animado por quadro, expressões, objetos de cena e legenda dinâmica.',
    motorPadrao: 'remotion',
    imagens: 'none',
    formatos: ['vertical', 'horizontal'],
    temaPadrao: {
      background: '#F8FAFC',
      primary: '#0F172A',
      accent: '#EF4444',
      text: '#0F172A',
      fontMood: 'handwritten',
    },
    dicasDeRoteiro: [
      'Defina pose (idle, thinking, pointing, excited, shocked, walking, celebrating, floating) e expressao (neutral, happy, surprised, serious) em cada cena.',
      'Use assets com objetos simples quando ajudar (ball, clock, chart, phone, lightbulb, document).',
      'Deixe promptImagem vazio (""): o personagem é desenhado em código, sem gerar imagem no Flow.',
    ],
  },
  'ad-creative': {
    id: 'ad-creative',
    nome: 'Criativo de Anúncio',
    descricao:
      'Layout de resposta direta para ofertas low-ticket em dois modos: "inspiracao" (criativo 100% autoral modelado sobre referência do Radar) ou "overlay-proprio" (vídeo-base próprio/licenciado com troca de áudio e overlays).',
    motorPadrao: 'remotion',
    imagens: 'optional',
    formatos: ['vertical', 'horizontal'],
    temaPadrao: {
      background: '#111827',
      primary: '#F97316',
      accent: '#FACC15',
      text: '#FFFFFF',
      fontMood: 'bold-sans',
    },
    dicasDeRoteiro: [
      'Regra de campanha — use modoCampanha "inspiracao" para referências de terceiros/Radar (recriação 100% autoral) ou "overlay-proprio" apenas com vídeo próprio/licenciado (videoBase + videoBaseAutorizado: true + mutarVideoBase: true) trocando o áudio e adicionando overlays.',
      'Cena 1: gancho direto para a dor ou desejo do público nos primeiros 3 segundos (textoNaTela em caixa de destaque).',
      'Cenas do meio: demonstre mecanismo e entregável concreto (use assets para selos curtos de benefício) sem prometer ganho garantido.',
      'Última cena: chamada clara para ação em textoNaTela (ex.: "SAIBA MAIS" ou "CONHEÇA O GUIA").',
    ],
  },
  'dark-science-2d': {
    id: 'dark-science-2d',
    nome: 'Ciência Ilustrada 2D (Atmosférico)',
    descricao: 'Ilustração 2D atmosférica com traço em tinta escura, iluminação dramática, lentes circulares POV e legenda amarela com contorno.',
    motorPadrao: 'remotion',
    imagens: 'optional',
    formatos: ['vertical', 'horizontal'],
    temaPadrao: {
      background: '#13262F',
      primary: '#1E3A47',
      accent: '#FACC15',
      text: '#F8FAFC',
      fontMood: 'bold-sans',
    },
    dicasDeRoteiro: [
      'Defina cenario em cada cena ("lab", "microscope-pov", "cosmos-pov" ou "reveal") alternando planos abertos e lentes circulares.',
      'Use frases curtas e impactantes (legenda central amarela sem caixa de fundo) e textoNaTela opcional só para marcadores técnicos (ex.: "-272 °C").',
      'Defina pose ("observing", "holding-flask", "pointing", "amazed", "calm-seated", "thinking"), expressao e assets ("microscope", "tardigrade", "flask", "planet", "timer", "dna", "glass-shield").',
    ],
  },
  'comic-explainer-16x9': {
    id: 'comic-explainer-16x9',
    nome: 'Explicador Comic 2D (16:9)',
    descricao:
      'Ilustração 2D estilo tira/quadrinho com traço em tinta preta, paleta terrosa ocre/oliva, zoom-out em quadro aninhado e legenda amarela em caixa normal com contorno.',
    motorPadrao: 'remotion',
    imagens: 'optional',
    formatos: ['horizontal', 'vertical'],
    temaPadrao: {
      background: '#D8B76A',
      primary: '#6E8A57',
      accent: '#F5D838',
      text: '#1C1917',
      fontMood: 'bold-sans',
    },
    dicasDeRoteiro: [
      'Use cenario entre "savanna", "tree-roots", "nested-zoom" e "timeline" (ou anexe ilustrações 16:9 em traço preto e cores terrosas).',
      'Use transicao "zoom" ou cenario "nested-zoom" para o efeito de câmera recuando em quadro aninhado (escala de cena).',
      'Escreva narração em frases curtas e diretas (legenda amarela na base sem caixa de fundo); textoNaTela é opcional para rótulos curtos.',
    ],
  },
  'cozy-story-16x9': {
    id: 'cozy-story-16x9',
    nome: 'Narrativa Cozy 2D (16:9)',
    descricao:
      'Ilustração 2D aconchegante com iluminação dourada, cenários detalhados de escritório/café, câmera Ken Burns suave e legenda itálica branca com destaque amarelo por palavra-chave.',
    motorPadrao: 'remotion',
    imagens: 'optional',
    formatos: ['horizontal', 'vertical'],
    temaPadrao: {
      background: '#E7D5B8',
      primary: '#8FA876',
      accent: '#FDE047',
      text: '#FFFFFF',
      fontMood: 'bold-sans',
    },
    dicasDeRoteiro: [
      'Defina cenario entre "office", "cafe", "research" e "living-room" (ou anexe ilustrações 16:9 em tons quentes âmbar/madeira).',
      'Use frases conversacionais em ritmo calmo; a legenda itálica inferior destaca automaticamente palavras-chave em amarelo (ou envolva uma palavra com *asteriscos* para forçar destaque).',
      'Mantenha textoNaTela opcional e curto (ex.: título de capítulo ou número-chave) para não poluir o cenário.',
    ],
  },
  'dark-philosophy-16x9': {
    id: 'dark-philosophy-16x9',
    nome: 'Filosofia Dark Cinema (2.39:1)',
    descricao:
      'Ensaio filosófico dark com barras cinematográficas 2.39:1, pinturas clássicas a óleo e gravuras em pergaminho, movimento Ken Burns contemplativo e tela limpa sem legendas intrusivas.',
    motorPadrao: 'remotion',
    imagens: 'optional',
    formatos: ['horizontal', 'vertical'],
    temaPadrao: {
      background: '#0B0A08',
      primary: '#C59B5F',
      accent: '#DED1B1',
      text: '#F2E8CF',
      fontMood: 'editorial',
    },
    dicasDeRoteiro: [
      'Use cenario entre "chiaroscuro", "engraving" e "classical-hall" (ou anexe pinturas clássicas a óleo e gravuras vintage em 16:9).',
      'Mantenha textoNaTela vazio na maioria das cenas para preservar a obra limpa; use apenas para títulos de capítulo ou epígrafes curtas em caixa alta.',
      'Escreva narração contemplativa com ritmo pausado; o template não sobrepõe legendas pop (para legendas editoriais discretas opcionais, inclua "captions" em assets).',
    ],
  },
  'psych-explainer-16x9': {
    id: 'psych-explainer-16x9',
    nome: 'Psicologia Cartoon 2D (16:9)',
    descricao:
      'Ilustração 2D em traço preto marcante sobre fundos pastel variados (azul, amarelo, cinza), diagramas didáticos com balões e legenda itálica branca com destaque amarelo ampliado na palavra falada.',
    motorPadrao: 'remotion',
    imagens: 'optional',
    formatos: ['horizontal', 'vertical'],
    temaPadrao: {
      background: '#B8E6EC',
      primary: '#2563EB',
      accent: '#FFEE00',
      text: '#FFFFFF',
      fontMood: 'bold-sans',
    },
    dicasDeRoteiro: [
      'Alterne cenario entre "study-desk", "brain-diagram", "panic-desk" e "flashcard" (ou anexe ilustrações cartoon 2D 16:9 em traço preto forte sobre fundo pastel).',
      'Use textoNaTela curto (2 a 5 palavras) para rótulos diegéticos dentro da cena: cartaz na parede, balão de fala ou cartão de estudo.',
      'Escreva frases conversacionais em ritmo ágil; a legenda inferior destaca e amplia automaticamente a palavra-chave falada em amarelo (ou envolva uma palavra com *asteriscos*).',
    ],
  },
};

const ALIASES: Readonly<Record<string, string>> = {
  stickman: 'stickman-2d',
  'stickman-2d': 'stickman-2d',
  palito: 'stickman-2d',
  boneco: 'stickman-2d',
  motion: 'motion-graphics',
  'motion-graphics': 'motion-graphics',
  cinetico: 'motion-graphics',
  ad: 'ad-creative',
  anuncio: 'ad-creative',
  criativo: 'ad-creative',
  'ad-creative': 'ad-creative',
  'low-ticket': 'ad-creative',
  editorial: 'editorial-flow',
  flow: 'editorial-flow',
  'editorial-flow': 'editorial-flow',
  'dark-science': 'dark-science-2d',
  'dark-science-2d': 'dark-science-2d',
  cientifico: 'dark-science-2d',
  ciencia: 'dark-science-2d',
  'ilustrado-escuro': 'dark-science-2d',
  'historia-ilustrada': 'dark-science-2d',
  'comic-explainer-16x9': 'comic-explainer-16x9',
  'comic-explainer': 'comic-explainer-16x9',
  quadrinho: 'comic-explainer-16x9',
  quadrinhos: 'comic-explainer-16x9',
  'explicador-comic': 'comic-explainer-16x9',
  'historia-comic': 'comic-explainer-16x9',
  'tira-2d': 'comic-explainer-16x9',
  'cozy-story-16x9': 'cozy-story-16x9',
  'cozy-story': 'cozy-story-16x9',
  'narrativa-quente': 'cozy-story-16x9',
  negocios: 'cozy-story-16x9',
  financas: 'cozy-story-16x9',
  dinheiro: 'cozy-story-16x9',
  storybook: 'cozy-story-16x9',
  'dark-philosophy-16x9': 'dark-philosophy-16x9',
  'dark-philosophy': 'dark-philosophy-16x9',
  filosofia: 'dark-philosophy-16x9',
  'filosofia-dark': 'dark-philosophy-16x9',
  bygone: 'dark-philosophy-16x9',
  estoico: 'dark-philosophy-16x9',
  estoicismo: 'dark-philosophy-16x9',
  'ensaio-classico': 'dark-philosophy-16x9',
  'cinema-dark': 'dark-philosophy-16x9',
  'pintura-classica': 'dark-philosophy-16x9',
  'psych-explainer-16x9': 'psych-explainer-16x9',
  'psych-explainer': 'psych-explainer-16x9',
  psicologia: 'psych-explainer-16x9',
  neurociencia: 'psych-explainer-16x9',
  'deep-primate': 'psych-explainer-16x9',
  primate: 'psych-explainer-16x9',
  aprendizado: 'psych-explainer-16x9',
  'cartoon-explainer': 'psych-explainer-16x9',
  'explicador-psicologia': 'psych-explainer-16x9',
};

function normalizarTexto(valor: string): string {
  return valor
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function escapeRegExp(valor: string): string {
  return valor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const ALIAS_ENTRIES_ORDENADAS = Object.entries(ALIASES).sort((a, b) => b[0].length - a[0].length);

/** Busca o template exato pelo ID; retorna null se não existir. */
export function getVideoTemplate(id: string | undefined | null): VideoTemplateSpec | null {
  if (typeof id !== 'string') return null;
  const chave = id.trim();
  if (chave === '') return null;
  return VIDEO_TEMPLATES[chave] ?? null;
}

/** Lista todos os templates registrados, na ordem de cadastro. */
export function listVideoTemplates(): VideoTemplateSpec[] {
  return Object.values(VIDEO_TEMPLATES);
}

/**
 * Resolve o template mais adequado a partir de um ID ou texto de estilo livre
 * ("stickman", "anúncio low-ticket", "motion graphics", "editorial", "científico").
 */
export function resolveTemplateForStyle(styleText: string | undefined | null): VideoTemplateSpec | null {
  if (typeof styleText !== 'string') return null;
  const limpo = styleText.trim();
  if (limpo === '') return null;

  const direto = getVideoTemplate(limpo);
  if (direto) return direto;

  const norm = normalizarTexto(limpo);
  const porAlias = ALIASES[norm];
  if (porAlias) return getVideoTemplate(porAlias);

  for (const [alias, id] of ALIAS_ENTRIES_ORDENADAS) {
    const pattern = escapeRegExp(alias).replace(/-/g, '[-\\s]+');
    const re = new RegExp(`(?:^|[^a-z0-9])${pattern}(?:$|[^a-z0-9])`);
    if (re.test(norm)) return getVideoTemplate(id);
  }
  return null;
}

/**
 * Indica se o template exige imagens anexadas antes do render final.
 * Legado (sem templateVisual) ou desconhecido continua exigindo Flow como antes.
 */
export function templateRequiresImages(templateId: string | undefined | null): boolean {
  const spec = getVideoTemplate(templateId);
  if (spec === null) return true;
  return spec.imagens === 'required';
}
