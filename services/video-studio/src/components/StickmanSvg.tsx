import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { useStudioScale } from './scale';

export interface StickmanSvgProps {
  pose?: string;
  expressao?: string;
  assets?: string[];
  strokeColor: string;
  accentColor: string;
}

interface PoseAngles {
  bodyLean: number;
  headTilt: number;
  leftShoulder: number;
  leftElbow: number;
  rightShoulder: number;
  rightElbow: number;
  leftHip: number;
  leftKnee: number;
  rightHip: number;
  rightKnee: number;
  bobAmp: number;
}

const POSES: Record<string, PoseAngles> = {
  idle: {
    bodyLean: 0, headTilt: 0,
    leftShoulder: 28, leftElbow: 15,
    rightShoulder: -28, rightElbow: -15,
    leftHip: 12, leftKnee: 4,
    rightHip: -12, rightKnee: -4,
    bobAmp: 4,
  },
  thinking: {
    bodyLean: -4, headTilt: -10,
    leftShoulder: 22, leftElbow: 20,
    rightShoulder: -115, rightElbow: -110,
    leftHip: 10, leftKnee: 2,
    rightHip: -12, rightKnee: 12,
    bobAmp: 3,
  },
  pointing: {
    bodyLean: 8, headTilt: 4,
    leftShoulder: 35, leftElbow: 18,
    rightShoulder: -88, rightElbow: -6,
    leftHip: 16, leftKnee: 6,
    rightHip: -18, rightKnee: -4,
    bobAmp: 4,
  },
  excited: {
    bodyLean: 0, headTilt: -5,
    leftShoulder: 135, leftElbow: 20,
    rightShoulder: -135, rightElbow: -20,
    leftHip: 20, leftKnee: 14,
    rightHip: -20, rightKnee: -14,
    bobAmp: 12,
  },
  shocked: {
    bodyLean: -8, headTilt: -6,
    leftShoulder: 105, leftElbow: 75,
    rightShoulder: -105, rightElbow: -75,
    leftHip: 18, leftKnee: 10,
    rightHip: -18, rightKnee: -10,
    bobAmp: 7,
  },
  walking: {
    bodyLean: 7, headTilt: 3,
    leftShoulder: 38, leftElbow: 28,
    rightShoulder: -38, rightElbow: -28,
    leftHip: 28, leftKnee: -16,
    rightHip: -28, rightKnee: 16,
    bobAmp: 8,
  },
  celebrating: {
    bodyLean: 2, headTilt: -8,
    leftShoulder: 150, leftElbow: 14,
    rightShoulder: -150, rightElbow: -14,
    leftHip: 22, leftKnee: -12,
    rightHip: -22, rightKnee: 12,
    bobAmp: 14,
  },
  floating: {
    bodyLean: -10, headTilt: 8,
    leftShoulder: 80, leftElbow: 30,
    rightShoulder: -75, rightElbow: -35,
    leftHip: 25, leftKnee: 22,
    rightHip: -20, rightKnee: -28,
    bobAmp: 18,
  },
};

function degToRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

function limbEnd(x: number, y: number, angleDegFromDown: number, len: number): { x: number; y: number } {
  const rad = degToRad(angleDegFromDown);
  return {
    x: x + Math.sin(rad) * len,
    y: y + Math.cos(rad) * len,
  };
}

