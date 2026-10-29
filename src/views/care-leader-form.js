'use strict';
const { esc } = require('../util');

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
        ${t('leader_name', 'Nombre del líder o líderes', 'maxlength="120" required')}
        <label for="leader_birth_date">Fecha de nacimiento del líder</label><input id="leader_birth_date" type="date" name="leader_birth_date" min="1910-01-01" max="${esc(today)}" value="${esc(v.leader_birth_date || '')}">
        ${t('co_leader_name', 'Pareja o co-líder, si lo hay (opcional)')}
        <label for="co_leader_birth_date">Fecha de nacimiento de la pareja o co-líder</label><input id="co_leader_birth_date" type="date" name="co_leader_birth_date" min="1910-01-01" max="${esc(today)}" value="${esc(v.co_leader_birth_date || '')}">
        <label for="leader_phone">Teléfono (WhatsApp)</label><input id="leader_phone" type="tel" inputmode="tel" name="leader_phone" value="${esc(v.leader_phone_input ?? '')}" placeholder="0414-000.00.00">
        <label for="leader_email">Correo (opcional)</label><input id="leader_email" type="email" inputmode="email" name="leader_email" value="${esc(v.leader_email || '')}">
        ${t('advisor_name', 'Líder asesor (opcional)')}
        <h2>Foto</h2>
        <p class="muted" style="font-size:14px;margin:6px 0">Una foto del líder o de la pareja, de frente y con buena luz. Es opcional.</p>
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
        ${t('address', 'Dirección o punto de referencia')}
        ${sel('stage', 'Etapa del grupo', stages)}
        <h2>Pertenencia</h2>
        ${t('belongs_to', 'Pertenece a (opcional)')}
        ${skipCongregation ? '' : sel('congregation', 'Congregación', v.congregation && !congregations.includes(v.congregation) ? [...congregations, v.congregation] : congregations)}`;
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
        })();
      </script>`;

module.exports = { leaderFields, PHOTO_SCRIPT };
