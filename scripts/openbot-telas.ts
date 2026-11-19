// `pnpm night:telas`: gera o pacote de importação do OpenBot com as 6 telas do NIGHT.
// No OpenBot: Configurações do servidor → Importar → escolher o .zip gerado.
//
// Formato: `openbot-import.json` na raiz (format "openbot-agent-import", versão 1), o mesmo que o
// OpenBot aceita das exportações (src/main/agent-import-manifest.ts no repositório dele). As instruções
// de cada tela vão em `description` (até 2.000 caracteres), que é o que o agente segue.
// Sem dependência: o .zip é montado à mão, sem compressão (é um arquivo só).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { crc32 } from 'node:zlib';
import { nightDataRoot } from '../src/app/coordinator.ts';
import { TELAS, type Tela } from '../src/app/server.ts';

const NOMES: Record<Tela, { name: string; title: string }> = {
  night: { name: 'NIGHT', title: 'Conversa e pesquisa do NIGHT' },
  radar: { name: 'NIGHT Radar', title: 'Busca e discussão de ofertas' },
  produto: { name: 'NIGHT Produto', title: 'Produto low-ticket da oferta aprovada' },
  campanha: { name: 'NIGHT Campanha', title: 'Campanha na Meta (sempre pausada)' },
  codigo: { name: 'NIGHT Código', title: 'Tarefas de código com Claude e Codex' },
  video: { name: 'NIGHT Vídeo', title: 'Vídeos (parado por decisão do Joel)' },
};
const LIMITE_INSTRUCOES = 2000;

export function buildImportManifest(instrucoes: (t: Tela) => string, agora = new Date()): object {
  return {
    format: 'openbot-agent-import',
    version: 1,
    source: { app: 'NIGHT', exportedAt: agora.toISOString() },
    agents: TELAS.map((t) => {
      const description = instrucoes(t).trim();
      if (description.length > LIMITE_INSTRUCOES) {
        throw new Error(`instruções da tela ${t} têm ${description.length} caracteres (máximo ${LIMITE_INSTRUCOES})`);
      }
      return { key: t, ...NOMES[t], description, avatar: null, skills: [], files: null, routines: [], memories: [] };
    }),
    channels: [],
  };
}

/** .zip "stored" (sem compressão) com arquivos na raiz: o suficiente para o importador. */
export function zipStored(files: { name: string; data: Buffer }[]): Buffer {
  const locais: Buffer[] = [];
  const centrais: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const nome = Buffer.from(f.name, 'utf8');
    const crc = crc32(f.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // versão necessária
    local.writeUInt16LE(0x0800, 6); // nome em UTF-8
    local.writeUInt16LE(0, 8); // sem compressão
    local.writeUInt32LE(0, 10); // hora/data
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(f.data.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(nome.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(f.data.length, 20);
    central.writeUInt32LE(f.data.length, 24);
    central.writeUInt16LE(nome.length, 28);
    central.writeUInt32LE(offset, 42);
    locais.push(local, nome, f.data);
    centrais.push(central, nome);
    offset += local.length + nome.length + f.data.length;
  }
  const dir = Buffer.concat(centrais);
  const fim = Buffer.alloc(22);
  fim.writeUInt32LE(0x06054b50, 0);
  fim.writeUInt16LE(files.length, 8);
  fim.writeUInt16LE(files.length, 10);
  fim.writeUInt32LE(dir.length, 12);
  fim.writeUInt32LE(offset, 16);
  return Buffer.concat([...locais, dir, fim]);
}

// Só gera quando roda como script (o teste importa as funções sem gravar nada).
if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const raiz = join(import.meta.dirname, '..');
  const manifesto = buildImportManifest((t) => readFileSync(join(raiz, 'openbot', 'telas', `${t}.md`), 'utf8'));
  const pasta = join(nightDataRoot(), 'openbot');
  mkdirSync(pasta, { recursive: true });
  const destino = join(pasta, 'night-telas.zip');
  writeFileSync(destino, zipStored([{ name: 'openbot-import.json', data: Buffer.from(JSON.stringify(manifesto, null, 2), 'utf8') }]));
  console.log(`Pacote das 6 telas: ${destino}`);
  console.log('No OpenBot: Configurações do servidor → Importar → escolha esse arquivo.');
}
