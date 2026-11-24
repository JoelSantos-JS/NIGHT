import type { ReactNode } from 'react';
import { AbsoluteFill } from 'remotion';
import { useStudioScale } from './scale';

export interface SafeZoneProps {
  children: ReactNode;
}

/**
 * Área segura para Reels, TikTok, Shorts e YouTube: evita sobreposição com
 * botões laterais, barra superior e descrição inferior das plataformas.
 */
export function SafeZone({ children }: SafeZoneProps) {
  const { isVertical, s } = useStudioScale();

  return (
    <AbsoluteFill
      style={{
        paddingTop: (isVertical ? 128 : 64) * s,
        paddingBottom: (isVertical ? 280 : 88) * s,
        paddingLeft: (isVertical ? 64 : 84) * s,
        paddingRight: (isVertical ? 120 : 84) * s,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        boxSizing: 'border-box',
      }}
    >
      {children}
    </AbsoluteFill>
  );
}
