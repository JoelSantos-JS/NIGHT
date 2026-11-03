# Voz do Night (Python)

Kokoro para falar (PT-BR `pf_dora`, EN `af_heart`) e faster-whisper para ouvir, tudo local.
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
| `NIGHT_VOICE_PT` | `pf_dora` | ou `pm_alex` |
| `NIGHT_VOICE_EN` | `af_heart` | qualquer voz `af_*`/`am_*` do Kokoro |
| `NIGHT_SPEECH_OFFLINE` | — | `1` = não consulta a internet |

## Testar

    pnpm test:voz      # gera WAV com o Kokoro e transcreve de volta com o Whisper (sem mic, sem som)
    pnpm night:voz     # de verdade: Enter abre o microfone, Enter de novo fecha
