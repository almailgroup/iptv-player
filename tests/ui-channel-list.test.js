// Channel list UI: the now-playing equalizer follows state.playbackState (repainting only the current row),
// recycled rows cancel their stale logo downloads, channels that can't play here are flagged (or hidden,
// with the sort menu's "Hide unplayable channels"), the row / header anatomy (one meta pill + "+1",
// hashed-hue initials, emphasised counts), the no-playlist hint and recycled logo plates.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStore } from '../src/app/store.js';
import { DEFAULT_SETTINGS } from '../src/app/constants.js';
import { hueFromString } from '../src/lib/utils.js';
import { createChannelList } from '../src/ui/channel-list.js';

function channel(i, extra = {}) {
  return {
    id: `ch${i}`,
    index: i,
    name: `Channel ${i}`,
    url: `https://example.com/${i}.m3u8`,
    group: 'News',
    groups: ['News'],
    logo: '',
    tvgId: '',
    tvgName: '',
    chno: null,
    duration: -1,
    attrs: {},
    headers: {},
    drm: false,
    ...extra,
  };
}

function setup({ channels = [channel(0), channel(1), channel(2)], ...state } = {}) {
  const store = createStore({
    ready: true,
    busy: null,
    playlists: [{ id: 'pl1', name: 'Test', source: { kind: 'url', url: 'https://example.com/p.m3u' } }],
    activePlaylistId: 'pl1',
    playlistError: null,
    channels,
    groups: [{ name: 'News', count: channels.length, firstIndex: 0 }],
    category: 'all',
    query: '',
    sort: 'playlist',
    groupSort: 'name',
    favorites: [],
    recents: [],
    currentChannel: null,
    playRequest: 0,
    playbackState: 'idle',
    theme: { accent: 'azure', mode: 'dark' },
    settings: { ...DEFAULT_SETTINGS },
    health: {},
    sidebarOpen: false,
    ...state,
  });
  const actions = {
    setQuery: vi.fn((query) => store.set({ query })),
    setCategory: vi.fn((category) => store.set({ category })),
    setSort: vi.fn(),
    updateSettings: vi.fn((patch) => store.set((s) => ({ settings: { ...s.settings, ...patch } }))),
    playChannel: vi.fn(),
    toggleFavorite: vi.fn(),
    setSidebarOpen: vi.fn(),
    exportFavorites: vi.fn(),
    clearRecents: vi.fn(),
  };
  const list = createChannelList({ store, actions });
  document.body.append(list.el);
  const rowFor = (id) =>
    [...list.el.querySelectorAll('.cl-row')].find((r) => r.dataset.key === id && r.style.display !== 'none');
  return { store, actions, list, rowFor };
}

let current = null;
afterEach(() => {
  current?.list.destroy();
  current = null;
  document.body.replaceChildren();
  vi.restoreAllMocks();
  window.happyDOM?.setURL('http://localhost:3000/');
});

