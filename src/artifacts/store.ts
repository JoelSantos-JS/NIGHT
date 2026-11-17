// Repositório de artefatos por trabalho (plano mestre F04).
// Fica só no sistema de arquivos; o banco guarda a referência de ref().
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { Transform, pipeline } from 'node:stream';

export interface ArtifactItem {
  name: string;
  sha256: string;
  size: number;
  origin: string;
  kind?: string;
  /** Cresce quando o mesmo nome é gravado de novo. */
  version: number;
  addedAt: string;
}

export interface ArtifactManifest {
  version: 'artefatos/1';
  jobId: string;
  /** Cresce a cada mudança no manifesto. */
  revision: number;
  items: ArtifactItem[];
}

export interface AddInput {
  name: string;
  data: Buffer | string;
  origin: string;
  kind?: string;
}

export interface AddFileOptions {
  name?: string;
  origin: string;
  kind?: string;
}

export interface VerifyReport {
  ok: boolean;
  missing: string[];
  changed: string[];
  extra: string[];
}

const MANIFEST_FILE = 'manifest.json';
const MANIFEST_VERSION = 'artefatos/1';
const JOB_ID = /^[A-Za-z0-9_-]{1,80}$/;
/** Contador do sufixo do .tmp, para não repetir o nome dentro do processo. */
let tmpCounter = 0;

/** Valida o id do trabalho: sem isso a pasta poderia escapar da raiz. */
function validJobId(jobId: string): string {
  if (!JOB_ID.test(jobId)) throw new Error(`jobId inválido: ${jobId}`);
  return jobId;
}

/** Só nome simples dentro da pasta do trabalho; o manifesto é do repositório. */
function validName(name: string): string {
  const forbidden = name === '' || name === '.' || name === '..'
    || name.includes('/') || name.includes('\\') || name.includes('\0')
    || name.toLowerCase() === MANIFEST_FILE
    // verify() ignora .tmp; recusar aqui evita artefato invisível.
    || name.endsWith('.tmp');
  if (forbidden) throw new Error(`nome de artefato inválido: ${name}`);
  return name;
}

function sha256Of(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Copia por stream (vídeos grandes não passam pela memória) e calcula hash/tamanho. */
function copyAndHash(source: string, target: string): Promise<{ sha256: string; size: number }> {
  const hash = createHash('sha256');
  let size = 0;
  const tap = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      size += chunk.length;
      callback(null, chunk);
    },
  });
  return new Promise((resolvePromise, reject) => {
    pipeline(createReadStream(source), tap, createWriteStream(target), (error) => {
      if (error) reject(error);
      else resolvePromise({ sha256: hash.digest('hex'), size });
    });
  });
}

