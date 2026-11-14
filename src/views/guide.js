'use strict';
/**
 * Modo guía: un botón "? Guía" fijo en todas las pantallas del panel. Encendido, cada pestaña del menú, botón, campo y tabla
 * explica qué hace al pasar el ratón por encima (en el teléfono, al tocarlo). Mientras está encendido, los botones y enlaces
 * NO hacen nada: solo explican, para que se pueda recorrer el sistema sin miedo a cambiar algo.
 *
 * Las explicaciones salen de: el atributo data-ayuda (si una pantalla quiere explicar algo propio), el mapa del menú, la
 * introducción de cada pantalla y reglas generales por el texto del botón o la etiqueta del campo. Todo corre en el
 * navegador; no consulta ni cambia nada en el servidor. Recuerda si estaba encendido (solo en ese navegador).
 */

// Qué es cada pestaña del menú
const NAV_HELP = {
  '/': 'Inicio: el resumen del día. Próximos eventos, lo pendiente y los números principales de un vistazo.',
  '/eventos': 'Eventos: crea los eventos de la iglesia y manda los recordatorios por WhatsApp (1 mes, 1 semana y 1 día antes). Aquí ves quién confirmó y quién no puede.',
  '/calendario': 'Calendario: todo en un mes a la vista, eventos, cumpleaños de personas y de líderes, y reuniones.',
  '/personas': 'Personas: la lista de toda la gente de la iglesia. Agregar, editar, buscar, marcar si es miembro o amigo y si aceptó recibir mensajes.',
  '/ministerios': 'Ministerios: cada ministerio, su coordinador y quiénes sirven en él.',
  '/mensajes': 'Mensajes: lo que el sistema ha enviado por WhatsApp o correo y si llegó.',
  '/asistencia': 'Asistencia: el conteo de cada servicio (inicio, mitad y final, invitados, conversiones, servidores, pastores y niños). También los enlaces para registrarlo desde el teléfono.',
  '/reporte': 'Reporte: gráficas y promedios de la asistencia y de la comunicación, por fechas y por sede. Se puede imprimir o guardar en PDF.',
  '/nueva-vida': 'Nueva Vida: las personas que tomaron la decisión de seguir a Jesús, con su carta de bienvenida y su seguimiento.',
  '/consolidacion': 'Consolidación: el camino de cada nuevo creyente. Llamada en 48 horas, reunión, Primeros Pasos, bautismo y grupo de cuidado.',
  '/bautizados': 'Bautizados: el registro de bautismos con fecha, sede y quién bautizó, sus fotos y un reporte para imprimir.',
  '/grupos': 'Grupos de cuidado: cada GdC con su líder, día y lugar, sus reportes semanales y el enlace del líder para reportar desde el teléfono.',
  '/oracion': 'Buzón de oración: las peticiones de oración que llegan por Grace o que escribes tú, para enviarlas por WhatsApp al líder del grupo o al pastor de la congregación.',
  '/guia': 'Guía del líder: las respuestas aprobadas a las dudas de los líderes. Grace solo usa las confirmadas.',
  '/reunion-equipo': 'Reunión de equipo: la hoja de la reunión y las respuestas que el equipo manda desde su teléfono.',
  '/redil/libreta': 'Libretica REDIL: los puntos de la reunión de liderazgo y su enlace para verla desde el teléfono.',
  '/redil/preguntas': 'Preguntas REDIL: las preguntas que hacen los líderes sobre la libretica, para contestarlas.',
  '/conversaciones': 'Conversaciones: los mensajes de WhatsApp que llegan al número de la iglesia y lo que respondió Grace. Los casos que Grace pasó a una persona salen marcados.',
  '/asistente': 'Asistente: la información de la iglesia que Grace puede compartir (horarios, sedes…) y un probador para ver qué respondería sin enviar nada.',
  '/grace': 'Grace (control remoto): un chat con Grace dentro del CRM para preguntarle por asistencia, grupos, reportes, cumpleaños y más.',
  '/configuracion': 'Configuración: WeCall, la clave y el cerebro de Grace, los números con acceso pastoral y el aviso diario de cumpleaños.',
  '/pruebas': 'Pruebas: herramientas para revisar que todo funcione (envíos de prueba, últimos avisos de WeCall, respuestas de Grace).',
};

