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

## WeCall como proveedor del número (`src/channels/wecall.js`)
- `WHATSAPP_PROVIDER=wecall` (+ `WECALL_BASE_URL`, `WECALL_API_KEY`, `WECALL_WEBHOOK_SECRET`): el canal `channels.whatsapp` envía por la API v1 de WeCall (`POST /api/v1/mensajes/enviar/`, Bearer) en vez de Meta directo; el resto del CRM (asistente, recordatorios, respuestas) no cambia. Por defecto sigue `meta`.
- Recibe en `POST /webhooks/wecall` (público, antes del guardia de sesión): exige `X-WeCall-Signature: sha256=<hmac del cuerpo crudo>`; convierte `mensaje_nuevo` entrante al formato de Meta y reutiliza `handleWhatsAppWebhook`; ignora lo saliente; no repite un mensaje ya registrado (`raw->>'id'`). Con `meta` la ruta responde 404. DRY_RUN sigue simulando los envíos.
- Pendiente de verificar con WeCall real: formato de `variables` de plantillas y tipos de mensaje no texto; WeCall no reintenta webhooks (el call center usa además un polling de respaldo; aquí aún no).

## Asistente de WhatsApp (`src/agent.js`)
- Apagado por defecto (`AGENT_ENABLED`). Solo temas de congregación y grupos de cuidado; todo lo demás se escala a un líder/pastor.
- Nunca darle al modelo datos de otras personas. Las crisis se responden con texto fijo, sin modelo.
- Cualquier cambio al prompt o a los filtros debe pasar por el subagente `safety-reviewer` y mantener `test/agent.test.js` en verde.
- **Asistente virtual del CRM y ERP** (pantalla `/asistente`, migración 021): además de lo anterior, comparte la **información general de la iglesia** que el administrador escribe en `agent_knowledge` (horarios, sedes, cómo bautizarse...; nunca datos de personas) y, si quien escribe es **líder de un grupo de cuidado** (su teléfono = `care_groups.leader_phone`), conoce **solo su grupo**: reunión, último reporte, si confirmó sus datos y sus enlaces `/g/<token>` y `/g/<token>/datos`. No inventa horarios, enlaces ni teléfonos: lo que no está en los datos, lo escala.
- **Filtro de salida (`guardReply`)**: una respuesta que traiga un enlace o un teléfono que no esté en los datos dados al modelo no se envía; se manda el aviso fijo y se escala. Los teléfonos se comparan sin código de país. Mantén esta capa si cambias el prompt.
- `/asistente` también tiene un **probador** (`dryAnswer`): muestra qué respondería a un número y un mensaje, sin enviar ni guardar nada (usa el modelo real). Úsalo antes de encender `AGENT_ENABLED`. El asistente solo responde a mensajes entrantes de personas registradas y activas; nunca escribe primero.

## Consolidación y Nueva Vida (`src/consolidation/`, `src/nuevavida/`)
- Seguimiento de nuevos creyentes: decisión, llamada (estándar del ministerio: dentro de las 48 horas), reunión de Nueva Vida, Primeros Pasos, bautismo, grupo de cuidado y riel.
- Registrar a alguien en consolidación o en Nueva Vida **nunca** cambia su `opt_in`. Las personas nuevas se crean con `opt_in = FALSE`.
- Unión de personas: el teléfono normalizado (`normalizePhone`) es la clave. Un nombre parecido solo es una sugerencia y siempre se confirma a mano; nunca se une ni se duplica solo.
- Las personas de listas viejas se conectan como **históricas** (`consolidation.historical`): no cuentan en el embudo ni en la retención salvo que se pida.
- Datos sensibles (direcciones, edades, menores, notas de llamadas): solo en la ficha, nunca en listas ni en CSV descargables. Hoy solo los ve el nivel administrador.
- Los archivos con datos reales de personas **nunca** se suben al repo (es público). Las pruebas usan datos inventados.
- Pruebas con base real: `npm install --no-save @electric-sql/pglite` y `npm test` (o `DATABASE_URL_TEST` en CI). Sin ellas, esas pruebas se omiten.

