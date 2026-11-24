import { AbsoluteFill, Img, interpolate, useCurrentFrame } from 'remotion';
import { buildCaptionChunks } from '../components/OutlinedCaption';
import { useStudioScale } from '../components/scale';
import type { TemplateComponentProps } from '../types';

type PhilosophyScenario =
  | 'chiaroscuro'
  | 'engraving'
  | 'classical-hall'
  | 'library-hall'
  | 'quill-manuscript'
  | 'hourglass-engraving'
  | 'amphitheater'
  | 'still-life-book';

const VALID_PHIL_SCENARIOS = new Set<string>([
  'chiaroscuro',
  'engraving',
  'classical-hall',
  'library-hall',
  'quill-manuscript',
  'hourglass-engraving',
  'amphitheater',
  'still-life-book',
]);

function pickPhilosophyScenario(cenario: string | undefined, sceneIndex: number): PhilosophyScenario {
  const norm = (cenario ?? '').trim().toLowerCase();
  if (VALID_PHIL_SCENARIOS.has(norm)) {
    return norm as PhilosophyScenario;
  }
  const cycle: PhilosophyScenario[] = [
    'chiaroscuro',
    'engraving',
    'library-hall',
    'quill-manuscript',
    'hourglass-engraving',
    'classical-hall',
    'amphitheater',
    'still-life-book',
  ];
  return cycle[sceneIndex % cycle.length]!;
}

/** Gravura clássica em pergaminho envelhecido com hachuras em tinta sépia. */
function EngravingArtwork({ frame }: { frame: number }) {
  const shimmer = Math.sin(frame * 0.03) * 0.03;
  return (
    <g>
      <defs>
        <radialGradient id="parchmentGlow" cx="50%" cy="46%" r="65%">
          <stop offset="0%" stopColor="#ECE1C4" />
          <stop offset="68%" stopColor="#D6C49B" />
          <stop offset="100%" stopColor="#9B8662" />
        </radialGradient>
        <pattern id="crossHatch" width="16" height="16" patternUnits="userSpaceOnUse" patternTransform="rotate(32)">
          <line x1="0" y1="0" x2="0" y2="16" stroke="#3B2F22" strokeWidth="1.2" opacity="0.22" />
          <line x1="0" y1="0" x2="16" y2="0" stroke="#3B2F22" strokeWidth="0.9" opacity="0.14" />
        </pattern>
      </defs>

      <rect x={0} y={0} width={1920} height={1080} fill="url(#parchmentGlow)" />
      <rect x={0} y={0} width={1920} height={1080} fill="url(#crossHatch)" opacity={0.42 + shimmer} />

      {/* Moldura arquivística dupla gravada */}
      <rect x={95} y={135} width={1730} height={810} fill="none" stroke="#473827" strokeWidth={3} opacity={0.45} />
      <rect x={115} y={155} width={1690} height={770} fill="none" stroke="#473827" strokeWidth={1.5} opacity={0.35} />

      {/* Colunata romana em perspectiva clássica */}
      {[290, 490, 1430, 1630].map((cx, idx) => (
        <g key={idx} transform={`translate(${cx}, 195)`}>
          <rect x={-38} y={0} width={76} height={26} fill="#C8B68F" stroke="#362A1D" strokeWidth={3} />
          <rect x={-26} y={26} width={52} height={630} fill="#D9C9A3" stroke="#362A1D" strokeWidth={3} />
          <line x1={-10} y1={26} x2={-10} y2={656} stroke="#362A1D" strokeWidth={2} opacity={0.45} />
          <line x1={10} y1={26} x2={10} y2={656} stroke="#362A1D" strokeWidth={2} opacity={0.45} />
          <rect x={-42} y={656} width={84} height={32} fill="#C4B189" stroke="#362A1D" strokeWidth={3} />
        </g>
      ))}

      {/* Arco central e medalhão clássico com perfil laureado estilizado */}
      <circle cx={960} cy={530} r={285} fill="#E4D7B6" stroke="#362A1D" strokeWidth={4} />
      <circle cx={960} cy={530} r={264} fill="url(#crossHatch)" stroke="#362A1D" strokeWidth={2} opacity={0.7} />

      {/* Busto clássico em perfil (silhueta neoclássica gravada em pedra/cobre) */}
      <path
        d="M 885 735 C 902 670 905 628 890 598 L 876 588 C 862 582 864 566 878 560 C 864 552 866 538 880 532 L 856 502 C 848 492 854 476 872 454 C 868 418 886 354 944 334 C 998 315 1054 344 1076 396 C 1096 446 1084 510 1052 558 C 1032 590 1032 652 1055 735 Z"
        fill="#D6C49D"
        stroke="#2E2318"
        strokeWidth={4.5}
      />
      {/* Pedestal sutil e hachura do rosto em gravura */}
      <path d="M 874 735 L 1066 735 L 1076 762 L 864 762 Z" fill="#C4B189" stroke="#2E2318" strokeWidth={4} />
      <path d="M 896 446 Q 920 442 932 454" fill="none" stroke="#2E2318" strokeWidth={3.5} />
      <path d="M 906 462 Q 920 460 930 468" fill="none" stroke="#2E2318" strokeWidth={2.5} />
      <path d="M 988 450 Q 1038 440 1058 495" fill="none" stroke="#2E2318" strokeWidth={2.5} opacity={0.5} />
      <path d="M 942 356 Q 992 385 1028 455" fill="none" stroke="#362A1D" strokeWidth={3} />
      {[0, 1, 2, 3].map((leaf) => {
        const lx = 954 + leaf * 24;
        const ly = 365 + leaf * 24;
        return (
          <path
            key={leaf}
            d={`M ${lx} ${ly} Q ${lx + 24} ${ly - 22} ${lx + 42} ${ly - 4} Q ${lx + 18} ${ly + 12} ${lx} ${ly} Z`}
            fill="#C7B388"
            stroke="#2E2318"
            strokeWidth={2.5}
          />
        );
      })}

      {/* Manchas suaves de papel envelhecido */}
      <circle cx={340} cy={290} r={4} fill="#5C4832" opacity={0.35} />
      <circle cx={1540} cy={780} r={5} fill="#5C4832" opacity={0.32} />
      <circle cx={680} cy={220} r={3} fill="#5C4832" opacity={0.28} />
    </g>
  );
}

