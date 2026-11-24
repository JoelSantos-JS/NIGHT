// Captura criativos públicos visíveis nos cards da Biblioteca de Anúncios da Meta.
// Uso: tsx scripts/capturar-criativos-meta.ts <id-do-anuncio> <pasta-de-saida> [host-da-oferta]
// Os arquivos são referências locais; não são ativos para publicação.
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';

const adId = process.argv[2];
const saida = process.argv[3];
const hostOferta = process.argv[4]?.toLowerCase() ?? '';
if (!adId || !/^\d{10,20}$/.test(adId) || !saida) {
  console.error('uso: tsx scripts/capturar-criativos-meta.ts <id-do-anuncio> <pasta-de-saida> [host-da-oferta]');
  process.exit(2);
}
const destino = resolve(saida);
const urlAnuncio = `https://www.facebook.com/ads/library/?id=${adId}`;
const browser = await chromium.launch({
  executablePath: process.env.NIGHT_RADAR_CHROME_PATH ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  headless: true,
});

type Midia = { tipo: 'imagem' | 'video'; url: string; largura?: number; altura?: number };
type Card = { id: string; texto: string; midias: Midia[] };
type Arquivo = { anuncioId: string; tipo: 'imagem' | 'video'; nome: string; bytes: number; sha256: string; largura?: number; altura?: number };
const cards = new Map<string, Card>();
try {
  const page = await browser.newPage({ locale: 'pt-BR' });
  await page.goto(urlAnuncio, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForFunction((id) => (document.body?.innerText ?? '').includes(`Identificação da biblioteca: ${id}`), adId, { timeout: 30_000 });
  for (let rodada = 0; rodada < 5; rodada++) {
    const encontrados = await page.evaluate((): Card[] => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const out: Card[] = [];
      let node: Node | null;
      while ((node = walker.nextNode())) {
        const m = /^Identificação da biblioteca:\s*(\d{10,20})$/.exec(node.textContent?.trim() ?? '');
        if (!m) continue;
        let card = node.parentElement;
        while (card && (!card.innerText.includes('Patrocinado') || card.querySelectorAll('img,video').length === 0)) card = card.parentElement;
        if (!card) continue;
        const texto = card.innerText;
        if ((texto.match(/Identificação da biblioteca:/g) ?? []).length !== 1) continue;
        const imagens: Midia[] = [...card.querySelectorAll('img')]
          .filter((img) => img.naturalWidth >= 300 && img.naturalHeight >= 250)
          .map((img) => ({ tipo: 'imagem', url: img.currentSrc || img.src, largura: img.naturalWidth, altura: img.naturalHeight }));
        const videos: Midia[] = [...card.querySelectorAll('video')]
          .filter((video) => Boolean(video.currentSrc || video.src))
          .map((video) => ({ tipo: 'video', url: video.currentSrc || video.src }));
        out.push({ id: m[1]!, texto: texto.slice(0, 5000), midias: [...imagens, ...videos] });
      }
      return out;
    });
    for (const card of encontrados) if (!cards.has(card.id)) cards.set(card.id, card);
    await page.mouse.wheel(0, 5000);
    await page.waitForTimeout(1200);
  }

  const alvo = cards.get(adId);
  if (!alvo) throw new Error(`anúncio ${adId} não apareceu na página`);
  const candidatos = [alvo, ...[...cards.values()].filter((c) => c.id !== adId && hostOferta && c.texto.toLowerCase().includes(hostOferta))].slice(0, 20);
  await mkdir(destino, { recursive: true });
  const arquivos: Arquivo[] = [];
  const falhas: { anuncioId: string; tipo: string; motivo: string }[] = [];
  const hashes = new Set<string>();
  for (const card of candidatos) {
    for (const [index, midia] of card.midias.entries()) {
      try {
        const host = new URL(midia.url).hostname;
        if (!/^https:\/\//.test(midia.url) || !/(^|\.)fbcdn\.net$/.test(host)) throw new Error('URL fora da CDN da Meta');
        const resposta = await page.request.get(midia.url, { maxRedirects: 0, timeout: 20_000 });
        if (!resposta.ok()) throw new Error(`HTTP ${resposta.status()}`);
        const tipo = resposta.headers()['content-type'] ?? '';
        if (!tipo.startsWith(midia.tipo === 'imagem' ? 'image/' : 'video/')) throw new Error(`MIME inesperado: ${tipo}`);
        const conteudo = await resposta.body();
        const maximo = midia.tipo === 'imagem' ? 10_000_000 : 40_000_000;
        if (conteudo.length === 0 || conteudo.length > maximo) throw new Error('arquivo vazio ou grande demais');
        const sha256 = createHash('sha256').update(conteudo).digest('hex');
        if (hashes.has(sha256)) continue;
        hashes.add(sha256);
        const extensao = midia.tipo === 'video' ? '.mp4' : tipo.includes('png') ? '.png' : tipo.includes('webp') ? '.webp' : '.jpg';
        const nome = `${card.id}-${midia.tipo}-${index + 1}${extensao}`;
        await writeFile(resolve(destino, nome), conteudo);
        arquivos.push({ anuncioId: card.id, tipo: midia.tipo, nome, bytes: conteudo.length, sha256, largura: midia.largura, altura: midia.altura });
      } catch (err) { falhas.push({ anuncioId: card.id, tipo: midia.tipo, motivo: (err as Error).message }); }
    }
  }
  const manifesto = {
    origem: urlAnuncio,
    hostOferta: hostOferta || null,
    capturadoEm: new Date().toISOString(),
    anunciosEncontrados: cards.size,
    anunciosDaOferta: candidatos.map((c) => c.id),
    arquivos,
    falhas,
    uso: 'Referência de análise. Criar peças novas; não publicar nem reutilizar os bytes capturados.',
  };
  await writeFile(resolve(destino, 'manifesto.json'), JSON.stringify(manifesto, null, 2), 'utf8');
  console.log(JSON.stringify({ pasta: destino, anunciosDaOferta: candidatos.length, arquivos: arquivos.length, imagens: arquivos.filter((a) => a.tipo === 'imagem').length, videos: arquivos.filter((a) => a.tipo === 'video').length, falhas: falhas.length }));
} finally { await browser.close(); }
