// Applies the saved theme before first paint to avoid a flash of the default theme.
// Must stay in sync with KEYS.theme / ACCENTS in src/app/constants.js and the --bg values in
// src/styles/tokens.css (theme.js re-syncs the theme-color meta from the computed --bg later).
(function () {
  var accents = ['azure', 'emerald', 'cyberpunk', 'amber', 'slate', 'rose', 'violet'];
  var root = document.documentElement;
  var accent = 'azure';
  var mode = 'dark';
  try {
    var saved = JSON.parse(localStorage.getItem('iptvp.v1.theme') || 'null');
    if (saved && accents.indexOf(saved.accent) !== -1) accent = saved.accent;
    if (saved && (saved.mode === 'light' || saved.mode === 'dark')) mode = saved.mode;
  } catch (e) {
    /* storage unavailable — keep defaults */
  }
  root.setAttribute('data-accent', accent);
  root.setAttribute('data-mode', mode);
  // Browser UI / PWA title bar colour, so it matches the page before the stylesheet has loaded.
  var neon = accent === 'cyberpunk';
  var bg = mode === 'light' ? (neon ? '#ece6f4' : '#e8ecf4') : neon ? '#07040d' : '#06070c';
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', bg);
})();
