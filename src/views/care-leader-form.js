'use strict';
const { esc } = require('../util');

const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

/** Fecha de nacimiento como tres selectores (día, mes y año): en el teléfono salen como ruedas. */
function birthRoll(v, today) {
  const [y, m, d] = v.bd_year !== undefined ? [v.bd_year, v.bd_month, v.bd_day] : String(v.leader_birth_date || '').split('-');
  const opt = (value, label, cur) => `<option value="${value}" ${String(cur) === String(value) ? 'selected' : ''}>${label}</option>`;
  const days = Array.from({ length: 31 }, (_, i) => opt(String(i + 1).padStart(2, '0'), i + 1, d));
  const months = MONTHS.map((n, i) => opt(String(i + 1).padStart(2, '0'), n, m));
  const last = Number(String(today).slice(0, 4)) - 10;
  const years = Array.from({ length: last - 1909 }, (_, i) => opt(last - i, last - i, y));
  const st = 'font-size:18px;padding:12px 6px;width:100%;border-radius:10px;border:1px solid var(--line)';
  return `<label>Fecha de nacimiento del líder</label>
        <div class="triple">
          <div><select name="bd_day" aria-label="Día" style="${st}"><option value="">Día</option>${days.join('')}</select></div>
          <div><select name="bd_month" aria-label="Mes" style="${st}"><option value="">Mes</option>${months.join('')}</select></div>
          <div><select name="bd_year" aria-label="Año" style="${st}"><option value="">Año</option>${years.join('')}</select></div>
        </div>`;
}

/**
 * Campos del líder y del grupo (datos, nacimiento, foto, reunión, pertenencia).
 * Los usan el formulario de cada grupo (/g/<token>/datos) y el enlace común (/registro/<token>),
 * para que los dos pidan exactamente lo mismo.
 *  v: valores actuales; today: 'YYYY-MM-DD'; photoSrc: vista previa inicial ('' = sin foto).
 */
function leaderFields(v, { today, photoSrc = '', stages, days, congregations = [], skipCongregation = false }) {
  const t = (name, label, extra = '') => `<label for="${name}">${label}</label><input id="${name}" type="text" name="${name}" value="${esc(v[name] || '')}" ${extra}>`;
  const sel = (name, label, options) =>
    `<label for="${name}">${label}</label><select id="${name}" name="${name}" style="font-size:18px;padding:12px;width:100%;border-radius:10px;border:1px solid var(--line)"><option value="">Sin definir</option>${options
      .map((o) => `<option ${v[name] === o ? 'selected' : ''}>${esc(o)}</option>`)
      .join('')}</select>`;
  const preview = v.photo_data ? `src="${esc(v.photo_data)}"` : photoSrc ? `src="${esc(photoSrc)}"` : 'style="display:none"';
  return `<h2>Líder</h2>
        ${t('leader_name', 'Nombre y apellido', 'maxlength="120" required placeholder="Nombre y apellido" autocomplete="off"')}
        ${birthRoll(v, today)}
        <label for="leader_cedula">Cédula de identidad (C.I.) del líder</label><input id="leader_cedula" type="text" inputmode="text" autocapitalize="characters" name="leader_cedula" required maxlength="14" value="${esc(v.leader_cedula || '')}" placeholder="V-12345678">
        ${t('leader_address', 'Dirección del líder', 'maxlength="250" required')}
        <label for="leader_phone">Teléfono del líder (WhatsApp)</label><input id="leader_phone" type="tel" inputmode="tel" name="leader_phone" required value="${esc(v.leader_phone_input ?? '')}" placeholder="0414-000.00.00">
        <label for="leader_email">Correo del líder</label><input id="leader_email" type="email" inputmode="email" name="leader_email" required value="${esc(v.leader_email || '')}">

        ${skipCongregation ? '' : sel('congregation', 'Congregación', v.congregation && !congregations.includes(v.congregation) ? [...congregations, v.congregation] : congregations)}
        <h2>Foto del líder</h2>
        <p class="muted" style="font-size:14px;margin:6px 0"><strong>Cargar tu fotografía es necesario para completar el registro de tu ficha de liderazgo.</strong> Una foto del líder, de frente y con buena luz.</p>
        <div class="photo-box">
          <img id="photo_prev" alt="Vista previa de la foto" ${preview}>
          <div class="quick">
            <label class="btn sec photo-btn">Tomar foto<input id="photo_cam" type="file" accept="image/*" capture="user" hidden></label>
            <label class="btn sec photo-btn">Elegir de la galería<input id="photo_gal" type="file" accept="image/*" hidden></label>
          </div>
          <p id="photo_msg" class="muted" style="font-size:13px;margin:6px 0 0"></p>
          <input type="hidden" id="photo_data" name="photo_data" value="${esc(v.photo_data || '')}">
        </div>
        <h2>Reunión</h2>
        ${sel('meeting_day', 'Día', days)}
        <label for="meeting_time">Hora</label><input id="meeting_time" type="time" name="meeting_time" value="${esc(v.meeting_time || '')}">
        ${t('place', 'Lugar de reunión')}
        ${t('address', 'Dirección o punto de referencia del lugar de reunión')}
        ${sel('stage', 'Etapa del grupo', stages)}`;
}

/** La foto se reduce y se reconvierte a JPEG en el teléfono (así no viaja la ubicación). */
const PHOTO_SCRIPT = `<script>
        (function () {
          var data = document.getElementById('photo_data'), prev = document.getElementById('photo_prev'), msg = document.getElementById('photo_msg');
          function take(file) {
            if (!file) return;
            msg.textContent = 'Preparando la foto…';
            var url = URL.createObjectURL(file), img = new Image();
            img.onload = function () {
              var s = Math.min(1, 900 / Math.max(img.width, img.height)), c = document.createElement('canvas');
              c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
              c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
              data.value = c.toDataURL('image/jpeg', 0.82);
              prev.src = data.value; prev.style.display = 'block';
              msg.textContent = 'Foto lista. Se enviará al guardar.';
              URL.revokeObjectURL(url);
            };
            img.onerror = function () { msg.textContent = 'No pude leer esa foto. Prueba con otra.'; URL.revokeObjectURL(url); };
            img.src = url;
          }
          ['photo_cam', 'photo_gal'].forEach(function (id) { document.getElementById(id).addEventListener('change', function (e) { take(e.target.files[0]); }); });
          var form = data.closest('form');
          if (form) form.addEventListener('submit', function (e) {
            if (!data.value && !prev.getAttribute('src')) { e.preventDefault(); msg.textContent = 'Cargar tu fotografía es necesario para completar el registro de tu ficha de liderazgo.'; msg.style.color = 'var(--bad)'; prev.scrollIntoView({ block: 'center' }); }
          });
        })();
      </script>`;

module.exports = { leaderFields, PHOTO_SCRIPT };
