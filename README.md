# Comunicación de la iglesia · Fase 1

Recordatorios automáticos y confirmaciones de asistencia por **WhatsApp** y **correo**.

- Base de personas y ministerios (se carga desde una hoja de cálculo).
- Eventos que convocan a uno o varios ministerios.
- Recordatorios automáticos **1 mes, 1 semana y 1 día antes**, solo entre las 8:00 y las 20:00.
- La persona responde con los botones **Confirmo / No puedo** (WhatsApp) o con un enlace (correo). También entiende respuestas escritas como "sí", "confirmo" o "no puedo".
- Panel web para ver quién confirmó, quién falta y qué mensajes fallaron.
- Quien ya confirmó solo recibe el recordatorio de 1 día. Quien dijo que no, ya no recibe más.
- Solo se escribe a personas **activas** que **aceptaron** recibir mensajes.

Hecho con Node.js 22, Express y PostgreSQL. Sin paso de compilación.

---

## Puesta en marcha en Railway

### 1. Subir el código a GitHub
Crea un repositorio privado (por ejemplo `lbnc-comunica`) y sube esta carpeta.

### 2. Crear el proyecto en Railway
1. **New Project → Deploy from GitHub repo** y elige el repositorio.
2. En el mismo proyecto: **New → Database → PostgreSQL**.
3. En el servicio de la app → **Settings → Networking → Generate Domain**. Esa es la dirección del panel.
4. En el servicio de la app → **Variables**, agrega:

| Variable | Valor |
|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (referencia a la base de datos) |
| `ADMIN_PASSWORD` | Contraseña del panel (mínimo 10 caracteres) |
| `SESSION_SECRET` | 64 caracteres aleatorios (ver abajo) |
| `CHURCH_NAME` | Nombre de la iglesia |
| `DRY_RUN` | `true` mientras se prueba |

Para generar `SESSION_SECRET`:
```
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Railway instala, arranca con `npm start`, crea las tablas sola y revisa `/health`. Con `DRY_RUN=true` todo funciona, pero los mensajes solo se registran como **Simulado**.

### 3. Conectar WhatsApp (Meta)
1. En [developers.facebook.com](https://developers.facebook.com) crea una app de tipo **Business** y agrega el producto **WhatsApp**.
2. Registra el **número dedicado** de la iglesia (no puede estar usándose en la app de WhatsApp).
3. Crea un **usuario del sistema** en el Business Manager con permisos `whatsapp_business_messaging` y `whatsapp_business_management`, y genera un **token permanente**.
4. Agrega un método de pago en la cuenta de WhatsApp Business (los mensajes de plantilla se cobran por mensaje).
5. Crea la plantilla que muestra el panel en **Pruebas** (nombre `recordatorio_evento`, categoría **Utilidad**, idioma **Español**, con los botones de respuesta rápida *Confirmo* y *No puedo*), y espera la aprobación.
6. En **WhatsApp → Configuración → Webhook**:
   - URL de devolución: `https://TU-DOMINIO/webhooks/whatsapp`
   - Token de verificación: el mismo valor que pongas en `WHATSAPP_VERIFY_TOKEN`
   - Suscríbete al campo **messages**.
7. Variables en Railway:

| Variable | Dónde se obtiene |
|---|---|
| `WHATSAPP_TOKEN` | Token permanente del usuario del sistema |
| `WHATSAPP_PHONE_NUMBER_ID` | WhatsApp → Configuración de la API → ID del número |
| `WHATSAPP_APP_SECRET` | Configuración de la app → Básica → Clave secreta |
| `WHATSAPP_VERIFY_TOKEN` | Una palabra secreta que inventas tú |

### 4. Conectar el correo (opcional, recomendado como respaldo)
Railway bloquea el SMTP saliente en muchos planes, así que se recomienda **Resend**, que envía por HTTPS:

