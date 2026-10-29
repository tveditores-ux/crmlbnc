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

## Miembros y amigos (`src/members.js`, dentro de Personas)
- **No es una pestaña aparte**: es la misma tabla `people`. `/personas` tiene columnas Tipo y Grupo oficial, filtros (tipo, grupo oficial, ministerio, búsqueda por nombre o teléfono), clasificación rápida y el importador de la lista del grupo (`/personas/importar-grupo`). `/miembros*` solo redirige a `/personas` para no romper enlaces guardados.
- `people.membership`: '' (por clasificar), 'miembro' o 'amigo'. `whatsapp_name` es el nombre de perfil de WhatsApp. `in_official_group` marca a quien está en el grupo oficial.
- **Estar en el grupo de WhatsApp NO es aceptar recordatorios.** Importar la lista crea personas con `opt_in = FALSE` y nunca cambia el `opt_in` de quien ya existe.
- El importador (`/personas/importar-grupo`) usa el teléfono normalizado como clave: a quien ya existe no se le pisa el nombre, el correo ni el consentimiento; el rol solo crece ("Admin grupo WhatsApp"). Todo en una transacción.
- El tipo se guarda aparte (`setMembership`), para que importar o editar personas nunca lo borre sin querer.

## Unir duplicados (`src/people-merge.js`, `/personas/duplicados`)
- Se conserva siempre la ficha **más antigua** y se elimina la otra, en una sola transacción: si algo falla, no cambia nada.
- Pasan a la conservada: ministerios (y coordinación), participaciones en eventos con sus mensajes, conversaciones, consolidación (unida si las dos la tenían), registros de Nueva Vida, y los campos que le falten (teléfono, correo, notas, rol, tipo, grupo oficial). Los datos únicos distintos quedan anotados en las notas.
- **El consentimiento (`opt_in`) no se hereda** salvo que se marque expresamente: dos fichas con el mismo nombre pueden ser dos personas distintas. Mantener esta regla.
- Si agregas una tabla con una columna que apunte a `people`, súmala a `mergePeople`; hay una prueba que busca referencias que quedaron colgando.

## Grupos de cuidado (`src/care-groups.js`, `/grupos`, remoto `/g/<token>`)
- Tablas `care_groups` y `care_group_reports` (migración 009). Un reporte por grupo y fecha: reenviar la misma fecha lo corrige.
- Cada grupo tiene su enlace secreto para el líder (`/g/<token>`, sin sesión, como `/a/<token>` de asistencia): limitador, trampa para robots, no se guarda en caché. Se puede desactivar o regenerar desde la ficha del grupo; un grupo inactivo tampoco recibe reportes.
- El líder se guarda como texto (nombre, teléfono, correo), **sin FK a `people`**, para que unir o borrar personas nunca rompa un grupo. No toca `opt_in` ni crea personas.
- Las demás hojas del libro de formatos (repo reportes-de-GdeC) ya están: el líder las llena desde pestañas de su enlace (`/g/<token>/planificador`, `/gente`, `/foda`, `/trimestral`) y el panel las muestra en la ficha del grupo (`/grupos/:id`, `/grupos/:id/trimestral` imprimible). Tablas `care_group_people` (ruta de crecimiento, hitos NV B tPE VL 2D DRT dLC LCa CC), `care_group_plans`, `care_group_foda` (migración 010).
- El reporte trimestral no tiene tabla: se calcula con los reportes semanales (13 semanas desde el inicio del trimestre; los promedios solo cuentan semanas con reporte).
- La ruta de crecimiento se guarda reemplazando la lista completa en una transacción, y una lista vacía se rechaza para no borrar a todos por error. El significado de cada hito no está en el libro: solo se muestran los códigos.
- **Datos del grupo** (`/g/<token>/datos`, migración 011): el líder confirma sus datos (líder, teléfono, correo, asesor, día, hora, lugar, dirección, etapa) y quedan en `care_groups`; `profile_updated_at` marca cuándo. El nombre del grupo no lo cambia el líder.
- **Pedir datos** (`/grupos/solicitud`): mensaje editable y un botón de WhatsApp por grupo (`wa.me`) que abre el chat del propio administrador. El sistema **no envía nada por su cuenta**; no cambia ningún `opt_in` (el teléfono del líder es un dato del grupo, no una persona consentida).
- **Nacimiento y foto del líder** (migración 012): en `/g/<token>/datos` el líder envía su fecha de nacimiento y una foto suya (cámara o galería). Es solo del líder, **no de los asistentes ni de menores**. Ya no se pide pareja o co-líder ni "pertenece a" (las columnas `co_leader_*` y `belongs_to` quedan sin uso). Las fechas van como texto `YYYY-MM-DD`. La foto se reduce y reconvierte a JPEG en el teléfono (así no viaja la ubicación), se valida en el servidor (firma JPEG, máx. ~1.2 MB) y se guarda en `care_group_photos` (tabla aparte para que `SELECT *` de grupos no arrastre los bytes). Solo se sirve con el enlace del líder (`/g/<token>/foto`) o con sesión del panel (`/grupos/:id/foto`); nunca públicamente. `/grupos` muestra los cumpleaños de líderes de los próximos 45 días.
- **Enlace común para todos los líderes** (`/registro/<token>`, migración 013): el líder **elige su congregación** (Niños, Adolescentes, Jóvenes, Jóvenes adultos, Matrimonios, Mujeres, Hombres; `CONGREGATIONS` en `care-groups.js`), llena la misma planilla de "Datos del grupo" y la envía. **Obligatorios: congregación, nombre y apellido (dos palabras como mínimo), cédula (C.I.), dirección del líder, teléfono, correo, líder asesor y foto** (el nacimiento y los datos de la reunión no). Todo el texto va en singular (un líder, una foto). **No elige grupo: el grupo se reconoce por el teléfono del líder.** El token vive en `care_settings` (`intake_token`) y se puede apagar o regenerar desde `/grupos/solicitud`. Cada envío es una respuesta en `care_group_submissions`:
  - Si el teléfono es de **un solo grupo** registrado, se aplica sola (`care-intake.apply`). Si lleva varios, desempata su congregación; si sigue ambiguo, o el teléfono no existe, queda **pendiente**.
  - Lo pendiente se resuelve en `/grupos/respuestas`: crear grupo nuevo (se llama "Congregación · Líder") o asignarlo a un grupo existente. Si el nombre ya existe, no se duplica.
  - Aplicar solo copia lo que vino lleno (nunca deja un dato en blanco), pone la foto y marca los datos como confirmados. Nunca toca `opt_in`.
  - `leaderFields` (`src/views/care-leader-form.js`) es la única fuente de los campos: el formulario por grupo y el común piden lo mismo. El enlace por grupo (`/g/<token>/datos`) sigue funcionando.
- **Cédula y dirección del líder** (migración 014): `leader_cedula` se guarda normalizada (`V-12345678` / `E-…`, de 5 a 9 dígitos; `care-groups.parseCedula`) y `leader_address` es la residencia del líder (distinta de `address`, que es el lugar de la reunión). La cédula es un **dato sensible**: solo se ve en el panel con sesión, nunca va en CSV ni en mensajes; al aplicar o descartar una respuesta, el servidor la borra de `care_group_submissions`.
