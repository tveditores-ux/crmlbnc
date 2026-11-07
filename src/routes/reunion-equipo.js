'use strict';
const express = require('express');
const { layout } = require('../views/layout');
const { esc } = require('../util');
const { createRateLimiter } = require('../attendance-store');
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


/** Las secciones de la hoja (entrevista, 4 temas, acuerdos). `d` trae los valores guardados (vacío en la libreta del teléfono). */
function sheet(d = {}) {
  const ta = (k, val) => `<textarea data-k="${k}" rows="3" spellcheck="false" autocomplete="off" aria-label="${esc(k)}">${esc(val || '')}</textarea>`;
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
  return h + '</section>';
}

/** Libreta del teléfono: guarda en el propio aparato de cada persona (no en el CRM). */
const REMOTE_SCRIPT = `
(function(){
  var KEY='lbnc-reunion-equipo-v1',data={};
  try{data=JSON.parse(localStorage.getItem(KEY)||'{}')}catch(e){data={}}
  function persist(){try{localStorage.setItem(KEY,JSON.stringify(data))}catch(e){}}
  function grow(e){e.style.height='auto';e.style.height=Math.max(108,e.scrollHeight)+'px'}
  var dev=null;
  try{dev=localStorage.getItem('lbnc-reunion-device')}catch(e){}
  if(!dev){dev=(window.crypto&&crypto.randomUUID?crypto.randomUUID():String(Math.random()).slice(2)+String(Date.now())).replace(/[^A-Za-z0-9_-]/g,'');while(dev.length<16)dev+='x';try{localStorage.setItem('lbnc-reunion-device',dev)}catch(e){}}
  var msg=document.getElementById('msg');
  function say(t){msg.textContent=t;setTimeout(function(){msg.textContent=''},2500)}
  document.querySelectorAll('.re textarea,.re input').forEach(function(e){
    var k=e.getAttribute('data-k');if(data[k])e.value=data[k];
    if(e.tagName==='TEXTAREA')grow(e);
    e.addEventListener('input',function(){data[k]=e.value;persist();if(e.tagName==='TEXTAREA')grow(e)});
  });
  function compile(){
    var o=[],q=function(e){return (e.value||'').trim()||'—'};
    document.querySelectorAll('.re section').forEach(function(sec){
      o.push(sec.querySelector('h2').textContent.toUpperCase());
      sec.querySelectorAll('.q,.lbl,.ac,textarea').forEach(function(n){
        if(n.tagName==='TEXTAREA'){if(!n.closest('.ac'))o.push(q(n))}
        else if(n.classList.contains('ac')){o.push(n.querySelector('.n').textContent+' '+q(n.querySelector('textarea')));var i=n.querySelectorAll('input');o.push('   Responsable: '+q(i[0])+'  Fecha: '+q(i[1]))}
        else o.push(n.textContent)
      });o.push('');
    });
    return o.join('\\n');
  }
  function fb(t){var x=document.createElement('textarea');x.value=t;document.body.appendChild(x);x.select();try{document.execCommand('copy');say('Copiado')}catch(e){say('No se pudo copiar')}document.body.removeChild(x)}
  document.getElementById('send').onclick=function(){
    var ans={},name='';
    document.querySelectorAll('.re textarea,.re input').forEach(function(e){var k=e.getAttribute('data-k');if(k==='nombre')name=e.value;else ans[k]=e.value});
    if(name.trim().length<2){say('Escribe tu nombre arriba');return}
    say('Enviando…');
    fetch(location.pathname+'/enviar',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({device:dev,name:name,answers:ans})})
      .then(function(r){if(r.ok)say('Enviado. Gracias');else if(r.status===400)return r.json().then(function(j){say((j.errors||['No se pudo enviar'])[0])});else throw 0})
      .catch(function(){say('No se pudo enviar. Intenta de nuevo')});
  };
  document.getElementById('copy').onclick=function(){var t=compile();try{navigator.clipboard.writeText(t).then(function(){say('Copiado')},function(){fb(t)})}catch(e){fb(t)}};
  document.getElementById('wa').onclick=function(){window.location.href='https://wa.me/?text='+encodeURIComponent(compile())};
  var armed=false;
  document.getElementById('clear').onclick=function(){
    if(!armed){armed=true;say('Toca otra vez para borrar');setTimeout(function(){armed=false},3000);return}
    data={};persist();document.querySelectorAll('.re textarea,.re input').forEach(function(e){e.value='';if(e.tagName==='TEXTAREA')grow(e)});armed=false;say('Borrado')
  };
})();`;