1. Crea una cuenta en [resend.com](https://resend.com) y verifica un dominio propio (por ejemplo, el de la iglesia).
2. Variables: `EMAIL_PROVIDER=resend`, `RESEND_API_KEY=…`, `EMAIL_FROM=Iglesia <avisos@tudominio.org>`.

### 5. Activar
Cuando las pruebas de la siguiente sección salgan bien, cambia `DRY_RUN=false`.

---

## Lista de validación antes de activar

En el panel → **Pruebas**:

1. [ ] Todos los indicadores dicen **Listo**.
2. [ ] Enviar `hello_world` a tu número llega a WhatsApp. *(Comprueba token e ID del número.)*
3. [ ] Enviar la **plantilla de recordatorio** a tu número llega con los dos botones. *(Comprueba que Meta la aprobó.)*
4. [ ] Pulsar **Confirmo** en ese mensaje aparece en **Mensajes → Recibidos**. *(Comprueba el webhook.)*
5. [ ] El correo de prueba llega y no cae en spam.
6. [ ] Crear un evento de prueba para mañana con 2–3 personas del equipo, pulsar **Enviar recordatorio ahora**, responder y ver los estados cambiar en el evento.

---

## Cargar las personas

**Personas → Importar** acepta un CSV exportado desde Excel o Google Sheets (separado por comas o por punto y coma). Descarga la plantilla desde esa misma página.

| Columna | Ejemplo | Notas |
|---|---|---|
| `nombre` | María Pérez | Obligatorio |
| `telefono` | 0414-1234567 | Se convierte a 584141234567 |
| `correo` | maria@ejemplo.com | Teléfono o correo, al menos uno |
| `ministerios` | Diáconos; Alabanza | Se crean si no existen |
| `rol` | Coordinadora | Opcional |
| `acepta_mensajes` | si | Sin "si", la persona no recibe nada |
| `canal` | whatsapp | `whatsapp`, `correo` o `ambos` |

**Revisar sin guardar** valida el archivo y muestra los errores por línea. Si hay errores no se guarda nada. Si una persona ya existe (mismo teléfono o correo), se actualiza y se le suman los ministerios.

---

## Desarrollo local

```
cp .env.example .env        # y completa DATABASE_URL, ADMIN_PASSWORD, SESSION_SECRET
npm install
npm run seed                # datos de ejemplo (opcional)
npm run dev                 # http://localhost:3000
```

Pruebas automáticas (necesitan un Postgres vacío para pruebas; **borran esa base**):
```
DATABASE_URL_TEST=postgres://postgres@localhost/comunica_test npm test
```
GitHub Actions las ejecuta en cada push (`.github/workflows/pruebas.yml`).

---

## Todas las variables

| Variable | Por defecto | Para qué |
|---|---|---|
| `DATABASE_URL` | — | Conexión a PostgreSQL |
| `DATABASE_SSL` | `false` | `true` si usas la URL pública de la base de datos |
| `ADMIN_PASSWORD` | — | Contraseña del panel |
| `SESSION_SECRET` | — | Firma de las sesiones (32+ caracteres) |
| `CHURCH_NAME` | Mi Iglesia | Aparece en el panel y en los mensajes |
| `PUBLIC_URL` | dominio de Railway | Base de los enlaces de confirmación |
| `TIMEZONE` | America/Caracas | Zona horaria de los eventos |
| `DEFAULT_COUNTRY_CODE` | 58 | Para números escritos como 0414… |
| `DRY_RUN` | `true` | No envía nada real; solo registra |
| `SEND_WINDOW_START` / `SEND_WINDOW_END` | 8 / 20 | Horario permitido de envío |
| `SCHEDULER_ENABLED` | `true` | Recordatorios automáticos |
| `SCHEDULER_INTERVAL_MINUTES` | 10 | Cada cuánto revisa |
| `WHATSAPP_*` | — | Ver la sección de WhatsApp |
| `EMAIL_PROVIDER` | none | `resend`, `smtp` o `none` |
| `EMAIL_FROM`, `RESEND_API_KEY`, `SMTP_*` | — | Ver la sección de correo |

## Estructura

```
src/
  server.js        arranque, migraciones y programador
  app.js           servidor web, sesión del panel
  reminders.js     reglas de 1 mes / 1 semana / 1 día y envío
  responses.js     webhook de WhatsApp y respuestas
  messages.js      textos, plantilla y botones
  repo.js          personas, ministerios, eventos, importación
  channels/        WhatsApp Cloud API y correo
  routes/          páginas del panel y rutas públicas
  migrations/      estructura de la base de datos
test/              pruebas unitarias y de integración
```

## Lo que viene en la fase 2
Panel para coordinadores con sus propias alertas, resumen semanal de confirmaciones y seguimiento de nuevos (Nueva Vida).