## Bautizados (`src/bautizados/store.js`, `/bautizados`, migración 015)
- Pestaña propia en el menú. Tabla `bautizados` (nombre, teléfono, fecha del bautismo, sede, bautizado por, nota, fuente), **sin FK a `people`**, como `nueva_vida`: no crea personas ni toca `opt_in`.
- Se agrega **uno por uno** (formulario en la misma pestaña) o se **carga una lista** (`/bautizados/importar`): lista simple (un nombre por línea, con teléfono opcional después de una coma) o CSV con columnas `nombre, telefono, fecha_bautismo, sede, ministro, nota`. Fecha, sede, ministro y nombre de la lista se pueden poner para toda la carga; la fila manda si trae el dato.
- La carga primero se revisa y luego se guarda en una transacción (todo o nada). Si alguien ya estaba (mismo teléfono, o mismo nombre y fecha) no se duplica, tampoco al agregarlo uno por uno.
- Las fechas aceptan listas viejas (desde 1940) y no pueden ser futuras.
- **Reporte para imprimir** (`/bautizados/reporte`, vínculo "Imprimir reporte" con ícono de impresora en la lista, que lleva los filtros puestos): filtra por fechas desde/hasta, año y sede; muestra totales, conteo por sede y por fecha, y la lista numerada. No incluye notas. Al imprimir se ocultan menú y filtros (`.no-print`).
- **Completar teléfonos** (`/bautizados/telefonos`, `phoneSuggestions`/`applyPhones`): para los bautizados sin teléfono sugiere el de alguien de **Personas** o **Nueva Vida** con el mismo nombre o uno muy parecido (`nameScore` de consolidación; un apellido suelto no basta y los dos nombres deben tener nombre y apellido). Nunca ofrece un teléfono que ya tenga otro bautizado. **Nada se guarda solo**: por defecto queda "Ninguno" y el servidor vuelve a validar cada elección. Al guardar, la nota dice de dónde salió el teléfono. No toca `people` ni `opt_in`.
- **Fotos** (migración 016, tabla `bautizados_fotos`, una por bautizado, se borra con el registro): se suben **una por una** desde la ficha (cámara o archivo) o **varias a la vez** en `/bautizados/fotos`, donde se emparejan por el nombre del archivo ("Ana Torres.jpg"; ignora números, "IMG", "WhatsApp" y tildes) y se confirman antes de subir; cada foto va en su propio envío (`Accept: application/json`). El navegador las reduce a JPEG de 900 px (sin ubicación) y el servidor las valida con `parsePhoto` de grupos de cuidado (firma JPEG, máx. ~1.2 MB). **Pueden ser de menores**: solo se sirven con sesión del panel (`/bautizados/:id/foto`, `no-store`), nunca públicamente ni en el reporte para imprimir.
- **Fotos generales** (migración 017, tabla `bautizos_fotos_generales`, `/bautizados/generales`): fotos del grupo o del momento, no de una persona. Van por **fecha del bautismo** (propone las fechas ya registradas u otra), con sede y nota opcionales; puede haber varias por fecha. Se reducen a 1600 px en el navegador, se validan con `parsePhoto` y solo se sirven con sesión (`no-store`). Galería agrupada por fecha, con borrar.
- **Gráficas** (SVG de `src/views/charts.js`, en la lista y en el reporte, con los filtros puestos): bautizados por mes (todos los meses entre el primero y el último, los vacíos en cero, hasta 24), por sede y, si hay más de un año, por año.

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
- **Enlace común para todos los líderes** (`/registro/<token>`, migración 013): el líder **elige su congregación** (Niños, Adolescentes, Jóvenes, Jóvenes adultos, Matrimonios, Mujeres, Hombres; `CONGREGATIONS` en `care-groups.js`), llena la misma planilla de "Datos del grupo" y la envía. **Obligatorios: congregación, nombre y apellido (dos palabras como mínimo), cédula (C.I.), dirección del líder, teléfono, correo y foto** (el nacimiento y los datos de la reunión no). Todo el texto va en singular (un líder, una foto). **No elige grupo: el grupo se reconoce por el teléfono del líder.** El token vive en `care_settings` (`intake_token`) y se puede apagar o regenerar desde `/grupos/solicitud`. Cada envío es una respuesta en `care_group_submissions`:
  - Si el teléfono es de **un solo grupo** registrado, se aplica sola (`care-intake.apply`). Si lleva varios, desempata su congregación; si sigue ambiguo, o el teléfono no existe, queda **pendiente**.
  - Lo pendiente se resuelve en `/grupos/respuestas`: crear grupo nuevo (se llama "Congregación · Líder") o asignarlo a un grupo existente. Si el nombre ya existe, no se duplica.
  - Aplicar solo copia lo que vino lleno (nunca deja un dato en blanco), pone la foto y marca los datos como confirmados. Nunca toca `opt_in`.
  - `leaderFields` (`src/views/care-leader-form.js`) es la única fuente de los campos: el formulario por grupo y el común piden lo mismo. El enlace por grupo (`/g/<token>/datos`) sigue funcionando.
