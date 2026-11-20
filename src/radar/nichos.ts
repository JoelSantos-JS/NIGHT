// Etapa 1 do Radar de low-ticket (pedido do Joel, 20/11): o Codex pesquisa na internet os melhores nichos (ou ofertas)
// para criar produto low-ticket agora; cada um vira um termo de busca que o Claude leva à Biblioteca de Anúncios
// (MetaMcpAdSource). A nota e a proposta seguem o caminho de sempre (score.ts, pipeline.ts).
//
// A resposta do modelo é dado, não instrução: o código valida a forma, corta o tamanho e descarta o que não serve.

import { QuotaError, type ResearchAgent } from '../agents/research.ts';

export interface NichoPlanejado {
  tipo: 'nicho' | 'oferta';
  /** Nome curto do nicho ou da oferta ("receitas fit", "método X"). */
  nome: string;
  /** O que buscar na Biblioteca de Anúncios (2 a 5 palavras, como um anunciante escreveria). */
  termo: string;
  /** Por que vale agora, em uma frase. */
  motivo: string;
  fontes: string[];
}

export interface PlanoNichos {
  nichos: NichoPlanejado[];
  /** Quem pesquisou ("codex:gpt-6-luna") e o que foi descartado. */
  autor: string;
  avisos: string[];
}

export interface PlanejadorNichos {
  planejar(nicho: string, max: number): Promise<PlanoNichos>;
}

const MAX_TEXTO = 120;
const MAX_TERMO = 60;

export function promptNichos(nicho: string, max: number): string {
  return [
    `Pesquise na internet, agora, os melhores nichos dentro de ${JSON.stringify(nicho)} para criar um produto digital low-ticket`,
    'no Brasil (PDF, guia ou miniaula vendido por R$ 19,90 a R$ 97, sem precisar gravar curso).',
    'Procure sinais reais de demanda: ofertas sendo anunciadas, produtos vendendo em Hotmart/Kiwify/Eduzz, buscas em alta.',
    `Traga até ${max} itens. Cada item pode ser um nicho ou uma oferta específica que você encontrou anunciando.`,
    'Para cada um, dê o termo que um anunciante usaria no anúncio (2 a 5 palavras, em português), para buscar na Biblioteca de Anúncios da Meta.',
    'Não invente números nem ofertas: se não achou fonte, não inclua.',
    'Responda SÓ com JSON, sem texto antes ou depois, neste formato:',
    '{"itens":[{"tipo":"nicho","nome":"...","termo":"...","motivo":"...","fontes":["https://..."]}]}',
  ].join('\n');
}

function texto(v: unknown, max: number): string | null {
  return typeof v === 'string' && v.trim() ? v.trim().replace(/\s+/g, ' ').slice(0, max) : null;
}

/** Lê a resposta do modelo: aceita JSON puro, em cerca markdown ou com frase antes. */
export function lerNichos(resposta: string, max: number): { nichos: NichoPlanejado[]; avisos: string[] } {
  const bruto = /```(?:json)?\s*([\s\S]*?)```/.exec(resposta)?.[1] ?? /\{[\s\S]*\}/.exec(resposta)?.[0] ?? '';
  let obj: unknown;
  try { obj = JSON.parse(bruto); } catch { return { nichos: [], avisos: ['a pesquisa de nichos não veio em JSON'] }; }
  const itens = (obj as { itens?: unknown })?.itens;
  if (!Array.isArray(itens)) return { nichos: [], avisos: ['a pesquisa de nichos não trouxe a lista "itens"'] };
  const nichos: NichoPlanejado[] = [];
  const avisos: string[] = [];
  const vistos = new Set<string>();
  for (const item of itens) {
    const x = (item ?? {}) as Record<string, unknown>;
    const nome = texto(x.nome, MAX_TEXTO);
    const termo = texto(x.termo, MAX_TERMO);
    if (!nome || !termo) { avisos.push('item sem nome ou termo descartado'); continue; }
    const chave = termo.toLowerCase();
    if (vistos.has(chave)) continue;
    vistos.add(chave);
    const fontes = Array.isArray(x.fontes) ? x.fontes.filter((f): f is string => typeof f === 'string' && /^https?:\/\//.test(f)).slice(0, 5) : [];
    if (fontes.length === 0) { avisos.push(`"${nome}" sem fonte: descartado (nada sem evidência)`); continue; }
    nichos.push({ tipo: x.tipo === 'oferta' ? 'oferta' : 'nicho', nome, termo, motivo: texto(x.motivo, 300) ?? '', fontes });
    if (nichos.length === max) break;
  }
  return { nichos, avisos };
}

/** Pede aos agentes de pesquisa em ordem (Codex primeiro); no limite de uso, passa ao próximo. */
export class PlanejadorComPesquisa implements PlanejadorNichos {
  constructor(private readonly agentes: ResearchAgent[]) {}

  async planejar(nicho: string, max: number): Promise<PlanoNichos> {
    const avisos: string[] = [];
    for (const agente of this.agentes) {
      try {
        const r = await agente.ask(promptNichos(nicho, max), 'pt-BR');
        const lido = lerNichos(r.answer, max);
        if (lido.nichos.length > 0) return { nichos: lido.nichos, autor: agente.id, avisos: [...avisos, ...lido.avisos] };
        avisos.push(`${agente.id}: ${lido.avisos[0] ?? 'nenhum nicho com fonte'}`);
      } catch (err) {
        avisos.push(`${agente.id}: ${err instanceof QuotaError ? 'no limite de uso' : (err as Error).message.slice(0, 200)}`);
      }
    }
    return { nichos: [], autor: 'nenhum', avisos };
  }
}
