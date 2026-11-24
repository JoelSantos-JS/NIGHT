import { AbsoluteFill, Img, interpolate, useCurrentFrame } from 'remotion';
import { CartoonScientistSvg } from '../components/CartoonScientistSvg';
import { OutlinedCaption } from '../components/OutlinedCaption';
import { useStudioScale } from '../components/scale';
import type { TemplateComponentProps } from '../types';

const INK = '#080B10';

/** Desenho vetorial estilizado de um tardígrado (urso-d'água) em traço de tinta. */
function TardigradeSvg({
  frame,
  cx,
  cy,
  scale = 1,
  curledTun = false,
}: {
  frame: number;
  cx: number;
  cy: number;
  scale?: number;
  curledTun?: boolean;
}) {
  const bob = Math.sin(frame * 0.06) * 14;
  const rot = Math.sin(frame * 0.04) * 4;
  const legWiggle = Math.sin(frame * 0.22) * 5;

  if (curledTun) {
    return (
      <g transform={`translate(${cx}, ${cy + bob}) rotate(${rot}) scale(${scale})`}>
        {/* Cápsula protetora de biovidro (túnel/tun) */}
        <ellipse cx={0} cy={0} rx={128} ry={96} fill="rgba(56, 189, 248, 0.22)" stroke="#7DD3FC" strokeWidth={5} />
        <ellipse cx={0} cy={0} rx={106} ry={76} fill="#64748B" stroke={INK} strokeWidth={7} />
        <path d="M -60 -28 Q -15 -56 42 -36" fill="none" stroke="#94A3B8" strokeWidth={10} strokeLinecap="round" />
        <path d="M -52 12 Q 0 38 56 16" fill="none" stroke="#475569" strokeWidth={8} strokeLinecap="round" />
        <circle cx={68} cy={-8} r={14} fill="#334155" stroke={INK} strokeWidth={5} />
      </g>
    );
  }

  return (
    <g transform={`translate(${cx}, ${cy + bob}) rotate(${rot}) scale(${scale})`}>
      {/* Pares traseiros de patinhas (4 do lado oposto para dar volume de 8 patas) */}
      {[-80, -20, 44, 102].map((lx, idx) => (
        <g key={`back-${lx}`} stroke={INK} strokeWidth={5} strokeLinecap="round" fill="#475569">
          <path d={`M ${lx - 8} 48 Q ${lx - 10} 82 ${lx - 2 + (idx % 2 === 0 ? -legWiggle : legWiggle)} 96 L ${lx + 14} 80 Z`} />
        </g>
      ))}
      {/* Pares frontais de patinhas */}
      {[-95, -35, 30, 92].map((lx, idx) => (
        <g key={lx} stroke={INK} strokeWidth={6} strokeLinecap="round" fill="#64748B">
          <path d={`M ${lx - 10} 58 Q ${lx - 14} 95 ${lx - 6 + (idx % 2 === 0 ? legWiggle : -legWiggle)} 112 L ${lx + 16} 92 Z`} />
        </g>
      ))}
      {/* Corpo segmentado translúcido */}
      <ellipse cx={0} cy={0} rx={170} ry={88} fill="#7C98A6" stroke={INK} strokeWidth={8} />
      <path d="M -75 -82 Q -68 0 -75 82" fill="none" stroke={INK} strokeWidth={5} opacity={0.65} />
      <path d="M -5 -86 Q 4 0 -5 86" fill="none" stroke={INK} strokeWidth={5} opacity={0.65} />
      <path d="M 68 -80 Q 75 0 68 80" fill="none" stroke={INK} strokeWidth={5} opacity={0.65} />
      {/* Cabeça e boca tubular */}
      <ellipse cx={162} cy={4} rx={36} ry={34} fill="#94B0BE" stroke={INK} strokeWidth={7} />
      <circle cx={196} cy={6} r={14} fill="#334155" stroke={INK} strokeWidth={5} />
      <circle cx={158} cy={-10} r={5} fill={INK} />
      {/* Brilho interno */}
      <ellipse cx={-25} cy={-38} rx={95} ry={22} fill="rgba(226, 232, 240, 0.25)" />
    </g>
  );
}

