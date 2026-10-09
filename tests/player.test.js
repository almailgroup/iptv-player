import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  hls: [],
  hlsSupported: { value: true },
  ts: [],
  tsFeatures: { value: { mseLivePlayback: true } },
}));

vi.mock('hls.js', () => {
  const Events = {
    MEDIA_ATTACHED: 'hlsMediaAttached',
    MANIFEST_PARSED: 'hlsManifestParsed',
    LEVEL_LOADED: 'hlsLevelLoaded',
    LEVEL_SWITCHED: 'hlsLevelSwitched',
    LEVELS_UPDATED: 'hlsLevelsUpdated',
    AUDIO_TRACKS_UPDATED: 'hlsAudioTracksUpdated',
    AUDIO_TRACK_SWITCHED: 'hlsAudioTrackSwitched',
    FRAG_BUFFERED: 'hlsFragBuffered',
    ERROR: 'hlsError',
  };
  const ErrorTypes = {
    NETWORK_ERROR: 'networkError',
    MEDIA_ERROR: 'mediaError',
    KEY_SYSTEM_ERROR: 'keySystemError',
    MUX_ERROR: 'muxError',
    OTHER_ERROR: 'otherError',
  };
  const ErrorDetails = {
    KEY_SYSTEM_NO_KEYS: 'keySystemNoKeys',
    MANIFEST_LOAD_ERROR: 'manifestLoadError',
    MANIFEST_LOAD_TIMEOUT: 'manifestLoadTimeOut',
    MANIFEST_PARSING_ERROR: 'manifestParsingError',
    MANIFEST_INCOMPATIBLE_CODECS_ERROR: 'manifestIncompatibleCodecsError',
    LEVEL_LOAD_ERROR: 'levelLoadError',
    LEVEL_EMPTY_ERROR: 'levelEmptyError',
    LEVEL_PARSING_ERROR: 'levelParsingError',
    FRAG_LOAD_ERROR: 'fragLoadError',
    FRAG_PARSING_ERROR: 'fragParsingError',
    BUFFER_ADD_CODEC_ERROR: 'bufferAddCodecError',
    BUFFER_INCOMPATIBLE_CODECS_ERROR: 'bufferIncompatibleCodecsError',
    BUFFER_APPEND_ERROR: 'bufferAppendError',
    BUFFER_STALLED_ERROR: 'bufferStalledError',
    INTERNAL_EXCEPTION: 'internalException',
  };
  class FakeHls {
    static isSupported() {
      return mocks.hlsSupported.value;
    }
    static get Events() {
      return Events;
    }
    static get ErrorTypes() {
      return ErrorTypes;
    }
    static get ErrorDetails() {
      return ErrorDetails;
    }
    constructor(config) {
      this.config = config;
      this.listeners = {};
      this.levels = [];
      this.audioTracks = [];
      this.audioTrack = -1;
      this.currentLevel = -1;
      this.liveSyncPosition = null;
      this.latency = 0;
      this.bandwidthEstimate = Number.NaN;
      this.lowLatencyMode = !!config?.lowLatencyMode;
      this.destroyed = false;
      this.media = null;
      this.url = null;
      this.startLoad = vi.fn();
      this.recoverMediaError = vi.fn();
      this.swapAudioCodec = vi.fn();
      mocks.hls.push(this);
    }
    on(event, fn) {
      (this.listeners[event] ||= []).push(fn);
    }
    off(event, fn) {
      this.listeners[event] = (this.listeners[event] || []).filter((f) => f !== fn);
    }
    /** Test helper. Listeners are intentionally kept after destroy() so stale-event guards are exercised. */
    emit(event, data = {}) {
      for (const fn of [...(this.listeners[event] || [])]) fn(event, data);
    }
    attachMedia(media) {
      this.media = media;
    }
    loadSource(url) {
      this.url = url;
    }
    destroy() {
      this.destroyed = true;
      this.media = null;
    }
  }
  return { default: FakeHls };
});

vi.mock('mpegts.js', () => {
  const Events = {
    ERROR: 'error',
    LOADING_COMPLETE: 'loading_complete',
    MEDIA_INFO: 'media_info',
    STATISTICS_INFO: 'statistics_info',
  };
  const ErrorTypes = { NETWORK_ERROR: 'NetworkError', MEDIA_ERROR: 'MediaError', OTHER_ERROR: 'OtherError' };
  const ErrorDetails = {
    NETWORK_EXCEPTION: 'Exception',
    NETWORK_STATUS_CODE_INVALID: 'HttpStatusCodeInvalid',
    NETWORK_TIMEOUT: 'ConnectingTimeout',
    NETWORK_UNRECOVERABLE_EARLY_EOF: 'UnrecoverableEarlyEof',
    MEDIA_MSE_ERROR: 'MediaMSEError',
    MEDIA_FORMAT_ERROR: 'FormatError',
    MEDIA_FORMAT_UNSUPPORTED: 'FormatUnsupported',
    MEDIA_CODEC_UNSUPPORTED: 'CodecUnsupported',
  };
  class FakeTsPlayer {
    constructor(dataSource, config) {
      this.dataSource = dataSource;
      this.config = config;
      this.listeners = {};
      this.media = null;
      this.loaded = false;
      this.destroyed = false;
      mocks.ts.push(this);
    }
    on(event, fn) {
      (this.listeners[event] ||= []).push(fn);
    }
    off(event, fn) {
      this.listeners[event] = (this.listeners[event] || []).filter((f) => f !== fn);
    }
    emit(event, ...args) {
      for (const fn of [...(this.listeners[event] || [])]) fn(...args);
    }
    attachMediaElement(media) {
      this.media = media;
    }
    detachMediaElement() {
      this.media = null;
    }
    load() {
      this.loaded = true;
    }
    unload() {
      this.loaded = false;
    }
    play() {}
    pause() {}
    destroy() {
      this.destroyed = true;
    }
  }
  const mpegts = {
    Events,
    ErrorTypes,
    ErrorDetails,
    isSupported: () => true,
    getFeatureList: () => mocks.tsFeatures.value,
    createPlayer: (dataSource, config) => new FakeTsPlayer(dataSource, config),
  };
  return { default: mpegts };
});

import { Player, PlayerState, PlayerErrorCode, buildLevelList, loadHls } from '../src/player/player.js';

// ---------------------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------------------

const ranges = (list) => ({ length: list.length, start: (i) => list[i][0], end: (i) => list[i][1] });