/** Pintura barroca chiaroscuro: escrivaninha antiga iluminada à luz de vela. */
function ChiaroscuroArtwork({ frame }: { frame: number }) {
  const flicker = 1 + Math.sin(frame * 0.24) * 0.045;
  return (
    <g>
      <defs>
        <radialGradient id="candleLight" cx="29%" cy="46%" r="58%">
          <stop offset="0%" stopColor="#F5CF86" stopOpacity="0.62" />
          <stop offset="35%" stopColor="#9A6838" stopOpacity="0.34" />
          <stop offset="100%" stopColor="#1B140E" stopOpacity="0.96" />
        </radialGradient>
      </defs>

      {/* Fundo sombrio barroco com luz âmbar quente */}
      <rect x={0} y={0} width={1920} height={1080} fill="#251B14" />
      <rect x={0} y={0} width={1920} height={1080} fill="url(#candleLight)" />

      {/* Cortina carmesim profunda à direita */}
      <path
        d="M 1220 110 C 1340 280 1280 510 1370 760 L 1920 760 L 1920 110 Z"
        fill="#6D2016"
        stroke="#2A0B07"
        strokeWidth={4}
      />
      <path
        d="M 1420 110 C 1495 310 1440 520 1545 760"
        fill="none"
        stroke="#9A3628"
        strokeWidth={22}
        opacity={0.45}
      />

      {/* Mesa de carvalho iluminada */}
      <polygon points="160,720 1780,720 1920,1080 0,1080" fill="#543823" stroke="#1E130B" strokeWidth={5} />
      <polygon points="220,730 1660,730 1580,980 280,980" fill="#6B482E" opacity={0.65} />

      {/* Castiçal e vela acesa à esquerda */}
      <g transform="translate(520, 660)">
        <ellipse cx={0} cy={125} rx={72} ry={20} fill="#8D6938" stroke="#23170D" strokeWidth={4} />
        <rect x={-16} y={35} width={32} height={90} fill="#9C7540" stroke="#23170D" strokeWidth={4} />
        <rect x={-22} y={-95} width={44} height={135} rx={6} fill="#E6D7B3" stroke="#23170D" strokeWidth={4} />
        {/* Halo de chama */}
        <circle
          cx={0}
          cy={-132}
          r={88 * flicker}
          fill="rgba(248, 205, 118, 0.30)"
        />
        <path
          d={`M 0 ${-162 * flicker + 26} Q 18 -132 0 -106 Q -18 -132 0 ${-162 * flicker + 26} Z`}
          fill="#FFE082"
          stroke="#D97706"
          strokeWidth={3}
        />
      </g>

      {/* Livro aberto e manuscrito central em pergaminho */}
      <g transform="translate(970, 745)">
        <polygon points="-245,85 -10,65 -10,-65 -215,-50" fill="#DDD0AF" stroke="#2C2014" strokeWidth={4} />
        <polygon points="-10,65 245,95 225,-45 -10,-65" fill="#E8DCC0" stroke="#2C2014" strokeWidth={4} />
        {[-32, -10, 12, 34].map((ly) => (
          <g key={ly} stroke="#5B4935" strokeWidth={2.5} opacity={0.55}>
            <line x1={-190} y1={ly} x2={-35} y2={ly} />
            <line x1={25} y1={ly} x2={195} y2={ly + 6} />
          </g>
        ))}
        {/* Pena de escrita */}
        <path d="M 110 20 Q 175 -75 215 -140 Q 190 -55 125 25 Z" fill="#EFE8D5" stroke="#2C2014" strokeWidth={3} />
        <line x1={96} y1={42} x2={195} y2={-110} stroke="#3B2B1C" strokeWidth={4} />
      </g>

      {/* Pergaminho enrolado à direita */}
      <g transform="translate(1410, 795)">
        <rect x={-95} y={-28} width={190} height={62} rx={24} fill="#DECFA9" stroke="#2C2014" strokeWidth={4} />
        <ellipse cx={-95} cy={3} rx={16} ry={31} fill="#B9A57C" stroke="#2C2014" strokeWidth={4} />
      </g>
    </g>
  );
}

