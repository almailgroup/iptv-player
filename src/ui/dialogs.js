// App dialogs: Add playlist, Playlist manager, Settings, the stream-relay setup guide and Keyboard shortcuts.
// Everything is built with h() (text nodes only) — playlist names, URLs and file names are untrusted.

import { BUILTIN_RELAY_URL, DEFAULT_SETTINGS, SUGGESTED_PLAYLISTS } from '../app/constants.js';
import { effectiveRelay, hasBuiltinRelay } from '../app/relay.js';
import { SHORTCUTS } from '../app/shortcuts-list.js';
import { h, replaceChildren } from '../lib/dom.js';
import { estimateUsage } from '../lib/storage.js';
import {
  clamp,
  copyText,
  debounce,
  downloadText,
  formatBytes,
  formatCount,
  tryParseUrl,
  uid,
} from '../lib/utils.js';
import { icon, setIcon } from './icons.js';
import { confirmDialog, openModal, promptDialog } from './modal.js';
import { createThemePicker } from './theme.js';
import { toast } from './toast.js';

const FILE_ACCEPT = '.m3u,.m3u8,.txt,audio/x-mpegurl,application/x-mpegurl,application/vnd.apple.mpegurl';
const FILE_EXTENSIONS = ['m3u', 'm3u8', 'txt'];
const FILE_TYPES = ['audio/x-mpegurl', 'application/x-mpegurl', 'application/vnd.apple.mpegurl', 'text/plain'];
const NOT_A_PLAYLIST = 'This doesn’t look like a playlist. Choose an .m3u, .m3u8 or .txt file.';
const NAME_MAX = 80;

const REFRESH_CHOICES = [
  { hours: 0, label: 'Never' },
  { hours: 6, label: 'Every 6 hours' },
  { hours: 12, label: 'Every 12 hours' },
  { hours: 24, label: 'Every 24 hours' },
  { hours: 72, label: 'Every 3 days' },
  { hours: 168, label: 'Every 7 days' },
];

const SOURCE_LABEL = { url: 'URL', file: 'File', demo: 'Demo' };
const SOURCE_ICON = { url: 'link', file: 'file', demo: 'tv' };

/** One instance per dialog kind: re-opening focuses / updates the open one instead of stacking copies. */
const openDialogs = new Map();

// ---------------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------------

const messageOf = (err, fallback = 'Something went wrong. Please try again.') =>
  (err && typeof err.message === 'string' && err.message.trim()) || fallback;

/** Superseded / cancelled loads are not user-facing errors. */
const isAbortError = (err) => err?.name === 'AbortError' || err?.code === 'ABORTED';

const plural = (n, one, many = `${one}s`) => `${formatCount(n)} ${n === 1 ? one : many}`;

const stripExtension = (name) =>
  String(name || '')
    .replace(/\.(m3u8?|txt)$/i, '')
    .trim();

const isCoarsePointer = () => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

const spinner = () => h('span', { class: 'spinner spinner-sm', 'aria-hidden': 'true' });

const hasFiles = (e) => {
  const types = e.dataTransfer?.types;
  return !!types && Array.from(types).includes('Files');
};

/** Same acceptance rules as playlist-loader's readPlaylistFile, for instant feedback. */
function isPlaylistFile(file) {
  const name = String(file?.name || '');
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  const type = String(file?.type || '').toLowerCase();
  return FILE_EXTENSIONS.includes(ext) || !type || FILE_TYPES.includes(type);
}

const SHORT_DATE = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const LONG_DATE = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

/** "just now", "5 min ago", "2 h ago", "yesterday", "3 days ago", then a short date. */
function relativeTime(ts, now = Date.now()) {
  if (!Number.isFinite(ts) || ts <= 0) return '';
  const diff = now - ts;
  if (diff < 45_000) return 'just now'; // includes small clock skew into the future
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  const date = new Date(ts);
  return (date.getFullYear() === new Date(now).getFullYear() ? SHORT_DATE : LONG_DATE).format(date);
}

function usageBytes() {
  try {
    const usage = estimateUsage();
    return Number.isFinite(usage?.bytes) ? usage.bytes : null;
  } catch {
    return null;
  }
}

/** Label ("Name · optional") + control + optional error slot. */
function field({ id, label, control, error, optional = false }) {
  return h(
    'div',
    { class: 'field' },
    h(
      'label',
      { class: 'field-label', htmlFor: id },
      label,
      optional ? h('span', { class: 'dlg-optional', text: ' · optional' }) : null,
    ),
    control,
    error || null,
  );
}

/** Input with a leading icon (e.g. the link glyph in URL fields). */
const withIcon = (name, input) => h('div', { class: 'input-group' }, icon(name, { size: 18 }), input);

/**
 * Chip text for a suggested playlist: drops the shared "iptv-org · " prefix (the note under the chips names
 * the source) and turns a trailing "(large)" into a small tag.
 */
function suggestionLabel(name) {
  const short = String(name || '').replace(/^iptv-org\s*·\s*/i, '');
  const match = /^(.*\S)\s*\(([^)]+)\)$/.exec(short);
  return match ? { text: match[1], tag: match[2] } : { text: short, tag: '' };
}

const errorSlot = (id) => h('p', { class: 'field-error dlg-error', id, 'aria-live': 'polite' });

function setFieldError(slot, control, message) {
  slot.textContent = message || '';
  if (control) control.setAttribute('aria-invalid', String(!!message));
}

// ---------------------------------------------------------------------------------------------------
// Add playlist
// ---------------------------------------------------------------------------------------------------

/**
 * Add a playlist from a link or a local file.
 * @param {{ store: object, actions: object, tab?: 'url'|'file', file?: File }} deps
 * @returns {{ el: HTMLDialogElement, close: Function, result: Promise<any> }} modal handle
 *   (`result` resolves with the new PlaylistMeta on success, undefined when dismissed).
 */
