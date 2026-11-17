# NIGHT: passagem para o próximo chat

**Escrito em 17/11/2026, ao fim de uma sessão longa.** Lido por um Claude novo (sem a memória desta conversa) e pelo Joel. Leia este arquivo inteiro antes de mexer em qualquer coisa. Depois leia o [plano mestre](PLANO_MESTRE_NIGHT.md), que é o backlog oficial com critério de pronto por tarefa, e o [.agents/em-andamento.md](../.agents/em-andamento.md).

> **Foco escolhido pelo Joel em 17/11:** Radar, anúncios na Meta e produto low-ticket. **O vídeo está parado** por pedido dele ("esquece o vídeo agora"). Não retome o vídeo sem ele pedir.

---

## 1. Estado em uma olhada

- **Nada foi commitado.** Tudo desta sessão está sem commit no `main` (cerca de 70 arquivos novos ou alterados). O último commit é `8d37c5a`. **Primeira decisão do próximo chat: perguntar ao Joel se pode commitar** (ver seção 4.1).
- **Testes:** `pnpm test` com 668 testes passando e `pnpm typecheck` limpo.
  - Os testes de banco usam `night_test` (Postgres na porta 5433) e precisam rodar em sequência: o `pnpm test` já usa `--test-concurrency=1`. Rodar dois arquivos de banco em paralelo dá falsos erros.
- **Banco real (`night`) ainda não recebeu as migrações 004 a 012.** Elas rodam sozinhas na primeira vez que alguém abrir `pnpm night` ou `pnpm night:voz`. São aditivas: tabelas novas e CHECKs ampliados (a 011 e a 012 trocam CHECKs de `tasks` e `jobs`).
- **Plano mestre:** 78 tarefas, 43 prontas. Cada uma está marcada `[x]`, e a seção "Progresso em 17/11/2026" resume as ressalvas.
- **Saldo DeepSeek:** US$ 0,11. Dá para 1 tarefa pequena. Avise o Joel para recarregar antes de uma leva grande.
- **Instalados nesta sessão** (registro em [agents/ferramentas-externas.md](agents/ferramentas-externas.md)):
  - ship-it em `C:\Users\Joel\tools\ship-it`, commit `a92f85c`
  - Executor `2.0.0-beta.60`, com o serviço **parado**

---

## 2. O que já funciona (resumo por área)

### Base de trabalhos (F01–F08)
- Trabalhos (`jobs`) de cinco tipos: `coding`, `radar`, `video`, `lowticket` e `campanha`. Cada tipo tem número falável ("radar 2", "produto 1").
- Pedido repetido não duplica (`idempotency_key`). Efeito externo é registrado uma vez por chave (`recordJobEffect`).
- O `JobRunner` só marca sucesso com artefatos conferidos por hash (`ArtifactStore`). Ele trata espera (`waiting` + `waitingFor`) e retomada sem repetir efeito, e não roda dois laços no mesmo trabalho.
- Ao reiniciar, retoma o que estava `running`. O que está `waiting` espera o Joel dizer "continua…".

### Parecer DeepSeek (D01–D13, menos D10 na nuvem)
- Matriz de pontos de decisão (`src/advisor/matrix.ts`).
- Cliente da API com saída validada; texto de fonte externa vai em bloco `<<<DADOS>>>`.
- Diário com cache e reserva atômica, para não cobrar duas vezes.
- Regra de divergência: teste falhando, fonte faltando ou decisão reservada ao Joel sempre vencem quando os modelos concordam.
- O DeepSeek é reserva do Codex na conversa, na pesquisa e na revisão. Revisão que falhou ou ficou sem veredito nunca é anunciada como "aprovou".
- O DeepSeek também é agente de código dentro do NIGHT (`DeepSeekCodingAgent`: CLI do Claude em `--bare`, sem commit, teto de saldo). Ainda não rodou numa tarefa real (D12).

### Radar (R02–R06, R08)
- Banco: `radar_candidates`, `radar_offers` (com versões) e `radar_feedback`.
- Coleta incremental com cursor e sem duplicar. Nota de triagem em código: a rubrica do PDF, com os 80 resolvidos e nota parcial quando falta dado.
- Proposta original com validação: sem cópia de 8+ palavras, sem promessa de renda, 4 PDFs, 5 ângulos. Parecer DeepSeek no fluxo.
- Conversa por voz/texto: "mostra a oferta 3", "por que ela é boa?", "ajusta o público da oferta 3 para…", "aprova a oferta 2".
- **Trabalhador do Radar pronto, mas hoje para em `waiting: fonte`.** Falta provar a fonte de anúncios (R01, M01–M02).

