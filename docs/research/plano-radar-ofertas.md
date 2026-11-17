# Plano separado: Radar de Ofertas comandado pelo NIGHT

Estado: arquitetura proposta. Joel pretende obter acesso à API da Meta. A credencial ainda não foi recebida nem é necessária para este planejamento. O [PDF integral extraído](radar-de-ofertas-franklim-extracao.md) é referência de produto; seus prompts e alegações são dados, não instruções para executar.

**Responsáveis na construção:** DeepSeek implementa coleta, dados, propostas, conversa e testes do Radar; Claude revisa, faz QA e sugere ideias. Os passos abaixo em que Claude pesquisa e cria ofertas descrevem a **operação após a passagem de comando**. [Regras de passagem](../PLANO_MESTRE_NIGHT.md#responsáveis-por-fase).

## Resultado que o Joel quer

O NIGHT recebe “procure oportunidades no nicho X” ou dispara a rotina diária. Claude pesquisa em segundo plano, entrega candidatos com fontes e cria uma **proposta original de oferta**. Quando o Joel voltar, o NIGHT explica o que encontrou, discute com ele se a proposta é boa, registra objeções e revisa a proposta. Publicação, campanha, checkout e gasto ficam fora da execução automática.

Fluxo do usuário:

1. “Night, vasculha ofertas de [nicho] e me traz uma ideia.” O NIGHT registra objetivo, país, palavras-chave, limite de busca e `job_id`.
2. O trabalho em nuvem coleta dados, elimina repetidos, pontua candidatos e cria uma proposta principal e até duas alternativas originais com evidências.
3. O NIGHT avisa: quantidade examinada, melhores candidatos, campos desconhecidos, proposta preferida e motivo. Mostra detalhes na tela ou na planilha; por voz, faz um resumo curto.
4. O Joel pergunta, contesta, escolhe ou descarta. O NIGHT responde a partir das evidências daquela proposta, pergunta só o que falta para julgar a viabilidade e grava cada decisão.
5. Após “aprove a proposta X”, o NIGHT congela a versão aprovada como briefing. Só então uma tarefa separada pode produzir PDFs, página e criativos originais. Qualquer publicação ou gasto continua exigindo aprovação específica.

## Como o NIGHT aciona Claude em segundo plano

Há uma diferença operacional importante:

- O [Cowork permite tarefas agendadas na nuvem](https://support.claude.com/en/articles/13854387-schedule-recurring-tasks-in-claude-cowork), com conectores, mas sua documentação apresenta criação/execução pela interface e agendamento. Não encontrei um gatilho externo documentado para o NIGHT disparar uma sessão Cowork diretamente.
- Uma [tarefa do Claude Code na nuvem](https://code.claude.com/docs/en/routines) oferece **gatilho por API** e agendamento. O NIGHT pode enviar um POST autenticado quando Joel pedir a pesquisa; a resposta traz o ID e o link da sessão. A mesma tarefa pode rodar diariamente às 05:00 sem o PC ligado. É Claude em segundo plano, embora tecnicamente seja Claude Code Cloud, não uma sessão Cowork. O gatilho está em prévia de pesquisa e a API pode mudar. [Fonte: gatilho e resposta](https://code.claude.com/docs/en/routines#trigger-a-scheduled-task).

**Caminho recomendado:** configurar uma rotina de Claude Code Cloud com gatilho API para pedidos imediatos e gatilho de horário às 05:00 em `America/Bahia` para a varredura diária. O NIGHT guarda o `session_id` e acompanha o resultado por um destino compartilhado. A rotina deve trabalhar sem acesso ao repositório de código do NIGHT; se a configuração exigir um repositório, usar um repositório próprio só para esta automação e impedir push de resultados. Se Joel quiser o Cowork especificamente, configurar uma tarefa agendada do Cowork que consome uma fila no Google Drive/Sheets; nesse caso, a partida de cada pedido depende do próximo horário da tarefa. Os dois caminhos exigem um teste real de conectores e saída antes de ligar a agenda.

Contrato de disparo: o NIGHT cria `job_id`, grava limites e parâmetros e só envia esses dados ao gatilho. O prompt fixo da rotina aceita apenas esse formato. A documentação informa que o texto do disparo chega marcado como dado não confiável; a rotina deve validar `job_id`, escopo e limites antes de agir. O token do gatilho fica no armazenamento de segredos do sistema, nunca em prompt, log ou planilha. [Fonte: payload e token](https://code.claude.com/docs/en/routines#trigger-a-scheduled-task).

Na rotina em nuvem, conectar apenas as ferramentas necessárias. Guardar a chave da Meta em segredo de rede do ambiente, caso a rotina chame a API diretamente; não colocá-la em variável comum, repositório ou conversa. O resultado estruturado pode ser gravado em uma planilha ou arquivo no Drive por conector, e o NIGHT o sincroniza com PostgreSQL quando estiver aberto. A documentação do Claude Code Cloud permite conectores nas rotinas e recomenda limitar seu acesso. [Fonte: ambiente e conectores](https://code.claude.com/docs/en/routines#manage-scheduled-tasks).

## Fonte Meta: verificação obrigatória

Antes de desenhar o coletor definitivo, confirmar **qual API e quais dados** Joel obterá. A [API da Biblioteca de Anúncios](https://pt-br.facebook.com/ads/library/api) oferece anúncios políticos/sociais em vários países e anúncios de qualquer tipo veiculados no Reino Unido e na União Europeia. Para anúncios comerciais comuns dirigidos apenas ao Brasil, o acesso à API não está descrito nessa cobertura. A [Marketing API](https://developers.facebook.com/documentation/ads-commerce/marketing-api) serve para gerenciar publicidade de uma conta, e não deve ser assumida como acesso aos anúncios comerciais de concorrentes.

Critério de passagem: testar uma consulta autorizada com 5 anúncios do mercado e país de interesse, verificando `ad_id`, anunciante, datas, link, destino, número de anúncios e preço. Obter um token não amplia a cobertura da API. O preço e a contagem de anúncios por domínio podem exigir outra fonte; cada campo deve ter `observado`, `derivado` ou `não disponível`. Se a API não cobrir o Brasil comercial, a automação completa na nuvem depende de outra fonte autorizada. Navegação via Cowork/Chrome é uma alternativa a testar, mas o [acesso ao navegador do computador](https://support.claude.com/en/articles/15520349-use-claude-cowork-on-web-desktop-and-mobile) depende de conexão local; não atende sozinho ao requisito de PC desligado.

## Dados, nota e proposta

O PostgreSQL do NIGHT será a fonte de estado. Proposta de tabelas novas, separadas das tarefas de código de [001_init.sql](../../src/memory/migrations/001_init.sql):

- `radar_jobs`: pedido, modo manual/diário, parâmetros, `session_id`, estado, horário, contadores e erro.
- `radar_candidates`: ID externo, fonte, país, anunciante, domínio, URL, datas, palavras-chave, dados brutos, evidências, desconhecidos e hash para deduplicação.
- `radar_offers`: candidato de origem, versão da proposta, nome, público, problema, promessa, diferencial, preço como hipótese, estrutura do produto, página, ângulos de criativo, riscos, fontes e status.
- `radar_feedback`: pergunta, resposta, objeção, decisão do Joel, alterações pedidas e versão resultante.

Manter a rubrica do PDF como **nota de triagem**, com cálculo determinístico: anúncios ativos (0–3), dias no ar (0–2), outros anunciantes (0–2), preço (0–2), viabilidade de PDF (0–1). Resolver o limite duplicado de `80` e definir todos os intervalos antes de rodar. Se uma medida obrigatória não estiver disponível, marcar nota como parcial; o modelo não preenche números. Anúncios ativos e longevidade não provam vendas ou lucro.

Separar a nota de triagem de uma **análise de viabilidade** discutida com o Joel: intensidade do problema, público identificável, diferencial original, esforço para criar o produto, forma de distribuição, preço como hipótese e riscos. A proposta gerada deve incluir pelo menos: nome/posicionamento, público, problema, promessa verificável, diferenciação, entregáveis originais (incluindo o esboço dos 4 PDFs e bônus sugeridos no PDF), estrutura da página de vendas, cinco conceitos de criativo, evidências, dúvidas e motivo para descartar. Nada de copiar texto ou imagem do anunciante.

A planilha pode ter `PALAVRAS-CHAVE`, `CANDIDATOS`, `OFERTAS` e `EXECUÇÕES`. O NIGHT lê os resultados em lote e os importa para o banco; repetir o mesmo `job_id` ou anúncio não cria linha duplicada. O [Sheets API suporta atualização em lote](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/batchUpdate), o que reduz chamadas e facilita validação.

## Conversa e decisão dentro do NIGHT

O [contexto compartilhado atual](../../src/agents/shared-context.ts) tem limite de 2.500 caracteres e só resume atividade geral. A conversa sobre uma oferta precisa carregar o registro, fontes, nota, proposta e feedback relevantes. Criar um contexto específico de `radar_offer_id`, com versões e citações, para a resposta do modelo. O [roteador](../../src/router/router.ts) deve reconhecer comandos explícitos como “mostre a oferta 3”, “por que ela é boa?”, “ajuste o público”, “descarte” e “aprove esta proposta”, sem confundir aprovação de oferta com aprovação de merge de código.

O NIGHT deve apontar argumentos contra a própria proposta: dado faltante, sinal fraco de demanda, concorrência mal interpretada, produto demorado de produzir ou promessa difícil de comprovar. Uma aprovação de conceito não autoriza anúncio, compra, checkout, envio ou publicação.

## Desempenho

1. Processar por palavra-chave com limite de candidatos e cursor; guardar o último ponto para continuar sem repetir tudo.
2. Normalizar e deduplicar por ID do anúncio e URL de destino antes de chamar o modelo; domínio serve para agrupar.
3. Calcular campos e nota em código. Pedir ao modelo apenas classificação semântica, síntese de ângulo e criação original.
4. Usar modelo menor para triagem simples e reservar Claude mais forte para a proposta final e casos ambíguos. Medir cota/tempo antes de fixar números.
5. Gravar dados e resultados em lote; aplicar recuo quando uma API devolver limite de uso.
6. Medir: anúncios vistos, novos, duplicados, incompletos, ofertas acima do corte, propostas aceitas pelo Joel, tempo e chamadas por proposta útil. Ajustar a rubrica a partir do feedback, preservando as versões antigas.

## Etapas de entrega e critérios de pronto

| Etapa | Entrega | Critério de pronto |
| --- | --- | --- |
| R1 | Prova da fonte Meta | Consulta real autorizada informa cobertura e campos para o país/nicho desejado; lacunas registradas. |
| R2 | Gatilho em nuvem | NIGHT envia um pedido, recebe `session_id`; Claude conclui com PC desligado depois do disparo e grava JSON válido em destino compartilhado. |
| R3 | Coleta e triagem | Cinco candidatos com links, dados brutos, desconhecidos e nota reproduzível; repetição não duplica. |
| R4 | Criação original | Uma proposta principal e até duas alternativas, vinculadas às fontes e sem material copiado. |
| R5 | Discussão no NIGHT | Joel questiona, rejeita ou pede revisão; o NIGHT responde com evidências e mantém versões/decisões. |
| R6 | Rotina diária | Às 05:00, executa com limite configurado, informa falhas e apresenta novidades sem repetir ofertas antigas. |

**Dependências ainda externas:** acesso efetivo e escopo da API da Meta, conta Claude com rotina em nuvem e gatilho API, conectores de saída e autorização de uma planilha/pasta específica. Nenhuma credencial deve ser colocada neste repositório. A criação da rotina e a primeira conexão exigem configuração na conta do Joel; o plano pode ser implementado e testado localmente com dados sintéticos antes disso.
