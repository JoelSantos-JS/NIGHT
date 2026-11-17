// Pacote de entrega versionado do vídeo (V08, docs/PLANO_MESTRE_NIGHT.md).
// Junta no ArtifactStore o que o Joel precisa para conferir e guardar: vídeo, prévia,
// áudios, legendas, imagens (com hash), roteiro, fontes, créditos e avisos da revisão.
// Publicar continua sendo ação separada: o pacote diz explicitamente que não foi
// publicado e que isso exige pedido do Joel.
//
// V07 (parte): replaceScene troca uma cena e devolve só as cacheKeys afetadas, base do
// "troque a cena 4" sem regenerar as outras cenas.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ArtifactItem, ArtifactStore } from '../artifacts/store.ts';
import { sceneCacheKey, type PapelImagem, type Scene, type Source, type VideoManifest } from './manifest.ts';

/** Nome do arquivo do pacote dentro do job. */
export function packageName(version: number): string {
  return `pacote-v${version}.json`;
}

export interface PackageFile {
  arquivo: string;
  sha256: string;
}

export interface PackageImage extends PackageFile {
  cena: number;
}

export interface DeliveryPackage {
  version: number;
  criadoEm: string;
  titulo: string;
  arquivos: {
    video: PackageFile | null;
    previa: PackageFile | null;
    audios: PackageFile[];
    legendas: PackageFile[];
    imagens: PackageImage[];
  };
  /** Roteiro por cena, na ordem do vídeo. */
  roteiro: { n: number; narracao: string }[];
  fontes: Source[];
  cenas: { n: number; papelImagem: PapelImagem; realistaGeradaPorIA: boolean }[];
  /** Origem de cada asset guardado (Flow, Kokoro, FFmpeg...). */
  creditos: { arquivo: string; origem: string }[];
  avisosRevisao: string[];
  publicacao: string;
}

const AVISO_PUBLICACAO = 'não publicado — publicar exige pedido explícito do Joel';
const REVISAO_PREVIA = 'revisao-previa.json';
const IMAGEM_CENA = /^imagem-cena-(\d+)(?:\.[^.]+)?$/;

function arquivoDe(item: ArtifactItem): PackageFile {
  return { arquivo: item.name, sha256: item.sha256 };
}

function numeroDaImagem(nome: string): number | null {
  const achado = IMAGEM_CENA.exec(nome);
  return achado ? Number(achado[1]) : null;
}

/** Avisos da revisão da prévia, quando o agente já gravou a revisão. */
async function avisosDaRevisao(store: ArtifactStore, jobId: string): Promise<string[]> {
  try {
    const bruto = await readFile(join(store.root, jobId, REVISAO_PREVIA), 'utf8');
    const raw = JSON.parse(bruto) as { avisos?: unknown };
    if (!Array.isArray(raw.avisos)) return [];
    return raw.avisos.map((aviso) => String(aviso));
  } catch {
    // Sem revisão gravada (ou ilegível): o pacote segue sem avisos inventados.
    return [];
  }
}

/**
 * Monta e grava `pacote-v<version>.json`. Os hashes vêm do manifesto do store, não de
 * um cálculo solto: o pacote descreve exatamente o que está guardado no job.
 */
export async function buildDeliveryPackage(
  store: ArtifactStore,
  jobId: string,
  manifest: VideoManifest,
  version: number,
): Promise<DeliveryPackage> {
  if (!Number.isInteger(version) || version < 1) {
    throw new Error(`versão do pacote deve ser inteiro maior ou igual a 1: ${version}`);
  }
  if (manifest.jobId !== jobId) {
    throw new Error(`manifesto é do trabalho ${manifest.jobId}, esperado ${jobId}`);
  }
  const manifestoStore = await store.manifest(jobId);
  const itens = manifestoStore?.items ?? [];

  const videos = itens.filter((item) => item.kind === 'video');
  const final = videos.find((item) => item.name === `${jobId}.mp4`) ?? null;
  const previa = videos.find((item) => item.name === `${jobId}-preview.mp4`) ?? null;
  const audios = itens.filter((item) => item.kind === 'audio');
  const legendas = itens.filter((item) => item.kind === 'legenda');
  const imagens = itens
    .filter((item) => item.kind === 'image')
    .flatMap((item) => {
      const cena = numeroDaImagem(item.name);
      return cena === null ? [] : [{ cena, ...arquivoDe(item) }];
    })
    .sort((a, b) => a.cena - b.cena);

  const pacote: DeliveryPackage = {
    version,
    criadoEm: new Date().toISOString(),
    titulo: manifest.titulo,
    arquivos: {
      video: final ? arquivoDe(final) : null,
      previa: previa ? arquivoDe(previa) : null,
      audios: audios.map(arquivoDe),
      legendas: legendas.map(arquivoDe),
      imagens,
    },
    roteiro: manifest.cenas.map((cena) => ({ n: cena.n, narracao: cena.narracao })),
    fontes: manifest.fontes,
    cenas: manifest.cenas.map((cena) => ({
      n: cena.n,
      papelImagem: cena.papelImagem,
      realistaGeradaPorIA: cena.realistaGeradaPorIA,
    })),
    creditos: itens.map((item) => ({ arquivo: item.name, origem: item.origin })),
    avisosRevisao: await avisosDaRevisao(store, jobId),
    publicacao: AVISO_PUBLICACAO,
  };

  await store.add(jobId, {
    name: packageName(version),
    data: `${JSON.stringify(pacote, null, 2)}\n`,
    origin: 'agente-video',
    kind: 'pacote',
  });
  return pacote;
}

