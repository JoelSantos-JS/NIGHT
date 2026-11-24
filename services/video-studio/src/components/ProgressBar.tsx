import { interpolate, useCurrentFrame, useVideoConfig } from 'remotion';

export interface ProgressBarProps {
  accent: string;
}

export function ProgressBar({ accent }: ProgressBarProps) {
  const frame = useCurrentFrame();
  const { durationInFrames, width } = useVideoConfig();
  const progress = interpolate(frame, [0, Math.max(1, durationInFrames - 1)], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const height = Math.max(4, Math.round(width * 0.006));

  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        height,
        backgroundColor: 'rgba(255,255,255,0.16)',
        zIndex: 50,
      }}
    >
      <div
        style={{
          width: `${(progress * 100).toFixed(2)}%`,
          height: '100%',
          backgroundColor: accent,
        }}
      />
    </div>
  );
}
