// Selector tests: category / sort / search derivation and memoization (src/app/selectors.js).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/playability.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, staticPlayability: vi.fn(actual.staticPlayability) };
});

import { CATEGORY, DEFAULT_SETTINGS, UNCATEGORIZED } from '../src/app/constants.js';
import {
  categoryExists,
  selectCategoryChannels,
  selectPlayability,
  selectVisibleChannels,
  snapshotToChannel,
} from '../src/app/selectors.js';
import { groupChannels, parseM3U } from '../src/lib/m3u.js';
import { staticPlayability } from '../src/lib/playability.js';

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

// ---------------------------------------------------------------------------------------------------------
// Playability

const FLAGGED = [
  '#EXTM3U',
  '#EXTINF:-1 group-title="News",Secure News',
  'https://tv.example/secure-news.m3u8',
  '#EXTINF:-1 group-title="News",Insecure News',
  'http://203.0.113.7:8080/live/news.m3u8',
  '#EXTINF:-1 group-title="Sports",RTMP Sports',
  'rtmp://live.example/app/sports',
  '#EXTINF:-1 group-title="Sports",Secure Sports',
  'https://tv.example/sports.m3u8',
  '#EXTINF:-1 group-title="Movies",Dash Movies',
  'https://tv.example/movies/manifest.mpd',
  '#EXTINF:-1 group-title="Movies",Secure Movies',
  'https://tv.example/movies.m3u8',
].join('\n');

function makeFlaggedState(patch = {}) {
  const { channels } = parseM3U(FLAGGED);
  return {
    channels,
    groups: groupChannels(channels),
    favorites: [],
    recents: [],
    category: CATEGORY.all,
    sort: 'playlist',
    query: '',
    settings: { ...DEFAULT_SETTINGS },
    health: {},
    currentChannel: null,
    ...patch,
  };
}
const byName = (state, name) => state.channels.find((ch) => ch.name === name);
const failed = (title, at = 1_700_000_000_000) => ({ code: 'NETWORK', title, at });

