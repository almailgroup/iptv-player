// Derived state. All selectors are memoized on the identity of their inputs, so calling them
// repeatedly with an unchanged state is free.

import { CATEGORY, UNCATEGORIZED } from './constants.js';
import { streamRelay } from './relay.js';
import { naturalCompare } from '../lib/utils.js';
import { searchChannels } from '../lib/fuzzy.js';
import { staticPlayability } from '../lib/playability.js';

/** Memoize a function on the identity (Object.is) of its arguments (last call only). */
function memo(fn) {
  let lastArgs = null;
  let lastResult;
  return (...args) => {
    if (lastArgs && args.length === lastArgs.length && args.every((a, i) => Object.is(a, lastArgs[i]))) {
      return lastResult;
    }
    lastArgs = args;
    lastResult = fn(...args);
    return lastResult;
  };
}

/** Convert a stored favorite/recent snapshot into a Channel-shaped object. */
export function snapshotToChannel(snap) {
  const text = (value) => (typeof value === 'string' ? value : '');
  const group = text(snap.group) || UNCATEGORIZED;
  return {
    id: snap.id,
    index: -1,
    name: text(snap.name) || 'Untitled',
    url: snap.url,
    group,
    groups: Array.isArray(snap.groups) && snap.groups.length ? snap.groups : [group],
    logo: text(snap.logo),
    tvgId: text(snap.tvgId),
    tvgName: '',
    chno: null,
    duration: -1,
    attrs: {},
    headers: snap.headers && typeof snap.headers === 'object' ? snap.headers : {},
    drm: !!snap.drm,
    playlistId: snap.playlistId || null,
  };
}

/** Channel -> minimal snapshot persisted for favorites/recents. */
export function channelToSnapshot(channel, playlistId) {
  return {
    id: channel.id,
    name: channel.name,
    url: channel.url,
    logo: channel.logo || '',
    group: channel.group || UNCATEGORIZED,
    groups: channel.groups && channel.groups.length > 1 ? channel.groups.slice(0, 8) : undefined,
    tvgId: channel.tvgId || '',
    headers: channel.headers && Object.keys(channel.headers).length ? channel.headers : undefined,
    drm: channel.drm || undefined,
    playlistId: channel.playlistId || playlistId || null,
  };
}

const channelMap = memo((channels) => {
  const map = new Map();
  for (const ch of channels) map.set(ch.id, ch);
  return map;
});
/** @returns {Map<string, object>} id -> channel for the active playlist */
export const selectChannelMap = (state) => channelMap(state.channels);

const favoriteIds = memo((favorites) => new Set(favorites.map((f) => f.id)));
/** @returns {Set<string>} */
export const selectFavoriteIds = (state) => favoriteIds(state.favorites);

export const isFavorite = (state, id) => selectFavoriteIds(state).has(id);

export const selectActivePlaylist = (state) =>
  state.playlists.find((p) => p.id === state.activePlaylistId) || null;

const sortedGroups = memo((groups, groupSort) => {
  const list = groups.slice();
  if (groupSort === 'name') {
    list.sort((a, b) => {
      if (a.name === UNCATEGORIZED) return 1;
      if (b.name === UNCATEGORIZED) return -1;
      return naturalCompare(a.name, b.name);
    });
  }
  return list;
});
/** Groups ordered per state.groupSort ('name' = A–Z with Uncategorized last, 'playlist' = appearance order). */
export const selectSortedGroups = (state) => sortedGroups(state.groups, state.groupSort);

const resolveSnapshots = (snaps, map) => snaps.map((s) => map.get(s.id) || snapshotToChannel(s));

// Each step is memoized on its own inputs only, so e.g. playing a channel (new recents) or starring one (new
// favorites) doesn't re-sort and re-search a 20k-channel "All channels" list.
const favoriteChannels = memo(resolveSnapshots);
const recentChannels = memo(resolveSnapshots);
const groupMembers = memo((channels, name) => channels.filter((ch) => ch.groups.includes(name)));
const sortedChannels = memo((list, sort) =>
  sort === 'name' ? list.slice().sort((a, b) => naturalCompare(a.name, b.name)) : list,
);

