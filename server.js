require('dotenv').config();

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
const rateLimit      = require('express-rate-limit');
const compression    = require('compression');

const app  = express();
const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === 'production' || !!process.env.RENDER;

const stripe = process.env.STRIPE_SECRET_KEY
  ? require('stripe')(process.env.STRIPE_SECRET_KEY)
  : null;

const resend = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

// ── Variables d'environnement requises ────────────────────────────────────────
const REQUIRED_ENV = ['MONGODB_URI', 'CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET'];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length) {
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
  .then(() => console.log('✅ MongoDB connecté'))
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

// ── App ───────────────────────────────────────────────────────────────────────
app.set('trust proxy', 1);

// ── Sessions dans MongoDB ─────────────────────────────────────────────────────
app.use(session({
  store: MongoStore.create({ mongoUrl: process.env.MONGODB_URI }),
  secret: process.env.SESSION_SECRET || 'reactioncam-dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 7 * 24 * 60 * 60 * 1000,
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
app.post('/api/billing/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    if (!stripe) return res.status(503).send('Stripe non configuré');
    const sig = req.headers['stripe-signature'];
    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      console.error('[WEBHOOK] Signature invalide :', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
      if (event.type === 'checkout.session.completed') {
        const s = event.data.object;
        const user = await User.findById(s.client_reference_id);
        if (user) {
          user.stripeCustomerId     = s.customer;
          user.stripeSubscriptionId = s.subscription;
          user.plan = 'pro';
          await user.save();
          await Video.updateMany({ userId: user._id }, { expiresAt: null });
          console.log(`✅ Plan Pro activé : ${user.email}`);
        }
      }

      if (event.type === 'customer.subscription.deleted') {
        const sub = event.data.object;
        const user = await User.findOne({ stripeCustomerId: sub.customer });
        if (user && user.plan === 'pro') {
          user.plan = 'free';
          user.stripeSubscriptionId = null;
          await user.save();
          const expiry = expiresAtForPlan('free');
          await Video.updateMany({ userId: user._id, expiresAt: null }, { expiresAt: expiry });
          console.log(`⬇️  Plan rétrogradé à Free : ${user.email}`);
        }
      }

      if (event.type === 'customer.subscription.updated') {
        const sub = event.data.object;
        if (sub.status !== 'active' && sub.status !== 'trialing') {
          const user = await User.findOne({ stripeCustomerId: sub.customer });
          console.log(`⚠️  Abonnement ${sub.status} pour ${user?.email}`);
        }
      }
    } catch (e) {
      console.error('[WEBHOOK] Traitement :', e.message);
    }

    res.json({ received: true });
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

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(compression());
app.use((req, res, next) => {
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=()');
  next();
});
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(passport.initialize());
app.use(express.static(path.join(__dirname, 'public')));

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
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || 'gertrudedu12@gmail.com')
  .split(',').map(e => e.trim().toLowerCase()).filter(Boolean);

// Synchronise le plan 'admin' au démarrage pour tous les emails admin
mongoose.connection.once('open', async () => {
  if (!ADMIN_EMAILS.length) return;
  await User.updateMany(
    { email: { $in: ADMIN_EMAILS } },
    { $set: { plan: 'admin', emailVerified: true } }
  ).catch(e => console.error('[ADMIN SYNC]', e.message));
  console.log(`👑 Admins : ${ADMIN_EMAILS.join(', ')}`);
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

// ── Email verification helper ─────────────────────────────────────────────────
async function sendVerificationEmail(user, baseUrl) {
  const token   = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + 24 * 60 * 60 * 1000);
  user.emailVerificationToken   = token;
  user.emailVerificationExpires = expires;
  await user.save();

  const link = `${baseUrl}/api/auth/verify-email?token=${token}`;

  if (!resend) {
    console.log(`[DEV] Lien de vérification pour ${user.email} : ${link}`);
    return;
  }

  await resend.emails.send({
    from:    'ReactionCam <noreply@reaction-cam.com>',
    to:      user.email,
    subject: 'Confirme ton adresse email — ReactionCam',
    html:    `
<!DOCTYPE html><html><body style="margin:0;padding:0;background:#0a0a0a;font-family:'Courier New',monospace;color:#e8e0d0;">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:40px 20px;">
<table width="480" cellpadding="0" cellspacing="0" style="background:#111;border:1px solid #1e1e1e;border-radius:4px;">
  <tr><td style="padding:40px 36px;">
    <p style="font-size:22px;font-weight:300;letter-spacing:0.12em;color:#c9a84c;margin:0 0 24px;">Reaction<em>Cam</em></p>
    <p style="font-size:14px;margin:0 0 12px;">Bonjour ${user.name},</p>
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
    console.error('[REGISTER]', e.message);
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
    console.error('[LOGIN]', e.message);
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
    console.error('[VERIFY EMAIL]', e.message);
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
    console.error('[RESEND VERIFY]', e.message);
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

app.post('/upload', requireAuth, (req, res) => {
  uploadVideo.single('video')(req, res, async (err) => {
    if (err) {
      console.error('[UPLOAD]', err.message);
      return res.status(400).json({ error: err.message });
    }
    if (!req.file) return res.status(400).json({ error: 'Aucun fichier reçu' });

    try {
      const user = await User.findById(req.session.userId);
      const plan = PLANS[user?.plan || 'free'];

      if (plan.maxVideos !== null) {
        const count = await Video.countDocuments({ userId: req.session.userId });
        if (count >= plan.maxVideos) {
          await cloudinary.uploader.destroy(req.file.filename, { resource_type: 'video' });
          return res.status(403).json({
            error: `Limite atteinte : le plan gratuit permet ${plan.maxVideos} vidéos maximum.`,
            limitReached: true,
          });
        }
      }

      const visibility   = req.body?.visibility === 'private' ? 'private' : 'public';
      const allowedEmails = visibility === 'private' ? parseEmailList(req.body?.allowedEmails) : [];

      if (visibility === 'private' && allowedEmails.length === 0) {
        await cloudinary.uploader.destroy(req.file.filename, { resource_type: 'video' });
        return res.status(400).json({ error: 'Une vidéo privée doit avoir au moins un email autorisé.' });
      }

      const video = await Video.create({
        userId:        req.session.userId,
        cloudinaryId:  req.file.filename,
        url:           req.file.path,
        originalName:  req.file.originalname,
        size:          req.file.size,
        visibility,
        allowedEmails,
        expiresAt:     expiresAtForPlan(user?.plan || 'free')
      });

      const link = `${req.protocol}://${req.get('host')}/watch/${video._id}`;
      res.json({ id: video._id, link, visibility, allowedEmails });

      // Invitations (non-bloquant)
      if (resend && visibility === 'private' && allowedEmails.length > 0) {
        const senderName  = user?.name || 'Quelqu’un';
        const videoTitle  = (req.file.originalname || 'une vidéo').slice(0, 60);
        const baseUrl     = `${req.protocol}://${req.get('host')}`;
        for (const email of allowedEmails) {
          resend.emails.send({
            from:    'ReactionCam <noreply@reaction-cam.com>',
            to:      email,
            subject: `${senderName} t'a partagé une vidéo privée`,
            html: `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#0a0a0a;font-family:'Courier New',monospace;color:#e8e0d0;">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:40px 20px;">
<table width="480" cellpadding="0" cellspacing="0" style="background:#111;border:1px solid #1e1e1e;border-radius:4px;">
  <tr><td style="padding:40px 36px;">
    <p style="font-size:22px;font-weight:300;letter-spacing:0.12em;color:#c9a84c;margin:0 0 24px;">Reaction<em>Cam</em></p>
    <p style="font-size:14px;margin:0 0 12px;">Tu as reçu une vidéo privée 🎬</p>
    <p style="font-size:13px;color:#a09080;margin:0 0 18px;line-height:1.6;"><strong style="color:#e8e0d0;">${senderName}</strong> t'a partagé <em>${videoTitle}</em>.</p>
    <p style="font-size:12px;color:#a09080;margin:0 0 28px;line-height:1.6;">Cette vidéo est <strong style="color:#c9a84c;">privée</strong>. Pour la regarder, tu dois te connecter à ReactionCam avec cette adresse email (<strong style="color:#e8e0d0;">${email}</strong>). Si tu n'as pas encore de compte, crée-le avec cette même adresse.</p>
    <a href="${baseUrl}/watch/${video._id}" style="display:inline-block;padding:14px 28px;background:#c9a84c;color:#0a0a0a;text-decoration:none;font-size:11px;letter-spacing:0.18em;text-transform:uppercase;border-radius:2px;">Regarder la vidéo</a>
    <p style="font-size:11px;color:#5a5245;margin:28px 0 0;line-height:1.6;">Tu reçois cet email parce que ${senderName} t'a explicitement ajouté à la liste d'accès de cette vidéo.</p>
  </td></tr>
</table>
</td></tr></table></body></html>`,
          }).catch(e => console.error('[INVITE EMAIL]', e.message));
        }
      }
    } catch (e) {
      console.error('[UPLOAD DB]', e.message);
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
        View.create({ videoId: video._id, ipHash }).catch(e => console.error('[VIEW]', e.message));
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
    console.error('[VIDEO PROXY]', e.message);
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
    console.error('[DASHBOARD]', e.message);
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
    console.error('[STATS]', e.message);
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
    console.error('[MY REACTIONS]', e.message);
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
    console.error('[DELETE MY REACTION]', e.message);
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
    console.error('[NOTIF LIST]', e.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.post('/api/notifications/read', requireAuth, async (req, res) => {
  try {
    await Notification.updateMany({ userId: req.session.userId, read: false }, { $set: { read: true } });
    res.json({ ok: true });
  } catch (e) {
    console.error('[NOTIF READ]', e.message);
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
    console.error('[NOTIF DELETE]', e.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.delete('/api/notifications', requireAuth, async (req, res) => {
  try {
    await Notification.deleteMany({ userId: req.session.userId });
    res.json({ ok: true });
  } catch (e) {
    console.error('[NOTIF CLEAR]', e.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// RÉACTIONS
// ═══════════════════════════════════════════════════════════════════════════════

app.post('/reaction/:id',
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
      }).catch(e => console.error('[NOTIF DB]', e.message));

      // Notification email (non-bloquant)
      if (resend) {
        const owner = await User.findById(video.userId).catch(() => null);
        if (owner?.email) {
          const baseUrl = `${req.protocol}://${req.get('host')}`;
          const videoTitle = video.originalName || 'ta vidéo';
          resend.emails.send({
            from:    'ReactionCam <noreply@reaction-cam.com>',
            to:      owner.email,
            subject: `${viewerName} a réagi à "${videoTitle.slice(0, 40)}"`,
            html: `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#0a0a0a;font-family:'Courier New',monospace;color:#e8e0d0;">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:40px 20px;">
<table width="480" cellpadding="0" cellspacing="0" style="background:#111;border:1px solid #1e1e1e;border-radius:4px;">
  <tr><td style="padding:40px 36px;">
    <p style="font-size:22px;font-weight:300;letter-spacing:0.12em;color:#c9a84c;margin:0 0 24px;">Reaction<em>Cam</em></p>
    <p style="font-size:14px;margin:0 0 12px;">Nouvelle réaction !</p>
    <p style="font-size:13px;color:#a09080;margin:0 0 28px;line-height:1.6;"><strong style="color:#e8e0d0;">${viewerName}</strong> a regardé <em>${videoTitle.slice(0, 60)}</em> et a enregistré sa réaction.</p>
    <a href="${baseUrl}/dashboard" style="display:inline-block;padding:14px 28px;background:#c9a84c;color:#0a0a0a;text-decoration:none;font-size:11px;letter-spacing:0.18em;text-transform:uppercase;border-radius:2px;">Voir la réaction</a>
    <p style="font-size:11px;color:#5a5245;margin:28px 0 0;line-height:1.6;">Tu reçois cet email car tu as un compte ReactionCam. <a href="${baseUrl}/dashboard" style="color:#7a6330;">Gérer les notifications</a></p>
  </td></tr>
</table>
</td></tr></table></body></html>`,
          }).catch(e => console.error('[NOTIF EMAIL]', e.message));
        }
      }
    } catch (e) {
      console.error('[REACTION]', e.message);
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
    console.error('[DELETE VIDEO]', e.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// STRIPE BILLING
// ═══════════════════════════════════════════════════════════════════════════════

app.post('/api/billing/checkout', requireAuth, async (req, res) => {
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
    console.error('[BILLING CHECKOUT]', e.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.post('/api/billing/portal', requireAuth, async (req, res) => {
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
    console.error('[BILLING PORTAL]', e.message);
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
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const [
      userTotal, userFree, userPro, userAdmin,
      userWeek, videoTotal, videoWeek, reactionTotal, reactionWeek,
      storageAgg, expiringSoon
    ] = await Promise.all([
      User.countDocuments(),
      User.countDocuments({ plan: 'free' }),
      User.countDocuments({ plan: 'pro' }),
      User.countDocuments({ plan: 'admin' }),
      User.countDocuments({ createdAt: { $gte: sevenDaysAgo } }),
      Video.countDocuments(),
      Video.countDocuments({ createdAt: { $gte: sevenDaysAgo } }),
      Reaction.countDocuments(),
      Reaction.countDocuments({ createdAt: { $gte: sevenDaysAgo } }),
      Video.aggregate([{ $group: { _id: null, total: { $sum: '$size' } } }]),
      Video.countDocuments({ expiresAt: { $gte: new Date(), $lte: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) } }),
    ]);

    // Inscriptions par jour (14 derniers jours)
    const days = [];
    for (let i = 13; i >= 0; i--) {
      const start = new Date(); start.setDate(start.getDate() - i); start.setHours(0, 0, 0, 0);
      const end   = new Date(start); end.setDate(end.getDate() + 1);
      const [u, v, r] = await Promise.all([
        User.countDocuments({ createdAt: { $gte: start, $lt: end } }),
        Video.countDocuments({ createdAt: { $gte: start, $lt: end } }),
        Reaction.countDocuments({ createdAt: { $gte: start, $lt: end } }),
      ]);
      days.push({ date: start.toISOString().slice(0, 10), users: u, videos: v, reactions: r });
    }

    res.json({
      users:     { total: userTotal, free: userFree, pro: userPro, admin: userAdmin, week: userWeek },
      videos:    { total: videoTotal, week: videoWeek, expiringSoon },
      reactions: { total: reactionTotal, week: reactionWeek },
      storage:   { bytes: storageAgg[0]?.total || 0 },
      chart:     days,
    });
  } catch (e) {
    console.error('[ADMIN STATS]', e.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.get('/api/admin/users', requireAdmin, async (req, res) => {
  try {
    const { search = '', page = 1, limit = 25, plan } = req.query;
    const query = {};
    if (search) query.$or = [{ email: new RegExp(search, 'i') }, { name: new RegExp(search, 'i') }];
    if (plan) query.plan = plan;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [users, total] = await Promise.all([
      User.find(query)
        .select('-password -emailVerificationToken -emailVerificationExpires')
        .sort({ createdAt: -1 }).skip(skip).limit(parseInt(limit)),
      User.countDocuments(query),
    ]);
    const enriched = await Promise.all(users.map(async u => {
      const videoCount = await Video.countDocuments({ userId: u._id });
      return { ...u.toObject(), videoCount };
    }));
    res.json({ users: enriched, total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)) });
  } catch (e) {
    console.error('[ADMIN USERS]', e.message);
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
    console.error('[ADMIN SET PLAN]', e.message);
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
    console.error('[ADMIN DELETE USER]', e.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.get('/api/admin/videos', requireAdmin, async (req, res) => {
  try {
    const { search = '', page = 1, limit = 25 } = req.query;
    const query = search ? { originalName: new RegExp(search, 'i') } : {};
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [videos, total] = await Promise.all([
      Video.find(query).sort({ createdAt: -1 }).skip(skip).limit(parseInt(limit)),
      Video.countDocuments(query),
    ]);
    const enriched = await Promise.all(videos.map(async v => {
      const [owner, reactionCount] = await Promise.all([
        User.findById(v.userId).select('email name plan').catch(() => null),
        Reaction.countDocuments({ videoId: v._id }),
      ]);
      return { ...v.toObject(), owner, reactionCount };
    }));
    res.json({ videos: enriched, total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)) });
  } catch (e) {
    console.error('[ADMIN VIDEOS]', e.message);
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
    console.error('[ADMIN DELETE VIDEO]', e.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.get('/api/admin/reactions', requireAdmin, async (req, res) => {
  try {
    const { page = 1, limit = 25 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [reactions, total] = await Promise.all([
      Reaction.find().sort({ createdAt: -1 }).skip(skip).limit(parseInt(limit)),
      Reaction.countDocuments(),
    ]);
    const enriched = await Promise.all(reactions.map(async r => {
      const video = await Video.findById(r.videoId).select('originalName userId').catch(() => null);
      return { ...r.toObject(), video };
    }));
    res.json({ reactions: enriched, total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)) });
  } catch (e) {
    console.error('[ADMIN REACTIONS]', e.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.get('/api/admin/users/:id', requireAdmin, async (req, res) => {
  try {
    const user = await User.findById(req.params.id)
      .select('-password -emailVerificationToken -emailVerificationExpires');
    if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });
    const videos = await Video.find({ userId: user._id }).sort({ createdAt: -1 });
    const enrichedVideos = await Promise.all(videos.map(async v => {
      const reactionCount = await Reaction.countDocuments({ videoId: v._id });
      return { ...v.toObject(), reactionCount };
    }));
    const totalSize = videos.reduce((s, v) => s + (v.size || 0), 0);
    res.json({ user: user.toObject(), videos: enrichedVideos, totalSize });
  } catch (e) {
    console.error('[ADMIN USER DETAIL]', e.message);
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
    console.error('[ADMIN DELETE REACTION]', e.message);
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
app.get('/rgpd',       (req, res) => res.redirect('/privacy'));

app.use((err, req, res, next) => {
  console.error('Erreur globale :', err.message);
  res.status(500).json({ error: err.message });
});

// ═══════════════════════════════════════════════════════════════════════════════
// NETTOYAGE DES VIDÉOS EXPIRÉES
// ═══════════════════════════════════════════════════════════════════════════════

async function deleteExpiredVideos() {
  const now     = new Date();
  const expired = await Video.find({ expiresAt: { $lte: now } });
  if (!expired.length) return;

  console.log(`🗑️  Nettoyage : ${expired.length} vidéo(s) expirée(s)`);

  for (const video of expired) {
    try {
      const reactions = await Reaction.find({ videoId: video._id });
      for (const r of reactions) {
        await cloudinary.uploader.destroy(r.cloudinaryId, { resource_type: 'video' });
      }
      await Reaction.deleteMany({ videoId: video._id });
      await cloudinary.uploader.destroy(video.cloudinaryId, { resource_type: 'video' });
      await Video.deleteOne({ _id: video._id });
      console.log(`  ✓ Supprimé : ${video.originalName} (${video._id})`);
    } catch (e) {
      console.error(`  ✗ Échec suppression ${video._id} :`, e.message);
    }
  }
}

// Tourne chaque nuit à 3h UTC
cron.schedule('0 3 * * *', () => {
  console.log('⏰ Cron nettoyage lancé');
  deleteExpiredVideos().catch(e => console.error('Cron erreur :', e.message));
});

// Route admin pour déclencher manuellement (clé header OU session admin)
app.post('/api/admin/cleanup', async (req, res) => {
  const headerOk = process.env.ADMIN_KEY && req.headers['x-admin-key'] === process.env.ADMIN_KEY;
  let sessionOk = false;
  if (req.session.userId) {
    const u = await User.findById(req.session.userId).select('email plan').catch(() => null);
    sessionOk = u && (u.plan === 'admin' || ADMIN_EMAILS.includes(u.email));
  }
  if (!headerOk && !sessionOk) return res.status(403).json({ error: 'Forbidden' });
  try {
    await deleteExpiredVideos();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log(`\n🎬 ReactionCam → http://localhost:${PORT} (${IS_PROD ? 'PROD' : 'DEV'})\n`));
