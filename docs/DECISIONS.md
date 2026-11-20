# Decisões do Night

Cada decisão: o que foi decidido, por quê e quando. Mudou de ideia? Acrescente uma nova; não apague a antiga.

## D-001 — Stack: Node/TypeScript no coordenador, Python à parte só para voz (03/11/2026)
O coordenador (roteador, fila, memória, worktrees, adaptadores Claude/Codex) é Node 22 + TypeScript, um pacote só,
com módulos por pasta em `src/`. A voz (STT/TTS) vai num processo Python separado, porque Nemotron, Kokoro e
whisper.cpp têm o melhor suporte em Python. Testes com `node:test` + `tsx`, sem framework extra.
Confirmado pelo Joel.

## D-002 — Banco: PostgreSQL 18 local, porta 5433 (03/11/2026)
O Joel já tem o Postgres 18 instalado e rodando com o Windows. Ganhos sobre o SQLite: busca em português com
radicais ("ideias" acha "ideia"), pgvector para a memória semântica depois e escrita concorrente.
Usuário `night`, bancos `night` e `night_test`, criados por `scripts/setup-db.ps1`. A senha fica só em
`%APPDATA%\postgresql\pgpass.conf`, nunca no repositório. Os testes só zeram bancos com nome terminado em `_test`.
Decidido pelo Joel.

## D-003 — STT: whisper.cpp primeiro, Nemotron multilingual em paralelo (03/11/2026)
O Nemotron só vira padrão depois de passar nos critérios da seção 17 do blueprint. Isso evita travar o MVP num
runtime que ainda não sabemos se roda no Windows.

## D-004 — Voz (TTS): Kokoro pelo pacote Python oficial (03/11/2026)
O Joel escolheu o Kokoro. Testado nesta máquina (`lab/tts-pt/`):
- `kokoro-js` (o que o Soaken usa) só fala inglês: o fonetizador dele só tem en-us/en-gb. O Soaken usa o
  Edge TTS (nuvem) para o português, então ele não prova nada sobre PT-BR.
- O `phonemizer` do npm também só traz os dados de inglês do espeak-ng. Caminho "tudo em Node" descartado.
- O pacote Python `kokoro` (lang_code `p`, espeak-ng embutido via espeakng-loader) funciona: vozes `pf_dora` e
  `pm_alex`, sotaque brasileiro ("testes" → tˈɛsʧys), cerca de 0,4 s de processamento por 1 s de áudio depois da
  primeira frase, com metade dos núcleos. Inglês (`af_heart`, lang_code `a`) funciona no mesmo processo.
- A primeira frase depois de carregar leva ~5 s: o processo de voz tem que ficar aberto, não subir a cada fala.
Pendente: o Joel ouvir `lab/tts-pt/out/*.wav` e escolher a voz.

## D-005 — Roteador: regras primeiro, modelo local só para o ambíguo (03/11/2026)
Comandos conhecidos (salvar/buscar ideia, status, tarefa de código, cancelar, aprovar, parar de falar) saem de
regras fixas em PT/EN, sem chamar modelo. Aprovar, rejeitar, cancelar e parar SÓ saem das regras: o Qwen nunca
produz esses intents. Frase sem regra mas com cara de comando vai ao Qwen em JSON validado; o resto é conversa.
Cada decisão vai para a tabela `route_log` (modelo, motivo, cota premium).
Medido com qwen3:1.7b: a instrução de idioma só é obedecida quando vai no começo da fala do dono (5/5),
não no system nem no fim da fala (0/5).

