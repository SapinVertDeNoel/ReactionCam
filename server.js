require('dotenv').config();

const express    = require('express');
const multer     = require('multer');
const path       = require('path');
const bcrypt     = require('bcrypt');
const session    = require('express-session');
const mongoose   = require('mongoose');
const MongoStore = require('connect-mongo');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');

const app  = express();
const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === 'production' || !!process.env.RENDER;

// ── Variables d'environnement requises ────────────────────────────────────────
const REQUIRED_ENV = ['MONGODB_URI', 'CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET'];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length) {
  console.error('❌ Variables manquantes :', missing.join(', '));
  console.error('   Crée un fichier .env en te basant sur .env.example');
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

// ── Modèles ───────────────────────────────────────────────────────────────────
const User = mongoose.model('User', new mongoose.Schema({
  email:     { type: String, unique: true, lowercase: true, required: true },
  password:  { type: String, required: true },
  name:      { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
}));

const Video = mongoose.model('Video', new mongoose.Schema({
  userId:       { type: mongoose.Schema.Types.ObjectId, required: true },
  cloudinaryId: { type: String, required: true },
  url:          { type: String, required: true },
  originalName: String,
  size:         Number,
  createdAt:    { type: Date, default: Date.now }
}));

const Reaction = mongoose.model('Reaction', new mongoose.Schema({
  videoId:      { type: mongoose.Schema.Types.ObjectId, required: true },
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

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Auth guard ────────────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Non connecté' });
  next();
}

// ── Multer → Cloudinary (streaming direct, rien écrit sur disque) ─────────────
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

app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, name } = req.body;
    if (!email || !password || !name)
      return res.status(400).json({ error: 'Tous les champs sont requis' });
    if (password.length < 6)
      return res.status(400).json({ error: 'Mot de passe trop court (6 caractères min)' });

    if (await User.findOne({ email: email.toLowerCase() }))
      return res.status(409).json({ error: 'Email déjà utilisé' });

    const hash = await bcrypt.hash(password, 10);
    const user = await User.create({ email: email.toLowerCase(), name, password: hash });

    req.session.userId   = user._id.toString();
    req.session.userName = user.name;
    await req.session.save();

    res.json({ id: user._id, name: user.name, email: user.email });
  } catch (e) {
    console.error('[REGISTER]', e.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email: (email || '').toLowerCase() });
    if (!user || !(await bcrypt.compare(password || '', user.password)))
      return res.status(401).json({ error: 'Email ou mot de passe incorrect' });

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

app.get('/api/auth/me', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Non connecté' });
  try {
    const user = await User.findById(req.session.userId);
    if (!user) return res.status(401).json({ error: 'Introuvable' });
    res.json({ id: user._id, name: user.name, email: user.email });
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
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
      const video = await Video.create({
        userId:       req.session.userId,
        cloudinaryId: req.file.filename,
        url:          req.file.path,
        originalName: req.file.originalname,
        size:         req.file.size
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
    const videos = await Video.find({ userId: req.session.userId }).sort({ createdAt: -1 });

    const result = await Promise.all(videos.map(async v => {
      const reactions = await Reaction.find({ videoId: v._id }).sort({ createdAt: -1 });
      return {
        id:           v._id,
        url:          v.url,
        originalName: v.originalName,
        size:         v.size,
        createdAt:    v.createdAt,
        reactions: reactions.map(r => ({
          id:         r._id,
          viewerName: r.viewerName || 'Anonyme',
          url:        r.url,
          createdAt:  r.createdAt,
          ready:      true
        }))
      };
    }));

    res.json({ videos: result });
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

      const reaction = await Reaction.create({
        videoId:      video._id,
        viewerName:   req.body?.viewerName || 'Anonyme',
        cloudinaryId: file.filename,
        url:          file.path
      });

      res.json({ reactionId: reaction._id, url: reaction.url });
    } catch (e) {
      console.error('[REACTION]', e.message);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  }
);

// ═══════════════════════════════════════════════════════════════════════════════
// PAGES
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/watch/:id',  (req, res) => res.sendFile(path.join(__dirname, 'public', 'watch.html')));
app.get('/dashboard',  (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/login',      (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/register',   (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));

app.use((err, req, res, next) => {
  console.error('Erreur globale :', err.message);
  res.status(500).json({ error: err.message });
});

app.listen(PORT, () => console.log(`\n🎬 ReactionCam → http://localhost:${PORT} (${IS_PROD ? 'PROD' : 'DEV'})\n`));
