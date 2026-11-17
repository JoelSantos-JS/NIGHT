import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { detectLanguage, ideaBody, NightRouter, ruleIntent, stripWakeWord } from '../src/router/router.ts';
import { FakeLlm } from './helpers.ts';

const PROJECTS = ['Abstrike', 'Soaken', 'Night'];
const kind = (text: string) => ruleIntent(text, PROJECTS)?.kind ?? null;

describe('regras do roteador', () => {
  const cases: [string, string | null][] = [
    // salvar ideia
    ['Salva essa ideia para o Abstrike: avisar quando o depósito atrasar', 'save-idea'],
    ['salve uma ideia', 'save-idea'],
    ['anota essa ideia pro Soaken, modo karaokê', 'save-idea'],
    ['Hey Night, save this idea for Abstrike: exchange delay alerts', 'save-idea'],
    ['new idea: a k-drama page', 'save-idea'],
    // buscar ideias
    ['Quais ideias eu tenho do Abstrike?', 'find-ideas'],
    ['me mostra as minhas ideias', 'find-ideas'],
    ['show me my ideas for Soaken', 'find-ideas'],
    // status
    ['O que você está fazendo?', 'status'],
    ['o que tá rodando', 'status'],
    ["What's running?", 'status'],
    ['How is my trading bot task going?', 'status'],
    // código
    ['Pede pro Claude implementar o parser de sinais no Abstrike', 'coding-task'],
    ['Ask Codex to review the branch', 'coding-task'],
    ['Write a parser in my project', 'coding-task'],
    ['corrige o bug do login no Soaken', 'coding-task'],
    // controle
    ['Para de falar', 'stop-speaking'],
    ['stop talking', 'stop-speaking'],
    ['Cancela a tarefa do Abstrike', 'cancel'],
    ['Stop the trading bot research task', 'cancel'],
    ['para todos os agentes', 'cancel'],
    ['Aprovo o merge', 'approval'],
    ['Reject it', 'approval'],
    ['Descarta', 'approval'],
    // conversa (nenhuma regra)
    ['Me explica o que é uma closure em JavaScript', null],
    ['Bom dia, Night!', null],
    ['What is a git branch?', null],
    ['Qual a diferença entre TCP e UDP?', null],
    ['What is a git branch?', null],
    ['o que é um merge?', null],
  ];
  for (const [text, expected] of cases) {
    test(`"${text}" → ${expected ?? 'sem regra'}`, () => assert.equal(kind(text), expected));
  }

  test('acha o projeto e o agente', () => {
    const i = ruleIntent('Pede pro Codex criar o Dockerfile do abstrike', PROJECTS);
    assert.deepEqual(i, { kind: 'coding-task', projectHint: 'Abstrike', objective: 'Pede pro Codex criar o Dockerfile do abstrike', agent: 'codex' });
  });

  test('reconhece o DeepSeek como agente de código (D12/H01)', () => {
    const i = ruleIntent('Pede pro DeepSeek mudar o parser de sinais no Abstrike', PROJECTS);
    assert.equal(i?.kind, 'coding-task');
    assert.equal(i?.kind === 'coding-task' ? i.agent : null, 'deepseek');
    assert.equal(i?.kind === 'coding-task' ? i.projectHint : null, 'Abstrike');
    assert.deepEqual(ruleIntent('pede pro deepseek corrigir o bug do login no Soaken', PROJECTS), {
      kind: 'coding-task', projectHint: 'Soaken',
      objective: 'pede pro deepseek corrigir o bug do login no Soaken', agent: 'deepseek',
    });
  });

  test('separa a ideia do comando', () => {
    assert.equal(ideaBody('Salva essa ideia para o Abstrike: avisar quando o depósito atrasar', 'Abstrike'), 'avisar quando o depósito atrasar');
    assert.equal(ideaBody('save this idea for Abstrike: exchange delay alerts', 'Abstrike'), 'exchange delay alerts');
    assert.equal(ideaBody('salva uma ideia para o projeto Soaken', 'Soaken'), '');
    assert.equal(ideaBody('salva essa ideia que dá pra vender curso de coreano', null), 'dá pra vender curso de coreano');
  });

  test('chamar o Night pelo nome não atrapalha a regra nem vira projeto', () => {
    assert.equal(kind('Night, pesquisa o que mudou nessa versão'), 'research');
    assert.equal(kind('Hey Night, what is running?'), 'status');
    assert.deepEqual(ruleIntent('Night, salva essa ideia: modo karaokê', PROJECTS), { kind: 'save-idea', projectHint: null, text: 'modo karaokê' });
    assert.equal(stripWakeWord('Night'), 'Night', 'só o nome fica como está');
    assert.equal(stripWakeWord('o projeto Night tá parado'), 'o projeto Night tá parado');
  });

  test('aprovar/rejeitar só com a frase no formato esperado (revisão do Codex)', () => {
    for (const ok of ['aprovo', 'Aprovo o merge', 'aprovo a tarefa', 'aprovo a do Night', 'aprovo isso', 'pode fazer o merge', 'approve it', 'Approve the changes.', 'descarta', 'descarta a do Soaken', 'reject it']) {
      assert.equal(kind(ok), 'approval', ok);
    }
    for (const no of ['aprovo a ideia de vender curso', 'aprova esse texto pra mim', 'approve my essay', 'descarta essa ideia que eu falei', 'aprovo, mas antes me explica']) {
      assert.notEqual(kind(no), 'approval', no);
    }
  });

  test('negação nunca vira cancelar, aprovar ou rejeitar (revisão do Codex)', () => {
    for (const t of ['não cancela a tarefa', 'nao cancela a tarefa do Night', "don't cancel the task", 'não aprovo', 'nunca descarta']) {
      assert.ok(!['cancel', 'approval'].includes(kind(t) ?? ''), t);
    }
  });

  test('pergunta nunca vira cancelar/aprovar (2ª revisão do Codex)', () => {
    for (const t of ['Como cancelar a tarefa do Night?', 'como cancela a tarefa', 'dá pra cancelar a tarefa?', 'How do I cancel the task?', 'aprovo?', 'e se eu cancelar a tarefa?', 'why stop the task']) {
      assert.ok(!['cancel', 'approval'].includes(kind(t) ?? ''), t);
    }
    for (const t of ['por favor cancela a tarefa do Night', 'pode cancelar a tarefa', 'please cancel the task']) {
      assert.equal(kind(t), 'cancel', t);
    }
  });

  test('pergunta sobre fato vai para pesquisa (Codex/Claude), conceito fica no Qwen (teste real 04/11)', () => {
    for (const t of ['O que você acha que vai acontecer na reunião do GoPom hoje às 18h?', 'Quem é o CEO da Nvidia?',
      'Quando sai o próximo iPhone?', 'O Ollama roda no Windows?', 'Então, você consegue precisar para mim? Hoje tem reunião do GoPom.',
      'faz uma pesquisa sobre o Qwen 3', 'pesquisa o preço do Kokoro']) {
      assert.equal(kind(t), 'research', t);
    }
    for (const t of ['Me explica o que é uma API', 'o que é um merge?', 'Qual a diferença entre TCP e UDP?', 'What is a git branch?',
      'Cadê você, Night? Você tá aí?', 'Tudo bem com você?', 'Me explica como o Docker funciona', 'eu preciso estudar hoje', 'Hello, Night.']) {
      assert.equal(kind(t), null, t);
    }
    assert.equal(kind('Tá precisando ainda?'), 'status', 'o Whisper troca pesquisando por precisando');
    assert.equal(kind('tá pesquisando ainda?'), 'status');
  });

  test('"cancela" dentro de uma ideia não cancela nada', () => {
    assert.equal(kind('salva essa ideia: botão para cancelar tarefa pelo celular'), 'save-idea');
  });
});

