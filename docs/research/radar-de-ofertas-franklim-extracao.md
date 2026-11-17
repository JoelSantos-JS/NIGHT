# Radar de Ofertas - extracao textual integral

Fonte: `Radar-de-Ofertas-franklim.pdf`. 9 paginas. Texto extraido na ordem das paginas; quebras de linha e espacos seguem a diagramacao do PDF.


## Pagina 1

GUIA PRÁTICO · 2026



RADAR DE
OFERTAS






Como montar um minerador de ofertas que roda sozinho todo dia
às 5h da manhã e entrega tudo pronto numa planilha. Com Claude
Cowork.
































Guilherme Franklim

Montagem em 15 minutos · Não precisa saber programar             @franklim.gui


## Pagina 2

O QUE VOCÊ VAI MONTAR



Um agente que varre a Biblioteca de Anúncios do Meta todo dia, pontua cada oferta que
encontra de 0 a 10 segundo um critério fixo, e escreve só as boas numa planilha do Google.
Você abre a planilha de manhã e escolhe.


Isso substitui a parte mais chata do jogo: ficar horas garimpando biblioteca de anúncios no olho. Você
deixa de procurar oferta e passa a escolher oferta.


O que você precisa

    Assinatura paga do Claude (o plano Pro já serve, é o mais barato)

    Uma conta Google qualquer

    Google Chrome instalado

    15 minutos para montar. Depois disso roda sozinho para sempre



     ANTES DE COMEÇAR

     Existe uma ferramenta parecida que apareceu essa semana e custa mais de mil reais por mês. Testei. É
     boa, mas para o que a gente vai fazer aqui o Claude entrega o mesmo resultado por uma fração do
     preço, e ainda constrói a oferta depois. Por isso o guia é com Claude.



Os 6 passos

1. Abrir o Cowork                                                                                                   2 min


2. Conectar o Google Drive                                                                                          1 min


3. Ativar o navegador                                                                                               3 min


4. Criar a planilha (com 1 prompt)                                                                                  2 min


5. Dar o cérebro para o agente                                                                                      3 min


6. Testar e agendar                                                                                                4 min

























                                     RADAR DE OFERTAS · @franklim.gui · pág. 2


## Pagina 3

1. ABRIR O COWORK




 1   Baixa o Claude Desktop em claude.com/download


 2   Abre e faz login com a sua conta paga


 3   No campo de mensagem, canto inferior esquerdo, clica em "Cowork"

É isso. Cowork não é um app separado nem tem preço separado, é um modo dentro do Claude que você
já paga. Se aparecer só "Chat" e não aparecer "Cowork", atualiza o app.

2. CONECTAR O GOOGLE DRIVE




 1   Configurações


 2   Conectores


 3   Google Drive, botão Conectar


 4   Autoriza na tela do Google

É por aqui que ele vai criar e preencher a planilha sozinho. Só isso. Não precisa conectar Gmail, agenda,
nem nada.

3. ATIVAR O NAVEGADOR



Instala a extensão Claude in Chrome. É ela que dá as pernas para o agente entrar na Biblioteca de
Anúncios e ler o que tem lá.



   FAZ ISSO OU PODE SE ARREPENDER

   Cria um perfil separado do Chrome e loga nele com um Facebook que não seja o administrador da
   sua BM principal. A extensão dirige o navegador com as SUAS sessões abertas. Você não quer navegação
   automatizada em massa acontecendo no perfil logado na conta que gera o seu dinheiro.



























                                   RADAR DE OFERTAS · @franklim.gui · pág. 3


## Pagina 4

4. CRIAR A PLANILHA



Você não vai montar planilha na mão. Cola o prompt abaixo no Cowork e ele cria tudo, formata
e te manda o link.



  PROMPT 1 · CRIAR A PLANILHA



      Cria no meu Google Drive uma planilha chamada "Radar de Ofertas"
      com duas abas.


      ABA 1, nome "PALAVRAS-CHAVE", coluna A, começando na linha 1:
      apenas R$ 47
      apenas R$ 67
      apenas R$ 97
      de R$ 197 por R$ 67
      acesso vitalício
      curso completo passo a passo
      método comprovado
      garantia de 7 dias


      ABA 2, nome "OFERTAS", cabeçalho na linha 1 nesta ordem:
      Data | Palavra-chave | Anunciante | Domínio | Anúncios ativos |
      Dias no ar | Nicho | Preço | Link do anúncio | Link da página |
      Ângulo | Nota | Justificativa | Status


      Deixa o cabeçalho em negrito com fundo cinza e congela a linha 1.
      Me manda o link quando terminar.



