"""Transcrição pelo Whisper grande na nuvem do Groq (o OpenBot oferece o mesmo como opção de nuvem).

Chave: GROQ_API_KEY ou o arquivo ~/.groq/api_key. Nunca vai para log nem para mensagem de erro.
O áudio da fala sai do PC: só liga com NIGHT_STT=groq.
"""
from __future__ import annotations

import io
import os
import time
from pathlib import Path

import numpy as np

URL = "https://api.groq.com/openai/v1/audio/transcriptions"
MODELO = os.environ.get("NIGHT_GROQ_STT_MODEL", "whisper-large-v3")
SAMPLE_RATE = 16_000
TIMEOUT_S = 20


def groq_key() -> str | None:
    key = os.environ.get("GROQ_API_KEY", "").strip()
    if key:
        return key
    f = Path.home() / ".groq" / "api_key"
    return f.read_text(encoding="utf-8").strip() if f.exists() else None


class GroqStt:
    def __init__(self, model: str = MODELO) -> None:
        if not groq_key():
            raise RuntimeError("sem chave do Groq (GROQ_API_KEY ou ~/.groq/api_key)")
        self.model = model

    def transcribe(self, audio: np.ndarray, language: str | None, prompt: str | None) -> dict:
        import requests
        import soundfile as sf

        buf = io.BytesIO()
        sf.write(buf, audio.astype(np.float32), SAMPLE_RATE, format="FLAC")
        data = {"model": self.model, "response_format": "verbose_json", "temperature": "0"}
        if language:
            data["language"] = language
        if prompt:
            data["prompt"] = prompt
        t = time.perf_counter()
        r = requests.post(URL, headers={"Authorization": f"Bearer {groq_key()}"}, data=data,
                          files={"file": ("fala.flac", buf.getvalue(), "audio/flac")}, timeout=TIMEOUT_S)
        if r.status_code != 200:
            # Só o código e o começo da mensagem do Groq: nada da chave nem do áudio.
            raise RuntimeError(f"Groq respondeu {r.status_code}: {r.text[:200]}")
        j = r.json()
        segs = j.get("segments") or []
        dur = sum(max(0.0, s.get("end", 0) - s.get("start", 0)) for s in segs)
        avg = (sum(s.get("avg_logprob", 0) * (s.get("end", 0) - s.get("start", 0)) for s in segs) / dur) if dur else None
        no_speech = max((s.get("no_speech_prob", 0) for s in segs), default=None)
        return {"text": (j.get("text") or "").strip(), "language": j.get("language"), "avg_logprob": avg,
                "no_speech": no_speech, "ms": round((time.perf_counter() - t) * 1000)}
