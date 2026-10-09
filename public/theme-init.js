// Applies the saved theme before first paint to avoid a flash of the default theme.
// Must stay in sync with KEYS.theme / ACCENTS in src/app/constants.js.
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
})();
