// Controller tests: ingest / dedupe / favorites / recents / playNext / persistence / start-up.
// Every module the controller talks to is mocked with a small implementation that follows its spec contract.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mem = vi.hoisted(() => ({ json: new Map(), text: new Map(), failWrite: null }));

vi.mock('../src/lib/storage.js', () => ({
  isStorageAvailable: vi.fn(() => true),
  readJSON: vi.fn((key, fallback) => (mem.json.has(key) ? structuredClone(mem.json.get(key)) : fallback)),
  writeJSON: vi.fn((key, value) => {
    mem.json.set(key, JSON.parse(JSON.stringify(value)));
    return true;
  }),
  removeKey: vi.fn((key) => mem.json.delete(key)),
  writePlaylistText: vi.fn(async (id, text) => {
    if (mem.failWrite) return { ok: false, bytes: 0, compressed: false, error: mem.failWrite };
    mem.text.set(id, text);
    return { ok: true, bytes: text.length * 2, compressed: false };
  }),
  readPlaylistText: vi.fn(async (id) => (mem.text.has(id) ? mem.text.get(id) : null)),
  removePlaylistText: vi.fn((id) => {
    mem.text.delete(id);
  }),
  estimateUsage: vi.fn(() => ({ bytes: 0, keys: mem.json.size + mem.text.size })),
  clearAllData: vi.fn(() => {
    mem.json.clear();
    mem.text.clear();
  }),
  isQuotaError: vi.fn((err) => err?.name === 'QuotaExceededError'),
}));

vi.mock('../src/lib/playlist-loader.js', () => {
  class PlaylistLoadError extends Error {
    constructor(code, message, { status, cause } = {}) {
      super(message || code, cause === undefined ? undefined : { cause });
      this.name = 'PlaylistLoadError';
      this.code = code;
      this.status = status ?? null;
    }
  }
  return {
    PlaylistLoadError,
    fetchPlaylist: vi.fn(),
    readPlaylistFile: vi.fn(async (file) => file.text()),
    describeLoadError: vi.fn((err) =>
      err?.code === 'ABORTED' ? 'The download was cancelled.' : `Couldn’t load the playlist (${err?.code}).`,
    ),
    normalizePlaylistUrl: vi.fn((input) => {
      const value = String(input ?? '').trim();
      if (!value) throw new PlaylistLoadError('INVALID_URL', 'Enter a playlist URL.');
      const withScheme = /^[a-z][a-z\d+.-]*:/i.test(value) ? value : `https://${value}`;
      let url;
      try {
        url = new URL(withScheme);
      } catch {
        throw new PlaylistLoadError('INVALID_URL', 'That doesn’t look like a valid URL.');
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new PlaylistLoadError('INVALID_URL', 'Only http(s) links are supported.');
      }
      return url.href;
    }),
  };
});

vi.mock('../src/lib/m3u.js', async () => {
  const { hashString } = await import('../src/lib/utils.js');
  const { UNCATEGORIZED } = await import('../src/app/constants.js');
  const makeChannelId = (name, url) => hashString(`${name}\n${url}`);
  const isHlsManifest = (text) => /^#EXT-X-(STREAM-INF|TARGETDURATION|MEDIA-SEQUENCE)/m.test(text);
  const looksLikeM3U = (text) => /#EXTM3U|#EXTINF/.test(text) || /^https?:\/\//m.test(text);

  function parseM3U(text, { baseUrl } = {}) {
    const meta = { title: '', epgUrl: '', attrs: {}, isHlsManifest: false };
    const channels = [];
    const warnings = [];
    if (isHlsManifest(text)) {
      meta.isHlsManifest = true;
      return { channels, meta, warnings };
    }
    const seen = new Map();
    let info = null;
    let unsupported = 0;
    for (const raw of text.replace(/^﻿/, '').split(/\r\n|\r|\n/)) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith('#EXTM3U')) {
        meta.epgUrl = /x-tvg-url="([^"]*)"/.exec(line)?.[1] || '';
      } else if (line.startsWith('#PLAYLIST:')) {
        meta.title = line.slice(10).trim();
      } else if (line.startsWith('#EXTINF:')) {
        const comma = line.indexOf(',');
        const head = comma === -1 ? line : line.slice(0, comma);
        const attrs = {};
        for (const m of head.matchAll(/([\w-]+)="([^"]*)"/g)) attrs[m[1].toLowerCase()] = m[2];
        info = { title: comma === -1 ? '' : line.slice(comma + 1).trim(), attrs };
      } else if (!line.startsWith('#')) {
        let url;
        try {
          url = new URL(line, baseUrl).href;
        } catch {
          continue;
        }
        if (!/^https?:/.test(url)) unsupported++;
        const attrs = info?.attrs || {};
        const name = info?.title || attrs['tvg-name'] || url;
        const groups = [...new Set((attrs['group-title'] || '').split(';').map((g) => g.trim()).filter(Boolean))];
        const base = makeChannelId(name, url);
        const n = (seen.get(base) || 0) + 1;
        seen.set(base, n);
        const chno = Number.parseInt(attrs['tvg-chno'], 10);
        channels.push({
          id: n > 1 ? `${base}~${n}` : base,
          index: channels.length,
          name,
          url,
          group: groups[0] || UNCATEGORIZED,
          groups: groups.length ? groups : [UNCATEGORIZED],
          logo: '',
          tvgId: attrs['tvg-id'] || '',
          tvgName: attrs['tvg-name'] || '',
          chno: Number.isFinite(chno) ? chno : null,
          duration: -1,
          attrs,
          headers: {},
          drm: false,
        });
        info = null;
      }
    }
    if (unsupported) warnings.push(`${unsupported} channel uses a protocol browsers can’t play (rtmp://).`);
    return { channels, meta, warnings };
  }

  function groupChannels(channels) {
    const map = new Map();
    channels.forEach((ch, i) => {
      for (const name of ch.groups) {
        const group = map.get(name);
        if (group) group.count++;
        else map.set(name, { name, count: 1, firstIndex: ch.index >= 0 ? ch.index : i });
      }
    });
    return [...map.values()];
  }

  function serializeM3U(channels, { title } = {}) {
    const out = ['#EXTM3U'];
    if (title) out.push(`#PLAYLIST:${title}`);
    for (const ch of channels) {
      const attrs = [];
      if (ch.tvgId) attrs.push(`tvg-id="${ch.tvgId}"`);
      const groups = (ch.groups?.length ? ch.groups : [ch.group]).filter((g) => g && g !== UNCATEGORIZED);
      if (groups.length) attrs.push(`group-title="${groups.join(';')}"`);
      out.push(`#EXTINF:-1${attrs.length ? ` ${attrs.join(' ')}` : ''},${ch.name}`, ch.url);
    }
    return `${out.join('\n')}\n`;
  }

  return { parseM3U, looksLikeM3U, isHlsManifest, groupChannels, makeChannelId, serializeM3U };
});

