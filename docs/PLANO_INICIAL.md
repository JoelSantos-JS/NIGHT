# Night — Plano inicial e divisão Claude × Codex

**Data:** 03/11/2026 · **Base:** `NIGHT_BLUEPRINT_V2.md` · **Estado:** rascunho do Claude, aguardando revisão do Codex e aprovação do Joel.
**Regra de liderança:** o Claude lidera; o Codex revisa e dá a segunda visão. Cada arquivo/worktree tem **um único dono** por vez.

---

## 1. Fatos do ambiente (verificados em 03/11)

| Item | Situação | Consequência |
|---|---|---|
| CPU / RAM / GPU | Ryzen 5 5500, 16 GB (≈800 MB livres na hora do teste), RX 550 4 GB | Tudo na CPU. RAM é o gargalo: medir com VS Code + agentes abertos |
| Disco | C: 21 GB livres (o Joel liberou espaço), D: 22 GB livres | Modelos grandes de preferência no D: |
| Node / pnpm / Python / uv / git | 22.16 / 10.14 / 3.13.1 / 0.12.6 / 2.47 | OK |
| Claude Code CLI | 2.1.273 no PATH | OK para o adaptador |
| Codex CLI | 0.155.0-alpha só pela extensão do VS Code, fora do PATH | Adaptador recebe o caminho por configuração (`CODEX_BIN`) |
| Ollama | 0.40.14 + qwen3:1.7b, rodando na RX 550 via Vulkan (~10 tokens/s) | OK. O app da bandeja não sobe o servidor sozinho: a investigar |
| D:\NIGHT | Repositório git iniciado em 03/11 (branch main) | OK |
| PostgreSQL | 18 rodando na porta 5433 (o 17 também está instalado) | Banco do Night (D-002) |
| Soaken | O app é `Desktop\PROFESSOR\tutor-pc` (`Desktop\Soaken` é só o site) | Lido com permissão em 03/11; o Kokoro de lá só fala inglês (D-004) |

## 2. Decisões de stack (propostas)

1. **Coordenador em TypeScript/Node** (`src/`, um pacote só): roteador, fila, memória, adaptadores Claude/Codex, worktrees e aprovações. Chamar as CLIs como processos é simples em Node.
2. **Voz num processo Python separado** (`services/speech`), falando com o Node por JSON em stdin/stdout (ou WebSocket local). Confirmado para o TTS em 03/11: o Kokoro só fala PT-BR pelo pacote Python (D-004). Ambiente com `uv`, cache no D:.
3. **PostgreSQL 18** local (porta 5433), driver `pg`, migrações em SQL puro (D-002).
4. **Ordem do STT:** começar com **whisper.cpp Small** (funciona com certeza) e testar o **Nemotron multilingual** em paralelo, pelos critérios da seção 17 do blueprint. O Nemotron só vira padrão depois de passar nesses critérios.
5. **Sem MCP/ACP no MVP.** Os adaptadores chamam `claude -p` e `codex exec` em modo não interativo, dentro da worktree da tarefa.

**Incertezas a testar antes de comprometer:** runtime do Nemotron multilingual no Windows/CPU; RAM com Qwen3 1.7B + STT + TTS + VS Code; termos de uso do `claude -p`/`codex exec` acionados por um programa local.

## 3. Marcos (cada um com critério de pronto)

