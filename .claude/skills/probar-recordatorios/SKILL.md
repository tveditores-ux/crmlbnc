---
name: probar-recordatorios
description: Prueba el flujo de recordatorios en modo simulado (DRY_RUN) sin escribir a nadie
disable-model-invocation: true
---

Prueba el sistema de recordatorios sin enviar mensajes reales.

1. Verifica que `.env` tenga `DRY_RUN=true`. Si no, detente y avisa. No lo cambies.
2. Corre `npm test` y reporta el resultado.
3. Corre `npm run seed` (solo carga datos si la base está vacía).
4. Con `npm run dev`, revisa en el panel que los mensajes aparezcan como **Simulado** y comprueba:
   - "Luis Sin Permiso" (sin consentimiento) no recibe nada.
   - Quien confirmó solo recibe el de 1 día.
   - Quien respondió "No puedo" no recibe más.
   - No hay envíos fuera de la ventana 8:00–20:00.
5. Resume qué pasó y qué falló, sin pegar tokens ni contenido de `.env`.
