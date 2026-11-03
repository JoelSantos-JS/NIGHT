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