| # | Marco | Pronto quando | Dono |
|---|---|---|---|
| M0 | Preparação | `git init`, pastas, `docs/DECISIONS.md`, Ollama + Qwen3 1.7B no D:, variáveis de cache no D: | Joel instala; Claude registra |
| M1 | Contratos | Interfaces TS e esquema do Postgres fechados (ver §4), revisados pelo Codex | Claude escreve, Codex revisa |
| M2 | Conversa por texto | Terminal → roteador → Qwen local → resposta, sem rede (provado por log) | Claude · ✅ 03/11 (`pnpm night`) |
| M3 | Memória | “Salva essa ideia para o Abstrike” grava no Postgres; “quais ideias do Abstrike?” recupera; testes passam | Claude · ✅ 03/11 |
| M4 | Worktree + tarefa (sem IA) | `WorktreeManager` cria `agent/<agente>/<id>` a partir de um commit base, mostra diff, rejeita (apaga só a worktree do agente) e aprova (merge só se não houver conflito). Testes provam que a worktree do Joel não muda | Codex · ✅ 04/11 |
| M5 | Adaptadores Claude/Codex | Uma tarefa real roda numa worktree, grava eventos, o cancelamento mata o processo e o status vem do banco | Claude · ✅ 04/11 (e2e real) |
| M6 | Voz | Push-to-talk → STT → Qwen → Kokoro, em EN e PT-BR; banco de testes com 10+10 frases do Joel | Claude · ✅ 03–04/11 (automática por VAD; faltam as 10+10 frases do Joel) |
| M7 | Juntar tudo | Os 5 passos da seção 15 do blueprint funcionam por voz | Claude integra, Codex revisa |
| M8 | Revisão cruzada | Claude implementa, Codex revisa, no máximo 2 ciclos | Ambos · ✅ 04/11 (o outro agente revisa cada tarefa) |

M2–M3 (Claude) e M4–M5 (Codex) andam **em paralelo** depois do M1. O M6 pode começar junto, pois depende só do contrato de voz.

## 4. Contratos a fixar no M1 (antes de dividir)

- `src/core/types.ts`: `Project`, `Idea`, `Task`, `TaskEvent`, `Approval` e o enum de status (§8 do blueprint).
- `src/memory/migrations/001_init.sql`: esquema das tabelas acima (PostgreSQL 18, ver D-002).
- Interfaces: `SpeechToText`, `TextToSpeech`, `ModelRouter`, `JobScheduler`, `WorktreeManager`, `CodingAgent` (`start`, `status`, `cancel`, `result`).
- Protocolo de voz Node↔Python: mensagens `partial`, `final`, `error`, `speak`, `done`.

Depois do M1, mudar um contrato exige que o dono avise o outro agente e que este revise.

## 5. Quem é dono de quê

| Pasta | Dono | O outro |
|---|---|---|
| `src/core`, `src/memory`, `src/local-llm`, `src/app` | Claude | revisa |
| `services/speech` (Python) | Claude | revisa |
| `src/workspaces`, `src/agents`, `src/permissions` | Codex | revisa |
| `tests/` de lifecycle, permissão e isolamento | Codex | revisa |
| `docs/DECISIONS.md` | Claude registra; os dois propõem | — |

O Codex trabalha numa worktree própria (`task`), e o Claude revisa o diff antes de trazê-lo para o main. Nada é mergeado sem o OK do Joel.

## 6. Como funciona a revisão cruzada

1. O dono entrega um commit na sua branch, com os testes passando.
2. O outro agente roda `review` naquele diff, com contexto do que não pode quebrar.
3. O dono corrige o que for real (com teste) e justifica o que descartou. No máximo 2 ciclos; depois disso o Joel decide.
4. Mudança de desenho difícil (roteador, scheduler, recuperação após reinício): pedir `alt` ao Codex e comparar as duas versões pelos testes.

## 7. O que o Joel precisa decidir/fazer

Feito em 03/11: espaço no C:, Ollama + Qwen, `git init`, leitura do Soaken, stack, Postgres 18.

Pendente:
1. Ouvir `lab/tts-pt/out/*.wav` e escolher a voz em PT-BR (`pf_dora` ou `pm_alex`).
2. Caminho dos repositórios (Abstrike etc.) para ligar os projetos cadastrados.
3. Gravar as 10+10 frases de teste do STT (M6).

## 8. Ajustes em relação ao blueprint

- **whisper.cpp primeiro, Nemotron em paralelo**, para não travar o MVP num runtime incerto. O blueprint já permite isso (§19); aqui vira a ordem padrão.
- **Contratos antes da divisão (M1)**, porque o blueprint divide as frentes mas não diz quem fixa as interfaces.
- **Worktree sem IA (M4) antes dos adaptadores (M5):** o isolamento é testado de forma determinística antes de entrar um agente real.
