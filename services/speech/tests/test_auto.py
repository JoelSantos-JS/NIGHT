"""Escuta automática sem microfone: o áudio entra direto na fila do VAD.
Roda: services/speech/.venv/Scripts/python -m pytest services/speech/tests  (ou só python este arquivo)."""
import os
import sys
import threading
import time

import numpy as np
import soundfile as sf

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from night_speech.auto import FRAME, RATE, AutoListener  # noqa: E402

HERE = os.path.dirname(__file__)
SAMPLES = os.path.join(HERE, "..", "..", "..", "lab", "tts-pt", "out")


def load(name: str) -> np.ndarray:
    """Lê em 16 kHz e corta o silêncio que o Kokoro põe nas pontas, para as pausas do teste serem exatas."""
    a, r = sf.read(os.path.join(SAMPLES, name), dtype="float32")
    a = np.interp(np.linspace(0, len(a) - 1, int(len(a) * RATE / r)), np.arange(len(a)), a).astype(np.float32)
    loud = np.flatnonzero(np.abs(a) > 0.02)
    return a[loud[0]:loud[-1] + 1]


def silence(s: float) -> np.ndarray:
    return np.zeros(int(s * RATE), dtype=np.float32)


def run(audio: np.ndarray, speaking: bool = False) -> list[dict]:
    events: list[dict] = []
    al = AutoListener(events.append, lambda: speaking)
    al.running.set()
    worker = threading.Thread(target=al._loop, daemon=True)
    worker.start()
    for i in range(0, len(audio) - FRAME + 1, FRAME):
        al.frames.put(audio[i:i + FRAME])
    al.frames.put(None)
    worker.join(timeout=30)
    return events


def utterances(events):
    return [e for e in events if e["type"] == "utterance"]


def test_pausa_curta_junta_numa_fala_so():
    a, b = load("py-pm_alex-1.wav"), load("py-pm_alex-2.wav")
    ev = run(np.concatenate([silence(0.5), a, silence(0.8), b, silence(2.0)]))
    u = utterances(ev)
    assert len(u) == 1, ev
    assert len(u[0]["audio"]) / RATE > (len(a) + len(b)) / RATE * 0.9


def test_silencio_longo_separa_em_duas():
    a, b = load("py-pm_alex-1.wav"), load("py-pm_alex-2.wav")
    ev = run(np.concatenate([silence(0.5), a, silence(2.0), b, silence(2.0)]))
    assert len(utterances(ev)) == 2, ev
    assert [e["type"] for e in ev].count("speech_start") == 2


def test_barulho_baixo_nao_vira_fala():
    rng = np.random.default_rng(1)
    ev = run((rng.standard_normal(RATE * 4) * 0.003).astype(np.float32))
    assert utterances(ev) == [], ev


def test_com_o_night_falando_precisa_de_fala_firme():
    a = load("py-pm_alex-1.wav")
    ev = run(np.concatenate([silence(0.5), a, silence(2.0)]), speaking=True)
    starts = [e for e in ev if e["type"] == "speech_start"]
    assert starts and starts[0]["barge_in"] is True


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            t = time.perf_counter()
            fn()
            print(f"ok  {name}  ({time.perf_counter() - t:.1f}s)")