/** Paisagem e pórtico neoclássico em óleo desaturado. */
function ClassicalHallArtwork({ frame }: { frame: number }) {
  const cloudDrift = interpolate(frame, [0, 300], [0, 26], { extrapolateRight: 'clamp' });
  return (
    <g>
      <defs>
        <linearGradient id="duskSky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#5C6255" />
          <stop offset="55%" stopColor="#A99974" />
          <stop offset="100%" stopColor="#D1BC8C" />
        </linearGradient>
      </defs>

      <rect x={0} y={0} width={1920} height={690} fill="url(#duskSky)" />
      <g transform={`translate(${cloudDrift}, 0)`} opacity={0.35}>
        <ellipse cx={640} cy={330} rx={310} ry={48} fill="#E6D6B3" />
        <ellipse cx={1280} cy={270} rx={260} ry={40} fill="#E6D6B3" />
      </g>

      {/* Colinas oliveiras distantes */}
      <path
        d="M 0 650 Q 480 540 960 620 Q 1440 530 1920 625 L 1920 790 L 0 790 Z"
        fill="#4E5840"
        stroke="#272D20"
        strokeWidth={3}
      />

      {/* Piso em pedra travertino */}
      <rect x={0} y={715} width={1920} height={365} fill="#8B7B60" />
      <line x1={0} y1={715} x2={1920} y2={715} stroke="#2E251A" strokeWidth={4} />

      {/* Pórtico de mármore enquadrando a paisagem */}
      {[210, 390, 1530, 1710].map((cx, idx) => (
        <g key={idx}>
          <rect x={cx - 45} y={130} width={90} height={685} fill="#C8BC9E" stroke="#2D251B" strokeWidth={4} />
          <line x1={cx - 16} y1={130} x2={cx - 16} y2={815} stroke="#574A38" strokeWidth={2.5} opacity={0.45} />
          <line x1={cx + 16} y1={130} x2={cx + 16} y2={815} stroke="#574A38" strokeWidth={2.5} opacity={0.45} />
        </g>
      ))}
    </g>
  );
}

