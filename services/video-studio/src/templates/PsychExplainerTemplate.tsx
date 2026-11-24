import { AbsoluteFill, Img, interpolate, useCurrentFrame } from 'remotion';
import { ItalicKeywordCaption } from '../components/ItalicKeywordCaption';
import { useStudioScale } from '../components/scale';
import type { TemplateComponentProps } from '../types';

const INK = '#141414';
const SKIN = '#F6D8BE';

type PsychScenario =
  | 'study-desk'
  | 'panic-desk'
  | 'brain-diagram'
  | 'flashcard'
  | 'highlighter-book'
  | 'neural-trail'
  | 'feynman-teach'
  | 'gap-lightbulbs';

const SCENARIO_BG: Record<PsychScenario, string> = {
  'study-desk': '#B8E6EC',
  'panic-desk': '#EFE58E',
  'brain-diagram': '#DFE1E4',
  flashcard: '#CFE8D5',
  'highlighter-book': '#B8E6EC',
  'neural-trail': '#B8E6EC',
  'feynman-teach': '#EFE58E',
  'gap-lightbulbs': '#DFE1E4',
};

const VALID_PSYCH_SCENARIOS = new Set<string>(Object.keys(SCENARIO_BG));

function pickPsychScenario(cenario: string | undefined, sceneIndex: number): PsychScenario {
  const norm = (cenario ?? '').trim().toLowerCase();
  if (VALID_PSYCH_SCENARIOS.has(norm)) {
    return norm as PsychScenario;
  }
  const cycle: PsychScenario[] = [
    'panic-desk',
    'highlighter-book',
    'brain-diagram',
    'flashcard',
    'neural-trail',
    'feynman-teach',
    'gap-lightbulbs',
    'study-desk',
  ];
  return cycle[sceneIndex % cycle.length]!;
}

/** Personagem 2D autoral em traço preto forte para explicações de psicologia/aprendizado. */
function ExplainerCharacterSvg({
  frame,
  cx,
  cy,
  scale = 1,
  shirtColor = '#2E7D32',
  pose = 'idle',
  expressao = 'neutral',
}: {
  frame: number;
  cx: number;
  cy: number;
  scale?: number;
  shirtColor?: string;
  pose?: string;
  expressao?: string;
}) {
  const bob = pose === 'panicking' ? Math.sin(frame * 0.45) * 4 : Math.sin(frame * 0.08) * 3;
  const blink = frame % 110 >= 106 ? 0.15 : 1;
  const isPanicking = pose === 'panicking' || pose === 'shocked' || expressao === 'surprised';
  const isHappy = expressao === 'happy' || pose === 'happy' || pose === 'celebrating';

  return (
    <g transform={`translate(${cx}, ${cy + bob}) scale(${scale})`} strokeLinecap="round" strokeLinejoin="round">
      {/* Pernas/calça */}
      <path
        d="M -46 65 L -52 195 L -10 195 L 0 115 L 12 195 L 54 195 L 48 65 Z"
        fill="#2B598A"
        stroke={INK}
        strokeWidth={5.5}
      />

      {/* Camiseta de gola redonda */}
      <path
        d="M -60 -58 Q 0 -70 60 -58 L 66 78 Q 0 88 -64 78 Z"
        fill={shirtColor}
        stroke={INK}
        strokeWidth={5.5}
      />

      {/* Braços expressivos */}
      {isPanicking ? (
        <>
          <path d="M -58 -36 L -145 -84 L -126 -110 L -46 -62 Z" fill={shirtColor} stroke={INK} strokeWidth={5} />
          <circle cx={-146} cy={-96} r={18} fill={SKIN} stroke={INK} strokeWidth={5} />
          <path d="M 58 -36 L 122 10 L 96 32 L 44 -14 Z" fill={shirtColor} stroke={INK} strokeWidth={5} />
          <circle cx={116} cy={22} r={18} fill={SKIN} stroke={INK} strokeWidth={5} />
        </>
      ) : pose === 'pointing' ? (
        <>
          <path d="M -56 -32 L -84 36 L -54 44 L -34 -12 Z" fill={shirtColor} stroke={INK} strokeWidth={5} />
          <circle cx={-68} cy={48} r={17} fill={SKIN} stroke={INK} strokeWidth={5} />
          <path d="M 58 -38 L 148 -68 L 154 -38 L 62 -10 Z" fill={shirtColor} stroke={INK} strokeWidth={5} />
          <circle cx={162} cy={-54} r={18} fill={SKIN} stroke={INK} strokeWidth={5} />
        </>
      ) : (
        <>
          <path d="M -56 -32 L -90 38 L -58 46 L -34 -10 Z" fill={shirtColor} stroke={INK} strokeWidth={5} />
          <circle cx={-72} cy={52} r={17} fill={SKIN} stroke={INK} strokeWidth={5} />
          <path d="M 56 -32 L 90 38 L 58 46 L 34 -10 Z" fill={shirtColor} stroke={INK} strokeWidth={5} />
          <circle cx={72} cy={52} r={17} fill={SKIN} stroke={INK} strokeWidth={5} />
        </>
      )}

      {/* Cabeça cartoon arredondada */}
      <circle cx={0} cy={-150} r={96} fill={SKIN} stroke={INK} strokeWidth={6} />
      {/* Cabelo castanho em topo suave (visual próprio) */}
      <path
        d="M -92 -175 C -96 -255 0 -278 72 -236 C 98 -220 100 -180 92 -164 C 66 -202 18 -212 -32 -204 C -58 -200 -76 -188 -92 -175 Z"
        fill="#5C3B24"
        stroke={INK}
        strokeWidth={6}
      />

      {/* Olhos ovais grandes */}
      <g transform={`translate(0, -155) scale(1, ${blink})`}>
        <ellipse cx={-34} cy={0} rx={16} ry={20} fill="#FFFFFF" stroke={INK} strokeWidth={4.5} />
        <ellipse cx={30} cy={0} rx={16} ry={20} fill="#FFFFFF" stroke={INK} strokeWidth={4.5} />
        <circle cx={-30} cy={2} r={6} fill={INK} />
        <circle cx={34} cy={2} r={6} fill={INK} />
        <path d="M -52 -28 Q -34 -38 -18 -26" fill="none" stroke={INK} strokeWidth={5} />
        <path d="M 14 -26 Q 32 -38 48 -28" fill="none" stroke={INK} strokeWidth={5} />
      </g>

      {/* Boca */}
      {isPanicking ? (
        <path d="M -28 -96 Q 0 -116 28 -96 Q 16 -66 -16 -66 Z" fill="#8C2626" stroke={INK} strokeWidth={5} />
      ) : isHappy ? (
        <path d="M -32 -106 Q 0 -72 34 -106 Z" fill="#FFFFFF" stroke={INK} strokeWidth={5} />
      ) : (
        <path d="M -22 -96 Q 0 -86 24 -96" fill="none" stroke={INK} strokeWidth={5} />
      )}
    </g>
  );
}

