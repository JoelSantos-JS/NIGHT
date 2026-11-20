# Skills de terceiros

Copiadas em 20/11/2026 e revisadas pelo Claude antes de entrar. Todas permitem uso comercial e redistribuição, desde que a licença vá junto. Por isso cada pasta tem o seu `LICENSE`.

| Pasta | Origem | Versão | Licença | O que mudou aqui |
|---|---|---|---|---|
| `ui-ux-pro-max` | [nextlevelbuilder/ui-ux-pro-max-skill](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill), `.claude/skills/ui-ux-pro-max` | commit `2de1134` (v2.15.0) | MIT | O caminho `${CLAUDE_PLUGIN_ROOT}/.claude/skills/ui-ux-pro-max/` do `SKILL.md` virou `<pasta desta skill>/`, porque no OpenBot não existe essa variável. A pasta `scripts/tests` ficou de fora. |
| `frontend-design` | [anthropics/skills](https://github.com/anthropics/skills), `skills/frontend-design` | commit `e4bb5d9` | Apache 2.0 | Nada. |
| `copywriting`, `cro`, `ad-creative` | [coreyhaines31/marketingskills](https://github.com/coreyhaines31/marketingskills), `skills/…` | commit `5b2b400` | MIT | As pastas `evals` ficaram de fora. |

## O que a revisão olhou

- **Caracteres escondidos e instrução injetada** nos `.md`: nada encontrado.
- **`ui-ux-pro-max`** roda scripts em Python (`scripts/search.py` e os que ele importa).
  - Só usam a biblioteca padrão e leem os CSV da própria pasta.
  - Não acessam a internet, não rodam comandos e só leem a variável `COLORTERM`.
  - O `preview.html` gerado aponta para as fontes do Google: quem abre a página baixa as fontes.
  - Precisa de Python 3 no PC.
- **`ad-creative`** cita serviços pagos de imagem, voz e vídeo (ElevenLabs, Runway e outros), com chaves de API.
  - Não há chave nenhuma configurada.
  - A tela Marketing proíbe chamar serviço pago: ela entrega só o prompt.
- **Ficaram de fora por enquanto:**
  - `agent-browser` e `playwright-mcp`: controlam um navegador, baixam binários e guardam sessão. Ficam para quando o Radar ganhar o navegador, num perfil separado.
  - `competitor-profiling`: coleta páginas de terceiros pela internet.

Para atualizar: baixe de novo, rode a mesma revisão e troque a versão nesta tabela.
