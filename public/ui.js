(function () {
  'use strict';

  // ── Translations ──────────────────────────────────────────────────────────────
  var T = {
    fr: {
      'nav.home':     'Accueil',
      'nav.pricing':  'Tarifs',
      'nav.login':    'Connexion',
      'nav.register': 'Créer un compte',
      'nav.dashboard':'Mon espace',
      'nav.logout':   'Déconnexion',
      'nav.upload':   'Uploader une vidéo',
      'copy':         'Copier',
      'copied':       '✓ Copié',
      'download':     'Télécharger',
      'loading':      'Chargement…',

      'index.tagline':      'Capture les vraies réactions',
      'index.h1':           'Partage une vidéo.<br><em>Capture la réaction.</em>',
      'index.subtitle':     'Génère un lien · Le spectateur est filmé · Tu récupères sa réaction',
      'index.drop.main':    '<strong>Glisse ta vidéo ici</strong>',
      'index.drop.or':      'ou <strong>clique pour sélectionner</strong>',
      'index.result.title': 'Lien prêt',
      'index.copy':         'Copier',
      'index.upload.again': '↩ Uploader une autre vidéo',
      'index.step1.title':  'Upload',
      'index.step1.desc':   'Dépose ta vidéo sur ce site. Un lien unique est généré instantanément.',
      'index.step2.title':  'Partage',
      'index.step2.desc':   "Envoie le lien à tes amis. Ils devront accepter d'activer leur webcam.",
      'index.step3.title':  'Réaction',
      'index.step3.desc':   'Leur réaction est capturée. Vidéo combinée générée automatiquement.',
      'index.footer.legal': 'Données traitées selon le RGPD · Consentement explicite requis',
      'index.uploading':    'Envoi en cours…',
      'index.err.type':     'Seuls les fichiers vidéo sont acceptés.',
      'index.err.size':     'Le fichier dépasse la limite de 500 MB.',
      'index.err.auth':     'Tu dois être connecté pour uploader. Redirection…',
      'index.err.network':  'Erreur réseau. Vérifie ta connexion.',

      'login.tab.login':        'Connexion',
      'login.tab.register':     'Créer un compte',
      'login.google':           'Continuer avec Google',
      'login.or.email':         'ou continuer avec email',
      'login.or.create':        'ou créer avec email',
      'login.label.email':      'Email',
      'login.label.password':   'Mot de passe',
      'login.label.name':       'Ton prénom / pseudo',
      'login.pw.placeholder':   '6 caractères minimum',
      'login.email.placeholder':'toi@exemple.com',
      'login.btn.login':        'Se connecter',
      'login.btn.register':     'Créer mon compte',
      'login.btn.logging-in':   'Connexion…',
      'login.btn.creating':     'Création…',
      'login.link.no-account':  'Pas encore de compte ?',
      'login.link.register':    'Créer un compte',
      'login.link.has-account': 'Déjà un compte ?',
      'login.link.login':       'Se connecter',

      'dashboard.title':                'Mes',
      'dashboard.title.em':             'vidéos',
      'dashboard.empty.title':          'Aucune vidéo pour l\'instant',
      'dashboard.empty.desc':           'Upload ta première vidéo pour générer un lien de réaction.',
      'dashboard.copy.link':            'Copier le lien',
      'dashboard.copy.done':            '✓ Copié',
      'dashboard.modal.close':          '✕ fermer',
      'dashboard.rx.none':              'Aucune réaction reçue',
      'dashboard.rx.share':             'Partage ce lien pour recevoir des réactions :',
      'dashboard.rx.singular':          'réaction',
      'dashboard.rx.plural':            'réactions',
      'dashboard.rx.received.singular': 'reçue',
      'dashboard.rx.received.plural':   'reçues',
      'dashboard.status.ready':         '● Vidéo prête',
      'dashboard.status.proc':          '◌ Conversion en cours…',
      'dashboard.plan.unlimited':       'stockage illimité, vidéos conservées indéfiniment.',
      'dashboard.plan.manage':          "Gérer l'abonnement",
      'dashboard.plan.upgrade':         'Passer au Pro',
      'dashboard.plan.quota':           ' · supprimées après 90 jours',
      'dashboard.toast.pro':            '🎉 Bienvenue sur le plan Pro !',
      'dashboard.expire.in':            'Expire dans',
      'dashboard.expire.day':           'jour',
      'dashboard.expire.days':          'jours',
      'dashboard.expire.on':            'Expire le',
      'dashboard.portal.loading':       'Chargement…',
      'dashboard.no-name':              '(sans nom)',
      'dashboard.anonymous':            'Anonyme',

      'pricing.recommended':       'Recommandé',
      'pricing.hero.h1':           'Des plans simples,<br><em>sans surprise.</em>',
      'pricing.hero.sub':          'Commence gratuitement, passe au Pro quand tu en as besoin.',
      'pricing.free.name':         'Gratuit',
      'pricing.free.period':       'pour toujours',
      'pricing.free.desc':         'Parfait pour essayer ReactionCam et partager quelques vidéos.',
      'pricing.pro.period':        'par mois · résiliable à tout moment',
      'pricing.pro.desc':          'Pour les créateurs sérieux qui veulent tout garder, sans limite.',
      'pricing.feature.3videos':   '3 vidéos maximum',
      'pricing.feature.rx':        'Réactions illimitées par vidéo',
      'pricing.feature.3months':   'Vidéos conservées 3 mois',
      'pricing.feature.storage':   'Stockage illimité',
      'pricing.feature.permanent': 'Conservation permanente',
      'pricing.feature.unlimited': 'Vidéos illimitées',
      'pricing.feature.support':   'Support prioritaire',
      'pricing.btn.free':          'Commencer gratuitement',
      'pricing.btn.free.current':  'Ton plan actuel',
      'pricing.btn.pro':           'Passer au Pro',
      'pricing.btn.pro.manage':    "Gérer l'abonnement",
      'pricing.faq.title':         'Questions fréquentes',
      'pricing.faq.1.q':           "Que se passe-t-il si j'annule mon abonnement Pro ?",
      'pricing.faq.1.a':           "Tes vidéos passent en mode gratuit : elles seront supprimées 90 jours après la résiliation. Tu gardes accès à toutes tes réactions jusqu'à cette date.",
      'pricing.faq.2.q':           'Puis-je uploader plus de 3 vidéos avec le plan gratuit ?',
      'pricing.faq.2.a':           'Non, le plan gratuit est limité à 3 vidéos actives simultanément. Supprime une vidéo existante pour en uploader une nouvelle.',
      'pricing.faq.3.q':           'Le paiement est-il sécurisé ?',
      'pricing.faq.3.a':           'Oui, le paiement est géré par Stripe, leader mondial du paiement en ligne. Nous ne stockons aucune donnée de carte bancaire.',
      'pricing.faq.4.q':           'Les réactions sont-elles limitées en plan gratuit ?',
      'pricing.faq.4.a':           'Non. Le nombre de réactions reçues par vidéo est illimité sur les deux plans.',
      'pricing.footer':            'Données traitées selon le RGPD · Paiements sécurisés par Stripe',
    },

    en: {
      'nav.home':     'Home',
      'nav.pricing':  'Pricing',
      'nav.login':    'Login',
      'nav.register': 'Sign up',
      'nav.dashboard':'My space',
      'nav.logout':   'Logout',
      'nav.upload':   'Upload a video',
      'copy':         'Copy',
      'copied':       '✓ Copied',
      'download':     'Download',
      'loading':      'Loading…',

      'index.tagline':      'Capture real reactions',
      'index.h1':           'Share a video.<br><em>Capture the reaction.</em>',
      'index.subtitle':     'Generate a link · The viewer is filmed · You get their reaction',
      'index.drop.main':    '<strong>Drop your video here</strong>',
      'index.drop.or':      'or <strong>click to select</strong>',
      'index.result.title': 'Link ready',
      'index.copy':         'Copy',
      'index.upload.again': '↩ Upload another video',
      'index.step1.title':  'Upload',
      'index.step1.desc':   'Drop your video on this site. A unique link is generated instantly.',
      'index.step2.title':  'Share',
      'index.step2.desc':   "Send the link to your friends. They'll need to enable their webcam.",
      'index.step3.title':  'Reaction',
      'index.step3.desc':   'Their reaction is captured. Combined video generated automatically.',
      'index.footer.legal': 'Data processed per GDPR · Explicit consent required',
      'index.uploading':    'Uploading…',
      'index.err.type':     'Only video files are accepted.',
      'index.err.size':     'File exceeds the 500 MB limit.',
      'index.err.auth':     'You must be logged in to upload. Redirecting…',
      'index.err.network':  'Network error. Check your connection.',

      'login.tab.login':        'Login',
      'login.tab.register':     'Create an account',
      'login.google':           'Continue with Google',
      'login.or.email':         'or continue with email',
      'login.or.create':        'or create with email',
      'login.label.email':      'Email',
      'login.label.password':   'Password',
      'login.label.name':       'Your name / username',
      'login.pw.placeholder':   '6 characters minimum',
      'login.email.placeholder':'you@example.com',
      'login.btn.login':        'Log in',
      'login.btn.register':     'Create my account',
      'login.btn.logging-in':   'Logging in…',
      'login.btn.creating':     'Creating…',
      'login.link.no-account':  'No account yet?',
      'login.link.register':    'Sign up',
      'login.link.has-account': 'Already have an account?',
      'login.link.login':       'Log in',

      'dashboard.title':                'My',
      'dashboard.title.em':             'videos',
      'dashboard.empty.title':          'No videos yet',
      'dashboard.empty.desc':           'Upload your first video to generate a reaction link.',
      'dashboard.copy.link':            'Copy link',
      'dashboard.copy.done':            '✓ Copied',
      'dashboard.modal.close':          '✕ close',
      'dashboard.rx.none':              'No reactions received',
      'dashboard.rx.share':             'Share this link to receive reactions:',
      'dashboard.rx.singular':          'reaction',
      'dashboard.rx.plural':            'reactions',
      'dashboard.rx.received.singular': 'received',
      'dashboard.rx.received.plural':   'received',
      'dashboard.status.ready':         '● Video ready',
      'dashboard.status.proc':          '◌ Processing…',
      'dashboard.plan.unlimited':       'unlimited storage, videos kept indefinitely.',
      'dashboard.plan.manage':          'Manage subscription',
      'dashboard.plan.upgrade':         'Upgrade to Pro',
      'dashboard.plan.quota':           ' · deleted after 90 days',
      'dashboard.toast.pro':            '🎉 Welcome to the Pro plan!',
      'dashboard.expire.in':            'Expires in',
      'dashboard.expire.day':           'day',
      'dashboard.expire.days':          'days',
      'dashboard.expire.on':            'Expires on',
      'dashboard.portal.loading':       'Loading…',
      'dashboard.no-name':              '(no name)',
      'dashboard.anonymous':            'Anonymous',

      'pricing.recommended':       'Recommended',
      'pricing.hero.h1':           'Simple plans,<br><em>no surprises.</em>',
      'pricing.hero.sub':          'Start for free, upgrade to Pro when you need it.',
      'pricing.free.name':         'Free',
      'pricing.free.period':       'forever',
      'pricing.free.desc':         'Perfect to try ReactionCam and share a few videos.',
      'pricing.pro.period':        'per month · cancel anytime',
      'pricing.pro.desc':          'For serious creators who want to keep everything, without limits.',
      'pricing.feature.3videos':   '3 videos maximum',
      'pricing.feature.rx':        'Unlimited reactions per video',
      'pricing.feature.3months':   'Videos kept 3 months',
      'pricing.feature.storage':   'Unlimited storage',
      'pricing.feature.permanent': 'Permanent storage',
      'pricing.feature.unlimited': 'Unlimited videos',
      'pricing.feature.support':   'Priority support',
      'pricing.btn.free':          'Get started for free',
      'pricing.btn.free.current':  'Your current plan',
      'pricing.btn.pro':           'Upgrade to Pro',
      'pricing.btn.pro.manage':    'Manage subscription',
      'pricing.faq.title':         'Frequently asked questions',
      'pricing.faq.1.q':           'What happens if I cancel my Pro subscription?',
      'pricing.faq.1.a':           'Your videos switch to free mode: they will be deleted 90 days after cancellation. You keep access to all your reactions until that date.',
      'pricing.faq.2.q':           'Can I upload more than 3 videos on the free plan?',
      'pricing.faq.2.a':           'No, the free plan is limited to 3 active videos at a time. Delete an existing video to upload a new one.',
      'pricing.faq.3.q':           'Is payment secure?',
      'pricing.faq.3.a':           'Yes, payment is handled by Stripe, the world leader in online payments. We do not store any credit card data.',
      'pricing.faq.4.q':           'Are reactions limited on the free plan?',
      'pricing.faq.4.a':           'No. The number of reactions received per video is unlimited on both plans.',
      'pricing.footer':            'Data processed per GDPR · Payments secured by Stripe',
    },

    es: {
      'nav.home':     'Inicio',
      'nav.pricing':  'Precios',
      'nav.login':    'Iniciar sesión',
      'nav.register': 'Crear cuenta',
      'nav.dashboard':'Mi espacio',
      'nav.logout':   'Cerrar sesión',
      'nav.upload':   'Subir un vídeo',
      'copy':         'Copiar',
      'copied':       '✓ Copiado',
      'download':     'Descargar',
      'loading':      'Cargando…',

      'index.tagline':      'Captura las reacciones reales',
      'index.h1':           'Comparte un vídeo.<br><em>Captura la reacción.</em>',
      'index.subtitle':     'Genera un enlace · El espectador es filmado · Recuperas su reacción',
      'index.drop.main':    '<strong>Arrastra tu vídeo aquí</strong>',
      'index.drop.or':      'o <strong>haz clic para seleccionar</strong>',
      'index.result.title': 'Enlace listo',
      'index.copy':         'Copiar',
      'index.upload.again': '↩ Subir otro vídeo',
      'index.step1.title':  'Subir',
      'index.step1.desc':   'Sube tu vídeo a este sitio. Se genera un enlace único al instante.',
      'index.step2.title':  'Compartir',
      'index.step2.desc':   'Envía el enlace a tus amigos. Tendrán que aceptar activar su cámara.',
      'index.step3.title':  'Reacción',
      'index.step3.desc':   'Su reacción es capturada. Vídeo combinado generado automáticamente.',
      'index.footer.legal': 'Datos tratados según el RGPD · Consentimiento explícito requerido',
      'index.uploading':    'Subiendo…',
      'index.err.type':     'Solo se aceptan archivos de vídeo.',
      'index.err.size':     'El archivo supera el límite de 500 MB.',
      'index.err.auth':     'Debes iniciar sesión para subir. Redirigiendo…',
      'index.err.network':  'Error de red. Comprueba tu conexión.',

      'login.tab.login':        'Iniciar sesión',
      'login.tab.register':     'Crear una cuenta',
      'login.google':           'Continuar con Google',
      'login.or.email':         'o continuar con correo',
      'login.or.create':        'o crear con correo',
      'login.label.email':      'Correo electrónico',
      'login.label.password':   'Contraseña',
      'login.label.name':       'Tu nombre / apodo',
      'login.pw.placeholder':   '6 caracteres mínimo',
      'login.email.placeholder':'tú@ejemplo.com',
      'login.btn.login':        'Iniciar sesión',
      'login.btn.register':     'Crear mi cuenta',
      'login.btn.logging-in':   'Iniciando sesión…',
      'login.btn.creating':     'Creando…',
      'login.link.no-account':  '¿Sin cuenta aún?',
      'login.link.register':    'Crear una cuenta',
      'login.link.has-account': '¿Ya tienes cuenta?',
      'login.link.login':       'Iniciar sesión',

      'dashboard.title':                'Mis',
      'dashboard.title.em':             'vídeos',
      'dashboard.empty.title':          'Sin vídeos por ahora',
      'dashboard.empty.desc':           'Sube tu primer vídeo para generar un enlace de reacción.',
      'dashboard.copy.link':            'Copiar enlace',
      'dashboard.copy.done':            '✓ Copiado',
      'dashboard.modal.close':          '✕ cerrar',
      'dashboard.rx.none':              'Sin reacciones recibidas',
      'dashboard.rx.share':             'Comparte este enlace para recibir reacciones:',
      'dashboard.rx.singular':          'reacción',
      'dashboard.rx.plural':            'reacciones',
      'dashboard.rx.received.singular': 'recibida',
      'dashboard.rx.received.plural':   'recibidas',
      'dashboard.status.ready':         '● Vídeo listo',
      'dashboard.status.proc':          '◌ Procesando…',
      'dashboard.plan.unlimited':       'almacenamiento ilimitado, vídeos conservados indefinidamente.',
      'dashboard.plan.manage':          'Gestionar suscripción',
      'dashboard.plan.upgrade':         'Pasarse al Pro',
      'dashboard.plan.quota':           ' · eliminadas tras 90 días',
      'dashboard.toast.pro':            '🎉 ¡Bienvenido al plan Pro!',
      'dashboard.expire.in':            'Expira en',
      'dashboard.expire.day':           'día',
      'dashboard.expire.days':          'días',
      'dashboard.expire.on':            'Expira el',
      'dashboard.portal.loading':       'Cargando…',
      'dashboard.no-name':              '(sin nombre)',
      'dashboard.anonymous':            'Anónimo',

      'pricing.recommended':       'Recomendado',
      'pricing.hero.h1':           'Planes simples,<br><em>sin sorpresas.</em>',
      'pricing.hero.sub':          'Comienza gratis, pásate al Pro cuando lo necesites.',
      'pricing.free.name':         'Gratis',
      'pricing.free.period':       'para siempre',
      'pricing.free.desc':         'Perfecto para probar ReactionCam y compartir algunos vídeos.',
      'pricing.pro.period':        'al mes · cancela en cualquier momento',
      'pricing.pro.desc':          'Para creadores serios que quieren guardarlo todo, sin límites.',
      'pricing.feature.3videos':   '3 vídeos máximo',
      'pricing.feature.rx':        'Reacciones ilimitadas por vídeo',
      'pricing.feature.3months':   'Vídeos conservados 3 meses',
      'pricing.feature.storage':   'Almacenamiento ilimitado',
      'pricing.feature.permanent': 'Conservación permanente',
      'pricing.feature.unlimited': 'Vídeos ilimitados',
      'pricing.feature.support':   'Soporte prioritario',
      'pricing.btn.free':          'Empezar gratis',
      'pricing.btn.free.current':  'Tu plan actual',
      'pricing.btn.pro':           'Pasarse al Pro',
      'pricing.btn.pro.manage':    'Gestionar suscripción',
      'pricing.faq.title':         'Preguntas frecuentes',
      'pricing.faq.1.q':           '¿Qué pasa si cancelo mi suscripción Pro?',
      'pricing.faq.1.a':           'Tus vídeos pasan al modo gratuito: serán eliminados 90 días después de la cancelación. Conservas el acceso a todas tus reacciones hasta esa fecha.',
      'pricing.faq.2.q':           '¿Puedo subir más de 3 vídeos con el plan gratuito?',
      'pricing.faq.2.a':           'No, el plan gratuito está limitado a 3 vídeos activos simultáneamente. Elimina un vídeo existente para subir uno nuevo.',
      'pricing.faq.3.q':           '¿Es seguro el pago?',
      'pricing.faq.3.a':           'Sí, el pago está gestionado por Stripe, líder mundial en pagos online. No almacenamos ningún dato de tarjeta bancaria.',
      'pricing.faq.4.q':           '¿Están limitadas las reacciones en el plan gratuito?',
      'pricing.faq.4.a':           'No. El número de reacciones recibidas por vídeo es ilimitado en ambos planes.',
      'pricing.footer':            'Datos tratados según el RGPD · Pagos seguros por Stripe',
    }
  };

  // ── State ─────────────────────────────────────────────────────────────────────
  var THEME_KEY = 'rc-theme';
  var LANG_KEY  = 'rc-lang';

  window.RC_THEME = localStorage.getItem(THEME_KEY) || 'dark';
  window.RC_LANG  = localStorage.getItem(LANG_KEY)  || 'fr';

  window.__ = function (key) {
    return (T[window.RC_LANG] || T.fr)[key] || key;
  };

  window.RC_DATE_LOCALE = { fr: 'fr-FR', en: 'en-US', es: 'es-ES' };

  // ── Theme ─────────────────────────────────────────────────────────────────────
  function applyTheme(theme) {
    window.RC_THEME = theme;
    localStorage.setItem(THEME_KEY, theme);
    document.documentElement.setAttribute('data-theme', theme);
    var btn = document.getElementById('rc-theme-btn');
    if (btn) btn.innerHTML = theme === 'dark' ? SUN_ICON : MOON_ICON;
  }

  // ── Language ──────────────────────────────────────────────────────────────────
  function applyLang(lang) {
    window.RC_LANG = lang;
    localStorage.setItem(LANG_KEY, lang);
    document.querySelectorAll('[data-i18n]').forEach(function (el) {
      var v = window.__(el.getAttribute('data-i18n'));
      if (v) el.textContent = v;
    });
    document.querySelectorAll('[data-i18n-html]').forEach(function (el) {
      var v = window.__(el.getAttribute('data-i18n-html'));
      if (v) el.innerHTML = v;
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(function (el) {
      var v = window.__(el.getAttribute('data-i18n-placeholder'));
      if (v) el.placeholder = v;
    });
    document.querySelectorAll('.rc-lang-btn').forEach(function (btn) {
      btn.classList.toggle('rc-lang-active', btn.dataset.lang === lang);
    });
    var recStyle = document.getElementById('rc-rec-style');
    if (recStyle) {
      recStyle.textContent = ".plan-card.featured::before { content: '" + window.__('pricing.recommended') + "'; }";
    }
    document.dispatchEvent(new CustomEvent('rc-langchange', { detail: { lang: lang } }));
  }

  // ── SVG icons ─────────────────────────────────────────────────────────────────
  var SUN_ICON = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><line x1="12" y1="2" x2="12" y2="5"/><line x1="12" y1="19" x2="12" y2="22"/><line x1="4.22" y1="4.22" x2="6.34" y2="6.34"/><line x1="17.66" y1="17.66" x2="19.78" y2="19.78"/><line x1="2" y1="12" x2="5" y2="12"/><line x1="19" y1="12" x2="22" y2="12"/><line x1="4.22" y1="19.78" x2="6.34" y2="17.66"/><line x1="17.66" y1="6.34" x2="19.78" y2="4.22"/></svg>';
  var MOON_ICON = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';

  // ── Global styles (light theme + widget) ─────────────────────────────────────
  function injectStyles() {
    var style = document.createElement('style');
    style.textContent = [
      /* Light theme overrides */
      '[data-theme="light"] {',
      '  --bg: #f5f1ea; --surface: #ffffff; --surface2: #f0ebe0;',
      '  --border: #ddd5c8; --border2: #ccc4b8;',
      '  --gold: #9a7220; --gold-dim: #b89040;',
      '  --text: #1c1610; --muted: #7a6a5a; --green: #2d6b42; --red: #c0392b;',
      '}',
      '[data-theme="light"] body::before { opacity: 0.10 !important; }',
      '[data-theme="light"] nav, [data-theme="light"] header { background: rgba(245,241,234,0.97) !important; }',
      '[data-theme="light"] .drop-zone { background: #faf7f2 !important; }',
      '[data-theme="light"] .drop-zone:hover, [data-theme="light"] .drop-zone.drag-over { background: #ede7da !important; }',
      '[data-theme="light"] .result-box { background: #f0ebe0 !important; }',
      '[data-theme="light"] .reactions-header { background: #ede7da !important; }',
      '[data-theme="light"] .modal-overlay { background: rgba(0,0,0,0.65) !important; }',
      '[data-theme="light"] .modal-content video { background: #fff !important; }',
      '[data-theme="light"] footer { color: #9a8a7a !important; }',
      '[data-theme="light"] .drop-limit { color: #a09080 !important; }',
      '[data-theme="light"] .step-num { color: #ccc4b8 !important; }',
      '[data-theme="light"] .link-input, [data-theme="light"] .field input { background: #f8f5f0 !important; }',
      '[data-theme="light"] .btn-google { background: #fff !important; }',
      '[data-theme="light"] .card { background: #fff !important; }',
      '[data-theme="light"] .tab.active { background: #f8f5f0 !important; }',
      '[data-theme="light"] .video-card { background: #fff !important; }',
      '[data-theme="light"] .video-header:hover { background: var(--surface2) !important; }',
      '[data-theme="light"] .reaction-row:hover { background: var(--surface2) !important; }',
      '[data-theme="light"] .video-thumb, [data-theme="light"] .reaction-thumb { background: #e8e0d0 !important; }',
      '[data-theme="light"] .plan-bar { background: #fff !important; }',
      /* Controls widget */
      '#rc-controls-mount { display:flex; align-items:center; gap:6px; }',
      '#rc-theme-btn {',
      '  display:flex; align-items:center; justify-content:center;',
      '  width:28px; height:28px; background:none;',
      '  border:1px solid var(--border); border-radius:2px;',
      '  color:var(--muted); cursor:pointer; padding:0;',
      '  transition:color 0.2s, border-color 0.2s;',
      '}',
      '#rc-theme-btn:hover { color:var(--text); border-color:var(--muted); }',
      '.rc-lang-btn {',
      '  background:none; border:1px solid var(--border); border-radius:2px;',
      '  padding:4px 7px; color:var(--muted);',
      '  font-family:"DM Mono",monospace; font-size:9px; letter-spacing:0.12em;',
      '  cursor:pointer; transition:all 0.2s;',
      '}',
      '.rc-lang-btn:hover { color:var(--text); border-color:var(--muted); }',
      '.rc-lang-active { color:var(--gold) !important; border-color:var(--gold-dim) !important; }',
    ].join('\n');
    document.head.appendChild(style);
  }

  // ── Build controls ────────────────────────────────────────────────────────────
  function buildControls() {
    var mount = document.getElementById('rc-controls-mount');
    if (!mount) return;

    var themeBtn = document.createElement('button');
    themeBtn.id = 'rc-theme-btn';
    themeBtn.title = 'Toggle theme';
    themeBtn.innerHTML = window.RC_THEME === 'dark' ? SUN_ICON : MOON_ICON;
    themeBtn.addEventListener('click', function () {
      applyTheme(window.RC_THEME === 'dark' ? 'light' : 'dark');
    });
    mount.appendChild(themeBtn);

    ['fr', 'en', 'es'].forEach(function (l) {
      var btn = document.createElement('button');
      btn.className = 'rc-lang-btn' + (l === window.RC_LANG ? ' rc-lang-active' : '');
      btn.dataset.lang = l;
      btn.textContent = l.toUpperCase();
      btn.addEventListener('click', function () { applyLang(l); });
      mount.appendChild(btn);
    });
  }

  // ── Init ──────────────────────────────────────────────────────────────────────
  injectStyles();
  document.documentElement.setAttribute('data-theme', window.RC_THEME);

  document.addEventListener('DOMContentLoaded', function () {
    if (document.querySelector('.plan-card.featured')) {
      var recStyle = document.createElement('style');
      recStyle.id = 'rc-rec-style';
      recStyle.textContent = ".plan-card.featured::before { content: '" + window.__('pricing.recommended') + "'; }";
      document.head.appendChild(recStyle);
    }
    buildControls();
    applyLang(window.RC_LANG);
  });
})();
