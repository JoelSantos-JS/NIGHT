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
  openbot: '<rect x="4" y="6" width="16" height="13" rx="3"/><path d="M12 3v3"/><path d="M9 12h.01"/><path d="M15 12h.01"/><path d="M9 16h6"/>',
  enviar: '<path d="M5 12h14"/><path d="M13 6l6 6-6 6"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3"/><path d="M9 21h6"/>',
};

const svg = (nome: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONES[nome]}</svg>`;

export function paginaPainel(token: string): string {
  const icones = JSON.stringify(Object.fromEntries(Object.keys(ICONES).map((k) => [k, svg(k)])));
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><title>NIGHT</title>
<meta name="color-scheme" content="dark">
<link rel="icon" href="/icone.svg" type="image/svg+xml">
<style>${CSS}</style></head><body>
<div class="app">
  <nav class="trilho" aria-label="Seções">
    <div class="logo" title="NIGHT">${ICONE_NIGHT}</div>
    <button class="trilho-btn ativo" data-secao="agentes" title="Agentes" aria-label="Agentes">${svg('radar')}</button>
    <button class="trilho-btn" data-secao="decisoes" title="Decisões" aria-label="Decisões">${svg('decisoes')}<span class="contador" id="contador" hidden></span></button>
    <button class="trilho-btn" data-secao="conexoes" title="Conexões" aria-label="Conexões">${svg('conexoes')}</button>
    <button class="trilho-btn" data-secao="openbot" title="OpenBot" aria-label="OpenBot">${svg('openbot')}<span class="contador" id="contador-openbot" hidden></span></button>
  </nav>
  <aside class="lista" aria-label="Agentes">
    <div class="lista-topo"><span>Agentes</span></div>
    <div id="agentes"></div>
  </aside>
  <main class="principal">
    <header class="cabeca"><span class="cabeca-avatar" id="cabeca-avatar"></span><h1 id="titulo">NIGHT</h1><span class="chip" id="chip" hidden></span>
      <div class="voz-grupo">
        <button class="btn voz-btn" id="voz-btn" type="button" aria-pressed="false">${svg('mic')}<span>Voz ao vivo</span></button>
        <button class="btn voz-mudo" id="voz-mudo" type="button" hidden>Mudo</button>
        <span class="voz-estado" id="voz-estado" hidden></span>
      </div>
    </header>
    <div class="voz-legenda" id="voz-legenda" hidden></div>
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
*{box-sizing:border-box}html,body{height:100%;max-width:100%;overflow-x:hidden}
body{margin:0;background:var(--fundo);color:var(--txt);font:15px/1.45 "Inter",system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased;overflow-wrap:break-word}
button{font:inherit;color:inherit;cursor:pointer;border:0;background:none}
.app{display:grid;grid-template-columns:56px 280px minmax(0,1fr);height:100vh;width:100%;max-width:100%;min-width:0}
.app>*{min-width:0}
.trilho{display:flex;flex-direction:column;align-items:center;gap:6px;padding:10px 0;border-right:1px solid var(--borda);min-width:0;max-width:100%}
.logo{width:34px;height:34px;margin-bottom:10px;border-radius:9px;box-shadow:0 0 0 1px #2a2e38}
.logo svg{width:34px;height:34px;display:block}.trilho-btn svg{width:20px;height:20px}
.trilho-btn{position:relative;width:38px;height:38px;border-radius:10px;display:grid;place-items:center;color:var(--sub);transition:background .15s,color .15s}
.trilho-btn.ativo{background:var(--superficie2);color:var(--txt)}
.contador{position:absolute;top:2px;right:2px;min-width:16px;height:16px;padding:0 4px;border-radius:8px;background:var(--alerta);color:#1b1300;font-size:11px;font-weight:700;line-height:16px;text-align:center}
.lista{display:flex;flex-direction:column;padding:10px;gap:4px;overflow:auto;min-width:0;max-width:100%}
#agentes{display:flex;flex-direction:column;gap:4px}
.lista-topo{display:flex;align-items:center;justify-content:space-between;padding:6px 8px 10px;color:var(--sub);font-size:13px;font-weight:600;letter-spacing:.02em;text-transform:uppercase}
.agente{display:flex;gap:10px;align-items:center;width:100%;padding:9px 10px;border-radius:var(--raio-p);text-align:left;transition:background .15s}
.agente.ativo{background:var(--superficie)}
.agente-nome{font-weight:600}.agente-estado{font-size:12.5px;color:var(--sub);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.agente-texto{min-width:0;flex:1}
.avatar{flex:none;width:36px;height:36px;border-radius:11px;display:grid;place-items:center;color:#fff}
.avatar svg{width:19px;height:19px}
.ponto{flex:none;width:8px;height:8px;border-radius:50%;background:var(--alerta)}
.principal{display:flex;flex-direction:column;min-width:0;min-height:0;max-width:100%;overflow:hidden;padding:0 10px 10px 0}
.cabeca{display:flex;align-items:center;gap:10px;height:52px;padding:0 6px;min-width:0;max-width:100%}
.cabeca h1{font-size:16px;margin:0;font-weight:600;min-width:0;overflow-wrap:anywhere}
.cabeca-avatar .avatar{width:26px;height:26px;border-radius:8px}.cabeca-avatar svg{width:15px;height:15px}
.chip{font-size:12px;padding:3px 9px;border-radius:999px;background:var(--superficie2);color:var(--sub)}
.cartao{flex:1;min-height:0;min-width:0;max-width:100%;background:var(--cartao);border:1px solid var(--borda);border-radius:var(--raio);display:flex;flex-direction:column;overflow:hidden}
.rolagem{flex:1;min-height:0;min-width:0;max-width:100%;overflow-y:auto;overflow-x:hidden;padding:22px clamp(16px,4vw,48px)}
.miolo{width:100%;max-width:760px;min-width:0;margin:0 auto}
.bloco{background:var(--superficie);border:1px solid var(--borda);border-radius:var(--raio-p);padding:12px 14px;margin:0 0 14px;min-width:0;max-width:100%;overflow-wrap:anywhere}
.bloco h2{font-size:13px;color:var(--sub);margin:0 0 8px;font-weight:600;text-transform:uppercase;letter-spacing:.02em}
.bloco ul{margin:0;padding-left:18px}.bloco li{margin:3px 0}
.bloco p,.bloco li,.bloco h2,.bloco h3,.bloco small,.bloco summary{overflow-wrap:anywhere;word-break:break-word}
.vazio{color:var(--fraco)}
.msg{display:flex;margin:10px 0;min-width:0;max-width:100%}.msg.voce{justify-content:flex-end}
.balao{max-width:82%;min-width:0;padding:10px 13px;border-radius:14px;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word}
.voce .balao{background:#24305a;border-bottom-right-radius:4px}
.night .balao{background:var(--superficie2);border-bottom-left-radius:4px}
.aviso .balao{background:#2b2616;color:#f3dca6}
.digitando .balao{color:var(--sub)}
.boas-vindas{text-align:center;padding:30px 0 10px}
.boas-vindas .avatar{width:64px;height:64px;border-radius:20px;margin:0 auto 14px}.boas-vindas .avatar svg{width:32px;height:32px}
.boas-vindas h2{margin:0 0 6px;font-size:20px}.boas-vindas p{margin:0 auto;color:var(--sub);max-width:420px}
.sugestoes{display:flex;flex-wrap:wrap;gap:8px;justify-content:center;margin-top:16px}
.sugestao{padding:8px 12px;border:1px solid var(--borda);border-radius:999px;background:var(--superficie);color:var(--sub);font-size:13.5px;max-width:100%;overflow-wrap:anywhere}
.compositor{border-top:1px solid var(--borda);padding:12px clamp(12px,4vw,48px);min-width:0;max-width:100%;background:var(--cartao)}
.compositor form{width:100%;max-width:760px;min-width:0;margin:0 auto;display:flex;gap:8px;align-items:flex-end;background:var(--superficie);border:1px solid var(--borda);border-radius:14px;padding:6px 6px 6px 12px}
.compositor textarea{flex:1 1 auto;min-width:0;resize:none;border:0;outline:0;background:transparent;color:var(--txt);font:inherit;padding:7px 0;max-height:160px}
.compositor .btn{flex:none}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:34px;padding:0 14px;border-radius:9px;font-weight:600;transition:transform .1s,opacity .15s}
.btn:active{transform:scale(.97)}.btn:disabled{opacity:.5;cursor:default}
.btn-primario{background:#f1f3f8;color:#11131a}.btn-icone{width:34px;padding:0}.btn-icone svg{width:18px;height:18px}
.btn-ok{background:var(--ok);color:#06150d}.btn-perigo{background:transparent;border:1px solid #5a2a2a;color:var(--perigo)}
.voz-grupo{margin-left:auto;display:flex;align-items:center;justify-content:flex-end;gap:8px;flex-wrap:wrap}
.voz-btn svg{width:17px;height:17px}
.voz-btn.btn-perigo{background:var(--perigo);border-color:var(--perigo);color:#1a0707}
.voz-mudo{background:var(--superficie2);color:var(--txt)}
.voz-mudo.mudo{color:var(--alerta)}
.voz-estado{font-size:12.5px;color:var(--sub);white-space:nowrap}
.voz-estado.erro{color:var(--perigo);white-space:normal}
.voz-mudo[hidden],.voz-estado[hidden],.voz-legenda[hidden]{display:none!important}
.voz-legenda{margin:0 6px 8px;padding:8px 12px;border:1px solid var(--borda);border-radius:var(--raio-p);background:var(--superficie);color:var(--sub);font-size:13px;display:flex;flex-direction:column;gap:2px;min-width:0;max-width:100%}
.voz-linha{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.voz-quem{color:var(--txt);font-weight:600}
.decisao{display:grid;gap:8px;min-width:0;max-width:100%}.decisao h3{margin:0;font-size:15px;overflow-wrap:anywhere}.decisao p{margin:0;color:var(--sub)}
.acoes{display:flex;flex-wrap:wrap;gap:8px;align-items:center;min-width:0;max-width:100%}
.campo{display:flex;flex-wrap:wrap;align-items:center;gap:8px;color:var(--sub);min-width:0;max-width:100%}
.campo input[type=number]{width:96px;max-width:100%;height:34px;padding:0 10px;border-radius:9px;border:1px solid var(--borda);background:var(--fundo);color:var(--txt);font:inherit}
.conexao{display:flex;gap:10px;align-items:flex-start;padding:8px 0;border-bottom:1px solid var(--borda);min-width:0;max-width:100%}.conexao:last-child{border:0}
.conexao>div{min-width:0;overflow-wrap:anywhere}
.estado-ok,.estado-falta{flex:none;width:9px;height:9px;border-radius:50%;margin-top:6px}.estado-ok{background:var(--ok)}.estado-falta{background:var(--perigo)}
.conexao small{display:block;color:var(--sub);overflow-wrap:anywhere}
.retorno{margin:0 0 14px}
.bloco ol{margin:0;padding-left:18px}
.bloco h3{margin:10px 0 4px;font-size:13px;font-weight:600;color:var(--txt)}
.openbot-item{padding:8px 0;border-bottom:1px solid var(--borda);min-width:0;max-width:100%}.openbot-item:last-child{border:0}
.openbot-topo{display:flex;flex-wrap:wrap;align-items:center;gap:8px;font-size:12.5px;color:var(--sub);min-width:0;max-width:100%}
.openbot-agente{color:var(--txt);font-weight:600;overflow-wrap:anywhere}
.openbot-texto{margin:2px 0 0;max-width:100%;overflow-wrap:anywhere;word-break:break-word}
.pendente{padding:8px 0;border-bottom:1px solid var(--borda);min-width:0;max-width:100%}.pendente:last-child{border:0}
.pendente p{margin:2px 0 0;max-width:100%;overflow-wrap:anywhere;word-break:break-word}
.pendente-agente{font-weight:600}
.status{font-size:12px;padding:2px 8px;border-radius:999px;background:var(--superficie2);color:var(--sub);white-space:nowrap}
.status.st-ok{background:rgba(79,194,138,.16);color:var(--ok)}
.status.st-erro{background:rgba(239,107,107,.16);color:var(--perigo)}
.status.st-andamento{background:rgba(240,180,76,.16);color:var(--alerta)}
.hora{color:var(--fraco);font-size:12px}
details{margin-top:6px;min-width:0;max-width:100%;overflow-x:auto}summary{cursor:pointer;color:var(--sub);font-size:13px;overflow-wrap:anywhere}
pre,code{max-width:100%;overflow-wrap:anywhere;word-break:break-word}
pre{white-space:pre-wrap;overflow-x:auto}
.resposta{margin:6px 0 0;max-width:100%;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;overflow-x:auto}
:focus-visible{outline:2px solid var(--acento);outline-offset:2px}
@media (hover:hover) and (pointer:fine){.trilho-btn:hover,.agente:hover{background:var(--superficie)}.sugestao:hover{color:var(--txt);border-color:#3a4050}.btn-primario:hover{opacity:.9}}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
@media (max-width:760px){
  .app{grid-template-columns:minmax(0,1fr);grid-template-rows:auto auto minmax(0,1fr);height:100dvh;min-height:100dvh;width:100%;max-width:100%;overflow:hidden}
  .trilho{flex-direction:row;justify-content:flex-start;padding:8px 12px;border-right:0;border-bottom:1px solid var(--borda);width:100%;max-width:100%;min-width:0;overflow-x:auto;overflow-y:hidden}
  .logo{margin:0 8px 0 0}
  .lista{flex-direction:row;padding:8px 12px;gap:6px;width:100%;max-width:100%;min-width:0;overflow-x:auto;overflow-y:hidden}.lista-topo{display:none}
  #agentes{flex-direction:row;gap:6px;min-width:0}
  .agente{width:auto;flex:none;padding:6px 10px;max-width:100%}.agente-estado{display:none}
  .principal{padding:0 12px;min-width:0;max-width:100%;overflow:hidden}
  .cabeca{height:auto;min-height:52px;flex-wrap:wrap;padding:8px 6px;min-width:0}
  .cabeca h1{min-width:0;overflow-wrap:anywhere}
  .voz-grupo{gap:6px;min-width:0}
  .voz-estado{font-size:12px}
  .voz-legenda{margin:0 6px 8px}
  .rolagem{padding:16px 12px}
  .balao{max-width:92%}
  .boas-vindas{padding:20px 0 10px}
  .compositor{flex:none;padding:10px 12px calc(10px + env(safe-area-inset-bottom));position:sticky;bottom:0;z-index:2;background:var(--cartao)}
  .compositor form{width:100%;max-width:100%;min-width:0}
  .compositor textarea{font-size:16px;flex:1 1 auto}
  .compositor .btn{flex:none}
}
@media (max-width:400px){
  .trilho,.lista{padding-left:8px;padding-right:8px}
  .principal{padding:0 8px}
}
`;