/** Laboratório atmosférico noturno em perspectiva de 1 ponto. */
function LabBackdrop({
  frame,
  badgeText,
  pose,
  expressao,
  assets = [],
}: {
  frame: number;
  badgeText?: string;
  pose?: string;
  expressao?: string;
  assets?: string[];
}) {
  const lampSwing = Math.sin(frame * 0.05) * 1.5;
  const hasMicroscope = assets.some((a) => a.toLowerCase().includes('micro'));
  const rawBadge = badgeText?.trim() ?? '';
  const ledText = rawBadge.length > 0 && rawBadge.length <= 7 && /\d/.test(rawBadge) ? rawBadge : '03:17';

  return (
    <svg viewBox="0 0 1080 1920" width="100%" height="100%" preserveAspectRatio="xMidYMid slice">
      <defs>
        <linearGradient id="wallGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#13252D" />
          <stop offset="100%" stopColor="#264956" />
        </linearGradient>
        <linearGradient id="lampCone" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="rgba(253, 224, 71, 0.30)" />
          <stop offset="100%" stopColor="rgba(253, 224, 71, 0.0)" />
        </linearGradient>
      </defs>

      {/* Paredes e teto em perspectiva */}
      <rect x={0} y={0} width={1080} height={1920} fill="url(#wallGrad)" />
      <polygon points="0,0 1080,0 850,360 230,360" fill="#0F1F26" stroke={INK} strokeWidth={5} />
      <polygon points="0,0 230,360 230,1260 0,1520" fill="#18323D" stroke={INK} strokeWidth={5} />
      <polygon points="1080,0 850,360 850,1260 1080,1520" fill="#152C35" stroke={INK} strokeWidth={5} />

      {/* Piso de madeira escuro */}
      <polygon points="230,1260 850,1260 1080,1520 1080,1920 0,1920 0,1520" fill="#1B343E" stroke={INK} strokeWidth={5} />
      {[1350, 1470, 1610, 1760].map((fy) => (
        <line key={fy} x1={0} y1={fy} x2={1080} y2={fy} stroke={INK} strokeWidth={4} opacity={0.7} />
      ))}

      {/* Janela à esquerda + facho de luar no piso */}
      <polygon points="20,420 150,480 150,960 20,1040" fill="#2E5B69" stroke={INK} strokeWidth={5} />
      <polygon points="150,960 540,1450 260,1740 20,1360" fill="rgba(125, 211, 252, 0.14)" />

      {/* Armário de vidro e bancada ao fundo */}
      <rect x={260} y={760} width={560} height={500} rx={8} fill="#1E3944" stroke={INK} strokeWidth={6} />
      <rect x={244} y={960} width={592} height={30} rx={6} fill="#315260" stroke={INK} strokeWidth={6} />

      {/* Painel LED vermelho no laboratório */}
      <rect x={295} y={845} width={155} height={74} rx={8} fill="#090D14" stroke={INK} strokeWidth={5} />
      <text
        x={372}
        y={896}
        textAnchor="middle"
        fill="#EF4444"
        fontFamily="monospace"
        fontWeight="bold"
        fontSize={34}
      >
        {ledText}
      </text>

      {/* Microscópio sobre a bancada */}
      {hasMicroscope ? (
        <g transform="translate(740, 880)" stroke={INK} strokeWidth={5} fill="#94A3B8">
          <rect x={-38} y={62} width={76} height={18} rx={4} fill="#334155" />
          <path d="M 10 62 Q 35 20 16 -20" fill="none" stroke="#475569" strokeWidth={12} />
          <rect x={-16} y={-44} width={22} height={64} rx={4} transform="rotate(20)" />
          <rect x={-28} y={32} width={48} height={8} fill="#CBD5E1" />
        </g>
      ) : null}

      {/* Lâmpada pendente com cone de luz */}
      <g transform={`translate(540, 0) rotate(${lampSwing})`}>
        <line x1={0} y1={0} x2={0} y2={250} stroke={INK} strokeWidth={6} />
        <polygon points="-42,278 42,278 320,1180 -320,1180" fill="url(#lampCone)" />
        <path d="M -38 250 L 38 250 L 52 282 L -52 282 Z" fill="#334155" stroke={INK} strokeWidth={5} />
        <circle cx={0} cy={286} r={18} fill="#FEF08A" stroke={INK} strokeWidth={4} />
      </g>

      {/* Cientista no centro da cena (acima da faixa de legenda) */}
      <CartoonScientistSvg
        pose={pose ?? 'observing'}
        expressao={expressao ?? 'focused'}
        x={540}
        y={995}
        scale={1.12}
      />
    </svg>
  );
}