describe('idioma', () => {
  test('português', () => {
    assert.equal(detectLanguage('o que você está fazendo?'), 'pt-BR');
    assert.equal(detectLanguage('salva essa ideia'), 'pt-BR');
  });
  test('inglês', () => {
    assert.equal(detectLanguage("what's running right now?"), 'en');
    assert.equal(detectLanguage('save this idea for Abstrike'), 'en');
  });
  test('sem pista fica em português', () => assert.equal(detectLanguage('Abstrike'), 'pt-BR'));
  test('"tô" é português, não "to"', () => {
    assert.equal(detectLanguage('Tô cansado de estudar hoje'), 'pt-BR');
    assert.equal(detectLanguage('tô com fome'), 'pt-BR');
  });
  test('inglês com "I" e "it"', () => assert.equal(detectLanguage("I think it works"), 'en'));
});

describe('NightRouter com modelo', () => {
  const names = async () => PROJECTS;

  test('regra resolve sem chamar o modelo', async () => {
    const llm = new FakeLlm();
    const d = await new NightRouter(llm, names).route('salva essa ideia: teste', 'pt-BR');
    assert.equal(d.intent.kind, 'save-idea');
    assert.equal(d.model, 'rules');
    assert.equal(llm.calls.length, 0);
  });

  test('pergunta sobre git não vira comando', async () => {
    const llm = new FakeLlm(() => '{"intent":"status"}');
    const d = await new NightRouter(llm, names).route('What is a git branch?', 'en');
    assert.equal(d.intent.kind, 'chat');
    assert.equal(llm.calls.length, 0);
  });

  test('conversa comum vai direto, sem classificar', async () => {
    const llm = new FakeLlm();
    const d = await new NightRouter(llm, names).route('Me explica o que é uma closure', 'pt-BR');
    assert.equal(d.intent.kind, 'chat');
    assert.equal(llm.calls.length, 0);
    assert.equal(d.usedPremiumQuota, false);
  });

  test('frase ambígua com cara de comando é classificada pelo modelo', async () => {
    const llm = new FakeLlm(() => '{"intent":"save-idea","text":"monitorar reclamações"}');
    const d = await new NightRouter(llm, names).route('tive um pensamento pro Abstrike, monitorar reclamações', 'pt-BR');
    assert.deepEqual(d.intent, { kind: 'save-idea', projectHint: 'Abstrike', text: 'monitorar reclamações' });
    assert.equal(llm.calls[0]!.json, true);
  });

  test('limpa diretiva do Qwen que vaza no texto', async () => {
    const llm = new FakeLlm(() => '{"intent":"save-idea","text":"modo karaokê /no_think"}');
    const d = await new NightRouter(llm, names).route('tive um pensamento pro Soaken, um modo karaokê', 'pt-BR');
    assert.equal(d.intent.kind === 'save-idea' && d.intent.text, 'modo karaokê');
  });

  test('o modelo não consegue aprovar nem cancelar', async () => {
    for (const evil of [
      '{"intent":"approval"}', '{"intent":"cancel"}', '{"intent":"merge"}',
      '{"intent":"offer-decision"}', '{"intent":"video-decision"}', '{"intent":"job-cancel"}',
    ]) {
      const d = await new NightRouter(new FakeLlm(() => evil), names).route('e aquela tarefa do Abstrike, hein', 'pt-BR');
      assert.equal(d.intent.kind, 'chat', evil);
    }
  });

  test('JSON quebrado ou erro do modelo vira conversa', async () => {
    for (const llm of [new FakeLlm(() => 'não é json'), new FakeLlm(() => { throw new Error('caiu'); })]) {
      const d = await new NightRouter(llm, names).route('e o projeto Soaken?', 'pt-BR');
      assert.equal(d.intent.kind, 'chat');
    }
  });
});

