# Plano separado: DeepSeek implementa e depois apoia o NIGHT

**Estado:** planejamento em 17/11/2026. Nenhuma integração, chave ou cobrança foi ativada. O [plano mestre](../PLANO_MESTRE_NIGHT.md) contém as tarefas executáveis D01–D10.

## Papel no fluxo

Joel definiu uma **fase de construção**: DeepSeek é responsável por implementar os fluxos deste backlog; Claude atua **só como revisor, QA e fonte de sugestões de ideias**. Depois que os entregáveis estiverem prontos e validados, Claude assume a liderança operacional do NIGHT. Nessa fase posterior, DeepSeek passa a dar um terceiro parecer independente e a substituir Codex se ele falhar ou ficar sem cota. O NIGHT coordena estado, regras e histórico; Joel decide sobre aprovações de conceito, merge, publicação e gasto. Este arranjo temporário para o backlog atualiza o papel anterior descrito em [DECISIONS.md](../DECISIONS.md), sem mudar o [código atual](../../src/app/coordinator.ts) até a implementação.

## Duas fases e critério de passagem

| Fase | Quem implementa/produz | Quem revisa | Quando termina |
| --- | --- | --- | --- |
| Construção do backlog | DeepSeek escreve código, integrações, testes e documentação, e prepara pilotos. | Claude faz QA obrigatório de cada diff e artefato; pode sugerir ideias e devolver correções. Codex pode acrescentar uma segunda visão. | Todos os marcos obrigatórios do escopo escolhido têm evidência, testes de ponta a ponta passam e Claude conclui o QA final. |
| Operação do NIGHT | Claude lidera tarefas de código, Radar e vídeo. | Codex revisa quando disponível; DeepSeek dá parecer independente e assume o papel do Codex em falha/cota. | Modo contínuo após a passagem registrada pelo NIGHT e comunicada a Joel. |

As tarefas novas do [plano mestre](../PLANO_MESTRE_NIGHT.md) têm **DeepSeek como implementador padrão** e **Claude como revisor/QA**. A passagem de comando é uma etapa planejada, não uma suposição de que “rodou uma vez, está pronto”. Ela exige autoria, diff, testes, limites, documentação, QA e pendências resolvidas. Itens opcionais que não forem adotados não bloqueiam a entrega. A orientação anterior de Claude líder volta a valer para a operação após essa passagem.

DeepSeek **não revisa nem aprova o próprio trabalho**. Uma falha ou falta de cota do Codex não substitui o QA do Claude durante a construção. Se Claude estiver indisponível, a entrega fica `qa_pendente`; DeepSeek pode continuar outras tarefas independentes, mas não marcar aquela como pronta. Joel continua decidindo merge, publicação, gasto e outras ações reservadas.

“Em tudo” significa consultar o DeepSeek nas **etapas de decisão relevantes** dos fluxos de código, Radar e vídeo. Chamá-lo para cada saudação ou resposta simples aumentaria latência e custo sem melhorar a decisão. O roteamento deve ser medido, configurável e explicável.

## Como habilitar DeepSeek sem trocar os outros agentes

