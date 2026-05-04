(function () {
  'use strict';

  function injectStyles() {
    if (document.getElementById('rc-nav-styles')) return;
    var css = ''
      + '.nav-right, .header-right { display: flex !important; align-items: center; gap: 10px; flex-wrap: nowrap; position: relative; }'
      + '.rc-nav-dashboard { display: none; padding: 8px 16px; background: none; border: 1px solid var(--gold-dim, #7a6330); border-radius: 2px; color: var(--gold, #c9a84c); font-family: "DM Mono", monospace; font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; text-decoration: none; transition: background 0.2s; white-space: nowrap; }'
      + '.rc-nav-dashboard:hover { background: rgba(201,168,76,0.08); }'
      + '.rc-nav-login { display: none; align-items: center; padding: 8px 16px; background: var(--gold, #c9a84c); color: #0a0a0a; border-radius: 2px; font-family: "DM Mono", monospace; font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; text-decoration: none; transition: background 0.2s; white-space: nowrap; }'
      + '.rc-nav-login:hover { background: #e0bb60; }'
      + '#rc-notif-mount { display: inline-flex; align-items: center; }'
      + '@media (max-width: 600px) {'
      + '  .rc-nav-dashboard, .rc-nav-login { padding: 6px 12px; font-size: 10px; letter-spacing: 0.1em; }'
      + '  .nav-right, .header-right { gap: 8px; }'
      + '}';
    var st = document.createElement('style');
    st.id = 'rc-nav-styles';
    st.textContent = css;
    document.head.appendChild(st);
  }

  function buildSkeleton() {
    return ''
      + '<div id="rc-controls-mount"></div>'
      + '<a class="rc-nav-dashboard" href="/dashboard" id="rcNavDashboard">…</a>'
      + '<a class="rc-nav-login" href="/login" id="rcNavLogin">…</a>'
      + '<div id="rc-notif-mount"></div>';
  }

  function ensureContainer() {
    var target = document.querySelector('.nav-right, .header-right');
    if (target) return target;
    var host = document.querySelector('nav, header, .header');
    if (!host) return null;
    var div = document.createElement('div');
    div.className = 'nav-right';
    host.appendChild(div);
    return div;
  }

  function tr(key, fallback) {
    return (window.__ ? window.__(key) : null) || fallback;
  }

  function applyAuthState(target, me) {
    var dashBtn   = target.querySelector('#rcNavDashboard');
    var loginBtn  = target.querySelector('#rcNavLogin');
    var notifSlot = target.querySelector('#rc-notif-mount');
    var path      = window.location.pathname;
    var onLoginPg = path === '/login' || path === '/register';
    var onDash    = path === '/dashboard';
    var onAccount = path === '/account';
    var onPricing = path === '/pricing';

    dashBtn.textContent  = tr('nav.dashboard', 'Mon espace');
    loginBtn.textContent = tr('nav.login', 'Connexion');

    if (!window.RC || !window.RC.clearMobileLinks) {
      document.addEventListener('rc-mobile-ready', function () {
        applyAuthState(target, me);
      }, { once: true });
      return;
    }
    window.RC.clearMobileLinks();

    if (me) {
      dashBtn.style.display  = onDash ? 'none' : 'inline-flex';
      loginBtn.style.display = 'none';
      if (notifSlot) notifSlot.style.display = '';

      if (!onPricing) {
        window.RC.addMobileLink(window.RC.makeMobileLink(
          tr('nav.pricing', 'Tarifs'), '/pricing', false, 'nav.pricing'
        ));
      }
      if (!onAccount) {
        var label = tr('nav.account', 'Mon compte');
        if (me.name) label += ' · ' + me.name;
        window.RC.addMobileLink(window.RC.makeMobileLink(label, '/account', false));
      }
      if (me.plan === 'admin') {
        window.RC.addMobileLink(window.RC.makeMobileLink('Admin', '/admin', true));
      }
      var logout = window.RC.makeMobileBtn(tr('nav.logout', 'Déconnexion'), false);
      logout.addEventListener('click', function () {
        logout.disabled = true;
        try { sessionStorage.setItem('rc-flash', 'logout'); } catch (e) {}
        fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' })
          .finally(function () { window.location.href = '/login'; });
      });
      window.RC.addMobileLink(logout);
    } else {
      dashBtn.style.display  = 'none';
      loginBtn.style.display = onLoginPg ? 'none' : 'inline-flex';
      if (notifSlot) notifSlot.style.display = 'none';

      if (!onPricing) {
        window.RC.addMobileLink(window.RC.makeMobileLink(
          tr('nav.pricing', 'Tarifs'), '/pricing', false, 'nav.pricing'
        ));
      }
      if (!onLoginPg) {
        window.RC.addMobileLink(window.RC.makeMobileLink(
          tr('nav.login', 'Connexion'), '/login', false, 'nav.login'
        ));
        window.RC.addMobileLink(window.RC.makeMobileLink(
          tr('nav.register', 'Créer un compte'), '/register', true, 'nav.register'
        ));
      }
    }
  }

  injectStyles();
  var target = ensureContainer();
  if (!target) return;
  target.innerHTML = buildSkeleton();

  if (!window.__RC_AUTH_PROMISE) {
    window.__RC_AUTH_PROMISE = fetch('/api/auth/me', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; });
  }

  window.__RC_AUTH_PROMISE.then(function (me) {
    applyAuthState(target, me);
  });
})();
