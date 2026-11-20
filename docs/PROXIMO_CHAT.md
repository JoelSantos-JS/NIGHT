# NIGHT: passagem para o próximo chat

**Escrito em 20/11/2026.** Para um Claude novo, sem a memória desta conversa, e para o Joel. Leia inteiro antes de mexer. Depois leia o [.agents/em-andamento.md](../.agents/em-andamento.md) e as decisões D-016 a D-020 em [DECISIONS.md](DECISIONS.md).

As passagens anteriores continuam no histórico:
- 17/11 (Radar, low-ticket, campanha, vídeo): `git show 15ce5f5:docs/PROXIMO_CHAT.md`
- 19/11 e começo de 20/11 (voz do dono, telas, pesquisa no PC, OpenBot): `git show 6b7fd83:docs/PROXIMO_CHAT.md`

> **Objetivo do Joel:** vender o NIGHT como programa. O OpenBot é só ferramenta auxiliar (as "telas").
> **Foco:** Radar de Ofertas de **low-ticket**, anúncios na Meta e produto low-ticket. **Vídeo parado** até ele pedir.

---

## 1. Estado em uma olhada

- **Git:** o último commit no GitHub é `deffb33`.
  - Os commits locais `6b7fd83` e o seguinte (Radar e esta passagem) **ainda não foram enviados**. Ver a seção 4.
  - **O repositório é PÚBLICO.** Nunca commite chave, e-mail, ID de conta de anúncios (`act_…`) ou nome de conta do Joel.
- **Testes:** 770 passando e `pnpm typecheck` limpo (20/11).
  - O teste do agendador (`tests/scheduler.test.ts`) falha às vezes com o PC carregado. Rodando de novo, passa.
  - Os testes que usam o banco precisam rodar **um de cada vez** (`--test-concurrency=1`, o `pnpm test` já faz isso). Dois arquivos de banco em paralelo dão falsos erros.
- **Cotas:** o Codex voltou em 20/11 às 13:57. A voz ao vivo funcionou depois disso (o Joel testou e mandou print).
- **Saldo do DeepSeek:** cerca de US$ 1,70.
- **Servidor do NIGHT:** nesta sessão ele rodava em segundo plano (`pnpm night:servidor`) e fecha junto com ela. Para abrir: `Night.cmd` (com voz) ou `pnpm night:servidor` (só painel e telas).
- **Chave do Groq:** passou pelo chat em 18/11. O Joel ainda precisa trocá-la no painel do Groq.

---

## 2. O que entrou em 19 e 20/11

### 2.1 Voz
- **Voz do dono** (D-016): perfil remontado com falas ao vivo; limite padrão 0,68. Falta o Joel testar ao vivo pelo `Night.cmd`.
- **Voz ao vivo** (D-018): botão **Voz ao vivo** no painel. É a voz da OpenAI pelo login do ChatGPT, por um `codex app-server`.
  - Código: [src/app/voz-ao-vivo.ts](../src/app/voz-ao-vivo.ts).
  - Pedidos falados entram com origem `'voz'`: mandam tarefa, não decidem nada.
  - Funcionou em 20/11 depois da cota. Mas o pedido "pesquisar no radar de ofertas" ia para a pesquisa comum na internet; isso foi corrigido no roteador.
  - Prova sem navegador: `npx tsx scripts/voz-ao-vivo-prova.ts`.

### 2.2 OpenBot (D-019)
- **NIGHT → OpenBot:** "manda pro Radar do OpenBot pesquisar X" passa pela API local de automação do OpenBot ([src/openbot/](../src/openbot/)).
- **OpenBot → NIGHT:** a seção **OpenBot** do painel mostra:
  - os agentes;
  - as tarefas que o NIGHT mandou;
  - as aprovações pendentes (aceitar ou recusar só ali);
  - o diário das telas, que chega pela ferramenta MCP `night_relatar`.
