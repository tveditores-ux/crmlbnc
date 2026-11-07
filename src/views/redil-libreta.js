'use strict';
const { esc } = require('../util');
const { CSS, REMOTE_CSS, squig } = require('../routes/reunion-equipo');

/**
 * Libretica del REDIL con el mismo aspecto de cuaderno manuscrito de /reunion-equipo: letra a mano, renglones y una caja por punto.
 * leaderPage = la que escribe el líder en su teléfono; sheet(..., { readOnly: true }) = la misma hoja para leer desde el panel.
 */
const EXTRA_CSS = `
.re .pt{margin:0 0 4px;font-size:26px;line-height:1.15;display:flex;gap:10px}
.re .pt .n{flex:none;font-size:34px;line-height:30px;width:42px}
.re .pt+.pt{margin-top:10px}
.re .pregunta{margin:0 0 34px 52px}
.re .resp{margin:6px 0 0;padding:6px 10px;border-left:3px solid #2f6b4f;background:rgba(47,107,79,.08);font-size:24px;line-height:1.15}
.re .who{font-size:23px;margin:0 0 30px;color:#555}
.re .intro{font-size:26px;margin:0 0 34px}
.tools a{font:inherit;font-size:24px;text-transform:uppercase;color:#2b2b2b;text-decoration:none;border:1.5px solid #2b2b2b;border-radius:3px 10px 4px 9px;padding:8px 16px}
.re .pregunta textarea{min-height:144px}
`;

const para = (lines) => lines.map((t) => `<span style="display:block;margin-bottom:4px">${esc(t)}</span>`).join('');

/** Las secciones. mine = Map(punto → { question, answer }) con lo que el grupo ya envió (solo hoja del líder). */
function sheet(L, { mine = new Map(), readOnly = false, counts = new Map() } = {}) {
  let seed = 11;
  let h = '';
  L.sections.forEach((s, i) => {
    h += `<section><h2>${String(i + 1).padStart(2, '0')} · ${esc(s.title)}${squig((seed += 7))}</h2>`;
    for (const p of s.points) {
      const m = mine.get(p.n);
      h += `<div class="pt" id="p${p.n}"><span class="n">${String(p.n).padStart(2, '0')}</span><div>${para(p.text)}</div></div>`;
      if (readOnly) {
        if (counts.get(p.n)) h += `<div class="pregunta"><a href="/redil/preguntas?ver=todas" style="color:#8a6116;font-size:22px">${counts.get(p.n)} pregunta(s) recibida(s)</a></div>`;
        else h += '<div class="pregunta"></div>';
      } else {
        h += `<div class="pregunta"><p class="lbl" style="margin-top:6px">Mi pregunta o comentario</p><textarea data-k="p${p.n}" rows="4" spellcheck="false" autocomplete="off" maxlength="1500" aria-label="Mi pregunta sobre el punto ${p.n}">${esc(m ? m.question : '')}</textarea>${
          m && m.answer ? `<p class="resp"><strong>Respuesta:</strong> ${esc(m.answer)}</p>` : ''
        }</div>`;
      }
    }
    h += '</section>';
  });
  return h;
}

/** Script de la hoja del líder: borrador en el propio teléfono, envío a la iglesia, copiar y WhatsApp. */
const LEADER_SCRIPT = `
(function(){
  var cfg=window.__LIB,KEY='lbnc-redil-'+cfg.key+'-'+cfg.tok,data={};
  try{data=JSON.parse(localStorage.getItem(KEY)||'{}')}catch(e){data={}}
  function persist(){try{localStorage.setItem(KEY,JSON.stringify(data))}catch(e){}}
  function grow(e){e.style.height='auto';e.style.height=Math.max(144,e.scrollHeight)+'px'}
  var open=!!cfg.open,nameEl=document.getElementById('nombre'),devKey='lbnc-redil-dev',device='';
  if(open){
    try{device=localStorage.getItem(devKey)||''}catch(e){}
    if(!/^[A-Za-z0-9_-]{16,64}$/.test(device)){device='';var c='abcdefghijklmnopqrstuvwxyz0123456789';for(var i=0;i<28;i++)device+=c.charAt(Math.floor(Math.random()*c.length));try{localStorage.setItem(devKey,device)}catch(e){}}
    if(data.__nombre)nameEl.value=data.__nombre;
    nameEl.addEventListener('input',function(){data.__nombre=nameEl.value;persist()});
  }
  var msg=document.getElementById('msg');
  function say(t){msg.textContent=t;setTimeout(function(){msg.textContent=''},3000)}
  var boxes=document.querySelectorAll('.re textarea');
  boxes.forEach(function(e){
    var k=e.getAttribute('data-k');
    if(data[k]!==undefined)e.value=data[k]; /* un borrador sin enviar gana sobre lo ya enviado */
    grow(e);
    e.addEventListener('input',function(){data[k]=e.value;persist();grow(e)});
  });
  function compile(){
    var o=['REDIL EXTRAORDINARIO — LIBRETICA',open?(nameEl.value.trim()||'(sin nombre)'):cfg.who,''];
    document.querySelectorAll('.re .pt').forEach(function(pt){
      var ta=document.querySelector('[data-k="p'+parseInt(pt.querySelector('.n').textContent,10)+'"]');
      if(ta&&ta.value.trim()){o.push(pt.querySelector('.n').textContent+'. '+pt.querySelector('div').textContent.trim().slice(0,90));o.push('   Mi pregunta: '+ta.value.trim());o.push('')}
    });
    var g=document.querySelector('[data-k="general"]');
    if(g&&g.value.trim()){o.push('PREGUNTA GENERAL');o.push(g.value.trim())}
    return o.join('\\n');
  }
  function fb(t){var x=document.createElement('textarea');x.value=t;document.body.appendChild(x);x.select();try{document.execCommand('copy');say('Copiado')}catch(e){say('No se pudo copiar')}document.body.removeChild(x)}
  document.getElementById('send').onclick=function(){
    var ans={};boxes.forEach(function(e){ans[e.getAttribute('data-k')]=e.value});
    if(open&&nameEl.value.trim().length<2){say('Escribe tu nombre para poder enviar');nameEl.focus();return}
    say('Enviando…');
    var payload=open?{name:nameEl.value,device:device,answers:ans}:{answers:ans};
    fetch(location.pathname+'/enviar',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)})
      .then(function(r){
        if(r.ok||r.status===204){var nm=data.__nombre;data={};if(nm)data.__nombre=nm;persist();say(open?'Enviado a REDIL del CRM. Gracias':'Enviado a la iglesia. Gracias')}
        else if(r.status===400)return r.json().then(function(j){say((j.errors||['No se pudo enviar'])[0])});
        else throw 0})
      .catch(function(){say('No se pudo enviar. Tu borrador sigue guardado en este teléfono')});
  };
  document.getElementById('copy').onclick=function(){var t=compile();try{navigator.clipboard.writeText(t).then(function(){say('Copiado')},function(){fb(t)})}catch(e){fb(t)}};
  document.getElementById('wa').onclick=function(){window.location.href='https://wa.me/?text='+encodeURIComponent(compile())};
})();`;

