// Prova da voz ao vivo sem navegador: manda uma oferta WebRTC montada à mão e confere se o Codex (login do
// ChatGPT) abre a voz da OpenAI e devolve a resposta. Não passa áudio. Uso: pnpm tsx scripts/voz-ao-vivo-prova.ts
import { randomBytes } from 'node:crypto';
import { findCodexLiveBin, VozAoVivo } from '../src/app/voz-ao-vivo.ts';

const fp = Array.from(randomBytes(32), (b) => b.toString(16).padStart(2, '0').toUpperCase()).join(':');
const oferta = [
  'v=0', `o=- ${Date.now()} 2 IN IP4 127.0.0.1`, 's=-', 't=0 0', 'a=group:BUNDLE 0 1', 'a=extmap-allow-mixed', 'a=msid-semantic: WMS',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111', 'c=IN IP4 0.0.0.0', 'a=rtcp:9 IN IP4 0.0.0.0',
  `a=ice-ufrag:${randomBytes(3).toString('hex')}`, `a=ice-pwd:${randomBytes(12).toString('hex')}`, 'a=ice-options:trickle',
  `a=fingerprint:sha-256 ${fp}`, 'a=setup:actpass', 'a=mid:0', 'a=sendrecv', 'a=rtcp-mux',
  'a=rtpmap:111 opus/48000/2', 'a=fmtp:111 minptime=10;useinbandfec=1',
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'c=IN IP4 0.0.0.0',
  `a=ice-ufrag:${randomBytes(3).toString('hex')}`, `a=ice-pwd:${randomBytes(12).toString('hex')}`, 'a=ice-options:trickle',
  `a=fingerprint:sha-256 ${fp}`, 'a=setup:actpass', 'a=mid:1', 'a=sctp-port:5000', 'a=max-message-size:262144', '',
].join('\r\n');

console.log('Codex:', findCodexLiveBin());
const voz = new VozAoVivo({ pedir: async (t) => ({ texto: `eco: ${t}` }) });
const t0 = Date.now();
try {
  const r = await voz.iniciar(oferta);
  console.log(`OK em ${Date.now() - t0} ms: a OpenAI respondeu a oferta (${r.sdp.length} caracteres, começa com ${JSON.stringify(r.sdp.slice(0, 12))})`);
  await voz.parar(r.sessionId);
} catch (err) {
  console.log(`FALHOU em ${Date.now() - t0} ms: ${(err as Error).message}`);
}
console.log('eventos:', JSON.stringify(voz.eventosDesde(0)));
