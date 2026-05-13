require('./instrument'); // Sentry init AVANT tout autre require (auto-instrumentation)
require('dotenv').config();

const logger  = require('./logger');
const Sentry  = process.env.SENTRY_DSN ? require('@sentry/node') : null;

const express    = require('express');
const multer     = require('multer');
const path       = require('path');
const crypto     = require('crypto');
const bcrypt     = require('bcrypt');
const session    = require('express-session');
const mongoose   = require('mongoose');
const MongoStore = require('connect-mongo');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const cron           = require('node-cron');
const passport       = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const { Resend }     = require('resend');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const compression    = require('compression');
const helmet         = require('helmet');

const app  = express();
const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === 'production' || !!process.env.RENDER;

// apiVersion épinglée : sans ça, la lib Stripe utilise la version par défaut
// de l'instant T (au moment du `require`). Un upgrade silencieux de la lib
// pourrait changer le format des payloads ; on fige donc explicitement.
const stripe = process.env.STRIPE_SECRET_KEY
  ? require('stripe')(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' })
  : null;

const resend = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

// ── Variables d'environnement requises ────────────────────────────────────────
const REQUIRED_ENV = ['MONGODB_URI', 'CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET'];
if (process.env.NODE_ENV === 'production' || process.env.RENDER) {
  REQUIRED_ENV.push('SESSION_SECRET', 'ADMIN_EMAILS');
}
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length) {
  // console.error (sync) plutôt que logger.error : pino bufferise stdout en
  // async et le message serait perdu avant process.exit().
  console.error('❌ Variables manquantes :', missing.join(', '));
  process.exit(1);
}

// ── Cloudinary ────────────────────────────────────────────────────────────────
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// ── MongoDB ───────────────────────────────────────────────────────────────────
mongoose.connect(process.env.MONGODB_URI)
  .then(() => logger.info('✅ MongoDB connecté'))
  .catch(err => { console.error('❌ MongoDB :', err.message); process.exit(1); });

// ── Plans ─────────────────────────────────────────────────────────────────────
const PLANS = {
  free:  { label: 'Gratuit', retentionDays: 90,   maxVideos: 3    },
  pro:   { label: 'Pro',     retentionDays: null,  maxVideos: null },
  admin: { label: 'Admin',   retentionDays: null,  maxVideos: null },
};

function expiresAtForPlan(plan) {
  const days = PLANS[plan]?.retentionDays;
  if (!days) return null;
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d;
}

// ── Modèles ───────────────────────────────────────────────────────────────────
const User = mongoose.model('User', new mongoose.Schema({
  email:                      { type: String, unique: true, lowercase: true, required: true },
  password:                   { type: String },
  googleId:                   { type: String, sparse: true, index: true },
  name:                       { type: String, required: true },
  plan:                       { type: String, enum: ['free', 'pro', 'admin'], default: 'free' },
  stripeCustomerId:           String,
  stripeSubscriptionId:       String,
  emailVerified:              { type: Boolean, default: false },
  emailVerificationToken:     { type: String, sparse: true, index: true },
  emailVerificationExpires:   { type: Date },
  createdAt:                  { type: Date, default: Date.now }
}));

const Video = mongoose.model('Video', new mongoose.Schema({
  userId:        { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  cloudinaryId:  { type: String, required: true },
  url:           { type: String, required: true },
  originalName:  String,
  size:          Number,
  visibility:    { type: String, enum: ['public', 'private'], default: 'public', index: true },
  allowedEmails: { type: [String], default: [], index: true },
  expiresAt:     { type: Date, default: null, index: true },
  createdAt:     { type: Date, default: Date.now }
}));

const Reaction = mongoose.model('Reaction', new mongoose.Schema({
  videoId:       { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  viewerUserId:  { type: mongoose.Schema.Types.ObjectId, default: null, index: true },
  viewerName:    String,
  cloudinaryId:  { type: String, required: true },
  url:           { type: String, required: true },
  createdAt:     { type: Date, default: Date.now }
}));

const View = mongoose.model('View', new mongoose.Schema({
  videoId:   { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  ipHash:    { type: String, index: true },
  createdAt: { type: Date, default: Date.now, index: true }
}));

// Stocke les IDs d'événements Stripe déjà traités (idempotence webhook).
// TTL 30 jours : Stripe ne retente que pendant ~3 jours, large marge.
const ProcessedWebhook = mongoose.model('ProcessedWebhook', new mongoose.Schema({
  eventId:   { type: String, required: true, unique: true },
  type:      String,
  createdAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 * 30 }
}));

// File d'attente d'emails : si Resend est down ou indisponible, on persiste
// l'email ici et un cron rejoue régulièrement les `pending` avec backoff
// exponentiel. TTL 30j sur les entrées pour purger l'historique automatiquement.
const EmailQueue = mongoose.model('EmailQueue', new mongoose.Schema({
  to:            { type: String, required: true },
  from:          { type: String, default: 'ReactionCam <noreply@reaction-cam.com>' },
  replyTo:       { type: String, default: null },
  subject:       { type: String, required: true },
  html:          { type: String, required: true },
  status:        { type: String, enum: ['pending', 'sent', 'failed'], default: 'pending', index: true },
  attempts:      { type: Number, default: 0 },
  nextAttemptAt: { type: Date, default: Date.now, index: true },
  lastError:     { type: String, default: null },
  sentAt:        { type: Date, default: null },
  createdAt:     { type: Date, default: Date.now, expires: 60 * 60 * 24 * 30 }
}));

const Notification = mongoose.model('Notification', new mongoose.Schema({
  userId:     { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  type:       { type: String, default: 'reaction' },
  videoId:    { type: mongoose.Schema.Types.ObjectId },
  reactionId: { type: mongoose.Schema.Types.ObjectId },
  viewerName: String,
  videoTitle: String,
  read:       { type: Boolean, default: false, index: true },
  createdAt:  { type: Date, default: Date.now, index: true }
}));

// Signalements DSA (UE 2022/2065) — chaque signalement laisse une trace
// auditable pour démontrer la diligence en cas de contrôle.
const Report = mongoose.model('Report', new mongoose.Schema({
  videoId:        { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  reporterUserId: { type: mongoose.Schema.Types.ObjectId, default: null },
  reporterIpHash: String,
  reason:         { type: String, required: true },
  description:    { type: String, default: '' },
  status:         { type: String, default: 'pending', enum: ['pending', 'reviewed', 'actioned', 'dismissed'], index: true },
  createdAt:      { type: Date, default: Date.now, index: true }
}));

// ── App ───────────────────────────────────────────────────────────────────────
app.set('trust proxy', 1);

// ── Sessions dans MongoDB ─────────────────────────────────────────────────────
// TTL aligné sur le cookie (7j) — connect-mongo crée un index TTL natif Mongo
// qui supprime automatiquement les sessions expirées (autoRemove: 'native' par
// défaut). Sans `ttl` explicite la lib utilise 14j, ce qui laisserait des
// documents zombies une semaine de plus que la durée de validité du cookie.
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
app.use(session({
  store: MongoStore.create({
    mongoUrl: process.env.MONGODB_URI,
    ttl: SESSION_TTL_SECONDS,
  }),
  secret: process.env.SESSION_SECRET || (IS_PROD ? null : 'reactioncam-dev-only-secret'),
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: SESSION_TTL_SECONDS * 1000,
    secure: IS_PROD,
    sameSite: 'lax',
    httpOnly: true
  }
}));

// ── Google OAuth ──────────────────────────────────────────────────────────────
if (process.env.GOOGLE_CLIENT_ID) {
  passport.use(new GoogleStrategy({
    clientID:     process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL:  process.env.GOOGLE_CALLBACK_URL || 'http://localhost:3000/auth/google/callback',
  }, async (accessToken, refreshToken, profile, done) => {
    try {
      // Cherche par googleId
      let user = await User.findOne({ googleId: profile.id });
      if (user) return done(null, user);

      // Cherche par email pour lier un compte existant
      const email = profile.emails?.[0]?.value?.toLowerCase();
      if (email) {
        user = await User.findOne({ email });
        if (user) {
          user.googleId      = profile.id;
          user.emailVerified = true;
          await user.save();
          return done(null, user);
        }
      }

      // Crée un nouveau compte
      user = await User.create({
        email:         email || `google_${profile.id}@noemail.local`,
        name:          profile.displayName || 'Utilisateur',
        googleId:      profile.id,
        emailVerified: true,
      });
      done(null, user);
    } catch (e) {
      done(e);
    }
  }));
}

// ── Webhook Stripe : body brut avant les parsers globaux ──────────────────────
async function downgradeUserToFree(user, reason) {
  if (!user || user.plan === 'admin') return;
  const wasPro = user.plan === 'pro';
  user.plan = 'free';
  user.stripeSubscriptionId = null;
  await user.save();
  if (wasPro) {
    const expiry = expiresAtForPlan('free');
    await Video.updateMany({ userId: user._id, expiresAt: null }, { expiresAt: expiry });
  }
  logger.info(`⬇️  Plan rétrogradé à Free (${reason}) : ${user.email}`);
}

app.post('/api/billing/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    if (!stripe) return res.status(503).send('Stripe non configuré');
    const sig = req.headers['stripe-signature'];
    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      logger.error('[WEBHOOK] Signature invalide :', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Idempotence : on insère l'event.id en base ; si le doublon est rejeté
    // par l'index unique, c'est un retry Stripe → on renvoie 200 sans rien refaire.
    try {
      await ProcessedWebhook.create({ eventId: event.id, type: event.type });
    } catch (e) {
      if (e.code === 11000) {
        return res.json({ received: true, duplicate: true });
      }
      logger.error('[WEBHOOK] Idempotence DB :', e.message);
      return res.status(500).send('DB error');
    }

    try {
      switch (event.type) {
        case 'checkout.session.completed': {
          const s = event.data.object;
          const user = await User.findById(s.client_reference_id);
          if (user) {
            user.stripeCustomerId     = s.customer;
            user.stripeSubscriptionId = s.subscription;
            if (user.plan !== 'admin') user.plan = 'pro';
            await user.save();
            await Video.updateMany({ userId: user._id }, { expiresAt: null });
            logger.info(`✅ Plan Pro activé : ${user.email}`);
          }
          break;
        }

        case 'customer.subscription.deleted': {
          const sub = event.data.object;
          const user = await User.findOne({ stripeCustomerId: sub.customer });
          if (user && user.plan === 'pro') await downgradeUserToFree(user, 'subscription deleted');
          break;
        }

        case 'customer.subscription.updated': {
          const sub = event.data.object;
          // past_due / unpaid / canceled / incomplete_expired → on rétrograde.
          const downgradeStatuses = ['past_due', 'unpaid', 'canceled', 'incomplete_expired'];
          if (downgradeStatuses.includes(sub.status)) {
            const user = await User.findOne({ stripeCustomerId: sub.customer });
            if (user && user.plan === 'pro') await downgradeUserToFree(user, `subscription ${sub.status}`);
          }
          break;
        }

        case 'invoice.payment_failed': {
          const inv = event.data.object;
          const user = await User.findOne({ stripeCustomerId: inv.customer });
          if (user) logger.info(`⚠️  Paiement échoué : ${user.email} (invoice ${inv.id})`);
          // On ne rétrograde pas immédiatement — Stripe retentera, et passera en past_due.
          break;
        }

        default:
          // Event ignoré, idempotence déjà enregistrée.
          break;
      }
      res.json({ received: true });
    } catch (e) {
      logger.error('[WEBHOOK] Traitement :', e.message);
      // On retire la marque d'idempotence pour que Stripe retente.
      await ProcessedWebhook.deleteOne({ eventId: event.id }).catch(() => {});
      res.status(500).send('Processing error — Stripe will retry');
    }
  }
);

// ── Rate limiters ─────────────────────────────────────────────────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Trop de tentatives, réessaie dans 15 minutes.' },
  standardHeaders: true, legacyHeaders: false,
});
const resendLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  message: { error: 'Trop de demandes d\'envoi. Réessaie dans 1 heure.' },
  standardHeaders: true, legacyHeaders: false,
});
// Limite les uploads de réaction par IP (vidéos webcam stockées sur Cloudinary → coûteux).
const reactionLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  message: { error: 'Trop de réactions envoyées. Réessaie dans 1 heure.' },
  standardHeaders: true, legacyHeaders: false,
});
// Limite les uploads de vidéo (un user Free fait 3 vidéos max — pas besoin de 10/min).
const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  keyGenerator: (req) => req.session?.userId ? `u:${req.session.userId}` : ipKeyGenerator(req.ip || ''),
  message: { error: 'Trop d\'uploads. Réessaie dans 1 heure.' },
  standardHeaders: true, legacyHeaders: false,
});
// Limite la création de sessions Stripe Checkout (chaque appel = appel API Stripe).
const billingLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  keyGenerator: (req) => req.session?.userId ? `u:${req.session.userId}` : ipKeyGenerator(req.ip || ''),
  message: { error: 'Trop de tentatives de paiement. Réessaie dans 1 minute.' },
  standardHeaders: true, legacyHeaders: false,
});
// Limite l'export RGPD (lecture lourde — pas besoin de plus d'1 export par minute).
const exportLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 5,
  keyGenerator: (req) => req.session?.userId ? `u:${req.session.userId}` : ipKeyGenerator(req.ip || ''),
  message: { error: 'Trop d\'exports demandés. Réessaie plus tard.' },
  standardHeaders: true, legacyHeaders: false,
});
// Limite les signalements DSA — évite le flood/harcèlement, 5/h c'est large pour un usage légitime.
const reportLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  keyGenerator: (req) => req.session?.userId ? `u:${req.session.userId}` : ipKeyGenerator(req.ip || ''),
  message: { error: 'Trop de signalements envoyés. Réessaie dans 1 heure.' },
  standardHeaders: true, legacyHeaders: false,
});

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(compression());

