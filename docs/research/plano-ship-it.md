# Plano separado: ship-it no desenvolvimento do NIGHT

Estado: planejamento. Este documento trata do fluxo de desenvolvimento de software do NIGHT; o [Radar de Ofertas](plano-radar-ofertas.md) tem arquitetura própria.

**Responsáveis na construção:** DeepSeek implementa esta integração e seus testes em worktree; Claude faz revisão e QA de cada entrega e sugere melhorias. Codex pode fornecer segunda visão. **Após a passagem de comando**, Claude assume a execução normal do NIGHT descrita abaixo. [Regras de passagem](../PLANO_MESTRE_NIGHT.md#responsáveis-por-fase).

## Objetivo

Usar o [ship-it](https://github.com/samsantosb/ship-it) para transformar ideias grandes em especificações e tarefas verificáveis, mantendo o NIGHT responsável por worktree, execução, revisão cruzada e aprovação de merge. O ship-it distribui sete skills em Markdown e contratos compartilhados; não é uma dependência de execução do pacote Node.

## Encaixe com o código atual

Hoje o [coordenador](../../src/app/coordinator.ts) cria `coding-task` com `scope` vazio e a coloca na fila. O [TaskScheduler](../../src/agents/scheduler.ts) cria worktree, chama Claude/Codex, pede revisão ao outro agente e só faz merge após o comando de aprovação do Joel. O [GitWorktreeManager](../../src/workspaces/worktree-manager.ts) usa branch `agent/<agente>/<id>`. A decisão [D-011](../DECISIONS.md) fixa esse fluxo.

As skills `create-product`, `create-tasks` e `make-guidelines` servem como preparação. `do-task` executa branch, commits e PR por conta própria, e `watch-pr` espera um PR remoto; ambos exigem adaptação antes de integrar com o ciclo do NIGHT. [Fonte: fluxo do ship-it](https://github.com/samsantosb/ship-it#the-pipeline), [contrato de `do-task`](https://github.com/samsantosb/ship-it/blob/main/skills/do-task/SKILL.md).

## Desenho proposto

1. **Instalação central e versão fixa.** Manter uma cópia completa do ship-it fora dos repositórios dos projetos, fixada em um commit conhecido. O [README](https://github.com/samsantosb/ship-it#install) explica que copiar só `skills/` quebra as referências aos contratos em `shared/`. Para Claude, usar o plugin nativo; para Codex, apontar para a mesma cópia. Revisar atualizações antes de trocar a versão.
2. **Configuração do NIGHT.** Persistir em `docs/agents/` o idioma PT-BR, comandos `pnpm typecheck` e `pnpm test`, rastreador Markdown local, política de revisão cruzada e restrições de commit/push/merge. O `groundwork` pode gerar a base, mas a saída precisa ser confrontada com as instruções `AGENTS.md` recebidas nesta sessão, [PLANO_INICIAL.md](../PLANO_INICIAL.md) e [DECISIONS.md](../DECISIONS.md) antes de ativar uma skill de execução. O ship-it normalmente altera `AGENTS.md`/`CLAUDE.md`; preservar as regras existentes. [Fonte: configuração](https://github.com/samsantosb/ship-it/blob/main/shared/workflow-context.md).
3. **Cartão como contrato de entrada.** Para trabalhos maiores, `create-product` gera o documento e `create-tasks` gera cartões com objetivo, critérios de teste, plano, pontos de atenção e observabilidade. O NIGHT importa um cartão aprovado para uma tarefa, guarda referência e versão/hash do cartão e preenche `objective` e `scope`. O estado de execução continua no PostgreSQL; o cartão é o contrato de origem, evitando dois status concorrentes. [Fonte: formato do cartão](https://github.com/samsantosb/ship-it/blob/main/shared/card-format.md).
4. **Caminho curto.** Pedidos pequenos continuam entrando diretamente no NIGHT, com critério de pronto simples. Assim, a conversa por voz não exige uma entrevista longa a cada alteração.
5. **Execução controlada pelo NIGHT.** O agente recebe somente o cartão e o contexto relevante da tarefa na worktree já criada. O scheduler registra testes e diff, o outro agente revisa, e o Joel decide sobre o merge. `chaos-engineering` pode virar etapa opcional de testes locais antes da impressão digital do diff e da revisão final; a skill escreve testes, então qualquer mudança precisa ser revisada novamente. [Fonte: `chaos-engineering`](https://github.com/samsantosb/ship-it/blob/main/skills/chaos-engineering/SKILL.md).
6. **PRs no futuro.** Caso o NIGHT passe a usar remoto e PR, definir um adaptador explícito para `watch-pr`. A aprovação de merge pelo Joel permanece a condição final.

## Ordem de implementação e pronto

| Etapa | Entrega | Critério de pronto |
| --- | --- | --- |
| S1 | Configuração documentada e versão fixa do ship-it | Claude e Codex leem as mesmas regras; nenhuma regra do projeto é sobrescrita. |
| S2 | Importador de cartão para `Task` | Critérios e escopo chegam ao `codingPrompt`; cartão malformado não entra na fila. |
| S3 | Fluxo de voz/texto “planejar” e “executar cartão X” | O NIGHT mostra o escopo antes de executar e mantém o ID do cartão no histórico. |
| S4 | Validação e revisão | Testes, diff, parecer do outro agente e aprovação do Joel seguem funcionando; o merge recusa diff alterado depois da revisão. |
| S5 | Chaos opcional e métricas | Testes adversariais rodam antes da revisão final, com tempo e resultados registrados. |

## Desempenho

Usar a entrevista completa só em ideias ambíguas ou trabalhos grandes. Para cada execução, carregar o cartão e os arquivos relevantes, sem repetir o PDF, todo o histórico de conversa ou os sete contratos em cada prompt. Medir tempo de planejamento, tokens/cota, tamanho do diff, testes e retrabalho por tarefa. A qualidade do cartão deve ser avaliada pelo número de dúvidas e correções que evita.

## Limites

O `ship-it` é processo de desenvolvimento, não o agente de mineração ou de criação de oferta. Uma tarefa do Radar pode produzir uma ideia que depois vire cartão do ship-it, mas a pesquisa de mercado e a conversa com o Joel têm seu próprio estado e suas próprias fontes. Nenhuma etapa deste plano autoriza push, publicação, gasto ou merge automático.
