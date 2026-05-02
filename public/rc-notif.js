(function () {
  'use strict';

  var POLL_MS = 30000;
  var pollTimer = null;
  var loaded = null;

  function escHtml(s) {
    if (!s) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
  }

  function fmtNotifDate(iso) {
    var d = new Date(iso);
    var diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 60)     return 'à l’instant';
    if (diff < 3600)   return Math.floor(diff / 60) + ' min';
    if (diff < 86400)  return Math.floor(diff / 3600) + ' h';
    if (diff < 604800) return Math.floor(diff / 86400) + ' j';
    return d.toLocaleDateString('fr-FR');
  }

  function injectStyles() {
    if (document.getElementById('rc-notif-styles')) return;
    var css = ''
      + '.rc-notif-wrap { position: relative; display: inline-flex; align-items: center; }'
      + '.rc-notif-btn { background: none; border: 1px solid var(--border, #1e1e1e); border-radius: 2px; width: 34px; height: 34px; display: inline-flex; align-items: center; justify-content: center; color: var(--muted, #5a5245); cursor: pointer; transition: color 0.2s, border-color 0.2s; position: relative; padding: 0; }'
      + '.rc-notif-btn:hover { color: var(--text, #e8e0d0); border-color: var(--muted, #5a5245); }'
      + '.rc-notif-btn svg { width: 14px; height: 14px; }'
      + '.rc-notif-dot { position: absolute; top: -4px; right: -4px; min-width: 16px; height: 16px; padding: 0 4px; border-radius: 8px; background: var(--gold, #c9a84c); color: #0a0a0a; font-size: 9px; font-weight: 600; display: none; align-items: center; justify-content: center; line-height: 1; border: 2px solid var(--bg, #0a0a0a); font-family: "DM Mono", monospace; }'
      + '.rc-notif-dot.show { display: inline-flex; }'
      + '.rc-notif-panel { display: none; position: absolute; top: calc(100% + 10px); right: 0; width: 340px; max-width: calc(100vw - 32px); max-height: 460px; overflow-y: auto; background: var(--surface, #111); border: 1px solid var(--border, #1e1e1e); border-radius: 3px; box-shadow: 0 12px 40px rgba(0,0,0,0.6); z-index: 1500; font-family: "DM Mono", monospace; }'
      + '.rc-notif-panel.open { display: block; }'
      + '.rc-notif-head { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; border-bottom: 1px solid var(--border, #1e1e1e); font-size: 10px; letter-spacing: 0.18em; text-transform: uppercase; color: var(--muted, #5a5245); }'
      + '.rc-notif-clear { background: none; border: none; padding: 0; color: var(--muted, #5a5245); font-family: inherit; font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase; cursor: pointer; transition: color 0.15s; }'
      + '.rc-notif-clear:hover { color: var(--gold, #c9a84c); }'
      + '.rc-notif-clear[hidden] { display: none; }'
      + '.rc-notif-empty { padding: 36px 20px; text-align: center; font-size: 11px; color: var(--muted, #5a5245); letter-spacing: 0.06em; }'
      + '.rc-notif-item { position: relative; display: flex; align-items: flex-start; gap: 8px; padding: 12px 40px 12px 16px; border-bottom: 1px solid var(--border, #1e1e1e); text-decoration: none; color: var(--text, #e8e0d0); cursor: pointer; transition: background 0.15s; }'
      + '.rc-notif-item:last-child { border-bottom: none; }'
      + '.rc-notif-item:hover { background: var(--surface2, #141414); }'
      + '.rc-notif-item.unread { background: rgba(201,168,76,0.04); }'
      + '.rc-notif-item.unread .rc-notif-body::before { content: ""; display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: var(--gold, #c9a84c); margin-right: 8px; vertical-align: middle; }'
      + '.rc-notif-body { flex: 1; min-width: 0; }'
      + '.rc-notif-text { font-size: 12px; line-height: 1.5; }'
      + '.rc-notif-text strong { color: var(--gold, #c9a84c); font-weight: 400; }'
      + '.rc-notif-date { font-size: 10px; color: var(--muted, #5a5245); letter-spacing: 0.06em; margin-top: 4px; }'
      + '.rc-notif-close { position: absolute; top: 10px; right: 10px; width: 22px; height: 22px; display: inline-flex; align-items: center; justify-content: center; background: none; border: none; padding: 0; color: var(--muted, #5a5245); cursor: pointer; border-radius: 2px; opacity: 0.6; transition: opacity 0.15s, color 0.15s, background 0.15s; }'
      + '.rc-notif-close:hover { opacity: 1; color: var(--text, #e8e0d0); background: rgba(255,255,255,0.05); }'
      + '.rc-notif-close svg { width: 10px; height: 10px; }'
      + '@media (max-width: 600px) { .rc-notif-panel { width: 300px; right: -8px; } }';
    var style = document.createElement('style');
    style.id = 'rc-notif-styles';
    style.textContent = css;
    document.head.appendChild(style);
  }

  function buildWidget() {
    var wrap = document.createElement('div');
    wrap.className = 'rc-notif-wrap';
    wrap.id = 'rcNotifWrap';
    wrap.innerHTML = ''
      + '<button class="rc-notif-btn" id="rcNotifBtn" aria-label="Notifications" type="button">'
      +   '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
      +     '<path d="M3.5 6.5a4.5 4.5 0 0 1 9 0v3l1 2H2.5l1-2v-3z"/>'
      +     '<path d="M6.5 13.5a1.5 1.5 0 0 0 3 0"/>'
      +   '</svg>'
      +   '<span class="rc-notif-dot" id="rcNotifDot">0</span>'
      + '</button>'
      + '<div class="rc-notif-panel" id="rcNotifPanel">'
      +   '<div class="rc-notif-head"><span>Notifications</span><button type="button" class="rc-notif-clear" id="rcNotifClear" hidden>Tout effacer</button></div>'
      +   '<div id="rcNotifList"><div class="rc-notif-empty">Aucune notification</div></div>'
      + '</div>';
    return wrap;
  }

  function mount(widget) {
    // 1) dedicated slot at the right end (built by rc-nav.js)
    var slot = document.getElementById('rc-notif-mount');
    if (slot) {
      slot.appendChild(widget);
      slot.style.display = 'inline-flex';
      return true;
    }
    // 2) inside .nav-right / .header-right — append at the end (rightmost)
    var navRight = document.querySelector('.nav-right, .header-right');
    if (navRight) {
      navRight.appendChild(widget);
      return true;
    }
    // 3) right after #rc-controls-mount wherever it lives
    var ctlGlobal = document.getElementById('rc-controls-mount');
    if (ctlGlobal && ctlGlobal.parentElement) {
      ctlGlobal.parentElement.insertBefore(widget, ctlGlobal.nextSibling);
      return true;
    }
    return false;
  }

  function renderBadge(unread) {
    var dot = document.getElementById('rcNotifDot');
    if (!dot) return;
    if (unread > 0) {
      dot.textContent = unread > 99 ? '99+' : String(unread);
      dot.classList.add('show');
    } else {
      dot.classList.remove('show');
    }
  }

  function renderList(items) {
    var list = document.getElementById('rcNotifList');
    var clearBtn = document.getElementById('rcNotifClear');
    if (!list) return;
    if (!items || items.length === 0) {
      list.innerHTML = '<div class="rc-notif-empty">Aucune notification</div>';
      if (clearBtn) clearBtn.hidden = true;
      return;
    }
    if (clearBtn) clearBtn.hidden = false;
    list.innerHTML = items.map(function (n) {
      var title = n.videoTitle ? escHtml(String(n.videoTitle).slice(0, 50)) : 'ta vidéo';
      var viewer = escHtml(n.viewerName || 'Anonyme');
      return '<div class="rc-notif-item ' + (n.read ? '' : 'unread') + '" data-vid="' + (n.videoId || '') + '" data-id="' + (n.id || '') + '">'
        + '<div class="rc-notif-body">'
        +   '<div class="rc-notif-text"><strong>' + viewer + '</strong> a réagi à <em>' + title + '</em></div>'
        +   '<div class="rc-notif-date">' + fmtNotifDate(n.createdAt) + '</div>'
        + '</div>'
        + '<button type="button" class="rc-notif-close" aria-label="Supprimer la notification">'
        +   '<svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M1.5 1.5l7 7M8.5 1.5l-7 7"/></svg>'
        + '</button>'
        + '</div>';
    }).join('');
    list.querySelectorAll('.rc-notif-close').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        var item = btn.closest('.rc-notif-item');
        if (!item) return;
        var id = item.dataset.id;
        deleteOne(id, item);
      });
    });
    list.querySelectorAll('.rc-notif-item').forEach(function (el) {
      el.addEventListener('click', function (e) {
        if (e.target.closest('.rc-notif-close')) return;
        e.preventDefault();
        var vid = el.dataset.vid;
        closePanel();
        // If on dashboard, open the matching card; otherwise navigate to /dashboard
        var card = vid ? document.querySelector('.video-card[data-id="' + vid + '"]') : null;
        if (card) {
          if (!card.classList.contains('open')) {
            var hdr = card.querySelector('.video-header');
            if (hdr) hdr.click();
          }
          card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        } else {
          window.location.href = '/dashboard' + (vid ? '#card-' + vid : '');
        }
      });
    });
  }

  function deleteOne(id, el) {
    if (!id) return;
    if (el) el.style.opacity = '0.4';
    fetch('/api/notifications/' + encodeURIComponent(id), {
      method: 'DELETE',
      credentials: 'same-origin'
    }).then(function (r) {
      if (!r.ok) throw new Error();
      var wasUnread = el && el.classList.contains('unread');
      if (el) el.remove();
      var list = document.getElementById('rcNotifList');
      if (list && !list.querySelector('.rc-notif-item')) {
        list.innerHTML = '<div class="rc-notif-empty">Aucune notification</div>';
        var clearBtn = document.getElementById('rcNotifClear');
        if (clearBtn) clearBtn.hidden = true;
      }
      if (wasUnread) {
        var dot = document.getElementById('rcNotifDot');
        var n = dot ? parseInt(dot.textContent, 10) : 0;
        renderBadge(isNaN(n) ? 0 : Math.max(0, n - 1));
      }
    }).catch(function () {
      if (el) el.style.opacity = '';
    });
  }

  function deleteAll() {
    fetch('/api/notifications', { method: 'DELETE', credentials: 'same-origin' })
      .then(function (r) {
        if (!r.ok) throw new Error();
        renderList([]);
        renderBadge(0);
      })
      .catch(function () {});
  }

  function closePanel() {
    var p = document.getElementById('rcNotifPanel');
    if (p) p.classList.remove('open');
  }

  function fetchAll() {
    return fetch('/api/notifications', { credentials: 'same-origin' })
      .then(function (r) { if (!r.ok) throw new Error(); return r.json(); })
      .then(function (data) {
        renderBadge(data.unread || 0);
        renderList(data.items || []);
      })
      .catch(function () { /* silent */ });
  }

  function markRead() {
    fetch('/api/notifications/read', { method: 'POST', credentials: 'same-origin' }).catch(function () {});
    renderBadge(0);
    document.querySelectorAll('.rc-notif-item.unread').forEach(function (el) { el.classList.remove('unread'); });
  }

  function wire() {
    var btn = document.getElementById('rcNotifBtn');
    var panel = document.getElementById('rcNotifPanel');
    var dot = document.getElementById('rcNotifDot');
    var clearBtn = document.getElementById('rcNotifClear');
    if (!btn || !panel) return;

    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      var opening = !panel.classList.contains('open');
      panel.classList.toggle('open');
      if (opening) {
        fetchAll().then(function () {
          if (dot && dot.classList.contains('show')) markRead();
        });
      }
    });
    if (clearBtn) {
      clearBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        deleteAll();
      });
    }
    document.addEventListener('click', function (e) {
      if (!panel.contains(e.target) && e.target !== btn && !btn.contains(e.target)) closePanel();
    });
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) fetchAll();
    });
  }

  function init() {
    if (loaded) return;
    loaded = fetch('/api/auth/me', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (me) {
        if (!me) return; // pas connecté → pas de bell
        injectStyles();
        var widget = buildWidget();
        if (!mount(widget)) return; // pas de slot → on n'injecte rien
        wire();
        fetchAll();
        pollTimer = setInterval(fetchAll, POLL_MS);
      })
      .catch(function () {});
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
