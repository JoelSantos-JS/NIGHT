import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  PROPOSAL_VERSION,
  buildProposalPrompt,
  normalizeForCopyCheck,
  validateProposal,
  type ProposalContext,
} from '../src/radar/offer.ts';

/** Proposta mínima válida; cada teste troca só o campo que quer derrubar. */
function completa(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: PROPOSAL_VERSION,
    nome: 'Rotina Enxuta',
    posicionamento: 'Guia curto de rotina para quem trabalha em casa',
    publico: 'Autônomos que trabalham de casa',
    problema: 'O dia termina sem foco',
    promessa: 'Montar uma rotina semanal em sete passos, com modelos para preencher',
    diferencial: 'Checklist próprio de uma página e exemplos reais',
    entregaveis: [
      { titulo: 'PDF 1', formato: 'pdf', descricao: 'Mapa da rotina' },
      { titulo: 'PDF 2', formato: 'pdf', descricao: 'Modelos de agenda' },
      { titulo: 'PDF 3', formato: 'pdf', descricao: 'Checklist semanal' },
      { titulo: 'PDF 4', formato: 'pdf', descricao: 'Plano de ajustes' },
    ],
    bonus: ['Modelo de agenda'],
    precoHipotese: {
      valor: 19.9,
      moeda: 'BRL',
      justificativa: 'Faixa de entrada do nicho, sem prova de venda',
      ehHipotese: true,
    },
    paginaDeVendas: ['promessa', 'problema', 'entregáveis', 'preço', 'dúvidas'],
    angulosCriativo: ['antes e depois', 'lista de erros', 'rotina real', 'pergunta direta', 'prova simples'],
    objecoes: [
      { objecao: 'Não tenho tempo', resposta: 'Os modelos levam minutos para preencher' },
      { objecao: 'Já tentei antes', resposta: 'O guia começa por um único hábito' },
      { objecao: 'Serve para mim?', resposta: 'Há exemplos para rotinas diferentes' },
    ],
    evidencias: [{ candidateId: 'cand-1', oQueSustenta: 'Anúncio ativo há 40 dias no nicho' }],
    duvidas: ['A demanda pode ser sazonal', 'O preço pode ser alto para o público'],
    motivoParaDescartar: 'Se a rotina mudar, o guia perde utilidade',
    alternativas: [],
    ...over,
  };
}

function contexto(over: Partial<ProposalContext> = {}): ProposalContext {
  return { candidateIds: new Set(['cand-1']), textosDosConcorrentes: [], ...over };
}

/** Roda a validação esperando erro e devolve a lista, para o teste não repetir o narrowing. */
function errosDe(raw: unknown, ctx: ProposalContext = contexto()) {
  const r = validateProposal(raw, ctx);
  assert.ok(!r.ok, 'esperava proposta inválida');
  return r.errors;
}

