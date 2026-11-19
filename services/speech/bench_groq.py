"""Whisper grande na nuvem do Groq × Whisper small local, com a voz do Joel (áudios da calibragem).

Roda:  services/speech/.venv/Scripts/python services/speech/bench_groq.py
Chave: GROQ_API_KEY ou ~/.groq/api_key (nunca no código nem no log). O áudio da calibragem vai para o Groq.
"""
from __future__ import annotations

import glob
import io
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(__file__))

import soundfile as sf  # noqa: E402

from bench_stt import NAMES, wer, words  # noqa: E402
from night_speech.__main__ import WHISPER_PROMPT_EN, WHISPER_PROMPT_PT, load_wav_16k  # noqa: E402
from night_speech.groq import GroqStt  # noqa: E402


def main() -> None:
    sets = []
    for m in sorted(glob.glob("D:/NIGHT-data/calibragem/*/manifest.json")):
        data = json.load(open(m, encoding="utf-8"))
        items = [(r, load_wav_16k(r["audio"])) for r in data["results"] if r.get("audio") and os.path.exists(r["audio"])]
        sets.append((data["mic"], items))
    print(f"\n{'microfone':22s} {'modelo':28s} {'WER':>6s} {'nomes':>7s} {'por fala':>9s}")
    combos = [(m, u) for m in ("whisper-large-v3", "whisper-large-v3-turbo") for u in (True, False)]
    if len(sys.argv) > 1:
        combos = [c for c in combos if f"{c[0]}{'+' if c[1] else ''}" in sys.argv[1:]]
    for modelo, usar_prompt in combos:
        stt = GroqStt(model=modelo)
        if True:
            for mic, items in sets:
                errors = total = name_err = name_total = 0
                gasto = []
                piores = []
                for r, audio in items:
                    lang = "en" if r["lang"] == "en" else "pt"
                    prompt = (WHISPER_PROMPT_EN if lang == "en" else WHISPER_PROMPT_PT) if usar_prompt else None
                    t = time.perf_counter()
                    hyp = stt.transcribe(audio, lang, prompt)["text"]
                    gasto.append(time.perf_counter() - t)
                    time.sleep(3.2)  # plano grátis do Groq: 20 pedidos por minuto
                    ref_w, hyp_w = words(r["expected"]), words(hyp)
                    e = wer(ref_w, hyp_w)
                    errors += e
                    total += len(ref_w)
                    names = [w for w in ref_w if w in NAMES]
                    name_total += len(names)
                    name_err += sum(1 for w in names if w not in hyp_w)
                    piores.append((e / max(1, len(ref_w)), r["expected"], hyp))
                nome = f"{modelo}{' +prompt' if usar_prompt else ''}"
                print(f"{mic[:22]:22s} {nome:28s} {100 * errors / max(1, total):5.1f}% {name_err:>3d}/{name_total:<3d} "
                      f"{sum(gasto) / len(gasto):7.2f} s")
                if usar_prompt:
                    for score, ref, hyp in sorted(piores, reverse=True)[:3]:
                        print(f"     pior ({100 * score:.0f}%): esperado «{ref}»\n                  ouvido   «{hyp}»")


if __name__ == "__main__":
    main()
