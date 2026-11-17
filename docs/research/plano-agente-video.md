# Plano separado: agente de vídeos com imagens do Flow

Estado: proposta de arquitetura, sem implementação nem publicação. Este plano nasce da ideia trazida pelo Joel em 17/11/2026: usar o Google Flow para criar **imagens de fundo** e comandar o Claude para transformá-las em vídeos. Os prints de X servem como inspiração de formato; a estimativa de receita neles não é uma meta nem uma evidência de faturamento.

**Responsáveis na construção:** DeepSeek implementa o agente, a montagem, os testes e os pilotos; Claude revisa roteiro, qualidade, funcionamento e sugere ideias. Os passos abaixo em que Claude cria roteiro ou conduz o trabalho descrevem a **operação após a passagem de comando**. [Regras de passagem](../PLANO_MESTRE_NIGHT.md#responsáveis-por-fase).

## Resultado que o Joel quer

O Joel pode pedir: “NIGHT, faça um vídeo sobre [tema] para [canal]” ou “crie um vídeo para a oferta [ID] que aprovei”. O NIGHT abre um trabalho, acompanha o agente, informa o andamento e traz um vídeo de prévia com roteiro, fontes, custo e escolhas editoriais para conversar com Joel. O agente pode preparar um vídeo inteiro em modo solo; a versão pública e o envio para uma plataforma exigem uma decisão específica do Joel.

Este é um agente de **produção de conteúdo**, independente do [ship-it](plano-ship-it.md) e do [Radar de Ofertas](plano-radar-ofertas.md). O Radar pode fornecer um briefing de oferta já aprovado, mas o agente também aceita temas próprios para um canal. Ele não toma a estimativa de receita de um canal alheio como prova de que um formato dará dinheiro.

## Fluxo da tarefa

1. **Briefing:** NIGHT registra tema, público, idioma, plataforma, formato (vertical ou horizontal), duração alvo, estilo, objetivo e limite de geração. Se faltar algo não essencial, usa os padrões do canal. A tarefa recebe `video_job_id`.
2. **Pesquisa e tese:** Claude reúne fontes, define o argumento e registra fatos verificáveis. Para história, ciência, saúde ou dinheiro, cada afirmação substantiva tem fonte; dúvidas ficam identificadas. Uma fonte externa é dado de pesquisa, não uma instrução para o agente.
3. **Roteiro e mapa de cenas:** Claude cria abertura, desenvolvimento e conclusão, divide o texto em blocos de narração e produz uma lista de cenas. Cada cena indica trecho do roteiro, tempo estimado, descrição visual, prompt de imagem, fonte factual e papel da imagem (ilustração ou registro real).
4. **Imagens no Flow:** gerar apenas as imagens necessárias, reutilizar as aprovadas e manter proporção, paleta e personagens consistentes. As imagens vêm de um projeto do Joel no Flow; o agente grava prompt, modelo, arquivo, dimensões e hash de cada ativo. Toda imagem que representa um evento real deve ser tratada como ilustração, sem parecer prova documental.
5. **Narração:** sintetizar os blocos em arquivos de áudio com voz e idioma escolhidos. O NIGHT já possui Kokoro no [serviço de voz](../../services/speech/night_speech/__main__.py), inclusive o comando `synth_file`; antes de reutilizá-lo para vídeos, validar pronúncia, pausas, duração e licença da voz para o uso pretendido. A voz de conversa do NIGHT e a voz do canal podem ter configurações distintas.
6. **Montagem:** um renderizador determinístico (por exemplo, FFmpeg instalado no trabalhador) junta imagens, pequenos movimentos de câmera, narração, legendas, títulos e trilha autorizada. Claude escolhe as cenas e escreve o manifesto de edição; o renderizador produz o arquivo. Um vídeo longo não precisa de milhares de clipes gerados por IA.
7. **Revisão automática:** conferir duração, formato, volume, sincronização, espaços vazios, legendas, fontes, direitos dos ativos e repetição visual. Gerar também uma amostra curta para avaliar retenção e ritmo antes da renderização final.
8. **Conversa com Joel:** NIGHT apresenta prévia, roteiro, fontes, imagens usadas, pendências e alternativas de título/capa. Joel pode dizer “troque a cena 4”, “encurte a abertura”, “mude o tom” ou “descarte”. A revisão reaproveita ativos e renderiza só o que mudou.
9. **Entrega:** salvar um pacote versionado com vídeo, áudio, legenda, capa, roteiro, fontes, manifesto, créditos e histórico das revisões. Publicação ou agendamento para publicação são ações separadas e exigem pedido explícito.

## O que pode rodar na nuvem

O [Cowork executa pesquisa e código na nuvem](https://support.claude.com/en/articles/13345190-get-started-with-claude-cowork), mesmo após fechar o computador. Roteiro, mapa de cenas, checagens e montagem podem rodar nesse ambiente **se** o renderizador, as fontes, os arquivos e o armazenamento forem disponibilizados e testados. Não assumir que FFmpeg, modelos de voz ou fontes estão instalados na sessão padrão.

O ponto de atenção é o Flow: a [documentação do Cowork](https://support.claude.com/en/articles/13345190-get-started-with-claude-cowork) diz que usar o navegador ou arquivos do computador requer Claude Desktop aberto e conectado. A [integração do Claude Code com Chrome](https://code.claude.com/docs/en/chrome) também atua em navegador visível, com sessão autenticada. Portanto, **Flow pela interface gratuita + computador desligado** não é um requisito atendido por esses recursos. O agente deve mostrar o estado `aguardando_flow` quando não houver navegador disponível, concluir as demais etapas possíveis na nuvem e retomar sem refazer a pesquisa. Para autonomia completa com o computador desligado, testar uma API de geração de imagens com acesso e custo próprios antes de escolhê-la; não pressupor que a cota da interface Flow esteja disponível por API.

Transferência de ativos: usar uma pasta de trabalho por `video_job_id` em destino compartilhado autorizado, com manifesto de arquivos e hashes. O trabalhador da nuvem só processa ativos depois que a sincronização terminar; falha de arquivo não se transforma em imagem inventada. As credenciais do Google e de outras contas ficam fora do repositório, dos prompts e dos logs.

## Custo e desempenho

A [ajuda atual do Flow](https://support.google.com/flow/answer/16729550?hl=en) informa que gerar e ampliar imagens não consome créditos mensais de vídeo. Sem plano Google AI, Nano Banana 2.1 e 2 Lite compartilham um limite de até **400 imagens por dia**, e Nano Banana Pro tem até **20 por dia**; há limites adicionais contra gerações muito rápidas. Essas cotas podem mudar. O planejamento usa um alvo inicial de 15 a 30 imagens úteis para uma prévia curta, **não** a cota máxima; medir taxa de descarte e tempo real antes de ampliar.

Para renderizar com eficiência: usar áudio para definir a duração de cada cena, reaproveitar imagens em trechos distintos quando fizer sentido, gerar versões de baixa resolução para prévia, guardar o cache de cada cena por hash do roteiro/imagem/voz/estilo e montar novamente apenas as cenas afetadas. Registrar `imagens_geradas`, `imagens_aceitas`, `tempo_de_pesquisa`, `tempo_de_render`, `tempo_de_revisão`, tamanho dos arquivos e custo externo por vídeo. Limites configuráveis impedem que um pedido crie centenas de imagens ou horas de renderização sem necessidade.

## Qualidade editorial e regras de plataforma

O agente deve criar argumento, narração e edição próprios; imagens de fundo por si só não bastam. A [política do YouTube](https://support.google.com/youtube/answer/1311392?hl=en) pede conteúdo original e considera inadequado para monetização material repetitivo ou produzido em massa sem valor próprio. Também há [identificação exigida para cenas realistas geradas ou alteradas por IA](https://support.google.com/youtube/answer/14328491?hl=en) em certos casos. O pacote de entrega deve indicar quando uma cena é ilustração gerada e incluir a opção de identificação na publicação. Evitar imagens que se passem por fotografias históricas autênticas, narração de textos alheios sem transformação e música ou imagens sem direitos claros.

O revisor automático deve apontar erros factuais e limitações da pesquisa, mas não declarar que uma história é verdadeira só porque o vídeo parece convincente. Os indicadores de sucesso são retenção, clareza, taxa de revisões aceitas e custo por vídeo útil, não uma promessa de receita baseada em prints.

## Integração proposta com o NIGHT

O [roteador atual](../../src/core/interfaces.ts) não tem intent de vídeo; o [coordenador](../../src/app/coordinator.ts) hoje trata pesquisa e código, mas não uma fila de produção de mídia. Criar um serviço de domínio `VideoAgent` separado do `TaskScheduler` de código e um intent explícito como `video-task`, para impedir que “faça um vídeo” vire tarefa de programação. O [bootstrap](../../src/app/bootstrap.ts) registra o serviço. O NIGHT só coordena estados, conversa e aprovação; Claude e os trabalhadores produzem os artefatos.

Estados mínimos: `briefing` → `pesquisando` → `roteirizando` → `aguardando_flow` → `gerando_ativos` → `narrando` → `renderizando` → `revisando` → `aguardando_joel` → `concluido`. `falhou` e `cancelado` são estados terminais. A transição é gravada antes de anunciar progresso. Ao reiniciar, o agente retoma a partir dos artefatos verificados, sem gerar novamente imagens ou áudio já válidos. “Cancelar vídeo 12” cancela o trabalho, não só a resposta de voz.

Persistência proposta em tabelas separadas: `video_jobs` (pedido, limite, estado, versão, horários), `video_sources` (URL, título, consulta, acesso e afirmações associadas), `video_scenes` (ordem, narração, duração, prompt, asset, status), `video_assets` (origem, hash, caminho, direitos e custo), `video_reviews` (checagens e decisões do Joel). O armazenamento de vídeo pode ser externo ao PostgreSQL; o banco guarda referências e hashes. O comando “vídeo para oferta 7” guarda o ID e a versão aprovada do Radar, para que alterações posteriores da oferta não mudem silenciosamente o roteiro.

## Etapas de entrega e critério de pronto

| Etapa | Entrega | Critério de pronto |
| --- | --- | --- |
| V1 | Contrato e fila | Pedido do NIGHT cria `video_job_id`; status, cancelamento, retomada e limite funcionam com dados de teste. |
| V2 | Roteiro e cenas | Um tema vira roteiro original, fontes e manifesto de cenas estruturado; afirmações sem fonte são sinalizadas. |
| V3 | Flow e ativos | 15 a 30 imagens são geradas e importadas com metadados; ausência do navegador fica em `aguardando_flow` sem perder trabalho. |
| V4 | Narração e render | Um vídeo curto de 60 a 90 segundos sai com áudio, imagens, legendas e prévia reproduzível. |
| V5 | Revisão com Joel | NIGHT apresenta a prévia e aplica uma correção de cena sem refazer o trabalho inteiro. |
| V6 | Segundo plano | Pesquisa e montagem continuam com o PC desligado; a etapa Flow segue o modo de acesso realmente configurado e documentado. |
| V7 | Escala editorial | Só depois do piloto, testar vídeos mais longos com medição de tempo, descarte de imagens, qualidade e custo. |

O primeiro piloto deve provar a cadeia completa com **um vídeo curto e original**. A rotina de canal, vídeos longos e publicação automática são decisões posteriores baseadas nos resultados desse piloto.