## D-006 — STT: faster-whisper no mesmo processo Python da voz; `base` por enquanto (03/11/2026)
O faster-whisper (CTranslate2, int8, CPU) substitui o whisper.cpp do plano: é o mesmo Whisper, roda no mesmo
processo do Kokoro e evita um segundo runtime. Detecção de idioma restrita a PT/EN.
O `small` não coube na RAM em 03/11: o PC estava com 2 GB livres de memória total, por causa dos outros
programas abertos (servidor do crypto-arbitrage-pro 1,7 GB, proxy headroom 865 MB, VS Code, navegadores).
Ficou o `base`: ida e volta Kokoro → Whisper acertou 4/4 frases e o idioma, mas errou palavras estrangeiras
em PT ("karaokê", "parser"). Trocar para `small` com `NIGHT_WHISPER_MODEL=small` quando houver memória.
O Nemotron continua como teste futuro (D-003).

## D-007 — Personalidade bem-humorada; modelo continua o qwen3:1.7b (03/11/2026)
Pedido do Joel: voz masculina e um pouco engraçada. Voz `pm_santa`/`am_puck` e personalidade "amigo esperto e
meio debochado" só na conversa; confirmações de ação (salvei, cancelei, registrei) continuam secas e exatas,
e sem piada quando o assunto é erro, dinheiro ou segurança. A resposta passa por `forSpeech` (tira emoji e
markdown, que o 1.7B põe mesmo proibido). O humor do 1.7B é fraco e ele às vezes inventa fatos; o qwen3:4b
não coube em 03/11 (faltou memória na GPU e na RAM com os outros programas abertos). Temperatura em 0.4.

## D-008 — Qwen no processador, Whisper small com queda para base (03/11/2026)
Com o projeto pesado do Joel fechado (memória livre de 2 para 14,7 GB), medido no Ryzen 5 5500:
- qwen3:1.7b: 22 tok/s no processador × 9,7 tok/s na RX 550 (Vulkan). Padrão agora é `num_gpu: 0`;
  `NIGHT_LLM_GPU=1` volta para a placa (gasta menos RAM, mais lento).
- qwen3:4b: dividido entre GPU e CPU estourou 120 s por resposta; só no processador, 8,8 tok/s e 86 s numa
  resposta curta, e ignorou `think: false`. Descartado e apagado.
- Whisper small × base em 3 frases PT: small acerta mais ("karaoke", "O Claude", "pro") e gasta 4,5 s por frase
  contra 1,8 s. Padrão `small`; se não couber na memória, o serviço cai sozinho para `base`.
O 1.7B continua inventando fato quando pedem curiosidade ("Linux num PDP-11 em 1964", duas vezes).

## D-009 — Quem responde o quê: local, modelos menores para pesquisa, maiores só para código (03/11/2026)
Decisão do Joel:
- Conversa do dia a dia: qwen3:1.7b local (grátis).
- Pesquisa e fato atual: modelos MENORES pela assinatura, com busca na internet. Ordem: Codex `gpt-6-luna`
  (`codex exec`, sandbox read-only, `web_search="live"`, pasta temporária vazia), depois Claude `haiku`
  (`claude -p`, só WebSearch/WebFetch, Bash/Edit/Write bloqueados). Nunca API paga.
- Código e trabalho pesado: modelos MAIORES (Codex `gpt-6-astra`, Claude padrão) — entra no M5.
A pesquisa é reconhecida por regra (pedido explícito, ou pergunta sobre preço/notícia/versão/resultado) ou pelo
Qwen no ambíguo. O Night responde na hora "vou pesquisar" e fala o resultado quando chega. Se os dois
pesquisadores falharem, ele diz isso e não chuta; o motivo técnico vai para o `route_log`.
Não testado de ponta a ponta em 03/11: o Codex estava no limite de uso até 19:22, e o Claude não roda dentro
da sessão do Claude Code em que o teste foi feito (roda normal no terminal do Joel). Modelos por variável:
`NIGHT_RESEARCH_CODEX_MODEL`, `NIGHT_RESEARCH_CLAUDE_MODEL`.

