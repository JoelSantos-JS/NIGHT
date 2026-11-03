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
        options: { temperature: opts.json ? 0 : 0.6 },
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
