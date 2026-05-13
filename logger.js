// Logger structuré JSON pour la prod. En dev, sortie pretty.
// Wrapper compat-console : signature multi-arg comme console.log/error,
// chaque argument est aplati en chaîne et concaténé dans `msg` — pino
// produit du JSON propre tout en restant un drop-in pour console.*.
const pino = require('pino');

const IS_PROD = process.env.NODE_ENV === 'production' || !!process.env.RENDER;

const pinoLogger = pino({
  level: process.env.LOG_LEVEL || (IS_PROD ? 'info' : 'debug'),
  base:  { service: 'reactioncam' },
  redact: {
    paths: [
      'req.headers.cookie',
      'req.headers.authorization',
      'req.headers["x-csrf-token"]',
      '*.password',
      '*.token',
    ],
    censor: '[REDACTED]',
  },
  ...(IS_PROD ? {} : {
    transport: {
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname,service' },
    },
  }),
});

function flatten(args) {
  return args.map(a => {
    if (a == null) return String(a);
    if (a instanceof Error) return a.stack || a.message;
    if (typeof a === 'string') return a;
    try { return JSON.stringify(a); } catch { return String(a); }
  }).join(' ');
}

const logger = {
  pino: pinoLogger,
  debug: (...args) => pinoLogger.debug(flatten(args)),
  info:  (...args) => pinoLogger.info(flatten(args)),
  warn:  (...args) => pinoLogger.warn(flatten(args)),
  error: (...args) => pinoLogger.error(flatten(args)),
  fatal: (...args) => pinoLogger.fatal(flatten(args)),
};

module.exports = logger;