vi.mock('../src/lib/fuzzy.js', () => ({
  normalizeText: (str) => ({ text: String(str).toLowerCase(), map: [] }),
  fuzzyMatch: () => null,
  searchChannels: (channels, query) => {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return null;
    return channels
      .filter((channel) => channel.name.toLowerCase().includes(q))
      .map((channel) => ({ channel, score: 1, indices: [] }));
  },
  highlight: (text) => document.createTextNode(text),
}));

vi.mock('../src/ui/theme.js', () => ({
  applyTheme: vi.fn(),
  createThemePicker: vi.fn(() => document.createElement('div')),
  createThemeSwitcher: vi.fn(() => document.createElement('button')),
}));

vi.mock('../src/ui/toast.js', () => {
  const handle = () => ({ dismiss: () => {}, el: null });
  const toast = vi.fn(handle);
  toast.info = vi.fn(handle);
  toast.success = vi.fn(handle);
  toast.warning = vi.fn(handle);
  toast.error = vi.fn(handle);
  return { toast };
});

vi.mock('../src/lib/utils.js', async (importOriginal) => ({
  ...(await importOriginal()),
  downloadText: vi.fn(),
}));

import { createStore } from '../src/app/store.js';
import { createController, createInitialState } from '../src/app/controller.js';
import { CATEGORY, DEFAULT_SETTINGS, KEYS, MAX_RECENTS, UNCATEGORIZED } from '../src/app/constants.js';
import { DEMO_PLAYLIST_NAME } from '../src/app/demo.js';
import { channelToSnapshot } from '../src/app/selectors.js';
import { PlaylistLoadError, fetchPlaylist } from '../src/lib/playlist-loader.js';
import { makeChannelId } from '../src/lib/m3u.js';
import * as storage from '../src/lib/storage.js';
import { downloadText } from '../src/lib/utils.js';
import { applyTheme } from '../src/ui/theme.js';
import { toast } from '../src/ui/toast.js';

// ---------------------------------------------------------------------------------------------------------
// Fixtures & helpers

const ENTRIES = [
  ['News One', 'News', 'https://tv.example/news1.m3u8', ' tvg-id="news1" tvg-chno="1"'],
  ['News Two', 'News', 'https://tv.example/news2.m3u8', ' tvg-id="news2"'],
  ['Sport One', 'Sports', 'https://tv.example/sport1.m3u8', ' tvg-id="sport1"'],
  ['Cartoon Time', 'Movies;Kids', 'https://tv.example/kids.m3u8', ''],
];
const m3u = (entries = ENTRIES, title = 'Sample TV') =>
  [
    '#EXTM3U',
    title ? `#PLAYLIST:${title}` : null,
    ...entries.flatMap(([name, group, url, extra]) => [`#EXTINF:-1${extra} group-title="${group}",${name}`, url]),
  ]
    .filter((line) => line !== null)
    .join('\n');
const SAMPLE = m3u();
const URL_A = 'https://lists.example/a/tv.m3u';
const URL_B = 'https://lists.example/b/more.m3u';

const okResult = (text, url) => ({ text, finalUrl: url, viaProxy: false, upgraded: false });
const respondWith = (text = SAMPLE) =>
  fetchPlaylist.mockImplementation(async (url) => okResult(typeof text === 'function' ? text(url) : text, url));

const controllers = [];
function setup(seed) {
  seed?.();
  const store = createStore(createInitialState());
  const actions = createController(store);
  controllers.push(actions);
  return { store, actions };
}

const writesFor = (key) => storage.writeJSON.mock.calls.filter(([k]) => k === key);
const lastWrite = (key) => writesFor(key).at(-1)?.[1];
const byName = (store, name) => store.get().channels.find((ch) => ch.name === name);

function seedPlaylist({ id = 'pl_seed', url = URL_A, text = SAMPLE, updatedAt = Date.now(), cached = true } = {}) {
  const meta = {
    id,
    name: 'Seeded',
    source: { kind: 'url', url },
    channelCount: 4,
    groupCount: 4,
    createdAt: 1,
    updatedAt,
    cached,
  };
  mem.json.set(KEYS.playlists, [...(mem.json.get(KEYS.playlists) || []), meta]);
  if (text !== null) mem.text.set(id, text);
  return meta;
}

beforeEach(() => {
  mem.json.clear();
  mem.text.clear();
  mem.failWrite = null;
  vi.clearAllMocks();
  fetchPlaylist.mockReset();
});

afterEach(() => {
  for (const actions of controllers.splice(0)) actions.destroy();
  vi.useRealTimers();
  history.replaceState(null, '', '/');
});

// ---------------------------------------------------------------------------------------------------------

