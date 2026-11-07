'use strict';

/**
 * Libretica digital del REDIL: los puntos a tratar, agrupados por tema, y las preguntas que los líderes escriben.
 * El contenido salió de la libretica en PDF de la iglesia; el 7 de nov. de 2026 se redactó cada punto como pregunta, a pedido del pastor.
 * Cada libretica es un dato aquí; la que está en uso es ACTIVE. Las preguntas se guardan en redil_questions.
 */
const LIBRETAS = {
  'redil-extraordinario-2026-11-07': {
    title: 'REDIL extraordinario',
    when: 'Sábado 7 de noviembre de 2026 · 9:00 a. m. a 12:00 m.',
    intro:
      'Puntos para exponer, conversar y registrar los acuerdos del equipo, agrupados por tema. Las preguntas quedan abiertas para su consideración en el encuentro.',
    sections: [
      {
        title: 'Cuidado y acompañamiento',
        points: [
          { n: 1, text: ['¿Cuál es el protocolo de acompañamiento pastoral ante un funeral?'] },
          { n: 2, text: ['¿Por qué presentamos a los niños al Señor? ¿Por qué deseas presentar a tu hijo/a, y cuál es su fundamento bíblico?'] },
          { n: 3, text: ['¿Cómo y a quién deben reportar los líderes si hay algún hermano enfermo en su GDC o que lleva tiempo sin asistir?'] },
          { n: 4, text: ['¿Cuál es el criterio pastoral para no celebrar matrimonios de personas de otra congregación, y cómo se les explica y se les acompaña?'] },
          { n: 5, text: ['¿Cuál es el criterio pastoral para no bautizar a personas de otra congregación, y cómo se les explica y se les acompaña?'] },
        ],
      },
      {
        title: 'Integración y crecimiento',
        points: [
          { n: 6, text: ['¿Qué diferencias hay en la ruta de crecimiento y en los tiempos entre un nuevo creyente y un hermano recibido de otra congregación?'] },
          { n: 7, text: ['¿Cómo deben ser conocidos por el equipo pastoral y tratados según su contexto los nuevos miembros que vienen de otra congregación? ¿Cómo darles espacio para conectarse y un tiempo prudente de permanencia antes de integrarlos en la ruta de crecimiento?'] },
          { n: 8, text: ['¿Cómo debo tratar a un miembro que asiste al grupo de cuidado, pero congrega en otra iglesia?'] },
        ],
      },
      {
        title: 'Liderazgo y estructura',
        points: [
          { n: 9, text: ['¿Deben los líderes asistir a los servicios de los miércoles y domingos, y al REDIL, como responsabilidad inherente a su rol o función?'] },
          { n: 10, text: ['¿Con qué frecuencia deben reunirse los coordinadores de ministerios con su red de liderazgo, para cuidado y planificación?'] },
          { n: 11, text: ['¿Con quién debe comunicarse en primer lugar el líder: con su líder asesor o, si no cuenta con esa figura, con su coordinador?'] },
          { n: 12, text: ['¿Cómo debe cada líder expresar, con convicción y fidelidad, lo que ha recibido de su líder asesor, coordinador o pastor, evitando presentarlo solo como «esta es la norma»?'] },
        ],
      },
      {
        title: 'Acompañamiento al líder',
        points: [
          { n: 13, text: ['¿Qué hacer como líder si me siento intimidado por otro miembro del grupo, porque lideraba en otra congregación o porque forma parte de otro ministerio y manifiesta conocer mucho de la Palabra?'] },
          { n: 14, text: ['¿Es correcto que los líderes asesores visiten de sorpresa a los líderes de GDC para supervisar? ¿Con qué propósito y con qué criterios debería hacerse?'] },
          { n: 15, text: ['¿Qué hacer cuando un miembro del grupo pide ayuda financiera al resto de los miembros?'] },
          { n: 16, text: ['¿Cómo tratar el tema de las ofrendas en los grupos de cuidado?'] },
        ],
      },
      {
        title: 'Enseñanza y capacitación',
        points: [
          { n: 17, text: ['¿Cuál fue el motivo del cambio de nombre del taller PADRE por VIDA? ¿Afecta este cambio la estructura del GDC y sus etapas?'] },
          { n: 18, text: ['¿Qué se enseña dentro de los grupos de cuidado? ¿Cuál es su propósito?'] },
          { n: 19, text: ['¿Quién inscribe a los participantes en la ruta de crecimiento? ¿Qué ocurre cuando cierra el período de inscripción? Como líder, ¿puedo enviar a los talleres a miembros del GDC que no fueron registrados en el plazo fijado?'] },
          { n: 20, text: ['¿Cuántos talleres del riel de capacitación se pueden realizar por ciclo?'] },
        ],
      },
      {
        title: 'Reuniones del grupo',
        points: [
          { n: 21, text: ['Si no pude congregarme el domingo, ¿qué comparto en el GDC?'] },
          { n: 22, text: ['¿Qué debe hacer el líder si las condiciones no están dadas para realizar el GDC? ¿Quién decide cuándo una reunión se suspende y se cambia de fecha o de casa anfitriona?'] },
          { n: 23, text: ['¿Una reunión extra o un compartir sustituye la reunión regular del GDC?'] },
          { n: 24, text: ['¿Qué tipo de música es apropiada en el grupo de cuidado, y con qué criterios se elige?'] },
        ],
      },
      {
        title: 'Comunicación y contenidos',
        points: [
          { n: 25, text: ['¿Puedo grabar una prédica y enviarla a otro líder que no asistió al servicio? ¿Y puedo, como líder, grabarla y enviarla a los miembros de mi GDC?'] },
          { n: 26, text: ['¿Qué información compartimos en los grupos de WhatsApp de la iglesia? Si un miembro del grupo ya no está asistiendo, ¿debe permanecer en el chat?'] },
          { n: 27, text: ['¿Cómo reforzamos en la práctica que toda instrucción y todo acuerdo estén fundamentados en la Escritura?'] },
        ],
      },
      {
        title: 'Asistencia al REDIL',
        points: [
          { n: 28, text: ['Cuando ambos esposos son líderes, ¿deben asistir los dos al REDIL, o basta con uno?'] },
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