const REMOTE_CSS = `
html{-webkit-text-size-adjust:100%}
body{margin:0;background:#faf8f3}
.wrapr{max-width:680px;margin:0 auto;padding:26px 20px 80px}
.tools{display:flex;gap:12px;flex-wrap:wrap;align-items:center}
.tools button{font:inherit;font-size:24px;text-transform:uppercase;background:none;border:1.5px solid #2b2b2b;border-radius:3px 10px 4px 9px;padding:8px 16px;color:#2b2b2b;cursor:pointer}
.tools button:active{background:#2b2b2b;color:#faf8f3}
#msg{font-size:22px;color:#777}
`;

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

  r.get(
    '/reunion-equipo',
    ah(async (req, res) => {
      const d = await re.loadAll(db);
      const h = sheet(d);
      const link = await re.ensureLink(db);
      const nResp = await re.countSubmissions(db);
      const url = `${String(config.publicUrl || '').replace(/\/$/, '')}/reunion/${link.token}`;
      const body = `<style>${CSS}</style>
        <h1>Reunión de equipo</h1>
        <p class="sub">Lo que se escribe aquí se guarda solo y lo ve cualquiera que entre al panel.</p>
        <div class="card">
          <h2 style="margin-top:0">Libreta para el equipo</h2>
          <p class="muted" style="margin:0 0 10px">Envía este enlace por WhatsApp: cada persona abre su libreta en el teléfono, sin entrar al CRM. Lo que escribe se queda en su teléfono hasta que toque «Enviar a la iglesia»; entonces llega a <a href="/reunion-equipo/respuestas">Respuestas del equipo (${nResp})</a>.</p>
          ${link.active ? `<input type="text" readonly value="${esc(url)}" onclick="this.select()" class="mono">` : '<p><span class="badge b-warn">Enlace apagado</span></p>'}
          <div class="actions">
            ${link.active ? `<a class="btn small" href="https://wa.me/?text=${encodeURIComponent('Libreta para la reunión de equipo: ' + url)}" target="_blank" rel="noopener">Enviar por WhatsApp</a>` : ''}
            <form class="inline" method="post" action="/reunion-equipo/enlace/${link.active ? 'apagar' : 'encender'}"><button class="sec small">${link.active ? 'Apagar enlace' : 'Encender enlace'}</button></form>
            <form class="inline" method="post" action="/reunion-equipo/enlace/regenerar" onsubmit="return confirm('El enlace anterior dejará de funcionar. ¿Generar uno nuevo?')"><button class="sec small">Generar enlace nuevo</button></form>
          </div>
        </div>
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

  r.get(
    '/reunion-equipo/respuestas',
    ah(async (req, res) => {
      const rows = await re.listSubmissions(db);
      const porPersona = req.query.ver === 'persona';
      const fecha = (d) => new Date(d).toLocaleString('es-VE', { timeZone: config.timezone, dateStyle: 'short', timeStyle: 'short' });
      const bloque = (nombre, texto) => `<p style="margin:4px 0 10px"><strong>${esc(nombre)}:</strong> <span style="white-space:pre-wrap">${esc(texto)}</span></p>`;
      let h = '';
      if (porPersona) {
        for (const x of rows) {
          let inner = '';
          const campo = (k, etiqueta) => (x.answers[k] ? `<p class="muted" style="margin:10px 0 0;font-size:13px">${esc(etiqueta)}</p><p style="margin:2px 0;white-space:pre-wrap">${esc(x.answers[k])}</p>` : '');
          for (const [k, q] of re.ENTREVISTA) inner += campo(k, q);
          for (const t of re.TEMAS) for (const [c, l] of re.CAMPOS_TEMA) inner += campo(t.k + c, `${t.title} · ${l}`);
          for (const n of re.ACUERDOS) {
            const resp = x.answers[`ac${n}r`] ? ` — Responsable: ${x.answers[`ac${n}r`]}` : '';
            const fch = x.answers[`ac${n}f`] ? ` — Fecha: ${x.answers[`ac${n}f`]}` : '';
            if (x.answers[`ac${n}`]) inner += campo(`ac${n}`, `Acuerdo ${n}${resp}${fch}`);
          }
          h += `<div class="card"><div style="display:flex;justify-content:space-between;gap:10px;align-items:baseline"><h2 style="margin:0">${esc(x.name)}</h2><span class="muted" style="font-size:12px">${esc(fecha(x.updated_at))}</span></div>${inner}
            <form method="post" action="/reunion-equipo/respuestas/${x.id}/borrar" onsubmit="return confirm('¿Borrar la respuesta de ${esc(x.name).replace(/'/g, '')}?')" style="margin-top:12px"><button class="danger small">Borrar</button></form></div>`;
        }
      } else {
        const seccion = (titulo, items) => {
          const parts = items
            .map(([k, etiqueta]) => {
              const con = rows.filter((x) => x.answers[k]);
              return con.length ? `<p class="muted" style="margin:14px 0 2px;font-size:13px">${esc(etiqueta)}</p>${con.map((x) => bloque(x.name, x.answers[k])).join('')}` : '';
            })
            .join('');
          return parts ? `<div class="card"><h2 style="margin-top:0">${esc(titulo)}</h2>${parts}</div>` : '';
        };
        h += seccion('Entrevista cruzada', re.ENTREVISTA);
        for (const t of re.TEMAS) h += seccion(`${t.title} — ${t.q}`, re.CAMPOS_TEMA.map(([c, l]) => [t.k + c, l]));
        const acu = re.ACUERDOS.map((n) => [`ac${n}`, `Acuerdo ${n}`]);
        h += seccion('Lo que decidimos juntos', acu);
      }
      const body = `<p><a href="/reunion-equipo">← Reunión de equipo</a></p><h1>Respuestas del equipo</h1>
        <p class="sub">${rows.length} ${rows.length === 1 ? 'persona ha enviado' : 'personas han enviado'} su libreta.</p>
        <div class="actions"><a class="btn ${porPersona ? 'sec' : ''} small" href="/reunion-equipo/respuestas">Por tema</a><a class="btn ${porPersona ? '' : 'sec'} small" href="/reunion-equipo/respuestas?ver=persona">Por persona</a></div>
        ${h || '<div class="card muted">Aún no ha llegado ninguna respuesta.</div>'}`;
      res.send(layout({ title: 'Respuestas del equipo', active: '/reunion-equipo', body, config, query: req.query }));
    })
  );

  r.post(
    '/reunion-equipo/respuestas/:id/borrar',
    ah(async (req, res) => {
      const id = /^\d{1,9}$/.test(req.params.id) ? Number(req.params.id) : 0;
      const ok = id && (await re.deleteSubmission(db, id));
      res.redirect(303, '/reunion-equipo/respuestas?' + (ok ? 'ok=' + encodeURIComponent('Respuesta borrada.') : 'err=' + encodeURIComponent('No se encontró esa respuesta.')));
    })
  );

  r.post(
    '/reunion-equipo/enlace/:accion',
    ah(async (req, res) => {
      const a = req.params.accion;
      const go = (ok) => res.redirect(303, '/reunion-equipo?ok=' + encodeURIComponent(ok));
      if (a === 'regenerar') {
        await re.regenerateLink(db);
        return go('Enlace nuevo generado. El anterior ya no funciona; vuelve a enviarlo.');
      }
      if (a !== 'apagar' && a !== 'encender') return res.sendStatus(404);
      await re.ensureLink(db);
      await re.setLinkActive(db, a === 'encender');
      go(a === 'encender' ? 'Enlace encendido.' : 'Enlace apagado.');
    })
  );

  return r;
}

/** Libreta del equipo: sin sesión, protegida por el enlace secreto. No lee ni escribe en la base de datos. */
function reunionRemotaRouter(ctx) {
  const { db, config } = ctx;
  const r = express.Router();
  const limiter = createRateLimiter({ max: 120 });
  const sendLimiter = createRateLimiter({ max: 60 });
  const page = (status, body, extra = '') => ({
    status,
    html: `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">
<meta name="theme-color" content="#faf8f3">
<link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="apple-touch-icon" href="/apple-touch-icon.png">
<title>Reunión de equipo</title><style>${REMOTE_CSS}${CSS}</style></head><body><div class="wrapr">${body}</div>${extra}</body></html>`,
  });
  const send = (res, o) => {
    res.setHeader('Cache-Control', 'no-store');
    res.status(o.status).send(o.html);
  };

  r.get(
    '/reunion/:token',
    ah(async (req, res) => {
      if (!limiter.take(`${req.ip}|get`)) return res.sendStatus(429);
      if (!(await re.linkIsValid(db, req.params.token))) {
        return send(res, page(404, '<div class="re"><h2>Enlace no válido</h2><p class="q">Pídele uno nuevo a quien administra el panel.</p></div>'));
      }
      send(
        res,
        page(
          200,
          `<div class="re"><p class="lbl" style="margin-top:0">Mi nombre</p><input data-k="nombre" maxlength="80" autocomplete="name" style="border-bottom:1px solid #b9b6ae;height:36px;margin-bottom:40px">${sheet()}<div class="tools"><button type="button" id="send">Enviar a la iglesia</button><button type="button" id="copy">Copiar todo</button><button type="button" id="wa">Enviar por WhatsApp</button><button type="button" id="clear">Borrar</button><span id="msg"></span></div></div>`,
          `<script>${REMOTE_SCRIPT}</script>`
        )
      );
    })
  );

  r.post(
    '/reunion/:token/enviar',
    ah(async (req, res) => {
      if (!(await re.linkIsValid(db, req.params.token))) return res.sendStatus(404);
      if (!sendLimiter.take(`${req.ip}|${req.params.token}`)) return res.sendStatus(429);
      const sub = re.parseSubmission(req.body);
      if (sub.errors.length) return res.status(400).json({ errors: sub.errors });
      await re.saveSubmission(db, sub.value);
      res.sendStatus(204);
    })
  );

  return r;
}

module.exports = { reunionEquipoRouter, reunionRemotaRouter, CSS, REMOTE_CSS, squig };
