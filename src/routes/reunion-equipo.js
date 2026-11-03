'use strict';
const express = require('express');
const { layout } = require('../views/layout');
const { esc } = require('../util');
const re = require('../reunion-equipo');

const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const CSS = `
@font-face{font-family:"Amatic";font-weight:700;src:url(/amatic-sc-bold.woff) format("woff")}
.re{font-family:"Amatic","Marker Felt","Comic Sans MS",cursive;font-weight:700;font-size:26px;line-height:1.1;max-width:680px;margin:0 auto;color:#2b2b2b}
.re section{margin:0 0 64px}
.re h2{font-family:inherit;font-weight:700;font-size:44px;margin:0 0 24px;display:inline-block;text-transform:uppercase;line-height:1;position:relative;padding-bottom:6px}
.re h2 svg{position:absolute;left:0;bottom:-4px;width:100%;height:10px}
.re section:nth-of-type(odd) h2{transform:rotate(-.6deg)}
.re section:nth-of-type(even) h2{transform:rotate(.5deg)}
.re .q{margin:0 0 6px;text-transform:uppercase;font-size:27px}
.re .lbl{margin:22px 0 2px;text-transform:uppercase;font-size:25px}
.re textarea,.re input{display:block;width:100%;border:0;outline:0;background:transparent;color:#2b2b2b;font:inherit;font-size:26px;resize:none;padding:0;border-radius:0;box-shadow:none}
.re textarea{line-height:36px;min-height:108px;overflow:hidden;background-image:repeating-linear-gradient(to bottom,transparent 0,transparent 33px,#b9b6ae 33px,#b9b6ae 34px,transparent 34px,transparent 36px)}
.re textarea:focus,.re input:focus{background-color:rgba(0,0,0,.03)}
.re .ac{margin:0 0 34px;display:flex;gap:6px}
.re .ac .n{width:30px;font-size:30px;line-height:36px;flex:none}
.re .ac .body{flex:1;min-width:0}
.re .row{display:flex;gap:18px;margin-top:6px}
.re .row label{flex:1;font-size:22px;text-transform:uppercase;margin:0;font-weight:700}
.re .row label.f{flex:.7}
.re .row input{border-bottom:1px solid #b9b6ae;height:36px;line-height:36px}
.re-state{position:sticky;top:0;text-align:right;font:13px system-ui,sans-serif;color:var(--muted);height:0;overflow:visible}
.re-state span{background:var(--bg);padding:2px 8px;border-radius:6px}
`;

function squig(seed) {
  let s = seed;
  const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  let p = 'M0 5';
  for (let i = 1; i <= 12; i++) p += ` L${(300 * i) / 12} ${(5 + Math.sin(i * 1.3) * 1.8 + (rnd() - 0.5) * 1.4).toFixed(1)}`;
  return `<svg viewBox="0 0 300 10" preserveAspectRatio="none" aria-hidden="true"><path d="${p}" fill="none" stroke="#2b2b2b" stroke-width="2.2" stroke-linecap="round" vector-effect="non-scaling-stroke"/></svg>`;
}

const SCRIPT = `
(function(){
  var state=document.getElementById('re-state');
  function say(t){state.textContent=t;state.parentNode.style.visibility=t?'visible':'hidden'}
  function grow(e){e.style.height='auto';e.style.height=Math.max(108,e.scrollHeight)+'px'}
  var timers={},pending=0;
  function save(e){
    var k=e.getAttribute('data-k');
    fetch('/reunion-equipo/guardar',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({k:k,v:e.value})})
      .then(function(r){if(!r.ok)throw 0;pending--;say(pending>0?'Guardando…':'Guardado')})
      .catch(function(){pending--;say('No se pudo guardar: revisa la conexión')});
  }
  document.querySelectorAll('.re textarea,.re input').forEach(function(e){
    if(e.tagName==='TEXTAREA')grow(e);
    e.addEventListener('input',function(){
      if(e.tagName==='TEXTAREA')grow(e);
      var k=e.getAttribute('data-k');clearTimeout(timers[k]);say('Guardando…');pending++;
      timers[k]=setTimeout(function(){save(e)},600);
    });
  });
  var copy=document.getElementById('re-copy');
  if(copy)copy.onclick=function(){
    var t=document.getElementById('re-text').value;
    function fb(){var x=document.getElementById('re-text');x.hidden=false;x.select();try{document.execCommand('copy');say('Copiado')}catch(e){say('Selecciona y copia el texto')}}
    try{navigator.clipboard.writeText(t).then(function(){say('Copiado')},fb)}catch(e){fb()}
  };
})();`;

