"""Voz do dono: o Night só aceita fala que soe como o Joel (vídeo tocando, outra pessoa e a própria voz do Night
ficam de fora). Um microfone só não separa o som do PC da fala; o jeito é reconhecer QUEM está falando.

Modelo: WeSpeaker ResNet34 (VoxCeleb, ~26 MB) pelo sherpa-onnx, em NIGHT_SPEAKER_MODEL. O perfil é a média das
"impressões de voz" das falas da calibragem (pnpm night:calibrar), guardado em D:/NIGHT-data/voz-dono.npy.
Nada sai do PC.
"""
from __future__ import annotations

import os

import numpy as np

MODELO = os.environ.get("NIGHT_SPEAKER_MODEL", "D:/NIGHT-data/modelos/voz-dono/wespeaker_en_voxceleb_resnet34_LM.onnx")
PERFIL = os.environ.get("NIGHT_SPEAKER_PROFILE", "D:/NIGHT-data/voz-dono.npy")
SAMPLE_RATE = 16_000


def cos(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-9))


class VozDono:
    def __init__(self, modelo: str = MODELO) -> None:
        import sherpa_onnx

        cfg = sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=modelo, num_threads=2)
        if not cfg.validate():
            raise RuntimeError(f"modelo de voz inválido: {modelo}")
        self.ext = sherpa_onnx.SpeakerEmbeddingExtractor(cfg)

    def embedding(self, audio: np.ndarray) -> np.ndarray:
        s = self.ext.create_stream()
        s.accept_waveform(SAMPLE_RATE, audio.astype(np.float32))
        s.input_finished()
        return np.array(self.ext.compute(s), dtype=np.float32)


MIN_SEMELHANCA = float(os.environ.get("NIGHT_SPEAKER_MIN", "0.68"))
"""Medido 19/11 com o perfil calibragem + 8 falas ao vivo (metade cada): Joel ao vivo 0,72–0,93 (cada fala fora da
média); outras vozes (Kokoro PT e EN, som de Bluetooth) até 0,69, as em português até 0,61. Em 0,68: 8/8 do Joel,
1/18 de outras (uma voz masculina em inglês). Só com a calibragem, o Joel ao vivo caía para 0,66."""


class PerfilDono:
    """Perfil pronto: a média das impressões de voz do Joel. Monta sozinho da calibragem na 1ª vez."""

    def __init__(self, voz: VozDono, perfil: np.ndarray, minimo: float = MIN_SEMELHANCA) -> None:
        self.voz, self.perfil, self.minimo = voz, perfil, minimo

    @classmethod
    def carregar(cls) -> "PerfilDono | None":
        if os.environ.get("NIGHT_SPEAKER", "on") == "off" or not os.path.exists(MODELO):
            return None
        voz = VozDono()
        if os.path.exists(PERFIL):
            return cls(voz, np.load(PERFIL))
        perfil = montar_perfil(voz)
        if perfil is None:
            return None
        os.makedirs(os.path.dirname(PERFIL), exist_ok=True)
        np.save(PERFIL, perfil)
        return cls(voz, perfil)

    def semelhanca(self, audio: np.ndarray) -> float:
        return cos(self.voz.embedding(audio), self.perfil)


def montar_perfil(voz: VozDono) -> np.ndarray | None:
    """Média das falas da calibragem (pnpm night:calibrar). Sem calibragem, não há perfil e o filtro fica desligado."""
    import glob
    import json

    from night_speech.__main__ import load_wav_16k

    embs = []
    for m in sorted(glob.glob("D:/NIGHT-data/calibragem/*/manifest.json")):
        data = json.load(open(m, encoding="utf-8"))
        embs += [voz.embedding(load_wav_16k(r["audio"])) for r in data["results"] if os.path.exists(r.get("audio", ""))]
    return np.mean(embs, axis=0) if len(embs) >= 5 else None
