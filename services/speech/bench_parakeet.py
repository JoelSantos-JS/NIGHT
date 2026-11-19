"""Parakeet TDT 0.6B v3 (o motor de voz padrão do OpenBot) × Whisper small, com a voz do Joel.

Roda:  services/speech/.venv/Scripts/python services/speech/bench_parakeet.py
Usa os áudios da calibragem (pnpm night:calibrar) e o modelo em D:/NIGHT-data/modelos/parakeet-tdt-0.6b-v3-int8
(NIGHT_PARAKEET_DIR). Mede % de palavras erradas, nomes próprios errados e tempo por segundo de áudio.
"""
from __future__ import annotations

import glob
import json
import os
import sys
import time

os.environ.setdefault("HF_HOME", "D:/NIGHT-data/hf-py")
sys.path.insert(0, os.path.dirname(__file__))

from bench_stt import NAMES, wer, words  # noqa: E402
from night_speech.__main__ import THREADS, WHISPER_PROMPT_EN, WHISPER_PROMPT_PT, load_wav_16k  # noqa: E402
from night_speech.parakeet import PARAKEET_DIR, Parakeet  # noqa: E402


def medir(nome: str, transcrever, sets) -> None:
    for mic, items in sets:
        errors = total = name_err = name_total = 0
        spent = audio_s = 0.0
        piores = []
        for r, audio in items:
            t = time.perf_counter()
            hyp = transcrever(audio, "en" if r["lang"] == "en" else "pt")
            spent += time.perf_counter() - t
            audio_s += len(audio) / 16000
            ref_w, hyp_w = words(r["expected"]), words(hyp)
            e = wer(ref_w, hyp_w)
            errors += e
            total += len(ref_w)
            names = [w for w in ref_w if w in NAMES]
            name_total += len(names)
            name_err += sum(1 for w in names if w not in hyp_w)
            piores.append((e / max(1, len(ref_w)), r["expected"], hyp))
        print(f"{mic[:28]:28s} {nome:22s} {100 * errors / max(1, total):5.1f}% {name_err:>3d}/{name_total:<3d} "
              f"{spent / max(1e-6, audio_s):8.2f}x")
        for score, ref, hyp in sorted(piores, reverse=True)[:3]:
            print(f"     pior ({100 * score:.0f}%): esperado «{ref}»\n                  ouvido   «{hyp}»")


def main() -> None:
    sets = []
    for m in sorted(glob.glob("D:/NIGHT-data/calibragem/*/manifest.json")):
        data = json.load(open(m, encoding="utf-8"))
        items = [(r, load_wav_16k(r["audio"])) for r in data["results"] if r.get("audio") and os.path.exists(r["audio"])]
        sets.append((data["mic"], items))
        print(f"{data['mic']}: {len(items)} falas, {sum(len(a) for _, a in items) / 16000:.0f} s de áudio")
    if not sets:
        print("Sem calibragem. Rode antes: pnpm night:calibrar")
        return

    print(f"\n{'microfone':28s} {'modelo':22s} {'WER':>6s} {'nomes':>7s} {'tempo':>9s}")
    t = time.perf_counter()
    p = Parakeet(PARAKEET_DIR)
    print(f"(Parakeet carregou em {time.perf_counter() - t:.1f} s)")
    medir("parakeet-tdt-0.6b-v3", lambda audio, _lang: p.transcribe(audio)["text"], sets)

    from faster_whisper import WhisperModel

    w = WhisperModel("small", device="cpu", compute_type="int8", cpu_threads=THREADS)

    def whisper(audio, lang):
        prompt = WHISPER_PROMPT_EN if lang == "en" else WHISPER_PROMPT_PT
        segs, _ = w.transcribe(audio, language=lang, vad_filter=True, beam_size=5, initial_prompt=prompt)
        return " ".join(s.text.strip() for s in segs)

    medir("whisper small (+prompt)", whisper, sets)


if __name__ == "__main__":
    main()