function compile(d) {
  const v = (k) => (d[k] || '').trim() || '—';
  const o = ['REUNIÓN DE EQUIPO', '', 'ENTREVISTA CRUZADA'];
  for (const [k, q] of re.ENTREVISTA) o.push(q, v(k), '');
  for (const t of re.TEMAS) {
    o.push(`${t.title.toUpperCase()} — ${t.q}`);
    for (const [c, l] of re.CAMPOS_TEMA) o.push(`${l}:`, v(t.k + c));
    o.push('');
  }
  o.push('LO QUE DECIDIMOS JUNTOS');
  for (const n of re.ACUERDOS) o.push(`${n}. ${v('ac' + n)}`, `   Responsable: ${v('ac' + n + 'r')}  Fecha: ${v('ac' + n + 'f')}`);
  return o.join('\n');
}

/** Pestaña "Reunión de equipo": hoja con cajas de texto que se guardan solas en la base. */
function reunionEquipoRouter(ctx) {
  const { db, config } = ctx;
  const r = express.Router();
  r.use('/reunion-equipo', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  const ta = (k, val) => `<textarea data-k="${k}" rows="3" spellcheck="false" autocomplete="off" aria-label="${esc(k)}">${esc(val || '')}</textarea>`;

  r.get(
    '/reunion-equipo',
    ah(async (req, res) => {
      const d = await re.loadAll(db);
      let h = '';
      let seed = 5;
      const title = (t) => `<h2>${esc(t)}${squig((seed += 7))}</h2>`;
      h += `<section>${title('Entrevista cruzada')}`;
      for (const [k, q] of re.ENTREVISTA) h += `<p class="q">${esc(q)}</p>${ta(k, d[k])}<div style="height:22px"></div>`;
      h += '</section>';
      for (const t of re.TEMAS) {
        h += `<section>${title(t.title)}<p class="q">${esc(t.q)}</p>`;
        for (const [c, l] of re.CAMPOS_TEMA) h += `<p class="lbl">${esc(l)}</p>${ta(t.k + c, d[t.k + c])}`;
        h += '</section>';
      }
      h += `<section>${title('Lo que decidimos juntos')}`;
      for (const n of re.ACUERDOS) {
        h += `<div class="ac"><span class="n">${n}.</span><div class="body">${ta('ac' + n, d['ac' + n])}
          <div class="row"><label>Responsable<input data-k="ac${n}r" value="${esc(d['ac' + n + 'r'] || '')}" maxlength="${re.MAX_LEN}" autocomplete="off"></label>
          <label class="f">Fecha<input data-k="ac${n}f" value="${esc(d['ac' + n + 'f'] || '')}" maxlength="${re.MAX_LEN}" autocomplete="off"></label></div></div></div>`;
      }
      h += '</section>';
      const body = `<style>${CSS}</style>
        <h1>Reunión de equipo</h1>
        <p class="sub">Lo que se escribe aquí se guarda solo y lo ve cualquiera que entre al panel.</p>
        <div class="re-state"><span id="re-state"></span></div>
        <div class="re">${h}</div>
        <div class="actions"><button type="button" class="sec" id="re-copy">Copiar todo</button>
          <form class="inline" method="post" action="/reunion-equipo/borrar" onsubmit="return confirm('¿Borrar todo lo escrito en la hoja? No se puede deshacer.')"><button class="danger">Borrar todo</button></form></div>
        <textarea id="re-text" hidden readonly style="min-height:200px">${esc(compile(d))}</textarea>
        <script>${SCRIPT}</script>`;
      res.send(layout({ title: 'Reunión de equipo', active: '/reunion-equipo', body, config, query: req.query }));
    })
  );

  r.post(
    '/reunion-equipo/guardar',
    ah(async (req, res) => {
      const ok = await re.saveField(db, String(req.body && req.body.k), req.body && req.body.v);
      res.sendStatus(ok ? 204 : 400);
    })
  );

  r.post(
    '/reunion-equipo/borrar',
    ah(async (req, res) => {
      await re.clearAll(db);
      res.redirect(303, '/reunion-equipo?ok=' + encodeURIComponent('Hoja borrada.'));
    })
  );

  return r;
}

module.exports = { reunionEquipoRouter };