/** Enquadramento circular estilo lente de microscópio / olho mágico. */
function MicroscopeLensBackdrop({ frame }: { frame: number }) {
  const pulse = 1 + Math.sin(frame * 0.08) * 0.015;
  return (
    <svg viewBox="0 0 1080 1920" width="100%" height="100%" preserveAspectRatio="xMidYMid slice">
      <defs>
        <radialGradient id="lensBg" cx="50%" cy="46%" r="52%">
          <stop offset="0%" stopColor="#A7F3D0" />
          <stop offset="55%" stopColor="#2A6F68" />
          <stop offset="100%" stopColor="#0E282A" />
        </radialGradient>
        <clipPath id="eyepieceClip">
          <circle cx={540} cy={880} r={470} />
        </clipPath>
      </defs>

      <rect x={0} y={0} width={1080} height={1920} fill="#04070B" />
      <g clipPath="url(#eyepieceClip)">
        <rect x={40} y={380} width={1000} height={1000} fill="url(#lensBg)" />
        {/* Bolhas e partículas orgânicas flutuando */}
        {[
          { x: 310, y: 650, r: 28, speed: 0.05 },
          { x: 760, y: 720, r: 20, speed: 0.07 },
          { x: 400, y: 1120, r: 34, speed: 0.04 },
          { x: 710, y: 1060, r: 16, speed: 0.08 },
        ].map((b, i) => (
          <circle
            key={i}
            cx={b.x + Math.sin(frame * b.speed + i) * 18}
            cy={b.y + Math.cos(frame * b.speed + i) * 14}
            r={b.r}
            fill="rgba(236, 253, 245, 0.25)"
            stroke="rgba(15, 23, 42, 0.45)"
            strokeWidth={4}
          />
        ))}
        <TardigradeSvg frame={frame} cx={540} cy={860} scale={1.38 * pulse} />
        {/* Graduação sutil da ocular */}
        <line x1={540} y1={420} x2={540} y2={1340} stroke="rgba(15,23,42,0.18)" strokeWidth={3} strokeDasharray="12 16" />
        <line x1={80} y1={880} x2={1000} y2={880} stroke="rgba(15,23,42,0.18)" strokeWidth={3} strokeDasharray="12 16" />
      </g>
      <circle cx={540} cy={880} r={470} fill="none" stroke="#1E293B" strokeWidth={22} />
      <circle cx={540} cy={880} r={458} fill="none" stroke="rgba(255,255,255,0.15)" strokeWidth={4} />
    </svg>
  );
}

/** Enquadramento circular no vácuo espacial (missão FOTON-M3). */
function CosmosLensBackdrop({ frame }: { frame: number }) {
  const starTwinkle = (offset: number) => 0.45 + 0.55 * Math.abs(Math.sin(frame * 0.09 + offset));
  return (
    <svg viewBox="0 0 1080 1920" width="100%" height="100%" preserveAspectRatio="xMidYMid slice">
      <defs>
        <radialGradient id="cosmosBg" cx="50%" cy="40%" r="60%">
          <stop offset="0%" stopColor="#172554" />
          <stop offset="70%" stopColor="#090F24" />
          <stop offset="100%" stopColor="#03060F" />
        </radialGradient>
        <clipPath id="portholeClip">
          <circle cx={540} cy={880} r={470} />
        </clipPath>
      </defs>

      <rect x={0} y={0} width={1080} height={1920} fill="#030508" />
      <g clipPath="url(#portholeClip)">
        <rect x={40} y={380} width={1000} height={1000} fill="url(#cosmosBg)" />
        {/* Estrelas */}
        {[
          [220, 560], [340, 480], [690, 520], [830, 660],
          [270, 920], [800, 980], [450, 610], [610, 740],
        ].map(([sx, sy], i) => (
          <circle key={i} cx={sx} cy={sy} r={i % 2 === 0 ? 4.5 : 3} fill="#E0F2FE" opacity={starTwinkle(i)} />
        ))}
        {/* Horizonte curvo da Terra */}
        <circle cx={540} cy={1460} r={420} fill="#0EA5E9" opacity={0.28} />
        <circle cx={540} cy={1480} r={410} fill="#1E3A8A" stroke="#38BDF8" strokeWidth={6} />
        {/* Ondas de radiação solar */}
        <path
          d={`M ${140 + (frame * 3) % 60} 580 Q 300 540 420 590`}
          fill="none"
          stroke="#FACC15"
          strokeWidth={5}
          strokeDasharray="16 12"
          opacity={0.7}
        />
        <TardigradeSvg frame={frame} cx={540} cy={835} scale={1.32} curledTun />
      </g>
      <circle cx={540} cy={880} r={470} fill="none" stroke="#1E293B" strokeWidth={24} />
      <circle cx={540} cy={880} r={456} fill="none" stroke="#38BDF8" strokeWidth={3} opacity={0.35} />
    </svg>
  );
}

