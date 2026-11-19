# NIGHT: passagem para o próximo chat

**Escrito em 19/11/2026.** Para um Claude novo, sem a memória desta conversa, e para o Joel. Leia inteiro antes de mexer, depois o [plano mestre](PLANO_MESTRE_NIGHT.md) e o [.agents/em-andamento.md](../.agents/em-andamento.md).

A passagem anterior, de 17/11, tem o detalhe de Radar, low-ticket, campanha na Meta e vídeo, e continua válida. Ela está no histórico: `git show 15ce5f5:docs/PROXIMO_CHAT.md`.

> **Objetivo do Joel:** vender o NIGHT como programa. O OpenBot entra só como ferramenta auxiliar (as "telas").
> **Foco:** Radar, anúncios na Meta e low-ticket. **O vídeo continua parado** até ele pedir.

---

## 1. Estado em uma olhada

- **Tudo commitado e no GitHub:** https://github.com/JoelSantos-JS/NIGHT, `main` em `8b79fea`.
  - **O repositório está PÚBLICO.** O Joel decidiu subir assim e disse que muda para privado depois. Enquanto estiver público, **nunca commite chave, e-mail ou dado pessoal**.
- **Testes:** `pnpm test` roda 695 testes e o `pnpm typecheck` está limpo.
  - De 1 a 4 testes do agendador (`tests/scheduler.test.ts`, que esperam por tempo) falham de forma alternada quando o PC está carregado (voz, OpenBot e Night abertos). Rodando de novo, passam. Ninguém mexeu nesse código.
- **Codex sem cota:** a cota semanal da conta do Codex está em 100% até **sexta, 20/11, às 13:57**. O OpenBot lê esse número e se bloqueia sozinho; o NIGHT não lê e segue chamando o Luna até a OpenAI recusar (aí cai no Claude).
- **Chave do Groq:** passou pelo chat. O Joel precisa trocá-la no painel do Groq e salvar a nova em `C:\Users\Joel\.groq\api_key`.

---

## 2. O que entrou desde 17/11

### 2.1 Telas no OpenBot + servidor MCP + painel
- **OpenBot 0.73.0** instalado em `%LOCALAPPDATA%\Programs\OpenBot` (hash e assinatura conferidos).
  - **6 telas importadas:** NIGHT, NIGHT Radar, NIGHT Produto, NIGHT Campanha, NIGHT Código e NIGHT Vídeo.
  - Para gerar o pacote: `pnpm night:telas`, que cria `D:\NIGHT-data\openbot\night-telas.zip` a partir de `openbot/telas/*.md`.
- **Servidor do NIGHT** ([src/app/server.ts](../src/app/server.ts)): escuta só em `127.0.0.1:4517` (`NIGHT_PORT`) e recusa Host e Origin de fora.
  - `/mcp`: MCP para as telas, com as ferramentas `night_pedir`, `night_novidades` e `night_trabalhos`.
  - `/painel`: a interface visual, escura, no estilo do OpenBot, com código e ícone próprios ([src/app/painel-ui.ts](../src/app/painel-ui.ts), [assets/night-icon.svg](../assets/night-icon.svg)). Mostra os agentes com conversa por agente, as decisões e as conexões.
  - `/api/estado`, `/api/pedir` e `/api/decidir`: exigem token e Origin.
  - Quem sobe o servidor é a janela que tem a trava: `pnpm night:voz` e `pnpm night` sobem sozinhos; sem voz e sem terminal, use `pnpm night:servidor`.
- **Guarda de decisões:** pedido vindo de tela tem origem `'tela'`.
  - Aprovar, rejeitar, cancelar, montar campanha com R$ e o "pode rodar" **não executam** por ali: voltam com o link do painel.
  - O painel e a voz/terminal são o dono.
  - Revisão do Codex feita (4 achados). Três foram corrigidos: campanha duplicada, histórico restaurado com corrida e histórico de uma tela vazando para outra.
  - O quarto ficou só documentado: qualquer programa local consegue usar o painel. Para vender, o painel vai precisar de login de verdade.
- Guia completo: [docs/agents/openbot-telas.md](agents/openbot-telas.md).

### 2.2 Voz (D-015, D-016 em [DECISIONS.md](DECISIONS.md))
- O Joel só tem o **fone Bluetooth BW06**, sem outro microfone. Em modo de ligação, ele corta o som acima de 4 kHz, o que derruba a transcrição.
- **Parakeet** (o motor do OpenBot) foi medido e não ajuda: 31,6% de erro. Ficou instalado para medir de novo com outro microfone.
- **Transcrição pelo Groq** (`whisper-large-v3`): 16,9% de erro, contra 29,4% do Whisper small local, em 0,5 s por fala. O idioma vem do próprio Groq.
  - `NIGHT_STT=auto` usa o Groq quando há chave e cai no Whisper local se ele falhar. `local` desliga o Groq.
  - O plano grátis aceita 20 pedidos por minuto.