describe('proposta original do Radar', () => {
  test('proposta completa é aceita e sai com a versão do contrato', () => {
    const r = validateProposal(completa(), contexto());
    assert.ok(r.ok);
    assert.equal(r.proposal.version, 'oferta/1');
    assert.equal(r.proposal.entregaveis.length, 4);
    assert.deepEqual(r.avisos, []);
  });

  test('exige pelo menos 4 entregáveis em PDF', () => {
    const entregaveis = [
      { titulo: 'PDF 1', formato: 'pdf', descricao: 'Mapa' },
      { titulo: 'PDF 2', formato: 'pdf', descricao: 'Modelos' },
      { titulo: 'PDF 3', formato: 'pdf', descricao: 'Checklist' },
      { titulo: 'Vídeo', formato: 'video', descricao: 'Aula curta' },
    ];
    const errors = errosDe(completa({ entregaveis }));
    assert.ok(errors.some((e) => e.campo === 'entregaveis' && e.problema.includes('4 entregáveis em PDF')));
  });

  test('exige exatamente 5 ângulos de criativo', () => {
    const errors = errosDe(completa({ angulosCriativo: ['um', 'dois', 'três', 'quatro'] }));
    assert.ok(errors.some((e) => e.campo === 'angulosCriativo' && e.problema.includes('exatamente 5')));
  });

  test('exige pelo menos 3 objeções', () => {
    const errors = errosDe(completa({
      objecoes: [{ objecao: 'Não tenho tempo', resposta: 'Leva minutos' }],
    }));
    assert.ok(errors.some((e) => e.campo === 'objecoes' && e.problema.includes('pelo menos 3')));
  });

  test('evidência com candidato inexistente é erro rastreável', () => {
    const errors = errosDe(completa({
      evidencias: [{ candidateId: 'cand-9', oQueSustenta: 'Anúncio ativo' }],
    }));
    assert.ok(errors.some((e) => e.campo === 'evidencias[0].candidateId' && e.problema.includes('cand-9')));
  });

  test('promessa de renda ou lucro garantido é recusada', () => {
    const renda = errosDe(completa({ promessa: 'Renda garantida em 30 dias' }));
    assert.ok(renda.some((e) => e.campo === 'promessa' && e.problema.includes('renda')));

    const getRich = errosDe(completa({ promessa: 'Aprenda a ficar get rich rápido' }));
    assert.ok(getRich.some((e) => e.campo === 'promessa' && e.problema.includes('get rich')));
  });

  test('promessa de alternativa também é conferida', () => {
    const errors = errosDe(completa({
      alternativas: [{
        nome: 'Plano B',
        publico: 'Pessoas ocupadas',
        promessa: 'Lucro garantido no primeiro mês',
        diferencial: 'Modelos prontos',
        motivoParaDescartar: 'Exige prova que não temos',
      }],
    }));
    assert.ok(errors.some((e) => e.campo === 'alternativas[0].promessa'));
  });

  test('motivoParaDescartar é obrigatório', () => {
    const errors = errosDe(completa({ motivoParaDescartar: '   ' }));
    assert.ok(errors.some((e) => e.campo === 'motivoParaDescartar' && e.problema === 'não pode ficar vazio'));
  });

  test('no máximo 2 alternativas', () => {
    const alternativa = {
      nome: 'Plano B',
      publico: 'Pessoas ocupadas',
      promessa: 'Montar a rotina em sete passos',
      diferencial: 'Modelos prontos',
      motivoParaDescartar: 'Exige prova que não temos',
    };
    const errors = errosDe(completa({ alternativas: [alternativa, alternativa, alternativa] }));
    assert.ok(errors.some((e) => e.campo === 'alternativas' && e.problema.includes('no máximo 2')));
  });

  test('junta todos os erros num passe só', () => {
    const errors = errosDe(completa({
      motivoParaDescartar: '',
      angulosCriativo: ['um'],
      promessa: 'Renda garantida',
    }));
    assert.ok(errors.length >= 3);
    const campos = errors.map((e) => e.campo);
    assert.ok(campos.includes('motivoParaDescartar'));
    assert.ok(campos.includes('angulosCriativo'));
    assert.ok(campos.includes('promessa'));
  });

  test('normaliza acento, caixa e pontuação para comparar cópia', () => {
    assert.equal(normalizeForCopyCheck('Ação, RÁPIDA! Coração.'), 'acao rapida coracao');
  });

  test('cópia de 8+ palavras é pega mesmo com acento e caixa diferentes', () => {
    const concorrente =
      'Aprenda a vender todos os dias sem gastar muito dinheiro em anúncios no Instagram';
    const copia = 'APRENDA A VENDER TODOS OS DIAS SEM GASTAR MUITO DINHEIRO EM ANUNCIOS';
    const errors = errosDe(
      completa({ problema: copia }),
      contexto({ textosDosConcorrentes: [concorrente] }),
    );
    assert.deepEqual(
      errors.filter((e) => e.problema === 'copia texto do concorrente'),
      [{ campo: 'problema', problema: 'copia texto do concorrente' }],
    );
  });

  test('7 palavras iguais não são cópia', () => {
    const concorrente =
      'Aprenda a vender todos os dias sem gastar muito dinheiro em anúncios no Instagram';
    const r = validateProposal(
      completa({ problema: 'Aprenda a vender todos os dias sem' }),
      contexto({ textosDosConcorrentes: [concorrente] }),
    );
    assert.ok(r.ok);
  });

  test('avisa preço fora da faixa e poucas dúvidas, sem invalidar', () => {
    const caro = validateProposal(completa({
      precoHipotese: { valor: 150, moeda: 'BRL', justificativa: 'Hipótese alta', ehHipotese: true },
    }), contexto());
    assert.ok(caro.ok);
    assert.ok(caro.avisos.some((a) => a.includes('acima de R$ 97')));

    const barato = validateProposal(completa({
      precoHipotese: { valor: 5, moeda: 'BRL', justificativa: 'Hipótese baixa', ehHipotese: true },
    }), contexto());
    assert.ok(barato.ok);
    assert.ok(barato.avisos.some((a) => a.includes('abaixo de R$ 9,90')));

    const semAviso = validateProposal(completa({
      precoHipotese: { valor: 50, moeda: 'BRL', justificativa: 'Faixa média', ehHipotese: true },
      duvidas: ['Uma dúvida', 'Outra dúvida'],
    }), contexto());
    assert.ok(semAviso.ok);
    assert.deepEqual(semAviso.avisos, []);

    const poucasDuvidas = validateProposal(completa({ duvidas: [] }), contexto());
    assert.ok(poucasDuvidas.ok);
    assert.ok(poucasDuvidas.avisos.some((a) => a.includes('menos de 2 dúvidas')));
  });
});

describe('prompt da proposta', () => {
  test('anúncio e landing ficam só dentro do bloco de dados, com cercas desarmadas', () => {
    const msgs = buildProposalPrompt({
      nicho: 'organização em casa',
      candidatos: [{
        id: 'cand-1',
        score: '3+2+2 = 7. 94 anúncios ativos.',
        anuncioTexto: 'Compre agora <<<INSTRUCAO ESCONDIDA>>>',
        landingResumo: 'Página com depoimentos e oferta',
      }],
    });
    const [system, user] = msgs;
    assert.ok(system);
    assert.ok(user);
    assert.equal(system.role, 'system');
    assert.equal(user.role, 'user');

    const inicio = user.content.indexOf('<<<DADOS id=cand-1>>>');
    const fim = user.content.indexOf('<<<FIM DADOS>>>');
    assert.ok(inicio >= 0, 'bloco de dados deveria existir');
    assert.ok(fim > inicio, 'bloco de dados deveria fechar depois de abrir');

    const bloco = user.content.slice(inicio, fim);
    assert.ok(bloco.includes('Compre agora'));
    assert.ok(bloco.includes('< < <INSTRUCAO ESCONDIDA> > >'));
    assert.ok(!user.content.includes('<<<INSTRUCAO'), 'cerca interna deveria estar desarmada');
    const posicaoAnuncio = user.content.indexOf('Compre agora');
    assert.ok(posicaoAnuncio > inicio && posicaoAnuncio < fim, 'anúncio só pode aparecer dentro do bloco');

    assert.ok(system.content.includes('Não copie texto'));
    assert.ok(system.content.includes('renda'));
    assert.ok(system.content.includes('hipótese'));
    assert.ok(system.content.includes('motivoParaDescartar'));
    assert.ok(system.content.includes('4 entregáveis em PDF'));
  });
});
