// Channel list panel (mounted into #channels): a header with the category title, counts, sort menu,
// library actions and the search field, above a virtualized, keyboard-navigable listbox of channels.
//
// Rendering is driven entirely by the store: the list re-renders when `selectVisibleChannels()` changes
// identity, and repaints visible rows in place when favorites, the current channel, `showLogos` or channel
// playability (selectPlayability(): unsupported formats, DRM, insecure streams, recent failures) change.

import { h, clear, replaceChildren, on } from '../lib/dom.js';
import { clamp, debounce, formatCount, hueFromString, initials, safeImageUrl } from '../lib/utils.js';
import { highlight } from '../lib/fuzzy.js';
import { CATEGORY } from '../app/constants.js';
import {
  selectActivePlaylist,
  selectCategoryLabel,
  selectFavoriteIds,
  selectPlayability,
  selectVisibleChannels,
} from '../app/selectors.js';
import { icon, setIcon } from './icons.js';
import { openMenu } from './popover.js';
import { createVirtualList } from './virtual-list.js';
import { openAddPlaylistDialog, openPlaylistManager } from './dialogs.js';

const ROW_HEIGHT = 56;
const OVERSCAN = 8;
const SEARCH_DEBOUNCE_MS = 60;
const ANNOUNCE_DELAY_MS = 600;
/** Searching inside a sub-category with fewer results than this offers "Search all channels". */
const FEW_RESULTS = 5;
const SKELETON_ROWS = 6;
const SKELETON_WIDTHS = [
  [64, 34],
  [48, 26],
  [72, 40],
  [56, 22],
  [42, 30],
  [66, 28],
];
const MAX_FAILED_LOGOS = 5000;
/** PlayerState values published by the player view as `state.playbackState` (anything else = idle). */
const PLAYBACK_STATES = new Set(['idle', 'loading', 'playing', 'paused', 'buffering', 'reconnecting', 'error']);
const playbackOf = (state) => (PLAYBACK_STATES.has(state.playbackState) ? state.playbackState : 'idle');
const NOW_PLAYING_LABEL = { paused: 'paused', error: 'playback failed' };

/** Store keys whose changes can affect this panel (everything else, e.g. volume, is ignored). */
const WATCHED_KEYS = [
  'ready',
  'busy',
  'playlists',
  'activePlaylistId',
  'playlistError',
  'channels',
  'groups',
  'category',
  'query',
  'sort',
  'favorites',
  'recents',
  'currentChannel',
  'settings',
  'health',
  'sidebarOpen',
];

/**
 * Logo URLs that failed to load once. Recycled rows showing the same channel again go straight to the
 * initials fallback instead of re-requesting (and flashing) a broken image.
 */
const failedLogos = new Set();
function rememberFailedLogo(url) {
  if (failedLogos.size >= MAX_FAILED_LOGOS) failedLogos.clear();
  failedLogos.add(url);
}

const plural = (n, one, many) => `${formatCount(n)} ${n === 1 ? one : many}`;
const ellipsize = (str, max) => (str.length > max ? `${str.slice(0, max - 1).trimEnd()}…` : str);
const ignoreRejection = (value) => Promise.resolve(value).catch(() => {});