- **Cédula y dirección del líder** (migración 014): `leader_cedula` se guarda normalizada (`V-12345678` / `E-…`, de 5 a 9 dígitos; `care-groups.parseCedula`) y `leader_address` es la residencia del líder (distinta de `address`, que es el lugar de la reunión). La cédula es un **dato sensible**: solo se ve en el panel con sesión, nunca va en CSV ni en mensajes; al aplicar o descartar una respuesta, el servidor la borra de `care_group_submissions`.
- **Fecha de nacimiento en tres selectores** (día, mes, año; `bd_day`/`bd_month`/`bd_year`): en el teléfono salen como ruedas. El servidor arma `YYYY-MM-DD`, exige las tres partes si hay alguna y también acepta una fecha ya armada. **Ya no se pide "líder asesor"** (la columna `advisor_name` sigue existiendo, sin uso en la planilla).
- **Vaciar los datos de grupos** (`/grupos/borrar-todo`): pide escribir BORRAR, muestra cuántos registros se van y borra en una transacción grupos, reportes, ruta, planes, F.O.D.A., fotos y respuestas. **Conserva el enlace común** (`care_settings`) y no toca `people` ni nada más. Úsalo para empezar de cero y que los grupos se creen solo con lo que envían los líderes.

## Reunión de equipo (`src/reunion-equipo.js`, `/reunion-equipo`, migración 018)
- Pestaña propia en el menú: hoja manuscrita con cajas de texto (entrevista cruzada, cuatro temas de escucha y cuatro acuerdos con responsable y fecha). Se guarda sola (`POST /reunion-equipo/guardar`, una casilla por vez) en la tabla `reunion_equipo` (clave → texto), **sin FK a `people`**: no crea personas ni toca `opt_in`.
- Solo se aceptan las claves de `KEYS` (máx. 5000 caracteres por casilla); un texto vacío borra la casilla. "Copiar todo" arma un texto para pegar en WhatsApp; "Borrar todo" vacía la hoja.
- **Libreta para el equipo** (`/reunion/<token>`, `reunionRemotaRouter`, sin sesión): enlace secreto como `/registro/<token>` (token en `care_settings`: `reunion_token`, `reunion_active`; se enciende, apaga o regenera desde la pestaña). Cada persona escribe en **su propio teléfono** (localStorage) y la página **no lee nada de la base**: no muestra lo de la hoja del panel. Tiene "Copiar todo", "Enviar por WhatsApp" (`wa.me`, sin número) y "Borrar".
- **Respuestas del equipo** (migración 019, tabla `reunion_respuestas`, `POST /reunion/<token>/enviar`): solo cuando la persona toca "Enviar a la iglesia" (pide nombre y al menos una respuesta). Una fila por aparato (`device_id`): reenviar corrige, no duplica. Solo pasan las claves de `KEYS`; limitador por IP y token. Se ven en `/reunion-equipo/respuestas` (por tema o por persona, con borrar). Sin FK a `people`; no crea personas ni toca `opt_in`.