// Script da página: sem dependências; todo texto do servidor entra por textContent.
const JS = `
const AGENTES_COR = { night:'#000', radar:'#1f8a70', produto:'#b4672a', campanha:'#b23a6f', codigo:'#4a58c9', video:'#7a4bc2' };
// Servidor antigo ainda não manda \`openbot\`: o painel mostra o OpenBot como desligado, sem quebrar.
const OPENBOT_VAZIO = { ligado:false, motivo:'O NIGHT ainda não lê o OpenBot.', agentes:[], tarefas:[], pendentes:[], relatos:[] };
const STATUS_OPENBOT = { queued:'na fila', starting:'começando', running:'rodando', completed:'pronta', failed:'falhou', interrupted:'interrompida', cancelled:'cancelada' };
const STATUS_CLASSE = { completed:'st-ok', failed:'st-erro', interrupted:'st-erro', cancelled:'st-erro', running:'st-andamento', starting:'st-andamento' };
let estado = null;
let secao = 'agentes';
let tela = 'night';
let enviando = false;

const $ = (s) => document.querySelector(s);
function el(tag, cls, texto) { const e = document.createElement(tag); if (cls) e.className = cls; if (texto != null) e.textContent = texto; return e; }
function avatar(t) { const a = el('span', 'avatar'); a.style.background = AGENTES_COR[t] || '#333'; a.innerHTML = ICONES[t] || ''; return a; }
function quando(em) { const d = new Date(em); return isNaN(d.getTime()) ? 0 : d.getTime(); }
function horaCurta(em) {
  const d = new Date(em);
  if (isNaN(d.getTime())) return String(em || '');
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

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

// ---------- Voz ao vivo (WebRTC direto com a OpenAI; o servidor só troca o SDP) ----------

let vozPc = null;
let vozMic = null;
let vozAudio = null; // elemento <audio> criado uma vez e reaproveitado
let vozSessao = null;
let vozDesde = 0; // maior n de evento já visto
let vozTimer = null;
let vozLigada = false;
let vozConectando = false;
let vozMudo = false;
let vozConsultando = false;
let vozGeracao = 0; // invalida ligações antigas depois de desligar
let vozLegendas = []; // até 2 transcrições

function vozMostrarEstado(texto, erro) {
  const s = $('#voz-estado');
  if (!texto) { s.hidden = true; s.textContent = ''; s.classList.remove('erro'); return; }
  s.hidden = false; s.textContent = texto; s.classList.toggle('erro', !!erro);
}

function vozMostrarBotao(ligado, conectando) {
  const b = $('#voz-btn');
  b.classList.toggle('btn-perigo', ligado);
  b.querySelector('span').textContent = conectando ? 'Conectando…' : (ligado ? 'Desligar' : 'Voz ao vivo');
  b.disabled = !!conectando;
  b.setAttribute('aria-pressed', ligado ? 'true' : 'false');
}

function vozDesenharLegenda() {
  const l = $('#voz-legenda');
  l.replaceChildren();
  if (!vozLigada || vozLegendas.length === 0) { l.hidden = true; return; }
  for (const t of vozLegendas) {
    const d = el('div', 'voz-linha');
    d.append(el('strong', 'voz-quem', t.papel === 'voce' ? 'Você:' : 'NIGHT:'), document.createTextNode(' ' + t.texto));
    l.append(d);
  }
  l.hidden = false;
}

// Para tudo que é local, sem falar com o servidor (quem chama decide se avisa o /api/voz/parar).
function vozPararLocal() {
  vozGeracao++;
  if (vozTimer) { clearInterval(vozTimer); vozTimer = null; }
  if (vozMic) { for (const t of vozMic.getTracks()) t.stop(); vozMic = null; }
  if (vozPc) { try { vozPc.close(); } catch (e) { /* já fechado */ } vozPc = null; }
  if (vozAudio) { try { vozAudio.pause(); } catch (e) { /* sem áudio */ } vozAudio.srcObject = null; }
  vozSessao = null; vozLigada = false; vozConectando = false; vozMudo = false;
  vozDesde = 0; vozLegendas = [];
  const m = $('#voz-mudo'); m.hidden = true; m.textContent = 'Mudo'; m.classList.remove('mudo');
  vozMostrarBotao(false, false);
  vozDesenharLegenda();
}

async function desligar(erro) {
  const sessao = vozSessao;
  const estava = vozLigada || vozConectando;
  vozPararLocal();
  if (erro) vozMostrarEstado('Erro: ' + erro, true);
  else vozMostrarEstado(null);
  if (estava && sessao) { try { await postar('/api/voz/parar', { sessionId: sessao }); } catch (e) { /* servidor fora do ar */ } }
}

function esperarIce(pc, ms) {
  return new Promise((ok) => {
    if (pc.iceGatheringState === 'complete') return ok();
    let timer = null;
    let fim = false;
    const terminar = () => {
      if (fim) return;
      fim = true;
      if (timer) clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', conferir);
      ok();
    };
    const conferir = () => { if (pc.iceGatheringState === 'complete') terminar(); };
    timer = setTimeout(terminar, ms);
    pc.addEventListener('icegatheringstatechange', conferir);
  });
}

async function ligar() {
  if (vozLigada || vozConectando) return;
  const g = ++vozGeracao;
  vozConectando = true;
  vozMostrarBotao(false, true);
  vozMostrarEstado('Conectando…');
  try {
    let mic;
    try {
      mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (e) {
      if (g !== vozGeracao) return;
      throw new Error('o navegador não deu acesso ao microfone');
    }
    if (g !== vozGeracao) { for (const t of mic.getTracks()) t.stop(); return; }
    vozMic = mic;

    const pc = new RTCPeerConnection();
    vozPc = pc;
    for (const t of mic.getTracks()) pc.addTrack(t, mic);
    pc.createDataChannel('oai-events');
    pc.ontrack = (e) => {
      if (!vozAudio) {
        vozAudio = document.createElement('audio');
        vozAudio.autoplay = true;
        vozAudio.setAttribute('playsinline', '');
        vozAudio.style.display = 'none';
        document.body.append(vozAudio);
      }
      vozAudio.srcObject = e.streams[0];
      const p = vozAudio.play();
      if (p && p.catch) p.catch(() => vozMostrarEstado('Erro: o navegador bloqueou o som. Clique na página e tente de novo.', true));
    };
    pc.onconnectionstatechange = () => {
      if (pc !== vozPc) return;
      if (pc.connectionState === 'failed') desligar('a conexão de áudio caiu');
    };

    const oferta = await pc.createOffer();
    if (g !== vozGeracao) return;
    await pc.setLocalDescription(oferta);
    await esperarIce(pc, 2000);
    if (g !== vozGeracao) return;

    const r = await postar('/api/voz/iniciar', { sdp: pc.localDescription.sdp });
    if (g !== vozGeracao) {
      if (r && r.sessionId) postar('/api/voz/parar', { sessionId: r.sessionId }).catch(() => {});
      return;
    }
    // Guarda a sessão já: se algo falhar daqui em diante, o desligar avisa o servidor e o Codex não fica aberto.
    if (r && r.sessionId) vozSessao = r.sessionId;
    if (!r || !r.sdp || !r.sessionId) throw new Error((r && r.texto) ? r.texto : 'o NIGHT não abriu a voz');

    await pc.setRemoteDescription({ type: 'answer', sdp: r.sdp });
    if (g !== vozGeracao) { postar('/api/voz/parar', { sessionId: r.sessionId }).catch(() => {}); return; }

    vozSessao = r.sessionId;
    vozLigada = true;
    vozConectando = false;
    vozMostrarBotao(true, false);
    const m = $('#voz-mudo'); m.hidden = false; m.textContent = 'Mudo';
    vozMostrarEstado('Ouvindo');
    vozTimer = setInterval(consultarEventos, 1000);
    consultarEventos();
  } catch (e) {
    if (g !== vozGeracao) return;
    await desligar(e && e.message ? e.message : String(e));
  }
}

async function consultarEventos() {
  if (!vozLigada || vozConsultando) return;
  vozConsultando = true;
  const g = vozGeracao;
  try {
    // Servidor travado não pode prender a consulta: 8 s e tenta no próximo ciclo.
    const r = await Promise.race([postar('/api/voz/eventos', { desde: vozDesde }), new Promise((_, falha) => setTimeout(() => falha(new Error('demorou')), 8000))]);
    if (g !== vozGeracao || !vozLigada) return;
    const eventos = (r && Array.isArray(r.eventos)) ? r.eventos : [];
    for (const ev of eventos) {
      if (typeof ev.n === 'number' && ev.n > vozDesde) vozDesde = ev.n;
      if (ev.tipo === 'transcricao') {
        vozLegendas.push({ papel: ev.papel, texto: String(ev.texto || '') });
        if (vozLegendas.length > 2) vozLegendas.shift();
        vozDesenharLegenda();
      } else if (ev.tipo === 'pedido' || ev.tipo === 'resposta') {
        carregar(); // a conversa do NIGHT no painel recebe o pedido e a resposta pelo servidor
      } else if (ev.tipo === 'fim') {
        desligar(ev.erro || null);
        return;
      }
    }
    if (r && r.ativa === false && eventos.length === 0) desligar(null); // a sessão sumiu (servidor reiniciou?)
  } catch (e) {
    // servidor reiniciando: tenta de novo no próximo ciclo
  } finally {
    vozConsultando = false;
  }
}

$('#voz-btn').onclick = () => { if (vozLigada) desligar(null); else ligar(); };
$('#voz-mudo').onclick = () => {
  if (!vozMic) return;
  vozMudo = !vozMudo;
  for (const t of vozMic.getAudioTracks()) t.enabled = !vozMudo;
  const m = $('#voz-mudo'); m.textContent = vozMudo ? 'Som' : 'Mudo'; m.classList.toggle('mudo', vozMudo);
  vozMostrarEstado(vozMudo ? 'Mudo' : 'Ouvindo');
};

// Fechou a página: avisa o servidor com keepalive (sendBeacon não manda JSON+token do jeito que a rota exige).
window.addEventListener('pagehide', () => {
  if (!vozSessao) return;
  try {
    fetch('/api/voz/parar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: vozSessao, token: TOKEN }),
      keepalive: true
    });
  } catch (e) { /* a página já está indo embora */ }
});

function desenhar() {
  if (!estado) return;
  const n = estado.decisoes.length;
  const c = $('#contador'); c.hidden = n === 0; c.textContent = String(n);
  const ob = estado.openbot || OPENBOT_VAZIO;
  const nOb = Array.isArray(ob.pendentes) ? ob.pendentes.length : 0;
  const co = $('#contador-openbot'); co.hidden = nOb === 0; co.textContent = String(nOb);
  document.querySelectorAll('.trilho-btn').forEach((b) => b.classList.toggle('ativo', b.dataset.secao === secao));
  desenharLista();
  if (secao === 'agentes') desenharAgente();
  else if (secao === 'decisoes') desenharDecisoes();
  else if (secao === 'openbot') desenharOpenBot();
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

function desenharOpenBot(retorno) {
  const ob = estado.openbot || OPENBOT_VAZIO;
  const agentes = Array.isArray(ob.agentes) ? ob.agentes : [];
  const tarefas = Array.isArray(ob.tarefas) ? ob.tarefas : [];
  const pendentes = Array.isArray(ob.pendentes) ? ob.pendentes : [];
  const relatos = Array.isArray(ob.relatos) ? ob.relatos : [];
  cabeca('OpenBot', null, ob.ligado ? 'ligado' : 'desligado');
  const vista = $('#vista'); vista.replaceChildren();
  const rol = el('div', 'rolagem'); const miolo = el('div', 'miolo'); rol.append(miolo);
  if (retorno) miolo.append(el('div', 'bloco retorno', retorno));

  if (!ob.ligado) {
    const b = el('div', 'bloco');
    b.append(el('h2', null, 'OpenBot desligado'), el('p', null, ob.motivo || 'O OpenBot não está ligado.'));
    b.append(el('h3', null, 'Como ligar'));
    const passos = el('ol');
    passos.append(
      el('li', null, 'Abra o OpenBot.'),
      el('li', null, 'Em cada agente: Configurações -> Permissões -> Local scripts (ligar).'),
      el('li', null, 'Para as telas falarem com o NIGHT: Marketplace -> Apps -> servidor por URL, nome night, URL http://127.0.0.1:4517/mcp.'),
      el('li', null, 'Segurança: em cada agente, acesso com aprovação (não "total") e controle do computador desligado. O NIGHT pode mandar tarefas a eles.'),
    );
    b.append(passos); miolo.append(b);
  }

  const bp = el('div', 'bloco');
  bp.append(el('h2', null, 'Esperando você'));
  if (!pendentes.length) bp.append(el('p', 'vazio', 'Nada esperando você.'));
  for (const p of pendentes) {
    const item = el('div', 'pendente');
    item.append(el('div', 'pendente-agente', p.agente), el('p', null, p.texto));
    if (p.tipo === 'aprovacao') {
      const acoes = el('div', 'acoes');
      const aceitar = el('button', 'btn btn-ok', 'Aceitar');
      const recusar = el('button', 'btn btn-perigo', 'Recusar');
      const responder = async (decisao) => {
        aceitar.disabled = true; recusar.disabled = true;
        const r = await postar('/api/openbot/responder', { agenteId: p.agenteId, pedidoId: p.id, decisao });
        await carregar();
        if (secao === 'openbot') desenharOpenBot((r && r.texto) ? r.texto : 'Feito.');
      };
      aceitar.onclick = () => responder('accept');
      recusar.onclick = () => responder('decline');
      acoes.append(aceitar, recusar); item.append(acoes);
    } else {
      item.append(el('p', 'vazio', 'Responda no OpenBot'));
    }
    bp.append(item);
  }
  miolo.append(bp);

  const bt = el('div', 'bloco');
  bt.append(el('h2', null, 'Tarefas que o NIGHT mandou'));
  if (!tarefas.length) bt.append(el('p', 'vazio', 'Nenhuma tarefa mandada ainda.'));
  for (const t of tarefas) {
    const item = el('div', 'openbot-item');
    const topo = el('div', 'openbot-topo');
    topo.append(el('span', 'openbot-agente', t.agente));
    topo.append(el('span', 'status ' + (STATUS_CLASSE[t.status] || ''), STATUS_OPENBOT[t.status] || t.status));
    topo.append(el('span', 'hora', horaCurta(t.em)));
    item.append(topo, el('p', 'openbot-texto', t.texto));
    const resposta = t.resposta || t.erro;
    if (resposta) {
      const d = el('details');
      d.append(el('summary', null, 'Resposta'), el('div', 'resposta', resposta));
      item.append(d);
    }
    bt.append(item);
  }
  miolo.append(bt);

  const br = el('div', 'bloco');
  br.append(el('h2', null, 'O que as telas fizeram'));
  if (!relatos.length) br.append(el('p', 'vazio', 'Nenhum relato das telas ainda.'));
  for (const r of relatos.slice().sort((a, b) => quando(b.em) - quando(a.em))) {
    const item = el('div', 'openbot-item');
    const topo = el('div', 'openbot-topo');
    topo.append(el('span', 'openbot-agente', r.tela), el('span', 'hora', horaCurta(r.em)));
    item.append(topo, el('p', 'openbot-texto', r.texto));
    br.append(item);
  }
  miolo.append(br);

  const ba = el('div', 'bloco');
  ba.append(el('h2', null, 'Agentes com automação ligada'));
  if (!agentes.length) ba.append(el('p', 'vazio', 'Nenhum agente com automação ligada.'));
  else {
    const ul = el('ul');
    for (const a of agentes) ul.append(el('li', null, a.nome));
    ba.append(ul);
  }
  miolo.append(ba);

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
