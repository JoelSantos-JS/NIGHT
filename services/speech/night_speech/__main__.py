"""Serviço de voz do Night: Kokoro (falar) + faster-whisper (ouvir), tudo local.

Fala com o Node por JSON, uma mensagem por linha:
  entrada  {"id": 1, "type": "speak", "text": "...", "lang": "pt-BR"|"en"}
           {"type": "stop"}                      -> para de falar na hora
           {"id": 2, "type": "listen_start"}     -> abre o microfone
           {"id": 2, "type": "listen_stop", "lang": null|"pt-BR"|"en"}  -> fecha e transcreve
           {"type": "shutdown"}
           {"id": 3, "type": "transcribe_file", "path": "x.wav", "lang": null}   (testes, sem microfone)
           {"id": 4, "type": "synth_file", "text": "...", "lang": "pt-BR", "path": "x.wav"}  (testes, sem tocar)
  saída    {"type": "ready", ...}
           {"id": 1, "type": "spoken", "interrupted": false, "ms": 1234}
           {"id": 2, "type": "listening"}
           {"id": 2, "type": "final", "text": "...", "language": "pt-BR", "ms": 900, "audio_s": 3.1}
           {"id": n, "type": "error", "message": "..."}
Logs vão para stderr. Nada aqui acessa a rede depois que os modelos estão no cache.
"""

from __future__ import annotations

import json
import os
import queue
import sys
import threading
import time

os.environ.setdefault("HF_HOME", "D:/NIGHT-data/hf-py")
# Depois do primeiro download, não deixa a biblioteca consultar a internet: NIGHT_SPEECH_OFFLINE=1.
if os.environ.get("NIGHT_SPEECH_OFFLINE") == "1":
    os.environ["HF_HUB_OFFLINE"] = "1"

import numpy as np
import sounddevice as sd