describe('createInitialState', () => {
  it('merges defaults and drops invalid persisted values', () => {
    mem.json.set(KEYS.settings, { maxRetries: 99, autoplay: 'yes', lowLatency: false, bogus: 1, corsProxy: 'ftp://x' });
    mem.json.set(KEYS.theme, { accent: 'neon', mode: 'light' });
    mem.json.set(KEYS.session, { sort: 'name', groupSort: 'bad', volume: 3, muted: true, category: 'favorites' });
    mem.json.set(KEYS.favorites, [{ id: 'a', name: 'A', url: 'https://x/a' }, { id: 'b' }, { id: 'a', url: 'dup' }]);
    seedPlaylist();
    mem.json.set(KEYS.playlists, [...mem.json.get(KEYS.playlists), { name: 'no id' }, { id: 'x', source: 5 }]);

    const state = createInitialState();
    expect(state.settings).toEqual({ ...DEFAULT_SETTINGS, maxRetries: 30, lowLatency: false });
    expect(state.theme).toEqual({ accent: 'azure', mode: 'light' });
    expect(state).toMatchObject({ sort: 'name', groupSort: 'name', volume: 1, muted: true, category: 'favorites' });
    expect(state.favorites.map((f) => f.id)).toEqual(['a']);
    expect(state.playlists.map((p) => p.id)).toEqual(['pl_seed']);
    expect(state.activePlaylistId).toBe('pl_seed'); // falls back to the first playlist
    expect(state).toMatchObject({ ready: false, busy: null, channels: [], currentChannel: null, playRequest: 0 });
  });

  it('starts with playbackState "idle" and never persists it', async () => {
    vi.useFakeTimers();
    const { store, actions } = setup();
    expect(store.get().playbackState).toBe('idle');
    store.set({ playbackState: 'playing' });
    actions.setSort('name');
    await vi.advanceTimersByTimeAsync(1000);
    window.dispatchEvent(new Event('pagehide'));
    expect(lastWrite(KEYS.session)).not.toHaveProperty('playbackState');
    for (const [, value] of storage.writeJSON.mock.calls) expect(JSON.stringify(value)).not.toContain('playbackState');
  });

  it('ignores null / boolean / empty-string numbers in stored settings', () => {
    mem.json.set(KEYS.settings, { maxRetries: null, autoRefreshHours: true, autoplay: false });
    expect(createInitialState().settings).toEqual({ ...DEFAULT_SETTINGS, autoplay: false });
    mem.json.set(KEYS.settings, { maxRetries: '', autoRefreshHours: '' });
    expect(createInitialState().settings).toEqual(DEFAULT_SETTINGS);
    mem.json.set(KEYS.settings, { maxRetries: '12', autoRefreshHours: '6' });
    expect(createInitialState().settings).toMatchObject({ maxRetries: 12, autoRefreshHours: 6 });
  });

  it('type-checks every field of stored favorites / recents snapshots', () => {
    mem.json.set(KEYS.favorites, [
      {
        id: 'a',
        url: ' https://x/a.m3u8 ',
        name: ['not', 'a', 'string'],
        logo: { src: 'x' },
        group: 7,
        groups: [1, null, 'News', 'News', 'World'],
        headers: { userAgent: 'UA', referrer: 5, evil: 'x' },
        tvgId: 9,
        drm: 'yes',
        playlistId: 3,
        addedAt: 'today',
      },
      { id: 'b', url: 'https://x/b', name: 'B', headers: 'zz', groups: 'abc', drm: true, addedAt: 5 },
      { id: 'c', url: 42 },
      { id: 'd', url: '   ' },
    ]);
    mem.json.set(KEYS.recents, [{ id: 'r', url: 'https://x/r', name: { x: 1 }, watchedAt: 9 }, 'junk', null]);
    const state = createInitialState();
    expect(state.favorites).toEqual([
      {
        id: 'a',
        name: '',
        url: 'https://x/a.m3u8',
        logo: '',
        group: UNCATEGORIZED,
        groups: ['News', 'World'],
        headers: { userAgent: 'UA' },
        tvgId: '',
        playlistId: null,
      },
      { id: 'b', name: 'B', url: 'https://x/b', logo: '', group: UNCATEGORIZED, tvgId: '', playlistId: null, drm: true, addedAt: 5 },
    ]);
    expect(state.recents).toEqual([
      { id: 'r', name: '', url: 'https://x/r', logo: '', group: UNCATEGORIZED, tvgId: '', playlistId: null, watchedAt: 9 },
    ]);
  });
});

