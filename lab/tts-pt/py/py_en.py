"""Kokoro em inglês pelo mesmo pacote (lang_code='a'), para confirmar que um processo atende EN e PT."""
import os, time
os.environ.setdefault("HF_HOME", "D:/NIGHT-data/hf-py")
import soundfile as sf, torch
from kokoro import KPipeline
torch.set_num_threads(max(1, (os.cpu_count() or 2) // 2))
pipe = KPipeline(lang_code="a", repo_id="hexgrad/Kokoro-82M")
for i, frase in enumerate(["I saved your idea for Abstrike.", "Claude finished the parser task. Three files changed and all twelve tests passed."], 1):
    t = time.perf_counter()
    audio = torch.cat([p.audio for p in pipe(frase, voice="af_heart")]).numpy()
    dt = time.perf_counter() - t
    sf.write(f"../out/py-en-af_heart-{i}.wav", audio, 24000)
    print(f"af_heart #{i}: {dt:.2f}s para {len(audio)/24000:.1f}s (RTF {dt/(len(audio)/24000):.2f})", flush=True)