function StudyDeskScene({ frame, badge }: { frame: number; badge?: string }) {
  return (
    <g>
      <rect x={0} y={0} width={1920} height={1080} fill="#B8E6EC" />
      <line x1={0} y1={590} x2={1920} y2={590} stroke="#8FC6CE" strokeWidth={4} />

      {/* Relógio na parede */}
      <g transform="translate(1490, 225)">
        <circle cx={0} cy={0} r={96} fill="#FFFFFF" stroke={INK} strokeWidth={6} />
        <circle cx={0} cy={0} r={80} fill="#E5F4F6" stroke="#7AA5AD" strokeWidth={4} />
        <line x1={0} y1={0} x2={0} y2={-48} stroke={INK} strokeWidth={6} strokeLinecap="round" />
        <line x1={0} y1={0} x2={38} y2={-22} stroke={INK} strokeWidth={6} strokeLinecap="round" />
      </g>

      {/* Personagem sentado atrás da escrivaninha */}
      <ExplainerCharacterSvg frame={frame} cx={1060} cy={520} scale={1.15} shirtColor="#2E8B57" expressao="happy" />

      {/* Mesa de estudo */}
      <polygon points="360,640 1230,640 1090,940 180,940" fill="#8D6146" stroke={INK} strokeWidth={6} />
      <rect x={235} y={940} width={44} height={140} fill="#6F4A33" stroke={INK} strokeWidth={5} />
      <rect x={1020} y={940} width={44} height={140} fill="#6F4A33" stroke={INK} strokeWidth={5} />

      {/* Planta em vaso sobre a mesa */}
      <rect x={445} y={535} width={115} height={110} rx={12} fill="#B85D3B" stroke={INK} strokeWidth={5} />
      <path d="M 500 535 Q 440 430 435 385 Q 490 420 505 520 Q 525 405 570 375 Q 555 460 512 535 Z" fill="#4E944F" stroke={INK} strokeWidth={5} />

      {/* Folha de caderno inclinada com rótulo diegético */}
      <g transform="translate(765, 765) rotate(-14)">
        <rect x={-135} y={-90} width={270} height={180} rx={8} fill="#FFFFFF" stroke={INK} strokeWidth={5} />
        <text
          x={0}
          y={-32}
          textAnchor="middle"
          fill={INK}
          fontSize={28}
          fontWeight={900}
          fontFamily="Segoe UI, Arial, sans-serif"
        >
          {(badge && badge.trim() !== '' ? badge : 'ESTUDO ATIVO').slice(0, 16)}
        </text>
        <line x1={-95} y1={12} x2={95} y2={12} stroke="#475569" strokeWidth={5} />
        <line x1={-95} y1={46} x2={75} y2={46} stroke="#475569" strokeWidth={5} />
      </g>
    </g>
  );
}