describe('now-playing equalizer', () => {
  it('exposes the playback state only on the current row', () => {
    current = setup();
    const { store, rowFor } = current;
    store.set({ currentChannel: store.get().channels[1], playbackState: 'playing' });
    expect(rowFor('ch1').dataset.playback).toBe('playing');
    expect(rowFor('ch0').dataset.playback).toBeUndefined();
    expect(rowFor('ch2').dataset.playback).toBeUndefined();
    expect(rowFor('ch1').getAttribute('aria-label')).toContain('now playing');
  });

  it('follows every PlayerState and treats unknown / missing values as idle', () => {
    current = setup();
    const { store, rowFor } = current;
    store.set({ currentChannel: store.get().channels[0] });
    for (const state of ['loading', 'buffering', 'playing', 'paused', 'reconnecting', 'error', 'idle']) {
      store.set({ playbackState: state });
      expect(rowFor('ch0').dataset.playback).toBe(state);
    }
    store.set({ playbackState: undefined });
    expect(rowFor('ch0').dataset.playback).toBe('idle');
    store.set({ playbackState: 'bogus' });
    expect(rowFor('ch0').dataset.playback).toBe('idle');
  });

  it('labels paused and failed playback for assistive tech', () => {
    current = setup();
    const { store, rowFor } = current;
    store.set({ currentChannel: store.get().channels[2], playbackState: 'error' });
    expect(rowFor('ch2').getAttribute('aria-label')).toContain('playback failed');
    expect(rowFor('ch2').getAttribute('aria-label')).not.toContain('now playing');
    store.set({ playbackState: 'paused' });
    expect(rowFor('ch2').getAttribute('aria-label')).toContain('paused');
  });

  it('repaints only the current row when just the playback state changes', async () => {
    current = setup({ channels: Array.from({ length: 30 }, (_, i) => channel(i)) });
    const { store, list, rowFor } = current;
    store.set({ currentChannel: store.get().channels[3], playbackState: 'loading' });
    const touched = new Set();
    const observer = new MutationObserver((records) => {
      for (const rec of records) {
        const row = (rec.target.nodeType === 1 ? rec.target : rec.target.parentElement)?.closest('.cl-row');
        if (row) touched.add(row.dataset.key);
      }
    });
    observer.observe(list.el, { subtree: true, attributes: true, childList: true, characterData: true });
    store.set({ playbackState: 'playing' });
    await Promise.resolve(); // flush mutation records
    observer.disconnect();
    expect(rowFor('ch3').dataset.playback).toBe('playing');
    expect([...touched]).toEqual(['ch3']);
  });

  it('moves the state to the new row when the current channel changes', () => {
    current = setup();
    const { store, rowFor } = current;
    store.set({ currentChannel: store.get().channels[0], playbackState: 'playing' });
    store.set({ currentChannel: store.get().channels[1], playbackState: 'loading' });
    expect(rowFor('ch0').dataset.playback).toBeUndefined();
    expect(rowFor('ch1').dataset.playback).toBe('loading');
  });
});

describe('channel logos on recycled rows', () => {
  const logo = (i) => `https://cdn.example.com/logo/${i}.png`;

  it('cancels the previous logo download when a row is reused for another channel', () => {
    current = setup({ channels: [channel(0, { logo: logo(0) }), channel(1, { logo: logo(1) })] });
    const { store, rowFor } = current;
    const oldImg = rowFor('ch0').querySelector('img');
    expect(oldImg.getAttribute('src')).toBe(logo(0));
    Object.defineProperty(oldImg, 'complete', { value: false, configurable: true }); // still downloading

    // Same row position, different channel (e.g. another playlist / category).
    store.set({ channels: [channel(5, { logo: logo(5) }), channel(6, { logo: logo(6) })] });
    const row = rowFor('ch5');
    expect(row.querySelector('img').getAttribute('src')).toBe(logo(5));
    expect(oldImg.isConnected).toBe(false);
    expect(oldImg.hasAttribute('src')).toBe(false); // request aborted
  });

  it('does not blacklist a logo whose cancelled download reports an error', () => {
    current = setup({ channels: [channel(0, { logo: logo(0) })] });
    const { store, rowFor } = current;
    const oldImg = rowFor('ch0').querySelector('img');
    Object.defineProperty(oldImg, 'complete', { value: false, configurable: true });
    store.set({ channels: [channel(7, { logo: logo(7) })] });
    oldImg.dispatchEvent(new Event('error')); // late error from the aborted request

    store.set({ channels: [channel(0, { logo: logo(0) })] });
    const img = rowFor('ch0').querySelector('img');
    expect(img).not.toBeNull();
    expect(img.getAttribute('src')).toBe(logo(0));
  });

  it('falls back to initials when the logo of the visible row fails', () => {
    current = setup({ channels: [channel(0, { logo: logo(100) })] });
    const { rowFor } = current;
    const img = rowFor('ch0').querySelector('img');
    img.dispatchEvent(new Event('error'));
    const avatar = rowFor('ch0').querySelector('.cl-avatar');
    expect(avatar.querySelector('img')).toBeNull();
    expect(avatar.classList.contains('avatar-fallback')).toBe(true);
    expect(avatar.textContent).toBe('C0');
  });
});

