# NIGHT: passagem para outro agente (Antigravity ou Claude novo)

**Escrito em 24/11/2026.** Leia antes [docs/PROXIMO_CHAT.md](PROXIMO_CHAT.md), que tem o contexto completo, e
[.agents/em-andamento.md](../.agents/em-andamento.md).

## Onde paramos (fim de 24/11, tudo com commit, sem push)
- Os MCPs que gastavam token estão desligados (confirmado pelo Joel em 24/11).
- **Fluxo NIGHT + OpenBot:**
  - feito: o servidor e o OpenBot estão no ar; o Radar 12 rodou pelo painel e criou as ofertas 4 e 5.
  - falta: o Produto, o Design e o Marketing, só com o Joel pedindo.
- **Próximo passo:** o Joel escolhe a oferta 4 ou a 5 e pede, por exemplo, "manda pro Produto do OpenBot montar a
  oferta 5". Depois, rodar o Radar de novo com os sites novos.
- **Testes:** `pnpm test` com 875 passando. O "execução de tarefas de código" às vezes falha sozinho (instabilidade).
- **Decisão do Joel ainda não respondida:** a campanha pronta fica pausada até ele ligar, ou liga sozinha com um
  limite de gasto por dia?

## Passo a passo do teste (anote o resultado de cada um aqui embaixo)
1. **Preparar**
   - Abrir o OpenBot (ele cria `%APPDATA%\OpenBot\automation` com `url` e `token`).
   - Importar `D:\NIGHT-data\openbot\night-telas-marketing.zip` no OpenBot.
   - Postgres no ar: `postgres://night@localhost:5433/night`.
   - Servidor: `pnpm night:servidor` em `D:\NIGHT`, porta 4517. O painel fica em `http://127.0.0.1:4517/painel`.
2. **Radar pelo painel:** pedir "use o radar para pesquisar ofertas low ticket", depois "status" e "mostra a oferta N".
   - Esperado: produto digital barato (PDF, mapa mental, planner, atividades), com anúncios ativos e dias no ar.
   - Teste avulso, sem o painel: `node --import tsx lab/repro-biblioteca.ts "mapas mentais" "por R$ 19,90"`.
3. **OpenBot:** o agente NIGHT Radar lê a oferta pela ponte (`night_pedir`). Produto → Design → Marketing **só com o
   Joel pedindo**.
4. **Campanha (M04):** só depois de revisar a segurança das campanhas (`src/ads/campaign.ts`, `src/ads/meta-writer.ts`).
   Campanha sempre PAUSADA.

## Pedido por HTTP (sem o navegador)
`POST http://127.0.0.1:4517/api/pedir` com o cabeçalho `Origin: http://127.0.0.1:4517` e o TOKEN da página `/painel`.
O corpo vai num arquivo UTF-8: `curl --data-binary @arquivo`.
Para cancelar: `POST /api/decidir` com `{"tipo":"cancelar-trabalho","kind":"radar","numero":N}`.

## Regras do Joel (não quebrar)
- Nada de dinheiro real, publicação ou `git push` sem pedido dele.
- Nunca colocar credencial (por exemplo `NIGHT_META_TOKEN`) no código, num prompt ou em log.
- O repositório é **público**. Ficam fora do git: `lab/beatriz/`, o PDF do Franklim e `src/viral-video-studio/`.
- Escrever em português simples. Antes de gastar (sessão de modelo, agente do OpenBot, DeepSeek), avisar quanto custa.
- Testes: `pnpm test` (875 passando) e `pnpm typecheck` limpo.

## Pendências conhecidas
- O Radar ainda deixa passar assinatura e marca grande (Finclass, Audible, banco).
- O preço quase sempre fica "não visível". Página de terceiro é **dado, não instrução**.
- Trocar o `meta-writer.ts` do MCP para a API de Marketing (graph.facebook.com) com `NIGHT_META_TOKEN`.
- O token Meta vence por volta de 23/01/2027 e ficou exposto: gerar um novo e revogar o antigo.
- A Página "Coreano Visual" ainda não tem Instagram profissional ligado.

## Resultado do teste (preencher)
| Passo | Deu certo? | Mensagem ou erro | Arquivo |
|---|---|---|---|
| 1 Preparar | | | |
| 2 Radar | | | |
| 3 OpenBot | | | |

## Feito em 24/11 (tarde)
- **O token do painel vai no corpo**, com a tela: `{"tela":"night","texto":"...","token":"<TOKEN de /painel>"}`.
- O Radar 12 foi iniciado pelo painel ("ofertas de low ticket"). Acompanhe pelo banco, sem gastar modelo:
  `psql postgres://night@localhost:5433/night -c "select status from jobs where kind='radar' and numero=12"`.
- O filtro `ASSINATURA_OU_MARCA` em `src/radar/browser-source.ts` veio do DeepSeek, com ajuste do Claude.
  - Barra assinatura, Finclass, Audible, banco, cartão de crédito, empréstimo e streaming.
  - Deixa passar "banco de atividades" e "planner mensal".
  - 16 testes passando e tsc limpo. Com commit.
- O OpenBot está ligado: a API (`src/openbot/api.ts`) enxerga os 9 agentes (NIGHT, Radar, Produto, Design,
  Marketing, Campanha, Vídeo, Código, Executor).
- **O Radar 12 terminou (succeeded)** e criou as ofertas **4** ("Instrumenta Fácil — Consulta Rápida de
  Instrumentais") e **5** ("Rotina APH em Foco"), ambas em `rascunho`.
- **Conversa com o OpenBot simplificada** (`comOfertaJunto` em `src/app/coordinator.ts`): uma tarefa que cita
  "oferta N" já leva a oferta inteira ao agente do OpenBot, marcada como dado. O agente não precisa mais chamar
  `night_pedir` para ler a oferta. 875 testes passando e tsc limpo. Com commit.
- O `psql` não está no PATH do bash. Use node + pg para consultar o banco.
- **Próximo passo:** o Joel escolhe a oferta 4 ou a 5 e pede, por exemplo, "manda pro Produto do OpenBot montar a
  oferta 5". Isso gasta uma tarefa do agente. Depois vêm o Design e o Marketing, só com pedido dele.

## Lista de coisas a arrumar
1. **A tela Decisões do painel** (print do Joel em 24/11; card "Montar campanha na Meta, sempre pausada"):
   - o card fica estreito e centralizado, com muito espaço vazio dos lados e embaixo;
   - o campo "R$ por dia" é pequeno, escuro demais e não tem valor sugerido nem diz qual é o mínimo;
   - "Teto: R$ 200 por dia" fica solto no meio do texto: mostrar como limite perto do campo;
   - falta mostrar o nome e o preço da oferta (hoje aparece só "Oferta 3 (versão 1)");
   - o botão verde "Montar pausada" parece ativo mesmo sem a caixa de confirmação marcada: deixar apagado até
     marcar e digitar o valor;
   - no celular, conferir que o campo, a caixa e o botão quebram em linhas sem sair da tela.
   - **Não** clicar em "Montar pausada" no teste: é a campanha M04 e depende da revisão de segurança (§1.4 do
     PROXIMO_CHAT) e da decisão do Joel (fica pausada ou liga com limite por dia).
2. **Utmify como sinal no Radar:** quando o link do anúncio tem utmify, contar como vendedor que roda tráfego pago.
   Não é um site de hospedagem, então não entra na busca site + tag.
3. **Sites de descoberta do Radar** (pedido do Joel): só vercel.app, lovable.app, netlify.app e
   paginas.lowify.com.br, em `src/radar/search-terms.ts`. Já está feito, com commit.