function PanicDeskScene({ frame, badge }: { frame: number; badge?: string }) {
  const dropBounce = Math.sin(frame * 0.25) * 8;
  const wallText = badge && badge.trim() !== '' ? badge : 'ESTRESSE & FOCO';
  return (
    <g>
      <rect x={0} y={0} width={1920} height={1080} fill="#EFE58E" />

      {/* Quadro informativo na parede à esquerda */}
      <g transform="translate(135, 95)">
        <rect x={0} y={0} width={445} height={490} fill="#9C714A" stroke={INK} strokeWidth={6} />
        <rect x={24} y={24} width={397} height={442} fill="#FAF7EE" stroke={INK} strokeWidth={4} />
        <text
          x={222}
          y={195}
          textAnchor="middle"
          fill={INK}
          fontSize={wallText.length > 13 ? 34 : 42}
          fontWeight={900}
          fontFamily="Segoe UI, Arial, sans-serif"
        >
          {wallText.slice(0, 20).toUpperCase()}
        </text>
        <line x1={64} y1={245} x2={380} y2={245} stroke={INK} strokeWidth={5} />
        <text
          x={222}
          y={330}
          textAnchor="middle"
          fill="#B91C1C"
          fontSize={36}
          fontWeight={900}
          fontFamily="Segoe UI, Arial, sans-serif"
        >
          MODO PÂNICO
        </text>
      </g>

      {/* Prateleira à direita */}
      <rect x={1595} y={145} width={75} height={240} fill="#2E6F9E" stroke={INK} strokeWidth={5} />
      <rect x={1670} y={175} width={70} height={210} fill="#4C8C57" stroke={INK} strokeWidth={5} />
      <rect x={1740} y={160} width={72} height={225} fill="#C24135" stroke={INK} strokeWidth={5} />
      <rect x={1560} y={385} width={360} height={28} fill="#8D6146" stroke={INK} strokeWidth={5} />

      <ExplainerCharacterSvg frame={frame} cx={1160} cy={520} scale={1.15} shirtColor="#4E6E52" pose="panicking" />

      {/* Gotas de suor e linhas de movimento cartoon */}
      <g transform={`translate(1160, ${225 + dropBounce})`} fill="#60A5FA" stroke={INK} strokeWidth={4}>
        <path d="M -215 -10 Q -255 15 -235 42 Q -200 38 -215 -10 Z" />
        <path d="M 195 -20 Q 245 10 220 42 Q 185 34 195 -20 Z" />
      </g>

      {/* Mesa com notebook aberto e caneca */}
      <rect x={125} y={660} width={1660} height={115} rx={8} fill="#BD885B" stroke={INK} strokeWidth={6} />
      <rect x={235} y={775} width={52} height={305} fill="#8F613D" stroke={INK} strokeWidth={5} />
      <rect x={1610} y={775} width={52} height={305} fill="#8F613D" stroke={INK} strokeWidth={5} />

      <g transform="translate(650, 560) rotate(-12)">
        <rect x={-165} y={-145} width={330} height={215} rx={12} fill="#E2E8F0" stroke={INK} strokeWidth={6} />
        <rect x={-145} y={-125} width={290} height={175} fill="#FFFFFF" stroke={INK} strokeWidth={3.5} />
        <text x={0} y={-40} textAnchor="middle" fill="#B91C1C" fontSize={30} fontWeight={900} fontFamily="Segoe UI, Arial, sans-serif">
          ALERTA!
        </text>
      </g>
      <rect x={1395} y={565} width={96} height={105} rx={10} fill="#2563EB" stroke={INK} strokeWidth={5} />
      <text x={1443} y={626} textAnchor="middle" fill="#FFFFFF" fontSize={26} fontWeight={900} fontFamily="Segoe UI, Arial, sans-serif">
        MIND
      </text>
    </g>
  );
}