describe('playability flags', () => {
  const flagged = () => [
    channel(0),
    channel(1, { name: 'RTMP', url: 'rtmp://example.com/live/1' }),
    channel(2, { name: 'DASH', url: 'https://example.com/live/manifest.mpd' }),
    channel(3, { name: 'Widevine', drm: true }),
    channel(4, { name: 'Insecure', url: 'http://203.0.113.7:8080/live/index.m3u8' }),
  ];
  const flagOf = (row) => row.querySelector('.cl-flag');

  it('labels channels that can’t play here, with the reason as tooltip and in the row’s name', () => {
    window.happyDOM.setURL('https://me.github.io/iptv/');
    current = setup({ channels: flagged() });
    const { rowFor } = current;
    expect(flagOf(rowFor('ch0'))).toBeNull();
    expect(rowFor('ch0').classList.contains('is-unplayable')).toBe(false);

    const expected = {
      ch1: ['unsupported', 'Not supported', 'rtmp:// streams can’t be played in a browser.'],
      ch2: ['unsupported', 'Not supported', 'MPEG-DASH streams aren’t supported.'],
      ch3: ['drm', 'DRM', 'DRM-protected — can’t play in the browser.'],
      ch4: ['insecure', 'HTTP', 'Insecure http:// stream — browsers block it on this secure site.'],
    };
    for (const [id, [kind, label, title]] of Object.entries(expected)) {
      const row = rowFor(id);
      const flag = flagOf(row);
      expect(flag.dataset.kind).toBe(kind);
      expect(flag.textContent).toBe(label);
      expect(flag.title).toBe(title);
      expect(row.querySelector('.cl-meta').firstChild).toBe(flag); // leads the meta line
      expect(row.classList.contains('is-unplayable')).toBe(true);
      expect(row.dataset.flag).toBe(kind);
      expect(row.getAttribute('aria-label')).toContain(title.replace(/\.$/, ''));
    }
    expect(rowFor('ch4').querySelector('.cl-meta').textContent).toBe('HTTPNews');
  });

  it('drops the HTTP flag once a relay is in effect', () => {
    window.happyDOM.setURL('https://me.github.io/');
    current = setup({ channels: flagged() });
    const { store, rowFor } = current;
    expect(flagOf(rowFor('ch4')).textContent).toBe('HTTP');
    store.set((s) => ({ settings: { ...s.settings, corsProxy: 'https://my-relay.deno.dev' } }));
    expect(flagOf(rowFor('ch4'))).toBeNull();
    expect(rowFor('ch4').classList.contains('is-unplayable')).toBe(false);
    expect(flagOf(rowFor('ch1')).textContent).toBe('Not supported'); // still can't play
  });

  it('shows remembered failures as "Unavailable" with how long ago, and clears them when they play', () => {
    const now = Date.UTC(2026, 9, 9, 12, 0, 0);
    vi.spyOn(Date, 'now').mockReturnValue(now);
    current = setup();
    const { store, rowFor } = current;
    store.set({ health: { ch1: { code: 'HTTP', title: 'Channel not found', at: now - 5 * 60_000 } } });
    const flag = flagOf(rowFor('ch1'));
    expect(flag.dataset.kind).toBe('failed');
    expect(flag.textContent).toBe('Unavailable');
    expect(flag.title).toBe('Channel not found · 5 min ago');
    expect(rowFor('ch1').getAttribute('aria-label')).toContain('unavailable: Channel not found');

    // The tooltip's age is refreshed when the pointer reaches it.
    Date.now.mockReturnValue(now + 2 * 3_600_000);
    flag.dispatchEvent(new Event('pointerover', { bubbles: true }));
    expect(flag.title).toBe('Channel not found · 2 h ago');

    store.set({ health: {} });
    expect(flagOf(rowFor('ch1'))).toBeNull();
    expect(rowFor('ch1').getAttribute('aria-label')).not.toContain('unavailable');
  });

  it('keeps the static reason when a flagged channel also failed', () => {
    current = setup({ channels: flagged() });
    const { store, rowFor } = current;
    store.set({ health: { ch3: { code: 'DRM', title: 'Protected content', at: Date.now() } } });
    expect(flagOf(rowFor('ch3')).dataset.kind).toBe('drm');
  });

  it('tones each flag by how serious it is (a local-network stream is informational)', () => {
    window.happyDOM.setURL('https://me.github.io/');
    current = setup({
      channels: [...flagged(), channel(5, { name: 'LAN', url: 'http://192.168.1.20/live/index.m3u8' }), channel(6)],
    });
    const { store, rowFor } = current;
    store.set({ health: { ch6: { code: 'HTTP', title: 'Channel not found', at: Date.now() } } });
    const tones = Object.fromEntries(
      ['ch1', 'ch3', 'ch4', 'ch5', 'ch6'].map((id) => [flagOf(rowFor(id)).textContent, flagOf(rowFor(id)).dataset.tone]),
    );
    expect(tones).toEqual({
      'Not supported': 'unsupported',
      DRM: 'drm',
      HTTP: 'warning',
      Local: 'info',
      Unavailable: 'danger',
    });
  });
});

