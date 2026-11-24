import { AbsoluteFill, Img, interpolate, useCurrentFrame } from 'remotion';
import { OutlinedCaption } from '../components/OutlinedCaption';
import { useStudioScale } from '../components/scale';
import type { TemplateComponentProps } from '../types';

const INK = '#1C1917';
const SKIN = '#F7F3EA';

type ComicScenario = 'savanna' | 'tree-roots' | 'timeline' | 'nested-zoom';

function pickComicScenario(cenario: string | undefined, sceneIndex: number): ComicScenario {
  const norm = (cenario ?? '').trim().toLowerCase();
  if (norm === 'savanna' || norm === 'tree-roots' || norm === 'timeline' || norm === 'nested-zoom') {
    return norm;
  }
  const cycle: ComicScenario[] = ['savanna', 'nested-zoom', 'tree-roots', 'timeline'];
  return cycle[sceneIndex % cycle.length]!;
}

/** Mascote minimalista autoral em traço de tira 2D (cabeça arredondada clara + membros finos). */
function ComicCharacterSvg({
  frame,
  cx,
  cy,
  scale = 1,
  shirtColor = '#78614B',
  hairVariant = 0,
  pose = 'idle',
  expressao = 'neutral',
}: {
  frame: number;
  cx: number;
  cy: number;
  scale?: number;
  shirtColor?: string;
  hairVariant?: number;
  pose?: string;
  expressao?: string;
}) {
  const bob = pose === 'walking' ? Math.abs(Math.sin(frame * 0.2)) * -7 : Math.sin(frame * 0.08) * 3;
  const walkSwing = pose === 'walking' ? Math.sin(frame * 0.2) * 18 : 0;
  const blink = frame % 100 >= 95 ? 0.15 : 1;

  const isSurprised = expressao === 'surprised' || pose === 'shocked';
  const isHappy = expressao === 'happy' || pose === 'celebrating';
  const isSerious = expressao === 'serious' || pose === 'thinking';

  const leftArmD =
    pose === 'pointing' || pose === 'celebrating'
      ? 'M -24 -76 Q -56 -108 -74 -132'
      : pose === 'shocked'
        ? 'M -24 -76 Q -54 -96 -62 -120'
        : `M -24 -76 Q -38 ${-36 + walkSwing * 0.5} -34 ${-8 + walkSwing * 0.7}`;

  const rightArmD =
    pose === 'pointing'
      ? 'M 24 -76 Q 68 -86 106 -94'
      : pose === 'thinking'
        ? 'M 24 -76 Q 58 -84 26 -112'
        : pose === 'celebrating' || pose === 'shocked'
          ? 'M 24 -76 Q 56 -108 74 -132'
          : `M 24 -76 Q 38 ${-36 - walkSwing * 0.5} 34 ${-8 - walkSwing * 0.7}`;

  return (
    <g transform={`translate(${cx}, ${cy + bob}) scale(${scale})`} strokeLinecap="round" strokeLinejoin="round">
      {/* Sombra no chão */}
      <ellipse cx={0} cy={88} rx={36} ry={9} fill="rgba(28, 25, 23, 0.18)" />

      {/* Pernas estilo tira palito */}
      <path d={`M -12 8 L ${-18 - walkSwing * 0.7} 82`} fill="none" stroke={INK} strokeWidth={6} />
      <path d={`M 12 8 L ${18 + walkSwing * 0.7} 82`} fill="none" stroke={INK} strokeWidth={6} />
      <path d={`M ${-24 - walkSwing * 0.7} 83 L ${-10 - walkSwing * 0.7} 83`} fill="none" stroke={INK} strokeWidth={6} />
      <path d={`M ${12 + walkSwing * 0.7} 83 L ${28 + walkSwing * 0.7} 83`} fill="none" stroke={INK} strokeWidth={6} />

      {/* Braços */}
      <path d={leftArmD} fill="none" stroke={INK} strokeWidth={5.5} />
      <path d={rightArmD} fill="none" stroke={INK} strokeWidth={5.5} />

      {/* Túnica / camiseta terrosa */}
      <path
        d="M -25 -82 L 25 -82 L 32 12 L 10 8 L -8 14 L -30 10 Z"
        fill={shirtColor}
        stroke={INK}
        strokeWidth={4.5}
      />
      <path d="M -12 -82 Q 0 -68 12 -82" fill="none" stroke={INK} strokeWidth={3} opacity={0.65} />

      {/* Cabeça circular clara */}
      <circle cx={0} cy={-126} r={42} fill={SKIN} stroke={INK} strokeWidth={4.5} />

      {/* Cabelo opcional por variante (mantém silhueta neutra/clean) */}
      {hairVariant % 3 === 1 ? (
        <path
          d="M -38 -142 Q -32 -176 0 -174 Q 34 -176 39 -140 Q 24 -158 2 -152 Q -18 -160 -38 -142 Z"
          fill="#3E3228"
          stroke={INK}
          strokeWidth={4}
        />
      ) : null}
      {hairVariant % 3 === 2 ? (
        <path
          d="M -34 -146 L -22 -176 L -6 -160 L 12 -180 L 28 -158 L 40 -168 L 36 -138 Q 10 -158 -34 -146 Z"
          fill="#29231F"
          stroke={INK}
          strokeWidth={4}
        />
      ) : null}

      {/* Rosto */}
      <g transform={`translate(0, -124) scale(1, ${blink})`}>
        {isSurprised ? (
          <>
            <circle cx={-13} cy={-4} r={7.5} fill="#FFFFFF" stroke={INK} strokeWidth={3} />
            <circle cx={14} cy={-4} r={7.5} fill="#FFFFFF" stroke={INK} strokeWidth={3} />
            <circle cx={-12} cy={-4} r={2.8} fill={INK} />
            <circle cx={13} cy={-4} r={2.8} fill={INK} />
          </>
        ) : (
          <>
            <ellipse cx={-12} cy={-4} rx={4} ry={5} fill={INK} />
            <ellipse cx={14} cy={-4} rx={4} ry={5} fill={INK} />
          </>
        )}
        {isSerious ? (
          <>
            <path d="M -20 -15 L -5 -11" stroke={INK} strokeWidth={3} />
            <path d="M 6 -11 L 21 -15" stroke={INK} strokeWidth={3} />
          </>
        ) : null}
      </g>

      {/* Boca */}
      {isSurprised ? (
        <ellipse cx={1} cy={-104} rx={6.5} ry={8} fill="#D6A08C" stroke={INK} strokeWidth={3} />
      ) : isHappy ? (
        <path d="M -12 -106 Q 1 -94 14 -106" fill="none" stroke={INK} strokeWidth={3.5} />
      ) : (
        <path d="M -9 -104 Q 1 -102 10 -105" fill="none" stroke={INK} strokeWidth={3.5} />
      )}
    </g>
  );
}

