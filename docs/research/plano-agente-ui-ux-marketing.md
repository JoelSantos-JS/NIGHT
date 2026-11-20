# AGENTE UI/UX — LANDING PAGES, ANÚNCIOS E MARKETING

Trecho da pesquisa original, extraído da V1 consolidada Unite + OpenClaw (19/11/2026).

## ANEXO — A. Pesquisa de UI/UX, agentes de marketing, anúncios e criativos

**Documento original:** `PESQUISA_AGENTES_DESIGN_MARKETING_OPENCLAW_2026-11-19.md`

# Pesquisa de agentes e skills: UI/UX, landing pages, anúncios e vídeos
**Data:** 19/11/2026 | **Objetivo:** construir um agente próprio, aproveitando skills e projetos open source compatíveis com OpenClaw, Codex, Claude Code e orquestradores personalizados.

> **Escopo e interpretação:** a expressão oral "Open Bot" foi interpretada como possível referência ao **OpenClaw** e seu ecossistema de skills. Nenhum dos projetos abaixo precisa necessariamente do runtime OpenClaw: boa parte funciona como skills em Markdown, comandos CLI, bibliotecas ou servidores MCP. Os repositórios foram pesquisados, mas o código não foi executado nem auditado neste levantamento. Estrelas são snapshots aproximados e não substituem revisão técnica.

## 1. Resumo executivo

**Stack sugerida para o agente de design e landing page:**
- **ui-ux-pro-max-skill** para orientação de design, tokens, layouts e padrões de UI.
- **frontend-design (Anthropic)** para direção visual e construção de interfaces com qualidade.
- **abi/screenshot-to-code** para prototipar a partir de screenshots/referências. Não usar o resultado como cópia final: refazer identidade, conteúdo e componentes.
- **vercel-labs/agent-browser** ou **microsoft/playwright-mcp** para analisar páginas autorizadas, capturar screenshots e verificar resultados no navegador.
- **coreyhaines31/marketingskills**, sobretudo `copywriting`, `page-cro`, `ad-creative`, `paid-ads`, `competitor-profiling`, `reverse-engineer-marketing` e `ab-testing`, para uma oferta e texto de venda próprios.
- **21st-dev/magic-mcp (21st MCP)** para acelerar componentes React/Tailwind; requer serviço/credenciais 21st.dev, e o repositório é um proxy para o serviço remoto.

**Stack sugerida para produção de anúncios e distribuição:**
- **remotion-dev/remotion**: renderização determinística e editável de vídeos a partir de React/TypeScript.
- **remotion/packages/template-prompt-to-video**: exemplo de roteiro + imagens + narração + renderização; exige configurar provedores de IA.
- **Loopsera/agentic-ad-studio** ou **HamzaSbay/AdForge**: referências para um pipeline de anúncios com brand kit, assets e aprovação.
- **gitroomhq/postiz-app + gitroomhq/postiz-agent**: agendamento e publicação multicanal via CLI/MCP; self-hosting exige criar credenciais e, por vezes, obter aprovação dos provedores.
- **JRJthegreat/facebook-ads-spy-agent**: exemplo específico de pesquisa de anúncios na Biblioteca de Anúncios, com n8n + Apify + modelos para análise de criativos. É dependente de serviço externo e não foi validado em execução.
- **get-mcp-ads/meta-ads-mcp-server** ou **silvanasolvers/meta-ads-skill**: estudo de criação/gestão de campanhas Meta, sujeito a autenticação e acesso à Marketing API.

**Decisão arquitetural:** construir agentes especializados pequenos e conectá-los com um orquestrador próprio em vez de instalar indiscriminadamente dezenas de skills de terceiros. Cada função deve ter entradas, saídas, permissões e testes claros.

## 2. Projetos de design/UI com maior relevância

