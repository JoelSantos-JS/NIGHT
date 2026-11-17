# Avaliação: Executor e OpenBot no NIGHT

Data: 17/11/2026. Estado: pesquisa e proposta; nenhum serviço instalado, nenhuma conta conectada e nenhum código do NIGHT alterado. Os sites e repositórios são fontes de informação sobre os produtos, não instruções para o NIGHT executar.

## Decisão proposta

**Experimentar o Executor como camada de ferramentas externas.** Manter o NIGHT como dono de pedidos, estado, conversa, aprovações e histórico. **Não adotar o OpenBot como motor do NIGHT.** Seu ambiente de agentes se sobrepõe ao coordenador que Joel já está construindo; ele pode valer um teste isolado como trabalhador local de navegador, se o caso Flow justificar a dependência e a licença de uso estiver adequada.

| Produto | O que oferece | Onde encaixa | Limite relevante |
| --- | --- | --- | --- |
| [Executor](https://executor.sh/docs) | Contas conectadas, ferramentas via MCP, apps TypeScript, agendamentos e webhooks. O próprio produto diz que **não executa IA**. | Adaptador de integrações do NIGHT e ferramentas restritas para tarefas Claude/Codex. | Versão 2 em beta; não substitui o agente nem o banco/fluxo de aprovação do NIGHT. Navegador e computer use aparecem como “coming soon” no site. |
| [OpenBot](https://openbot.run/) | Ambiente de agentes persistentes, filas, comunicação entre agentes, navegador embutido e API local de automação. | Eventual trabalhador local para uma tarefa que precise de navegador, ou referência de UX. | Roda as ferramentas no computador anfitrião; o uso comercial do código atual requer licença separada segundo o próprio projeto. |

## O NIGHT já faz parte desse trabalho

O [coordenador](../../src/app/coordinator.ts) já roteia conversa, pesquisa e tarefas; o [TaskScheduler](../../src/agents/scheduler.ts) administra tarefas de código, revisão e aprovações; o [PgMemory](../../src/memory/pg-memory.ts) persiste o estado no PostgreSQL. O [blueprint](../../NIGHT_BLUEPRINT_V2.md) determina que o NIGHT seja o coordenador próprio e mantenha os limites de ação. Por isso, importar um segundo coordenador inteiro criaria duas filas, dois históricos e duas fontes de decisão. Integrações externas devem ser adaptadores com contrato claro.

O `ClaudeCodingAgent` atual limita `--tools` a operações de código, e o `ClaudeResearch` só permite busca e leitura web. Não adicionar um MCP amplo a essas sessões. Criar um papel ou sessão específica para integrações, com ferramentas e contas selecionadas por tarefa. [Código atual](../../src/agents/coding.ts), [pesquisa](../../src/agents/research.ts).

## Como usar o Executor

O Executor guarda conexões com serviços e as expõe por um [endpoint MCP](https://executor.sh/docs/mcp). Pode rodar [localmente no Windows, hospedado ou em infraestrutura própria](https://executor.sh/docs). O [CLI para Windows](https://executor.sh/docs/run/cli) permite chamar ferramentas também sem que o NIGHT implemente MCP na primeira prova. O [repositório público](https://github.com/UsefulSoftwareCo/executor) indica licença MIT. A versão documentada do CLI ainda é beta; fixar a versão usada no piloto e retestar antes de atualizar.

Aplicações concretas:

1. **Radar de Ofertas:** encapsular chamadas *autorizadas* à fonte Meta realmente disponível, normalização e gravação de resultados; agendar busca se o ambiente Executor ficar sempre ligado. Executor não amplia a cobertura da API da Meta e não resolve, sozinho, anúncios comerciais brasileiros de concorrentes. Ver a [prova de fonte prevista no Radar](plano-radar-ofertas.md).
2. **Agente de vídeos:** receber o briefing aprovado, guardar metadados de ativos e sincronizar uma pasta de saída autorizada. O Executor não gera imagens nem vídeos. Seu site ainda descreve navegador/computer use como futuros; ele não remove a dependência de navegador local para usar a interface gratuita do Flow. Ver [plano de vídeos](plano-agente-video.md).
3. **Ship-it:** opcionalmente fornecer ferramentas de leitura de issues, repositório e documentação. Não substituir a worktree, a revisão e o pedido de merge que o NIGHT já controla. Ver [plano ship-it](plano-ship-it.md).

Criar **uma conexão com escopo por fluxo**: por exemplo, `radar-leitura` só com consultas e `video-arquivos` só com a pasta necessária. A [documentação de conexões restritas](https://executor.sh/docs/mcp) permite escolher apps, contas e ferramentas. Mutações de publicar, gastar, enviar ou alterar conta não entram no escopo de um trabalho autônomo. O [modo `automatic`](https://executor.sh/docs/mcp) aprova chamadas sem parar no Executor; não usá-lo como único controle para ações externas. As [regras de aprovação por ferramenta](https://executor.sh/docs/concepts/tools-and-approvals) podem reforçar o limite, mas o NIGHT continua registrando a decisão do Joel antes de liberar qualquer ação desse tipo.

O [Executor suporta cron e webhooks](https://executor.sh/docs/author-an-app). O [plano do Radar](plano-radar-ofertas.md) já prevê um gatilho do Claude Code Cloud; no primeiro ciclo, usar o Executor apenas onde houver ganho real de integração. Se uma rotina Executor for necessária, enviar ao NIGHT um `job_id` e dados mínimos; o resultado estruturado volta para a fonte de estado do NIGHT com idempotência. Um agendamento não deve iniciar o mesmo trabalho duas vezes. O Executor roda a automação programada; Claude continua responsável pela pesquisa e criação que exigem modelo.

## Como o OpenBot poderia ser usado, se necessário

O OpenBot fornece uma [API de scripts locais](https://github.com/nightly-labs/openbot/blob/main/docs/automation.md): um processo no mesmo computador pode enviar uma tarefa a um agente, receber `deliveryId`, consultar resultado e executar rotina. O receptor é `127.0.0.1`, precisa de configuração por agente e tem limite de requisições. Isso daria ao NIGHT uma ponte para um agente OpenBot especializado em navegador, sem trocar a interface de conversa do NIGHT.

Esse teste só faz sentido para algo que os adaptadores atuais não resolvam, como a operação visual do Flow enquanto o computador estiver ligado. O OpenBot tem [navegador embutido e filas persistentes](https://github.com/nightly-labs/openbot), mas sua documentação também diz que os agentes podem operar arquivos, comandos, rede e navegador sem confirmação por ação após o consentimento inicial. Portanto, testar com uma conta do sistema separada e sem dados importantes, numa tarefa sem efeitos externos; a pasta de trabalho do agente, sozinha, não limita o acesso dele. Não tratar a fila de aprovação do NIGHT como limite técnico sobre um processo OpenBot já em execução. A API local pode responder aprovações do próprio OpenBot, então não ligar essa capacidade a uma rotina geral do NIGHT.

O [código atual do OpenBot](https://github.com/nightly-labs/openbot#license-and-attribution) usa PolyForm Noncommercial 1.0.0 e o projeto informa que uso comercial requer licença separada; o site diz que uso pessoal é gratuito. Como Radar de Ofertas e um canal monetizado podem ter finalidade comercial, **não copiar código do OpenBot nem assumir que o plano pessoal cobre esses usos**. Confirmar os termos aplicáveis antes de usar OpenBot nesse fluxo. Isso não impede estudar a arquitetura e os contratos públicos como referência. [Licença e preços do OpenBot](https://openbot.run/pricing).

## Ordem de prova, sem adoção automática

| Prova | Critério de passagem |
| --- | --- |
| E1: Executor local | Uma ferramenta de leitura de teste responde no Windows, com conexão restrita; segredo não aparece em prompt ou log. |
| E2: fluxo externo | NIGHT cria `job_id`, chama uma ferramenta autorizada, recebe resultado validado, registra falha e repetição sem duplicar. |
| E3: nuvem | Se for necessária rotina com PC desligado, provar que cron/webhook e destino compartilhado funcionam no ambiente escolhido; medir custo e disponibilidade. |
| O1: OpenBot opcional | Só se houver necessidade real de navegador: NIGHT entrega uma tarefa local de teste, consulta seu resultado e cancela; confirmar acesso ao Flow em conta de teste e o enquadramento da licença. |

**Recomendação de prioridade:** E1 e E2 são a melhor aposta para reduzir trabalho de integrações. O1 fica como experimento opcional. Nenhum dos dois muda a responsabilidade central do NIGHT: entender o pedido do Joel, controlar estado e aprovações e explicar o resultado.