### Low-ticket (seção L)
- **"Gera o produto da oferta N"** (só oferta aprovada) gera 4 PDFs, o bônus e a página de vendas HTML, junta tudo num pacote versionado e passa pelo parecer.
  - Foi provado de ponta a ponta com o DeepSeek real.
  - Amostra em `D:\NIGHT-data\amostras\produto-piloto-caixa-do-autonomo`.
  - Os PDFs são gerados pelo Edge em modo headless, já instalado no PC.
- **Criativos (L04):** `src/lowticket/creatives.ts` monta os 5 textos por ângulo e uma folha de prompts para o Flow. Ainda não está ligado a um comando (ver 4.3).
- **Análise do teste e escala (L05/L06):** `src/lowticket/analysis.ts` calcula as métricas e diz onde está o furo (criativo, página, checkout, preço ou amostra pequena). Sugere subir 30% por vez e nunca dobrar, sempre como sugestão. Ainda não está ligado a um comando (ver 4.3).
- Links por oferta, guardados na tabela `offer_links`:
  - "a página da oferta 2 é https://…"
  - "o checkout da oferta 2 é https://…"
  - "as imagens da oferta 2 são https://… https://…"

### Campanha na Meta (seção M), feita pelo Claude porque mexe com dinheiro
- **"Monta a campanha da oferta N"** mostra o rascunho e as pendências, sem chamar a Meta.
- **"Aprovo montar a campanha da oferta N com R$ X por dia"** cria campanha, conjunto e anúncios **PAUSADOS**.
  - O teto é de R$ 200 por dia.
  - Repetir a frase não duplica: cada etapa é um efeito com chave, e a campanha é achada pelo nome com tag.
  - Em erro, para e não repete.
  - Na leitura de volta, qualquer item que não esteja `PAUSED` gera um alerta.
  - Ativar é com o Joel, no Gerenciador.
- O adaptador real (`src/ads/meta-writer.ts`) roda uma sessão do Claude Code por etapa, com **uma** ferramenta do MCP liberada. Ele recusa ferramentas de ativar, editar status ou orçamento.
- Tudo isso está testado **só com MCP falso**: o conector ainda não foi ligado.
- **M07 (leitura do desempenho):** ver o fim deste arquivo, na seção "Atualização final".

### Vídeo (parado por pedido do Joel)
- Funciona até a espera do Flow:
  - roteiro gerado e validado com fontes
  - folha de prompts em `D:\NIGHT-data\flow-import\<n>\`
  - narração com Kokoro no modo voz
  - render com FFmpeg, provado com 5 s, legenda e áudio sincronizados
  - revisão automática e parecer antes do render final
- Pendências: V03 (Flow no navegador), V05 (piloto de 60–90 s), V09, V10.

---

## 3. Prioridade 1: ligar a Meta (destrava o Radar e os anúncios)

### 3.1 O que só o Joel pode fazer (peça a ele, com estes passos)
1. No terminal: `claude mcp add --transport http meta-ads https://mcp.facebook.com/ads`. Depois, no Claude Code, `/mcp`, escolher `meta-ads` e fazer o login da Meta com a conta de anúncios.
2. Em **Configurações do negócio → Integrações → Ads MCP Server**, conferir as 7 chaves. **"Editar status" desligado sempre.** As outras ficam desligadas para a primeira prova, que é só leitura.
3. Passar o id da conta de anúncios (`act_…`).
4. Ter página, conta de anúncios e portfólio empresarial (se não tiver, ele cria na Meta).

### 3.2 O que o Claude faz depois que o conector estiver ligado (M01 → M02 → R01)
1. **Descobrir os nomes reais das ferramentas.** Numa sessão do Claude Code com o MCP, liste as ferramentas (`/mcp` mostra). Os nomes em uso hoje são **palpites** tirados de guias:
   - `mcp__meta-ads__ads_create_campaign`, `…ads_create_ad_set`, `…ads_create_ad`, `…ads_get_ad_entities` (em `src/ads/meta-writer.ts`, `DEFAULT_TOOLS`)
   - a busca da Biblioteca de Anúncios, ainda **sem nome conhecido**
   - Ajuste os padrões ou use as variáveis de ambiente (seção 6).