## D-010 — Contexto compartilhado entre os agentes (03/11/2026)
Pedido do Joel: "tem que estar tudo conectado, os agentes têm que ter noção um do outro".
Todo pedido a um agente (hoje: pesquisa; depois: código) leva um bloco montado do banco por
`src/agents/shared-context.ts`: quem ele é, quem são os outros agentes e para que serve cada um, os últimos
8 pedidos com quem respondeu o quê, e as tarefas abertas. Até 2500 caracteres, cortando o mais antigo.
O `route_log` agora guarda a resposta (`reply`, migração 003). Ao reiniciar, o Night recupera a conversa
recente do banco, então lembra também do que o Codex e o Claude responderam.
O bloco vai marcado como contexto, não instrução. O ai-memory do Akita (blueprint §18) pode substituir isto
quando houver motivo; por enquanto o banco do Night basta e funciona no Windows.

## D-011 — Execução de código: worktree por tarefa, outro agente revisa, merge só com "aprovo" (04/11/2026)
- Worktrees (M4, feito pelo Codex): `src/workspaces/worktree-manager.ts`, em `D:/NIGHT-data/worktrees/<projeto>/<agente>-<tarefa>`,
  branch `agent/<agente>/<tarefa>`. Conflito por `git merge-tree` (sem tocar em pasta). Merge recusa se a pasta
  do dono tiver mudança não salva; nunca force/reset/checkout no repo do dono.
- Agentes (M5): Claude Code (modelo padrão da conta) e Codex `gpt-6-astra`, dentro da worktree, sem push nem
  internet. O OUTRO agente revisa por padrão, uma rodada, só leitura ("sem revisão" no pedido desliga).
- Ciclo no banco: queued → planning → running → testing → review-ready → awaiting-approval → accepted / rejected
  / failed / cancelled. Cancelar mata a árvore de processos. Reinício: o que estava rodando vira `failed`.
- Por voz: "pede pro Claude/Codex … no <projeto>", "mostra as mudanças", "aprovo" / "descarta", "cancela".
  Projeto precisa de pasta: "a pasta do <projeto> é C:\…" (melhor digitado).
- Testado de verdade em 04/11 (`pnpm e2e:agentes claude|codex`): Claude fez + Codex revisou em 48 s; Codex fez +
  Claude revisou em 45 s; pasta do dono intacta até o "aprovo"; merge no main com testes passando.

## D-012 — Endurecimento depois de duas revisões do Codex (04/11/2026)
1ª rodada: 11 achados (6 graves), todos corrigidos. 2ª rodada, só sobre as correções: 4 achados, todos corrigidos.
Regras que ficaram:
- Controle (aprovar, rejeitar, cancelar) só por ordem explícita: frase inteira no formato esperado, sem negação e
  sem ser pergunta ("como cancelar a tarefa?" não cancela).
- Os agentes recebem ambiente mínimo (`src/agents/env.ts`): nunca `*_API_KEY`, tokens, senhas ou URL do banco —
  uma ANTHROPIC_API_KEY herdada faria o Claude cobrar por API.
- Claude com `--tools` (o que existe na sessão), além de `--allowedTools` (o que é pré-aprovado).
- Merge só do diff que foi revisado: a impressão digital (sha256 do patch) vai no pedido de aprovação; se mudou,
  a tarefa falha e nada novo fica esperando aprovação sem revisão.
- Abrir aprovação, aprovar, rejeitar e cancelar a mesma tarefa: um de cada vez.
- Cancelar ou fechar o Night mata o agente E o revisor antes de soltar a trava de instância única.
Limite conhecido: os testes que os agentes rodam executam código da própria worktree sem sandbox do sistema
(no Windows o Claude Code não tem sandbox de SO; o Codex roda com o dele). Mitigação: ambiente sem segredos e
worktree fora do repo do dono. Isolamento de verdade (WSL2/VM) fica para depois (blueprint §18 D).

