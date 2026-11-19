"""Reconhecimento da voz do dono: separa o Joel de outras vozes (vídeo tocando, outra pessoa, a voz do Night)?

Roda:  services/speech/.venv/Scripts/python services/speech/bench_dono.py
Joel: as falas da calibragem (deixa uma de fora e compara com a média das outras).
Outros: frases geradas pelo Kokoro em várias vozes, com o som cortado acima de 4 kHz como no fone Bluetooth.
"""
from __future__ import annotations

import glob
import json
import os
import sys

os.environ.setdefault("HF_HOME", "D:/NIGHT-data/hf-py")
sys.path.insert(0, os.path.dirname(__file__))

import numpy as np  # noqa: E402

from night_speech.__main__ import load_wav_16k  # noqa: E402
from night_speech.dono import VozDono, cos  # noqa: E402

FRASES = {
    "p": ["Família com pesadelos, todo mundo chega com bagagem emocional.", "Valeu por assistir, até o próximo vídeo.",
          "Eu tô ligando na idade da espuma, mas se liga ao Night."],
    "a": ["I think I found a nice place, but I am going to go back to sleep.", "Thanks for watching, see you next time.",
          "I'm going to search for you and then talk to Claude and Codex."],
}
VOZES = {"p": ["pm_santa", "pf_dora", "pm_alex"], "a": ["af_heart", "am_adam", "bm_george"]}


def como_bluetooth(audio24k: np.ndarray) -> np.ndarray:
    """24 kHz → 8 kHz → 16 kHz: corta tudo acima de 4 kHz, como o fone em modo de ligação."""
    n8 = int(len(audio24k) / 3)
    a8 = np.interp(np.linspace(0, len(audio24k) - 1, n8), np.arange(len(audio24k)), audio24k)
    n16 = n8 * 2
    return np.interp(np.linspace(0, n8 - 1, n16), np.arange(n8), a8).astype(np.float32)


def main() -> None:
    v = VozDono()
    falas = []
    for m in sorted(glob.glob("D:/NIGHT-data/calibragem/*/manifest.json")):
        data = json.load(open(m, encoding="utf-8"))
        falas += [load_wav_16k(r["audio"]) for r in data["results"] if os.path.exists(r.get("audio", ""))]
    embs = [v.embedding(a) for a in falas]
    joel = []
    for i, e in enumerate(embs):
        outros = [x for j, x in enumerate(embs) if j != i]
        joel.append(cos(e, np.mean(outros, axis=0)))
    perfil = np.mean(embs, axis=0)

    from kokoro import KModel, KPipeline

    model = KModel(repo_id="hexgrad/Kokoro-82M").eval()
    outros = []
    for lang, vozes in VOZES.items():
        pipe = KPipeline(lang_code=lang, repo_id="hexgrad/Kokoro-82M", model=model)
        for voz in vozes:
            for frase in FRASES[lang]:
                audio = np.concatenate([p.audio.numpy() for p in pipe(frase, voice=voz) if p.audio is not None])
                outros.append((voz, cos(v.embedding(como_bluetooth(audio)), perfil)))

    print(f"Joel ({len(joel)} falas, deixando cada uma de fora): mín {min(joel):.2f} · média {np.mean(joel):.2f} · máx {max(joel):.2f}")
    sims = [s for _, s in outros]
    print(f"Outras vozes ({len(sims)} falas): mín {min(sims):.2f} · média {np.mean(sims):.2f} · máx {max(sims):.2f}")
    for voz in sorted({x for x, _ in outros}):
        print(f"   {voz:10s} máx {max(s for x, s in outros if x == voz):.2f}")
    for limite in (0.3, 0.35, 0.4, 0.45, 0.5):
        print(f"limite {limite:.2f}: Joel aceito {sum(s >= limite for s in joel)}/{len(joel)} · "
              f"outras vozes aceitas {sum(s >= limite for s in sims)}/{len(sims)}")


if __name__ == "__main__":
    main()
