# Ferramentas externas instaladas (versão fixa)

Registro de 17/11/2026. Atualizar só depois de revisar a mudança e retestar. Nenhuma das duas tem conta conectada.

## ship-it (S01)

- **O que é:** sete skills em Markdown (`create-product`, `create-tasks`, `do-task`, `watch-pr`, `chaos-engineering`, `groundwork`, `make-guidelines`) que transformam uma ideia grande em documento de produto e cartões de tarefa verificáveis. Não é biblioteca do NIGHT; é um método que o agente segue. [Repositório](https://github.com/samsantosb/ship-it), licença MIT.
- **Onde está:** `C:\Users\Joel\tools\ship-it`, commit `a92f85ce4ef18f3a5091982c186a264def52b556` (14/07/2026). A pasta é usada inteira, porque as skills leem os contratos em `shared/`.
- **Claude:** `claude --plugin-dir C:/Users/Joel/tools/ship-it` (uma sessão) ou, sem interação, `claude --bare --plugin-dir C:/Users/Joel/tools/ship-it -p "/ship-it:create-tasks ..."`.
- **Codex e DeepSeek:** "Siga C:/Users/Joel/tools/ship-it/AGENTS.md e rode skills/create-tasks/SKILL.md com <pedido>".
- **Ainda não usar no NIGHT:** `do-task` e `watch-pr` fazem branch, commit e PR por conta própria. O NIGHT faz isso pelo próprio fluxo (worktree, revisão, "aprovo"), e o plano exige adaptar antes (S06). O cartão do ship-it entra pelo importador do NIGHT (`src/cards/`).
- **Pendente (S02):** rodar `/groundwork` no NIGHT com acompanhamento e conferir a saída antes de aceitar. Ele escreve em `AGENTS.md`/`CLAUDE.md` e não pode sobrescrever as regras atuais.

## Executor (E01)

- **O que é:** um cofre de conexões com serviços (contas, OAuth) que expõe ferramentas por CLI e MCP, com aprovação por ferramenta. Não roda IA. [Documentação](https://executor.sh/docs), licença MIT.
- **Versão:** `executor@2.0.0-beta.60`, instalada com `npm i -g executor@2.0.0-beta.60`.
- **Prova E01 (17/11):**
  - o serviço local subiu em cerca de 17 s na primeira vez;
  - `executor call tools.executor.appManagement.catalog` devolveu JSON em cerca de 1 s;
  - entrada inválida devolveu erro estruturado (`RequestInvalid`, HTTP 400, com orientação de correção);
  - sem conta e sem login.
- **Catálogo público:** 77 apps, **nenhum da Meta nem de anúncios**. Para Radar e anúncios, o caminho é o [MCP oficial da Meta](../research/plano-meta-ads-mcp.md). O Executor fica para integrações futuras, como Drive para os criativos com URL (M05).
- **Serviço:** fica parado. `executor service start` / `stop` / `status`.

## OpenBot (telas, 18/11/2026)

- **O que é:** app de desktop com agentes persistentes, cada um com sua tela. No NIGHT ele é **só a vitrine**: as 6 telas repassam os pedidos ao NIGHT pelo MCP local (`http://127.0.0.1:4517/mcp`). Guia completo em [openbot-telas.md](openbot-telas.md).
- **Versão:** `0.73.0`, instalada pelo `OpenBot-0.73.0-x64.exe` do GitHub Releases em `%LOCALAPPDATA%\Programs\OpenBot`. Os dados ficam em `%APPDATA%\OpenBot` e as pastas dos agentes em `~/OpenBot/Agents`.
- **Verificação:** o SHA-256 `a14b4343…af52cf` confere com o `SHA256SUMS-windows.txt`. A assinatura Authenticode é válida, assinada por SYNTHETIFY LABS.
- **Atualização:** sai versão quase todo dia. Só atualize depois de retestar o MCP e as permissões das telas.
- **Licença:** PolyForm Noncommercial, grátis para uso pessoal. Para vender o NIGHT, é preciso a licença comercial ou um acordo com licenses@openbot.run (O01).
