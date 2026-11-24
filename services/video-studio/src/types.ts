export type VisualTemplateId =
  | 'editorial-flow'
  | 'motion-graphics'
  | 'stickman-2d'
  | 'ad-creative'
  | 'dark-science-2d'
  | 'comic-explainer-16x9'
  | 'cozy-story-16x9'
  | 'dark-philosophy-16x9'
  | 'psych-explainer-16x9'
  | string;

export type SceneTransition = 'cut' | 'fade' | 'slide' | 'zoom';
export type FontMood = 'bold-sans' | 'editorial' | 'handwritten';

export interface StudioTheme {
  background: string;
  primary: string;
  accent: string;
  text: string;
  fontMood: FontMood;
}

export interface StudioScene {
  n: number;
  durationSec: number;
  narracao: string;
  textoNaTela?: string;
  acao?: string;
  transicao?: SceneTransition;
  assets?: string[];
  pose?: string;
  expressao?: string;
  cenario?: string;
  imageUrl?: string | null;
  audioUrl?: string | null;
  cta?: boolean;
}

export interface StudioProps extends Record<string, unknown> {
  jobId: string;
  titulo: string;
  width: number;
  height: number;
  fps: number;
  preview: boolean;
  templateId: VisualTemplateId;
  theme: StudioTheme;
  musicUrl?: string | null;
  scenes: StudioScene[];
}

export interface TemplateComponentProps {
  scene: StudioScene;
  sceneIndex: number;
  totalScenes: number;
  durationInFrames: number;
  theme: StudioTheme;
  titulo: string;
}

export const FONT_STACKS: Record<FontMood, string> = {
  'bold-sans': '"Segoe UI", "Inter", "Arial Black", sans-serif',
  editorial: '"Georgia", "Times New Roman", serif',
  handwritten: '"Comic Sans MS", "Segoe Print", "Trebuchet MS", sans-serif',
};
