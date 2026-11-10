'use strict';
const { esc } = require('../util');

/** Avatar por defecto de Grace: una esmeralda tallada con su inicial. */
const DEFAULT_AVATAR = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120">
<defs>
  <linearGradient id="a" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#a7f3d0"/><stop offset=".45" stop-color="#10b981"/><stop offset="1" stop-color="#022c22"/></linearGradient>
  <linearGradient id="b" x1="1" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ecfdf5" stop-opacity=".9"/><stop offset="1" stop-color="#34d399" stop-opacity="0"/></linearGradient>
</defs>
<rect width="120" height="120" fill="#011a13"/>
<polygon points="60,10 100,32 100,88 60,110 20,88 20,32" fill="url(#a)"/>
<polygon points="60,10 100,32 60,46 20,32" fill="url(#b)" opacity=".75"/>
<polygon points="20,32 60,46 60,110 20,88" fill="#064e3b" opacity=".45"/>
<polygon points="60,46 100,32 100,88 60,110" fill="#047857" opacity=".35"/>
<text x="60" y="78" text-anchor="middle" font-family="Georgia, serif" font-size="40" font-weight="700" fill="#ecfdf5" opacity=".95">G</text>
</svg>`;

const SUGERENCIAS = [
  '¿Cuántos vinieron el último servicio?',
  '¿Qué grupos no reportaron esta semana?',
  '¿Quién cumple años hoy?',
  '¿Quiénes se convirtieron el domingo?',
  'Resumen de los grupos de cuidado',
  'Bautizados de este mes',
];

function gracePage({ config }) {
  const church = esc(config.churchName || '');
  return `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#022c22">
