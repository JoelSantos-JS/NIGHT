import assert from 'node:assert/strict';
import { test } from 'node:test';
import { paginaPainel } from '../src/app/painel-ui.ts';

// Chat no celular (pedido do Joel, 20/11): nada passa da borda e o campo de mensagem não dá zoom no iOS.
test('painel responsivo: viewport, coluna do chat que encolhe e compositor no celular', () => {
  const html = paginaPainel('t');
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">/);
  assert.match(html, /grid-template-columns:56px 280px minmax\(0,1fr\)/, 'o chat encolhe em vez de empurrar a tela');
  const celular = html.slice(html.indexOf('@media (max-width:760px)'));
  assert.match(celular, /\.balao\{max-width:92%\}/);
  assert.match(celular, /\.compositor textarea\{font-size:16px/);
  assert.match(celular, /env\(safe-area-inset-bottom\)/);
  assert.match(html, /\.balao\{[^}]*overflow-wrap:anywhere/, 'link longo quebra dentro do balão');
});

// Continuação de pesquisa (uso real 20/11): "pegue os dados daí" depois de um link é mais pesquisa; uma pergunta solta
// com "dados" não é (revisão do Codex).
test('continuação de pesquisa só com referência ao que veio antes', async () => {
  const { FOLLOW_UP } = await import('../src/app/coordinator.ts');
  const { normalize } = await import('../src/router/router.ts');
  assert.ok(FOLLOW_UP.test(normalize('Sim, quero que eu pegue os dados daí também')));
  assert.ok(FOLLOW_UP.test(normalize('compara com a UTMify')));
  assert.ok(!FOLLOW_UP.test(normalize('meus dados estão salvos?')));
});