SAMPLE_RATE_IN = 16_000
SAMPLE_RATE_OUT = 24_000
MAX_LISTEN_S = 60  # o microfone nunca fica aberto mais que isso (blueprint §6)
VOICES = {
    "pt-BR": os.environ.get("NIGHT_VOICE_PT", "pm_santa"),
    "en": os.environ.get("NIGHT_VOICE_EN", "am_puck"),
}
KOKORO_LANG = {"pt-BR": "p", "en": "a"}
WHISPER_MODEL = os.environ.get("NIGHT_WHISPER_MODEL", "small")
THREADS = max(1, (os.cpu_count() or 2) // 2)

_out_lock = threading.Lock()


def send(msg: dict) -> None:
    with _out_lock:
        sys.stdout.write(json.dumps(msg, ensure_ascii=False) + "\n")
        sys.stdout.flush()


def log(*args) -> None:
    print("[speech]", *args, file=sys.stderr, flush=True)


class Speaker:
    """Kokoro, uma pipeline por idioma, e um só áudio tocando por vez."""

    def __init__(self) -> None:
        import torch
        from kokoro import KModel, KPipeline

        torch.set_num_threads(THREADS)
        # Um modelo só para os dois idiomas: cada KPipeline sem `model` carregaria uma cópia própria.
        model = KModel(repo_id="hexgrad/Kokoro-82M").eval()
        self.pipes = {lang: KPipeline(lang_code=code, repo_id="hexgrad/Kokoro-82M", model=model)
                      for lang, code in KOKORO_LANG.items()}
        self.stop_flag = threading.Event()
        for lang in self.pipes:  # aquece: a 1ª síntese é bem mais lenta
            list(self._synth("ok", lang))

    def _synth(self, text: str, lang: str):
        for part in self.pipes[lang](text, voice=VOICES[lang], speed=1):
            if part.audio is not None:
                yield part.audio.numpy()

    def speak(self, text: str, lang: str) -> bool:
        """Fala frase por frase; devolve True se foi interrompido."""
        self.stop_flag.clear()
        for chunk in self._synth(text, lang if lang in self.pipes else "pt-BR"):
            if self.stop_flag.is_set():
                return True
            sd.play(chunk, SAMPLE_RATE_OUT)
            while sd.get_stream().active:
                if self.stop_flag.wait(0.05):
                    sd.stop()
                    return True
        return self.stop_flag.is_set()

    def stop(self) -> None:
        self.stop_flag.set()


class Listener:
    """Microfone só aberto entre listen_start e listen_stop; transcrição com faster-whisper."""

    def __init__(self) -> None:
        from faster_whisper import WhisperModel

        self.model = WhisperModel(WHISPER_MODEL, device="cpu", compute_type="int8", cpu_threads=THREADS)
        self.stream: sd.InputStream | None = None
        self.chunks: list[np.ndarray] = []
        self.opened_at = 0.0

    def start(self) -> None:
        if self.stream:
            raise RuntimeError("o microfone já está aberto")
        self.chunks = []
        self.opened_at = time.monotonic()

        def on_audio(data, _frames, _time, status):
            if status:
                log("mic:", status)
            if time.monotonic() - self.opened_at < MAX_LISTEN_S:
                self.chunks.append(data[:, 0].copy())

        self.stream = sd.InputStream(samplerate=SAMPLE_RATE_IN, channels=1, dtype="float32", callback=on_audio)
        self.stream.start()

    def stop(self, lang_hint: str | None) -> dict:
        if not self.stream:
            raise RuntimeError("o microfone não estava aberto")
        self.stream.stop()
        self.stream.close()
        self.stream = None
        audio = np.concatenate(self.chunks) if self.chunks else np.zeros(0, dtype=np.float32)
        return self.transcribe(audio, lang_hint)

    def transcribe(self, audio: np.ndarray, lang_hint: str | None) -> dict:
        audio_s = len(audio) / SAMPLE_RATE_IN
        if audio_s < 0.3:
            return {"text": "", "language": lang_hint, "audio_s": round(audio_s, 2), "ms": 0}
        t = time.perf_counter()
        language = {"pt-BR": "pt", "en": "en"}.get(lang_hint or "")
        if not language:
            # Só PT ou EN: entre os dois, o mais provável. Evita o Whisper "achar" galego ou espanhol.
            _, _, probs = self.model.detect_language(audio)
            p = dict(probs)
            language = "en" if p.get("en", 0) > p.get("pt", 0) else "pt"
        # Os nomes próprios no prompt ajudam o Whisper a escrevê-los certo.
        segments, _ = self.model.transcribe(audio, language=language, vad_filter=True, beam_size=5,
                                            initial_prompt="Night, Claude, Codex, Soaken.")
        text = " ".join(s.text.strip() for s in segments).strip()
        return {"text": text, "language": "en" if language == "en" else "pt-BR", "audio_s": round(audio_s, 2),
                "ms": round((time.perf_counter() - t) * 1000)}


def load_wav_16k(path: str) -> np.ndarray:
    """Lê um WAV e converte para mono 16 kHz (para testes sem microfone)."""
    import soundfile as sf

    data, rate = sf.read(path, dtype="float32", always_2d=True)
    mono = data.mean(axis=1)
    if rate != SAMPLE_RATE_IN:
        n = int(len(mono) * SAMPLE_RATE_IN / rate)
        mono = np.interp(np.linspace(0, len(mono) - 1, n), np.arange(len(mono)), mono).astype(np.float32)
    return mono


def main() -> None:
    t = time.perf_counter()
    speaker = Speaker()
    listener = Listener()
    send({"type": "ready", "load_ms": round((time.perf_counter() - t) * 1000), "voices": VOICES,
          "whisper": WHISPER_MODEL, "input": sd.query_devices(kind="input")["name"],
          "output": sd.query_devices(kind="output")["name"]})

    # Fala numa thread própria: "stop" e "listen_start" precisam funcionar enquanto ela fala.
    speak_q: queue.Queue = queue.Queue()

    def speak_worker():
        while True:
            job = speak_q.get()
            if job is None:
                return
            t0 = time.perf_counter()
            try:
                interrupted = speaker.speak(job["text"], job.get("lang", "pt-BR"))
                send({"id": job.get("id"), "type": "spoken", "interrupted": interrupted,
                      "ms": round((time.perf_counter() - t0) * 1000)})
            except Exception as e:  # noqa: BLE001
                send({"id": job.get("id"), "type": "error", "message": f"fala: {e}"})

    threading.Thread(target=speak_worker, daemon=True).start()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            send({"type": "error", "message": f"JSON inválido: {line[:80]}"})
            continue
        kind, mid = msg.get("type"), msg.get("id")
        try:
            if kind == "speak":
                speak_q.put(msg)
            elif kind == "stop":
                speaker.stop()
                # descarta o que estava na fila para falar
                while not speak_q.empty():
                    job = speak_q.get_nowait()
                    send({"id": job.get("id"), "type": "spoken", "interrupted": True, "ms": 0})
            elif kind == "listen_start":
                speaker.stop()  # começou a falar: o Night se cala
                listener.start()
                send({"id": mid, "type": "listening"})
            elif kind == "listen_stop":
                send({"id": mid, "type": "final", **listener.stop(msg.get("lang"))})
            elif kind == "transcribe_file":
                send({"id": mid, "type": "final", **listener.transcribe(load_wav_16k(msg["path"]), msg.get("lang"))})
            elif kind == "synth_file":
                # Gera WAV sem tocar (testes).
                import soundfile as sf
                lang = msg.get("lang", "pt-BR")
                audio = np.concatenate(list(speaker._synth(msg["text"], lang)))
                sf.write(msg["path"], audio, SAMPLE_RATE_OUT)
                send({"id": mid, "type": "synthesized", "path": msg["path"], "audio_s": round(len(audio) / SAMPLE_RATE_OUT, 2)})
            elif kind == "shutdown":
                break
            else:
                send({"id": mid, "type": "error", "message": f"tipo desconhecido: {kind}"})
        except Exception as e:  # noqa: BLE001
            send({"id": mid, "type": "error", "message": str(e)})

    speaker.stop()
    speak_q.put(None)


if __name__ == "__main__":
    main()
