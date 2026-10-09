// Selector tests: category / sort / search derivation and memoization (src/app/selectors.js).

import { describe, expect, it } from 'vitest';
import { CATEGORY, UNCATEGORIZED } from '../src/app/constants.js';
import {
  categoryExists,
  selectCategoryChannels,
  selectVisibleChannels,
  snapshotToChannel,
} from '../src/app/selectors.js';
import { groupChannels, parseM3U } from '../src/lib/m3u.js';

const PLAYLIST = [
  '#EXTM3U',
  '#EXTINF:-1 group-title="News;World",Zulu News',
  'https://tv.example/zulu.m3u8',
  '#EXTINF:-1 group-title="Sports",Alpha Sports 10',
  'https://tv.example/alpha10.m3u8',
  '#EXTINF:-1 group-title="Sports",Alpha Sports 2',
  'https://tv.example/alpha2.m3u8',
  '#EXTINF:-1 group-title="World",Mike World',
  'https://tv.example/mike.m3u8',
].join('\n');

function makeState(patch = {}) {
  const { channels } = parseM3U(PLAYLIST);
  return {
    channels,
    groups: groupChannels(channels),
    favorites: [],
    recents: [],
    category: CATEGORY.all,
    sort: 'playlist',
    query: '',
    ...patch,
  };
}
const names = (list) => list.map((ch) => ch.name);

describe('selectCategoryChannels', () => {
  it('filters multi-group channels into each of their groups and sorts A–Z naturally', () => {
    const state = makeState({ category: 'group:World' });
    expect(names(selectCategoryChannels(state))).toEqual(['Zulu News', 'Mike World']);
    expect(names(selectCategoryChannels({ ...state, sort: 'name' }))).toEqual(['Mike World', 'Zulu News']);
    expect(names(selectCategoryChannels({ ...state, category: 'group:Sports', sort: 'name' }))).toEqual([
      'Alpha Sports 2',
      'Alpha Sports 10',
    ]);
  });

  it('resolves favorites to live channels (or snapshots) and keeps recents most-recent first', () => {
    const base = makeState();
    const [zulu, , alpha2] = base.channels;
    const foreign = { id: 'other', name: 'Other Playlist TV', url: 'https://x/o.m3u8', playlistId: 'pl_2' };
    const state = { ...base, favorites: [{ id: alpha2.id, url: alpha2.url, name: 'stale' }, foreign] };
    const favs = selectCategoryChannels({ ...state, category: CATEGORY.favorites });
    expect(favs[0]).toBe(alpha2);
    expect(favs[1]).toMatchObject({ id: 'other', name: 'Other Playlist TV', playlistId: 'pl_2', index: -1 });
    const recents = [foreign, { id: zulu.id, url: zulu.url }];
    expect(names(selectCategoryChannels({ ...state, recents, category: CATEGORY.recent, sort: 'name' }))).toEqual([
      'Other Playlist TV',
      'Zulu News',
    ]);
  });

  it('does not re-sort or re-search the channel list when only favorites / recents change', () => {
    let state = makeState({ sort: 'name' });
    const sorted = selectCategoryChannels(state);
    const visible = selectVisibleChannels(state);
    state = { ...state, recents: [{ id: 'r', url: 'https://x/r' }], favorites: [{ id: 'f', url: 'https://x/f' }] };
    expect(selectCategoryChannels(state)).toBe(sorted);
    expect(selectVisibleChannels(state)).toBe(visible);

    state = { ...state, query: 'alpha' };
    const searched = selectVisibleChannels(state);
    expect(names(searched.items.map((i) => i.channel))).toEqual(['Alpha Sports 2', 'Alpha Sports 10']);
    state = { ...state, recents: [...state.recents] };
    expect(selectVisibleChannels(state)).toBe(searched);

    // …but they do recompute when the relevant input changes.
    const favState = { ...state, query: '', category: CATEGORY.favorites };
    const favs = selectCategoryChannels(favState);
    expect(selectCategoryChannels({ ...favState, favorites: [] })).not.toBe(favs);
    expect(selectCategoryChannels({ ...state, sort: 'playlist', query: '' })).toBe(state.channels);
  });

  it('knows which categories exist', () => {
    const state = makeState();
    expect(categoryExists(state, 'group:World')).toBe(true);
    expect(categoryExists(state, 'group:Gone')).toBe(false);
    expect(categoryExists(state, CATEGORY.recent)).toBe(true);
    expect(categoryExists(state, 'bogus')).toBe(false);
  });
});

describe('snapshotToChannel', () => {
  it('always yields string fields, even for malformed snapshots', () => {
    const ch = snapshotToChannel({ id: 'x', url: 'https://x', name: ['a'], group: 5, logo: {}, tvgId: 1, headers: 'h' });
    expect(ch).toMatchObject({ name: 'Untitled', group: UNCATEGORIZED, groups: [UNCATEGORIZED], logo: '', tvgId: '' });
    expect(ch.headers).toEqual({});
  });
});
