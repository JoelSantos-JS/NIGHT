// Credenciais separadas por integração (F05). Cada integração tem sua própria chave e seus
// escopos: a chave do Meta Ads não serve para publicar, e a do executor só lê.
// Regra do projeto: segredo nunca aparece em prompt, log, evento ou mensagem de erro.
// Só o valor devolvido por get() é secreto; status/JSON/inspect mostram apenas disponibilidade.

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';

export type IntegrationName = 'deepseek' | 'meta_ads' | 'executor';

export interface Integration {
  /** Variável de ambiente que guarda a credencial. */
  env: string;
  /** Arquivo alternativo (só o DeepSeek usa); '~' é a pasta do usuário. */
  file?: string;
  /** Escopos permitidos: pedir outro é negado antes de qualquer leitura. */
  scopes: readonly string[];
}

export const INTEGRATIONS: Readonly<Record<IntegrationName, Integration>> = {
  // 'executor' é o DeepSeek escrevendo código na worktree (D12/H01): mesma chave, uso separado.
  deepseek: { env: 'DEEPSEEK_API_KEY', file: '~/.deepseek/api_key', scopes: ['parecer', 'reserva', 'executor'] },
  meta_ads: { env: 'NIGHT_META_ADS_TOKEN', scopes: ['leitura'] },
  executor: { env: 'NIGHT_EXECUTOR_TOKEN', scopes: ['leitura'] },
};

export interface CredentialStatus {
  integration: IntegrationName;
  available: boolean;
  /** Frase do que fazer para resolver; null quando a credencial existe. Nunca mostra valores. */
  missing: string | null;
}

export type ReadFileSyncLike = (path: string, encoding: 'utf8') => string;
export type ExistsSyncLike = (path: string) => boolean;

export interface CredentialStoreOptions {
  env?: NodeJS.ProcessEnv;
  readFile?: ReadFileSyncLike;
  exists?: ExistsSyncLike;
}

const LABELS: Readonly<Record<IntegrationName, string>> = {
  deepseek: 'a chave do DeepSeek',
  meta_ads: 'o token do Meta Ads',
  executor: 'o token do executor',
};

/** Expande '~/...' para os.homedir(); o resto do caminho fica como veio. */
function expandHome(file: string): string {
  if (file === '~') return homedir();
  if (file.startsWith('~/') || file.startsWith('~\\')) return join(homedir(), file.slice(2));
  return file;
}

function missingText(name: IntegrationName): string {
  const spec = INTEGRATIONS[name];
  const hint = spec.file ? `defina ${spec.env} ou crie ${spec.file}` : `defina ${spec.env}`;
  return `falta ${LABELS[name]}: ${hint}`;
}

/** Troca cada segredo (4+ caracteres) por '[segredo]'. Use antes de gravar log ou evento. */
export function redactSecrets(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    // Segredo curto demais trocaria texto comum e esconderia o problema real.
    if (secret.length < 4) continue;
    out = out.split(secret).join('[segredo]');
  }
  return out;
}

export class CredentialStore {
  private readonly env: NodeJS.ProcessEnv;
  private readonly readFile: ReadFileSyncLike;
  private readonly exists: ExistsSyncLike;

  constructor({ env = process.env, readFile, exists }: CredentialStoreOptions = {}) {
    this.env = env;
    this.readFile = readFile ?? ((path, encoding) => readFileSync(path, encoding));
    this.exists = exists ?? existsSync;
  }

  status(name: IntegrationName): CredentialStatus {
    const available = this.resolve(name) !== null;
    return { integration: name, available, missing: available ? null : missingText(name) };
  }

  /** Devolve o segredo só se o escopo pedido pertence à integração. */
  get(name: IntegrationName, scope: string): string {
    const spec = INTEGRATIONS[name];
    if (!spec) throw new Error(`integração desconhecida: ${String(name)}`);
    if (!spec.scopes.includes(scope)) {
      throw new Error(`escopo ${scope} não permitido para ${name}`);
    }
    const secret = this.resolve(name);
    if (secret === null) throw new Error(missingText(name));
    return secret;
  }

  /** JSON e util.inspect mostram só nomes e disponibilidade: nada de segredo. */
  toJSON(): Record<IntegrationName, { available: boolean }> {
    const out = {} as Record<IntegrationName, { available: boolean }>;
    for (const name of Object.keys(INTEGRATIONS) as IntegrationName[]) {
      out[name] = { available: this.status(name).available };
    }
    return out;
  }

  [inspect.custom](): string {
    return `CredentialStore ${inspect(this.toJSON())}`;
  }

  private resolve(name: IntegrationName): string | null {
    const spec = INTEGRATIONS[name];
    if (!spec) throw new Error(`integração desconhecida: ${String(name)}`);
    const doAmbiente = this.env[spec.env]?.trim();
    if (doAmbiente) return doAmbiente;
    if (!spec.file) return null;
    const arquivo = expandHome(spec.file);
    if (!this.exists(arquivo)) return null;
    try {
      const conteudo = this.readFile(arquivo, 'utf8').trim();
      return conteudo === '' ? null : conteudo;
    } catch {
      // Arquivo ilegível conta como ausente: o status precisa responder sem quebrar.
      return null;
    }
  }
}
