const express  = require('express');
const multer   = require('multer');
const { v4: uuidv4 } = require('uuid');
const path     = require('path');
const fs       = require('fs');
const bcrypt   = require('bcrypt');
const session  = require('express-session');
const low      = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');

const app  = express();
const PORT = process.env.PORT || 3000;

// Render (et la plupart des hébergeurs) est derrière un reverse proxy
// Sans ça, req.secure est toujours false et les cookies session ne passent pas
app.set('trust proxy', 1);

// ── Chemins : /tmp en prod (Render), local sinon ──────────────────────────────
// Render a un filesystem en lecture seule sauf /tmp
const IS_PROD   = process.env.NODE_ENV === 'production' || process.env.RENDER;
const BASE_DIR  = IS_PROD ? '/tmp/reactioncam' : __dirname;

const DIRS = {
  uploads:   path.join(BASE_DIR, 'uploads'),
  reactions: path.join(BASE_DIR, 'reactions'),
  data:      path.join(BASE_DIR, 'data'),
  sessions:  path.join(BASE_DIR, 'data', 'sessions'),
};

// Crée tous les dossiers nécessaires
Object.values(DIRS).forEach(d => fs.mkdirSync(d, { recursive: true }));

console.log(`📁 Stockage : ${BASE_DIR}`);

// ── DB ────────────────────────────────────────────────────────────────────────
const adapter = new FileSync(path.join(DIRS.data, 'db.json'));
const db = low(adapter);
db.defaults({ users: [], videos: [], reactions: [] }).write();

// ── Sessions ──────────────────────────────────────────────────────────────────
const FileStore = require('session-file-store')(session);
app.use(session({
  store: new FileStore({ path: DIRS.sessions, retries: 1 }),
  secret: process.env.SESSION_SECRET || 'reactioncam-dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 7 * 24 * 60 * 60 * 1000,
    // En prod sur HTTPS : secure + sameSite
    secure: IS_PROD,
    sameSite: IS_PROD ? 'none' : 'lax',
  }
}));

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads',   express.static(DIRS.uploads));
app.use('/reactions', express.static(DIRS.reactions));

// ── Auth guard ────────────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  console.log('[AUTH] sessionID:', req.sessionID, '| userId:', req.session.userId || 'none');
  if (!req.session.userId) return res.status(401).json({ error: 'Non connecté' });
  next();
}

// ── Multer ────────────────────────────────────────────────────────────────────
const uploadVideo = multer({
  storage: multer.diskStorage({
    destination: DIRS.uploads,
    filename: (req, file, cb) => {
      const id = uuidv4();
      req.generatedId = id;
      cb(null, `${id}${path.extname(file.originalname) || '.mp4'}`);
    }
  }),
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (req, file, cb) =>
    file.mimetype.startsWith('video/') ? cb(null, true) : cb(new Error('Fichier vidéo uniquement'))
});

const uploadReaction = multer({
  storage: multer.diskStorage({
    destination: DIRS.reactions,
    filename: (req, file, cb) => cb(null, `${uuidv4()}.webm`)
  }),
  limits: { fileSize: 500 * 1024 * 1024 }
});

// ═══════════════════════════════════════════════════════════════════════════════
// AUTH
// ═══════════════════════════════════════════════════════════════════════════════

