// Theme: apply accent + mode to <html>, and the Appearance UI (switcher button + picker) used by the
// sidebar and the Settings dialog.

import { ACCENTS, DEFAULT_THEME, MODES } from '../app/constants.js';
import { h } from '../lib/dom.js';
import { uid } from '../lib/utils.js';
import { icon } from './icons.js';
import { openPopover } from './popover.js';

const ACCENT_IDS = new Set(ACCENTS.map((a) => a.id));
const MODE_META = {
  dark: { label: 'Dark', icon: 'moon' },
  light: { label: 'Light', icon: 'sun' },
};

const PICKER_TAG = 'th-picker';
// Registry symbol (not a module-local WeakMap) so the custom element class keeps working when this
// module is re-evaluated by HMR — the element class can only be defined once per page.
const BINDING = Symbol.for('iptvp.themePicker.binding');

/** Normalize a possibly partial / invalid theme to `{ accent, mode }`. */
function normalizeTheme(theme) {
  const accent = theme && ACCENT_IDS.has(theme.accent) ? theme.accent : DEFAULT_THEME.accent;
  const mode = theme && MODES.includes(theme.mode) ? theme.mode : DEFAULT_THEME.mode;
  return { accent, mode };
}

/**
 * Apply a theme to the document: `data-accent` / `data-mode` on <html>, and `<meta name="theme-color">`
 * set to the resulting computed `--bg` (browser UI / PWA title bar color).
 * @param {{ accent?: string, mode?: string }} theme
 * @returns {{ accent: string, mode: string }} the theme actually applied
 */
export function applyTheme(theme) {
  const { accent, mode } = normalizeTheme(theme);
  const root = document.documentElement;
  if (root.getAttribute('data-accent') !== accent) root.setAttribute('data-accent', accent);
  if (root.getAttribute('data-mode') !== mode) root.setAttribute('data-mode', mode);
  syncThemeColor(true);
  return { accent, mode };
}

function syncThemeColor(retry) {
  let bg = '';
  try {
    bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  } catch {
    bg = '';
  }
  if (!bg) {
    // Stylesheet not applied yet (very early call): try once more on the next frame.
    if (retry && typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => syncThemeColor(false));
    }
    return;
  }
  let metas = document.querySelectorAll('meta[name="theme-color"]');
  if (!metas.length) {
    const meta = document.createElement('meta');
    meta.setAttribute('name', 'theme-color');
    document.head.append(meta);
    metas = [meta];
  }
  for (const meta of metas) if (meta.getAttribute('content') !== bg) meta.setAttribute('content', bg);
}

