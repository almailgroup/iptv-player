// Channel list UI: the now-playing equalizer follows state.playbackState (repainting only the current row),
// and recycled rows cancel their stale logo downloads.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStore } from '../src/app/store.js';
import { DEFAULT_SETTINGS } from '../src/app/constants.js';
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
    sidebarOpen: false,
    ...state,
  });
  const actions = {
    setQuery: vi.fn((query) => store.set({ query })),
    setCategory: vi.fn((category) => store.set({ category })),
    setSort: vi.fn(),
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
