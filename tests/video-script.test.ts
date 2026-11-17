import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import type { AdvisorResult } from '../src/advisor/deepseek-client.ts';
import { MemoryAdvisorJournal } from '../src/advisor/journal.ts';
import type { AdvisorInput, Opinion, Recomendacao } from '../src/advisor/opinion.ts';
import { AdvisorService } from '../src/advisor/service.ts';
import type { OpinionAdvisor } from '../src/advisor/service.ts';
import { buildBrief, type VideoBrief } from '../src/video/brief.ts';
import { FlowFolderProvider, writePromptSheet } from '../src/video/flow-folder.ts';
import { MANIFEST_VERSION, validateManifest, type Scene } from '../src/video/manifest.ts';
import {
  generateManifest,
  type ScriptGenerator,
  type ScriptMessage,
} from '../src/video/script.ts';

/** Shorts de 60 s: 3 cenas de 20 s ficam dentro da meta. */
const brief: VideoBrief = buildBrief({
  tema: 'Como funciona o Pix',
  publico: 'adultos curiosos',
  plataforma: 'shorts',
  duracaoAlvoSeg: 60,
  estilo: 'documental',
  objetivo: 'explicar em um minuto',
});

/** O que o modelo devolveria: manifesto válido, mas com jobId/brief próprios. */
function manifestoBruto(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: MANIFEST_VERSION,
    jobId: 'do-modelo',
    brief,
    titulo: 'Pix em um minuto',
    fontes: [
      {
        id: 'bcb',
        url: 'https://www.bcb.gov.br/pix',
        titulo: 'Banco Central — Pix',
        acessadoEm: '2026-11-17',
      },
    ],
    cenas: [1, 2, 3].map((n) => ({
      n,
      narracao: `Narração da cena ${n}`,
      duracaoEstimadaSeg: 20,
      afirmacoes: [{ texto: `Afirmação ${n}`, fonte: 'bcb', duvida: false }],
      visual: `Visual da cena ${n}`,
      promptImagem: `illustration ${n}, same palette`,
      papelImagem: 'ilustracao',
      realistaGeradaPorIA: false,
      assetRef: null,
    })),
    ...extra,
  };
}

/** Gerador falso: devolve as respostas na ordem e guarda uma cópia das mensagens. */
function geradorQue(...respostas: string[]): { generator: ScriptGenerator; calls: ScriptMessage[][] } {
  const calls: ScriptMessage[][] = [];
  const generator: ScriptGenerator = async (messages) => {
    // Cópia: a correção é acrescentada ao mesmo array entre as tentativas.
    calls.push([...messages]);
    return respostas[Math.min(calls.length - 1, respostas.length - 1)] ?? '';
  };
  return { generator, calls };
}

function parecerFalso(recomendacao: Recomendacao): Opinion {
  return {
    version: 'parecer/1',
    jobId: 'video-1',
    fase: 'roteiro',
    recomendacao,
    motivos: ['fonte fraca na cena 1'],
    evidencias: [],
    contrapontos: [],
    lacunas: [],
    proximoTeste: 'confirmar a fonte',
    confianca: 'alta',
  };
}

/** Conselheiro falso: guarda a entrada e responde com um parecer fixo. */
class FakeAdvisor implements OpinionAdvisor {
  readonly model = 'fake-flash';
  readonly calls: AdvisorInput[] = [];
  constructor(private readonly opinion: Opinion | null) {}

  async ask(input: AdvisorInput): Promise<AdvisorResult> {
    this.calls.push(input);
    if (this.opinion === null) {
      return {
        ok: false,
        state: 'parecer_indisponivel',
        reason: 'timeout',
        detail: 'sem parecer no teste',
        model: this.model,
        ms: 1,
      };
    }
    return {
      ok: true,
      opinion: { ...this.opinion, jobId: input.jobId, fase: input.fase },
      model: this.model,
      ms: 1,
      usage: { promptTokens: 1, completionTokens: 1 },
    };
  }
}

const cena = (n: number): Scene => ({ n } as Scene);

