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
