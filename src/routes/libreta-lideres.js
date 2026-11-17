'use strict';
const express = require('express');
const { layout } = require('../views/layout');
const { esc } = require('../util');
const { createRateLimiter } = require('../attendance-store');
const ll = require('../libreta-lideres');
const { CSS, REMOTE_CSS, squig } = require('./reunion-equipo');

const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/**
 * Las secciones de la hoja: una por líder/coordinador, con su punto expuesto y su solución clave
 * (solo lectura, dato en código) y las tres casillas que se llenan. `d` trae los valores
 * guardados (vacío en la libreta del teléfono).
 */
function sheet(d = {}) {
  const ta = (k, val) => `<textarea data-k="${k}" rows="3" spellcheck="false" autocomplete="off" aria-label="${esc(k)}">${esc(val || '')}</textarea>`;
  let h = '';
  let seed = 11;
  for (const p of ll.PERSONAS) {
    h += `<section><h2>${p.n}. ${esc(p.name)}${squig((seed += 7))}</h2>`;
    h += `<p class="lbl">Punto que expuso</p><p class="q" style="text-transform:none">${esc(p.punto)}</p>`;
    h += `<p class="lbl">Solución clave</p><p class="q" style="text-transform:none">${esc(p.solucion)}</p>`;
    for (const [c, l] of ll.CAMPOS) h += `<p class="lbl">${esc(l)}</p>${ta(ll.keyOf(p.n, c), d[ll.keyOf(p.n, c)])}`;
    h += '</section>';
  }
  return h;
}

