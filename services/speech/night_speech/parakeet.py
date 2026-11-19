"""Parakeet TDT 0.6B v3 (NVIDIA, CC-BY-4.0) pelo sherpa-onnx: o mesmo motor de voz padrão do OpenBot.

Acha sozinho o idioma entre 25 línguas europeias (português e inglês incluídos) e não "inventa" frase em
silêncio como o Whisper ("Thanks for watching", "Obrigado."). Roda no CPU, em int8.
Modelo: os 4 arquivos da exportação fixada que o OpenBot usa (csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8,
revisão 2bda32ec), na pasta NIGHT_PARAKEET_DIR.
"""
from __future__ import annotations

import os
import time

import numpy as np

PARAKEET_DIR = os.environ.get("NIGHT_PARAKEET_DIR", "D:/NIGHT-data/modelos/parakeet-tdt-0.6b-v3-int8")
ARQUIVOS = ("encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt")
SAMPLE_RATE = 16_000


def parakeet_disponivel(pasta: str = PARAKEET_DIR) -> bool:
    return all(os.path.exists(os.path.join(pasta, f)) for f in ARQUIVOS)


class Parakeet:
    def __init__(self, pasta: str = PARAKEET_DIR, threads: int | None = None) -> None:
        import sherpa_onnx

        # O OpenBot usa metade dos processadores lógicos, de 4 a 6 (mais que isso não acelera).
        threads = threads or max(4, min(6, (os.cpu_count() or 8) // 2))
        p = lambda f: os.path.join(pasta, f)  # noqa: E731
        self.rec = sherpa_onnx.OfflineRecognizer.from_transducer(
            encoder=p("encoder.int8.onnx"), decoder=p("decoder.int8.onnx"), joiner=p("joiner.int8.onnx"),
            tokens=p("tokens.txt"), num_threads=threads, sample_rate=SAMPLE_RATE, feature_dim=80,
            decoding_method="greedy_search", model_type="nemo_transducer",
        )

    def transcribe(self, audio: np.ndarray) -> dict:
        t = time.perf_counter()
        stream = self.rec.create_stream()
        stream.accept_waveform(SAMPLE_RATE, audio.astype(np.float32))
        self.rec.decode_stream(stream)
        r = stream.result
        lang = (getattr(r, "lang", "") or "").strip("<|>").lower()
        return {"text": r.text.strip(), "lang": lang, "ms": round((time.perf_counter() - t) * 1000)}
