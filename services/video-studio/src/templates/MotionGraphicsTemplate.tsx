import { AbsoluteFill, Img, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { DynamicCaption } from '../components/DynamicCaption';
import { SafeZone } from '../components/SafeZone';
import { useStudioScale } from '../components/scale';
import { FONT_STACKS, type TemplateComponentProps } from '../types';

export function MotionGraphicsTemplate({
  scene,
  sceneIndex,
  totalScenes,
  durationInFrames,
  theme,
  titulo,
}: TemplateComponentProps) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { s, isVertical } = useStudioScale();

  const pop = spring({
    frame,
    fps,
    config: { damping: 14, stiffness: 145, mass: 0.75 },
  });
  const cardScale = interpolate(pop, [0, 1], [0.9, 1]);
  const cardOpacity = interpolate(frame, [0, 8], [0.2, 1], { extrapolateRight: 'clamp' });
  const orbX = Math.sin(frame * 0.04 + sceneIndex) * 40 * s;
  const orbY = Math.cos(frame * 0.03 + sceneIndex) * 32 * s;
  const headline = scene.textoNaTela?.trim() || titulo;

  return (
    <AbsoluteFill
      style={{
        background: `linear-gradient(155deg, ${theme.background} 0%, #1E1B4B 60%, #0F172A 100%)`,
        overflow: 'hidden',
      }}
    >
      {/* Formas geométricas animadas de fundo */}
      <div
        style={{
          position: 'absolute',
          top: -80 * s + orbY,
          right: -60 * s + orbX,
          width: 460 * s,
          height: 460 * s,
          borderRadius: '50%',
          background: `radial-gradient(circle, ${theme.primary}55 0%, transparent 70%)`,
        }}
      />
      <div
        style={{
          position: 'absolute',
          bottom: 140 * s - orbY,
          left: -100 * s - orbX,
          width: 420 * s,
          height: 420 * s,
          borderRadius: '50%',
          background: `radial-gradient(circle, ${theme.accent}44 0%, transparent 70%)`,
        }}
      />

      <SafeZone>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div
            style={{
              padding: `${8 * s}px ${18 * s}px`,
              borderRadius: 999,
              backgroundColor: 'rgba(255,255,255,0.12)',
              border: `${1.5 * s}px solid rgba(255,255,255,0.22)`,
              color: theme.accent,
              fontFamily: FONT_STACKS['bold-sans'],
              fontWeight: 700,
              fontSize: 22 * s,
              letterSpacing: '0.06em',
            }}
          >
            {String(sceneIndex + 1).padStart(2, '0')} / {String(totalScenes).padStart(2, '0')}
          </div>
        </div>

        <div
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 24 * s,
            opacity: cardOpacity,
            transform: `scale(${cardScale})`,
          }}
        >
          {scene.imageUrl ? (
            <div
              style={{
                width: (isVertical ? 680 : 540) * s,
                height: (isVertical ? 440 : 320) * s,
                borderRadius: 28 * s,
                overflow: 'hidden',
                border: `${3 * s}px solid ${theme.accent}`,
                boxShadow: `0 ${20 * s}px ${48 * s}px rgba(0,0,0,0.45)`,
              }}
            >
              <Img
                src={scene.imageUrl}
                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              />
            </div>
          ) : null}

          <div
            style={{
              width: '100%',
              padding: `${32 * s}px ${36 * s}px`,
              borderRadius: 28 * s,
              backgroundColor: 'rgba(15, 23, 42, 0.72)',
              border: `${2.5 * s}px solid ${sceneIndex === 0 ? theme.accent : 'rgba(255,255,255,0.18)'}`,
              boxShadow: `0 ${20 * s}px ${50 * s}px rgba(0,0,0,0.38)`,
              textAlign: 'center',
            }}
          >
            <div
              style={{
                fontFamily: FONT_STACKS[theme.fontMood],
                fontWeight: 900,
                fontSize: (sceneIndex === 0 ? 64 : 54) * s,
                lineHeight: 1.12,
                color: theme.text,
                letterSpacing: '-0.02em',
              }}
            >
              {headline}
            </div>
          </div>
        </div>

        <DynamicCaption text={scene.narracao} durationInFrames={durationInFrames} theme={theme} />
      </SafeZone>
    </AbsoluteFill>
  );
}