- **Só a voz do dono** ([services/speech/night_speech/dono.py](../services/speech/night_speech/dono.py)): impressão de voz WeSpeaker pelo sherpa-onnx.
  - O perfil está em `D:/NIGHT-data/voz-dono.npy`, montado das 13 falas da calibragem.
  - O teste roda antes do Groq, então som que não é o Joel nem gasta cota.

### 2.3 Pesquisa no PC (D-017)
- `researchScope` no roteador escolhe entre **internet** (padrão), **PC** ("no seu código", "nos arquivos do Soaken", "no meu pc") e **os dois**.
- A pesquisa no PC (`ClaudeLocalResearch`, `CodexLocalResearch`):
  - lê só a pasta do projeto citado ou a do NIGHT, com Read, Grep e Glob;
  - não tem internet nem Bash;
  - não abre as pastas de chaves (`SECRET_PATHS`);
  - passa a resposta por `redactKeyLike`, que apaga o que parecer chave.
- "Os dois" roda as duas sessões separadas e um modelo sem ferramentas junta as respostas. Assim nenhuma sessão lê arquivo e abre página ao mesmo tempo.
- Teste real: o pedido para ler `~/.groq/api_key` foi recusado.

---

## 3. Pendências, em ordem

### 3.1 Voz: ajuste que ficou no meio (primeiro)
- **Limite da voz do dono está alto demais ao vivo.** Na calibragem, o Joel deu 0,80 a 0,93 de semelhança. Ao vivo deu 0,66 a 0,68 e foi rejeitado com o padrão do código, `NIGHT_SPEAKER_MIN=0.70`.
- **Como a janela de voz ficou aberta (provisório):** foi aberta à mão com `NIGHT_SPEAKER_MIN=0.58` e `NIGHT_SAVE_AUDIO_DIR=D:\NIGHT-data\falas-ao-vivo`, gravando as falas de hoje para ajustar o limite.
- **O que fazer:**
  1. Medir as falas de `D:\NIGHT-data\falas-ao-vivo` contra o perfil, usando `bench_dono.py` como base.
  2. Remontar o perfil incluindo essas falas (média da calibragem + ao vivo) e regravar `voz-dono.npy`.
  3. Escolher um limite com margem: acima das outras vozes (até 0,66 com som de Bluetooth) e abaixo do Joel ao vivo. Se não houver margem, avisar o Joel e manter o limite baixo.
  4. Trocar o padrão em `dono.py` e **parar de gravar falas**: abrir de novo pelo `Night.cmd`, sem as variáveis.
- **Frases fantasma:** o Whisper/Groq ainda inventa uma ou outra ("Thanks for watching"). A lista `HALLUCINATIONS` em `src/app/voice.ts` já filtra algumas.

### 3.2 Ligar o NIGHT às telas do OpenBot
- **Falta cadastrar o servidor no OpenBot:** Marketplace (ícone da loja) → Apps → servidor personalizado por URL, nome `night`, URL `http://127.0.0.1:4517/mcp`, liberado só para as 6 telas. Também dá para pedir na tela NIGHT do OpenBot e aprovar.
- **Modelo das telas:** **Claude Opus 5.5**, porque o Codex do OpenBot está sem cota até 20/11.
- **Testes depois de ligar:**
  - "mostra a oferta 1" na tela Radar responde pelo NIGHT;
  - "aprovo montar a campanha da oferta 1 com R$ 20 por dia" na tela Campanha devolve só o link do painel;
  - em cada tela, pedir para rodar `curl http://127.0.0.1:4517/painel`: a tela tem que recusar ou pedir aprovação.
- **Controle pelo mouse:** o Joel autorizou o Claude a clicar no OpenBot. O que funcionou:
  - script PowerShell com `SetProcessDPIAware`, Alt solto antes do `SetForegroundWindow` e `CopyFromScreen`, porque `PrintWindow` sai preto no OpenBot;
  - conferir que a janela da frente é do processo OpenBot **antes** de cada clique, e abortar se não for;
  - tirar print a cada passo.
  - O script ficou no scratchpad da sessão e se perdeu. Refazer se precisar.

### 3.3 Pedidos do Joel ainda não feitos
- **Seção "Modelos" no painel**, igual à página Providers do OpenBot:
  - cartão para Codex, Claude e DeepSeek, com conectado/versão/cota;
  - botão Conectar: login oficial para Claude e Codex, campo de chave para o DeepSeek, guardada fora do código;
  - escolha do modelo por papel (conversa, pesquisa, código, parecer).
