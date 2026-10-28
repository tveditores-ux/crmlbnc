# lbnc-comunica — Comunicación de la iglesia (fase 1)

Recordatorios y confirmaciones por WhatsApp y correo. Node 22, Express, PostgreSQL, sin compilación.

## Comandos
- `npm test` — pruebas (`node --test`)
- `npm run dev` — servidor local (necesita `.env`)
- `npm run seed` — datos de ejemplo (solo si la base está vacía)

## Reglas que no se pueden romper
- Solo se escribe a personas **activas** que **aceptaron** recibir mensajes (`opt_in`).
- Envíos solo dentro de la ventana `SEND_WINDOW_START`–`SEND_WINDOW_END` (8–20, zona `America/Caracas`).
- Recordatorios: 1 mes, 1 semana, 1 día. Quien confirmó solo recibe el de 1 día; quien dijo "No puedo" no recibe más.
- Cada envío se reserva en la base (`claim` en `src/reminders.js`) antes de enviarse, para evitar duplicados.
- `DRY_RUN=true` mientras se prueba; nunca ponerlo en `false` sin que el usuario lo pida.
- Plantilla de WhatsApp: `recordatorio_evento`, categoría Utilidad, idioma `es`, botones *Confirmo* / *No puedo*.

## Despliegue
- Railway, conectado a `main`: **cada push a `main` despliega solo**. Probar en local antes.
- Nunca leer, imprimir ni commitear `.env` ni tokens (`WHATSAPP_TOKEN`, `SESSION_SECRET`, etc.).

## Glosario
- **REDIL**: reunión de empoderamiento, dirección e instrucción para el liderazgo. "REDIL Extendido" es el ministerio/grupo con todos los líderes convocados (pastores, coordinadores, líderes asesores y líderes).

## Asistente de WhatsApp (`src/agent.js`)
- Apagado por defecto (`AGENT_ENABLED`). Solo temas de congregación y grupos de cuidado; todo lo demás se escala a un líder/pastor.
- Nunca darle al modelo datos de otras personas. Las crisis se responden con texto fijo, sin modelo.
- Cualquier cambio al prompt o a los filtros debe pasar por el subagente `safety-reviewer` y mantener `test/agent.test.js` en verde.

## Consolidación y Nueva Vida (`src/consolidation/`, `src/nuevavida/`)
- Seguimiento de nuevos creyentes: decisión, llamada (estándar del ministerio: dentro de las 48 horas), reunión de Nueva Vida, Primeros Pasos, bautismo, grupo de cuidado y riel.
- Registrar a alguien en consolidación o en Nueva Vida **nunca** cambia su `opt_in`. Las personas nuevas se crean con `opt_in = FALSE`.
- Unión de personas: el teléfono normalizado (`normalizePhone`) es la clave. Un nombre parecido solo es una sugerencia y siempre se confirma a mano; nunca se une ni se duplica solo.
- Las personas de listas viejas se conectan como **históricas** (`consolidation.historical`): no cuentan en el embudo ni en la retención salvo que se pida.
- Datos sensibles (direcciones, edades, menores, notas de llamadas): solo en la ficha, nunca en listas ni en CSV descargables. Hoy solo los ve el nivel administrador.
- Los archivos con datos reales de personas **nunca** se suben al repo (es público). Las pruebas usan datos inventados.
- Pruebas con base real: `npm install --no-save @electric-sql/pglite` y `npm test` (o `DATABASE_URL_TEST` en CI). Sin ellas, esas pruebas se omiten.

## Miembros y amigos (`src/members.js`, pestaña `/miembros`)
- `people.membership`: '' (por clasificar), 'miembro' o 'amigo'. `whatsapp_name` es el nombre de perfil de WhatsApp. `in_official_group` marca a quien está en el grupo oficial.
- **Estar en el grupo de WhatsApp NO es aceptar recordatorios.** Importar la lista crea personas con `opt_in = FALSE` y nunca cambia el `opt_in` de quien ya existe.
- El importador (`/miembros/importar`) usa el teléfono normalizado como clave: a quien ya existe no se le pisa el nombre, el correo ni el consentimiento; el rol solo crece ("Admin grupo WhatsApp"). Todo en una transacción.
- El tipo se guarda aparte (`setMembership`), para que importar o editar personas nunca lo borre sin querer.
