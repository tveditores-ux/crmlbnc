'use strict';

/**
 * Libretica digital del REDIL: los puntos a tratar, agrupados por tema, y las preguntas que los líderes escriben.
 * El contenido sale de la libretica en PDF de la iglesia y se conserva como fue compartido (el equipo pidió no reescribirlo).
 * Cada libretica es un dato aquí; la que está en uso es ACTIVE. Las preguntas se guardan en redil_questions.
 */
const LIBRETAS = {
  'redil-extraordinario-2026-11-07': {
    title: 'REDIL extraordinario',
    when: 'Sábado 7 de noviembre de 2026 · 9:00 a. m. a 12:00 m.',
    intro:
      'Puntos para exponer, conversar y registrar los acuerdos del equipo. Los planteamientos se conservan como fueron compartidos y se agrupan por tema. Las preguntas quedan abiertas para su consideración en el encuentro.',
    sections: [
      {
        title: 'Cuidado y acompañamiento',
        points: [
          { n: 1, text: ['Protocolo para funerales.'] },
          { n: 2, text: ['¿Por qué presentamos los niños al Señor? Preguntar: ¿Por qué quieres presentar al niño/a bajo los fundamentos bíblicos'] },
          { n: 3, text: ['Los líderes siempre deben preguntar y luego reportar si hay algún hermano enfermo en su gdc o que tienen tiempo que no ven.'] },
          { n: 4, text: ['No casamos personas de otra congregación'] },
          { n: 5, text: ['No bautizamos personas de otra congregación'] },
        ],
      },
      {
        title: 'Integración y crecimiento',
        points: [
          { n: 6, text: ['Diferencias en la ruta de crecimiento y los tiempos de un nuevo creyente y un hermano recibido de otra congregación.'] },
          {
            n: 7,
            text: [
              'Los nuevos miembros que vienen de otra congregación debe ser conocidos por el equipo pastoral y ser tratado según su contexto (otra congregación).',
              'Darles el espacio para que se conecten y tengan un tiempo prudente de permanencia para integrarlos en la ruta de crecimiento. 1 año',
            ],
          },
          { n: 8, text: ['¿Cómo debo tratar a un miembro que asiste al grupo de cuidado pero va a otra iglesia?'] },
        ],
      },
      {
        title: 'Liderazgo y estructura',
        points: [
          { n: 9, text: ['Los líderes deben asistir a los servicios de los miércoles (domingos, redil)', 'Como responsabilidad inherente a su rol o función.'] },
          { n: 10, text: ['Los coordinadores de ministerios deben reunirse frecuentemente con su red de liderazgo para cuidado y planificación.'] },
          { n: 11, text: ['Los líderes deben comunicarse primeramente con su líder asesor o su coordinador en caso que no se cuente con la figura de líder asesor. Como parte de la estructura funcional'] },
          { n: 12, text: ['Cada líder debe expresar con convicción y fidelidad lo que ha recibido de su líder asesor, coordinador o pastor. Evitar frases como: "esta es la norma".'] },
        ],
      },
      {
        title: 'Acompañamiento al líder',
        points: [
          { n: 13, text: ['¿Qué hacer como líder si me siento intimidado por otro miembro del grupo? Porque lideraba en otra congregación o porque forma parte de otro ministerio y manifiesta conocer mucho de la Palabra'] },
          { n: 14, text: ['Los líderes asesores visitan de sorpresa a los líderes de GDC para supervisar. ¿Está correcto este proceder?'] },
          { n: 15, text: ['¿Qué hacer cuando un miembro del grupo pide ayuda financiera al resto de los miembros?'] },
          { n: 16, text: ['Ofrendas en los grupos de cuidado. Importante tomar el espacio para orar y no dar por sentado que los miembros no están dando.'] },
        ],
      },
      {
        title: 'Enseñanza y capacitación',
        points: [
          { n: 17, text: ['¿Por qué cambiaron el nombre del taller PADRE por VIDA? Este cambio afecta la estructura del GdC y sus etapas?'] },
          { n: 18, text: ['¿Qué se enseña dentro de los grupos de cuidado/ cual es el propósito?'] },
          { n: 19, text: ['¿Quien inscribe a los participantes en la ruta de crecimiento? Que ocurre cuando cierra el periodo de inscripción? Como lider puedo enviar a los talleres a miembros del gdc sin haberlos registrado en el plazo fijado.'] },
          { n: 20, text: ['Cuantos talleres del Riel de capacitación se puede realizar por ciclo? En la mesa pastoral acordamos que es un taller por ciclo.'] },
        ],
      },
      {
        title: 'Reuniones del grupo',
        points: [
          { n: 21, text: ['Si no me congrego un domingo que comparto en el gdc?'] },
          { n: 22, text: ['Si las condiciones no estan dadas para que el líder lleve a cabo el gdc que debe hacer?', 'Quien decide cuando un gdc se suspende y cambia de fecha y de casa anfitriona?'] },
          { n: 23, text: ['Una reunión extra o compartir sustituye la reunión regular de gdc?'] },
          { n: 24, text: ['¿Qué música se escucha en el grupo de cuidado?'] },
        ],
      },
      {
        title: 'Comunicación y contenidos',
        points: [
          { n: 25, text: ['¿Puedo grabar una predicación y enviarla a otro líder que no asistió al servicio?', 'Y como líder grabar la prédica y enviarla a los miembros del gdc?'] },
          { n: 26, text: ['¿Qué información compartimos en los grupos de WhatsApp de la iglesia? ¿Si un miembro de grupo ya no está asistiendo debe permanecer en el chat?'] },
          { n: 27, text: ['Reforzar todas las instrucciones y acuerdos fundamentados con la escritura.'] },
        ],
      },
    ],
  },
};
const ACTIVE = 'redil-extraordinario-2026-11-07';