describe('geração do roteiro (V02)', () => {
  test('manifesto válido de primeira: prompt pede o JSON do manifesto e resultado traz avisos', async () => {
    const { generator, calls } = geradorQue(JSON.stringify(manifestoBruto()));
    const resultado = await generateManifest({ generator }, { jobId: 'video-1', brief });

    assert.equal(resultado.status, 'ok');
    if (resultado.status !== 'ok') return;
    assert.equal(resultado.manifest.jobId, 'video-1');
    assert.equal(resultado.manifest.cenas.length, 3);
    assert.equal(resultado.manifest.titulo, 'Pix em um minuto');
    assert.deepEqual(resultado.avisos, []);
    assert.equal(resultado.parecer, undefined, 'sem conselheiro não há parecer');

    assert.equal(calls.length, 1);
    const system = calls[0]![0]!.content;
    const user = calls[0]![1]!.content;
    assert.match(system, /cenas\/1/);
    assert.match(system, /palavras\/s/);
    assert.match(system, /ilustracao/);
    assert.match(system, /renda, lucro/);
    assert.match(system, /promptImagem em inglês/);
    assert.match(user, /Como funciona o Pix/);
    assert.match(user, /duração alvo: 60 s/);
  });

  test('inválido e depois válido: os erros voltam ao gerador e a segunda tentativa é aceita', async () => {
    const { generator, calls } = geradorQue(
      'isso não é json',
      JSON.stringify(manifestoBruto()),
    );
    const resultado = await generateManifest({ generator }, { jobId: 'video-1', brief });

    assert.equal(resultado.status, 'ok');
    assert.equal(calls.length, 2);
    assert.equal(calls[1]!.length, 3, 'a correção entra como terceira mensagem');
    assert.match(calls[1]![2]!.content, /recusado pela validação/);
    assert.match(calls[1]![2]!.content, /manifesto: não é um objeto JSON válido/);
  });

  test('duas inválidas: devolve status invalido com os erros da última tentativa', async () => {
    const { generator, calls } = geradorQue(
      JSON.stringify({ version: 'errado' }),
      JSON.stringify({ version: 'errado' }),
    );
    const resultado = await generateManifest({ generator }, { jobId: 'video-1', brief });

    assert.equal(resultado.status, 'invalido');
    if (resultado.status !== 'invalido') return;
    assert.equal(calls.length, 2);
    assert.ok(resultado.errors.some((erro) => erro.campo === 'version'));
    assert.ok(resultado.errors.some((erro) => erro.campo === 'cenas'));
  });

  test('jobId e brief do modelo são sobrescritos pelos do pedido', async () => {
    const bruto = manifestoBruto({
      jobId: 'outro-trabalho',
      brief: buildBrief({ tema: 'Tema do modelo', plataforma: 'youtube' }),
    });
    const { generator } = geradorQue(JSON.stringify(bruto));
    const resultado = await generateManifest({ generator }, { jobId: 'video-1', brief });

    assert.equal(resultado.status, 'ok');
    if (resultado.status !== 'ok') return;
    assert.equal(resultado.manifest.jobId, 'video-1');
    assert.equal(resultado.manifest.brief.tema, 'Como funciona o Pix');
    assert.equal(resultado.manifest.brief.plataforma, 'shorts');
  });

  test('avisos do validador são repassados no resultado', async () => {
    const bruto = manifestoBruto();
    const cenas = bruto.cenas as Array<Record<string, unknown>>;
    const afirmacoes = cenas[1]!.afirmacoes as Array<Record<string, unknown>>;
    afirmacoes[0]!.fonte = null;
    const { generator } = geradorQue(JSON.stringify(bruto));

    const resultado = await generateManifest({ generator }, { jobId: 'video-1', brief });
    assert.equal(resultado.status, 'ok');
    if (resultado.status !== 'ok') return;
    assert.ok(
      resultado.avisos.some((aviso) => /cena 2: afirmação sem fonte e sem dúvida/.test(aviso)),
      `avisos: ${resultado.avisos.join(' | ')}`,
    );
  });

  test('parecer do conselheiro é registrado com cenas internas e fontes externas', async () => {
    const fake = new FakeAdvisor(parecerFalso('parar'));
    const journal = new MemoryAdvisorJournal();
    const service = new AdvisorService(fake, journal);
    const { generator } = geradorQue(JSON.stringify(manifestoBruto()));

    const resultado = await generateManifest(
      { generator, advisor: service },
      { jobId: 'video-1', brief },
    );

    // 'parar' não invalida o roteiro: quem bloqueia é a etapa antes do render.
    assert.equal(resultado.status, 'ok');
    if (resultado.status !== 'ok') return;
    const parecer = resultado.parecer;
    if (parecer === undefined) throw new Error('faltou o parecer no resultado');
    if (parecer.status !== 'ok' && parecer.status !== 'cache') {
      throw new Error(`esperava parecer ok/cache, recebi ${parecer.status}`);
    }
    assert.equal(parecer.opinion.recomendacao, 'parar');

    assert.equal(fake.calls.length, 1);
    const input = fake.calls[0]!;
    assert.equal(input.jobId, 'video-1');
    assert.equal(input.dominio, 'video');
    assert.equal(input.fase, 'roteiro');
    assert.equal(input.objetivo, brief.tema);

    const fonte = input.evidencias.find((ev) => ev.ref === 'bcb');
    assert.ok(fonte, 'faltou a fonte do roteiro');
    assert.equal(fonte.externa, true);
    assert.match(fonte.conteudo, /https:\/\/www\.bcb\.gov\.br\/pix/);

    const cena1 = input.evidencias.find((ev) => ev.ref === 'cena-1');
    assert.ok(cena1, 'faltou a cena 1');
    assert.equal(cena1.externa, false);
    assert.match(cena1.conteudo, /Narração da cena 1/);
    assert.match(cena1.conteudo, /afirmação "Afirmação 1"/);

    assert.equal((await journal.list('video-1')).length, 1, 'o parecer fica no diário');
  });
});

