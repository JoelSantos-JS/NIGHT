# NIGHT: passagem para o próximo chat

**Escrito em 21/11/2026, de manhã.** Para um Claude novo, sem a memória desta conversa, e para o Joel. Leia inteiro antes de mexer.

Depois leia:
- [.agents/em-andamento.md](../.agents/em-andamento.md): vazio, ninguém mexendo em nada;
- as decisões D-016 a D-022 em [DECISIONS.md](DECISIONS.md).

Passagens anteriores (no histórico do git):
- 17/11 (Radar, low-ticket, campanha, vídeo): `git show 15ce5f5:docs/PROXIMO_CHAT.md`
- 19/11 e começo de 20/11 (voz do dono, telas, pesquisa no PC, OpenBot): `git show 6b7fd83:docs/PROXIMO_CHAT.md`
- fim de 20/11 (Radar com nota real, Design e Marketing, skills): `git show 5b77f5d:docs/PROXIMO_CHAT.md`
- madrugada de 21/11 (roteador, Executor, status do Radar, chat no celular): `git show 5db0bcf:docs/PROXIMO_CHAT.md`

> **Objetivo do Joel:** vender o NIGHT como programa. O OpenBot é ferramenta auxiliar (agentes e "telas").
> **Foco:** Radar de Ofertas de **low-ticket**, anúncios na Meta e produto low-ticket. **Vídeo parado** até ele pedir.

---

## 1. Estado em uma olhada

- **Git:** tudo no GitHub depois do push desta passagem. **O repositório é PÚBLICO**: nunca commite chave, e-mail, ID de conta de anúncios (`act_…`) ou nome de conta do Joel.
- **Testes:** 800 passando e `pnpm typecheck` limpo.
- **Limite do Claude:** **91% da semana** em 21/11 de manhã; renova **24/11 às 08:00**. Cada busca do Radar é uma sessão do Claude (~3 a 5 min). Até renovar, só teste que não gaste o Claude.
- **Codex:** 7% da janela de 5 h e 28% da semana. **DeepSeek:** US$ 1,71 (não foi usado).
- **Servidor:** rodando com `NIGHT_RADAR_BUSCAS=1` (1 busca por rodada). Sem a variável, são 3.
- **OpenBot:** precisa estar **aberto** para o Executor e as telas (ele só escreve `url` e `token` em `%APPDATA%\OpenBot\automation` quando abre). Com ele fechado, a cópia do pedido falha e vai para o log.
- **O Radar agora busca pelo Codex por padrão** ([src/radar/codex-mcp-source.ts](../src/radar/codex-mcp-source.ts), feito pelo Codex e revisado/testado pelo Claude). `NIGHT_RADAR_PROVIDER=claude` volta para a sessão do Claude. O Codex já está ligado ao MCP da Meta (OAuth) e só pode usar `ads_library_search` (`enabled_tools`); qualquer outra ferramenta da Meta derruba a busca.
- **Os dois bateram limite em 21/11 de manhã:** Claude (sessão, "resets 11:40am America/Bahia"; semana em 91%) e Codex (até 11:54). A busca real pelo Codex **ainda não foi provada** (seção 3.1, item 0).
- **"Valores mais baixos":** pedido com "barato", "valor mais baixo", "R$ 9,90/19/27" usa `PALAVRAS_PRECO_BAIXO` (R$ 9,90 a R$ 37) em vez das frases caras do PDF. Pela rubrica, origem abaixo de R$ 37 vale 0 no preço: são os concorrentes do preço final.

---

## 2. O que fizemos em 21/11 de manhã (teste de verdade)

### 2.1 Por que o Radar não trazia nada
1. **A sessão do Radar ficava sem ferramenta da Meta.** `claude mcp list` mostrava `meta-ads … tools fetch failed — Request timed out`: a lista de ferramentas da Meta é enorme e o CLI desistia. O modelo gastava 25 rodadas procurando no ToolSearch e respondia texto → "resposta da busca por nicho não é JSON" (Radar 4).
   - Conserto: `MCP_TIMEOUT=120000` no processo do Claude do Radar ([src/radar/meta-mcp-source.ts](../src/radar/meta-mcp-source.ts); `runCli` aceita variáveis extras em [src/agents/research.ts](../src/agents/research.ts)).
   - Prazo por busca de 180 s → **360 s** (a busca real levou 189 s).
   - O erro "não é JSON" agora mostra o começo do que o modelo escreveu.