export function openAddPlaylistDialog({ store, actions, tab = 'url', file } = {}) {
  const existing = openDialogs.get('add');
  if (existing) {
    existing.select(file || tab === 'file' ? 'file' : 'url');
    if (file) existing.setFile(file);
    return existing.handle;
  }

  const base = uid('dlg-add');
  const ids = {
    tabUrl: `${base}-tab-url`,
    tabFile: `${base}-tab-file`,
    panelUrl: `${base}-panel-url`,
    panelFile: `${base}-panel-file`,
    urlForm: `${base}-url-form`,
    fileForm: `${base}-file-form`,
    url: `${base}-url`,
    urlName: `${base}-url-name`,
    urlError: `${base}-url-error`,
    fileName: `${base}-file-name`,
    fileError: `${base}-file-error`,
    suggest: `${base}-suggest`,
    demoError: `${base}-demo-error`,
  };

  let activeTab = file || tab === 'file' ? 'file' : 'url';
  /** @type {null | 'url' | 'file' | 'demo'} */
  let loading = null;
  /** @type {File | null} */
  let selectedFile = null;
  let closed = false;
  let handle = null;
  let dragDepth = 0;

  // ----- Tabs -----
  const tabUrl = h(
    'button',
    {
      type: 'button',
      role: 'tab',
      id: ids.tabUrl,
      'aria-controls': ids.panelUrl,
      onClick: () => select('url'),
    },
    icon('link', { size: 16 }),
    h('span', { text: 'Link' }),
  );
  const tabFile = h(
    'button',
    {
      type: 'button',
      role: 'tab',
      id: ids.tabFile,
      'aria-controls': ids.panelFile,
      onClick: () => select('file'),
    },
    icon('upload', { size: 16 }),
    h('span', { text: 'File' }),
  );
  const tabs = h(
    'div',
    {
      class: 'segmented segmented-block dlg-tabs',
      role: 'tablist',
      'aria-label': 'Playlist source',
      onKeydown: (e) => {
        let next = null;
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') next = activeTab === 'url' ? 'file' : 'url';
        else if (e.key === 'Home') next = 'url';
        else if (e.key === 'End') next = 'file';
        if (!next) return;
        e.preventDefault();
        e.stopPropagation();
        select(next, { focusTab: true });
      },
    },
    tabUrl,
    tabFile,
  );

  // ----- Link panel -----
  const urlError = errorSlot(ids.urlError);
  const urlInput = h('input', {
    class: 'input',
    id: ids.url,
    type: 'url',
    inputmode: 'url',
    autocomplete: 'off',
    autocapitalize: 'off',
    placeholder: 'https://example.com/playlist.m3u',
    'aria-describedby': ids.urlError,
    'aria-invalid': 'false',
    'aria-required': 'true',
    onInput: () => setFieldError(urlError, urlInput, ''),
  });
  urlInput.setAttribute('spellcheck', 'false');
  const urlName = h('input', {
    class: 'input',
    id: ids.urlName,
    type: 'text',
    autocomplete: 'off',
    maxlength: NAME_MAX,
    placeholder: 'Uses the playlist’s own title when empty',
  });
  const urlForm = h(
    'form',
    {
      class: 'dlg-form',
      id: ids.urlForm,
      novalidate: true,
      onSubmit: (e) => {
        e.preventDefault();
        submitUrl();
      },
    },
    field({ id: ids.url, label: 'Playlist URL', control: withIcon('link', urlInput), error: urlError }),
    field({ id: ids.urlName, label: 'Name', control: urlName, optional: true }),
  );

  const suggestionButtons = [];
  const suggestions = SUGGESTED_PLAYLISTS.length
    ? h(
        'section',
        { class: 'dlg-suggest', 'aria-labelledby': ids.suggest },
        h('h3', { class: 'dlg-subtitle', id: ids.suggest, text: 'Suggestions' }),
        h(
          'ul',
          { class: 'dlg-suggest-list' },
          SUGGESTED_PLAYLISTS.map((s, i) => {
            const label = suggestionLabel(s.name);
            const btn = h(
              'button',
              {
                type: 'button',
                class: 'dlg-suggest-item',
                title: s.url,
                'aria-label': `Load ${s.name}`,
                // Hue dots spread evenly around the wheel, starting at blue.
                style: { '--h': Math.round(215 + (i * 360) / SUGGESTED_PLAYLISTS.length) % 360 },
                onClick: () => useSuggestion(s),
              },
              h('span', { class: 'dlg-suggest-dot', 'aria-hidden': 'true' }),
              h('span', { class: 'dlg-suggest-name', text: label.text }),
              label.tag ? h('span', { class: 'dlg-suggest-tag', text: label.tag }) : null,
            );
            suggestionButtons.push(btn);
            return h('li', null, btn);
          }),
        ),
        h('p', {
          class: 'dlg-note',
          text: 'Community playlists from iptv-org (third-party). Availability varies.',
        }),
      )
    : null;

  const demoError = errorSlot(ids.demoError);
  const demoBtn = h('button', {
    type: 'button',
    class: 'btn btn-secondary dlg-demo-btn',
    'aria-describedby': ids.demoError,
    onClick: () => loadDemo(),
  });
  const demo = h(
    'div',
    { class: 'dlg-demo-wrap' },
    h(
      'div',
      { class: 'dlg-demo' },
      h(
        'div',
        { class: 'dlg-demo-text' },
        h('span', { class: 'dlg-demo-title', text: 'Just exploring?' }),
        h('span', { class: 'dlg-demo-hint', text: 'Try a handful of public test streams.' }),
      ),
      demoBtn,
    ),
    demoError,
  );

  const panelUrl = h(
    'div',
    { class: 'dlg-panel', role: 'tabpanel', id: ids.panelUrl, 'aria-labelledby': ids.tabUrl },
    urlForm,
    suggestions,
    demo,
  );

  // ----- File panel -----
  const fileError = errorSlot(ids.fileError);
  const fileInput = h('input', {
    type: 'file',
    accept: FILE_ACCEPT,
    hidden: true,
    tabIndex: -1,
    'aria-hidden': 'true',
    onChange: () => {
      const picked = fileInput.files && fileInput.files[0];
      if (picked) setFile(picked);
      fileInput.value = ''; // allow re-picking the same file
    },
  });
  const dropIcon = h('span', { class: 'dlg-drop-icon', 'aria-hidden': 'true' }, icon('upload', { size: 24 }));
  const dropTitle = h('span', { class: 'dlg-drop-title' });
  const dropHint = h('span', { class: 'dlg-drop-hint' });
  const drop = h(
    'button',
    {
      type: 'button',
      class: 'dlg-drop',
      'aria-describedby': ids.fileError,
      onClick: () => {
        if (!loading) fileInput.click();
      },
      onDragenter: (e) => {
        if (!hasFiles(e)) return;
        dragDepth += 1;
        drop.classList.add('is-dragover');
      },
      onDragleave: (e) => {
        if (!hasFiles(e)) return;
        dragDepth = Math.max(0, dragDepth - 1);
        if (!dragDepth) drop.classList.remove('is-dragover');
      },
    },
    dropIcon,
    dropTitle,
    dropHint,
  );
  const fileName = h('input', {
    class: 'input',
    id: ids.fileName,
    type: 'text',
    autocomplete: 'off',
    maxlength: NAME_MAX,
    placeholder: 'Uses the file name when empty',
  });
  const fileForm = h(
    'form',
    {
      class: 'dlg-form',
      id: ids.fileForm,
      novalidate: true,
      onSubmit: (e) => {
        e.preventDefault();
        submitFile();
      },
    },
    h('div', { class: 'field' }, drop, fileError),
    fileInput,
    field({ id: ids.fileName, label: 'Name', control: fileName, optional: true }),
  );
  const panelFile = h(
    'div',
    { class: 'dlg-panel', role: 'tabpanel', id: ids.panelFile, 'aria-labelledby': ids.tabFile },
    fileForm,
  );

  // ----- Footer -----
  const status = h('p', { class: 'dlg-status md-footer-start', role: 'status' });
  const cancelBtn = h('button', {
    type: 'button',
    class: 'btn btn-secondary',
    text: 'Cancel',
    onClick: () => handle?.close(),
  });
  const submitBtn = h('button', { type: 'submit', class: 'btn btn-primary dlg-submit' });

  // ----- Behaviour -----
  function select(next, { focusTab = false } = {}) {
    if (next !== 'url' && next !== 'file') return;
    if (loading && next !== activeTab) return;
    activeTab = next;
    const isUrl = next === 'url';
    tabUrl.setAttribute('aria-selected', String(isUrl));
    tabFile.setAttribute('aria-selected', String(!isUrl));
    tabUrl.tabIndex = isUrl ? 0 : -1;
    tabFile.tabIndex = isUrl ? -1 : 0;
    panelUrl.hidden = !isUrl;
    panelFile.hidden = isUrl;
    // The footer button submits whichever form is visible (also makes Enter work in both forms).
    submitBtn.setAttribute('form', isUrl ? ids.urlForm : ids.fileForm);
    if (focusTab) (isUrl ? tabUrl : tabFile).focus();
  }

  const busyMessage = () =>
    store.get().busy?.message || (loading === 'file' ? 'Reading playlist…' : 'Downloading playlist…');

  function setLoading(kind) {
    loading = kind;
    const busy = kind !== null;
    const formBusy = kind === 'url' || kind === 'file';
    for (const input of [urlInput, urlName, fileName]) input.readOnly = busy;
    // aria-disabled (not disabled) keeps focus where it is; handlers check `loading`.
    for (const el of [drop, demoBtn, submitBtn, ...suggestionButtons]) {
      el.setAttribute('aria-disabled', String(busy));
    }
    tabUrl.setAttribute('aria-disabled', String(busy && activeTab !== 'url'));
    tabFile.setAttribute('aria-disabled', String(busy && activeTab !== 'file'));
    submitBtn.classList.toggle('is-loading', formBusy);
    replaceChildren(submitBtn, formBusy ? [spinner(), 'Loading…'] : 'Load playlist');
    demoBtn.classList.toggle('is-loading', kind === 'demo');
    replaceChildren(
      demoBtn,
      kind === 'demo' ? spinner() : icon('play', { size: 14 }),
      kind === 'demo' ? 'Loading demo…' : 'Try demo channels',
    );
    panelUrl.setAttribute('aria-busy', String(kind === 'url' || kind === 'demo'));
    panelFile.setAttribute('aria-busy', String(kind === 'file'));
    status.textContent = busy ? busyMessage() : '';
    handle?.el.toggleAttribute('data-loading', busy);
  }

  function renderDrop() {
    drop.classList.toggle('has-file', !!selectedFile);
    if (selectedFile) {
      setIcon(dropIcon, 'file', { size: 24 });
      dropTitle.textContent = selectedFile.name || 'Playlist file';
      replaceChildren(
        dropHint,
        `${formatBytes(selectedFile.size)} · `,
        h('span', { class: 'dlg-drop-link', text: 'Choose another' }),
        ' or drop to replace',
      );
    } else {
      setIcon(dropIcon, 'upload', { size: 24 });
      dropTitle.textContent = 'Drop an .m3u / .m3u8 file here';
      replaceChildren(dropHint, 'or ', h('span', { class: 'dlg-drop-link', text: 'browse' }), ' your files');
    }
  }

  function setFile(picked) {
    if (loading || !picked) return;
    selectedFile = picked;
    fileName.placeholder = stripExtension(picked.name) || 'Uses the file name when empty';
    setFieldError(fileError, drop, isPlaylistFile(picked) ? '' : NOT_A_PLAYLIST);
    renderDrop();
  }

  async function submitUrl() {
    if (loading || closed) return;
    const url = urlInput.value.trim();
    const name = urlName.value.trim();
    setFieldError(demoError, null, '');
    if (!url) {
      setFieldError(urlError, urlInput, 'Paste the link to an .m3u or .m3u8 playlist.');
      urlInput.focus();
      return;
    }
    setFieldError(urlError, urlInput, '');
    setLoading('url');
    try {
      const meta = await actions.addPlaylistFromUrl(name ? { url, name } : { url });
      if (!closed) handle.close(meta);
    } catch (err) {
      if (closed) return;
      setLoading(null);
      if (isAbortError(err)) return;
      setFieldError(urlError, urlInput, messageOf(err));
      urlInput.focus();
    }
  }

  async function submitFile() {
    if (loading || closed) return;
    if (!selectedFile) {
      setFieldError(fileError, drop, 'Choose a playlist file first.');
      drop.focus();
      return;
    }
    if (!isPlaylistFile(selectedFile)) {
      setFieldError(fileError, drop, NOT_A_PLAYLIST);
      drop.focus();
      return;
    }
    const name = fileName.value.trim();
    setFieldError(fileError, drop, '');
    setLoading('file');
    try {
      const meta = await actions.addPlaylistFromFile(selectedFile, name ? { name } : {});
      if (!closed) handle.close(meta);
    } catch (err) {
      if (closed) return;
      setLoading(null);
      if (isAbortError(err)) return;
      setFieldError(fileError, drop, messageOf(err));
      drop.focus();
    }
  }

  function useSuggestion(suggestion) {
    if (loading || closed) return;
    select('url');
    urlInput.value = suggestion.url;
    urlName.value = suggestion.name;
    submitUrl();
  }

  async function loadDemo() {
    if (loading || closed) return;
    setFieldError(demoError, null, '');
    setFieldError(urlError, urlInput, '');
    setLoading('demo');
    try {
      const meta = await actions.addDemoPlaylist();
      if (!closed) handle.close(meta);
    } catch (err) {
      if (closed) return;
      setLoading(null);
      if (!isAbortError(err)) setFieldError(demoError, null, messageOf(err));
    }
  }

  select(activeTab);
  setLoading(null);
  renderDrop();
  if (file) setFile(file);

  const unsubBusy = store.select(
    (s) => s.busy,
    () => {
      if (loading && !closed) status.textContent = busyMessage();
    },
  );

  // Touch devices: don't pop the on-screen keyboard over the sheet right away.
  const isUrlTab = activeTab === 'url';
  const initialFocus = isCoarsePointer() ? (isUrlTab ? tabUrl : tabFile) : isUrlTab ? urlInput : drop;

  handle = openModal({
    title: 'Add playlist',
    description: 'Paste an M3U / M3U8 link or pick a file from this device.',
    icon: 'plus',
    body: h('div', { class: 'dlg-add' }, tabs, panelUrl, panelFile),
    footer: [status, cancelBtn, submitBtn],
    size: 'md',
    className: 'dlg-add-dialog',
    initialFocus,
    onClose: () => {
      closed = true;
      unsubBusy();
      if (openDialogs.get('add')?.handle === handle) openDialogs.delete('add');
    },
  });

  // Files dropped anywhere on the dialog (or its backdrop) land here instead of the app-wide drop handler.
  const dialog = handle.el;
  dialog.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
  });
  dialog.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = loading ? 'none' : 'copy';
  });
  dialog.addEventListener('dragleave', (e) => {
    if (hasFiles(e)) e.stopPropagation();
  });
  dialog.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    dragDepth = 0;
    drop.classList.remove('is-dragover');
    const dropped = e.dataTransfer?.files?.[0];
    if (!dropped || loading) return;
    select('file');
    setFile(dropped);
  });

  openDialogs.set('add', { handle, select: (t) => select(t), setFile });
  return handle;
}