function BrainDiagramScene({ frame, badge }: { frame: number; badge?: string }) {
  const pulse = 1 + Math.sin(frame * 0.1) * 0.03;
  const bubbleText = badge && badge.trim() !== '' ? badge : 'É ASSIM QUE FUNCIONA!';
  return (
    <g>
      <rect x={0} y={0} width={1920} height={1080} fill="#DFE1E4" />
      <line x1={140} y1={835} x2={1780} y2={835} stroke={INK} strokeWidth={5} />

      {/* Balão de pensamento com lâmpada */}
      <g transform={`translate(285, 225) scale(${pulse})`}>
        <ellipse cx={0} cy={0} rx={170} ry={100} fill="#FFFFFF" stroke={INK} strokeWidth={5.5} />
        <circle cx={90} cy={130} r={16} fill="#FFFFFF" stroke={INK} strokeWidth={4.5} />
        <circle cx={120} cy={165} r={10} fill="#FFFFFF" stroke={INK} strokeWidth={4} />
        <circle cx={58} cy={-10} r={28} fill="#FACC15" stroke={INK} strokeWidth={4.5} />
        <rect x={46} y={16} width={24} height={14} rx={4} fill="#94A3B8" stroke={INK} strokeWidth={3.5} />
        <text x={-62} y={12} fontSize={44} fontWeight={900} fill={INK}>
          ...
        </text>
      </g>

      {/* Balão de fala amplo no topo direito */}
      <g transform="translate(820, 95)">
        <rect x={0} y={0} width={960} height={150} rx={75} fill="#FFFFFF" stroke={INK} strokeWidth={6} />
        <polygon points="105,146 35,235 168,148" fill="#FFFFFF" stroke={INK} strokeWidth={6} />
        <text
          x={480}
          y={94}
          textAnchor="middle"
          fill={INK}
          fontSize={48}
          fontWeight={900}
          fontFamily="Segoe UI, Arial, sans-serif"
        >
          {bubbleText.slice(0, 26).toUpperCase()}
        </text>
      </g>

      <ExplainerCharacterSvg
        frame={frame}
        cx={565}
        cy={625}
        scale={1.08}
        shirtColor="#3B6DA8"
        pose="pointing"
        expressao="happy"
      />

      {/* Quadro branco com diagrama cerebral didático colorido */}
      <g transform="translate(905, 315)">
        <rect x={12} y={12} width={865} height={470} fill="#B8BDC4" />
        <rect x={0} y={0} width={865} height={470} fill="#FFFFFF" stroke={INK} strokeWidth={6} />
        {/* Cérebro dividido por áreas coloridas */}
        <path
          d="M 275 235 C 255 155 320 95 405 110 L 405 260 Q 325 270 275 235 Z"
          fill="#FACC15"
          stroke={INK}
          strokeWidth={5}
        />
        <path
          d="M 405 110 C 495 95 570 150 560 225 L 405 260 Z"
          fill="#3B82F6"
          stroke={INK}
          strokeWidth={5}
        />
        <path
          d="M 560 225 C 585 275 540 315 480 305 L 405 260 Z"
          fill="#22C55E"
          stroke={INK}
          strokeWidth={5}
        />
        <ellipse cx={455} cy={335} rx={62} ry={40} fill="#E05A5A" stroke={INK} strokeWidth={5} />
        <path d="M 412 365 L 445 415" stroke={INK} strokeWidth={24} strokeLinecap="round" />
        <path d="M 412 365 L 445 415" stroke="#E05A5A" strokeWidth={14} strokeLinecap="round" />

        {/* Setas indicativas dos rótulos até o cérebro */}
        <g stroke={INK} strokeWidth={3.5} strokeLinecap="round">
          <line x1={198} y1={132} x2={278} y2={165} />
          <line x1={635} y1={128} x2={550} y2={162} />
          <line x1={670} y1={262} x2={572} y2={252} />
          <line x1={215} y1={330} x2={315} y2={265} />
          <line x1={620} y1={392} x2={515} y2={352} />
        </g>

        {/* Rótulos limpos ao redor do cérebro */}
        {[
          { x: 135, y: 125, text: 'FOCO' },
          { x: 720, y: 120, text: 'MEMÓRIA' },
          { x: 745, y: 270, text: 'VISÃO' },
          { x: 145, y: 340, text: 'LÓGICA' },
          { x: 695, y: 405, text: 'MOTOR' },
        ].map((lbl) => (
          <text
            key={lbl.text}
            x={lbl.x}
            y={lbl.y}
            textAnchor="middle"
            fill={INK}
            fontSize={30}
            fontWeight={900}
            fontFamily="Segoe UI, Arial, sans-serif"
          >
            {lbl.text}
          </text>
        ))}
      </g>
    </g>
  );
}

