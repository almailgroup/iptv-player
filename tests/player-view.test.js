// Player view (src/ui/player-view.js) wiring: playback-state publishing, volume persistence rules, channel
// health reports (markChannelOk / markChannelFailed) and the stream relay integration: Player options,
// error-panel actions and copy (own relay, built-in relay, none), status line and notices.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';

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
const INSECURE = channel('Fox News', 'http://1.2.3.4:8080/live/index.m3u8');
const LAN = channel('Living Room', 'http://192.168.1.20:9981/stream/channel/1');
const RELAY = 'https://my-relay.deno.dev';
const LOCAL_DETAIL =
  'This stream is on your local network. Browsers block insecure streams on secure sites; open the player over ' +
  'http on your network (e.g. run it locally) to watch it.';

/** Play LAN on an https page, where it is blocked (no https attempt), and check the error panel. */
async function expectLocalNetworkBlock() {
  view.player.setOptions({ pageProtocol: 'https:' });
  play(LAN);
  await flush();
  expect(view.player.error).toMatchObject({ code: 'MIXED_CONTENT', localNetwork: true });
  expect(view.player.viaProxy).toBe(false);
  expect(view.el.querySelector('.pv-error-title').textContent).toBe('Blocked insecure stream');
  expect(view.el.querySelector('.pv-error-detail').textContent).toBe(LOCAL_DETAIL);
  // No relay can reach it: no setup guide or relay settings, and retrying changes nothing.
  expect(errorButtons()).toEqual(['Next channel', 'Copy stream URL']);
  expect(errorButton('Next channel').classList.contains('btn-primary')).toBe(true);
  // The list flags it as "Local" already; it isn't remembered as a failed channel.
  expect(actions.markChannelFailed).not.toHaveBeenCalled();
}

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
/** The modules mount() uses — swapped for fresh copies built with a built-in relay in that describe. */
let modules = { createStore, createPlayerView };

function mount(patch) {
  store = modules.createStore(initialState(patch));
  actions = {
    setVolumeState: vi.fn((v) => store.set(v)),
    playNext: vi.fn(),
    playPrev: vi.fn(),
    toggleFavorite: vi.fn(),
    setCategory: vi.fn(),
    addDemoPlaylist: vi.fn(),
    refreshPlaylist: vi.fn(),
    updateSettings: vi.fn((patch) => store.set((s) => ({ settings: { ...s.settings, ...patch } }))),
    setAccent: vi.fn(),
    setMode: vi.fn(),
    clearAllData: vi.fn(),
    markChannelOk: vi.fn(),
    markChannelFailed: vi.fn(),
  };
  view = modules.createPlayerView({ store, actions });
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

const setSettings = (patch) => store.set((s) => ({ settings: { ...s.settings, ...patch } }));

/** Resolve once `check` returns truthy (polling microtasks and short timers). */
async function until(check, { tries = 60 } = {}) {
  for (let i = 0; i < tries; i++) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('condition not met');
}

/** Put the (real) Player into ERROR with `error`, as if a load had failed. */
function failWith(error) {
  Object.defineProperty(view.player, 'error', { configurable: true, get: () => error });
  Object.defineProperty(view.player, 'state', { configurable: true, get: () => 'error' });
  view.player.dispatchEvent(new CustomEvent('error', { detail: { error } }));
  view.player.dispatchEvent(new CustomEvent('statechange', { detail: { state: 'error' } }));
}

const errorButtons = () =>
  [...view.el.querySelectorAll('.pv-error-actions > button')]
    .filter((b) => !b.hidden)
    .map((b) => b.textContent);
const errorButton = (label) =>
  [...view.el.querySelectorAll('.pv-error-actions > button')].find((b) => b.textContent === label);
const toastTexts = () => [...document.querySelectorAll('.toast-message')].map((t) => t.textContent);
const closeDialogs = () => {
  for (const btn of document.querySelectorAll('dialog[open]:not(.is-closing) .md-close')) btn.click();
};

beforeEach(() => {
  document.body.replaceChildren();
  // No network in unit tests (e.g. the relay health check after a failure through the relay).
  vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))));
});