Por que a aba de palavras-chave existe

Porque ela é o seu volante. Quer minerar um nicho novo? Abre a planilha no celular, digita a palavra-
chave e fecha. No dia seguinte tem oferta daquele nicho esperando você. Sem tocar no computador.



      O TRUQUE DO PREÇO

      Repara que a lista busca por 47, 67 e 97, e não por 10. O jogo é achar oferta cara que já está validada, e
      vender a sua versão por 19,90. Quem procura oferta de 10 para vender a 10 está entrando num leilão que
      não dá para ganhar.




























                                      RADAR DE OFERTAS · @franklim.gui · pág. 4


## Pagina 5

5. DAR O CÉREBRO PARA O AGENTE



No Cowork, cria um Projeto chamado "Radar de Ofertas" e cola o texto abaixo no campo de
instruções do projeto. Isso é o que separa achar oferta de achar oferta boa.



  PROMPT 2 · O CÉREBRO



     Você é meu analista de mineração de ofertas low ticket.


     CONTEXTO: pego ofertas validadas de 47/67/97 reais, crio minha
     própria versão e vendo por 19,90. Preciso de ofertas CARAS e
     validadas, nunca de ofertas que já estão baratas.


     TAREFA: varrer a Biblioteca de Anúncios do Meta com as palavras-
     chave da aba PALAVRAS-CHAVE, pontuar pela rubrica, e registrar
     só as de nota 6 ou mais na aba OFERTAS com Status = novo.


     RUBRICA (0 a 10):
     1. Anúncios ativos no domínio (0-3)
        1-10 = 0 | 11-30 = 1 | 31-80 = 2 | 80+ = 3
     2. Dias no ar do anúncio mais antigo (0-2)
        menos de 7 = 0 | 7 a 30 = 1 | mais de 30 = 2
     3. Outros anunciantes rodando o mesmo nicho (0-2)
        só ele = 0 | 2 a 3 = 1 | 4 ou mais = 2
     4. Preço de origem (0-2)
        abaixo de 37 = 0 | 37 a 67 = 1 | acima de 67 = 2
     5. Dá para entregar em PDF sem gravar vídeo (0-1)


     A justificativa sempre vem quebrada por critério, assim:
     "3+2+1+2+1 = 9. 94 anúncios ativos, 41 dias no ar,
     5 anunciantes no nicho, origem R$97, entregável em PDF."


     NUNCA:
     - copiar texto ou imagem de ninguém, você só registra dados
       públicos de anúncio e descreve o ângulo com suas palavras
     - repetir domínio que já está na planilha, confere antes
     - inventar número. Se não conseguir ver, escreve "não visível"


































                                      RADAR DE OFERTAS · @franklim.gui · pág. 5


## Pagina 6

A RUBRICA, EXPLICADA



Se você levar só uma coisa desse PDF, leva essa tabela. Ela funciona com IA, sem IA, e vai
continuar funcionando quando essas ferramentas todas mudarem de nome.



  CRITÉRIO                     PESO            POR QUE IMPORTA


  Anúncios ativos             0 a 3            É o termômetro mais honesto que existe. Ninguém paga para manter 80
  no domínio                                   anúncios no ar por hobby. Se está no ar em volume, está vendendo.


  Dias no ar                  0 a 2            Anúncio de 3 dias pode ser teste que vai morrer amanhã. Anúncio de 40
                                               dias já provou que fecha a conta.


  Outros                      0 a 2            Concorrência assusta iniciante e alegra operador. Vários caras no mesmo
  anunciantes                                  nicho significa que o nicho tem dinheiro, não que está lotado.


  Preço                       0 a 2            Quanto mais caro o que está validado, maior o desconto que você
  de origem                                    consegue aplicar. É daqui que sai a sua vantagem no leilão.


  Entregável                  0 a 1            Se o produto exige você gravar 40 aulas, não é MVP. Se cabe em PDF e
  viável                                       área de membros, você sobe amanhã.





    CORTE

    Nota abaixo de 6 nem entra na planilha. O valor de um filtro está no que ele barra, não no que ele deixa
    passar. Planilha com 200 ofertas medianas não vale nada. Planilha com 12 ofertas nota 8 vale o mês
    inteiro.










































                                        RADAR DE OFERTAS · @franklim.gui · pág. 6


## Pagina 7

