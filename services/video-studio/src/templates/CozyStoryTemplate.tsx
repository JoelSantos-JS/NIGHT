import { AbsoluteFill, Img, interpolate, useCurrentFrame } from 'remotion';
import { ItalicKeywordCaption } from '../components/ItalicKeywordCaption';
import { useStudioScale } from '../components/scale';
import type { TemplateComponentProps } from '../types';

const LINE = '#3B2C24';
const MASCOT_HEAD = '#F6F3EC';

type CozyScenario = 'office' | 'cafe' | 'research' | 'living-room';

function pickCozyScenario(cenario: string | undefined, sceneIndex: number): CozyScenario {
  const norm = (cenario ?? '').trim().toLowerCase();
  if (norm === 'office' || norm === 'cafe' || norm === 'research' || norm === 'living-room') {
    return norm;
  }
  const cycle: CozyScenario[] = ['office', 'cafe', 'research', 'living-room'];
  return cycle[sceneIndex % cycle.length]!;
}

/** Personagem minimalista com braços em tubo macio e expressão calma para cenários aconchegantes. */
function CozyCharacterSvg({
  frame,
  cx,
  cy,
  scale = 1,
  pose = 'idle',
  expressao = 'neutral',
}: {
  frame: number;
  cx: number;
  cy: number;
  scale?: number;
  pose?: string;
  expressao?: string;
}) {
  const breathe = Math.sin(frame * 0.06) * 3;
  const reachWave = pose === 'pointing' ? Math.sin(frame * 0.09) * 5 : Math.sin(frame * 0.05) * 2;
  const blink = frame % 115 >= 110 ? 0.15 : 1;

  const isSerious = expressao === 'serious' || pose === 'thinking';
  const isSurprised = expressao === 'surprised';

  return (
    <g transform={`translate(${cx}, ${cy + breathe}) scale(${scale})`} strokeLinecap="round" strokeLinejoin="round">
      {/* Calça cáqui sentado/apoiado */}
      <path
        d="M -66 72 Q -68 150 -48 210 L 68 210 Q 80 148 64 72 Z"
        fill="#B6996F"
        stroke={LINE}
        strokeWidth={4.5}
      />

      {/* Camiseta verde sálvia */}
      <path
        d="M -68 -52 Q 0 -64 68 -52 L 74 82 Q 0 92 -72 82 Z"
        fill="#8FA876"
        stroke={LINE}
        strokeWidth={4.5}
      />

      {/* Manga e braço esquerdo em tubo comprido (gesto no quadro/papel) */}
      {pose === 'pointing' ? (
        <g>
          <path
            d="M -66 -32 L -116 -56 L -102 -88 L -54 -62 Z"
            fill="#8FA876"
            stroke={LINE}
            strokeWidth={4.5}
          />
          <path
            d={`M -112 -74 Q -215 ${-130 + reachWave} -305 ${-182 + reachWave}`}
            fill="none"
            stroke={LINE}
            strokeWidth={34}
          />
          <path
            d={`M -112 -74 Q -215 ${-130 + reachWave} -305 ${-182 + reachWave}`}
            fill="none"
            stroke={MASCOT_HEAD}
            strokeWidth={25}
          />
          <circle cx={-312} cy={-186 + reachWave} r={16} fill={MASCOT_HEAD} stroke={LINE} strokeWidth={4} />
        </g>
      ) : (
        <g>
          <path
            d="M -68 -36 L -104 22 L -74 36 L -44 -14 Z"
            fill="#8FA876"
            stroke={LINE}
            strokeWidth={4.5}
          />
          <path
            d={`M -92 26 Q -114 82 -52 ${108 + reachWave}`}
            fill="none"
            stroke={LINE}
            strokeWidth={30}
          />
          <path
            d={`M -92 26 Q -114 82 -52 ${108 + reachWave}`}
            fill="none"
            stroke={MASCOT_HEAD}
            strokeWidth={22}
          />
        </g>
      )}

      {/* Braço direito apoiado */}
      <path
        d="M 66 -34 L 98 22 L 68 38 L 42 -10 Z"
        fill="#8FA876"
        stroke={LINE}
        strokeWidth={4.5}
      />
      <path
        d={`M 82 28 Q 92 86 42 ${114 - reachWave}`}
        fill="none"
        stroke={LINE}
        strokeWidth={30}
      />
      <path
        d={`M 82 28 Q 92 86 42 ${114 - reachWave}`}
        fill="none"
        stroke={MASCOT_HEAD}
        strokeWidth={22}
      />

      {/* Cabeça arredondada clara */}
      <ellipse cx={0} cy={-136} rx={84} ry={78} fill={MASCOT_HEAD} stroke={LINE} strokeWidth={4.5} />
      {/* Pequeno topete suave */}
      <path
        d="M -38 -206 L -22 -224 L -4 -209 L 16 -225 L 34 -204"
        fill={MASCOT_HEAD}
        stroke={LINE}
        strokeWidth={4}
      />

      {/* Olhos calmos */}
      <g transform={`translate(-14, -138) scale(1, ${blink})`}>
        <circle cx={-26} cy={0} r={5.5} fill={LINE} />
        <circle cx={22} cy={0} r={5.5} fill={LINE} />
        {isSerious ? (
          <>
            <path d="M -38 -15 L -16 -9" stroke={LINE} strokeWidth={3.5} />
            <path d="M 12 -9 L 34 -15" stroke={LINE} strokeWidth={3.5} />
          </>
        ) : null}
      </g>

      {/* Boca */}
      {isSurprised ? (
        <ellipse cx={-12} cy={-108} rx={9} ry={10} fill="#D4A38B" stroke={LINE} strokeWidth={3.5} />
      ) : isSerious ? (
        <path d="M -26 -108 Q -12 -114 4 -108" fill="none" stroke={LINE} strokeWidth={3.5} />
      ) : (
        <path d="M -28 -110 Q -12 -98 8 -112" fill="none" stroke={LINE} strokeWidth={3.8} />
      )}
    </g>
  );
}

