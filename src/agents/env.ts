// Ambiente mínimo para os processos dos agentes (Claude Code, Codex). Revisão do Codex, 04/11:
// herdar o ambiente do Night levaria junto chaves e, pior, uma ANTHROPIC_API_KEY/OPENAI_API_KEY faria a CLI
// cobrar por API em vez de usar a assinatura (blueprint §9: nunca API paga sem o Joel pedir).
// Lista fechada do que passa; todo o resto (inclusive NIGHT_DATABASE_URL, PG*, *_TOKEN) fica de fora.

const ALLOWED = new Set([
  'systemroot', 'windir', 'comspec', 'path', 'pathext', 'temp', 'tmp',
  'userprofile', 'homedrive', 'homepath', 'home', 'appdata', 'localappdata',
  'programdata', 'programfiles', 'programfiles(x86)', 'programw6432', 'commonprogramfiles',
  'number_of_processors', 'processor_architecture', 'os', 'username', 'userdomain', 'computername',
  'lang', 'lc_all', 'tz',
  // onde as CLIs guardam o login da assinatura (OAuth), se o Joel tiver mudado o padrão
  'codex_home', 'claude_config_dir',
  // o pnpm/npm dos testes do projeto
  'pnpm_home', 'nvm_home', 'nvm_symlink',
]);

/** Nunca passa, mesmo que alguém ponha na lista acima por engano. */
const NEVER = /(api_?key|token|secret|password|passwd|credential|auth|cookie|session|database_url|^pg|^aws_|^azure_|^gcp_|^google_|^anthropic|^openai|^claude_code|^claudecode)/i;

export function agentEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (ALLOWED.has(key.toLowerCase()) && !NEVER.test(key)) env[key] = value;
  }
  return env;
}
