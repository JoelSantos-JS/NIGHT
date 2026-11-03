"""Teste do Kokoro em PT-BR pelo pacote oficial `kokoro` (lang_code='p', G2P espeak-ng pt-br).
Roda: .venv/Scripts/python py_pt.py  ->  gera ../out/py-<voz>-<n>.wav e imprime tempos."""
import os, sys, time

os.environ.setdefault("HF_HOME", "D:/NIGHT-data/hf-py")
import soundfile as sf
import torch
from kokoro import KPipeline

FRASES = [
    "Salvei a sua ideia no projeto Abstrike. Quer que eu marque para revisar na semana que vem?",
    "O Claude terminou a tarefa do parser. Três arquivos mudaram e os doze testes passaram.",
    "Não encontrei nenhuma tarefa rodando agora. A última, do Codex, falhou às quatorze e trinta.",
]
VOZES = ["pf_dora", "pm_alex"]

torch.set_num_threads(max(1, (os.cpu_count() or 2) // 2))
os.makedirs("../out", exist_ok=True)
t = time.perf_counter()
pipe = KPipeline(lang_code="p", repo_id="hexgrad/Kokoro-82M")
print(f"pipeline carregada em {time.perf_counter() - t:.1f}s", flush=True)

for voz in VOZES:
    for i, frase in enumerate(FRASES, 1):
        t = time.perf_counter()
        partes = list(pipe(frase, voice=voz, speed=1))
        audio = torch.cat([p.audio for p in partes]).numpy()
        dt = time.perf_counter() - t
        seg = len(audio) / 24000
        sf.write(f"../out/py-{voz}-{i}.wav", audio, 24000)
        print(f"{voz} #{i}: {dt:.2f}s para {seg:.1f}s de áudio (RTF {dt / seg:.2f})", flush=True)
        if voz == VOZES[0]:
            print("   fonemas:", " | ".join(p.phonemes for p in partes), flush=True)
