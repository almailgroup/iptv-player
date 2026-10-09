// Player view (src/ui/player-view.js) wiring: playback-state publishing and volume persistence rules.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('hls.js', () => {
  class FakeHls {
    static isSupported() {
      return true;
    }
    static Events = { ERROR: 'hlsError', MANIFEST_PARSED: 'hlsManifestParsed' };
    static ErrorTypes = {};
    static ErrorDetails = {};
    on() {}
    attachMedia() {}
    loadSource() {}
    destroy() {}
  }
  return { default: FakeHls };
});

import { createStore } from '../src/app/store.js';
import { DEFAULT_SETTINGS } from '../src/app/constants.js';
import { createPlayerView } from '../src/ui/player-view.js';

const channel = (name, url) => ({
  id: name.toLowerCase().replace(/\W+/g, '-'),
  index: 0,
  name,
  url,
  group: 'Live',
  groups: ['Live'],
  logo: '',
  tvgId: '',
  tvgName: '',
  chno: null,
  duration: -1,
  attrs: {},
  headers: {},
  drm: false,
});

const WEBM = channel('Clip', 'http://127.0.0.1:8090/clip.webm');
const RTMP = channel('Broken', 'rtmp://example.com/live/stream');

function initialState(patch = {}) {
  return {
    ready: true,
    busy: null,
    playlists: [{ id: 'pl_1', name: 'Test', source: { kind: 'url', url: 'http://x/test.m3u' } }],
    activePlaylistId: 'pl_1',
    playlistError: null,
    channels: [WEBM, RTMP],
    groups: [{ name: 'Live', count: 2, firstIndex: 0 }],
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
    volume: 1,
    muted: false,
    sidebarOpen: false,
    ...patch,
  };
}

let store;
let actions;
let view;

function mount(patch) {
  store = createStore(initialState(patch));
  actions = {
    setVolumeState: vi.fn((v) => store.set(v)),
    playNext: vi.fn(),
    playPrev: vi.fn(),
    toggleFavorite: vi.fn(),
    setCategory: vi.fn(),
    addDemoPlaylist: vi.fn(),
    refreshPlaylist: vi.fn(),
  };
  view = createPlayerView({ store, actions });
  document.body.append(view.el);
  const video = view.el.querySelector('video');
  video.play = vi.fn(() => Promise.resolve());
  video.load = vi.fn();
  return video;
}

const play = (ch) => store.set((s) => ({ currentChannel: ch, playRequest: s.playRequest + 1 }));
const flush = async (n = 30) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

beforeEach(() => {
  document.body.replaceChildren();
});

afterEach(() => {
  view?.destroy();
  view = null;
  vi.restoreAllMocks();
});

describe('player view — playbackState', () => {
  it('publishes the player state to the store and idle on stop/destroy', async () => {
    const video = mount();
    const seen = [];
    store.select((s) => s.playbackState, (v) => seen.push(v));
    expect(store.get().playbackState).toBe('idle');

    play(WEBM);
    await flush();
    expect(store.get().playbackState).toBe('loading');
    video.dispatchEvent(new Event('playing'));
    expect(store.get().playbackState).toBe('playing');

    play(RTMP);
    await flush();
    expect(store.get().playbackState).toBe('error');

    store.set({ currentChannel: null });
    expect(store.get().playbackState).toBe('idle');
    expect(seen).toEqual(['loading', 'playing', 'loading', 'error', 'idle']);

    play(WEBM);
    await flush();
    expect(store.get().playbackState).toBe('loading');
    view.destroy();
    expect(store.get().playbackState).toBe('idle');
  });

  it('publishes loading as soon as a new channel is requested (not the previous channel\'s state)', async () => {
    mount();
    play(RTMP);
    await flush();
    expect(store.get().playbackState).toBe('error');
    let stateAtLoad = null;
    const load = view.player.load.bind(view.player);
    view.player.load = (source) => {
      stateAtLoad = store.get().playbackState;
      return load(source);
    };
    play(WEBM);
    expect(stateAtLoad).toBe('loading');
    expect(store.get().playbackState).toBe('loading');
  });
});

describe('player view — volume persistence', () => {
  it('does not persist the automatic autoplay mute, even right after page load', async () => {
    vi.spyOn(performance, 'now').mockReturnValue(300); // autoplay typically happens within the first second
    const video = mount();
    play(WEBM);
    await flush();
    video.muted = true; // what Player does when unmuted autoplay is refused
    video.dispatchEvent(new Event('volumechange'));
    expect(actions.setVolumeState).not.toHaveBeenCalled();
    expect(store.get().muted).toBe(false);
  });

  it('persists mute changes the user makes', async () => {
    const video = mount();
    view.toggleMute();
    video.dispatchEvent(new Event('volumechange'));
    expect(actions.setVolumeState).toHaveBeenLastCalledWith({ volume: 1, muted: true });
    view.setVolume(0.4);
    video.dispatchEvent(new Event('volumechange'));
    expect(actions.setVolumeState).toHaveBeenLastCalledWith({ volume: 0.4, muted: false });
  });
});
