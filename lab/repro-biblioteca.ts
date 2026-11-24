// Teste 21/11: uma busca do Radar pela página da Biblioteca (navegador sem login), fora do servidor.
// Uso: node --import tsx lab/repro-biblioteca.ts "por R$ 19,90"
import { BrowserAdLibrarySource } from '../src/radar/browser-source.ts';
import { scoreCandidate } from '../src/radar/score.ts';

const fonte = new BrowserAdLibrarySource();
for (const termo of process.argv.slice(2)) {
  const t0 = Date.now();
  try {
    const r = await fonte.nicheScan(termo);
    console.log(`\n=== ${termo} (${Math.round((Date.now() - t0) / 1000)} s, total ${r.estimatedTotal}, anunciantes ${r.anunciantesNoNicho})`);
    for (const o of r.observacoes) console.log('  aviso:', o);
    for (const a of r.ads) {
      const s = scoreCandidate({ anunciosAtivos: a.activeAdsInDomain ?? null, diasNoAr: (a.diasNoAr as number) ?? null,
        anunciantesNoNicho: a.anunciantesNoNicho as number, precoOrigem: (a.precoOrigem as number) ?? null,
        entregavelEmPdf: a.entregavelEmPdf as boolean | null });
      console.log(`  - ${a.advertiser} | ${a.landingUrl ?? '-'} | nota ${s.justificativa}`);
      console.log(`    ${String(a.anuncioTexto).slice(0, 200).replace(/\n/g, ' ')}`);
    }
  } catch (err) { console.log(`\n=== ${termo}: ERRO ${(err as Error).message}`); }
}