2. **M01:** provar que uma escrita é recusada pela própria Meta com as chaves desligadas. Registrar a lista de ferramentas de leitura.
3. **M02/R01:** definir `NIGHT_META_READ_TOOLS=<ferramenta de busca da Biblioteca>` e rodar "vasculha ofertas de <nicho>". O `RadarWorker` passa a usar o `MetaMcpAdSource`. Critério: 5 anúncios do Brasil, com tabela de cobertura (o que veio, o que é derivado, o que não aparece). Nada inventado: campo ausente fica ausente.
   - **Ponto de atenção:** confirmar se a Biblioteca pelo MCP mostra anúncios **comerciais comuns do Brasil**, não só políticos. Se não mostrar, o R01 continua aberto e é preciso outra fonte permitida.
   - **Formato da resposta:** o `MetaMcpAdSource` espera os campos `externalId`, `advertiser`, `adUrl`, `landingUrl`, `country`, `startedAt` e `activeAdsInDomain`. Se a Meta não tiver "anúncios ativos no domínio", a nota fica parcial (correto) e vale pensar em derivar esse número contando resultados por domínio. Isso é cálculo em código, não palpite do modelo.
4. **M04 real, com o Joel acompanhando:** ligar as chaves de criar campanha, conjunto e anúncio (status **desligado**, orçamento com teto). Definir `NIGHT_META_AD_ACCOUNT`.
   - Fluxo: "a página da oferta N é …" → "as imagens da oferta N são …" → "monta a campanha da oferta N" → "aprovo montar … com R$ 20 por dia".
   - Conferir no Gerenciador que tudo está pausado.
   - **Risco a observar:** pode ser que a Meta exija o orçamento numa chave separada ("editar ou definir orçamento"). Se a criação do conjunto falhar por isso, ligar essa chave com teto baixo. Status continua desligado.
5. **M06:** observar ritmo e erros reais. Hoje há 2 s entre criações e nenhuma repetição automática.

---

## 4. Prioridade 2: o que dá para fazer sem o Joel

### 4.1 Antes de tudo
- **Commit:** perguntar ao Joel. Sugestão: um commit por área (base de jobs, advisor, radar, low-ticket, ads, vídeo, docs), ou um só com mensagem detalhada. Não fazer push sem pedido. O `.claude/` sem commit é configuração local e não deve entrar.
- **Revisão do Codex da segunda rodada:** a revisão geral (9 achados, todos corrigidos) cobriu a primeira rodada. **Low-ticket, anúncios (`src/ads/`), `offer_links`, `MetaMcpAdSource`, `LowticketWorker` e os comandos novos ainda não passaram pelo Codex.** Pela regra do Joel (mudança grande ou com dinheiro → revisão do Codex antes do "pronto"), rodar:
  `node ~/.claude/skills/codex/codex.mjs review src/ads src/lowticket src/radar/meta-mcp-source.ts src/app/coordinator.ts src/router/router.ts src/app/bootstrap.ts src/memory/migrations/012_lowticket_ads.sql --context "<o que mudou>"`
  e tratar cada achado. **Nunca passar credencial nem comando com dinheiro real ao Codex ou ao DeepSeek.**

