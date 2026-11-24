import { createReadStream, existsSync, statSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { bundle } from '@remotion/bundler';
import { renderMedia, selectComposition } from '@remotion/renderer';

const MIME_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.aac': 'audio/aac',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
};

function parseArgs(argv) {
  let propsPath = '';
  let outPath = '';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--props' && argv[i + 1]) {
      propsPath = argv[++i];
    } else if (argv[i] === '--out' && argv[i + 1]) {
      outPath = argv[++i];
    }
  }
  if (!propsPath || !outPath) {
    throw new Error('uso: node render-cli.mjs --props <props.json> --out <video.mp4>');
  }
  return { propsPath: resolve(propsPath), outPath: resolve(outPath) };
}

function findBrowserExecutable() {
  const candidates = [
    process.env.NIGHT_CHROME_BIN,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ].filter((c) => typeof c === 'string' && c.trim() !== '');

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Cria um WAV PCM silencioso de 1 segundo em memória para garantir faixa de áudio quando o rascunho é mudo. */
function buildSilentWavBuffer(sampleRate = 48000, channels = 2, durationSec = 1) {
  const numSamples = sampleRate * durationSec;
  const dataSize = numSamples * channels * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); // PCM chunk size
  buf.writeUInt16LE(1, 20); // PCM format
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * channels * 2, 28);
  buf.writeUInt16LE(channels * 2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  return buf;
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(value);
}

async function startAssetServer(props, silentWavPath) {
  const routeToFile = new Map();
  let counter = 0;

  const registerLocal = (rawPath) => {
    if (typeof rawPath !== 'string' || rawPath.trim() === '') return null;
    if (isHttpUrl(rawPath)) return rawPath;
    const abs = resolve(rawPath);
    if (!existsSync(abs)) {
      throw new Error(`asset local não encontrado: ${abs}`);
    }
    const ext = extname(abs).toLowerCase() || '.bin';
    const route = `/assets/${counter++}${ext}`;
    routeToFile.set(route, abs);
    return route;
  };

  const mappedScenes = (props.scenes ?? []).map((scene) => ({
    ...scene,
    imageUrl: registerLocal(scene.imageUrl),
    audioUrl: registerLocal(scene.audioUrl),
  }));

  let musicRoute = registerLocal(props.musicUrl);
  const hasAnyAudio = mappedScenes.some((s) => Boolean(s.audioUrl)) || Boolean(musicRoute);
  if (!hasAnyAudio && silentWavPath) {
    musicRoute = registerLocal(silentWavPath);
  }

  const server = createServer((req, res) => {
    const pathname = (req.url || '').split('?')[0];
    const filePath = routeToFile.get(pathname);
    if (!filePath) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const stat = statSync(filePath);
    const ext = extname(filePath).toLowerCase();
    const mime = MIME_TYPES[ext] || 'application/octet-stream';
    const range = req.headers.range;

    if (range) {
      const m = /^bytes=(\d+)-(\d*)$/.exec(range);
      if (m) {
        const start = Number(m[1]);
        const end = m[2] ? Math.min(Number(m[2]), stat.size - 1) : stat.size - 1;
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${stat.size}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': String(end - start + 1),
          'Content-Type': mime,
        });
        createReadStream(filePath, { start, end }).pipe(res);
        return;
      }
    }

    res.writeHead(200, {
      'Content-Length': String(stat.size),
      'Accept-Ranges': 'bytes',
      'Content-Type': mime,
    });
    createReadStream(filePath).pipe(res);
  });

  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => resolveListen());
  });

  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const toUrl = (val) => (typeof val === 'string' && val.startsWith('/assets/') ? `${baseUrl}${val}` : val);

  const rewrittenProps = {
    ...props,
    musicUrl: toUrl(musicRoute),
    scenes: mappedScenes.map((s) => ({
      ...s,
      imageUrl: toUrl(s.imageUrl),
      audioUrl: toUrl(s.audioUrl),
    })),
  };

  return {
    props: rewrittenProps,
    close: () =>
      new Promise((resolveClose) => {
        server.close(() => resolveClose());
      }),
  };
}

async function main() {
  const { propsPath, outPath } = parseArgs(process.argv.slice(2));
  const raw = JSON.parse(await readFile(propsPath, 'utf8'));
  const workTmp = await mkdtemp(join(tmpdir(), 'night-remotion-'));
  const silentWavPath = join(workTmp, 'silence.wav');
  await writeFile(silentWavPath, buildSilentWavBuffer());

  let serverHandle = null;
  try {
    serverHandle = await startAssetServer(raw, silentWavPath);
    const bundleLocation = await bundle({
      entryPoint: join(import.meta.dirname, 'src', 'index.ts'),
      outDir: join(workTmp, 'bundle'),
    });

    const browserExecutable = findBrowserExecutable();
    const composition = await selectComposition({
      serveUrl: bundleLocation,
      id: 'NightVideo',
      inputProps: serverHandle.props,
      ...(browserExecutable ? { browserExecutable } : {}),
    });

    await mkdir(dirname(outPath), { recursive: true });
    await renderMedia({
      composition,
      serveUrl: bundleLocation,
      codec: 'h264',
      audioCodec: 'aac',
      pixelFormat: 'yuv420p',
      crf: raw.preview ? 24 : 20,
      outputLocation: outPath,
      inputProps: serverHandle.props,
      ...(browserExecutable ? { browserExecutable } : {}),
    });
  } finally {
    if (serverHandle) await serverHandle.close();
    await rm(workTmp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