A documentação atual oferece uma API compatível com o formato OpenAI e integrações que permitem configurar DeepSeek como provedor do [Codex](https://api-docs.deepseek.com/quick_start/agent_integrations/codex/) ou do [Claude Code](https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code/). Essas integrações **trocam o modelo por trás da ferramenta**. Para DeepSeek **implementar este backlog**, primeiro preparar um executor de desenvolvimento isolado em worktree; avaliar API com ferramentas ou uma instância isolada do Codex CLI apontada ao DeepSeek. A [instalação oficial do provedor no Codex](https://api-docs.deepseek.com/quick_start/agent_integrations/codex/) altera a configuração compartilhada dos clientes, então o piloto não usa o script global no computador do Joel. Dentro do NIGHT, um adaptador próprio à [API do DeepSeek](https://api-docs.deepseek.com/) mantém parecer e fallback separados de Claude/Codex.

Os identificadores documentados em 17/11/2026 são `deepseek-flash` e `deepseek-v4-pro`. Ambos têm saída JSON e chamadas de ferramenta; o [Responses API](https://api-docs.deepseek.com/api/create-response/) aceita formato `json_schema`. A versão e o preço podem mudar: nomes de modelo, timeout e teto de custo ficam em configuração, e o preço é consultado antes de ativar chamadas reais. [Fonte: modelos e preços](https://api-docs.deepseek.com/quick_start/pricing/).

## Contrato de parecer

Entrada mínima para parecer: `job_id`, domínio, fase, objetivo, evidências com origem, resultado dos testes/checagens, proposta do executor daquela fase, parecer de outro agente quando existir, limites e pergunta concreta. Enviar só o trecho necessário; nunca chaves, dados pessoais desnecessários, histórico completo, arquivos privados inteiros ou instruções de fontes externas como se fossem comandos. Na operação após a passagem, a primeira análise do DeepSeek pode receber problema e evidências **antes** de ler a conclusão do Claude; depois, uma etapa curta compara as posições. Na construção, Claude recebe o produto do DeepSeek para QA.

Saída validada por esquema:

```json
{
  "job_id": "...",
  "fase": "...",
  "recomendacao": "prosseguir | revisar | parar | perguntar_joel",
  "motivos": ["..."],
  "evidencias": [{ "ref": "...", "sustenta": "..." }],
  "contrapontos": ["..."],
  "lacunas": ["..."],
  "proximo_teste": "...",
  "confianca": "baixa | media | alta"
}
```

O esquema valida **forma**, não verdade. O NIGHT confere se as referências existem nos artefatos recebidos, recusa afirmações sem fonte quando fonte é obrigatória e marca respostas inválidas. A confiança é opinião do modelo, nunca porcentagem de sucesso. O registro de decisão guarda `job_id`, fase, versão/hash da entrada, modelo, uso/custo, parecer, divergência, regra aplicada e decisão do Joel.

## Onde entra

| Fluxo | Pergunta para o DeepSeek | O que o NIGHT faz com a resposta |
| --- | --- | --- |
| Pedido complexo | O objetivo está claro? Falta critério de pronto ou há risco relevante? | Pede a Joel só a informação que bloqueia o próximo passo. |
| ship-it e código | O cartão é testável? O plano e o diff cobrem o objetivo? Há regressão ou teste faltante? | Na construção, DeepSeek implementa e Claude faz QA; após a passagem, Claude implementa e Codex revisa, com DeepSeek como conselheiro ou reserva. NIGHT compara pareceres com testes e diff antes de mostrar a decisão de merge. |
| Radar de Ofertas | A evidência realmente sustenta demanda, preço e promessa? Qual é o argumento contra a oferta? | Mantém a nota numérica determinística; apresenta a Joel potencial, incertezas e alternativas originais. |
| Vídeo | O roteiro distingue fato de ilustração? Há repetição, promessa enganosa ou fonte fraca? | Bloqueia afirmação factual sem fonte e solicita revisão de cena/roteiro antes do render final. |
| Falha ou divergência | A causa provável é dados, ferramenta, escopo ou hipótese? Qual teste menor resolve? | Registra o desacordo e escolhe uma verificação observável; se a dúvida persistir, leva a Joel. |

Na **construção**, DeepSeek implementa em worktree com executor separado, cancelamento e testes; Claude revisa o resultado. Na **operação**, o modo de parecer do DeepSeek sugere, contesta e pede teste sem alterar arquivos; seu modo de reserva usa o executor limitado à worktree quando Codex faltar. Em nenhuma fase ele recebe ferramentas de campanha, compra, publicação ou contas externas apenas por ser implementador ou substituto do Codex.

## Quando o Codex falhar ou ficar sem cota após a passagem

Hoje a [pesquisa](../../src/app/bootstrap.ts) tenta Codex e depois Claude; a [conversa](../../src/app/coordinator.ts) alterna Codex/Claude e cai para Qwen local se ambos falham; o [scheduler](../../src/agents/scheduler.ts) encerra uma execução de código com quota e transforma uma falha de revisão em texto de erro. Após a passagem para Claude líder, o fallback precisa ser explícito em cada fluxo:

| Papel do Codex | Troca planejada | Estado que deve ficar visível |
| --- | --- | --- |
| Conversa na vez do Codex | DeepSeek responde na mesma vez; se também indisponível, usar a reserva já configurada e por fim Qwen. | `codex_indisponivel`, motivo, `deepseek` como modelo que respondeu. |
| Pesquisa iniciada pelo Codex | DeepSeek recebe a mesma consulta e contexto mínimo antes de Claude, com fontes verificáveis. | Consulta, fontes, modelo efetivo, falhas e custo. |
| Revisão de código que seria do Codex | DeepSeek revisa o mesmo diff/hash em leitura; se não conseguir, marcar `revisao_pendente`. | Revisor real, parecer, hash do diff e falta de revisão quando ocorrer. |
| Codex como executor principal de código | Se falhar **antes de editar**, DeepSeek pode iniciar na worktree validada. Se houve edição parcial, congelar diff e logs; só retomar após decidir descartar ou aproveitar as mudanças com verificação. | Autor real de cada etapa, estado da worktree, testes e transição de agente. |

Falha elegível: executável ausente, erro de processo, timeout ou limite/cota detectado. Uma resposta de revisão “corrigir” **não** é falha de disponibilidade e nunca dispara outro agente para obter aprovação. No limite de uso, registrar a indisponibilidade temporária e evitar tentar Codex repetidamente até expirar a janela conhecida ou haver teste de disponibilidade. O gatilho de troca não deve depender só de um texto arbitrário retornado por fonte externa.

O substituto **não herda uma tarefa pelo nome**: recebe `job_id`, objetivo e escopo aprovados, versão/hash da entrada, último estado confirmado, artefatos e limites. Trocar de modelo não altera o contrato nem apaga o parecer anterior. A revisão de DeepSeek deve ser identificada como revisão de DeepSeek; nunca aparecer como “Codex aprovou”. Se nenhum revisor estiver disponível, o NIGHT não declara revisão aprovada e apresenta a pendência ao Joel antes de pedir merge.

Quando DeepSeek substitui Codex, seu parecer ocupa **um único papel de revisão**; não contar o mesmo texto também como terceiro parecer independente. Se for preciso um contraponto adicional, ele terá de vir de outro agente ou de uma verificação objetiva.

Para código, o teste de segurança operacional é: detectar o último efeito concluído, conferir a worktree e o diff, escolher uma retomada idempotente e rodar novamente os testes. Nunca executar uma segunda vez um comando com efeito externo só porque a primeira resposta se perdeu. O executor de DeepSeek terá limites de arquivos, comandos, duração, chamadas de ferramenta e custo, além do mesmo cancelamento por tarefa. A integração só é considerada pronta quando essa troca funciona com Codex indisponível **antes de iniciar** e **depois de edição parcial**.

## Regra de decisão do NIGHT

1. **Verificações objetivas primeiro:** estado do job, permissão, orçamento, fonte, testes, hash do diff e contratos de saída. Falha objetiva impede avanço, mesmo se os três modelos concordarem.
2. **Comparar argumentos, não contar votos:** Claude, Codex e DeepSeek podem repetir o mesmo erro. Cada recomendação deve apontar evidência ou um teste que a diferencie.
3. **Escalonar pelo impacto:** conflito de baixo risco pode ser resolvido por teste; conflito sobre gasto, publicação, merge ou alegação factual importante vai para Joel com opções e consequências claras.
4. **Explicar a decisão:** NIGHT informa “recomendo X porque Y; falta Z”, com referência ao artefato e ao parecer. Não esconde discordâncias úteis.

## Desempenho e custo

- Usar `deepseek-flash` para classificação e crítica curta; reservar `deepseek-v4-pro` para divergência difícil ou decisão de maior impacto, se os testes mostrarem ganho. Esses nomes são parâmetros, não escolhas fixas no código.
- Deduplicar consultas por hash da entrada, versão e fase. Limitar chamadas, tokens, tempo e custo por job; registrar uso real retornado pela API. Uma mesma oferta ou diff sem mudança reutiliza o parecer.
- Executar em paralelo com a revisão do Codex **somente quando ambos recebem o mesmo artefato fechado e não dependem um do outro**. A síntese final espera os resultados ou um timeout definido.
- Em falha, timeout ou limite de saldo, registrar `parecer_indisponivel`; o NIGHT continua apenas as etapas permitidas pela política daquele fluxo. Não inventa a opinião que faltou nem converte ausência em aprovação.
- Manter **orçamento separado para substituição do Codex**: uma execução de código pode consumir muito mais tokens e ferramentas do que um parecer. Esgotado o teto do DeepSeek, o NIGHT avisa e pausa a etapa dependente; não assume crédito ilimitado.
- Comparar pilotos com e sem DeepSeek por qualidade de críticas aceitas, defeitos encontrados, retrabalho evitado, tempo de resposta e custo por decisão útil. Se a terceira opinião não melhorar o resultado, reduzir os pontos de chamada.

A [tabela oficial de preços](https://api-docs.deepseek.com/quick_start/pricing/) apresenta cobrança por tokens e valores que variam conforme modelo e horário. O plano do Codex e o saldo da API DeepSeek são contas diferentes: ficar sem cota no Codex não cria créditos no DeepSeek. O piloto deve usar teto configurado e nenhum teste real deve começar sem chave e limite definidos pelo Joel.

## Local, nuvem e privacidade

O adaptador local pode chamar a API quando o NIGHT estiver aberto. Para o Radar e o vídeo continuarem com o PC desligado, a consulta ao DeepSeek precisa ocorrer **dentro do trabalhador em nuvem autorizado**, ou ficar pendente até o NIGHT sincronizar o resultado. O plano atual de [Claude em segundo plano](plano-radar-ofertas.md) ainda exige prova real de gatilho, retorno e conectores; não presumir que Cowork possa receber um comando externo ou que tenha a chave do DeepSeek. O primeiro piloto deve validar o parecer local; o segundo, a mesma entrada/saída num job de nuvem com segredo separado e resultado rastreável.

Cada chamada envia dados do projeto a um serviço externo. Configurar minimização de contexto, lista de campos permitidos e segredos no ambiente apropriado. Antes de enviar dados de clientes ou material sensível, Joel deve escolher se esse tipo de dado pode sair da máquina. O teste inicial usa tarefas sintéticas e dados públicos.

## Ordem de prova

1. Habilitar o executor isolado do DeepSeek e provar um cartão sintético em worktree. Claude revisa diff e testes; esse é o primeiro QA da fase de construção.
2. DeepSeek define matriz de consulta por fluxo e contrato JSON, com exemplos sintéticos de cartão, oferta incompleta e roteiro sem fonte; Claude confere o contrato.
3. DeepSeek constrói adaptador substituível e testes com resposta falsa, incluindo timeout, JSON inválido e referência inexistente; Claude faz QA.
4. Rodar piloto local com uma chamada real limitada: comparar crítica DeepSeek, parecer Codex e decisão NIGHT; registrar tempo e uso.
5. Provar a troca na conversa, pesquisa e revisão com Codex simulado como indisponível ou sem cota; verificar que o modelo efetivo aparece no histórico.
6. Provar executor de código DeepSeek dentro do NIGHT em worktree descartável, inclusive falha antes de editar e edição parcial, com cancelamento, testes e diff conferido por Claude.
7. DeepSeek implementa uma fase de cada domínio, primeiro código, depois Radar e vídeo. Claude revisa qualidade, comportamento e ideias; testar desacordos sem voto automático.
8. Provar consulta na nuvem com PC desligado, só depois de o trabalhador e o armazenamento de segredos estarem validados.
9. Medir benefício, custo e latência; concluir QA dos marcos obrigatórios; passar a liderança operacional ao Claude com histórico e perfil registrados.

**Critério de pronto:** DeepSeek implementou os fluxos escolhidos e Claude concluiu QA dos diffs e pilotos; um pedido em cada domínio produz parecer rastreável e útil; uma discordância mostra evidências e próximo teste; após a passagem, quando Codex falta, DeepSeek assume o papel elegível sem duplicar efeitos ou apagar a autoria; indisponibilidade do DeepSeek é visível; nenhuma ação reservada a Joel é aprovada por consenso de modelos.