## Carta de bienvenida en Nueva Vida (`src/nuevavida/letters.js`, `/nueva-vida/carta`)
- La carta es el PDF de la iglesia (`src/assets/cartas/bienvenida-dama.pdf`), que se lee **sin sesión** en `/cartas/<archivo>` (solo los archivos de `LETTERS`; no contiene datos de nadie). Para sumar otra carta (la de varón): copia el PDF a `src/assets/cartas/` y agrega una línea a `LETTERS`.
- `/nueva-vida/carta`: se elige a quién (números escritos a mano, uno por línea o separados por coma, con nombre opcional; y/o personas de la lista de Nueva Vida con teléfono) y el sistema prepara un enlace `wa.me` por persona con el mensaje (editable; `{nombre}` y `{enlace}`) y el enlace de la carta.
- **El envío es manual**: lo hace quien administra, desde su propio WhatsApp. El sistema no manda nada por su cuenta, no crea `notifications` y no toca `opt_in` ni `people` (estar en Nueva Vida o recibir la carta ≠ consentimiento para recordatorios).
- `nueva_vida_cartas` (migración 020) guarda quién ya recibió su carta, cuando se pulsa "Ya la envié", para no mandarla dos veces.

## Mis datos: enlace para que toda la gente envíe sus datos (`src/member-intake.js`, `/mis-datos/<token>`, `/personas/solicitud`, migración 022)
- Un solo enlace para todos (token en `care_settings`: `member_token`, `member_active`; se apaga o regenera en `/personas/solicitud`). La persona llena nombre y apellido, teléfono, fecha de nacimiento (tres selectores) y congregación (obligatorios), y opcionalmente cédula, correo, dirección, estado civil, grupo de cuidado (solo se elige entre nombres), foto y "quiero recibir recordatorios".
- Se guarda en columnas nuevas de `people` (`birth_date`, `cedula`, `address`, `civil_status`, `congregation`, `care_group_name`, `profile_updated_at`) y la foto en `people_photos`. **Cédula, dirección y nacimiento son sensibles**: solo se ven en la ficha del panel con sesión; no van en la lista, ni en `/personas/exportar.csv`, ni en mensajes. Al atender una respuesta se borran de `member_submissions`.
- Cada envío es una respuesta en `member_submissions`. **El teléfono es la clave**: si ya está en Personas y no trae nada distinto, la ficha se completa sola (solo llena lo vacío; nunca pisa el nombre ni el correo); si es **persona nueva** o trae un **dato distinto** (o un correo que es de otra persona), queda pendiente en `/personas/respuestas` para aprobar o descartar. Una persona nueva se crea **sin consentimiento y sin clasificar**.
- **No cambia `opt_in`, `membership` ni `in_official_group` por sí sola.** "Quiero recibir recordatorios" es solo un aviso: se registra el consentimiento únicamente si la persona lo pidió **y** quien revisa marca la casilla al aprobar (`apply(..., { consent: true })`). Mantener esta regla.
- Unir duplicados (`people-merge.js`) conserva estos campos y pasa la foto y las respuestas a la ficha que queda.
- El envío del enlace es manual (botón de WhatsApp sin número para elegir el chat, o copiar el mensaje); el sistema no manda nada por su cuenta.

## Ministerios repetidos (`src/ministries-merge.js`, `/ministerios/unir`)
- Los ministerios se comparan **sin tildes, mayúsculas, signos ni espacios de más** (`normName`). `repo.ensureMinistry` (usado por el importador de personas y por "Nuevo ministerio") reutiliza el que ya se llama casi igual en vez de crear un repetido; antes solo comparaba en minúsculas y por eso "Anfitriones" pudo quedar dos veces.
- `/ministerios/unir` muestra los que parecen repetidos (propone conservar el que tiene más personas) y permite unir dos a mano. `mergeMinistries` (una transacción): pasa las personas y los eventos al conservado sin repetir, hereda el coordinador solo si el conservado no tenía, y elimina el otro. Nadie se borra.
- La lista de congregaciones (`CONGREGATIONS`, `care-groups.js`) ahora incluye **Preadolescentes** (Niños, Preadolescentes, Adolescentes, Jóvenes, Jóvenes adultos, Matrimonios, Mujeres, Hombres): la usan la planilla del líder y "Mis datos".

