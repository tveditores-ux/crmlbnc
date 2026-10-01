'use strict';
const { esc } = require('../util');

const CSS = `
:root{
  --bg:#f5f2eb;--surface:#fffdf8;--ink:#1f2a2e;--muted:#6b665c;--line:#e3ddcf;
  --accent:#2f5d62;--accent-ink:#fff;--ok:#2f6b4f;--ok-bg:#e3f0e7;--warn:#8a6116;--warn-bg:#f8eed8;
  --bad:#8a3b2e;--bad-bg:#f6e2dc;--chip:#ece6d8;
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
a{color:var(--accent)}
header.top{background:var(--ink);color:#f5f2eb}
header.top .wrap{display:flex;align-items:center;gap:20px;flex-wrap:wrap;padding-top:12px;padding-bottom:12px}
.brand{font-weight:700;letter-spacing:.01em;margin-right:auto}
.brand small{display:block;font-weight:400;opacity:.7;font-size:12px}
nav a{color:#f5f2eb;text-decoration:none;opacity:.8;padding:6px 2px;margin-right:12px;font-size:14px}
nav a.on,nav a:hover{opacity:1;border-bottom:2px solid #d9b56a}
.wrap{max-width:1080px;margin:0 auto;padding:0 16px}
main{padding:24px 0 60px}
h1{font-size:24px;margin:0 0 4px}
h2{font-size:17px;margin:28px 0 10px}
.sub{color:var(--muted);margin:0 0 20px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:18px;margin-bottom:16px}
.grid{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(220px,1fr))}
.stat{font-size:28px;font-weight:700}
.stat-label{color:var(--muted);font-size:13px}
table{width:100%;border-collapse:collapse;background:var(--surface);border:1px solid var(--line);border-radius:10px;overflow:hidden}
th,td{text-align:left;padding:9px 12px;border-bottom:1px solid var(--line);vertical-align:top;font-size:14px}
th{background:#efe9dc;font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}
tr:last-child td{border-bottom:0}
.table-scroll{overflow-x:auto;-webkit-overflow-scrolling:touch}
.chip{display:inline-block;background:var(--chip);border-radius:20px;padding:1px 9px;font-size:12px;margin:1px 3px 1px 0}
.badge{display:inline-block;border-radius:5px;padding:1px 8px;font-size:12px;font-weight:600}
.b-ok{background:var(--ok-bg);color:var(--ok)}.b-warn{background:var(--warn-bg);color:var(--warn)}.b-bad{background:var(--bad-bg);color:var(--bad)}.b-muted{background:var(--chip);color:var(--muted)}
.flash{padding:10px 14px;border-radius:8px;margin-bottom:16px}
.flash.ok{background:var(--ok-bg);color:var(--ok)}.flash.err{background:var(--bad-bg);color:var(--bad)}
form.inline{display:inline}
label{display:block;font-weight:600;font-size:13px;margin:12px 0 4px}
label.check{font-weight:400;font-size:14px;display:flex;gap:8px;align-items:center;margin:6px 0}
input[type=text],input[type=email],input[type=tel],input[type=password],input[type=datetime-local],input[type=search],select,textarea{
  width:100%;padding:9px 10px;border:1px solid #cfc7b5;border-radius:7px;background:#fff;font:inherit;color:inherit}
textarea{min-height:90px}
.row{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(200px,1fr))}
button,.btn{display:inline-block;border:0;border-radius:7px;padding:9px 16px;font:inherit;font-weight:600;cursor:pointer;
  background:var(--accent);color:var(--accent-ink);text-decoration:none;line-height:1.3}
.btn.sec,button.sec{background:var(--chip);color:var(--ink)}
.btn.danger,button.danger{background:var(--bad);color:#fff}
.btn.small,button.small{padding:5px 10px;font-size:13px}
.actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:14px 0}
.muted{color:var(--muted)}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px}
pre{white-space:pre-wrap;background:#f0ebdf;padding:12px;border-radius:8px;font-size:13px}
.checks{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:2px 12px}
.toolbar{display:flex;gap:8px;flex-wrap:wrap;align-items:end;margin-bottom:14px}
.toolbar > *{flex:1 1 180px}
.toolbar > button,.toolbar > .btn{flex:0 0 auto}
@media (max-width:640px){nav a{margin-right:8px;font-size:13px}h1{font-size:21px}}
`;

const NAV = [
  ['/', 'Inicio'],
  ['/eventos', 'Eventos'],
  ['/personas', 'Personas'],
  ['/ministerios', 'Ministerios'],
  ['/mensajes', 'Mensajes'],
  ['/pruebas', 'Pruebas'],
];

function flash(query) {
  if (!query) return '';
  if (query.ok) return `<div class="flash ok">${esc(query.ok)}</div>`;
  if (query.err) return `<div class="flash err">${esc(query.err)}</div>`;
  return '';
}

function layout({ title, active, body, config, query, bare = false }) {
  const church = config ? config.churchName : '';
  const nav = bare
    ? ''
    : `<nav>${NAV.map(([href, label]) => `<a href="${href}" class="${active === href ? 'on' : ''}">${label}</a>`).join('')}
       <form class="inline" method="post" action="/salir"><button class="small sec" style="margin-left:6px">Salir</button></form></nav>`;
  const dryBanner =
    !bare && config && config.dryRun
      ? `<div style="background:#d9b56a;color:#1f2a2e;font-size:13px;text-align:center;padding:5px">Modo de prueba (DRY_RUN): los mensajes se registran pero no se envían.</div>`
      : '';
  return `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · ${esc(church)}</title><style>${CSS}</style></head><body>
${dryBanner}
<header class="top"><div class="wrap"><div class="brand">Comunicación<small>${esc(church)}</small></div>${nav}</div></header>
<main><div class="wrap">${flash(query)}${body}</div></main></body></html>`;
}

const STATUS_BADGE = {
  pendiente: '<span class="badge b-warn">Pendiente</span>',
  confirmado: '<span class="badge b-ok">Confirmado</span>',
  no_puede: '<span class="badge b-bad">No puede</span>',
};

const NOTIF_BADGE = {
  enviado: '<span class="badge b-ok">Enviado</span>',
  simulado: '<span class="badge b-muted">Simulado</span>',
  enviando: '<span class="badge b-warn">Enviando</span>',
  fallido: '<span class="badge b-bad">Falló</span>',
};

module.exports = { layout, STATUS_BADGE, NOTIF_BADGE, CSS };
