// Página do painel do NIGHT: uma tela por agente, decisões e conexões, sempre no tema escuro.
// O desenho segue a ideia do OpenBot (barra de ícones, lista de agentes, conversa num cartão), mas o código,
// os ícones e as cores são do NIGHT: o OpenBot é PolyForm Noncommercial e o NIGHT vai ser vendido.
//
// Segurança: tudo que vem do servidor entra na página por textContent (nunca innerHTML), e cada POST leva o
// token deste início do servidor; o servidor confere o token e a origem.

/**
 * Ícone do NIGHT: quadrado preto de cantos suaves, lua crescente branca e uma estrela.
 * Desenho próprio (não vem do OpenBot); a mesma arte fica em assets/night-icon.svg.
 */
export const ICONE_NIGHT = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
<defs><mask id="lua"><rect width="64" height="64" fill="#fff"/><circle cx="39" cy="25" r="14" fill="#000"/></mask></defs>
<rect width="64" height="64" rx="15" fill="#000"/>
<circle cx="30" cy="34" r="17" fill="#fff" mask="url(#lua)"/>
<path d="M47 12l1.6 3.4L52 17l-3.4 1.6L47 22l-1.6-3.4L42 17l3.4-1.6Z" fill="#fff"/>
</svg>`;

/** Ícones próprios (traço simples, 24×24). */
const ICONES: Record<string, string> = {
  night: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z"/>',
  radar: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/><path d="M12 12l5-5"/>',
  produto: '<path d="M4 8l8-4 8 4-8 4-8-4Z"/><path d="M4 8v8l8 4 8-4V8"/><path d="M12 12v8"/>',
  campanha: '<path d="M4 10v4h3l6 4V6L7 10H4Z"/><path d="M17 9a4 4 0 0 1 0 6"/>',
  codigo: '<path d="M9 8l-4 4 4 4"/><path d="M15 8l4 4-4 4"/>',
  video: '<rect x="4" y="6" width="16" height="12" rx="2"/><path d="M11 10v4l3-2-3-2Z"/>',
  decisoes: '<path d="M5 12l4 4 10-10"/>',
  conexoes: '<path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1"/><path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1"/>',
  enviar: '<path d="M5 12h14"/><path d="M13 6l6 6-6 6"/>',
};

const svg = (nome: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONES[nome]}</svg>`;