- **Configurado no OpenBot pelo mouse** (script em PowerShell; ver seção 5):
  - servidor `night` cadastrado (`http://127.0.0.1:4517/mcp`);
  - **Local scripts** ligado nos 6 agentes.
- **Decisão do Joel:** os 6 agentes ficam com **acesso total e controle do computador**, por enquanto. Não mexer sem ele pedir.
- Exemplos do painel e das telas sem nomes de projetos pessoais.

### 2.3 Meta (D-020)
- **Conector oficial `meta-ads`** cadastrado e logado.
  - Escopo do usuário: `claude mcp add --transport http --scope user meta-ads https://mcp.facebook.com/ads`.
  - Login: `claude mcp login meta-ads`. Precisa de um terminal de verdade: abri uma janela do PowerShell para o Joel e ele só fez o login.
- **Ferramentas da Meta passam de 200 mil tokens.** Toda chamada do NIGHT à Meta precisa de `--settings {"env":{"ENABLE_TOOL_SEARCH":"true"}}` e de `ToolSearch` liberado. Isso já está feito nas três chamadas (criar, ler campanha, Radar).
- **Conta de anúncios:** o Joel escolheu qual usar (20/11). Ela está em `NIGHT_META_AD_ACCOUNT`, variável do usuário do Windows; **não vai no repositório**.
  - Uma conta antiga dele está **desativada pela Meta** ("atividade incomum"). Não usar.
- Ferramentas proibidas para o NIGHT: `ads_activate_entity` e `ads_update_entity` (regra `NUNCA` em `src/ads/meta-writer.ts`).

### 2.4 Radar de low-ticket (o trabalho de agora)
- **Material de referência:** [Radar-de-Ofertas-franklim.pdf](../Radar-de-Ofertas-franklim.pdf), na raiz, sem commit. Extração em texto: [docs/research/radar-de-ofertas-franklim-extracao.md](research/radar-de-ofertas-franklim-extracao.md). Para ler o PDF como imagem: PyMuPDF numa venv temporária (`uv venv` + `uv pip install pymupdf`), porque o leitor de PDF daqui precisa do poppler, que não está instalado.
- **O método:** achar ofertas **caras e já validadas** (R$ 47/67/97), para o Joel vender a versão dele por **R$ 19,90**. Nota de 0 a 10 com 5 critérios; corte em 6.
  - anúncios ativos (0 a 3);
  - dias no ar (0 a 2);
  - outros anunciantes no nicho (0 a 2);
  - preço de origem (0 a 2);
  - dá para entregar em PDF (0 a 1).
- **Fluxo combinado com o Joel (20/11):**
  1. Nicho = **low ticket** (o padrão quando ele não diz o nicho).
  2. **O Codex pesquisa na internet** os melhores nichos e ofertas de low-ticket agora. Pronto: [src/radar/nichos.ts](../src/radar/nichos.ts), com o Claude de reserva se o Codex falhar.
  3. **O Claude busca cada nicho** na Biblioteca de Anúncios (`MetaMcpAdSource`). Com nichos encontrados, buscam-se só os termos deles; as 8 frases de preço do método ficam de reserva.
  4. Nota pela rubrica em código e proposta da versão a R$ 19,90.
  5. **Até 15 ofertas por dia.**
- **Roteador:** "pesquisar no radar de ofertas", "pesquisa produtos de lowticket" e "roda o radar" abrem o Radar. "O que é o radar de ofertas?" continua sendo pesquisa comum.
- **Primeira rodada real (Radar 1, 20/11):**
  - o Codex achou 5 nichos (Air Fryer, finanças pessoais, marmitas, marmitas fitness, concursos), com fontes da Hotmart;
  - o Claude trouxe 15 anúncios do Brasil;
  - **resultado: todos com nota 0 "parcial" e nenhuma oferta.** Motivo na seção 3.1.

---

## 3. Pendências, em ordem

