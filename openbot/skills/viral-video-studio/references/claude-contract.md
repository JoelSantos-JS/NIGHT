# Contrato de tarefa: Claude Code / Animador

**Input:** `storyboard.json`, `script.md`, `reference_analysis.json` (se houver), configuração do projeto e `assets_manifest.json`.

**Instrução ao Claude Code:**
"Você é o engenheiro de motion design. Construa e renderize animações originais conforme os arquivos, usando Remotion como motor central. Use React/TypeScript e princípios de animação determinística por frame; mantenha a identidade dos personagens consistente. Não gere áudio falso. Se uma dependência como TTS não estiver configurada, exponha o bloqueio. Produza preview, frames de amostragem, vídeo MP4 validado por ffprobe e relatório de QA. Não publique." 

**Entregáveis:** código-fonte, `assets_manifest.json`, `preview.mp4`, `final.mp4`, `render_report.json`, quatro cópias de metadados para postagens.

**Requisitos:**
- `width=1080`, `height=1920`, `fps=30` por padrão.
- Não usar `setTimeout` ou CSS animation baseada em relógio para frames renderizados. Preferir `useCurrentFrame`, `spring`, `interpolate`.
- Criar primitivas reutilizáveis para personagens stickman (cabeça, braços, pernas, pose, expressões, props) e componentes de legenda.
- Garantir áudio/lipsync aproximado quando aplicável; legenda alinhada ao áudio real.
- Armazenar atribuições/licenças dos assets; falhar se direitos estiverem desconhecidos para publicação.
- Reutilizar cache de cenas e vozes no mesmo job. Limitar tentativas e exibir erro reproduzível.
