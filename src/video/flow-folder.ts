// Caminho manual e honesto das imagens do Flow (V03, docs/PLANO_MESTRE_NIGHT.md).
// O Flow gratuito não tem API: o Joel gera no navegador, baixa a imagem e salva numa
// pasta com o nome combinado. O NIGHT lê essa pasta e retoma o vídeo sem inventar
// imagem nem prometer Flow autônomo com o computador desligado.
//
// Nomes aceitos por cena: cena-1.png, cena-01.jpg, cena-02.jpeg, cena-3.webp...
// A pasta do trabalho pode ser o número do vídeo ("continua o vídeo 12") ou o jobId.

import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { ImageProvider } from './agent.ts';
import type { Scene, VideoManifest } from './manifest.ts';

/** Pasta raiz padrão: fora do repositório, no disco de dados do NIGHT. */
export const FLOW_FOLDER_PADRAO = 'D:/NIGHT-data/flow-import';

const EXTENSOES = ['.png', '.jpg', '.jpeg', '.webp'] as const;

export interface FlowFolderOptions {
  /** Pasta raiz onde ficam as subpastas por vídeo; padrão FLOW_FOLDER_PADRAO. */
  root?: string;
  /** Número do vídeo que o Joel fala ("continua o vídeo 12"); opcional. */
  numeroDoVideo?: number | string | null;
}

/** Nomes-base aceitos para a cena, do mais simples ao zero à esquerda. */
function nomesDaCena(n: number): string[] {
  const nomes = new Set([`cena-${n}`, `cena-${String(n).padStart(2, '0')}`, `cena-0${n}`]);
  return [...nomes];
}

function ehFaltaDeArquivo(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

export class FlowFolderProvider implements ImageProvider {
  readonly origin = 'flow';
  private readonly root: string;
  private readonly numero: string | null;

  constructor(options: FlowFolderOptions = {}) {
    this.root = options.root ?? FLOW_FOLDER_PADRAO;
    const numero = options.numeroDoVideo;
    this.numero = numero === undefined || numero === null || String(numero).trim() === ''
      ? null
      : String(numero).trim();
  }

  /** Pasta onde o Joel deve salvar as imagens (número do vídeo quando conhecido). */
  pastaDoJob(jobId: string): string {
    return join(this.root, this.numero ?? jobId);
  }

  /** Pastas aceitas: a do número do vídeo e a do jobId, sem repetir. */
  private pastasDoJob(jobId: string): string[] {
    const pastas: string[] = [];
    if (this.numero !== null) pastas.push(join(this.root, this.numero));
    const porJob = join(this.root, jobId);
    if (!pastas.includes(porJob)) pastas.push(porJob);
    return pastas;
  }

  /** Caminho da imagem da cena, ou null se ainda não foi salva. */
  async find(jobId: string, scene: Scene): Promise<string | null> {
    const bases = nomesDaCena(scene.n).map((nome) => nome.toLowerCase());
    for (const pasta of this.pastasDoJob(jobId)) {
      let entradas: string[];
      try {
        entradas = await readdir(pasta);
      } catch (error) {
        if (ehFaltaDeArquivo(error)) continue;
        throw error;
      }
      // Compara sem diferenciar maiúsculas: o Windows não diferencia nomes de arquivo.
      const porNome = new Map(entradas.map((nome) => [nome.toLowerCase(), nome]));
      for (const base of bases) {
        for (const extensao of EXTENSOES) {
          const achado = porNome.get(`${base}${extensao}`);
          if (achado) return join(pasta, achado);
        }
      }
    }
    return null;
  }

  /** Grava a folha de prompts na pasta do trabalho e devolve o arquivo. */
  async writePromptSheet(jobId: string, manifest: VideoManifest): Promise<string> {
    return writePromptSheet(manifest, this.pastaDoJob(jobId));
  }
}

/**
 * Grava 'prompts-flow.txt' na pasta indicada: uma linha por cena com o prompt em inglês
 * e as instruções curtas do caminho manual (gerar no Flow, baixar, salvar e retomar).
 */
export async function writePromptSheet(manifest: VideoManifest, dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const numero = basename(dir);
  const cenas = manifest.cenas.map((cena) => `cena-${cena.n}: ${cena.promptImagem}`);
  const conteudo = [
    `# Prompts do Flow — ${manifest.titulo}`,
    '',
    'Gere cada imagem no Flow pelo navegador, usando o prompt da cena.',
    'Baixe a imagem e salve nesta pasta com o nome indicado (cena-N.png, cena-N.jpg ou cena-N.webp).',
    `Depois fale: "continua o vídeo ${numero}".`,
    '',
    ...cenas,
    '',
  ].join('\n');
  const arquivo = join(dir, 'prompts-flow.txt');
  await writeFile(arquivo, conteudo, 'utf8');
  return arquivo;
}