/** Channels in the current category (before search), sorted per state.sort. */
export function selectCategoryChannels(state) {
  const { category } = state;
  // "Recently watched" is always most-recent first.
  if (category === CATEGORY.recent) return recentChannels(state.recents, selectChannelMap(state));
  let list;
  if (category === CATEGORY.favorites) list = favoriteChannels(state.favorites, selectChannelMap(state));
  else if (category.startsWith(CATEGORY.groupPrefix)) {
    list = groupMembers(state.channels, category.slice(CATEGORY.groupPrefix.length));
  } else list = state.channels;
  return sortedChannels(list, state.sort);
}

// ---- Playability ------------------------------------------------------------------------------------------

const NO_HEALTH = Object.freeze({});
const MAX_STATIC_CACHES = 4;
/**
 * `${pageProtocol}\n${relay}` -> WeakMap<channel, Playability | null>. Static results only depend on the
 * channel and these two values, so they survive health changes and are computed once per channel object.
 * Only a few combinations are kept (the relay changes rarely; the page protocol never does).
 */
const staticCaches = new Map();
/** health entry -> its frozen 'failed' result (stable identity while the entry is unchanged). */
const failedResults = new WeakMap();

function staticCacheFor(pageProtocol, relay) {
  const key = `${pageProtocol}\n${relay}`;
  let cache = staticCaches.get(key);
  if (!cache) {
    if (staticCaches.size >= MAX_STATIC_CACHES) staticCaches.delete(staticCaches.keys().next().value);
    cache = new WeakMap();
    staticCaches.set(key, cache);
  }
  return cache;
}

function failedPlayability(entry) {
  let result = failedResults.get(entry);
  if (!result) {
    result = Object.freeze({ kind: 'failed', label: 'Unavailable', title: entry.title, at: entry.at });
    failedResults.set(entry, result);
  }
  return result;
}

const playability = memo((health, relay, pageProtocol) => {
  const statics = staticCacheFor(pageProtocol, relay);
  const options = { pageProtocol, streamRelay: relay };
  return (channel) => {
    if (!channel || typeof channel !== 'object') return null;
    let result = statics.get(channel);
    if (result === undefined) {
      result = staticPlayability(channel, options);
      statics.set(channel, result);
    }
    if (result) return result;
    const entry = typeof channel.id === 'string' && Object.hasOwn(health, channel.id) ? health[channel.id] : null;
    return entry && typeof entry === 'object' ? failedPlayability(entry) : null;
  };
});
/**
 * Why a channel can't play here: the static checks of staticPlayability() (unsupported format, DRM, insecure
 * stream without a relay — these win) or a recent failure remembered in `state.health`. Memoized on
 * (state.health, stream relay, page protocol); static results are cached per channel object, so calling the
 * returned function for every rendered row (or a whole category) is cheap.
 * @returns {(channel: object) => (import('../lib/playability.js').Playability | null)} returns frozen,
 *   shared results (stable identity) — never mutate them.
 */
export const selectPlayability = (state) =>
  playability(state.health || NO_HEALTH, streamRelay(state.settings || {}), globalThis.location?.protocol);

// ---- Visible list ------------------------------------------------------------------------------------------