// ---------------------------------------------------------------------------------------------------
// Playlist manager
// ---------------------------------------------------------------------------------------------------

/**
 * List of saved playlists with use / refresh / rename / download / delete actions.
 * @param {{ store: object, actions: object }} deps
 * @returns {{ el: HTMLDialogElement, close: Function, result: Promise<any> }}
 */
export function openPlaylistManager({ store, actions }) {
  const existing = openDialogs.get('manager');
  if (existing) return existing.handle;

  let closed = false;
  let handle = null;
  /** @type {Map<string, ReturnType<typeof createRow>>} */
  const rows = new Map();
  /** Running operations, keyed `${id}:${op}`. */
  const pending = new Set();
  /** Inline errors from actions started here (the controller also toasts them). */
  const rowErrors = new Map();

  const list = h('ul', { class: 'dlg-pl-list', 'aria-label': 'Saved playlists' });
  const empty = h(
    'div',
    { class: 'empty-state dlg-empty' },
    h('div', { class: 'empty-state-icon', 'aria-hidden': 'true' }, icon('list', { size: 22 })),
    h('h3', { text: 'No playlists yet' }),
    h('p', { text: 'Add an M3U playlist from a link or a file to start watching.' }),
  );
  const usageText = h('span');
  const usage = h('p', { class: 'dlg-usage md-footer-start' }, icon('folder', { size: 14 }), usageText);
  const addBtn = h(
    'button',
    { type: 'button', class: 'btn btn-primary', onClick: () => openAddPlaylistDialog({ store, actions }) },
    icon('plus', { size: 16 }),
    h('span', { text: 'Add playlist' }),
  );

  const findPlaylist = (id) => (store.get().playlists || []).find((p) => p && p.id === id) || null;

  function actionButton(name, title, onClick, extraClass) {
    return h(
      'button',
      { type: 'button', class: ['icon-btn', 'dlg-pl-action', extraClass], title, onClick },
      icon(name, { size: 17 }),
      h('span', { class: 'spinner spinner-sm', 'aria-hidden': 'true', hidden: true }),
    );
  }

  function setButtonBusy(btn, busy) {
    const [svg, spin] = [btn.querySelector('svg'), btn.querySelector('.spinner')];
    svg?.toggleAttribute('hidden', busy);
    spin?.toggleAttribute('hidden', !busy);
    btn.setAttribute('aria-busy', String(busy));
    btn.setAttribute('aria-disabled', String(busy));
  }

  function createRow(id) {
    const kindIcon = h('span', { class: 'dlg-pl-icon', 'aria-hidden': 'true' }, icon('list', { size: 18 }));
    const name = h('span', { class: 'dlg-pl-name truncate' });
    const activeBadge = h('span', { class: 'badge badge-accent dlg-pl-badge', text: 'Active' });
    const cacheBadge = h('span', { class: 'badge badge-warning dlg-pl-badge', text: 'Not cached' });
    const meta = h('p', { class: 'dlg-pl-meta truncate' });
    const errorText = h('span');
    const errorLine = h('p', { class: 'dlg-pl-error' }, icon('alert', { size: 13 }), errorText);
    const useSpinner = spinner();
    const useBtn = h(
      'button',
      { type: 'button', class: 'btn btn-secondary btn-sm dlg-pl-use', onClick: () => use(id) },
      useSpinner,
      h('span', { text: 'Use' }),
    );
    const refreshBtn = actionButton('refresh', 'Refresh', () => refresh(id));
    const renameBtn = actionButton('edit', 'Rename', () => rename(id));
    const downloadBtn = actionButton('download', 'Download .m3u', () => download(id));
    const deleteBtn = actionButton('trash', 'Delete', () => remove(id), 'dlg-pl-delete');
    const main = h(
      'div',
      { class: 'dlg-pl-main' },
      h('div', { class: 'dlg-pl-head' }, name, activeBadge, cacheBadge),
      meta,
      errorLine,
    );
    const li = h(
      'li',
      { class: 'dlg-pl' },
      kindIcon,
      main,
      h('div', { class: 'dlg-pl-actions' }, useBtn, refreshBtn, renameBtn, downloadBtn, deleteBtn),
    );
    let lastKind = null;

    function update(pl, state, now) {
      const active = pl.id === state.activePlaylistId;
      const kind = SOURCE_LABEL[pl.source?.kind] ? pl.source.kind : 'url';
      const label = pl.name || 'Untitled playlist';
      li.classList.toggle('is-active', active);
      if (active) li.setAttribute('aria-current', 'true');
      else li.removeAttribute('aria-current');
      if (kind !== lastKind) {
        setIcon(kindIcon, SOURCE_ICON[kind], { size: 18 });
        lastKind = kind;
      }

      name.textContent = label;
      const detail = kind === 'url' ? pl.source?.url : kind === 'file' ? pl.source?.fileName : '';
      if (detail) main.title = detail;
      else main.removeAttribute('title');
      activeBadge.hidden = !active;
      cacheBadge.hidden = pl.cached !== false || kind === 'demo';
      cacheBadge.title =
        kind === 'file'
          ? 'Too large to keep in browser storage — re-upload it after reloading the page.'
          : 'Too large to keep offline — it will be downloaded again when the page reloads.';

      const channels = Number(pl.channelCount) || 0;
      const groups = Number(pl.groupCount) || 0;
      const when = relativeTime(pl.updatedAt || pl.createdAt, now);
      meta.textContent = [
        plural(channels, 'channel'),
        plural(groups, 'group'),
        SOURCE_LABEL[kind],
        when && `updated ${when}`,
      ]
        .filter(Boolean)
        .join(' · ');

      const loadError = state.playlistError?.playlistId === pl.id ? state.playlistError.message : '';
      const error = rowErrors.get(pl.id) || loadError || '';
      errorText.textContent = error;
      errorLine.hidden = !error;

      // Use (switch)
      const switching = pending.has(`${pl.id}:switch`);
      const useHadFocus = document.activeElement === useBtn;
      useBtn.hidden = active && !switching;
      useSpinner.hidden = !switching;
      useBtn.classList.toggle('is-loading', switching);
      useBtn.setAttribute('aria-busy', String(switching));
      useBtn.setAttribute('aria-disabled', String(switching));
      useBtn.setAttribute('aria-label', `Use “${label}”`);
      if (useHadFocus && useBtn.hidden) renameBtn.focus({ preventScroll: true });

      // Refresh (URL playlists only)
      refreshBtn.hidden = kind !== 'url';
      const refreshing = pending.has(`${pl.id}:refresh`);
      setButtonBusy(refreshBtn, refreshing);
      const refreshLabel = refreshing ? `Refreshing “${label}”…` : `Refresh “${label}”`;
      refreshBtn.setAttribute('aria-label', refreshLabel);

      setButtonBusy(downloadBtn, pending.has(`${pl.id}:export`));
      downloadBtn.setAttribute('aria-label', `Download “${label}” as .m3u`);
      renameBtn.setAttribute('aria-label', `Rename “${label}”`);
      deleteBtn.setAttribute('aria-label', `Delete “${label}”`);
    }

    return { li, update, deleteBtn };
  }

  function renderUsage() {
    const bytes = usageBytes();
    usage.hidden = bytes === null;
    if (bytes !== null) usageText.textContent = `Using ${formatBytes(bytes)} of browser storage`;
  }

  function render() {
    if (closed) return;
    const state = store.get();
    const playlists = Array.isArray(state.playlists) ? state.playlists : [];
    const now = Date.now();
    const seen = new Set();
    // Keyed, in-place update: rows (and their focused buttons) survive re-renders.
    let cursor = list.firstChild;
    for (const pl of playlists) {
      if (!pl || !pl.id || seen.has(pl.id)) continue;
      seen.add(pl.id);
      let row = rows.get(pl.id);
      if (!row) {
        row = createRow(pl.id);
        rows.set(pl.id, row);
      }
      row.update(pl, state, now);
      if (row.li === cursor) cursor = cursor.nextSibling;
      else list.insertBefore(row.li, cursor);
    }
    for (const [id, row] of rows) {
      if (seen.has(id)) continue;
      row.li.remove();
      rows.delete(id);
      rowErrors.delete(id);
    }
    list.hidden = seen.size === 0;
    empty.hidden = seen.size > 0;
    renderUsage();
  }

  async function run(id, op, task) {
    const key = `${id}:${op}`;
    if (pending.has(key)) return;
    pending.add(key);
    rowErrors.delete(id);
    render();
    try {
      await task();
    } catch (err) {
      if (!isAbortError(err)) rowErrors.set(id, messageOf(err));
    } finally {
      pending.delete(key);
      render();
    }
  }

  const use = (id) => run(id, 'switch', () => actions.switchPlaylist(id));
  const refresh = (id) => run(id, 'refresh', () => actions.refreshPlaylist(id));
  const download = (id) => run(id, 'export', () => actions.exportPlaylist(id));

  async function rename(id) {
    const pl = findPlaylist(id);
    if (!pl) return;
    const next = await promptDialog({
      title: 'Rename playlist',
      label: 'Name',
      value: pl.name || '',
      confirmLabel: 'Rename',
      maxLength: NAME_MAX,
      validate: (value) => (value ? '' : 'Give the playlist a name.'),
    });
    const current = findPlaylist(id);
    if (next === null || !current || next === current.name) return;
    try {
      actions.renamePlaylist(id, next);
    } catch (err) {
      rowErrors.set(id, messageOf(err));
      render();
    }
  }

  async function remove(id) {
    const pl = findPlaylist(id);
    if (!pl) return;
    let focusAfter = null;
    const isActive = store.get().activePlaylistId === id;
    const ok = await confirmDialog({
      title: 'Delete playlist?',
      message: `“${pl.name || 'Untitled playlist'}” will be removed from this browser.${
        isActive ? ' It’s the playlist you’re using right now.' : ''
      } This can’t be undone.`,
      confirmLabel: 'Delete',
      danger: true,
      icon: 'trash',
      // Evaluated after the confirm has closed — by then the row is gone, so land on a neighbour.
      returnFocus: () => focusAfter,
    });
    if (!ok) return;
    const order = (store.get().playlists || []).map((p) => p.id);
    const index = order.indexOf(id);
    const neighbour = index === -1 ? null : (order[index + 1] ?? order[index - 1] ?? null);
    focusAfter = (neighbour && rows.get(neighbour)?.deleteBtn) || addBtn;
    try {
      actions.removePlaylist(id);
    } catch (err) {
      rowErrors.set(id, messageOf(err));
      render();
    }
  }

  const unsubscribe = store.subscribe((s, prev) => {
    const changed =
      s.playlists !== prev.playlists ||
      s.activePlaylistId !== prev.activePlaylistId ||
      s.playlistError !== prev.playlistError;
    if (changed) render();
  });
  // Keep "updated 5 min ago" and the storage figure fresh while the dialog stays open.
  const ticker = setInterval(render, 30_000);

  render();
  handle = openModal({
    title: 'Playlists',
    description: 'Switch between, refresh or remove the playlists saved in this browser.',
    icon: 'playlist',
    body: h('div', { class: 'dlg-manager' }, list, empty),
    footer: [usage, addBtn],
    size: 'lg',
    className: 'dlg-manager-dialog',
    initialFocus: '.md-close',
    onClose: () => {
      closed = true;
      unsubscribe();
      clearInterval(ticker);
      if (openDialogs.get('manager')?.handle === handle) openDialogs.delete('manager');
    },
  });
  openDialogs.set('manager', { handle });
  return handle;
}