/** Pequenos figurantes de fundo dando escala de grupo ou população distante. */
function DistantCrowdRow({
  count,
  startX,
  endX,
  baseY,
  scale = 0.24,
  frame,
}: {
  count: number;
  startX: number;
  endX: number;
  baseY: number;
  scale?: number;
  frame: number;
}) {
  const step = count <= 1 ? 0 : (endX - startX) / (count - 1);
  return (
    <g>
      {Array.from({ length: count }, (_, idx) => {
        const x = startX + idx * step;
        const yJitter = ((idx * 37) % 19) - 9;
        const microS = scale * (0.85 + ((idx * 17) % 5) * 0.08);
        const bob = Math.sin(frame * 0.05 + idx) * 1.5;
        return (
          <g key={idx} transform={`translate(${x}, ${baseY + yJitter + bob}) scale(${microS})`}>
            <path d="M -6 0 L -8 34 M 6 0 L 8 34" stroke={INK} strokeWidth={6} strokeLinecap="round" />
            <rect
              x={-11}
              y={-32}
              width={22}
              height={34}
              rx={5}
              fill={idx % 2 === 0 ? '#78614B' : '#5E7749'}
              stroke={INK}
              strokeWidth={5}
            />
            <circle cx={0} cy={-50} r={16} fill={SKIN} stroke={INK} strokeWidth={5} />
          </g>
        );
      })}
    </g>
  );
}