/** Biblioteca antiga silenciosa cortada por feixes dourados de fim de tarde. */
function LibraryHallArtwork({ frame }: { frame: number }) {
  const beamShift = Math.sin(frame * 0.04) * 10;
  return (
    <g>
      <rect x={0} y={0} width={1920} height={1080} fill="#2A1F16" />
      <rect x={0} y={760} width={1920} height={320} fill="#463324" />

      {/* Janela em arco no centro iluminando a sala */}
      <path
        d="M 810 680 L 810 340 C 810 215 1110 215 1110 340 L 1110 680 Z"
        fill="#E5C88B"
        stroke="#22170F"
        strokeWidth={6}
      />
      <line x1={960} y1={245} x2={960} y2={680} stroke="#3B2B1C" strokeWidth={5} />
      <line x1={810} y1={460} x2={1110} y2={460} stroke="#3B2B1C" strokeWidth={5} />

      {/* Estantes de madeira esquerda e direita */}
      {[120, 440, 1180, 1500].map((sx, idx) => (
        <g key={idx}>
          <rect x={sx} y={140} width={285} height={635} fill="#3E2A1B" stroke="#1E130B" strokeWidth={5} />
          {[285, 445, 605].map((sy) => (
            <g key={sy}>
              <rect x={sx + 10} y={sy} width={265} height={18} fill="#5E4029" />
              {[0, 1, 2, 3, 4].map((b) => (
                <rect
                  key={b}
                  x={sx + 24 + b * 48}
                  y={sy - 110 + ((b * 13) % 24)}
                  width={38}
                  height={110 - ((b * 13) % 24)}
                  rx={3}
                  fill={['#7A2E22', '#4F5D3E', '#9C7B47', '#5E4B3B', '#875133'][b]!}
                  stroke="#1E130B"
                  strokeWidth={2.5}
                />
              ))}
            </g>
          ))}
        </g>
      ))}

      {/* Feixe diagonal quente */}
      <polygon
        points={`810,280 1110,280 ${1520 + beamShift},1080 ${410 + beamShift},1080`}
        fill="rgba(248, 214, 134, 0.24)"
      />
    </g>
  );
}

/** Plano fechado chiaroscuro de manuscrito, pena, tinteiro e selo de cera. */
function QuillManuscriptArtwork({ frame }: { frame: number }) {
  const glow = 1 + Math.sin(frame * 0.16) * 0.04;
  return (
    <g>
      <defs>
        <radialGradient id="quillLight" cx="48%" cy="48%" r="58%">
          <stop offset="0%" stopColor="#F0C97E" stopOpacity="0.48" />
          <stop offset="100%" stopColor="#20160F" stopOpacity="0.96" />
        </radialGradient>
      </defs>
      <rect x={0} y={0} width={1920} height={1080} fill="#2B1F16" />
      <rect x={0} y={0} width={1920} height={1080} fill="url(#quillLight)" />
      <rect x={0} y={190} width={1920} height={890} fill="#4E3522" opacity={0.45} />

      {/* Grande folha de pergaminho aberta em diagonal suave */}
      <g transform="translate(940, 560) rotate(-4)">
        <rect x={-410} y={-230} width={820} height={470} rx={8} fill="#DFD0AB" stroke="#24190E" strokeWidth={5} />
        {[-150, -90, -30, 30, 90, 150].map((ly, idx) => (
          <line
            key={ly}
            x1={-320}
            y1={ly}
            x2={idx === 5 ? 95 : 310}
            y2={ly}
            stroke="#594632"
            strokeWidth={4}
            opacity={0.55}
          />
        ))}
        {/* Lacre de cera vermelha */}
        <circle cx={260} cy={145} r={42} fill="#8C261B" stroke="#360B06" strokeWidth={4} />
        <circle cx={260} cy={145} r={26} fill="#A33327" />
      </g>

      {/* Tinteiro de bronze + pena de ganso branca iluminada */}
      <g transform="translate(1485, 595)">
        <ellipse cx={0} cy={88} rx={68} ry={22} fill="#7B5C30" stroke="#21160B" strokeWidth={4} />
        <rect x={-42} y={10} width={84} height={75} rx={12} fill="#916E39" stroke="#21160B" strokeWidth={4} />
        <path d="M 10 20 Q 125 -150 185 -270 Q 145 -95 25 22 Z" fill="#EFE7D1" stroke="#21160B" strokeWidth={3.5} />
        <line x1={4} y1={28} x2={162} y2={-228} stroke="#4B3824" strokeWidth={5} />
      </g>

      <circle cx={640} cy={430} r={260 * glow} fill="rgba(255, 218, 145, 0.14)" />
    </g>
  );
}