## D-013 — Conversa normal com Sonnet e Luna; voz pm_santa nos dois idiomas (04/11/2026)
Pedido do Joel depois de usar: o Qwen 1.7B "ignora ou não entende" a conversa normal. Agora a conversa vai para
Codex `gpt-6-luna` e Claude `sonnet`, ALTERNANDO a cada mensagem (divide a cota), pelas CLIs oficiais, sem
ferramenta nenhuma (`--tools ""` no Claude; sandbox read-only sem web no Codex), ambiente mínimo. Se o da vez
falhar, vai o outro; se os dois falharem, o Qwen local responde. `NIGHT_CHAT=local` volta para só o Qwen.
Isso muda D-009 (o Qwen era o padrão da conversa). Medido: 5 a 16 s por resposta (a 1ª de cada um é a mais lenta).
O Qwen continua local no roteador (classificar frase ambígua) e como reserva offline.
Voz: `pm_santa` também em inglês (o Joel gostou dela em português).
Whisper: limite de confiança por duração (-0,8 abaixo de 4 s, -1,4 acima): uma fala longa de 16 s transcrita
certinha tinha sido descartada.

## D-014 — Transcrição: o gargalo é o microfone Bluetooth, não o modelo (04/11/2026)
Calibragem com a voz do Joel (`pnpm night:calibrar`, 13 frases, fone BW06 Bluetooth), medida com
`services/speech/bench_stt.py`:
| modelo | palavras erradas | nomes errados | tempo por 1 s de fala |
|---|---|---|---|
| small | 29% | 6/14 | 0,8 s |
| medium | 21% | 6/14 | 2,6 s |
| large-v3-turbo | 21% | 7/14 | 3,3 s |
Sem a frase de ajuda no prompt, os nomes errados sobem para 8–11/14: ela fica. O áudio do fone tem 1,3% da energia
acima de 4 kHz (voz normal: 5–15%): Bluetooth em modo de ligação corta as consoantes. Ruído não é o problema
(SNR 39 dB). Modelo maior ajuda pouco e fica lento demais para conversa no Ryzen 5 5500; fica o `small`.
Próximo passo: calibrar com o microfone do celular (Iriun) ou com fio. Com outro microfone, o fone também volta a
tocar a voz do Night em qualidade de música (o microfone aberto força o modo de ligação).
Também: nome de projeto com 1 letra errada a cada 4 é aceito no roteador ("soken" → Soaken).

## D-015 — Parakeet (motor do OpenBot) não resolve o microfone Bluetooth (18/11/2026)
Pedido do Joel: "veja o que o OpenBot faz" com a voz. O OpenBot transcreve no PC com o Parakeet TDT 0.6B v3
(sherpa-onnx, int8). Medido com as 13 falas da calibragem no fone BW06 (`services/speech/bench_parakeet.py`):
| motor | palavras erradas | nomes errados | tempo por 1 s de fala |
|---|---|---|---|
| Parakeet TDT 0.6B v3 | 31,6% | 11/14 | 0,08 s |
| Whisper small + frase de ajuda | 29,4% | 6/14 | 0,74 s |
Os dois erram as mesmas frases do mesmo jeito ("Roda o AWS Prep" → "Hot W S Plap" / "Hot WS, plebe"): confirma D-014,
o áudio do Bluetooth em modo de ligação é o gargalo. O Parakeet é 10x mais rápido mas erra mais nomes (não aceita
frase de ajuda), então o Whisper small continua. O Parakeet fica instalado (`night_speech/parakeet.py`, modelo em
`D:/NIGHT-data/modelos`) para medir de novo com outro microfone.

