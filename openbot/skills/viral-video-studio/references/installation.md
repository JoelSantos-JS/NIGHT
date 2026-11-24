# Instalação e configuração

## OpenBot de made-to-fit-ai / nightly-labs
A documentação do projeto descreve uma biblioteca de skills locais: criar uma pasta com `SKILL.md` e opcionalmente `references/`, `scripts/`, `assets/`, depois adicionar via agente (`create_skill`) ou interface **Settings → Skills → Local skills**. Como existem vários projetos chamados OpenBot, confirme qual aplicação e versão está rodando antes de usar APIs internas ou caminhos de instalação.

1. Descompacte o pacote `viral-video-studio` em uma pasta local.
2. No OpenBot, peça ao agente para ler `SKILL.md` e registrar como skill local via mecanismo suportado; se o aplicativo oferecer a seção Settings → Skills → Local skills, instale/habilite nela. Não presuma que o simples ZIP é autoimportado.
3. Configure acesso ao Codex e Claude Code conforme o OpenBot instalado. Teste handoff e escrita em workspace compartilhado.
4. Instale Node.js, Remotion, FFmpeg/ffprobe e Python 3.10+ apenas após checar versões compatíveis. Ative Remotion Skills conforme https://www.remotion.dev/docs/ai/skills.
5. Configure motor TTS e armazenamento de assets licenciados, com limites de custo.
6. Só depois conecte Upload-Post MCP ou APIs diretas, utilizando credenciais em secret manager e OAuth externo.
7. Rode o roteiro de exemplo: `python scripts/validate_storyboard.py examples/storyboard.example.json`.
8. Execute um render sem publicar; inspecione o MP4 com `python scripts/check_media.py caminho/para/final.mp4`.
9. Faça uma publicação de teste privada/rascunho quando a rede permitir; confirme `post_id` e resultado antes de ativar rotina recorrente.

## Como chamar
- "Use viral-video-studio para gerar um stickman de 45 segundos sobre [tema]".
- "Analise [URL] como referência de linguagem visual e crie uma história original".
- "Prepare os quatro posts, mas não publique antes da minha aprovação".

## Limites da entrega
Esta skill é um **manual de orquestração e contratos validados**, não um aplicativo de edição já instalado, um TTS, uma conta autorizada, nem um servidor MCP pré-configurado. O runtime deve implementar as integrações usando as ferramentas realmente disponíveis.