// Introducción de cada pantalla (sale arriba al encender la guía)
const PAGE_HELP = {
  '/': 'Esta es la pantalla de inicio. Pasa el ratón por las tarjetas y el menú para saber qué es cada cosa.',
  '/eventos': 'Aquí están los eventos. Al crear uno, el sistema programa solo los recordatorios a las personas activas que aceptaron mensajes.',
  '/personas': 'Aquí está toda la gente. Usa el buscador de arriba de la tabla para encontrar a alguien por nombre o teléfono.',
  '/asistencia': 'Aquí se registra cada servicio. Arriba están las gráficas, luego el resumen por sede y abajo cada registro con su botón para editar.',
  '/reporte': 'Elige sede y fechas arriba y pulsa Actualizar. Los porcentajes comparan con el periodo anterior de igual duración.',
  '/grupos': 'Aquí están los grupos de cuidado. Entra a uno para ver sus reportes, su gente y el enlace de su líder.',
  '/oracion': 'Arriba escribes una petición nueva. Abajo está cada petición: elige a quién enviarla (líder, pastor o los dos) y pulsa Enviar por WhatsApp. Al final, los pastores de cada congregación y la plantilla.',
  '/grace': 'Escríbele a Grace como en WhatsApp. Ella consulta los datos del CRM y te responde. Las sugerencias de abajo son atajos.',
  '/configuracion': 'Aquí se ajusta el sistema. Lo que guardes aquí manda sobre lo que está en Railway. Las claves nunca se muestran de vuelta.',
  '/conversaciones': 'Aquí ves cada conversación de WhatsApp. Las marcadas como escaladas necesitan que alguien escriba personalmente.',
  '/asistente': 'Escribe aquí la información general de la iglesia para Grace. Abajo, el probador muestra qué respondería sin enviar nada.',
};

// Reglas por el texto del botón o enlace (se usa la primera que coincida)
const BUTTON_RULES = [
  [/^salir$/i, 'Cierra tu sesión en este equipo.'],
  [/guardar y confirmar/i, 'Guarda los cambios y marca esta respuesta como confirmada.'],
  [/guardar/i, 'Guarda lo que escribiste o cambiaste en este formulario.'],
  [/^(✕|eliminar|borrar)/i, 'Borra este registro. Siempre pide confirmación antes.'],
  [/editar/i, 'Abre este registro para corregirlo.'],
  [/filtrar|actualizar/i, 'Aplica los filtros elegidos (sede, fechas…) y vuelve a mostrar la lista.'],
  [/descargar|exportar/i, 'Descarga la lista en un archivo para abrirlo en Excel o Google Sheets.'],
  [/imprimir|pdf/i, 'Abre la ventana de impresión. Desde ahí también puedes guardarlo como PDF.'],
  [/importar|cargar/i, 'Sube una lista desde una hoja de cálculo (CSV). Primero se revisa y luego se guarda.'],
  [/enviar por whatsapp|^enviar/i, 'Envía este mensaje por WhatsApp a quien marcaste.'],
  [/archivar/i, 'La guarda en Archivadas para que no estorbe en la lista.'],
  [/reabrir/i, 'La devuelve a la lista de abiertas.'],
  [/registrar|nuev[oa]|agregar|crear/i, 'Abre el formulario para agregar uno nuevo.'],
  [/probar/i, 'Hace una prueba de solo lectura para ver si funciona. No envía mensajes.'],
  [/unificar|unir/i, 'Junta dos registros en uno. Pide confirmación y no se puede deshacer fácilmente.'],
  [/todo el historial|este año|últimos 90 días/i, 'Atajo: cambia las fechas del reporte de un solo toque.'],
];

