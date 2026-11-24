import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { escolherFonteRadar, nightPaths } from '../src/app/bootstrap.ts';

// Só caminhos puros: não abre banco, não sobe rede e não chama createNight.
test('nightPaths põe artefatos, vídeo e Flow sob a pasta de dados do NIGHT', () => {
  const raiz = join('D:', 'NIGHT-data');
  const paths = nightPaths(raiz);
  assert.equal(paths.data, raiz);
  assert.equal(paths.artifacts, join(raiz, 'artefatos'));
  assert.equal(paths.videoWork, join(raiz, 'video-work'));
  assert.equal(paths.flowImages, join(raiz, 'flow-import'));
});

test('fonte do Radar: navegador quando existe, fallback explícito e espera sem fonte', () => {
  const base = { metaReadTools: [], workDir: 'D:/NIGHT-data/meta-mcp' };
  const navegador = escolherFonteRadar({ ...base, browserDisponivel: true });
  assert.equal(navegador.source?.name, 'meta-ads-biblioteca');
  assert.match(navegador.descricao, /navegador/);

  // Fonte explícita que não subiu cai no navegador em vez de deixar o Radar cego.
  const claudeSemMcp = escolherFonteRadar({ ...base, provider: 'claude', browserDisponivel: true });
  assert.equal(claudeSemMcp.source?.name, 'meta-ads-biblioteca');

  const desligada = escolherFonteRadar({ ...base, provider: 'off', browserDisponivel: true });
  assert.equal(desligada.source, null);

  const semNada = escolherFonteRadar({ ...base, browserDisponivel: false });
  assert.equal(semNada.source, null, 'sem navegador nem MCP, o Radar espera');
});