export function paginaPainel(token: string): string {
  const icones = JSON.stringify(Object.fromEntries(Object.keys(ICONES).map((k) => [k, svg(k)])));
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>NIGHT</title>
<meta name="color-scheme" content="dark">
<link rel="icon" href="/icone.svg" type="image/svg+xml">
<style>${CSS}</style></head><body>
<div class="app">
  <nav class="trilho" aria-label="Seções">
    <div class="logo" title="NIGHT">${ICONE_NIGHT}</div>
    <button class="trilho-btn ativo" data-secao="agentes" title="Agentes" aria-label="Agentes">${svg('radar')}</button>
    <button class="trilho-btn" data-secao="decisoes" title="Decisões" aria-label="Decisões">${svg('decisoes')}<span class="contador" id="contador" hidden></span></button>
    <button class="trilho-btn" data-secao="conexoes" title="Conexões" aria-label="Conexões">${svg('conexoes')}</button>
  </nav>
  <aside class="lista" aria-label="Agentes">
    <div class="lista-topo"><span>Agentes</span></div>
    <div id="agentes"></div>
  </aside>
  <main class="principal">
    <header class="cabeca"><span class="cabeca-avatar" id="cabeca-avatar"></span><h1 id="titulo">NIGHT</h1><span class="chip" id="chip" hidden></span></header>
    <section class="cartao" id="vista"></section>
  </main>
</div>
<script>
const TOKEN = ${JSON.stringify(token)};
const ICONES = ${icones};
${JS}
</script></body></html>`;
}

const CSS = `
:root{color-scheme:dark;--fundo:#0c0d10;--lista:#0c0d10;--cartao:#15171c;--superficie:#1c1f26;--superficie2:#232733;--borda:#262a33;
--txt:#e9ebf1;--sub:#9096a5;--fraco:#6b7180;--acento:#7c9cff;--acento2:#a5b8ff;--ok:#4fc28a;--alerta:#f0b44c;--perigo:#ef6b6b;
--raio:14px;--raio-p:10px}
*{box-sizing:border-box}html,body{height:100%}
body{margin:0;background:var(--fundo);color:var(--txt);font:15px/1.45 "Inter",system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
button{font:inherit;color:inherit;cursor:pointer;border:0;background:none}
.app{display:grid;grid-template-columns:56px 280px 1fr;height:100vh}
.trilho{display:flex;flex-direction:column;align-items:center;gap:6px;padding:10px 0;border-right:1px solid var(--borda)}
.logo{width:34px;height:34px;margin-bottom:10px;border-radius:9px;box-shadow:0 0 0 1px #2a2e38}
.logo svg{width:34px;height:34px;display:block}.trilho-btn svg{width:20px;height:20px}
.trilho-btn{position:relative;width:38px;height:38px;border-radius:10px;display:grid;place-items:center;color:var(--sub);transition:background .15s,color .15s}
.trilho-btn.ativo{background:var(--superficie2);color:var(--txt)}
.contador{position:absolute;top:2px;right:2px;min-width:16px;height:16px;padding:0 4px;border-radius:8px;background:var(--alerta);color:#1b1300;font-size:11px;font-weight:700;line-height:16px;text-align:center}
.lista{display:flex;flex-direction:column;padding:10px;gap:4px;overflow:auto}
#agentes{display:flex;flex-direction:column;gap:4px}
.lista-topo{display:flex;align-items:center;justify-content:space-between;padding:6px 8px 10px;color:var(--sub);font-size:13px;font-weight:600;letter-spacing:.02em;text-transform:uppercase}
.agente{display:flex;gap:10px;align-items:center;width:100%;padding:9px 10px;border-radius:var(--raio-p);text-align:left;transition:background .15s}
.agente.ativo{background:var(--superficie)}
.agente-nome{font-weight:600}.agente-estado{font-size:12.5px;color:var(--sub);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.agente-texto{min-width:0;flex:1}
.avatar{flex:none;width:36px;height:36px;border-radius:11px;display:grid;place-items:center;color:#fff}
.avatar svg{width:19px;height:19px}
.ponto{flex:none;width:8px;height:8px;border-radius:50%;background:var(--alerta)}
.principal{display:flex;flex-direction:column;min-width:0;padding:0 10px 10px 0}
.cabeca{display:flex;align-items:center;gap:10px;height:52px;padding:0 6px}
.cabeca h1{font-size:16px;margin:0;font-weight:600}
.cabeca-avatar .avatar{width:26px;height:26px;border-radius:8px}.cabeca-avatar svg{width:15px;height:15px}
.chip{font-size:12px;padding:3px 9px;border-radius:999px;background:var(--superficie2);color:var(--sub)}
.cartao{flex:1;min-height:0;background:var(--cartao);border:1px solid var(--borda);border-radius:var(--raio);display:flex;flex-direction:column;overflow:hidden}
.rolagem{flex:1;overflow:auto;padding:22px clamp(16px,4vw,48px)}
.miolo{max-width:760px;margin:0 auto}
.bloco{background:var(--superficie);border:1px solid var(--borda);border-radius:var(--raio-p);padding:12px 14px;margin:0 0 14px}
.bloco h2{font-size:13px;color:var(--sub);margin:0 0 8px;font-weight:600;text-transform:uppercase;letter-spacing:.02em}
.bloco ul{margin:0;padding-left:18px}.bloco li{margin:3px 0}
.vazio{color:var(--fraco)}
.msg{display:flex;margin:10px 0}.msg.voce{justify-content:flex-end}
.balao{max-width:82%;padding:10px 13px;border-radius:14px;white-space:pre-wrap;overflow-wrap:anywhere}
.voce .balao{background:#24305a;border-bottom-right-radius:4px}
.night .balao{background:var(--superficie2);border-bottom-left-radius:4px}
.aviso .balao{background:#2b2616;color:#f3dca6}
.digitando .balao{color:var(--sub)}
.boas-vindas{text-align:center;padding:30px 0 10px}
.boas-vindas .avatar{width:64px;height:64px;border-radius:20px;margin:0 auto 14px}.boas-vindas .avatar svg{width:32px;height:32px}
.boas-vindas h2{margin:0 0 6px;font-size:20px}.boas-vindas p{margin:0 auto;color:var(--sub);max-width:420px}
.sugestoes{display:flex;flex-wrap:wrap;gap:8px;justify-content:center;margin-top:16px}
.sugestao{padding:8px 12px;border:1px solid var(--borda);border-radius:999px;background:var(--superficie);color:var(--sub);font-size:13.5px}
.compositor{border-top:1px solid var(--borda);padding:12px clamp(12px,4vw,48px)}
.compositor form{max-width:760px;margin:0 auto;display:flex;gap:8px;align-items:flex-end;background:var(--superficie);border:1px solid var(--borda);border-radius:14px;padding:6px 6px 6px 12px}
.compositor textarea{flex:1;min-width:0;resize:none;border:0;outline:0;background:transparent;color:var(--txt);font:inherit;padding:7px 0;max-height:160px}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:34px;padding:0 14px;border-radius:9px;font-weight:600;transition:transform .1s,opacity .15s}
.btn:active{transform:scale(.97)}.btn:disabled{opacity:.5;cursor:default}
.btn-primario{background:#f1f3f8;color:#11131a}.btn-icone{width:34px;padding:0}.btn-icone svg{width:18px;height:18px}
.btn-ok{background:var(--ok);color:#06150d}.btn-perigo{background:transparent;border:1px solid #5a2a2a;color:var(--perigo)}
.decisao{display:grid;gap:8px}.decisao h3{margin:0;font-size:15px}.decisao p{margin:0;color:var(--sub)}
.acoes{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.campo{display:flex;align-items:center;gap:8px;color:var(--sub)}
.campo input[type=number]{width:96px;height:34px;padding:0 10px;border-radius:9px;border:1px solid var(--borda);background:var(--fundo);color:var(--txt);font:inherit}
.conexao{display:flex;gap:10px;align-items:flex-start;padding:8px 0;border-bottom:1px solid var(--borda)}.conexao:last-child{border:0}
.estado-ok,.estado-falta{flex:none;width:9px;height:9px;border-radius:50%;margin-top:6px}.estado-ok{background:var(--ok)}.estado-falta{background:var(--perigo)}
.conexao small{display:block;color:var(--sub)}
.retorno{margin:0 0 14px}
:focus-visible{outline:2px solid var(--acento);outline-offset:2px}
@media (hover:hover) and (pointer:fine){.trilho-btn:hover,.agente:hover{background:var(--superficie)}.sugestao:hover{color:var(--txt);border-color:#3a4050}.btn-primario:hover{opacity:.9}}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
@media (max-width:760px){
  .app{grid-template-columns:1fr;grid-template-rows:auto auto 1fr;height:100dvh}
  .trilho{flex-direction:row;justify-content:flex-start;padding:8px 16px;border-right:0;border-bottom:1px solid var(--borda)}
  .logo{margin:0 8px 0 0}
  .lista{flex-direction:row;overflow-x:auto;padding:8px 16px;gap:6px}.lista-topo{display:none}
  #agentes{flex-direction:row;gap:6px}
  .agente{width:auto;flex:none;padding:6px 10px}.agente-estado{display:none}
  .principal{padding:0 16px 16px}
}
`;

// Script da página: sem dependências; todo texto do servidor entra por textContent.
const JS = `
const AGENTES_COR = { night:'#000', radar:'#1f8a70', produto:'#b4672a', campanha:'#b23a6f', codigo:'#4a58c9', video:'#7a4bc2' };
let estado = null;
let secao = 'agentes';
let tela = 'night';
let enviando = false;

const $ = (s) => document.querySelector(s);
function el(tag, cls, texto) { const e = document.createElement(tag); if (cls) e.className = cls; if (texto != null) e.textContent = texto; return e; }
function avatar(t) { const a = el('span', 'avatar'); a.style.background = AGENTES_COR[t] || '#333'; a.innerHTML = ICONES[t] || ''; return a; }

async function carregar() {
  try {
    const r = await fetch('/api/estado', { cache: 'no-store' });
    if (!r.ok) throw new Error(r.status);
    estado = await r.json();
    desenhar();
  } catch (e) { /* servidor reiniciando: tenta de novo no próximo ciclo */ }
}

async function postar(caminho, dados) {
  const r = await fetch(caminho, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...dados, token: TOKEN }) });
  const corpo = await r.json().catch(() => ({ texto: 'Resposta inválida do NIGHT.' }));
  if (r.status === 403) return { texto: 'O painel foi reaberto pelo NIGHT. Recarregue a página (F5).' };
  return corpo;
}

function desenhar() {
  if (!estado) return;
  const n = estado.decisoes.length;
  const c = $('#contador'); c.hidden = n === 0; c.textContent = String(n);
  document.querySelectorAll('.trilho-btn').forEach((b) => b.classList.toggle('ativo', b.dataset.secao === secao));
  desenharLista();
  if (secao === 'agentes') desenharAgente();
  else if (secao === 'decisoes') desenharDecisoes();
  else desenharConexoes();
}

function desenharLista() {
  const lista = $('#agentes'); lista.replaceChildren();
  for (const a of estado.agentes) {
    const b = el('button', 'agente' + (secao === 'agentes' && a.tela === tela ? ' ativo' : ''));
    b.append(avatar(a.tela));
    const t = el('span', 'agente-texto');
    t.append(el('div', 'agente-nome', a.nome), el('div', 'agente-estado', a.resumo));
    b.append(t);
    if (a.esperando > 0) b.append(el('span', 'ponto'));
    b.onclick = () => { secao = 'agentes'; tela = a.tela; desenhar(); setTimeout(() => $('#texto')?.focus(), 0); };
    lista.append(b);
  }
}

function cabeca(titulo, t, chip) {
  $('#titulo').textContent = titulo;
  const ca = $('#cabeca-avatar'); ca.replaceChildren(); if (t) ca.append(avatar(t));
  const ch = $('#chip'); ch.hidden = !chip; ch.textContent = chip || '';
}

function desenharAgente() {
  const a = estado.agentes.find((x) => x.tela === tela);
  cabeca(a.nome, a.tela, a.resumo);
  const vista = $('#vista');
  const rascunho = $('#texto')?.value || '';
  vista.replaceChildren();
  const rol = el('div', 'rolagem'); const miolo = el('div', 'miolo'); rol.append(miolo);
  if (a.linhas.length) {
    const bloco = el('div', 'bloco'); bloco.append(el('h2', null, 'Trabalhos'));
    const ul = el('ul'); for (const l of a.linhas) ul.append(el('li', null, l)); bloco.append(ul); miolo.append(bloco);
  }
  const conversa = estado.conversas[tela] || [];
  if (conversa.length === 0) {
    const bv = el('div', 'boas-vindas'); bv.append(avatar(a.tela), el('h2', null, a.nome), el('p', null, a.foco));
    const sug = el('div', 'sugestoes');
    for (const s of a.exemplos) { const b = el('button', 'sugestao', s); b.onclick = () => { $('#texto').value = s; $('#texto').focus(); }; sug.append(b); }
    bv.append(sug); miolo.append(bv);
  }
  for (const m of conversa) { const d = el('div', 'msg ' + m.quem); d.append(el('div', 'balao', m.texto)); miolo.append(d); }
  if (enviando) { const d = el('div', 'msg night digitando'); d.append(el('div', 'balao', 'NIGHT está pensando…')); miolo.append(d); }
  const comp = el('div', 'compositor'); const f = el('form');
  const ta = el('textarea'); ta.id = 'texto'; ta.rows = 1; ta.maxLength = 4000; ta.placeholder = 'Fale com ' + a.nome + '…'; ta.value = rascunho;
  ta.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); f.requestSubmit(); } };
  ta.oninput = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 160) + 'px'; };
  const b = el('button', 'btn btn-primario btn-icone'); b.type = 'submit'; b.innerHTML = ICONES.enviar; b.setAttribute('aria-label', 'Enviar'); b.disabled = enviando;
  f.append(ta, b);
  f.onsubmit = async (e) => {
    e.preventDefault();
    const texto = ta.value.trim(); if (!texto || enviando) return;
    enviando = true; ta.value = '';
    (estado.conversas[tela] ||= []).push({ quem: 'voce', texto });
    desenhar();
    await postar('/api/pedir', { tela, texto });
    enviando = false;
    await carregar();
    $('#texto')?.focus();
  };
  comp.append(f);
  vista.append(rol, comp);
  rol.scrollTop = rol.scrollHeight;
}

function desenharDecisoes(retorno) {
  cabeca('Decisões', null, estado.decisoes.length ? estado.decisoes.length + ' esperando' : '');
  const vista = $('#vista'); vista.replaceChildren();
  const rol = el('div', 'rolagem'); const miolo = el('div', 'miolo'); rol.append(miolo);
  if (retorno) miolo.append(el('div', 'bloco retorno', retorno));
  if (estado.decisoes.length === 0) miolo.append(el('p', 'vazio', 'Nada esperando decisão agora.'));
  for (const d of estado.decisoes) {
    const c = el('div', 'bloco decisao');
    c.append(el('h2', null, d.grupo), el('h3', null, d.titulo), el('p', null, d.texto));
    const acoes = el('div', 'acoes');
    let valor = null, confirmo = null;
    if (d.pedeValor) {
      const campo = el('label', 'campo', 'R$ por dia');
      valor = el('input'); valor.type = 'number'; valor.min = '1'; valor.max = '200'; valor.step = '1'; valor.inputMode = 'numeric';
      campo.append(valor); acoes.append(campo);
      const cc = el('label', 'campo'); confirmo = el('input'); confirmo.type = 'checkbox';
      cc.append(confirmo, document.createTextNode('Confirmo criar PAUSADA com esse valor'));
      acoes.append(cc);
    }
    for (const a of d.acoes) {
      const b = el('button', 'btn ' + (a.estilo === 'perigo' ? 'btn-perigo' : 'btn-ok'), a.rotulo);
      b.onclick = async () => {
        b.disabled = true;
        const extra = d.pedeValor ? { valor: valor.value, confirmo: confirmo.checked ? 'sim' : '' } : {};
        const r = await postar('/api/decidir', { ...a.campos, ...extra });
        await carregar();
        if (secao === 'decisoes') desenharDecisoes(r.texto);
      };
      acoes.append(b);
    }
    c.append(acoes); miolo.append(c);
  }
  vista.append(rol);
}

function desenharConexoes() {
  cabeca('Conexões', null, '');
  const vista = $('#vista'); vista.replaceChildren();
  const rol = el('div', 'rolagem'); const miolo = el('div', 'miolo'); rol.append(miolo);
  const bloco = el('div', 'bloco');
  for (const c of estado.conexoes) {
    const linha = el('div', 'conexao'); linha.append(el('span', c.ok ? 'estado-ok' : 'estado-falta'));
    const t = el('div'); t.append(el('div', null, c.nome), el('small', null, c.detalhe)); linha.append(t); bloco.append(linha);
  }
  if (!estado.conexoes.length) bloco.append(el('p', 'vazio', 'Sem informação de conexões.'));
  miolo.append(bloco); vista.append(rol);
}

document.querySelectorAll('.trilho-btn').forEach((b) => { b.onclick = () => { secao = b.dataset.secao; desenhar(); }; });
carregar();
// Atualiza estado e respostas que chegam depois (pesquisa), sem atrapalhar quem está digitando.
setInterval(() => { if (!enviando && document.visibilityState === 'visible') carregar(); }, 5000);
`;
