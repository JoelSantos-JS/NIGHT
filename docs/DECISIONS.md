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
