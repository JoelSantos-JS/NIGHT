# Night

Assistente pessoal local, voz primeiro, em português e inglês. Conversa sem custo por mensagem (Qwen local),
pesquisa com os modelos menores do Codex/Claude e delega código ao Claude Code e ao Codex em worktrees
separadas, com revisão de um pelo outro e merge só depois do seu "aprovo".
Requisitos: `NIGHT_BLUEPRINT_V2.md` · Plano: `docs/PLANO_INICIAL.md` · Decisões: `docs/DECISIONS.md`.

## Usar

| Comando | O que faz |
|---|---|
| `pnpm night:voz` | Voz automática: fale, e quando você parar (~1,3 s) ele responde. Enter pausa o microfone |
| `pnpm night` | O mesmo por texto |
| `pnpm night:teste "frase 1 \| frase 2"` | Testa por voz sem microfone (o Kokoro fala a frase, o Whisper ouve) |
| `pnpm night:teste --arquivo audio.wav` | Testa com um áudio seu |

O que dá para falar:

| Exemplo | Quem responde |
|---|---|
| "Bom dia, Night", "me explica o que é uma API" | Qwen 1.7B local (grátis) |
| "Salva essa ideia para o Soaken: …" / "Quais ideias eu tenho do Soaken?" | banco local |
| "Pesquisa pra mim …", "qual a cotação do dólar hoje?" | Codex `gpt-6-luna` (depois Claude `haiku`), com internet |
| "Pede pro Claude/Codex <mudança> no <projeto>" | o agente faz numa worktree; o outro revisa; ele avisa quando termina |
| "Mostra as mudanças" · "Aprovo" · "Descarta" · "Cancela a tarefa" | executor de tarefas |
| "O que tá rodando?" | banco (status real) |
| "A pasta do <projeto> é C:\…" (digitado) | liga o projeto ao repositório |

## Preparar (uma vez)

1. Node 22.13+ e pnpm: `pnpm install`
2. PostgreSQL 18 na porta 5433: no PowerShell, `.\scripts\setup-db.ps1` (pede a senha do `postgres`), depois `pnpm seed`
3. Ollama com `qwen3:1.7b`
4. Voz: ver `services/speech/README.md`
5. Conferir: `pnpm test` (rápido) · `pnpm test:voz` (voz, ~1 min) · `pnpm e2e:agentes claude|codex` (agentes de verdade, gasta cota)

## Pastas

| Pasta | O que tem |
|---|---|
| `src/core` | tipos e contratos entre módulos |
| `src/router`, `src/app` | roteador, coordenador, modos texto/voz |
| `src/memory` | PostgreSQL: projetos, ideias, tarefas, eventos, aprovações, registro do roteador |
| `src/agents` | pesquisa, agentes de código, revisores, executor de tarefas, contexto compartilhado |
| `src/workspaces` | worktrees git (a pasta do dono nunca muda antes do "aprovo") |
| `src/speech`, `services/speech` | voz: Kokoro + Whisper + detecção de fala (Python) |
