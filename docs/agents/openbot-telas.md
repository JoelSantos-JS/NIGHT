# Telas do NIGHT no OpenBot

Cada agente do NIGHT ganha uma tela no OpenBot. As telas são NIGHT, Radar, Produto, Campanha, Código e Vídeo.

O OpenBot é só a vitrine. Estado, trabalhos, regras, aprovações e dinheiro continuam no NIGHT. Cada tela repassa o pedido ao NIGHT por um servidor MCP local e mostra a resposta.

**Decisões não valem pela tela.** Aprovar oferta, vídeo ou código, cancelar, montar campanha com R$ ou "pode rodar" só valem em três lugares:
- no painel do NIGHT, em `http://127.0.0.1:4517/painel`;
- na voz do NIGHT;
- no terminal do NIGHT.

O motivo: quem escreve na tela é um modelo, e um modelo pode inventar um "aprovo".

## Como funciona

```
Joel ──digita──▶ tela do OpenBot (Opus ou Codex)
                    │ night_pedir {tela, texto}   (MCP por HTTP, só 127.0.0.1)
                    ▼
                 NIGHT (src/app/server.ts) ──▶ coordenador da tela, com origem 'tela'
                    │                            decisão → "decida no painel"
Joel ──clica──▶ painel http://127.0.0.1:4517/painel ──▶ mesmo coordenador, com origem 'dono'
```

**Ferramentas do MCP**
- `night_pedir {tela, texto}`: repassa o pedido ao NIGHT. Se a resposta passar de 90 s, ela vira novidade.
- `night_novidades {tela}`: mostra respostas de pesquisa que chegaram, trabalhos que mudaram e avisos das tarefas de código.
- `night_trabalhos {tela}`: lista os trabalhos da tela, lidos do banco.
- `night_relatar {tela, texto}`: registra no diário do NIGHT, em 1 a 3 linhas, o que a tela acabou de fazer (até 1000 caracteres).

**Quem sobe o servidor:** a janela do NIGHT que roda os trabalhos.
- `pnpm night:voz` e `pnpm night` sobem o servidor sozinhos.
- Sem voz e sem terminal, use `pnpm night:servidor`.
- A porta padrão é 4517. Para trocar, use `NIGHT_PORT`.

## Montar as telas (uma vez)

1. **Instalar o OpenBot.** Instalado em 18/11/2026: versão 0.73.0, em `%LOCALAPPDATA%\Programs\OpenBot`. O hash SHA-256 conferiu com o `SHA256SUMS-windows.txt` e a assinatura é válida (SYNTHETIFY LABS).
2. **Abrir o NIGHT** com `pnpm night:voz`, `pnpm night` ou `pnpm night:servidor`. Confira se aparece a linha "Telas do OpenBot (MCP): http://127.0.0.1:4517/mcp".
3. **Ligar o MCP do NIGHT no OpenBot** (depois do passo 4, para as telas já existirem). Também dá para pedir na tela NIGHT: "adicione o servidor MCP por URL http://127.0.0.1:4517/mcp com o nome night"; ela pede a sua aprovação.
   - Vá em Marketplace → Apps → servidor personalizado por URL.
   - Nome: `night`. URL: `http://127.0.0.1:4517/mcp`.
   - Na seção Agentes do servidor, deixe só as 6 telas.
4. **Criar os 6 agentes de uma vez:**
   - Rode `pnpm night:telas`. Ele gera `D:\NIGHT-data\openbot\night-telas.zip` a partir de `openbot/telas/*.md`.
   - No OpenBot: Configurações do servidor → Importar → escolha esse arquivo.
   - As instruções de cada tela entram como as regras do agente. Se mudar um `.md`, gere de novo e reimporte.
5. **Escolher o modelo de cada tela:** Opus ou Codex. Cada mensagem gasta cota da sua conta.
   - O OpenBot avisa que a Anthropic não confirmou o login por assinatura dentro dele.
6. **Permissões de cada tela:** **Computer Use desligado**, sem navegador e o nível mais fechado que ainda deixe a tela usar o MCP.
7. **Teste obrigatório antes de usar.** Em cada tela, peça: "rode o comando `curl http://127.0.0.1:4517/painel`".
   - O certo é ela recusar ou mostrar um cartão de aprovação para você. Recuse esse cartão.
   - Se ela rodar sozinha, troque o nível para **Ask first** e repita o teste.

