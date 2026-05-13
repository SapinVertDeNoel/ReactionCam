(function () {
  'use strict';

  function readToken() {
    var m = document.cookie.match(/(?:^|;\s*)rc-csrf=([A-Za-z0-9_-]+)/);
    return m ? m[1] : null;
  }

  var SAFE_METHODS = { GET: 1, HEAD: 1, OPTIONS: 1 };
  var origFetch = window.fetch.bind(window);

  window.fetch = function (input, init) {
    init = init || {};
    var method = (init.method || (typeof input !== 'string' && input && input.method) || 'GET').toUpperCase();
    if (!SAFE_METHODS[method]) {
      // Same-origin only : on n'ajoute le token que pour des URLs de notre site.
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      var sameOrigin = url.indexOf('http') !== 0 || url.indexOf(location.origin) === 0;
      if (sameOrigin) {
        var tok = readToken();
        if (tok) {
          var headers = new Headers(init.headers || (typeof input !== 'string' && input && input.headers) || {});
          if (!headers.has('X-CSRF-Token')) headers.set('X-CSRF-Token', tok);
          init.headers = headers;
        }
      }
    }
    return origFetch(input, init);
  };
})();