function SavannaBackdrop({
  frame,
  pose,
  expressao,
}: {
  frame: number;
  pose?: string;
  expressao?: string;
}) {
  const cloudShift = interpolate(frame, [0, 300], [0, 38], { extrapolateRight: 'clamp' });
  return (
    <g>
      {/* Céu suave em azul acinzentado */}
      <rect x={0} y={0} width={1920} height={470} fill="#B3CDD9" />
      <g transform={`translate(${cloudShift}, 0)`} opacity={0.8}>
        <path
          d="M 180 185 Q 240 135 320 155 Q 375 110 460 150 Q 530 140 570 185 Z"
          fill="#DFE9EE"
          stroke={INK}
          strokeWidth={2.5}
          opacity={0.75}
        />
        <path
          d="M 1220 155 Q 1295 100 1390 130 Q 1470 90 1560 135 Q 1630 125 1675 155 Z"
          fill="#DFE9EE"
          stroke={INK}
          strokeWidth={2.5}
          opacity={0.75}
        />
      </g>

      {/* Colinas distantes em linha de tinta */}
      <path
        d="M 0 385 Q 340 330 720 375 Q 1120 415 1520 350 Q 1740 320 1920 365 L 1920 480 L 0 480 Z"
        fill="#C9BA94"
        stroke={INK}
        strokeWidth={3}
      />

      {/* Planície ocre quente */}
      <rect x={0} y={445} width={1920} height={635} fill="#D8B76A" />
      <path d="M 0 445 L 1920 445" stroke={INK} strokeWidth={3.5} />
      <path d="M 180 615 Q 520 580 860 620" fill="none" stroke="#B7944C" strokeWidth={4} />
      <path d="M 1040 540 Q 1410 515 1780 555" fill="none" stroke="#B7944C" strokeWidth={4} />

      {/* Pedrinhas e tufos de capim */}
      {[
        { x: 240, y: 740, w: 68 },
        { x: 1470, y: 710, w: 84 },
        { x: 640, y: 840, w: 52 },
      ].map((rock, idx) => (
        <ellipse
          key={idx}
          cx={rock.x}
          cy={rock.y}
          rx={rock.w}
          ry={rock.w * 0.36}
          fill="#98866B"
          stroke={INK}
          strokeWidth={4}
        />
      ))}

      {/* População esparsa distante */}
      <DistantCrowdRow count={7} startX={230} endX={1680} baseY={495} scale={0.22} frame={frame} />

      {/* Grupo central de personagens */}
      <ComicCharacterSvg
        frame={frame}
        cx={710}
        cy={635}
        scale={1.08}
        shirtColor="#78614B"
        hairVariant={0}
        pose="idle"
        expressao="neutral"
      />
      <ComicCharacterSvg
        frame={frame}
        cx={960}
        cy={650}
        scale={1.18}
        shirtColor="#6E8A57"
        hairVariant={1}
        pose={pose}
        expressao={expressao}
      />
      <ComicCharacterSvg
        frame={frame}
        cx={1205}
        cy={638}
        scale={1.08}
        shirtColor="#8D7355"
        hairVariant={2}
        pose="pointing"
        expressao="surprised"
      />
    </g>
  );
}

function TreeRootsBackdrop({
  frame,
  pose,
  expressao,
}: {
  frame: number;
  pose?: string;
  expressao?: string;
}) {
  return (
    <g>
      <rect x={0} y={0} width={1920} height={540} fill="#B5CFD9" />
      <rect x={0} y={540} width={1920} height={540} fill="#D5BE84" />
      <path d="M 0 540 L 1920 540" stroke={INK} strokeWidth={3.5} />

      {/* Multidão à esquerda e à direita ao longe */}
      <DistantCrowdRow count={14} startX={80} endX={640} baseY={605} scale={0.26} frame={frame} />
      <DistantCrowdRow count={14} startX={1280} endX={1840} baseY={605} scale={0.26} frame={frame} />

      {/* Grande árvore genealógica com raízes ramificadas */}
      <g>
        <path
          d="M 790 210 L 825 510 Q 740 650 420 795 L 520 815 Q 765 705 860 645 Q 960 660 1055 645 Q 1165 715 1405 815 L 1515 790 Q 1190 650 1095 510 L 1135 210 Z"
          fill="#7D6750"
          stroke={INK}
          strokeWidth={5}
        />
        {/* Linhas de casca e raízes */}
        <path d="M 885 250 Q 890 420 855 560" fill="none" stroke={INK} strokeWidth={4} opacity={0.6} />
        <path d="M 970 245 Q 960 410 990 565" fill="none" stroke={INK} strokeWidth={4} opacity={0.6} />
        <path d="M 1035 255 Q 1030 430 1065 570" fill="none" stroke={INK} strokeWidth={4} opacity={0.6} />

        {/* Copa folhosa em oliva */}
        <ellipse cx={690} cy={175} rx={360} ry={175} fill="#6E8A57" stroke={INK} strokeWidth={5} />
        <ellipse cx={1235} cy={175} rx={360} ry={175} fill="#6E8A57" stroke={INK} strokeWidth={5} />
        <ellipse cx={960} cy={135} rx={420} ry={190} fill="#7E9B63" stroke={INK} strokeWidth={5} />
      </g>

      {/* Núcleo pequeno abrigado nas raízes */}
      <ComicCharacterSvg
        frame={frame}
        cx={815}
        cy={685}
        scale={0.86}
        shirtColor="#78614B"
        hairVariant={1}
        pose="idle"
        expressao="neutral"
      />
      <ComicCharacterSvg
        frame={frame}
        cx={965}
        cy={675}
        scale={1.0}
        shirtColor="#6E8A57"
        hairVariant={2}
        pose={pose}
        expressao={expressao}
      />
      <ComicCharacterSvg
        frame={frame}
        cx={1115}
        cy={688}
        scale={0.84}
        shirtColor="#8D7355"
        hairVariant={0}
        pose="celebrating"
        expressao="happy"
      />
    </g>
  );
}