// ---------------------------------------------------------------------------------------------------
// Stream relay ("proxy") — shared by Settings and the setup guide
// ---------------------------------------------------------------------------------------------------

const RELAY_SERVICE = 'iptv-stream-relay';
/** The relay code's `VERSION` export; a deployed relay that reports less is out of date. */
const RELAY_VERSION_LINE = /^export const VERSION = (\d+);/m;
/** The relay keeps its allowlist on one line so the guide can swap in this site's origin. */
const RELAY_ORIGINS_LINE = /^export const ALLOWED_ORIGINS = .*;$/m;
const RELAY_ENTRY_MARKER =
  '// ---- entry point (the in-app setup guide swaps this block for the chosen platform) ----';
/**
 * Deno Deploy's entry point. Like proxy/deno.js it hands the relay a resolver, so that host names of private
 * addresses (e.g. 127.0.0.1.nip.io) are refused too; Cloudflare Workers have no DNS API, so they do without.
 */
const DENO_ENTRY = [
  '// ---- entry point: Deno Deploy ----',
  "/** Errors that mean DNS lookups aren't available here at all (not merely that a name has no records). */",
  "const LOOKUP_UNAVAILABLE = new Set(['NotSupported', 'PermissionDenied', 'NotCapable']);",
  "let lookupsAvailable = typeof Deno.resolveDns === 'function';",
  '',
  '// Every address a host name resolves to (A and AAAA records), so that the relay also refuses names that',
  "// point at private addresses. Rejects when a name doesn't resolve; null (no check) if DNS is unavailable.",
  'async function resolveHost(hostname) {',
  "  if (!lookupsAvailable) return null; // can't look names up here: relay as if there were no resolver",
  '  let unavailable = false;',
  '  const lookup = async (type) => {',
  '    try {',
  '      return await Deno.resolveDns(hostname, type);',
  '    } catch (err) {',
  '      if (err instanceof TypeError || LOOKUP_UNAVAILABLE.has(err?.name)) unavailable = true;',
  '      return null; // e.g. no AAAA records',
  '    }',
  '  };',
  "  const [v4, v6] = await Promise.all([lookup('A'), lookup('AAAA')]);",
  '  if (v4 || v6) return [...(v4 || []), ...(v6 || [])];',
  '  if (unavailable) {',
  '    lookupsAvailable = false;',
  "    console.warn('DNS lookups are unavailable here; host names are no longer checked for private addresses.');",
  '    return null;',
  '  }',
  "  throw new Error(`Couldn't resolve ${hostname}`);",
  '}',
  '',
  'Deno.serve((request) => handleRequest(request, { resolveHost }));',
  '',
].join('\n');
/** Local dev servers (`vite` and `vite preview`) the copied relay allows besides this site. */
const DEV_ORIGINS = [
  'http://localhost:5173',
  'http://localhost:4173',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:4173',
];
const HEALTH_TIMEOUT_MS = 10_000;
const PROXY_PLACEHOLDER = 'https://your-relay.deno.dev';
const RELAY_DOCS_URL = 'https://github.com/almailgroup/iptv-player/blob/main/proxy/README.md';

/** Where the guide's steps point, per hosting platform. */
const RELAY_PLATFORMS = {
  deno: { label: 'Deno Deploy', placeholder: PROXY_PLACEHOLDER },
  cloudflare: { label: 'Cloudflare Workers', placeholder: 'https://your-relay.workers.dev' },
};

/** proxy/stream-proxy.js as text, once loadRelaySource() has fetched it ('' before). */
let relaySourceText = '';
let relaySourceLoad = null;

/**
 * The relay's source code (proxy/stream-proxy.js). It's a separate ~60 kB chunk that only the setup guide's
 * "Copy relay code" (and the out-of-date check of a relay test) needs, so it stays out of the main bundle.
 * The result is cached; a failed download (e.g. offline) is retried on the next call.
 * @returns {Promise<string>}
 */
export function loadRelaySource() {
  relaySourceLoad ??= import('../../proxy/stream-proxy.js?raw').then(
    ({ default: source }) => {
      relaySourceText = String(source);
      return relaySourceText;
    },
    (err) => {
      relaySourceLoad = null;
      throw err;
    },
  );
  return relaySourceLoad;
}

/** Version of the relay code this site ships (0 when it can't be loaded). */
async function shippedRelayVersion() {
  try {
    return Number(RELAY_VERSION_LINE.exec(await loadRelaySource())?.[1]) || 0;
  } catch {
    return 0;
  }
}

const pageOrigin = () => {
  const url = tryParseUrl(globalThis.location?.origin || '');
  return url && (url.protocol === 'http:' || url.protocol === 'https:') ? url.origin : '';
};

/** Same loopback rules as the browser's "potentially trustworthy" http:// hosts. */
function isLoopbackHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '[::1]' ||
    /^127(?:\.\d{1,3}){3}$/.test(host)
  );
}

/**
 * Empty is fine (disabled); otherwise an absolute http(s) URL that this page is allowed to call: secure pages
 * may only use https:// — or http://localhost, which browsers treat as secure.
 */
function validateProxy(value) {
  if (!value) return '';
  const url = tryParseUrl(value);
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
    return `Enter a full http(s) address, for example ${PROXY_PLACEHOLDER}`;
  }
  const securePage = globalThis.location?.protocol === 'https:';
  if (securePage && url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
    return (
      'Use an https:// address — browsers block insecure requests from secure pages ' +
      '(http://localhost is fine).'
    );
  }
  return '';
}

const quoteJs = (value) => `'${String(value).replace(/[\\']/g, '\\$&')}'`;

/**
 * The relay code ready to paste into a hosting platform: its ALLOWED_ORIGINS line lists `origin` (this site)
 * plus the local dev servers and, for Deno Deploy, the default-export entry point is replaced with
 * `Deno.serve`.
 * @param {string} relaySource proxy/stream-proxy.js's source (see loadRelaySource())
 * @param {'deno' | 'cloudflare'} platform
 * @param {string} [origin] the site that will use the relay; defaults to this page's origin
 * @returns {string}
 */
export function relaySourceFor(relaySource, platform, origin = pageOrigin()) {
  const site = tryParseUrl(String(origin || ''));
  const own = site && (site.protocol === 'http:' || site.protocol === 'https:') ? [site.origin] : [];
  const origins = [...new Set([...own, ...DEV_ORIGINS])];
  const line = `export const ALLOWED_ORIGINS = [${origins.map(quoteJs).join(', ')}];`;
  let source = String(relaySource).replace(RELAY_ORIGINS_LINE, () => line);
  if (platform === 'deno') {
    const at = source.indexOf(RELAY_ENTRY_MARKER);
    source = `${at >= 0 ? source.slice(0, at) : `${source.trimEnd()}\n\n`}${DENO_ENTRY}`;
  }
  return source;
}

/**
 * The relay's health-check address for a proxy setting: `<origin><path>?health`, where the path is the
 * setting's own path (up to a `{url}` placeholder; query and hash dropped). '' unless it's an http(s) URL.
 * @param {string} proxy
 * @returns {string}
 */
