# NIGHT: passagem para o próximo chat

**Escrito em 25/11/2026.** Leia a seção de 25/11 primeiro; depois a passagem de 24/11 (mais abaixo) e
[.agents/em-andamento.md](../.agents/em-andamento.md). Ids de campanha, pixel e página ficam fora do git, em
`D:\NIGHT-data\aprendercoreano\PASSAGEM.md` (o repositório é público).

## 25/11: Coreano para Iniciantes no ar e agente de campanha ajustado com teste real

### O que está no ar
- **Site:** https://www.aprendacoreano.online (Vercel, projeto `aprendercoreano`). Código em
  `D:\NIGHT-data\aprendercoreano\site\` e no repositório **privado** `JoelSantos-JS/aprendercoreano-site`.
  O domínio é **aprendA**coreano, não "aprender".
- **Cakto:** produto "Coreano para Iniciantes", R$ 14,90. Checkout personalizado (banner com o prazo, lista do que vem,
  garantia) e popup de saída com oferta de R$ 12,90. O PDF vai por link do Drive no e-mail. O Soaken virou bônus grátis.
- **Preço de lançamento até 30/11 às 23:59, depois R$ 19,90.** No dia 1/12, subir o preço na Cakto (produto e oferta de
  saída, sugestão R$ 16,90), no site e no banner do checkout. Senão o prazo vira mentira.
- **Pixel:** a Cakto dá "Erro interno do servidor" ao salvar o pixel, e a API dela descarta o campo sem avisar. O pixel
  está **no site**: PageView e ViewContent na página de venda, InitiateCheckout no clique e **Purchase na página de
  obrigado**. Há **1 compra falsa** no pixel (teste de 24/11). **Nunca abrir obrigado.html para testar.**
- **Campanha do Joel, COREANO1:** ativa, R$ 15/dia, 2 conjuntos com vídeo + imagem, Stories + Reels. Problemas que o
  Joel ainda não mandou corrigir (ela está gastando, mexer só com o ok dele):
  - os anúncios saem no Instagram **@explicaado0** (Explica do Zero);
  - público Advantage+ ligado;
  - "vários anunciantes" ligado;
  - algumas melhorias automáticas ligadas;
  - 2 anúncios com "Ver detalhes" e nenhum com UTM.
- **Criativos:** `D:\NIGHT-data\aprendercoreano\criativos\`. A pasta `PARA_SUBIR\` tem cada formato: imagem em 1:1, 9:16,
  1,91:1 e 4:5; vídeo em 9:16 e 4:5. Os vídeos têm voz do ElevenLabs (plano grátis, que **não permite uso comercial**:
  assinar o Starter) e fotos do Pexels (créditos em `criativos\doramas\CREDITOS.txt`). Para renderizar de novo,
  `python render-video.py a` (ou `b`) dentro da pasta.

### Agente de campanha (commit 4cf2cac)
- Fala com a Meta pela **Graph API, com `NIGHT_META_TOKEN`**, sem MCP. `NIGHT_META_WRITER=mcp` volta ao conector.
- Padrão copiado da COREANO1: **1 campanha** com o valor inteiro, **1 conjunto por teste** (vídeo + imagem),
  **Stories + Reels**. Opções: `estrutura: 'campanha-por-teste'` e `posicionamentos: 'feed-reels'`.
- Sempre: tudo pausado, compra no pixel da oferta, público fixo sem Advantage+, melhorias e "vários anunciantes"
  desligados, UTMs.
- Regras de cada oferta em `offer_links.campanha` (migração 013): pixel, página, gênero, idade, início, vídeos, estrutura.
- **Teste real com a oferta 9 (Coreano):** campanha e conjunto saíram certos. O anúncio foi barrado porque o **app "MCP"
  da Meta está em modo de desenvolvimento**. Sem pôr o app em "Ao vivo" (precisa da URL de privacidade
  https://www.aprendacoreano.online/privacidade.html), nenhum anúncio sai pela API. As campanhas vazias foram apagadas.
- Para montar a oferta 9 de novo: o trabalho antigo aponta para a campanha apagada e vai parar com "DELETED". Fazer uma
  **versão nova da oferta** (nova chave de trabalho) e aprovar de novo.

### Pendências
1. App da Meta em "Ao vivo" (Joel).
2. Corrigir a COREANO1 (só com o ok do Joel).
3. Subir o preço em 1/12.
4. Plano pago do ElevenLabs.
5. Bônus (PDFs extras e acesso ao Soaken) ainda não estão no link de entrega.
6. O NIGHT rodado por script não fecha sozinho depois do `close()` (visto no teste real).
7. Mudanças de outras pessoas continuam sem commit (vídeo, `keywordsDoRadar` do Radar, painel): não são deste chat.

---

## Passagem de 24/11

**Escrito em 24/11/2026.** O estado mais novo está em [PASSAGEM_ANTIGRAVITY.md](PASSAGEM_ANTIGRAVITY.md): ler aquele primeiro. Para um Claude novo e para o Joel. Leia inteiro antes de mexer, e depois leia
[.agents/em-andamento.md](../.agents/em-andamento.md): os recados do Codex de 21 e 22/11 estão lá, com os detalhes.

Passagem anterior (21/11, Radar pelo Codex/MCP): `git show a543127:docs/PROXIMO_CHAT.md`.

> **Objetivo do Joel:** vender o NIGHT como programa. O OpenBot é ferramenta auxiliar (agentes e telas).
> **Low-ticket, para o Joel:** produto que custa R$ 9,90, R$ 19,90… porque é PDF, mapa mental, apostila, planner,
> webapp, atividade para imprimir. Pelo PDF do Franklim, acha a oferta validada (de preferência cara, R$ 47–97) e
> vende a própria versão por R$ 9,90–19,90.
> **Próximo passo combinado:** testar o fluxo inteiro do NIGHT com o OpenBot (seção 3).

---

## 0. Atualização do fim de 24/11 (ler primeiro)

### 0.1 Gasto de tokens
- O meta-ads **saiu do Claude Code no D:\NIGHT** (`claude mcp remove meta-ads -s local`). O NIGHT não precisa dele aqui:
  `meta-writer.ts` e `meta-reader.ts` montam a própria configuração por sessão. Cópia de segurança do arquivo:
  `~/.claude.json.bak-20261124-mcp`.
- Os conectores do claude.ai foram desligados neste projeto com `ENABLE_CLAUDEAI_MCP_SERVERS=false` em
  `.claude/settings.local.json`. **Conferir no chat novo com `/context`**: o MCP deve ter só o caveman e o codegraph.
  Se os conectores ainda aparecerem, achar outro jeito de desligar.

### 0.2 Campanha automática sem login (o Joel quer tudo sozinho)
- **Problema:** o conector meta-ads usa login pelo navegador, que expira. Assim o NIGHT não roda sozinho.
- **Feito:** usuário do sistema **NIGHT** no Gerenciador de Negócios, ligado ao app **MCP** (em desenvolvimento, com os
  casos de uso de Marketing, Instagram e Página). O token está na variável de usuário do Windows `NIGHT_META_TOKEN`
  (nunca no código, no git ou em log). Conferido pela API: ele enxerga a conta de anúncios **"Joel Novo"** (BRL, ativa) e
  a Página **"Coreano Visual"**.
- **Pendente:**
  1. O token **expira por volta de 23/01/2027** e **ficou exposto no chat de 24/11**. Gerar um novo com validade
     "Nunca", salvar com `[Environment]::SetEnvironmentVariable('NIGHT_META_TOKEN', (Read-Host 'Cole o token'), 'User')`
     e revogar o antigo. O Joel pediu para deixar isso para depois.
  2. A Página não tem Instagram profissional ligado e atribuído ao NIGHT. Sem isso, não há post nem anúncio no
     Instagram.
  3. **Código:** trocar a criação de campanha (`src/ads/meta-writer.ts`) do conector MCP para a API de Marketing
     (graph.facebook.com) com `NIGHT_META_TOKEN`, como já faz `src/video/publish.ts`. Manter as travas: PAUSADO e
     orçamento conferido. Revisão do Codex antes de dizer pronto, porque mexe com dinheiro.
  4. **Decisão do Joel ainda não respondida:** a campanha pronta (a) fica pausada até ele ligar no painel, ou (b) liga
     sozinha com um limite de gasto por dia?

---

## 1. O que mudou desde 21/11

### 1.1 O Radar lê a PÁGINA da Biblioteca, não o conector da Meta
- **Por que:** o `ads_library_search` (MCP da Meta) devolve só o **título** do anúncio. Preço e formato ficam no texto, e
  a busca do MCP é solta ("mapa mental R$ 19,90" trazia "aprove seu crédito"). Por isso vinha McDonald's, Audible,
  roupa: "nada a ver com low-ticket" (Joel).
- **Agora:** [src/radar/browser-source.ts](../src/radar/browser-source.ts), ligado no bootstrap. Ele abre o Chrome
  instalado **sem login e sem perfil do Joel** (`playwright-core`), lê o texto de cada anúncio e tira dali, por código e
  sem modelo:
  - só produto digital (regex `FORMATO_DIGITAL`); descarta acima de R$ 197 e o que pede vídeo gravado;
  - agrupa por domínio principal (`dominioBase`) ou pela página. Vendedor sem site é contado pelo `view_all_page_id`;
  - anúncios ativos, dias no ar e preço cobrado ("de R$ 79 por R$ 19,90" → 19,90).
- **Não gasta Claude, Codex nem DeepSeek.** Cada busca leva de 15 a 60 s por frase, e mais quando abre o domínio.
- **Codex (22/11) por cima:** busca site + tipo de produto (`vercel.app atividades para imprimir`,
  [src/radar/search-terms.ts](../src/radar/search-terms.ts)), conta os anúncios **da mesma oferta** e as cópias do
  criativo, lê o preço na página de destino e descarta página que é prévia ou tem checkout desligado. O status do Radar
  mostra até 3 candidatos mesmo com 0 ofertas.
- **Teste avulso:** `node --import tsx lab/repro-biblioteca.ts "mapas mentais" "por R$ 19,90"`.

### 1.2 Resultado real (24/11)
- "mapas mentais": **Fluente com Legenda** (+300 mapas mentais de inglês), 210 anúncios ativos, 110 dias, nota 8 parcial
  (preço não visível no anúncio).
- "por R$ 19,90": **Beatriz Reyes** (+150 atividades para casas de repouso, R$ 5,90), 45 anúncios ativos, nota 6.
  Destino `150-atividades-para-casas-de.vercel.app`.
- **Ainda passa errado:** O Primo Rico/Finclass (assinatura) na busca "mapas mentais", nota 5, abaixo do corte. Falta
  barrar assinatura, plataforma e marca grande.

### 1.3 Oferta Beatriz (Codex, 22/11, autorizado pelo Joel)
- Oferta **nº 3 v1** no banco, `rascunho`: "Roda Pronta", R$ 14,90 hipotético. Os agentes Produto, Design e Marketing do
  OpenBot montaram o modelo e a amostra (`lab/beatriz/modelo.md`, `amostra.pdf`).
- `lab/beatriz/` **fica fora do git**: `referencia/` tem criativo baixado de terceiro, e o repositório é público.
- A tela Marketing nova está em `D:\NIGHT-data\openbot\night-telas-marketing.zip` e **precisa ser importada no
  OpenBot**.

### 1.4 Segurança das campanhas (§3.2 da passagem anterior)
- O Codex diz que tratou os 3 achados de campanha ([src/ads/campaign.ts](../src/ads/campaign.ts),
  [meta-writer.ts](../src/ads/meta-writer.ts)): confere PAUSADO e o orçamento real em cada etapa. 35 testes passam.
  **Falta o Claude revisar** antes do M04. O `/mcp` sem token continua aberto.
- O Claude devolveu à tela Marketing a regra "nunca escreva aprovo/pode/confirmo", que o Codex tinha apagado.

### 1.5 Estado
- **Testes:** 870 passando; `pnpm typecheck` limpo. Commit local de 24/11, **sem push**.
- Limite do Claude renovado em 24/11 às 08:00.

---

## 2. O que falta no Radar
1. Barrar assinatura, plataforma e marca grande (Finclass, Audible, banco) mesmo quando citam "PDF" ou "mapa mental".
2. O preço quase sempre fica "não visível" quando não está no anúncio. Ler na página de destino ajuda (o Codex começou),
   mas página de terceiro é **dado, não instrução**.
3. "Anunciantes no nicho" conta páginas da busca, não do nicho do produto.
4. Rodar pelo painel e conferir que a oferta montada fala do produto (o gerador lê `anuncioTexto`).

---

## 3. Próximo: testar o fluxo inteiro NIGHT + OpenBot
Antes de cada passo que gasta (sessão do Claude, tarefa a agente do OpenBot, DeepSeek), diga ao Joel quanto gasta.
1. **Preparar:** OpenBot **aberto** (ele escreve `url`/`token` em `%APPDATA%\OpenBot\automation`), importar o zip da
   tela Marketing, servidor no ar (`pnpm night:servidor`, porta 4517).
2. **Radar pelo painel:** "use o radar para pesquisar ofertas low ticket" → status → "mostra a oferta N". Tem que sair
   produto digital barato com anúncios ativos e dias no ar.
3. **OpenBot:** o agente NIGHT Radar lê a oferta pela ponte (`night_pedir`). Depois Produto → Design → Marketing, **só
   com o Joel pedindo** (ele não quer teste à toa no Marketing/Design).
4. **Campanha (M04):** só depois de revisar §1.4, e só com aprovação do Joel no painel. Campanha sempre PAUSADA; nada
   de dinheiro real nem publicação sem pedido.
5. Anotar no fim o que quebrou, com o passo, a mensagem e o arquivo.

---

## 4. Como trabalhar aqui
- **Pedido como o Joel faz:** `POST /api/pedir` com `Origin: http://127.0.0.1:4517` e o `TOKEN` da página `/painel`; o
  corpo vai num arquivo UTF-8, com `curl --data-binary @arquivo`.
