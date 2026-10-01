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
