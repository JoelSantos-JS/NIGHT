// Qwen local pelo Ollama (blueprint §5). Só fala com 127.0.0.1: nenhuma chamada sai da máquina.

import type { LocalLlm } from '../core/interfaces.ts';

export const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434';
export const DEFAULT_MODEL = 'qwen3:1.7b';

type Message = { role: 'system' | 'user' | 'assistant'; content: string };

export class OllamaLlm implements LocalLlm {
  constructor(
    readonly model = process.env.NIGHT_LOCAL_MODEL ?? DEFAULT_MODEL,
    private readonly baseUrl = process.env.OLLAMA_HOST_URL ?? DEFAULT_OLLAMA_URL,
    private readonly timeoutMs = 120_000,
  ) {
    const host = new URL(baseUrl).hostname;
    if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)) {
      throw new Error(`Ollama precisa ser local; recusando ${baseUrl}`);
    }
  }

  async chat(messages: Message[], opts: { json?: boolean } = {}): Promise<string> {
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        messages,
        stream: false,
        // Raciocínio do Qwen3 desligado: em conversa curta ele só atrasa a resposta.
        think: false,
        ...(opts.json ? { format: 'json' } : {}),
        // 0.4 e não mais: no 1.7B, temperatura alta inventa fatos (medido em 03/11: "Linux num PDP-11 em 1964").
        // num_gpu 0 = só processador. Medido em 03/11: 1.7B no Ryzen 5 5500 dá 22 tok/s; na RX 550 (Vulkan),
        // 9,7 tok/s. NIGHT_LLM_GPU=1 volta para a placa (usa menos RAM, mas é mais lento).
        // num_thread 4: medido em 04/11, 23,6 tok/s (igual a 6 threads) e deixa núcleos livres para o Whisper,
        // que chegou a levar 19 s para transcrever disputando o processador com o Qwen.
        options: {
          temperature: opts.json ? 0 : 0.4,
          ...(process.env.NIGHT_LLM_GPU === '1' ? {} : { num_gpu: 0, num_thread: Number(process.env.NIGHT_LLM_THREADS ?? 4) }),
        },
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`Ollama respondeu ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as { message?: { content?: string } };
    return (body.message?.content ?? '').trim();
  }

  async available(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) return false;
      const { models } = (await res.json()) as { models: { name: string }[] };
      return models.some((m) => m.name === this.model);
    } catch {
      return false;
    }
  }
}