function TimelineBackdrop({
  frame,
  pose,
  expressao,
  assets = [],
  titulo,
}: {
  frame: number;
  pose?: string;
  expressao?: string;
  assets?: string[];
  titulo: string;
}) {
  const pulse = 1 + Math.sin(frame * 0.1) * 0.04;
  const labels =
    assets.length >= 3
      ? assets.slice(0, 3)
      : assets.length > 0
        ? [assets[0]!, 'VIRADA', 'ESCALA']
        : ['INÍCIO', titulo.slice(0, 14).toUpperCase(), 'HOJE'];

  return (
    <g>
      <rect x={0} y={0} width={1920} height={410} fill="#BFD5DF" />
      <rect x={0} y={410} width={1920} height={670} fill="#DFC37E" />
      <path d="M 0 410 L 1920 410" stroke={INK} strokeWidth={3.5} />

      {/* Caminho de linha do tempo em perspectiva suave */}
      <path
        d="M 220 560 Q 620 490 960 560 Q 1300 630 1690 520"
        fill="none"
        stroke="#7D6750"
        strokeWidth={24}
        strokeLinecap="round"
      />
      <path
        d="M 220 560 Q 620 490 960 560 Q 1300 630 1690 520"
        fill="none"
        stroke={INK}
        strokeWidth={5}
        strokeDasharray="18 14"
      />

      {/* Marcos ilustrados */}
      {[
        { x: 380, y: 530, label: labels[0]! },
        { x: 960, y: 560, label: labels[1]! },
        { x: 1520, y: 545, label: labels[2]! },
      ].map((node, idx) => (
        <g
          key={idx}
          transform={`translate(${node.x}, ${node.y - 165}) scale(${idx === 1 ? pulse : 1})`}
        >
          <line x1={0} y1={52} x2={0} y2={155} stroke={INK} strokeWidth={5} />
          <rect
            x={-115}
            y={-42}
            width={230}
            height={90}
            rx={22}
            fill={idx === 1 ? '#F5D838' : '#FBF5E6'}
            stroke={INK}
            strokeWidth={5}
          />
          <text
            x={0}
            y={12}
            textAnchor="middle"
            fill={INK}
            fontSize={28}
            fontWeight={900}
            fontFamily="Segoe UI, Arial, sans-serif"
          >
            {node.label.slice(0, 14)}
          </text>
        </g>
      ))}

      <ComicCharacterSvg
        frame={frame}
        cx={960}
        cy={725}
        scale={1.16}
        shirtColor="#6E8A57"
        hairVariant={1}
        pose={pose ?? 'pointing'}
        expressao={expressao}
      />
    </g>
  );
}