export function proxyHealthUrl(proxy) {
  const value = typeof proxy === 'string' ? proxy.trim() : '';
  const placeholder = value.search(/\{url\}/i);
  const url = tryParseUrl(placeholder >= 0 ? value.slice(0, placeholder) : value);
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) return '';
  return `${url.origin}${url.pathname}?health`;
}

const HEALTH = {
  invalid: { status: 'error', message: `Enter a full http(s) address, for example ${PROXY_PLACEHOLDER}` },
  timeout: {
    status: 'error',
    message: 'The relay didn’t answer within 10 seconds. Check the address, or try again in a moment.',
  },
  unreachable: {
    status: 'error',
    message: 'Couldn’t reach the relay. Check the address and that the relay is deployed.',
  },
  foreign: {
    status: 'warning',
    message:
      'This address answers, but it isn’t the IPTV stream relay. Playlists may load through it; blocked ' +
      'streams may not play.',
  },
};

/**
 * Ask a stream relay whether it's up and allows this site: `GET <proxy>/?health` (see proxyHealthUrl()).
 * A relay older than the code this site ships is reported as out of date. Never throws.
 * @param {string} proxy the relay setting
 * @param {{ signal?: AbortSignal, timeoutMs?: number, fetchImpl?: typeof fetch }} [options]
 * @returns {Promise<{ status: 'ok' | 'warning' | 'error', message: string, version?: number } | null>}
 *   null when `signal` aborted the check.
 */