/** fetch() answering the relay's health check like a working relay. */
const healthyRelay = () =>
  vi.fn(async () => new Response(JSON.stringify({ ok: true, service: 'iptv-stream-relay', version: 1 })));

afterEach(async () => {
  closeDialogs();
  await new Promise((resolve) => setTimeout(resolve, 0));
  view?.destroy();
  view = null;
  vi.unstubAllGlobals();
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

describe('player view — stream relay (proxy)', () => {
  it('passes the proxy to the Player as streamProxy while "Play blocked streams" is on', () => {
    mount({ settings: { ...DEFAULT_SETTINGS, corsProxy: ` ${RELAY} `, proxyStreams: true } });
    expect(view.player.options.streamProxy).toBe(RELAY);
    setSettings({ proxyStreams: false });
    expect(view.player.options.streamProxy).toBe('');
    setSettings({ proxyStreams: true, corsProxy: '' });
    expect(view.player.options.streamProxy).toBe('');
    setSettings({ corsProxy: RELAY });
    expect(view.player.options.streamProxy).toBe(RELAY);
  });

  it('offers "Fix with a relay" for blocked insecure streams and opens the setup guide', async () => {
    mount({ settings: { ...DEFAULT_SETTINGS, upgradeInsecure: false } });
    view.player.setOptions({ pageProtocol: 'https:' });
    play(INSECURE);
    await flush();
    expect(view.player.error).toMatchObject({ code: 'MIXED_CONTENT', canUseProxy: true });
    expect(view.el.querySelector('.pv').dataset.state).toBe('error');
    expect(errorButtons()).toEqual(['Fix with a relay', 'Next channel', 'Copy stream URL']);
    expect(errorButton('Fix with a relay').classList.contains('btn-primary')).toBe(true);
    expect(errorButton('Retry').hidden).toBe(true); // nothing changes on retry until a relay is set up
    expect(view.el.querySelector('.pv-error-detail').textContent).toBe(
      'Set up your own free relay to play it here (about 5 minutes), or use an HTTPS link if your provider ' +
        'offers one.',
    );

    errorButton('Fix with a relay').click();
    const guide = document.querySelector('dialog.dlg-guide-dialog');
    expect(guide?.open).toBe(true);
    expect(guide.querySelector('.md-title').textContent).toBe('Play blocked channels');
  });

  it('mentions the failed https upgrade and turns Retry into the fix once a relay is set', async () => {
    mount();
    play(INSECURE);
    failWith({
      code: 'MIXED_CONTENT',
      message: 'This channel uses an insecure HTTP stream, which browsers block on secure (HTTPS) pages.',
      detail: 'The HTTPS version of this link didn’t work either. Use an HTTPS stream URL…',
      canUseProxy: true,
      fatal: true,
    });
    const detail = view.el.querySelector('.pv-error-detail');
    expect(detail.textContent).toMatch(/^Its HTTPS version didn’t work either\. Set up your own free relay/);

    setSettings({ corsProxy: RELAY });
    expect(errorButtons()).toEqual(['Retry', 'Next channel', 'Copy stream URL']);
    expect(errorButton('Retry').classList.contains('btn-primary')).toBe(true);
    expect(detail.textContent).toBe(
      'Its HTTPS version didn’t work either. A relay is set up now — press Retry to play it through the relay.',
    );
  });

  it('offers the fix for CORS failures without a relay, keeping Retry', () => {
    mount();
    play(WEBM);
    failWith({ code: 'CORS', message: 'The stream server didn’t respond.', canUseProxy: true, fatal: true });
    expect(errorButtons()).toEqual(['Fix with a relay', 'Retry', 'Next channel', 'Copy stream URL']);
    expect(view.el.querySelector('.pv-error-actions').hasAttribute('data-crowded')).toBe(true);
    // Unrelated errors don't mention the relay.
    failWith({ code: 'MEDIA', message: 'The stream couldn’t be decoded.', fatal: true });
    expect(errorButtons()).toEqual(['Retry', 'Next channel', 'Copy stream URL']);
  });

  it('replays the channel once the guide saved a working relay', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ ok: true, service: 'iptv-stream-relay', version: 1 }), { status: 200 }),
      ),
    );
    mount();
    play(INSECURE);
    failWith({ code: 'MIXED_CONTENT', message: 'Blocked.', canUseProxy: true, fatal: true });
    const retry = vi.spyOn(view.player, 'retry').mockImplementation(() => {});
    errorButton('Fix with a relay').click();
    const guide = document.querySelector('dialog.dlg-guide-dialog');
    guide.querySelector('.dlg-guide-connect input').value = RELAY;
    guide.querySelector('.dlg-save-test').click();
    expect(store.get().settings).toMatchObject({ corsProxy: RELAY, proxyStreams: true });
    expect(view.player.options.streamProxy).toBe(RELAY);
    await until(() => guide.querySelector('.dlg-check[data-status="ok"]'));
    expect(retry).not.toHaveBeenCalled();
    guide.querySelector('.md-footer .btn').click();
    await until(() => retry.mock.calls.length);
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('does not replay when the guide closes without a working relay', async () => {
    mount();
    play(INSECURE);
    failWith({ code: 'MIXED_CONTENT', message: 'Blocked.', canUseProxy: true, fatal: true });
    const retry = vi.spyOn(view.player, 'retry').mockImplementation(() => {});
    errorButton('Fix with a relay').click();
    document.querySelector('dialog.dlg-guide-dialog .md-close').click();
    await flush();
    expect(retry).not.toHaveBeenCalled();
  });

  it('shows "Relay settings" when playback through the user’s own relay failed', async () => {
    mount({ settings: { ...DEFAULT_SETTINGS, corsProxy: RELAY } });
    play(WEBM);
    failWith({
      code: 'NETWORK',
      message: 'Couldn’t play this stream through your proxy.',
      detail: 'Check that your proxy URL is correct and running (Settings → Proxy), or try again later.',
      viaProxy: true,
      fatal: true,
    });
    expect(errorButtons()).toEqual(['Retry', 'Next channel', 'Relay settings', 'Copy stream URL']);
    expect(view.el.querySelector('.pv-error-message').textContent).toBe(
      'Couldn’t play this stream through your relay.',
    );
    expect(view.el.querySelector('.pv-error-detail').textContent).toBe(
      'Check that your relay’s address is correct and that it’s running (Settings → Network), or try again ' +
        'later.',
    );
    const retry = vi.spyOn(view.player, 'retry').mockImplementation(() => {});
    errorButton('Relay settings').click();
    const settings = document.querySelector('dialog.dlg-settings-dialog');
    expect(settings?.open).toBe(true);
    // Changing the relay there replays the channel when Settings closes.
    setSettings({ corsProxy: 'https://fixed-relay.deno.dev' });
    settings.querySelector('.md-close').click();
    await until(() => retry.mock.calls.length);
  });

  it('says "via relay" and notices the own relay once per channel, when the switched stream plays', async () => {
    const video = mount({ settings: { ...DEFAULT_SETTINGS, corsProxy: RELAY } });
    let relayed = false;
    Object.defineProperty(view.player, 'viaProxy', { configurable: true, get: () => relayed });
    const status = () => view.el.querySelector('.pv-info-status-text').textContent;

    play(WEBM);
    await flush();
    expect(status()).toBe('Connecting…');
    relayed = true;
    view.player.dispatchEvent(new CustomEvent('proxy', { detail: { reason: 'cors' } }));
    expect(status()).toBe('Connecting via relay…');
    expect(toastTexts()).toEqual([]); // not before it actually plays
    video.dispatchEvent(new Event('playing'));
    expect(status()).toMatch(/ · via relay$/);
    expect(toastTexts()).toEqual(['Playing through your relay']);

    view.toggleStats();
    const route = [...view.el.querySelectorAll('.pv-stats-row')].find((r) => r.textContent.startsWith('Route'));
    expect(route.querySelector('dd').textContent).toBe('Via relay');

    // Same channel again: no second notice.
    relayed = false;
    play(WEBM);
    await flush();
    relayed = true;
    view.player.dispatchEvent(new CustomEvent('proxy', { detail: { reason: 'cors' } }));
    video.dispatchEvent(new Event('playing'));
    expect(toastTexts()).toEqual(['Playing through your relay']);
  });

  it('shows "Direct" in the stats when the relay isn’t used', async () => {
    mount();
    play(WEBM);
    await flush();
    view.toggleStats();
    const route = [...view.el.querySelectorAll('.pv-stats-row')].find((r) => r.textContent.startsWith('Route'));
    expect(route.querySelector('dd').textContent).toBe('Direct');
    expect(view.el.querySelector('.pv-info-status-text').textContent).not.toContain('via relay');
  });
});