function OfficeCozyBackdrop({
  frame,
  pose,
  expressao,
}: {
  frame: number;
  pose?: string;
  expressao?: string;
}) {
  const dustShift = Math.sin(frame * 0.04) * 12;
  const stickyColors = [
    '#F5B7C5', '#F9E498', '#BFE2A8', '#F2C799',
    '#F5B7C5', '#A8D8EA', '#F9E498', '#A8D8EA',
    '#A8D8EA', '#BFE2A8', '#F9E498', '#F5B7C5',
  ];

  return (
    <g>
      {/* Parede creme aquecida pela luz da tarde */}
      <rect x={0} y={0} width={1920} height={800} fill="#E6D2B2" />
      <rect x={0} y={770} width={1920} height={310} fill="#C6A47E" />
      <line x1={0} y1={770} x2={1920} y2={770} stroke={LINE} strokeWidth={4} />

      {/* Janela iluminada à direita */}
      <g transform="translate(1540, 40)">
        <rect x={0} y={0} width={350} height={540} fill="#F8ECCB" stroke={LINE} strokeWidth={5} />
        <line x1={175} y1={0} x2={175} y2={540} stroke={LINE} strokeWidth={5} />
        <line x1={0} y1={270} x2={350} y2={270} stroke={LINE} strokeWidth={5} />
        {/* Plantinha na soleira */}
        <rect x={48} y={460} width={86} height={74} rx={8} fill="#C97D52" stroke={LINE} strokeWidth={4} />
        <path d="M 90 460 Q 52 395 45 365 Q 85 385 95 450 Q 112 365 148 355 Q 140 415 102 460 Z" fill="#7D9963" stroke={LINE} strokeWidth={4} />
      </g>

      {/* Estante lateral à esquerda */}
      <g transform="translate(0, 0)">
        <rect x={-10} y={0} width={285} height={760} fill="#966A48" stroke={LINE} strokeWidth={5} />
        <rect x={12} y={240} width={240} height={24} fill="#7B5336" stroke={LINE} strokeWidth={4} />
        <rect x={12} y={500} width={240} height={24} fill="#7B5336" stroke={LINE} strokeWidth={4} />
        <rect x={28} y={60} width={52} height={180} fill="#6F8C7C" stroke={LINE} strokeWidth={4} />
        <rect x={82} y={92} width={48} height={148} fill="#B36E59" stroke={LINE} strokeWidth={4} />
        <rect x={148} y={146} width={72} height={94} rx={6} fill="#C58255" stroke={LINE} strokeWidth={4} />
        <ellipse cx={184} cy={126} rx={36} ry={22} fill="#7B9B64" stroke={LINE} strokeWidth={4} />
        <rect x={35} y={300} width={55} height={200} fill="#9D5E4C" stroke={LINE} strokeWidth={4} />
        <rect x={92} y={335} width={45} height={165} fill="#CBB489" stroke={LINE} strokeWidth={4} />
      </g>

      {/* Quadro de cortiça central com notas adesivas */}
      <g transform="translate(425, 110)">
        <rect x={0} y={0} width={780} height={470} rx={8} fill="#B28459" stroke={LINE} strokeWidth={6} />
        <rect x={26} y={26} width={728} height={418} fill="#CC9F72" stroke={LINE} strokeWidth={4} />
        {stickyColors.map((color, idx) => {
          const col = idx % 4;
          const row = Math.floor(idx / 4);
          return (
            <g key={idx} transform={`translate(${76 + col * 168}, ${54 + row * 126})`}>
              <rect x={0} y={0} width={110} height={98} fill={color} stroke={LINE} strokeWidth={3.5} />
              <circle cx={55} cy={12} r={5} fill="#5C4938" />
            </g>
          );
        })}
      </g>

      {/* Escrivaninha de madeira quente e objetos */}
      <g transform="translate(360, 620)">
        <polygon points="0,70 960,0 1120,160 120,250" fill="#B8875B" stroke={LINE} strokeWidth={5} />
        {/* Porta-canetas e bloco */}
        <rect x={390} y={24} width={56} height={74} rx={6} fill="#CFA073" stroke={LINE} strokeWidth={4} />
        <rect x={545} y={-8} width={220} height={124} rx={10} fill="#A7A195" stroke={LINE} strokeWidth={4.5} />
        <ellipse cx={690} cy={62} rx={34} ry={18} fill="#DFBE5E" stroke={LINE} strokeWidth={3.5} />
        {/* Pilha de cadernos PLANS na esquerda */}
        {[0, 1, 2, 3].map((row) => (
          <rect
            key={row}
            x={-260}
            y={-40 + row * 46}
            width={340}
            height={42}
            rx={6}
            fill={row % 2 === 0 ? '#A49A8B' : '#7E8791'}
            stroke={LINE}
            strokeWidth={4}
          />
        ))}
      </g>

      {/* Luminária quente próxima à mesa */}
      <g transform="translate(1155, 420)">
        <path d="M 45 200 L 18 90 L -20 40" fill="none" stroke="#857869" strokeWidth={12} strokeLinecap="round" />
        <path d="M -52 55 L -2 55 L -22 10 L -42 18 Z" fill="#9E7C5D" stroke={LINE} strokeWidth={4} />
      </g>

      {/* Cadeira de madeira atrás/sob o personagem */}
      <g transform="translate(1395, 760)">
        <rect x={-110} y={-20} width={220} height={140} rx={18} fill="#9B6E4A" stroke={LINE} strokeWidth={4.5} />
        <rect x={-96} y={70} width={192} height={36} rx={10} fill="#7B5234" stroke={LINE} strokeWidth={4.5} />
        <line x1={-76} y1={106} x2={-86} y2={230} stroke={LINE} strokeWidth={12} strokeLinecap="round" />
        <line x1={76} y1={106} x2={86} y2={230} stroke={LINE} strokeWidth={12} strokeLinecap="round" />
      </g>

      {/* Personagem sentado na cadeira de madeira */}
      <CozyCharacterSvg
        frame={frame}
        cx={1395}
        cy={620}
        scale={1.15}
        pose={pose ?? 'pointing'}
        expressao={expressao}
      />

      {/* Braço/encosto direito em primeiro plano parcial da cadeira */}
      <path
        d="M 1490 735 L 1540 970 M 1490 735 Q 1525 795 1475 840"
        fill="none"
        stroke={LINE}
        strokeWidth={24}
        strokeLinecap="round"
      />
      <path
        d="M 1490 735 L 1540 970 M 1490 735 Q 1525 795 1475 840"
        fill="none"
        stroke="#8B6141"
        strokeWidth={15}
        strokeLinecap="round"
      />

      {/* Feixe dourado suave vindo da janela */}
      <polygon
        points={`1560,0 1920,0 1920,1080 ${980 + dustShift},1080`}
        fill="rgba(255, 240, 195, 0.22)"
        pointerEvents="none"
      />
    </g>
  );
}

