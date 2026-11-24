import type { ReactNode } from 'react';
import { AbsoluteFill, Audio, Series, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import { ProgressBar } from './components/ProgressBar';
import { resolveStudioTemplate } from './templates/registry';
import type { SceneTransition, StudioProps, StudioScene } from './types';

function SceneTransitionWrapper({
  transition,
  children,
}: {
  transition?: SceneTransition;
  children: ReactNode;
}) {
  const frame = useCurrentFrame();
  const { width } = useVideoConfig();

  if (!transition || transition === 'cut') {
    return <AbsoluteFill>{children}</AbsoluteFill>;
  }
  if (transition === 'fade') {
    // Começa em 0.18 para evitar quadro totalmente preto em detectores de blackframe.
    const opacity = interpolate(frame, [0, 7], [0.18, 1], { extrapolateRight: 'clamp' });
    return <AbsoluteFill style={{ opacity }}>{children}</AbsoluteFill>;
  }
  if (transition === 'slide') {
    const tx = interpolate(frame, [0, 9], [width * 0.18, 0], { extrapolateRight: 'clamp' });
    const opacity = interpolate(frame, [0, 7], [0.25, 1], { extrapolateRight: 'clamp' });
    return (
      <AbsoluteFill style={{ opacity, transform: `translateX(${tx}px)` }}>
        {children}
      </AbsoluteFill>
    );
  }
  const scale = interpolate(frame, [0, 9], [1.08, 1], { extrapolateRight: 'clamp' });
  const opacity = interpolate(frame, [0, 7], [0.25, 1], { extrapolateRight: 'clamp' });
  return (
    <AbsoluteFill style={{ opacity, transform: `scale(${scale})` }}>
      {children}
    </AbsoluteFill>
  );
}

export function sceneDurationInFrames(scene: StudioScene, fps: number): number {
  return Math.max(1, Math.round(scene.durationSec * fps));
}

export function totalCompositionFrames(props: Pick<StudioProps, 'scenes' | 'fps'>): number {
  const total = props.scenes.reduce((sum, s) => sum + sceneDurationInFrames(s, props.fps), 0);
  return Math.max(1, total);
}

const CLEAN_CHROME_TEMPLATES = new Set([
  'comic-explainer-16x9',
  'cozy-story-16x9',
  'dark-philosophy-16x9',
  'psych-explainer-16x9',
]);

export function VideoComposition(props: StudioProps) {
  const Template = resolveStudioTemplate(props.templateId);
  const hasNarration = props.scenes.some((s) => Boolean(s.audioUrl));
  const hideProgressBar = CLEAN_CHROME_TEMPLATES.has(props.templateId);

  return (
    <AbsoluteFill style={{ backgroundColor: props.theme.background }}>
      <Series>
        {props.scenes.map((scene, index) => {
          const durationInFrames = sceneDurationInFrames(scene, props.fps);
          return (
            <Series.Sequence key={scene.n} durationInFrames={durationInFrames}>
              <SceneTransitionWrapper transition={scene.transicao}>
                <Template
                  scene={scene}
                  sceneIndex={index}
                  totalScenes={props.scenes.length}
                  durationInFrames={durationInFrames}
                  theme={props.theme}
                  titulo={props.titulo}
                  muteBaseVideo={props.muteBaseVideo ?? true}
                />
              </SceneTransitionWrapper>
              {scene.audioUrl ? <Audio src={scene.audioUrl} /> : null}
            </Series.Sequence>
          );
        })}
      </Series>

      {props.musicUrl ? (
        <Audio src={props.musicUrl} volume={hasNarration ? 0.12 : 0.25} loop />
      ) : null}

      {hideProgressBar ? null : <ProgressBar accent={props.theme.accent} />}
    </AbsoluteFill>
  );
}
