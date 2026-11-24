import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { FONT_STACKS, type StudioTheme } from '../types';
import { useStudioScale } from './scale';

export interface HookTitleProps {
  text?: string;
  theme: StudioTheme;
  isHook?: boolean;
  variant?: 'pill' | 'banner' | 'minimal';
}

export function HookTitle({ text, theme, isHook = false, variant = 'banner' }: HookTitleProps) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { s } = useStudioScale();

  if (!text || text.trim() === '') return null;

  const enter = spring({
    frame,
    fps,
    config: { damping: 14, stiffness: 160, mass: 0.7 },
  });
  const translateY = interpolate(enter, [0, 1], [-24 * s, 0]);
  const scale = interpolate(enter, [0, 1], [0.92, 1]);
  const opacity = interpolate(frame, [0, 6], [0, 1], { extrapolateRight: 'clamp' });

  const bg = variant === 'minimal'
    ? 'transparent'
    : isHook
      ? theme.accent
      : 'rgba(15, 23, 42, 0.78)';
  const fg = variant === 'minimal'
    ? theme.text
    : isHook
      ? '#0F172A'
      : '#FFFFFF';

  return (
    <div
      style={{
        opacity,
        transform: `translateY(${translateY}px) scale(${scale})`,
        alignSelf: 'center',
        maxWidth: '100%',
        padding: variant === 'minimal' ? `${8 * s}px ${12 * s}px` : `${16 * s}px ${28 * s}px`,
        borderRadius: (variant === 'pill' ? 999 : 20) * s,
        backgroundColor: bg,
        border: variant === 'minimal' ? 'none' : `${3 * s}px solid ${isHook ? theme.primary : theme.accent}`,
        boxShadow: variant === 'minimal' ? 'none' : `0 ${12 * s}px ${28 * s}px rgba(0,0,0,0.28)`,
        textAlign: 'center',
      }}
    >
      <span
        style={{
          fontFamily: FONT_STACKS[theme.fontMood],
          fontWeight: 800,
          fontSize: (isHook ? 52 : 44) * s,
          lineHeight: 1.15,
          letterSpacing: '-0.02em',
          color: fg,
          textShadow: variant === 'minimal' ? `0 ${3 * s}px ${10 * s}px rgba(0,0,0,0.45)` : 'none',
        }}
      >
        {text.trim()}
      </span>
    </div>
  );
}
