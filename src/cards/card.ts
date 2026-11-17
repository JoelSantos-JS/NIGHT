// Cartão de tarefa (S03): contrato de entrada validável, antes de entrar na fila de código.
// Código puro: sem banco, sem rede e sem relógio. Cartão inválido não entra na fila.

import { createHash } from 'node:crypto';

export const CARD_VERSION = 'cartao/1';

/** ID curto e estável da tarefa, por exemplo 'NIGHT-12'. */
const ID_VALIDO = /^[A-Za-z0-9_-]{1,40}$/;

export interface Card {
  version: typeof CARD_VERSION;
  id: string;
  titulo: string;
  objetivo: string;
  escopo: string;
  foraDoEscopo: string[];
  /** Pelo menos um: sem critério não há como dizer que ficou pronto. */
  criteriosDePronto: string[];
  /** Pelo menos um: comando ou teste descrito. */
  testes: string[];
  /** Pelo menos um: caminho relativo ao repo; aceita glob simples com '*' e '**'. */
  arquivosPermitidos: string[];
  /** Pode ser vazio, mas o campo precisa existir para o Joel ver o que foi pensado. */
  riscos: string[];
  /** Inteiro >= 1; sobe a cada alteração do cartão aprovado. */
  revisao: number;
}

export interface CardError {
  campo: string;
  problema: string;
}

export type CardValidation = { ok: true; card: Card } | { ok: false; errors: CardError[] };

function descrever(valor: unknown): string {
  if (valor === null) return 'null';
  if (Array.isArray(valor)) return 'lista';
  return `${typeof valor} ${String(valor)}`;
}

/** Texto obrigatório: ausente, de outro tipo ou só espaços vira erro. */
function validarTexto(obj: Record<string, unknown>, campo: string, add: (campo: string, problema: string) => void): string | null {
  if (!Object.hasOwn(obj, campo)) {
    add(campo, 'ausente');
    return null;
  }
  const valor = obj[campo];
  if (typeof valor !== 'string') {
    add(campo, `esperava texto, recebi ${descrever(valor)}`);
    return null;
  }
  if (valor.trim() === '') {
    add(campo, 'vazio (precisa de texto)');
    return null;
  }
  return valor;
}

interface OpcoesLista {
  minimo?: number;
  /** Mensagem específica quando a lista está vazia (ex.: "precisa de pelo menos um critério"). */
  mensagemMinimo?: string;
}

/** Lista de textos não vazios. O campo precisa existir mesmo quando a lista pode ser vazia. */
function validarLista(
  obj: Record<string, unknown>,
  campo: string,
  add: (campo: string, problema: string) => void,
  opcoes: OpcoesLista = {},
): string[] | null {
  if (!Object.hasOwn(obj, campo)) {
    add(campo, 'ausente');
    return null;
  }
  const valor = obj[campo];
  if (!Array.isArray(valor)) {
    add(campo, `esperava uma lista, recebi ${descrever(valor)}`);
    return null;
  }
  let todosValidos = true;
  valor.forEach((item, indice) => {
    if (typeof item !== 'string') {
      add(campo, `item ${indice + 1}: esperava texto, recebi ${descrever(item)}`);
      todosValidos = false;
    } else if (item.trim() === '') {
      add(campo, `item ${indice + 1}: vazio`);
      todosValidos = false;
    }
  });
  if (valor.length === 0 && opcoes.minimo) {
    add(campo, opcoes.mensagemMinimo ?? `precisa de pelo menos ${opcoes.minimo} item`);
  }
  return todosValidos ? (valor as string[]) : null;
}

/** Barra invertida do Windows vira '/' antes de comparar. */
function normalizarCaminho(caminho: string): string {
  let normalizado = caminho.replace(/\\/g, '/');
  while (normalizado.startsWith('./')) normalizado = normalizado.slice(2);
  return normalizado;
}

function ehAbsoluto(caminho: string): boolean {
  // '/' cobre também '//'; a letra de unidade cobre 'C:\x' mesmo fora do Windows.
  return caminho.startsWith('/') || /^[A-Za-z]:/.test(caminho);
}