6. TESTAR E AGENDAR



Nunca agende uma automação que você não viu funcionar. Roda uma vez na sua frente
primeiro.



  PROMPT 3 · TESTE



     Roda uma mineração agora. Limite de 5 ofertas.
     Me avisa quando terminar.



Acompanha ele trabalhando. Se aparecer CAPTCHA, você resolve na hora e ele continua. Confere se as 5
linhas que entraram fazem sentido. Se a nota estiver esquisita, ajusta a rubrica antes de agendar, não
depois.


  PROMPT 4 · AGENDAR


     Agenda essa tarefa para rodar todo dia às 05:00,
     minerando até 15 ofertas novas por vez.



Tarefas agendadas do Cowork rodam na nuvem. Notebook fechado, celular no bolso, ele trabalha do
mesmo jeito.


Sobre limite de uso

Cowork é agêntico, ele navega e tira print, então gasta bem mais que uma conversa normal. No plano
Pro, 10 a 15 ofertas por dia roda tranquilo. Se você mandar varrer 50 palavras-chave de uma vez, estoura o
limite. Começa pequeno.









































                                     RADAR DE OFERTAS · @franklim.gui · pág. 7


## Pagina 8

ACHOU A OFERTA. E AGORA?



A planilha é meia obra. Ela te diz o que construir. A outra metade é construir rápido, porque
oferta parada na planilha não paga boleto.


A vantagem de ter feito tudo no Claude é que a construção acontece na mesma assinatura. Você não
troca de ferramenta, não paga outra coisa. Pega a linha da planilha e manda construir.


  PROMPT BÔNUS · DO DADO AO MVP


     Peguei essa oferta da minha planilha Radar de Ofertas:


     Nicho: [cola aqui]
     Domínio de origem: [cola aqui]
     Preço de origem: [cola aqui]
     Ângulo principal: [cola aqui]


     Quero criar a MINHA versão dessa oferta, com marca própria,
     conteúdo original e preço de 19,90. Não copie nada do
     material do outro anunciante, use apenas como referência
     de mercado.


     Me entrega:
     1. Nome e posicionamento da minha oferta
     2. Estrutura do entregável em 4 PDFs + 1 bônus liberado
        após 7 dias (para reduzir reembolso)
     3. Estrutura da página de vendas, seção por seção
     4. 5 ângulos de criativo em imagem, com o prompt pronto
        para eu gerar cada um



A ordem certa

 1    Planilha entrega a oferta com nota alta


 2    Você constrói o MVP em minutos, não em dias


 3    Sobe o teste com orçamento pequeno


 4    Se não vender, manda os números para a IA analisar e diz onde está o furo


 5    Se vender, sobe o orçamento de 30% em 30%, e nunca dobra, porque dobrar reseta o aprendizado

























                                     RADAR DE OFERTAS · @franklim.gui · pág. 8


## Pagina 9

3 REGRAS PARA NÃO SE FERRAR



1. Perfil separado, sempre

Já falei no passo 3 e vou falar de novo porque é o erro mais caro. Navegação automatizada no perfil que
administra a sua BM principal é risco desnecessário. Perfil separado, Facebook separado, cinco minutos
para configurar.


2. O agente lê, mas não assina nada

Ele vai ler páginas de vendas de terceiros. Página de terceiro pode conter instrução escondida
direcionada a agentes de IA. Por isso, nesse fluxo, ele só tem permissão de ler a biblioteca e escrever na
planilha. Nada de acesso ao seu checkout ou ao seu gerenciador de anúncios sem aprovação sua.


3. Inspiração não é cópia

O agente registra dado público de anúncio e descreve o ângulo com as próprias palavras. Ele não clona
página, não baixa criativo, não copia texto. Isso não é frescura, é o que separa construir um ativo de
construir um problema. E, na prática, a sua versão fica melhor justamente porque foi feita do zero com
preço menor.



    A PARTE QUE NINGUÉM FALA

    Automação não te dá resultado. Ela te dá tempo. O que você faz com o tempo que sobrou é o que
    decide se isso aqui virou dinheiro ou virou mais um print bonito para postar no story.



                                          TRAVOU EM
                                     ALGUM PASSO?

                Me manda no direct qual nicho você está mirando e onde você travou. Sou eu
                  mesmo que respondo, sem automação e sem robô. A gente vê se dá para
                                                      destravar.


                                              @franklim.gui




















                                    RADAR DE OFERTAS · @franklim.gui · pág. 9