2. **O Radar buscava o lugar errado.** O Codex trocava as frases de preço do PDF por "nichos" (marmitas, planner…), e a busca por nicho traz qualquer página que anuncia (Biblioteca Católica). O Joel: "nada a ver com low-ticket, tem o PDF explicando".
   - Agora o Radar de low-ticket busca **as frases de preço do PDF** (`apenas R$ 97`, `de R$ 197 por R$ 67`…), **sem** o planejador de nichos. Poucas por rodada, girando por dia: `palavrasDaRodada()` em [src/app/coordinator.ts](../src/app/coordinator.ts), quantidade em `NIGHT_RADAR_BUSCAS` (padrão 3).
   - O planejador de nichos do Codex continua no código (`planejarNichos`), só não é mais usado no pedido de low-ticket.
3. **Preço e dias no ar nunca apareciam** (nota máxima 6). Agora:
   - **Preço de origem** sai do título do anúncio (`precoDosTitulos`: "por apenas R$ 97,00" → 97; "de R$ 197 por R$ 67" → 67).
   - **Dias no ar** pela data de início do anúncio mais antigo da página (`inicioMaisAntigo` e `delivery_start`).
   - Os dois só valem se aparecem na resposta crua da Meta (`RespostaCrua`).
4. **Título com acento era sempre descartado:** a Meta manda `n\u00e3o` e a conferência procurava "não". `temTexto` agora aceita as formas escapadas.
5. **Nota 7 não virava oferta:** nota parcial só passava se faltasse dias/preço. Agora, se os pontos que se vê já dão 6 ou mais, passa ([src/radar/score.ts](../src/radar/score.ts), `acimaDoCorte`).
6. **Cancelar não parava:** depois de "cancelar", o Radar abria a próxima busca. Agora confere antes de cada busca. A sessão que já estava rodando **não** é morta (ver 3.2).
7. **Um nicho com erro derrubava o Radar inteiro.** Agora vira aviso e os outros seguem; falha tudo só se todos falharem ou bater limite de uso ([src/radar/collect.ts](../src/radar/collect.ts)).

**Prova (Radar 8, uma busca "apenas R$ 97"):**
- **Método QAP** (preparação para GCM, R$ 97): **nota 7**, `1+2+2+2+? = 7 (parcial, máx. 9). 12 anúncios ativos, 52 dias no ar, 21 anunciantes no nicho, origem R$97, entregável não visível.`
- Ficou com 0 ofertas por causa do item 5, consertado depois. **Falta rodar uma vez para ver a oferta montada no painel.**
- Para reproduzir uma busca fora do servidor: `node --import tsx lab/repro-nicho.ts "apenas R$ 97"` (grava a saída crua em `REPRO_OUT`).

### 2.2 Roteador
- "pesquise quanto custa em média um curso low ticket de confeitaria" abria um Radar com a frase inteira como nicho. Agora, com pergunta logo depois do verbo (quanto, qual, como, se…), vai para a pesquisa, a não ser que o Radar seja citado pelo nome ([src/router/router.ts](../src/router/router.ts), `ASKS_ANSWER`).

### 2.3 O que foi conferido e funciona
- **Executor (D-022):** com o OpenBot aberto, pedido de pesquisa virou tarefa do NIGHT Executor, que respondeu com fontes. O NIGHT respondeu a parte dele também.
- **Status do Radar:** "como está o radar 8?" diz quantas ofertas, quantos anúncios e o primeiro aviso.
- **Marketing do OpenBot:** respondeu, mas o Joel achou fraco ("só sugestão"). **Não mande pedido de teste ao Marketing/Design sem ele pedir** (gasta e ele não quer).

---

## 3. O que falta fazer, em ordem

### 3.1 Radar (com o Joel)
0. **Provar a busca pelo Codex:** pelo PowerShell (no Git Bash o `HOME` vira `/c/...`), `node --import tsx lab/repro-codex.ts "apenas R$ 19,90"`. Pronto quando voltar total, páginas e títulos conferidos. Falha "Codex não conseguiu consultar a Meta" = o MCP não carregou (ver `startup_timeout_sec`).
   - Também: o agente NIGHT Radar do OpenBot respondeu "ainda não há ofertas" quando o trabalho **falhou** por limite (recado do Codex). Fazer o status dizer a falha.