/** Segmentos que nunca podem ser liberados no cartão, mesmo com glob. */
function segmentoProibido(segmento: string): string | null {
  const s = segmento.toLowerCase();
  if (s === '.git') return '.git';
  if (s === 'node_modules') return 'node_modules';
  if (s === '.env' || s.startsWith('.env')) return '.env';
  if (s === 'keys' || s === '.ssh' || s === 'secrets') return 'chaves';
  if (s === 'id_rsa' || s === 'id_ed25519') return 'chaves';
  if (/\.(pem|key|p12|pfx|keystore)$/.test(s)) return 'chaves';
  return null;
}

function partesDoCaminho(caminho: string): string[] {
  return caminho.split('/').filter((parte) => parte !== '' && parte !== '.');
}

/** Motivo pelo qual um caminho liberado é recusado; null quando está tudo bem. */
function problemaDeCaminhoPermitido(bruto: string): string | null {
  const caminho = normalizarCaminho(bruto);
  if (ehAbsoluto(caminho)) return `caminho precisa ser relativo ao repo: "${bruto}"`;
  const partes = partesDoCaminho(caminho);
  if (partes.includes('..')) return `caminho não pode subir com "..": "${bruto}"`;
  const proibido = partes.map(segmentoProibido).find((motivo) => motivo !== null);
  if (proibido) return `caminho aponta para ${proibido}, não pode: "${bruto}"`;
  return null;
}

/** Junta TODOS os erros: o Joel corrige o cartão de uma vez, não um campo por vez. */
export function validateCard(raw: unknown): CardValidation {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: [{ campo: 'cartão', problema: `esperava um objeto, recebi ${descrever(raw)}` }] };
  }

  const obj = raw as Record<string, unknown>;
  const errors: CardError[] = [];
  const add = (campo: string, problema: string): void => {
    errors.push({ campo, problema });
  };

  if (!Object.hasOwn(obj, 'version')) {
    add('version', `ausente (esperado '${CARD_VERSION}')`);
  } else if (obj.version !== CARD_VERSION) {
    add('version', `precisa ser '${CARD_VERSION}'`);
  }

  const id = validarTexto(obj, 'id', add);
  if (id !== null && !ID_VALIDO.test(id)) {
    add('id', "precisa de 1 a 40 letras, números, '_' ou '-'");
  }
  validarTexto(obj, 'titulo', add);
  validarTexto(obj, 'objetivo', add);
  validarTexto(obj, 'escopo', add);
  validarLista(obj, 'foraDoEscopo', add);
  validarLista(obj, 'criteriosDePronto', add, {
    minimo: 1,
    mensagemMinimo: 'precisa de pelo menos um critério',
  });
  validarLista(obj, 'testes', add, {
    minimo: 1,
    mensagemMinimo: 'precisa de pelo menos um teste',
  });
  const arquivos = validarLista(obj, 'arquivosPermitidos', add, {
    minimo: 1,
    mensagemMinimo: 'precisa de pelo menos um arquivo',
  });
  if (arquivos) {
    for (const caminho of arquivos) {
      const problema = problemaDeCaminhoPermitido(caminho);
      if (problema) add('arquivosPermitidos', problema);
    }
  }
  validarLista(obj, 'riscos', add);

  if (!Object.hasOwn(obj, 'revisao')) {
    add('revisao', 'ausente');
  } else {
    const revisao = obj.revisao;
    if (typeof revisao !== 'number' || !Number.isInteger(revisao) || revisao < 1) {
      add('revisao', 'precisa ser inteiro maior ou igual a 1');
    }
  }

  // Campo desconhecido quase sempre é erro de digitação (ex.: 'criterioDePronto').
  const conhecidos = new Set([
    'version', 'id', 'titulo', 'objetivo', 'escopo', 'foraDoEscopo',
    'criteriosDePronto', 'testes', 'arquivosPermitidos', 'riscos', 'revisao',
  ]);
  for (const chave of Object.keys(obj)) {
    if (!conhecidos.has(chave)) add(chave, 'campo desconhecido');
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    card: {
      version: CARD_VERSION,
      id: obj.id as string,
      titulo: obj.titulo as string,
      objetivo: obj.objetivo as string,
      escopo: obj.escopo as string,
      foraDoEscopo: obj.foraDoEscopo as string[],
      criteriosDePronto: obj.criteriosDePronto as string[],
      testes: obj.testes as string[],
      arquivosPermitidos: obj.arquivosPermitidos as string[],
      riscos: obj.riscos as string[],
      revisao: obj.revisao as number,
    },
  };
}

