'use strict';

function bool(v, def = false) {
  if (v === undefined || v === null || v === '') return def;
  return ['1', 'true', 'si', 'sí', 'yes', 'on'].includes(String(v).trim().toLowerCase());
}

function int(v, def) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

function loadConfig(env = process.env) {
  const publicUrl =
    env.PUBLIC_URL ||
    (env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : `http://localhost:${env.PORT || 3000}`);

  return {
    port: int(env.PORT, 3000),
    databaseUrl: env.DATABASE_URL,
    churchName: env.CHURCH_NAME || 'Mi Iglesia',
    publicUrl: publicUrl.replace(/\/+$/, ''),
    timezone: env.TIMEZONE || 'America/Caracas',
    defaultCountryCode: env.DEFAULT_COUNTRY_CODE || '58',

    adminPassword: env.ADMIN_PASSWORD || '',
    sessionSecret: env.SESSION_SECRET || '',

    // Envío
    dryRun: bool(env.DRY_RUN, true),
    sendWindowStart: int(env.SEND_WINDOW_START, 8), // hora local
    sendWindowEnd: int(env.SEND_WINDOW_END, 20), // hora local (exclusiva)
    schedulerEnabled: bool(env.SCHEDULER_ENABLED, true),
    schedulerIntervalMinutes: int(env.SCHEDULER_INTERVAL_MINUTES, 10),

    whatsapp: {
      token: env.WHATSAPP_TOKEN || '',
      phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID || '',
      apiVersion: env.WHATSAPP_API_VERSION || 'v23.0',
      templateName: env.WHATSAPP_TEMPLATE_NAME || 'recordatorio_evento',
      templateLang: env.WHATSAPP_TEMPLATE_LANG || 'es',
      verifyToken: env.WHATSAPP_VERIFY_TOKEN || '',
      appSecret: env.WHATSAPP_APP_SECRET || '',
    },

    // WeCall Inbox: proveedor del número de WhatsApp (API oficial de Meta administrada por ellos).
    // WHATSAPP_PROVIDER=wecall hace que el CRM envíe y reciba por WeCall en vez de hablar directo con Meta.
    wecall: {
      baseUrl: String(env.WECALL_BASE_URL || '').trim().replace(/\/+$/, ''),
      // se recortan: pegar una clave con un espacio o salto de línea de más es el error más común
      apiKey: String(env.WECALL_API_KEY || '').trim(),
      webhookSecret: String(env.WECALL_WEBHOOK_SECRET || '').trim(),
    },
    whatsappProvider: String(env.WHATSAPP_PROVIDER || 'meta').toLowerCase() === 'wecall' ? 'wecall' : 'meta',

    // Acceso al panel con Google (opcional; sin esto solo funciona la contraseña)
    google: {
      clientId: env.GOOGLE_CLIENT_ID || '',
      clientSecret: env.GOOGLE_CLIENT_SECRET || '',
      // Debe coincidir exactamente con la URI registrada en Google; si falta, se calcula con la URL pública.
      callbackUrl: env.GOOGLE_CALLBACK_URL || '',
      // Correos que entran como administrador aunque no tengan ficha (arranque inicial).
      adminEmails: String(env.ADMIN_GOOGLE_EMAILS || '')
        .split(/[,;\s]+/)
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean),
    },

    // Agente de WhatsApp (apagado por defecto)
    agent: {
      enabled: bool(env.AGENT_ENABLED, false),
      apiKey: env.ANTHROPIC_API_KEY || '',
      model: env.AGENT_MODEL || 'claude-sonnet-5-5',
      maxRepliesPerDay: int(env.AGENT_MAX_REPLIES_PER_DAY, 12),
      reviewer: bool(env.AGENT_REVIEWER, false), // revisor interno: una segunda mirada a cada respuesta antes de enviarla
      reviewerModel: env.AGENT_REVIEWER_MODEL || '', // vacío = el mismo modelo del asistente
      pastoralPhones: env.AGENT_PASTORAL_PHONES || '', // números con acceso pastoral (consultas de datos por WhatsApp)
      brain: '', // el cerebro editable (se guarda desde el panel); vacío = el original
    },

    email: {
      provider: (env.EMAIL_PROVIDER || 'none').toLowerCase(), // resend | smtp | none
      from: env.EMAIL_FROM || '',
      resendApiKey: env.RESEND_API_KEY || '',
      smtpHost: env.SMTP_HOST || '',
      smtpPort: int(env.SMTP_PORT, 587),
      smtpUser: env.SMTP_USER || '',
      smtpPass: env.SMTP_PASS || '',
    },
  };
}

function configProblems(config) {
  const problems = [];
  if (!config.databaseUrl) problems.push('Falta DATABASE_URL.');
  if (!config.adminPassword || config.adminPassword.length < 10)
    problems.push('ADMIN_PASSWORD debe tener al menos 10 caracteres.');
  if (!config.sessionSecret || config.sessionSecret.length < 32)
    problems.push('SESSION_SECRET debe tener al menos 32 caracteres.');
  return problems;
}

function whatsappReady(config) {
  if (config.whatsappProvider === 'wecall') return Boolean(config.wecall.apiKey && config.wecall.baseUrl);
  return Boolean(config.whatsapp.token && config.whatsapp.phoneNumberId);
}

function emailReady(config) {
  const e = config.email;
  if (!e.from) return false;
  if (e.provider === 'resend') return Boolean(e.resendApiKey);
  if (e.provider === 'smtp') return Boolean(e.smtpHost && e.smtpUser && e.smtpPass);
  return false;
}

module.exports = { loadConfig, configProblems, whatsappReady, emailReady };
