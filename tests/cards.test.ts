// Testes do cartão de tarefa (S03): validação pura, Markdown, hash e caminhos permitidos.
// Sem banco e sem rede: este arquivo só usa src/cards/card.ts.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  CARD_VERSION,
  cardHash,
  explainInvalid,
  isPathAllowed,
  parseCardMarkdown,
  validateCard,
} from '../src/cards/card.ts';
import type { Card, CardError } from '../src/cards/card.ts';

const cartaoValido: Card = {
  version: CARD_VERSION,
  id: 'NIGHT-12',
  titulo: 'Cartão de tarefa validável',
  objetivo: 'Validar o cartão antes de entrar na fila de código.',
  escopo: 'Código puro em src/cards.',
  foraDoEscopo: ['Banco de dados'],
  criteriosDePronto: ['Cartão inválido não entra na fila'],
  testes: ['npx tsc --noEmit'],
  arquivosPermitidos: ['src/cards/card.ts', 'tests/cards.test.ts'],
  riscos: [],
  revisao: 1,
};

const markdown = `# NIGHT-12 — Cartão de tarefa validável
revisao: 1
## Objetivo
Validar o cartão antes de entrar na fila de código.
## Escopo
Código puro em src/cards.
## Fora do escopo
- Banco de dados
## Critérios de pronto
- Cartão inválido não entra na fila
## Testes
- npx tsc --noEmit
## Arquivos permitidos
- src/cards/card.ts
- tests/cards.test.ts
## Riscos
- Nenhum
`;

function semCampo(campo: keyof Card): Record<string, unknown> {
  const copia: Record<string, unknown> = { ...cartaoValido };
  delete copia[campo];
  return copia;
}

/** Valida esperando erro: se o cartão passar, o teste falha com a mensagem do caso. */
function errosDe(raw: unknown): CardError[] {
  const resultado = validateCard(raw);
  assert.equal(resultado.ok, false, `esperava cartão inválido: ${JSON.stringify(raw)}`);
  if (resultado.ok) throw new Error('cartão inesperadamente válido');
  return resultado.errors;
}

function camposComErro(raw: unknown): string[] {
  return errosDe(raw).map((erro) => erro.campo);
}

