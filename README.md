# Night

Assistente pessoal local, voz primeiro, que conversa em inglês e português sem custo por mensagem e delega
tarefas de código ao Claude Code e ao Codex em worktrees separadas. Requisitos: `NIGHT_BLUEPRINT_V2.md`.
Plano: `docs/PLANO_INICIAL.md`. Decisões: `docs/DECISIONS.md`.

## Preparar

1. Node 22.13 ou mais novo e pnpm: `pnpm install`
2. PostgreSQL 18 na porta 5433: no PowerShell, `.\scripts\setup-db.ps1` (pede a senha do `postgres`)
3. `pnpm test` e `pnpm typecheck`

## Pastas

| Pasta | O que tem | Dono |
|---|---|---|
| `src/core` | tipos e contratos entre módulos | Claude (mudança revisada pelo Codex) |
| `src/memory` | PostgreSQL: projetos, ideias, tarefas, eventos, aprovações | Claude |
| `src/workspaces`, `src/agents`, `src/permissions` | worktrees, adaptadores Claude/Codex, aprovações | Codex |
| `services/speech` | voz em Python (a fazer) | Claude |