describe('player view — local-network streams', () => {
  it('explains them without offering a relay, whatever the relay settings', async () => {
    for (const patch of [{}, { corsProxy: RELAY }, { corsProxy: RELAY, proxyStreams: false }]) {
      mount({ settings: { ...DEFAULT_SETTINGS, upgradeInsecure: false, ...patch } });
      await expectLocalNetworkBlock();
      view.destroy();
    }
  });

  it('keeps the panel’s advice when a relay is set up later', async () => {
    mount({ settings: { ...DEFAULT_SETTINGS, upgradeInsecure: false } });
    await expectLocalNetworkBlock();
    setSettings({ corsProxy: RELAY });
    expect(view.el.querySelector('.pv-error-detail').textContent).toBe(LOCAL_DETAIL);
    expect(errorButtons()).toEqual(['Next channel', 'Copy stream URL']);
  });
});

describe('player view — relay settings', () => {
  it('points to the relay settings when blocked streams may not use the relay', async () => {
    mount({ settings: { ...DEFAULT_SETTINGS, corsProxy: RELAY, proxyStreams: false, upgradeInsecure: false } });
    view.player.setOptions({ pageProtocol: 'https:' });
    play(INSECURE);
    await flush();
    expect(view.player.error).toMatchObject({ code: 'MIXED_CONTENT', canUseProxy: true });
    expect(errorButtons()).toEqual(['Relay settings', 'Next channel', 'Copy stream URL']);
    expect(errorButton('Relay settings').classList.contains('btn-primary')).toBe(true);
    expect(view.el.querySelector('.pv-error-detail').textContent).toBe(
      'Turn on “Play blocked streams through the relay” in Settings to play it here.',
    );

    const retry = vi.spyOn(view.player, 'retry').mockImplementation(() => {});
    errorButton('Relay settings').click();
    const settings = document.querySelector('dialog.dlg-settings-dialog');
    expect(settings?.open).toBe(true);
    setSettings({ proxyStreams: true });
    settings.querySelector('.md-close').click();
    await until(() => retry.mock.calls.length);
  });
});