| Projeto | Popularidade aproximada em 19/11/2026* | Contribuição | Condição |
|---|---:|---|---|
| [nextlevelbuilder/ui-ux-pro-max-skill](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill) | ~151 mil estrelas | Orientação de UI/UX, design systems, layout e implementação multiplataforma; compatível com OpenClaw/Codex/Claude | Melhor skill central de design |
| [anthropics/skills — frontend-design](https://github.com/anthropics/skills/blob/main/skills/frontend-design/SKILL.md) | ~197 mil estrelas no repositório de skills (não na skill individual) | Direção de arte, paleta/tipografia e frontend | Complementa a anterior |
| [abi/screenshot-to-code](https://github.com/abi/screenshot-to-code) | ~81 mil estrelas | Transforma imagem da interface em protótipo HTML/Tailwind/React/Vue | Usar como acelerador, depois refatorar |
| [vercel-labs/agent-browser](https://github.com/vercel-labs/agent-browser) | ~52 mil estrelas | Navegador controlado por agente: inspecionar referências, testar páginas | Necessita sandbox/autorização contextual |
| [coreyhaines31/marketingskills](https://github.com/coreyhaines31/marketingskills) | ~61 mil estrelas | Copywriting, conversão, anúncios, planejamento e análise de concorrentes | Complementa design com marketing |
| [21st-dev/magic-mcp](https://github.com/21st-dev/magic-mcp) | ~6,6 mil estrelas | Catálogo/geração de componentes e inspiração UI via 21st MCP | Serviço externo com chave/API |
| [microsoft/playwright-mcp](https://github.com/microsoft/playwright-mcp) | sem número validado neste levantamento | Controle de navegador por MCP, snapshots de acessibilidade | Alternativa ao agent-browser |
| [figma/mcp-server-guide](https://github.com/figma/mcp-server-guide) | sem número validado | Passar design context do Figma para agentes | Útil se houver arquivo Figma |
| [vercel-labs/agent-skills — web-design-guidelines](https://github.com/vercel-labs/agent-skills/tree/main/skills/web-design-guidelines) | sem número validado por skill | Checklist para avaliar UI/accessibilidade | Integrar no QA |

\* Estrelas aproximadas obtidas de resultados públicos do GitHub; contagem muda continuamente. Não representa benchmark de qualidade.

### Design: como combinar de verdade

1. **Pesquisa de referência:** usuário envia link público de landing page, um print, ou link de anúncio na Meta Ad Library. `agent-browser` / Playwright recupera o que estiver visível e permitido, com screenshot e anotações.
2. **Decomposição:** identificar estrutura (hero, CTA, prova social, FAQ, pricing), hierarquia, cores, espaçamento e estratégia de oferta.
3. **Brief original:** separar o que é padrão comum de UX do que são elementos exclusivos da marca de terceiros; recriar o projeto com marca, texto, imagem, dados e layout próprios.
4. **Projeto de conversão:** usar `marketingskills` para público-alvo, proposta de valor, copy honesta, chamadas e experimentos A/B.
5. **Projeto visual:** usar `ui-ux-pro-max` + `frontend-design` para tokens e layout e, se necessário, `screenshot-to-code` apenas como ponto de partida.
6. **Código:** Codex/Claude Code gera Next.js/React/TypeScript/Tailwind/shadcn com componentes e tokens reaproveitáveis.
7. **QA:** capturas desktop/mobile, testes de acessibilidade, links e formulários, performance, copy e originalidade visual; relatório com erros; nova iteração.
8. **Saída:** repositório versionado + preview navegável + capturas + changelog + documentação para deploy.

**Exemplo de entrada:** "Analise esta landing page de referência e crie uma nova para meu produto, com identidade visual própria, copy diferente, CTA para checkout, FAQ e responsividade; não reutilize imagens, logotipos nem depoimentos do concorrente".

## 3. Pesquisa de ofertas e Biblioteca de Anúncios da Meta

**Caminho oficial:** [Biblioteca de Anúncios](https://www.facebook.com/ads/library/) (pesquisa pública) e [API da Biblioteca de Anúncios](https://pt-br.facebook.com/ads/library/api). A API **não é um exportador universal de anúncios comerciais**: a documentação explicita que anúncios não veiculados na UE só retornam se forem de temas sociais, eleições ou política. Não presumir acesso completo aos anúncios comerciais brasileiros pelo endpoint oficial.

**Alternativa técnica, a ser avaliada:** [JRJthegreat/facebook-ads-spy-agent](https://github.com/JRJthegreat/facebook-ads-spy-agent). Exemplo de fluxo n8n que envia URL de busca da Biblioteca ao **Apify**, analisa imagens/vídeos com modelos e salva em planilha título, anúncio, descrição e prompts. Depende de pagamentos/credenciais dos serviços e das condições de acesso da fonte; não assumir que coleta ilimitada ou scraping de toda mídia é permitido.

**Fluxo para 'modelar' produto:**
- Encontrar referências de campanhas ativas e páginas de destino visíveis ao público.
- Salvar URL, anunciante, data observada, público hipotético e links das fontes.
- Decompor ângulo, promessa, CTA, prova, visual, oferta e objeções.
- Verificar se o produto e alegações podem ser oferecidos de forma legítima; evitar falsos depoimentos, métricas inventadas, marcas e materiais protegidos de terceiros.
- Criar uma abordagem criativa **original** — outra marca, assets autorizados, nova direção de arte e texto próprio.
- Criar variantes de anúncio e landing page para teste A/B, com revisão humana antes de publicar.

## 4. Agentes de vídeo e criação de anúncios

| Projeto | Papel | Observações |
|---|---|---|
| [remotion-dev/remotion](https://github.com/remotion-dev/remotion) | Motor de vídeos em React/TS (~71,9 mil estrelas) | Boa base estável e editável; não é por si só um gerador mágico de vídeo |
| [Template prompt-to-video Remotion](https://github.com/remotion-dev/remotion/tree/main/packages/template-prompt-to-video) | Pipeline exemplo de roteiro, imagem, voz, timeline | Exige serviços de IA, adaptar modelos e custos |
| [Loopsera/agentic-ad-studio](https://github.com/Loopsera/agentic-ad-studio) | Agente de anúncio motion-graphics com brand kit + Remotion | Exemplo de arquitetura com checkpoints |
| [HamzaSbay/AdForge](https://github.com/HamzaSbay/AdForge) | Pipeline local-first de anúncios, legendas, áudio e CTA | Boa referência para templates multi-formato |
| [ZetaZeroHub/agentic-video-foundry](https://github.com/ZetaZeroHub/agentic-video-foundry) | Workflow de roteiro→storyboard→voz→legendas→render→revisão | Referência de orquestração e QC |
| [Anil-matcha/Open-AI-UGC](https://github.com/Anil-matcha/Open-AI-UGC) | Estúdio open source de UGC com avatares/modelos generativos | Modelos de vídeo e APIs podem ser pagos; projeto menor |
| [indygill/ugc-forge](https://github.com/indygill/ugc-forge) | Skill e utilitário Python para criação de ativos UGC | Não equivale a suíte de edição |
| [cspenn/supoclip](https://github.com/cspenn/supoclip) | Converter vídeo longo em Shorts/Reels com legendas | Usar apenas material próprio/licenciado |
| [SupercmoHQ/superCMO-skills](https://github.com/SupercmoHQ/superCMO-skills) | Skills para campanhas, UGC e vídeo ads | Inspecionar dependências/qualidade antes de instalar |

**Pipeline indicado para um 'AdCreator Agent':** briefing → proposta/roteiro → seleção de template Remotion → geração/importação de ativos originais/licenciados → legendas e voiceover → render 9:16/1:1/16:9 → QA (ortografia, enquadramento, duração, políticas de ads) → aprovação humana → agendamento.

**Custos:** Remotion e FFmpeg podem renderizar localmente, mas geração de vídeo realista por modelos externos geralmente demanda créditos; CPU e disco tornam renderização de vários vídeos uma carga importante para uma VPS básica.

## 5. Publicação social, campanhas Meta e contas

| Canal/função | Caminho viável | Condição concreta |
|---|---|---|
| TikTok | [Content Posting API — Direct Post](https://developers.tiktok.com/docs/en/content-posting-api-get-started) | OAuth e configuração; cliente não auditado publica apenas privado; auditoria para posts públicos |
| YouTube | [YouTube Data API videos.insert](https://developers.google.com/youtube/data/reference/rest/v3/videos/insert) | OAuth 2.0 e `youtube.upload`; cotas e eventuais avaliações/auditorias do projeto precisam ser verificadas. Documentos do Google encontrados divergem sobre a restrição de privacidade para clientes não verificados; confirmar no projeto real. |
| Instagram | [API Instagram da Meta](https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api) | Conta profissional (Business/Creator) e permissões/fluxo de login aplicáveis; suporte para publicação de Reels |
| Facebook Pages | [Graph API Page Feed](https://developers.facebook.com/docs/graph-api/reference/page/feed/) | Page token, permissões de publicação e acesso à Página |
| Anúncios Meta | [Marketing API](https://developers.facebook.com/documentation/ads-commerce/marketing-api) | Acesso de desenvolvedor, conta de anúncios autorizada e permissões. Mudanças de gasto exigem aprovação humana. |
| Business Portfolio | [Business setup — Meta](https://developers.facebook.com/docs/business-management-apis/2tier-bm-solution/prerequisites/business-setup) | Meta documenta criação inicial do portfólio como **manual** na interface Business Suite; sua API auxilia gestão posterior de ativos e pode permitir criar contas de anúncios em cenários aprovados. Não equivale a criar contas pessoais falsas/em massa. |
| Orquestrador social | [Postiz App](https://github.com/gitroomhq/postiz-app) + [Postiz Agent](https://github.com/gitroomhq/postiz-agent) | Interface, agendamento, API e MCP; versão self-hosted requer credenciais próprias das plataformas, PostgreSQL/Redis e segue AGPL-3.0 |
| Operação de campanhas | [get-mcp-ads/meta-ads-mcp-server](https://github.com/get-mcp-ads/meta-ads-mcp-server) ou [brijr/meta-mcp](https://github.com/brijr/meta-mcp) | MCP para métricas, campanhas e alterações com aprovação |
| Automação geral | [n8n-io/n8n](https://github.com/n8n-io/n8n) | Conecta webhooks, filas e provedores. Conferir licença e limites de hospedagem. |

**Importante:** Postiz hospedado utiliza apps OAuth já aprovados; Postiz self-hosted exige construir/aprovar os próprios apps nas plataformas. A simplicidade aparente da integração não elimina essas dependências. Para começarmos sem contas, usar mocks (simuladores) dos publicadores.

## 6. Arquitetura proposta para um agente próprio

```
Usuario (texto/voz)
  -> Orquestrador (fila de jobs, permissões e auditoria)
    -> ResearchAgent (URLs, Meta Ad Library visível, concorrentes)
    -> ProductStrategistAgent (público, promessa, diferenciação, oferta)
    -> CopyAgent (marketingskills: copywriting, cro, paid-ads)
    -> DesignAgent (ui-ux-pro-max + frontend-design + 21st MCP opcional)
    -> FrontendAgent (Codex/Claude Code + Next.js + Tailwind)
    -> BrowserQAAgent (Playwright + capturas + Lighthouse/a11y)
    -> VideoAgent (Remotion + FFmpeg + templates de anúncios)
    -> PublishingAgent (Postiz/MCP, TikTok, YouTube, Meta)
    -> AdsOpsAgent (Marketing API, métricas, campanhas, HITL)
  -> Artefatos aprovados: repositório, preview, vídeos, publicações agendadas
```

Cada agente recebe um JSON versionado com: `project_id`, `brief`, `source_urls`, `brand`, `target_audience`, `task`, `allowed_tools`, `budget_limit`, `approval_required` e `output_paths`. Para cada tarefa, registrar logs, custo, fontes utilizadas, checkpoints e status `draft|needs_review|approved|published|failed`.

**Segurança básica:** contas de produção separadas da pesquisa, secrets fora do repositório, isolamento do navegador e dos contêineres, validação de URLs, proteção contra prompt injection em páginas visitadas, escopo mínimo de OAuth, revisão dos SKILL.md e dependências antes de executar, nunca permitir que textos em sites alterem instruções do agente. Nunca deixar o robô criar campanhas pagas ou publicar sem aprovação no primeiro MVP.

**Para agente local:** skills são arquivos de instrução; é possível adaptá-los para orquestrador próprio sem instalar OpenClaw por completo, desde que se implemente leitura das skills, execução restrita de ferramentas e fluxo de aprovação. OpenClaw documenta discovery de skills por `SKILL.md`: https://github.com/openclaw/openclaw/blob/main/docs/tools/skills.md . O modelo e o sistema de execução podem ser diferentes para cada subtarefa.

## 7. MVP e ordem sugerida

**Sprint 1 — agente de landing page**
- Input: URL/screenshot + descrição de produto + marca.
- Extrair estrutura visível de referência e apresentar brief de diferenciação.
- Gerar página React/Next.js totalmente original e responsiva.
- Capturas desktop/mobile, teste de formulário/CTA, avaliação UX.
- Aprovação humana e export do repositório.
- **Aceitação:** código compila; preview abre; não contém recursos de terceiros indevidos; CTAs funcionam; boa avaliação em mobile.

**Sprint 2 — pesquisa competitiva/anúncios**
- Entrada manual de URL de anúncio ou pesquisa assistida na Biblioteca de Anúncios.
- Salvar referência, fonte, observações e hipótese de valor.
- Gerar 3 ângulos de copy original, 2 layouts e uma matriz de teste A/B.
- Implementar rota opcional Apify/Meta API com custos e limites visíveis.
- **Aceitação:** toda afirmação externa possui fonte; não copia campanhas nem inventa depoimentos.

**Sprint 3 — agente de anúncios e publicação**
- Criar vídeos editáveis no Remotion a partir do brand kit do mesmo projeto.
- Renderizar 9:16 e 1:1, validar arquivo, narração e legendas.
- Enviar a Postiz como rascunho (sem publicar automaticamente inicialmente).
- Conectar APIs oficiais uma a uma após autenticação/aprovação.
- **Aceitação:** um vídeo de demonstração renderiza; agendamento simulado; uma publicação real somente após aprovação.

**Sprint 4 — gestão de campanhas**
- Integração opcional com Meta Marketing API para leitura de métricas.
- Recomendar criativos, públicos e orçamento, sem gastar sozinho.
- Adicionar relatórios de CTR, CPC, conversão e auditoria.

## 8. Repositórios para começar: prioridade de integração

- **P0:** [ui-ux-pro-max](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill), [frontend-design](https://github.com/anthropics/skills/blob/main/skills/frontend-design/SKILL.md), [marketingskills](https://github.com/coreyhaines31/marketingskills), [agent-browser](https://github.com/vercel-labs/agent-browser), [screenshot-to-code](https://github.com/abi/screenshot-to-code).
- **P1:** [21st MCP](https://github.com/21st-dev/magic-mcp), [Playwright MCP](https://github.com/microsoft/playwright-mcp), [Remotion](https://github.com/remotion-dev/remotion), [Postiz](https://github.com/gitroomhq/postiz-app) e [Postiz Agent](https://github.com/gitroomhq/postiz-agent).
- **P2/experimental:** [facebook-ads-spy-agent](https://github.com/JRJthegreat/facebook-ads-spy-agent), [agentic-ad-studio](https://github.com/Loopsera/agentic-ad-studio), [AdForge](https://github.com/HamzaSbay/AdForge), [meta-ads-mcp-server](https://github.com/get-mcp-ads/meta-ads-mcp-server), [Open-AI-UGC](https://github.com/Anil-matcha/Open-AI-UGC).

## 9. Critérios para escolher qualquer repositório antes de copiar/adaptar

1. Licença compatível com uso comercial, distribuição e/ou modificação. **Postiz usa AGPL-3.0**, com obrigações relevantes para serviço de rede; não incorporá-lo cegamente ao código de produto proprietário.
2. README, commits recentes, issues abertas, exemplos de instalação e testes reproduzíveis.
3. Dependências externas e custos (serviços pagos, tokens de API, modelo de vídeo, hospedagem).
4. Riscos de segurança: `SKILL.md` malicioso, shells que executam comandos, scraping sem autorização, vazamento de cookies/tokens.
5. APIs oficiais, requisitos de auditoria e limites: verificar antes de prometer automação completa.
6. MVP com mocks primeiro; integrações reais só com credenciais próprias.

## 10. Especificação curta para Codex/Claude Code

> Crie um agente modular de design e marketing com orquestrador local. Primeiro entregue apenas o `LandingPageAgent`: entrada `url_or_screenshot`, `product_brief` e `brand`; extração de layout de referência por Playwright em ambiente isolado; geração de briefing original com as ideias de `ui-ux-pro-max` e `frontend-design`; geração de Next.js + Tailwind em workspace isolado; testes automatizados de build, mobile, formulários e snapshots; saída em repo Git com preview e relatório. Não copie logos, textos, imagens ou depoimentos de terceiros. Não realize publicações pagas nem ações externas sem aprovação explícita. Prepare interfaces futuras para `AdsResearchAgent`, `VideoAgent` e `PublishingAgent`, inicialmente todas em mock, além de logs, retries e testes unitários.

---

### Fontes primárias e leituras

- https://github.com/nextlevelbuilder/ui-ux-pro-max-skill
- https://github.com/anthropics/skills/blob/main/skills/frontend-design/SKILL.md
- https://github.com/abi/screenshot-to-code
- https://github.com/vercel-labs/agent-browser
- https://github.com/microsoft/playwright-mcp
- https://github.com/coreyhaines31/marketingskills
- https://github.com/21st-dev/magic-mcp
- https://github.com/remotion-dev/remotion
- https://github.com/gitroomhq/postiz-app
- https://github.com/gitroomhq/postiz-agent
- https://github.com/JRJthegreat/facebook-ads-spy-agent
- https://developers.tiktok.com/docs/en/content-posting-api-get-started
- https://developers.google.com/youtube/data/reference/rest/v3/videos/insert
- https://developers.facebook.com/docs/graph-api/reference/page/feed/
- https://developers.facebook.com/docs/business-management-apis/2tier-bm-solution/prerequisites/business-setup
- https://pt-br.facebook.com/ads/library/api
- https://github.com/openclaw/openclaw/blob/main/docs/tools/skills.md



---