function FlashcardScene({
  frame,
  badge,
  assets = [],
}: {
  frame: number;
  badge?: string;
  assets?: string[];
}) {
  const isCompare = assets[0] === 'compare';
  const isChecklist = !isCompare && assets.length >= 3;
  const header = badge && badge.trim() !== '' ? badge : isChecklist ? 'RESUMO PRÁTICO' : 'RECORDAÇÃO ATIVA';

  return (
    <g>
      <rect x={0} y={0} width={1920} height={1080} fill="#CFE8D5" />
      <circle cx={960} cy={520} r={460} fill="rgba(255,255,255,0.28)" />

      {isCompare ? (
        <g transform="translate(1070, 445)">
          <rect x={-450} y={-230} width={920} height={470} rx={24} fill="#8BB796" />
          <rect x={-465} y={-245} width={920} height={470} rx={24} fill="#FFFFFF" stroke={INK} strokeWidth={6} />
          <text
            x={-5}
            y={-170}
            textAnchor="middle"
            fill={INK}
            fontSize={42}
            fontWeight={900}
            fontFamily="Segoe UI, Arial, sans-serif"
          >
            {header.slice(0, 24)}
          </text>
          {/* Esquerda passiva */}
          <rect x={-415} y={-120} width={385} height={295} rx={18} fill="#FEE2E2" stroke={INK} strokeWidth={5} />
          <circle cx={-222} cy={-22} r={46} fill="#EF4444" stroke={INK} strokeWidth={4.5} />
          <path d="M -242 -42 L -202 -2 M -202 -42 L -242 -2" stroke="#FFFFFF" strokeWidth={10} strokeLinecap="round" />
          <text
            x={-222}
            y={96}
            textAnchor="middle"
            fill="#991B1B"
            fontSize={32}
            fontWeight={900}
            fontFamily="Segoe UI, Arial, sans-serif"
          >
            {(assets[1] ?? 'PASSIVO: RELER').slice(0, 18)}
          </text>

          {/* Direita ativa */}
          <rect x={20} y={-120} width={385} height={295} rx={18} fill="#DCFCE7" stroke={INK} strokeWidth={5} />
          <circle cx={212} cy={-22} r={46} fill="#22C55E" stroke={INK} strokeWidth={4.5} />
          <path d="M 188 -22 L 206 -4 L 238 -40" fill="none" stroke="#FFFFFF" strokeWidth={10} strokeLinecap="round" strokeLinejoin="round" />
          <text
            x={212}
            y={96}
            textAnchor="middle"
            fill="#166534"
            fontSize={32}
            fontWeight={900}
            fontFamily="Segoe UI, Arial, sans-serif"
          >
            {(assets[2] ?? 'ATIVO: LEMBRAR').slice(0, 18)}
          </text>
        </g>
      ) : isChecklist ? (
        <g transform="translate(1075, 445)">
          <rect x={-415} y={-230} width={840} height={470} rx={26} fill="#8BB796" />
          <rect x={-430} y={-245} width={840} height={470} rx={26} fill="#FFFFFF" stroke={INK} strokeWidth={6} />
          <text
            x={-10}
            y={-168}
            textAnchor="middle"
            fill={INK}
            fontSize={42}
            fontWeight={900}
            fontFamily="Segoe UI, Arial, sans-serif"
          >
            {header.slice(0, 22)}
          </text>
          {assets.slice(0, 3).map((item, idx) => {
            const ry = -112 + idx * 104;
            return (
              <g key={idx} transform={`translate(-365, ${ry})`}>
                <rect x={0} y={0} width={710} height={82} rx={16} fill="#F1F8F3" stroke={INK} strokeWidth={4.5} />
                <circle cx={46} cy={41} r={24} fill="#22C55E" stroke={INK} strokeWidth={4} />
                <path d="M 33 41 L 43 51 L 60 32" fill="none" stroke="#FFFFFF" strokeWidth={6.5} strokeLinecap="round" strokeLinejoin="round" />
                <text
                  x={94}
                  y={52}
                  fill={INK}
                  fontSize={36}
                  fontWeight={900}
                  fontFamily="Segoe UI, Arial, sans-serif"
                >
                  {item.slice(0, 24)}
                </text>
              </g>
            );
          })}
        </g>
      ) : (
        <g transform="translate(1055, 445) rotate(-3)">
          <rect x={-324} y={-189} width={680} height={410} rx={24} fill="#8BB796" />
          <rect x={-340} y={-205} width={680} height={410} rx={24} fill="#FFFFFF" stroke={INK} strokeWidth={6} />
          <text
            x={0}
            y={-35}
            textAnchor="middle"
            fill={INK}
            fontSize={52}
            fontWeight={900}
            fontFamily="Segoe UI, Arial, sans-serif"
          >
            {(badge && badge.trim() !== '' ? badge : assets[0] ?? 'REVISÃO ATIVA').slice(0, 18)}
          </text>
          <rect x={-160} y={18} width={320} height={74} rx={18} fill="#FACC15" stroke={INK} strokeWidth={4.5} />
          <text
            x={0}
            y={68}
            textAnchor="middle"
            fill={INK}
            fontSize={34}
            fontWeight={900}
            fontFamily="Segoe UI, Arial, sans-serif"
          >
            {(assets[1] ?? 'REPETIR > RELER').slice(0, 16)}
          </text>
        </g>
      )}

      <ExplainerCharacterSvg
        frame={frame}
        cx={365}
        cy={625}
        scale={1.12}
        shirtColor="#2563EB"
        pose="pointing"
        expressao="happy"
      />
    </g>
  );
}

