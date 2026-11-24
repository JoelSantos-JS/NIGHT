// Geração do roteiro do agente de vídeos (V02, docs/PLANO_MESTRE_NIGHT.md).
// Recebe o briefing, pede ao modelo SÓ o JSON do VideoManifest, valida e devolve os
// erros para o modelo corrigir na tentativa seguinte. Código sem banco: o gerador e o
// conselheiro são injetáveis para testar sem rede.
//
// O manifesto é o mesmo contrato de manifest.ts: cada afirmação factual tem fonte real
// ou é marcada como dúvida. Imagem gerada por IA é sempre ilustração: nunca finge ser
// registro real. Prometer renda/lucro é proibido, como nas regras do projeto.

import { getDecisionPoint } from '../advisor/matrix.ts';
import type { AdvisorEvidence, AdvisorInput } from '../advisor/opinion.ts';
import type { AdvisorService, ConsultResult } from '../advisor/service.ts';
import type { LimitTracker } from '../jobs/limits.ts';
import type { VideoBrief } from './brief.ts';
import {
  MANIFEST_VERSION,
  PALAVRAS_POR_SEGUNDO,
  estimateDuration,
  validateManifest,
  type ManifestProblem,
  type VideoManifest,
} from './manifest.ts';
import { resolveTemplateForStyle } from './templates.ts';

export interface ScriptMessage {
  role: 'system' | 'user';
  content: string;
}

/** Gerador injetável: na produção é a API do DeepSeek; nos testes, uma função falsa. */
export type ScriptGenerator = (messages: ScriptMessage[]) => Promise<string>;

export interface GenerateManifestDeps {
  generator: ScriptGenerator;
  /** Sem conselheiro, o roteiro é gerado e validado como antes (nenhum parecer). */
  advisor?: AdvisorService;
  /** Teto de chamadas do trabalho; sem tracker, nada é contado aqui. */
  tracker?: LimitTracker;
}

export interface GenerateManifestInput {
  jobId: string;
  brief: VideoBrief;
  /** Tentativas totais (a primeira + correções); padrão 2. */
  maxTentativas?: number;
}

export type GenerateManifestResult =
  | { status: 'ok'; manifest: VideoManifest; avisos: string[]; parecer?: ConsultResult }
  | { status: 'invalido'; errors: ManifestProblem[] };

/** Formato mínimo que o modelo deve devolver; o validador confere cada campo. */
const FORMATO_JSON = [
  '{',
  `  "version": "${MANIFEST_VERSION}",`,
  '  "jobId": "...",',
  '  "brief": { "version": "briefing-video/1", "tema": "...", "publico": "...", "idioma": "pt-BR", "plataforma": "shorts", "formato": "vertical", "duracaoAlvoSeg": 60, "estilo": "...", "objetivo": "...", "ofertaRadar": null, "limites": { "maxImagens": 30, "maxRenderMin": 15 } },',
  '  "titulo": "...",',
  '  "fontes": [{ "id": "...", "url": "https://...", "titulo": "...", "acessadoEm": "AAAA-MM-DD" }],',
  '  "cenas": [{',
  '    "n": 1,',
  '    "narracao": "...",',
  '    "duracaoEstimadaSeg": 20,',
  '    "afirmacoes": [{ "texto": "...", "fonte": "id-da-fonte ou null", "duvida": false }],',
  '    "visual": "...",',
  '    "promptImagem": "English descriptive image prompt...",',
  '    "papelImagem": "ilustracao",',
  '    "realistaGeradaPorIA": false,',
  '    "assetRef": null',
  '  }]',
  '}',
].join('\n');

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Orientação de duração com a mesma conta do estimateDuration (palavras ÷ ritmo). */
function orientacaoDeDuracao(brief: VideoBrief): string {
  const ritmo = PALAVRAS_POR_SEGUNDO[brief.idioma];
  const palavrasAlvo = Math.max(1, Math.round(brief.duracaoAlvoSeg * ritmo));
  const conferenciaSeg = estimateDuration(
    Array.from({ length: palavrasAlvo }, () => 'palavra').join(' '),
    brief.idioma,
  );
  return `duração alvo: ${brief.duracaoAlvoSeg} s. No ritmo de ${ritmo} palavras/s, o roteiro inteiro deve ter cerca de ${palavrasAlvo} palavras (${palavrasAlvo} palavras ≈ ${conferenciaSeg} s em estimateDuration). A soma de duracaoEstimadaSeg deve ficar perto da meta.`;
}