function shell(title, body, extra = '') {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">
<meta name="theme-color" content="#faf8f3">
<link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="apple-touch-icon" href="/apple-touch-icon.png">
<title>${esc(title)}</title><style>${REMOTE_CSS}${CSS}${EXTRA_CSS}</style></head><body><div class="wrapr">${body}</div>${extra}</body></html>`;
}

/** Hoja del líder (enlace secreto de su grupo). */
function leaderPage({ L, group, token, mine, libretaKey }) {
  const who = `${group.leader_name || group.name} · ${group.name}`;
  const body = `<div class="re"><p style="margin:0 0 18px"><a href="/g/${esc(token)}/redil" style="color:#2b2b2b;font-size:22px">← Volver</a></p>
    <h2>${esc(L.title)}${squig(3)}</h2>
    <p class="who">${esc(L.when)}</p>
    <p class="intro">${esc(L.intro)}</p>
    <p class="who">Escribo como: <strong>${esc(who)}</strong>. Lo que envíe le llega al equipo con mi nombre.</p>
    ${sheet(L, { mine })}
    <section><h2>Otra pregunta${squig(97)}</h2><p class="pt">¿Algo que no está en los puntos?</p>
      <div class="pregunta" style="margin-left:0"><textarea data-k="general" rows="4" spellcheck="false" autocomplete="off" maxlength="1500" aria-label="Pregunta general">${esc((mine.get(null) || {}).question || '')}</textarea>${
        (mine.get(null) || {}).answer ? `<p class="resp"><strong>Respuesta:</strong> ${esc(mine.get(null).answer)}</p>` : ''
      }</div></section>
    <div class="tools"><button type="button" id="send">Enviar a la iglesia</button><button type="button" id="copy">Copiar todo</button><button type="button" id="wa">Enviar por WhatsApp</button><span id="msg"></span></div></div>`;
  const cfg = `<script>window.__LIB=${JSON.stringify({ key: libretaKey, tok: token.slice(0, 10), who }).replace(/</g, '\\u003c')}</script>`;
  return shell('Libretica del REDIL', body, `${cfg}<script>${LEADER_SCRIPT}</script>`);
}

/** Hoja del enlace común (control remoto): abre solo la libretica; quien la abre escribe su nombre y envía al CRM. No lee nada de la base. */
function openPage({ L, token, libretaKey }) {
  const body = `<div class="re">
    <h2>${esc(L.title)}${squig(3)}</h2>
    <p class="who">${esc(L.when)}</p>
    <p class="intro">${esc(L.intro)}</p>
    <p class="lbl" style="margin-top:0">Mi nombre</p>
    <input id="nombre" maxlength="80" autocomplete="name" placeholder="Escribe tu nombre" style="border-bottom:1px solid #b9b6ae;height:36px;margin-bottom:40px">
    ${sheet(L)}
    <section><h2>Otra pregunta${squig(97)}</h2><p class="pt">¿Algo que no está en los puntos?</p>
      <div class="pregunta" style="margin-left:0"><textarea data-k="general" rows="4" spellcheck="false" autocomplete="off" maxlength="1500" aria-label="Pregunta general"></textarea></div></section>
    <div class="tools"><button type="button" id="send">Enviar a REDIL del CRM</button><button type="button" id="copy">Copiar todo</button><button type="button" id="wa">Enviar por WhatsApp</button><span id="msg"></span></div></div>`;
  const cfg = `<script>window.__LIB=${JSON.stringify({ key: libretaKey, tok: token.slice(0, 10), who: '', open: true }).replace(/</g, '\\u003c')}</script>`;
  return shell('Libretica del REDIL', body, `${cfg}<script>${LEADER_SCRIPT}</script>`);
}

module.exports = { leaderPage, openPage, sheet, EXTRA_CSS };