/** "just now", "5 min ago", "3 h ago" — remembered failures expire after hours, so that's all it needs. */
function timeAgo(at, now = Date.now()) {
  if (!Number.isFinite(at)) return '';
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return 'just now'; // includes small clock skew into the future
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.floor(hours / 24)} days ago`;
}

/** A playability flag's tooltip: its reason, plus when it happened for remembered failures. */
function flagTitle(flag) {
  const when = flag.kind === 'failed' ? timeAgo(flag.at) : '';
  return when ? `${flag.title} · ${when}` : flag.title;
}

/** The same reason for the row's accessible name (one clause of a comma-separated label). */
function flagLabel(flag) {
  const reason = String(flag.title || '').replace(/[.\s]+$/, '');
  if (flag.kind !== 'failed') return reason || flag.label;
  return reason ? `unavailable: ${reason}` : 'unavailable';
}

/**
 * Create the channel list panel.
 * @param {{ store: ReturnType<import('../app/store.js').createStore>, actions: Record<string, Function> }} deps
 * @returns {{
 *   el: HTMLElement,
 *   focusSearch: () => void,
 *   clearSearch: () => void,
 *   scrollToCurrent: () => boolean,
 *   destroy: () => void,
 * }}
 */
export function createChannelList({ store, actions }) {
  // ---- Mirrored state ------------------------------------------------------------------------------
  let visible = null; // last selectVisibleChannels() result
  let items = []; // visible.items — kept in sync with the virtual list
  let favIds = new Set();
  let currentId = null;
  let showLogos = true;
  let playabilityOf = () => null; // selectPlayability() — why a channel can't play here (null = it can)
  let playback = 'idle'; // playback state of the current channel (drives its equalizer)
  let activePlaylistId = null;
  let cursor = -1; // keyboard cursor: index into items, -1 = none
  let modeKey = '';
  let selfQuery = false; // true while we push the search field's value into the store
  let pointerFocus = false;
  let destroyed = false;
  const disposers = [];
  const listen = (target, type, fn, opts) => disposers.push(on(target, type, fn, opts));

  // ---- Header --------------------------------------------------------------------------------------
  const menuBtn = h(
    'button',
    {
      type: 'button',
      class: 'icon-btn cl-menu-btn',
      'aria-label': 'Open library',
      title: 'Library',
      'aria-controls': 'sidebar',
      'aria-expanded': 'false',
      onClick: () => actions.setSidebarOpen(true),
    },
    icon('menu'),
  );
  const titleEl = h('h2', { class: 'cl-title truncate', id: 'cl-title' });
  const countEl = h('p', { class: 'cl-count truncate' });

  const exportBtn = h(
    'button',
    {
      type: 'button',
      class: 'icon-btn cl-action',
      'aria-label': 'Export favorites as M3U',
      title: 'Export favorites (.m3u)',
      hidden: true,
      onClick: () => actions.exportFavorites(),
    },
    icon('download'),
  );
  const clearRecentsBtn = h(
    'button',
    {
      type: 'button',
      class: 'icon-btn cl-action',
      'aria-label': 'Clear watch history',
      title: 'Clear recently watched',
      hidden: true,
      onClick: () => {
        // Keep keyboard focus somewhere sensible: this button is disabled once the history is empty.
        if (document.activeElement === clearRecentsBtn) input.focus({ preventScroll: true });
        actions.clearRecents();
      },
    },
    icon('trash'),
  );
  // Sort order and the "Hide unplayable channels" filter (only the filter in Recently watched).
  const sortBtn = h(
    'button',
    {
      type: 'button',
      class: 'icon-btn cl-sort-btn',
      'aria-label': 'Sort and filter channels',
      'aria-haspopup': 'menu',
      'aria-expanded': 'false',
      onClick: openSortMenu,
    },
    icon('sort'),
  );
  sortBtn.dataset.icon = 'sort';

  const input = h('input', {
    type: 'search',
    id: 'cl-search',
    class: 'input cl-search-input',
    placeholder: 'Search channels',
    autocomplete: 'off',
    'aria-label': 'Search channels',
    'aria-controls': 'cl-listbox',
    'aria-keyshortcuts': '/',
    enterkeyhint: 'search',
    maxlength: 200, // matches the controller's query cap
    autocapitalize: 'off',
    autocorrect: 'off',
  });
  input.spellcheck = false;
  const clearBtn = h(
    'button',
    {
      type: 'button',
      class: 'icon-btn icon-btn-sm cl-search-clear',
      'aria-label': 'Clear search',
      title: 'Clear search (Esc)',
      hidden: true,
      onClick: () => {
        clearSearch();
        input.focus({ preventScroll: true });
      },
    },
    icon('close', { size: 16 }),
  );
  const kbdHint = h('kbd', {
    class: 'kbd cl-kbd',
    'aria-hidden': 'true',
    title: 'Press / to search',
    text: '/',
  });
  const searchGroup = h(
    'div',
    { class: 'input-group cl-search', role: 'search' },
    icon('search', { size: 16 }),
    input,
    h('div', { class: 'input-trailing' }, clearBtn, kbdHint),
  );

  const scopeText = h('span', { class: 'cl-scope-text truncate' });
  const scopeBar = h(
    'div',
    { class: 'cl-scope', hidden: true },
    scopeText,
    h(
      'button',
      { type: 'button', class: 'cl-link', onClick: searchAllChannels },
      'Search all channels',
      icon('arrow-right', { size: 14 }),
    ),
  );
  const live = h('div', {
    class: 'visually-hidden',
    role: 'status',
    'aria-live': 'polite',
    'aria-atomic': 'true',
  });

  const header = h(
    'header',
    { class: 'cl-header' },
    h(
      'div',
      { class: 'cl-head' },
      menuBtn,
      h('div', { class: 'cl-heading' }, titleEl, countEl),
      h('div', { class: 'cl-actions' }, exportBtn, clearRecentsBtn, sortBtn),
    ),
    searchGroup,
    scopeBar,
    live,
  );

  // ---- List ----------------------------------------------------------------------------------------
  /** Per-row element refs and the values they currently display (for cheap diffing on recycle). */
  const rowRefs = new WeakMap();

  const vl = createVirtualList({
    rowHeight: ROW_HEIGHT,
    overscan: OVERSCAN,
    renderRow,
    getKey: (item) => item.channel.id,
    onRangeChange: syncActiveDescendant,
    className: 'cl-list',
  });
  const list = vl.el;
  list.id = 'cl-listbox';
  list.tabIndex = 0;
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', 'Channels');

  const emptyEl = h('div', { class: 'cl-empty', hidden: true });
  const skeletonEl = buildSkeleton();
  const body = h('div', { class: 'cl-body' }, list, emptyEl, skeletonEl);
  const el = h('div', { class: 'cl' }, header, body);

  function createRow() {
    const avatar = h('span', { class: 'avatar cl-avatar', 'aria-hidden': 'true' });
    const name = h('span', { class: 'cl-name truncate' });
    const meta = h('span', { class: 'cl-meta truncate' });
    const star = h(
      'button',
      {
        type: 'button',
        class: 'icon-btn icon-btn-sm cl-star',
        tabIndex: -1,
        // Pointer shortcut only: options can't own interactive children, and the row's label already
        // says "favorite". Keyboard / AT users star channels from the now-playing card or with `s`.
        'aria-hidden': 'true',
        'aria-pressed': 'false',
        'aria-label': 'Add to favorites',
        title: 'Add to favorites',
        // Keep focus (and the listbox's active descendant) where it is when the star is clicked.
        onMousedown: (e) => e.preventDefault(),
      },
      icon('star', { size: 16 }),
    );
    const row = h(
      'div',
      { class: 'cl-row', role: 'option', 'aria-selected': 'false' },
      avatar,
      h('span', { class: 'cl-text' }, name, meta),
      h('span', { class: 'cl-eq', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')),
      star,
    );
    rowRefs.set(row, {
      avatar,
      name,
      meta,
      star,
      img: null,
      logo: null,
      channel: null,
      indices: undefined,
      index: -1,
      setsize: -1,
      other: null,
      flag: undefined,
      fav: null,
      current: null,
      playback: '',
      cursor: null,
      label: '',
    });
    return row;
  }

  /** Virtual list row renderer — idempotent; only touches the DOM for values that changed. */
  function renderRow(item, index, existing) {
    const row = existing || createRow();
    const r = rowRefs.get(row);
    const { channel, indices } = item;

    const id = `cl-opt-${index}`;
    if (row.id !== id) row.id = id; // the virtual list strips ids from pooled rows
    if (r.index !== index) {
      r.index = index;
      row.dataset.index = String(index);
      row.setAttribute('aria-posinset', String(index + 1));
    }
    if (r.setsize !== items.length) {
      r.setsize = items.length;
      row.setAttribute('aria-setsize', String(items.length));
    }

    const channelChanged = r.channel !== channel;
    if (channelChanged || r.indices !== indices) {
      if (indices && indices.length) replaceChildren(r.name, highlight(channel.name, indices));
      else r.name.textContent = channel.name;
      r.indices = indices;
    }
    if (channelChanged) r.name.title = channel.name;

    const other = isFromOtherPlaylist(channel);
    const flag = playabilityOf(channel); // frozen, shared results: identity changes only with the reason
    if (channelChanged || r.other !== other || r.flag !== flag) {
      renderMeta(r.meta, channel, other, flag);
      r.other = other;
    }
    if (r.flag !== flag) {
      r.flag = flag;
      row.classList.toggle('is-unplayable', !!flag);
      if (flag) row.dataset.flag = flag.kind;
      else delete row.dataset.flag;
    }

    const logo = showLogos ? safeImageUrl(channel.logo) : '';
    if (channelChanged || r.logo !== logo) renderAvatar(r, channel, logo);
    r.channel = channel;

    const fav = favIds.has(channel.id);
    if (r.fav !== fav) {
      r.fav = fav;
      const label = fav ? 'Remove from favorites' : 'Add to favorites';
      r.star.setAttribute('aria-pressed', String(fav));
      r.star.setAttribute('aria-label', label);
      r.star.title = label;
      setIcon(r.star, fav ? 'star-filled' : 'star', { size: 16 });
    }

    const current = channel.id === currentId;
    if (r.current !== current) {
      r.current = current;
      row.classList.toggle('is-current', current);
      if (current) row.setAttribute('aria-current', 'true');
      else row.removeAttribute('aria-current');
    }
    // CSS animates the equalizer only while playing; other states freeze it (error: danger-colored).
    const rowPlayback = current ? playback : '';
    if (r.playback !== rowPlayback) {
      r.playback = rowPlayback;
      if (rowPlayback) row.dataset.playback = rowPlayback;
      else delete row.dataset.playback;
    }

    const isCursor = index === cursor;
    if (r.cursor !== isCursor) {
      r.cursor = isCursor;
      row.classList.toggle('is-cursor', isCursor);
      row.setAttribute('aria-selected', String(isCursor));
    }

    const label = [
      channel.name,
      channel.group,
      channel.chno != null ? `channel ${channel.chno}` : '',
      flag ? flagLabel(flag) : '',
      other ? 'from another playlist' : '',
      current ? NOW_PLAYING_LABEL[playback] || 'now playing' : '',
      fav ? 'favorite' : '',
    ]
      .filter(Boolean)
      .join(', ');
    if (r.label !== label) {
      r.label = label;
      row.setAttribute('aria-label', label);
    }
    return row;
  }

  function isFromOtherPlaylist(channel) {
    return channel.index === -1 && !!channel.playlistId && channel.playlistId !== activePlaylistId;
  }

  function renderMeta(metaEl, channel, other, flag) {
    clear(metaEl);
    // The flag leads the line so a long group name can't truncate it away.
    if (flag) {
      metaEl.append(
        h('span', { class: 'cl-flag', dataset: { kind: flag.kind }, text: flag.label, title: flagTitle(flag) }),
      );
    }
    const text = [channel.group, channel.chno != null ? `#${channel.chno}` : ''].filter(Boolean).join(' · ');
    if (text) metaEl.append(text);
    if (other) {
      const source = store.get().playlists.find((p) => p.id === channel.playlistId);
      metaEl.append(
        h('span', {
          class: 'cl-tag',
          text: 'Other playlist',
          title: source ? `From “${source.name}”` : 'From another playlist',
        }),
      );
    }
  }

  /**
   * Show the channel's logo, or its initials when there is none / it fails. A fresh <img> is created for
   * every new logo so a recycled row never shows the previous channel's picture while the next one loads.
   */
  function renderAvatar(r, channel, logo) {
    const { avatar } = r;
    const previous = r.img;
    r.logo = logo;
    r.img = null;
    // Cancel the recycled row's logo download: after a fast flick through a long list, hundreds of
    // requests for rows that are long gone would otherwise queue ahead of the logos now on screen.
    if (previous && !previous.complete) previous.removeAttribute('src');
    clear(avatar);
    if (!logo || failedLogos.has(logo)) {
      showInitials(r, channel.name);
      return;
    }
    avatar.className = 'avatar cl-avatar';
    avatar.style.removeProperty('--hue');
    const img = h('img', { alt: '', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer' });
    img.draggable = false;
    img.addEventListener('load', () => {
      if (r.img === img) avatar.classList.add('is-loaded');
    });
    img.addEventListener('error', () => {
      if (r.img !== img) return; // replaced (and possibly cancelled) — not a broken logo
      rememberFailedLogo(logo);
      showInitials(r, channel.name);
    });
    r.img = img;
    img.src = logo;
    avatar.append(img);
    // Already decoded (memory cache): show immediately, without the fade-in.
    if (img.complete && img.naturalWidth > 0) avatar.classList.add('is-loaded');
  }

  function showInitials(r, name) {
    const { avatar } = r;
    r.img = null;
    avatar.className = 'avatar avatar-fallback cl-avatar';
    avatar.style.setProperty('--hue', String(hueFromString(name)));
    avatar.textContent = initials(name);
  }

  function buildSkeleton() {
    const rows = SKELETON_WIDTHS.slice(0, SKELETON_ROWS).map(([a, b]) =>
      h(
        'div',
        { class: 'cl-skel-row' },
        h('span', { class: 'skeleton cl-skel-avatar' }),
        h(
          'span',
          { class: 'cl-skel-lines' },
          h('span', { class: 'skeleton cl-skel-line', style: { width: `${a}%` } }),
          h('span', { class: 'skeleton cl-skel-line cl-skel-line-sm', style: { width: `${b}%` } }),
        ),
      ),
    );
    return h('div', { class: 'cl-skeleton', 'aria-hidden': 'true', hidden: true }, rows);
  }

  // ---- Cursor / active descendant ------------------------------------------------------------------
  function repaintRow(index) {
    if (index < 0 || !items[index]) return;
    const row = vl.getRow(index);
    if (row) renderRow(items[index], index, row);
  }

  function syncActiveDescendant() {
    const row = cursor >= 0 ? vl.getRow(cursor) : null;
    const id = row && row.id ? row.id : null;
    if (list.getAttribute('aria-activedescendant') === id) return;
    if (id) list.setAttribute('aria-activedescendant', id);
    else list.removeAttribute('aria-activedescendant');
  }

  function setCursor(next, { scroll = true, align = 'auto' } = {}) {
    const target = items.length ? clamp(Math.trunc(next), -1, items.length - 1) : -1;
    const prev = cursor;
    cursor = target;
    if (scroll && target >= 0) vl.scrollToIndex(target, align); // newly mounted rows read `cursor`
    if (prev !== target) {
      repaintRow(prev);
      repaintRow(target);
    }
    syncActiveDescendant();
  }

  const isOnScreen = (index, range) => index >= 0 && index >= range.visibleStart && index <= range.visibleEnd;

  function moveCursor(delta) {
    if (!items.length) return;
    const range = vl.getRange();
    // A cursor that was scrolled out of view restarts from the visible page instead of jumping back.
    const next = isOnScreen(cursor, range)
      ? cursor + delta
      : delta > 0
        ? range.visibleStart
        : range.visibleEnd;
    setCursor(clamp(next, 0, items.length - 1));
  }

  function playCursor() {
    const item = items[cursor];
    if (item) actions.playChannel(item.channel);
  }

  // ---- List events ---------------------------------------------------------------------------------
  /** True when the list got focus from the keyboard (Tab, or our own ArrowDown from the search field). */
  function isKeyboardFocus() {
    if (pointerFocus) return false;
    try {
      return list.matches(':focus-visible');
    } catch {
      return true;
    }
  }
  const endPointer = () =>
    setTimeout(() => {
      pointerFocus = false;
    }, 0);
  listen(list, 'pointerdown', () => {
    pointerFocus = true;
    list.classList.remove('is-kbd');
  });
  listen(list, 'pointerup', endPointer);
  listen(list, 'pointercancel', endPointer);

  listen(list, 'focus', () => {
    if (!items.length || !isKeyboardFocus()) return;
    list.classList.add('is-kbd');
    const range = vl.getRange();
    if (isOnScreen(cursor, range)) {
      syncActiveDescendant();
      return;
    }
    const current = currentId ? vl.indexOfKey(currentId) : -1;
    setCursor(isOnScreen(current, range) ? current : range.visibleStart);
  });

  listen(list, 'blur', () => list.classList.remove('is-kbd'));

  // A remembered failure's tooltip says how long ago it happened: refresh it as the pointer reaches it.
  listen(list, 'pointerover', (e) => {
    const chip = e.target instanceof Element ? e.target.closest('.cl-flag[data-kind="failed"]') : null;
    const row = chip?.closest('.cl-row');
    const flag = row ? rowRefs.get(row)?.flag : null;
    if (!flag) return;
    const title = flagTitle(flag);
    if (chip.title !== title) chip.title = title;
  });

  listen(list, 'click', (e) => {
    const target = e.target instanceof Element ? e.target : null;
    const row = target ? target.closest('.cl-row') : null;
    if (!row || !list.contains(row)) return;
    const index = Number(row.dataset.index);
    const item = items[index];
    if (!item) return;
    if (target.closest('.cl-star')) {
      e.stopPropagation();
      actions.toggleFavorite(item.channel);
      return;
    }
    setCursor(index, { scroll: false });
    actions.playChannel(item.channel);
  });

  listen(list, 'keydown', (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey || e.isComposing) return;
    const n = items.length;
    if (!n) return;
    switch (e.key) {
      case 'ArrowDown':
        moveCursor(1);
        break;
      case 'ArrowUp':
        if (cursor === 0) focusSearch(false);
        else moveCursor(-1);
        break;
      case 'PageDown':
        moveCursor(vl.pageSize());
        break;
      case 'PageUp':
        moveCursor(-vl.pageSize());
        break;
      case 'Home':
        setCursor(0, { align: 'start' });
        break;
      case 'End':
        setCursor(n - 1, { align: 'end' });
        break;
      case 'Enter':
        if (!e.repeat) playCursor();
        break;
      case 'Escape':
        focusSearch(false);
        break;
      default:
        return;
    }
    // Handled here: keep the global shortcut handler (volume, channel zapping…) out of it.
    e.preventDefault();
    e.stopPropagation();
    if (document.activeElement === list) list.classList.add('is-kbd');
  });

  // ---- Search --------------------------------------------------------------------------------------
  const pushQuery = debounce((value) => {
    if (destroyed) return;
    selfQuery = true;
    try {
      actions.setQuery(value);
    } finally {
      selfQuery = false;
    }
  }, SEARCH_DEBOUNCE_MS);

  const announce = debounce((text) => {
    live.textContent = text;
  }, ANNOUNCE_DELAY_MS);

  function syncSearchChrome() {
    const hasValue = input.value.length > 0;
    clearBtn.hidden = !hasValue;
    kbdHint.hidden = hasValue;
    searchGroup.classList.toggle('has-value', hasValue);
  }

  listen(input, 'input', (e) => {
    syncSearchChrome();
    if (e.isComposing) return; // wait for compositionend (IME)
    pushQuery(input.value);
  });
  listen(input, 'compositionend', () => pushQuery(input.value));

  listen(input, 'keydown', (e) => {
    if (e.isComposing || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === 'Escape') {
      if (!input.value) return; // let the global handler blur / close panels
      e.preventDefault();
      e.stopPropagation();
      clearSearch();
    } else if (e.key === 'ArrowDown') {
      pushQuery.flush(input.value);
      if (!items.length || list.hidden) return;
      e.preventDefault();
      const range = vl.getRange();
      setCursor(isOnScreen(cursor, range) ? cursor : range.visibleStart);
      list.focus({ preventScroll: true });
      list.classList.add('is-kbd');
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pushQuery.flush(input.value);
      const item = items[cursor >= 0 ? cursor : 0];
      if (item) actions.playChannel(item.channel);
    }
  });

  function searchAllChannels() {
    pushQuery.flush(input.value);
    actions.setCategory(CATEGORY.all);
    input.focus({ preventScroll: true });
  }

  /** Focus the search field (selecting its text by default). */
  function focusSearch(select = true) {
    input.focus({ preventScroll: true });
    if (select) input.select();
  }

  /** Clear the search field and the store query. */
  function clearSearch() {
    pushQuery.cancel();
    if (input.value) input.value = '';
    syncSearchChrome();
    if (store.get().query) {
      selfQuery = true;
      try {
        actions.setQuery('');
      } finally {
        selfQuery = false;
      }
    }
  }

  // ---- Header actions ------------------------------------------------------------------------------
  function sortLabel(state, sort = state.sort) {
    if (sort === 'name') return 'Name A–Z';
    return state.category === CATEGORY.favorites ? 'Date added' : 'Playlist order';
  }

  const isHiding = (state) => !!state.settings?.hideUnplayable;
  const showUnplayable = () => actions.updateSettings({ hideUnplayable: false });

  function openSortMenu() {
    const state = store.get();
    // Recently watched is always ordered by time — only the filter applies there.
    const sortable = state.category !== CATEGORY.recent;
    const handle = openMenu({
      anchor: sortBtn,
      placement: 'bottom-end',
      label: sortable ? 'Sort and filter channels' : 'Filter channels',
      className: 'cl-sort-menu',
      items: [
        ...(sortable
          ? [
              { type: 'label', label: 'Sort by' },
              {
                label: sortLabel(state, 'playlist'),
                checked: state.sort !== 'name',
                onSelect: () => actions.setSort('playlist'),
              },
              {
                label: sortLabel(state, 'name'),
                checked: state.sort === 'name',
                onSelect: () => actions.setSort('name'),
              },
              { type: 'separator' },
            ]
          : []),
        {
          label: 'Hide unplayable channels',
          icon: 'filter',
          checked: isHiding(state),
          onSelect: () => actions.updateSettings({ hideUnplayable: !isHiding(store.get()) }),
        },
      ],
    });
    // openMenu renders `checked` items as radios; this one is an on/off toggle (the only item outside the
    // "Sort by" group).
    handle?.el.querySelector('.menu > .menu-item')?.setAttribute('role', 'menuitemcheckbox');
  }

  // ---- Body states (list / skeleton / empty states) ------------------------------------------------
  function computeMode(state, v) {
    if (v.items.length) return 'list';
    if (!state.ready) return 'loading';
    const library = state.category === CATEGORY.favorites || state.category === CATEGORY.recent;
    if (!library && !state.channels.length) {
      if (state.busy) return 'loading';
      if (!state.playlists.length) return 'no-playlist';
      if (!selectActivePlaylist(state)) return 'no-active';
      if (state.playlistError && state.playlistError.playlistId === state.activePlaylistId) return 'error';
    }
    if (v.query) return 'no-results';
    if (v.hidden > 0) return 'all-hidden';
    if (state.category === CATEGORY.favorites) return 'no-favorites';
    if (state.category === CATEGORY.recent) return 'no-recents';
    return 'empty';
  }

  function emptyState(iconName, title, text, buttons = []) {
    return h(
      'div',
      { class: 'empty-state cl-empty-state' },
      h('div', { class: 'empty-state-icon', 'aria-hidden': 'true' }, icon(iconName, { size: 22 })),
      h('h3', { text: title }),
      text ? h('p', { text }) : null,
      buttons.length ? h('div', { class: 'empty-state-actions' }, buttons) : null,
    );
  }

  const button = (label, variant, onClick, iconName) =>
    h(
      'button',
      { type: 'button', class: ['btn', 'btn-sm', `btn-${variant}`], onClick },
      iconName ? icon(iconName, { size: 16 }) : null,
      label,
    );

  function buildEmpty(mode, state, v) {
    const openAdd = () => openAddPlaylistDialog({ store, actions });
    const openManager = () => openPlaylistManager({ store, actions });
    switch (mode) {
      case 'no-playlist':
        return emptyState(
          'tv',
          'No playlist loaded',
          'Add an M3U playlist by link or file to start watching.',
          [
            button('Add playlist', 'primary', openAdd, 'plus'),
            button('Try demo channels', 'secondary', () => ignoreRejection(actions.addDemoPlaylist())),
          ],
        );
      case 'no-active':
        return emptyState(
          'layers',
          'No playlist selected',
          'Choose one of your saved playlists to browse it.',
          [button('Manage playlists', 'secondary', openManager)],
        );
      case 'error': {
        const active = selectActivePlaylist(state);
        const canRetry = active?.source?.kind === 'url';
        return emptyState(
          'alert',
          'Couldn’t load this playlist',
          state.playlistError?.message || 'The playlist could not be loaded.',
          [
            canRetry
              ? button(
                  'Retry',
                  'primary',
                  () => ignoreRejection(actions.refreshPlaylist(active.id)),
                  'refresh',
                )
              : null,
            button('Manage playlists', 'secondary', openManager),
          ].filter(Boolean),
        );
      }
      case 'no-results': {
        const inSubCategory = state.category !== CATEGORY.all;
        const hidden = v.hidden > 0;
        const text = inSubCategory
          ? `Nothing in ${selectCategoryLabel(state)} matches. Try all channels or different words.`
          : 'Check the spelling or try fewer words.';
        // No-break space: the count shouldn't end a line on its own.
        const hiddenNote = `${formatCount(v.hidden)}\u00a0${
          v.hidden === 1 ? 'unplayable channel is' : 'unplayable channels are'
        } hidden.`;
        return emptyState(
          'search',
          `No matches for “${ellipsize(v.query, 48)}”`,
          hidden ? `${text} ${hiddenNote}` : text,
          [
            inSubCategory ? button('Search all channels', 'primary', searchAllChannels) : null,
            button('Clear search', 'secondary', () => {
              clearSearch();
              input.focus({ preventScroll: true });
            }),
            hidden ? button('Show hidden', 'ghost', showUnplayable) : null,
          ].filter(Boolean),
        );
      }
      case 'all-hidden': {
        const where = state.category === CATEGORY.all ? 'this playlist' : selectCategoryLabel(state);
        return emptyState(
          'filter',
          'No playable channels',
          v.hidden === 1
            ? `The only channel in ${where} can’t play here, so it’s hidden.`
            : `All ${formatCount(v.hidden)}\u00a0channels in ${where} can’t play here, so they’re hidden.`,
          [button(v.hidden === 1 ? 'Show it anyway' : 'Show them anyway', 'secondary', showUnplayable)],
        );
      }
      case 'no-favorites':
        return emptyState('star', 'No favorites yet', 'Star channels to pin them here.');
      case 'no-recents':
        return emptyState('clock', 'Nothing watched yet', 'Channels you play will show up here.');
      default:
        return emptyState(
          'tv',
          'No channels',
          state.category.startsWith(CATEGORY.groupPrefix)
            ? 'This group is empty.'
            : 'This playlist has no channels.',
        );
    }
  }

  function renderBody(mode, state, v) {
    const isList = mode === 'list';
    const isLoading = mode === 'loading';
    if (list.hidden === isList) {
      const hadFocus = document.activeElement === list;
      list.hidden = !isList;
      if (hadFocus && !isList) input.focus({ preventScroll: true });
    }
    skeletonEl.hidden = !isLoading;
    emptyEl.hidden = isList || isLoading;
    body.setAttribute('aria-busy', String(isLoading));

    let key = mode;
    if (mode === 'no-results') key += `|${v.query}|${state.category}|${v.hidden}`;
    else if (mode === 'all-hidden') key += `|${state.category}|${v.hidden}`;
    else if (mode === 'error') key += `|${state.playlistError?.message}|${state.activePlaylistId}`;
    else if (mode === 'empty') key += `|${state.category}`;
    if (key === modeKey) return;
    modeKey = key;
    if (isList || isLoading) clear(emptyEl);
    else replaceChildren(emptyEl, buildEmpty(mode, state, v));
  }

  function renderHeader(state, v, mode) {
    const label = selectCategoryLabel(state);
    if (titleEl.textContent !== label) {
      titleEl.textContent = label;
      titleEl.title = label;
      list.setAttribute('aria-label', label);
    }

    // Counts exclude hidden (unplayable) channels, which get their own "· N hidden".
    const hidden = v.hidden > 0 ? v.hidden : 0;
    const shown = v.total - hidden;
    let count;
    if (mode === 'loading') count = state.busy?.message || 'Loading channels…';
    else if (mode === 'no-playlist' || mode === 'no-active' || mode === 'error') count = '';
    else {
      count = v.query
        ? `${formatCount(v.items.length)} of ${formatCount(shown)}`
        : plural(shown, 'channel', 'channels');
      if (hidden) count += ` · ${formatCount(hidden)} hidden`;
    }
    if (countEl.textContent !== count) countEl.textContent = count;
    const countTitle = hidden && count ? `${plural(hidden, 'channel', 'channels')} that can’t play here` : '';
    if (countEl.title !== countTitle) countEl.title = countTitle;

    const cat = state.category;
    exportBtn.hidden = cat !== CATEGORY.favorites;
    exportBtn.disabled = !state.favorites.length;
    clearRecentsBtn.hidden = cat !== CATEGORY.recent;
    clearRecentsBtn.disabled = !state.recents.length;
    // Recently watched is always ordered by time: there the menu only holds the filter.
    const sortable = cat !== CATEGORY.recent;
    const sorted = sortable && state.sort === 'name';
    const hiding = isHiding(state);
    const menuIcon = sortable ? 'sort' : 'filter';
    if (sortBtn.dataset.icon !== menuIcon) {
      sortBtn.dataset.icon = menuIcon;
      setIcon(sortBtn, menuIcon);
    }
    // A quiet accent dot whenever the list isn't in its default order / unfiltered.
    sortBtn.classList.toggle('is-sorted', sorted || hiding);
    const menuLabel = sortable ? 'Sort and filter channels' : 'Filter channels';
    if (sortBtn.getAttribute('aria-label') !== menuLabel) sortBtn.setAttribute('aria-label', menuLabel);
    const filterNote = hiding ? 'unplayable channels hidden' : '';
    sortBtn.title = sortable
      ? [`Sort: ${sortLabel(state)}`, filterNote].filter(Boolean).join(' · ')
      : `Filter${filterNote ? `: ${filterNote}` : ''}`;
    menuBtn.setAttribute('aria-expanded', String(!!state.sidebarOpen));

    const showScope = mode === 'list' && !!v.query && cat !== CATEGORY.all && v.items.length < FEW_RESULTS;
    scopeBar.hidden = !showScope;
    if (showScope) {
      scopeText.textContent = `${plural(v.items.length, 'match', 'matches')} in ${label}`;
    }
  }

  // ---- Store sync ----------------------------------------------------------------------------------
  function followCurrent() {
    if (!currentId) return;
    const index = vl.indexOfKey(currentId);
    if (index >= 0) vl.scrollToIndex(index, 'auto');
  }

  /** Mirror `state.playbackState`; returns true when it changed. */
  function syncPlayback(state) {
    const next = playbackOf(state);
    if (next === playback) return false;
    playback = next;
    return true;
  }

  /** Repaint only the current channel's row (equalizer + label) — playback state changes often. */
  function repaintCurrent() {
    if (currentId) repaintRow(vl.indexOfKey(currentId));
  }

  function update(state, prev) {
    if (destroyed) return;
    if (prev && WATCHED_KEYS.every((k) => state[k] === prev[k])) {
      if (syncPlayback(state)) repaintCurrent();
      return;
    }
    const playbackChanged = syncPlayback(state);

    const v = selectVisibleChannels(state);
    const nextFav = selectFavoriteIds(state);
    const nextCurrent = state.currentChannel ? state.currentChannel.id : null;
    const nextLogos = state.settings ? state.settings.showLogos !== false : true;
    // Memoized on (health, stream relay, page protocol): a new function means some flags may have changed.
    const nextPlayability = selectPlayability(state);
    const prevVisible = visible;
    const listChanged = v !== prevVisible;
    const currentChanged = nextCurrent !== currentId;
    const rowsDirty =
      currentChanged ||
      nextFav !== favIds ||
      nextLogos !== showLogos ||
      nextPlayability !== playabilityOf ||
      state.activePlaylistId !== activePlaylistId;
    favIds = nextFav;
    currentId = nextCurrent;
    showLogos = nextLogos;
    playabilityOf = nextPlayability;
    activePlaylistId = state.activePlaylistId;

    // Search field <- store (external changes only, e.g. shortcuts or a playlist switch).
    if (!prev || state.query !== prev.query) {
      const query = state.query || '';
      if (!selfQuery && input.value.trim() !== query.trim()) {
        pushQuery.cancel();
        input.value = query;
      }
      syncSearchChrome();
    }

    // Show/hide the listbox first so scroll positions below are applied to a laid-out viewport.
    const mode = computeMode(state, v);
    renderBody(mode, state, v);

    if (listChanged) {
      const contextChanged =
        !prev ||
        !prevVisible ||
        state.category !== prev.category ||
        state.activePlaylistId !== prev.activePlaylistId;
      const firstFill = !prevVisible || prevVisible.items.length === 0;
      const reset = contextChanged || firstFill || state.sort !== prev.sort || v.query !== prevVisible.query;
      const keepKey = !reset && cursor >= 0 && items[cursor] ? items[cursor].channel.id : null;

      visible = v;
      items = v.items;
      cursor = -1;
      vl.setItems(items, { keepScroll: !reset });

      if (keepKey) {
        const index = vl.indexOfKey(keepKey);
        if (index >= 0) setCursor(index, { scroll: false });
        else syncActiveDescendant();
      } else syncActiveDescendant();

      if (reset) {
        // New context: bring the playing channel into view (search results always start at the top).
        if ((contextChanged || firstFill) && !v.query && currentId) {
          const index = vl.indexOfKey(currentId);
          if (index >= 0) vl.scrollToIndex(index, 'center');
        }
      } else if (currentChanged) followCurrent();

      if (v.query) {
        announce(
          v.items.length
            ? `${plural(v.items.length, 'channel', 'channels')} found`
            : `No channels match “${ellipsize(v.query, 48)}”`,
        );
      } else {
        announce.cancel();
        live.textContent = '';
      }
    } else if (rowsDirty) {
      vl.refresh();
      if (currentChanged) followCurrent();
    } else if (playbackChanged) repaintCurrent();

    renderHeader(state, v, mode);
  }

  const unsubscribe = store.subscribe(update);
  update(store.get(), null);

  // ---- Public API ----------------------------------------------------------------------------------
  /** Center the current channel in the list. Returns false when it isn't in the visible list. */
  function scrollToCurrent() {
    if (!currentId) return false;
    const index = vl.indexOfKey(currentId);
    if (index < 0) return false;
    vl.scrollToIndex(index, 'center');
    return true;
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    unsubscribe();
    pushQuery.cancel();
    announce.cancel();
    for (const off of disposers.splice(0)) off();
    vl.destroy();
    el.remove();
  }

  return {
    el,
    focusSearch: () => focusSearch(true),
    clearSearch,
    scrollToCurrent,
    destroy,
  };
}