/** True when both arrays hold the same items in the same order. */
function sameItems(a, b) {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// Hiding unplayable channels runs in two steps so that switching channels doesn't refilter a 20k list: the
// filter depends on the list and the playability only; the current channel (never hidden) is put back in a
// second step that is free unless the current channel itself is unplayable.
const playableChannels = memo((list, playabilityOf) => {
  const removed = new Set();
  const channels = [];
  for (const channel of list) {
    if (playabilityOf(channel)) removed.add(channel.id);
    else channels.push(channel);
  }
  return { channels: removed.size ? channels : list, removed };
});

// While the outcome is unchanged (e.g. a channel outside this category failed, or the current one did and
// stays on screen) the previous array is returned, so the fuzzy search and the list render aren't redone.
let lastPlayable = null;
const withCurrentChannel = memo((list, playable, currentId) => {
  let channels = playable.channels;
  if (currentId !== null && playable.removed.has(currentId)) {
    channels = list.filter((channel) => channel.id === currentId || !playable.removed.has(channel.id));
  }
  if (channels !== list && lastPlayable && sameItems(lastPlayable, channels)) channels = lastPlayable;
  lastPlayable = channels;
  return channels;
});

const visible = memo((list, query, total, hidden) => {
  const q = query.trim();
  if (!q) return { items: list.map((channel) => ({ channel, indices: null })), total, hidden, query: '' };
  const results = searchChannels(list, q) || [];
  return {
    items: results.map((r) => ({ channel: r.channel, indices: r.indices })),
    total,
    hidden,
    query: q,
  };
});
/**
 * The list the channel panel renders: category channels filtered/ranked by the fuzzy query. With
 * `settings.hideUnplayable`, channels with a non-null selectPlayability() result are left out before
 * searching — except the current channel, which always stays.
 * @returns {{ items: Array<{ channel: object, indices: number[] | null }>, total: number, hidden: number,
 *   query: string }} `total` is the category size before hiding and searching; `hidden` is how many of those
 *   were hidden as unplayable; `indices` are matched positions in channel.name.
 */
export function selectVisibleChannels(state) {
  const list = selectCategoryChannels(state);
  if (!state.settings?.hideUnplayable) return visible(list, state.query, list.length, 0);
  const playable = playableChannels(list, selectPlayability(state));
  const channels = withCurrentChannel(list, playable, state.currentChannel?.id ?? null);
  return visible(channels, state.query, list.length, list.length - channels.length);
}

// ---- Player shelf (up next / recently watched / favorites) -------------------------------------------------

/** The most tiles a shelf tab shows: the shelf is a glance, not a second channel list. */
export const SHELF_LIMIT = 24;

const upNext = memo((items, currentId, playabilityOf, limit) => {
  const count = items.length;
  if (!count) return { channels: [], next: null };
  // Same order as playNext(): the channels after the current one (wrapping), or from the top of the list when
  // the current channel isn't in it (or nothing plays).
  const index = currentId === null ? -1 : items.findIndex((item) => item.channel.id === currentId);
  const start = index + 1;
  const first = items[start % count].channel;
  const channels = [];
  for (let k = 0; k < count && channels.length < limit; k++) {
    const channel = items[(start + k) % count].channel;
    if (channel.id !== currentId && !playabilityOf(channel)) channels.push(channel);
  }
  return { channels, next: first.id === currentId ? null : first };
});
/**
 * What plays after the current channel, for the player's "Up next" shelf: the visible list's following
 * channels (wrapping around), skipping the current channel and every channel selectPlayability() flags.
 * @returns {{ channels: object[], next: object | null }} at most `limit` channels; `next` is the channel
 *   playNext() would pick (it doesn't skip unplayable ones), null when that is the current channel itself.
 *   Memoized: the same object while the list, the current channel and the playability are unchanged.
 */
export const selectUpNext = (state, limit = SHELF_LIMIT) =>
  upNext(selectVisibleChannels(state).items, state.currentChannel?.id ?? null, selectPlayability(state), limit);

/** Recently watched channels, most recent first, resolved against the active playlist (state.recents order). */
export const selectRecentChannels = (state) => recentChannels(state.recents, selectChannelMap(state));

/** Favorite channels in the order they were starred, resolved against the active playlist. */
export const selectFavoriteChannels = (state) => favoriteChannels(state.favorites, selectChannelMap(state));

/** Human label for the current category. */
export function selectCategoryLabel(state) {
  const { category } = state;
  if (category === CATEGORY.favorites) return 'Favorites';
  if (category === CATEGORY.recent) return 'Recently watched';
  if (category.startsWith(CATEGORY.groupPrefix)) return category.slice(CATEGORY.groupPrefix.length);
  return 'All channels';
}

/** True if the given category id still exists for the current state (groups can disappear on refresh). */
export function categoryExists(state, category) {
  if (category === CATEGORY.all || category === CATEGORY.favorites || category === CATEGORY.recent) return true;
  if (!category.startsWith(CATEGORY.groupPrefix)) return false;
  const name = category.slice(CATEGORY.groupPrefix.length);
  return state.groups.some((g) => g.name === name);
}