## Guía del líder (`src/leader-guide.js`, `/guia`, migraciones 023 y 024)
- Respuestas aprobadas a las dudas operativas de los líderes (espacios y equipos, grupos de cuidado, ofrendas y cuidado pastoral, formación del Riel, ruta de crecimiento, y cómo usar su enlace). Tabla `leader_guide`: pregunta, respuesta, a quién escribir, de dónde sale, estado (`confirmada` / `por_confirmar`), fecha de revisión y si está visible.
- **Solo lo `confirmada` y visible lo ven los líderes** (pestaña **Guía** de su enlace `/g/<token>/guia`, con buscador) **y el asistente de WhatsApp** (solo cuando le escribe un líder: el bloque `GUÍA DEL LÍDER` va en `buildContext` únicamente si el teléfono es de un líder). Lo "por confirmar" es un borrador que ve solo el administrador en `/guia`.
- La migración 024 siembra un borrador de 25 entradas sacado de documentos de la iglesia (minuta del REDIL 2022, normas de espacios y de equipos 2017, Riel 2022, tabla de la Ruta de crecimiento): **todo queda "por confirmar"**, salvo 4 que describen cómo funciona el propio sistema. Solo siembra si la guía está vacía. Muchas reglas son de 2017 y 2022: confirmarlas una por una.
- **No va aquí ningún dato de personas** ni peticiones de oración o de salud (la minuta original las trae; no se copian). Una prueba lo vigila (sin teléfonos, correos ni esos temas).
- El asistente solo responde con lo que está en la guía; si no lo cubre, escala. El filtro de salida (`guardReply`) sigue bloqueando teléfonos y enlaces que no estén en los datos.
- **Categorías de REDIL** (migración 025): la guía tiene `REDIL ordinario`, `REDIL extraordinario` y `REDIL extendido` (orden de `CATEGORIES`: sistema, las tres de REDIL, y luego grupos, ofrendas, espacios, Riel y ruta). Arrancan con dos respuestas por confirmar sacadas del glosario (qué es el REDIL; quiénes van al extendido: pastores, coordinadores, líderes asesores y líderes). Del ordinario y del extraordinario no se inventó nada: lo escribe la iglesia en `/guia`. Una categoría solo aparece en el enlace del líder cuando tiene al menos una respuesta confirmada.
- **Pruebas**: `npm test` corre con `--test-concurrency=8`. Sin ese límite, con la base de prueba PGlite (WebAssembly) y tantos archivos, se agota la memoria y fallan archivos al azar (`WebAssembly.Memory(): could not allocate memory`). Si vuelve a pasar, baja el número.

## Borrar grupos de cuidado (`care-groups.deleteGroups`, `POST /grupos/:id/borrar`, `POST /grupos/borrar-varios`)
- Borra el grupo y **todo lo que depende de él** en una sola transacción: reportes, ruta de crecimiento, planes, F.O.D.A., foto y respuestas de la planilla del líder. Su enlace `/g/<token>` es una columna del propio grupo y se va con él. Se usa `ON DELETE CASCADE` (así están definidas las 6 tablas); una prueba (`test/borrar-grupos.test.js`) consulta `pg_constraint` y **falla si alguien agrega una tabla con clave foránea a `care_groups` sin cascada**.
- Los reportes guardan solo cifras: no existe una tabla de asistentes por reporte.
- Botones: ficha (junto a "Desactivar grupo"), una ✕ por fila en `/grupos` y en `/grupos/solicitud`, y casillas + "Borrar seleccionados" en `/grupos`. La confirmación es `confirm()` en el `onsubmit` con el texto en `data-msg`, el mismo patrón que el resto de la app (no hay modal propio). Los formularios por fila van **fuera** del formulario de selección múltiple (`form="del-<id>"`) para no anidar formularios.
- Seguridad: las rutas viven en el router de grupos, detrás del guardia de sesión (sin sesión, un POST recibe 401). La app **no usa tokens CSRF**: se apoya en la cookie de sesión `HttpOnly; SameSite=Lax`, que el navegador no manda en POST entre sitios.
- Para vaciar todos los grupos a la vez sigue existiendo `/grupos/borrar-todo` (pide escribir BORRAR).