1. **Rodar o Radar uma vez** (depois de 24/11 08:00, ou antes se o Joel quiser gastar): "use o radar para pesquisar oferta low tickets". Pronto quando a Método QAP ou outra com nota ≥ 6 **virar oferta no painel**.
2. **Entregável em PDF** fica sempre "não visível": o classificador ([src/radar/meta-mcp-source.ts](../src/radar/meta-mcp-source.ts), `deepSeekPdfClassifier`) recebe só a frase ("apenas R$ 97"). Precisa ver o produto (título conferido), tratando o título como dado de terceiro (revisão do Codex de 20/11 era contra; decidir com cuidado, talvez limitar a resposta a true/false e pedir revisão).
3. **"Anunciantes no nicho"** hoje conta páginas distintas na busca da frase de preço, não do nicho do produto. Revisar o critério.
4. **Cancelar matar a sessão em andamento** (hoje ela termina sozinha, até 6 min gastando o Claude): passar um `AbortSignal` até o `runCli`.
5. **Radar fase 2, com navegador:** página de vendas e domínio (perfil separado do Chrome, pág. 9 do PDF).

### 3.2 Revisão do Codex (segurança) de 21/11, ainda não tratada
Resposta salva em `%LOCALAPPDATA%\claude-codex\2026-11-21T09-54-37-305Z-review.md`.
- **[grave]** `src/ads/campaign.ts:222`: na retomada, campanha achada pelo nome é reutilizada sem conferir se está PAUSADA antes de criar conjunto e anúncios.
- **[grave]** `src/ads/meta-writer.ts:68`: PAUSADO é pedido em texto ao Claude e só conferido no fim; conferir cada item logo depois de criar.
- **[médio]** `src/ads/campaign.ts:234`: retomada reutiliza conjunto com orçamento antigo enquanto a resposta fala do novo.
- **[médio]** `src/app/server.ts:465`: `/mcp` sem token (já estava na lista "antes de vender").
- Tratar antes do M04 ("monta a campanha da oferta N"). Nada disso roda sem aprovação do Joel.

### 3.3 Continuam abertos (da passagem anterior)
- Conferir o chat no celular (janela estreita).
- `src/viral-video-studio/` fora do git: perguntar ao Joel; vídeo parado.
- Cópias velhas do Codex: `git worktree remove --force C:\Users\Joel\.codex\worktrees\e6bd\NIGHT` e `…\d5dd\NIGHT`.
- NIGHT falar direto com o conector da Meta, sem sessão do Claude (mais rápido e barato, e não gasta o limite).
- Seção "Modelos" no painel; pular o Codex com cota em 100%; WhatsApp; testes de voz; Meta escrita (M01, M04).
- Antes de vender: licença do OpenBot, login no painel, chaves por cliente, tirar "Joel" do código, instalador.

---

## 4. Git

- Fora do git: o PDF do Franklim (material de terceiros; pergunte antes de subir) e `src/viral-video-studio/`.
- Antes de cada push: `git diff origin/main..HEAD | grep -iE "act_[0-9]|@gmail"`.

---

## 5. Como trabalhar aqui

