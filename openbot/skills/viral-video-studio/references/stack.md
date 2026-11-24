# Pilha recomendada

| Camada | Ferramenta | Papel | Prioridade |
|---|---|---|---|
| Orquestração | OpenBot (confirmar distribuição instalada) | tarefas, handoff, memória de jobs | Obrigatória |
| Roteiro | Codex | roteiro/storyboard e textos por canal | Obrigatória |
| Produção | Claude Code | geração/revisão de código audiovisual | Obrigatória |
| Análise | FFprobe/FFmpeg + rea-video opcional | breakdown das referências | Obrigatória/opcional |
| Composição | Remotion + Remotion Skills | cenas e render reproduzível | Obrigatória |
| Movimento | Remotion primitives; GSAP em casos testados | animação de personagens/cenas | Opcional |
| 3D | Three.js | cenários e câmera 3D | Opcional |
| Narração | engine TTS local ou API aprovada | voz original e alinhamento | Obrigatória para vídeo narrado |
| Finalização | FFmpeg | normalização e metadados de mídia | Obrigatória |
| Distribuição | Upload-Post MCP ou APIs oficiais | quatro redes | Opcional, exige OAuth e teste |
| Persistência | arquivos JSON + SQLite opcional | checkpoints, filas, idempotência | Obrigatória em lote |

Não presumir que os CLIs Codex e Claude Code, o MCP ou o TTS estão instalados só porque a skill foi importada. Detectar em tempo de execução. Estudar licenças dos repositórios e assets antes de uso comercial. Preferir evitar bibliotecas adicionais até o MVP funcionar.

A mesma estrutura SKILL.md é portável para implementações compatíveis com Agent Skills, mas operações de delegação e MCP variam por OpenBot. Adaptar o conector sem alterar os contratos.