/** Seções aceitas no Markdown, sem diferenciar maiúsculas nem acentos. */
const SECOES: Record<string, { campo: keyof Card; tipo: 'texto' | 'lista' }> = {
  'objetivo': { campo: 'objetivo', tipo: 'texto' },
  'escopo': { campo: 'escopo', tipo: 'texto' },
  'fora do escopo': { campo: 'foraDoEscopo', tipo: 'lista' },
  'criterios de pronto': { campo: 'criteriosDePronto', tipo: 'lista' },
  'testes': { campo: 'testes', tipo: 'lista' },
  'arquivos permitidos': { campo: 'arquivosPermitidos', tipo: 'lista' },
  'riscos': { campo: 'riscos', tipo: 'lista' },
};

function normalizarTitulo(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Lê um cartão em Markdown simples e devolve o objeto cru para validateCard.
 * Não valida nada: se faltar seção, o campo sai ausente e a validação reclama.
 */
export function parseCardMarkdown(md: string): unknown {
  let id: string | undefined;
  let titulo: string | undefined;
  let revisao: string | undefined;
  let secao: { campo: keyof Card; tipo: 'texto' | 'lista' } | null = null;
  const textos = new Map<string, string[]>();
  const listas = new Map<string, string[]>();

  for (const linha of md.split(/\r?\n/)) {
    const h1 = /^#\s+(.+?)\s*$/.exec(linha);
    if (h1 && id === undefined && titulo === undefined) {
      const texto = h1[1]!;
      const comId = /^([A-Za-z0-9_-]{1,40})\s*[—–-]\s*(.+)$/.exec(texto);
      if (comId) {
        id = comId[1]!;
        titulo = comId[2]!.trim();
      } else {
        titulo = texto.trim();
      }
      secao = null;
      continue;
    }

    const h2 = /^##\s+(.+?)\s*$/.exec(linha);
    if (h2) {
      secao = SECOES[normalizarTitulo(h2[1]!)] ?? null;
      if (secao && !textos.has(secao.campo) && !listas.has(secao.campo)) {
        if (secao.tipo === 'texto') textos.set(secao.campo, []);
        else listas.set(secao.campo, []);
      }
      continue;
    }

    if (!secao) {
      const linhaRevisao = /^revisao\s*:\s*(.*)$/i.exec(linha);
      if (linhaRevisao && revisao === undefined) revisao = linhaRevisao[1]!.trim();
      continue;
    }

    if (secao.tipo === 'lista') {
      const item = /^\s*[-*]\s+(.*)$/.exec(linha);
      if (item && item[1]!.trim() !== '') listas.get(secao.campo)!.push(item[1]!.trim());
    } else {
      textos.get(secao.campo)!.push(linha.trim());
    }
  }

  const bruto: Record<string, unknown> = { version: CARD_VERSION };
  if (id !== undefined) bruto.id = id;
  if (titulo !== undefined) bruto.titulo = titulo;
  if (revisao !== undefined) {
    bruto.revisao = /^-?\d+$/.test(revisao) ? Number(revisao) : revisao;
  }
  for (const [campo, linhas] of textos) bruto[campo] = linhas.join('\n').trim();
  for (const [campo, itens] of listas) bruto[campo] = itens;
  return bruto;
}

/** JSON com chaves ordenadas: a mesma entrada lógica gera sempre o mesmo hash. */
function jsonEstavel(valor: unknown): string {
  if (valor === undefined) return 'null';
  if (Array.isArray(valor)) return `[${valor.map(jsonEstavel).join(',')}]`;
  if (valor !== null && typeof valor === 'object') {
    const entradas = Object.entries(valor as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entradas.map(([k, v]) => `${JSON.stringify(k)}:${jsonEstavel(v)}`).join(',')}}`;
  }
  return JSON.stringify(valor) ?? 'null';
}

/** Muda quando qualquer campo muda; é o que prova qual cartão o agente recebeu. */
export function cardHash(card: Card): string {
  return createHash('sha256').update(jsonEstavel(card)).digest('hex');
}

/** Marca o padrão glob em regex: '*' não cruza '/', '**' cruza; '**' seguido de '/' aceita zero pastas. */
function globParaRegex(padrao: string): RegExp {
  let fonte = '^';
  for (let i = 0; i < padrao.length; i++) {
    const c = padrao[i]!;
    if (c === '*') {
      if (padrao[i + 1] === '*') {
        if (padrao[i + 2] === '/') {
          fonte += '(?:.*/)?';
          i += 2;
        } else {
          fonte += '.*';
          i += 1;
        }
      } else {
        fonte += '[^/]*';
      }
    } else if ('\\^$.|?+()[]{}'.includes(c)) {
      fonte += `\\${c}`;
    } else {
      fonte += c;
    }
  }
  return new RegExp(`${fonte}$`);
}

/** Confere se um arquivo mudado no diff está liberado pelo cartão. */
export function isPathAllowed(card: Card, relPath: string): boolean {
  const caminho = normalizarCaminho(relPath);
  if (caminho === '' || ehAbsoluto(caminho)) return false;
  const partes = partesDoCaminho(caminho);
  if (partes.length === 0 || partes.includes('..')) return false;
  // Caminho proibido continua proibido mesmo que algum padrão amplo o cubra.
  if (partes.some((parte) => segmentoProibido(parte) !== null)) return false;

  return card.arquivosPermitidos.some((bruto) => {
    const padrao = normalizarCaminho(bruto);
    if (padrao === '' || ehAbsoluto(padrao)) return false;
    const partesPadrao = partesDoCaminho(padrao);
    if (partesPadrao.includes('..')) return false;
    if (partesPadrao.some((parte) => segmentoProibido(parte) !== null)) return false;
    return globParaRegex(padrao).test(caminho);
  });
}

const NOMES: Record<string, string> = {
  version: 'versão',
  id: 'identificador',
  titulo: 'título',
  objetivo: 'objetivo',
  escopo: 'escopo',
  foraDoEscopo: 'fora do escopo',
  criteriosDePronto: 'critérios de pronto',
  testes: 'testes',
  arquivosPermitidos: 'arquivos permitidos',
  riscos: 'riscos',
  revisao: 'revisão',
};

function listar(itens: string[]): string {
  if (itens.length === 1) return itens[0]!;
  return `${itens.slice(0, -1).join(', ')} e ${itens[itens.length - 1]!}`;
}

function ehAusencia(problema: string): boolean {
  return problema.startsWith('ausente') || problema.startsWith('vazio') || problema.startsWith('precisa de pelo menos');
}

/** Frase curta para voz e tela: "Cartão inválido: faltam critérios de pronto e testes." */
export function explainInvalid(errors: CardError[]): string {
  if (errors.length === 0) return 'Cartão inválido: sem detalhes.';
  const faltam: string[] = [];
  const corrigir: string[] = [];
  for (const erro of errors) {
    const nome = erro.problema === 'campo desconhecido'
      ? `o campo desconhecido '${erro.campo}'`
      : (NOMES[erro.campo] ?? erro.campo);
    const destino = ehAusencia(erro.problema) ? faltam : corrigir;
    if (!destino.includes(nome)) destino.push(nome);
  }
  const partes: string[] = [];
  if (faltam.length > 0) partes.push(`${faltam.length === 1 ? 'falta' : 'faltam'} ${listar(faltam)}`);
  if (corrigir.length > 0) partes.push(`corrija ${listar(corrigir)}`);
  return `Cartão inválido: ${partes.join('; ')}.`;
}