/** Cena de revelação científica com destaque de biovidro e cientista em foco. */
function RevealBackdrop({
  frame,
  pose,
  expressao,
}: {
  frame: number;
  pose?: string;
  expressao?: string;
}) {
  const glow = 0.28 + Math.sin(frame * 0.08) * 0.06;
  return (
    <svg viewBox="0 0 1080 1920" width="100%" height="100%" preserveAspectRatio="xMidYMid slice">
      <defs>
        <radialGradient id="revealLight" cx="50%" cy="35%" r="55%">
          <stop offset="0%" stopColor="#38BDF8" stopOpacity={glow + 0.15} />
          <stop offset="55%" stopColor="#16323F" stopOpacity={0.6} />
          <stop offset="100%" stopColor="#091318" />
        </radialGradient>
      </defs>

      <rect x={0} y={0} width={1080} height={1920} fill="#091318" />
      <rect x={0} y={0} width={1080} height={1920} fill="url(#revealLight)" />

      {/* Diagrama cristalino de proteção biológica atrás */}
      <g transform={`translate(540, 560) rotate(${Math.sin(frame * 0.03) * 3})`}>
        <polygon
          points="0,-200 180,-90 180,100 0,210 -180,100 -180,-90"
          fill="rgba(56, 189, 248, 0.14)"
          stroke="#7DD3FC"
          strokeWidth={5}
        />
        <polygon
          points="0,-130 115,-55 115,65 0,140 -115,65 -115,-55"
          fill="rgba(250, 204, 21, 0.12)"
          stroke="#FACC15"
          strokeWidth={4}
        />
        {/* Filamento estilizado TDP */}
        <path d="M -70 -20 Q -20 -80 20 0 T 80 -10" fill="none" stroke="#E0F2FE" strokeWidth={8} strokeLinecap="round" />
        <circle cx={-70} cy={-20} r={10} fill="#FACC15" stroke={INK} strokeWidth={4} />
        <circle cx={80} cy={-10} r={10} fill="#38BDF8" stroke={INK} strokeWidth={4} />
      </g>

      <CartoonScientistSvg
        pose={pose ?? 'amazed'}
        expressao={expressao ?? 'amazed'}
        x={540}
        y={1000}
        scale={1.15}
      />
    </svg>
  );
}

/** Câmara criogênica congelada em ciano escuro com cristais de gelo e cilindro de vidro. */
function FreezeChamberBackdrop({ frame }: { frame: number }) {
  const mistY = Math.sin(frame * 0.06) * 14;
  return (
    <svg viewBox="0 0 1080 1920" width="100%" height="100%" preserveAspectRatio="xMidYMid slice">
      <defs>
        <radialGradient id="freezeGlow" cx="50%" cy="46%" r="54%">
          <stop offset="0%" stopColor="#22D3EE" stopOpacity={0.35} />
          <stop offset="60%" stopColor="#0E3446" />
          <stop offset="100%" stopColor="#05131B" />
        </radialGradient>
      </defs>
      <rect x={0} y={0} width={1080} height={1920} fill="#05131B" />
      <rect x={0} y={0} width={1080} height={1920} fill="url(#freezeGlow)" />

      {/* Cristais de gelo geométricos em tinta escura */}
      {[
        'M 60,260 L 180,380 L 110,480 Z',
        'M 1020,300 L 880,440 L 970,560 Z',
        'M 90,1480 L 240,1360 L 210,1560 Z',
        'M 990,1450 L 820,1340 L 860,1540 Z',
      ].map((d, i) => (
        <path key={i} d={d} fill="rgba(165, 243, 252, 0.24)" stroke="#67E8F9" strokeWidth={5} />
      ))}

      {/* Cilindro criogênico central */}
      <rect x={320} y={420} width={440} height={860} rx={48} fill="rgba(8, 51, 68, 0.55)" stroke="#22D3EE" strokeWidth={8} />
      <rect x={300} y={390} width={480} height={54} rx={12} fill="#1E293B" stroke={INK} strokeWidth={6} />
      <rect x={300} y={1250} width={480} height={54} rx={12} fill="#1E293B" stroke={INK} strokeWidth={6} />

      <TardigradeSvg frame={frame} cx={540} cy={835} scale={1.15} curledTun />

      {/* Névoa fria */}
      <ellipse cx={540} cy={1210 + mistY} rx={360} ry={45} fill="rgba(207, 250, 254, 0.22)" />
    </svg>
  );
}