/** Data de acesso das fontes: hoje em ISO, para o modelo não inventar data no futuro. */
function hojeIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Mensagens system+user para o modelo gerar o manifesto.
 * O briefing vem do NIGHT (dado do pedido); o modelo não escolhe tema nem plataforma.
 */
export function buildScriptPrompt(input: GenerateManifestInput): ScriptMessage[] {
  const template = resolveTemplateForStyle(input.brief.estilo);
  const templateSystem = template === null
    ? []
    : [
        `Template visual selecionado (${template.id}):`,
        `- Inclua "motorVisual": "${template.motorPadrao}" e "templateVisual": "${template.id}" no manifesto.`,
        '- Em cada cena, preencha os campos visuais opcionais quando aplicável: "textoNaTela" (manchete curta na tela), "acao" (movimento/ação visual), "transicao" ("cut" | "fade" | "slide" | "zoom"), "assets" (lista de elementos de cena).',
        ...(template.id === 'stickman-2d'
          ? ['- Em cada cena stickman-2d, inclua "pose" e "expressao".']
          : []),
        '- A cena 1 deve abrir com gancho forte nos primeiros 3 segundos.',
        ...template.dicasDeRoteiro.map((dica) => `- ${dica}`),
      ];

  const promptImagemRegra = template?.imagens === 'none'
    ? '- promptImagem em inglês (pode ser "" neste template programático, pois a cena é desenhada em código).'
    : '- promptImagem em inglês, descritivo, com o mesmo estilo visual e a mesma paleta em todas as cenas.';

  const system = [
    'Você escreve o roteiro original de um vídeo para o NIGHT e entrega o manifesto de cenas.',
    'Responda em português do Brasil e envie SOMENTE um objeto JSON, sem markdown, no formato:',
    FORMATO_JSON,
    'Regras obrigatórias:',
    `- version exatamente "${MANIFEST_VERSION}"; o jobId e o brief serão conferidos e substituídos pelos do pedido.`,
    '- O roteiro é ORIGINAL sobre o tema do briefing: não copie texto de outra fonte.',
    `- Narração e título no idioma do briefing (${input.brief.idioma}); as instruções deste pedido estão em português.`,
    `- ${orientacaoDeDuracao(input.brief)}`,
    '- Toda afirmação factual precisa de uma fonte real (URL http/https que você conheça, listada em fontes) ou duvida: true. Não invente URL.',
    '- Use papelImagem "ilustracao" em todas as cenas: imagem gerada por IA nunca é registro real.',
    promptImagemRegra,
    `- assetRef sempre null: ${template?.imagens === 'none' ? 'o template renderiza a cena sem imagem importada.' : 'a imagem é gerada no Flow depois.'}`,
    '- Não prometa renda, lucro, faturamento, garantia nem "fique rico".',
    '- Cenas em sequência, n de 1 a N sem buraco; se uma cena não tiver afirmação factual, envie afirmacoes como lista vazia.',
    ...templateSystem,
  ].join('\n');

  const linhas: string[] = [
    `jobId: ${input.jobId}`,
    'briefing (o NIGHT mantém este briefing; use o tema, o idioma, o estilo e a duração):',
    JSON.stringify(input.brief, null, 2),
    `duração alvo: ${input.brief.duracaoAlvoSeg} s; idioma: ${input.brief.idioma}; formato: ${input.brief.formato}.`,
    ...(template !== null ? [`template visual: ${template.id} (${template.nome}); motor: ${template.motorPadrao}.`] : []),
    `data de acesso para as fontes (acessadoEm): ${hojeIso()}.`,
  ];

  return [
    { role: 'system', content: system },
    { role: 'user', content: linhas.join('\n') },
  ];
}

/** Extrai o JSON do modelo; cerca de markdown é aceita porque alguns modelos embrulham a resposta. */
function lerManifesto(resposta: string): { ok: true; raw: unknown } | { ok: false; errors: ManifestProblem[] } {
  const bruto = resposta.trim();
  const cerca = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i.exec(bruto);
  const corpo = cerca ? (cerca[1] ?? bruto).trim() : bruto;
  try {
    return { ok: true, raw: JSON.parse(corpo) };
  } catch {
    return { ok: false, errors: [{ campo: 'manifesto', problema: 'não é um objeto JSON válido' }] };
  }
}

/**
 * jobId e brief são do NIGHT, não do modelo: sobrescreve antes de validar para que o
 * manifesto pertença sempre ao trabalho e ao briefing pedidos.
 */