function renderProp(name: string, x: number, y: number, stroke: string, accent: string, frame: number) {
  const n = name.toLowerCase();
  const floatY = Math.sin(frame * 0.1) * 8;
  const cx = x;
  const cy = y + floatY;

  if (n.includes('ball') || n.includes('bola')) {
    return (
      <g transform={`translate(${cx}, ${cy})`}>
        <circle cx={0} cy={0} r={26} fill={accent} stroke={stroke} strokeWidth={5} />
        <path d="M -18 -10 Q 0 10 18 -10" fill="none" stroke={stroke} strokeWidth={4} />
      </g>
    );
  }
  if (n.includes('clock') || n.includes('relogio') || n.includes('relógio') || n.includes('time')) {
    const handAngle = (frame * 8) % 360;
    return (
      <g transform={`translate(${cx}, ${cy})`}>
        <circle cx={0} cy={0} r={32} fill="#FFFFFF" stroke={stroke} strokeWidth={5} />
        <line x1={0} y1={0} x2={0} y2={-18} stroke={stroke} strokeWidth={4} strokeLinecap="round" />
        <line
          x1={0}
          y1={0}
          x2={Math.sin(degToRad(handAngle)) * 22}
          y2={-Math.cos(degToRad(handAngle)) * 22}
          stroke={accent}
          strokeWidth={4}
          strokeLinecap="round"
        />
      </g>
    );
  }
  if (n.includes('lightbulb') || n.includes('ideia') || n.includes('idea')) {
    return (
      <g transform={`translate(${cx}, ${cy})`}>
        <circle cx={0} cy={-6} r={22} fill={accent} stroke={stroke} strokeWidth={4.5} />
        <rect x={-10} y={14} width={20} height={10} rx={3} fill="#CBD5E1" stroke={stroke} strokeWidth={4} />
        <line x1={0} y1={-38} x2={0} y2={-48} stroke={accent} strokeWidth={4} strokeLinecap="round" />
        <line x1={26} y1={-24} x2={34} y2={-30} stroke={accent} strokeWidth={4} strokeLinecap="round" />
        <line x1={-26} y1={-24} x2={-34} y2={-30} stroke={accent} strokeWidth={4} strokeLinecap="round" />
      </g>
    );
  }
  if (n.includes('chart') || n.includes('grafico') || n.includes('gráfico')) {
    return (
      <g transform={`translate(${cx - 32}, ${cy - 26})`}>
        <rect x={0} y={0} width={64} height={52} rx={8} fill="#FFFFFF" stroke={stroke} strokeWidth={4} />
        <rect x={10} y={28} width={10} height={16} fill={stroke} />
        <rect x={27} y={20} width={10} height={24} fill={accent} />
        <rect x={44} y={10} width={10} height={34} fill={accent} />
      </g>
    );
  }
  if (n.includes('phone') || n.includes('celular')) {
    return (
      <g transform={`translate(${cx - 20}, ${cy - 32})`}>
        <rect x={0} y={0} width={40} height={64} rx={8} fill="#1E293B" stroke={stroke} strokeWidth={4} />
        <rect x={5} y={8} width={30} height={44} rx={3} fill={accent} />
        <circle cx={20} cy={58} r={2.5} fill="#FFFFFF" />
      </g>
    );
  }
  if (n.includes('document') || n.includes('pdf') || n.includes('book') || n.includes('livro')) {
    return (
      <g transform={`translate(${cx - 24}, ${cy - 30})`}>
        <rect x={0} y={0} width={48} height={60} rx={6} fill="#FFFFFF" stroke={stroke} strokeWidth={4.5} />
        <line x1={10} y1={16} x2={38} y2={16} stroke={accent} strokeWidth={5} strokeLinecap="round" />
        <line x1={10} y1={30} x2={38} y2={30} stroke={stroke} strokeWidth={4} strokeLinecap="round" />
        <line x1={10} y1={42} x2={28} y2={42} stroke={stroke} strokeWidth={4} strokeLinecap="round" />
      </g>
    );
  }
  return null;
}

