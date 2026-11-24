import { AbsoluteFill, Img, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { DynamicCaption } from '../components/DynamicCaption';
import { HookTitle } from '../components/HookTitle';
import { SafeZone } from '../components/SafeZone';
import { useStudioScale } from '../components/scale';
import { FONT_STACKS, type TemplateComponentProps } from '../types';

export function AdCreativeTemplate({
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

  const isHook = sceneIndex === 0;
  const isCta = scene.cta === true || sceneIndex === totalScenes - 1;
  const floatY = Math.sin(frame * 0.08) * 8 * s;

  const ctaEnter = spring({
    frame: Math.max(0, frame - 4),
    fps,
    config: { damping: 12, stiffness: 150 },
  });
  const ctaPulse = isCta ? 1 + Math.sin(frame * 0.18) * 0.025 : 1;

  return (
    <AbsoluteFill
      style={{
        background: `linear-gradient(170deg, ${theme.background} 0%, #1F2937 55%, #090D16 100%)`,
        overflow: 'hidden',
      }}
    >
      {/* Faixa diagonal decorativa */}
      <div
        style={{
          position: 'absolute',
          top: 220 * s,
          left: -140 * s,
          right: -140 * s,
          height: 220 * s,
          transform: 'rotate(-8deg)',
          background: `linear-gradient(90deg, transparent 0%, ${theme.primary}22 50%, transparent 100%)`,
        }}
      />

      <SafeZone>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 * s, alignItems: 'center' }}>
          <HookTitle
            text={isHook ? (scene.textoNaTela ?? titulo) : scene.textoNaTela}
            theme={theme}
            isHook={isHook}
            variant="banner"
          />
        </div>

        <div
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 24 * s,
          }}
        >
          {scene.imageUrl ? (
            <div
              style={{
                width: (isVertical ? 760 : 620) * s,
                height: (isVertical ? 640 : 420) * s,
                borderRadius: 28 * s,
                overflow: 'hidden',
                border: `${4 * s}px solid ${theme.accent}`,
                boxShadow: `0 ${24 * s}px ${56 * s}px rgba(0,0,0,0.55)`,
                transform: `translateY(${floatY}px)`,
              }}
            >
              <Img src={scene.imageUrl} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            </div>
          ) : (
            <div
              style={{
                width: '94%',
                padding: `${34 * s}px ${32 * s}px`,
                borderRadius: 26 * s,
                backgroundColor: 'rgba(255,255,255,0.06)',
                border: `${2.5 * s}px solid ${isCta ? theme.accent : theme.primary}`,
                textAlign: 'center',
                transform: `translateY(${floatY * 0.5}px)`,
              }}
            >
              <div
                style={{
                  fontFamily: FONT_STACKS['bold-sans'],
                  fontWeight: 800,
                  fontSize: 42 * s,
                  lineHeight: 1.22,
                  color: '#F8FAFC',
                }}
              >
                {scene.acao?.trim() || scene.textoNaTela?.trim() || titulo}
              </div>
            </div>
          )}

          {isCta ? (
            <div
              style={{
                transform: `scale(${interpolate(ctaEnter, [0, 1], [0.82, 1]) * ctaPulse})`,
                padding: `${18 * s}px ${40 * s}px`,
                borderRadius: 999,
                backgroundColor: theme.accent,
                color: '#0F172A',
                fontFamily: FONT_STACKS['bold-sans'],
                fontWeight: 900,
                fontSize: 38 * s,
                boxShadow: `0 ${14 * s}px ${32 * s}px rgba(0,0,0,0.45)`,
              }}
            >
              {scene.textoNaTela?.trim() || 'SAIBA MAIS'}
            </div>
          ) : null}
        </div>

        <DynamicCaption text={scene.narracao} durationInFrames={durationInFrames} theme={theme} />
      </SafeZone>
    </AbsoluteFill>
  );
}
