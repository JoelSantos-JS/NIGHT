import { interpolate, useCurrentFrame } from 'remotion';
import { useStudioScale } from './scale';

export interface OutlinedCaptionProps {
  text: string;
  durationInFrames: number;
  accentColor?: string;
  uppercase?: boolean;
  position?: 'mid-bottom' | 'bottom';
  maxWordsPerChunk?: number;
}

export interface CaptionChunk {
  text: string;
  startFrame: number;
  endFrame: number;
}

export function buildCaptionChunks(
  text: string,
  durationInFrames: number,
  maxWords = 3,
): CaptionChunk[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const limitWords = Math.max(1, maxWords);
  const maxChars = limitWords === 3 ? 18 : limitWords * 7;

  const groups: string[][] = [];
  let current: string[] = [];
  let chars = 0;

  for (const w of words) {
    if (current.length >= limitWords || (current.length >= 2 && chars + w.length > maxChars)) {
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
    chunks.push({ text: group.join(' '), startFrame, endFrame });
  }
  return chunks;
}

/**
 * Legenda centralizada amarela com contorno preto espesso e sem caixa de fundo.
 * Padrão ("mid-bottom", caixa alta) preserva o DarkScienceTemplate;
 * variante ("bottom", uppercase=false) atende o formato explicador 16:9.
 */
export function OutlinedCaption({
  text,
  durationInFrames,
  accentColor = '#FACC15',
  uppercase = true,
  position = 'mid-bottom',
  maxWordsPerChunk = 3,
}: OutlinedCaptionProps) {
  const frame = useCurrentFrame();
  const { s, isVertical } = useStudioScale();
  const chunks = buildCaptionChunks(text, Math.max(1, durationInFrames), maxWordsPerChunk);
  if (chunks.length === 0) return null;

  const active =
    chunks.find((c) => frame >= c.startFrame && frame < c.endFrame) ?? chunks[chunks.length - 1]!;
  const localFrame = Math.max(0, frame - active.startFrame);
  const scale = interpolate(localFrame, [0, 4], [0.92, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  const isBottom = position === 'bottom';
  const fontSize = (isVertical ? 58 : isBottom ? 56 : 54) * s;
  const stroke = Math.max(3, (isBottom ? 11 : 12) * s);
  const topPosition = isBottom ? (isVertical ? '78%' : '86%') : isVertical ? '65%' : '76%';

  return (
    <div
      style={{
        position: 'absolute',
        left: (isBottom && !isVertical ? 96 : 64) * s,
        right: (isVertical ? 96 : isBottom ? 96 : 64) * s,
        top: topPosition,
        transform: `translateY(-50%) scale(${scale})`,
        textAlign: 'center',
        pointerEvents: 'none',
        zIndex: 30,
      }}
    >
      <span
        style={{
          fontFamily: '"Arial Black", "Montserrat", "Segoe UI", sans-serif',
          fontWeight: 900,
          fontSize,
          lineHeight: 1.12,
          letterSpacing: '-0.01em',
          textTransform: uppercase ? 'uppercase' : 'none',
          color: accentColor,
          WebkitTextStroke: `${stroke}px #080B10`,
          paintOrder: 'stroke fill',
          textShadow: `0 ${5 * s}px ${14 * s}px rgba(0, 0, 0, 0.85)`,
          display: 'inline-block',
        }}
      >
        {active.text}
      </span>
    </div>
  );
}