/** Fenda hidrotermal abissal com ondas de calor âmbar e bolhas ascendentes. */
function HeatVentBackdrop({ frame }: { frame: number }) {
  const waveShift = Math.sin(frame * 0.14) * 14;
  return (
    <svg viewBox="0 0 1080 1920" width="100%" height="100%" preserveAspectRatio="xMidYMid slice">
      <defs>
        <radialGradient id="heatGlow" cx="50%" cy="62%" r="58%">
          <stop offset="0%" stopColor="#F97316" stopOpacity={0.55} />
          <stop offset="55%" stopColor="#431407" />
          <stop offset="100%" stopColor="#0A0A0C" />
        </radialGradient>
      </defs>
      <rect x={0} y={0} width={1080} height={1920} fill="#0A0A0C" />
      <rect x={0} y={0} width={1080} height={1920} fill="url(#heatGlow)" />

      {/* Chaminé rochosa abissal */}
      <polygon points="320,1920 430,1180 650,1180 760,1920" fill="#1C1917" stroke={INK} strokeWidth={8} />
      <ellipse cx={540} cy={1180} rx={110} ry={26} fill="#EA580C" stroke={INK} strokeWidth={6} />

      {/* Ondas de calor e vapor subindo */}
      {[460, 540, 620].map((vx, i) => (
        <path
          key={vx}
          d={`M ${vx} 1160 Q ${vx + waveShift * (i % 2 === 0 ? 1 : -1)} 900 ${vx} 620`}
          fill="none"
          stroke="#FB923C"
          strokeWidth={10}
          strokeLinecap="round"
          opacity={0.45}
        />
      ))}

      <TardigradeSvg frame={frame} cx={540} cy={780} scale={1.15} />
    </svg>
  );
}

/** Pulso de radiação extrema com anéis concêntricos dourados e escudo biológico. */
function RadiationPulseBackdrop({ frame }: { frame: number }) {
  const ringPulse = (offset: number) => 1 + ((frame * 0.03 + offset) % 1) * 0.45;
  return (
    <svg viewBox="0 0 1080 1920" width="100%" height="100%" preserveAspectRatio="xMidYMid slice">
      <rect x={0} y={0} width={1080} height={1920} fill="#070B14" />
      {[0, 0.33, 0.66].map((off, i) => (
        <circle
          key={i}
          cx={540}
          cy={820}
          r={240 * ringPulse(off)}
          fill="none"
          stroke="#FACC15"
          strokeWidth={5}
          opacity={Math.max(0.08, 0.65 - (ringPulse(off) - 1))}
        />
      ))}
      <TardigradeSvg frame={frame} cx={540} cy={820} scale={1.25} curledTun />
    </svg>
  );
}

/** Bancada iluminada de pesquisa com frascos de vacina estabilizados e cientista sorrindo. */
function VaccineLabBackdrop({
  frame,
  pose,
  expressao,
}: {
  frame: number;
  pose?: string;
  expressao?: string;
}) {
  const shimmer = 0.25 + Math.sin(frame * 0.09) * 0.08;
  return (
    <svg viewBox="0 0 1080 1920" width="100%" height="100%" preserveAspectRatio="xMidYMid slice">
      <defs>
        <linearGradient id="vacWall" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#0E222A" />
          <stop offset="100%" stopColor="#1B3C49" />
        </linearGradient>
      </defs>
      <rect x={0} y={0} width={1080} height={1920} fill="url(#vacWall)" />
      {/* Halo de luz da lâmpada sobre a bancada */}
      <ellipse cx={540} cy={920} rx={360} ry={220} fill={`rgba(56, 189, 248, ${shimmer})`} />
      <CartoonScientistSvg
        pose={pose ?? 'calm-seated'}
        expressao={expressao ?? 'happy'}
        x={540}
        y={920}
        scale={1.06}
      />
      {/* Bancada à frente com frascos brilhantes */}
      <rect x={140} y={1020} width={800} height={36} rx={10} fill="#315260" stroke={INK} strokeWidth={6} />
      {[340, 540, 740].map((vx, i) => (
        <g key={vx} transform={`translate(${vx}, 965)`} stroke={INK} strokeWidth={5}>
          <rect x={-26} y={-20} width={52} height={74} rx={10} fill="#0F172A" />
          <rect x={-20} y={14} width={40} height={34} rx={4} fill={i === 1 ? '#FACC15' : '#22D3EE'} />
          <rect x={-18} y={-32} width={36} height={14} rx={3} fill="#CBD5E1" />
        </g>
      ))}
    </svg>
  );
}