### 4.2 Ligações que faltam (código, pequenas)
- **Comando de status para produto e campanha:** "como está o produto 1?" ainda não é reconhecido. `job-status` só aceita `radar`/`video` (em `src/router/router.ts`, `jobStatusIntent`, e no tipo `Intent` 'job-status'). O "status" geral lista os trabalhos ativos.
- **"Mostra o produto da oferta 2" (L07):** listar o pacote (`pacote-produto-v<N>.json`) com os caminhos dos PDFs e da página. Hoje o Joel precisa abrir a pasta `D:\NIGHT-data\artefatos\<jobId>`.
- **Ligar os criativos (L04)** a um comando ("cria os criativos da oferta 2"): grava a folha de prompts e usa os textos por ângulo no rascunho da campanha (`buildCampaignDraft` já aceita `opts.criativos`).
- **Ligar a análise (L05/L06)** a um comando: o Joel dita os números ("o teste da oferta 2 teve R$ 60 de gasto, 4.000 impressões, 70 cliques, 2 vendas") ou eles vêm do M07, e o NIGHT responde onde está o furo e se sugere escalar. Só sugestão.
- **Nome do produto no pacote:** o `LowticketWorker` grava em `artefatos/<jobId>`. Copiar a versão final para `D:\NIGHT-data\produtos\oferta-<N>-v<V>\` facilitaria para o Joel.

### 4.3 Radar
- **R07, rotina diária:** a versão local roda numa hora definida com o NIGHT aberto, sem repetir oferta antiga e com limites. A versão com PC desligado depende de C01–C04 (rotina do Claude na nuvem).
- **Métricas semanais (R08)** já existem em `src/radar/metrics.ts`. Falta o comando "como foi o Radar esta semana?".

### 4.4 ship-it e Executor (instalados, com pendências)
- **S02:** rodar `/groundwork` do ship-it no NIGHT **com o Joel acompanhando** e conferir antes de aceitar. Ele escreve em `AGENTS.md`/`CLAUDE.md` e não pode sobrescrever regras.
- **S05–S08:** rota curta e longa, `do-task` adaptado ao fluxo do NIGHT, testes adversariais e métricas.
- **E02–E05:** conexões restritas no Executor. Útil para M05: publicar a imagem do criativo num lugar com URL https, por exemplo pelo Drive. Hoje o Joel publica manualmente.

---

## 5. Prioridade 3: depois (dependem de conta ou piloto)
- **Vídeo:** V03, V05 (piloto real de 60–90 s), V09, V10. Parado por decisão do Joel.
- **Nuvem:** C01–C04 (rotina do Claude Code Cloud ou Cowork) e D10 na nuvem.
- **OpenBot:** O01–O04, opcional, e só depois de avaliar a licença (não comercial).
- **Passagem de comando:** H01–H03. Depois dela, o Claude lidera e o DeepSeek vira conselheiro e reserva.
- **M08:** ativar e gastar pelo NIGHT só se o Joel pedir, com aprovação `spend` e valor.

---

## 6. Variáveis de ambiente (todas opcionais)

| Variável | Para quê |
|---|---|
| `NIGHT_DATABASE_URL` | Banco (padrão `postgres://night@localhost:5433/night`). Testes: `NIGHT_TEST_DATABASE_URL` / `night_test` |
| `NIGHT_DATA` | Pasta de dados (padrão `D:/NIGHT-data`): `artefatos/`, `flow-import/`, `video-work/`, `lowticket-work/`, `meta-mcp/` |
| `NIGHT_META_AD_ACCOUNT` | Conta de anúncios `act_…`; sem ela, a montagem explica o que falta |
| `NIGHT_META_READ_TOOLS` | Ferramentas de leitura da Biblioteca, separadas por vírgula; sem ela, o Radar espera `fonte` |
| `NIGHT_META_INSIGHTS_TOOL` | Ferramenta de desempenho da campanha (M07; ver "Atualização final") |
| `DEEPSEEK_API_KEY` ou `~/.deepseek/api_key` | Liga parecer, reserva, gerador de roteiro/proposta/produto e agente DeepSeek |
| `NIGHT_CHAT=local` | Conversa só com o Qwen local |
| `NIGHT_CODE_DEEPSEEK_MODEL`, `NIGHT_DEEPSEEK_MODEL` | Modelo do DeepSeek (padrão `deepseek-flash`) |

---

## 7. Como trabalhar neste projeto (o que aprendemos)

- **Divisão de papéis na construção:** pelo [plano mestre](PLANO_MESTRE_NIGHT.md), o DeepSeek implementa e o Claude faz QA, roda os testes e devolve correções. **Exceção:** tudo que mexe com conta de anúncios ou dinheiro (`src/ads/`) o Claude implementa. O Codex dá a segunda visão.
- **Skill do DeepSeek:** `node ~/.claude/skills/deepseek/deepseek.mjs task "<regras + tarefa>" --atual --minutes N`, em segundo plano. A cópia é uma worktree `D:\NIGHT-ds-<data>`.
  - **O DeepSeek não consegue rodar os testes** (só o `npx tsc`): o Claude roda todos.
  - Pedido bom: arquivos permitidos, contrato exato, regras de segurança e testes esperados. Os pedidos desta sessão estão no scratchpad e foram usados com um bloco fixo de regras do projeto: imports com `.ts`, `node:test`, comentários em português, sem dependências.
  - Para trazer o resultado: `git -C <cópia> diff -- src tests | git apply`, mais copiar os arquivos novos (`??`).
  - **Apague a cópia só com** `node ~/.claude/skills/deepseek/deepseek.mjs limpar "D:/NIGHT-ds-…"`. Use barra normal: com `"D:\\$VAR"` no bash a variável não expande e o comando falha.
- **Teste de verdade, além do simulado:** o FFmpeg, o Edge (PDF) e uma chamada real ao DeepSeek pegaram bugs que os testes simulados não pegavam:
  - legenda no Windows
  - vídeo 25 contra 30 fps
  - parecer do produto caindo por referência
  - ordem Flow/voz

  Repita esse hábito na Meta.
