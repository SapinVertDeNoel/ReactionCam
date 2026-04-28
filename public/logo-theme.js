(function () {
  var LOGO_DARK = '/logo-dark.svg';
  var LOGO_LIGHT = '/logo.svg';
  var TITRE_DARK = '/titre.svg';
  var TITRE_LIGHT = '/titre-light.svg';

  function endsWith(str, suffix) {
    return str.slice(-suffix.length) === suffix;
  }

  function applyTheme() {
    var light = document.documentElement.getAttribute('data-theme') === 'light';
    document.querySelectorAll('img').forEach(function (img) {
      var src = img.getAttribute('src') || '';
      if (endsWith(src, '/logo.svg') || endsWith(src, '/logo-dark.svg')) {
        img.setAttribute('src', light ? LOGO_LIGHT : LOGO_DARK);
      }
      if (endsWith(src, '/titre.svg') || endsWith(src, '/titre-light.svg')) {
        img.setAttribute('src', light ? TITRE_LIGHT : TITRE_DARK);
      }
    });
  }

  applyTheme();

  var observer = new MutationObserver(function (mutations) {
    mutations.forEach(function (m) {
      if (m.attributeName === 'data-theme') applyTheme();
    });
  });
  observer.observe(document.documentElement, { attributes: true });
})();