/** Template Comic 2D 16:9 inspirado no formato tira/explicador ilustrado com zoom em quadro aninhado. */
export function ComicExplainerTemplate({
  scene,
  sceneIndex,
  durationInFrames,
  theme,
  titulo,
}: TemplateComponentProps) {
  const frame = useCurrentFrame();
  const { s, isVertical } = useStudioScale();

  const scenario = pickComicScenario(scene.cenario, sceneIndex);
  const isNestedZoom = scenario === 'nested-zoom' || scene.transicao === 'zoom';

  const zoomIn = scene.n % 2 === 1;
  const maxFrame = Math.max(1, durationInFrames - 1);
  const camScale = interpolate(frame, [0, maxFrame], zoomIn ? [1.0, 1.06] : [1.06, 1.0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const camPanX = interpolate(frame, [0, maxFrame], zoomIn ? [-6, 6] : [6, -6], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  // Progresso do recuo picture-in-frame (1.0 -> 0.74) com intervalos estritamente crescentes.
  const p1 = Math.max(6, Math.round(durationInFrames * 0.18));
  const p2 = Math.max(p1 + 6, Math.round(durationInFrames * 0.75));
  const zoomProgress = interpolate(frame, [0, p1, p2], [0, 0.12, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const insetScale = interpolate(zoomProgress, [0, 1], [1.0, 0.74]);
  const backdropScale = interpolate(zoomProgress, [0, 1], [1.08, 1.0]);
  const frameBorderOpacity = interpolate(zoomProgress, [0, 0.25, 1], [0, 0.55, 0.85]);

  const renderScenarioArtwork = (activeScenario: ComicScenario) => {
    if (scene.imageUrl) {
      return (
        <Img
          src={scene.imageUrl}
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
        />
      );
    }

    return (
      <svg
        viewBox="0 0 1920 1080"
        preserveAspectRatio="xMidYMid slice"
        style={{ width: '100%', height: '100%', display: 'block' }}
      >
        {activeScenario === 'tree-roots' ? (
          <TreeRootsBackdrop frame={frame} pose={scene.pose} expressao={scene.expressao} />
        ) : activeScenario === 'timeline' ? (
          <TimelineBackdrop
            frame={frame}
            pose={scene.pose}
            expressao={scene.expressao}
            assets={scene.assets}
            titulo={titulo}
          />
        ) : (
          <SavannaBackdrop frame={frame} pose={scene.pose} expressao={scene.expressao} />
        )}
      </svg>
    );
  };

  return (
    <AbsoluteFill style={{ backgroundColor: theme.background, overflow: 'hidden' }}>
      {isNestedZoom ? (
        <>
          {/* Camada panorâmica de fundo */}
          <AbsoluteFill
            style={{
              transform: `scale(${backdropScale})`,
              filter: 'saturate(0.92) brightness(0.96)',
            }}
          >
            {renderScenarioArtwork(sceneIndex % 2 === 0 ? 'savanna' : 'tree-roots')}
          </AbsoluteFill>

          {/* Quadro interno recuando em escala para revelar o contexto amplo */}
          <AbsoluteFill
            style={{
              transform: `scale(${insetScale})`,
              boxShadow: `0 ${18 * s}px ${48 * s}px rgba(28, 25, 23, ${frameBorderOpacity * 0.45})`,
              outline: `${Math.max(2, 4 * s)}px solid rgba(28, 25, 23, ${frameBorderOpacity * 0.65})`,
              overflow: 'hidden',
            }}
          >
            {renderScenarioArtwork('savanna')}
          </AbsoluteFill>
        </>
      ) : (
        <AbsoluteFill style={{ transform: `scale(${camScale}) translateX(${camPanX}px)` }}>
          {renderScenarioArtwork(scenario)}
        </AbsoluteFill>
      )}

      {/* Vinheta inferior discreta apenas para contraste confortável da legenda */}
      <AbsoluteFill
        style={{
          background:
            'linear-gradient(180deg, rgba(28,25,23,0) 68%, rgba(28,25,23,0.40) 100%)',
          pointerEvents: 'none',
        }}
      />

      {/* Selo compacto em pergaminho só quando scene.textoNaTela existir */}
      {scene.textoNaTela && scene.textoNaTela.trim() !== '' ? (
        <div
          style={{
            position: 'absolute',
            top: (isVertical ? 90 : 42) * s,
            left: (isVertical ? 44 : 56) * s,
            padding: `${10 * s}px ${22 * s}px`,
            borderRadius: 12 * s,
            backgroundColor: '#FBF5E6',
            border: `${Math.max(2, 3.5 * s)}px solid ${INK}`,
            boxShadow: `${4 * s}px ${4 * s}px 0 ${INK}`,
            zIndex: 25,
          }}
        >
          <span
            style={{
              fontFamily: '"Segoe UI", "Arial", sans-serif',
              fontWeight: 900,
              fontSize: (isVertical ? 28 : 26) * s,
              color: INK,
              letterSpacing: '0.02em',
            }}
          >
            {scene.textoNaTela}
          </span>
        </div>
      ) : null}

      <OutlinedCaption
        text={scene.narracao}
        durationInFrames={durationInFrames}
        accentColor={theme.accent}
        uppercase={false}
        position="bottom"
        maxWordsPerChunk={4}
      />
    </AbsoluteFill>
  );
}