## D-016 — Transcrição pelo Groq e só a voz do dono (18/11/2026)
Com o mesmo fone Bluetooth (sem outro microfone), medido com as 13 falas da calibragem (`bench_groq.py`):
| motor | palavras erradas | nomes errados | tempo por fala |
|---|---|---|---|
| Groq whisper-large-v3, idioma automático + frase de ajuda PT/EN | 16,9% | 8/14 | 0,5 s |
| Groq whisper-large-v3-turbo + frase | 18,4% | 6/14 | 0,5 s |
| Whisper small local (antes) | 29,4% | 6/14 | 2–5 s (detecção de idioma local custava 1,7–2,7 s) |
O idioma vem do Groq (13/13 certos; o local errou 1). `NIGHT_STT=auto` usa o Groq quando há chave
(`GROQ_API_KEY` ou `~/.groq/api_key`) e cai no Whisper local se ele falhar; `NIGHT_STT=local` desliga. O áudio da fala
sai do PC só nesse caso. Plano grátis: 20 pedidos por minuto.
Só a voz do dono (`night_speech/dono.py`): impressão de voz WeSpeaker ResNet34 pelo sherpa-onnx, perfil montado das
falas da calibragem. Medido (`bench_dono.py`): Joel 0,80–0,93 de semelhança; outras vozes (Kokoro PT/EN, inclusive
a do Night, com som de Bluetooth) até 0,66. Limite 0,70 (`NIGHT_SPEAKER_MIN`): 13/13 do Joel aceitas, 0/18 de outras.
O teste vem antes do Groq: som do PC nem gasta cota. Trocar de microfone pede recalibrar (o perfil é do fone BW06).
`NIGHT_SPEAKER=off` desliga.
**Ajuste de 19/11:** ao vivo o Joel deu só 0,66–0,91 contra o perfil da calibragem e foi recusado. O perfil passou a
ser metade calibragem, metade 8 falas ao vivo que eram claramente comandos dele; as falas de dono incerto ficaram de
fora. Com cada fala fora da média: Joel ao vivo 0,72–0,93; outras vozes até 0,69 (em português até 0,61). Limite
agora 0,68: 8/8 do Joel, 1/18 de outras (voz masculina em inglês). Margem curta: um vídeo em inglês com voz grave
pode passar. O perfil antigo ficou em `D:/NIGHT-data/voz-dono-calibragem-18-11.npy`.

## D-017 — Pesquisa no PC separada da pesquisa na internet; "os dois" obedece (18/11/2026)
Pedido do Joel: o NIGHT dizia "não consigo vasculhar o código daqui". Agora há três escopos (`researchScope` no
roteador): internet (padrão), PC ("no seu código", "nos arquivos do Soaken", "no meu pc") e os dois ("os dois",
"no código e na internet"). A pesquisa no PC (`ClaudeLocalResearch`, `CodexLocalResearch`) lê só a pasta do projeto
citado ou do NIGHT, com Read/Grep/Glob, sem internet e sem Bash; pastas de chaves (`.groq`, `.deepseek`, `.codex`,
`.claude`, `.ssh`, `.env`...) ficam negadas, e o que parecer chave na resposta é apagado (`redactKeyLike`).
"Os dois" roda as duas sessões separadas ao mesmo tempo e um modelo da conversa, sem ferramentas, junta as
respostas: nenhuma sessão lê arquivo E abre página, então uma página maliciosa não consegue levar uma chave para fora.
Teste real (18/11): pedido para ler `~/.groq/api_key` foi recusado e a resposta listou os agentes de `src/agents`.