function HighlighterBookScene({ frame, badge }: { frame: number; badge?: string }) {
  const penBob = Math.sin(frame * 0.14) * 6;
  const boardText = badge && badge.trim() !== '' ? badge : 'RELER ≠ APRENDER';
  return (
    <g>
      <rect x={0} y={0} width={1920} height={1080} fill="#B8E6EC" />
      <line x1={0} y1={630} x2={1920} y2={630} stroke="#8FC6CE" strokeWidth={4} />

      {/* Quadro branco limpo no fundo */}
      <g transform="translate(520, 95)">
        <rect x={14} y={14} width={880} height={195} rx={14} fill="#89BCC4" />
        <rect x={0} y={0} width={880} height={195} rx={14} fill="#FFFFFF" stroke={INK} strokeWidth={6} />
        <text
          x={440}
          y={116}
          textAnchor="middle"
          fill={INK}
          fontSize={boardText.length > 16 ? 44 : 52}
          fontWeight={900}
          fontFamily="Segoe UI, Arial, sans-serif"
        >
          {boardText.slice(0, 22).toUpperCase()}
        </text>
      </g>

      {/* Mesa com livro aberto exageradamente grifado */}
      <rect x={180} y={560} width={1560} height={520} rx={12} fill="#B8875B" stroke={INK} strokeWidth={6} />
      <g transform="translate(960, 620)">
        <polygon points="-490,-150 -10,-120 -10,195 -515,155" fill="#FFFFFF" stroke={INK} strokeWidth={6} />
        <polygon points="-10,-120 490,-150 515,155 -10,195" fill="#FAF7EE" stroke={INK} strokeWidth={6} />
        {/* Faixas neon amarelas e rosas cobrindo as linhas */}
        {[-85, -32, 22, 76].map((ly, i) => (
          <g key={ly}>
            <rect x={-425} y={ly} width={350} height={24} rx={6} fill={i % 2 === 0 ? '#FDE047' : '#F472B6'} opacity={0.85} />
            <line x1={-415} y1={ly + 12} x2={-85} y2={ly + 12} stroke="#334155" strokeWidth={4.5} />
            <rect x={55} y={ly} width={360} height={24} rx={6} fill={i % 2 === 1 ? '#FDE047' : '#F472B6'} opacity={0.85} />
            <line x1={65} y1={ly + 12} x2={400} y2={ly + 12} stroke="#334155" strokeWidth={4.5} />
          </g>
        ))}
      </g>

      {/* Marca-texto gigante inclinado */}
      <g transform={`translate(1325, ${495 + penBob}) rotate(-32)`}>
        <rect x={-38} y={-145} width={76} height={240} rx={12} fill="#FACC15" stroke={INK} strokeWidth={6} />
        <polygon points="-24,95 24,95 14,138 -14,138" fill="#FEF08A" stroke={INK} strokeWidth={5} />
        <rect x={-38} y={-145} width={76} height={52} rx={10} fill="#1E293B" stroke={INK} strokeWidth={6} />
      </g>
    </g>
  );
}

function NeuralTrailScene({ frame, badge }: { frame: number; badge?: string }) {
  const pulse = 1 + Math.sin(frame * 0.14) * 0.08;
  const signText = badge && badge.trim() !== '' ? badge : 'TRILHA NEURAL';
  return (
    <g>
      <rect x={0} y={0} width={1920} height={540} fill="#B8E6EC" />
      <path d="M 0 510 Q 520 435 980 495 Q 1460 555 1920 465 L 1920 1080 L 0 1080 Z" fill="#9BD18B" stroke={INK} strokeWidth={5} />

      {/* Caminho fraco à esquerda se alargando até estrada iluminada à direita */}
      <path
        d="M 180 790 C 380 740 460 660 660 685 C 860 710 920 620 1120 620 L 1720 560"
        fill="none"
        stroke="#C7AE7D"
        strokeWidth={18}
        strokeDasharray="16 14"
        strokeLinecap="round"
      />
      <path
        d="M 860 665 C 1100 660 1320 605 1740 580"
        fill="none"
        stroke="#64748B"
        strokeWidth={84}
        strokeLinecap="round"
      />
      <path
        d="M 860 665 C 1100 660 1320 605 1740 580"
        fill="none"
        stroke="#FACC15"
        strokeWidth={8}
        strokeDasharray="28 20"
        strokeLinecap="round"
      />

      {/* Nós neuronais conectados */}
      {[
        { x: 1120, y: 295, r: 44 },
        { x: 1410, y: 235, r: 52 },
        { x: 1640, y: 345, r: 46 },
      ].map((n, idx) => (
        <g key={idx}>
          {idx > 0 ? (
            <line
              x1={idx === 1 ? 1120 : 1410}
              y1={idx === 1 ? 295 : 235}
              x2={n.x}
              y2={n.y}
              stroke="#3B82F6"
              strokeWidth={14}
              strokeLinecap="round"
            />
          ) : null}
          <circle
            cx={n.x}
            cy={n.y}
            r={n.r * pulse}
            fill="#FACC15"
            stroke={INK}
            strokeWidth={5.5}
          />
          <circle cx={n.x} cy={n.y} r={n.r * 0.45} fill="#2563EB" />
        </g>
      ))}

      {/* Placa indicativa limpa à esquerda */}
      <g transform="translate(420, 415)">
        <rect x={-12} y={25} width={24} height={240} fill="#8D6146" stroke={INK} strokeWidth={5} />
        <rect x={-230} y={-72} width={460} height={116} rx={16} fill="#FFFFFF" stroke={INK} strokeWidth={6} />
        <text
          x={0}
          y={2}
          textAnchor="middle"
          fill={INK}
          fontSize={38}
          fontWeight={900}
          fontFamily="Segoe UI, Arial, sans-serif"
        >
          {signText.slice(0, 20).toUpperCase()}
        </text>
      </g>
    </g>
  );
}

