// App dialogs: Add playlist, Playlist manager, Settings and Keyboard shortcuts.
// Everything is built with h() (text nodes only) — playlist names, URLs and file names are untrusted.

import { DEFAULT_SETTINGS, SUGGESTED_PLAYLISTS } from '../app/constants.js';
import { SHORTCUTS } from '../app/shortcuts-list.js';
import { h, replaceChildren } from '../lib/dom.js';
import { estimateUsage } from '../lib/storage.js';
import { clamp, debounce, formatBytes, formatCount, isHttpUrl, uid } from '../lib/utils.js';
import { icon, setIcon } from './icons.js';
import { confirmDialog, openModal, promptDialog } from './modal.js';
import { createThemePicker } from './theme.js';

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

const displayUrl = (url) => String(url).replace(/^https?:\/\//i, '');

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

/** Label row + control + optional error slot. */
function field({ id, label, control, error, optional = false }) {
  return h(
    'div',
    { class: 'field' },
    h(
      'div',
      { class: 'dlg-label-row' },
      h('label', { class: 'field-label', htmlFor: id, text: label }),
      optional ? h('span', { class: 'dlg-optional', text: 'Optional' }) : null,
    ),
    control,
    error || null,
  );
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
    icon('link', { size: 15 }),
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
    icon('upload', { size: 15 }),
    h('span', { text: 'File' }),
  );
  const tabs = h(
    'div',
    {
      class: 'segmented dlg-tabs',
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
    field({ id: ids.url, label: 'Playlist URL', control: urlInput, error: urlError }),
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
          SUGGESTED_PLAYLISTS.map((s) => {
            const btn = h(
              'button',
              {
                type: 'button',
                class: 'dlg-suggest-item',
                title: s.url,
                'aria-label': `Load ${s.name}`,
                onClick: () => useSuggestion(s),
              },
              h('span', { class: 'dlg-suggest-icon', 'aria-hidden': 'true' }, icon('broadcast', { size: 15 })),
              h(
                'span',
                { class: 'dlg-suggest-text' },
                h('span', { class: 'dlg-suggest-name truncate', text: s.name }),
                h('span', { class: 'dlg-suggest-url truncate', text: displayUrl(s.url) }),
              ),
              icon('arrow-right', { size: 16, class: 'dlg-suggest-go' }),
            );
            suggestionButtons.push(btn);
            return h('li', null, btn);
          }),
        ),
        h(
          'p',
          { class: 'dlg-note' },
          icon('info', { size: 13 }),
          h('span', { text: 'Community playlists from iptv-org (third-party). Availability varies.' }),
        ),
      )
    : null;

  const demoError = errorSlot(ids.demoError);
  const demoBtn = h('button', {
    type: 'button',
    class: 'btn btn-ghost btn-sm dlg-demo-btn',
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
  const dropIcon = h('span', { class: 'dlg-drop-icon', 'aria-hidden': 'true' }, icon('upload', { size: 22 }));
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
      kind === 'demo' ? 'Loading demo…' : 'Load demo channels',
    );
    panelUrl.setAttribute('aria-busy', String(kind === 'url' || kind === 'demo'));
    panelFile.setAttribute('aria-busy', String(kind === 'file'));
    status.textContent = busy ? busyMessage() : '';
    handle?.el.toggleAttribute('data-loading', busy);
  }

  function renderDrop() {
    drop.classList.toggle('has-file', !!selectedFile);
    if (selectedFile) {
      setIcon(dropIcon, 'file', { size: 22 });
      dropTitle.textContent = selectedFile.name || 'Playlist file';
      replaceChildren(
        dropHint,
        `${formatBytes(selectedFile.size)} · `,
        h('span', { class: 'dlg-drop-link', text: 'Choose another' }),
        ' or drop to replace',
      );
    } else {
      setIcon(dropIcon, 'upload', { size: 22 });
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
    description: 'Load an M3U / M3U8 playlist from a link or from a file on this device.',
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
// Settings
// ---------------------------------------------------------------------------------------------------

/** Empty is fine (disabled); otherwise an absolute http(s) URL that the page is allowed to call. */
function validateProxy(value) {
  if (!value) return '';
  if (!isHttpUrl(value)) return 'Enter a full http(s) address, for example https://corsproxy.example/?url=';
  if (globalThis.location?.protocol === 'https:' && /^http:/i.test(value)) {
    return 'Use an https:// proxy — browsers block insecure requests from secure pages.';
  }
  return '';
}

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
  const retriesRow = h(
    'div',
    { class: 'dlg-row dlg-row-sub' },
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
    retries,
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

  // ----- CORS proxy -----
  const proxyId = uid('dlg-set-proxy');
  const proxyError = errorSlot(`${proxyId}-error`);
  const proxyInput = h('input', {
    class: 'input',
    type: 'url',
    id: proxyId,
    inputmode: 'url',
    autocomplete: 'off',
    autocapitalize: 'off',
    placeholder: 'https://corsproxy.example/?url=',
    'aria-describedby': `${proxyId}-hint ${proxyId}-error`,
    'aria-invalid': 'false',
    onInput: () => {
      setFieldError(proxyError, proxyInput, '');
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
  const proxyRow = h(
    'div',
    { class: 'dlg-row dlg-row-stack' },
    h(
      'span',
      { class: 'dlg-row-text' },
      h('label', { class: 'dlg-row-label', htmlFor: proxyId, text: 'CORS proxy (optional)' }),
      h('span', {
        class: 'dlg-row-hint',
        id: `${proxyId}-hint`,
        text:
          'Used only for downloading playlists that block cross-origin requests. Example: ' +
          'https://corsproxy.example/?url= — leave empty to disable.',
      }),
    ),
    proxyInput,
    proxyError,
  );

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
      title: 'Reset settings?',
      message:
        'Playback, library and network settings go back to their defaults. ' +
        'Playlists, favorites and your theme are kept.',
      confirmLabel: 'Reset',
    });
    if (ok) {
      setFieldError(proxyError, proxyInput, '');
      apply({ ...DEFAULT_SETTINGS });
    }
  }

  // ----- Layout -----
  const section = (title, children, cardClass) => {
    const id = uid('dlg-sec');
    return h(
      'section',
      { class: 'dlg-section', 'aria-labelledby': id },
      h('h3', { class: 'dlg-section-title', id, text: title }),
      h('div', { class: ['dlg-card', cardClass] }, children),
    );
  };

  const body = h(
    'div',
    { class: 'dlg-settings' },
    section('Playback', [
      switchRow('autoplay', 'Autoplay', 'Start playback as soon as you pick a channel.'),
      switchRow('autoReconnect', 'Auto-reconnect', 'Retry automatically when a stream drops or stalls.'),
      retriesRow,
      switchRow(
        'upgradeInsecure',
        'Upgrade HTTP streams to HTTPS',
        'On secure pages, try an https:// address first for http:// streams.',
      ),
      switchRow('lowLatency', 'Low-latency mode', 'Stay closer to the live edge on low-latency HLS streams.'),
      switchRow(
        'preferNativeHls',
        'Prefer native HLS',
        'Use the browser’s built-in HLS playback when available (Safari).',
      ),
    ]),
    section('Library', [
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
    section('Network', [proxyRow]),
    section(
      'Appearance',
      [h('div', { class: 'dlg-card-pad' }, createThemePicker({ store, actions }))],
      'dlg-card-plain',
    ),
    section('Data', [dataRow]),
  );

  function sync() {
    const s = settings();
    for (const { key, input } of switches) input.checked = !!s[key];
    const reconnect = !!s.autoReconnect;
    retries.disabled = !reconnect;
    retriesRow.classList.toggle('is-disabled', !reconnect);
    if (document.activeElement !== retries) retries.value = String(s.maxRetries);
    renderRefreshOptions(Number(s.autoRefreshHours));
    // Don't clobber what the user is typing (or an invalid value they still need to fix).
    if (document.activeElement !== proxyInput && !proxyError.textContent) proxyInput.value = s.corsProxy || '';
    renderUsage();
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
    body,
    footer: [resetBtn, doneBtn],
    size: 'md',
    className: 'dlg-settings-dialog',
    initialFocus: '.md-close',
    onClose: () => {
      closed = true;
      unsubscribe();
      commitProxyLater.cancel();
      commitProxy(false); // keep a valid proxy typed right before closing
      if (openDialogs.get('settings')?.handle === handle) openDialogs.delete('settings');
    },
  });
  openDialogs.set('settings', { handle });
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
          h('kbd', { class: 'kbd', text: label }),
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
