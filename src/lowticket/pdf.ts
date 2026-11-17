// PDFs de verdade do produto low-ticket (L02, docs/PLANO_MESTRE_NIGHT.md).
// O Markdown vira HTML com um conversor próprio (sem dependência) e o HTML vira PDF pelo
// Edge/Chrome em modo headless, já presente no PC. O processo é injetável para testar sem
// abrir navegador.
//
// Escolhas que importam:
// - todo texto é escapado antes de virar HTML: nada de HTML cru do modelo passa;
// - a capa usa o "#" do Markdown, o sumário vem dos "##" e cada "##" começa em página nova;
// - o PDF só é aceito se o arquivo existe e começa com "%PDF";
// - o nome do arquivo sai de um slug determinístico (mesma entrada, mesmos nomes).

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, open, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ArtifactStore } from '../artifacts/store.ts';
import { normalizeForCopyCheck } from '../radar/offer.ts';
import type { ProductContentItem, ProductItemType } from './content.ts';

// --- Markdown -> HTML ---

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escapa todo o texto; o modelo pode escrever "<script>" que nunca vira tag. */
function escapeHtml(texto: string): string {
  return texto.replace(/[&<>"']/g, (caractere) => ESCAPES[caractere]!);
}

/** Escapa primeiro e só depois aplica links, negrito e itálico. */
function inline(texto: string): string {
  let out = escapeHtml(texto);
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_todo, rotulo: string, url: string) => {
    // Só link inofensivo vira âncora; o resto fica como texto (nada de javascript:).
    if (!/^(https?:\/\/|mailto:)/i.test(url)) return rotulo;
    return `<a href="${url.replace(/"/g, '&quot;')}">${rotulo}</a>`;
  });
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  return out;
}

interface Capa {
  titulo: string;
  subtitulo: string;
}

