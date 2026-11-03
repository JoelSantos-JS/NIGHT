import pg from 'pg';
import type { LocalLlm } from '../src/core/interfaces.ts';

export const TEST_URL = process.env.NIGHT_TEST_DATABASE_URL ?? 'postgres://night@localhost:5433/night_test';

/** Zera o schema do banco de teste. Recusa qualquer banco que não termine em _test. */
export async function resetTestDb(url: string = TEST_URL): Promise<void> {
  const db = new URL(url).pathname.slice(1);
  if (!db.endsWith('_test')) throw new Error(`recusando zerar "${db}": não é banco de teste`);
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  } finally {
    await client.end();
  }
}

export async function truncateAll(url: string = TEST_URL): Promise<void> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query('TRUNCATE route_log, approvals, task_events, tasks, ideas, projects');
  } finally {
    await c.end();
  }
}

/** Modelo falso: devolve o que a função mandar e guarda cada chamada. */
export class FakeLlm implements LocalLlm {
  readonly model = 'fake-local';
  calls: { messages: { role: string; content: string }[]; json: boolean }[] = [];
  constructor(private readonly answer: (messages: { role: string; content: string }[], json: boolean) => string = () => 'ok') {}
  async chat(messages: { role: 'system' | 'user' | 'assistant'; content: string }[], opts: { json?: boolean } = {}): Promise<string> {
    this.calls.push({ messages, json: !!opts.json });
    return this.answer(messages, !!opts.json);
  }
}

/** Pesquisador falso: devolve a resposta, ou lança o erro, e guarda as perguntas. */
export class FakeResearcher {
  questions: string[] = [];
  contexts: (string | undefined)[] = [];
  constructor(readonly id: string, private readonly behavior: string | Error) {}
  async ask(question: string, _language?: string, context?: string): Promise<{ answer: string; ms: number }> {
    this.questions.push(question);
    this.contexts.push(context);
    if (this.behavior instanceof Error) throw this.behavior;
    return { answer: this.behavior, ms: 1234 };
  }
}
