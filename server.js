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
  userId:       { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  cloudinaryId: { type: String, required: true },
  url:          { type: String, required: true },
  originalName: String,
  size:         Number,
  expiresAt:    { type: Date, default: null, index: true },
  createdAt:    { type: Date, default: Date.now }
}));

const Reaction = mongoose.model('Reaction', new mongoose.Schema({
  videoId:      { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  viewerName:   String,
  cloudinaryId: { type: String, required: true },
  url:          { type: String, required: true },
  createdAt:    { type: Date, default: Date.now }
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

      const video = await Video.create({
        userId:       req.session.userId,
        cloudinaryId: req.file.filename,
        url:          req.file.path,
        originalName: req.file.originalname,
        size:         req.file.size,
        expiresAt:    expiresAtForPlan(user?.plan || 'free')
      });
      res.json({ id: video._id, link: `${req.protocol}://${req.get('host')}/watch/${video._id}` });
    } catch (e) {
      console.error('[UPLOAD DB]', e.message);
      res.status(500).json({ error: 'Erreur base de données' });
    }
  });
});

app.get('/api/video/:id', async (req, res) => {
  try {
    const video = await Video.findById(req.params.id);
    if (!video) return res.status(404).json({ error: 'Vidéo introuvable' });
    res.json({ url: video.url });
  } catch {
    res.status(404).json({ error: 'Vidéo introuvable' });
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

      const viewerName = (req.body?.viewerName || 'Anonyme').slice(0, 80);
      const reaction = await Reaction.create({
        videoId:      video._id,
        viewerName,
        cloudinaryId: file.filename,
        url:          file.path
      });

      res.json({ reactionId: reaction._id, url: reaction.url });

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
// PAGES
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/watch/:id',  (req, res) => res.sendFile(path.join(__dirname, 'public', 'watch.html')));
app.get('/dashboard',  (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
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

// Route admin pour déclencher manuellement
app.post('/api/admin/cleanup', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    await deleteExpiredVideos();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log(`\n🎬 ReactionCam → http://localhost:${PORT} (${IS_PROD ? 'PROD' : 'DEV'})\n`));
