import { interpolate, useCurrentFrame } from 'remotion';
import { FONT_STACKS, type StudioTheme } from '../types';
import { useStudioScale } from './scale';

export interface DynamicCaptionProps {
  text: string;
  durationInFrames: number;
  theme: StudioTheme;
}

interface CaptionChunk {
  words: string[];
  startFrame: number;
  endFrame: number;
}

function buildChunks(text: string, durationInFrames: number): CaptionChunk[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const groups: string[][] = [];
  let current: string[] = [];
  let chars = 0;

  for (const w of words) {
    if (current.length >= 4 || (current.length >= 2 && chars + w.length > 22)) {
      groups.push(current);
      current = [w];
      chars = w.length;
    } else {
      current.push(w);
      chars += w.length + 1;
    }
  }
  if (current.length > 0) groups.push(current);

  const totalWeight = words.reduce((sum, w) => sum + Math.max(2, w.length), 0);
  const chunks: CaptionChunk[] = [];
  let accWeight = 0;

  for (const group of groups) {
    const groupWeight = group.reduce((sum, w) => sum + Math.max(2, w.length), 0);
    const startFrame = Math.floor((accWeight / totalWeight) * durationInFrames);
    accWeight += groupWeight;
    const endFrame = Math.max(startFrame + 1, Math.ceil((accWeight / totalWeight) * durationInFrames));
    chunks.push({ words: group, startFrame, endFrame });
  }
  return chunks;
}

export function DynamicCaption({ text, durationInFrames, theme }: DynamicCaptionProps) {
  const frame = useCurrentFrame();
  const { s } = useStudioScale();
  const chunks = buildChunks(text, Math.max(1, durationInFrames));
  if (chunks.length === 0) return null;

  const activeChunk =
    chunks.find((c) => frame >= c.startFrame && frame < c.endFrame) ?? chunks[chunks.length - 1]!;
  const chunkSpan = Math.max(1, activeChunk.endFrame - activeChunk.startFrame);
  const localProgress = interpolate(frame, [activeChunk.startFrame, activeChunk.endFrame], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const activeWordIdx = Math.min(
    activeChunk.words.length - 1,
    Math.floor(localProgress * activeChunk.words.length),
  );
  const popScale = interpolate(
    frame - activeChunk.startFrame,
    [0, Math.min(4, chunkSpan)],
    [0.95, 1],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' },
  );

  return (
    <div
      style={{
        alignSelf: 'center',
        maxWidth: '96%',
        padding: `${14 * s}px ${24 * s}px`,
        borderRadius: 18 * s,
        backgroundColor: 'rgba(2, 6, 23, 0.84)',
        border: `${2 * s}px solid rgba(255,255,255,0.18)`,
        boxShadow: `0 ${10 * s}px ${24 * s}px rgba(0,0,0,0.4)`,
        transform: `scale(${popScale})`,
        textAlign: 'center',
      }}
    >
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          justifyContent: 'center',
          gap: `${10 * s}px`,
          fontFamily: FONT_STACKS[theme.fontMood === 'editorial' ? 'bold-sans' : theme.fontMood],
          fontWeight: 800,
          fontSize: 42 * s,
          lineHeight: 1.2,
        }}
      >
        {activeChunk.words.map((word, idx) => {
          const highlighted = idx === activeWordIdx;
          return (
            <span
              key={`${activeChunk.startFrame}-${idx}`}
              style={{
                color: highlighted ? '#0F172A' : '#F8FAFC',
                backgroundColor: highlighted ? theme.accent : 'transparent',
                padding: highlighted ? `${2 * s}px ${10 * s}px` : `${2 * s}px ${2 * s}px`,
                borderRadius: 10 * s,
              }}
            >
              {word}
            </span>
          );
        })}
      </div>
    </div>
  );
}