/** Capa: primeiro "#" vira título e o primeiro parágrafo depois dele vira subtítulo. */
function extrairCapa(md: string, tituloPadrao: string): Capa {
  const linhas = md.replace(/\r\n?/g, '\n').split('\n');
  const indice = linhas.findIndex((linha) => /^#\s+/.test(linha));
  if (indice < 0) return { titulo: tituloPadrao, subtitulo: '' };
  const titulo = linhas[indice]!.replace(/^#\s+/, '').trim();

  const subtitulo: string[] = [];
  for (const linha of linhas.slice(indice + 1)) {
    const limpa = linha.trim();
    if (limpa === '') {
      if (subtitulo.length > 0) break;
      continue;
    }
    if (/^#{1,6}\s/.test(limpa) || /^>\s?/.test(limpa) || /^[-*]\s+/.test(limpa) || /^\d+\.\s+/.test(limpa)) {
      break;
    }
    subtitulo.push(limpa);
  }
  return { titulo, subtitulo: subtitulo.join(' ') };
}

/** Bloco que começa um trecho especial e por isso fecha o parágrafo em curso. */
function ehInicioDeBloco(linha: string): boolean {
  return /^#{1,3}\s+/.test(linha)
    || /^---+$/.test(linha)
    || /^>\s?/.test(linha)
    || /^[-*]\s+/.test(linha)
    || /^\d+\.\s+/.test(linha);
}

const CSS = `
@page {
  size: A4;
  margin: 20mm 18mm 22mm;
  @bottom-center {
    content: counter(page) " / " counter(pages);
    font-family: Georgia, "Times New Roman", serif;
    font-size: 9pt;
    color: #6b6b6b;
  }
}
html, body { margin: 0; padding: 0; }
body {
  font-family: Georgia, "Times New Roman", serif;
  font-size: 11.5pt;
  line-height: 1.55;
  color: #1d1d1d;
}
.capa {
  min-height: 88vh;
  display: flex;
  flex-direction: column;
  justify-content: center;
  text-align: center;
  page-break-after: always;
}
.capa .marca {
  font-size: 10pt;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: #8a5a2b;
  margin-bottom: 12mm;
}
.capa h1 { font-size: 30pt; line-height: 1.15; margin: 0 0 8mm; }
.capa .subtitulo {
  font-size: 14pt;
  color: #444;
  font-style: italic;
  max-width: 130mm;
  margin: 0 auto;
}
.sumario { page-break-after: always; }
.sumario h2 { page-break-before: auto; break-before: auto; font-size: 19pt; margin: 0 0 5mm; }
.sumario ol { font-size: 12.5pt; line-height: 1.8; }
.sumario a { color: inherit; text-decoration: none; }
main h2 {
  page-break-before: always;
  break-before: page;
  font-size: 19pt;
  margin: 0 0 4mm;
}
main h3 { font-size: 14pt; margin: 7mm 0 2mm; }
p { text-align: justify; margin: 0 0 4mm; }
ul, ol { margin: 0 0 4mm 6mm; padding-left: 5mm; }
li { margin-bottom: 1.5mm; }
blockquote {
  margin: 4mm 0;
  padding: 2mm 5mm;
  border-left: 2pt solid #b88a5a;
  color: #4a4a4a;
  font-style: italic;
}
hr { border: 0; border-top: 0.5pt solid #ccc; margin: 6mm 0; }
a { color: #7a4a1f; }
`.trim();

/**
 * Converte o Markdown do item em um documento HTML de impressão com capa, sumário,
 * capítulos, listas, citações e numeração de página. Sem dependência e determinístico.
 */
export function markdownToHtml(md: string, opts: { titulo: string; marca?: string }): string {
  const capa = extrairCapa(md, opts.titulo);
  const linhas = md.replace(/\r\n?/g, '\n').split('\n');
  const corpo: string[] = [];
  const secoes: string[] = [];
  let tituloDaCapaVisto = false;
  let i = 0;

  while (i < linhas.length) {
    const linha = linhas[i]!.trim();

    if (linha === '') {
      i += 1;
      continue;
    }

    if (/^---+$/.test(linha)) {
      corpo.push('<hr>');
      i += 1;
      continue;
    }

    const titulo = /^(#{1,3})\s+(.*)$/.exec(linha);
    if (titulo) {
      const nivel = titulo[1]!.length;
      const texto = titulo[2]!.trim();
      if (nivel === 1 && !tituloDaCapaVisto) {
        // O primeiro "#" já é a capa: não repete no corpo.
        tituloDaCapaVisto = true;
      } else if (nivel <= 2) {
        secoes.push(texto);
        corpo.push(`<h2 id="sec-${secoes.length}">${inline(texto)}</h2>`);
      } else {
        corpo.push(`<h3>${inline(texto)}</h3>`);
      }
      i += 1;
      continue;
    }

    if (/^>\s?/.test(linha)) {
      const citacao: string[] = [];
      while (i < linhas.length && /^>\s?/.test(linhas[i]!.trim())) {
        citacao.push(linhas[i]!.trim().replace(/^>\s?/, ''));
        i += 1;
      }
      corpo.push(`<blockquote>${inline(citacao.join(' '))}</blockquote>`);
      continue;
    }

    if (/^[-*]\s+/.test(linha)) {
      const itens: string[] = [];
      while (i < linhas.length && /^[-*]\s+/.test(linhas[i]!.trim())) {
        itens.push(linhas[i]!.trim().replace(/^[-*]\s+/, ''));
        i += 1;
      }
      corpo.push(`<ul>${itens.map((item) => `<li>${inline(item)}</li>`).join('')}</ul>`);
      continue;
    }

    if (/^\d+\.\s+/.test(linha)) {
      const itens: string[] = [];
      while (i < linhas.length && /^\d+\.\s+/.test(linhas[i]!.trim())) {
        itens.push(linhas[i]!.trim().replace(/^\d+\.\s+/, ''));
        i += 1;
      }
      corpo.push(`<ol>${itens.map((item) => `<li>${inline(item)}</li>`).join('')}</ol>`);
      continue;
    }

    // Parágrafo: junta as linhas até um bloco especial ou linha em branco.
    const paragrafo: string[] = [];
    while (i < linhas.length) {
      const atual = linhas[i]!.trim();
      if (atual === '' || ehInicioDeBloco(atual)) break;
      paragrafo.push(atual);
      i += 1;
    }
    corpo.push(`<p>${inline(paragrafo.join(' '))}</p>`);
  }

  const marca = opts.marca ? `<div class="marca">${inline(opts.marca)}</div>` : '';
  const subtitulo = capa.subtitulo ? `<p class="subtitulo">${inline(capa.subtitulo)}</p>` : '';
  const sumario = secoes.length === 0
    ? ''
    : '<nav class="sumario"><h2>Sumário</h2><ol>'
      + secoes.map((secao, indice) => `<li><a href="#sec-${indice + 1}">${inline(secao)}</a></li>`).join('')
      + '</ol></nav>';

  return [
    '<!doctype html>',
    '<html lang="pt-BR">',
    '<head>',
    '<meta charset="utf-8">',
    `<title>${escapeHtml(opts.titulo)}</title>`,
    `<style>${CSS}</style>`,
    '</head>',
    '<body>',
    `<section class="capa">${marca}<h1>${inline(capa.titulo)}</h1>${subtitulo}</section>`,
    sumario,
    '<main>',
    ...corpo,
    '</main>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

// --- Navegador e PDF ---

/** Caminhos procurados, na ordem: Edge primeiro (já vem no Windows). */
export const EDGE_CANDIDATES: readonly string[] = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];

export const CHROME_CANDIDATES: readonly string[] = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
];

/**
 * Acha o navegador para o modo headless. NIGHT_PDF_BROWSER tem prioridade (escolha
 * explícita do Joel); sem ele, procura o Edge e depois o Chrome nos caminhos padrão.
 * `existe` é injetável para testar sem abrir o disco.
 */
export function findBrowser(
  env: NodeJS.ProcessEnv = process.env,
  existe: (caminho: string) => boolean = existsSync,
): string | null {
  const doEnv = env.NIGHT_PDF_BROWSER?.trim();
  if (doEnv) return doEnv;
  for (const caminho of [...EDGE_CANDIDATES, ...CHROME_CANDIDATES]) {
    if (existe(caminho)) return caminho;
  }
  return null;
}

/** URL de arquivo aceita pelo navegador, inclusive no Windows ("file:///C:/..."). */
export function fileUrl(caminho: string): string {
  return pathToFileURL(caminho).href;
}

export type PdfRunner = (bin: string, args: string[]) => Promise<{ code: number; stderr: string }>;

/** Executa o navegador sem shell; os argumentos vão em array, um a um. */
function runBrowser(bin: string, args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const filho = spawn(bin, args, { shell: false });
    let stderr = '';
    filho.stderr.setEncoding('utf8');
    filho.stderr.on('data', (trecho: string) => {
      stderr += trecho;
      if (stderr.length > 16_000) stderr = stderr.slice(-16_000);
    });
    filho.on('error', (erro) => reject(new Error(`não consegui executar ${bin}: ${erro.message}`)));
    filho.on('close', (codigo) => resolve({ code: codigo ?? -1, stderr }));
  });
}

/** Fim do stderr, que é onde o navegador explica o erro de verdade. */
function fimDoStderr(stderr: string, max = 2000): string {
  const limpo = stderr.trim();
  if (limpo === '') return 'sem stderr';
  return limpo.length <= max ? limpo : `…${limpo.slice(-max)}`;
}

/** Lê os primeiros bytes do arquivo; null quando ele nem existe. */
async function lerInicio(caminho: string, bytes: number): Promise<string | null> {
  let arquivo;
  try {
    arquivo = await open(caminho, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await arquivo.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead).toString('latin1');
  } finally {
    await arquivo.close();
  }
}

/**
 * Roda o navegador com `--print-to-pdf` e confere a saída. PDF ausente ou sem "%PDF"
 * vira erro claro em vez de um arquivo quebrado anunciado como pronto.
 */
export async function htmlToPdf(
  htmlPath: string,
  pdfPath: string,
  run: PdfRunner = runBrowser,
  browser: string | null = findBrowser(),
): Promise<void> {
  if (!browser) {
    throw new Error('navegador não encontrado para gerar PDF; defina NIGHT_PDF_BROWSER ou instale o Edge');
  }
  await mkdir(dirname(pdfPath), { recursive: true });
  const args = [
    '--headless',
    '--disable-gpu',
    '--no-pdf-header-footer',
    `--print-to-pdf=${pdfPath}`,
    fileUrl(htmlPath),
  ];
  const resultado = await run(browser, args);
  if (resultado.code !== 0) {
    throw new Error(`navegador falhou (código ${resultado.code}) ao gerar PDF: ${fimDoStderr(resultado.stderr)}`);
  }
  const inicio = await lerInicio(pdfPath, 4);
  if (inicio === null) throw new Error(`o navegador não gravou o PDF: ${pdfPath}`);
  if (inicio !== '%PDF') {
    throw new Error(`a saída do navegador não é um PDF (falta %PDF no início): ${pdfPath}`);
  }
}

// --- Montagem dos arquivos ---

const SLUG_MAX = 40;

/** Slug determinístico para o nome do arquivo: sem acento, minúsculo, com hífens. */
function slug(texto: string): string {
  const limpo = normalizeForCopyCheck(texto)
    .replace(/ +/g, '-')
    .slice(0, SLUG_MAX)
    .replace(/-+$/, '');
  return limpo || 'item';
}

export interface BuildPdfsOptions {
  /** Pasta dos HTML e PDF antes de irem ao store (o HTML fica só aqui). */
  workDir: string;
  marca?: string;
  /** Injetável nos testes; o padrão roda o navegador de verdade. */
  run?: PdfRunner;
  /** Caminho do navegador; sem ele, findBrowser() decide. */
  browser?: string;
}

export interface BuiltPdf {
  nome: string;
  tipo: ProductItemType;
  /** Nome do PDF dentro do store. */
  arquivo: string;
  sha256: string;
  size: number;
  /** Caminho do HTML que gerou este PDF. */
  html: string;
}

/**
 * Para cada item 'ok', grava o HTML no workDir, gera o PDF e adiciona o PDF ao
 * ArtifactStore (origin 'lowticket', kind 'pdf'). Item inválido é pulado.
 */
export async function buildProductPdfs(
  store: ArtifactStore,
  jobId: string,
  itens: ProductContentItem[],
  opts: BuildPdfsOptions,
): Promise<BuiltPdf[]> {
  await mkdir(opts.workDir, { recursive: true });
  const pdfs: BuiltPdf[] = [];
  let numeroDoPdf = 0;

  for (const item of itens) {
    if (item.status !== 'ok') continue;

    let arquivo: string;
    if (item.tipo === 'bonus') {
      arquivo = `bonus-${slug(item.nome)}.pdf`;
    } else {
      // A numeração segue a ordem dos PDFs (um inválido deixa o buraco, o nome não muda).
      numeroDoPdf += 1;
      arquivo = `produto-${numeroDoPdf}-${slug(item.nome)}.pdf`;
    }
    const htmlPath = join(opts.workDir, arquivo.replace(/\.pdf$/, '.html'));
    const pdfPath = join(opts.workDir, arquivo);

    await writeFile(htmlPath, markdownToHtml(item.markdown, { titulo: item.nome, marca: opts.marca }), 'utf8');
    await htmlToPdf(htmlPath, pdfPath, opts.run, opts.browser);

    const guardado = await store.addFile(jobId, pdfPath, { name: arquivo, origin: 'lowticket', kind: 'pdf' });
    pdfs.push({
      nome: item.nome,
      tipo: item.tipo,
      arquivo: guardado.name,
      sha256: guardado.sha256,
      size: guardado.size,
      html: htmlPath,
    });
  }

  return pdfs;
}
