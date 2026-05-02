(function () {
  'use strict';

  // ── Helpers ─────────────────────────────────────────────────────────────────
  function escHtml(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;' })[c];
    });
  }

  function injectStyles() {
    if (document.getElementById('rc-nav-styles')) return;
    var css = ''
      // Container
      + '.nav-right, .header-right { display: flex !important; align-items: center; gap: 12px; flex-wrap: nowrap; }'
      // Theme/lang slot
      + '#rc-controls-mount { display: inline-flex; align-items: center; gap: 6px; }'
      // Public link (Tarifs)
      + '.rc-nav-link { font-size: 11px; letter-spacing: 0.12em; color: var(--muted, #5a5245); text-decoration: none; text-transform: uppercase; transition: color 0.2s; white-space: nowrap; }'
      + '.rc-nav-link:hover { color: var(--text, #e8e0d0); }'
      + '.rc-nav-link.active { color: var(--gold, #c9a84c); }'
      // User name
      + '.rc-nav-user { font-size: 12px; color: var(--muted, #5a5245); letter-spacing: 0.06em; text-decoration: none; cursor: pointer; max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }'
      + '.rc-nav-user:hover { color: var(--text, #e8e0d0); }'
      // Plan badge
      + '.rc-nav-plan { display: inline-block; padding: 3px 8px; border-radius: 2px; font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase; line-height: 1.4; font-family: "DM Mono", monospace; }'
      + '.rc-nav-plan.free { border: 1px solid var(--border, #1e1e1e); color: var(--muted, #5a5245); }'
      + '.rc-nav-plan.pro, .rc-nav-plan.admin { border: 1px solid var(--gold-dim, #7a6330); color: var(--gold, #c9a84c); background: rgba(201,168,76,0.06); }'
      // Admin pill
      + '.rc-nav-admin { background: none; border: 1px solid var(--gold-dim, #7a6330); border-radius: 2px; padding: 3px 8px; color: var(--gold, #c9a84c); font-family: "DM Mono", monospace; font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase; text-decoration: none; transition: background 0.2s; }'
      + '.rc-nav-admin:hover { background: rgba(201,168,76,0.08); }'
      // Logout
      + '.rc-nav-logout { background: none; border: 1px solid var(--border, #1e1e1e); border-radius: 2px; padding: 8px 16px; color: var(--muted, #5a5245); font-family: "DM Mono", monospace; font-size: 11px; letter-spacing: 0.1em; cursor: pointer; transition: color 0.2s, border-color 0.2s; white-space: nowrap; }'
      + '.rc-nav-logout:hover { color: var(--text, #e8e0d0); border-color: var(--muted, #5a5245); }'
      // Login (golden CTA)
      + '.rc-nav-login { display: inline-flex; align-items: center; padding: 8px 16px; background: var(--gold, #c9a84c); color: #0a0a0a; border-radius: 2px; font-family: "DM Mono", monospace; font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; text-decoration: none; transition: background 0.2s; white-space: nowrap; }'
      + '.rc-nav-login:hover { background: #e0bb60; }'
      // Notif slot — always present in DOM, the bell is injected by rc-notif.js
      + '#rc-notif-mount { display: inline-flex; align-items: center; }'
      // Mobile: collapse text-heavy items but keep theme/lang, login OR notif
      + '@media (max-width: 600px) {'
      + '  .rc-nav-user, .rc-nav-plan, .rc-nav-logout, .rc-nav-link, .rc-nav-admin { display: none !important; }'
      + '  .nav-right, .header-right { gap: 8px; }'
      + '}';
    var st = document.createElement('style');
    st.id = 'rc-nav-styles';
    st.textContent = css;
    document.head.appendChild(st);
  }

  function buildSkeleton(currentPath) {
    var pricingActive = currentPath === '/pricing' ? ' active' : '';
    var pricingHidden = currentPath === '/pricing' ? 'style="display:none;"' : '';
    return ''
      + '<a class="rc-nav-link' + pricingActive + '" href="/pricing" id="rcNavPricing" ' + pricingHidden + '>Tarifs</a>'
      + '<div id="rc-controls-mount"></div>'
      + '<span class="rc-nav-plan free" id="planBadge" style="display:none;">…</span>'
      + '<a class="rc-nav-user" href="/account" id="userName" style="display:none;">…</a>'
      + '<button class="rc-nav-logout" id="btnLogout" type="button" style="display:none;">Déconnexion</button>'
      + '<a class="rc-nav-login" href="/login" id="btnLogin" style="display:none;">Connexion</a>'
      + '<div id="rc-notif-mount"></div>';
  }

  function ensureContainer() {
    // Prefer existing .nav-right or .header-right
    var target = document.querySelector('.nav-right, .header-right');
    if (target) return target;

    // Create one inside <nav> or <header>
    var host = document.querySelector('nav, header, .header');
    if (!host) return null;
    var div = document.createElement('div');
    div.className = 'nav-right';
    host.appendChild(div);
    return div;
  }

  function applyAuthState(target, me) {
    var planBadge = target.querySelector('#planBadge');
    var userName  = target.querySelector('#userName');
    var btnLogout = target.querySelector('#btnLogout');
    var btnLogin  = target.querySelector('#btnLogin');
    var notifSlot = target.querySelector('#rc-notif-mount');
    var path      = window.location.pathname;
    var onLoginPg = path === '/login' || path === '/register';

    if (me) {
      // Plan badge or admin link
      if (me.plan === 'admin') {
        var adminLink = document.createElement('a');
        adminLink.href = '/admin';
        adminLink.className = 'rc-nav-admin';
        adminLink.id = 'planBadge';
        adminLink.textContent = 'Admin';
        planBadge.replaceWith(adminLink);
      } else {
        planBadge.textContent = me.planLabel || (me.plan ? me.plan.charAt(0).toUpperCase() + me.plan.slice(1) : 'Free');
        planBadge.className = 'rc-nav-plan ' + (me.plan || 'free');
        planBadge.style.display = '';
      }

      userName.textContent = me.name || '';
      userName.style.display = '';

      btnLogout.style.display = '';
      btnLogout.addEventListener('click', function () {
        fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' })
          .finally(function () { window.location.href = '/login'; });
      });

      btnLogin.style.display = 'none';
      // Notif slot stays visible — rc-notif.js will populate it
    } else {
      planBadge.style.display = 'none';
      userName.style.display = 'none';
      btnLogout.style.display = 'none';
      btnLogin.style.display = onLoginPg ? 'none' : '';
      // Hide notif slot when logged out (no bell to show)
      if (notifSlot) notifSlot.style.display = 'none';
    }
  }

  // ── Run synchronously (defer ensures DOM is parsed) ─────────────────────────
  injectStyles();
  var target = ensureContainer();
  if (!target) return;
  target.innerHTML = buildSkeleton(window.location.pathname);

  // Cache a single auth fetch for other modules (rc-notif.js)
  if (!window.__RC_AUTH_PROMISE) {
    window.__RC_AUTH_PROMISE = fetch('/api/auth/me', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; });
  }

  window.__RC_AUTH_PROMISE.then(function (me) {
    applyAuthState(target, me);
  });
})();