/** A happy-dom <video> whose media state is fully scriptable (happy-dom has no media pipeline). */
function createVideo({ nativeHls = '' } = {}) {
  const video = document.createElement('video');
  const m = {
    paused: true,
    currentTime: 0,
    duration: Number.NaN,
    readyState: 0,
    error: null,
    muted: false,
    seekable: ranges([]),
    buffered: ranges([]),
    videoWidth: 0,
    videoHeight: 0,
  };
  for (const key of Object.keys(m)) {
    Object.defineProperty(video, key, {
      configurable: true,
      get: () => m[key],
      set: (value) => {
        m[key] = value;
      },
    });
  }
  const ctl = {
    video,
    m,
    playImpl: null,
    fire(type) {
      video.dispatchEvent(new Event(type));
    },
    /** Simulate the first decoded frame + playback start. */
    startPlaying(time = 0.1) {
      m.readyState = 4;
      m.currentTime = time;
      m.paused = false;
      ctl.fire('loadeddata');
      ctl.fire('playing');
    },
    fail(code) {
      m.error = { code, message: 'test failure' };
      ctl.fire('error');
    },
  };
  video.canPlayType = vi.fn((type) => (/mpegurl/i.test(type) ? nativeHls : ''));
  video.play = vi.fn(() => {
    if (ctl.playImpl) return ctl.playImpl();
    if (m.paused) {
      m.paused = false;
      ctl.fire('play');
    }
    return Promise.resolve();
  });
  video.pause = vi.fn(() => {
    if (m.paused) return;
    m.paused = true;
    ctl.fire('pause');
  });
  video.load = vi.fn(() => {
    m.paused = true;
    m.error = null;
    m.readyState = 0;
    m.currentTime = 0;
    m.duration = Number.NaN;
    ctl.fire('emptied');
  });
  return ctl;
}

function record(player) {
  const events = [];
  for (const type of ['statechange', 'error', 'reconnecting', 'levels', 'levelswitch', 'audiotracks', 'engine',
    'autoplaymuted', 'live', 'recovered']) {
    player.addEventListener(type, (e) => events.push({ type, detail: e.detail }));
  }
  events.of = (type) => events.filter((e) => e.type === type).map((e) => e.detail);
  return events;
}

const flush = async (n = 25) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

const lastHls = () => mocks.hls[mocks.hls.length - 1];
const lastTs = () => mocks.ts[mocks.ts.length - 1];

const HLS_URL = 'https://cdn.example.com/live/index.m3u8';

const TS_URL = 'https://iptv.example.com/live/u/p/42.ts';

const netError = (details, code) => ({ type: 'networkError', details, fatal: true, response: { code } });

const manifestError = (code) => ({
  type: 'networkError',
  details: 'manifestLoadError',
  fatal: true,
  response: { url: HLS_URL, code },
});

let ctl;
let player;

function setup(options = {}, videoOptions = {}) {
  player?.destroy(); // a test may set up more than one player
  ctl = createVideo(videoOptions);
  player = new Player(ctl.video, { pageProtocol: 'https:', sniff: false, ...options });
  return { ctl, player, events: record(player) };
}

// hls.js is imported lazily; load it once so engine creation in these tests is synchronous after load().
beforeAll(async () => {
  await loadHls();
});

beforeEach(() => {
  mocks.hls.length = 0;
  mocks.ts.length = 0;
  mocks.hlsSupported.value = true;
  mocks.tsFeatures.value = { mseLivePlayback: true };
});