function comPedidoDoInput(raw: unknown, input: GenerateManifestInput): unknown {
  if (!isRecord(raw)) return raw;
  return { ...raw, jobId: input.jobId, brief: input.brief };
}

/** Devolve os erros ao gerador numa nova tentativa, como o validador os juntou. */
function mensagemDeCorrecao(errors: ManifestProblem[]): ScriptMessage {
  const lista = errors.map((e) => `- ${e.campo}: ${e.problema}`).join('\n');
  return {
    role: 'user',
    content:
      'O manifesto anterior foi recusado pela validação. Corrija todos os pontos abaixo e envie SOMENTE o objeto JSON do manifesto:\n'
      + lista,
  };
}

/** Chama o gerador contando a tentativa no tracker, se houver. */
async function chamarGerador(deps: GenerateManifestDeps, mensagens: ScriptMessage[]): Promise<string> {
  if (!deps.tracker) return deps.generator(mensagens);
  deps.tracker.assertWithin();
  try {
    return await deps.generator(mensagens);
  } finally {
    // A tentativa conta mesmo se o modelo falhar: a chamada já foi assumida.
    deps.tracker.call();
  }
}

/** Fontes do manifesto são externas (dado); cada cena é interna (roteiro e afirmações). */
function evidenciasDoRoteiro(manifest: VideoManifest): AdvisorEvidence[] {
  const fontes: AdvisorEvidence[] = manifest.fontes.map((fonte) => ({
    ref: fonte.id,
    origem: 'fonte do roteiro',
    externa: true,
    conteudo: `${fonte.titulo} — ${fonte.url}`,
  }));
  const cenas: AdvisorEvidence[] = manifest.cenas.map((cena) => {
    const afirmacoes = cena.afirmacoes.map((a) => {
      const fonte = a.fonte === null ? 'sem fonte' : `fonte ${a.fonte}`;
      const duvida = a.duvida ? '; assumida como dúvida' : '';
      return `afirmação "${a.texto}" (${fonte}${duvida})`;
    });
    return {
      ref: `cena-${cena.n}`,
      origem: 'cena do roteiro',
      externa: false,
      conteudo: [
        `narração: ${cena.narracao}`,
        `papel da imagem: ${cena.papelImagem}`,
        ...afirmacoes,
      ].join('\n'),
    };
  });
  return [...fontes, ...cenas];
}

/**
 * Gera o manifesto, valida e tenta de novo com os erros até `maxTentativas`.
 * Manifesto inválido nunca é aceito; o parecer, quando existe, só é registrado
 * (quem decide parar o vídeo é a etapa antes do render).
 */
export async function generateManifest(
  deps: GenerateManifestDeps,
  input: GenerateManifestInput,
): Promise<GenerateManifestResult> {
  const maxTentativas = input.maxTentativas ?? 2;
  if (!Number.isInteger(maxTentativas) || maxTentativas < 1) {
    throw new Error(`maxTentativas inválido: esperava inteiro de pelo menos 1, recebi ${String(maxTentativas)}`);
  }

  const mensagens = buildScriptPrompt(input);
  let validado: { manifest: VideoManifest; avisos: string[] } | null = null;
  let erros: ManifestProblem[] = [];

  for (let tentativa = 1; tentativa <= maxTentativas; tentativa++) {
    const resposta = await chamarGerador(deps, mensagens);
    const lida = lerManifesto(resposta);
    if (!lida.ok) {
      erros = lida.errors;
    } else {
      const resultado = validateManifest(comPedidoDoInput(lida.raw, input));
      if (resultado.ok) {
        validado = { manifest: resultado.manifest, avisos: resultado.avisos };
        break;
      }
      erros = resultado.errors;
    }
    if (tentativa < maxTentativas) mensagens.push(mensagemDeCorrecao(erros));
  }

  if (!validado) return { status: 'invalido', errors: erros };

  let parecer: ConsultResult | undefined;
  if (deps.advisor) {
    const advisorInput: AdvisorInput = {
      jobId: input.jobId,
      dominio: 'video',
      fase: 'roteiro',
      objetivo: input.brief.tema,
      pergunta: getDecisionPoint('video.roteiro')?.pergunta
        ?? 'O roteiro distingue fato de ilustração? Há repetição, promessa enganosa ou fonte fraca?',
      evidencias: evidenciasDoRoteiro(validado.manifest),
    };
    parecer = await deps.advisor.consult('video.roteiro', advisorInput);
  }

  return {
    status: 'ok',
    manifest: validado.manifest,
    avisos: validado.avisos,
    ...(parecer !== undefined ? { parecer } : {}),
  };
}
