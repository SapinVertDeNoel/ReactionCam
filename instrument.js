// Initialisation Sentry — DOIT être require()-é avant tout autre import
// pour que l'auto-instrumentation Express/Mongoose fonctionne.
// Aucun effet si SENTRY_DSN n'est pas défini.
require('dotenv').config();

if (process.env.SENTRY_DSN) {
  const Sentry = require('@sentry/node');
  Sentry.init({
    dsn:          process.env.SENTRY_DSN,
    environment:  process.env.NODE_ENV || 'development',
    release:      process.env.RENDER_GIT_COMMIT || undefined,
    tracesSampleRate:  Number(process.env.SENTRY_TRACES_SAMPLE_RATE || '0.1'),
    profilesSampleRate: Number(process.env.SENTRY_PROFILES_SAMPLE_RATE || '0'),
    sendDefaultPii: false,
  });
}