/** Hash/tamanho por stream; null se o arquivo não existe mais. */
async function hashFile(path: string): Promise<{ sha256: string; size: number } | null> {
  const hash = createHash('sha256');
  let size = 0;
  try {
    for await (const chunk of createReadStream(path)) {
      const buffer = chunk as Buffer;
      hash.update(buffer);
      size += buffer.length;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  return { sha256: hash.digest('hex'), size };
}

async function listFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

export class ArtifactStore {
  readonly root: string;
  /** Cadeia de gravações pendentes por job (ver serialize()). */
  private readonly queues = new Map<string, Promise<void>>();

  constructor(root: string) {
    this.root = resolve(root);
  }

  /**
   * Enfileira a mudança de manifesto do job: record() faz ler-alterar-gravar,
   * então duas gravações simultâneas perderiam itens. Jobs diferentes seguem
   * em paralelo. A fila é removida quando esvazia.
   */
  private serialize<T>(jobId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(jobId) ?? Promise.resolve();
    const run = previous.then(task);
    // A fila guarda só o término, já sem erro: falha numa gravação não trava as próximas.
    const tail = run.then(() => undefined, () => undefined);
    this.queues.set(jobId, tail);
    void tail.then(() => {
      if (this.queues.get(jobId) === tail) this.queues.delete(jobId);
    });
    return run;
  }

  private jobDir(jobId: string): string {
    return join(this.root, validJobId(jobId));
  }

  /** Referência curta para jobs.artifact_ref; o arquivo fica fora do banco. */
  ref(jobId: string): string {
    return `artefatos:${validJobId(jobId)}`;
  }

  /** Temporário único na pasta do job: verify() ignora .tmp, então ninguém vê a sobra. */
  private tmpPath(dir: string, name: string): string {
    return join(dir, `${name}.${process.pid}.${++tmpCounter}.tmp`);
  }

  async add(jobId: string, input: AddInput): Promise<ArtifactItem> {
    const dir = this.jobDir(jobId);
    const name = validName(input.name);
    const data = typeof input.data === 'string' ? Buffer.from(input.data, 'utf8') : input.data;
    await mkdir(dir, { recursive: true });
    // O arquivo final só é tocado dentro da fila (commit): arquivo e manifesto mudam juntos.
    const tmp = this.tmpPath(dir, name);
    try {
      await writeFile(tmp, data);
    } catch (error) {
      await unlink(tmp).catch(() => undefined);
      throw error;
    }
    return this.commit(jobId, tmp, name, {
      sha256: sha256Of(data), size: data.length, origin: input.origin, kind: input.kind,
    });
  }

  async addFile(jobId: string, sourcePath: string, options: AddFileOptions): Promise<ArtifactItem> {
    const dir = this.jobDir(jobId);
    const name = validName(options.name ?? basename(sourcePath));
    await mkdir(dir, { recursive: true });
    const tmp = this.tmpPath(dir, name);
    let info: { sha256: string; size: number };
    try {
      info = await copyAndHash(sourcePath, tmp);
    } catch (error) {
      // Cópia interrompida não pode deixar temporário para trás.
      await unlink(tmp).catch(() => undefined);
      throw error;
    }
    return this.commit(jobId, tmp, name, { ...info, origin: options.origin, kind: options.kind });
  }

  async manifest(jobId: string): Promise<ArtifactManifest | null> {
    const path = join(this.jobDir(jobId), MANIFEST_FILE);
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    const manifest = JSON.parse(raw) as ArtifactManifest;
    if (manifest.version !== MANIFEST_VERSION) {
      throw new Error(`manifesto de artefatos com versão desconhecida: ${path}`);
    }
    return manifest;
  }

  /** Confere hash/tamanho antes de anunciar resultado; extra = arquivo solto na pasta. */
  async verify(jobId: string): Promise<VerifyReport> {
    const dir = this.jobDir(jobId);
    const manifest = await this.manifest(jobId);
    const items = manifest?.items ?? [];
    const known = new Set(items.map((item) => item.name));
    const missing: string[] = [];
    const changed: string[] = [];
    for (const item of items) {
      const actual = await hashFile(join(dir, item.name));
      if (!actual) {
        missing.push(item.name);
      } else if (actual.sha256 !== item.sha256 || actual.size !== item.size) {
        changed.push(item.name);
      }
    }
    const extra = (await listFiles(dir))
      .filter((name) => name !== MANIFEST_FILE && !name.endsWith('.tmp') && !known.has(name))
      .sort();
    return { ok: missing.length === 0 && changed.length === 0 && extra.length === 0, missing, changed, extra };
  }

  /**
   * Renomeia o temporário para o nome final e atualiza o manifesto, tudo na fila do job.
   * Fora da fila, duas gravações do mesmo nome deixariam o disco com um conteúdo e o
   * manifesto com o hash de outro.
   */
  private commit(
    jobId: string, tmp: string, name: string,
    info: { sha256: string; size: number; origin: string; kind?: string },
  ): Promise<ArtifactItem> {
    return this.serialize(jobId, async () => {
      try {
        await rename(tmp, join(this.jobDir(jobId), name));
      } catch (error) {
        await unlink(tmp).catch(() => undefined);
        throw error;
      }
      const current = await this.manifest(jobId);
      const items = current ? [...current.items] : [];
      const index = items.findIndex((item) => item.name === name);
      const previous = index >= 0 ? items[index]! : null;
      const item: ArtifactItem = {
        name,
        sha256: info.sha256,
        size: info.size,
        origin: info.origin,
        ...(info.kind ? { kind: info.kind } : {}),
        version: (previous?.version ?? 0) + 1,
        addedAt: new Date().toISOString(),
      };
      if (index >= 0) items[index] = item;
      else items.push(item);
      const manifest: ArtifactManifest = {
        version: MANIFEST_VERSION,
        jobId,
        revision: (current?.revision ?? 0) + 1,
        items,
      };
      await this.writeManifest(jobId, manifest);
      return item;
    });
  }

  /** Grava em .tmp e renomeia: manifesto nunca fica pela metade. */
  private async writeManifest(jobId: string, manifest: ArtifactManifest): Promise<void> {
    const dir = this.jobDir(jobId);
    const path = join(dir, MANIFEST_FILE);
    // .tmp único por gravação: duas gravações nunca disputam o mesmo temporário.
    const tmp = `${path}.${process.pid}.${++tmpCounter}.tmp`;
    await mkdir(dir, { recursive: true });
    await writeFile(tmp, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    await rename(tmp, path);
  }
}