export async function checkProxyHealth(
  proxy,
  { signal, timeoutMs = HEALTH_TIMEOUT_MS, fetchImpl = globalThis.fetch } = {},
) {
  const url = proxyHealthUrl(proxy);
  if (!url) return { ...HEALTH.invalid };
  if (signal?.aborted) return null;
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const init = { method: 'GET', cache: 'no-store', credentials: 'omit', signal: controller.signal };
  const interrupted = () => (signal?.aborted ? null : timedOut ? { ...HEALTH.timeout } : undefined);
  try {
    let res;
    try {
      res = await fetchImpl(url, init);
    } catch {
      const stop = interrupted();
      if (stop !== undefined) return stop;
      // Unreachable, or running without CORS headers for this site (the relay's allowlist): an opaque
      // no-cors request still succeeds in the second case, which tells the two apart.
      const reachable = await fetchImpl(url, { ...init, mode: 'no-cors' }).then(
        () => true,
        () => false,
      );
      const late = interrupted();
      if (late !== undefined) return late;
      if (!reachable) return { ...HEALTH.unreachable };
      const site = pageOrigin();
      return {
        status: 'error',
        message:
          `The relay is running but doesn’t allow this site${site ? ` (${site})` : ''}. Copy the relay ` +
          'code again from the setup guide and redeploy it.',
      };
    }
    if (!res.ok) {
      const refused = res.status === 401 || res.status === 403;
      return {
        status: 'error',
        message: refused
          ? `The relay refused this site (HTTP ${res.status}).`
          : `The relay answered with an error (HTTP ${res.status}). Check the address.`,
      };
    }
    let info = null;
    try {
      info = JSON.parse(await res.text());
    } catch {
      const stop = interrupted();
      if (stop !== undefined) return stop;
    }
    if (!info || info.ok !== true || info.service !== RELAY_SERVICE) return { ...HEALTH.foreign };
    const version = Number.isInteger(info.version) && info.version > 0 ? info.version : 0;
    const working = `Relay is working${version ? ` (v${version})` : ''}`;
    const latest = version ? await shippedRelayVersion() : 0;
    if (signal?.aborted) return null;
    if (version && version < latest) {
      return {
        status: 'warning',
        version,
        message: `${working}, but it’s out of date. Copy the relay code again and redeploy it to update.`,
      };
    }
    return { status: 'ok', version, message: working };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

const CHECK_ICON = { ok: 'check', warning: 'alert', error: 'alert' };

/** Hints of the "Ambient colour from video" switch. */
const AMBIENT_HINT = {
  on: 'Tint the background with colours from the playing video.',
  reducedMotion:
    'Tint the background with colours from the playing video. Paused while your device is set to reduce ' +
    'motion.',
};

/** Settings hints of the "Use the built-in relay" switch. */
const BUILTIN_HINT = {
  on:
    'Lets insecure (http://) and blocked channels play. Your viewing of those channels passes through this ' +
    'site’s relay.',
  overridden: 'Not used while your own relay is set below.',
};

/**
 * A health check of the built-in relay, worded for visitors: they can't fix its setup (and an older version
 * still works), so a problem just means "not working right now".
 */
function builtinHealth(result) {
  if (result.status === 'ok' || result.version) {
    const version = result.version ? ` (v${result.version})` : '';
    return { status: 'ok', message: `The built-in relay is working${version}` };
  }
  return {
    status: 'error',
    message: 'The built-in relay isn’t working right now. Try again later, or set up your own relay.',
  };
}

/** Inline result line for a relay test (a polite live region; empty while there is nothing to say). */
function createCheckLine(id) {
  const el = h('p', { class: 'dlg-check', id, role: 'status' });
  let value = '';
  return {
    el,
    /** The relay address the current message is about ('' when cleared). */
    get value() {
      return value;
    },
    set(status, message, about = '') {
      value = about;
      el.dataset.status = status;
      replaceChildren(
        el,
        status === 'pending' ? spinner() : icon(CHECK_ICON[status] || 'info', { size: 14 }),
        h('span', { class: 'dlg-check-text', text: message }),
      );
    },
    clear() {
      value = '';
      delete el.dataset.status;
      replaceChildren(el);
    },
  };
}

const externalLink = (href, text) =>
  h(
    'a',
    { class: 'dlg-link', href, target: '_blank', rel: 'noopener noreferrer' },
    text,
    icon('external', { size: 12 }),
  );

// ---------------------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------------------

/**
 * Settings: playback, library, network, appearance and data. Changes apply immediately.
 * @param {{ store: object, actions: object }} deps
 * @returns {{ el: HTMLDialogElement, close: Function, result: Promise<any> }}
 */
export function openSettingsDialog({ store, actions }) {
  const existing = openDialogs.get('settings');
  if (existing) return existing.handle;

  let closed = false;
  let handle = null;
  const settings = () => ({ ...DEFAULT_SETTINGS, ...(store.get().settings || {}) });
  const apply = (patch) => {
    try {
      actions.updateSettings(patch);
    } catch (err) {
      console.error(err);
    }
  };

  // ----- Switch rows -----
  const switches = [];
  function switchRow(key, label, hint) {
    const id = uid(`dlg-set-${key}`);
    const input = h('input', {
      type: 'checkbox',
      role: 'switch',
      id,
      'aria-labelledby': `${id}-label`,
      'aria-describedby': hint ? `${id}-hint` : undefined,
      onChange: () => apply({ [key]: input.checked }),
    });
    switches.push({ key, input });
    return h(
      'label',
      { class: 'dlg-row dlg-row-switch', htmlFor: id },
      h(
        'span',
        { class: 'dlg-row-text' },
        h('span', { class: 'dlg-row-label', id: `${id}-label`, text: label }),
        hint ? h('span', { class: 'dlg-row-hint', id: `${id}-hint`, text: hint }) : null,
      ),
      h('span', { class: 'switch' }, input, h('span', { class: 'switch-track', 'aria-hidden': 'true' })),
    );
  }

  // ----- Max retries -----
  const retriesId = uid('dlg-set-retries');
  const parseRetries = (raw) => {
    const n = Number(raw);
    return String(raw).trim() !== '' && Number.isInteger(n) && n >= 1 && n <= 30 ? n : null;
  };
  const retries = h('input', {
    class: 'input input-sm dlg-number',
    type: 'number',
    id: retriesId,
    min: 1,
    max: 30,
    step: 1,
    inputmode: 'numeric',
    'aria-describedby': `${retriesId}-hint`,
    onInput: () => {
      const n = parseRetries(retries.value);
      if (n !== null && n !== settings().maxRetries) apply({ maxRetries: n });
    },
    onChange: () => commitRetries(),
    onBlur: () => commitRetries(),
  });
  function commitRetries() {
    const raw = Number(retries.value);
    const valid = retries.value.trim() !== '' && Number.isFinite(raw);
    const n = valid ? clamp(Math.round(raw), 1, 30) : settings().maxRetries;
    if (retries.value !== String(n)) retries.value = String(n);
    if (n !== settings().maxRetries) apply({ maxRetries: n });
  }
  // − [n] + : the buttons are pointer shortcuts (the spin button itself handles ↑ / ↓), so they stay out of
  // the Tab order.
  const stepButton = (delta, label) =>
    h('button', {
      type: 'button',
      class: ['dlg-stepper-btn', delta > 0 && 'is-plus'],
      tabIndex: -1,
      'aria-label': label,
      onClick: () => {
        if (retries.disabled) return;
        const current = parseRetries(retries.value) ?? settings().maxRetries;
        retries.value = String(clamp(current + delta, 1, 30));
        commitRetries();
      },
    });
  const retriesDown = stepButton(-1, 'Fewer retries');
  const retriesUp = stepButton(1, 'More retries');
  const retriesRow = h(
    'div',
    { class: 'dlg-row dlg-row-sub dlg-row-stepper' },
    h(
      'span',
      { class: 'dlg-row-text' },
      h('label', { class: 'dlg-row-label', htmlFor: retriesId, text: 'Max retries' }),
      h('span', {
        class: 'dlg-row-hint',
        id: `${retriesId}-hint`,
        text: 'Reconnect attempts before giving up (1\u2060–\u206030).',
      }),
    ),
    h('span', { class: 'dlg-stepper' }, retriesDown, retries, retriesUp),
  );

  // ----- Auto-refresh -----
  const refreshId = uid('dlg-set-refresh');
  const refreshSelect = h('select', {
    class: 'input dlg-select',
    id: refreshId,
    'aria-describedby': `${refreshId}-hint`,
    onChange: () => {
      const hours = Number(refreshSelect.value);
      if (Number.isFinite(hours) && hours >= 0) apply({ autoRefreshHours: hours });
    },
  });
  let refreshOptionsKey = '';
  function renderRefreshOptions(value) {
    const hours = Number.isFinite(value) && value >= 0 ? value : DEFAULT_SETTINGS.autoRefreshHours;
    const choices = REFRESH_CHOICES.some((c) => c.hours === hours)
      ? REFRESH_CHOICES
      : [...REFRESH_CHOICES, { hours, label: `Every ${formatCount(hours)} hours` }].sort(
          (a, b) => a.hours - b.hours,
        );
    const key = choices.map((c) => c.hours).join(',');
    if (key !== refreshOptionsKey) {
      refreshOptionsKey = key;
      replaceChildren(
        refreshSelect,
        choices.map((c) => h('option', { value: String(c.hours), text: c.label })),
      );
    }
    refreshSelect.value = String(hours);
  }
  const refreshRow = h(
    'div',
    { class: 'dlg-row dlg-row-select' },
    h(
      'span',
      { class: 'dlg-row-text' },
      h('label', { class: 'dlg-row-label', htmlFor: refreshId, text: 'Auto-refresh URL playlists' }),
      h('span', {
        class: 'dlg-row-hint',
        id: `${refreshId}-hint`,
        text: 'Re-download link playlists in the background once they’re older than this.',
      }),
    ),
    h('span', { class: 'dlg-select-wrap' }, refreshSelect, icon('chevron-down', { size: 16 })),
  );

  // ----- Stream relay -----
  // With a built-in relay (BUILTIN_RELAY_URL) the field is the user's own relay, which overrides it; without
  // one it's the only relay there is. "Test" checks whichever relay is in effect.
  const builtin = hasBuiltinRelay();
  const builtinRow = builtin ? switchRow('useBuiltinRelay', 'Use the built-in relay', BUILTIN_HINT.on) : null;
  const builtinHint = builtinRow?.querySelector('.dlg-row-hint');
  const proxyId = uid('dlg-set-proxy');
  const proxyError = errorSlot(`${proxyId}-error`);
  const proxyCheck = createCheckLine(`${proxyId}-check`);
  /** The running "Test" (aborted when the value changes or the dialog closes). */
  let proxyTest = null;
  const proxyInput = h('input', {
    class: 'input',
    type: 'url',
    id: proxyId,
    inputmode: 'url',
    autocomplete: 'off',
    autocapitalize: 'off',
    placeholder: PROXY_PLACEHOLDER,
    'aria-describedby': `${proxyId}-hint ${proxyId}-error ${proxyId}-check`,
    'aria-invalid': 'false',
    onInput: () => {
      setFieldError(proxyError, proxyInput, '');
      cancelProxyTest();
      proxyCheck.clear();
      renderProxyTools();
      commitProxyLater();
    },
    onChange: () => {
      commitProxyLater.cancel();
      commitProxy(true);
    },
    onKeydown: (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      commitProxyLater.cancel();
      commitProxy(true);
    },
  });
  proxyInput.setAttribute('spellcheck', 'false');
  function commitProxy(showErrors) {
    const value = proxyInput.value.trim();
    const error = validateProxy(value);
    if (error) {
      if (showErrors) setFieldError(proxyError, proxyInput, error);
      return false;
    }
    setFieldError(proxyError, proxyInput, '');
    if (value !== (settings().corsProxy || '')) apply({ corsProxy: value });
    return true;
  }
  const commitProxyLater = debounce(() => commitProxy(false), 450);
  const testBtn = h('button', {
    type: 'button',
    class: 'btn btn-secondary dlg-proxy-test',
    text: 'Test',
    'aria-describedby': `${proxyId}-check`,
    onClick: () => testProxy(),
  });
  const guideBtn = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-ghost btn-sm dlg-link-btn',
      onClick: () => openProxyGuide({ store, actions }),
    },
    icon('broadcast', { size: 15 }),
    h('span', { text: builtin ? 'Set up your own relay…' : 'Set up a free relay…' }),
  );
  const proxyRow = h(
    'div',
    { class: 'dlg-row dlg-row-stack dlg-row-proxy' },
    h(
      'span',
      { class: 'dlg-row-text' },
      h('label', {
        class: 'dlg-row-label',
        htmlFor: proxyId,
        text: builtin ? 'Your own relay (optional)' : 'Relay (optional)',
      }),
      h('span', {
        class: 'dlg-row-hint',
        id: `${proxyId}-hint`,
        text: builtin
          ? 'Overrides the built-in relay.'
          : 'Your own relay for streams and playlists that browsers block (insecure HTTP or missing CORS). ' +
            'Leave empty to disable.',
      }),
    ),
    h('div', { class: 'dlg-inline' }, proxyInput, testBtn),
    proxyError,
    proxyCheck.el,
    h('div', { class: 'dlg-row-tools' }, guideBtn),
  );
  const proxyStreamsRow = switchRow(
    'proxyStreams',
    'Play blocked streams through the relay',
    'Only channels your browser would block go through it — the rest play directly.',
  );
  const proxyStreamsInput = proxyStreamsRow.querySelector('input');

  /** What "Test" checks: the typed own relay, else the built-in one while it's on ('' = nothing). */
  function testTarget() {
    const typed = proxyInput.value.trim();
    if (typed) return typed;
    return builtin && settings().useBuiltinRelay !== false ? BUILTIN_RELAY_URL : '';
  }
  function renderProxyTools() {
    const target = testTarget();
    testBtn.disabled = !target;
    testBtn.title = target && !proxyInput.value.trim() ? 'Test the built-in relay' : 'Test your relay';
    testBtn.setAttribute('aria-busy', String(!!proxyTest));
  }
  function cancelProxyTest() {
    if (!proxyTest) return;
    proxyTest.abort();
    proxyTest = null;
    proxyCheck.clear();
    renderProxyTools();
  }
  async function testProxy() {
    if (proxyTest || closed) return;
    commitProxyLater.cancel();
    if (!commitProxy(true)) {
      proxyInput.focus();
      return;
    }
    const value = testTarget();
    if (!value) return;
    const isBuiltin = !proxyInput.value.trim();
    const controller = new AbortController();
    proxyTest = controller;
    renderProxyTools();
    proxyCheck.set('pending', isBuiltin ? 'Testing the built-in relay…' : 'Testing your relay…', value);
    const result = await checkProxyHealth(value, { signal: controller.signal });
    if (proxyTest !== controller) return; // value changed, reset or dialog closed meanwhile
    proxyTest = null;
    renderProxyTools();
    if (!result) return;
    const shown = isBuiltin ? builtinHealth(result) : result;
    proxyCheck.set(shown.status, shown.message, value);
  }

  // ----- Data -----
  const usageHint = h('span', { class: 'dlg-row-hint' });
  const clearBtn = h(
    'button',
    { type: 'button', class: 'btn btn-danger btn-sm', onClick: () => clearData() },
    icon('trash', { size: 14 }),
    h('span', { text: 'Clear all data' }),
  );
  const dataRow = h(
    'div',
    { class: 'dlg-row dlg-row-data' },
    h('span', { class: 'dlg-row-text' }, h('span', { class: 'dlg-row-label', text: 'Stored data' }), usageHint),
    clearBtn,
  );
  function renderUsage() {
    const bytes = usageBytes();
    usageHint.textContent =
      bytes === null
        ? 'Playlists, favorites, watch history and settings saved in this browser.'
        : `Playlists, favorites, watch history and settings — ${formatBytes(bytes)} in this browser.`;
  }
  async function clearData() {
    const ok = await confirmDialog({
      icon: 'trash',
      title: 'Clear all data?',
      message:
        'This permanently removes every playlist, favorite, watch-history entry and setting saved by this ' +
        'player in this browser, then reloads the page.',
      confirmLabel: 'Clear everything',
      danger: true,
    });
    if (ok) actions.clearAllData();
  }

  // ----- Footer -----
  const resetBtn = h(
    'button',
    { type: 'button', class: 'btn btn-ghost md-footer-start dlg-reset', onClick: () => resetDefaults() },
    icon('rotate-ccw', { size: 15 }),
    h('span', { text: 'Reset to defaults' }),
  );
  const doneBtn = h('button', {
    type: 'button',
    class: 'btn btn-primary',
    text: 'Done',
    onClick: () => handle?.close(),
  });
  async function resetDefaults() {
    const ok = await confirmDialog({
      icon: 'rotate-ccw',
      title: 'Reset settings?',
      message:
        'Playback, library, network and ambient colour settings go back to their defaults. ' +
        'Playlists, favorites and your theme are kept.',
      confirmLabel: 'Reset',
    });
    if (ok) {
      setFieldError(proxyError, proxyInput, '');
      cancelProxyTest();
      proxyCheck.clear();
      apply({ ...DEFAULT_SETTINGS });
    }
  }

  // ----- Appearance -----
  // The page-wide tint follows the video only with motion allowed (the player pauses it otherwise): say so.
  const reducedMotion =
    typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  const ambientRow = switchRow('ambientColor', 'Ambient colour from video', AMBIENT_HINT.on);
  const ambientHint = ambientRow.querySelector('.dlg-row-hint');
  const renderAmbientHint = () => {
    ambientHint.textContent = reducedMotion?.matches ? AMBIENT_HINT.reducedMotion : AMBIENT_HINT.on;
  };
  reducedMotion?.addEventListener?.('change', renderAmbientHint);

  // ----- Layout -----
  const section = (title, iconName, children, cardClass) => {
    const id = uid('dlg-sec');
    return h(
      'section',
      { class: 'dlg-section', 'aria-labelledby': id },
      h('h3', { class: 'dlg-section-title', id }, icon(iconName, { size: 14 }), title),
      h('div', { class: ['dlg-card', cardClass] }, children),
    );
  };

  const body = h(
    'div',
    { class: 'dlg-settings' },
    section('Playback', 'play', [
      switchRow('autoplay', 'Autoplay', 'Start playback as soon as you pick a channel.'),
      switchRow('autoReconnect', 'Auto-reconnect', 'Retry automatically when a stream drops or stalls.'),
      retriesRow,
      switchRow(
        'upgradeInsecure',
        'Upgrade HTTP streams to HTTPS',
        'On secure pages, try an https:// address for http:// streams that don’t use the relay.',
      ),
      switchRow('lowLatency', 'Low-latency mode', 'Stay closer to the live edge on low-latency HLS streams.'),
      switchRow(
        'preferNativeHls',
        'Prefer native HLS',
        'Use the browser’s built-in HLS playback when available (Safari).',
      ),
    ]),
    section('Library', 'list', [
      switchRow(
        'showLogos',
        'Show channel logos',
        'Load logos from the playlist. Turn off for a faster, quieter list.',
      ),
      switchRow(
        'rememberLastChannel',
        'Remember last channel',
        'Resume the channel you were watching when you return.',
      ),
      refreshRow,
    ]),
    section('Network', 'broadcast', [builtinRow, proxyRow, proxyStreamsRow]),
    section('Appearance', 'palette', [
      h('div', { class: 'dlg-card-pad dlg-theme' }, createThemePicker({ store, actions })),
      ambientRow,
    ]),
    section('Data', 'folder', [dataRow]),
  );

  function sync() {
    const s = settings();
    for (const { key, input } of switches) input.checked = !!s[key];
    const reconnect = !!s.autoReconnect;
    retries.disabled = !reconnect;
    retriesDown.disabled = !reconnect || s.maxRetries <= 1;
    retriesUp.disabled = !reconnect || s.maxRetries >= 30;
    retriesRow.classList.toggle('is-disabled', !reconnect);
    if (document.activeElement !== retries) retries.value = String(s.maxRetries);
    renderRefreshOptions(Number(s.autoRefreshHours));
    // Don't clobber what the user is typing (or an invalid value they still need to fix).
    if (document.activeElement !== proxyInput && !proxyError.textContent) proxyInput.value = s.corsProxy || '';
    // A test of another relay (e.g. before one was saved from the setup guide, or of the built-in one after
    // it was switched off) no longer applies.
    if (proxyCheck.value && proxyCheck.value !== testTarget()) {
      cancelProxyTest();
      proxyCheck.clear();
    }
    const hasRelay = !!effectiveRelay(s);
    proxyStreamsInput.disabled = !hasRelay;
    proxyStreamsRow.classList.toggle('is-disabled', !hasRelay);
    if (builtinHint) {
      const hint = String(s.corsProxy || '').trim() ? BUILTIN_HINT.overridden : BUILTIN_HINT.on;
      if (builtinHint.textContent !== hint) builtinHint.textContent = hint;
    }
    renderProxyTools();
    renderUsage();
    renderAmbientHint();
  }

  sync();
  const unsubscribe = store.select(
    (s) => s.settings,
    () => {
      if (!closed) sync();
    },
  );

  handle = openModal({
    title: 'Settings',
    description: 'Changes are saved automatically.',
    icon: 'settings',
    body,
    footer: [resetBtn, doneBtn],
    size: 'md',
    className: 'dlg-settings-dialog',
    initialFocus: '.md-close',
    onClose: () => {
      closed = true;
      unsubscribe();
      reducedMotion?.removeEventListener?.('change', renderAmbientHint);
      commitProxyLater.cancel();
      cancelProxyTest();
      commitProxy(false); // keep a valid relay address typed right before closing
      if (openDialogs.get('settings')?.handle === handle) openDialogs.delete('settings');
    },
  });
  openDialogs.set('settings', { handle });
  return handle;
}