describe('selectPlayability', () => {
  beforeEach(() => {
    vi.stubGlobal('location', { protocol: 'https:' });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('combines the static checks with remembered failures (static results win)', () => {
    const base = makeFlaggedState();
    const rtmp = byName(base, 'RTMP Sports');
    const secure = byName(base, 'Secure News');
    const health = {
      [rtmp.id]: failed('Couldn’t play this stream.'),
      [secure.id]: failed('Lost connection to the stream.', 1_700_000_123_000),
    };
    const of = selectPlayability({ ...base, health });
    expect(of(byName(base, 'Insecure News'))).toMatchObject({ kind: 'insecure', label: 'HTTP' });
    expect(of(rtmp)).toMatchObject({ kind: 'unsupported', title: 'rtmp:// streams can’t be played in a browser.' });
    expect(of(byName(base, 'Dash Movies'))).toMatchObject({ kind: 'unsupported', label: 'Not supported' });
    expect(of(secure)).toEqual({
      kind: 'failed',
      label: 'Unavailable',
      title: 'Lost connection to the stream.',
      at: 1_700_000_123_000,
    });
    expect(of(byName(base, 'Secure Sports'))).toBeNull();
    expect(of(null)).toBeNull();
  });

  it('ignores inherited keys and tolerates states without health or settings', () => {
    const channel = { id: 'toString', url: 'https://tv.example/x.m3u8' };
    expect(selectPlayability(makeFlaggedState())(channel)).toBeNull();
    const bare = makeFlaggedState({ health: undefined, settings: undefined });
    expect(selectPlayability(bare)({ id: 'x', url: 'https://tv.example/x.m3u8' })).toBeNull();
    expect(selectPlayability(bare)({ id: 'y', url: 'http://tv.example/y.m3u8' })).toMatchObject({ kind: 'insecure' });
  });

  it('uses the stream relay in effect for insecure streams', () => {
    const base = makeFlaggedState();
    const insecure = byName(base, 'Insecure News');
    const relay = { ...base.settings, corsProxy: 'https://relay.example.test' };
    expect(selectPlayability({ ...base, settings: relay })(insecure)).toBeNull();
    // Streams don't go through the relay when proxyStreams is off.
    expect(selectPlayability({ ...base, settings: { ...relay, proxyStreams: false } })(insecure)).toMatchObject({
      kind: 'insecure',
    });
    expect(selectPlayability(base)(insecure)).toMatchObject({ kind: 'insecure' });
  });

  it('is memoized on health + relay and computes static results once per channel', () => {
    const base = makeFlaggedState();
    const of = selectPlayability(base);
    expect(selectPlayability({ ...base, query: 'x', recents: [] })).toBe(of);
    expect(selectPlayability({ ...base, settings: { ...base.settings } })).toBe(of);

    staticPlayability.mockClear();
    const results = base.channels.map(of);
    expect(staticPlayability).toHaveBeenCalledTimes(base.channels.length);
    expect(base.channels.map(of)).toEqual(results);
    expect(staticPlayability).toHaveBeenCalledTimes(base.channels.length);

    // A health change gives a new function but keeps the static results (and their identity).
    const secure = byName(base, 'Secure News');
    const entry = failed('Gone.');
    const next = selectPlayability({ ...base, health: { [secure.id]: entry } });
    expect(next).not.toBe(of);
    expect(base.channels.map(next).map((r) => r?.kind ?? null)).toEqual([
      'failed', 'insecure', 'unsupported', null, 'unsupported', null,
    ]);
    expect(next(byName(base, 'RTMP Sports'))).toBe(of(byName(base, 'RTMP Sports')));
    expect(next(secure)).toBe(next(secure)); // stable 'failed' result for an unchanged entry
    expect(staticPlayability).toHaveBeenCalledTimes(base.channels.length);
  });
});

describe('selectVisibleChannels with hideUnplayable', () => {
  beforeEach(() => {
    vi.stubGlobal('location', { protocol: 'https:' });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const hide = (state) => ({ ...state, settings: { ...state.settings, hideUnplayable: true } });
  const visibleNames = (state) => selectVisibleChannels(state).items.map((item) => item.channel.name);

  it('keeps every channel (and hidden = 0) while the setting is off', () => {
    const state = makeFlaggedState();
    expect(selectVisibleChannels(state)).toMatchObject({ total: 6, hidden: 0 });
    expect(visibleNames(state)).toHaveLength(6);
    const health = { [byName(state, 'Secure News').id]: failed('Gone.') };
    expect(selectVisibleChannels({ ...state, health })).toBe(selectVisibleChannels(state));
  });

  it('hides unplayable channels before searching and counts them', () => {
    const base = makeFlaggedState();
    const health = { [byName(base, 'Secure Sports').id]: failed('Gone.') };
    const state = hide({ ...base, health });
    expect(visibleNames(state)).toEqual(['Secure News', 'Secure Movies']);
    expect(selectVisibleChannels(state)).toMatchObject({ total: 6, hidden: 4, query: '' });

    const searched = selectVisibleChannels({ ...state, query: 'news' });
    expect(searched.items.map((item) => item.channel.name)).toEqual(['Secure News']);
    expect(searched).toMatchObject({ total: 6, hidden: 4, query: 'news' });

    const group = { ...state, category: 'group:Sports' };
    expect(visibleNames(group)).toEqual([]);
    expect(selectVisibleChannels(group)).toMatchObject({ total: 2, hidden: 2 });
  });

  it('never hides the current channel', () => {
    const base = makeFlaggedState();
    const insecure = byName(base, 'Insecure News');
    const state = hide({ ...base, currentChannel: { ...insecure } }); // e.g. a snapshot of the same channel
    expect(visibleNames(state)).toEqual(['Secure News', 'Insecure News', 'Secure Sports', 'Secure Movies']);
    expect(selectVisibleChannels(state)).toMatchObject({ total: 6, hidden: 2 });
    expect(visibleNames({ ...state, currentChannel: byName(base, 'Secure Sports') })).toEqual([
      'Secure News',
      'Secure Sports',
      'Secure Movies',
    ]);
  });

  it('reuses the previous result while the outcome is unchanged', () => {
    const base = hide(makeFlaggedState({ query: 'secure' }));
    const first = selectVisibleChannels(base);
    // Switching between playable channels.
    const playing = { ...base, currentChannel: byName(base, 'Secure Sports') };
    expect(selectVisibleChannels(playing)).toBe(first);
    expect(selectVisibleChannels({ ...playing, currentChannel: byName(base, 'Secure Movies') })).toBe(first);
    // A failure of a channel outside the category / already hidden changes nothing.
    const sports = { ...base, category: 'group:Sports' };
    const sportsFirst = selectVisibleChannels(sports);
    const outside = { [byName(base, 'Secure News').id]: failed('Gone.') };
    expect(selectVisibleChannels({ ...sports, health: outside })).toBe(sportsFirst);
    // The current channel failing keeps it on screen, so the list stays the same too.
    const current = byName(base, 'Secure Sports');
    const withCurrent = { ...sports, currentChannel: current };
    const beforeFailure = selectVisibleChannels(withCurrent);
    const failedCurrent = { ...withCurrent, health: { [current.id]: failed('Gone.') } };
    expect(selectVisibleChannels(failedCurrent)).toBe(beforeFailure);
    // …and it disappears once another channel plays.
    expect(selectVisibleChannels({ ...failedCurrent, currentChannel: null })).toMatchObject({ items: [], hidden: 2 });
  });

  it('filters a large category quickly once static results are cached', () => {
    const channels = Array.from({ length: 20_000 }, (_, i) => ({
      id: `ch${i}`,
      name: `Channel ${i}`,
      url: i % 4 ? `https://cdn${i % 50}.example/live/${i}/index.m3u8` : `http://203.0.113.${i % 250}:8080/${i}.ts`,
      group: 'All',
      groups: ['All'],
      drm: false,
    }));
    const state = hide(makeFlaggedState({ channels, groups: [{ name: 'All', count: channels.length }] }));
    expect(selectVisibleChannels(state)).toMatchObject({ total: 20_000, hidden: 5_000 });
    const health = { ch1: failed('Gone.') };
    const started = performance.now();
    const next = selectVisibleChannels({ ...state, health });
    const elapsed = performance.now() - started;
    expect(next).toMatchObject({ total: 20_000, hidden: 5_001 });
    expect(elapsed).toBeLessThan(250); // generous for slow CI machines; typically a few ms
  });
});
