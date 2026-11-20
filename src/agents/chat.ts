// Conversa normal com os modelos da assinatura: Claude Sonnet e Codex gpt-6-luna, alternando (pedido do Joel,
// 04/11: o Qwen 1.7B "ignora ou não entende" a conversa). Sem ferramenta nenhuma: só conversam.
// Mesmo cuidado da pesquisa: CLIs oficiais, ambiente mínimo (env.ts), nunca API paga.

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Language } from '../core/types.ts';
import { findClaudeBin, findCodexBin, QuotaError, runCli } from './research.ts';

export interface ChatTurn {
  role: 'owner' | 'night';
  text: string;
}

export interface ChatAgent {
  /** "claude:sonnet", "codex:gpt-6-luna" — vai para o route_log. */
  readonly id: string;
  reply(history: ChatTurn[], text: string, language: Language, context: string): Promise<string>;
}

const LIMIT_RE = /usage limit|rate limit|limite de uso|quota|try again at|429|too many requests/i;

const PERSONA: Record<Language, string> = {
  'pt-BR': `Você é o Night, assistente pessoal do Joel, conversando por voz com ele.
Jeito: bem-humorado, amigo esperto e meio debochado; sério quando o assunto é erro, dinheiro, saúde ou algo que preocupa.
Responda em português do Brasil, curto (1 a 4 frases), como fala: sem markdown, sem listas, sem emoji, sem links.
Converse de verdade: dê opinião quando ele pedir, faça uma pergunta de volta quando fizer sentido.
Você não tem internet nesta conversa. Se precisar de fato atual (notícia, preço, resultado de hoje), diga o que você
sabe, deixe claro que pode estar desatualizado e sugira "pesquisa isso". Não invente. Não execute nada.
Você não abre site nem link e não tira print. Se ele quiser dados de um site, diga que é só mandar o link sozinho ou
"pesquisa <o link>": o Night abre pela pesquisa. Nunca diga que você ou outro modelo acessou, anotou ou guardou algo
que não aparece na conversa.`,
  en: `You are Night, Joel's personal assistant, talking with him by voice.
Style: good-humored, a witty friend with a bit of sass; serious about errors, money, health or anything worrying.
Answer in English, short (1 to 4 sentences), spoken style: no markdown, no lists, no emoji, no links.
Really talk: give an opinion when asked, ask something back when it makes sense.
You have no internet in this conversation. If a current fact is needed (news, price, today's result), say what you
know, make clear it may be outdated and suggest "search for it". Don't make things up. Don't run anything.
You don't open sites or links and can't take screenshots. If he wants data from a site, tell him to send the link
alone or "search <the link>": Night opens it through search. Never claim you or another model accessed, noted or
saved something that isn't in the conversation.`,
};

export function chatPrompt(history: ChatTurn[], text: string, language: Language, context: string): string {
  const who = (r: ChatTurn['role']) => (r === 'owner' ? 'Joel' : 'Night');
  const convo = history.slice(-10).map((t) => `${who(t.role)}: ${t.text}`).join('\n');
  return `${PERSONA[language]}

<contexto_night>
${context}
</contexto_night>
${convo ? `\nConversa até agora:\n${convo}\n` : ''}
Joel: ${text}
Night:`;
}

export class ClaudeChat implements ChatAgent {
  readonly id: string;
  constructor(private readonly model = process.env.NIGHT_CHAT_CLAUDE_MODEL ?? 'sonnet', private readonly bin = findClaudeBin(), private readonly timeoutMs = 90_000) {
    this.id = `claude:${model}`;
  }

  async reply(history: ChatTurn[], text: string, language: Language, context: string): Promise<string> {
    const dir = mkdtempSync(path.join(tmpdir(), 'night-chat-'));
    try {
      const r = await runCli(this.bin, [
        '-p', chatPrompt(history, text, language, context),
        '--model', this.model,
        '--tools', '', // nenhuma ferramenta: só conversa
        '--output-format', 'json', '--no-session-persistence',
      ], dir, this.timeoutMs);
      let parsed: { result?: string; is_error?: boolean } = {};
      try { parsed = JSON.parse(r.stdout); } catch { /* erro abaixo */ }
      const answer = (parsed.result ?? '').trim();
      if (r.code !== 0 || parsed.is_error || !answer) {
        const tail = (answer || r.stderr || r.stdout).trim().slice(-300);
        if (LIMIT_RE.test(tail)) throw new QuotaError(`Claude no limite de uso: ${tail}`);
        throw new Error(`Claude falhou (código ${r.code}): ${tail}`);
      }
      return answer;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

export class CodexChat implements ChatAgent {
  readonly id: string;
  constructor(private readonly model = process.env.NIGHT_CHAT_CODEX_MODEL ?? 'gpt-6-luna', private readonly bin = findCodexBin(), private readonly timeoutMs = 90_000) {
    this.id = `codex:${model}`;
  }

  async reply(history: ChatTurn[], text: string, language: Language, context: string): Promise<string> {
    if (!this.bin) throw new Error('Codex não encontrado');
    const dir = mkdtempSync(path.join(tmpdir(), 'night-chat-'));
    const out = path.join(dir, 'answer.txt');
    try {
      const r = await runCli(this.bin, [
        'exec', '--model', this.model, '-c', 'model_reasoning_effort="low"',
        '--sandbox', 'read-only', '--skip-git-repo-check', '--ephemeral',
        '-C', dir, '-o', out, chatPrompt(history, text, language, context),
      ], dir, this.timeoutMs);
      const answer = existsSync(out) ? readFileSync(out, 'utf8').trim() : '';
      if (!answer) {
        const tail = (r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ');
        if (LIMIT_RE.test(tail)) throw new QuotaError(`Codex no limite de uso: ${tail}`);
        throw new Error(`Codex falhou (código ${r.code}): ${tail}`);
      }
      return answer;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