### 3.1 Radar: fazer a nota funcionar (PRIMEIRO)
O que a busca da Meta (`ads_library_search`) devolve, medido em 20/11:
- **Parâmetros:** `search_terms`, `page_ids`, `countries`, `ad_active_status` (ALL/ACTIVE/INACTIVE), `ad_type`, `limit` (no máximo 50). **Não há como ordenar** nem filtrar por data.
- **Campos de cada anúncio:** `id`, `page_id`, `page_name`, `ad_creative_link_title`, `ad_creation_time`, `ad_delivery_start_time` (epoch), `ad_snapshot_url` e `currency`. Mais o `estimated_total_count` da busca. A resposta vem como **JSON dentro de uma string** (`results`), então precisa de dois parses.
- **Não vem:** texto do anúncio, link da página de vendas, preço. E só vêm os anúncios **mais novos**, por isso todos aparecem com "0 dias no ar".

O que a prova manual de 20/11 mostrou que **dá para calcular em código** (critérios 1 e 3):
- **Anúncios ativos da página:** buscar `page_ids=[id]`, `ACTIVE`, `BR` e usar o `estimated_total_count`. Exemplo: a página que mais apareceu em "receitas air fryer" tinha **350 ativos**.
- **Anunciantes no nicho:** contar os `page_id` diferentes numa busca do termo com `limit 50`. Em "receitas air fryer": 7 em 50 (total estimado de 1.401).

O que **não dá** pela Meta (critérios 2 e 4):
- **Dias no ar:** a busca só devolve os mais novos.
- **Preço de origem:** não vem.
- Opções para o próximo chat:
  - (a) abrir o `ad_snapshot_url` ou a página de vendas pelo navegador (o método original usa o Claude in Chrome, num perfil separado do Chrome; ver as regras da pág. 9 do PDF);
  - (b) aceitar nota parcial e ajustar o corte;
  - (c) perguntar ao Joel qual ele prefere.
- **Não inventar número:** campo que não aparece fica "não visível", como o material manda.

**O que fazer:**
1. Mudar o `MetaMcpAdSource` (ou criar outra fonte) para, em **uma sessão por nicho**:
   - buscar o termo com `limit 50`;
   - contar os anunciantes;
   - pegar as 3 páginas que mais aparecem;
   - para cada uma, buscar por `page_ids` e anotar os ativos estimados e os títulos.
   - O código valida tudo; o modelo só traz os dados.
2. Ajustar a nota (`src/radar/score.ts`) para usar os ativos por página e os anunciantes no nicho. Decidir com o Joel o corte quando "dias no ar" e "preço" não estiverem visíveis (o código hoje usa corte 7; o PDF usa 6).
3. **Entregável em PDF (0 a 1):** pode ser classificado por um modelo barato a partir do nicho e dos títulos.
4. Rodar de novo: "pesquisa produtos de lowticket". Critério de pronto: pelo menos 1 oferta com nota real e justificativa por critério ("3+?+2+?+1").
5. **Ideia aprovada na conversa (maior):** o NIGHT falar **direto** com o conector da Meta, sem sessão do Claude no meio. Fica mais rápido (cada busca hoje leva cerca de 1,5 min), mais barato e com botão **"Conectar Meta"** no painel (login próprio). Antes, confirmar no guia da Meta se o login exige um app próprio da Meta.

### 3.2 Revisão do Codex (segurança), agora que ele tem cota
Pedir `review` do Codex (skill `codex`) e tratar cada achado:
- [src/app/voz-ao-vivo.ts](../src/app/voz-ao-vivo.ts) e as rotas `/api/voz/*`;
- [src/openbot/](../src/openbot/), a rota `/api/openbot/responder` e a origem `'voz'` no coordenador;
- as mudanças do Radar (`src/radar/nichos.ts`, `worker.ts`) e do roteador;
- `src/ads/` e `src/radar/meta-mcp-source.ts` (que estavam na lista desde 17/11).

O DeepSeek já revisou a voz ao vivo e o OpenBot. Os achados graves foram corrigidos (D-018, D-019).

