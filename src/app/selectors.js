// Derived state. All selectors are memoized on the identity of their inputs, so calling them
// repeatedly with an unchanged state is free.

import { CATEGORY, UNCATEGORIZED } from './constants.js';
import { naturalCompare } from '../lib/utils.js';
import { searchChannels } from '../lib/fuzzy.js';

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

const visible = memo((list, query) => {
  const q = query.trim();
  if (!q) return { items: list.map((channel) => ({ channel, indices: null })), total: list.length, query: '' };
  const results = searchChannels(list, q) || [];
  return {
    items: results.map((r) => ({ channel: r.channel, indices: r.indices })),
    total: list.length,
    query: q,
  };
});
/**
 * The list the channel panel renders: category channels filtered/ranked by the fuzzy query.
 * @returns {{ items: Array<{ channel: object, indices: number[] | null }>, total: number, query: string }}
 *   `total` is the category size before searching; `indices` are matched positions in channel.name.
 */
export const selectVisibleChannels = (state) => visible(selectCategoryChannels(state), state.query);

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