/** Readable check-mark ink for a swatch (the swatch colors are fixed previews, independent of the theme). */
function inkFor(accent) {
  const lum = (hex) => {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
    if (!m) return 0;
    const n = parseInt(m[1], 16);
    const channel = (v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
  };
  const l = accent.swatch2 ? (lum(accent.swatch) + lum(accent.swatch2)) / 2 : lum(accent.swatch);
  return l > 0.42 ? 'rgba(0, 0, 0, 0.78)' : '#fff';
}

function defineElement() {
  if (typeof customElements === 'undefined' || typeof HTMLElement === 'undefined') return false;
  if (!customElements.get(PICKER_TAG)) {
    customElements.define(
      PICKER_TAG,
      class ThemePickerElement extends HTMLElement {
        connectedCallback() {
          this[BINDING]?.connect();
        }
        disconnectedCallback() {
          this[BINDING]?.disconnect();
        }
      },
    );
  }
  return true;
}

/**
 * Radio-group keyboard behaviour: arrows move focus *and* selection (wrapping), Home/End jump.
 * Handled keys don't propagate, so global shortcuts (arrows = volume/seek) don't fire as well.
 */
function handleRadioKeys(e, buttons, pick) {
  const index = buttons.indexOf(document.activeElement);
  if (index === -1) return;
  const n = buttons.length;
  let next;
  switch (e.key) {
    case 'ArrowRight':
    case 'ArrowDown':
      next = (index + 1) % n;
      break;
    case 'ArrowLeft':
    case 'ArrowUp':
      next = (index - 1 + n) % n;
      break;
    case 'Home':
      next = 0;
      break;
    case 'End':
      next = n - 1;
      break;
    default:
      return;
  }
  e.preventDefault();
  e.stopPropagation();
  buttons[next].focus();
  pick(next);
}

/**
 * Accent swatches (radio group) + dark/light toggle. Stays in sync with `store.theme` while it is in the
 * document and unsubscribes automatically when removed (custom element lifecycle), so it is leak-free
 * wherever it is mounted (popover, settings dialog…).
 * @param {{ store: ReturnType<import('../app/store.js').createStore>, actions: object }} deps
 * @returns {HTMLElement}
 */
export function createThemePicker({ store, actions }) {
  const usesCustomElement = defineElement();
  const el = document.createElement(usesCustomElement ? PICKER_TAG : 'div');
  el.className = 'th-picker';

  const accentLabelId = uid('th-accent');
  const modeLabelId = uid('th-mode');
  let current = normalizeTheme(store.get().theme);

  const chooseAccent = (id) => {
    if (id !== current.accent) actions.setAccent(id);
  };
  const chooseMode = (mode) => {
    if (mode !== current.mode) actions.setMode(mode);
  };

  const swatches = ACCENTS.map((accent) =>
    h(
      'button',
      {
        type: 'button',
        class: 'th-swatch',
        role: 'radio',
        'aria-checked': 'false',
        tabIndex: -1,
        dataset: { accent: accent.id },
        style: {
          '--th-sw': accent.swatch,
          '--th-sw2': accent.swatch2 || accent.swatch,
          '--th-ink': inkFor(accent),
        },
        onClick: () => chooseAccent(accent.id),
      },
      h(
        'span',
        { class: 'th-dot', 'aria-hidden': 'true' },
        icon('check', { size: 14, strokeWidth: 3, class: 'th-check' }),
      ),
      h('span', { class: 'th-name', text: accent.name }),
    ),
  );

  const modes = MODES.map((mode) =>
    h(
      'button',
      {
        type: 'button',
        class: 'th-mode',
        role: 'radio',
        'aria-checked': 'false',
        tabIndex: -1,
        dataset: { mode },
        onClick: () => chooseMode(mode),
      },
      icon(MODE_META[mode]?.icon || 'palette', { size: 15 }),
      h('span', { text: MODE_META[mode]?.label || mode }),
    ),
  );

  el.append(
    h(
      'div',
      { class: 'th-group' },
      h('div', { class: 'th-label', id: modeLabelId, text: 'Mode' }),
      h(
        'div',
        {
          class: 'segmented th-modes',
          role: 'radiogroup',
          'aria-labelledby': modeLabelId,
          onKeydown: (e) => handleRadioKeys(e, modes, (i) => chooseMode(MODES[i])),
        },
        modes,
      ),
    ),
    h(
      'div',
      { class: 'th-group' },
      h('div', { class: 'th-label', id: accentLabelId, text: 'Accent' }),
      h(
        'div',
        {
          class: 'th-swatches',
          role: 'radiogroup',
          'aria-labelledby': accentLabelId,
          onKeydown: (e) => handleRadioKeys(e, swatches, (i) => chooseAccent(ACCENTS[i].id)),
        },
        swatches,
      ),
    ),
  );

  function syncGroup(buttons, key, value) {
    let any = false;
    for (const btn of buttons) {
      const on = btn.dataset[key] === value;
      any ||= on;
      btn.setAttribute('aria-checked', String(on));
      btn.tabIndex = on ? 0 : -1;
    }
    if (!any && buttons[0]) buttons[0].tabIndex = 0; // keep the group reachable with Tab
  }

  function sync(theme) {
    current = normalizeTheme(theme);
    syncGroup(swatches, 'accent', current.accent);
    syncGroup(modes, 'mode', current.mode);
  }

  sync(store.get().theme);

  let unsubscribe = null;
  const connect = () => {
    if (unsubscribe) return;
    sync(store.get().theme); // may have changed while detached
    unsubscribe = store.select((s) => s.theme, (theme) => sync(theme));
  };
  const disconnect = () => {
    unsubscribe?.();
    unsubscribe = null;
  };

  if (usesCustomElement) {
    el[BINDING] = { connect, disconnect };
    if (el.isConnected) connect();
  } else {
    // No custom elements: subscribe now and drop the subscription on the first change after removal.
    let seenConnected = false;
    unsubscribe = store.select(
      (s) => s.theme,
      (theme) => {
        if (el.isConnected) seenConnected = true;
        else if (seenConnected) return disconnect();
        sync(theme);
      },
    );
  }

  return el;
}

/**
 * Icon button (palette) that opens the "Appearance" popover with a theme picker.
 * @param {{ store: object, actions: object }} deps
 * @returns {HTMLButtonElement}
 */
export function createThemeSwitcher({ store, actions }) {
  const button = h(
    'button',
    {
      type: 'button',
      class: 'icon-btn th-switcher',
      'aria-label': 'Theme',
      title: 'Appearance',
      'aria-haspopup': 'dialog',
      'aria-expanded': 'false',
      onClick: () => {
        // The popover itself is the labelled dialog ("Appearance"); the heading is the visible title.
        const panel = h(
          'div',
          { class: 'th-panel' },
          h('div', { class: 'th-panel-title', 'aria-hidden': 'true', text: 'Appearance' }),
          createThemePicker({ store, actions }),
        );
        openPopover({
          anchor: button,
          content: panel,
          placement: 'top-start',
          className: 'th-popover',
          label: 'Appearance',
        });
      },
    },
    icon('palette'),
  );
  return button;
}
