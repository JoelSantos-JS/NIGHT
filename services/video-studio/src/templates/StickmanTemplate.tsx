import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { DynamicCaption } from '../components/DynamicCaption';
import { HookTitle } from '../components/HookTitle';
import { SafeZone } from '../components/SafeZone';
import { StickmanSvg } from '../components/StickmanSvg';
import { useStudioScale } from '../components/scale';
import type { TemplateComponentProps } from '../types';

export function StickmanTemplate({
  scene,
  sceneIndex,
  durationInFrames,
  theme,
}: TemplateComponentProps) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { s } = useStudioScale();

  const stageEnter = spring({
    frame,
    fps,
    config: { damping: 16, stiffness: 120 },
  });
  const stageY = interpolate(stageEnter, [0, 1], [18 * s, 0]);

  return (
    <AbsoluteFill
      style={{
        backgroundColor: theme.background,
        backgroundImage: `radial-gradient(rgba(15, 23, 42, 0.12) ${1.5 * s}px, transparent ${1.5 * s}px)`,
        backgroundSize: `${28 * s}px ${28 * s}px`,
      }}
    >
      <SafeZone>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 * s, alignItems: 'center' }}>
          <HookTitle text={scene.textoNaTela} theme={theme} isHook={sceneIndex === 0} variant="banner" />
        </div>

        <div
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            transform: `translateY(${stageY}px)`,
          }}
        >
          <StickmanSvg
            pose={scene.pose}
            expressao={scene.expressao}
            assets={scene.assets}
            strokeColor={theme.primary}
            accentColor={theme.accent}
          />
        </div>

        <DynamicCaption text={scene.narracao} durationInFrames={durationInFrames} theme={theme} />
      </SafeZone>
    </AbsoluteFill>
  );
}
