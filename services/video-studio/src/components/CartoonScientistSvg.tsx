import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';

export interface CartoonScientistSvgProps {
  pose?: string;
  expressao?: string;
  accentColor?: string;
  /** Posição horizontal dentro do viewBox 0..1080. */
  x?: number;
  /** Posição vertical dentro do viewBox 0..1920. */
  y?: number;
  scale?: number;
}

const INK = '#0B0F17';
const SKIN = '#F3F6FA';
const SKIN_SHADE = '#CBD5E1';
const HAIR = '#3B2820';
const COAT = '#E2E8F0';
const COAT_SHADE = '#94A3B8';
const SHIRT = '#164E63';
const PANTS = '#1E293B';

/**
 * Personagem cientista 2D autoral com contorno em tinta escura e animação contínua por frame.
 */
export function CartoonScientistSvg({
  pose = 'observing',
  expressao = 'focused',
  accentColor = '#FACC15',
  x = 540,
  y = 1040,
  scale = 1,
}: CartoonScientistSvgProps) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const enter = spring({ frame, fps, config: { damping: 16, stiffness: 130 } });
  const pop = interpolate(enter, [0, 1], [0.94, 1]);
  const breathe = Math.sin(frame * 0.08) * 4;
  const armFloat = Math.sin(frame * 0.07) * 5;
  const blink = frame % 105 < 4;

  const p = pose.toLowerCase();
  const expr = expressao.toLowerCase();
  const isSeated = p.includes('seated') || p.includes('calm');
  const isFlask = p.includes('flask');
  const isPointing = p.includes('point');
  const isAmazed = p.includes('amaze') || p.includes('shock');
  const isThinking = p.includes('think');

  const leftArmD = isFlask
    ? `M -48 ${-160 + breathe} Q -115 ${-195 + armFloat} -122 ${-248 + armFloat}`
    : isAmazed
      ? `M -48 ${-160 + breathe} Q -115 ${-200 + armFloat} -118 ${-242 + armFloat}`
      : isSeated
        ? `M -48 ${-155 + breathe} Q -95 ${-85 + armFloat * 0.4} -106 ${-38}`
        : `M -48 ${-160 + breathe} Q -84 ${-110} -78 ${-58 + armFloat * 0.5}`;

  const rightArmD = isPointing
    ? `M 48 ${-160 + breathe} Q 125 ${-170 - armFloat * 0.5} 175 ${-198 - armFloat * 0.6}`
    : isAmazed
      ? `M 48 ${-160 + breathe} Q 115 ${-200 - armFloat} 118 ${-242 - armFloat}`
      : isThinking
        ? `M 48 ${-160 + breathe} Q 100 ${-168} 44 ${-218 + breathe}`
        : isSeated
          ? `M 48 ${-155 + breathe} Q 95 ${-85 - armFloat * 0.4} 106 ${-38}`
          : `M 48 ${-160 + breathe} Q 86 ${-108} 82 ${-56 - armFloat * 0.5}`;

  const mouth =
    expr === 'happy' || expr === 'calm'
      ? `M -16 ${-226 + breathe} Q 0 ${-212 + breathe} 16 ${-226 + breathe}`
      : expr === 'surprised' || expr === 'amazed'
        ? null
        : `M -14 ${-222 + breathe} Q 0 ${-225 + breathe} 14 ${-222 + breathe}`;

  return (
    <g transform={`translate(${x}, ${y}) scale(${scale * pop})`}>
      {/* Tapete/almofada quando sentado */}
      {isSeated ? (
        <ellipse cx={0} cy={128} rx={118} ry={34} fill="#334155" stroke={INK} strokeWidth={5.5} />
      ) : null}

      {/* Sombra sob o personagem */}
      <ellipse cx={0} cy={145} rx={isSeated ? 95 : 74} ry={16} fill="rgba(4, 9, 14, 0.45)" />

      {/* Pernas */}
      {isSeated ? (
        <g stroke={INK} strokeWidth={7} strokeLinecap="round" strokeLinejoin="round">
          <path d="M -30 -35 L -68 42 L -74 115" fill="none" stroke={PANTS} strokeWidth={24} />
          <path d="M 30 -35 L 68 42 L 74 115" fill="none" stroke={PANTS} strokeWidth={24} />
          <path d="M -30 -35 L -68 42 L -74 115" fill="none" stroke={INK} strokeWidth={6} />
          <path d="M 30 -35 L 68 42 L 74 115" fill="none" stroke={INK} strokeWidth={6} />
          <ellipse cx={-78} cy={124} rx={22} ry={11} fill="#E2E8F0" />
          <ellipse cx={78} cy={124} rx={22} ry={11} fill="#E2E8F0" />
        </g>
      ) : (
        <g stroke={INK} strokeWidth={6} strokeLinecap="round" strokeLinejoin="round">
          <rect x={-36} y={-40} width={28} height={162} rx={10} fill={PANTS} />
          <rect x={8} y={-40} width={28} height={162} rx={10} fill={PANTS} />
          <ellipse cx={-26} cy={128} rx={24} ry={11} fill="#CBD5E1" />
          <ellipse cx={26} cy={128} rx={24} ry={11} fill="#CBD5E1" />
        </g>
      )}

      {/* Jaleco e tronco */}
      <g stroke={INK} strokeWidth={6} strokeLinejoin="round">
        {/* Camisa interna */}
        <path d={`M -48 ${-175 + breathe} L 48 ${-175 + breathe} L 54 ${-28 + breathe} L -54 ${-28 + breathe} Z`} fill={SHIRT} />
        {/* Abas do jaleco */}
        <path
          d={`M -50 ${-175 + breathe} L -16 ${-175 + breathe} L -12 ${-20 + breathe} L -64 ${-18 + breathe} Z`}
          fill={COAT}
        />
        <path
          d={`M 50 ${-175 + breathe} L 16 ${-175 + breathe} L 12 ${-20 + breathe} L 64 ${-18 + breathe} Z`}
          fill={COAT}
        />
        {/* Sombra lateral do jaleco */}
        <path d={`M -62 ${-22 + breathe} L -48 ${-170 + breathe} L -38 ${-170 + breathe} L -48 ${-22 + breathe} Z`} fill={COAT_SHADE} stroke="none" />
        {/* Bolso + caneta */}
        <rect x={22} y={-132 + breathe} width={22} height={24} rx={3} fill="#CBD5E1" strokeWidth={4} />
        <line x1={32} y1={-144 + breathe} x2={32} y2={-130 + breathe} stroke={accentColor} strokeWidth={5} />
      </g>

      {/* Braços */}
      <path d={leftArmD} fill="none" stroke={INK} strokeWidth={18} strokeLinecap="round" />
      <path d={leftArmD} fill="none" stroke={COAT} strokeWidth={9} strokeLinecap="round" />
      <path d={rightArmD} fill="none" stroke={INK} strokeWidth={18} strokeLinecap="round" />
      <path d={rightArmD} fill="none" stroke={COAT} strokeWidth={9} strokeLinecap="round" />

      {/* Mão com frasco brilhante */}
      {isFlask ? (
        <g transform={`translate(-128, ${-272 + armFloat})`}>
          <path d="M -8 -26 L 8 -26 L 10 -6 L 26 24 L -26 24 L -10 -6 Z" fill="#0F172A" stroke={INK} strokeWidth={5} />
          <path d="M -18 8 L 18 8 L 22 21 L -22 21 Z" fill="#2DD4BF" />
          <circle cx={-4} cy={14} r={3} fill="#CCFBF1" />
          <circle cx={6} cy={12} r={2} fill="#CCFBF1" />
        </g>
      ) : null}

      {/* Cabeça */}
      <g>
        <ellipse cx={0} cy={-250 + breathe} rx={62} ry={58} fill={SKIN} stroke={INK} strokeWidth={6} />
        {/* Sombra sutil no queixo */}
        <path
          d={`M -54 ${-234 + breathe} Q 0 ${-190 + breathe} 54 ${-234 + breathe} Q 0 ${-208 + breathe} -54 ${-234 + breathe}`}
          fill={SKIN_SHADE}
          opacity={0.45}
        />

        {/* Cabelo autoral de cientista */}
        <path
          d={`M -62 ${-262 + breathe} Q -58 ${-324 + breathe} 0 ${-318 + breathe} Q 42 ${-328 + breathe} 64 ${-264 + breathe} Q 34 ${-290 + breathe} 6 ${-284 + breathe} Q -28 ${-294 + breathe} -62 ${-262 + breathe} Z`}
          fill={HAIR}
          stroke={INK}
          strokeWidth={5.5}
          strokeLinejoin="round"
        />

        {/* Óculos redondos de laboratório */}
        <g stroke={INK} strokeWidth={4.5} fill="rgba(224, 242, 254, 0.25)">
          <circle cx={-23} cy={-255 + breathe} r={18} />
          <circle cx={23} cy={-255 + breathe} r={18} />
          <line x1={-5} y1={-255 + breathe} x2={5} y2={-255 + breathe} />
        </g>

        {/* Olhos */}
        {blink || expr === 'calm' ? (
          <g stroke={INK} strokeWidth={4.5} strokeLinecap="round">
            <path d={`M -32 ${-255 + breathe} Q -23 ${-249 + breathe} -14 ${-255 + breathe}`} fill="none" />
            <path d={`M 14 ${-255 + breathe} Q 23 ${-249 + breathe} 32 ${-255 + breathe}`} fill="none" />
          </g>
        ) : (
          <g fill={INK}>
            <circle cx={-23} cy={-255 + breathe} r={4.8} />
            <circle cx={23} cy={-255 + breathe} r={4.8} />
          </g>
        )}

        {/* Sobrancelhas */}
        <g stroke={INK} strokeWidth={4} strokeLinecap="round">
          <path
            d={
              expr === 'surprised' || expr === 'amazed'
                ? `M -36 ${-280 + breathe} Q -23 ${-287 + breathe} -10 ${-279 + breathe}`
                : `M -35 ${-277 + breathe} L -11 ${-274 + breathe}`
            }
            fill="none"
          />
          <path
            d={
              expr === 'surprised' || expr === 'amazed'
                ? `M 10 ${-279 + breathe} Q 23 ${-287 + breathe} 36 ${-280 + breathe}`
                : `M 11 ${-274 + breathe} L 35 ${-277 + breathe}`
            }
            fill="none"
          />
        </g>

        {/* Nariz */}
        <path d={`M 0 ${-252 + breathe} L -5 ${-238 + breathe} L 3 ${-236 + breathe}`} fill="none" stroke={INK} strokeWidth={3.5} strokeLinecap="round" strokeLinejoin="round" />

        {/* Boca */}
        {mouth ? (
          <path d={mouth} fill="none" stroke={INK} strokeWidth={4.5} strokeLinecap="round" />
        ) : (
          <ellipse cx={0} cy={-219 + breathe} rx={10} ry={12} fill="#1E293B" stroke={INK} strokeWidth={4} />
        )}
      </g>
    </g>
  );
}
