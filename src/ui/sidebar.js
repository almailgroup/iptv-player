// Library sidebar (mounted into #sidebar): brand, playlist switcher, library navigation, the playlist's
// groups (sortable, filterable) and a footer with appearance / settings / shortcuts buttons.

import { h, clear, replaceChildren, on } from '../lib/dom.js';
import { formatCount } from '../lib/utils.js';
import { APP_NAME, CATEGORY } from '../app/constants.js';
import { selectActivePlaylist, selectSortedGroups } from '../app/selectors.js';
import { icon } from './icons.js';
import { openMenu } from './popover.js';
import { createThemeSwitcher } from './theme.js';
import {
  openAddPlaylistDialog,
  openPlaylistManager,
  openSettingsDialog,
  openShortcutsDialog,
} from './dialogs.js';

/** Show the group filter only when there are more groups than this. */
const FILTER_THRESHOLD = 10;
/** Below this width the sidebar is an off-canvas drawer (see layout.css). */
const DRAWER_QUERY = '(max-width: 1100px)';

const LIBRARY = [
  { cat: CATEGORY.all, label: 'All channels', icon: 'list' },
  { cat: CATEGORY.favorites, label: 'Favorites', icon: 'star' },
  { cat: CATEGORY.recent, label: 'Recently watched', icon: 'clock' },
];

const channelsLabel = (n) => `${formatCount(n)} ${n === 1 ? 'channel' : 'channels'}`;
const ignoreRejection = (value) => Promise.resolve(value).catch(() => {});

/** Case- and diacritic-insensitive folding for the local group filter. */
function fold(str) {
  return String(str)
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase();
}

/**
 * Create the sidebar.
 * @param {{ store: ReturnType<import('../app/store.js').createStore>, actions: Record<string, Function> }} deps
 * @returns {{ el: HTMLElement, destroy: () => void }}
 */