function CafeCozyBackdrop({
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
      {/* Parede cremosa e porta de vidro à esquerda */}
      <rect x={0} y={0} width={1920} height={740} fill="#E4CEB0" />
      <rect x={28} y={65} width={450} height={700} fill="#EFE2C8" stroke={LINE} strokeWidth={5} />
      <line x1={250} y1={65} x2={250} y2={765} stroke={LINE} strokeWidth={5} />

      {/* Piso quadriculado terracota e creme */}
      <rect x={0} y={730} width={1920} height={350} fill="#EAD5BF" />
      {Array.from({ length: 12 }, (_, col) => (
        <rect
          key={col}
          x={col * 165}
          y={765 + (col % 2 === 0 ? 0 : 120)}
          width={145}
          height={110}
          fill="#C98A69"
          opacity={0.78}
        />
      ))}

      {/* Prateleira de pães e vitrine */}
      <rect x={1230} y={135} width={660} height={385} fill="#8B6141" stroke={LINE} strokeWidth={5} />
      {Array.from({ length: 7 }, (_, i) => (
        <ellipse
          key={i}
          cx={1300 + i * 82}
          cy={235}
          rx={24}
          ry={52}
          fill="#DDA859"
          stroke={LINE}
          strokeWidth={4}
        />
      ))}

      {/* Balcão e luminárias suspensas */}
      <rect x={1185} y={530} width={720} height={300} fill="#A3734E" stroke={LINE} strokeWidth={5} />
      {[1080, 1390, 1710].map((lx, idx) => (
        <g key={idx} transform={`translate(${lx}, 0)`}>
          <line x1={0} y1={0} x2={0} y2={135} stroke={LINE} strokeWidth={4} />
          <path d="M -55 150 Q 0 95 55 150 Z" fill="#C9A87D" stroke={LINE} strokeWidth={4} />
        </g>
      ))}

      <CozyCharacterSvg
        frame={frame}
        cx={610}
        cy={605}
        scale={1.25}
        pose={pose ?? 'thinking'}
        expressao={expressao}
      />

      {/* Mesa redonda clara de bistrô */}
      <g transform="translate(875, 765)">
        <rect x={-18} y={15} width={36} height={240} fill="#7B6E63" stroke={LINE} strokeWidth={4} />
        <ellipse cx={0} cy={0} rx={270} ry={66} fill="#EAE4DB" stroke={LINE} strokeWidth={5} />
        <ellipse cx={-75} cy={-8} rx={36} ry={22} fill="#C8BEB3" stroke={LINE} strokeWidth={3.5} />
        <ellipse cx={50} cy={-16} rx={48} ry={26} fill="#DDA552" stroke={LINE} strokeWidth={3.5} />
      </g>
    </g>
  );
}