## Tipos de evento (REDIL) y buscador de listas
- `events.event_type` (migración 026): `''` = evento general, o uno de los tres REDIL: `REDIL ordinario`, `REDIL extraordinario`, `REDIL extendido` (`src/event-types.js`; cualquier otro valor se guarda como evento general). Es solo una clasificación: **no cambia a quién se convoca ni los recordatorios** (eso sigue saliendo de los ministerios). Aparece como selector en el formulario del evento, como etiqueta en la lista y en la ficha, y como filtro (pastillas) en `/eventos`.
- **Buscador de listas**: cualquier `<table data-filter="Buscar persona…">` recibe una casilla de búsqueda arriba (script `TABLE_FILTER_SCRIPT` en `src/views/layout.js`, solo en el panel, no en las páginas públicas del teléfono). Corre en el navegador: ignora mayúsculas y tildes y encuentra teléfonos escritos como `0414-123.45.67`, `4141234567` o `+58 414…`. Si agregas una lista de personas nueva, ponle `data-filter`. Las listas con búsqueda propia en el servidor (Personas, Nueva Vida, Bautizados, Unir duplicados) siguen con la suya.

## Reporte semanal ampliado (migración 027)
- El reporte del líder (`/g/<token>`) ahora recoge, además de lo anterior y todo **opcional** (un reporte sin ellos sigue siendo válido): **hora de entrada y de salida** (puntualidad; la salida debe ser después de la entrada), **etapa del grupo y semana de la etapa** (1–52), **invitados de las últimas 3 semanas**, **ofrenda en bolívares y en divisas** (`offering` sigue siendo la de bolívares; `offering_fx` la de divisas), **referencia del pago** y si el **líder asistió a los servicios del miércoles y del domingo** (`leader_wed`/`leader_sun`; vacío = no lo dijo). Salen de los formularios de los grupos de Matrimonios.
- **Referencia del pago: solo los 4 últimos números** (`payment_ref`); si escriben más, el servidor rechaza el reporte y no guarda lo escrito. Nunca pedir la cuenta ni el teléfono completos.
- Panel: el historial de la ficha muestra horario, etapa, invitados recientes, ofrendas (Bs. y divisas), referencia y asistencia del líder; la ficha resume "el líder asistió a los servicios: miércoles X de Y · domingo X de Y" (solo cuenta los reportes donde lo contestó). La descarga `/grupos/reportes.csv` trae las columnas nuevas. El reporte trimestral separa **Ofrendas en bolívares** y **Ofrendas en divisas**.
- Como antes, reenviar la misma fecha corrige el reporte (reemplaza todos sus campos, también los nuevos).

## Borrar toda la lista de personas (`src/people-wipe.js`, `/personas/borrar-todas`)
- **Destructivo y sin vuelta atrás.** La pantalla muestra primero qué se llevaría (consulta el catálogo `pg_constraint`, así incluye las tablas ligadas a `people` que se agreguen después), ofrece descargar la copia CSV y pide escribir `BORRAR TODAS`. Todo en una transacción.
- **Se conservan las personas con acceso al panel** (`access_level` distinto de `ninguno`: administradores y coordinadores que entran con Google), porque viven en la misma tabla y borrarlas los dejaría sin poder entrar.
- Lo que depende de cada persona sigue las claves foráneas: en cascada se borran sus ministerios, participaciones en eventos, consolidación, fotos y respuestas de "Mis datos"; solo pierden el vínculo (se conservan) Nueva Vida, las conversaciones del asistente y el coordinador de los ministerios. No toca grupos de cuidado, eventos, ministerios, asistencia ni bautizados.
- La ruta vive detrás del guardia de sesión (sin sesión, un POST recibe 401). Vigilado por `test/borrar-personas.test.js`.
