import { Composition } from 'remotion';
import { VideoComposition, totalCompositionFrames } from './VideoComposition';
import type { StudioProps } from './types';

const DEFAULT_PROPS: StudioProps = {
  jobId: 'preview-demo',
  titulo: 'Prévia do NIGHT Studio',
  width: 1080,
  height: 1920,
  fps: 30,
  preview: false,
  templateId: 'stickman-2d',
  theme: {
    background: '#F8FAFC',
    primary: '#0F172A',
    accent: '#EF4444',
    text: '#0F172A',
    fontMood: 'handwritten',
  },
  musicUrl: null,
  scenes: [
    {
      n: 1,
      durationSec: 4,
      narracao: 'Exemplo de cena inicial no estúdio visual do NIGHT.',
      textoNaTela: 'GANCHO INICIAL',
      pose: 'excited',
      expressao: 'happy',
      assets: ['lightbulb'],
      transicao: 'cut',
    },
  ],
};

export function RemotionRoot() {
  return (
    <Composition
      id="NightVideo"
      component={VideoComposition}
      durationInFrames={totalCompositionFrames(DEFAULT_PROPS)}
      fps={DEFAULT_PROPS.fps}
      width={DEFAULT_PROPS.width}
      height={DEFAULT_PROPS.height}
      defaultProps={DEFAULT_PROPS}
      calculateMetadata={({ props }) => {
        const p = props as StudioProps;
        return {
          durationInFrames: totalCompositionFrames(p),
          fps: p.fps,
          width: p.width,
          height: p.height,
        };
      }}
    />
  );
}
