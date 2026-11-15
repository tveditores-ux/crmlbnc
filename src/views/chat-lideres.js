'use strict';
const { esc } = require('../util');
const { DEFAULT_AVATAR } = require('./grace-remoto');

/**
 * La app del chat de líderes: una PWA sencilla (se agrega a la pantalla de inicio y avisa con
 * notificaciones propias cuando alguien escribe). Cada líder entra con su enlace personal.
 */

function invalidPage() {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Enlace no válido</title><style>body{font:16px/1.6 system-ui,sans-serif;background:#022c22;color:#ecfdf5;display:grid;place-items:center;min-height:100vh;margin:0;padding:20px;text-align:center}</style></head>
<body><div><h1>Enlace no válido</h1><p>Este enlace del chat de líderes no existe o fue apagado.<br>Pídele uno nuevo a la iglesia.</p></div></body></html>`;
}

function manifest({ config, token }) {
  return {
    name: `Chat de líderes · ${config.churchName}`,
    short_name: 'Líderes',
    description: 'El chat de los líderes y servidores de la iglesia, con Grace.',
    start_url: `/chat/${token}`,
    scope: `/chat/${token}/`,
    display: 'standalone',
    background_color: '#022c22',
    theme_color: '#022c22',
    icons: [
      { src: `/chat/${token}/icono-192.png`, sizes: '192x192', type: 'image/png' },
      { src: `/chat/${token}/icono-512.png`, sizes: '512x512', type: 'image/png' },
    ],
  };
}

function serviceWorkerJs() {
  return `'use strict';
self.addEventListener('push', (event) => {
  let data = { title: 'Chat de líderes', body: 'Tienes un mensaje nuevo.', url: '/' };
  try { data = Object.assign(data, event.data ? event.data.json() : {}); } catch (e) { /* cuerpo ilegible */ }
  event.waitUntil(self.registration.showNotification(data.title, {
    body: data.body,
    icon: data.url + '/icono-192.png',
    badge: data.url + '/icono-192.png',
    data: { url: data.url },
    tag: 'chat-lideres',
    renotify: true,
  }));
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) { if (c.url.includes('/chat/') && 'focus' in c) return c.focus(); }
    return clients.openWindow(url);
  }));
});
self.addEventListener('fetch', () => { /* sin caché: el chat siempre va a la red */ });
`;
}

function chatPage({ config, person, token }) {
  const church = esc(config.churchName || '');
  const first = esc(String(person.full_name || '').split(' ')[0]);
  const base = `/chat/${token}`;
  return `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#022c22">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Líderes">