function guideClient(data) {
  var KEY = 'crm-guia';
  var on = false;
  try { on = localStorage.getItem(KEY) === '1'; } catch (e) { /* sin almacenamiento */ }
  var path = location.pathname.replace(/\/+$/, '') || '/';
  var navKey = function (href) {
    try { var p = new URL(href, location.href).pathname.replace(/\/+$/, '') || '/'; return data.nav[p] ? p : null; } catch (e) { return null; }
  };
  var pageIntro = (function () {
    var best = '';
    Object.keys(data.pages).forEach(function (k) { if ((path === k || (k !== '/' && path.indexOf(k + '/') === 0)) && k.length > best.length) best = k; });
    return best ? data.pages[best] : (data.nav[path] || 'Pasa el ratón por cualquier botón, campo o pestaña para saber qué hace.');
  })();
  var rules = data.rules.map(function (r) { return [new RegExp(r[0], r[1]), r[2]]; });

  function labelOf(el) {
    if (el.id) { var l = document.querySelector('label[for="' + el.id + '"]'); if (l) return l.textContent; }
    var wrap = el.closest('label'); if (wrap) return wrap.textContent;
    var prev = el.previousElementSibling; if (prev && prev.tagName === 'LABEL') return prev.textContent;
    var p = el.parentElement && el.parentElement.querySelector('label'); return p ? p.textContent : '';
  }
  function clean(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }

  // la explicación de un elemento, o null
  function explain(el) {
    var own = el.closest('[data-ayuda]'); if (own) return own.getAttribute('data-ayuda');
    var a = el.closest('a[href]');
    if (a && a.closest('nav')) { var k = navKey(a.getAttribute('href')); if (k) return data.nav[k]; }
    var btn = el.closest('button, a.btn, a[href], input[type=submit]');
    if (btn) {
      var t = clean(btn.textContent || btn.value || btn.getAttribute('aria-label') || btn.title);
      for (var i = 0; i < rules.length; i++) if (rules[i][0].test(t)) return rules[i][1];
      if (btn.title) return btn.title;
      if (btn.tagName === 'A') { var k2 = navKey(btn.getAttribute('href')); if (k2) return 'Lleva a ' + data.nav[k2]; return t ? 'Abre: ' + t + '.' : null; }
      return t ? 'Botón «' + t + '».' : null;
    }
    var f = el.closest('input, select, textarea');
    if (f) {
      if (f.type === 'checkbox') return 'Casilla: ' + clean(labelOf(f)) + '. Márcala o desmárcala.';
      if (f.type === 'search') return 'Buscador: escribe un nombre o un teléfono y la tabla de abajo muestra solo lo que coincide.';
      var lab = clean(labelOf(f)).replace(/\(opcional\)/i, '').trim();
      var what = f.tagName === 'SELECT' ? 'Elige una opción' : f.type === 'date' ? 'Elige la fecha' : 'Escribe aquí';
      return (lab ? lab + ': ' : '') + what + (f.required ? ' (obligatorio).' : '.');
    }
    if (el.closest('table')) return 'Tabla: cada fila es un registro. Si la tabla es ancha, deslízala hacia los lados.';
    if (el.closest('.badge')) return 'Etiqueta de estado: dice en qué situación está este registro.';
    if (el.closest('.card .stat, .stat-label')) return 'Indicador: un número resumen del periodo elegido.';
    if (el.closest('svg')) return 'Gráfica: pasa el ratón sobre las barras o puntos para ver el número exacto.';
    return null;
  }

  var tip = document.createElement('div'); tip.className = 'guia-tip'; tip.setAttribute('role', 'tooltip');
  var bar = document.createElement('div'); bar.className = 'guia-bar no-print';
  bar.innerHTML = '<strong>Modo guía</strong> <span></span> <button type="button" class="small">Salir de la guía</button>';
  bar.querySelector('span').textContent = pageIntro + ' Mientras la guía está encendida, los botones no hacen nada: solo explican.';
  var btn = document.createElement('button'); btn.type = 'button'; btn.className = 'guia-btn no-print';
  btn.setAttribute('aria-pressed', 'false'); btn.title = 'Encender o apagar la guía';
  document.body.appendChild(tip); document.body.insertBefore(bar, document.body.firstChild); document.body.appendChild(btn);

  var current = null;
  function hide() { tip.style.display = 'none'; if (current) current.classList.remove('guia-sel'); current = null; }
  function show(el, text, x, y) {
    if (current !== el) { if (current) current.classList.remove('guia-sel'); current = el; el.classList.add('guia-sel'); }
    tip.textContent = text; tip.style.display = 'block';
    var r = el.getBoundingClientRect(), w = tip.offsetWidth, h = tip.offsetHeight;
    var left = Math.min(Math.max(8, (x != null ? x : r.left) - w / 2 + (x != null ? 0 : r.width / 2)), window.innerWidth - w - 8);
    var top = r.bottom + 8 + h > window.innerHeight ? r.top - h - 8 : r.bottom + 8;
    tip.style.left = left + 'px'; tip.style.top = Math.max(8, top) + 'px';
  }
  function target(e) {
    var el = e.target;
    // el botón ☰ sigue funcionando, para poder abrir el menú y recorrerlo en el teléfono
    if (!el || !el.closest || el.closest('.guia-btn, .guia-bar, .guia-tip, .menu-btn, #menu-abierto')) return null;
    var host = el.closest('a, button, input, select, textarea, label, table, .badge, .card .stat, .stat-label, svg, [data-ayuda]');
    return host ? { el: host, text: explain(el) } : null;
  }
  function set(v) {
    on = v;
    document.body.classList.toggle('guia-on', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.textContent = on ? '✕ Cerrar guía' : '? Guía';
    try { localStorage.setItem(KEY, on ? '1' : '0'); } catch (e) { /* sin almacenamiento */ }
    if (!on) hide();
  }
  btn.addEventListener('click', function () { set(!on); });
  bar.querySelector('button').addEventListener('click', function () { set(false); });
  document.addEventListener('mouseover', function (e) {
    if (!on) return;
    var t = target(e); if (t && t.text) show(t.el, t.text); else hide();
  });
  // mientras la guía está encendida, tocar o hacer clic explica en vez de actuar
  document.addEventListener('click', function (e) {
    if (!on) return;
    var t = target(e); if (!t) return;
    e.preventDefault(); e.stopPropagation();
    if (t.text) show(t.el, t.text, e.clientX); else hide();
  }, true);
  document.addEventListener('submit', function (e) { if (on) e.preventDefault(); }, true);
  document.addEventListener('keydown', function (e) { if (on && e.key === 'Escape') set(false); });
  window.addEventListener('scroll', function () { if (on) hide(); }, { passive: true });
  set(on);
}

const GUIDE_CSS = `
.guia-btn{position:fixed;right:16px;bottom:16px;z-index:60;border-radius:999px;padding:10px 16px;font-weight:600;box-shadow:0 4px 14px rgba(0,0,0,.18)}
body.guia-on .guia-btn{background:var(--ink);color:#f5f2eb}
.guia-bar{display:none;position:sticky;top:0;z-index:55;background:#fff5d6;color:var(--ink);border-bottom:2px solid #d9b56a;padding:8px 16px;font-size:14px}
.guia-bar button{margin-left:8px}
body.guia-on .guia-bar{display:block}
body.guia-on a,body.guia-on button,body.guia-on input,body.guia-on select,body.guia-on textarea,body.guia-on label,body.guia-on table{cursor:help}
.guia-sel{outline:2px dashed #b4842a!important;outline-offset:2px}
.guia-tip{display:none;position:fixed;z-index:70;max-width:min(340px,calc(100vw - 16px));background:var(--ink);color:#f5f2eb;padding:9px 12px;border-radius:8px;font-size:13.5px;line-height:1.45;box-shadow:0 6px 18px rgba(0,0,0,.25);pointer-events:none}
@media print{.guia-btn,.guia-bar,.guia-tip{display:none!important}}`;

const GUIDE_SCRIPT = `<script>(${guideClient.toString()})(${JSON.stringify({
  nav: NAV_HELP,
  pages: PAGE_HELP,
  rules: BUTTON_RULES.map(([re, text]) => [re.source, re.flags, text]),
}).replace(/</g, '\\u003c')});</script>`;

module.exports = { GUIDE_SCRIPT, GUIDE_CSS, NAV_HELP, PAGE_HELP, BUTTON_RULES };
