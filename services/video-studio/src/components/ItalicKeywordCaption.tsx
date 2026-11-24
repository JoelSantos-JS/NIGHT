import { interpolate, useCurrentFrame } from 'remotion';
import { buildCaptionChunks } from './OutlinedCaption';
import { useStudioScale } from './scale';

export interface ItalicKeywordCaptionProps {
  text: string;
  durationInFrames: number;
  textColor?: string;
  accentColor?: string;
  popActiveWord?: boolean;
}

interface ParsedWord {
  label: string;
  explicit: boolean;
  weight: number;
}

function parseChunkWords(chunkText: string): ParsedWord[] {
  return chunkText
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((raw) => {
      const explicit = /\*[^*\s]+/.test(raw);
      const label = raw.replace(/\*/g, '');
      return {
        label,
        explicit,
        weight: Math.max(2, label.replace(/[^\p{L}\p{N}]/gu, '').length),
      };
    })
    .filter((w) => w.label.length > 0);
}

function activeSpokenWordIndex(words: ParsedWord[], chunkFrame: number, chunkLen: number): number {
  if (words.length <= 1) return 0;
  const totalWeight = words.reduce((sum, w) => sum + w.weight, 0);
  const progress = Math.min(0.9999, Math.max(0, chunkFrame / Math.max(1, chunkLen)));
  const target = progress * totalWeight;
  let acc = 0;
  for (let i = 0; i < words.length; i++) {
    acc += words[i]!.weight;
    if (target <= acc) return i;
  }
  return words.length - 1;
}

/**
 * Legenda itálica limpa na base da tela: mistura texto branco com destaque amarelo
 * na palavra-chave falada ou marcada com *asteriscos*, sem caixa de fundo.
 */
export function ItalicKeywordCaption({
  text,
  durationInFrames,
  textColor = '#FFFFFF',
  accentColor = '#FDE047',
  popActiveWord = false,
}: ItalicKeywordCaptionProps) {
  const frame = useCurrentFrame();
  const { s, isVertical } = useStudioScale();
  const chunks = buildCaptionChunks(text, Math.max(1, durationInFrames), 4);
  if (chunks.length === 0) return null;

  const active =
    chunks.find((c) => frame >= c.startFrame && frame < c.endFrame) ?? chunks[chunks.length - 1]!;
  const words = parseChunkWords(active.text);
  if (words.length === 0) return null;

  const localFrame = Math.max(0, frame - active.startFrame);
  const chunkLen = Math.max(1, active.endFrame - active.startFrame);
  const scale = interpolate(localFrame, [0, 4], [0.95, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  const hasExplicit = words.some((w) => w.explicit);
  const spokenIndex = activeSpokenWordIndex(words, localFrame, chunkLen);

  const fontSize = popActiveWord
    ? (isVertical ? 50 : 48) * s
    : (isVertical ? 54 : 52) * s;
  const stroke = Math.max(3, (popActiveWord ? 10 : 9) * s);
  const strokeColor = popActiveWord ? '#0A0A0A' : '#140F0B';

  return (
    <div
      style={{
        position: 'absolute',
        left: (isVertical ? 64 : 96) * s,
        right: (isVertical ? 96 : 96) * s,
        top: isVertical ? '78%' : '86%',
        transform: `translateY(-50%) scale(${scale})`,
        textAlign: 'center',
        pointerEvents: 'none',
        zIndex: 30,
      }}
    >
      <span
        style={{
          fontFamily: '"Segoe UI", "Montserrat", "Arial", sans-serif',
          fontStyle: 'italic',
          fontWeight: popActiveWord ? 900 : 800,
          fontSize,
          lineHeight: 1.15,
          letterSpacing: '-0.01em',
          WebkitTextStroke: `${stroke}px ${strokeColor}`,
          paintOrder: 'stroke fill',
          textShadow: `0 ${4 * s}px ${12 * s}px rgba(10, 6, 4, 0.88)`,
          display: 'inline-block',
        }}
      >
        {words.map((word, idx) => {
          const highlighted = hasExplicit ? word.explicit : idx === spokenIndex;
          const popStyle =
            popActiveWord && highlighted
              ? {
                  fontSize: fontSize * 1.24,
                  lineHeight: 1,
                  display: 'inline-block',
                  transform: `translateY(${-2 * s}px)`,
                }
              : undefined;
          return (
            <span key={`${idx}-${word.label}`}>
              {idx > 0 ? ' ' : null}
              <span
                style={{
                  color: highlighted ? accentColor : textColor,
                  ...popStyle,
                }}
              >
                {word.label}
              </span>
            </span>
          );
        })}
      </span>
    </div>
  );
}
