// Registro de templates do estúdio Remotion.
// Para adicionar um novo exemplo visual:
// 1. Crie o componente em services/video-studio/src/templates/MeuExemploTemplate.tsx
// 2. Registre o mesmo ID aqui em TEMPLATE_REGISTRY e em src/video/templates.ts

import type { ComponentType } from 'react';
import type { TemplateComponentProps } from '../types';
import { AdCreativeTemplate } from './AdCreativeTemplate';
import { ComicExplainerTemplate } from './ComicExplainerTemplate';
import { CozyStoryTemplate } from './CozyStoryTemplate';
import { DarkPhilosophyTemplate } from './DarkPhilosophyTemplate';
import { DarkScienceTemplate } from './DarkScienceTemplate';
import { EditorialFlowTemplate } from './EditorialFlowTemplate';
import { MotionGraphicsTemplate } from './MotionGraphicsTemplate';
import { PsychExplainerTemplate } from './PsychExplainerTemplate';
import { StickmanTemplate } from './StickmanTemplate';

export const TEMPLATE_REGISTRY: Readonly<Record<string, ComponentType<TemplateComponentProps>>> = {
  'stickman-2d': StickmanTemplate,
  'motion-graphics': MotionGraphicsTemplate,
  'ad-creative': AdCreativeTemplate,
  'editorial-flow': EditorialFlowTemplate,
  'dark-science-2d': DarkScienceTemplate,
  'comic-explainer-16x9': ComicExplainerTemplate,
  'cozy-story-16x9': CozyStoryTemplate,
  'dark-philosophy-16x9': DarkPhilosophyTemplate,
  'psych-explainer-16x9': PsychExplainerTemplate,
};

export function resolveStudioTemplate(id: string): ComponentType<TemplateComponentProps> {
  return TEMPLATE_REGISTRY[id] ?? MotionGraphicsTemplate;
}