describe('player view — channel health reports', () => {
  it('reports the first playing state of the current channel as playable', async () => {
    const video = mount();
    play(WEBM);
    await flush();
    expect(actions.markChannelOk).not.toHaveBeenCalled();
    video.dispatchEvent(new Event('playing'));
    expect(actions.markChannelOk).toHaveBeenCalledTimes(1);
    expect(actions.markChannelOk).toHaveBeenCalledWith(WEBM);
    // Pausing and resuming doesn't report again.
    video.dispatchEvent(new Event('pause'));
    video.dispatchEvent(new Event('playing'));
    expect(actions.markChannelOk).toHaveBeenCalledTimes(1);
    expect(actions.markChannelFailed).not.toHaveBeenCalled();
  });

  it('remembers a fatal failure with the title the error panel shows', async () => {
    mount();
    play(RTMP);
    await flush();
    expect(view.el.querySelector('.pv-error-title').textContent).toBe('Format not supported');
    expect(actions.markChannelFailed).toHaveBeenCalledTimes(1);
    expect(actions.markChannelFailed).toHaveBeenCalledWith(RTMP, {
      code: 'UNSUPPORTED',
      title: 'Format not supported',
    });
  });

  it('reports playing again after a failure, e.g. after Retry', () => {
    mount();
    play(WEBM);
    failWith({ code: 'HTTP', status: 404, message: 'Stream not found (404).', fatal: true });
    expect(actions.markChannelFailed).toHaveBeenLastCalledWith(WEBM, { code: 'HTTP', title: 'Channel not found' });
    view.player.dispatchEvent(new CustomEvent('statechange', { detail: { state: 'playing' } }));
    expect(actions.markChannelOk).toHaveBeenCalledTimes(1);
    expect(actions.markChannelOk).toHaveBeenCalledWith(WEBM);
  });

  it('ignores errors that say nothing about the channel', () => {
    mount();
    play(WEBM);
    failWith({ code: 'AUTOPLAY', message: 'Autoplay was blocked.', fatal: true });
    failWith({ code: 'MIXED_CONTENT', message: 'Blocked.', canUseProxy: true, fatal: true });
    failWith({ code: 'OFFLINE', message: 'You’re offline.', fatal: false });
    failWith({ code: 'NETWORK', message: 'Lost.', fatal: false }); // not fatal: still reconnecting
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    failWith({ code: 'NETWORK', message: 'Lost.', fatal: true }); // the device is offline
    expect(actions.markChannelFailed).not.toHaveBeenCalled();
  });

  it('only reports for the channel the player is loading', () => {
    mount();
    play(WEBM);
    store.set({ currentChannel: RTMP }); // switched, but not loaded yet
    failWith({ code: 'NETWORK', message: 'Lost.', fatal: true });
    view.player.dispatchEvent(new CustomEvent('statechange', { detail: { state: 'playing' } }));
    expect(actions.markChannelFailed).not.toHaveBeenCalled();
    expect(actions.markChannelOk).not.toHaveBeenCalled();
  });
});