describe('row and header anatomy', () => {
  const playlists = [
    { id: 'pl1', name: 'Test', source: { kind: 'url', url: 'https://example.com/p.m3u' } },
    { id: 'pl2', name: 'Travel list', source: { kind: 'url', url: 'https://example.com/t.m3u' } },
  ];

  it('shows at most one meta pill: a second reason folds into a "+1" chip', () => {
    const favorites = [
      { id: 'r1', name: 'Remote RTMP', url: 'rtmp://example.com/r', group: 'News', playlistId: 'pl2' },
      { id: 'r2', name: 'Remote HLS', url: 'https://example.com/r.m3u8', group: 'News', playlistId: 'pl2' },
    ];
    current = setup({ playlists, favorites, category: 'favorites' });
    const { rowFor } = current;
    const meta = (id) => rowFor(id).querySelector('.cl-meta');

    // Can't play here AND from another playlist: the flag leads, the tag becomes "+1" (named in its tooltip).
    expect([...meta('r1').children].map((el) => el.className)).toEqual(['cl-flag', 'cl-more']);
    expect(meta('r1').querySelector('.cl-more').title).toBe('Other playlist · From “Travel list”');
    expect(meta('r1').textContent).toBe('Not supported+1News');
    expect(rowFor('r1').getAttribute('aria-label')).toContain('from another playlist');

    // Only from another playlist: the tag itself leads the line.
    expect(meta('r2').firstChild.className).toBe('cl-tag');
    expect(meta('r2').textContent).toBe('Other playlistNews');
  });

  it('separates the group and channel number', () => {
    current = setup({ channels: [channel(0, { chno: 12 })] });
    const meta = current.rowFor('ch0').querySelector('.cl-meta');
    expect(meta.textContent).toBe('News · #12');
    expect(meta.querySelector('.cl-sep').textContent).toBe(' · ');
  });

  it('tints initials with the channel name’s hashed hue (--h)', () => {
    current = setup();
    const avatar = current.rowFor('ch1').querySelector('.cl-avatar');
    expect(avatar.classList.contains('avatar-fallback')).toBe(true);
    expect(avatar.style.getPropertyValue('--h')).toBe(String(hueFromString('Channel 1')));
    expect(avatar.textContent).toBe('C1');
  });

  it('emphasises the leading count and names the category size in the search placeholder', () => {
    current = setup({ channels: Array.from({ length: 12 }, (_, i) => channel(i)) });
    const { store, list } = current;
    const count = list.el.querySelector('.cl-count');
    const search = list.el.querySelector('#cl-search');
    expect(count.querySelector('b').textContent).toBe('12');
    expect(count.textContent).toBe('12 channels');
    expect(search.placeholder).toBe('Search 12 channels');
    expect(search.getAttribute('aria-label')).toBe('Search channels');
    store.set({ query: 'channel 1' });
    expect(count.textContent).toMatch(/^\d+ of 12$/);
    const shown = [...list.el.querySelectorAll('.cl-row')].filter((r) => r.style.display !== 'none');
    expect(count.querySelector('b').textContent).toBe(String(shown.length));
  });

  it('highlights a multi-word match as one pill, spaces included', () => {
    current = setup({ channels: [channel(0, { name: 'Pinewood Public Access' }), channel(1, { name: 'Civic Channel' })] });
    const { store, rowFor } = current;
    store.set({ query: 'pinewood public access' });
    const marks = [...rowFor('ch0').querySelectorAll('.cl-name mark')].map((m) => m.textContent);
    expect(marks).toEqual(['Pinewood Public Access']);
    expect(rowFor('ch0').querySelector('.cl-name').textContent).toBe('Pinewood Public Access');
    // Characters between matches that aren't whitespace stay unmarked.
    store.set({ query: 'civic chan' });
    expect([...rowFor('ch1').querySelectorAll('.cl-name mark')].map((m) => m.textContent)).toEqual(['Civic Chan']);
  });

  it('offers to search all N channels when a search inside a group finds nothing', () => {
    current = setup({ category: 'group:News' });
    const { store, list, actions } = current;
    store.set({ query: 'zzzz' });
    const buttons = [...list.el.querySelectorAll('.cl-empty button')].map((b) => b.textContent);
    expect(buttons).toEqual(['Search all 3 channels', 'Clear']);
    list.el.querySelector('.cl-empty .btn-primary').click();
    expect(actions.setCategory).toHaveBeenCalledWith('all');
  });
});

