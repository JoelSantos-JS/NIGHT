// Teste do serviço de voz real (Kokoro + Whisper). Lento (~30 s para carregar), por isso fica fora do
// `pnpm test`: roda com `pnpm test:voz`. Não usa microfone nem toca som: gera WAV e transcreve de volta.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { normalize } from '../../src/router/router.ts';
import { SpeechService } from '../../src/speech/speech-service.ts';

const words = (s: string) => normalize(s).replace(/[^\p{L}\p{N} ]/gu, ' ').split(' ').filter(Boolean);
/** Fração das palavras esperadas que aparecem na transcrição. */
function recall(expected: string, got: string): number {
  const g = new Set(words(got));
  const e = words(expected);
  return e.filter((w) => g.has(w)).length / e.length;
}

describe('serviço de voz (ida e volta)', { timeout: 300_000 }, () => {
  const speech = new SpeechService();
  const dir = mkdtempSync(path.join(tmpdir(), 'night-voz-'));
  before(async () => { await speech.start(); });
  after(async () => { await speech.close(); rmSync(dir, { recursive: true, force: true }); });

  const cases = [
    { lang: 'pt-BR' as const, text: 'Salva essa ideia para o Soaken: lembrar o usuário de praticar todo dia.' },
    { lang: 'pt-BR' as const, text: 'O que você está fazendo agora?' },
    { lang: 'en' as const, text: 'Ask Claude to write the parser in its own branch.' },
    { lang: 'en' as const, text: "What's running right now?" },
  ];
  for (const [i, c] of cases.entries()) {
    test(`${c.lang}: "${c.text}"`, async () => {
      const file = path.join(dir, `${i}.wav`);
      const { audioSeconds } = await speech.synthesizeToFile(c.text, c.lang, file);
      assert.ok(audioSeconds > 0.5);
      const heard = await speech.transcribeFile(file); // sem dica de idioma: testa a detecção também
      assert.equal(heard.language, c.lang, `idioma errado: ${heard.text}`);
      const r = recall(c.text, heard.text);
      assert.ok(r >= 0.8, `só ${(r * 100).toFixed(0)}% das palavras: "${heard.text}"`);
    });
  }

  test('fecha o microfone que não abriu dá erro claro', async () => {
    await assert.rejects(speech.stopListening(), /não estava ouvindo/);
  });
});