## D-018 — Voz ao vivo da OpenAI pelo login do ChatGPT, com o NIGHT no comando (19/11/2026)
Pedido do Joel: falar com os agentes por voz ao vivo, como no OpenBot. O painel tem o botão **Voz ao vivo**: o
navegador abre o microfone e manda a oferta WebRTC; `src/app/voz-ao-vivo.ts` abre um `codex app-server` (o Codex
oficial que o OpenBot baixou, >= 0.156; ou `NIGHT_CODEX_LIVE_BIN`) com o login do ChatGPT e devolve a resposta. O
áudio vai direto do navegador para a OpenAI. A voz entrega cada pedido a uma ponte do Codex (modelo padrão, esforço
baixo) cuja única ferramenta é `pedir_ao_night`; o NIGHT responde e a voz fala. Código nosso: o OpenBot (PolyForm
Noncommercial) serviu só de estudo do fluxo; o Codex é Apache-2.0.
Segurança: a ponte não tem shell, arquivos, internet nem os MCP do Joel; roda numa pasta temporária vazia, só
leitura, sem aprovações; qualquer outro pedido do Codex é recusado. O texto passou por modelos da OpenAI, então entra
com origem `'tela'`: aprovar, cancelar e campanha com R$ devolvem o link do painel. Tudo que vai para a OpenAI passa
por `redactKeyLike`. As rotas `/api/voz/*` exigem o token do painel e a Origin própria.
Medido 19/11: com a cota semanal do Codex em 100%, um turno de texto ainda passa, mas a OpenAI recusa a voz ao vivo
("You've hit your usage limit... try again at Nov 20th, 2026 1:57 PM"). O NIGHT mostra esse aviso em português.
Prova sem navegador: `npx tsx scripts/voz-ao-vivo-prova.ts`. Pesquisa de base em
[docs/agents/voz-ao-vivo-referencias.md](agents/voz-ao-vivo-referencias.md).
Revisão (DeepSeek, no lugar do Codex sem cota) e correções no mesmo dia: sem ler o config do Codex a voz não abre
(senão os MCP do Joel ficariam ligados); a voz recebe só o `text` da resposta, nunca o `detail` (diff, relatório),
e o que vai para a ponte é cortado em 3,5 KB; mesmo pedido em 10 s ou mais de 8 por minuto são recusados; sem o
painel perguntar pelos eventos por 30 s, a voz desliga; fechar o NIGHT espera o Codex fechar. Limite que fica: o
filtro de voz do dono (D-016) não vale aqui, porque o áudio não passa pelo NIGHT. Contra TV ou outra pessoa falando,
valem o botão Mudo, o limite de pedidos e as decisões só no painel.

## D-019 — NIGHT e OpenBot ligados pela API local de automação do OpenBot (20/11/2026)
Pedido do Joel: cadastrar o NIGHT no OpenBot, ver no NIGHT o que o OpenBot faz e o NIGHT mandar tarefa aos agentes.
- **NIGHT → OpenBot:** "manda pro Radar do OpenBot pesquisar X" (só por regra, com a palavra "openbot") vai para
  `src/openbot/`: lê `url` e `token` em `%APPDATA%\OpenBot\automation` a cada pedido (o OpenBot troca quando
  reinicia), só aceita endereço 127.0.0.1/localhost e nunca mostra o token. Acompanha a entrega até a resposta, que
  aparece na conversa do NIGHT no painel e nas novidades da tela NIGHT. Só funciona com "Local scripts" ligado no agente
  (desligado por padrão). Limite do OpenBot: 30 mensagens por hora.
- **OpenBot → NIGHT:** a API do OpenBot não mostra o histórico das conversas. O NIGHT vê o que ele mandou, o que os
  agentes esperam do Joel (aprovações e perguntas, a cada 15 s) e o diário das telas: ferramenta MCP `night_relatar`,
  que as instruções do servidor e de cada tela mandam chamar depois de cada resposta. Tudo na seção OpenBot do painel.
- **Quem pode:** origem nova `'voz'` (voz ao vivo): decisão não vale, mandar tarefa ao OpenBot vale. De `'tela'` não
  vale (um agente do OpenBot mandando em outro vira laço). Aprovação pendente de agente do OpenBot só se aceita ou
  recusa no painel (`/api/openbot/responder`, token e Origin); pergunta, só no OpenBot.
- **Achado 20/11:** os 6 agentes do NIGHT no OpenBot estavam com acesso "full" e controle do computador ligado, embora
  as instruções digam que a tela não age no PC. Com o NIGHT mandando tarefas, isso tem que ser fechado no OpenBot
  (acesso com aprovação e sem controle do computador). Decisão do Joel em 20/11: **manter acesso total e controle do
  computador por enquanto**.