// ---------------------------------------------------------------------------------------------------
// Proxy setup guide
// ---------------------------------------------------------------------------------------------------

/** The guide reopens on the platform picked last time. */
let lastGuidePlatform = 'deno';

/**
 * "Play blocked channels": why some channels are blocked on secure sites, step-by-step setup of a personal
 * stream relay (Deno Deploy or Cloudflare Workers, with the relay code ready to paste) and an inline
 * "Save & test" for its address (saves `corsProxy`, turns on `proxyStreams`, runs the health check). When the
 * site has a built-in relay, the guide is "Use your own relay" and says it's only needed for that.
 * @param {{ store: object, actions: object }} deps
 * @returns {{ el: HTMLDialogElement, close: Function,
 *   result: Promise<{ proxy: string, working: boolean } | undefined> }} modal handle; `result` resolves when
 *   the dialog closes, with the proxy saved here (and whether its health check passed) or undefined.
 */
export function openProxyGuide({ store, actions }) {
  const existing = openDialogs.get('guide');
  if (existing) return existing.handle;

  const base = uid('dlg-guide');
  const ids = {
    url: `${base}-url`,
    urlError: `${base}-url-error`,
    check: `${base}-check`,
    setup: `${base}-setup`,
    connect: `${base}-connect`,
  };
  let platform = RELAY_PLATFORMS[lastGuidePlatform] ? lastGuidePlatform : 'deno';
  let closed = false;
  let modal = null;
  /** What "Save & test" stored, reported as the dialog's result. */
  let saved = null;
  /** The running health check. */
  let test = null;
  const timers = new Set();
  const later = (fn, ms) => {
    const t = setTimeout(() => {
      timers.delete(t);
      fn();
    }, ms);
    timers.add(t);
    return t;
  };
  const cancelLater = (t) => {
    clearTimeout(t);
    timers.delete(t);
  };

  const strong = (text) => h('strong', { text });
  const code = (text) => h('code', { class: 'dlg-code', text });
  const builtin = hasBuiltinRelay();

  // The ~60 kB relay code isn't part of the app bundle: fetch it now, so "Copy relay code" can copy it
  // synchronously within the click (Safari refuses clipboard writes that wait for the network).
  loadRelaySource().catch(() => {});

  // ----- Why -----
  const fact = (name, text) => h('li', null, icon(name, { size: 14 }), h('span', { text }));
  const intro = builtin
    ? [
        h(
          'p',
          null,
          strong('You probably don’t need this. '),
          'This site already plays insecure (http://) and blocked channels through its built-in relay. Set ' +
            'up your own only if you’d rather your viewing went through a relay you control, or if the ' +
            'built-in one can’t reach a channel.',
        ),
        h(
          'p',
          null,
          strong('How it works. '),
          'Your relay fetches the stream for you and hands it to the player over a secure connection, ' +
            'instead of the built-in one. Only the channels your browser would block go through it.',
        ),
      ]
    : [
        h(
          'p',
          null,
          strong('Why some channels won’t play. '),
          'Many channels use insecure http:// links, or servers that don’t allow web players. Browsers ' +
            'block those on secure (https://) sites like this one, and no website can get around it.',
        ),
        h(
          'p',
          null,
          strong('The fix. '),
          'A personal relay fetches the stream for you and hands it to the player over a secure ' +
            'connection. Only the channels your browser would block go through it.',
        ),
      ];
  const why = h(
    'div',
    { class: 'dlg-guide-why' },
    intro,
    h(
      'ul',
      { class: 'dlg-guide-facts', 'aria-label': 'At a glance' },
      fact('check', 'Free'),
      fact('clock', 'About 5 minutes'),
      fact('link', 'Your traffic goes through your relay'),
    ),
  );

  // ----- Platforms -----
  function copyButton(key) {
    const label = h('span', { text: 'Copy relay code' });
    let resetTimer = 0;
    const btn = h(
      'button',
      { type: 'button', class: 'btn btn-secondary btn-sm dlg-copy-btn', onClick: () => copyRelay() },
      icon('copy', { size: 14 }),
      label,
    );
    async function copyRelay() {
      let source;
      try {
        source = relaySourceFor(relaySourceText || (await loadRelaySource()), key);
      } catch {
        if (!closed) toast.error('Couldn’t load the relay code. Check your connection and try again.');
        return;
      }
      if (closed) return;
      const ok = await copyText(source);
      if (closed) return;
      if (!ok) {
        toast.error('Couldn’t copy the relay code', {
          detail: 'Download it instead, then paste the file’s contents.',
          action: {
            label: 'Download',
            onClick: () => downloadText('stream-proxy.js', source, 'text/javascript'),
          },
        });
        return;
      }
      toast.success('Relay code copied', { detail: 'Paste it into the editor, replacing everything.' });
      btn.classList.add('is-done');
      setIcon(btn, 'check', { size: 14 });
      label.textContent = 'Copied';
      cancelLater(resetTimer);
      resetTimer = later(() => {
        btn.classList.remove('is-done');
        setIcon(btn, 'copy', { size: 14 });
        label.textContent = 'Copy relay code';
      }, 2200);
    }
    return btn;
  }

  const steps = (items) =>
    h(
      'ol',
      { class: 'dlg-steps' },
      items.map(([text, action]) =>
        h(
          'li',
          { class: 'dlg-step' },
          h('span', { class: 'dlg-step-text' }, text),
          action ? h('div', { class: 'dlg-step-action' }, action) : null,
        ),
      ),
    );

  const callout = (tone, iconName, text) =>
    h('p', { class: 'dlg-callout', dataset: { tone } }, icon(iconName, { size: 15 }), h('span', { text }));

  const content = {
    // Deno's dashboard changes now and then: describe each step instead of naming exact buttons.
    deno: [
      callout('success', 'check', 'Reaches every stream, including ones on IP addresses and custom ports.'),
      steps([
        [['Open ', externalLink('https://console.deno.com', 'console.deno.com'), ' and sign in. It’s free.']],
        [['Create a new ', strong('playground'), ' (or a new app).']],
        [['Copy the relay code and paste it into the editor, replacing everything.'], copyButton('deno')],
        [['Deploy it.']],
        [['Copy its public https:// address (it ends in .deno.net or .deno.dev) and paste it below.']],
      ]),
    ],
    cloudflare: [
      callout(
        'warning',
        'alert',
        'Can’t reach streams on IP addresses or custom ports — use Deno Deploy for those.',
      ),
      steps([
        [
          [
            'Open ',
            externalLink('https://dash.cloudflare.com', 'dash.cloudflare.com'),
            ' and sign in. It’s free.',
          ],
        ],
        [
          [
            'Go to ',
            strong('Workers & Pages'),
            ' → ',
            strong('Create'),
            ' → ',
            strong('Worker'),
            ', then click ',
            strong('Deploy'),
            '.',
          ],
        ],
        [
          ['Click ', strong('Edit code'), ', then paste the relay code, replacing everything.'],
          copyButton('cloudflare'),
        ],
        [['Click ', strong('Deploy'), '.']],
        [['Copy the worker’s ', code('https://….workers.dev'), ' address and paste it below.']],
      ]),
    ],
  };

  const tabs = {};
  const panels = {};
  for (const key of Object.keys(RELAY_PLATFORMS)) {
    const tabId = `${base}-tab-${key}`;
    const panelId = `${base}-panel-${key}`;
    tabs[key] = h(
      'button',
      { type: 'button', role: 'tab', id: tabId, 'aria-controls': panelId, onClick: () => select(key) },
      h('span', { text: RELAY_PLATFORMS[key].label }),
      key === 'deno' ? h('span', { class: 'dlg-tab-badge', text: 'Recommended' }) : null,
    );
    panels[key] = h(
      'div',
      { class: 'dlg-guide-panel', role: 'tabpanel', id: panelId, 'aria-labelledby': tabId },
      content[key],
    );
  }
  const keys = Object.keys(tabs);
  const tablist = h(
    'div',
    {
      class: 'segmented segmented-block dlg-tabs dlg-guide-tabs',
      role: 'tablist',
      'aria-label': 'Where to host your relay',
      onKeydown: (e) => {
        const i = keys.indexOf(platform);
        let next = null;
        if (e.key === 'ArrowRight') next = keys[(i + 1) % keys.length];
        else if (e.key === 'ArrowLeft') next = keys[(i - 1 + keys.length) % keys.length];
        else if (e.key === 'Home') next = keys[0];
        else if (e.key === 'End') next = keys[keys.length - 1];
        if (!next) return;
        e.preventDefault();
        e.stopPropagation();
        select(next, { focusTab: true });
      },
    },
    keys.map((key) => tabs[key]),
  );

  const ownServer = h(
    'p',
    { class: 'dlg-note dlg-guide-own' },
    icon('info', { size: 13 }),
    h(
      'span',
      null,
      strong('Own server or computer? '),
      'Run ',
      code('proxy/node-server.mjs'),
      ' with Node.js — on this computer the address is ',
      code('http://localhost:8787'),
      '. ',
      externalLink(RELAY_DOCS_URL, 'Relay guide on GitHub'),
    ),
  );

  // ----- Connect -----
  const urlError = errorSlot(ids.urlError);
  const check = createCheckLine(ids.check);
  const urlInput = h('input', {
    class: 'input',
    id: ids.url,
    type: 'url',
    inputmode: 'url',
    autocomplete: 'off',
    autocapitalize: 'off',
    value: String(store.get().settings?.corsProxy || ''),
    'aria-describedby': `${ids.urlError} ${ids.check}`,
    'aria-invalid': 'false',
    onInput: () => {
      setFieldError(urlError, urlInput, '');
      cancelTest();
      check.clear();
    },
  });
  urlInput.setAttribute('spellcheck', 'false');
  const saveBtn = h('button', {
    type: 'submit',
    class: 'btn btn-primary dlg-save-test',
    text: 'Save & test',
  });
  const connectForm = h(
    'form',
    {
      class: 'dlg-guide-connect',
      novalidate: true,
      onSubmit: (e) => {
        e.preventDefault();
        saveAndTest();
      },
    },
    h('label', { class: 'field-label', htmlFor: ids.url, text: 'Your relay’s address' }),
    h('div', { class: 'dlg-inline' }, urlInput, saveBtn),
    urlError,
    check.el,
  );

  const doneBtn = h('button', {
    type: 'button',
    class: 'btn btn-secondary',
    text: 'Done',
    onClick: () => modal?.close(),
  });

  // ----- Behaviour -----
  function select(next, { focusTab = false } = {}) {
    if (!tabs[next]) return;
    platform = next;
    lastGuidePlatform = next;
    for (const key of keys) {
      const on = key === next;
      tabs[key].setAttribute('aria-selected', String(on));
      tabs[key].tabIndex = on ? 0 : -1;
      panels[key].hidden = !on;
    }
    urlInput.placeholder = RELAY_PLATFORMS[next].placeholder;
    if (focusTab) tabs[next].focus();
  }

  function cancelTest() {
    if (!test) return;
    test.abort();
    test = null;
    renderTesting();
  }

  function renderTesting() {
    const busy = !!test;
    saveBtn.setAttribute('aria-disabled', String(busy));
    saveBtn.classList.toggle('is-loading', busy);
    replaceChildren(saveBtn, busy ? [spinner(), 'Testing…'] : 'Save & test');
    connectForm.setAttribute('aria-busy', String(busy));
  }

  async function saveAndTest() {
    if (closed || test) return;
    const value = urlInput.value.trim();
    const invalid = value
      ? validateProxy(value)
      : `Paste your relay’s address, for example ${RELAY_PLATFORMS[platform].placeholder}`;
    if (invalid) {
      setFieldError(urlError, urlInput, invalid);
      urlInput.focus();
      return;
    }
    setFieldError(urlError, urlInput, '');
    try {
      actions.updateSettings({ corsProxy: value, proxyStreams: true });
    } catch (err) {
      setFieldError(urlError, urlInput, messageOf(err));
      return;
    }
    saved = { proxy: value, working: false };
    const controller = new AbortController();
    test = controller;
    renderTesting();
    check.set('pending', 'Saved. Testing your relay…', value);
    const result = await checkProxyHealth(value, { signal: controller.signal });
    if (test !== controller) return; // edited, superseded or closed meanwhile
    test = null;
    renderTesting();
    if (!result) return;
    const working = result.status === 'ok' || !!result.version;
    saved.working = working;
    const message =
      result.status === 'ok' ? `${result.message}. Blocked channels will now play through it.` : result.message;
    check.set(result.status, message, value);
    doneBtn.className = working ? 'btn btn-primary' : 'btn btn-secondary';
  }

  select(platform);
  renderTesting();

  const body = h(
    'div',
    { class: 'dlg-guide' },
    why,
    h(
      'section',
      { class: 'dlg-guide-section', 'aria-labelledby': ids.setup },
      h('h3', { class: 'dlg-subtitle', id: ids.setup, text: '1 · Create your relay' }),
      tablist,
      keys.map((key) => panels[key]),
      ownServer,
    ),
    h(
      'section',
      { class: 'dlg-guide-section', 'aria-labelledby': ids.connect },
      h('h3', { class: 'dlg-subtitle', id: ids.connect, text: '2 · Connect it' }),
      connectForm,
    ),
  );

  modal = openModal({
    title: builtin ? 'Use your own relay' : 'Play blocked channels',
    icon: 'broadcast',
    description: builtin
      ? 'Optional — this site’s built-in relay already plays blocked channels.'
      : 'Your own free relay lets you watch them here too.',
    body,
    footer: [doneBtn],
    size: 'md',
    className: 'dlg-guide-dialog',
    initialFocus: tabs[platform],
    onClose: () => {
      closed = true;
      cancelTest();
      for (const t of timers) clearTimeout(t);
      timers.clear();
      if (openDialogs.get('guide')?.handle === handle) openDialogs.delete('guide');
    },
  });
  const handle = {
    el: modal.el,
    close: modal.close,
    result: modal.result.then(() => (saved ? { ...saved } : undefined)),
  };
  openDialogs.set('guide', { handle });
  return handle;
}