function FeynmanTeachScene({ frame, badge }: { frame: number; badge?: string }) {
  const headBob = Math.sin(frame * 0.14) * 4;
  const headerText = badge && badge.trim() !== '' ? badge : 'TÉCNICA FEYNMAN';
  return (
    <g>
      <rect x={0} y={0} width={1920} height={1080} fill="#EFE58E" />
      <line x1={120} y1={825} x2={1800} y2={825} stroke={INK} strokeWidth={5} />

      {/* Quadro simples com passos 1 -> 2 -> 3 */}
      <g transform="translate(550, 145)">
        <rect x={14} y={14} width={760} height={385} rx={16} fill="#C7BC65" />
        <rect x={0} y={0} width={760} height={385} rx={16} fill="#FFFFFF" stroke={INK} strokeWidth={6} />
        <text
          x={380}
          y={76}
          textAnchor="middle"
          fill={INK}
          fontSize={42}
          fontWeight={900}
          fontFamily="Segoe UI, Arial, sans-serif"
        >
          {headerText.slice(0, 22).toUpperCase()}
        </text>
        {[0, 1, 2].map((step) => {
          const bx = 90 + step * 215;
          return (
            <g key={step}>
              <rect x={bx} y={145} width={150} height={135} rx={16} fill={step === 1 ? '#FACC15' : '#DBEAFE'} stroke={INK} strokeWidth={5} />
              <text x={bx + 75} y={232} textAnchor="middle" fill={INK} fontSize={54} fontWeight={900}>
                {step + 1}
              </text>
              {step < 2 ? (
                <path d={`M ${bx + 162} 212 L ${bx + 202} 212`} stroke={INK} strokeWidth={7} strokeLinecap="round" />
              ) : null}
            </g>
          );
        })}
      </g>

      <ExplainerCharacterSvg
        frame={frame}
        cx={345}
        cy={620}
        scale={1.08}
        shirtColor="#2E7D32"
        pose="pointing"
        expressao="happy"
      />

      {/* Ouvinte robô simpático sentado na direita */}
      <g transform={`translate(1545, ${625 + headBob})`}>
        <rect x={-75} y={110} width={150} height={24} rx={8} fill="#8D6146" stroke={INK} strokeWidth={5} />
        <line x1={-55} y1={134} x2={-62} y2={200} stroke={INK} strokeWidth={10} />
        <line x1={55} y1={134} x2={62} y2={200} stroke={INK} strokeWidth={10} />
        <rect x={-62} y={-20} width={124} height={130} rx={22} fill="#60A5FA" stroke={INK} strokeWidth={6} />
        <rect x={-72} y={-148} width={144} height={112} rx={28} fill="#E2E8F0" stroke={INK} strokeWidth={6} />
        <line x1={0} y1={-148} x2={0} y2={-186} stroke={INK} strokeWidth={6} />
        <circle cx={0} cy={-194} r={12} fill="#FACC15" stroke={INK} strokeWidth={4} />
        <circle cx={-32} cy={-96} r={14} fill="#1E293B" />
        <circle cx={32} cy={-96} r={14} fill="#1E293B" />
        <path d="M -26 -62 Q 0 -46 26 -62" fill="none" stroke={INK} strokeWidth={5} strokeLinecap="round" />
      </g>
    </g>
  );
}