/** Gravura vintage em cobre de ampulheta sobre livros antigos. */
function HourglassEngravingArtwork({ frame }: { frame: number }) {
  const sandDrop = (frame % 36) * 2;
  return (
    <g>
      <defs>
        <radialGradient id="parchmentGlowHg" cx="50%" cy="48%" r="65%">
          <stop offset="0%" stopColor="#ECE1C4" />
          <stop offset="68%" stopColor="#D6C49B" />
          <stop offset="100%" stopColor="#9B8662" />
        </radialGradient>
        <pattern id="crossHatchHg" width="14" height="14" patternUnits="userSpaceOnUse" patternTransform="rotate(30)">
          <line x1="0" y1="0" x2="0" y2="14" stroke="#3B2F22" strokeWidth="1.2" opacity="0.22" />
          <line x1="0" y1="0" x2="14" y2="0" stroke="#3B2F22" strokeWidth="0.9" opacity="0.14" />
        </pattern>
      </defs>

      <rect x={0} y={0} width={1920} height={1080} fill="url(#parchmentGlowHg)" />
      <rect x={0} y={0} width={1920} height={1080} fill="url(#crossHatchHg)" opacity={0.45} />
      <rect x={95} y={135} width={1730} height={810} fill="none" stroke="#473827" strokeWidth={3} opacity={0.45} />

      {/* Pilha de livros antigos */}
      <g transform="translate(960, 745)">
        <rect x={-260} y={40} width={520} height={74} rx={8} fill="#B9A377" stroke="#2E2318" strokeWidth={4} />
        <rect x={-225} y={-28} width={450} height={68} rx={8} fill="#CBB88E" stroke="#2E2318" strokeWidth={4} />
      </g>

      {/* Ampulheta gravada */}
      <g transform="translate(960, 495)">
        <rect x={-145} y={-215} width={290} height={28} rx={6} fill="#B49D6F" stroke="#2E2318" strokeWidth={4} />
        <rect x={-145} y={195} width={290} height={28} rx={6} fill="#B49D6F" stroke="#2E2318" strokeWidth={4} />
        <line x1={-115} y1={-187} x2={-115} y2={195} stroke="#2E2318" strokeWidth={8} />
        <line x1={115} y1={-187} x2={115} y2={195} stroke="#2E2318" strokeWidth={8} />
        <path
          d="M -92 -187 C -92 -55 -14 -22 -14 0 C -14 22 -92 55 -92 195 L 92 195 C 92 55 14 22 14 0 C 14 -22 92 -55 92 -187 Z"
          fill="#E9DEC1"
          stroke="#2E2318"
          strokeWidth={4}
        />
        <polygon points="-75,-75 75,-75 10,-6 -10,-6" fill="#C4AE7E" />
        <polygon points="-76,190 76,190 22,126 -22,126" fill="#C4AE7E" />
        <line x1={0} y1={0} x2={0} y2={125} stroke="#8D754A" strokeWidth={3} strokeDasharray="10 8" strokeDashoffset={-sandDrop} />
      </g>
    </g>
  );
}