### 3.3 Testes reais que faltam
- **NIGHT → OpenBot:** "manda pro agente NIGHT do OpenBot responder: oi" e conferir a resposta na seção OpenBot do painel.
- **Voz ao vivo:** "o que tá rodando?", uma pesquisa e "aprovo a oferta 1" (este tem que mandar para o painel).
- **Voz do dono:** abrir pelo `Night.cmd` e ver se o Joel é aceito com o limite de 0,68.

### 3.4 Meta: escrita (só com o Joel acompanhando)
- **M01:** provar que criar alguma coisa é recusado pela Meta com as chaves de escrita desligadas (Configurações do negócio → Integrações → Ads MCP Server; "Editar status" sempre desligado).
- **M04 real:** "monta a campanha da oferta N" e depois "aprovo montar … com R$ 20 por dia". Tudo PAUSADO. Conferir no Gerenciador.

### 3.5 Pedidos do Joel ainda não feitos
- Seção **"Modelos"** no painel: Codex, Claude e DeepSeek com conectado/cota, botão Conectar e modelo por papel.
- **Pular o Codex com cota em 100%:** o percentual está em `account/rateLimits/read` do `codex app-server`, ou em `~/.codex/sessions/**/rollout-*.jsonl`.
- **WhatsApp** como o OpenBot faz (só pesquisado). Mandar mensagem é ação para fora: precisa de aprovação.
- Plano de arquitetura do produto (o Joel perguntou como os agentes conversam; resposta na conversa de 20/11: coordenador no centro, quadro de trabalhos, MCP para fora, A2A só depois).

### 3.6 Novos agentes e skills que o Joel trouxe (20/11)
O Joel disse que são as próximas skills e agentes a adicionar. Ainda não foram estudados a fundo nem ligados ao NIGHT.
- **Agente de UI/UX e marketing** (landing pages, anúncios, criativos): pesquisa em [docs/research/plano-agente-ui-ux-marketing.md](research/plano-agente-ui-ux-marketing.md).
  - Sugere skills abertas (ui-ux-pro-max, frontend-design, marketingskills, agent-browser ou playwright-mcp, remotion, postiz) e recomenda agentes pequenos ligados a um orquestrador próprio, que é o desenho do NIGHT.
  - Conversa com o L03 (página de vendas do low-ticket) e com os criativos da campanha.
  - Antes de instalar qualquer skill de terceiros, revisar o código (risco de `SKILL.md` malicioso, citado no próprio documento).
- **Skill `viral-video-studio`** do OpenBot: [openbot/skills/viral-video-studio/SKILL.md](../openbot/skills/viral-video-studio/SKILL.md).
  - O Codex é o roteirista, o Claude Code faz as animações (Remotion) e publica em 4 redes, sempre com revisão antes.
  - **O vídeo está parado** por pedido do Joel: confirme com ele antes de começar.
- Próximo passo: perguntar ao Joel a ordem (UI/UX primeiro combina com o Radar e o low-ticket) e fazer um plano curto de cada um no estilo do plano mestre.

### 3.7 Antes de vender
- Licença comercial do OpenBot (PolyForm Noncommercial).
- Login de verdade no painel. Hoje qualquer programa do PC usa o `/mcp`, que não tem token.
- Cada cliente com as próprias chaves e contas.
- Tirar "Joel" e nomes de projetos pessoais do código e dos testes.
- Instalador.
- Layout do painel no celular: já passava da borda direita antes de 19/11.

---

## 4. Git: o que está local

- **Dois commits locais, sem push:** `6b7fd83` (Meta conectada, roteador do Radar, `nichos.ts`) e o seguinte (etapa de nichos ligada ao Radar, testes e esta passagem). Já conferido: nenhum ID nem nome de conta de anúncios neles.
- **Fora do git:** o PDF na raiz (**pergunte ao Joel antes de subir**: é material de terceiros) e dois arquivos que o Joel pôs na raiz em 20/11 (`PROJETO_AGENTE_UI_UX_MARKETING.md`, `SKILL.md`); não são do NIGHT até ele dizer.
- O Joel pediu commit e push várias vezes nesta sessão. Para o lote de agora, confirme com ele antes do push.
- **Worktree do Codex** que ficou: `C:\Users\Joel\.codex\worktrees\49f7\NIGHT`. O diff dela já foi trazido; pode ser removida.