export function StickmanSvg({
  pose = 'idle',
  expressao = 'neutral',
  assets = [],
  strokeColor,
  accentColor,
}: StickmanSvgProps) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { s } = useStudioScale();

  const p = POSES[pose.toLowerCase()] ?? POSES.idle!;
  const enter = spring({ frame, fps, config: { damping: 12, stiffness: 140 } });
  const scaleIn = interpolate(enter, [0, 1], [0.85, 1]);

  const walkSwing = pose === 'walking' ? Math.sin(frame * 0.25) * 32 : Math.sin(frame * 0.08) * 6;
  const bob = Math.sin(frame * 0.12) * p.bobAmp;
  const blink = frame % 110 < 4;

  const hipX = 200;
  const hipY = (pose === 'floating' ? 235 : 265) + bob;
  const shoulder = limbEnd(hipX, hipY, 180 + p.bodyLean, 95);
  const headCenter = limbEnd(shoulder.x, shoulder.y, 180 + p.headTilt, 42);

  const lElbow = limbEnd(shoulder.x, shoulder.y, p.leftShoulder + walkSwing * 0.6, 52);
  const lHand = limbEnd(lElbow.x, lElbow.y, p.leftShoulder + p.leftElbow + walkSwing * 0.4, 48);

  const rElbow = limbEnd(shoulder.x, shoulder.y, p.rightShoulder - walkSwing * 0.6, 52);
  const rHand = limbEnd(rElbow.x, rElbow.y, p.rightShoulder + p.rightElbow - walkSwing * 0.4, 48);

  const lKnee = limbEnd(hipX, hipY, p.leftHip - walkSwing, 60);
  const lFoot = limbEnd(lKnee.x, lKnee.y, p.leftHip + p.leftKnee - walkSwing * 0.5, 58);

  const rKnee = limbEnd(hipX, hipY, p.rightHip + walkSwing, 60);
  const rFoot = limbEnd(rKnee.x, rKnee.y, p.rightHip + p.rightKnee + walkSwing * 0.5, 58);

  const expr = expressao.toLowerCase();
  const mouthPath =
    expr === 'happy'
      ? `M ${headCenter.x - 12} ${headCenter.y + 8} Q ${headCenter.x} ${headCenter.y + 22} ${headCenter.x + 12} ${headCenter.y + 8}`
      : expr === 'surprised'
        ? undefined
        : expr === 'serious'
          ? `M ${headCenter.x - 10} ${headCenter.y + 13} L ${headCenter.x + 10} ${headCenter.y + 13}`
          : `M ${headCenter.x - 10} ${headCenter.y + 11} Q ${headCenter.x} ${headCenter.y + 16} ${headCenter.x + 10} ${headCenter.y + 11}`;

  const propItems = assets.filter((a) => !a.toLowerCase().includes('stickman')).slice(0, 2);

  return (
    <svg
      width={420 * s}
      height={420 * s}
      viewBox="0 0 400 420"
      style={{
        overflow: 'visible',
        transform: `scale(${scaleIn})`,
      }}
    >
      {/* Sombra no chão */}
      <ellipse
        cx={200}
        cy={394}
        rx={pose === 'floating' ? 42 : 68}
        ry={11}
        fill="rgba(15, 23, 42, 0.14)"
      />

      {/* Props de cena */}
      {propItems[0] ? renderProp(propItems[0], 330, 150, strokeColor, accentColor, frame) : null}
      {propItems[1] ? renderProp(propItems[1], 70, 175, strokeColor, accentColor, frame + 20) : null}

      {/* Tronco e membros */}
      <g stroke={strokeColor} strokeWidth={11} strokeLinecap="round" strokeLinejoin="round" fill="none">
        <line x1={hipX} y1={hipY} x2={shoulder.x} y2={shoulder.y} />
        <polyline points={`${shoulder.x},${shoulder.y} ${lElbow.x},${lElbow.y} ${lHand.x},${lHand.y}`} />
        <polyline points={`${shoulder.x},${shoulder.y} ${rElbow.x},${rElbow.y} ${rHand.x},${rHand.y}`} />
        <polyline points={`${hipX},${hipY} ${lKnee.x},${lKnee.y} ${lFoot.x},${lFoot.y}`} />
        <polyline points={`${hipX},${hipY} ${rKnee.x},${rKnee.y} ${rFoot.x},${rFoot.y}`} />
      </g>

      {/* Cabeça */}
      <circle
        cx={headCenter.x}
        cy={headCenter.y}
        r={34}
        fill="#FFFFFF"
        stroke={strokeColor}
        strokeWidth={10}
      />

      {/* Olhos */}
      {blink ? (
        <g stroke={strokeColor} strokeWidth={4} strokeLinecap="round">
          <line x1={headCenter.x - 15} y1={headCenter.y - 6} x2={headCenter.x - 7} y2={headCenter.y - 6} />
          <line x1={headCenter.x + 7} y1={headCenter.y - 6} x2={headCenter.x + 15} y2={headCenter.y - 6} />
        </g>
      ) : (
        <g fill={strokeColor}>
          <circle cx={headCenter.x - 11} cy={headCenter.y - 6} r={4.2} />
          <circle cx={headCenter.x + 11} cy={headCenter.y - 6} r={4.2} />
        </g>
      )}

      {/* Sobrancelhas para expressão */}
      {expr === 'serious' ? (
        <g stroke={strokeColor} strokeWidth={3.5} strokeLinecap="round">
          <line x1={headCenter.x - 17} y1={headCenter.y - 16} x2={headCenter.x - 6} y2={headCenter.y - 13} />
          <line x1={headCenter.x + 6} y1={headCenter.y - 13} x2={headCenter.x + 17} y2={headCenter.y - 16} />
        </g>
      ) : null}

      {/* Boca */}
      {expr === 'surprised' ? (
        <ellipse
          cx={headCenter.x}
          cy={headCenter.y + 13}
          rx={6}
          ry={8}
          fill={accentColor}
          stroke={strokeColor}
          strokeWidth={3.5}
        />
      ) : (
        <path d={mouthPath} fill="none" stroke={strokeColor} strokeWidth={4} strokeLinecap="round" />
      )}
    </svg>
  );
}