describe('folha de prompts do Flow (V03)', () => {
  let root = '';

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'night-flow-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test('acha cena-1.png e cena-02.jpg e ignora outros nomes', async () => {
    const provider = new FlowFolderProvider({ root });
    const pasta = join(root, 'video-flow');
    await mkdir(pasta, { recursive: true });
    await writeFile(join(pasta, 'cena-1.png'), 'png 1', 'utf8');
    await writeFile(join(pasta, 'cena-02.jpg'), 'jpg 2', 'utf8');
    await writeFile(join(pasta, 'cena-04.webp'), 'webp 4', 'utf8');
    await writeFile(join(pasta, 'capa.png'), 'capa', 'utf8');
    await writeFile(join(pasta, 'cena-3.gif'), 'gif', 'utf8');

    assert.equal(provider.origin, 'flow');
    assert.equal(await provider.find('video-flow', cena(1)), join(pasta, 'cena-1.png'));
    assert.equal(await provider.find('video-flow', cena(2)), join(pasta, 'cena-02.jpg'));
    assert.equal(await provider.find('video-flow', cena(3)), null, 'gif não é aceito');
    assert.equal(await provider.find('video-flow', cena(4)), join(pasta, 'cena-04.webp'));
  });

  test('aceita a subpasta do número do vídeo e a do jobId', async () => {
    const porNumero = join(root, '12');
    await mkdir(porNumero, { recursive: true });
    await writeFile(join(porNumero, 'cena-1.png'), '1', 'utf8');

    const porJob = join(root, 'video-12');
    await mkdir(porJob, { recursive: true });
    await writeFile(join(porJob, 'cena-2.jpg'), '2', 'utf8');

    const comNumero = new FlowFolderProvider({ root, numeroDoVideo: 12 });
    assert.equal(await comNumero.find('video-12', cena(1)), join(porNumero, 'cena-1.png'));
    // A cena que falta no número é buscada na pasta do jobId.
    assert.equal(await comNumero.find('video-12', cena(2)), join(porJob, 'cena-2.jpg'));

    const soJob = new FlowFolderProvider({ root });
    assert.equal(await soJob.find('video-12', cena(2)), join(porJob, 'cena-2.jpg'));
  });

  test('folha de prompts: uma linha por cena e instruções curtas', async () => {
    const validado = validateManifest(manifestoBruto({ jobId: 'video-12' }));
    if (!validado.ok) throw new Error('manifesto de teste inválido: ' + JSON.stringify(validado.errors));

    const dir = join(root, '12');
    const arquivo = await writePromptSheet(validado.manifest, dir);
    assert.equal(arquivo, join(dir, 'prompts-flow.txt'));

    const texto = await readFile(arquivo, 'utf8');
    assert.match(texto, /^cena-1: illustration 1, same palette$/m);
    assert.match(texto, /^cena-2: illustration 2, same palette$/m);
    assert.match(texto, /^cena-3: illustration 3, same palette$/m);
    assert.match(texto, /Gere cada imagem no Flow/);
    assert.match(texto, /cena-N\.png/);
    assert.match(texto, /continua o vídeo 12/);

    // O provider também grava a folha, na pasta do job.
    const provider = new FlowFolderProvider({ root });
    const viaProvider = await provider.writePromptSheet('video-12', validado.manifest);
    assert.equal(viaProvider, join(root, 'video-12', 'prompts-flow.txt'));
  });
});