describe('no playlist yet', () => {
  it('keeps its actions and adds the one-line hint the app shows beside the welcome hero', () => {
    current = setup({ playlists: [], activePlaylistId: null, channels: [], groups: [] });
    const { list } = current;
    const empty = list.el.querySelector('.cl-empty');
    expect(empty.hidden).toBe(false);
    // Without the app shell (#app[data-library='empty']) the full state shows, with both actions …
    const buttons = [...empty.querySelectorAll('.cl-empty-state button')].map((b) => b.textContent);
    expect(buttons).toEqual(['Add playlist', 'Try demo channels']);
    // … channels.css swaps it for this line next to the hero, which holds the same actions.
    expect(list.el.dataset.mode).toBe('no-playlist');
    expect(empty.querySelector('.cl-empty-hint').textContent).toBe('Your channels will appear here');
  });
});

describe('logo plates', () => {
  it('clears a recycled avatar’s fitted plate when its row shows initials', () => {
    current = setup({ channels: [channel(0, { logo: 'https://logos.example/0.png' }), channel(1)] });
    const { store, rowFor } = current;
    const avatar = rowFor('ch0').querySelector('.cl-avatar');
    avatar.dataset.shape = 'wide';
    avatar.dataset.tone = 'light';
    avatar.style.setProperty('--logo-box', 'inset(10% 0% 10% 0%)');
    store.set((s) => ({ settings: { ...s.settings, showLogos: false } }));
    expect(avatar.classList.contains('avatar-fallback')).toBe(true);
    expect(avatar.dataset.shape).toBeUndefined();
    expect(avatar.dataset.tone).toBeUndefined();
    expect(avatar.style.getPropertyValue('--logo-box')).toBe('');
  });
});