<link rel="manifest" href="${base}/manifest.webmanifest">
<link rel="apple-touch-icon" href="${base}/icono-192.png">
<link rel="icon" href="${base}/icono-192.png">
<title>Chat de líderes · ${church}</title>
<style>
:root{--deep:#010f0b;--e900:#022c22;--e800:#064e3b;--e500:#10b981;--e400:#34d399;--e300:#6ee7b7;--e200:#a7f3d0;--e50:#ecfdf5;--edge:rgba(110,231,183,.28);--text:#e9fff6;--muted:rgba(209,250,229,.62)}
*{box-sizing:border-box}html,body{height:100%;margin:0}
body{background:var(--deep);color:var(--text);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;overflow:hidden;-webkit-font-smoothing:antialiased}
.bg{position:fixed;inset:0;z-index:0;background:radial-gradient(120% 70% at 50% -10%,rgba(52,211,153,.35),transparent 60%),radial-gradient(80% 60% at 110% 110%,rgba(4,120,87,.45),transparent 60%),linear-gradient(180deg,#02261c 0%,#011510 60%,#010b08 100%)}
.app{position:relative;z-index:1;display:flex;flex-direction:column;height:100%;max-width:880px;margin:0 auto;background:rgba(1,20,15,.25)}
header{display:flex;align-items:center;gap:12px;padding:calc(10px + env(safe-area-inset-top)) 14px 10px;background:linear-gradient(180deg,rgba(6,78,59,.55),rgba(2,44,34,.35));backdrop-filter:blur(18px);border-bottom:1px solid var(--edge)}
.avatar{width:46px;height:46px;flex:0 0 46px;border-radius:50%;overflow:hidden;box-shadow:0 0 18px rgba(52,211,153,.45)}
.avatar svg{width:100%;height:100%;display:block}
.who{flex:1;min-width:0}.who b{display:block;font-size:17px}.who small{display:block;color:var(--muted);font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bell{background:transparent;border:1px solid var(--edge);color:var(--e200);font-size:17px;cursor:pointer;padding:8px 11px;border-radius:999px}
.bell.on{background:rgba(16,185,129,.25);color:var(--e50)}
main{flex:1;overflow-y:auto;padding:18px 14px 8px;scroll-behavior:smooth}
.day{display:flex;justify-content:center;margin:6px 0 14px}.day span{font-size:12px;color:var(--e200);padding:4px 12px;border-radius:999px;background:rgba(6,78,59,.55);border:1px solid rgba(110,231,183,.18)}
.row{display:flex;margin:6px 0;flex-direction:column}
.row.yo{align-items:flex-end}.row.otro,.row.grace{align-items:flex-start}
.autor{font-size:12px;margin:0 4px 2px;font-weight:650}
.bub{position:relative;max-width:min(80%,560px);padding:9px 12px 20px;border-radius:16px;word-wrap:break-word;overflow-wrap:anywhere}
.otro .bub{border-top-left-radius:5px;background:linear-gradient(160deg,rgba(236,253,245,.10),rgba(2,44,34,.55));border:1px solid rgba(236,253,245,.16);box-shadow:0 6px 24px rgba(0,0,0,.28)}
.grace .bub{border-top-left-radius:5px;background:linear-gradient(160deg,rgba(16,185,129,.20),rgba(2,44,34,.55));border:1px solid var(--edge);box-shadow:0 6px 24px rgba(0,0,0,.28)}
.yo .bub{border-top-right-radius:5px;color:#012018;background:linear-gradient(140deg,#d1fae5 0%,#6ee7b7 35%,#10b981 100%);box-shadow:0 8px 26px rgba(16,185,129,.35)}
.privado{align-items:center}.privado .bub{max-width:92%;background:rgba(127,29,29,.35);border:1px solid rgba(252,165,165,.45);border-radius:14px;color:#ffe4e6}
.bub time{position:absolute;right:10px;bottom:4px;font-size:11px;opacity:.6}
.bub strong{color:var(--e200)}.yo .bub strong{color:#013b2b}
.bub ul{margin:4px 0;padding-left:18px}
.typing .bub{padding:12px 16px}.dots{display:inline-flex;gap:5px}.dots i{width:7px;height:7px;border-radius:50%;background:var(--e300);animation:blink 1.2s infinite}.dots i:nth-child(2){animation-delay:.2s}.dots i:nth-child(3){animation-delay:.4s}
@keyframes blink{0%,80%,100%{opacity:.25}40%{opacity:1}}
.hello{text-align:center;padding:26px 10px 8px;color:var(--muted)}
.hello h1{margin:0 0 4px;font-size:22px;color:var(--e50)}
.bar{display:flex;gap:8px;align-items:center;padding:6px 14px 2px;flex-wrap:wrap}
.toggle{font:inherit;font-size:13px;color:var(--e50);cursor:pointer;padding:7px 13px;border-radius:999px;border:1px solid var(--edge);background:rgba(2,44,34,.5)}
.toggle.on{background:linear-gradient(140deg,#34d399,#047857);color:#012018;font-weight:650}
.quedan{font-size:12.5px;color:var(--muted)}
footer{display:flex;align-items:flex-end;gap:10px;padding:8px 12px calc(10px + env(safe-area-inset-bottom));background:linear-gradient(0deg,rgba(2,44,34,.75),rgba(2,44,34,.35));border-top:1px solid var(--edge)}
.box{flex:1;display:flex;border-radius:24px;padding:4px 6px 4px 14px;background:rgba(1,26,19,.65);border:1px solid var(--edge)}
textarea{flex:1;resize:none;border:0;outline:0;background:transparent;color:var(--text);font:inherit;max-height:140px;padding:9px 0;line-height:1.4}
textarea::placeholder{color:rgba(209,250,229,.45)}
.send{flex:0 0 48px;width:48px;height:48px;border:0;cursor:pointer;color:#012018;font-size:20px;display:grid;place-items:center;clip-path:polygon(50% 0,93% 25%,93% 75%,50% 100%,7% 75%,7% 25%);background:linear-gradient(140deg,#ecfdf5,#34d399 45%,#047857)}
.send:disabled{filter:grayscale(.6) brightness(.7)}
.note{font-size:11.5px;color:var(--muted);text-align:center;padding:0 12px 6px}
[hidden]{display:none!important}
@media (max-width:640px){.bub{max-width:88%}}
</style></head><body>
<div class="bg"></div>
<div class="app">
  <header>
    <div class="avatar">${DEFAULT_AVATAR}</div>
    <div class="who"><b>Chat de líderes</b><small id="status">${church} · solo líderes y servidores</small></div>
    <button class="bell" id="bell" title="Activar notificaciones de esta app" aria-label="Activar notificaciones">🔔</button>
  </header>
  <main id="chat" aria-live="polite">
    <div class="hello" id="hello">
      <h1>Hola, ${first}</h1>
      <div>Este es el chat de los líderes: conversen entre ustedes y, cuando necesiten, pregúntenle a Grace con el botón de abajo. Ella responde de su grupo, su ministerio y los eventos de la iglesia.</div>
    </div>
  </main>
  <div class="bar">
    <button class="toggle" id="graceToggle" type="button">✦ Preguntar a Grace</button>
    <span class="quedan" id="quedan"></span>
  </div>
  <footer>
    <div class="box"><textarea id="msg" rows="1" placeholder="Escribe un mensaje" maxlength="1000" aria-label="Mensaje"></textarea></div>
    <button class="send" id="send" aria-label="Enviar">➤</button>
  </footer>
  <div class="note" id="iosNote" hidden>En iPhone: para recibir notificaciones, toca Compartir → «Agregar a pantalla de inicio», abre el chat desde ese ícono y luego toca la campana 🔔.</div>
</div>
<script>
(function () {
  var BASE = '${base}';
  var chat = document.getElementById('chat'), msg = document.getElementById('msg'), send = document.getElementById('send');
  var hello = document.getElementById('hello'), toggle = document.getElementById('graceToggle'), quedan = document.getElementById('quedan');
  var bell = document.getElementById('bell');
  var lastId = 0, lastDay = '', busy = false, paraGrace = false, yoId = 0;
  var IGLESIA = ${JSON.stringify(config.churchName || '')};
  var TITULO = document.title;
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
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
  function color(nombre) {
    var h = 0; for (var i = 0; i < nombre.length; i++) h = (h * 31 + nombre.charCodeAt(i)) % 360;
    return 'hsl(' + h + ' 80% 78%)';
  }
  function add(m) {
    hello.hidden = true;
    var d = new Date(m.created_at), key = d.toDateString();
    if (key !== lastDay) { lastDay = key; var sep = document.createElement('div'); sep.className = 'day'; sep.innerHTML = '<span>' + esc(dayLabel(d)) + '</span>'; chat.appendChild(sep); }
    var row = document.createElement('div');
    var esGrace = m.kind === 'grace';
    var esYo = !esGrace && m.person_id === yoId;
    row.className = 'row ' + (esGrace ? 'grace' : esYo ? 'yo' : 'otro');
    var autor = esGrace ? '<div class="autor" style="color:var(--e300)">✦ Grace</div>' : (!esYo ? '<div class="autor" style="color:' + color(m.author_name || '') + '">' + esc(m.author_name || '') + '</div>' : '');
    row.innerHTML = autor + '<div class="bub">' + fmt(m.body) + '<time>' + hhmm(d) + '</time></div>';
    chat.appendChild(row);
    if (m.id > lastId) lastId = m.id;
    chat.scrollTop = chat.scrollHeight;
    return row;
  }
  function addLocal(texto, clase) {
    var row = document.createElement('div');
    row.className = 'row ' + (clase || 'grace');
    row.innerHTML = '<div class="bub">' + fmt(texto) + '</div>';
    chat.appendChild(row);
    chat.scrollTop = chat.scrollHeight;
    return row;
  }
  function typing(on) {
    var t = document.getElementById('typing');
    if (on && !t) { t = document.createElement('div'); t.id = 'typing'; t.className = 'row grace typing'; t.innerHTML = '<div class="bub"><span class="dots"><i></i><i></i><i></i></span></div>'; chat.appendChild(t); chat.scrollTop = chat.scrollHeight; }
    if (!on && t) t.remove();
  }
  function setLimite(l) {
    if (!l) return;
    quedan.textContent = l.limite > 0 ? ('Te quedan ' + l.restantes + ' de ' + l.limite + ' preguntas a Grace hoy') : 'Grace está apagada en este chat';
    toggle.disabled = l.restantes <= 0;
    if (l.restantes <= 0 && paraGrace) { paraGrace = false; toggle.classList.remove('on'); }
  }
  function post(url, body) {
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, j: j }; }); });
  }
  function marcarLeido() { if (lastId > 0 && !document.hidden) post(BASE + '/leido', { hasta: lastId }); }
  function traer() {
    return fetch(BASE + '/mensajes?desde=' + lastId).then(function (r) { return r.json(); }).then(function (j) {
      yoId = j.yo_id || yoId;
      var nuevos = j.mensajes || [];
      var deOtros = false;
      nuevos.forEach(function (m) { add(m); if (m.kind === 'grace' || m.person_id !== yoId) deOtros = true; });
      if (nuevos.length) { marcarLeido(); if (document.hidden && deOtros) document.title = '• ' + TITULO; }
      setLimite(j.limite);
      document.getElementById('status').textContent = IGLESIA + ' · ' + (j.miembros || 0) + ' en la sala';
      return nuevos;
    }).catch(function () { return []; });
  }
  function enviar() {
    var texto = String(msg.value || '').trim();
    if (!texto || busy) return;
    busy = true; send.disabled = true;
    var eraGrace = paraGrace || /^\\s*@?grace\\b/i.test(texto);
    if (eraGrace) typing(true);
    post(BASE + '/mensaje', { texto: texto, para_grace: paraGrace }).then(function (r) {
      typing(false);
      if (r.j.crisis) { addLocal(r.j.crisis, 'privado'); msg.value = ''; }
      else if (r.ok) {
        msg.value = ''; grow();
        (r.j.mensajes || []).forEach(function (m) { add(m); });
        if (r.j.aviso) addLocal(r.j.aviso, 'grace');
        setLimite(r.j.limite);
        marcarLeido();
      } else addLocal(r.j.error || 'No se pudo enviar. Intenta de nuevo.', 'privado');
    }).catch(function () { typing(false); addLocal('Se perdió la conexión. Intenta de nuevo.', 'privado'); })
      .then(function () { busy = false; send.disabled = false; msg.focus(); });
  }
  function grow() { msg.style.height = 'auto'; msg.style.height = Math.min(msg.scrollHeight, 140) + 'px'; }
  msg.addEventListener('input', grow);
  msg.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); enviar(); } });
  send.addEventListener('click', enviar);
  toggle.addEventListener('click', function () { paraGrace = !paraGrace; toggle.classList.toggle('on', paraGrace); msg.placeholder = paraGrace ? 'Tu pregunta para Grace…' : 'Escribe un mensaje'; msg.focus(); });
  document.addEventListener('visibilitychange', function () { if (!document.hidden) { document.title = TITULO; traer(); } });

  // Notificaciones de la app (Web Push)
  function urlB64ToUint8(b64) {
    var padding = '='.repeat((4 - (b64.length % 4)) % 4);
    var base = (b64 + padding).replace(/-/g, '+').replace(/_/g, '/');
    var raw = atob(base), out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }
  function estadoCampana() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) { bell.hidden = true; return; }
    navigator.serviceWorker.ready.then(function (reg) { return reg.pushManager.getSubscription(); }).then(function (sub) {
      bell.classList.toggle('on', Boolean(sub));
      bell.title = sub ? 'Notificaciones activadas en este aparato' : 'Activar notificaciones de esta app';
    }).catch(function () {});
  }
  bell.addEventListener('click', function () {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) { alert('Este navegador no admite notificaciones de la app.'); return; }
    Notification.requestPermission().then(function (perm) {
      if (perm !== 'granted') { alert('Sin permiso no puedo avisarte. Activa las notificaciones para esta app en los ajustes del navegador.'); return; }
      return navigator.serviceWorker.ready.then(function (reg) {
        return fetch(BASE + '/vapid').then(function (r) { return r.json(); }).then(function (j) {
          return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8(j.publicKey) });
        }).then(function (sub) { return post(BASE + '/push', { subscription: sub.toJSON() }); });
      }).then(function () { estadoCampana(); alert('Listo: te avisaré aquí cuando alguien escriba en el chat.'); });
    }).catch(function () { alert('No se pudieron activar las notificaciones en este aparato.'); });
  });
  if ('serviceWorker' in navigator) navigator.serviceWorker.register(BASE + '/sw.js').then(estadoCampana).catch(function () {});
  var esIOS = /iphone|ipad/i.test(navigator.userAgent || '');
  var standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
  if (esIOS && !standalone) document.getElementById('iosNote').hidden = false;

  traer().then(function () { msg.focus(); });
  setInterval(traer, 8000);
})();
</script>
</body></html>`;
}

module.exports = { chatPage, invalidPage, manifest, serviceWorkerJs };