// ---------------------------------------------------------------------------------------------------
// Keyboard shortcuts
// ---------------------------------------------------------------------------------------------------

/**
 * Two-column cheat sheet generated from SHORTCUTS.
 * @returns {{ el: HTMLDialogElement, close: Function, result: Promise<any> }}
 */
export function openShortcutsDialog() {
  const existing = openDialogs.get('shortcuts');
  if (existing) return existing.handle;

  let handle = null;
  const items = SHORTCUTS.map((shortcut) =>
    h(
      'div',
      { class: 'dlg-key' },
      h('dt', { class: 'dlg-key-desc', text: shortcut.description }),
      h(
        'dd',
        { class: 'dlg-key-combo' },
        (shortcut.label || []).map((label, i) => [
          i > 0 ? h('span', { class: 'dlg-key-or', text: 'or' }) : null,
          h('kbd', { class: 'kbd dlg-kbd', text: label }),
        ]),
      ),
    ),
  );
  const doneBtn = h('button', {
    type: 'button',
    class: 'btn btn-secondary',
    text: 'Done',
    onClick: () => handle?.close(),
  });

  handle = openModal({
    title: 'Keyboard shortcuts',
    description: ['Press ', h('kbd', { class: 'kbd', text: '?' }), ' anytime to open this list.'],
    icon: 'keyboard',
    body: h(
      'div',
      { class: 'dlg-shortcuts' },
      h('dl', { class: 'dlg-keys' }, items),
      h('p', {
        class: 'dlg-note',
        text: 'Shortcuts pause while you’re typing in a field or a dialog is open.',
      }),
    ),
    footer: [doneBtn],
    size: 'lg',
    className: 'dlg-shortcuts-dialog',
    initialFocus: doneBtn,
    onClose: () => {
      if (openDialogs.get('shortcuts')?.handle === handle) openDialogs.delete('shortcuts');
    },
  });
  openDialogs.set('shortcuts', { handle });
  return handle;
}
