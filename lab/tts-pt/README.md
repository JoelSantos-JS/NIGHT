# Teste: Kokoro em PT-BR (03/11/2026)

Resultado em `docs/DECISIONS.md`, D-004. Os áudios ficam em `out/` (fora do git).

- `node-pt.mjs`: tentativa só com Node (`kokoro-js` + `phonemizer`). **Falha**: o `phonemizer` do npm só tem inglês.
- `py/py_pt.py`: pacote Python `kokoro`, vozes `pf_dora` e `pm_alex`. **Funciona.**
- `py/py_en.py`: o mesmo pacote em inglês (`af_heart`). **Funciona.**

Para refazer (cache dos modelos em `D:\NIGHT-data`):

    cd lab/tts-pt/py
    uv venv --python 3.12 .venv && uv pip install --python .venv kokoro soundfile
    .venv/Scripts/python py_pt.py
