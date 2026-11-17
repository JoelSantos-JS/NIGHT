// Regra de divergência (D08): verificação objetiva primeiro; parecer não aprova sozinho.
// O parecer do autor do trabalho não conta, parecer indisponível não é aprovação e
// ação reservada a Joel sempre volta para ele.

import type { Recomendacao } from './opinion.ts';

export interface DivergenceParecer {
  autor: string;
  recomendacao: Recomendacao | 'indisponivel';
}

export interface DivergenceInput {
  testes: 'passaram' | 'falharam' | 'nao_rodaram';
  fontesObrigatoriasOk: boolean;
  /** Merge, publicar ou gastar: decisão do Joel, não de modelo. */
  reservadoAoJoel: boolean;
  pareceres: DivergenceParecer[];
  autorDoTrabalho: string;
}

export interface DivergenceResult {
  decisao: 'prosseguir' | 'corrigir' | 'perguntar_joel';
  motivo: string;
  divergencia: boolean;
}

export function decide(input: DivergenceInput): DivergenceResult {
  // Falha objetiva vem antes de qualquer parecer: concordância não supera teste.
  if (input.testes === 'falharam') {
    return {
      decisao: 'corrigir',
      motivo: 'teste falhou; pareceres não superam falha objetiva',
      divergencia: false,
    };
  }
  if (input.testes === 'nao_rodaram') {
    return {
      decisao: 'corrigir',
      motivo: 'teste não rodou; sem verificação objetiva não há aprovação',
      divergencia: false,
    };
  }
  if (!input.fontesObrigatoriasOk) {
    return {
      decisao: 'corrigir',
      motivo: 'fonte obrigatória ausente; a alegação não pode avançar',
      divergencia: false,
    };
  }

  // Autor do trabalho não revisa o próprio resultado; indisponível não é aprovação.
  const validos = input.pareceres.filter(
    (p) => p.autor !== input.autorDoTrabalho && p.recomendacao !== 'indisponivel',
  );
  const aprovacoes = validos.filter((p) => p.recomendacao === 'prosseguir');
  const ressalvas = validos.filter((p) => p.recomendacao === 'revisar' || p.recomendacao === 'parar');
  const pedemJoel = validos.filter((p) => p.recomendacao === 'perguntar_joel');
  const divergencia = aprovacoes.length > 0 && ressalvas.length + pedemJoel.length > 0;

  if (validos.length === 0) {
    const tinhaIndisponivel = input.pareceres.some((p) => p.recomendacao === 'indisponivel');
    return {
      decisao: 'perguntar_joel',
      motivo: tinhaIndisponivel
        ? 'sem revisão independente: parecer indisponível não conta como aprovação'
        : 'sem revisão independente: nenhum parecer válido de outro agente',
      divergencia: false,
    };
  }

  // Ação reservada a Joel vence o "tudo verde", mas não um problema objetivo acima.
  if (input.reservadoAoJoel) {
    return {
      decisao: 'perguntar_joel',
      motivo: 'ação reservada a Joel (merge, publicar ou gastar); parecer não decide isso',
      divergencia,
    };
  }

  if (divergencia) {
    return {
      decisao: 'perguntar_joel',
      motivo: 'pareceres divergentes; nenhum teste observável resolve a discordância',
      divergencia: true,
    };
  }

  if (aprovacoes.length === validos.length) {
    return {
      decisao: 'prosseguir',
      motivo: 'testes passaram, fontes ok e pareceres independentes concordam em prosseguir',
      divergencia: false,
    };
  }

  if (ressalvas.length > 0) {
    return {
      decisao: 'corrigir',
      motivo: 'pareceres independentes pedem revisão ou parada; corrigir antes de prosseguir',
      divergencia: false,
    };
  }

  return {
    decisao: 'perguntar_joel',
    motivo: 'pareceres independentes pedem decisão de Joel',
    divergencia: false,
  };
}
