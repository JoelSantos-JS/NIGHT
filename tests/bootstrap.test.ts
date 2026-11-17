import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { nightPaths } from '../src/app/bootstrap.ts';

// Só caminhos puros: não abre banco, não sobe rede e não chama createNight.
test('nightPaths põe artefatos, vídeo e Flow sob a pasta de dados do NIGHT', () => {
  const raiz = join('D:', 'NIGHT-data');
  const paths = nightPaths(raiz);
  assert.equal(paths.data, raiz);
  assert.equal(paths.artifacts, join(raiz, 'artefatos'));
  assert.equal(paths.videoWork, join(raiz, 'video-work'));
  assert.equal(paths.flowImages, join(raiz, 'flow-import'));
});