function cameraTransform(
  frame: number,
  durationInFrames: number,
  sceneIndex: number,
  s: number,
): string {
  const maxFrame = Math.max(1, durationInFrames - 1);
  const mode = sceneIndex % 4;
  if (mode === 0) {
    const scale = interpolate(frame, [0, maxFrame], [1.0, 1.07], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
    const ty = interpolate(frame, [0, maxFrame], [0, -8 * s], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
    return `scale(${scale}) translateY(${ty}px)`;
  }
  if (mode === 1) {
    const scale = interpolate(frame, [0, maxFrame], [1.08, 1.01], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
    const tx = interpolate(frame, [0, maxFrame], [-14 * s, 14 * s], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
    return `scale(${scale}) translateX(${tx}px)`;
  }
  if (mode === 2) {
    const punchEnd = Math.min(6, maxFrame);
    const scale =
      frame <= punchEnd
        ? interpolate(frame, [0, punchEnd], [1.06, 1.02], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
        : interpolate(frame, [punchEnd, maxFrame], [1.02, 1.07], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
    return `scale(${scale})`;
  }
  const tx = interpolate(frame, [0, maxFrame], [14 * s, -14 * s], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return `scale(1.06) translateX(${tx}px)`;
}

export function DarkScienceTemplate({
  scene,
  sceneIndex,
  durationInFrames,
  theme,
}: TemplateComponentProps) {
  const frame = useCurrentFrame();
  const { s, isVertical } = useStudioScale();

  const cam = cameraTransform(frame, durationInFrames, sceneIndex, s);
  const cenario = (scene.cenario ?? 'lab').toLowerCase();

  return (
    <AbsoluteFill style={{ backgroundColor: '#05080D', overflow: 'hidden' }}>
      <AbsoluteFill style={{ transform: cam }}>
        {scene.imageUrl ? (
          <Img src={scene.imageUrl} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        ) : cenario.includes('freeze') || cenario.includes('ice') ? (
          <FreezeChamberBackdrop frame={frame} />
        ) : cenario.includes('heat') || cenario.includes('vent') ? (
          <HeatVentBackdrop frame={frame} />
        ) : cenario.includes('rad') || cenario.includes('pulse') ? (
          <RadiationPulseBackdrop frame={frame} />
        ) : cenario.includes('vac') ? (
          <VaccineLabBackdrop frame={frame} pose={scene.pose} expressao={scene.expressao} />
        ) : cenario.includes('micro') ? (
          <MicroscopeLensBackdrop frame={frame} />
        ) : cenario.includes('cosmos') || cenario.includes('space') ? (
          <CosmosLensBackdrop frame={frame} />
        ) : cenario.includes('reveal') || cenario.includes('bio') ? (
          <RevealBackdrop frame={frame} pose={scene.pose} expressao={scene.expressao} />
        ) : (
          <LabBackdrop
            frame={frame}
            badgeText={scene.textoNaTela}
            pose={scene.pose}
            expressao={scene.expressao}
            assets={scene.assets}
          />
        )}
      </AbsoluteFill>

      {/* Vinheta cinematográfica suave */}
      <AbsoluteFill
        style={{
          background:
            'radial-gradient(circle at 50% 48%, rgba(0,0,0,0) 48%, rgba(2,6,14,0.55) 100%)',
          pointerEvents: 'none',
        }}
      />

      {/* Marcador técnico opcional no topo seguro */}
      {scene.textoNaTela && scene.textoNaTela.trim() !== '' ? (
        <div
          style={{
            position: 'absolute',
            top: (isVertical ? 110 : 48) * s,
            left: 56 * s,
            padding: `${10 * s}px ${22 * s}px`,
            borderRadius: 12 * s,
            backgroundColor: 'rgba(8, 15, 24, 0.78)',
            border: `${2 * s}px solid ${theme.accent}`,
            color: '#F8FAFC',
            fontFamily: '"Consolas", "Segoe UI", monospace',
            fontWeight: 700,
            fontSize: 26 * s,
            letterSpacing: '0.06em',
            zIndex: 25,
          }}
        >
          {scene.textoNaTela.trim()}
        </div>
      ) : null}

      <OutlinedCaption
        text={scene.narracao}
        durationInFrames={durationInFrames}
        accentColor={theme.accent}
      />
    </AbsoluteFill>
  );
}