---

## 5. Como trabalhar aqui (lições de 19 e 20/11)

- **Dividir o trabalho para poupar a cota do Claude** (pedido do Joel):
  - O **DeepSeek** faz telas e testes (`node ~/.claude/skills/deepseek/deepseek.mjs task --atual …`; `--atual` leva o que está sem commit). Ele **não roda** os testes do projeto (`node --test`); quem roda é você. Nunca apague a cópia dele na mão: use `limpar`.
  - O **Codex** faz tarefas maiores (`node ~/.claude/skills/codex/codex.mjs task …`). A cópia dele parte do **último commit**: faça um commit local antes. Ele também não conseguiu rodar `tsc` nem testes (erro EPERM).
  - O **Claude** fica com segurança, dinheiro, login, revisão e junção.
- **Editar código com barra invertida:** script `node -e` dentro de bash e Python em heredoc trocam `\b` por caractere de backspace e comem `\s`. Use a ferramenta Edit, ou escreva o script com a ferramenta Write e rode o arquivo. Confira com `grep -c $'\x08' arquivo`.
- **Controle do OpenBot pelo mouse:**
  - O script fica no scratchpad da sessão (`ob.ps1`) e se perde; refaça com estas lições:
  - usar a **maior janela visível** do processo OpenBot (o `MainWindowHandle` pega uma barrinha de 614x50 fora da tela);
  - `SetProcessDPIAware` e soltar o Alt antes do `SetForegroundWindow`;
  - conferir que a janela da frente é do OpenBot antes de cada clique;
  - print só da janela, com `CopyFromScreen`;
  - **colar texto pela área de transferência** (o Caps Lock do Joel costuma estar ligado e o SendKeys inverte as letras), guardando e devolvendo o que estava lá.
  - Ao terminar, esconda as barrinhas 614x50 que o restaurar faz aparecer (`ShowWindow(h, 0)`): o Joel reclamou delas.
- **Login de conector MCP** (`claude mcp login …`) precisa de terminal interativo: abra uma janela com `Start-Process powershell -ArgumentList '-NoExit','-Command','claude mcp login <nome>'`.
- **Uma conversa só enxerga os MCP que existiam quando ela abriu.** Conector novo aparece no `/mcp` de uma conversa nova ou no terminal.
- **Regras do Joel que valem sempre:**
  - nada de dinheiro real, publicação ou push sem pedido;
  - nunca credencial no código, no prompt ou no log;
  - respostas em português simples;
  - o Claude lidera e o Codex revisa mudanças grandes;
  - ler `.agents/em-andamento.md` no começo e anotar o que vai editar.

---

## 6. Variáveis de ambiente (novas desde 19/11)

| Variável | Para quê |
|---|---|
| `NIGHT_META_AD_ACCOUNT` | Conta de anúncios das campanhas (já definida no usuário do Windows; não vai no repositório) |
| `NIGHT_META_READ_TOOLS` | Ferramentas de leitura do Radar (padrão `mcp__meta-ads__ads_library_search`; `off` desliga) |
| `NIGHT_CODEX_LIVE_BIN` | Codex da voz ao vivo (padrão: o mais novo do OpenBot, >= 0.156) |
| `NIGHT_VOZ_LIVE_MODEL`, `NIGHT_VOZ_LIVE_VOICE` | Modelo da ponte da voz ao vivo e voz da OpenAI |
| `OPENBOT_AUTOMATION_DIR` | Pasta de automação do OpenBot (padrão `%APPDATA%\OpenBot\automation`) |
| `NIGHT_SPEAKER_MIN` | Semelhança mínima da voz do dono (padrão 0.68) |

As das passagens de 17 e 19/11 continuam valendo.