afterEach(() => {
  player?.destroy();
  player = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------------------------------------

describe('Player — construction', () => {
  it('starts idle with empty getters', () => {
    setup();
    expect(player.state).toBe(PlayerState.IDLE);
    expect(player.error).toBeNull();
    expect(player.engine).toBeNull();
    expect(player.isLive).toBe(false);
    expect(player.canSeek).toBe(false);
    expect(player.levels).toEqual([]);
    expect(player.audioTracks).toEqual([]);
    expect(player.currentLevel).toBe(-1);
    expect(player.autoLevel).toBe(true);
    expect(player.attempt).toBe(0);
    expect(player.video).toBe(ctl.video);
    expect(player).toBeInstanceOf(EventTarget);
  });

  it('requires a media element', () => {
    expect(() => new Player(null)).toThrow(TypeError);
  });

  it('exposes the state and error enums', () => {
    expect(Object.values(PlayerState)).toEqual(
      ['idle', 'loading', 'playing', 'paused', 'buffering', 'reconnecting', 'error'],
    );
    for (const code of ['MIXED_CONTENT', 'NETWORK', 'CORS', 'MEDIA', 'UNSUPPORTED', 'DRM', 'MANIFEST', 'HTTP',
      'OFFLINE', 'AUTOPLAY', 'UNKNOWN']) {
      expect(PlayerErrorCode[code]).toBe(code);
    }
  });
});

describe('Player — immediate errors', () => {
  it('rejects rtmp:// as UNSUPPORTED without creating an engine', async () => {
    const { events } = setup();
    await player.load({ url: 'rtmp://live.example.com/app/stream', name: 'RTMP' });
    expect(player.state).toBe(PlayerState.ERROR);
    expect(player.error).toMatchObject({ code: PlayerErrorCode.UNSUPPORTED, fatal: true });
    expect(player.error.message).toContain('rtmp://');
    expect(events.of('statechange')).toEqual([{ state: 'error', prev: 'idle' }]);
    expect(events.of('error')).toHaveLength(1);
    expect(events.of('reconnecting')).toHaveLength(0);
    expect(mocks.hls).toHaveLength(0);
  });

  it('rejects udp:// with a protocol-specific message', async () => {
    setup();
    await player.load({ url: 'udp://@239.0.0.1:1234' });
    expect(player.error.message).toContain('udp://');
    expect(player.error.message).toContain('browser');
  });

  it('rejects MPEG-DASH', async () => {
    setup();
    await player.load({ url: 'https://cdn.example.com/manifest.mpd' });
    expect(player.error).toMatchObject({ code: 'UNSUPPORTED' });
    expect(player.error.message).toBe('MPEG-DASH streams are not supported.');
  });

  it('rejects DRM channels immediately', async () => {
    setup();
    await player.load({ url: HLS_URL, drm: true });
    expect(player.state).toBe('error');
    expect(player.error.code).toBe(PlayerErrorCode.DRM);
    expect(player.error.message).toBe('DRM-protected channels are not supported in the browser player.');
    expect(mocks.hls).toHaveLength(0);
  });

  it('rejects an empty URL (and never throws on bad input)', async () => {
    setup();
    await player.load({ url: '   ' });
    expect(player.error.code).toBe('UNSUPPORTED');
    await expect(player.load(null)).resolves.toBeUndefined();
    await expect(player.load()).resolves.toBeUndefined();
    expect(player.state).toBe('error');
  });

  it('fails with MIXED_CONTENT when upgradeInsecure is false', async () => {
    const { events } = setup({ upgradeInsecure: false, pageProtocol: 'https:' });
    await player.load({ url: 'http://insecure.example.com/live.m3u8' });
    expect(player.state).toBe('error');
    expect(player.error.code).toBe(PlayerErrorCode.MIXED_CONTENT);
    expect(player.error.message).toBe(
      'This channel uses an insecure HTTP stream, which browsers block on secure (HTTPS) pages.',
    );
    expect(player.error.detail).toMatch(/HTTPS/);
    expect(player.error.detail).toMatch(/http:\/\//);
    expect(events.of('reconnecting')).toHaveLength(0);
    expect(mocks.hls).toHaveLength(0);
  });

  it('plays http streams as-is on http pages', async () => {
    setup({ upgradeInsecure: false, pageProtocol: 'http:' });
    await player.load({ url: 'http://insecure.example.com/live.m3u8' });
    expect(lastHls().url).toBe('http://insecure.example.com/live.m3u8');
  });
});

describe('Player — hls.js engine', () => {
  it('creates hls.js with the specified config', async () => {
    const { events } = setup({ lowLatency: true });
    await player.load({ url: HLS_URL, name: 'Live' });
    const hls = lastHls();
    expect(hls.config).toMatchObject({
      enableWorker: true,
      lowLatencyMode: true,
      backBufferLength: 30,
      maxBufferLength: 30,
      maxMaxBufferLength: 60,
      liveSyncDurationCount: 3,
      liveMaxLatencyDurationCount: 10,
      startFragPrefetch: true,
      testBandwidth: true,
      progressive: false,
    });
    const manifestRetry = hls.config.manifestLoadPolicy.default.errorRetry;
    expect(manifestRetry).toMatchObject({ maxNumRetry: 2, retryDelayMs: 1000 });
    expect(hls.config.playlistLoadPolicy.default.errorRetry.maxNumRetry).toBe(4);
    expect(hls.config.fragLoadPolicy.default.errorRetry.maxNumRetry).toBe(6);
    expect(hls.config.workerPath).toMatch(/hls\.worker/);
    expect(hls.media).toBe(ctl.video);
    expect(hls.url).toBe(HLS_URL);
    expect(player.engine).toBe('hls.js');
    expect(player.state).toBe('loading');
    expect(player.source).toEqual({ url: HLS_URL, name: 'Live' });
    expect(events.of('engine')).toEqual([{ engine: 'hls.js' }]);
    expect(events.of('statechange')[0]).toEqual({ state: 'loading', prev: 'idle' });
  });

  it('emits levels after MANIFEST_PARSED, autoplays and reaches PLAYING', async () => {
    const { events } = setup();
    await player.load({ url: HLS_URL });
    const hls = lastHls();
    hls.levels = [
      { height: 360, width: 640, bitrate: 800000 },
      { height: 1080, width: 1920, bitrate: 5000000 },
      { height: 720, width: 1280, bitrate: 2500000 },
      { height: 720, width: 1280, bitrate: 3200000 },
    ];
    hls.emit('hlsManifestParsed', { levels: hls.levels });
    expect(player.levels.map((l) => l.label)).toEqual(['1080p', '720p', '360p']);
    expect(player.levels[1]).toMatchObject({ index: 3, height: 720, bitrate: 3200000 });
    expect(events.of('levels').at(-1)).toEqual({ levels: player.levels, current: -1 });
    expect(ctl.video.play).toHaveBeenCalledTimes(1);
    ctl.startPlaying();
    expect(player.state).toBe('playing');
  });

  it('switches levels via hls.currentLevel', async () => {
    const { events } = setup();
    await player.load({ url: HLS_URL });
    const hls = lastHls();
    hls.levels = [{ height: 1080, bitrate: 5e6 }, { height: 720, bitrate: 3e6 }];
    hls.emit('hlsManifestParsed', {});
    player.setLevel(1);
    expect(hls.currentLevel).toBe(1);
    expect(player.currentLevel).toBe(1);
    expect(player.autoLevel).toBe(false);
    player.setLevel(-1);
    expect(hls.currentLevel).toBe(-1);
    expect(player.autoLevel).toBe(true);
    player.setLevel(9); // out of range: ignored
    expect(player.currentLevel).toBe(-1);
    hls.emit('hlsLevelSwitched', { level: 0 });
    expect(events.of('levelswitch').at(-1)).toMatchObject({ level: 0, auto: true, label: '1080p' });
    expect(player.playingLevel).toBe(0);
  });

  it('tracks live state and jumps to the live edge', async () => {
    const { events } = setup();
    await player.load({ url: HLS_URL });
    const hls = lastHls();
    hls.emit('hlsManifestParsed', {});
    hls.emit('hlsLevelLoaded', { details: { live: true } });
    expect(player.isLive).toBe(true);
    expect(events.of('live')).toEqual([{ isLive: true }]);
    ctl.startPlaying(10);
    hls.liveSyncPosition = 95;
    player.goLive();
    expect(ctl.m.currentTime).toBe(95);
    expect(player.canSeek).toBe(false);
    ctl.m.seekable = ranges([[0, 300]]);
    expect(player.canSeek).toBe(true); // DVR window > 60 s
  });

  it('lists and switches audio tracks', async () => {
    const { events } = setup();
    await player.load({ url: HLS_URL });
    const hls = lastHls();
    hls.audioTracks = [{ name: 'English', lang: 'en' }, { name: '', lang: 'de' }, { name: '', lang: '' }];
    hls.audioTrack = 0;
    hls.emit('hlsManifestParsed', {});
    expect(player.audioTracks.map((t) => t.label)[0]).toBe('English');
    expect(player.audioTracks[1].lang).toBe('de');
    expect(player.audioTracks[2].label).toBe('Track 3');
    expect(player.currentAudioTrack).toBe(0);
    player.setAudioTrack(1);
    expect(hls.audioTrack).toBe(1);
    expect(events.of('audiotracks').at(-1)).toMatchObject({ current: 1 });
  });

  it('upgrades http streams to https on https pages', async () => {
    setup({ pageProtocol: 'https:', upgradeInsecure: true });
    await player.load({ url: 'http://insecure.example.com/live.m3u8' });
    expect(lastHls().url).toBe('https://insecure.example.com/live.m3u8');
    expect(player.url).toBe('https://insecure.example.com/live.m3u8');
  });

  it('reports MIXED_CONTENT (not retried) when the https upgrade fails', async () => {
    const { events } = setup({ pageProtocol: 'https:' });
    await player.load({ url: 'http://insecure.example.com/live.m3u8' });
    lastHls().emit('hlsError', manifestError(0));
    await flush();
    expect(player.state).toBe('error');
    expect(player.error.code).toBe('MIXED_CONTENT');
    expect(events.of('reconnecting')).toHaveLength(0);
  });

  it('falls back to native HLS on CORS / status 0 without consuming a retry', async () => {
    const { events } = setup({}, { nativeHls: 'maybe' });
    await player.load({ url: HLS_URL });
    const hls = lastHls();
    hls.emit('hlsError', manifestError(0));
    await flush();
    expect(hls.destroyed).toBe(true);
    expect(player.engine).toBe('native');
    expect(ctl.video.getAttribute('src')).toBe(HLS_URL);
    expect(player.attempt).toBe(0);
    expect(events.of('reconnecting')).toHaveLength(0);
    expect(events.of('engine').map((e) => e.engine)).toEqual(['hls.js', 'native']);
    ctl.startPlaying();
    expect(player.state).toBe('playing');
  });

  it('retries CORS failures at most twice when no fallback exists, then reports CORS', async () => {
    vi.useFakeTimers();
    const { events } = setup();
    await player.load({ url: HLS_URL });
    for (let i = 0; i < 3; i++) {
      lastHls().emit('hlsError', manifestError(0));
      await flush();
      if (i < 2) {
        expect(player.state).toBe('reconnecting');
        expect(events.of('reconnecting').at(-1)).toMatchObject({ attempt: i + 1, max: 2, code: 'CORS' });
        await vi.advanceTimersByTimeAsync(events.of('reconnecting').at(-1).delayMs);
        expect(mocks.hls).toHaveLength(i + 2);
      }
    }
    expect(player.state).toBe('error');
    expect(player.error.code).toBe('CORS');
    expect(player.error.message).toMatch(/Couldn’t reconnect after 2 attempts/);
    expect(player.error.message).toMatch(/doesn’t allow playback/);
  });

  it('classifies 404 as HTTP and stops after two retries', async () => {
    vi.useFakeTimers();
    const { events } = setup();
    await player.load({ url: HLS_URL });
    for (let i = 0; i < 3; i++) {
      lastHls().emit('hlsError', manifestError(404));
      await flush();
      if (i < 2) await vi.advanceTimersByTimeAsync(events.of('reconnecting').at(-1).delayMs);
    }
    expect(events.of('reconnecting').map((r) => r.max)).toEqual([2, 2]);
    expect(player.state).toBe('error');
    expect(player.error).toMatchObject({ code: 'HTTP', status: 404, fatal: true });
    expect(player.error.message).toContain('not found');
  });

  it('tries the native player for 403 and keeps the more specific HTTP error', async () => {
    const { events } = setup({}, { nativeHls: 'maybe' });
    await player.load({ url: HLS_URL });
    lastHls().emit('hlsError', manifestError(403));
    await flush();
    expect(player.engine).toBe('native');
    ctl.fail(4); // MEDIA_ERR_SRC_NOT_SUPPORTED
    await flush();
    expect(player.state).toBe('reconnecting');
    expect(events.of('reconnecting')[0]).toMatchObject({ code: 'HTTP', max: 2 });
    expect(events.of('reconnecting')[0].reason).toContain('Access denied (403)');
  });

  it('recovers network errors after MANIFEST_PARSED with startLoad() once, then reconnects', async () => {
    const { events } = setup();
    await player.load({ url: HLS_URL });
    const hls = lastHls();
    hls.emit('hlsManifestParsed', {});
    ctl.startPlaying();
    const fragError = { type: 'networkError', details: 'fragLoadError', fatal: true, response: { code: 0 } };
    hls.emit('hlsError', fragError);
    await flush();
    expect(hls.startLoad).toHaveBeenCalledTimes(1);
    expect(player.state).toBe('playing');
    hls.emit('hlsError', fragError);
    await flush();
    expect(player.state).toBe('reconnecting');
    expect(events.of('reconnecting')[0]).toMatchObject({ attempt: 1, max: 8, code: 'NETWORK' });
    expect(hls.destroyed).toBe(true);
  });

  it('escalates media errors: recoverMediaError → swapAudioCodec → full reload', async () => {
    vi.useFakeTimers();
    const { events } = setup();
    await player.load({ url: HLS_URL });
    const hls = lastHls();
    hls.emit('hlsManifestParsed', {});
    ctl.startPlaying();
    const mediaError = { type: 'mediaError', details: 'bufferAppendError', fatal: true };
    hls.emit('hlsError', mediaError);
    await flush();
    expect(hls.recoverMediaError).toHaveBeenCalledTimes(1);
    expect(hls.swapAudioCodec).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    hls.emit('hlsError', mediaError);
    await flush();
    expect(hls.swapAudioCodec).toHaveBeenCalledTimes(1);
    expect(hls.recoverMediaError).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1000);
    hls.emit('hlsError', mediaError);
    await flush();
    expect(player.state).toBe('reconnecting');
    expect(events.of('reconnecting')[0].code).toBe('MEDIA');
  });

  it('treats media errors more than 3 s apart as fresh (no codec swap)', async () => {
    vi.useFakeTimers();
    setup();
    await player.load({ url: HLS_URL });
    const hls = lastHls();
    hls.emit('hlsManifestParsed', {});
    ctl.startPlaying();
    const mediaError = { type: 'mediaError', details: 'fragParsingError', fatal: true };
    hls.emit('hlsError', mediaError);
    vi.advanceTimersByTime(4000);
    hls.emit('hlsError', mediaError);
    await flush();
    expect(hls.recoverMediaError).toHaveBeenCalledTimes(2);
    expect(hls.swapAudioCodec).not.toHaveBeenCalled();
  });

  it('moves to the next engine on incompatible codecs, else fails without retrying', async () => {
    setup({}, { nativeHls: 'maybe' });
    await player.load({ url: HLS_URL });
    lastHls().emit('hlsError', { type: 'mediaError', details: 'manifestIncompatibleCodecsError', fatal: true });
    await flush();
    expect(player.engine).toBe('native');

    const second = setup();
    await second.player.load({ url: HLS_URL });
    lastHls().emit('hlsError', { type: 'mediaError', details: 'manifestIncompatibleCodecsError', fatal: true });
    await flush();
    expect(second.player.state).toBe('error');
    expect(second.player.error.code).toBe('UNSUPPORTED');
    expect(second.events.of('reconnecting')).toHaveLength(0);
  });

  it('maps key-system errors to DRM (not retried)', async () => {
    const { events } = setup();
    await player.load({ url: HLS_URL });
    lastHls().emit('hlsError', { type: 'keySystemError', details: 'keySystemNoKeys', fatal: true });
    await flush();
    expect(player.error.code).toBe('DRM');
    expect(events.of('reconnecting')).toHaveLength(0);
  });

  it('does not mistake response-less network errors (empty live playlist) for CORS', async () => {
    const { events } = setup({}, { nativeHls: 'maybe' });
    await player.load({ url: HLS_URL });
    const hls = lastHls();
    hls.emit('hlsManifestParsed', {});
    hls.emit('hlsError', { type: 'networkError', details: 'levelEmptyError', fatal: true });
    await flush();
    expect(hls.startLoad).toHaveBeenCalledTimes(1); // in-place recovery first
    hls.emit('hlsError', { type: 'networkError', details: 'levelEmptyError', fatal: true });
    await flush();
    expect(player.engine).toBe('hls.js');
    expect(events.of('reconnecting')[0]).toMatchObject({ code: 'NETWORK' });
  });

  it('treats a manifest parsing error as MANIFEST and tries the next engine', async () => {
    setup({}, { nativeHls: 'maybe' });
    await player.load({ url: HLS_URL });
    lastHls().emit('hlsError', { type: 'networkError', details: 'manifestParsingError', fatal: true });
    await flush();
    expect(player.engine).toBe('native');
  });

  it('ignores non-fatal errors but shows buffering on BUFFER_STALLED', async () => {
    const { events } = setup();
    await player.load({ url: HLS_URL });
    const hls = lastHls();
    hls.emit('hlsManifestParsed', {});
    ctl.startPlaying();
    hls.emit('hlsError', { type: 'mediaError', details: 'bufferStalledError', fatal: false });
    hls.emit('hlsError', { type: 'networkError', details: 'fragLoadError', fatal: false });
    await flush();
    expect(player.state).toBe('buffering');
    expect(events.of('reconnecting')).toHaveLength(0);
    expect(player.getStats().stalls).toBe(1);
    ctl.m.currentTime = 1;
    ctl.fire('timeupdate');
    expect(player.state).toBe('playing');
  });

  it('prefers native HLS when preferNativeHls is set and supported', async () => {
    setup({ preferNativeHls: true }, { nativeHls: 'probably' });
    await player.load({ url: HLS_URL });
    expect(player.engine).toBe('native');
    expect(mocks.hls).toHaveLength(0);
  });

  it('reports UNSUPPORTED when neither hls.js nor native HLS is available', async () => {
    mocks.hlsSupported.value = false;
    setup();
    await player.load({ url: HLS_URL });
    expect(player.error.code).toBe('UNSUPPORTED');
    expect(player.error.message).toContain('HLS');
  });
});

describe('Player — load tokens', () => {
  it('destroys the previous engine and ignores its late events on rapid switching', async () => {
    vi.useFakeTimers();
    const { events } = setup();
    for (let i = 0; i < 5; i++) player.load({ url: `https://cdn.example.com/ch${i}.m3u8` });
    await flush();
    expect(mocks.hls).toHaveLength(5);
    expect(mocks.hls.slice(0, 4).every((h) => h.destroyed)).toBe(true);
    expect(lastHls().destroyed).toBe(false);
    expect(lastHls().url).toBe('https://cdn.example.com/ch4.m3u8');

    const stale = mocks.hls[1];
    stale.emit('hlsError', manifestError(0));
    stale.emit('hlsManifestParsed', {});
    stale.emit('hlsLevelLoaded', { details: { live: true } });
    await flush();
    expect(player.state).toBe('loading');
    expect(player.isLive).toBe(false);
    expect(events.of('reconnecting')).toHaveLength(0);
    expect(ctl.video.play).not.toHaveBeenCalled();
    // Only the current run's watchdog is active.
    expect(vi.getTimerCount()).toBe(1);
  });

  it('cancels a pending sniff when another channel is loaded', async () => {
    const pending = [];
    vi.stubGlobal('fetch', vi.fn((url, init) => new Promise((resolve, reject) => {
      pending.push({ url, resolve, signal: init.signal });
      init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    })));
    setup({ sniff: true });
    const first = player.load({ url: 'http://xtream.example.com:8080/u/p/1' , name: 'one' });
    await flush();
    expect(pending).toHaveLength(1);
    await player.load({ url: HLS_URL });
    await first;
    expect(pending[0].signal.aborted).toBe(true);
    expect(mocks.hls).toHaveLength(1);
    expect(player.engine).toBe('hls.js');
    expect(player.source.url).toBe(HLS_URL);
  });
});

describe('Player — reconnect', () => {
  it('reconnects with backoff, emits recovered and resets attempts after healthy playback', async () => {
    vi.useFakeTimers();
    const { events } = setup();
    await player.load({ url: HLS_URL });
    let hls = lastHls();
    hls.emit('hlsManifestParsed', {});
    ctl.startPlaying();
    hls.emit('hlsError', netError('levelLoadError', 500));
    await flush();
    expect(player.state).toBe('reconnecting');
    const info = events.of('reconnecting')[0];
    expect(info).toMatchObject({ attempt: 1, max: 8, code: 'HTTP' });
    expect(info.delayMs).toBeGreaterThanOrEqual(800);
    expect(info.delayMs).toBeLessThanOrEqual(1200);
    expect(player.attempt).toBe(1);

    await vi.advanceTimersByTimeAsync(info.delayMs);
    expect(mocks.hls).toHaveLength(2);
    hls = lastHls();
    expect(hls.url).toBe(HLS_URL);
    expect(player.state).toBe('loading');
    hls.emit('hlsManifestParsed', {});
    ctl.startPlaying();
    expect(events.of('recovered')).toHaveLength(1);
    expect(player.state).toBe('playing');
    expect(player.attempt).toBe(1);

    for (let i = 0; i < 17; i++) {
      ctl.m.currentTime += 1;
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(player.attempt).toBe(0);
  });

  it('keeps reconnecting a stream that played when its server becomes unreachable (not CORS)', async () => {
    vi.useFakeTimers();
    const { events } = setup();
    await player.load({ url: HLS_URL });
    lastHls().emit('hlsManifestParsed', {});
    ctl.startPlaying();
    // Server goes away: fragments fail (in-place startLoad() first), then every reconnect's manifest request
    // gets no response (status 0).
    lastHls().emit('hlsError', netError('fragLoadError', 0));
    lastHls().emit('hlsError', netError('fragLoadError', 0));
    await flush();
    for (let i = 0; i < 5; i++) {
      expect(player.state).toBe('reconnecting');
      await vi.advanceTimersByTimeAsync(events.of('reconnecting').at(-1).delayMs);
      lastHls().emit('hlsError', manifestError(0));
      await flush();
    }
    expect(player.state).toBe('reconnecting');
    const info = events.of('reconnecting').at(-1);
    expect(info).toMatchObject({ attempt: 6, max: 8, code: 'NETWORK' });
    // The server comes back.
    await vi.advanceTimersByTimeAsync(info.delayMs);
    lastHls().emit('hlsManifestParsed', {});
    ctl.startPlaying();
    expect(player.state).toBe('playing');
    expect(events.of('recovered')).toHaveLength(1);
  });

  it('gives up after maxRetries', async () => {
    vi.useFakeTimers();
    const { events } = setup({ maxRetries: 3 });
    await player.load({ url: HLS_URL });
    for (let i = 0; i < 4; i++) {
      const hls = lastHls();
      hls.emit('hlsManifestParsed', {});
      hls.emit('hlsError', netError('fragLoadError', 503));
      await flush();
      if (i < 3) await vi.advanceTimersByTimeAsync(events.of('reconnecting').at(-1).delayMs);
    }
    expect(events.of('reconnecting').map((r) => r.attempt)).toEqual([1, 2, 3]);
    expect(player.state).toBe('error');
    expect(player.error.message).toMatch(/^Couldn’t reconnect after 3 attempts\./);
    expect(player.attempt).toBe(3);
  });

  it('fails immediately when autoReconnect is off', async () => {
    const { events } = setup({ autoReconnect: false });
    await player.load({ url: HLS_URL });
    lastHls().emit('hlsError', { type: 'networkError', details: 'manifestLoadTimeOut', fatal: true });
    await flush();
    expect(player.state).toBe('error');
    expect(player.error.code).toBe('NETWORK');
    expect(events.of('reconnecting')).toHaveLength(0);
  });

  it('detects stalls with the watchdog', async () => {
    vi.useFakeTimers();
    const { events } = setup({ stallTimeoutMs: 5000 });
    await player.load({ url: HLS_URL });
    lastHls().emit('hlsManifestParsed', {});
    ctl.startPlaying(3);
    await vi.advanceTimersByTimeAsync(4000);
    expect(player.state).toBe('playing');
    await vi.advanceTimersByTimeAsync(1500); // stall detected at 5 s; the reconnect waits ≥ 800 ms
    expect(player.state).toBe('reconnecting');
    expect(events.of('reconnecting')[0]).toMatchObject({ code: 'NETWORK' });
    expect(events.of('reconnecting')[0].reason).toBe('The stream stopped responding.');
  });

  it('does not treat a paused stream as stalled', async () => {
    vi.useFakeTimers();
    setup({ stallTimeoutMs: 3000 });
    await player.load({ url: HLS_URL });
    lastHls().emit('hlsManifestParsed', {});
    ctl.startPlaying(3);
    player.pause();
    expect(player.state).toBe('paused');
    await vi.advanceTimersByTimeAsync(10000);
    expect(player.state).toBe('paused');
  });

  it('times out loads that never start', async () => {
    vi.useFakeTimers();
    const { events } = setup();
    await player.load({ url: HLS_URL });
    await vi.advanceTimersByTimeAsync(24000);
    expect(player.state).toBe('loading');
    await vi.advanceTimersByTimeAsync(1500); // timeout at 25 s; the reconnect waits ≥ 800 ms
    expect(player.state).toBe('reconnecting');
    expect(events.of('reconnecting')[0].reason).toBe('The stream took too long to start.');
  });

  it('gives up on a server that never responds after a few attempts, not minutes', async () => {
    vi.useFakeTimers();
    const { events } = setup();
    await player.load({ url: HLS_URL });
    await vi.advanceTimersByTimeAsync(120000);
    expect(events.of('reconnecting').map((r) => r.max)).toEqual([2, 2]);
    expect(player.state).toBe('error');
    expect(player.error).toMatchObject({ code: 'NETWORK' });
    expect(player.error.message).toMatch(/^Couldn’t reconnect after 2 attempts\. The stream took too long/);
  });

  it('keeps the full retry budget for load timeouts of a stream that already played', async () => {
    vi.useFakeTimers();
    const { events } = setup();
    await player.load({ url: HLS_URL });
    lastHls().emit('hlsManifestParsed', {});
    ctl.startPlaying();
    await vi.advanceTimersByTimeAsync(16000); // stalls (no progress) → reconnect
    expect(player.state).not.toBe('error');
    await vi.advanceTimersByTimeAsync(120000); // every reconnect then times out while loading
    expect(events.of('reconnecting').length).toBeGreaterThanOrEqual(4);
    expect(events.of('reconnecting').every((r) => r.max === 8)).toBe(true);
  });

  it('restores the VOD position after a reconnect', async () => {
    vi.useFakeTimers();
    const { events } = setup();
    await player.load({ url: 'https://cdn.example.com/movie.mp4' });
    expect(player.engine).toBe('native');
    ctl.m.duration = 600;
    ctl.fire('durationchange');
    expect(player.isLive).toBe(false);
    ctl.startPlaying(120);
    expect(player.canSeek).toBe(true);
    ctl.fail(2); // MEDIA_ERR_NETWORK
    await flush();
    expect(player.state).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(events.of('reconnecting')[0].delayMs);
    expect(ctl.video.getAttribute('src')).toBe('https://cdn.example.com/movie.mp4');
    ctl.m.duration = 600;
    ctl.fire('loadedmetadata');
    expect(ctl.m.currentTime).toBe(120);
  });

  it('prefers the engine that last worked when reconnecting', async () => {
    vi.useFakeTimers();
    const { events } = setup({}, { nativeHls: 'maybe' });
    await player.load({ url: HLS_URL });
    lastHls().emit('hlsError', manifestError(0));
    await flush();
    expect(player.engine).toBe('native');
    ctl.startPlaying();
    ctl.fail(2);
    await flush();
    await vi.advanceTimersByTimeAsync(events.of('reconnecting')[0].delayMs);
    expect(player.engine).toBe('native');
    expect(mocks.hls).toHaveLength(1);
  });

  it('retry() resets the attempt counter and reloads from ERROR', async () => {
    setup({ autoReconnect: false });
    await player.load({ url: HLS_URL });
    lastHls().emit('hlsError', manifestError(0));
    await flush();
    expect(player.state).toBe('error');
    player.retry();
    await flush();
    expect(player.state).toBe('loading');
    expect(player.error).toBeNull();
    expect(player.attempt).toBe(0);
    expect(mocks.hls).toHaveLength(2);
  });

  it('play() during the reconnect countdown reconnects immediately', async () => {
    vi.useFakeTimers();
    setup();
    await player.load({ url: HLS_URL });
    lastHls().emit('hlsManifestParsed', {});
    ctl.startPlaying();
    lastHls().emit('hlsError', netError('fragLoadError', 502));
    await flush();
    expect(player.state).toBe('reconnecting');
    await player.play();
    await flush();
    expect(mocks.hls).toHaveLength(2);
    expect(player.state).toBe('loading');
    expect(vi.getTimerCount()).toBe(1); // only the new watchdog
  });
});

describe('Player — autoplay', () => {
  it('falls back to muted autoplay on NotAllowedError', async () => {
    const { events } = setup();
    let calls = 0;
    ctl.playImpl = () => {
      calls += 1;
      if (calls === 1) return Promise.reject(new DOMException('blocked', 'NotAllowedError'));
      ctl.m.paused = false;
      return Promise.resolve();
    };
    await player.load({ url: HLS_URL });
    lastHls().emit('hlsManifestParsed', {});
    await flush();
    expect(ctl.m.muted).toBe(true);
    expect(events.of('autoplaymuted')).toHaveLength(1);
  });

  it('goes to PAUSED when even muted autoplay is blocked, restoring the mute state', async () => {
    const { events } = setup();
    ctl.playImpl = () => Promise.reject(new DOMException('blocked', 'NotAllowedError'));
    await player.load({ url: HLS_URL });
    lastHls().emit('hlsManifestParsed', {});
    await flush();
    expect(player.state).toBe('paused');
    expect(events.of('statechange').at(-1)).toMatchObject({ state: 'paused', reason: 'autoplay-blocked' });
    expect(ctl.m.muted).toBe(false);
    expect(events.of('autoplaymuted')).toHaveLength(0);
  });

  it('does not time out a blocked autoplay when the user presses play much later', async () => {
    vi.useFakeTimers();
    const { events } = setup();
    let blocked = true;
    ctl.playImpl = () => {
      if (blocked) return Promise.reject(new DOMException('blocked', 'NotAllowedError'));
      ctl.m.paused = false;
      ctl.fire('play');
      return Promise.resolve();
    };
    await player.load({ url: HLS_URL });
    lastHls().emit('hlsManifestParsed', {});
    await flush();
    expect(player.state).toBe('paused');
    await vi.advanceTimersByTimeAsync(60000);
    expect(player.state).toBe('paused');
    blocked = false;
    await player.play();
    expect(player.state).toBe('loading');
    await vi.advanceTimersByTimeAsync(3000);
    expect(player.state).toBe('loading');
    expect(events.of('reconnecting')).toHaveLength(0);
    ctl.startPlaying();
    expect(player.state).toBe('playing');
  });

  it('ignores AbortError from rapid switching', async () => {
    const { events } = setup();
    ctl.playImpl = () => Promise.reject(new DOMException('interrupted', 'AbortError'));
    await player.load({ url: HLS_URL });
    lastHls().emit('hlsManifestParsed', {});
    await flush();
    expect(player.state).toBe('loading');
    expect(player.error).toBeNull();
    expect(events.of('error')).toHaveLength(0);
  });

  it('does not autoplay when disabled and settles in PAUSED once data is loaded', async () => {
    setup({ autoplay: false });
    await player.load({ url: HLS_URL });
    lastHls().emit('hlsManifestParsed', {});
    expect(ctl.video.play).not.toHaveBeenCalled();
    ctl.m.readyState = 2;
    ctl.fire('loadeddata');
    expect(player.state).toBe('paused');
    await player.play();
    ctl.fire('playing');
    expect(player.state).toBe('playing');
  });

  it('play() never rejects', async () => {
    setup();
    ctl.playImpl = () => Promise.reject(new DOMException('blocked', 'NotAllowedError'));
    await player.load({ url: 'https://cdn.example.com/movie.mp4' });
    await expect(player.play()).resolves.toBeUndefined();
    await flush();
    expect(player.state).toBe('paused');
  });
});

describe('Player — offline / online', () => {
  it('waits while offline without consuming attempts and reloads when back online', async () => {
    const { events } = setup();
    await player.load({ url: HLS_URL });
    const hls = lastHls();
    hls.emit('hlsManifestParsed', {});
    ctl.startPlaying();
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    window.dispatchEvent(new Event('offline'));
    expect(player.state).toBe('reconnecting');
    expect(player.error).toMatchObject({ code: 'OFFLINE', fatal: false });
    expect(events.of('error').at(-1).error.code).toBe('OFFLINE');
    expect(player.attempt).toBe(0);
    expect(hls.destroyed).toBe(true);

    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    window.dispatchEvent(new Event('online'));
    await flush();
    expect(mocks.hls).toHaveLength(2);
    expect(player.state).toBe('loading');
    lastHls().emit('hlsManifestParsed', {});
    ctl.startPlaying();
    expect(events.of('recovered')).toHaveLength(1);
    expect(player.error).toBeNull();
  });

  it('enters the offline wait instead of retrying when a failure happens offline', async () => {
    const { events } = setup();
    await player.load({ url: HLS_URL });
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    lastHls().emit('hlsError', manifestError(0));
    await flush();
    expect(player.state).toBe('reconnecting');
    expect(player.error.code).toBe('OFFLINE');
    expect(events.of('reconnecting')).toHaveLength(0);
    expect(player.attempt).toBe(0);
  });
});

describe('Player — native and mpegts.js engines', () => {
  it('plays progressive files natively and reports SRC_NOT_SUPPORTED as UNSUPPORTED', async () => {
    const { events } = setup();
    await player.load({ url: 'https://cdn.example.com/movie.mp4' });
    expect(player.engine).toBe('native');
    expect(ctl.video.getAttribute('src')).toBe('https://cdn.example.com/movie.mp4');
    expect(ctl.video.play).toHaveBeenCalled();
    ctl.fail(4);
    await flush();
    expect(player.state).toBe('error');
    expect(player.error.code).toBe('UNSUPPORTED');
    expect(events.of('reconnecting')).toHaveLength(0);
  });

  it('retries native network errors', async () => {
    const { events } = setup();
    await player.load({ url: 'https://cdn.example.com/movie.mp4' });
    ctl.fail(2);
    await flush();
    expect(player.state).toBe('reconnecting');
    expect(events.of('reconnecting')[0].code).toBe('NETWORK');
  });

  it('keeps reconnecting a native stream that played when its source becomes unreachable', async () => {
    vi.useFakeTimers();
    const { events } = setup();
    await player.load({ url: 'https://cdn.example.com/live/stream.webm' });
    ctl.startPlaying();
    ctl.fail(2); // network error mid-playback
    await flush();
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(events.of('reconnecting').at(-1).delayMs);
      ctl.fail(4); // Chrome reports a refused connection on a fresh src as SRC_NOT_SUPPORTED
      await flush();
      expect(player.state).toBe('reconnecting');
    }
    expect(events.of('reconnecting').at(-1)).toMatchObject({ attempt: 4, max: 8, code: 'NETWORK' });
  });

  it('keeps reconnecting an MPEG-TS stream that played when the server becomes unreachable', async () => {
    vi.useFakeTimers();
    const { events } = setup();
    await player.load({ url: TS_URL });
    await vi.waitFor(() => expect(mocks.ts).toHaveLength(1));
    ctl.startPlaying();
    lastTs().emit('error', 'NetworkError', 'UnrecoverableEarlyEof', { code: -1, msg: 'eof' });
    await flush();
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(events.of('reconnecting').at(-1).delayMs);
      await vi.waitFor(() => expect(mocks.ts).toHaveLength(i + 2));
      lastTs().emit('error', 'NetworkError', 'Exception', { code: -1, msg: 'Failed to fetch' });
      await flush();
      expect(player.state).toBe('reconnecting');
    }
    expect(events.of('reconnecting').at(-1)).toMatchObject({ attempt: 4, max: 8, code: 'NETWORK' });
  });

  it('ignores aborted media errors', async () => {
    setup();
    await player.load({ url: 'https://cdn.example.com/movie.mp4' });
    ctl.fail(1);
    await flush();
    expect(player.state).toBe('loading');
  });

  it('plays MPEG-TS with mpegts.js and retries its network errors', async () => {
    const { events } = setup();
    await player.load({ url: TS_URL });
    await vi.waitFor(() => expect(mocks.ts).toHaveLength(1));
    const ts = lastTs();
    expect(ts.dataSource).toEqual({ type: 'mpegts', isLive: true, url: TS_URL });
    expect(ts.config).toMatchObject({
      enableWorker: false,
      lazyLoad: false,
      liveBufferLatencyChasing: true,
      liveBufferLatencyMaxLatency: 6,
      liveBufferLatencyMinRemain: 1.5,
      autoCleanupSourceBuffer: true,
    });
    expect(ts.media).toBe(ctl.video);
    expect(ts.loaded).toBe(true);
    expect(player.engine).toBe('mpegts.js');
    expect(player.isLive).toBe(true);
    ctl.startPlaying();
    ts.emit('error', 'NetworkError', 'UnrecoverableEarlyEof', { code: -1, msg: 'eof' });
    await flush();
    expect(player.state).toBe('reconnecting');
    expect(events.of('reconnecting')[0].code).toBe('NETWORK');
    expect(ts.destroyed).toBe(true);
  });

  it('uses the flv type for .flv streams', async () => {
    setup();
    await player.load({ url: 'https://iptv.example.com/live/stream.flv' });
    await vi.waitFor(() => expect(mocks.ts).toHaveLength(1));
    expect(lastTs().dataSource.type).toBe('flv');
  });

  it('falls back to native when MSE live playback is unavailable', async () => {
    mocks.tsFeatures.value = { mseLivePlayback: false };
    setup();
    await player.load({ url: TS_URL });
    await vi.waitFor(() => expect(player.engine).toBe('native'));
    expect(mocks.ts).toHaveLength(0);
    expect(ctl.video.getAttribute('src')).toBe(TS_URL);
  });

  it('maps mpegts.js HTTP status errors', async () => {
    const { events } = setup();
    await player.load({ url: TS_URL });
    await vi.waitFor(() => expect(mocks.ts).toHaveLength(1));
    lastTs().emit('error', 'NetworkError', 'HttpStatusCodeInvalid', { code: 404, msg: 'Not Found' });
    await flush();
    expect(events.of('reconnecting')[0]).toMatchObject({ code: 'HTTP', max: 2 });
  });

  it('sniffs unknown URLs and picks the matching engine', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      url: '',
      headers: { get: () => 'application/octet-stream' },
      body: {
        getReader: () => {
          let done = false;
          return {
            read: async () => {
              if (done) return { done: true };
              done = true;
              return { done: false, value: new TextEncoder().encode('#EXTM3U\n#EXT-X-VERSION:3\n') };
            },
            cancel: async () => {},
          };
        },
      },
    })));
    setup({ sniff: true });
    await player.load({ url: 'https://xtream.example.com/u/p/1001' });
    expect(player.engine).toBe('hls.js');
    expect(player.getStats().type).toBe('hls');
  });

  it('falls back to the native → hls.js → mpegts.js chain when sniffing fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }));
    setup({ sniff: true });
    await player.load({ url: 'https://xtream.example.com/u/p/1001' });
    expect(player.engine).toBe('native');
    ctl.fail(4);
    await flush();
    expect(player.engine).toBe('hls.js');
    lastHls().emit('hlsError', { type: 'networkError', details: 'manifestParsingError', fatal: true });
    await flush();
    await vi.waitFor(() => expect(player.engine).toBe('mpegts.js'));
    expect(lastTs().dataSource.type).toBe('mpegts');
  });
});