describe('player view — built-in relay', () => {
  const BUILTIN = 'https://relay.example.test';
  const saved = modules;

  beforeAll(async () => {
    vi.stubEnv('VITE_BUILTIN_RELAY', BUILTIN);
    vi.resetModules();
    modules = {
      createStore: (await import('../src/app/store.js')).createStore,
      createPlayerView: (await import('../src/ui/player-view.js')).createPlayerView,
    };
  });

  afterAll(() => {
    modules = saved;
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  const relayFailure = {
    code: 'NETWORK',
    message: 'Couldn’t play this stream through your proxy.',
    detail: 'Check that your proxy URL is correct and running (Settings → Proxy), or try again later.',
    viaProxy: true,
    fatal: true,
  };

  it('streams through the built-in relay unless the user has their own or turned it off', () => {
    mount();
    expect(view.player.options.streamProxy).toBe(BUILTIN);
    setSettings({ corsProxy: RELAY });
    expect(view.player.options.streamProxy).toBe(RELAY);
    setSettings({ corsProxy: '', useBuiltinRelay: false });
    expect(view.player.options.streamProxy).toBe('');
    setSettings({ useBuiltinRelay: true, proxyStreams: false });
    expect(view.player.options.streamProxy).toBe('');
  });

  it('explains a failure through the built-in relay and offers only Retry / Next channel', async () => {
    const fetch = healthyRelay();
    vi.stubGlobal('fetch', fetch);
    mount();
    play(INSECURE);
    failWith(relayFailure);
    expect(view.el.querySelector('.pv-error-title').textContent).toBe('Stream unavailable');
    expect(view.el.querySelector('.pv-error-message').textContent).toBe(
      'Couldn’t play this stream through the built-in relay.',
    );
    expect(view.el.querySelector('.pv-error-detail').textContent).toBe(
      'The stream may be offline, region-locked, or refusing relays. Try again later.',
    );
    expect(errorButtons()).toEqual(['Retry', 'Next channel', 'Copy stream URL']);
    // No HTTP answer at all: the relay's health check runs first; it's up, so the stream is to blame.
    await until(() => actions.markChannelFailed.mock.calls.length);
    expect(fetch).toHaveBeenCalledWith(`${BUILTIN}/?health`, expect.objectContaining({ credentials: 'omit' }));
    expect(actions.markChannelFailed).toHaveBeenCalledWith(INSECURE, {
      code: 'NETWORK',
      title: 'Stream unavailable',
    });
    expect(view.el.querySelector('.pv-error-message').textContent).toBe(
      'Couldn’t play this stream through the built-in relay.',
    );

    // A refusal keeps its title and status; a specific answer (404) keeps the Player's message.
    failWith({ ...relayFailure, code: 'HTTP', status: 403 });
    expect(view.el.querySelector('.pv-error-title').textContent).toBe('Access denied');
    expect(view.el.querySelector('.pv-error-detail').textContent).toMatch(/Try again later\. · HTTP 403$/);
    failWith({ code: 'HTTP', status: 404, message: 'Stream not found (404).', viaProxy: true, fatal: true });
    expect(view.el.querySelector('.pv-error-message').textContent).toBe('Stream not found (404).');
  });

  it('says the built-in relay is unreachable, and blames no channel, when its health check fails too', async () => {
    mount();
    play(INSECURE);
    failWith(relayFailure);
    await until(() => view.el.querySelector('.pv-error-title').textContent === 'Relay unavailable');
    expect(view.el.querySelector('.pv-error-message').textContent).toBe('Couldn’t reach the built-in relay.');
    expect(view.el.querySelector('.pv-error-detail').textContent).toBe(
      'It may be down or busy right now. Try again in a few minutes.',
    );
    expect(errorButtons()).toEqual(['Retry', 'Next channel', 'Copy stream URL']);
    expect(actions.markChannelFailed).not.toHaveBeenCalled();

    // Retry starts over: a new failure is described (and checked) afresh.
    vi.stubGlobal('fetch', healthyRelay());
    vi.spyOn(view.player, 'retry').mockImplementation(() => {});
    errorButton('Retry').click();
    failWith({ ...relayFailure });
    expect(view.el.querySelector('.pv-error-title').textContent).toBe('Stream unavailable');
    await until(() => actions.markChannelFailed.mock.calls.length);
  });

  it('reports failures with an HTTP status through the relay right away, without a health check', () => {
    mount();
    play(INSECURE);
    failWith({ ...relayFailure, code: 'HTTP', status: 502 });
    expect(fetch).not.toHaveBeenCalled();
    expect(actions.markChannelFailed).toHaveBeenCalledWith(INSECURE, { code: 'HTTP', title: 'Server error' });
  });

  it('drops a pending relay health check when another channel loads', async () => {
    let answer;
    vi.stubGlobal('fetch', vi.fn(() => new Promise((resolve) => (answer = resolve))));
    mount();
    play(INSECURE);
    failWith(relayFailure);
    play(WEBM);
    await flush();
    answer(new Response('{}'));
    await flush();
    expect(actions.markChannelFailed).not.toHaveBeenCalled();
  });

  it('still points to Settings when the failing relay is the user’s own', () => {
    mount({ settings: { ...DEFAULT_SETTINGS, corsProxy: RELAY } });
    play(INSECURE);
    failWith(relayFailure);
    expect(view.el.querySelector('.pv-error-message').textContent).toBe(
      'Couldn’t play this stream through your relay.',
    );
    expect(errorButtons()).toEqual(['Retry', 'Next channel', 'Relay settings', 'Copy stream URL']);
  });

  it('says when the user’s own relay can’t be reached', async () => {
    mount({ settings: { ...DEFAULT_SETTINGS, corsProxy: RELAY } });
    play(INSECURE);
    failWith(relayFailure);
    await until(() => view.el.querySelector('.pv-error-message').textContent === 'Couldn’t reach your relay.');
    expect(fetch).toHaveBeenCalledWith(`${RELAY}/?health`, expect.anything());
    expect(errorButtons()).toEqual(['Retry', 'Next channel', 'Relay settings', 'Copy stream URL']);
    expect(actions.markChannelFailed).not.toHaveBeenCalled();
  });

  it('offers the relay settings (not the setup guide) when the built-in relay was turned off', async () => {
    mount({ settings: { ...DEFAULT_SETTINGS, useBuiltinRelay: false, upgradeInsecure: false } });
    view.player.setOptions({ pageProtocol: 'https:' });
    play(INSECURE);
    await flush();
    expect(view.player.error).toMatchObject({ code: 'MIXED_CONTENT', canUseProxy: true });
    expect(errorButtons()).toEqual(['Relay settings', 'Next channel', 'Copy stream URL']);
    expect(view.el.querySelector('.pv-error-detail').textContent).toBe(
      'Turn the built-in relay back on in Settings to play it here, or use an HTTPS link if your provider ' +
        'offers one.',
    );
    const retry = vi.spyOn(view.player, 'retry').mockImplementation(() => {});
    errorButton('Relay settings').click();
    const settings = document.querySelector('dialog.dlg-settings-dialog');
    expect(settings?.open).toBe(true);
    setSettings({ useBuiltinRelay: true });
    settings.querySelector('.md-close').click();
    await until(() => retry.mock.calls.length);
  });

  it('never sends local-network streams to the built-in relay, nor offers it for them', async () => {
    mount({ settings: { ...DEFAULT_SETTINGS, upgradeInsecure: false } });
    expect(view.player.options.streamProxy).toBe(BUILTIN);
    await expectLocalNetworkBlock();
  });

  it('rewords the Player’s relay failure while reconnecting', () => {
    mount();
    play(INSECURE);
    Object.defineProperty(view.player, 'state', { configurable: true, get: () => 'reconnecting' });
    view.player.dispatchEvent(new CustomEvent('statechange', { detail: { state: 'reconnecting' } }));
    view.player.dispatchEvent(
      new CustomEvent('reconnecting', {
        detail: { attempt: 1, max: 2, delayMs: 2000, reason: relayFailure.message, code: 'NETWORK' },
      }),
    );
    const sub = view.el.querySelector('.pv-status-sub');
    expect(sub.textContent).toBe('Couldn’t play this stream through the built-in relay.');
    setSettings({ corsProxy: RELAY });
    view.player.dispatchEvent(new CustomEvent('statechange', { detail: { state: 'reconnecting' } }));
    expect(sub.textContent).toBe('Couldn’t play this stream through your relay.');
  });

  it('says "via relay" without a toast when the built-in relay takes over', async () => {
    const video = mount();
    let relayed = false;
    Object.defineProperty(view.player, 'viaProxy', { configurable: true, get: () => relayed });
    play(WEBM);
    await flush();
    relayed = true;
    view.player.dispatchEvent(new CustomEvent('proxy', { detail: { reason: 'cors' } }));
    video.dispatchEvent(new Event('playing'));
    expect(view.el.querySelector('.pv-info-status-text').textContent).toMatch(/ · via relay$/);
    expect(toastTexts()).toEqual([]);
  });
});