function ResearchLampBackdrop({
  frame,
  pose,
  expressao,
}: {
  frame: number;
  pose?: string;
  expressao?: string;
}) {
  const glowScale = 1 + Math.sin(frame * 0.08) * 0.03;
  return (
    <g>
      {/* Fundo sépia acolhedor (acima do limite do blackdetect) */}
      <rect x={0} y={0} width={1920} height={1080} fill="#36271D" />
      <rect x={0} y={710} width={1920} height={370} fill="#5C402B" />
      <line x1={0} y1={710} x2={1920} y2={710} stroke={LINE} strokeWidth={5} />

      {/* Cone dourado alinhado exatamente à boca da luminária */}
      <polygon
        points="1182,276 620,960 1540,960 1263,300"
        fill="rgba(250, 214, 130, 0.20)"
        transform={`translate(1222, 288) scale(${glowScale}) translate(-1222, -288)`}
      />

      {/* Quadro de anotações iluminado ao centro */}
      <rect x={540} y={145} width={720} height={405} rx={12} fill="#4D3627" stroke="#221710" strokeWidth={6} />
      <rect x={600} y={200} width={175} height={135} fill="#E9D6A9" stroke={LINE} strokeWidth={4} />
      <rect x={815} y={215} width={185} height={135} fill="#C5DCAC" stroke={LINE} strokeWidth={4} />
      <rect x={1035} y={195} width={165} height={135} fill="#F3C1C6" stroke={LINE} strokeWidth={4} />
      <path d="M 690 270 L 905 282 L 1118 262" fill="none" stroke="#D9534F" strokeWidth={5} />

      {/* Luminária articulada */}
      <g transform="translate(1310, 480)">
        <path d="M 105 230 L 40 40 L -80 -195" fill="none" stroke="#9B8265" strokeWidth={14} strokeLinecap="round" />
        <path d="M -130 -205 L -45 -180 L -75 -235 Z" fill="#C79658" stroke={LINE} strokeWidth={4.5} />
      </g>

      <CozyCharacterSvg
        frame={frame}
        cx={910}
        cy={620}
        scale={1.12}
        pose={pose ?? 'thinking'}
        expressao={expressao}
      />

      {/* Bancada da mesa em primeiro plano apoiando os documentos */}
      <rect x={0} y={770} width={1920} height={310} fill="#674831" />
      <line x1={0} y1={770} x2={1920} y2={770} stroke={LINE} strokeWidth={5} />
      <rect x={555} y={792} width={220} height={122} rx={8} fill="#F4ECDC" stroke={LINE} strokeWidth={4} />
      <rect x={985} y={802} width={240} height={122} rx={8} fill="#EFE2C6" stroke={LINE} strokeWidth={4} />
    </g>
  );
}

