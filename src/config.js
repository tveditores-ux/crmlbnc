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

    // Agente de WhatsApp (apagado por defecto)
    agent: {
      enabled: bool(env.AGENT_ENABLED, false),
      apiKey: env.ANTHROPIC_API_KEY || '',
      model: env.AGENT_MODEL || 'claude-sonnet-5-5',
      maxRepliesPerDay: int(env.AGENT_MAX_REPLIES_PER_DAY, 12),
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
