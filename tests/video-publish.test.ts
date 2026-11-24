import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { inspect } from 'node:util';
import { ArtifactStore } from '../src/artifacts/store.ts';
import { buildBrief } from '../src/video/brief.ts';
import { MANIFEST_VERSION, validateManifest, type VideoManifest } from '../src/video/manifest.ts';
import { buildDeliveryPackage, type DeliveryPackage } from '../src/video/package.ts';
import {
  META_PUBLISH_ENV,
  MetaPublishCredentials,
  THREADS_MAX_CAPTION_CHARS,
  approvePublishManifest,
  buildPublishManifest,
  executePublishManifest,
  formatCaptionForPlatform,
  loadPublishManifest,
  publishManifestName,
  savePublishManifest,
  validatePublicHttpsUrl,
  type MetaHttpClient,
  type MetaHttpRequest,
} from '../src/video/publish.ts';

function manifestoBasico(jobId: string): VideoManifest {
  const brief = buildBrief({
    tema: 'Como tardígrados sobrevivem ao vácuo espacial',
    publico: 'curiosos por ciência',
    plataforma: 'reels',
    duracaoAlvoSeg: 45,
    estilo: 'dark-science-2d',
  });
  const v = validateManifest({
    version: MANIFEST_VERSION,
    jobId,
    brief,
    titulo: 'O animal que sobrevive ao espaço',
    motorVisual: 'remotion',
    templateVisual: 'dark-science-2d',
    fontes: [
      { id: 'esa', url: 'https://www.esa.int/', titulo: 'ESA FOTON-M3', acessadoEm: '2026-11-23' },
    ],
    cenas: [1, 2, 3].map((n) => ({
      n,
      narracao: `Cena científica ${n}`,
      duracaoEstimadaSeg: 15,
      afirmacoes: [{ texto: `Fato ${n}`, fonte: 'esa', duvida: false }],
      visual: `Laboratório ${n}`,
      promptImagem: '',
      papelImagem: 'ilustracao',
      realistaGeradaPorIA: false,
      assetRef: null,
      cenario: n === 2 ? 'microscope-pov' : 'lab',
    })),
  });
  if (!v.ok) throw new Error(JSON.stringify(v.errors));
  return v.manifest;
}

