---
name: project-conventions
description: Reglas de negocio de lbnc-comunica (consentimiento, ventana horaria, recordatorios, plantilla de WhatsApp, despliegue)
user-invocable: false
---

Aplica estas reglas al tocar envíos, recordatorios o canales:

- Solo personas activas con `opt_in`. Ningún camino de envío puede saltarse esto.
- Ventana de envío 8–20 en `America/Caracas` (`inSendWindow` en `src/reminders.js`).
- Offsets: `1m` (30 d), `1w` (7 d), `1d`. `confirmado` → solo `1d`; `no_puede` → ninguno (`shouldRemind`).
- Reservar con `claim()` antes de enviar; reintentos: máx. 3, cada 30 min.
- Teléfonos: país por defecto 58 (`src/phone.js`).
- Plantilla `recordatorio_evento` (Utilidad, `es`) con botones *Confirmo* y *No puedo*.
- Texto de la interfaz y mensajes en español.
- Push a `main` despliega solo en Railway: probar con `npm test` antes.
