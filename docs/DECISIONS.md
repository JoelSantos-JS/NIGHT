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