describe('publicação Meta (Facebook Reels, Instagram Reels, Threads)', () => {
  let root = '';
  let store: ArtifactStore;
  const jobId = 'pub-1';
  let pkg: DeliveryPackage;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'night-publish-'));
    store = new ArtifactStore(root);
    const manifest = manifestoBasico(jobId);
    await store.add(jobId, {
      name: `${jobId}.mp4`,
      data: Buffer.from('FAKE-MP4-BYTES-0001'),
      origin: 'remotion',
      kind: 'video',
    });
    pkg = await buildDeliveryPackage(store, jobId, manifest, 1);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test('MetaPublishCredentials protege segredos em JSON, inspect e erros', () => {
    const segredoFb = 'EAAB_SUPER_SEGREDO_FB_999';
    const creds = new MetaPublishCredentials({ [META_PUBLISH_ENV.facebook_reels]: segredoFb });

    assert.equal(creds.status('facebook_reels').available, true);
    assert.equal(creds.status('instagram_reels').available, false);
    assert.match(creds.status('threads').missing ?? '', /NIGHT_META_THREADS_TOKEN/);
    assert.equal(creds.get('facebook_reels'), segredoFb);

    assert.throws(() => creds.get('instagram_reels'), /NIGHT_META_IG_TOKEN/);

    const serializado = JSON.stringify(creds);
    assert.ok(!serializado.includes(segredoFb));
    assert.ok(!inspect(creds).includes(segredoFb));
  });

  test('validatePublicHttpsUrl exige HTTPS público e bloqueia localhost/privado', () => {
    assert.deepEqual(validatePublicHttpsUrl('https://cdn.exemplo.com/video.mp4'), {
      ok: true,
      url: 'https://cdn.exemplo.com/video.mp4',
    });
    assert.equal(validatePublicHttpsUrl('http://cdn.exemplo.com/video.mp4').ok, false);
    assert.equal(validatePublicHttpsUrl('https://localhost/video.mp4').ok, false);
    assert.equal(validatePublicHttpsUrl('https://127.0.0.1:4517/video.mp4').ok, false);
    assert.equal(validatePublicHttpsUrl('https://192.168.1.10/video.mp4').ok, false);
    assert.equal(validatePublicHttpsUrl('https://user:pass@cdn.exemplo.com/v.mp4').ok, false);
  });

  test('formatCaptionForPlatform respeita limite de 500 chars no Threads', () => {
    const longo = 'A'.repeat(550);
    const threads = formatCaptionForPlatform('threads', longo, ['#ciencia', 'espaco']);
    assert.ok(threads.length <= THREADS_MAX_CAPTION_CHARS);
    assert.ok(threads.endsWith('…'));

    const ig = formatCaptionForPlatform('instagram_reels', longo, ['#ciencia']);
    assert.ok(ig.length > 500);
  });

  test('buildPublishManifest nasce sempre em rascunho travado com idempotencyKey', async () => {
    const m = buildPublishManifest(pkg, {
      jobId,
      caption: 'Descubra como um animal sobrevive ao espaço.',
      hashtags: ['ciencia', 'biologia'],
      destinations: {
        facebook_reels: { accountId: '10001' },
        instagram_reels: { accountId: '20002', videoUrl: 'https://cdn.exemplo.com/v.mp4' },
        threads: { accountId: '30003', videoUrl: 'https://cdn.exemplo.com/v.mp4' },
      },
    });

    assert.equal(m.status, 'draft');
    assert.equal(m.publicationEnabled, false);
    assert.equal(m.approvalMode, 'review_before_publish');
    assert.equal(m.destinations.length, 3);
    assert.ok(m.destinations.every((d) => /^[a-f0-9]{24}$/.test(d.idempotencyKey)));
    assert.ok(m.destinations.every((d) => d.status === 'draft'));
    assert.equal(publishManifestName(1), 'publish-v1.json');

    await savePublishManifest(store, jobId, m);
    const lido = await loadPublishManifest(store, jobId, 1);
    assert.deepEqual(lido, m);
  });

  test('executePublishManifest bloqueia sem aprovação e valida no dryRun sem chamar rede', async () => {
    const m = buildPublishManifest(pkg, {
      jobId,
      destinations: {
        facebook_reels: { accountId: 'fb-1' },
        instagram_reels: { accountId: 'ig-1', videoUrl: 'https://cdn.exemplo.com/v.mp4' },
        threads: { accountId: 'th-1', videoUrl: 'http://inseguro.com/v.mp4' },
      },
    });
    await savePublishManifest(store, jobId, m);

    let httpCalls = 0;
    const http: MetaHttpClient = async () => {
      httpCalls += 1;
      return { status: 200, ok: true, text: async () => '{}' };
    };

    const creds = new MetaPublishCredentials({
      NIGHT_META_FB_PAGE_TOKEN: 'tok-fb',
      NIGHT_META_IG_TOKEN: 'tok-ig',
      NIGHT_META_THREADS_TOKEN: 'tok-th',
    });

    await assert.rejects(
      executePublishManifest(store, jobId, 1, { http, credentials: creds }),
      /rascunho sem aprovação explícita/,
    );
    assert.equal(httpCalls, 0);

    const dry = await executePublishManifest(store, jobId, 1, {
      dryRun: true,
      http,
      credentials: creds,
    });
    assert.equal(httpCalls, 0);
    assert.equal(dry.dryRun, true);
    assert.equal(dry.ready, false);
    assert.equal(dry.checks.find((c) => c.platform === 'facebook_reels')?.ok, true);
    assert.equal(dry.checks.find((c) => c.platform === 'instagram_reels')?.ok, true);
    assert.equal(dry.checks.find((c) => c.platform === 'threads')?.ok, false);
  });

  test('publica nas 3 redes após aprovação e respeita idempotência em retentativa parcial', async () => {
    const draft = buildPublishManifest(pkg, {
      jobId,
      caption: 'Tardígrados no vácuo espacial.',
      destinations: {
        facebook_reels: { accountId: 'fb-page-1' },
        instagram_reels: { accountId: 'ig-user-2', videoUrl: 'https://cdn.exemplo.com/reel.mp4' },
        threads: { accountId: 'th-user-3', videoUrl: 'https://cdn.exemplo.com/reel.mp4' },
      },
    });
    const aprovado = approvePublishManifest(draft, 'joel');
    await savePublishManifest(store, jobId, aprovado);

    const creds = new MetaPublishCredentials({
      NIGHT_META_FB_PAGE_TOKEN: 'SECRET-FB-1234',
      NIGHT_META_IG_TOKEN: 'SECRET-IG-5678',
      NIGHT_META_THREADS_TOKEN: 'SECRET-TH-9012',
    });

    const requests: { url: string; init: MetaHttpRequest }[] = [];
    let igPollCount = 0;
    let failThreadsOnce = true;

    const http: MetaHttpClient = async (url, init) => {
      requests.push({ url, init });
      if (url.includes('/fb-page-1/video_reels') && typeof init.body === 'string' && init.body.includes('upload_phase=start')) {
        return {
          status: 200,
          ok: true,
          text: async () => JSON.stringify({ video_id: 'fb_vid_11', upload_url: 'https://rupload.facebook.com/up/11' }),
        };
      }
      if (url === 'https://rupload.facebook.com/up/11') {
        assert.ok(init.body instanceof Uint8Array);
        return { status: 200, ok: true, text: async () => JSON.stringify({ success: true }) };
      }
      if (url.includes('/fb-page-1/video_reels') && typeof init.body === 'string' && init.body.includes('upload_phase=finish')) {
        return { status: 200, ok: true, text: async () => JSON.stringify({ success: true }) };
      }
      if (url.includes('/ig-user-2/media_publish')) {
        return { status: 200, ok: true, text: async () => JSON.stringify({ id: 'ig_post_22' }) };
      }
      if (url.endsWith('/ig-user-2/media') && init.method === 'POST') {
        return { status: 200, ok: true, text: async () => JSON.stringify({ id: 'ig_cont_22' }) };
      }
      if (url.includes('/ig_cont_22?fields=status_code')) {
        igPollCount += 1;
        return {
          status: 200,
          ok: true,
          text: async () => JSON.stringify({ status_code: igPollCount === 1 ? 'IN_PROGRESS' : 'FINISHED' }),
        };
      }
      if (url.includes('graph.threads.net/v1.0/th-user-3/threads_publish')) {
        return { status: 200, ok: true, text: async () => JSON.stringify({ id: 'th_post_33' }) };
      }
      if (url.endsWith('graph.threads.net/v1.0/th-user-3/threads') && failThreadsOnce) {
        failThreadsOnce = false;
        return {
          status: 500,
          ok: false,
          text: async () => JSON.stringify({ error: { message: 'erro temporario com SECRET-TH-9012' } }),
        };
      }
      if (url.endsWith('graph.threads.net/v1.0/th-user-3/threads')) {
        return { status: 200, ok: true, text: async () => JSON.stringify({ id: 'th_cont_33' }) };
      }
      if (url.includes('/th_cont_33?fields=status')) {
        return { status: 200, ok: true, text: async () => JSON.stringify({ status: 'FINISHED' }) };
      }
      throw new Error(`chamada inesperada: ${init.method} ${url}`);
    };

    // 1ª execução: FB e IG publicam, Threads falha (e token é redigido do erro).
    const primeira = await executePublishManifest(store, jobId, 1, {
      http,
      credentials: creds,
      pollIntervalMs: 0,
      sleep: async () => undefined,
    });
    assert.equal(primeira.manifest.status, 'partial');
    assert.equal(primeira.manifest.destinations[0]?.status, 'published');
    assert.equal(primeira.manifest.destinations[0]?.providerPostId, 'fb_vid_11');
    assert.equal(primeira.manifest.destinations[1]?.status, 'published');
    assert.equal(primeira.manifest.destinations[1]?.providerPostId, 'ig_post_22');
    assert.equal(primeira.manifest.destinations[2]?.status, 'failed');
    assert.ok(!(primeira.manifest.destinations[2]?.lastError ?? '').includes('SECRET-TH-9012'));
    assert.match(primeira.manifest.destinations[2]?.lastError ?? '', /\[segredo\]/);

    // 2ª execução: não reenvia FB nem IG (idempotência!), apenas publica Threads.
    const requestsAntes = requests.length;
    const segunda = await executePublishManifest(store, jobId, 1, {
      http,
      credentials: creds,
      pollIntervalMs: 0,
      sleep: async () => undefined,
    });
    assert.equal(segunda.manifest.status, 'published');
    assert.equal(segunda.manifest.destinations[2]?.providerPostId, 'th_post_33');
    const novasUrls = requests.slice(requestsAntes).map((r) => r.url);
    assert.ok(novasUrls.every((u) => u.includes('graph.threads.net')));
  });

  test('recusa publicar se o arquivo MP4 foi alterado após o pacote', async () => {
    const aprovado = approvePublishManifest(
      buildPublishManifest(pkg, {
        jobId,
        destinations: { facebook_reels: { accountId: 'fb-1' } },
      }),
      'joel',
    );
    await savePublishManifest(store, jobId, aprovado);
    await writeFile(join(store.root, jobId, `${jobId}.mp4`), 'ADULTERADO', 'utf8');

    const creds = new MetaPublishCredentials({ NIGHT_META_FB_PAGE_TOKEN: 'tok' });
    await assert.rejects(
      executePublishManifest(store, jobId, 1, { credentials: creds, dryRun: true }),
      /alterado|não confere|hash/,
    );
  });
});
