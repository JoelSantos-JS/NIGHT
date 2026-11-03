# Voz do Night (Python)

Kokoro para falar (PT-BR `pm_santa`, EN `am_puck`: masculinas e um pouco engraçadas, escolha do Joel) e faster-whisper para ouvir, tudo local.
O Node abre este processo uma vez (`src/speech/speech-service.ts`) e conversa por JSON em stdin/stdout;
o protocolo está no topo de `night_speech/__main__.py`.

## Instalar (uma vez)

    cd services/speech
    uv venv --python 3.12 .venv
    uv pip install --python .venv -r pyproject.toml

Os modelos baixam no primeiro uso para `D:\NIGHT-data\hf-py` (Kokoro ~330 MB, Whisper base ~150 MB,
small ~480 MB). Depois disso, `NIGHT_SPEECH_OFFLINE=1` impede qualquer acesso à rede.

## Variáveis

| Variável | Padrão | O que faz |
|---|---|---|
| `NIGHT_WHISPER_MODEL` | `base` no modo voz | `small` erra menos em PT, mas precisa de ~500 MB a mais de RAM |
| `NIGHT_VOICE_PT` | `pm_santa` | ou `pm_alex` (masculina neutra), `pf_dora` (feminina) |
| `NIGHT_VOICE_EN` | `am_puck` | ou `am_fenrir`, `am_michael`, `af_heart`... |
| `NIGHT_SPEECH_OFFLINE` | — | `1` = não consulta a internet |

## Testar

    pnpm test:voz      # gera WAV com o Kokoro e transcreve de volta com o Whisper (sem mic, sem som)
    pnpm night:voz     # de verdade: Enter abre o microfone, Enter de novo fecha