const MAX_LEN = 1500;
const GENERAL = 'general'; // clave de la caja de pregunta general

const pointNumbers = (lib) => lib.sections.flatMap((s) => s.points.map((p) => p.n));
const getLibreta = (key = ACTIVE) => LIBRETAS[key] || null;
const findPoint = (lib, n) => {
  for (const s of lib.sections) for (const p of s.points) if (p.n === n) return { ...p, section: s.title };
  return null;
};
/** Claves de las cajas de la hoja: p1…p27 y general. */
const sheetKeys = (lib) => [...pointNumbers(lib).map((n) => `p${n}`), GENERAL];

/**
 * Valida lo que manda la hoja: { p1: '…', p14: '…', general: '…' }. Solo pasan las claves de la libretica; un texto vacío
 * significa "sin pregunta en este punto". Devuelve { value: [{ point, question }], errors }.
 */
function parseSheet(lib, answers) {
  const errors = [];
  const value = [];
  const src = answers && typeof answers === 'object' ? answers : {};
  for (const key of sheetKeys(lib)) {
    const q = String(src[key] ?? '').replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
    if (q.length > MAX_LEN) errors.push(`Una de tus preguntas es muy larga (máximo ${MAX_LEN} letras).`);
    value.push({ point: key === GENERAL ? null : Number(key.slice(1)), question: q });
  }
  return { value, errors: [...new Set(errors)] };
}

/**
 * Guarda la hoja del grupo: una fila por punto (reenviar corrige). Texto vacío borra la fila, salvo que ya tenga respuesta del
 * equipo (esa se conserva). Si cambia el texto de una pregunta ya contestada, vuelve a quedar abierta. Devuelve { saved, removed }.
 */
async function saveSheet(db, group, libretaKey, items) {
  let saved = 0;
  let removed = 0;
  for (const it of items) {
    if (!it.question) {
      const r = await db.query("DELETE FROM redil_questions WHERE libreta = $1 AND group_id = $2 AND COALESCE(point, 0) = $3 AND answer = ''", [libretaKey, group.id, it.point || 0]);
      removed += r.rowCount;
      continue;
    }
    await db.query(
      `INSERT INTO redil_questions (libreta, point, asker_name, asker_phone, group_name, group_id, question)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (libreta, group_id, COALESCE(point, 0)) WHERE group_id IS NOT NULL DO UPDATE SET
         question = EXCLUDED.question, asker_name = EXCLUDED.asker_name, asker_phone = EXCLUDED.asker_phone, group_name = EXCLUDED.group_name,
         status = CASE WHEN redil_questions.question = EXCLUDED.question THEN redil_questions.status ELSE 'abierta' END`,
      [libretaKey, it.point, group.leader_name || group.name, group.leader_phone || '', group.name, group.id, it.question]
    );
    saved++;
  }
  return { saved, removed };
}

/** Lo que este grupo ya envió: Map(punto → { question, answer, status }); null = la pregunta general. */
async function listForGroup(db, group, libretaKey) {
  const { rows } = await db.query('SELECT id, point, question, status, answer, created_at FROM redil_questions WHERE libreta = $1 AND group_id = $2 ORDER BY created_at', [libretaKey, group.id]);
  const by = new Map();
  for (const q of rows) by.set(q.point, q);
  return by;
}

/** Todas las preguntas de una libretica, para el panel. */
async function listAll(db, libretaKey) {
  return (await db.query('SELECT * FROM redil_questions WHERE libreta = $1 ORDER BY point NULLS LAST, created_at', [libretaKey])).rows;
}

async function answer(db, id, text) {
  const t = String(text ?? '').trim().slice(0, 2000);
  const { rowCount } = await db.query("UPDATE redil_questions SET answer = $2, status = CASE WHEN $2 = '' THEN 'abierta' ELSE 'atendida' END, answered_at = CASE WHEN $2 = '' THEN NULL ELSE now() END WHERE id = $1", [id, t]);
  return rowCount > 0;
}
async function setStatus(db, id, status) {
  if (!['abierta', 'atendida'].includes(status)) return false;
  const { rowCount } = await db.query('UPDATE redil_questions SET status = $2, answered_at = CASE WHEN $2 = \'atendida\' THEN COALESCE(answered_at, now()) ELSE NULL END WHERE id = $1', [id, status]);
  return rowCount > 0;
}

module.exports = { LIBRETAS, ACTIVE, MAX_LEN, GENERAL, getLibreta, findPoint, pointNumbers, sheetKeys, parseSheet, saveSheet, listForGroup, listAll, answer, setStatus };