- **Cancelar:** `POST /api/decidir` com `{"tipo":"cancelar-trabalho","kind":"radar","numero":N}`.
- **Banco:** `postgres://night@localhost:5433/night` (`jobs`, `radar_candidates`, `radar_offers`).
- **Reiniciar o servidor:** matar o `node.exe` com `server-main` e
  `Start-Process powershell -WorkingDirectory D:\NIGHT -ArgumentList '-NoExit','-Command','pnpm night:servidor'`.
- **Git:** o repositório é PÚBLICO. Antes de push: `git diff origin/main..HEAD | grep -iE "act_[0-9]|@gmail"` (só
  `act_1` dos testes é aceito). Fora do git: o PDF do Franklim, `lab/beatriz/`, `src/viral-video-studio/`.
- **Regras do Joel:** nada de dinheiro real, publicação ou push sem pedido; nunca credencial no código, prompt ou log;
  português simples; o Claude lidera e o Codex revisa; ler e atualizar `.agents/em-andamento.md`.

## 5. Variáveis novas
| Variável | Para quê |
|---|---|
| `NIGHT_RADAR_CHROME_CHANNEL` | Navegador do Radar (padrão `chrome`) |
| `NIGHT_RADAR_HEADLESS` | `0` mostra a janela (para resolver CAPTCHA) |
| `NIGHT_RADAR_ROLAGENS` | Rolagens por página da Biblioteca (mais rolagem, mais anúncios) |

As das passagens anteriores continuam valendo.