describe('Player — controls and lifecycle', () => {
  it('pause/togglePlay/seekBy behave', async () => {
    setup();
    await player.load({ url: 'https://cdn.example.com/movie.mp4' });
    ctl.m.duration = 300;
    ctl.fire('durationchange');
    ctl.startPlaying(100);
    player.togglePlay();
    expect(player.state).toBe('paused');
    player.togglePlay();
    ctl.fire('playing');
    expect(player.state).toBe('playing');
    player.seekBy(30);
    expect(ctl.m.currentTime).toBe(130);
    player.seekBy(-500);
    expect(ctl.m.currentTime).toBe(0);
    player.seekBy(10000);
    expect(ctl.m.currentTime).toBeCloseTo(299.9);
  });

  it('stop() tears everything down and returns to IDLE', async () => {
    vi.useFakeTimers();
    const { events } = setup();
    await player.load({ url: HLS_URL });
    const hls = lastHls();
    hls.levels = [{ height: 720, bitrate: 1e6 }, { height: 480, bitrate: 5e5 }];
    hls.emit('hlsManifestParsed', {});
    ctl.startPlaying();
    player.stop();
    expect(player.state).toBe(PlayerState.IDLE);
    expect(player.engine).toBeNull();
    expect(player.levels).toEqual([]);
    expect(player.source).toBeNull();
    expect(hls.destroyed).toBe(true);
    expect(ctl.video.hasAttribute('src')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(events.of('engine').at(-1)).toEqual({ engine: null });
    expect(events.of('levels').at(-1).levels).toEqual([]);
    // Late events from the stopped engine are ignored.
    hls.emit('hlsError', manifestError(0));
    await flush();
    expect(player.state).toBe('idle');
  });

  it('destroy() is idempotent and silences the player', async () => {
    const { events } = setup();
    await player.load({ url: HLS_URL });
    const hls = lastHls();
    player.destroy();
    expect(() => player.destroy()).not.toThrow();
    expect(player.destroyed).toBe(true);
    expect(hls.destroyed).toBe(true);
    const count = events.length;
    await player.load({ url: HLS_URL });
    window.dispatchEvent(new Event('offline'));
    ctl.fire('playing');
    hls.emit('hlsError', manifestError(0));
    await flush();
    expect(events.length).toBe(count);
    expect(mocks.hls).toHaveLength(1);
  });

  it('getStats() returns a complete snapshot', async () => {
    setup();
    await player.load({ url: HLS_URL });
    const hls = lastHls();
    hls.levels = [{ height: 720, width: 1280, bitrate: 3e6 }];
    hls.currentLevel = 0;
    hls.bandwidthEstimate = 8e6;
    hls.emit('hlsManifestParsed', {});
    hls.emit('hlsLevelLoaded', { details: { live: true } });
    hls.latency = 6.5;
    ctl.m.videoWidth = 1280;
    ctl.m.videoHeight = 720;
    ctl.m.buffered = ranges([[0, 14]]);
    ctl.startPlaying(10);
    const stats = player.getStats();
    expect(stats).toMatchObject({
      engine: 'hls.js',
      url: HLS_URL,
      width: 1280,
      height: 720,
      bitrate: 3e6,
      bandwidth: 8e6,
      bufferAhead: 4,
      latency: 6.5,
      level: '720p',
      isLive: true,
      state: 'playing',
      attempt: 0,
    });
    expect(stats).toHaveProperty('droppedFrames');
    expect(stats).toHaveProperty('totalFrames');
  });

  it('getStats() labels a plain media playlist (no RESOLUTION/BANDWIDTH) by the decoded height', async () => {
    setup();
    await player.load({ url: HLS_URL });
    const hls = lastHls();
    hls.levels = [{ height: 0, width: 0, bitrate: 0 }];
    hls.currentLevel = 0;
    hls.emit('hlsManifestParsed', {});
    ctl.m.videoWidth = 640;
    ctl.m.videoHeight = 360;
    ctl.startPlaying(1);
    expect(player.getStats()).toMatchObject({ level: '360p', bitrate: 0 });
  });

  it('setOptions applies lowLatency to the running hls.js instance', async () => {
    setup({ lowLatency: true });
    await player.load({ url: HLS_URL });
    player.setOptions({ lowLatency: false, maxRetries: 3 });
    expect(lastHls().lowLatencyMode).toBe(false);
    expect(player.options.maxRetries).toBe(3);
  });
});

describe('buildLevelList', () => {
  it('sorts, dedupes by height and labels levels', () => {
    const list = buildLevelList([
      { height: 480, width: 854, bitrate: 1.2e6 },
      { height: 1080, width: 1920, bitrate: 6e6, frameRate: 60 },
      { height: 1080, width: 1920, bitrate: 4.5e6, frameRate: 30 },
      { height: 0, bitrate: 128000 }, // audio-only variant: dropped when video exists
    ]);
    expect(list.map((l) => l.label)).toEqual(['1080p60', '480p']);
    expect(list[0]).toMatchObject({ index: 1, bitrate: 6e6, detail: '6.0 Mbps' });
  });

  it('labels audio-only / unknown resolutions by bitrate', () => {
    expect(buildLevelList([{ bitrate: 3.2e6 }, { bitrate: 128000 }]).map((l) => l.label))
      .toEqual(['3.2 Mbps', '128 kbps']);
  });
});