describe('validateCard', () => {
  test('aceita cartão completo', () => {
    const resultado = validateCard(cartaoValido);
    assert.equal(resultado.ok, true);
    if (!resultado.ok) return;
    assert.deepEqual(resultado.card, cartaoValido);
  });

  test('aceita cartão escrito em Markdown', () => {
    const resultado = validateCard(parseCardMarkdown(markdown));
    assert.equal(resultado.ok, true);
    if (!resultado.ok) return;
    assert.equal(resultado.card.id, 'NIGHT-12');
    assert.equal(resultado.card.titulo, 'Cartão de tarefa validável');
    assert.equal(resultado.card.revisao, 1);
    assert.equal(resultado.card.objetivo, 'Validar o cartão antes de entrar na fila de código.');
    assert.deepEqual(resultado.card.foraDoEscopo, ['Banco de dados']);
    assert.deepEqual(resultado.card.criteriosDePronto, ['Cartão inválido não entra na fila']);
    assert.deepEqual(resultado.card.arquivosPermitidos, ['src/cards/card.ts', 'tests/cards.test.ts']);
    // Mesmo conteúdo lógico do objeto: o hash tem que bater.
    assert.equal(cardHash(resultado.card), cardHash({ ...cartaoValido, riscos: ['Nenhum'] }));
  });

  test('cada campo obrigatório ausente gera erro com o nome do campo', () => {
    const obrigatorios: (keyof Card)[] = [
      'version', 'id', 'titulo', 'objetivo', 'escopo', 'foraDoEscopo',
      'criteriosDePronto', 'testes', 'arquivosPermitidos', 'riscos', 'revisao',
    ];
    for (const campo of obrigatorios) {
      const erros = errosDe(semCampo(campo));
      assert.ok(
        erros.some((erro) => erro.campo === campo),
        `faltou erro de "${campo}": ${JSON.stringify(erros)}`,
      );
    }
  });

  test('junta todos os erros em vez de parar no primeiro', () => {
    const campos = camposComErro({ ...cartaoValido, criteriosDePronto: [], testes: [] });
    assert.ok(campos.includes('criteriosDePronto'));
    assert.ok(campos.includes('testes'));
  });

  test('texto vazio ou só espaços conta como ausente', () => {
    const titulo = errosDe({ ...cartaoValido, titulo: '   ' });
    assert.ok(titulo.some((erro) => erro.campo === 'titulo' && erro.problema.includes('vazio')));
    const objetivo = errosDe({ ...cartaoValido, objetivo: '' });
    assert.ok(objetivo.some((erro) => erro.campo === 'objetivo' && erro.problema.includes('vazio')));
  });

  test('lista vazia onde exige mínimo explica o que falta', () => {
    const criterios = errosDe({ ...cartaoValido, criteriosDePronto: [] });
    assert.ok(criterios.some((erro) => erro.problema.includes('pelo menos um critério')));
    const testes = errosDe({ ...cartaoValido, testes: [] });
    assert.ok(testes.some((erro) => erro.problema.includes('pelo menos um teste')));
    const arquivos = errosDe({ ...cartaoValido, arquivosPermitidos: [] });
    assert.ok(arquivos.some((erro) => erro.problema.includes('pelo menos um arquivo')));
  });

  test('fora do escopo e riscos podem ser vazios, mas precisam existir', () => {
    const resultado = validateCard({ ...cartaoValido, foraDoEscopo: [], riscos: [] });
    assert.equal(resultado.ok, true);
    assert.deepEqual(camposComErro(semCampo('foraDoEscopo')), ['foraDoEscopo']);
    assert.deepEqual(camposComErro(semCampo('riscos')), ['riscos']);
  });

  test('revisão precisa ser inteiro maior ou igual a 1', () => {
    for (const revisao of [0, -1, 1.5, '1']) {
      const erros = errosDe({ ...cartaoValido, revisao });
      assert.ok(erros.some((erro) => erro.campo === 'revisao'), `revisão ${String(revisao)} passou`);
    }
  });

  test('id fora do formato é recusado', () => {
    for (const id of ['NIGHT 12', 'a'.repeat(41), 'NIGHT/12']) {
      const erros = errosDe({ ...cartaoValido, id });
      assert.ok(erros.some((erro) => erro.campo === 'id'), `id ${id} passou`);
    }
  });

  test('campo desconhecido é erro para pegar erro de digitação', () => {
    const erros = errosDe({ ...cartaoValido, maxCall: 10 });
    const desconhecido = erros.find((erro) => erro.campo === 'maxCall');
    assert.ok(desconhecido);
    assert.equal(desconhecido.problema, 'campo desconhecido');
  });

  test('raiz que não é objeto vira um erro claro', () => {
    for (const raw of [null, [], 'texto']) {
      assert.deepEqual(camposComErro(raw), ['cartão']);
    }
  });

  test('recusa caminhos proibidos nos arquivos permitidos', () => {
    const proibidos = ['.env', '.env.local', '../x', 'C:\\x', '/etc/passwd', 'node_modules/a', '.git/config', 'keys/a.pem'];
    for (const caminho of proibidos) {
      const erros = errosDe({ ...cartaoValido, arquivosPermitidos: [caminho] });
      assert.ok(
        erros.some((erro) => erro.campo === 'arquivosPermitidos'),
        `caminho ${caminho} passou`,
      );
    }
  });
});

describe('parseCardMarkdown', () => {
  test('títulos de seção não diferenciam maiúsculas nem acentos', () => {
    const variante = markdown
      .replace('## Objetivo', '## OBJETIVO')
      .replace('## Fora do escopo', '## Fora do Escopo')
      .replace('## Critérios de pronto', '## CRITÉRIOS DE PRONTO')
      .replace('## Testes', '## TESTES')
      .replace('## Arquivos permitidos', '## ARQUIVOS PERMITIDOS')
      .replace('## Riscos', '## RISCOS');
    const resultado = validateCard(parseCardMarkdown(variante));
    assert.equal(resultado.ok, true);
    if (!resultado.ok) return;
    assert.equal(resultado.card.revisao, 1);
    assert.deepEqual(resultado.card.testes, ['npx tsc --noEmit']);
  });

  test('devolve objeto cru: seção faltando só aparece na validação', () => {
    const cru = parseCardMarkdown('# NIGHT-1 — Só título\nrevisao: 1\n');
    assert.equal(typeof cru, 'object');
    const campos = camposComErro(cru);
    for (const campo of ['objetivo', 'escopo', 'foraDoEscopo', 'criteriosDePronto', 'testes', 'arquivosPermitidos', 'riscos']) {
      assert.ok(campos.includes(campo), `faltou erro de ${campo}: ${JSON.stringify(campos)}`);
    }
  });
});

