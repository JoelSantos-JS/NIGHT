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
from night_speech.auto import input_device
import sounddevice as sd

SAMPLE_RATE_IN = 16_000
SAMPLE_RATE_OUT = 24_000
MAX_LISTEN_S = 60  # o microfone nunca fica aberto mais que isso (blueprint §6)
VOICES = {
    "pt-BR": os.environ.get("NIGHT_VOICE_PT", "pm_santa"),
    "en": os.environ.get("NIGHT_VOICE_EN", "pm_santa"),
}
KOKORO_LANG = {"pt-BR": "p", "en": "a"}
WHISPER_MODEL = os.environ.get("NIGHT_WHISPER_MODEL", "small")
# Frase natural, não lista de palavras: com a lista ("pesquisa pra mim, pesquisar, pesquisando, ...") o Whisper
# copiava o prompt na transcrição ("Night, pesquisar, pesquisar, pesquisar", uso real 04/11).
WHISPER_PROMPT_PT = os.environ.get("NIGHT_STT_PROMPT_PT", "Oi Night, pesquisa pra mim uma coisa e depois fala com o Claude e o Codex.")
WHISPER_PROMPT_EN = os.environ.get("NIGHT_STT_PROMPT_EN", "Hey Night, search something for me and then talk to Claude and Codex.")
WHISPER_FALLBACK = "base"
# Motor da transcrição. "groq" (padrão quando há chave): Whisper large-v3 na nuvem do Groq, medido 18/11 com a voz do
# Joel no fone Bluetooth: 16% de palavras erradas × 29% do small local, em 0,5 s por fala (D-016). O áudio da fala
# sai do PC. "local": só o Whisper do PC. Com Groq, o local continua carregado como reserva (sem internet, limite).
STT_ENGINE = os.environ.get("NIGHT_STT", "auto")
# Confiança mínima do Whisper. Fala lida e clara fica entre -0,1 e -0,5; fala longa e espontânea do Joel cai mais
# (04/11: uma fala de 16 s transcrita certinha foi descartada com o limite único de -0,8). Frase curta é onde ele
# inventa ("So watch the events"), então lá o limite é rígido; fala longa ganha folga.
MIN_AVG_LOGPROB = float(os.environ.get("NIGHT_STT_MIN_LOGPROB", "-0.8"))        # fala com menos de 4 s
MIN_AVG_LOGPROB_LONG = float(os.environ.get("NIGHT_STT_MIN_LOGPROB_LONG", "-1.4"))  # fala de 4 s ou mais
MAX_NO_SPEECH = float(os.environ.get("NIGHT_STT_MAX_NO_SPEECH", "0.6"))
THREADS = max(1, (os.cpu_count() or 2) // 2)

_out_lock = threading.Lock()
# O stdout é só do protocolo. Bibliotecas que dão print (spaCy, misaki...) vão parar no stderr.
_protocol = sys.stdout
sys.stdout = sys.stderr


def send(msg: dict) -> None:
    with _out_lock:
        _protocol.write(json.dumps(msg, ensure_ascii=False) + "\n")
        _protocol.flush()


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
        self.speaking = threading.Event()  # a escuta automática usa para não ouvir a própria voz
        for lang in self.pipes:  # aquece: a 1ª síntese é bem mais lenta
            list(self._synth("ok", lang))

    def _synth(self, text: str, lang: str):
        for part in self.pipes[lang](text, voice=VOICES[lang], speed=1):
            if part.audio is not None:
                yield part.audio.numpy()

    def speak(self, text: str, lang: str) -> bool:
        """Fala frase por frase; devolve True se foi interrompido."""
        self.stop_flag.clear()
        self.speaking.set()
        try:
            for chunk in self._synth(text, lang if lang in self.pipes else "pt-BR"):
                if self.stop_flag.is_set():
                    return True
                sd.play(chunk, SAMPLE_RATE_OUT)
                while sd.get_stream().active:
                    if self.stop_flag.wait(0.05):
                        sd.stop()
                        return True
            return self.stop_flag.is_set()
        finally:
            self.speaking.clear()

    def stop(self) -> None:
        self.stop_flag.set()


class Listener:
    """Microfone só aberto entre listen_start e listen_stop; transcrição com faster-whisper."""

    def __init__(self) -> None:
        from faster_whisper import WhisperModel

        self.model_name = WHISPER_MODEL
        try:
            self.model = WhisperModel(WHISPER_MODEL, device="cpu", compute_type="int8", cpu_threads=THREADS)
        except (RuntimeError, MemoryError) as e:
            if WHISPER_MODEL == WHISPER_FALLBACK:
                raise
            log(f"whisper {WHISPER_MODEL} não coube ({e}); usando {WHISPER_FALLBACK}")
            self.model_name = WHISPER_FALLBACK
            self.model = WhisperModel(WHISPER_FALLBACK, device="cpu", compute_type="int8", cpu_threads=THREADS)
        self.groq = None
        if STT_ENGINE in ("auto", "groq"):
            from night_speech.groq import GroqStt, groq_key

            if groq_key():
                self.groq = GroqStt()
            elif STT_ENGINE == "groq":
                log("NIGHT_STT=groq, mas não há chave (GROQ_API_KEY ou ~/.groq/api_key); usando o Whisper local")
        self.engine = f"groq:{self.groq.model} (reserva {self.model_name})" if self.groq else self.model_name
        # Só a voz do Joel: vídeo tocando, outra pessoa e a voz do próprio Night ficam de fora (D-016).
        from night_speech.dono import PerfilDono

        try:
            self.dono = PerfilDono.carregar()
        except Exception as e:  # noqa: BLE001
            log(f"filtro de voz do dono desligado: {e}")
            self.dono = None
        if self.dono:
            self.engine += f" · só a voz do dono (mín {self.dono.minimo:.2f})"
        self.stream: sd.InputStream | None = None
        self.chunks: list[np.ndarray] = []
        self.opened_at = 0.0
        self.lock = threading.Lock()  # o Whisper é usado pela escuta automática e pelos comandos

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
        with self.lock:
            return self._transcribe(audio, lang_hint)

    def _transcribe(self, audio: np.ndarray, lang_hint: str | None) -> dict:
        audio_s = len(audio) / SAMPLE_RATE_IN
        if audio_s < 0.3:
            return {"text": "", "language": lang_hint, "audio_s": round(audio_s, 2), "ms": 0}
        t = time.perf_counter()
        # Ruído forte: limpa antes. Só quando o fundo está alto — com ruído leve a limpeza piora palavras
        # (medido 04/11: "seu" virou "ser"). Custa ~0,2 s.
        denoised = False
        snr = snr_db(audio)
        if snr < DENOISE_BELOW_DB:
            import noisereduce as nr
            audio = nr.reduce_noise(y=audio, sr=SAMPLE_RATE_IN, stationary=False).astype(np.float32)
            denoised = True
        if self.dono:
            # Antes da transcrição: som que não é o Joel nem gasta a cota do Groq.
            sim = self.dono.semelhanca(audio)
            if sim < self.dono.minimo:
                return {"text": "", "doubt": None, "other_voice": round(sim, 2), "snr_db": round(snr, 1),
                        "denoised": denoised, "language": lang_hint, "audio_s": round(audio_s, 2),
                        "ms": round((time.perf_counter() - t) * 1000)}
        r = self._groq(audio, lang_hint) if self.groq else None
        if r is None:
            r = self._local(audio, audio_s, lang_hint)
        text, avg_logprob, no_speech = r["text"], r["avg_logprob"], r["no_speech"]
        min_logprob = MIN_AVG_LOGPROB if audio_s < 4.0 else MIN_AVG_LOGPROB_LONG
        # "Não é fala" só conta junto com confiança baixa: em fala longa o no_speech de um trecho pode subir à toa.
        unsure = avg_logprob < min_logprob or (no_speech > MAX_NO_SPEECH and avg_logprob < -0.5)
        return {"text": "" if unsure else text, "doubt": text if unsure else None, "snr_db": round(snr, 1), "denoised": denoised,
                "confidence": round(avg_logprob, 2), "no_speech": round(no_speech, 2), "engine": r["engine"],
                "language": "en" if r["language"] == "en" else "pt-BR", "audio_s": round(audio_s, 2),
                "ms": round((time.perf_counter() - t) * 1000)}

    def _groq(self, audio: np.ndarray, lang_hint: str | None) -> dict | None:
        """Uma chamada: o Groq acha o idioma (13/13 certos na calibragem, 18/11) com a frase de ajuda nos dois.
        None = falhou (sem internet, limite do plano, chave recusada) e a fala vai para o Whisper local."""
        language = {"pt-BR": "pt", "en": "en"}.get(lang_hint or "")
        prompt = {"pt": WHISPER_PROMPT_PT, "en": WHISPER_PROMPT_EN}.get(language or "", f"{WHISPER_PROMPT_PT} {WHISPER_PROMPT_EN}")
        try:
            r = self.groq.transcribe(audio, language, prompt)
            achado = (r["language"] or language or "").lower()
            if not language and not achado.startswith(("english", "portug", "en", "pt")):
                # Achou outro idioma (galego, espanhol...): só PT ou EN; na dúvida, português (o padrão do Joel).
                language = "pt"
                r = self.groq.transcribe(audio, "pt", WHISPER_PROMPT_PT)
                achado = "pt"
        except Exception as e:  # noqa: BLE001
            log(f"groq falhou ({str(e)[:160]}); usando o Whisper local")
            return None
        text = r["text"]
        return {"text": text, "engine": f"groq:{self.groq.model}",
                "language": "en" if achado.startswith("en") else "pt",
                "avg_logprob": r["avg_logprob"] if r["avg_logprob"] is not None else (0.0 if text else -9.0),
                "no_speech": r["no_speech"] if r["no_speech"] is not None else (0.0 if text else 1.0)}

    def _local(self, audio: np.ndarray, audio_s: float, lang_hint: str | None) -> dict:
        language = {"pt-BR": "pt", "en": "en"}.get(lang_hint or "")
        if not language:
            # Só PT ou EN: entre os dois, o mais provável. Evita o Whisper "achar" galego ou espanhol.
            # 04/11 no uso real: falas de 1 a 2 s saíram inglês inventado ("So watch the events", "Night was the
            # day"). Abaixo de 3 s, inglês só com certeza alta. Na dúvida, português (o padrão do Joel).
            _, _, probs = self.model.detect_language(audio)
            p = dict(probs)
            p_en, p_pt = p.get("en", 0), p.get("pt", 0)
            if audio_s < 3.0:
                language = "en" if p_en >= 0.75 and p_en > p_pt * 3 else "pt"
            else:
                language = "en" if p_en > p_pt * 1.5 else "pt"
        # O prompt puxa o Whisper para o vocabulário dos comandos. Sem "pesquisar" aqui, ele ouvia "precisar"
        # (04/11: "você consegue pesquisar para mim?" virou "precisar" e o pedido não foi reconhecido).
        prompt = (WHISPER_PROMPT_EN if language == "en" else WHISPER_PROMPT_PT)
        # Fala longa com beam 1: medido 04/11, 4,7 s × 7,3 s para 21 s de áudio, mesmo texto. Comando curto
        # fica com beam 5 (é onde uma palavra errada muda o pedido).
        segments, _ = self.model.transcribe(audio, language=language, vad_filter=True,
                                            beam_size=5 if audio_s < 6.0 else 1, initial_prompt=prompt)
        segs = list(segments)
        text = " ".join(s.text.strip() for s in segs).strip()
        # Confiança: o Whisper "chuta" frase quando não entendeu (ruído, fala baixa, microfone Bluetooth ruim).
        # Média do log-prob baixa ou "provavelmente não é fala" → devolve vazio em vez de inventar.
        if segs:
            avg_logprob = sum(s.avg_logprob * (s.end - s.start) for s in segs) / max(1e-6, sum(s.end - s.start for s in segs))
            no_speech = max(s.no_speech_prob for s in segs)
        else:
            avg_logprob, no_speech = -9.0, 1.0
        return {"text": text, "engine": self.model_name, "language": language,
                "avg_logprob": avg_logprob, "no_speech": no_speech}


DENOISE_BELOW_DB = float(os.environ.get("NIGHT_DENOISE_BELOW_DB", "12"))
# Só com NIGHT_SAVE_AUDIO_DIR: guarda cada fala em WAV (calibragem do Whisper com a voz do Joel). Local, e só
# as últimas SAVE_KEEP ficam; sem a variável, nada de áudio vai para o disco (blueprint §9).
SAVE_DIR = os.environ.get("NIGHT_SAVE_AUDIO_DIR", "")
SAVE_KEEP = int(os.environ.get("NIGHT_SAVE_AUDIO_KEEP", "60"))


def save_utterance(audio: np.ndarray) -> str | None:
    if not SAVE_DIR:
        return None
    import soundfile as sf

    os.makedirs(SAVE_DIR, exist_ok=True)
    path = os.path.join(SAVE_DIR, time.strftime("fala-%Y%m%d-%H%M%S") + f"-{int(time.time() * 1000) % 1000:03d}.wav")
    sf.write(path, audio, SAMPLE_RATE_IN)
    files = sorted(f for f in os.listdir(SAVE_DIR) if f.startswith("fala-") and f.endswith(".wav"))
    for old in files[:-SAVE_KEEP]:
        os.remove(os.path.join(SAVE_DIR, old))
    return path


def snr_db(audio: np.ndarray) -> float:
    """Voz × fundo da própria gravação: energia dos trechos altos × dos baixos (quadros de 32 ms)."""
    n = len(audio) // 512
    if n < 10:
        return 99.0
    rms = np.sqrt(np.mean(audio[: n * 512].reshape(n, 512) ** 2, axis=1)) + 1e-9
    return float(20 * np.log10(np.percentile(rms, 90) / np.percentile(rms, 10)))


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
    if "--mics" in sys.argv:
        for i, d in enumerate(sd.query_devices()):
            api = sd.query_hostapis(d["hostapi"])["name"]
            if d["max_input_channels"] > 0 and api in ("MME", "Windows WASAPI"):
                _protocol.write(f"{i:3d}  {d['name']}  ({api})\n")
        return
    t = time.perf_counter()
    speaker = Speaker()
    listener = Listener()
    send({"type": "ready", "load_ms": round((time.perf_counter() - t) * 1000), "voices": VOICES,
          "whisper": listener.engine, "input": sd.query_devices(input_device() if input_device() is not None else sd.default.device[0])["name"],
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

    # Escuta automática: o VAD acha a fala; a transcrição roda em outra thread para o VAD não parar.
    from night_speech.auto import AutoListener

    stt_q: queue.Queue = queue.Queue()

    def on_auto_event(ev: dict) -> None:
        if ev["type"] == "speech_start":
            speaker.stop()  # o dono começou a falar: o Night se cala (barge-in)
            send(ev)
        elif ev["type"] == "utterance":
            stt_q.put(ev)
        else:
            send(ev)

    def stt_worker():
        while True:
            ev = stt_q.get()
            if ev is None:
                return
            try:
                saved = save_utterance(ev["audio"])
                r = listener.transcribe(ev["audio"], None)
                send({"type": "utterance", "speech_s": ev["speech_s"], "cut": ev["cut"], "audio_path": saved, **r})
            except Exception as e:  # noqa: BLE001
                send({"type": "error", "message": f"transcrição: {e}"})

    threading.Thread(target=stt_worker, daemon=True).start()
    auto = AutoListener(on_auto_event, speaker.speaking.is_set)

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
            elif kind == "auto_start":
                auto.start()
                send({"id": mid, "type": "auto", "active": True})
            elif kind == "auto_stop":
                auto.stop()
                send({"id": mid, "type": "auto", "active": False})
            elif kind == "listen_start":
                if auto.active:
                    raise RuntimeError("a escuta automática está ligada; desligue antes de usar o aperta-e-fala")
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

    auto.stop()
    speaker.stop()
    speak_q.put(None)
    stt_q.put(None)


if __name__ == "__main__":
    main()
