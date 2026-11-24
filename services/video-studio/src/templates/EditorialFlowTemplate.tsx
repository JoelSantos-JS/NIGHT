import { AbsoluteFill, Img, interpolate, useCurrentFrame } from 'remotion';
import { DynamicCaption } from '../components/DynamicCaption';
import { HookTitle } from '../components/HookTitle';
import { SafeZone } from '../components/SafeZone';
import type { TemplateComponentProps } from '../types';

export function EditorialFlowTemplate({
  scene,
  sceneIndex,
  durationInFrames,
  theme,
}: TemplateComponentProps) {
  const frame = useCurrentFrame();
  const zoomIn = scene.n % 2 === 1;
  const scale = interpolate(
    frame,
    [0, Math.max(1, durationInFrames - 1)],
    zoomIn ? [1.0, 1.08] : [1.08, 1.0],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' },
  );
  const panX = interpolate(
    frame,
    [0, Math.max(1, durationInFrames - 1)],
    zoomIn ? [-8, 8] : [8, -8],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' },
  );

  return (
    <AbsoluteFill style={{ backgroundColor: theme.background, overflow: 'hidden' }}>
      {scene.imageUrl ? (
        <AbsoluteFill style={{ transform: `scale(${scale}) translateX(${panX}px)` }}>
          <Img
            src={scene.imageUrl}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        </AbsoluteFill>
      ) : (
        <AbsoluteFill
          style={{
            background: `linear-gradient(160deg, ${theme.background} 0%, #1E293B 100%)`,
          }}
        />
      )}

      {/* Vinheta superior e inferior para garantir contraste de leitura */}
      <AbsoluteFill
        style={{
          background:
            'linear-gradient(180deg, rgba(2,6,23,0.68) 0%, rgba(2,6,23,0.12) 35%, rgba(2,6,23,0.18) 65%, rgba(2,6,23,0.78) 100%)',
        }}
      />

      <SafeZone>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <HookTitle text={scene.textoNaTela} theme={theme} isHook={sceneIndex === 0} variant="banner" />
        </div>
        <div style={{ flex: 1 }} />
        <DynamicCaption text={scene.narracao} durationInFrames={durationInFrames} theme={theme} />
      </SafeZone>
    </AbsoluteFill>
  );
}