export function createSidebar({ store, actions }) {
  const disposers = [];
  const listen = (target, type, fn, opts) => disposers.push(on(target, type, fn, opts));
  let destroyed = false;

  const drawerMql = typeof matchMedia === 'function' ? matchMedia(DRAWER_QUERY) : null;
  const isDrawer = () => !!drawerMql?.matches;

  // ---- Brand ---------------------------------------------------------------------------------------
  const brand = h(
    'div',
    { class: 'sb-brand' },
    h('span', { class: 'sb-logo', 'aria-hidden': 'true' }, icon('logo', { size: 18 })),
    h('span', { class: 'sb-wordmark', text: APP_NAME }),
    h(
      'button',
      {
        type: 'button',
        class: 'icon-btn sb-close',
        'aria-label': 'Close library',
        title: 'Close',
        onClick: () => actions.setSidebarOpen(false),
      },
      icon('close'),
    ),
  );

  // ---- Playlist switcher ---------------------------------------------------------------------------
  const swIcon = h('span', { class: 'sb-switcher-icon', 'aria-hidden': 'true' });
  const swName = h('span', { class: 'sb-switcher-name truncate' });
  const swMeta = h('span', { class: 'sb-switcher-meta truncate' });
  const switcher = h(
    'button',
    { type: 'button', class: 'sb-switcher', 'aria-expanded': 'false', onClick: onSwitcherClick },
    swIcon,
    h('span', { class: 'sb-switcher-text' }, swName, swMeta),
    icon('chevron-down', { size: 16, class: 'sb-switcher-chevron' }),
  );
  let swIconKind = '';

  function setSwitcherIcon(kind) {
    if (kind === swIconKind) return;
    swIconKind = kind;
    replaceChildren(
      swIcon,
      kind === 'busy'
        ? h('span', { class: 'spinner spinner-sm' })
        : icon(kind === 'add' ? 'plus' : 'layers', { size: 16 }),
    );
  }

  function renderSwitcher(state) {
    const playlists = state.playlists;
    const active = selectActivePlaylist(state);
    const hasPlaylists = playlists.length > 0;
    const failed = !!(active && state.playlistError && state.playlistError.playlistId === active.id);

    let name;
    let meta;
    if (!hasPlaylists) {
      name = 'Add a playlist';
      meta = 'M3U link or file';
    } else if (!active) {
      name = 'Choose a playlist';
      meta = `${formatCount(playlists.length)} saved`;
    } else {
      name = active.name || 'Untitled playlist';
      const count = state.channels.length || active.channelCount || 0;
      meta = failed ? 'Couldn’t load' : channelsLabel(count);
    }
    if (state.busy) meta = state.busy.message || 'Loading…';

    setSwitcherIcon(state.busy ? 'busy' : hasPlaylists ? 'playlist' : 'add');
    swName.textContent = name;
    swMeta.textContent = meta;
    swMeta.classList.toggle('is-error', failed && !state.busy);
    switcher.classList.toggle('is-empty', !hasPlaylists);
    switcher.setAttribute('aria-haspopup', hasPlaylists ? 'menu' : 'dialog');
    switcher.setAttribute('aria-label', hasPlaylists ? `Playlist: ${name}, ${meta}` : 'Add a playlist');
    switcher.title = hasPlaylists ? 'Switch playlist' : 'Add a playlist';
    if (state.busy) switcher.setAttribute('aria-busy', 'true');
    else switcher.removeAttribute('aria-busy');
  }

  function onSwitcherClick() {
    const state = store.get();
    if (!state.playlists.length) {
      openAddPlaylistDialog({ store, actions });
      return;
    }
    const active = selectActivePlaylist(state);
    const items = [{ type: 'label', label: 'Playlists' }];
    for (const playlist of state.playlists) {
      items.push({
        label: playlist.name || 'Untitled playlist',
        checked: playlist.id === state.activePlaylistId,
        hint: formatCount(playlist.channelCount || 0),
        onSelect: () => {
          if (playlist.id !== store.get().activePlaylistId)
            ignoreRejection(actions.switchPlaylist(playlist.id));
        },
      });
    }
    items.push({ type: 'separator' });
    if (active?.source?.kind === 'url') {
      items.push({
        label: 'Refresh playlist',
        icon: 'refresh',
        disabled: !!state.busy,
        onSelect: () => ignoreRejection(actions.refreshPlaylist(active.id)),
      });
    }
    items.push(
      { label: 'Add playlist…', icon: 'plus', onSelect: () => openAddPlaylistDialog({ store, actions }) },
      { label: 'Manage playlists…', icon: 'folder', onSelect: () => openPlaylistManager({ store, actions }) },
    );
    openMenu({
      anchor: switcher,
      items,
      placement: 'bottom-start',
      label: 'Playlists',
      className: 'sb-menu',
    });
  }

  const playlistRow = h('div', { class: 'sb-playlist' }, switcher);

  // ---- Library nav ---------------------------------------------------------------------------------
  /** category -> { btn, count, label } for library items */
  const libraryItems = new Map();
  const libraryList = h('ul', { class: 'sb-nav', role: 'list' });
  for (const item of LIBRARY) {
    const count = h('span', { class: 'count sb-count', 'aria-hidden': 'true' });
    const btn = h(
      'button',
      { type: 'button', class: 'sb-item', dataset: { cat: item.cat } },
      icon(item.icon, { size: 18, class: 'sb-item-icon' }),
      h('span', { class: 'sb-item-label truncate', text: item.label }),
      count,
    );
    libraryItems.set(item.cat, { btn, count, label: item.label });
    libraryList.append(h('li', null, btn));
  }

  function renderCounts(state) {
    const values = {
      [CATEGORY.all]: state.channels.length,
      [CATEGORY.favorites]: state.favorites.length,
      [CATEGORY.recent]: state.recents.length,
    };
    for (const [cat, { btn, count, label }] of libraryItems) {
      const n = values[cat] || 0;
      const text = n > 0 ? formatCount(n) : '';
      if (count.textContent !== text) count.textContent = text;
      btn.setAttribute('aria-label', n > 0 ? `${label}, ${channelsLabel(n)}` : label);
    }
  }

  // ---- Groups --------------------------------------------------------------------------------------
  const groupsCount = h('span', { class: 'count sb-groups-count' });
  const sortBtn = h(
    'button',
    {
      type: 'button',
      class: 'icon-btn icon-btn-sm sb-sort',
      onClick: () => actions.setGroupSort(store.get().groupSort === 'name' ? 'playlist' : 'name'),
    },
    icon('sort', { size: 16 }),
  );
  const filterInput = h('input', {
    type: 'search',
    class: 'input input-sm sb-filter-input',
    placeholder: 'Filter groups…',
    autocomplete: 'off',
    'aria-label': 'Filter groups',
    'aria-controls': 'sb-groups',
    enterkeyhint: 'go',
  });
  filterInput.spellcheck = false;
  const filterClear = h(
    'button',
    {
      type: 'button',
      class: 'icon-btn icon-btn-sm sb-filter-clear',
      'aria-label': 'Clear filter',
      title: 'Clear filter',
      hidden: true,
      onClick: () => {
        setFilter('');
        filterInput.focus({ preventScroll: true });
      },
    },
    icon('close', { size: 14 }),
  );
  const filterWrap = h(
    'div',
    { class: 'input-group sb-filter', hidden: true },
    icon('filter', { size: 14 }),
    filterInput,
    h('div', { class: 'input-trailing' }, filterClear),
  );
  const groupsTitle = h('h2', { class: 'sb-section-title', id: 'sb-groups-title', text: 'Groups' });
  const groupsHead = h(
    'div',
    { class: 'sb-groups-head' },
    h(
      'div',
      { class: 'sb-section-head' },
      groupsTitle,
      groupsCount,
      h('span', { class: 'sb-spacer' }),
      sortBtn,
    ),
    filterWrap,
  );
  const groupList = h('ul', {
    class: 'sb-nav sb-group-list',
    id: 'sb-groups',
    role: 'list',
    'aria-labelledby': 'sb-groups-title',
  });
  const groupsEmpty = h('p', { class: 'sb-empty', hidden: true });
  const groupsSection = h('section', { class: 'sb-section sb-groups' }, groupsHead, groupList, groupsEmpty);

  /** @type {Array<{ li: HTMLElement, btn: HTMLButtonElement, fold: string, cat: string }>} */
  let groupEntries = [];
  /** category -> group button */
  let groupButtons = new Map();
  let renderedGroups = null;
  let groupTabStop = null;

  function renderGroups(groups) {
    // Keep keyboard focus on the same group when the list is rebuilt (sort change, playlist refresh).
    const focused = groupList.contains(document.activeElement) ? document.activeElement.dataset.cat : null;
    renderedGroups = groups;
    groupEntries = [];
    groupButtons = new Map();
    groupTabStop = null;
    const frag = document.createDocumentFragment();
    for (const group of groups) {
      const cat = CATEGORY.groupPrefix + group.name;
      const btn = h(
        'button',
        {
          type: 'button',
          class: 'sb-item sb-group',
          dataset: { cat },
          tabIndex: -1,
          'aria-label': `${group.name}, ${channelsLabel(group.count)}`,
        },
        h('span', { class: 'sb-item-label truncate', title: group.name, text: group.name }),
        h('span', { class: 'count sb-count', 'aria-hidden': 'true', text: formatCount(group.count) }),
      );
      const li = h('li', { class: 'sb-group-li' }, btn);
      groupEntries.push({ li, btn, fold: fold(group.name), cat });
      groupButtons.set(cat, btn);
      frag.append(li);
    }
    replaceChildren(groupList, frag);

    groupsCount.textContent = groups.length ? formatCount(groups.length) : '';
    sortBtn.hidden = groups.length < 2;
    const filterable = groups.length > FILTER_THRESHOLD;
    filterWrap.hidden = !filterable;
    if (!filterable && filterInput.value) filterInput.value = '';
    applyFilter();
    const refocus = focused ? groupButtons.get(focused) : null;
    if (refocus && !refocus.parentElement.hidden) focusItem(refocus);
  }

  function applyFilter() {
    const raw = filterInput.value.trim();
    const q = fold(raw);
    let shown = 0;
    for (const entry of groupEntries) {
      const match = !q || entry.fold.includes(q);
      if (entry.li.hidden === match) entry.li.hidden = !match;
      if (match) shown++;
    }
    filterClear.hidden = !filterInput.value;
    if (!groupEntries.length) {
      groupsEmpty.textContent = 'No groups';
      groupsEmpty.hidden = false;
    } else if (!shown) {
      groupsEmpty.textContent = `No groups match “${raw.length > 32 ? `${raw.slice(0, 31)}…` : raw}”`;
      groupsEmpty.hidden = false;
    } else groupsEmpty.hidden = true;
    updateGroupTabStop();
  }

  function setFilter(value) {
    filterInput.value = value;
    applyFilter();
  }

  /** Roving tabindex: the group list is a single Tab stop (active group, else the first visible one). */
  function updateGroupTabStop() {
    const visibleBtn = (btn) => btn && !btn.parentElement.hidden;
    let next = activeBtn && groupButtons.get(activeBtn.dataset.cat) === activeBtn ? activeBtn : null;
    if (!visibleBtn(next)) next = groupEntries.find((e) => !e.li.hidden)?.btn || null;
    if (next === groupTabStop) return;
    if (groupTabStop) groupTabStop.tabIndex = -1;
    groupTabStop = next;
    if (next) next.tabIndex = 0;
  }

  function moveGroupTabStop(btn) {
    if (!groupButtons.has(btn.dataset.cat) || btn === groupTabStop) return;
    if (groupTabStop) groupTabStop.tabIndex = -1;
    groupTabStop = btn;
    btn.tabIndex = 0;
  }

  // ---- Active category -----------------------------------------------------------------------------
  let activeBtn = null;

  function setActive(category, { reveal = false } = {}) {
    const next = libraryItems.get(category)?.btn || groupButtons.get(category) || null;
    if (next !== activeBtn) {
      if (activeBtn) {
        activeBtn.classList.remove('is-active');
        activeBtn.removeAttribute('aria-current');
      }
      activeBtn = next;
      if (activeBtn) {
        activeBtn.classList.add('is-active');
        activeBtn.setAttribute('aria-current', 'page');
      }
    }
    updateGroupTabStop();
    if (reveal && activeBtn && groupButtons.has(category) && !activeBtn.parentElement.hidden)
      revealInScroller(activeBtn);
  }

  /** Scroll `btn` into view inside the sidebar scroller only (never the page), clear of the sticky head. */
  function revealInScroller(btn) {
    if (!scroller.clientHeight) return;
    const box = btn.getBoundingClientRect();
    const view = scroller.getBoundingClientRect();
    const minTop = Math.max(view.top, groupsHead.getBoundingClientRect().bottom);
    if (box.top < minTop) scroller.scrollTop -= minTop - box.top + 4;
    else if (box.bottom > view.bottom) scroller.scrollTop += box.bottom - view.bottom + 4;
  }

  function selectCategory(category) {
    actions.setCategory(category);
    if (isDrawer()) actions.setSidebarOpen(false);
  }

  // ---- Scroll area + navigation keyboard -----------------------------------------------------------
  const scroller = h(
    'nav',
    { class: 'sb-scroll', 'aria-label': 'Categories' },
    h('section', { class: 'sb-section sb-library' }, libraryList),
    groupsSection,
  );

  listen(scroller, 'click', (e) => {
    const btn = e.target instanceof Element ? e.target.closest('.sb-item') : null;
    if (!btn || !scroller.contains(btn) || !btn.dataset.cat) return;
    moveGroupTabStop(btn);
    selectCategory(btn.dataset.cat);
  });

  function navigableItems() {
    const list = [...libraryItems.values()].map((v) => v.btn);
    for (const entry of groupEntries) if (!entry.li.hidden) list.push(entry.btn);
    return list;
  }

  function focusItem(btn) {
    if (!btn) return;
    moveGroupTabStop(btn);
    btn.focus({ preventScroll: true });
    revealInScroller(btn);
  }

  listen(scroller, 'keydown', (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const current = e.target instanceof Element ? e.target.closest('.sb-item') : null;
    if (!current) return;
    const all = navigableItems();
    const index = all.indexOf(current);
    if (index < 0) return;
    let next = null;
    const isFirstGroup =
      groupButtons.has(current.dataset.cat) && !groupButtons.has(all[index - 1]?.dataset.cat);
    if (e.key === 'ArrowDown') next = all[Math.min(all.length - 1, index + 1)];
    else if (e.key === 'ArrowUp' && isFirstGroup && !filterWrap.hidden) {
      // From the first group, ArrowUp goes back to the group filter when it's shown.
      e.preventDefault();
      e.stopPropagation();
      filterInput.focus({ preventScroll: true });
      return;
    } else if (e.key === 'ArrowUp') next = all[Math.max(0, index - 1)];
    else if (e.key === 'Home') next = all[0];
    else if (e.key === 'End') next = all[all.length - 1];
    else return;
    // Handled: don't let global shortcuts (volume on ↑/↓) act on these keys.
    e.preventDefault();
    e.stopPropagation();
    focusItem(next);
  });

  listen(filterInput, 'input', applyFilter);
  listen(filterInput, 'keydown', (e) => {
    if (e.isComposing || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === 'Escape') {
      if (!filterInput.value) return;
      e.preventDefault();
      e.stopPropagation();
      setFilter('');
    } else if (e.key === 'ArrowDown') {
      const first = groupEntries.find((entry) => !entry.li.hidden);
      if (!first) return;
      e.preventDefault();
      e.stopPropagation();
      focusItem(first.btn);
    } else if (e.key === 'Enter') {
      const first = groupEntries.find((entry) => !entry.li.hidden);
      if (!first) return;
      e.preventDefault();
      moveGroupTabStop(first.btn);
      selectCategory(first.cat);
    }
  });

  // ---- Footer --------------------------------------------------------------------------------------
  const footer = h(
    'div',
    { class: 'sb-footer' },
    createThemeSwitcher({ store, actions }),
    h(
      'button',
      {
        type: 'button',
        class: 'icon-btn',
        'aria-label': 'Settings',
        title: 'Settings',
        onClick: () => openSettingsDialog({ store, actions }),
      },
      icon('settings'),
    ),
    h(
      'button',
      {
        type: 'button',
        class: 'icon-btn sb-shortcuts-btn',
        'aria-label': 'Keyboard shortcuts',
        'aria-keyshortcuts': '?',
        title: 'Keyboard shortcuts (?)',
        onClick: () => openShortcutsDialog(),
      },
      icon('keyboard'),
    ),
  );

  const el = h('div', { class: 'sb' }, brand, playlistRow, scroller, footer);

  // ---- Store sync ----------------------------------------------------------------------------------
  function updateSortButton(groupSort) {
    const label =
      groupSort === 'name'
        ? 'Groups sorted A–Z · switch to playlist order'
        : 'Groups in playlist order · sort A–Z';
    sortBtn.setAttribute('aria-label', label);
    sortBtn.title = label;
  }

  function update(state, prev) {
    if (destroyed) return;
    if (
      !prev ||
      state.playlists !== prev.playlists ||
      state.activePlaylistId !== prev.activePlaylistId ||
      state.busy !== prev.busy ||
      state.playlistError !== prev.playlistError ||
      state.channels !== prev.channels
    ) {
      renderSwitcher(state);
    }
    if (
      !prev ||
      state.channels !== prev.channels ||
      state.favorites !== prev.favorites ||
      state.recents !== prev.recents
    ) {
      renderCounts(state);
    }
    let groupsChanged = false;
    if (!prev || state.groups !== prev.groups || state.groupSort !== prev.groupSort) {
      const groups = selectSortedGroups(state);
      if (groups !== renderedGroups) {
        renderGroups(groups);
        groupsChanged = true;
      }
    }
    if (!prev || state.groupSort !== prev.groupSort) updateSortButton(state.groupSort);
    if (!prev || groupsChanged || state.category !== prev.category) {
      // Reveal the active group when the category changes from elsewhere (e.g. a group chip in the player).
      setActive(state.category, { reveal: !!prev && state.category !== prev.category });
    }
  }

  const unsubscribe = store.subscribe(update);
  update(store.get(), null);

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    unsubscribe();
    for (const off of disposers.splice(0)) off();
    clear(groupList);
    groupEntries = [];
    groupButtons = new Map();
    el.remove();
  }

  return { el, destroy };
}