- **Captura de página no Windows:** a janela do Edge headless não fica menor que uns 500 px. Para ver como celular, use um `<iframe>` de 375 px dentro de uma janela maior.
- **Regras do Joel que valem sempre:**
  - nada de dinheiro real, publicação, push ou merge sem pedido específico;
  - nunca credencial no código, no prompt ou no log;
  - respostas em português simples;
  - o Claude lidera e o Codex revisa mudanças grandes;
  - ler `.agents/em-andamento.md` no começo e anotar o que vai editar.

---

## 8. Pendências técnicas conhecidas (pequenas, registradas para não perder)
- **Numeração de página nos PDFs** (CSS `@page`) não foi conferida no PDF real: o Edge pode ignorar. Abrir um PDF da amostra e conferir.
- **Retomada da campanha:** se cair entre "criar conjunto" e "registrar", a retomada cria **outro conjunto** (pausado, não gasta). A campanha é achada pelo nome; o conjunto ainda não. Melhoria: procurar o conjunto pelo nome também.
- **Nomes das ferramentas do MCP da Meta** são palpites até o M01 (seção 3.2).
- **O vídeo usa a mesma voz** do NIGHT (Kokoro). Voz própria por canal exige um parâmetro novo no serviço Python.
- **`deepseek.mjs` mostra "Custo: US$ 0.0000"** em várias tarefas porque o saldo atualiza com atraso. O gasto real da sessão foi de cerca de US$ 1,75.

---

## 9. Mapa dos arquivos novos

| Pasta | O que tem |
|---|---|
| `src/jobs/` | `worker.ts` (contrato), `runner.ts`, `limits.ts`, `credentials.ts` |
| `src/artifacts/` | `store.ts`: pasta por trabalho, manifesto, hash |
| `src/advisor/` | parecer DeepSeek: `matrix`, `opinion`, `deepseek-client`, `journal`, `service`, `divergence` |
| `src/agents/deepseek.ts` | reserva (conversa/pesquisa/revisão); `coding.ts` tem o `DeepSeekCodingAgent` |
| `src/cards/` | cartão validável (S03) e importação para tarefa (S04) |
| `src/radar/` | `score`, `store`, `collect`, `offer`, `pipeline`, `conversation`, `metrics`, `worker`, `meta-mcp-source` |
| `src/lowticket/` | `content`, `pdf`, `sales-page`, `links`, `worker`, `creatives`, `analysis` |
| `src/ads/` | `campaign.ts` (rascunho e criação pausada), `meta-writer.ts` (adaptador MCP) e, se o M07 entrou, `meta-reader.ts` |
| `src/video/` | `brief`, `manifest`, `script`, `flow-folder`, `narrate`, `render`, `review`, `agent`, `package` |
| `src/memory/migrations/` | 004 a 012 |
| `docs/research/` | planos por área, incluindo [plano-meta-ads-mcp.md](research/plano-meta-ads-mcp.md) |

---

## Atualização final (fim da sessão de 17/11)

As três últimas tarefas entraram, com 668 testes passando:

- **L04, criativos:** `src/lowticket/creatives.ts` monta os 5 criativos (título até 40 caracteres, texto, descrição, CTA e prompt para o Flow, todos com o mesmo estilo) e grava a folha `criativos-oferta-<N>.md`. `buildCampaignDraft` aceita `opts.criativos`. Ainda falta o comando de voz (4.2).
- **L05/L06, análise e escala:** `src/lowticket/analysis.ts`, com `validateNumbers`, `analyzeTest` e `suggestScaling`. O cálculo é em código e a interpretação é marcada como hipótese. A escala só sugere: +30%, nunca dobra, exige ROAS ≥ 1, CPA ≤ preço, 3+ vendas em 3 dias e 3+ dias desde a última mudança. Ainda falta o comando (4.2).
- **M07, leitura do desempenho:** "como está a campanha da oferta 2?" lê pelo MCP da Meta, só leitura.
  - O adaptador é `src/ads/meta-reader.ts`. Ele recusa qualquer ferramenta com create, update, activate, edit, delete, budget ou status no nome.
  - A ferramenta padrão é `mcp__meta-ads__ads_insights_performance_trend` (palpite; trocar por `NIGHT_META_INSIGHTS_TOOL` depois do M01).
  - Período: últimos 7 dias. Métrica ausente vira `null`, nunca zero.
  - Testado só com MCP falso.

**Ainda sem revisão do Codex:** `src/ads/` (writer e reader), `src/lowticket/` inteiro, `src/radar/meta-mcp-source.ts` e os comandos novos no router e no coordinator. Faça essa revisão antes de declarar a seção M pronta (4.1).