function GapLightbulbsScene({ frame, badge }: { frame: number; badge?: string }) {
  const floatQ = Math.sin(frame * 0.14) * 8;
  const posterText = badge && badge.trim() !== '' ? badge : 'ENCONTRE AS LACUNAS';
  return (
    <g>
      <rect x={0} y={0} width={1920} height={1080} fill="#DFE1E4" />

      {/* Placa na parede */}
      <g transform="translate(650, 82)">
        <rect x={0} y={0} width={620} height={116} rx={14} fill="#FFFFFF" stroke={INK} strokeWidth={6} />
        <text
          x={310}
          y={74}
          textAnchor="middle"
          fill={INK}
          fontSize={posterText.length > 18 ? 34 : 40}
          fontWeight={900}
          fontFamily="Segoe UI, Arial, sans-serif"
        >
          {posterText.slice(0, 24).toUpperCase()}
        </text>
      </g>

      {/* Interrogações vermelhas à esquerda */}
      <g transform={`translate(345, ${365 + floatQ})`}>
        <circle cx={0} cy={0} r={88} fill="#FEE2E2" stroke={INK} strokeWidth={5.5} />
        <text x={0} y={32} textAnchor="middle" fill="#DC2626" fontSize={106} fontWeight={900}>
          ?
        </text>
      </g>

      {/* Seta de transformação */}
      <path d="M 520 365 L 675 365" stroke={INK} strokeWidth={8} strokeLinecap="round" />
      <polygon points="665,342 712,365 665,388" fill={INK} />

      {/* Lâmpadas amarelas acesas à direita */}
      <g transform={`translate(1555, ${355 - floatQ})`}>
        <circle cx={0} cy={-16} r={96} fill="#FEF08A" stroke={INK} strokeWidth={5.5} />
        <circle cx={0} cy={-26} r={46} fill="#FACC15" stroke={INK} strokeWidth={4.5} />
        <rect x={-22} y={16} width={44} height={24} rx={6} fill="#94A3B8" stroke={INK} strokeWidth={4.5} />
      </g>

      <ExplainerCharacterSvg frame={frame} cx={960} cy={520} scale={1.12} shirtColor="#2E7D32" expressao="happy" />

      {/* Escrivaninha limpa embaixo do personagem */}
      <rect x={440} y={640} width={1040} height={440} rx={12} fill="#8D6146" stroke={INK} strokeWidth={6} />
      <rect x={805} y={715} width={310} height={150} rx={8} fill="#FFFFFF" stroke={INK} strokeWidth={5} />
      <line x1={850} y1={762} x2={1065} y2={762} stroke="#475569" strokeWidth={5} />
      <line x1={850} y1={802} x2={1025} y2={802} stroke="#475569" strokeWidth={5} />
    </g>
  );
}

/** Template Psicologia Cartoon 2D (16:9) inspirado em explainers didáticos com traço forte e legendas pop amarelas. */
export function PsychExplainerTemplate({
  scene,
  sceneIndex,
  durationInFrames,
  theme,
}: TemplateComponentProps) {
  const frame = useCurrentFrame();
  const scenario = pickPsychScenario(scene.cenario, sceneIndex);
  const bg = SCENARIO_BG[scenario];

  const maxFrame = Math.max(1, durationInFrames - 1);
  const zoomIn = scene.n % 2 === 1;
  const camScale = interpolate(frame, [0, maxFrame], zoomIn ? [1.0, 1.035] : [1.035, 1.0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <AbsoluteFill style={{ backgroundColor: bg, overflow: 'hidden' }}>
      <AbsoluteFill style={{ transform: `scale(${camScale})` }}>
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
            {scenario === 'study-desk' ? (
              <StudyDeskScene frame={frame} badge={scene.textoNaTela} />
            ) : scenario === 'brain-diagram' ? (
              <BrainDiagramScene frame={frame} badge={scene.textoNaTela} />
            ) : scenario === 'flashcard' ? (
              <FlashcardScene frame={frame} badge={scene.textoNaTela} assets={scene.assets} />
            ) : scenario === 'highlighter-book' ? (
              <HighlighterBookScene frame={frame} badge={scene.textoNaTela} />
            ) : scenario === 'neural-trail' ? (
              <NeuralTrailScene frame={frame} badge={scene.textoNaTela} />
            ) : scenario === 'feynman-teach' ? (
              <FeynmanTeachScene frame={frame} badge={scene.textoNaTela} />
            ) : scenario === 'gap-lightbulbs' ? (
              <GapLightbulbsScene frame={frame} badge={scene.textoNaTela} />
            ) : (
              <PanicDeskScene frame={frame} badge={scene.textoNaTela} />
            )}
          </svg>
        )}
      </AbsoluteFill>

      {/* Vinheta mínima na base apenas para contraste da legenda sobre áreas claras */}
      <AbsoluteFill
        style={{
          background:
            'linear-gradient(180deg, rgba(10,12,16,0) 76%, rgba(10,12,16,0.34) 100%)',
          pointerEvents: 'none',
        }}
      />

      <ItalicKeywordCaption
        text={scene.narracao}
        durationInFrames={durationInFrames}
        textColor={theme.text}
        accentColor={theme.accent}
        popActiveWord
      />
    </AbsoluteFill>
  );
}
