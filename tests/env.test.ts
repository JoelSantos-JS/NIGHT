import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentEnv } from '../src/agents/env.ts';

test('agentes não recebem chaves, senhas nem banco (revisão do Codex)', () => {
  const env = agentEnv({
    PATH: 'C:\Windows', USERPROFILE: 'C:\Users\Joel', APPDATA: 'C:\Users\Joel\AppData\Roaming', SystemRoot: 'C:\Windows',
    ANTHROPIC_API_KEY: 'sk-ant-xxx', OPENAI_API_KEY: 'sk-xxx', GITHUB_TOKEN: 'ghp_xxx', NIGHT_DATABASE_URL: 'postgres://night@x/night',
    PGPASSWORD: 'x', AWS_SECRET_ACCESS_KEY: 'x', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'x', RANDOM_THING: 'x',
  });
  assert.deepEqual(Object.keys(env).sort(), ['APPDATA', 'PATH', 'SystemRoot', 'USERPROFILE']);
});