// TODO migrer les <script> inline vers des nonces pour supprimer 'unsafe-inline'.
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      defaultSrc:  ["'self'"],
      scriptSrc:   ["'self'", "'unsafe-inline'", 'https://js.stripe.com'],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc:    ["'self'", "'unsafe-inline'"],
      fontSrc:     ["'self'", 'data:'],
      imgSrc:      ["'self'", 'data:', 'blob:', 'https://res.cloudinary.com'],
      mediaSrc:    ["'self'", 'blob:', 'https://res.cloudinary.com'],
      connectSrc:  ["'self'", 'https://api.stripe.com', 'https://res.cloudinary.com'],
      frameSrc:    ["'self'", 'https://js.stripe.com', 'https://hooks.stripe.com'],
      formAction:  ["'self'", 'https://checkout.stripe.com'],
      objectSrc:   ["'none'"],
      baseUri:     ["'self'"],
      frameAncestors: ["'self'"],
      upgradeInsecureRequests: IS_PROD ? [] : null,
    },
  },
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  hsts: IS_PROD ? { maxAge: 31536000, includeSubDomains: true, preload: true } : false,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}));

app.use((req, res, next) => {
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=()');
  next();
});
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(passport.initialize());

// ── CSRF (double-submit cookie) ───────────────────────────────────────────────
// Token stocké dans un cookie lisible par JS + envoyé en header sur les
// requêtes mutantes. Le sameSite:lax du cookie de session bloque déjà la
// plupart des CSRF cross-origin ; le double-submit couvre les cas restants.
const CSRF_COOKIE = 'rc-csrf';
function getCsrfFromCookie(req) {
  const raw = req.headers.cookie || '';
  const m = raw.match(new RegExp('(?:^|;\\s*)' + CSRF_COOKIE + '=([A-Za-z0-9_-]+)'));
  return m ? m[1] : null;
}
function setCsrfCookie(res, token) {
  res.setHeader('Set-Cookie',
    `${CSRF_COOKIE}=${token}; Path=/; Max-Age=${60 * 60 * 24 * 7}; SameSite=Lax${IS_PROD ? '; Secure' : ''}`);
}

app.use((req, res, next) => {
  // Pose un token côté navigation HTML (top-level GET vers une page).
  if (req.method === 'GET' && req.accepts(['html', 'json']) === 'html') {
    if (!getCsrfFromCookie(req)) {
      setCsrfCookie(res, crypto.randomBytes(24).toString('base64url'));
    }
  }
  next();
});

function csrfProtect(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const cookieTok = getCsrfFromCookie(req);
  const headerTok = req.headers['x-csrf-token'];
  if (!cookieTok || !headerTok || cookieTok !== headerTok) {
    return res.status(403).json({ error: 'CSRF token invalide' });
  }
  next();
}

app.use(express.static(path.join(__dirname, 'public')));

// Protection CSRF globale sur toutes les routes mutantes (sauf le webhook
// Stripe qui est validé par sa signature et déjà traité plus haut).
app.use(csrfProtect);

// ── Auth guard ────────────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Non connecté' });
  next();
}

// Renvoie 'ok' | 'login' | 'forbidden' selon que la session peut voir cette vidéo.
async function checkVideoAccess(req, video) {
  if (video.visibility !== 'private') return 'ok';
  if (!req.session.userId) return 'login';
  if (req.session.userId.toString() === video.userId.toString()) return 'ok';
  if (!Array.isArray(video.allowedEmails) || video.allowedEmails.length === 0) return 'forbidden';
  const user = await User.findById(req.session.userId).select('email').lean();
  if (!user?.email) return 'forbidden';
  return video.allowedEmails.includes(user.email.toLowerCase()) ? 'ok' : 'forbidden';
}

// Échappe les caractères HTML dangereux pour l'interpolation dans les templates email.
function escHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
// Nettoie un sujet d'email : supprime CR/LF (header injection) et tronque.
function safeSubject(s, max = 120) {
  return String(s ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, max);
}