app.post('/api/auth/register', async (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password || !name)
    return res.status(400).json({ error: 'Tous les champs sont requis' });
  if (password.length < 6)
    return res.status(400).json({ error: 'Mot de passe trop court (6 caractères min)' });

  if (db.get('users').find({ email: email.toLowerCase() }).value())
    return res.status(409).json({ error: 'Email déjà utilisé' });

  const hash = await bcrypt.hash(password, 10);
  const user = { id: uuidv4(), email: email.toLowerCase(), name, password: hash, createdAt: Date.now() };
  db.get('users').push(user).write();

  req.session.userId   = user.id;
  req.session.userName = user.name;
  res.json({ id: user.id, name: user.name, email: user.email });
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  const user = db.get('users').find({ email: (email || '').toLowerCase() }).value();
  if (!user) return res.status(401).json({ error: 'Email ou mot de passe incorrect' });

  const ok = await bcrypt.compare(password || '', user.password);
  if (!ok) return res.status(401).json({ error: 'Email ou mot de passe incorrect' });

  req.session.userId   = user.id;
  req.session.userName = user.name;
  res.json({ id: user.id, name: user.name, email: user.email });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/auth/me', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Non connecté' });
  const user = db.get('users').find({ id: req.session.userId }).value();
  if (!user) return res.status(401).json({ error: 'Introuvable' });
  res.json({ id: user.id, name: user.name, email: user.email });
});

// ═══════════════════════════════════════════════════════════════════════════════
// VIDEOS
// ═══════════════════════════════════════════════════════════════════════════════

app.post('/upload', requireAuth, uploadVideo.single('video'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Aucun fichier reçu' });
  const id = req.generatedId;
  db.get('videos').push({
    id,
    userId:       req.session.userId,
    filename:     req.file.filename,
    originalName: req.file.originalname,
    size:         req.file.size,
    createdAt:    Date.now()
  }).write();
  res.json({ id, link: `${req.protocol}://${req.get('host')}/watch/${id}` });
});

app.get('/api/video/:id', (req, res) => {
  const video = db.get('videos').find({ id: req.params.id }).value();
  if (!video) return res.status(404).json({ error: 'Vidéo introuvable' });
  res.json({ url: `/uploads/${video.filename}` });
});

app.get('/api/dashboard', requireAuth, (req, res) => {
  const videos = db.get('videos')
    .filter({ userId: req.session.userId })
    .orderBy(['createdAt'], ['desc'])
    .value();

  const result = videos.map(v => {
    const reactions = db.get('reactions')
      .filter({ videoId: v.id })
      .orderBy(['createdAt'], ['desc'])
      .value();

    return {
      ...v,
      reactions: reactions.map(r => ({
        id:         r.id,
        viewerName: r.viewerName || 'Anonyme',
        url:        r.filename ? `/reactions/${r.filename}` : null,
        createdAt:  r.createdAt,
        ready:      true
      }))
    };
  });

  res.json({ videos: result });
});

// ═══════════════════════════════════════════════════════════════════════════════
// REACTIONS
// ═══════════════════════════════════════════════════════════════════════════════

app.post('/reaction/:id',
  uploadReaction.fields([{ name: 'reaction', maxCount: 1 }, { name: 'viewerName', maxCount: 1 }]),
  (req, res) => {
    const file = req.files?.['reaction']?.[0];
    if (!file) return res.status(400).json({ error: 'Aucune réaction reçue' });

    const video = db.get('videos').find({ id: req.params.id }).value();
    if (!video) return res.status(404).json({ error: 'Vidéo introuvable' });

    const reactionId = uuidv4();
    const viewerName = req.body?.viewerName || 'Anonyme';

    db.get('reactions').push({
      id:        reactionId,
      videoId:   req.params.id,
      viewerName,
      filename:  file.filename,
      createdAt: Date.now()
    }).write();

    res.json({ reactionId, url: `/reactions/${file.filename}` });
  }
);

// ═══════════════════════════════════════════════════════════════════════════════
// PAGES
// ═══════════════════════════════════════════════════════════════════════════════
const pub = p => res => res.sendFile(path.join(__dirname, 'public', p));
app.get('/watch/:id',  (req, res) => res.sendFile(path.join(__dirname, 'public', 'watch.html')));
app.get('/dashboard',  (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/login',      (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/register',   (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));

app.use((err, req, res, next) => {
  console.error('Erreur :', err.message);
  res.status(500).json({ error: err.message });
});

app.listen(PORT, () => console.log(`\n🎬 ReactionCam → http://localhost:${PORT} (${IS_PROD ? 'PROD' : 'DEV'})\n`));
