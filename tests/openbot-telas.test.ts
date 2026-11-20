import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildImportManifest, zipStored } from '../scripts/openbot-telas.ts';
import { TELAS } from '../src/app/server.ts';

const ler = (t: string) => readFileSync(join(import.meta.dirname, '..', 'openbot', 'telas', `${t}.md`), 'utf8');

test('manifesto do OpenBot: 8 telas com chave válida e instruções dentro do limite', () => {
  const m = buildImportManifest(ler) as { format: string; version: number; agents: { key: string; name: string; description: string }[] };
  assert.equal(m.format, 'openbot-agent-import');
  assert.equal(m.version, 1);
  assert.equal(m.agents.length, 8);
  assert.deepEqual(m.agents.map((a) => a.key), [...TELAS]);
  for (const a of m.agents) {
    assert.match(a.key, /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/);
    assert.ok(a.name.length <= 80);
    assert.ok(a.description.length <= 2000, `${a.key}: ${a.description.length}`);
    assert.match(a.description, new RegExp(`tela: "${a.key}"`), 'cada tela se identifica certo no night_pedir');
    assert.match(a.description, /Nunca escreva "aprovo"/);
  }
});

test('design e marketing: até 2.000 caracteres e relatam na própria tela', () => {
  for (const tela of ['design', 'marketing'] as const) {
    const texto = ler(tela);
    assert.ok(texto.length <= 2000, `${tela}: ${texto.length}`);
    assert.match(texto, /night_relatar/, `${tela} registra a etapa no night_relatar`);
    assert.match(texto, new RegExp(`night_relatar[^]*tela: "${tela}"`), `${tela} relata com a própria tela`);
  }
});

test('instrução longa demais é recusada em vez de cortada', () => {
  assert.throws(() => buildImportManifest(() => 'x'.repeat(2001)), /máximo 2000/);
});

test('zip sem compressão tem o arquivo na raiz, com CRC certo', () => {
  const data = Buffer.from('{"oi":"ação"}', 'utf8');
  const zip = zipStored([{ name: 'openbot-import.json', data }]);
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  const nomeLen = zip.readUInt16LE(26);
  assert.equal(zip.subarray(30, 30 + nomeLen).toString('utf8'), 'openbot-import.json');
  assert.deepEqual(zip.subarray(30 + nomeLen, 30 + nomeLen + data.length), data);
  const fim = zip.subarray(zip.length - 22);
  assert.equal(fim.readUInt32LE(0), 0x06054b50);
  assert.equal(fim.readUInt16LE(10), 1);
});