// Échappe un input utilisateur pour usage en RegExp (anti-ReDoS et regex injection).
function escapeRegExp(s) {
  return String(s ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseEmailList(input) {
  if (!input) return [];
  const raw = Array.isArray(input) ? input.join(',') : String(input);
  const emailRe = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
  return [...new Set(
    raw.split(/[\s,;]+/)
       .map(e => e.trim().toLowerCase())
       .filter(e => emailRe.test(e))
  )].slice(0, 50);
}

// ── Admin emails & guards ─────────────────────────────────────────────────────
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '')
  .split(',').map(e => e.trim().toLowerCase()).filter(Boolean);

// Synchronise le plan 'admin' au démarrage pour tous les emails admin
mongoose.connection.once('open', async () => {
  if (!ADMIN_EMAILS.length) return;
  await User.updateMany(
    { email: { $in: ADMIN_EMAILS } },
    { $set: { plan: 'admin', emailVerified: true } }
  ).catch(e => logger.error('[ADMIN SYNC]', e.message));
  logger.info(`👑 Admins : ${ADMIN_EMAILS.join(', ')}`);
});

async function requireAdmin(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Non connecté' });
  try {
    const user = await User.findById(req.session.userId).select('email plan');
    if (!user) return res.status(401).json({ error: 'Introuvable' });
    if (user.plan === 'admin' || ADMIN_EMAILS.includes(user.email)) return next();
    return res.status(403).json({ error: 'Accès refusé' });
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
}

async function requireAdminPage(req, res, next) {
  if (!req.session.userId) return res.redirect('/login');
  try {
    const user = await User.findById(req.session.userId).select('email plan');
    if (user && (user.plan === 'admin' || ADMIN_EMAILS.includes(user.email))) return next();
    return res.redirect('/dashboard');
  } catch {
    res.redirect('/login');
  }
}

// ── Email envoi + queue de retry ──────────────────────────────────────────────
// Tente d'envoyer immédiatement via Resend. En cas d'échec (ou si Resend n'est
// pas configuré en prod), persiste dans EmailQueue pour rejeu ultérieur par le
// cron `/api/admin/process-email-queue`. Ne throw jamais : l'envoi d'email ne
// doit pas casser le flux métier qui l'a déclenché.
const MAX_EMAIL_ATTEMPTS = 5;
const DEFAULT_EMAIL_FROM = 'ReactionCam <noreply@reaction-cam.com>';

async function sendEmail({ to, subject, html, replyTo, from }) {
  const payload = {
    from: from || DEFAULT_EMAIL_FROM,
    to,
    subject,
    html,
    ...(replyTo ? { replyTo } : {}),
  };
  if (resend) {
    try {
      await resend.emails.send(payload);
      return;
    } catch (e) {
      logger.error('[EMAIL] envoi direct échoué, mise en file :', e.message);
    }
  }
  try {
    await EmailQueue.create({
      to:            payload.to,
      from:          payload.from,
      replyTo:       payload.replyTo || null,
      subject:       payload.subject,
      html:          payload.html,
      nextAttemptAt: new Date(Date.now() + 60_000), // premier retry dans 1 min
    });
  } catch (e) {
    logger.error('[EMAIL QUEUE] enqueue échec :', e.message);
  }
}

async function processEmailQueue(maxItems = 50) {
  if (!resend) return { processed: 0, sent: 0, failed: 0, retried: 0 };
  const now = new Date();
  const pending = await EmailQueue.find({
    status:        'pending',
    nextAttemptAt: { $lte: now },
  }).sort({ nextAttemptAt: 1 }).limit(maxItems);

  let sent = 0, failed = 0, retried = 0;
  for (const m of pending) {
    try {
      const opts = { from: m.from, to: m.to, subject: m.subject, html: m.html };
      if (m.replyTo) opts.replyTo = m.replyTo;
      await resend.emails.send(opts);
      m.status = 'sent';
      m.sentAt = new Date();
      await m.save();
      sent++;
    } catch (e) {
      m.attempts++;
      m.lastError = (e.message || 'unknown').slice(0, 500);
      if (m.attempts >= MAX_EMAIL_ATTEMPTS) {
        m.status = 'failed';
        failed++;
      } else {
        // Backoff exponentiel : 2,4,8,16,32 minutes après la 1re tentative.
        const delayMs = 60_000 * Math.pow(2, m.attempts);
        m.nextAttemptAt = new Date(Date.now() + delayMs);
        retried++;
      }
      await m.save();
    }
  }
  return { processed: pending.length, sent, failed, retried };
}

// ── Email verification helper ─────────────────────────────────────────────────
async function sendVerificationEmail(user, baseUrl) {
  const token   = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + 24 * 60 * 60 * 1000);
  user.emailVerificationToken   = token;
  user.emailVerificationExpires = expires;
  await user.save();

  const link = `${baseUrl}/api/auth/verify-email?token=${token}`;

  if (!resend) {
    logger.info(`[DEV] Lien de vérification pour ${user.email} : ${link}`);
    return;
  }

  await sendEmail({
    to:      user.email,
    subject: safeSubject('Confirme ton adresse email — ReactionCam'),
    html:    `
<!DOCTYPE html><html><body style="margin:0;padding:0;background:#0a0a0a;font-family:'Courier New',monospace;color:#e8e0d0;">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:40px 20px;">
<table width="480" cellpadding="0" cellspacing="0" style="background:#111;border:1px solid #1e1e1e;border-radius:4px;">
  <tr><td style="padding:40px 36px;">
    <p style="font-size:22px;font-weight:300;letter-spacing:0.12em;color:#c9a84c;margin:0 0 24px;">Reaction<em>Cam</em></p>
    <p style="font-size:14px;margin:0 0 12px;">Bonjour ${escHtml(user.name)},</p>
    <p style="font-size:13px;color:#a09080;margin:0 0 28px;line-height:1.6;">Clique sur le bouton ci-dessous pour confirmer ton adresse email et accéder à ton compte.</p>
    <a href="${link}" style="display:inline-block;padding:14px 28px;background:#c9a84c;color:#0a0a0a;text-decoration:none;font-size:11px;letter-spacing:0.18em;text-transform:uppercase;border-radius:2px;">Confirmer mon email</a>
    <p style="font-size:11px;color:#5a5245;margin:28px 0 0;line-height:1.6;">Ce lien expire dans 24 heures. Si tu n'as pas créé de compte sur ReactionCam, ignore cet email.</p>
  </td></tr>
</table>
</td></tr></table>
</body></html>`,
  });
}

// ── Multer → Cloudinary ───────────────────────────────────────────────────────
const uploadVideo = multer({
  storage: new CloudinaryStorage({
    cloudinary,
    params: { folder: 'reactioncam/videos', resource_type: 'video' }
  }),
  limits:     { fileSize: 500 * 1024 * 1024 },
  fileFilter: (req, file, cb) =>
    file.mimetype.startsWith('video/') ? cb(null, true) : cb(new Error('Fichier vidéo uniquement'))
});

const uploadReaction = multer({
  storage: new CloudinaryStorage({
    cloudinary,
    params: { folder: 'reactioncam/reactions', resource_type: 'video' }
  }),
  limits: { fileSize: 200 * 1024 * 1024 }
});

// ═══════════════════════════════════════════════════════════════════════════════
// AUTH
// ═══════════════════════════════════════════════════════════════════════════════

app.post('/api/auth/register', authLimiter, async (req, res) => {
  try {
    const { email, password, name } = req.body;
    if (!email || !password || !name)
      return res.status(400).json({ error: 'Tous les champs sont requis' });
    if (password.length < 6)
      return res.status(400).json({ error: 'Mot de passe trop court (6 caractères min)' });

    if (await User.findOne({ email: email.toLowerCase() }))
      return res.status(409).json({ error: 'Email déjà utilisé' });

    const hash = await bcrypt.hash(password, 10);
    const user = await User.create({ email: email.toLowerCase(), name, password: hash, emailVerified: false });

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    await sendVerificationEmail(user, baseUrl);

    res.json({ needsVerification: true, email: user.email });
  } catch (e) {
    logger.error('[REGISTER]', e.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email: (email || '').toLowerCase() });
    if (!user) return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
    if (!user.password)
      return res.status(401).json({ error: 'Ce compte utilise la connexion Google. Clique sur "Continuer avec Google".' });
    if (!(await bcrypt.compare(password || '', user.password)))
      return res.status(401).json({ error: 'Email ou mot de passe incorrect' });

    if (!user.emailVerified)
      return res.status(403).json({ error: 'Confirme ton adresse email avant de te connecter.', needsVerification: true, email: user.email });

    req.session.userId   = user._id.toString();
    req.session.userName = user.name;
    await req.session.save();

    res.json({ id: user._id, name: user.name, email: user.email });
  } catch (e) {
    logger.error('[LOGIN]', e.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/auth/verify-email', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.redirect('/login?error=verify_invalid');
  try {
    const user = await User.findOne({
      emailVerificationToken:   token,
      emailVerificationExpires: { $gt: new Date() }
    });
    if (!user) return res.redirect('/login?error=verify_expired');

    user.emailVerified            = true;
    user.emailVerificationToken   = undefined;
    user.emailVerificationExpires = undefined;
    await user.save();

    req.session.userId   = user._id.toString();
    req.session.userName = user.name;
    await req.session.save();

    res.redirect('/dashboard');
  } catch (e) {
    logger.error('[VERIFY EMAIL]', e.message);
    res.redirect('/login?error=verify_invalid');
  }
});

app.post('/api/auth/resend-verification', resendLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    const user = await User.findOne({ email: (email || '').toLowerCase() });
    if (!user || !user.password)
      return res.status(400).json({ error: 'Aucun compte trouvé avec cet email.' });
    if (user.emailVerified)
      return res.status(400).json({ error: 'Ce compte est déjà vérifié.' });

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    await sendVerificationEmail(user, baseUrl);

    res.json({ ok: true });
  } catch (e) {
    logger.error('[RESEND VERIFY]', e.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.get('/api/auth/me', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Non connecté' });
  try {
    const user = await User.findById(req.session.userId);
    if (!user) return res.status(401).json({ error: 'Introuvable' });
    const planInfo = PLANS[user.plan];
    res.json({
      id:        user._id,
      name:      user.name,
      email:     user.email,
      plan:      user.plan,
      planLabel: planInfo.label,
      maxVideos: planInfo.maxVideos,
    });
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── Google OAuth routes ───────────────────────────────────────────────────────
app.get('/auth/google', (req, res, next) => {
  if (!process.env.GOOGLE_CLIENT_ID)
    return res.redirect('/login?error=google_not_configured');
  passport.authenticate('google', { scope: ['profile', 'email'], session: false })(req, res, next);
});

app.get('/auth/google/callback', (req, res, next) => {
  if (!process.env.GOOGLE_CLIENT_ID)
    return res.redirect('/login?error=google_not_configured');
  passport.authenticate('google', { session: false }, async (err, user) => {
    if (err || !user) return res.redirect('/login?error=google');
    req.session.userId   = user._id.toString();
    req.session.userName = user.name;
    await req.session.save();
    res.redirect('/dashboard');
  })(req, res, next);
});

// ═══════════════════════════════════════════════════════════════════════════════
// VIDÉOS
// ═══════════════════════════════════════════════════════════════════════════════

app.post('/upload', requireAuth, uploadLimiter, (req, res) => {
  uploadVideo.single('video')(req, res, async (err) => {
    if (err) {
      logger.error('[UPLOAD]', err.message);
      return res.status(400).json({ error: err.message });
    }
    if (!req.file) return res.status(400).json({ error: 'Aucun fichier reçu' });

    // Cleanup helper : libère Cloudinary si on n'arrive pas à finaliser le DB write.
    const destroyOrphan = () =>
      cloudinary.uploader.destroy(req.file.filename, { resource_type: 'video' })
        .catch(e => logger.error('[UPLOAD CLEANUP]', e.message));

    let video = null;
    try {
      const user = await User.findById(req.session.userId);
      const plan = PLANS[user?.plan || 'free'];

      const visibility   = req.body?.visibility === 'private' ? 'private' : 'public';
      const allowedEmails = visibility === 'private' ? parseEmailList(req.body?.allowedEmails) : [];

      if (visibility === 'private' && allowedEmails.length === 0) {
        await destroyOrphan();
        return res.status(400).json({ error: 'Une vidéo privée doit avoir au moins un email autorisé.' });
      }

      // On crée d'abord le document (atomique), puis on vérifie le quota.
      // Si on dépasse, on rollback (delete vidéo + Cloudinary). Cela évite
      // la race condition où deux uploads parallèles passeraient le check.
      video = await Video.create({
        userId:        req.session.userId,
        cloudinaryId:  req.file.filename,
        url:           req.file.path,
        originalName:  req.file.originalname,
        size:          req.file.size,
        visibility,
        allowedEmails,
        expiresAt:     expiresAtForPlan(user?.plan || 'free')
      });

      if (plan.maxVideos !== null) {
        const count = await Video.countDocuments({ userId: req.session.userId });
        if (count > plan.maxVideos) {
          await Video.deleteOne({ _id: video._id });
          await destroyOrphan();
          return res.status(403).json({
            error: `Limite atteinte : le plan gratuit permet ${plan.maxVideos} vidéos maximum.`,
            limitReached: true,
          });
        }
      }

      const link = `${req.protocol}://${req.get('host')}/watch/${video._id}`;
      res.json({ id: video._id, link, visibility, allowedEmails });

      // Invitations (non-bloquant, retry via EmailQueue si Resend échoue)
      if (visibility === 'private' && allowedEmails.length > 0) {
        const senderName  = user?.name || 'Quelqu’un';
        const videoTitle  = (req.file.originalname || 'une vidéo').slice(0, 60);
        const baseUrl     = `${req.protocol}://${req.get('host')}`;
        const safeSender  = escHtml(senderName);
        const safeTitle   = escHtml(videoTitle);
        for (const email of allowedEmails) {
          const safeEmail = escHtml(email);
          sendEmail({
            to:      email,
            subject: safeSubject(`${senderName} t'a partagé une vidéo privée`),
            html: `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#0a0a0a;font-family:'Courier New',monospace;color:#e8e0d0;">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:40px 20px;">
<table width="480" cellpadding="0" cellspacing="0" style="background:#111;border:1px solid #1e1e1e;border-radius:4px;">
  <tr><td style="padding:40px 36px;">
    <p style="font-size:22px;font-weight:300;letter-spacing:0.12em;color:#c9a84c;margin:0 0 24px;">Reaction<em>Cam</em></p>
    <p style="font-size:14px;margin:0 0 12px;">Tu as reçu une vidéo privée 🎬</p>
    <p style="font-size:13px;color:#a09080;margin:0 0 18px;line-height:1.6;"><strong style="color:#e8e0d0;">${safeSender}</strong> t'a partagé <em>${safeTitle}</em>.</p>
    <p style="font-size:12px;color:#a09080;margin:0 0 28px;line-height:1.6;">Cette vidéo est <strong style="color:#c9a84c;">privée</strong>. Pour la regarder, tu dois te connecter à ReactionCam avec cette adresse email (<strong style="color:#e8e0d0;">${safeEmail}</strong>). Si tu n'as pas encore de compte, crée-le avec cette même adresse.</p>
    <a href="${baseUrl}/watch/${video._id}" style="display:inline-block;padding:14px 28px;background:#c9a84c;color:#0a0a0a;text-decoration:none;font-size:11px;letter-spacing:0.18em;text-transform:uppercase;border-radius:2px;">Regarder la vidéo</a>
    <p style="font-size:11px;color:#5a5245;margin:28px 0 0;line-height:1.6;">Tu reçois cet email parce que ${safeSender} t'a explicitement ajouté à la liste d'accès de cette vidéo.</p>
  </td></tr>
</table>
</td></tr></table></body></html>`,
          }).catch(e => logger.error('[INVITE EMAIL]', e.message));
        }
      }
    } catch (e) {
      logger.error('[UPLOAD DB]', e.message);
      // Si on a échoué après création du doc, on nettoie tout.
      if (video) await Video.deleteOne({ _id: video._id }).catch(() => {});
      await destroyOrphan();
      res.status(500).json({ error: 'Erreur base de données' });
    }
  });
});

app.get('/api/video/:id/exists', async (req, res) => {
  try {
    const video = await Video.findById(req.params.id).select('_id userId visibility allowedEmails').lean();
    if (!video) return res.status(404).json({ error: 'Vidéo introuvable' });

    const access = await checkVideoAccess(req, video);
    if (access === 'login')     return res.status(401).json({ error: 'Connexion requise', visibility: 'private' });
    if (access === 'forbidden') return res.status(403).json({ error: 'Accès refusé', visibility: 'private' });

    // Track de vue (dédupliqué : 1 par IP / 24h / vidéo, et on n'enregistre pas la vue du propriétaire)
    if (req.session.userId?.toString() !== video.userId.toString()) {
      const ip = (req.headers['x-forwarded-for']?.split(',')[0] || req.ip || '').trim();
      const ipHash = crypto.createHash('sha256').update(ip + ':' + video._id).digest('hex').slice(0, 32);
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const already = await View.exists({ videoId: video._id, ipHash, createdAt: { $gte: since } });
      if (!already) {
        View.create({ videoId: video._id, ipHash }).catch(e => logger.error('[VIEW]', e.message));
      }
    }

    res.json({ ok: true });
  } catch {
    res.status(404).json({ error: 'Vidéo introuvable' });
  }
});

app.get('/api/video/:id', async (req, res) => {
  let video;
  try {
    video = await Video.findById(req.params.id);
  } catch {
    return res.status(404).end();
  }
  if (!video) return res.status(404).end();

  const access = await checkVideoAccess(req, video);
  if (access !== 'ok') return res.status(access === 'login' ? 401 : 403).end();

  // Économie bande passante Render : pour les vidéos publiques on redirige le
  // client directement vers Cloudinary (qui gère Range, ETag, CDN edge cache).
  // Pour les privées on garde le proxy stream — la vérif d'accès est par
  // session côté serveur, on ne peut pas exposer l'URL Cloudinary publique.
  if (video.visibility !== 'private') {
    return res.redirect(302, video.url);
  }

  try {
    const headers = {};
    if (req.headers.range) headers.range = req.headers.range;

    const upstream = await fetch(video.url, { method: req.method, headers });
    if (upstream.status >= 400) return res.status(upstream.status).end();

    res.status(upstream.status);
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag', 'cache-control']) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    }

    if (req.method === 'HEAD' || !upstream.body) return res.end();

    const { Readable } = require('stream');
    const stream = Readable.fromWeb(upstream.body);
    stream.on('error', () => res.destroy());
    req.on('close', () => stream.destroy());
    stream.pipe(res);
  } catch (e) {
    logger.error('[VIDEO PROXY]', e.message);
    if (!res.headersSent) res.status(502).end();
    else res.destroy();
  }
});

app.get('/api/dashboard', requireAuth, async (req, res) => {
  try {
    const user   = await User.findById(req.session.userId);
    const plan   = PLANS[user?.plan || 'free'];
    const videos = await Video.find({ userId: req.session.userId }).sort({ createdAt: -1 });

    const result = await Promise.all(videos.map(async v => {
      const reactions = await Reaction.find({ videoId: v._id }).sort({ createdAt: -1 });
      return {
        id:           v._id,
        url:          v.url,
        originalName: v.originalName,
        size:         v.size,
        createdAt:    v.createdAt,
        expiresAt:    v.expiresAt,
        visibility:   v.visibility || 'public',
        allowedEmails: v.allowedEmails || [],
        reactions:    reactions.map(r => ({
          id:         r._id,
          viewerName: r.viewerName || 'Anonyme',
          url:        r.url,
          createdAt:  r.createdAt,
          ready:      true
        }))
      };
    }));

    res.json({
      videos:     result,
      plan:       user?.plan || 'free',
      planLabel:  plan.label,
      maxVideos:  plan.maxVideos,
      videoCount: videos.length,
    });
  } catch (e) {
    logger.error('[DASHBOARD]', e.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// STATISTIQUES
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/api/stats', requireAuth, async (req, res) => {
  try {
    const userId = new mongoose.Types.ObjectId(req.session.userId);
    const videos = await Video.find({ userId }).select('_id originalName createdAt').lean();
    const videoIds = videos.map(v => v._id);

    // Compteurs globaux
    const [totalViews, totalReactions] = await Promise.all([
      View.countDocuments({ videoId: { $in: videoIds } }),
      Reaction.countDocuments({ videoId: { $in: videoIds } })
    ]);

    // Évolution sur 6 derniers mois (mois courant inclus)
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth() - 5, 1);

    const monthBuckets = [];
    for (let i = 0; i < 6; i++) {
      const d = new Date(start.getFullYear(), start.getMonth() + i, 1);
      monthBuckets.push({
        key:   `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
        label: d.toLocaleDateString('fr-FR', { month: 'short' }),
        views: 0,
        reactions: 0
      });
    }
    const bucketIdx = Object.fromEntries(monthBuckets.map((b, i) => [b.key, i]));

    const aggMonthly = async (Model) => Model.aggregate([
      { $match: { videoId: { $in: videoIds }, createdAt: { $gte: start } } },
      { $group: {
          _id: { y: { $year: '$createdAt' }, m: { $month: '$createdAt' } },
          n: { $sum: 1 }
      }}
    ]);

    const [viewsByMonth, reactionsByMonth] = await Promise.all([
      aggMonthly(View),
      aggMonthly(Reaction)
    ]);

    for (const r of viewsByMonth) {
      const k = `${r._id.y}-${String(r._id.m).padStart(2, '0')}`;
      if (bucketIdx[k] !== undefined) monthBuckets[bucketIdx[k]].views = r.n;
    }
    for (const r of reactionsByMonth) {
      const k = `${r._id.y}-${String(r._id.m).padStart(2, '0')}`;
      if (bucketIdx[k] !== undefined) monthBuckets[bucketIdx[k]].reactions = r.n;
    }

    // Évolution du mois courant vs précédent
    const last  = monthBuckets[monthBuckets.length - 1];
    const prev  = monthBuckets[monthBuckets.length - 2] || { views: 0, reactions: 0 };
    const pctChange = (cur, old) => old === 0 ? (cur > 0 ? 100 : 0) : Math.round(((cur - old) / old) * 100);

    // Top 5 vidéos
    const perVideoViews     = await View.aggregate([
      { $match: { videoId: { $in: videoIds } } },
      { $group: { _id: '$videoId', n: { $sum: 1 } } }
    ]);
    const perVideoReactions = await Reaction.aggregate([
      { $match: { videoId: { $in: videoIds } } },
      { $group: { _id: '$videoId', n: { $sum: 1 } } }
    ]);
    const viewsMap     = Object.fromEntries(perVideoViews.map(r => [String(r._id), r.n]));
    const reactionsMap = Object.fromEntries(perVideoReactions.map(r => [String(r._id), r.n]));

    const topVideos = videos
      .map(v => ({
        id:        v._id,
        name:      v.originalName || 'Sans nom',
        createdAt: v.createdAt,
        views:     viewsMap[String(v._id)] || 0,
        reactions: reactionsMap[String(v._id)] || 0
      }))
      .sort((a, b) => (b.views + b.reactions * 3) - (a.views + a.reactions * 3))
      .slice(0, 5);

    // Vues 7 derniers jours
    const last7 = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const [views7d, reactions7d] = await Promise.all([
      View.countDocuments({ videoId: { $in: videoIds }, createdAt: { $gte: last7 } }),
      Reaction.countDocuments({ videoId: { $in: videoIds }, createdAt: { $gte: last7 } })
    ]);

    const conversionRate = totalViews > 0
      ? Math.round((totalReactions / totalViews) * 1000) / 10
      : 0;

    res.json({
      totals: {
        videos:        videos.length,
        views:         totalViews,
        reactions:     totalReactions,
        conversion:    conversionRate,
        views7d,
        reactions7d
      },
      evolution: {
        viewsPct:     pctChange(last.views, prev.views),
        reactionsPct: pctChange(last.reactions, prev.reactions),
        currentMonth: { views: last.views, reactions: last.reactions }
      },
      monthly: monthBuckets,
      topVideos
    });
  } catch (e) {
    logger.error('[STATS]', e.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.get('/api/my-reactions', requireAuth, async (req, res) => {
  try {
    const reactions = await Reaction.find({ viewerUserId: req.session.userId })
      .sort({ createdAt: -1 })
      .limit(200)
      .lean();

    const videoIds = [...new Set(reactions.map(r => String(r.videoId)))];
    const videos = await Video.find({ _id: { $in: videoIds } })
      .select('_id originalName userId')
      .lean();
    const ownerIds = [...new Set(videos.map(v => String(v.userId)))];
    const owners = await User.find({ _id: { $in: ownerIds } })
      .select('_id name')
      .lean();

    const videoMap = Object.fromEntries(videos.map(v => [String(v._id), v]));
    const ownerMap = Object.fromEntries(owners.map(o => [String(o._id), o.name]));

    res.json({
      reactions: reactions.map(r => {
        const v = videoMap[String(r.videoId)];
        return {
          id:         r._id,
          url:        r.url,
          createdAt:  r.createdAt,
          viewerName: r.viewerName || 'Anonyme',
          video: v ? {
            id:           v._id,
            originalName: v.originalName || '',
            ownerName:    ownerMap[String(v.userId)] || 'Inconnu',
            available:    true
          } : { available: false }
        };
      })
    });
  } catch (e) {
    logger.error('[MY REACTIONS]', e.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.delete('/api/my-reactions/:id', requireAuth, async (req, res) => {
  try {
    const reaction = await Reaction.findOne({ _id: req.params.id, viewerUserId: req.session.userId });
    if (!reaction) return res.status(404).json({ error: 'Réaction introuvable' });
    await cloudinary.uploader.destroy(reaction.cloudinaryId, { resource_type: 'video' }).catch(() => {});
    await Reaction.deleteOne({ _id: reaction._id });
    res.json({ ok: true });
  } catch (e) {
    logger.error('[DELETE MY REACTION]', e.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// NOTIFICATIONS
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/api/notifications', requireAuth, async (req, res) => {
  try {
    const [items, unread] = await Promise.all([
      Notification.find({ userId: req.session.userId }).sort({ createdAt: -1 }).limit(30).lean(),
      Notification.countDocuments({ userId: req.session.userId, read: false })
    ]);
    res.json({
      unread,
      items: items.map(n => ({
        id:         n._id,
        type:       n.type,
        videoId:    n.videoId,
        reactionId: n.reactionId,
        viewerName: n.viewerName || 'Anonyme',
        videoTitle: n.videoTitle || '',
        read:       n.read,
        createdAt:  n.createdAt
      }))
    });
  } catch (e) {
    logger.error('[NOTIF LIST]', e.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.post('/api/notifications/read', requireAuth, async (req, res) => {
  try {
    await Notification.updateMany({ userId: req.session.userId, read: false }, { $set: { read: true } });
    res.json({ ok: true });
  } catch (e) {
    logger.error('[NOTIF READ]', e.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.delete('/api/notifications/:id', requireAuth, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: 'ID invalide' });
    }
    const r = await Notification.deleteOne({ _id: req.params.id, userId: req.session.userId });
    if (!r.deletedCount) return res.status(404).json({ error: 'Notification introuvable' });
    res.json({ ok: true });
  } catch (e) {
    logger.error('[NOTIF DELETE]', e.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.delete('/api/notifications', requireAuth, async (req, res) => {
  try {
    await Notification.deleteMany({ userId: req.session.userId });
    res.json({ ok: true });
  } catch (e) {
    logger.error('[NOTIF CLEAR]', e.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// RÉACTIONS
// ═══════════════════════════════════════════════════════════════════════════════

app.post('/reaction/:id',
  reactionLimiter,
  uploadReaction.fields([{ name: 'reaction', maxCount: 1 }, { name: 'viewerName', maxCount: 1 }]),
  async (req, res) => {
    const file = req.files?.['reaction']?.[0];
    if (!file) return res.status(400).json({ error: 'Aucune réaction reçue' });

    try {
      const video = await Video.findById(req.params.id);
      if (!video) return res.status(404).json({ error: 'Vidéo introuvable' });

      const access = await checkVideoAccess(req, video);
      if (access !== 'ok') {
        await cloudinary.uploader.destroy(file.filename, { resource_type: 'video' }).catch(() => {});
        return res.status(access === 'login' ? 401 : 403).json({ error: 'Accès refusé' });
      }

      const viewerName = (req.body?.viewerName || 'Anonyme').slice(0, 80);
      const reaction = await Reaction.create({
        videoId:      video._id,
        viewerUserId: req.session.userId || null,
        viewerName,
        cloudinaryId: file.filename,
        url:          file.path
      });

      res.json({ reactionId: reaction._id, url: reaction.url });

      // Notification in-app (pastille dashboard)
      Notification.create({
        userId:     video.userId,
        type:       'reaction',
        videoId:    video._id,
        reactionId: reaction._id,
        viewerName,
        videoTitle: (video.originalName || '').slice(0, 120)
      }).catch(e => logger.error('[NOTIF DB]', e.message));

      // Notification email (non-bloquant, retry via EmailQueue si Resend échoue)
      {
        const owner = await User.findById(video.userId).catch(() => null);
        if (owner?.email) {
          const baseUrl = `${req.protocol}://${req.get('host')}`;
          const videoTitle = video.originalName || 'ta vidéo';
          const safeViewer = escHtml(viewerName);
          const safeTitle  = escHtml(videoTitle.slice(0, 60));
          sendEmail({
            to:      owner.email,
            subject: safeSubject(`${viewerName} a réagi à "${videoTitle.slice(0, 40)}"`),
            html: `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#0a0a0a;font-family:'Courier New',monospace;color:#e8e0d0;">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:40px 20px;">
<table width="480" cellpadding="0" cellspacing="0" style="background:#111;border:1px solid #1e1e1e;border-radius:4px;">
  <tr><td style="padding:40px 36px;">
    <p style="font-size:22px;font-weight:300;letter-spacing:0.12em;color:#c9a84c;margin:0 0 24px;">Reaction<em>Cam</em></p>
    <p style="font-size:14px;margin:0 0 12px;">Nouvelle réaction !</p>
    <p style="font-size:13px;color:#a09080;margin:0 0 28px;line-height:1.6;"><strong style="color:#e8e0d0;">${safeViewer}</strong> a regardé <em>${safeTitle}</em> et a enregistré sa réaction.</p>
    <a href="${baseUrl}/dashboard" style="display:inline-block;padding:14px 28px;background:#c9a84c;color:#0a0a0a;text-decoration:none;font-size:11px;letter-spacing:0.18em;text-transform:uppercase;border-radius:2px;">Voir la réaction</a>
    <p style="font-size:11px;color:#5a5245;margin:28px 0 0;line-height:1.6;">Tu reçois cet email car tu as un compte ReactionCam. <a href="${baseUrl}/dashboard" style="color:#7a6330;">Gérer les notifications</a></p>
  </td></tr>
</table>
</td></tr></table></body></html>`,
          }).catch(e => logger.error('[NOTIF EMAIL]', e.message));
        }
      }
    } catch (e) {
      logger.error('[REACTION]', e.message);
      // Cleanup Cloudinary si on a déjà uploadé mais pas finalisé.
      if (req.files?.['reaction']?.[0]) {
        cloudinary.uploader.destroy(req.files['reaction'][0].filename, { resource_type: 'video' })
          .catch(err => logger.error('[REACTION CLEANUP]', err.message));
      }
      res.status(500).json({ error: 'Erreur serveur' });
    }
  }
);

app.delete('/api/video/:id', requireAuth, async (req, res) => {
  try {
    const video = await Video.findOne({ _id: req.params.id, userId: req.session.userId });
    if (!video) return res.status(404).json({ error: 'Vidéo introuvable' });

    const reactions = await Reaction.find({ videoId: video._id });
    for (const r of reactions) {
      await cloudinary.uploader.destroy(r.cloudinaryId, { resource_type: 'video' }).catch(() => {});
    }
    await Reaction.deleteMany({ videoId: video._id });
    await View.deleteMany({ videoId: video._id }).catch(() => {});
    await cloudinary.uploader.destroy(video.cloudinaryId, { resource_type: 'video' }).catch(() => {});
    await Video.deleteOne({ _id: video._id });

    res.json({ ok: true });
  } catch (e) {
    logger.error('[DELETE VIDEO]', e.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// STRIPE BILLING
// ═══════════════════════════════════════════════════════════════════════════════

app.post('/api/billing/checkout', requireAuth, billingLimiter, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Paiement non configuré' });
  try {
    const user = await User.findById(req.session.userId);
    if (user.plan === 'pro' || user.plan === 'admin')
      return res.status(400).json({ error: 'Tu es déjà sur le plan Pro' });

    const origin  = `${req.protocol}://${req.get('host')}`;
    const session = await stripe.checkout.sessions.create({
      customer:            user.stripeCustomerId || undefined,
      customer_email:      !user.stripeCustomerId ? user.email : undefined,
      client_reference_id: user._id.toString(),
      mode:                'subscription',
      line_items:          [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      success_url:         `${origin}/dashboard?upgrade=success`,
      cancel_url:          `${origin}/pricing`,
      locale:              'fr',
    });

    res.json({ url: session.url });
  } catch (e) {
    logger.error('[BILLING CHECKOUT]', e.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.post('/api/billing/portal', requireAuth, billingLimiter, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Paiement non configuré' });
  try {
    const user = await User.findById(req.session.userId);
    if (!user.stripeCustomerId)
      return res.status(400).json({ error: 'Aucun abonnement actif' });

    const origin = `${req.protocol}://${req.get('host')}`;
    const portal = await stripe.billingPortal.sessions.create({
      customer:   user.stripeCustomerId,
      return_url: `${origin}/dashboard`,
    });

    res.json({ url: portal.url });
  } catch (e) {
    logger.error('[BILLING PORTAL]', e.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// COMPTE UTILISATEUR
// ═══════════════════════════════════════════════════════════════════════════════

app.patch('/api/account/name', requireAuth, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || name.trim().length < 2)
      return res.status(400).json({ error: 'Nom trop court (2 caractères min)' });
    const user = await User.findById(req.session.userId);
    if (!user) return res.status(404).json({ error: 'Introuvable' });
    user.name = name.trim().slice(0, 60);
    await user.save();
    req.session.userName = user.name;
    await req.session.save();
    res.json({ ok: true, name: user.name });
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.post('/api/account/change-password', requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!newPassword || newPassword.length < 6)
      return res.status(400).json({ error: 'Nouveau mot de passe trop court (6 caractères min)' });
    const user = await User.findById(req.session.userId);
    if (!user) return res.status(404).json({ error: 'Introuvable' });
    if (!user.password)
      return res.status(400).json({ error: 'Ce compte utilise la connexion Google, pas de mot de passe à modifier.' });
    if (!(await bcrypt.compare(currentPassword || '', user.password)))
      return res.status(401).json({ error: 'Mot de passe actuel incorrect' });
    user.password = await bcrypt.hash(newPassword, 10);
    await user.save();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── Export RGPD (Art. 20 — droit à la portabilité) ────────────────────────────
app.get('/api/account/export', requireAuth, exportLimiter, async (req, res) => {
  try {
    const user = await User.findById(req.session.userId)
      .select('-password -emailVerificationToken -emailVerificationExpires')
      .lean();
    if (!user) return res.status(404).json({ error: 'Introuvable' });

    const [videos, reactionsAsViewer, notifications] = await Promise.all([
      Video.find({ userId: user._id }).lean(),
      Reaction.find({ viewerUserId: user._id }).lean(),
      Notification.find({ userId: user._id }).lean(),
    ]);

    const videoIds = videos.map(v => v._id);
    const reactionsOnMyVideos = await Reaction.find({ videoId: { $in: videoIds } }).lean();

    const safeName = (user.email || 'export').replace(/[^a-z0-9]/gi, '_');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="reactioncam-export-${safeName}-${Date.now()}.json"`);
    res.json({
      exportedAt: new Date().toISOString(),
      legalNotice: 'Export de vos données personnelles conformément à l\'Art. 20 RGPD. Pour toute question : contact@reaction-cam.com',
      account: user,
      videos: videos.map(v => ({
        id: v._id, originalName: v.originalName, size: v.size, url: v.url,
        visibility: v.visibility, allowedEmails: v.allowedEmails,
        createdAt: v.createdAt, expiresAt: v.expiresAt,
      })),
      reactionsReceived: reactionsOnMyVideos.map(r => ({
        id: r._id, videoId: r.videoId, viewerName: r.viewerName,
        url: r.url, createdAt: r.createdAt,
      })),
      reactionsAsViewer: reactionsAsViewer.map(r => ({
        id: r._id, videoId: r.videoId, url: r.url, createdAt: r.createdAt,
      })),
      notifications: notifications.map(n => ({
        id: n._id, type: n.type, videoId: n.videoId, viewerName: n.viewerName,
        videoTitle: n.videoTitle, read: n.read, createdAt: n.createdAt,
      })),
    });
  } catch (e) {
    logger.error('[EXPORT]', e.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.delete('/api/account', requireAuth, async (req, res) => {
  try {
    const { password } = req.body;
    const user = await User.findById(req.session.userId);
    if (!user) return res.status(404).json({ error: 'Introuvable' });
    if (ADMIN_EMAILS.includes(user.email))
      return res.status(403).json({ error: 'Impossible de supprimer un compte admin.' });
    if (user.password && !(await bcrypt.compare(password || '', user.password)))
      return res.status(401).json({ error: 'Mot de passe incorrect' });
    const videos = await Video.find({ userId: user._id });
    for (const v of videos) {
      const reactions = await Reaction.find({ videoId: v._id });
      for (const r of reactions) await cloudinary.uploader.destroy(r.cloudinaryId, { resource_type: 'video' }).catch(() => {});
      await Reaction.deleteMany({ videoId: v._id });
      await cloudinary.uploader.destroy(v.cloudinaryId, { resource_type: 'video' }).catch(() => {});
    }
    await Video.deleteMany({ userId: user._id });
    await User.deleteOne({ _id: user._id });
    req.session.destroy(() => res.json({ ok: true }));
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN API
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/api/admin/stats', requireAdmin, async (req, res) => {
  try {
    const now          = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7  * 24 * 60 * 60 * 1000);
    const in7Days      = new Date(now.getTime() + 7  * 24 * 60 * 60 * 1000);
    // Fenêtre du chart : 14 jours, ancrée à minuit UTC pour matcher $dateToString.
    const chart14Start = new Date(now); chart14Start.setUTCHours(0, 0, 0, 0);
    chart14Start.setUTCDate(chart14Start.getUTCDate() - 13);

    const dayGroup = {
      _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
      n:   { $sum: 1 },
    };

    // Avant : 11 countDocuments + 42 dans la boucle (14×3) = 53 round-trips.
    // Après : 3 aggregates `$facet` parallèles = 3 round-trips.
    const [userStats, videoStats, reactionStats] = await Promise.all([
      User.aggregate([{ $facet: {
        total: [{ $count: 'n' }],
        week:  [{ $match: { createdAt: { $gte: sevenDaysAgo } } }, { $count: 'n' }],
        plans: [{ $group: { _id: '$plan', n: { $sum: 1 } } }],
        daily: [{ $match: { createdAt: { $gte: chart14Start } } }, { $group: dayGroup }],
      }}]),
      Video.aggregate([{ $facet: {
        total:        [{ $count: 'n' }],
        week:         [{ $match: { createdAt: { $gte: sevenDaysAgo } } }, { $count: 'n' }],
        storage:      [{ $group: { _id: null, total: { $sum: '$size' } } }],
        expiringSoon: [{ $match: { expiresAt: { $gte: now, $lte: in7Days } } }, { $count: 'n' }],
        daily:        [{ $match: { createdAt: { $gte: chart14Start } } }, { $group: dayGroup }],
      }}]),
      Reaction.aggregate([{ $facet: {
        total: [{ $count: 'n' }],
        week:  [{ $match: { createdAt: { $gte: sevenDaysAgo } } }, { $count: 'n' }],
        daily: [{ $match: { createdAt: { $gte: chart14Start } } }, { $group: dayGroup }],
      }}]),
    ]);

    const pickCount = (arr) => arr?.[0]?.n || 0;
    const dayMap    = (arr) => Object.fromEntries((arr || []).map(d => [d._id, d.n]));

    const u = userStats[0], v = videoStats[0], r = reactionStats[0];
    const planMap = Object.fromEntries((u.plans || []).map(p => [p._id, p.n]));
    const uDaily  = dayMap(u.daily);
    const vDaily  = dayMap(v.daily);
    const rDaily  = dayMap(r.daily);

    const days = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date(chart14Start);
      d.setUTCDate(d.getUTCDate() + (13 - i));
      const key = d.toISOString().slice(0, 10);
      days.push({
        date:      key,
        users:     uDaily[key] || 0,
        videos:    vDaily[key] || 0,
        reactions: rDaily[key] || 0,
      });
    }

    res.json({
      users: {
        total: pickCount(u.total),
        free:  planMap.free  || 0,
        pro:   planMap.pro   || 0,
        admin: planMap.admin || 0,
        week:  pickCount(u.week),
      },
      videos: {
        total:        pickCount(v.total),
        week:         pickCount(v.week),
        expiringSoon: pickCount(v.expiringSoon),
      },
      reactions: { total: pickCount(r.total), week: pickCount(r.week) },
      storage:   { bytes: v.storage?.[0]?.total || 0 },
      chart:     days,
    });
  } catch (e) {
    logger.error('[ADMIN STATS]', e.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.get('/api/admin/users', requireAdmin, async (req, res) => {
  try {
    const { search = '', page = 1, limit = 25, plan } = req.query;
    const query = {};
    if (search) {
      const re = new RegExp(escapeRegExp(String(search).slice(0, 100)), 'i');
      query.$or = [{ email: re }, { name: re }];
    }
    if (plan) query.plan = plan;
    const pageNum  = Math.max(1, parseInt(page) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit) || 25));
    const skip     = (pageNum - 1) * limitNum;

    // Aggregate avec $lookup pour videoCount → évite le N+1 sur countDocuments.
    const [users, total] = await Promise.all([
      User.aggregate([
        { $match: query },
        { $sort:  { createdAt: -1 } },
        { $skip:  skip },
        { $limit: limitNum },
        { $lookup: {
            from: 'videos',
            let: { uid: '$_id' },
            pipeline: [
              { $match: { $expr: { $eq: ['$userId', '$$uid'] } } },
              { $count: 'n' },
            ],
            as: 'videoStats',
        }},
        { $addFields: { videoCount: { $ifNull: [{ $arrayElemAt: ['$videoStats.n', 0] }, 0] } } },
        { $project: { password: 0, emailVerificationToken: 0, emailVerificationExpires: 0, videoStats: 0 } },
      ]),
      User.countDocuments(query),
    ]);
    res.json({ users, total, page: pageNum, pages: Math.ceil(total / limitNum) });
  } catch (e) {
    logger.error('[ADMIN USERS]', e.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.patch('/api/admin/users/:id/plan', requireAdmin, async (req, res) => {
  try {
    const { plan } = req.body;
    if (!PLANS[plan]) return res.status(400).json({ error: 'Plan invalide' });
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });
    if (ADMIN_EMAILS.includes(user.email) && plan !== 'admin')
      return res.status(403).json({ error: 'Impossible de rétrograder un admin désigné' });
    user.plan = plan;
    await user.save();
    if (plan === 'free') {
      await Video.updateMany({ userId: user._id, expiresAt: null }, { expiresAt: expiresAtForPlan('free') });
    } else {
      await Video.updateMany({ userId: user._id }, { expiresAt: null });
    }
    res.json({ ok: true });
  } catch (e) {
    logger.error('[ADMIN SET PLAN]', e.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.delete('/api/admin/users/:id', requireAdmin, async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });
    if (ADMIN_EMAILS.includes(user.email))
      return res.status(403).json({ error: 'Impossible de supprimer un admin désigné' });
    const videos = await Video.find({ userId: user._id });
    for (const v of videos) {
      const reactions = await Reaction.find({ videoId: v._id });
      for (const r of reactions) await cloudinary.uploader.destroy(r.cloudinaryId, { resource_type: 'video' }).catch(() => {});
      await Reaction.deleteMany({ videoId: v._id });
      await cloudinary.uploader.destroy(v.cloudinaryId, { resource_type: 'video' }).catch(() => {});
    }
    await Video.deleteMany({ userId: user._id });
    await User.deleteOne({ _id: user._id });
    res.json({ ok: true });
  } catch (e) {
    logger.error('[ADMIN DELETE USER]', e.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.get('/api/admin/videos', requireAdmin, async (req, res) => {
  try {
    const { search = '', page = 1, limit = 25 } = req.query;
    const query = search
      ? { originalName: new RegExp(escapeRegExp(String(search).slice(0, 100)), 'i') }
      : {};
    const pageNum  = Math.max(1, parseInt(page) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit) || 25));
    const skip     = (pageNum - 1) * limitNum;

    // 2 $lookup : owner (User) + reactionCount via subpipeline $count.
    const [videos, total] = await Promise.all([
      Video.aggregate([
        { $match: query },
        { $sort:  { createdAt: -1 } },
        { $skip:  skip },
        { $limit: limitNum },
        { $lookup: {
            from: 'users',
            let: { uid: '$userId' },
            pipeline: [
              { $match: { $expr: { $eq: ['$_id', '$$uid'] } } },
              { $project: { email: 1, name: 1, plan: 1 } },
            ],
            as: 'ownerArr',
        }},
        { $lookup: {
            from: 'reactions',
            let: { vid: '$_id' },
            pipeline: [
              { $match: { $expr: { $eq: ['$videoId', '$$vid'] } } },
              { $count: 'n' },
            ],
            as: 'reactionStats',
        }},
        { $addFields: {
            owner:         { $arrayElemAt: ['$ownerArr', 0] },
            reactionCount: { $ifNull: [{ $arrayElemAt: ['$reactionStats.n', 0] }, 0] },
        }},
        { $project: { ownerArr: 0, reactionStats: 0 } },
      ]),
      Video.countDocuments(query),
    ]);
    res.json({ videos, total, page: pageNum, pages: Math.ceil(total / limitNum) });
  } catch (e) {
    logger.error('[ADMIN VIDEOS]', e.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.delete('/api/admin/videos/:id', requireAdmin, async (req, res) => {
  try {
    const video = await Video.findById(req.params.id);
    if (!video) return res.status(404).json({ error: 'Vidéo introuvable' });
    const reactions = await Reaction.find({ videoId: video._id });
    for (const r of reactions) await cloudinary.uploader.destroy(r.cloudinaryId, { resource_type: 'video' }).catch(() => {});
    await Reaction.deleteMany({ videoId: video._id });
    await cloudinary.uploader.destroy(video.cloudinaryId, { resource_type: 'video' }).catch(() => {});
    await Video.deleteOne({ _id: video._id });
    res.json({ ok: true });
  } catch (e) {
    logger.error('[ADMIN DELETE VIDEO]', e.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.get('/api/admin/reactions', requireAdmin, async (req, res) => {
  try {
    const { page = 1, limit = 25 } = req.query;
    const pageNum  = Math.max(1, parseInt(page) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit) || 25));
    const skip     = (pageNum - 1) * limitNum;

    const [reactions, total] = await Promise.all([
      Reaction.aggregate([
        { $sort:  { createdAt: -1 } },
        { $skip:  skip },
        { $limit: limitNum },
        { $lookup: {
            from: 'videos',
            let: { vid: '$videoId' },
            pipeline: [
              { $match: { $expr: { $eq: ['$_id', '$$vid'] } } },
              { $project: { originalName: 1, userId: 1 } },
            ],
            as: 'videoArr',
        }},
        { $addFields: { video: { $arrayElemAt: ['$videoArr', 0] } } },
        { $project: { videoArr: 0 } },
      ]),
      Reaction.countDocuments(),
    ]);
    res.json({ reactions, total, page: pageNum, pages: Math.ceil(total / limitNum) });
  } catch (e) {
    logger.error('[ADMIN REACTIONS]', e.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.get('/api/admin/users/:id', requireAdmin, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: 'ID invalide' });
    }
    const user = await User.findById(req.params.id)
      .select('-password -emailVerificationToken -emailVerificationExpires');
    if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });

    const videos = await Video.aggregate([
      { $match: { userId: user._id } },
      { $sort:  { createdAt: -1 } },
      { $lookup: {
          from: 'reactions',
          let: { vid: '$_id' },
          pipeline: [
            { $match: { $expr: { $eq: ['$videoId', '$$vid'] } } },
            { $count: 'n' },
          ],
          as: 'reactionStats',
      }},
      { $addFields: { reactionCount: { $ifNull: [{ $arrayElemAt: ['$reactionStats.n', 0] }, 0] } } },
      { $project: { reactionStats: 0 } },
    ]);
    const totalSize = videos.reduce((s, v) => s + (v.size || 0), 0);
    res.json({ user: user.toObject(), videos, totalSize });
  } catch (e) {
    logger.error('[ADMIN USER DETAIL]', e.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.delete('/api/admin/reactions/:id', requireAdmin, async (req, res) => {
  try {
    const reaction = await Reaction.findById(req.params.id);
    if (!reaction) return res.status(404).json({ error: 'Réaction introuvable' });
    await cloudinary.uploader.destroy(reaction.cloudinaryId, { resource_type: 'video' }).catch(() => {});
    await Reaction.deleteOne({ _id: reaction._id });
    res.json({ ok: true });
  } catch (e) {
    logger.error('[ADMIN DELETE REACTION]', e.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// SIGNALEMENT DSA (UE 2022/2065)
// ═══════════════════════════════════════════════════════════════════════════════
const REPORT_REASONS = new Set([
  'illegal', 'sexual', 'minor', 'hate', 'harassment',
  'copyright', 'privacy', 'spam', 'malware', 'other'
]);

app.post('/api/report', reportLimiter, async (req, res) => {
  try {
    const { videoId, reason, description } = req.body || {};
    if (!videoId || !mongoose.isValidObjectId(videoId)) {
      return res.status(400).json({ error: 'Vidéo invalide.' });
    }
    if (!reason || !REPORT_REASONS.has(reason)) {
      return res.status(400).json({ error: 'Motif invalide.' });
    }
    const desc = String(description || '').slice(0, 2000);

    const video = await Video.findById(videoId).select('_id originalName userId').lean();
    if (!video) return res.status(404).json({ error: 'Vidéo introuvable.' });

    const ip = req.ip || '';
    const ipHash = crypto.createHash('sha256').update(ip).digest('hex').slice(0, 32);

    const report = await Report.create({
      videoId:        video._id,
      reporterUserId: req.session?.userId || null,
      reporterIpHash: ipHash,
      reason,
      description:    desc,
    });

    {
      const safeReason = escHtml(reason);
      const safeDesc   = escHtml(desc) || '<em>(aucune description)</em>';
      const safeTitle  = escHtml(video.originalName || '');
      const safeVid    = escHtml(String(video._id));
      const safeRep    = escHtml(String(report._id));
      const safeUser   = req.session?.userId ? escHtml(String(req.session.userId)) : '<em>anonyme</em>';

      sendEmail({
        to:      'contact@reaction-cam.com',
        replyTo: 'contact@reaction-cam.com',
        subject: safeSubject(`[Signalement] ${reason} — vidéo ${video._id}`),
        html: `
          <div style="font-family:system-ui,sans-serif;max-width:600px;padding:20px;">
            <h2 style="color:#c9a84c;">Signalement de contenu</h2>
            <p><strong>Report ID :</strong> ${safeRep}</p>
            <p><strong>Vidéo :</strong> ${safeTitle} (${safeVid})</p>
            <p><strong>Lien :</strong> <a href="https://reaction-cam.com/watch/${safeVid}">https://reaction-cam.com/watch/${safeVid}</a></p>
            <p><strong>Motif :</strong> ${safeReason}</p>
            <p><strong>Description :</strong></p>
            <blockquote style="margin:8px 0;padding:12px;background:#f5f5f0;border-left:3px solid #c9a84c;">${safeDesc.replace(/\n/g, '<br>')}</blockquote>
            <p><strong>Signaleur :</strong> ${safeUser}</p>
            <hr style="margin:20px 0;border:none;border-top:1px solid #ddd;">
            <p style="font-size:11px;color:#888;">Action requise sous 24h (DSA). Examiner via /admin si décision d'action.</p>
          </div>
        `,
      }).catch(e => logger.error('[REPORT EMAIL]', e.message));
    }

    res.json({ ok: true, id: report._id });
  } catch (e) {
    logger.error('[REPORT]', e.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// PAGES
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/account',         (req, res) => res.sendFile(path.join(__dirname, 'public', 'account.html')));
app.get('/admin',           requireAdminPage, (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/admin/users/:id', requireAdminPage, (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin-user.html')));
app.get('/watch/:id',  (req, res) => res.sendFile(path.join(__dirname, 'public', 'watch.html')));
app.get('/dashboard',  (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/stats',      (req, res) => res.sendFile(path.join(__dirname, 'public', 'stats.html')));
app.get('/login',      (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/register',   (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/pricing',    (req, res) => res.sendFile(path.join(__dirname, 'public', 'pricing.html')));
app.get('/privacy',    (req, res) => res.sendFile(path.join(__dirname, 'public', 'privacy.html')));
app.get('/terms',      (req, res) => res.sendFile(path.join(__dirname, 'public', 'terms.html')));
app.get('/cgu',        (req, res) => res.redirect('/terms'));
app.get('/legal',      (req, res) => res.sendFile(path.join(__dirname, 'public', 'legal.html')));
app.get('/mentions',   (req, res) => res.redirect('/legal'));
app.get('/rgpd',       (req, res) => res.redirect('/privacy'));

// Health check — utilisé par Render pour piloter les rolling deploys.
// readyState : 0=disconnected, 1=connected, 2=connecting, 3=disconnecting.
app.get('/healthz', (req, res) => {
  const ok = mongoose.connection.readyState === 1;
  res.status(ok ? 200 : 503).json({
    status: ok ? 'ok' : 'degraded',
    mongo:  mongoose.connection.readyState,
    uptime: Math.floor(process.uptime()),
  });
});

// Sentry error handler — DOIT être après les routes, avant l'error handler custom.
if (Sentry) Sentry.setupExpressErrorHandler(app);

app.use((err, req, res, next) => {
  logger.error('Erreur globale :', err.message);
  // En prod on évite de leak le message d'erreur brut au client.
  res.status(500).json({ error: IS_PROD ? 'Erreur serveur' : err.message });
});

// ═══════════════════════════════════════════════════════════════════════════════
// NETTOYAGE NOCTURNE (vidéos expirées + tokens de vérif expirés)
// ═══════════════════════════════════════════════════════════════════════════════

async function deleteExpiredVideos() {
  const now     = new Date();
  const expired = await Video.find({ expiresAt: { $lte: now } });
  if (!expired.length) return;

  logger.info(`🗑️  Nettoyage : ${expired.length} vidéo(s) expirée(s)`);

  for (const video of expired) {
    try {
      const reactions = await Reaction.find({ videoId: video._id });
      for (const r of reactions) {
        await cloudinary.uploader.destroy(r.cloudinaryId, { resource_type: 'video' });
      }
      await Reaction.deleteMany({ videoId: video._id });
      await cloudinary.uploader.destroy(video.cloudinaryId, { resource_type: 'video' });
      await Video.deleteOne({ _id: video._id });
      logger.info(`  ✓ Supprimé : ${video.originalName} (${video._id})`);
    } catch (e) {
      logger.error(`  ✗ Échec suppression ${video._id} :`, e.message);
    }
  }
}

// Purge les tokens de vérification email expirés (24h). Sans ça, les docs
// User gardent à vie un token périmé qui pollue l'index unique sparse.
async function purgeExpiredEmailTokens() {
  try {
    const r = await User.updateMany(
      { emailVerificationExpires: { $lte: new Date() } },
      { $unset: { emailVerificationToken: 1, emailVerificationExpires: 1 } }
    );
    if (r.modifiedCount) logger.info(`🧹 Purge tokens email : ${r.modifiedCount} doc(s)`);
  } catch (e) {
    logger.error('[PURGE TOKENS]', e.message);
  }
}

async function runDailyMaintenance() {
  await deleteExpiredVideos();
  await purgeExpiredEmailTokens();
}

// En prod, Render Cron Jobs déclenche /api/admin/cleanup en HTTP (cf.
// render.yaml). On ne lance le cron interne qu'en dev pour éviter une double
// exécution si l'app passe en multi-instance.
if (!IS_PROD) {
  cron.schedule('0 3 * * *', () => {
    logger.info('⏰ Cron nettoyage lancé (dev)');
    runDailyMaintenance().catch(e => logger.error('Cron erreur :', e.message));
  });
}

// Helper d'authent admin partagé par les endpoints cron (header X-Admin-Key
// pour Render Cron Jobs, ou session admin pour déclenchement manuel).
async function isAdminRequest(req) {
  const headerOk = process.env.ADMIN_KEY && req.headers['x-admin-key'] === process.env.ADMIN_KEY;
  if (headerOk) return true;
  if (!req.session.userId) return false;
  const u = await User.findById(req.session.userId).select('email plan').catch(() => null);
  return !!u && (u.plan === 'admin' || ADMIN_EMAILS.includes(u.email));
}

// Route admin : nettoyage quotidien (vidéos + tokens). Appelée par Render Cron.
app.post('/api/admin/cleanup', async (req, res) => {
  if (!(await isAdminRequest(req))) return res.status(403).json({ error: 'Forbidden' });
  try {
    await runDailyMaintenance();
    res.json({ ok: true });
  } catch (e) {
    logger.error('[CLEANUP]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Route admin : rejeu de la file d'emails. Appelée par Render Cron toutes les
// 5 min — backoff exponentiel jusqu'à 5 tentatives par email.
app.post('/api/admin/process-email-queue', async (req, res) => {
  if (!(await isAdminRequest(req))) return res.status(403).json({ error: 'Forbidden' });
  try {
    const stats = await processEmailQueue();
    res.json({ ok: true, ...stats });
  } catch (e) {
    logger.error('[EMAIL QUEUE]', e.message);
    res.status(500).json({ error: e.message });
  }
});

const server = app.listen(PORT, () => logger.info(`\n🎬 ReactionCam → http://localhost:${PORT} (${IS_PROD ? 'PROD' : 'DEV'})\n`));

// ── Graceful shutdown ─────────────────────────────────────────────────────────
// Render envoie SIGTERM avant de tuer le process : on ferme le serveur HTTP
// (= plus de nouvelles connexions), on laisse les requêtes en cours finir,
// puis on ferme proprement Mongoose. Timeout 25 s avant kill forcé.
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`\n📴 ${signal} reçu — arrêt gracieux en cours…`);

  const forceTimer = setTimeout(() => {
    logger.error('⏱️  Timeout shutdown, kill forcé.');
    process.exit(1);
  }, 25_000);

  server.close(async (err) => {
    if (err) logger.error('[SHUTDOWN] server.close :', err.message);
    try {
      await mongoose.connection.close(false);
      logger.info('✅ Mongoose fermé proprement.');
    } catch (e) {
      logger.error('[SHUTDOWN] mongoose.close :', e.message);
    } finally {
      clearTimeout(forceTimer);
      process.exit(0);
    }
  });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