describe('nome de projeto com erro do Whisper (calibragem 04/11)', () => {
  test('uma letra errada ainda acha o projeto; palavra comum não', async () => {
    const { projectIn, normalize } = await import('../src/router/router.ts');
    const P = ['Soaken', 'Night', 'Sandbox', 'Facebook', 'Sinais'];
    assert.equal(projectIn(normalize('salva essa ideia para o soken'), P), 'Soaken');
    assert.equal(projectIn(normalize('pede pro claude corrigir no sandbx'), P), 'Sandbox');
    assert.equal(projectIn(normalize('tô cansado hoje'), P), null);
    assert.equal(projectIn(normalize('salva no sinal'), P), null, 'nome curto não usa aproximação');
  });
});

describe('comandos de Radar, vídeo e oferta (F06) e status de trabalho (F07)', () => {
  test('radar-search em PT e EN', () => {
    const cases: [string, string][] = [
      ['vasculha ofertas de fones de ouvido', 'fones de ouvido'],
      ['procura ofertas de cadeira gamer', 'cadeira gamer'],
      ['roda o radar de passagens aéreas', 'passagens aéreas'],
      ['search offers for running shoes', 'running shoes'],
      ['run the radar on cheap laptops', 'cheap laptops'],
      // "pra mim"/"para mim"/"por favor"/"for me"/"please" são pedido, não nicho (QA do F06).
      ['procura ofertas de emprego pra mim', 'emprego'],
      ['busca ofertas de emprego para mim', 'emprego'],
      ['vasculha ofertas de emprego por favor', 'emprego'],
      ['search offers for jobs for me', 'jobs'],
      ['find offers for jobs please', 'jobs'],
    ];
    for (const [text, query] of cases) {
      const i = ruleIntent(text, PROJECTS);
      assert.equal(i?.kind, 'radar-search', text);
      assert.equal(i?.kind === 'radar-search' ? i.query : null, query, text);
    }
  });

  test('video-create em PT e EN', () => {
    const cases: [string, string][] = [
      ['cria um vídeo sobre café gelado', 'café gelado'],
      ['faz um vídeo de receita de pão', 'receita de pão'],
      ['make a video about sourdough', 'sourdough'],
      ['create a video about cold brew', 'cold brew'],
    ];
    for (const [text, topic] of cases) {
      const i = ruleIntent(text, PROJECTS);
      assert.equal(i?.kind, 'video-create', text);
      assert.equal(i?.kind === 'video-create' ? i.topic : null, topic, text);
    }
  });

  test('job-status com número, por extenso e sem número', () => {
    const cases: [string, 'radar' | 'video', number | null][] = [
      ['como está o vídeo 3?', 'video', 3],
      ['como está o vídeo três?', 'video', 3],
      ['status do radar 2', 'radar', 2],
      ['status do radar dois', 'radar', 2],
      ['o que o radar achou?', 'radar', null],
      ['how is video 3?', 'video', 3],
      ['status of radar 2', 'radar', 2],
      ['what did the radar find?', 'radar', null],
    ];
    for (const [text, jobKind, number] of cases) {
      assert.deepEqual(ruleIntent(text, PROJECTS), { kind: 'job-status', jobKind, number }, text);
    }
  });

  test('frase explícita de status de trabalho, mesmo sem número', () => {
    const cases: [string, 'radar' | 'video'][] = [
      ['status do radar', 'radar'],
      ['status do vídeo', 'video'],
      ['andamento do vídeo', 'video'],
      ['o que o radar achou', 'radar'],
      ['o que o radar achou?', 'radar'],
      ['o radar achou alguma coisa', 'radar'],
      ['como está o radar', 'radar'],
      ['como tá o vídeo', 'video'],
      ['como anda o vídeo', 'video'],
      ['como vai o radar', 'radar'],
      ['como está o meu vídeo', 'video'],
      ['como está o último vídeo', 'video'],
      ['what did the radar find', 'radar'],
      ['radar status', 'radar'],
      ['video status', 'video'],
    ];
    for (const [text, jobKind] of cases) {
      assert.deepEqual(ruleIntent(text, PROJECTS), { kind: 'job-status', jobKind, number: null }, text);
    }
  });

  test('pergunta comum com "vídeo"/"radar" vai para conversa/pesquisa, não vira status', async () => {
    const questions = [
      'what is a video codec?',
      'como está o radar meteorológico hoje?',
      'o que você achou do vídeo que te mandei?',
      "what's the best video editor?",
    ];
    for (const text of questions) {
      assert.notEqual(kind(text), 'job-status', text);
      const d = await new NightRouter(new FakeLlm(), async () => PROJECTS).route(text, 'pt-BR');
      assert.ok(['chat', 'research'].includes(d.intent.kind), `${text} → ${d.intent.kind}`);
    }
  });

  test('job-cancel só com número; sem número cai no cancel de tarefas', () => {
    const cases: [string, 'radar' | 'video', number][] = [
      ['cancela o vídeo 3', 'video', 3],
      ['cancela o vídeo três', 'video', 3],
      ['cancela o radar 2', 'radar', 2],
      ['cancela o radar dois', 'radar', 2],
      ['cancel video 3', 'video', 3],
      ['cancel radar 2', 'radar', 2],
    ];
    for (const [text, jobKind, number] of cases) {
      assert.deepEqual(ruleIntent(text, PROJECTS), { kind: 'job-cancel', jobKind, number }, text);
    }
    assert.notEqual(kind('cancela o vídeo'), 'job-cancel', 'sem número não cancela trabalho');
    assert.equal(kind('cancela a tarefa'), 'cancel');
  });

  test('job-resume em PT e EN, só com número', () => {
    const cases: [string, 'radar' | 'video', number][] = [
      ['continua o vídeo 3', 'video', 3],
      ['continua o vídeo três', 'video', 3],
      ['retoma o radar 2', 'radar', 2],
      ['retoma o radar dois', 'radar', 2],
      ['resume video 3', 'video', 3],
      ['resume radar 2', 'radar', 2],
      ['continue video 3', 'video', 3],
    ];
    for (const [text, jobKind, number] of cases) {
      assert.deepEqual(ruleIntent(text, PROJECTS), { kind: 'job-resume', jobKind, number }, text);
    }
    for (const text of ['continua o vídeo', 'retoma o radar', 'resume the video']) {
      assert.notEqual(kind(text), 'job-resume', `sem número não retoma: ${text}`);
    }
  });

  test('offer-decision em PT e EN, com número por extenso', () => {
    const cases: [string, 'approve' | 'reject', number][] = [
      ['aprova a oferta 2', 'approve', 2],
      ['rejeita a oferta 1', 'reject', 1],
      ['descarta a oferta 3', 'reject', 3],
      ['aprova a oferta dois', 'approve', 2],
      ['approve offer 2', 'approve', 2],
      ['reject offer 1', 'reject', 1],
      ['discard the offer three', 'reject', 3],
    ];
    for (const [text, decision, number] of cases) {
      assert.deepEqual(ruleIntent(text, PROJECTS), { kind: 'offer-decision', number, decision }, text);
    }
  });

  test('video-decision em PT e EN, com número por extenso', () => {
    const cases: [string, 'approve' | 'reject', number][] = [
      ['aprova o vídeo 3', 'approve', 3],
      ['aprova o vídeo três', 'approve', 3],
      ['rejeita o vídeo 2', 'reject', 2],
      ['approve video 3', 'approve', 3],
      ['reject video 2', 'reject', 2],
    ];
    for (const [text, decision, number] of cases) {
      assert.deepEqual(ruleIntent(text, PROJECTS), { kind: 'video-decision', number, decision }, text);
    }
  });

  test('oferta/vídeo nunca se confundem com a aprovação de merge', () => {
    // "aprovo" sozinho e "aprovo o merge" continuam sendo merge.
    assert.deepEqual(ruleIntent('aprovo', PROJECTS), { kind: 'approval', decision: 'approve', taskHint: null });
    assert.deepEqual(ruleIntent('Aprovo o merge', PROJECTS), { kind: 'approval', decision: 'approve', taskHint: null });
    for (const t of ['aprova a oferta 2', 'aprova o vídeo 3', 'approve offer 2', 'approve video 3']) {
      assert.notEqual(kind(t), 'approval', t);
      assert.notEqual(kind(t), 'cancel', t);
    }
  });

  test('sem número, aprovar oferta/vídeo não decide: pede o número', () => {
    assert.deepEqual(ruleIntent('aprova a oferta', PROJECTS), { kind: 'offer-decision', number: null, decision: 'approve' });
    assert.deepEqual(ruleIntent('rejeita a oferta', PROJECTS), { kind: 'offer-decision', number: null, decision: 'reject' });
    assert.deepEqual(ruleIntent('aprova o vídeo', PROJECTS), { kind: 'video-decision', number: null, decision: 'approve' });
  });

  test('merge misturado com oferta/vídeo fica ambíguo, com número nulo', () => {
    // A regra não pode escolher entre a decisão de conteúdo e o merge de código (QA do F06).
    assert.deepEqual(ruleIntent('aprovo o merge do vídeo 2', PROJECTS),
      { kind: 'video-decision', number: null, decision: 'approve', ambiguous: true });
    assert.deepEqual(ruleIntent('aprova a oferta 2 e faz o merge', PROJECTS),
      { kind: 'offer-decision', number: null, decision: 'approve', ambiguous: true });
    assert.deepEqual(ruleIntent('rejeito o merge do vídeo 3', PROJECTS),
      { kind: 'video-decision', number: null, decision: 'reject', ambiguous: true });
    // Sem merge junto, a decisão continua normal.
    assert.deepEqual(ruleIntent('aprova o vídeo 2', PROJECTS),
      { kind: 'video-decision', number: 2, decision: 'approve' });
  });

  test('frase negada não decide oferta nem vídeo', () => {
    for (const t of ['não aprova a oferta 2', 'nao rejeita o video 3', "don't approve offer 2"]) {
      assert.ok(!['offer-decision', 'video-decision'].includes(kind(t) ?? ''), t);
    }
  });

  test('R06: mostra a oferta pelo número, em PT e EN', () => {
    const cases: [string, number][] = [
      ['mostra a oferta 3', 3],
      ['mostre a oferta 3', 3],
      ['abre a oferta 3', 3],
      ['mostra a oferta três', 3],
      ['show offer 3', 3],
      ['open offer two', 2],
    ];
    for (const [text, number] of cases) {
      assert.deepEqual(ruleIntent(text, PROJECTS), { kind: 'offer-show', number }, text);
    }
  });

  test('R06: pergunta sobre a oferta, com e sem número', () => {
    const cases: [string, number | null][] = [
      ['por que a oferta 3 é boa?', 3],
      ['quais as fontes da oferta 2?', 2],
      ['quais as fontes da oferta dois?', 2],
      ['what are the risks of offer 2?', 2],
      ['why is offer three good?', 3],
      ['por que a oferta é boa?', null],
    ];
    for (const [text, number] of cases) {
      const i = ruleIntent(text, PROJECTS);
      assert.equal(i?.kind, 'offer-ask', text);
      assert.equal(i?.kind === 'offer-ask' ? i.number : null, number, text);
      assert.equal(i?.kind === 'offer-ask' ? i.question : null, text, text);
    }
    // "por que ela é boa?" usa a última oferta mostrada: o número fica nulo e o coordenador resolve.
    const pronome = ruleIntent('por que ela é boa?', PROJECTS);
    assert.deepEqual(pronome, { kind: 'offer-ask', number: null, question: 'por que ela é boa?' });
  });

  test('R06: ajusta campo da oferta criando versão nova (número pode faltar)', () => {
    const cases: [string, number | null, string, string][] = [
      ['ajusta o público da oferta 3 para mães de primeira viagem', 3, 'publico', 'mães de primeira viagem'],
      ['muda o preço da oferta 2 para 47', 2, 'precoHipotese', '47'],
      ['muda a promessa da oferta dois para uma rotina em sete passos', 2, 'promessa', 'uma rotina em sete passos'],
      ['ajusta o nome da oferta 1 para Rotina Enxuta', 1, 'nome', 'Rotina Enxuta'],
      ['change the audience of offer 3 to first-time mothers', 3, 'publico', 'first-time mothers'],
      ['muda o diferencial da oferta para checklist próprio', null, 'diferencial', 'checklist próprio'],
    ];
    for (const [text, number, campo, valor] of cases) {
      assert.deepEqual(ruleIntent(text, PROJECTS), { kind: 'offer-edit', number, campo, valor }, text);
    }
  });

  test('R06: conversa de oferta não vira decisão, pesquisa nem conversa comum', () => {
    for (const t of ['mostra a oferta 3', 'por que a oferta 3 é boa?', 'quais as fontes da oferta 2?',
      'ajusta o público da oferta 3 para mães']) {
      assert.ok(!['offer-decision', 'video-decision', 'approval', 'research', 'chat'].includes(kind(t) ?? ''), t);
    }
    // Decisão continua sendo decisão: "aprova a oferta 2" não foi capturada pelas regras novas.
    assert.deepEqual(ruleIntent('aprova a oferta 2', PROJECTS), { kind: 'offer-decision', number: 2, decision: 'approve' });
    // Conversa sem oferta não é sequestrada por engano.
    assert.equal(kind('por que o céu é azul?'), null);
    assert.notEqual(kind('mostra as minhas ideias'), 'offer-show');
  });
});