<link rel="icon" href="/grace/avatar">
<title>Grace · ${church}</title>
<style>
:root{
  --deep:#010f0b; --e900:#022c22; --e800:#064e3b; --e700:#047857; --e500:#10b981; --e400:#34d399; --e300:#6ee7b7; --e200:#a7f3d0; --e50:#ecfdf5;
  --glass:rgba(16,185,129,.10); --glass-2:rgba(167,243,208,.08); --edge:rgba(110,231,183,.28); --text:#e9fff6; --muted:rgba(209,250,229,.62);
}
*{box-sizing:border-box}
html,body{height:100%;margin:0}
body{background:var(--deep);color:var(--text);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;overflow:hidden;-webkit-font-smoothing:antialiased}
/* fondo: una esmeralda vista por dentro, con facetas y un brillo que pasa lento */
.bg{position:fixed;inset:0;z-index:0;background:
  radial-gradient(120% 70% at 50% -10%,rgba(52,211,153,.35),transparent 60%),
  radial-gradient(80% 60% at 110% 110%,rgba(4,120,87,.45),transparent 60%),
  radial-gradient(70% 50% at -10% 80%,rgba(6,78,59,.6),transparent 60%),
  linear-gradient(180deg,#02261c 0%,#011510 60%,#010b08 100%)}
.bg::before{content:"";position:absolute;inset:-20%;opacity:.22;background:
  conic-gradient(from 30deg at 30% 20%,transparent 0 40deg,rgba(167,243,208,.35) 40deg 46deg,transparent 46deg 140deg,rgba(52,211,153,.25) 140deg 150deg,transparent 150deg),
  conic-gradient(from 200deg at 75% 65%,transparent 0 60deg,rgba(110,231,183,.3) 60deg 68deg,transparent 68deg 200deg,rgba(16,185,129,.22) 200deg 214deg,transparent 214deg);
  filter:blur(1px)}
.bg::after{content:"";position:absolute;inset:0;background:linear-gradient(115deg,transparent 35%,rgba(236,253,245,.07) 48%,transparent 60%);background-size:250% 100%;animation:shine 14s linear infinite}
@keyframes shine{from{background-position:150% 0}to{background-position:-100% 0}}
.app{position:relative;z-index:1;display:flex;flex-direction:column;height:100%;max-width:880px;margin:0 auto;
  border-left:1px solid rgba(110,231,183,.08);border-right:1px solid rgba(110,231,183,.08);background:rgba(1,20,15,.25)}
/* cabecera de cristal */
header{display:flex;align-items:center;gap:12px;padding:calc(10px + env(safe-area-inset-top)) 14px 10px;
  background:linear-gradient(180deg,rgba(6,78,59,.55),rgba(2,44,34,.35));backdrop-filter:blur(18px) saturate(140%);-webkit-backdrop-filter:blur(18px) saturate(140%);
  border-bottom:1px solid var(--edge);box-shadow:0 8px 30px rgba(0,0,0,.35),inset 0 -1px 0 rgba(236,253,245,.06)}
.back{color:var(--e200);text-decoration:none;font-size:22px;line-height:1;padding:6px 4px;opacity:.85}
.back:hover{opacity:1}
.avatar{position:relative;width:46px;height:46px;flex:0 0 46px;border-radius:50%;padding:2px;cursor:pointer;border:0;
  background:conic-gradient(from var(--ang,0deg),#a7f3d0,#10b981,#022c22,#34d399,#ecfdf5,#a7f3d0);animation:spin 6s linear infinite;box-shadow:0 0 18px rgba(52,211,153,.45)}
@property --ang{syntax:"<angle>";inherits:false;initial-value:0deg}
@keyframes spin{to{--ang:360deg}}
.avatar img{display:block;width:100%;height:100%;border-radius:50%;object-fit:cover;background:var(--e900)}
.avatar::after{content:"";position:absolute;right:1px;bottom:1px;width:11px;height:11px;border-radius:50%;background:var(--e400);box-shadow:0 0 0 2px #022c22,0 0 10px var(--e400)}
.who{flex:1;min-width:0}
.who b{display:block;font-size:17px;letter-spacing:.02em;background:linear-gradient(90deg,#ecfdf5,#6ee7b7);-webkit-background-clip:text;background-clip:text;color:transparent}
.who small{display:block;color:var(--muted);font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.menu-btn{background:transparent;border:0;color:var(--e200);font-size:22px;cursor:pointer;padding:6px 8px;border-radius:10px}
.menu-btn:hover{background:rgba(110,231,183,.1)}
.menu{position:absolute;right:14px;top:calc(60px + env(safe-area-inset-top));z-index:5;min-width:220px;padding:6px;border-radius:14px;
  background:rgba(2,44,34,.85);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);border:1px solid var(--edge);box-shadow:0 20px 50px rgba(0,0,0,.5)}
.menu button{display:block;width:100%;text-align:left;background:transparent;border:0;color:var(--text);font:inherit;padding:10px 12px;border-radius:10px;cursor:pointer}
.menu button:hover{background:rgba(110,231,183,.12)}
[hidden]{display:none!important}
/* conversación */
main{flex:1;overflow-y:auto;padding:18px 14px 8px;scroll-behavior:smooth}
main::-webkit-scrollbar{width:8px}main::-webkit-scrollbar-thumb{background:rgba(110,231,183,.18);border-radius:8px}
.day{display:flex;justify-content:center;margin:6px 0 14px}
.day span{font-size:12px;color:var(--e200);padding:4px 12px;border-radius:999px;background:rgba(6,78,59,.55);border:1px solid rgba(110,231,183,.18);backdrop-filter:blur(8px)}
.row{display:flex;margin:6px 0;animation:rise .28s ease-out both}
@keyframes rise{from{opacity:0;transform:translateY(8px) scale(.98)}to{opacity:1;transform:none}}
.row.yo{justify-content:flex-end}
.bub{position:relative;max-width:min(78%,560px);padding:9px 12px 20px;border-radius:16px;word-wrap:break-word;overflow-wrap:anywhere}
.grace .bub{border-top-left-radius:5px;background:linear-gradient(160deg,rgba(16,185,129,.16),rgba(2,44,34,.55));border:1px solid var(--edge);
  backdrop-filter:blur(14px) saturate(130%);-webkit-backdrop-filter:blur(14px) saturate(130%);box-shadow:0 6px 24px rgba(0,0,0,.28),inset 0 1px 0 rgba(236,253,245,.10)}
.yo .bub{border-top-right-radius:5px;color:#012018;background:linear-gradient(140deg,#d1fae5 0%,#6ee7b7 35%,#10b981 100%);
  box-shadow:0 8px 26px rgba(16,185,129,.35),inset 0 1px 0 rgba(255,255,255,.7),inset 0 -8px 18px rgba(4,120,87,.25)}
.yo .bub::before{content:"";position:absolute;inset:0;border-radius:inherit;background:linear-gradient(120deg,rgba(255,255,255,.45),transparent 40%);pointer-events:none}
.bub time{position:absolute;right:10px;bottom:4px;font-size:11px;opacity:.6}
.bub strong{color:var(--e200)}.yo .bub strong{color:#013b2b}
.bub ul{margin:4px 0;padding-left:18px}
.typing .bub{padding:12px 16px}
.dots{display:inline-flex;gap:5px}
.dots i{width:7px;height:7px;border-radius:50%;background:var(--e300);box-shadow:0 0 8px var(--e400);animation:blink 1.2s infinite}
.dots i:nth-child(2){animation-delay:.2s}.dots i:nth-child(3){animation-delay:.4s}
@keyframes blink{0%,80%,100%{opacity:.25;transform:translateY(0)}40%{opacity:1;transform:translateY(-3px)}}
.err .bub{border-color:rgba(252,165,165,.45);background:linear-gradient(160deg,rgba(127,29,29,.35),rgba(2,44,34,.55))}
/* bienvenida */
.hello{text-align:center;padding:26px 10px 8px;color:var(--muted)}
.hello .gem{width:84px;height:84px;margin:0 auto 12px;border-radius:50%;padding:3px;background:conic-gradient(from var(--ang,0deg),#a7f3d0,#10b981,#022c22,#34d399,#ecfdf5,#a7f3d0);animation:spin 6s linear infinite;box-shadow:0 0 40px rgba(52,211,153,.4)}
.hello .gem img{width:100%;height:100%;border-radius:50%;object-fit:cover}
.hello h1{margin:0 0 4px;font-size:22px;color:var(--e50);font-weight:650}
/* sugerencias y escritura */
.chips{display:flex;gap:8px;overflow-x:auto;padding:6px 14px 8px;scrollbar-width:none}
.chips::-webkit-scrollbar{display:none}
.chip{flex:0 0 auto;font:inherit;font-size:13px;color:var(--e50);cursor:pointer;padding:7px 13px;border-radius:999px;border:1px solid var(--edge);
  background:linear-gradient(160deg,rgba(52,211,153,.16),rgba(2,44,34,.5));backdrop-filter:blur(10px);transition:transform .15s,box-shadow .15s}
.chip:hover{transform:translateY(-1px);box-shadow:0 0 16px rgba(52,211,153,.35)}
footer{display:flex;align-items:flex-end;gap:10px;padding:8px 12px calc(10px + env(safe-area-inset-bottom));
  background:linear-gradient(0deg,rgba(2,44,34,.75),rgba(2,44,34,.35));backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);border-top:1px solid var(--edge)}
.box{flex:1;display:flex;border-radius:24px;padding:4px 6px 4px 14px;background:rgba(1,26,19,.65);border:1px solid var(--edge);box-shadow:inset 0 1px 6px rgba(0,0,0,.4)}
.box:focus-within{border-color:var(--e300);box-shadow:inset 0 1px 6px rgba(0,0,0,.4),0 0 0 3px rgba(52,211,153,.18)}
textarea{flex:1;resize:none;border:0;outline:0;background:transparent;color:var(--text);font:inherit;max-height:140px;padding:9px 0;line-height:1.4}
textarea::placeholder{color:rgba(209,250,229,.45)}
.send{flex:0 0 48px;width:48px;height:48px;border:0;cursor:pointer;color:#012018;font-size:20px;display:grid;place-items:center;
  clip-path:polygon(50% 0,93% 25%,93% 75%,50% 100%,7% 75%,7% 25%);background:linear-gradient(140deg,#ecfdf5,#34d399 45%,#047857);
  box-shadow:0 0 22px rgba(52,211,153,.55);transition:transform .15s,filter .15s}
.send:hover{transform:scale(1.06);filter:brightness(1.08)}
.send:disabled{filter:grayscale(.6) brightness(.7);cursor:default;transform:none}
.note{font-size:11.5px;color:var(--muted);text-align:center;padding:0 0 6px}
@media (max-width:640px){.bub{max-width:86%}.app{border:0}}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
</style></head><body>
<div class="bg"></div>
<div class="app">
  <header>
    <a class="back" href="/" title="Volver al CRM" aria-label="Volver al CRM">‹</a>
    <button class="avatar" id="avatarBtn" title="Cambiar el avatar de Grace" aria-label="Cambiar el avatar de Grace"><img id="avatarImg" src="/grace/avatar" alt=""></button>
    <div class="who"><b>Grace</b><small id="status">en línea · consultas de ${church}</small></div>
    <button class="menu-btn" id="menuBtn" aria-label="Más opciones" aria-expanded="false">⋮</button>
    <div class="menu" id="menu" hidden>
      <button data-act="avatar">Cambiar el avatar de Grace</button>
      <button data-act="quitar">Volver al avatar original</button>
      <button data-act="limpiar">Borrar esta conversación</button>
    </div>
  </header>
  <main id="chat" aria-live="polite">
    <div class="hello" id="hello">
      <div class="gem"><img src="/grace/avatar" alt="" class="avatarCopy"></div>
      <h1>Hola, soy Grace</h1>
      <div>Pregúntame por la asistencia, los grupos de cuidado y sus reportes, los nuevos creyentes, los bautizos, los eventos o los cumpleaños.</div>
    </div>
  </main>
  <div class="chips" id="chips">${SUGERENCIAS.map((s) => `<button class="chip" type="button">${esc(s)}</button>`).join('')}</div>
  <footer>
    <div class="box"><textarea id="msg" rows="1" placeholder="Escribe un mensaje" maxlength="1000" aria-label="Mensaje para Grace"></textarea></div>
    <button class="send" id="send" aria-label="Enviar">➤</button>
  </footer>
  <div class="note">Solo lectura · nunca muestra teléfonos, direcciones ni cédulas</div>
</div>
<input type="file" id="file" accept="image/png,image/jpeg,image/webp" hidden>
<script>
(function () {
  var chat = document.getElementById('chat'), msg = document.getElementById('msg'), send = document.getElementById('send');
  var hello = document.getElementById('hello'), menu = document.getElementById('menu'), menuBtn = document.getElementById('menuBtn');
  var lastDay = '';
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  // formato de WhatsApp: *negrita*, _cursiva_, listas con guion y saltos de línea
  function fmt(t) {
    var lines = esc(t).split('\\n'), out = [], list = false;
    lines.forEach(function (l) {
      var m = /^\\s*[-•]\\s+(.*)$/.exec(l);
      if (m) { if (!list) { out.push('<ul>'); list = true; } out.push('<li>' + m[1] + '</li>'); return; }
      if (list) { out.push('</ul>'); list = false; if (!l.trim()) return; }
      out.push(l + '<br>');
    });
    if (list) out.push('</ul>');
    return out.join('').replace(/(<br>)+$/, '').replace(/\\*([^*\\n]+)\\*/g, '<strong>$1</strong>').replace(/(^|[\\s>])_([^_\\n]+)_/g, '$1<em>$2</em>');
  }
  function hhmm(d) { return d.toLocaleTimeString('es-VE', { hour: 'numeric', minute: '2-digit' }); }
  function dayLabel(d) {
    var t = new Date(), y = new Date(Date.now() - 864e5);
    if (d.toDateString() === t.toDateString()) return 'Hoy';
    if (d.toDateString() === y.toDateString()) return 'Ayer';
    return d.toLocaleDateString('es-VE', { weekday: 'long', day: 'numeric', month: 'long' });
  }
  function add(who, text, when, extra) {
    hello.hidden = true;
    var d = when ? new Date(when) : new Date();
    var key = d.toDateString();
    if (key !== lastDay) { lastDay = key; var sep = document.createElement('div'); sep.className = 'day'; sep.innerHTML = '<span>' + esc(dayLabel(d)) + '</span>'; chat.appendChild(sep); }
    var row = document.createElement('div');
    row.className = 'row ' + (who === 'yo' ? 'yo' : 'grace') + (extra ? ' ' + extra : '');
    row.innerHTML = '<div class="bub">' + fmt(text) + '<time>' + hhmm(d) + '</time></div>';
    chat.appendChild(row);
    chat.scrollTop = chat.scrollHeight;
    return row;
  }
  function typing(on) {
    var t = document.getElementById('typing');
    if (on && !t) { t = document.createElement('div'); t.id = 'typing'; t.className = 'row grace typing'; t.innerHTML = '<div class="bub"><span class="dots"><i></i><i></i><i></i></span></div>'; chat.appendChild(t); chat.scrollTop = chat.scrollHeight; }
    if (!on && t) t.remove();
    document.getElementById('status').textContent = on ? 'consultando…' : 'en línea · consultas de ${church}';
  }
  function post(url, body) {
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (r.status === 401) location.href = '/entrar'; return { ok: r.ok, j: j }; }); });
  }
  var busy = false;
  function ask(text) {
    text = String(text || '').trim();
    if (!text || busy) return;
    busy = true; send.disabled = true;
    add('yo', text);
    msg.value = ''; grow();
    typing(true);
    post('/grace/mensaje', { texto: text }).then(function (r) {
      typing(false);
      if (r.ok) add('grace', r.j.respuesta);
      else add('grace', r.j.error || 'Grace no pudo responder ahora.', null, 'err');
    }).catch(function () { typing(false); add('grace', 'Se perdió la conexión. Intenta de nuevo.', null, 'err'); })
      .then(function () { busy = false; send.disabled = false; msg.focus(); });
  }
  function grow() { msg.style.height = 'auto'; msg.style.height = Math.min(msg.scrollHeight, 140) + 'px'; }
  msg.addEventListener('input', grow);
  msg.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(msg.value); } });
  send.addEventListener('click', function () { ask(msg.value); });
  document.getElementById('chips').addEventListener('click', function (e) { if (e.target.classList.contains('chip')) ask(e.target.textContent); });

  // menú y avatar
  function toggleMenu(open) { menu.hidden = !open; menuBtn.setAttribute('aria-expanded', open ? 'true' : 'false'); }
  menuBtn.addEventListener('click', function (e) { e.stopPropagation(); toggleMenu(menu.hidden); });
  document.addEventListener('click', function (e) { if (!menu.contains(e.target)) toggleMenu(false); });
  var file = document.getElementById('file');
  document.getElementById('avatarBtn').addEventListener('click', function () { file.click(); });
  function refreshAvatar() { var u = '/grace/avatar?v=' + Date.now(); document.getElementById('avatarImg').src = u; Array.prototype.forEach.call(document.querySelectorAll('.avatarCopy'), function (i) { i.src = u; }); }
  menu.addEventListener('click', function (e) {
    var act = e.target.getAttribute('data-act'); if (!act) return; toggleMenu(false);
    if (act === 'avatar') file.click();
    if (act === 'quitar') post('/grace/avatar/borrar').then(refreshAvatar);
    if (act === 'limpiar' && confirm('Se borra esta conversación con Grace. ¿Continuar?')) post('/grace/limpiar').then(function () { location.reload(); });
  });
  // la imagen se recorta en cuadrado y se reduce a 320 px en el navegador antes de subirla
  file.addEventListener('change', function () {
    var f = file.files && file.files[0]; if (!f) return;
    var img = new Image(), url = URL.createObjectURL(f);
    img.onload = function () {
      var s = Math.min(img.width, img.height), c = document.createElement('canvas'); c.width = c.height = 320;
      c.getContext('2d').drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, 320, 320);
      URL.revokeObjectURL(url);
      post('/grace/avatar', { imagen: c.toDataURL('image/jpeg', 0.86) }).then(function (r) { if (r.ok) refreshAvatar(); else alert(r.j.error || 'No se pudo guardar la imagen.'); });
    };
    img.onerror = function () { alert('No se pudo leer esa imagen.'); };
    img.src = url; file.value = '';
  });

  fetch('/grace/historial', { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (j) {
    (j.mensajes || []).forEach(function (m) { add(m.de, m.texto, m.cuando); });
    if (!j.listo) add('grace', 'Todavía falta la clave del modelo en Configuración → Asistente.', null, 'err');
  }).catch(function () {});
  msg.focus();
})();
</script>
</body></html>`;
}

module.exports = { gracePage, DEFAULT_AVATAR, SUGERENCIAS };
