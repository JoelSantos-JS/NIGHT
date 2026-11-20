import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { SKILLS_DA_TELA, SKILLS_PROPRIAS, arquivosDasSkills, buildImportManifest, zipStored } from '../scripts/openbot-telas.ts';
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

test('skills ligadas: cada pasta tem SKILL.md com o mesmo nome e licença, e o caminho bate com o manifesto', () => {
  const pasta = join(import.meta.dirname, '..', 'openbot', 'skills');
  const arquivos = arquivosDasSkills(pasta);
  const m = buildImportManifest(ler) as { agents: { key: string; skills: string[] }[] };
  for (const [tela, skills] of Object.entries(SKILLS_DA_TELA)) {
    const agente = m.agents.find((a) => a.key === tela)!;
    assert.deepEqual(agente.skills, skills.map((s) => `agents/${tela}/skills/${s}`));
    for (const s of skills) {
      const skillMd = arquivos.find((a) => a.name === `agents/${tela}/skills/${s}/SKILL.md`);
      assert.ok(skillMd, `${s} sem SKILL.md`);
      // O OpenBot exige name igual ao nome da pasta.
      const linhas = skillMd.data.toString('utf8').split(/\r?\n/);
      const fim = linhas.indexOf('---', 1);
      assert.equal(linhas[0], '---');
      assert.ok(fim > 0 && linhas.slice(1, fim).includes(`name: ${s}`), `${s}: name diferente da pasta`);
      if (!SKILLS_PROPRIAS.has(s)) assert.ok(arquivos.some((a) => a.name.startsWith(`agents/${tela}/skills/${s}/LICENSE`)), `${s} sem licença`);
    }
  }
  // Nenhum caminho com barra invertida, ".." ou cache do Python.
  for (const a of arquivos) assert.doesNotMatch(a.name, /\\|\.\.|__pycache__/);
  assert.deepEqual(m.agents.find((a) => a.key === 'video')!.skills, ['agents/video/skills/viral-video-studio']);
});