describe('hiding unplayable channels', () => {
  const channels = () => [
    channel(0),
    channel(1, { url: 'rtmp://example.com/1' }),
    channel(2),
    channel(3, { drm: true }),
    channel(4, { url: 'udp://239.0.0.1:1234' }),
  ];
  const hide = (store, on = true) =>
    store.set((s) => ({ settings: { ...s.settings, hideUnplayable: on } }));
  const visibleKeys = (list) =>
    [...list.el.querySelectorAll('.cl-row')].filter((r) => r.style.display !== 'none').map((r) => r.dataset.key);
  const count = (list) => list.el.querySelector('.cl-count').textContent;

  it('counts hidden channels in the header', () => {
    current = setup({ channels: channels() });
    const { store, list } = current;
    expect(count(list)).toBe('5 channels');
    hide(store);
    expect(visibleKeys(list)).toEqual(['ch0', 'ch2']);
    expect(count(list)).toBe('2 channels · 3 hidden');
    expect(list.el.querySelector('.cl-count').title).toBe('3 channels that can’t play here');
    store.set({ query: 'channel' });
    expect(count(list)).toBe('2 of 2 · 3 hidden');
    store.set({ query: '' });
    hide(store, false);
    expect(count(list)).toBe('5 channels');
    expect(list.el.querySelector('.cl-count').title).toBe('');
  });

  it('adds a "Hide unplayable channels" toggle to the sort menu', () => {
    current = setup({ channels: channels() });
    const { store, actions, list } = current;
    const sortBtn = list.el.querySelector('.cl-sort-btn');
    expect(sortBtn.getAttribute('aria-label')).toBe('Sort and filter channels');
    sortBtn.click();
    const menu = document.querySelector('.cl-sort-menu');
    const items = [...menu.querySelectorAll('.menu-item')];
    expect(items.map((i) => i.textContent)).toEqual(['Playlist order', 'Name A–Z', 'Hide unplayable channels']);
    expect(menu.querySelector('.menu-separator')).not.toBeNull();
    const toggle = items[2];
    expect(toggle.getAttribute('role')).toBe('menuitemcheckbox');
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    toggle.click();
    expect(actions.updateSettings).toHaveBeenCalledWith({ hideUnplayable: true });
    expect(store.get().settings.hideUnplayable).toBe(true);
    expect(sortBtn.classList.contains('is-sorted')).toBe(true); // quiet "not the default view" dot
    expect(sortBtn.title).toBe('Sort: Playlist order · unplayable channels hidden');

    sortBtn.click();
    const again = [...document.querySelectorAll('.cl-sort-menu .menu-item')].at(-1);
    expect(again.getAttribute('aria-checked')).toBe('true');
    again.click();
    expect(actions.updateSettings).toHaveBeenLastCalledWith({ hideUnplayable: false });
  });

  it('offers only the filter in Recently watched', () => {
    const recents = [{ id: 'ch1', name: 'Channel 1', url: 'rtmp://example.com/1', group: 'News' }];
    current = setup({ channels: channels(), recents, category: 'recent' });
    const { list } = current;
    const sortBtn = list.el.querySelector('.cl-sort-btn');
    expect(sortBtn.hidden).toBe(false);
    expect(sortBtn.getAttribute('aria-label')).toBe('Filter channels');
    sortBtn.click();
    const items = [...document.querySelectorAll('.cl-sort-menu .menu-item')];
    expect(items.map((i) => i.textContent)).toEqual(['Hide unplayable channels']);
    expect(document.querySelector('.cl-sort-menu .menu-separator')).toBeNull();
  });

  it('explains an all-hidden category and can show its channels again', () => {
    const all = [channel(0, { drm: true }), channel(1, { url: 'rtmp://example.com/1' })];
    current = setup({ channels: all, settings: { ...DEFAULT_SETTINGS, hideUnplayable: true } });
    const { list, actions } = current;
    const empty = list.el.querySelector('.cl-empty');
    expect(empty.hidden).toBe(false);
    expect(empty.querySelector('h3').textContent).toBe('No playable channels');
    expect(empty.querySelector('p').textContent).toBe(
      'All 2\u00a0channels in this playlist can’t play here, so they’re hidden.',
    );
    expect(count(list)).toBe('0 channels · 2 hidden');
    [...empty.querySelectorAll('button')].find((b) => b.textContent === 'Show them anyway').click();
    expect(actions.updateSettings).toHaveBeenCalledWith({ hideUnplayable: false });
    expect(empty.hidden).toBe(true);
    expect(visibleKeys(list)).toEqual(['ch0', 'ch1']);
  });

  it('mentions hidden channels when a search finds nothing', () => {
    current = setup({ channels: channels(), settings: { ...DEFAULT_SETTINGS, hideUnplayable: true } });
    const { store, list, actions } = current;
    store.set({ query: 'zzzz' });
    const empty = list.el.querySelector('.cl-empty');
    expect(empty.querySelector('p').textContent).toBe(
      'Check the spelling or try fewer words. 3\u00a0unplayable channels are hidden.',
    );
    [...empty.querySelectorAll('button')].find((b) => b.textContent === 'Show hidden').click();
    expect(actions.updateSettings).toHaveBeenCalledWith({ hideUnplayable: false });
  });
});