- **Pular o Codex quando a cota estiver em 100%:** o percentual está em `~/.codex/sessions/**/rollout-*.jsonl`, campo `rate_limits` (`primary` = 5 h, `secondary` = semanal, `resets_at` em epoch). Ofereci e o Joel não respondeu.
- **WhatsApp como o OpenBot faz:** só pesquisado por voz, sem resposta registrada. Mandar mensagem é ação para fora, então precisa de aprovação do dono.

### 3.4 Da passagem de 17/11, ainda abertos
- **Meta (prioridade do negócio):** o Joel liga o conector (`claude mcp add --transport http meta-ads https://mcp.facebook.com/ads`, `/mcp`, chave "Editar status" sempre desligada) e passa o `act_…`. Depois, M01, M02/R01 e M04 real (seção 3 da passagem de 17/11).
- **Revisão do Codex que falta:** `src/ads/`, `src/lowticket/`, `src/radar/meta-mcp-source.ts` e os comandos novos. Também a pesquisa no PC, a voz pelo Groq e o painel novo (segurança). Rodar quando o Codex tiver cota (sexta) e tratar cada achado. **Nunca passar chave ao Codex nem ao DeepSeek.**
- **Comandos pequenos:** "como está o produto 1?", "mostra o produto da oferta 2" (L07), "cria os criativos da oferta 2" (L04) e a análise do teste por números ditados (L05/L06).
- **Antes de vender:** licença comercial do OpenBot (PolyForm Noncommercial; Starter €10/mês, Team €25/mês, ou acordo pelo licenses@openbot.run); login de verdade no painel; tirar o "Joel" do código (152 ocorrências); cada cliente com a própria chave de API; instalador.
- **Saldo do DeepSeek** baixo (US$ 0,11 em 17/11). Avisar antes de usar.

---

## 4. Variáveis de ambiente novas (todas opcionais)

| Variável | Para quê |
|---|---|
| `NIGHT_PORT` | Porta do servidor das telas e do painel (padrão 4517) |
| `NIGHT_STT` | `auto` (Groq se houver chave, senão local), `groq` ou `local` |
| `GROQ_API_KEY` ou `~/.groq/api_key` | Chave do Groq (fora do repositório) |
| `NIGHT_GROQ_STT_MODEL` | Padrão `whisper-large-v3` |
| `NIGHT_SPEAKER` | `off` desliga o filtro da voz do dono |
| `NIGHT_SPEAKER_MIN` | Semelhança mínima (código: 0.70; **precisa de ajuste**, ver 3.1) |
| `NIGHT_SPEAKER_MODEL`, `NIGHT_SPEAKER_PROFILE` | Modelo WeSpeaker e perfil `.npy` |
| `NIGHT_PARAKEET_DIR` | Modelo Parakeet (só para medição) |
| `NIGHT_SAVE_AUDIO_DIR` | Guarda cada fala em WAV (só para calibrar; desligar depois) |
| `NIGHT_RESEARCH_PC_CLAUDE_MODEL`, `NIGHT_RESEARCH_PC_CODEX_MODEL` | Modelos da pesquisa no PC (padrão `sonnet` e `gpt-6-luna`) |

As variáveis de 17/11 (banco, Meta, DeepSeek, modelos) continuam as mesmas.

**Modelos baixados** (fora do repositório):
- `D:/NIGHT-data/modelos/parakeet-tdt-0.6b-v3-int8` (650 MB)
- `D:/NIGHT-data/modelos/voz-dono/wespeaker_en_voxceleb_resnet34_LM.onnx`

---

## 5. Como trabalhar aqui (lições desta sessão)

- **Ambiente Python da voz** (`services/speech/.venv`): não tem pip. Instalar com `uv pip install --python .venv/Scripts/python.exe <pacote>`.
- **Python em heredoc no bash:** `\b` dentro de `python - <<'EOF'` virou caractere de backspace e quebrou expressões regulares. Para editar código com barras invertidas, escreva o script num arquivo e rode o arquivo.
- **Medir antes de trocar.** `bench_stt.py`, `bench_parakeet.py`, `bench_groq.py` e `bench_dono.py` usam as falas da calibragem (`D:\NIGHT-data\calibragem`). Foi a medição que mostrou que o problema era o microfone, não o modelo.
- **Prints do PC:** capturar só a janela do app (há conversas pessoais do Joel em outras janelas). No console do Night, cuidado com o "modo de seleção" do Windows, que congela o programa; Esc destrava.
- **Regras do Joel que valem sempre:**
  - nada de dinheiro real, publicação ou push sem pedido específico;
  - nunca credencial no código, no prompt ou no log;
  - respostas em português simples;
  - o Claude lidera e o Codex revisa mudanças grandes;
  - ler `.agents/em-andamento.md` no começo e anotar o que vai editar.