describe('cardHash', () => {
  test('é estável e não depende da ordem das chaves', () => {
    const reordenado: Card = {
      revisao: 1,
      riscos: [],
      arquivosPermitidos: ['src/cards/card.ts', 'tests/cards.test.ts'],
      testes: ['npx tsc --noEmit'],
      criteriosDePronto: ['Cartão inválido não entra na fila'],
      foraDoEscopo: ['Banco de dados'],
      escopo: 'Código puro em src/cards.',
      objetivo: 'Validar o cartão antes de entrar na fila de código.',
      titulo: 'Cartão de tarefa validável',
      id: 'NIGHT-12',
      version: CARD_VERSION,
    };
    assert.equal(cardHash(cartaoValido), cardHash(reordenado));
    assert.match(cardHash(cartaoValido), /^[0-9a-f]{64}$/);
  });

  test('muda quando a revisão ou qualquer outro campo muda', () => {
    assert.notEqual(cardHash(cartaoValido), cardHash({ ...cartaoValido, revisao: 2 }));
    assert.notEqual(cardHash(cartaoValido), cardHash({ ...cartaoValido, titulo: 'Outro título' }));
    assert.notEqual(cardHash(cartaoValido), cardHash({ ...cartaoValido, testes: ['outro teste'] }));
  });
});

describe('isPathAllowed', () => {
  const comPadroes = (...padroes: string[]): Card => ({ ...cartaoValido, arquivosPermitidos: padroes });

  test('* não cruza barra', () => {
    const cartao = comPadroes('src/*.ts');
    assert.equal(isPathAllowed(cartao, 'src/x.ts'), true);
    assert.equal(isPathAllowed(cartao, 'src/a/b.ts'), false);
    assert.equal(isPathAllowed(cartao, 'tests/x.ts'), false);
  });

  test('** cruza barra e **/ aceita zero pastas', () => {
    const cartao = comPadroes('src/**');
    assert.equal(isPathAllowed(cartao, 'src/x.ts'), true);
    assert.equal(isPathAllowed(cartao, 'src/a/b.ts'), true);
    assert.equal(isPathAllowed(cartao, 'tests/a.ts'), false);

    const comTs = comPadroes('src/**/*.ts');
    assert.equal(isPathAllowed(comTs, 'src/a.ts'), true);
    assert.equal(isPathAllowed(comTs, 'src/a/b.ts'), true);
    assert.equal(isPathAllowed(comTs, 'src/a/b.md'), false);
  });

  test('normaliza a barra invertida do Windows', () => {
    const cartao = comPadroes('src/*.ts');
    assert.equal(isPathAllowed(cartao, 'src\\x.ts'), true);
    assert.equal(isPathAllowed(cartao, 'C:\\x'), false);
  });

  test('caminho proibido continua proibido mesmo com **', () => {
    const cartao = comPadroes('**');
    for (const caminho of ['.env', '.env.local', '../x', 'C:\\x', '/etc/passwd', 'node_modules/a', '.git/config', 'keys/a.pem']) {
      assert.equal(isPathAllowed(cartao, caminho), false, `caminho ${caminho} passou`);
    }
    assert.equal(isPathAllowed(cartao, 'src/x.ts'), true);
  });
});

describe('explainInvalid', () => {
  test('junta faltas em uma frase curta', () => {
    const erros = errosDe({ ...cartaoValido, criteriosDePronto: [], testes: [] });
    assert.equal(explainInvalid(erros), 'Cartão inválido: faltam critérios de pronto e testes.');
  });

  test('uma falta usa o singular', () => {
    assert.equal(explainInvalid(errosDe(semCampo('objetivo'))), 'Cartão inválido: falta objetivo.');
  });

  test('valor errado aparece como correção', () => {
    assert.equal(explainInvalid(errosDe({ ...cartaoValido, revisao: 0 })), 'Cartão inválido: corrija revisão.');
  });

  test('campo desconhecido é citado pelo nome', () => {
    const frase = explainInvalid(errosDe({ ...cartaoValido, maxCall: 10 }));
    assert.ok(frase.includes("o campo desconhecido 'maxCall'"), frase);
  });

  test('sem erros não inventa detalhe', () => {
    assert.equal(explainInvalid([]), 'Cartão inválido: sem detalhes.');
  });
});