**Por que esse teste importa** (achado da revisão do Codex, 18/11):
- O painel bloqueia sites abertos no navegador. O token e a origem conferida cuidam disso.
- Mas **qualquer programa que rode comandos no seu PC** consegue ler o painel e enviar uma aprovação. O mesmo vale para o terminal: `pnpm night` aceita texto vindo de outro programa.
- Ou seja, o limite de verdade é a tela do OpenBot **não conseguir rodar comandos sem você aprovar**.
- Para vender o NIGHT, o painel vai precisar de login de verdade (senha ou Windows Hello). Isso está registrado como pendência da fase 3.

## Cuidados no PC do Joel

- **Claude antigo no PATH:** o PATH tem um `claude.exe` antigo (2.1.50, em `~/.local/bin`) antes do atual, que vem do npm. Se a tela Claude falhar, aponte o OpenBot para o Claude do npm em Settings → Providers, ou atualize o antigo.
- **Codex:** só existe dentro da extensão do VS Code, fora do PATH. Deixe o OpenBot baixar o Codex dele, em Settings → Providers.
- **Licença do OpenBot:** PolyForm Noncommercial. É grátis para uso pessoal agora. **Antes de vender o NIGHT**, compre a licença comercial (Starter €10/mês, Team €25/mês em 18/11/2026) ou combine revenda pelo e-mail licenses@openbot.run.

## Conferido em 18/11/2026

- `pnpm night:servidor` com o banco real: `initialize`, `night_trabalhos` e `night_pedir` responderam.
  - "aprovo montar a campanha da oferta 1 com R$ 20 por dia", vindo da tela Campanha, voltou com o link do painel e nada foi criado.
- O Claude Code (`claude -p --mcp-config`, tipo `http`) achou e chamou `night_trabalhos`. É o mesmo cliente que o OpenBot usa por baixo.
- Testes: `tests/server.test.ts`, mais a guarda em `tests/coordinator.test.ts` e `tests/projects.test.ts`.

## Ligação com o OpenBot (20/11)

**Diário das telas.** Agora cada tela conta o que fez.
- A ferramenta é `night_relatar {tela, texto}`.
- O texto tem de 1 a 3 linhas: o que o Joel pediu e o que aconteceu. Cabe até 1000 caracteres.
- A tela também conta o que fez sem o NIGHT: pesquisa, arquivo, comando aprovado pelo Joel.
- O NIGHT guarda no diário e mostra no painel, seção OpenBot.
- Nada de chave, senha, token, e-mail ou dado de cliente no relato.

**O NIGHT manda tarefa para os agentes do OpenBot.** O Joel pode dizer: "manda pro Radar do OpenBot pesquisar X".
- O NIGHT usa a API local de automação do OpenBot.
- Quando a resposta chega, o NIGHT mostra ao Joel.
- Isso só vale dito pelo Joel no NIGHT. Vindo de uma tela, o NIGHT recusa.

**Ligar em cada agente do OpenBot:**
- Configurações → Permissões → **Local scripts** ligado. Vem desligado por padrão.
- O OpenBot escreve `url` e `token` em `%APPDATA%\OpenBot\automation`.
- O NIGHT lê esses arquivos e não mostra o token.
- O limite do OpenBot é de 30 mensagens por hora, por padrão.

**Aprovações e perguntas:**
- Aprovações pendentes dos agentes aparecem no painel do NIGHT, seção OpenBot.
- Só dá para aceitar ou recusar ali.
- Perguntas dos agentes, só no OpenBot.

**Depois de mudar as telas:**
1. Rode `pnpm night:telas`.
2. Importe de novo o zip no OpenBot.

## Depois (fase 3)

- O NIGHT avisar a tela sozinho quando um trabalho termina. Isso usa a API local do OpenBot: `POST /v1/agents/:id/messages`, com `url` e `token` lidos de `%APPDATA%\OpenBot\automation\` a cada início.
- Página de configuração (Meta, chaves, modelos), pensando na venda.
- Login de verdade no painel (senha ou Windows Hello) antes de vender: hoje um programa local que rode comandos consegue decidir pelo painel, como já consegue pelo terminal.