/** Confere se o arquivo registrado no pacote ainda existe com o mesmo hash. */
function conferirArquivos(pacote: DeliveryPackage, itens: Map<string, ArtifactItem>): string[] {
  const problemas: string[] = [];
  const registrados: PackageFile[] = [
    ...(pacote.arquivos.video ? [pacote.arquivos.video] : []),
    ...(pacote.arquivos.previa ? [pacote.arquivos.previa] : []),
    ...pacote.arquivos.audios,
    ...pacote.arquivos.legendas,
    ...pacote.arquivos.imagens,
  ];
  for (const arquivo of registrados) {
    const item = itens.get(arquivo.arquivo);
    if (!item) problemas.push(`ausente do store: ${arquivo.arquivo}`);
    else if (item.sha256 !== arquivo.sha256) problemas.push(`hash diferente: ${arquivo.arquivo}`);
  }
  return problemas;
}

/**
 * Recupera uma versão aprovada exatamente como foi gravada. Usa verify() do store e
 * também compara os hashes registrados no pacote: se algo mudou, recusa em vez de
 * devolver uma versão que não corresponde ao que o Joel aprovou.
 */
export async function loadPackage(
  store: ArtifactStore,
  jobId: string,
  version: number,
): Promise<DeliveryPackage> {
  const nome = packageName(version);
  const manifestoStore = await store.manifest(jobId);
  const item = manifestoStore?.items.find((candidato) => candidato.name === nome);
  if (!item) throw new Error(`pacote v${version} não existe no trabalho ${jobId}`);

  const relatorio = await store.verify(jobId);
  if (!relatorio.ok) {
    const motivos = [
      ...relatorio.missing.map((nomeItem) => `faltando: ${nomeItem}`),
      ...relatorio.changed.map((nomeItem) => `alterado: ${nomeItem}`),
      ...relatorio.extra.map((nomeItem) => `fora do manifesto: ${nomeItem}`),
    ];
    throw new Error(`pacote v${version} não confere: ${motivos.join('; ')}`);
  }

  let pacote: DeliveryPackage;
  try {
    pacote = JSON.parse(await readFile(join(store.root, jobId, nome), 'utf8')) as DeliveryPackage;
  } catch (error) {
    throw new Error(`pacote v${version} ilegível: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (pacote.version !== version) {
    throw new Error(`pacote v${version} declara versão ${String(pacote.version)}`);
  }

  const itens = new Map(manifestoStore!.items.map((candidato) => [candidato.name, candidato]));
  const problemas = conferirArquivos(pacote, itens);
  if (problemas.length > 0) {
    throw new Error(`pacote v${version} não corresponde ao store: ${problemas.join('; ')}`);
  }
  return pacote;
}

export interface SceneReplacement {
  /** Novo manifesto; a cena alterada é uma cópia, as demais seguem iguais. */
  manifest: VideoManifest;
  /** cacheKeys que precisam ser refeitas: só a cena n (vazio se nada mudou). */
  cacheKeysChanged: string[];
}

/**
 * Troca campos de uma cena e devolve o novo manifesto com as cacheKeys afetadas.
 * Base do "troque a cena 4": as outras cenas mantêm a chave e não são regeradas.
 */
export function replaceScene(
  manifest: VideoManifest,
  n: number,
  changes: Partial<Omit<Scene, 'n'>>,
): SceneReplacement {
  const index = manifest.cenas.findIndex((cena) => cena.n === n);
  if (index < 0) throw new Error(`cena ${n} não existe no manifesto`);

  const antes = manifest.cenas[index]!;
  const alterada: Scene = { ...antes, ...changes, n };
  const cenas = manifest.cenas.map((cena, i) => (i === index ? alterada : cena));
  const novo: VideoManifest = { ...manifest, cenas };

  const chaveAntes = sceneCacheKey(antes, manifest.brief);
  const chaveDepois = sceneCacheKey(alterada, manifest.brief);
  return {
    manifest: novo,
    cacheKeysChanged: chaveAntes === chaveDepois ? [] : [chaveDepois],
  };
}