describe('ingest', () => {
  it('downloads, parses, persists and activates a URL playlist', async () => {
    respondWith();
    const { store, actions } = setup();
    actions.setQuery('old search');
    const busy = [];
    store.subscribe((s, prev) => s.busy !== prev.busy && busy.push(s.busy));

    const meta = await actions.addPlaylistFromUrl({ url: 'lists.example/a/tv.m3u' });

    expect(fetchPlaylist).toHaveBeenCalledWith(URL_A, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(meta).toMatchObject({ name: 'Sample TV', source: { kind: 'url', url: URL_A }, channelCount: 4, cached: true });
    expect(meta.groupCount).toBe(4); // News, Sports, Movies, Kids
    const state = store.get();
    expect(state.activePlaylistId).toBe(meta.id);
    expect(state.playlists).toEqual([meta]);
    expect(state.channels.map((c) => c.name)).toEqual(['News One', 'News Two', 'Sport One', 'Cartoon Time']);
    expect(state).toMatchObject({ category: 'all', query: '', busy: null, playlistError: null });
    expect(busy).toEqual([{ message: expect.any(String) }, null]);
    expect(mem.text.get(meta.id)).toBe(SAMPLE);
    expect(lastWrite(KEYS.playlists)).toEqual([meta]);
    expect(toast.success).toHaveBeenCalledWith('Loaded 4 channels from “Sample TV”', expect.any(Object));
  });

  it('names playlists: explicit name → playlist title → URL / file name', async () => {
    respondWith(m3u(ENTRIES, ''));
    const { actions } = setup();
    expect((await actions.addPlaylistFromUrl({ url: URL_A, name: '  My   TV ' })).name).toBe('My TV');
    expect((await actions.addPlaylistFromUrl({ url: URL_B })).name).toBe('more');
    const file = new File([m3u(ENTRIES, '')], 'family-list.m3u8', { type: 'audio/x-mpegurl' });
    const fromFile = await actions.addPlaylistFromFile(file);
    expect(fromFile).toMatchObject({ name: 'family-list', source: { kind: 'file', fileName: 'family-list.m3u8' } });
    const titled = await actions.addPlaylistFromText(SAMPLE, { source: { kind: 'file' } });
    expect(titled.name).toBe('Sample TV');
  });

  it('refreshes an existing URL playlist instead of adding a duplicate', async () => {
    respondWith();
    const { store, actions } = setup();
    const first = await actions.addPlaylistFromUrl({ url: URL_A });
    await actions.addPlaylistFromUrl({ url: URL_B });
    respondWith(m3u([...ENTRIES, ['Extra', 'News', 'https://tv.example/extra.m3u8', '']]));

    const again = await actions.addPlaylistFromUrl({ url: `${URL_A}`, name: 'Renamed' });

    expect(again.id).toBe(first.id);
    expect(again).toMatchObject({ name: 'Renamed', channelCount: 5, createdAt: first.createdAt });
    expect(store.get().playlists).toHaveLength(2);
    expect(store.get().activePlaylistId).toBe(first.id);
    expect(store.get().channels).toHaveLength(5);
  });

  it('turns an HLS manifest URL into a single channel that survives reloads', async () => {
    const streamUrl = 'https://cdn.example/live/master.m3u8';
    respondWith('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nlow/index.m3u8\n');
    const { store, actions } = setup();
    const meta = await actions.addPlaylistFromUrl({ url: streamUrl });

    expect(meta).toMatchObject({ name: 'master', channelCount: 1 });
    const [channel] = store.get().channels;
    expect(channel).toMatchObject({ name: 'master', url: streamUrl, id: makeChannelId('master', streamUrl) });

    // The stored copy is a one-entry M3U, so a fresh start shows the same channel (same id).
    const reloaded = setup();
    await reloaded.actions.init();
    expect(reloaded.store.get().channels.map((c) => c.id)).toEqual([channel.id]);
  });

  it('rejects empty playlists with a clear message and keeps state unchanged', async () => {
    respondWith('#EXTM3U\n# nothing here\n');
    const { store, actions } = setup();
    await expect(actions.addPlaylistFromUrl({ url: URL_A })).rejects.toThrow('No channels found in this playlist.');
    expect(toast.error).toHaveBeenCalledWith('No channels found in this playlist.');
    expect(store.get()).toMatchObject({ playlists: [], busy: null, activePlaylistId: null });
    expect(mem.text.size).toBe(0);
  });

  it('surfaces loader errors with the friendly describeLoadError message', async () => {
    fetchPlaylist.mockRejectedValue(new PlaylistLoadError('CORS', 'Failed to fetch'));
    const { actions } = setup();
    const error = await actions.addPlaylistFromUrl({ url: URL_A }).catch((err) => err);
    expect(error).toMatchObject({ code: 'CORS', message: 'Couldn’t load the playlist (CORS).' });
    expect(toast.error).toHaveBeenCalledWith('Couldn’t load the playlist (CORS).');
    await expect(actions.addPlaylistFromUrl({ url: 'ftp://nope' })).rejects.toMatchObject({ code: 'INVALID_URL' });
  });

  it('warns when the playlist cannot be cached', async () => {
    mem.failWrite = 'QUOTA';
    respondWith();
    const { actions } = setup();
    const meta = await actions.addPlaylistFromUrl({ url: URL_A });
    expect(meta.cached).toBe(false);
    expect(toast.warning).toHaveBeenCalledWith(
      'Playlist is too large to cache offline — it will be downloaded again on reload.',
    );
    await actions.addPlaylistFromFile(new File([SAMPLE], 'big.m3u'));
    expect(toast.warning).toHaveBeenLastCalledWith(expect.stringContaining('re-upload it after reloading'));
    expect(toast.success).toHaveBeenCalledTimes(2); // still loaded for this session
  });

  it('keeps the in-memory copy of a playlist when browser storage is unavailable', async () => {
    storage.isStorageAvailable.mockReturnValue(false);
    // The storage module falls back to memory: the text is kept for this session but `ok` is false.
    storage.writePlaylistText.mockImplementation(async (id, text) => {
      mem.text.set(id, text);
      return { ok: false, bytes: 0, compressed: false, error: 'UNAVAILABLE' };
    });
    try {
      const { store, actions } = setup();
      const first = await actions.addPlaylistFromFile(new File([SAMPLE], 'first.m3u'));
      expect(toast.warning).toHaveBeenLastCalledWith(expect.stringContaining('Browser storage is unavailable'));
      await actions.addPlaylistFromFile(new File([m3u(ENTRIES.slice(0, 2), 'Second')], 'second.m3u'));
      expect(storage.removePlaylistText).not.toHaveBeenCalled();

      await actions.switchPlaylist(first.id); // must not fail with "no longer stored"
      expect(store.get()).toMatchObject({ activePlaylistId: first.id, playlistError: null });
      expect(store.get().channels).toHaveLength(4);
      expect(store.get().playlists.find((p) => p.id === first.id).cached).toBe(false);
      expect(toast.error).not.toHaveBeenCalled();
    } finally {
      storage.isStorageAvailable.mockReturnValue(true);
      storage.writePlaylistText.mockReset();
      storage.writePlaylistText.mockImplementation(async (id, text) => {
        if (mem.failWrite) return { ok: false, bytes: 0, compressed: false, error: mem.failWrite };
        mem.text.set(id, text);
        return { ok: true, bytes: text.length * 2, compressed: false };
      });
    }
  });

  it('drops a stale stored copy when a write fails although storage is available', async () => {
    respondWith();
    const { actions } = setup();
    const meta = await actions.addPlaylistFromUrl({ url: URL_A });
    expect(mem.text.has(meta.id)).toBe(true);
    mem.failWrite = 'UNAVAILABLE'; // e.g. a SecurityError on setItem
    await actions.refreshPlaylist(meta.id);
    expect(storage.removePlaylistText).toHaveBeenCalledWith(meta.id);
    expect(mem.text.has(meta.id)).toBe(false);
  });

  it('appends the first parser warning to the success toast', async () => {
    respondWith(m3u([...ENTRIES, ['Old', 'News', 'rtmp://live.example/app', '']]));
    const { actions } = setup();
    await actions.addPlaylistFromUrl({ url: URL_A });
    expect(toast.success.mock.calls[0][0]).toMatch(/^Loaded 5 channels from “Sample TV”\. 1 channel uses/);
  });

  it('aborts an in-flight download when another one starts', async () => {
    let firstSignal;
    fetchPlaylist
      .mockImplementationOnce(
        (url, { signal }) =>
          new Promise((_, reject) => {
            firstSignal = signal;
            signal.addEventListener('abort', () => reject(new PlaylistLoadError('ABORTED', 'aborted')));
          }),
      )
      .mockImplementationOnce(async (url) => okResult(SAMPLE, url));
    const { store, actions } = setup();

    const first = actions.addPlaylistFromUrl({ url: URL_A });
    const second = actions.addPlaylistFromUrl({ url: URL_B });

    await expect(first).rejects.toMatchObject({ code: 'ABORTED' });
    const meta = await second;
    expect(firstSignal.aborted).toBe(true);
    expect(toast.error).not.toHaveBeenCalled();
    expect(store.get().playlists.map((p) => p.source.url)).toEqual([URL_B]);
    expect(store.get()).toMatchObject({ activePlaylistId: meta.id, busy: null });
  });

  it('adding a playlist does not cancel the download of the playlist on screen', async () => {
    seedPlaylist({ text: null, cached: false }); // active URL playlist that has to be downloaded
    let release;
    fetchPlaylist.mockImplementation((url, { signal }) => {
      if (url !== URL_A) return Promise.reject(new PlaylistLoadError('HTTP', 'nope', { status: 404 }));
      return new Promise((resolve, reject) => {
        release = () => resolve(okResult(SAMPLE, url));
        signal.addEventListener('abort', () => reject(new PlaylistLoadError('ABORTED', 'aborted')));
      });
    });
    const { store, actions } = setup();
    const init = actions.init();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const downloading = store.get().busy;
    expect(downloading).toEqual({ message: 'Downloading “Seeded”…' });

    await expect(actions.addPlaylistFromUrl({ url: URL_B })).rejects.toMatchObject({ code: 'HTTP' });
    expect(store.get().busy).toBe(downloading); // the first download is still running
    release();
    await init;
    expect(store.get()).toMatchObject({ activePlaylistId: 'pl_seed', playlistError: null, busy: null });
    expect(store.get().channels).toHaveLength(4);
  });

  it('adds the demo playlist once', async () => {
    const { store, actions } = setup();
    const demo = await actions.addDemoPlaylist();
    expect(demo).toMatchObject({ name: DEMO_PLAYLIST_NAME, source: { kind: 'demo' } });
    expect(demo.channelCount).toBeGreaterThanOrEqual(8);
    expect(store.get().groups.map((g) => g.name).sort()).toEqual(['Live', 'On demand']);
    expect(store.get().channels.every((ch) => ch.url.startsWith('https://'))).toBe(true);
    expect((await actions.addDemoPlaylist()).id).toBe(demo.id);
    expect(store.get().playlists).toHaveLength(1);
  });
});

describe('favorites & recents', () => {
  it('toggles favorites with snapshots that remember the playlist', async () => {
    respondWith();
    const { store, actions } = setup();
    const meta = await actions.addPlaylistFromUrl({ url: URL_A });
    const news = byName(store, 'News One');

    expect(actions.toggleFavorite(news)).toBe(true);
    const [fav] = store.get().favorites;
    expect(fav).toMatchObject({ id: news.id, name: 'News One', url: news.url, playlistId: meta.id });
    expect(fav.addedAt).toEqual(expect.any(Number));
    expect(lastWrite(KEYS.favorites)).toHaveLength(1);

    const foreign = { ...channelToSnapshot(byName(store, 'Sport One'), 'pl_other'), id: 'foreign' };
    actions.toggleFavorite({ ...foreign, playlistId: 'pl_other' });
    expect(store.get().favorites.map((f) => [f.id, f.playlistId])).toEqual([
      [news.id, meta.id],
      ['foreign', 'pl_other'],
    ]);

    expect(actions.toggleFavorite(news)).toBe(false);
    actions.removeFavorite('foreign');
    expect(store.get().favorites).toEqual([]);
    expect(lastWrite(KEYS.favorites)).toEqual([]);
  });

  it('records recents most-recent first, deduped and capped', async () => {
    respondWith();
    const { store, actions } = setup();
    await actions.addPlaylistFromUrl({ url: URL_A });
    const [a, b] = store.get().channels;

    actions.playChannel(a);
    actions.playChannel(b);
    actions.playChannel(a);
    expect(store.get().currentChannel).toBe(a);
    expect(store.get().playRequest).toBe(3);
    expect(store.get().recents.map((r) => r.id)).toEqual([a.id, b.id]);
    expect(store.get().recents[0].watchedAt).toEqual(expect.any(Number));

    actions.playChannel(a); // same channel again still bumps playRequest (player reloads)
    expect(store.get().playRequest).toBe(4);

    for (let i = 0; i < MAX_RECENTS + 5; i++) {
      actions.playChannel({ ...a, id: `extra-${i}`, url: `https://tv.example/${i}.m3u8` });
    }
    expect(store.get().recents).toHaveLength(MAX_RECENTS);
    expect(store.get().recents[0].id).toBe(`extra-${MAX_RECENTS + 4}`);
    expect(lastWrite(KEYS.recents)).toHaveLength(MAX_RECENTS);

    actions.clearRecents();
    expect(store.get().recents).toEqual([]);
  });
});

describe('playNext / playPrev', () => {
  it('steps through the visible list and wraps around', async () => {
    respondWith();
    const { store, actions } = setup();
    await actions.addPlaylistFromUrl({ url: URL_A });
    const names = () => store.get().currentChannel?.name;

    actions.playNext();
    expect(names()).toBe('News One'); // nothing playing → first
    actions.playPrev();
    expect(names()).toBe('Cartoon Time'); // wraps
    actions.playNext();
    expect(names()).toBe('News One');

    actions.stopPlayback();
    actions.playPrev();
    expect(names()).toBe('Cartoon Time'); // nothing playing → last

    actions.setCategory('group:News');
    actions.playNext();
    expect(names()).toBe('News One'); // current not in list → first
    actions.playNext();
    expect(names()).toBe('News Two');
    actions.playNext();
    expect(names()).toBe('News One');

    actions.setCategory('all');
    actions.setSort('name');
    actions.playChannel(byName(store, 'Cartoon Time'));
    actions.playNext();
    expect(names()).toBe('News One'); // A–Z: Cartoon Time → News One

    actions.setQuery('one');
    actions.playNext();
    expect(names()).toBe('Sport One'); // search results only
  });

  it('does not reshuffle "Recently watched" while stepping through it', async () => {
    respondWith();
    const { store, actions } = setup();
    await actions.addPlaylistFromUrl({ url: URL_A });
    const [a, b, c] = store.get().channels;
    actions.playChannel(c);
    actions.playChannel(b);
    actions.playChannel(a); // recents: a, b, c
    actions.setCategory(CATEGORY.recent);

    actions.playNext();
    actions.playNext();
    expect(store.get().currentChannel.id).toBe(c.id);
    expect(store.get().recents.map((r) => r.id)).toEqual([a.id, b.id, c.id]);
  });
});

describe('persistence', () => {
  it('debounces session writes and flushes on pagehide', async () => {
    vi.useFakeTimers();
    respondWith();
    const { store, actions } = setup();
    await actions.addPlaylistFromUrl({ url: URL_A });
    await vi.advanceTimersByTimeAsync(1000);
    storage.writeJSON.mockClear();

    actions.playChannel(byName(store, 'Sport One'));
    actions.setVolumeState({ volume: 0.4, muted: true });
    actions.setSort('name');
    expect(writesFor(KEYS.session)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(399);
    expect(writesFor(KEYS.session)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(writesFor(KEYS.session)).toHaveLength(1);
    expect(lastWrite(KEYS.session)).toEqual({
      activePlaylistId: store.get().activePlaylistId,
      lastChannelId: byName(store, 'Sport One').id,
      category: 'all',
      sort: 'name',
      groupSort: 'name',
      volume: 0.4,
      muted: true,
    });

    actions.setCategory('group:Sports');
    window.dispatchEvent(new Event('pagehide'));
    expect(writesFor(KEYS.session)).toHaveLength(2);
    expect(lastWrite(KEYS.session).category).toBe('group:Sports');
  });

  it('does not rewrite an unchanged session when the tab is hidden or closed', async () => {
    vi.useFakeTimers();
    respondWith();
    const { store, actions } = setup();
    await actions.addPlaylistFromUrl({ url: URL_A });
    await vi.advanceTimersByTimeAsync(1000);
    // Another tab saves its own session meanwhile; this idle tab must not overwrite it.
    mem.json.set(KEYS.session, { activePlaylistId: 'pl_other_tab' });
    storage.writeJSON.mockClear();
    window.dispatchEvent(new Event('pagehide'));
    document.dispatchEvent(new Event('visibilitychange'));
    actions.destroy();
    expect(writesFor(KEYS.session)).toHaveLength(0);
    expect(mem.json.get(KEYS.session)).toEqual({ activePlaylistId: 'pl_other_tab' });
    expect(store.get().activePlaylistId).not.toBe('pl_other_tab');
  });

  it('writes settings and theme immediately and applies the theme', () => {
    const { store, actions } = setup();
    actions.updateSettings({ maxRetries: 0, autoplay: false, corsProxy: ' https://proxy.example/?url= ', nope: 1 });
    expect(store.get().settings).toMatchObject({ maxRetries: 1, autoplay: false, corsProxy: 'https://proxy.example/?url=' });
    expect(lastWrite(KEYS.settings)).toEqual(store.get().settings);
    expect(Object.hasOwn(store.get().settings, 'nope')).toBe(false);

    actions.setAccent('rose');
    actions.setAccent('not-a-theme');
    actions.toggleMode();
    expect(store.get().theme).toEqual({ accent: 'rose', mode: 'light' });
    expect(lastWrite(KEYS.theme)).toEqual({ accent: 'rose', mode: 'light' });
    expect(applyTheme).toHaveBeenLastCalledWith({ accent: 'rose', mode: 'light' });
  });

  it('adopts favorites and theme changed in another tab without writing them back', () => {
    const { store } = setup();
    const snap = { id: 'x1', name: 'Remote', url: 'https://tv.example/remote.m3u8', group: 'News' };
    mem.json.set(KEYS.favorites, [snap]);
    mem.json.set(KEYS.theme, { accent: 'violet', mode: 'dark' });
    storage.writeJSON.mockClear();

    window.dispatchEvent(new StorageEvent('storage', { key: KEYS.favorites, newValue: JSON.stringify([snap]) }));
    window.dispatchEvent(new StorageEvent('storage', { key: KEYS.theme, newValue: '{}' }));

    expect(store.get().favorites).toEqual([{ ...snap, logo: '', tvgId: '', playlistId: null }]);
    expect(store.get().theme).toEqual({ accent: 'violet', mode: 'dark' });
    expect(applyTheme).toHaveBeenLastCalledWith({ accent: 'violet', mode: 'dark' });
    expect(storage.writeJSON).not.toHaveBeenCalled();
  });

  it('adopts the playlist list saved by another tab, so its playlists are never overwritten', async () => {
    respondWith((url) => (url === URL_B ? m3u(ENTRIES.slice(0, 1), 'Other') : SAMPLE));
    const { store, actions } = setup();
    const mine = await actions.addPlaylistFromUrl({ url: URL_A });
    const remote = { ...mine, id: 'pl_remote', name: 'From the other tab', source: { kind: 'url', url: URL_B } };
    mem.text.set('pl_remote', m3u(ENTRIES.slice(0, 1), 'Other'));
    const sync = (list) => {
      mem.json.set(KEYS.playlists, list);
      storage.writeJSON.mockClear();
      window.dispatchEvent(new StorageEvent('storage', { key: KEYS.playlists, newValue: JSON.stringify(list) }));
    };

    sync([mine, remote]);
    expect(store.get().playlists.map((p) => p.id)).toEqual([mine.id, 'pl_remote']);
    expect(writesFor(KEYS.playlists)).toHaveLength(0); // adopted, not written back
    actions.renamePlaylist(mine.id, 'Renamed here');
    expect(lastWrite(KEYS.playlists).map((p) => p.name)).toEqual(['Renamed here', 'From the other tab']);

    // The other tab deletes the playlist shown here → this tab moves on to the remaining one.
    sync([remote]);
    expect(store.get().activePlaylistId).toBe('pl_remote');
    await vi.waitFor(() => expect(store.get().channels.map((c) => c.name)).toEqual(['News One']));
    expect(storage.removePlaylistText).not.toHaveBeenCalled(); // the other tab already did

    sync([]); // e.g. "Clear all data" in the other tab
    expect(store.get()).toMatchObject({ playlists: [], activePlaylistId: null, channels: [] });
  });

  it('clearAllData wipes storage, stops persisting and reloads', () => {
    const reload = vi.spyOn(window.location, 'reload').mockImplementation(() => {});
    try {
      const { actions } = setup();
      actions.clearAllData();
      expect(storage.clearAllData).toHaveBeenCalledTimes(1);
      expect(reload).toHaveBeenCalledTimes(1);
      storage.writeJSON.mockClear();
      actions.setAccent('emerald');
      window.dispatchEvent(new Event('pagehide'));
      expect(storage.writeJSON).not.toHaveBeenCalled();
    } finally {
      reload.mockRestore();
    }
  });
});

describe('init', () => {
  it('restores the active playlist, category and last channel from storage', async () => {
    seedPlaylist();
    const sport = makeChannelId('Sport One', 'https://tv.example/sport1.m3u8');
    mem.json.set(KEYS.session, { activePlaylistId: 'pl_seed', category: 'group:Sports', lastChannelId: sport });
    mem.json.set(KEYS.theme, { accent: 'amber', mode: 'dark' });
    const { store, actions } = setup();

    await actions.init();

    const state = store.get();
    expect(applyTheme).toHaveBeenCalledWith({ accent: 'amber', mode: 'dark' });
    expect(state).toMatchObject({ ready: true, activePlaylistId: 'pl_seed', category: 'group:Sports', playRequest: 1 });
    expect(state.channels).toHaveLength(4);
    expect(state.currentChannel).toBe(byName(store, 'Sport One'));
    expect(state.recents).toEqual([]); // restoring isn't "watching"
    expect(fetchPlaylist).not.toHaveBeenCalled();
  });

  it('falls back to "all" for a group that no longer exists and skips restore when disabled', async () => {
    seedPlaylist();
    mem.json.set(KEYS.settings, { rememberLastChannel: false });
    mem.json.set(KEYS.session, { category: 'group:Gone', lastChannelId: makeChannelId('News One', ENTRIES[0][2]) });
    const { store, actions } = setup();
    await actions.init();
    expect(store.get()).toMatchObject({ category: 'all', currentChannel: null });
  });

  it('downloads uncached URL playlists and offers Retry when that fails', async () => {
    seedPlaylist({ text: null, cached: false });
    fetchPlaylist.mockRejectedValueOnce(new PlaylistLoadError('HTTP', 'Not found', { status: 404 }));
    const { store, actions } = setup();

    await actions.init();

    expect(store.get()).toMatchObject({
      ready: true,
      busy: null,
      channels: [],
      playlistError: { playlistId: 'pl_seed', message: 'Couldn’t load the playlist (HTTP).' },
    });
    const call = toast.error.mock.calls.find(([, opts]) => opts?.action);
    expect(call[1].action.label).toBe('Retry');

    respondWith();
    call[1].action.onClick();
    await vi.waitFor(() => expect(store.get().channels).toHaveLength(4));
    expect(store.get().playlistError).toBeNull();
    expect(mem.text.get('pl_seed')).toBe(SAMPLE);
  });

  it('plays ?play= links as a one-off channel and cleans the address bar', async () => {
    const stream = 'https://cdn.example/live/stream.m3u8';
    history.replaceState(null, '', `/?play=${encodeURIComponent(stream)}&name=My%20Stream&keep=1`);
    const { store, actions } = setup();
    await actions.init();

    expect(store.get().currentChannel).toMatchObject({
      id: makeChannelId('My Stream', stream),
      name: 'My Stream',
      url: stream,
      group: 'Direct',
      groups: ['Direct'],
    });
    expect(store.get().playlists).toEqual([]);
    expect(location.search).toBe('?keep=1');
  });

  it('handles ?playlist= by switching to a known URL or adding a new one', async () => {
    seedPlaylist({ id: 'pl_one', url: URL_A });
    seedPlaylist({ id: 'pl_two', url: URL_B, text: m3u(ENTRIES.slice(0, 2)) });
    mem.json.set(KEYS.session, { activePlaylistId: 'pl_one' });
    history.replaceState(null, '', `/?playlist=${encodeURIComponent(URL_B)}`);
    const first = setup();
    await first.actions.init();
    expect(first.store.get().activePlaylistId).toBe('pl_two');
    expect(first.store.get().channels).toHaveLength(2);
    expect(fetchPlaylist).not.toHaveBeenCalled();
    expect(location.search).toBe('');

    respondWith();
    const fresh = 'https://other.example/new.m3u';
    history.replaceState(null, '', `/?playlist=${encodeURIComponent(fresh)}&name=Shared`);
    const second = setup();
    await second.actions.init();
    expect(fetchPlaylist).toHaveBeenCalledWith(fresh, expect.any(Object));
    expect(second.store.get().playlists).toHaveLength(3);
    expect(second.store.get().playlists.at(-1)).toMatchObject({ name: 'Shared', source: { url: fresh } });
    expect(selectActiveName(second.store)).toBe('Shared');
  });

  it('refreshes stale URL playlists in the background and keeps the current channel', async () => {
    vi.useFakeTimers();
    seedPlaylist({ updatedAt: Date.now() - 48 * 3_600_000 });
    const news = makeChannelId('News One', ENTRIES[0][2]);
    mem.json.set(KEYS.session, { lastChannelId: news });
    respondWith(m3u([...ENTRIES, ['Extra', 'News', 'https://tv.example/extra.m3u8', '']]));
    const { store, actions } = setup();

    await actions.init();
    expect(store.get().channels).toHaveLength(4);
    const playing = store.get().currentChannel;
    expect(playing.id).toBe(news);
    expect(fetchPlaylist).not.toHaveBeenCalled(); // deferred so the stream starts first

    await vi.advanceTimersByTimeAsync(4000);
    await vi.waitFor(() => expect(store.get().channels).toHaveLength(5));
    expect(fetchPlaylist).toHaveBeenCalledTimes(1);
    expect(toast.info).toHaveBeenCalledWith('Playlist updated · 5 channels');
    expect(store.get().busy).toBeNull(); // silent: no global busy indicator
    expect(store.get().currentChannel).toBe(playing);
    expect(store.get().playRequest).toBe(1);
    expect(store.get().playlists[0].updatedAt).toBeGreaterThan(Date.now() - 1000);
  });
});

describe('playlist management', () => {
  it('switches, renames and removes playlists', async () => {
    respondWith((url) => (url === URL_A ? SAMPLE : m3u(ENTRIES.slice(0, 1), 'Second')));
    const { store, actions } = setup();
    const a = await actions.addPlaylistFromUrl({ url: URL_A });
    const b = await actions.addPlaylistFromUrl({ url: URL_B });
    expect(store.get().channels).toHaveLength(1);

    actions.setCategory(CATEGORY.favorites);
    await actions.switchPlaylist(a.id);
    expect(store.get()).toMatchObject({ activePlaylistId: a.id, category: 'all' });
    expect(store.get().channels).toHaveLength(4);
    expect(fetchPlaylist).toHaveBeenCalledTimes(2); // served from the cache

    actions.renamePlaylist(a.id, '  Living room  ');
    actions.renamePlaylist(a.id, '   ');
    expect(store.get().playlists[0].name).toBe('Living room');

    actions.removePlaylist(a.id);
    expect(store.get().activePlaylistId).toBe(b.id);
    await vi.waitFor(() => expect(store.get().channels).toHaveLength(1));
    expect(mem.text.has(a.id)).toBe(false);

    actions.removePlaylist(b.id);
    expect(store.get()).toMatchObject({ playlists: [], activePlaylistId: null, channels: [], groups: [] });
  });

  it('refreshes URL playlists in place and refuses to refresh file playlists', async () => {
    respondWith();
    const { store, actions } = setup();
    const meta = await actions.addPlaylistFromUrl({ url: URL_A });
    actions.setCategory('group:Sports');
    const channels = store.get().channels;

    await actions.refreshPlaylist(meta.id); // same content
    expect(store.get().channels).toBe(channels); // nothing re-rendered
    expect(toast.success).toHaveBeenLastCalledWith('“Sample TV” updated · 4 channels');

    respondWith(m3u(ENTRIES.filter(([name]) => name !== 'Sport One')));
    await actions.refreshPlaylist(meta.id);
    expect(store.get().channels).toHaveLength(3);
    expect(store.get().category).toBe('all'); // the Sports group is gone
    expect(store.get().playlists[0]).toMatchObject({ id: meta.id, channelCount: 3 });

    const file = await actions.addPlaylistFromText(SAMPLE, { source: { kind: 'file', fileName: 'x.m3u' } });
    await expect(actions.refreshPlaylist(file.id)).rejects.toThrow(/can’t be refreshed/);
    expect(fetchPlaylist).toHaveBeenCalledTimes(3);
  });

  it('exports favorites and stored playlists as .m3u downloads', async () => {
    respondWith();
    const { store, actions } = setup();
    const meta = await actions.addPlaylistFromUrl({ url: URL_A, name: 'Living: Room?' });

    actions.exportFavorites();
    expect(downloadText).not.toHaveBeenCalled();
    expect(toast.info).toHaveBeenCalled();

    actions.toggleFavorite(byName(store, 'News Two'));
    actions.toggleFavorite(byName(store, 'Cartoon Time'));
    actions.exportFavorites();
    const [fileName, text] = downloadText.mock.calls[0];
    expect(fileName).toBe('favorites.m3u');
    expect(text).toContain('#PLAYLIST:Favorites');
    expect(text.indexOf('News Two')).toBeLessThan(text.indexOf('Cartoon Time')); // insertion order
    expect(text).toContain('group-title="Movies;Kids"');

    await actions.exportPlaylist(meta.id);
    expect(downloadText).toHaveBeenLastCalledWith('Living Room.m3u', SAMPLE);
  });

  it('validates browsing input', async () => {
    respondWith();
    const { store, actions } = setup();
    await actions.addPlaylistFromUrl({ url: URL_A });
    actions.setCategory('group:Nope');
    actions.setSort('random');
    actions.setGroupSort('playlist');
    actions.setSidebarOpen(1);
    expect(store.get()).toMatchObject({ category: 'all', sort: 'playlist', groupSort: 'playlist', sidebarOpen: true });
    actions.setCategory(`group:${UNCATEGORIZED}`);
    expect(store.get().category).toBe('all');
    actions.setCategory('group:Kids');
    expect(store.get().category).toBe('group:Kids');
  });
});

function selectActiveName(store) {
  const state = store.get();
  return state.playlists.find((p) => p.id === state.activePlaylistId)?.name;
}
