import { useVideoConfig } from 'remotion';

export interface StudioScale {
  width: number;
  height: number;
  fps: number;
  isVertical: boolean;
  /** Fator de escala relativo a 1080px (vertical) ou 1920px (horizontal). */
  s: number;
}

export function useStudioScale(): StudioScale {
  const { width, height, fps } = useVideoConfig();
  const isVertical = height > width;
  const s = width / (isVertical ? 1080 : 1920);
  return { width, height, fps, isVertical, s };
}