function LivingRoomBackdrop({
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
      <rect x={0} y={0} width={1920} height={760} fill="#EDE0C7" />
      <rect x={0} y={760} width={1920} height={320} fill="#B88E65" />
      <line x1={0} y1={760} x2={1920} y2={760} stroke={LINE} strokeWidth={4} />

      {/* Grande janela à esquerda */}
      <rect x={95} y={85} width={480} height={510} fill="#FBF2D5" stroke={LINE} strokeWidth={5} />
      <line x1={335} y1={85} x2={335} y2={595} stroke={LINE} strokeWidth={5} />
      <line x1={95} y1={340} x2={575} y2={340} stroke={LINE} strokeWidth={5} />

      {/* Quadros aconchegantes */}
      <rect x={750} y={175} width={240} height={180} rx={8} fill="#8FA876" stroke={LINE} strokeWidth={5} />
      <rect x={1040} y={205} width={205} height={150} rx={8} fill="#D59B6F" stroke={LINE} strokeWidth={5} />

      {/* Poltrona acolhedora */}
      <rect x={765} y={505} width={490} height={275} rx={36} fill="#7B9367" stroke={LINE} strokeWidth={5} />

      <CozyCharacterSvg
        frame={frame}
        cx={1010}
        cy={620}
        scale={1.18}
        pose={pose ?? 'idle'}
        expressao={expressao}
      />

      {/* Planta alta na direita */}
      <rect x={1560} y={625} width={130} height={140} rx={12} fill="#BA724D" stroke={LINE} strokeWidth={5} />
      <path d="M 1625 625 Q 1560 465 1525 385 Q 1605 425 1625 580 Q 1675 415 1745 365 Q 1715 485 1640 625 Z" fill="#6F8C58" stroke={LINE} strokeWidth={4.5} />

      <polygon points="100,85 575,85 1040,1080 280,1080" fill="rgba(255, 244, 204, 0.20)" />
    </g>
  );
}