/** Anfiteatro clássico de pedra banhado por um feixe vertical dourado. */
function AmphitheaterArtwork({ frame }: { frame: number }) {
  const beam = 1 + Math.sin(frame * 0.08) * 0.04;
  return (
    <g>
      <rect x={0} y={0} width={1920} height={1080} fill="#362E25" />
      <rect x={0} y={160} width={1920} height={420} fill="#4D4236" />

      {/* Degraus curvos do anfiteatro */}
      {[290, 385, 480, 575, 670].map((y, idx) => (
        <path
          key={y}
          d={`M 0 ${y} Q 960 ${y + 115} 1920 ${y} L 1920 ${y + 96} Q 960 ${y + 210} 0 ${y + 96} Z`}
          fill={['#4A3E32', '#5A4B3C', '#6A5847', '#796652', '#8B755E'][idx]!}
          stroke="#261F18"
          strokeWidth={3.5}
        />
      ))}

      {/* Arena central */}
      <ellipse cx={960} cy={835} rx={510} ry={125} fill="#A38D6F" stroke="#261F18" strokeWidth={4} />

      {/* Feixe zenital dramático */}
      <polygon
        points={`770,110 1150,110 ${1260 * beam + (1 - beam) * 960},850 ${660 * beam + (1 - beam) * 960},850`}
        fill="rgba(250, 218, 142, 0.28)"
      />
    </g>
  );
}

/** Natureza-morta em estilo holandês: livro aberto na manhã calma. */
function StillLifeBookArtwork({ frame }: { frame: number }) {
  const dust = Math.sin(frame * 0.05) * 8;
  return (
    <g>
      <rect x={0} y={0} width={1920} height={1080} fill="#33281E" />
      <polygon points="0,665 1920,665 1920,1080 0,1080" fill="#593F2A" stroke="#1E140B" strokeWidth={5} />
      {/* Caminho de tecido verde-oliva sobre a mesa */}
      <polygon points="460,665 1460,665 1590,1080 330,1080" fill="#4E5B3E" stroke="#22291B" strokeWidth={4} />

      {/* Grande livro encadernado aberto ao centro */}
      <g transform="translate(960, 695)">
        <polygon points="-340,110 -12,86 -12,-105 -300,-82" fill="#E6DAC0" stroke="#261B11" strokeWidth={5} />
        <polygon points="-12,86 340,110 300,-82 -12,-105" fill="#EFE4CC" stroke="#261B11" strokeWidth={5} />
        <path d="M -355 125 L -12 100 L 355 125" fill="none" stroke="#2E1C0E" strokeWidth={12} strokeLinecap="round" />
        {[-55, -20, 15, 50].map((ly) => (
          <g key={ly} stroke="#6A5640" strokeWidth={3} opacity={0.5}>
            <line x1={-260} y1={ly} x2={-48} y2={ly} />
            <line x1={48} y1={ly} x2={260} y2={ly} />
          </g>
        ))}
      </g>

      {/* Luz dourada oblíqua vinda da janela à esquerda */}
      <polygon
        points={`0,110 540,110 ${1260 + dust},1080 180,1080`}
        fill="rgba(255, 224, 158, 0.24)"
      />
    </g>
  );
}

/**
 * Template Filosofia Dark Cinema (2.39:1) inspirado em ensaios filosóficos com pinturas
 * clássicas a óleo, gravuras antigas, movimento contemplativo e ausência de poluição visual.
 */
