# Plano separado: MCP oficial de anúncios da Meta no NIGHT

**Estado:** pesquisa feita em 17/11/2026, antes de qualquer conexão. Nenhuma conta foi ligada e nenhum anúncio foi criado. As tarefas M01–M08 ficam no [plano mestre](../PLANO_MESTRE_NIGHT.md).

## O que existe

Desde 29/04/2026 a Meta mantém um servidor MCP oficial de anúncios em `https://mcp.facebook.com/ads`, ainda em beta aberto e gratuito. O login é por OAuth da conta Meta Business, sem chave de API. [Visão geral da Meta](https://developers.facebook.com/documentation/ads-commerce/ads-ai-connectors/ads-mcp-server/ads-mcp-server-overview), [guia de configuração](https://adadvisor.ai/blog/mcp-facebook-com-ads-official-meta-setup).

- **29 ferramentas:**
  - criar campanha, conjunto e anúncio (`ads_create_campaign`, `ads_create_ad_set`, `ads_create_ad`)
  - editar (`ads_update_entity`, inclusive orçamento) e ativar ou pausar (`ads_activate_entity`)
  - catálogo, contas e páginas
  - pixel e Conversions API
  - relatórios e benchmarks
  - [lista completa](https://pasqualepillitteri.it/en/news/1707/official-meta-ads-mcp-claude-29-tools-2026)
- **Tudo nasce pausado:** campanhas, conjuntos e anúncios só vão ao ar quando alguém ativa. Mas a ativação também existe como ferramenta. [Fonte](https://adsuploader.com/blog/meta-ads-mcp), [fonte](https://ferrerponseti.com/en/blog/official-meta-ads-mcp-claude/).
- **Travas no lado da Meta:** em *Configurações do negócio → Integrações → Ads MCP Server* há sete chaves:
  - editar ou definir orçamento
  - criar campanhas
  - criar conjuntos
  - criar anúncios
  - editar público
  - editar criativo
  - editar status

  Elas vêm **todas ligadas** e há teto de orçamento por porcentagem. [Fonte](https://ferrerponseti.com/en/blog/official-meta-ads-mcp-claude/).
- **Biblioteca de Anúncios:** os guias dizem que o conector consulta a Biblioteca, ou seja, os anúncios dos concorrentes. Isso pode resolver o caminho crítico do Radar (R01), **mas precisa ser provado com a sua conta**: país Brasil, anúncios comerciais comuns e quais campos aparecem. [Fonte](https://ferrerponseti.com/en/blog/official-meta-ads-mcp-claude/).
- **Criativos:** o MCP não envia arquivo do computador. Imagem ou vídeo precisa já estar numa URL ou na biblioteca de mídia da Meta. O caminho documentado é imagem única com link; vídeo é o caso mais difícil. [Fonte](https://adsuploader.com/blog/meta-ads-mcp).
- **Riscos:** a Meta não publica limites de chamada para o MCP. Há relatos de restrição de conta com edições em rajada, erro repetido em laço e criativo lançado sem revisão. [Fonte](https://adsuploader.com/blog/meta-ads-mcp).
- **Claude Code também usa:** `claude mcp add --transport http meta-ads https://mcp.facebook.com/ads`, depois login uma vez por `/mcp`. [Fonte](https://adsuploader.com/blog/meta-ads-mcp).

## Como entra no NIGHT

**Duas conexões separadas, nunca uma só com tudo liberado.**

| Uso | Ferramentas liberadas | Chaves na Meta |
| --- | --- | --- |
| **Radar (leitura)** | Biblioteca de Anúncios, relatórios e benchmarks | Todas as 7 desligadas |
| **Montagem de campanha** | criar campanha, conjunto e anúncio, sempre pausados | Orçamento e status **desligados**; o resto ligado só durante a montagem |

A ativação e o orçamento ficam **fora do alcance do agente**: a chave "editar status" fica desligada na Meta. Quem liga a campanha é você, no Gerenciador de Anúncios. É a trava mais forte que temos, porque vale mesmo que o NIGHT ou o modelo errem.

1. **Radar:** um `AdSource` novo (`MetaMcpAdSource`) roda uma sessão do Claude Code só com o MCP da Meta (`--mcp-config` próprio, `--strict-mcp-config` e `--allowedTools` apenas com as ferramentas de leitura). Ele devolve JSON no formato `RawAd`. Campo que a Meta não mostra fica ausente; nada é inventado. Isso destrava o R01 sem precisar da API da Biblioteca separada.
2. **Campanha:** com uma oferta aprovada (R06) e, se quiser, um vídeo aprovado (V08), o NIGHT monta um rascunho de campanha. Nele vão objetivo, público, orçamento proposto como **texto para você decidir**, criativo por URL e texto do anúncio. O NIGHT mostra o rascunho e só depois de um "aprovo montar a campanha da oferta 2" cria tudo **pausado** na Meta. Ele grava os IDs e confere lendo de volta pelo MCP.
3. **Gasto:** ligar a campanha e definir o orçamento continuam sendo ações suas no Gerenciador. Se um dia você quiser que o NIGHT ligue, o pedido precisa de uma aprovação `spend` específica, com valor e campanha (o tipo já existe no banco). A chave na Meta só é ligada com o teto de orçamento configurado. Por ora fica **desligado**.
4. **Ritmo:** no máximo uma alteração por vez, sem repetição automática em erro. Cada chamada que muda algo é um efeito externo com chave única (`recordJobEffect`), para nunca criar a mesma campanha duas vezes.

## O que só você pode fazer

- Ter (ou criar) o portfólio empresarial, a conta de anúncios e a página.
- Ligar o conector uma vez: no claude.ai em *Conectores → adicionar personalizado* ou no Claude Code com o comando acima e `/mcp`. Fazer o login da Meta e escolher a conta.
- Ajustar as 7 chaves na Meta conforme a tabela.
- Dizer se a primeira prova é só leitura (Radar) ou também montagem pausada.

## Quem implementa

A leitura do Radar segue o fluxo normal: o DeepSeek implementa com MCP falso nos testes e o Claude faz o QA. A parte que cria campanha **mexe com conta de anúncios e dinheiro real**. Pela regra do projeto, o DeepSeek e o Codex não recebem credencial nem comando com dinheiro. Por isso o Claude implementa e testa com MCP falso, e a primeira criação real (pausada) é feita junto com você.
