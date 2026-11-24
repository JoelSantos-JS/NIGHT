# Contrato de tarefa: Codex / Roteirista

**Input:** `brief.json`, `reference_analysis.json` (opcional), objetivos, idioma, duração, limites de custo, público e orientações factuais.

**Instrução ao Codex:**
"Você é o roteirista e diretor narrativo. Produza um roteiro original de alta clareza com gancho forte, desenvolvimento causal e desfecho. Entregue `script.md` e `storyboard.json` conforme schema. Garanta que a duração das cenas soma a duração do vídeo, com locução condizente com o tempo e especificações visuais implementáveis por código. Escreva descrições de cenas e ações sem dependência de técnicas não disponíveis. Não renderize, não publique e não reutilize elementos protegidos da referência. Se a história apresenta fatos, diferencie fatos verificáveis de dramatização." 

**Output:** `script.md`, `storyboard.json`, `channel_copy.json`. Use `scripts/validate_storyboard.py` antes do handoff. Estruture o conteúdo de cada cena sem ambiguidades: duração, movimento, fala, texto e necessidades de assets.

**Handoff:** Codex marca `SCRIPT_COMPLETE` apenas quando os arquivos existirem, esquema passar e estiverem legíveis no workspace compartilhado. O diretor repassa paths ao Claude Code.