export function DarkPhilosophyTemplate({
  scene,
  sceneIndex,
  durationInFrames,
  theme,
}: TemplateComponentProps) {
  const frame = useCurrentFrame();
  const { s, isVertical } = useStudioScale();

  const scenario = pickPhilosophyScenario(scene.cenario, sceneIndex);
  const maxFrame = Math.max(1, durationInFrames - 1);
  const zoomIn = scene.n % 2 === 1;
  const camScale = interpolate(frame, [0, maxFrame], zoomIn ? [1.025, 1.09] : [1.09, 1.025], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const camPanX = interpolate(frame, [0, maxFrame], zoomIn ? [-10 * s, 10 * s] : [10 * s, -10 * s], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  const barPercent = isVertical ? '14%' : '11.5%';
  const textFade = interpolate(frame, [0, 14], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  const showOptionalCaptions = scene.assets?.some((a) => a.toLowerCase() === 'captions') ?? false;
  const captionChunks = showOptionalCaptions
    ? buildCaptionChunks(scene.narracao, Math.max(1, durationInFrames), 6)
    : [];
  const activeChunk =
    captionChunks.find((c) => frame >= c.startFrame && frame < c.endFrame) ??
    captionChunks[captionChunks.length - 1];

  return (
    <AbsoluteFill style={{ backgroundColor: '#070605', overflow: 'hidden' }}>
      {/* Janela widescreen central entre as barras cinematográficas */}
      <div
        style={{
          position: 'absolute',
          top: barPercent,
          bottom: barPercent,
          left: 0,
          right: 0,
          overflow: 'hidden',
          backgroundColor: '#1B140E',
        }}
      >
        <AbsoluteFill
          style={{
            transform: `scale(${camScale}) translateX(${camPanX}px)`,
            filter: scene.imageUrl ? 'contrast(1.04) saturate(0.92)' : undefined,
          }}
        >
          {scene.imageUrl ? (
            <Img
              src={scene.imageUrl}
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            />
          ) : (
            <svg
              viewBox="0 0 1920 1080"
              preserveAspectRatio="xMidYMid slice"
              style={{ width: '100%', height: '100%', display: 'block' }}
            >
              {scenario === 'chiaroscuro' ? (
                <ChiaroscuroArtwork frame={frame} />
              ) : scenario === 'classical-hall' ? (
                <ClassicalHallArtwork frame={frame} />
              ) : scenario === 'library-hall' ? (
                <LibraryHallArtwork frame={frame} />
              ) : scenario === 'quill-manuscript' ? (
                <QuillManuscriptArtwork frame={frame} />
              ) : scenario === 'hourglass-engraving' ? (
                <HourglassEngravingArtwork frame={frame} />
              ) : scenario === 'amphitheater' ? (
                <AmphitheaterArtwork frame={frame} />
              ) : scenario === 'still-life-book' ? (
                <StillLifeBookArtwork frame={frame} />
              ) : (
                <EngravingArtwork frame={frame} />
              )}
            </svg>
          )}
        </AbsoluteFill>

        {/* Vinheta cinematográfica suave nos cantos da pintura */}
        <AbsoluteFill
          style={{
            background:
              'radial-gradient(ellipse at center, rgba(7,6,5,0) 56%, rgba(7,6,5,0.52) 100%)',
            pointerEvents: 'none',
          }}
        />

        {/* Epígrafe ou título de capítulo opcional (apenas quando scene.textoNaTela estiver preenchido) */}
        {scene.textoNaTela && scene.textoNaTela.trim() !== '' ? (
          <div
            style={{
              position: 'absolute',
              left: 80 * s,
              right: 80 * s,
              bottom: '8%',
              textAlign: 'center',
              opacity: textFade,
              pointerEvents: 'none',
            }}
          >
            <span
              style={{
                fontFamily: 'Georgia, "Times New Roman", serif',
                fontWeight: 500,
                fontSize: (isVertical ? 38 : 34) * s,
                letterSpacing: '0.14em',
                color: theme.text,
                textShadow: `0 ${3 * s}px ${16 * s}px rgba(0, 0, 0, 0.92)`,
                backgroundColor: 'rgba(11, 10, 8, 0.42)',
                padding: `${10 * s}px ${26 * s}px`,
                borderRadius: 4 * s,
                display: 'inline-block',
              }}
            >
              {scene.textoNaTela}
            </span>
          </div>
        ) : null}
      </div>

      {/* Legenda editorial discreta na barra inferior SOMENTE quando assets inclui "captions" */}
      {activeChunk ? (
        <div
          style={{
            position: 'absolute',
            left: 80 * s,
            right: 80 * s,
            bottom: isVertical ? '4.5%' : '3%',
            textAlign: 'center',
            pointerEvents: 'none',
          }}
        >
          <span
            style={{
              fontFamily: 'Georgia, "Times New Roman", serif',
              fontSize: (isVertical ? 30 : 28) * s,
              color: '#E6D9B8',
              letterSpacing: '0.02em',
            }}
          >
            {activeChunk.text}
          </span>
        </div>
      ) : null}
    </AbsoluteFill>
  );
}