- **Gastar pouco:** o Joel está perto do limite. Teste do Radar com **uma busca** (`NIGHT_RADAR_BUSCAS=1`). Antes de rodar algo que abre sessão do Claude ou manda tarefa a agente do OpenBot, diga quanto gasta.
- **Testar como o Joel usa:** o painel manda `POST /api/pedir` com `Origin: http://127.0.0.1:4517` e o `TOKEN` da página `/painel`. Escreva o corpo num arquivo UTF-8 e mande com `curl --data-binary @arquivo` (texto na linha de comando perde acento no Windows).
- **Cancelar trabalho:** `POST /api/decidir` com `{"tipo":"cancelar-trabalho","kind":"radar","numero":N}`. Confira se sobrou `claude.exe` com `mcp-config` na linha de comando.
- **Dividir o trabalho:** Codex (`node ~/.claude/skills/codex/codex.mjs task|ask|review …`) para revisão e lógica maior; DeepSeek para CSS e textos; Claude para roteador, segurança, dinheiro, junção e testes.
- **Barra invertida:** script `node`/heredoc com regex perde as barras. Use a ferramenta Edit.
- **Banco:** `postgres://night@localhost:5433/night` (tabelas `jobs`, `job_events`, `radar_candidates`, `radar_offers`, `route_log`). Script `.mjs` dentro de `D:\NIGHT` e `timeout 30 node …`.
- **Reiniciar o servidor:** matar o `node.exe` com `server-main` e `Start-Process powershell -WorkingDirectory D:\NIGHT -ArgumentList '-NoExit','-Command','pnpm night:servidor'`. Sobe em ~30 s na porta 4517.
- **Regras do Joel:** nada de dinheiro real, publicação ou push sem pedido; nunca credencial no código, prompt ou log; português simples; o Claude lidera e o Codex revisa; ler `.agents/em-andamento.md` no começo e anotar o que vai editar.

---

## 6. Codex no MCP da Meta (já ligado em 21/11; referência)

Para o Codex poder ler a Biblioteca de Anúncios também (e o Radar não depender só do limite do Claude).

- **Pelo terminal** (confira com `codex mcp --help`, a sintaxe muda entre versões):
  ```
  codex mcp add meta-ads --url https://mcp.facebook.com/ads
  codex mcp login meta-ads
  codex mcp list
  ```
- **Ou no** `~/.codex/config.toml`:
  ```toml
  [mcp_servers.meta-ads]
  url = "https://mcp.facebook.com/ads"
  startup_timeout_sec = 120
  tool_timeout_sec = 300
  ```
  O `startup_timeout_sec` alto é pelo mesmo motivo do Claude (2.1): a lista de ferramentas da Meta é enorme e o prazo padrão não dá.
- **Login:** é OAuth da Meta. Use o **Facebook do perfil separado** (pág. 9 do PDF), não o que administra a BM principal.
- **Só leitura:** no Radar só vale `ads_library_search`. Nada de criar, editar ou ativar pelo Codex.
- **Fonte do Radar pelo Codex:** existe (`codex exec --json --sandbox read-only` com `enabled_tools=['ads_library_search']`), com a mesma conferência da `RespostaCrua`. Modelo em `NIGHT_RADAR_CODEX_MODEL` (padrão `gpt-6-sol`).

---

## 7. Variáveis de ambiente

| Variável | Para quê |
|---|---|
| `NIGHT_RADAR_PROVIDER` | `claude` usa a sessão do Claude no Radar; qualquer outro valor (padrão) usa o Codex |
| `NIGHT_RADAR_CODEX_MODEL` | Modelo do Codex no Radar (padrão `gpt-6-sol`) |
| `NIGHT_RADAR_BUSCAS` | Frases de preço por rodada do Radar de low-ticket (padrão 3; cada uma é uma sessão do Claude) |
| `NIGHT_OPENBOT_EXECUTOR` | Agente do OpenBot que recebe cópia dos pedidos de trabalho (padrão `NIGHT Executor`; `off` desliga; D-022) |
| `NIGHT_LLM_CTX` | Contexto do modelo local (padrão 8192) |
| `NIGHT_META_AD_ACCOUNT` | Conta de anúncios das campanhas (no usuário do Windows; fora do repositório) |
| `NIGHT_META_READ_TOOLS` | Ferramentas de leitura do Radar (padrão `mcp__meta-ads__ads_library_search`; `off` desliga) |
| `NIGHT_CODEX_LIVE_BIN` | Codex da voz ao vivo (padrão: o mais novo do OpenBot, >= 0.156) |
| `NIGHT_VOZ_LIVE_MODEL`, `NIGHT_VOZ_LIVE_VOICE` | Modelo da ponte da voz ao vivo e voz da OpenAI |
| `OPENBOT_AUTOMATION_DIR` | Pasta de automação do OpenBot (padrão `%APPDATA%\OpenBot\automation`) |
| `NIGHT_SPEAKER_MIN` | Semelhança mínima da voz do dono (padrão 0.68) |

As das passagens de 17 e 19/11 continuam valendo.