/** Template Narrativa Cozy 2D 16:9 com luz dourada quente, câmera suave e legenda itálica branca/amarela. */
export function CozyStoryTemplate({
  scene,
  sceneIndex,
  durationInFrames,
  theme,
}: TemplateComponentProps) {
  const frame = useCurrentFrame();
  const { s, isVertical } = useStudioScale();

  const scenario = pickCozyScenario(scene.cenario, sceneIndex);
  const zoomIn = scene.n % 2 === 1;
  const maxFrame = Math.max(1, durationInFrames - 1);
  const camScale = interpolate(frame, [0, maxFrame], zoomIn ? [1.0, 1.07] : [1.07, 1.01], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const camPanX = interpolate(frame, [0, maxFrame], zoomIn ? [-10, 10] : [10, -10], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <AbsoluteFill style={{ backgroundColor: theme.background, overflow: 'hidden' }}>
      <AbsoluteFill style={{ transform: `scale(${camScale}) translateX(${camPanX}px)` }}>
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
            {scenario === 'cafe' ? (
              <CafeCozyBackdrop frame={frame} pose={scene.pose} expressao={scene.expressao} />
            ) : scenario === 'research' ? (
              <ResearchLampBackdrop frame={frame} pose={scene.pose} expressao={scene.expressao} />
            ) : scenario === 'living-room' ? (
              <LivingRoomBackdrop frame={frame} pose={scene.pose} expressao={scene.expressao} />
            ) : (
              <OfficeCozyBackdrop frame={frame} pose={scene.pose} expressao={scene.expressao} />
            )}
          </svg>
        )}
      </AbsoluteFill>

      {/* Banho suave de luz dourada no canto */}
      <AbsoluteFill
        style={{
          background:
            'radial-gradient(circle at 86% 14%, rgba(242, 223, 178, 0.16) 0%, rgba(242, 223, 178, 0) 55%)',
          pointerEvents: 'none',
        }}
      />

      {/* Sombra leve na base para legibilidade da legenda itálica branca/amarela */}
      <AbsoluteFill
        style={{
          background:
            'linear-gradient(180deg, rgba(18,12,8,0) 68%, rgba(18,12,8,0.46) 100%)',
          pointerEvents: 'none',
        }}
      />

      {/* Post-it opcional no canto superior esquerdo apenas quando scene.textoNaTela estiver preenchido */}
      {scene.textoNaTela && scene.textoNaTela.trim() !== '' ? (
        <div
          style={{
            position: 'absolute',
            top: (isVertical ? 88 : 42) * s,
            left: (isVertical ? 44 : 56) * s,
            padding: `${10 * s}px ${22 * s}px`,
            borderRadius: 10 * s,
            backgroundColor: '#FBF1C7',
            border: `${Math.max(2, 3 * s)}px solid ${LINE}`,
            boxShadow: `0 ${6 * s}px ${18 * s}px rgba(24, 16, 10, 0.25)`,
            display: 'flex',
            alignItems: 'center',
            gap: 10 * s,
            zIndex: 25,
          }}
        >
          <span
            style={{
              width: 10 * s,
              height: 10 * s,
              borderRadius: '50%',
              backgroundColor: '#C57B45',
              display: 'inline-block',
            }}
          />
          <span
            style={{
              fontFamily: '"Segoe UI", "Arial", sans-serif',
              fontWeight: 800,
              fontSize: (isVertical ? 26 : 24) * s,
              color: LINE,
            }}
          >
            {scene.textoNaTela}
          </span>
        </div>
      ) : null}

      <ItalicKeywordCaption
        text={scene.narracao}
        durationInFrames={durationInFrames}
        textColor={theme.text}
        accentColor={theme.accent}
      />
    </AbsoluteFill>
  );
}
