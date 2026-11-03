// Teste do Kokoro em PT-BR só com Node: kokoro-js + phonemizer (espeak-ng em WASM) em 'pt-br'.
// O kokoro-js só faz inglês; aqui a fonetização em português é feita fora e entra por generate_from_ids.
// Roda: node node-pt.mjs [q8|fp32]   →  gera out/node-<dtype>-<voz>-<n>.wav e imprime tempos.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { env, StyleTextToSpeech2Model, AutoTokenizer, Tensor, RawAudio } from '@huggingface/transformers';
import { phonemize } from 'phonemizer';
import { FRASES, VOZES, MODEL_ID, CACHE } from './frases.mjs';

const dtype = process.argv[2] ?? 'q8';
env.cacheDir = path.join(CACHE, 'hf');
await mkdir('out', { recursive: true });

/** Mesmas trocas que o kokoro-js e o misaki fazem depois do espeak. */
function ajustarFonemas(ps) {
  return ps.replace(/ʲ/g, 'j').replace(/r/g, 'ɹ').replace(/x/g, 'k').replace(/ɬ/g, 'l').trim();
}

async function voz(nome) {
  const arq = path.join(CACHE, 'voices', `${nome}.bin`);
  try {
    return new Float32Array((await readFile(arq)).buffer.slice(0));
  } catch {
    const url = `https://huggingface.co/${MODEL_ID}/resolve/main/voices/${nome}.bin`;
    const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
    await mkdir(path.dirname(arq), { recursive: true });
    await writeFile(arq, buf);
    return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  }
}

let t = performance.now();
const [model, tokenizer] = await Promise.all([
  StyleTextToSpeech2Model.from_pretrained(MODEL_ID, { dtype, device: 'cpu' }),
  AutoTokenizer.from_pretrained(MODEL_ID),
]);
console.log(`modelo ${dtype} carregado em ${((performance.now() - t) / 1000).toFixed(1)}s`);

for (const nomeVoz of VOZES) {
  const estilo = await voz(nomeVoz);
  for (const [i, frase] of FRASES.entries()) {
    t = performance.now();
    const fonemas = ajustarFonemas((await phonemize(frase, 'pt-br')).join(' '));
    const { input_ids } = tokenizer(fonemas, { truncation: true });
    const n = Math.min(Math.max(input_ids.dims.at(-1) - 2, 0), 509);
    const style = new Tensor('float32', estilo.slice(256 * n, 256 * n + 256), [1, 256]);
    const { waveform } = await model({ input_ids, style, speed: new Tensor('float32', [1], [1]) });
    const audio = new RawAudio(waveform.data, 24000);
    const ms = performance.now() - t;
    const seg = waveform.data.length / 24000;
    await audio.save(`out/node-${dtype}-${nomeVoz}-${i + 1}.wav`);
    console.log(`${nomeVoz} #${i + 1}: ${(ms / 1000).toFixed(2)}s para ${seg.toFixed(1)}s de áudio (RTF ${(ms / 1000 / seg).toFixed(2)})`);
    if (nomeVoz === VOZES[0]) console.log(`   fonemas: ${fonemas}`);
  }
}