/** Libreta del teléfono: guarda en el propio aparato de cada persona (no en el CRM). */
const REMOTE_SCRIPT = `
(function(){
  var KEY='lbnc-libreta-lideres-v1',data={};
  try{data=JSON.parse(localStorage.getItem(KEY)||'{}')}catch(e){data={}}
  function persist(){try{localStorage.setItem(KEY,JSON.stringify(data))}catch(e){}}
  function grow(e){e.style.height='auto';e.style.height=Math.max(108,e.scrollHeight)+'px'}
  var dev=null;
  try{dev=localStorage.getItem('lbnc-libreta-lideres-device')}catch(e){}
  if(!dev){dev=(window.crypto&&crypto.randomUUID?crypto.randomUUID():String(Math.random()).slice(2)+String(Date.now())).replace(/[^A-Za-z0-9_-]/g,'');while(dev.length<16)dev+='x';try{localStorage.setItem('lbnc-libreta-lideres-device',dev)}catch(e){}}
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
      sec.querySelectorAll('.q,.lbl,textarea').forEach(function(n){
        if(n.tagName==='TEXTAREA')o.push(q(n));
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

const SCRIPT = `
(function(){
  var state=document.getElementById('re-state');
  function say(t){state.textContent=t;state.parentNode.style.visibility=t?'visible':'hidden'}
  function grow(e){e.style.height='auto';e.style.height=Math.max(108,e.scrollHeight)+'px'}
  var timers={},pending=0;
  function save(e){
    var k=e.getAttribute('data-k');
    fetch('/libreta-lideres/guardar',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({k:k,v:e.value})})
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
  const o = ['LIBRETA DE LÍDERES — PROPUESTAS', ''];
  for (const p of ll.PERSONAS) {
    o.push(`${p.n}. ${p.name.toUpperCase()}`, `Punto que expuso: ${p.punto}`, `Solución clave: ${p.solucion}`);
    for (const [c, l] of ll.CAMPOS) o.push(`${l}:`, v(ll.keyOf(p.n, c)));
    o.push('');
  }
  return o.join('\n');
}

/** Pestaña "Libreta de líderes": hoja con cajas de texto que se guardan solas en la base. */
function libretaLideresRouter(ctx) {
  const { db, config } = ctx;
  const r = express.Router();
  r.use('/libreta-lideres', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  r.get(
    '/libreta-lideres',
    ah(async (req, res) => {
      const d = await ll.loadAll(db);
      const h = sheet(d);
      const link = await ll.ensureLink(db);
      const nResp = await ll.countSubmissions(db);
      const url = `${String(config.publicUrl || '').replace(/\/$/, '')}/libreta-lideres/${link.token}`;
      const body = `<style>${CSS}</style>
        <h1>Libreta de líderes — propuestas</h1>
        <p class="sub">Las 7 propuestas de los líderes y coordinadores, con el punto que cada uno expuso y su solución clave. Lo que se escribe en las casillas se guarda solo y lo ve cualquiera que entre al panel. El equipo pastoral no está en esta libreta.</p>
        <div class="card">
          <h2 style="margin-top:0">Libreta para los líderes</h2>
          <p class="muted" style="margin:0 0 10px">Envía este enlace por WhatsApp: cada persona abre solo esta libreta en el teléfono, sin entrar al CRM. Lo que escribe se queda en su teléfono hasta que toque «Enviar a la iglesia»; entonces llega a <a href="/libreta-lideres/respuestas">Respuestas de los líderes (${nResp})</a>.</p>
          ${link.active ? `<input type="text" readonly value="${esc(url)}" onclick="this.select()" class="mono">` : '<p><span class="badge b-warn">Enlace apagado</span></p>'}
          <div class="actions">
            ${link.active ? `<a class="btn small" href="https://wa.me/?text=${encodeURIComponent('Libreta de líderes — propuestas: ' + url)}" target="_blank" rel="noopener">Enviar por WhatsApp</a>` : ''}
            <form class="inline" method="post" action="/libreta-lideres/enlace/${link.active ? 'apagar' : 'encender'}"><button class="sec small">${link.active ? 'Apagar enlace' : 'Encender enlace'}</button></form>
            <form class="inline" method="post" action="/libreta-lideres/enlace/regenerar" onsubmit="return confirm('El enlace anterior dejará de funcionar. ¿Generar uno nuevo?')"><button class="sec small">Generar enlace nuevo</button></form>
          </div>
        </div>
        <div class="re-state"><span id="re-state"></span></div>
        <div class="re">${h}</div>
        <div class="actions"><button type="button" class="sec" id="re-copy">Copiar todo</button>
          <form class="inline" method="post" action="/libreta-lideres/borrar" onsubmit="return confirm('¿Borrar todo lo escrito en la hoja? No se puede deshacer.')"><button class="danger">Borrar todo</button></form></div>
        <textarea id="re-text" hidden readonly style="min-height:200px">${esc(compile(d))}</textarea>
        <script>${SCRIPT}</script>`;
      res.send(layout({ title: 'Libreta de líderes', active: '/libreta-lideres', body, config, query: req.query }));
    })
  );

  r.post(
    '/libreta-lideres/guardar',
    ah(async (req, res) => {
      const ok = await ll.saveField(db, String(req.body && req.body.k), req.body && req.body.v);
      res.sendStatus(ok ? 204 : 400);
    })
  );

  r.post(
    '/libreta-lideres/borrar',
    ah(async (req, res) => {
      await ll.clearAll(db);
      res.redirect(303, '/libreta-lideres?ok=' + encodeURIComponent('Hoja borrada.'));
    })
  );

  r.get(
    '/libreta-lideres/respuestas',
    ah(async (req, res) => {
      const rows = await ll.listSubmissions(db);
      const porPersona = req.query.ver === 'persona';
      const fecha = (d) => new Date(d).toLocaleString('es-VE', { timeZone: config.timezone, dateStyle: 'short', timeStyle: 'short' });
      const bloque = (nombre, texto) => `<p style="margin:4px 0 10px"><strong>${esc(nombre)}:</strong> <span style="white-space:pre-wrap">${esc(texto)}</span></p>`;
      let h = '';
      if (porPersona) {
        for (const x of rows) {
          let inner = '';
          const campo = (k, etiqueta) => (x.answers[k] ? `<p class="muted" style="margin:10px 0 0;font-size:13px">${esc(etiqueta)}</p><p style="margin:2px 0;white-space:pre-wrap">${esc(x.answers[k])}</p>` : '');
          for (const p of ll.PERSONAS) for (const [c, l] of ll.CAMPOS) inner += campo(ll.keyOf(p.n, c), `${p.n}. ${p.name} · ${l}`);
          h += `<div class="card"><div style="display:flex;justify-content:space-between;gap:10px;align-items:baseline"><h2 style="margin:0">${esc(x.name)}</h2><span class="muted" style="font-size:12px">${esc(fecha(x.updated_at))}</span></div>${inner}
            <form method="post" action="/libreta-lideres/respuestas/${x.id}/borrar" onsubmit="return confirm('¿Borrar la respuesta de ${esc(x.name).replace(/'/g, '')}?')" style="margin-top:12px"><button class="danger small">Borrar</button></form></div>`;
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
        for (const p of ll.PERSONAS) h += seccion(`${p.n}. ${p.name}`, ll.CAMPOS.map(([c, l]) => [ll.keyOf(p.n, c), l]));
      }
      const body = `<p><a href="/libreta-lideres">← Libreta de líderes</a></p><h1>Respuestas de los líderes</h1>
        <p class="sub">${rows.length} ${rows.length === 1 ? 'persona ha enviado' : 'personas han enviado'} su libreta.</p>
        <div class="actions"><a class="btn ${porPersona ? 'sec' : ''} small" href="/libreta-lideres/respuestas">Por propuesta</a><a class="btn ${porPersona ? '' : 'sec'} small" href="/libreta-lideres/respuestas?ver=persona">Por persona</a></div>
        ${h || '<div class="card muted">Aún no ha llegado ninguna respuesta.</div>'}`;
      res.send(layout({ title: 'Respuestas de los líderes', active: '/libreta-lideres', body, config, query: req.query }));
    })
  );

  r.post(
    '/libreta-lideres/respuestas/:id/borrar',
    ah(async (req, res) => {
      const id = /^\d{1,9}$/.test(req.params.id) ? Number(req.params.id) : 0;
      const ok = id && (await ll.deleteSubmission(db, id));
      res.redirect(303, '/libreta-lideres/respuestas?' + (ok ? 'ok=' + encodeURIComponent('Respuesta borrada.') : 'err=' + encodeURIComponent('No se encontró esa respuesta.')));
    })
  );

  r.post(
    '/libreta-lideres/enlace/:accion',
    ah(async (req, res) => {
      const a = req.params.accion;
      const go = (ok) => res.redirect(303, '/libreta-lideres?ok=' + encodeURIComponent(ok));
      if (a === 'regenerar') {
        await ll.regenerateLink(db);
        return go('Enlace nuevo generado. El anterior ya no funciona; vuelve a enviarlo.');
      }
      if (a !== 'apagar' && a !== 'encender') return res.sendStatus(404);
      await ll.ensureLink(db);
      await ll.setLinkActive(db, a === 'encender');
      go(a === 'encender' ? 'Enlace encendido.' : 'Enlace apagado.');
    })
  );

  return r;
}

/**
 * Libreta de los líderes: sin sesión, protegida por el enlace secreto. No lee ni escribe la hoja del panel.
 * El panel comparte el prefijo /libreta-lideres: los segmentos cortos de sus rutas (respuestas,
 * guardar, …) no son tokens (un token tiene 16+ caracteres), así que se dejan pasar con next()
 * para que los atienda el guardia de sesión y el router del panel.
 */
function libretaLideresRemotaRouter(ctx) {
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
<title>Libreta de líderes — propuestas</title><style>${REMOTE_CSS}${CSS}</style></head><body><div class="wrapr">${body}</div>${extra}</body></html>`,
  });
  const send = (res, o) => {
    res.setHeader('Cache-Control', 'no-store');
    res.status(o.status).send(o.html);
  };
  const esToken = (t) => /^[A-Za-z0-9_-]{16,64}$/.test(String(t));

  r.get(
    '/libreta-lideres/:token',
    ah(async (req, res, next) => {
      if (!esToken(req.params.token)) return next();
      if (!limiter.take(`${req.ip}|get`)) return res.sendStatus(429);
      if (!(await ll.linkIsValid(db, req.params.token))) {
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
    '/libreta-lideres/:token/enviar',
    ah(async (req, res) => {
      if (!(await ll.linkIsValid(db, req.params.token))) return res.sendStatus(404);
      if (!sendLimiter.take(`${req.ip}|${req.params.token}`)) return res.sendStatus(429);
      const sub = ll.parseSubmission(req.body);
      if (sub.errors.length) return res.status(400).json({ errors: sub.errors });
      await ll.saveSubmission(db, sub.value);
      res.sendStatus(204);
    })
  );

  return r;
}

module.exports = { libretaLideresRouter, libretaLideresRemotaRouter };
