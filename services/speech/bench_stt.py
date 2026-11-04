"""Compara modelos do Whisper com a voz do Joel (áudios da calibragem: pnpm night:calibrar).

Roda:  services/speech/.venv/Scripts/python services/speech/bench_stt.py [modelo ...]
Mede, por microfone e modelo: % de palavras erradas (WER, menor é melhor) e segundos de transcrição por segundo
de áudio. Os nomes próprios (Night, Claude, Codex, Soaken, Copom...) contam à parte, porque é onde o Whisper erra
e onde um erro muda o comando.
"""
from __future__ import annotations

import glob
import json
import os
import re
import sys
import time
import unicodedata

os.environ.setdefault("HF_HOME", "D:/NIGHT-data/hf-py")
sys.path.insert(0, os.path.dirname(__file__))

import numpy as np  # noqa: E402
from faster_whisper import WhisperModel  # noqa: E402

from night_speech.__main__ import THREADS, WHISPER_PROMPT_EN, WHISPER_PROMPT_PT, load_wav_16k  # noqa: E402

NAMES = {"night", "claude", "codex", "soaken", "copom", "aws", "api", "ollama", "karaoke"}


def words(s: str) -> list[str]:
    s = unicodedata.normalize("NFD", s.lower())
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    return re.findall(r"[a-z0-9]+", s.replace("to ", "tou "))  # "tô" sem acento vira "to"; iguala os dois lados


def wer(ref: list[str], hyp: list[str]) -> int:
    d = list(range(len(hyp) + 1))
    for i, r in enumerate(ref, 1):
        prev, d[0] = d[0], i
        for j, h in enumerate(hyp, 1):
            prev, d[j] = d[j], min(d[j] + 1, d[j - 1] + 1, prev + (r != h))
    return d[len(hyp)]


def main() -> None:
    models = sys.argv[1:] or ["small", "medium", "large-v3-turbo"]
    manifests = sorted(glob.glob("D:/NIGHT-data/calibragem/*/manifest.json"))
    if not manifests:
        print("Sem calibragem. Rode antes: pnpm night:calibrar")
        return
    sets = []
    for m in manifests:
        data = json.load(open(m, encoding="utf-8"))
        items = [(r, load_wav_16k(r["audio"])) for r in data["results"] if r.get("audio") and os.path.exists(r["audio"])]
        sets.append((data["mic"], items))
        print(f"{data['mic']}: {len(items)} falas, {sum(len(a) for _, a in items) / 16000:.0f} s de áudio")

    print(f"\n{'microfone':28s} {'modelo':16s} {'prompt':6s} {'WER':>6s} {'nomes':>7s} {'tempo/áudio':>12s}")
    for model_name in models:
        try:
            model = WhisperModel(model_name, device="cpu", compute_type="int8", cpu_threads=THREADS)
        except Exception as e:  # noqa: BLE001
            print(f"{model_name}: não carregou ({e})")
            continue
        for mic, items in sets:
            for use_prompt in (True, False):
                errors = total = name_err = name_total = 0
                spent = audio_s = 0.0
                worst = []
                for r, audio in items:
                    lang = "en" if r["lang"] == "en" else "pt"
                    prompt = (WHISPER_PROMPT_EN if lang == "en" else WHISPER_PROMPT_PT) if use_prompt else None
                    t = time.perf_counter()
                    segs, _ = model.transcribe(audio, language=lang, vad_filter=True, beam_size=5, initial_prompt=prompt)
                    hyp = " ".join(s.text.strip() for s in segs)
                    spent += time.perf_counter() - t
                    audio_s += len(audio) / 16000
                    ref_w, hyp_w = words(r["expected"]), words(hyp)
                    e = wer(ref_w, hyp_w)
                    errors += e
                    total += len(ref_w)
                    names = [w for w in ref_w if w in NAMES]
                    name_total += len(names)
                    name_err += sum(1 for w in names if w not in hyp_w)
                    worst.append((e / max(1, len(ref_w)), r["expected"], hyp))
                print(f"{mic[:28]:28s} {model_name:16s} {'sim' if use_prompt else 'não':6s} {100 * errors / max(1, total):5.1f}% "
                      f"{name_err:>3d}/{name_total:<3d} {spent / max(1e-6, audio_s):10.2f}x")
                if use_prompt:
                    for score, ref, hyp in sorted(worst, reverse=True)[:2]:
                        print(f"     pior ({100 * score:.0f}%): esperado «{ref}»\n                  ouvido   «{hyp}»")


if __name__ == "__main__":
    main()
