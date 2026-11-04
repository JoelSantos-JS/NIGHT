"""Escuta automática: o microfone fica aberto, o Silero VAD acha início e fim da fala, e cada fala vira
uma transcrição entregue ao Night. Sem tecla.

- Começo: 3 quadros seguidos (~0,1 s) com voz. Entra junto 0,3 s de antes, para não cortar a 1ª sílaba.
- Fim: END_SILENCE_S de silêncio. Pausa menor que isso (respirar, "ééé", pensar) continua na mesma fala;
  é assim que dá para ir acrescentando coisas.
- Enquanto o Night fala, só conta fala firme e mais longa (barge-in), para não ouvir a própria voz.
- O áudio só existe na memória enquanto a fala está aberta; nada é gravado em disco.
"""

from __future__ import annotations

import os
import queue
import threading
import time
from collections import deque
from typing import Callable

import numpy as np
import sounddevice as sd

RATE = 16_000
FRAME = 512  # 32 ms: o tamanho que o Silero espera em 16 kHz
CONTEXT = 64
FRAME_S = FRAME / RATE

# 04/11 no uso real: barulho de fundo disparava "fala" vazia. Começo exige voz mais clara e por ~0,16 s.
START_PROB = float(os.environ.get("NIGHT_VAD_START", "0.6"))
START_FRAMES = 5
END_PROB = 0.35
END_SILENCE_S = float(os.environ.get("NIGHT_END_SILENCE_S", "1.3"))
PRE_ROLL_FRAMES = 10  # ~0,3 s
MIN_SPEECH_S = 0.6
MAX_UTTERANCE_S = 60.0
# Barge-in: com o Night falando, precisa de voz mais clara e por mais tempo.
BARGE_PROB = 0.8
BARGE_FRAMES = 10  # ~0,3 s


def input_device() -> int | None:
    """NIGHT_MIC="Iriun" escolhe o microfone pelo nome (pedaço basta). Sem a variável, o padrão do Windows.
    Fone Bluetooth com microfone ligado grava com qualidade de telefone; microfone com fio/webcam costuma ir melhor."""
    want = os.environ.get("NIGHT_MIC", "").strip().lower()
    if not want:
        return None
    for i, d in enumerate(sd.query_devices()):
        if d["max_input_channels"] > 0 and want in d["name"].lower() and sd.query_hostapis(d["hostapi"])["name"] in ("MME", "Windows WASAPI"):
            return i
    raise RuntimeError(f'microfone "{want}" não encontrado; veja a lista com: python -m night_speech --mics')


class StreamingVad:
    """Silero VAD v6 (o que vem no faster-whisper) rodando quadro a quadro, com estado."""

    def __init__(self) -> None:
        import onnxruntime
        from faster_whisper.utils import get_assets_path

        opts = onnxruntime.SessionOptions()
        opts.inter_op_num_threads = 1
        opts.intra_op_num_threads = 1
        opts.log_severity_level = 4
        self.session = onnxruntime.InferenceSession(
            os.path.join(get_assets_path(), "silero_vad_v6.onnx"), providers=["CPUExecutionProvider"], sess_options=opts)
        self.reset()

    def reset(self) -> None:
        self.h = np.zeros((1, 1, 128), dtype=np.float32)
        self.c = np.zeros((1, 1, 128), dtype=np.float32)
        self.context = np.zeros(CONTEXT, dtype=np.float32)

    def __call__(self, frame: np.ndarray) -> float:
        x = np.concatenate([self.context, frame]).reshape(1, -1).astype(np.float32)
        out, self.h, self.c = self.session.run(None, {"input": x, "h": self.h, "c": self.c})
        self.context = frame[-CONTEXT:]
        return float(np.asarray(out).reshape(-1)[0])


class AutoListener:
    """Chama `on_event` com {"type": "speech_start"} e {"type": "utterance", "audio": ndarray, ...}."""

    def __init__(self, on_event: Callable[[dict], None], is_speaking: Callable[[], bool]) -> None:
        self.vad = StreamingVad()
        self.on_event = on_event
        self.is_speaking = is_speaking
        self.frames: queue.Queue = queue.Queue()
        self.stream: sd.InputStream | None = None
        self.worker: threading.Thread | None = None
        self.running = threading.Event()

    @property
    def active(self) -> bool:
        return self.running.is_set()

    def start(self) -> None:
        if self.running.is_set():
            return
        self.vad.reset()
        self.running.set()

        def on_audio(data, _frames, _time, status):
            self.frames.put(data[:, 0].copy())

        self.stream = sd.InputStream(samplerate=RATE, channels=1, dtype="float32", blocksize=FRAME, callback=on_audio,
                                     device=input_device())
        self.stream.start()
        self.worker = threading.Thread(target=self._loop, daemon=True)
        self.worker.start()

    def stop(self) -> None:
        self.running.clear()
        if self.stream:
            self.stream.stop()
            self.stream.close()
            self.stream = None
        self.frames.put(None)  # acorda o worker
        if self.worker:
            self.worker.join(timeout=2)
            self.worker = None
        while not self.frames.empty():
            self.frames.get_nowait()

    def _loop(self) -> None:
        pre_roll: deque = deque(maxlen=PRE_ROLL_FRAMES)
        speech: list[np.ndarray] = []
        in_speech = False
        voiced_run = 0
        silence_s = 0.0
        voiced_s = 0.0
        pending = np.zeros(0, dtype=np.float32)

        while self.running.is_set():
            chunk = self.frames.get()
            if chunk is None:
                break
            pending = np.concatenate([pending, chunk])
            while len(pending) >= FRAME:
                frame, pending = pending[:FRAME], pending[FRAME:]
                prob = self.vad(frame)

                if not in_speech:
                    pre_roll.append(frame)
                    speaking = self.is_speaking()
                    need_prob, need_frames = (BARGE_PROB, BARGE_FRAMES) if speaking else (START_PROB, START_FRAMES)
                    voiced_run = voiced_run + 1 if prob >= need_prob else 0
                    if voiced_run >= need_frames:
                        in_speech = True
                        speech = list(pre_roll)
                        voiced_s = voiced_run * FRAME_S
                        silence_s = 0.0
                        voiced_run = 0
                        self.on_event({"type": "speech_start", "barge_in": speaking})
                    continue

                speech.append(frame)
                if prob < END_PROB:
                    silence_s += FRAME_S
                else:
                    silence_s = 0.0
                    voiced_s += FRAME_S
                total_s = len(speech) * FRAME_S
                if silence_s >= END_SILENCE_S or total_s >= MAX_UTTERANCE_S:
                    in_speech = False
                    pre_roll.clear()
                    if voiced_s >= MIN_SPEECH_S:
                        # Corta o silêncio do fim, deixando 0,2 s.
                        keep = max(1, len(speech) - int((silence_s - 0.2) / FRAME_S))
                        audio = np.concatenate(speech[:keep])
                        self.on_event({"type": "utterance", "audio": audio, "speech_s": round(voiced_s, 2),
                                       "cut": "max" if total_s >= MAX_UTTERANCE_S else "silence"})
                    else:
                        self.on_event({"type": "speech_discarded", "speech_s": round(voiced_s, 2)})
                    speech = []
                    self.vad.reset()
