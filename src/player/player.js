// Playback engine: wraps a <video> element and picks the right engine per stream (hls.js, mpegts.js or the
// browser's native player), classifies failures into actionable errors, and keeps live channels alive with
// engine fallback, auto-reconnect (exponential backoff + jitter), a stall watchdog and offline handling.
//
// Every engine "run" gets a load token. All async continuations, engine callbacks and timers check it, so
// rapid channel switching never leaks engines, timers or listeners, and never applies stale events.

// hls.js itself is loaded on demand (see loadHls()), so the app shell starts without it. The worker URL is a
// plain asset URL: hls.js' ESM build only transmuxes in a Web Worker when given one (same origin, CSP-safe).
import hlsWorkerUrl from 'hls.js/dist/hls.worker.js?url';
import { formatBitrate, tryParseUrl } from '../lib/utils.js';
import {
  backoffDelay,
  detectStreamType,
  isMixedContent,
  sniffStreamType,
  upgradeToHttps,
} from './stream-type.js';

/** @enum {string} */
export const PlayerState = Object.freeze({
  IDLE: 'idle',
  LOADING: 'loading',
  PLAYING: 'playing',
  PAUSED: 'paused',
  BUFFERING: 'buffering',
  RECONNECTING: 'reconnecting',
  ERROR: 'error',
});

/** @enum {string} */
export const PlayerErrorCode = Object.freeze({
  MIXED_CONTENT: 'MIXED_CONTENT',
  NETWORK: 'NETWORK',
  CORS: 'CORS',
  MEDIA: 'MEDIA',
  UNSUPPORTED: 'UNSUPPORTED',
  DRM: 'DRM',
  MANIFEST: 'MANIFEST',
  HTTP: 'HTTP',
  OFFLINE: 'OFFLINE',
  AUTOPLAY: 'AUTOPLAY',
  UNKNOWN: 'UNKNOWN',
});

/** Engine identifiers exposed via `player.engine` and the 'engine' event. */
export const Engine = Object.freeze({ HLS: 'hls.js', NATIVE: 'native', MPEGTS: 'mpegts.js' });

export const DEFAULT_PLAYER_OPTIONS = Object.freeze({
  autoReconnect: true,
  maxRetries: 8,
  upgradeInsecure: true,
  lowLatency: true,
  preferNativeHls: false,
  stallTimeoutMs: 15000,
  autoplay: true,
  /** Max time from engine start to first frame before the load counts as a (retryable) network failure. */
  loadTimeoutMs: 25000,
  /** Continuous healthy playback needed before the reconnect attempt counter resets to 0. */
  healthyResetMs: 15000,
  /** Probe the first bytes of URLs whose type can't be told from the URL. */
  sniff: true,
  sniffTimeoutMs: 5000,
  /** Page protocol used for mixed-content checks; defaults to `location.protocol` (injectable for tests). */
  pageProtocol: undefined,
});

const S = PlayerState;
const E = PlayerErrorCode;

const MEDIA_ERR_ABORTED = 1;
const MEDIA_ERR_NETWORK = 2;
const MEDIA_ERR_DECODE = 3;
const MEDIA_ERR_SRC_NOT_SUPPORTED = 4;
const HAVE_CURRENT_DATA = 2;
const HAVE_FUTURE_DATA = 3;

const WATCHDOG_INTERVAL_MS = 1000;
const MEDIA_RECOVERY_WINDOW_MS = 3000;
/** Retry cap for errors that rarely fix themselves (403/404, CORS, invalid playlist…). */
const LIMITED_RETRIES = 2;

/** Equivalent of manifestLoadingMaxRetry: 2 + manifestLoadingRetryDelay: 1000, levelLoadingMaxRetry: 4 and
 * fragLoadingMaxRetry: 6, expressed with the non-deprecated *LoadPolicy API (the legacy keys make
 * hls.js ≥ 1.5 log a deprecation warning for every instance). Other timeouts keep hls.js defaults. */
const loadPolicy = (maxTimeToFirstByteMs, maxLoadTimeMs, maxNumRetry, timeoutRetryDelayMs = 0) => ({
  default: {
    maxTimeToFirstByteMs,
    maxLoadTimeMs,
    timeoutRetry: { maxNumRetry, retryDelayMs: timeoutRetryDelayMs, maxRetryDelayMs: timeoutRetryDelayMs },
    errorRetry: { maxNumRetry, retryDelayMs: 1000, maxRetryDelayMs: 8000 },
  },
});

const HLS_BASE_CONFIG = Object.freeze({
  enableWorker: true,
  backBufferLength: 30,
  maxBufferLength: 30,
  maxMaxBufferLength: 60,
  liveSyncDurationCount: 3,
  liveMaxLatencyDurationCount: 10,
  startFragPrefetch: true,
  testBandwidth: true,
  progressive: false,
});

function hlsConfig({ lowLatency, startPosition }) {
  const config = {
    ...HLS_BASE_CONFIG,
    lowLatencyMode: !!lowLatency,
    manifestLoadPolicy: loadPolicy(Infinity, 20000, 2, 1000),
    playlistLoadPolicy: loadPolicy(10000, 20000, 4),
    fragLoadPolicy: loadPolicy(10000, 120000, 6),
  };
  if (typeof hlsWorkerUrl === 'string' && hlsWorkerUrl) config.workerPath = hlsWorkerUrl;
  if (Number.isFinite(startPosition) && startPosition > 0) config.startPosition = startPosition;
  return config;
}

const MPEGTS_CONFIG = Object.freeze({
  enableWorker: false,
  lazyLoad: false,
  liveBufferLatencyChasing: true,
  liveBufferLatencyMaxLatency: 6,
  liveBufferLatencyMinRemain: 1.5,
  autoCleanupSourceBuffer: true,
});

/** Error codes that mean "couldn't reach / fetch it" — used to decide whether an https upgrade failed. */
const NETWORKISH = new Set([E.CORS, E.NETWORK, E.HTTP, E.MANIFEST, E.UNKNOWN]);

// ---------------------------------------------------------------------------------------------------------
// Failure classification. A "failure" is internal: it carries routing hints (retryable, nextEngine…).
// The public error (player.error / 'error' event) is { code, message, detail?, status?, technical?, fatal }.
// ---------------------------------------------------------------------------------------------------------

const RANK = {
  DRM: 100, HTTP: 90, MANIFEST: 75, CODEC: 74, MEDIA: 72, CORS: 70, FORMAT: 50, NETWORK: 40, UNKNOWN: 10,
};

/**
 * @typedef {object} Failure
 * @property {string} code
 * @property {string} message
 * @property {string} [detail]
 * @property {number} [status]
 * @property {string} [technical]
 * @property {boolean} retryable    a reconnect cycle may fix it
 * @property {number} maxRetries    per-cause cap (Infinity = use options.maxRetries)
 * @property {boolean} nextEngine   before the first frame, trying the next engine may help
 * @property {boolean} ambiguous    native "src not supported" (browsers also report 404/TLS failures this way)
 * @property {number} rank          informativeness when every engine failed
 * @property {string} reason        short machine-readable reason ('stalled', 'timeout', 'cors'…)
 */

/** @returns {Failure} */
function failure(code, message, opts = {}) {
  return {
    code,
    message,
    detail: opts.detail || '',
    status: opts.status,
    technical: opts.technical || '',
    retryable: !!opts.retryable,
    maxRetries: opts.maxRetries ?? Infinity,
    nextEngine: !!opts.nextEngine,
    ambiguous: !!opts.ambiguous,
    rank: opts.rank ?? RANK[code] ?? 0,
    reason: opts.reason || String(code).toLowerCase(),
  };
}

const MSG = {
  mixed: 'This channel uses an insecure HTTP stream, which browsers block on secure (HTTPS) pages.',
  mixedDetail:
    'Use an HTTPS stream URL if your provider offers one, or run the player locally over http:// ' +
    '(for example on your own computer) to play insecure streams.',
  mixedUpgradeDetail:
    'The HTTPS version of this link didn’t work either. Use an HTTPS stream URL if your provider offers one, ' +
    'or run the player locally over http:// (for example on your own computer) to play insecure streams.',
  drm: 'DRM-protected channels are not supported in the browser player.',
  drmDetail: 'This channel needs a license (Widevine/PlayReady). Open it in your provider’s official app.',
  dash: 'MPEG-DASH streams are not supported.',
  dashDetail: 'Look for an HLS (.m3u8) version of this channel, or open it in a desktop player such as VLC.',
  cors: 'The stream server didn’t respond or doesn’t allow playback in web browsers.',
  corsDetail:
    'The server may be offline, or it doesn’t send the CORS headers web players need. Try again later, ' +
    'or open the stream in a desktop player such as VLC.',
  format: 'This stream’s format isn’t supported by your browser.',
  formatDetail:
    'The stream may also be offline. Try another channel or open it in a desktop player such as VLC.',
  codec: 'This stream uses a video or audio codec your browser can’t play.',
  codecDetail:
    'This is common with HEVC/H.265 video or AC-3 audio. Try another browser (Safari or Edge often support ' +
    'more codecs) or a desktop player such as VLC.',
  media: 'The stream couldn’t be decoded.',
  mediaDetail: 'The stream may be corrupted or use an unusual encoding.',
  manifest: 'The stream playlist is invalid or empty.',
  manifestDetail: 'The server returned something that isn’t a playable HLS playlist.',
  network: 'Lost connection to the stream.',
  networkDetail: 'Check your internet connection. The stream server may also be overloaded or offline.',
  timeout: 'The stream took too long to start.',
  stalled: 'The stream stopped responding.',
  serverTimeout: 'The stream server isn’t responding.',
  closed: 'The stream server closed the connection.',
  ended: 'The live stream ended unexpectedly.',
  offline: 'You’re offline. Playback will resume when your connection is back.',
  noUrl: 'This channel has no stream URL.',
  badUrl: 'This channel’s stream URL is invalid.',
  noEngine: 'Your browser can’t play this type of stream.',
  noHls: 'Your browser can’t play HLS streams.',
  noHlsDetail: 'Update your browser, or try a recent version of Chrome, Edge, Firefox or Safari.',
  noMse: 'Your browser can’t play MPEG-TS/FLV streams.',
  unknown: 'Something went wrong while playing this stream.',
};

function protocolFailure(url) {
  const proto = (/^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1] || 'This').toLowerCase();
  return failure(E.UNSUPPORTED, `${proto}:// streams can’t be played in a browser.`, {
    detail:
      'Browsers can only play HTTP(S) streams. Open this channel in a desktop player such as VLC, ' +
      'or ask your provider for an HLS (.m3u8) link.',
    reason: 'protocol',
  });
}

function httpFailure(status, { technical = '', nextEngine = false } = {}) {
  const common = { status, technical, nextEngine, reason: `http-${status}` };
  if (status === 401 || status === 403) {
    return failure(E.HTTP, `Access denied (${status}). The provider refused this stream.`, {
      ...common,
      detail:
        'Your subscription may have expired, the link may be geo-restricted or tokenized, or the server ' +
        'blocks web players.',
      retryable: true,
      maxRetries: LIMITED_RETRIES,
    });
  }
  if (status === 404 || status === 410) {
    return failure(E.HTTP, `Stream not found (${status}).`, {
      ...common,
      detail: 'The channel may have moved or been taken offline. Try refreshing the playlist.',
      retryable: true,
      maxRetries: LIMITED_RETRIES,
    });
  }
  if (status >= 500 || status === 429 || status === 408) {
    return failure(E.HTTP, `The stream server is having trouble (${status}).`, {
      ...common,
      detail: 'This is usually temporary — try again in a moment.',
      retryable: true,
    });
  }
  return failure(E.HTTP, `The stream server rejected the request (${status}).`, {
    ...common,
    detail: 'The link may be outdated. Try refreshing the playlist.',
    retryable: true,
    maxRetries: LIMITED_RETRIES,
  });
}

const corsFailure = (technical) =>
  failure(E.CORS, MSG.cors, {
    detail: MSG.corsDetail,
    technical,
    retryable: true,
    maxRetries: LIMITED_RETRIES,
    nextEngine: true,
    reason: 'cors',
  });

const codecFailure = (technical) =>
  failure(E.UNSUPPORTED, MSG.codec, { detail: MSG.codecDetail, technical, nextEngine: true, rank: RANK.CODEC,
    reason: 'codec' });

const mediaFailure = (technical, nextEngine = true) =>
  failure(E.MEDIA, MSG.media, { detail: MSG.mediaDetail, technical, retryable: true, nextEngine });

const networkFailure = (message, reason, technical = '') =>
  failure(E.NETWORK, message, { detail: MSG.networkDetail, technical, retryable: true, reason });

function mixedContentFailure(upgradeTried, technical = '') {
  return failure(E.MIXED_CONTENT, MSG.mixed, {
    detail: upgradeTried ? MSG.mixedUpgradeDetail : MSG.mixedDetail,
    technical,
    reason: 'mixed-content',
  });
}

/** Most informative failure (highest rank; ties → most recent). */
function pickBest(failures) {
  let best = null;
  for (const f of failures) if (!best || f.rank >= best.rank) best = f;
  return best || failure(E.UNKNOWN, MSG.unknown, { retryable: true, maxRetries: LIMITED_RETRIES });
}

function toPublicError(f, fatal = true) {
  const error = { code: f.code, message: f.message, fatal };
  if (f.detail) error.detail = f.detail;
  if (Number.isFinite(f.status)) error.status = f.status;
  if (f.technical) error.technical = f.technical;
  return error;
}

// ---------------------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------------------

/** Call video.play() and always return a promise (play() may throw or return undefined in old engines). */
function safePlay(video) {
  try {
    const p = video.play();
    return p && typeof p.then === 'function' ? p : Promise.resolve();
  } catch (err) {
    return Promise.reject(err);
  }
}

function attempt(fn, fallback = undefined) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/** Seconds buffered ahead of currentTime. */
function bufferAhead(video) {
  const ranges = attempt(() => video.buffered);
  if (!ranges || !ranges.length) return 0;
  const t = video.currentTime;
  for (let i = 0; i < ranges.length; i++) {
    const start = ranges.start(i);
    const end = ranges.end(i);
    if (t >= start - 0.25 && t <= end) return Math.max(0, end - t);
  }
  return 0;
}

function lastRangeEnd(ranges) {
  return ranges && ranges.length ? ranges.end(ranges.length - 1) : NaN;
}

function levelLabel(level) {
  const height = level.height | 0;
  if (height > 0) {
    const fps = Number(level.frameRate) || 0;
    return `${height}p${fps >= 49 ? Math.round(fps) : ''}`;
  }
  return formatBitrate(level.bitrate) || `Level ${level.index + 1}`;
}

/**
 * Normalize hls.js levels for menus: sorted high→low, one entry per height (best bitrate wins), audio-only
 * variants dropped when video variants exist. `index` is the hls.js level index to pass to setLevel().
 * @param {Array<{height?: number, width?: number, bitrate?: number, frameRate?: number}>} raw  hls.levels
 * @returns {Array<{index: number, height: number, width: number, bitrate: number, label: string,
 *   detail: string}>}
 */
export function buildLevelList(raw) {
  const items = (raw || []).map((l, index) => ({
    index,
    height: (l && l.height) | 0,
    width: (l && l.width) | 0,
    bitrate: (l && (l.bitrate || l.maxBitrate)) || 0,
    frameRate: (l && l.frameRate) || 0,
  }));
  const hasVideo = items.some((it) => it.height > 0);
  const byKey = new Map();
  for (const it of items) {
    if (hasVideo && it.height <= 0) continue;
    const key = it.height > 0 ? `h${it.height}` : `b${it.bitrate}`;
    const prev = byKey.get(key);
    if (!prev || it.bitrate > prev.bitrate) byKey.set(key, it);
  }
  return [...byKey.values()]
    .sort((a, b) => b.height - a.height || b.bitrate - a.bitrate)
    .map((it) => ({
      index: it.index,
      height: it.height,
      width: it.width,
      bitrate: it.bitrate,
      label: levelLabel(it),
      detail: formatBitrate(it.bitrate),
    }));
}

let languageNames = null;
function languageLabel(code) {
  if (!code) return '';
  try {
    languageNames ||= new Intl.DisplayNames(undefined, { type: 'language' });
    const name = languageNames.of(code);
    return name && name !== code ? name : code;
  } catch {
    return code;
  }
}

function trackLabel(name, lang, index) {
  return String(name || '').trim() || languageLabel(lang) || `Track ${index + 1}`;
}

/** The hls.js class once loadHls() resolved (engine code below only runs after that). */
let Hls = null;
let hlsImport = null;

/**
 * Load hls.js (a separate ~500 kB chunk) once; later calls reuse it. A failed import is retried on the next
 * call. Call it early (e.g. once a playlist is shown) to warm the chunk up before the first HLS channel.
 * @returns {Promise<typeof import('hls.js').default>}
 */
export function loadHls() {
  if (Hls) return Promise.resolve(Hls);
  hlsImport ||= import('hls.js').then(
    (mod) => {
      const Ctor = typeof mod?.default === 'function' ? mod.default : mod;
      if (typeof Ctor?.isSupported !== 'function') throw new Error('hls.js module has no Hls export');
      Hls = Ctor;
      return Ctor;
    },
    (err) => {
      hlsImport = null;
      throw err;
    },
  );
  return hlsImport;
}

/** Reject when `promise` hasn't settled after `ms` (the timer is always cleared). */
function withTimeout(promise, ms, message) {
  let timer = 0;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** mpegts.js is UMD/CJS: depending on the bundler the API is the module, its default, or default.default. */
function resolveMpegts(mod) {
  for (const candidate of [mod?.default, mod, mod?.default?.default]) {
    if (candidate && typeof candidate.createPlayer === 'function') return candidate;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------
// Player
// ---------------------------------------------------------------------------------------------------------

/**
 * Stream player bound to one <video> element.
 *
 * Events (CustomEvent, read `e.detail`):
 *  'statechange' {state, prev, reason?}  'error' {error}  'reconnecting' {attempt, max, delayMs, reason, code}
 *  'levels' {levels, current}  'levelswitch' {level, auto, label}  'audiotracks' {tracks, current}
 *  'engine' {engine}  'autoplaymuted' {}  'live' {isLive}  'recovered' {}
 *
 * 'error' is emitted with `error.fatal === true` when the player enters ERROR. The only non-fatal 'error' is
 * OFFLINE: the state becomes RECONNECTING (reason 'offline') and playback resumes on the 'online' event.
 * `statechange.reason` is 'autoplay-blocked' | 'ended' | 'offline' when relevant.
 */
export class Player extends EventTarget {
  #video;
  #opts;
  #destroyed = false;
  #state = S.IDLE;
  #error = null;
  #engine = null;
  /** Incremented on every teardown; async work captures it and bails out when it changed. */
  #token = 0;
  /** Current source (one load() call): { url, name, drm, playUrl, upgraded, type, sniffed, chain, index,
   *  failures, everPlayed, wantPlay, engineType }. */
  #session = null;
  /** Current engine run (one engine instance on one URL). */
  #run = null;
  #attempt = 0;
  #lastGoodEngine = null;
  #resumeAt = null;
  #recovering = false;
  #offlineWait = false;
  #reconnectTimer = 0;
  #sniffAbort = null;
  #isLive = null;
  #levels = [];
  #manualLevel = -1;
  #playingLevel = -1;
  #audioTracks = [];
  #currentAudio = -1;
  #cleanup = [];

  /**
   * @param {HTMLVideoElement} video
   * @param {Partial<typeof DEFAULT_PLAYER_OPTIONS>} [options]
   */
  constructor(video, options = {}) {
    super();
    if (!video || typeof video.addEventListener !== 'function') {
      throw new TypeError('Player requires an HTMLVideoElement');
    }
    this.#video = video;
    this.#opts = normalizeOptions({ ...DEFAULT_PLAYER_OPTIONS, ...options });

    const onVideo = (type, fn) => {
      video.addEventListener(type, fn);
      this.#cleanup.push(() => video.removeEventListener(type, fn));
    };
    onVideo('playing', () => this.#onPlaying());
    onVideo('play', () => this.#onPlay());
    onVideo('pause', () => this.#onPause());
    onVideo('waiting', () => this.#onWaiting(false));
    onVideo('stalled', () => this.#onWaiting(true));
    onVideo('timeupdate', () => this.#onTimeUpdate());
    onVideo('loadedmetadata', () => this.#onMetadata());
    onVideo('durationchange', () => this.#onMetadata());
    onVideo('loadeddata', () => this.#onLoadedData());
    onVideo('ended', () => this.#onEnded());
    onVideo('error', () => this.#onVideoError());

    const win = typeof window !== 'undefined' && window && typeof window.addEventListener === 'function'
      ? window
      : null;
    if (win) {
      const onOffline = () => this.#onOffline();
      const onOnline = () => this.#onOnline();
      win.addEventListener('offline', onOffline);
      win.addEventListener('online', onOnline);
      this.#cleanup.push(() => win.removeEventListener('offline', onOffline));
      this.#cleanup.push(() => win.removeEventListener('online', onOnline));
    }
  }

  // ------------------------------------------------------------------------------------------- public API

  /** Merge new options. `lowLatency` applies to the running hls.js instance; others from the next load. */
  setOptions(partial = {}) {
    if (!partial || typeof partial !== 'object') return;
    this.#opts = normalizeOptions({ ...this.#opts, ...partial });
    const hls = this.#run?.hls;
    if (hls && 'lowLatency' in partial) attempt(() => { hls.lowLatencyMode = !!this.#opts.lowLatency; });
  }

  /** Current options (copy). */
  get options() {
    return { ...this.#opts };
  }

  /**
   * Load and (when `autoplay`) start a stream. Cancels any in-flight load. Never rejects.
   * @param {{ url: string, name?: string, drm?: boolean }} source
   */
  async load(source = {}) {
    if (this.#destroyed) return;
    const { url, name = '', drm = false } = source || {};
    this.#teardown();
    this.#session = null;
    this.#attempt = 0;
    this.#resumeAt = null;
    this.#lastGoodEngine = null;
    this.#manualLevel = -1;
    await this.#begin({ url, name, drm });
  }

  /** Start/resume playback. Never rejects. In ERROR it retries; while reconnecting it skips the wait. */
  play() {
    if (this.#destroyed || !this.#session) return Promise.resolve();
    this.#session.wantPlay = true;
    if (this.#state === S.ERROR) {
      this.retry();
      return Promise.resolve();
    }
    if (this.#state === S.RECONNECTING) {
      if (!this.#offlineWait && this.#reconnectTimer) this.#reconnectNow();
      return Promise.resolve();
    }
    const run = this.#run;
    if (!run) return Promise.resolve();
    return safePlay(this.#video).then(
      () => {},
      (err) => {
        if (run.token !== this.#token) return;
        if (err?.name === 'NotAllowedError') this.#setState(S.PAUSED, { reason: 'autoplay-blocked' });
      },
    );
  }

  pause() {
    const run = this.#run;
    if (this.#session) this.#session.wantPlay = false;
    if (!run) return;
    attempt(() => this.#video.pause());
    if (this.#state === S.PLAYING || this.#state === S.BUFFERING || this.#state === S.LOADING) {
      this.#setState(S.PAUSED);
    }
  }

  togglePlay() {
    const v = this.#video;
    if (v.paused || this.#state === S.PAUSED || this.#state === S.ERROR || this.#state === S.RECONNECTING) {
      return this.play();
    }
    this.pause();
    return Promise.resolve();
  }

  /** Tear down engines, clear the source and return to IDLE. */
  stop() {
    if (this.#destroyed) return;
    this.#teardown();
    this.#session = null;
    this.#attempt = 0;
    this.#error = null;
    this.#resumeAt = null;
    this.#recovering = false;
    this.#offlineWait = false;
    this.#lastGoodEngine = null;
    this.#manualLevel = -1;
    this.#setLive(null);
    this.#setEngine(null);
    this.#setState(S.IDLE);
  }

  /** Manual retry: reset the attempt counter and reload the current source immediately. */
  retry() {
    if (this.#destroyed || !this.#session) return;
    const { url, name, drm } = this.#session;
    this.#captureResume();
    const resumeAt = this.#resumeAt;
    this.#teardown();
    this.#attempt = 0;
    this.#resumeAt = resumeAt;
    this.#begin({ url, name, drm });
  }

  /** Seek relative to the current position (VOD or DVR window only). */
  seekBy(seconds) {
    const s = Number(seconds);
    if (!this.#run || !Number.isFinite(s) || s === 0 || !this.canSeek) return;
    const v = this.#video;
    const ranges = attempt(() => v.seekable);
    let min = 0;
    let max = v.duration;
    if (ranges && ranges.length) {
      min = ranges.start(0);
      max = ranges.end(ranges.length - 1);
    }
    if (this.#isLive) max -= 1;
    else if (Number.isFinite(v.duration)) max = Math.min(max, v.duration - 0.1);
    if (!Number.isFinite(max)) return;
    const target = Math.min(Math.max(min, v.currentTime + s), Math.max(min, max));
    attempt(() => { v.currentTime = target; });
  }

  /** Jump to the live edge (hls.liveSyncPosition, else seekable end − 2 s) and resume playback. */
  goLive() {
    const run = this.#run;
    if (!run || this.#isLive !== true) return;
    const v = this.#video;
    let target = NaN;
    const sync = run.hls ? attempt(() => run.hls.liveSyncPosition, null) : null;
    if (Number.isFinite(sync)) target = sync;
    if (!Number.isFinite(target)) {
      const r = attempt(() => v.seekable);
      if (r && r.length) target = Math.max(r.start(r.length - 1), r.end(r.length - 1) - 2);
    }
    if (!Number.isFinite(target)) {
      const b = attempt(() => v.buffered);
      if (b && b.length) target = Math.max(b.start(b.length - 1), b.end(b.length - 1) - 1);
    }
    if (Number.isFinite(target)) attempt(() => { v.currentTime = target; });
    if (v.paused) this.play();
  }

  get state() {
    return this.#state;
  }

  /** null | { code, message, detail?, status?, technical?, fatal } */
  get error() {
    return this.#error;
  }

  /** 'hls.js' | 'native' | 'mpegts.js' | null */
  get engine() {
    return this.#engine;
  }

  get video() {
    return this.#video;
  }

  /** The current source as requested ({ url, name }) or null. */
  get source() {
    return this.#session ? { url: this.#session.url, name: this.#session.name } : null;
  }

  /** URL actually being played (may be the https-upgraded variant). */
  get url() {
    return this.#run?.url || this.#session?.playUrl || '';
  }

  get isLive() {
    return this.#isLive === true;
  }

  /** VOD with a finite duration, or a live stream with a DVR window longer than 60 s. */
  get canSeek() {
    if (!this.#run) return false;
    const v = this.#video;
    if (this.#isLive === false) {
      const d = v.duration;
      return Number.isFinite(d) && d > 0;
    }
    if (this.#isLive === true) {
      const r = attempt(() => v.seekable);
      if (r && r.length) return r.end(r.length - 1) - r.start(0) > 60;
    }
    return false;
  }

  /** True when a live stream is noticeably behind its live edge (UI: dimmed "Go live" badge). */
  get isBehindLive() {
    const run = this.#run;
    if (!run || this.#isLive !== true) return false;
    const v = this.#video;
    const t = v.currentTime;
    if (run.hls) {
      const sync = attempt(() => run.hls.liveSyncPosition, null);
      if (Number.isFinite(sync)) return sync - t > 8;
    }
    if (run.engine === Engine.MPEGTS) return lastRangeEnd(attempt(() => v.buffered)) - t > 10;
    const end = lastRangeEnd(attempt(() => v.seekable));
    return Number.isFinite(end) && end - t > 40;
  }

  /** [{ index, height, width, bitrate, label, detail }] sorted high→low (hls.js only). */
  get levels() {
    return this.#levels;
  }

  /** Selected level index (-1 = auto). */
  get currentLevel() {
    return this.#manualLevel;
  }

  /** true when adaptive (auto) quality selection is active. */
  get autoLevel() {
    return this.#manualLevel === -1;
  }

  /** Index of the level actually playing (-1 = unknown). */
  get playingLevel() {
    return this.#playingLevel;
  }

  /** Label of the level actually playing, e.g. '720p' ('' when unknown). */
  get playingLevelLabel() {
    const raw = this.#run?.hls ? attempt(() => this.#run.hls.levels, [])?.[this.#playingLevel] : null;
    return raw ? levelLabel({ ...raw, index: this.#playingLevel }) : '';
  }

  /** Select a quality level by hls.js index; -1 = auto. Switches immediately. */
  setLevel(index) {
    const hls = this.#run?.hls;
    if (!hls) return;
    const n = Number(index);
    const count = attempt(() => hls.levels?.length, 0) || 0;
    if (!Number.isInteger(n) || n < 0) {
      this.#manualLevel = -1;
      attempt(() => { hls.currentLevel = -1; });
    } else if (n < count) {
      this.#manualLevel = n;
      attempt(() => { hls.currentLevel = n; });
    } else {
      return;
    }
    this.#emit('levels', { levels: this.#levels, current: this.#manualLevel });
  }

  /** [{ index, label, lang }] */
  get audioTracks() {
    return this.#audioTracks;
  }

  get currentAudioTrack() {
    return this.#currentAudio;
  }

  setAudioTrack(index) {
    const run = this.#run;
    const n = Number(index);
    if (!run || !Number.isInteger(n) || n < 0 || n >= this.#audioTracks.length) return;
    if (run.hls) {
      attempt(() => { run.hls.audioTrack = n; });
    } else {
      const list = attempt(() => this.#video.audioTracks);
      for (let i = 0; list && i < list.length; i++) attempt(() => { list[i].enabled = i === n; });
    }
    this.#currentAudio = n;
    this.#emit('audiotracks', { tracks: this.#audioTracks, current: n });
  }

  /** Current reconnect attempt (0 when healthy). */
  get attempt() {
    return this.#attempt;
  }

  /** Snapshot for the stats overlay. Sizes in px, bitrate/bandwidth in bps, times in seconds. */
  getStats() {
    const v = this.#video;
    const run = this.#run;
    const quality = typeof v.getVideoPlaybackQuality === 'function' ? attempt(() => v.getVideoPlaybackQuality())
      : null;
    let droppedFrames = quality?.droppedVideoFrames ?? v.webkitDroppedFrameCount ?? 0;
    let totalFrames = quality?.totalVideoFrames ?? v.webkitDecodedFrameCount ?? 0;
    if (!totalFrames && run?.mpegtsStats) {
      droppedFrames = run.mpegtsStats.droppedFrames || 0;
      totalFrames = run.mpegtsStats.decodedFrames || 0;
    }
    let bitrate = 0;
    let bandwidth = 0;
    let level = '';
    let latency = null;
    const live = this.#isLive === true;
    if (run?.hls) {
      const hls = run.hls;
      const idx = attempt(() => hls.currentLevel, -1);
      const raw = attempt(() => hls.levels, [])?.[idx];
      if (raw) {
        bitrate = raw.bitrate || 0;
        // A plain media playlist has neither RESOLUTION nor BANDWIDTH: use the decoded height below instead
        // of a meaningless "Level 1".
        if ((raw.height | 0) > 0 || bitrate > 0) level = levelLabel({ ...raw, index: idx });
      }
      const estimate = attempt(() => hls.bandwidthEstimate, NaN);
      if (Number.isFinite(estimate)) bandwidth = estimate;
      if (live) {
        const l = attempt(() => hls.latency, 0);
        latency = Number.isFinite(l) && l > 0 ? l : null;
      }
    } else if (run?.engine === Engine.MPEGTS) {
      const info = run.mediaInfo;
      const rate = (Number(info?.videoDataRate) || 0) + (Number(info?.audioDataRate) || 0);
      if (rate > 0) bitrate = rate * 1000;
      const speed = Number(run.mpegtsStats?.speed) || 0; // KB/s
      if (speed > 0) bandwidth = speed * 1024 * 8;
      const end = lastRangeEnd(attempt(() => v.buffered));
      if (Number.isFinite(end)) latency = Math.max(0, end - v.currentTime);
    }
    if (latency === null && live && !run?.hls) {
      const end = lastRangeEnd(attempt(() => v.seekable));
      if (Number.isFinite(end)) latency = Math.max(0, end - v.currentTime);
    }
    const width = v.videoWidth || run?.mediaInfo?.width || 0;
    const height = v.videoHeight || run?.mediaInfo?.height || 0;
    if (!level && height) level = `${height}p`;
    return {
      engine: this.#engine,
      url: this.url,
      type: this.#session?.engineType || null,
      width,
      height,
      bitrate,
      bandwidth,
      bufferAhead: Math.round(bufferAhead(v) * 100) / 100,
      latency: latency === null ? null : Math.round(latency * 100) / 100,
      droppedFrames,
      totalFrames,
      level,
      isLive: live,
      state: this.#state,
      attempt: this.#attempt,
      stalls: run?.stalls || 0,
    };
  }

  /** Stop everything and remove all listeners. Idempotent; the instance is unusable afterwards. */
  destroy() {
    if (this.#destroyed) return;
    this.#destroyed = true; // silences events emitted during teardown
    this.#teardown();
    this.#session = null;
    for (const off of this.#cleanup.splice(0)) attempt(off);
    this.#state = S.IDLE;
    this.#engine = null;
    this.#error = null;
  }

  get destroyed() {
    return this.#destroyed;
  }

  // ------------------------------------------------------------------------------------------ load pipeline

  /** Validate a source, set up the session and start the first cycle. */
  async #begin({ url, name, drm }) {
    try {
      const raw = String(url ?? '').trim();
      const session = {
        url: raw,
        name: String(name || ''),
        drm: !!drm,
        playUrl: raw,
        upgraded: false,
        type: 'unknown',
        sniffed: undefined,
        engineType: null,
        chain: [],
        index: 0,
        failures: [],
        everPlayed: false,
        wantPlay: !!this.#opts.autoplay,
      };
      this.#session = session;
      this.#error = null;
      this.#recovering = false;
      this.#offlineWait = false;
      this.#setEngine(null);
      this.#setLive(null);

      if (!raw) return this.#fail(failure(E.UNSUPPORTED, MSG.noUrl, { reason: 'no-url' }));
      if (session.drm) return this.#fail(failure(E.DRM, MSG.drm, { detail: MSG.drmDetail, reason: 'drm' }));
      const type = detectStreamType(raw);
      if (type === 'unsupported') return this.#fail(protocolFailure(raw));
      if (type === 'dash') return this.#fail(failure(E.UNSUPPORTED, MSG.dash, { detail: MSG.dashDetail,
        reason: 'dash' }));
      if (!tryParseUrl(raw)) return this.#fail(failure(E.UNSUPPORTED, MSG.badUrl, { reason: 'bad-url' }));
      session.type = type;

      const pageProtocol = this.#opts.pageProtocol ?? globalThis.location?.protocol;
      if (isMixedContent(raw, pageProtocol)) {
        if (!this.#opts.upgradeInsecure) return this.#fail(mixedContentFailure(false));
        session.playUrl = upgradeToHttps(raw);
        session.upgraded = true;
      }
      await this.#startCycle();
    } catch (err) {
      this.#fail(failure(E.UNKNOWN, MSG.unknown, { technical: String(err?.message || err) }));
    }
  }

  /** One pass over the engine chain (initial load, reconnect, back online). Never rejects. */
  async #startCycle() {
    try {
      await this.#runCycle();
    } catch (err) {
      if (this.#session && !this.#destroyed) {
        this.#fail(failure(E.UNKNOWN, MSG.unknown, { technical: String(err?.message || err) }));
      }
    }
  }

  async #runCycle() {
    this.#teardown();
    const session = this.#session;
    if (!session || this.#destroyed) return;
    const token = this.#token;
    session.failures = [];
    if (!this.#isOnline()) {
      this.#enterOfflineWait();
      return;
    }
    this.#setState(S.LOADING);

    let type = session.type;
    if (type === 'unknown') {
      if (session.sniffed === undefined) {
        let sniffed = null;
        if (this.#opts.sniff) {
          const controller = new AbortController();
          this.#sniffAbort = controller;
          sniffed = await sniffStreamType(session.playUrl, {
            signal: controller.signal,
            timeoutMs: this.#opts.sniffTimeoutMs,
          });
          if (token !== this.#token || session !== this.#session) return;
          this.#sniffAbort = null;
        }
        session.sniffed = sniffed;
      }
      type = session.sniffed || 'unknown';
    }
    session.engineType = type;

    // hls.js is only fetched for streams it might play. A failed load leaves the native player (if any).
    let hlsOk = false;
    let hlsError = null;
    if (type === 'hls' || type === 'unknown') {
      try {
        const HlsCtor = Hls || (await withTimeout(loadHls(), this.#opts.loadTimeoutMs, 'hls.js load timed out'));
        hlsOk = !!attempt(() => HlsCtor.isSupported(), false);
      } catch (err) {
        hlsError = err;
      }
      if (token !== this.#token || session !== this.#session) return;
    }

    const chain = this.#buildChain(type, hlsOk);
    if (!chain.length && hlsError) {
      const f = failure(E.UNKNOWN, 'Couldn’t load the HLS player.', {
        detail: 'Check your connection and try again.', technical: String(hlsError?.message || hlsError),
        retryable: true, maxRetries: LIMITED_RETRIES, reason: 'hls-load',
      });
      if (this.#opts.autoReconnect) this.#scheduleReconnect(f);
      else this.#fail(f);
      return;
    }
    if (!chain.length) {
      const f = type === 'hls'
        ? failure(E.UNSUPPORTED, MSG.noHls, { detail: MSG.noHlsDetail, reason: 'no-engine' })
        : failure(E.UNSUPPORTED, MSG.noEngine, { detail: MSG.formatDetail, reason: 'no-engine' });
      this.#fail(f);
      return;
    }
    const preferred = this.#lastGoodEngine;
    if (preferred && chain.includes(preferred)) {
      chain.splice(chain.indexOf(preferred), 1);
      chain.unshift(preferred);
    }
    session.chain = chain;
    this.#tryEngine(0);
  }

  #buildChain(type, hlsOk) {
    const nativeHls = this.#canPlayNativeHls();
    switch (type) {
      case 'hls': {
        if (this.#opts.preferNativeHls && nativeHls) {
          return hlsOk ? [Engine.NATIVE, Engine.HLS] : [Engine.NATIVE];
        }
        const chain = [];
        if (hlsOk) chain.push(Engine.HLS);
        if (nativeHls) chain.push(Engine.NATIVE);
        return chain;
      }
      case 'mpegts':
      case 'flv':
        return [Engine.MPEGTS, Engine.NATIVE];
      case 'native':
        return [Engine.NATIVE];
      default:
        return hlsOk ? [Engine.NATIVE, Engine.HLS, Engine.MPEGTS] : [Engine.NATIVE, Engine.MPEGTS];
    }
  }

  #canPlayNativeHls() {
    const v = this.#video;
    if (typeof v.canPlayType !== 'function') return false;
    return !!attempt(
      () => v.canPlayType('application/vnd.apple.mpegurl') || v.canPlayType('application/x-mpegURL'),
      '',
    );
  }

  #tryEngine(index) {
    const session = this.#session;
    if (!session) return;
    const engine = session.chain[index];
    if (!engine) {
      this.#onCycleFailed(pickBest(session.failures));
      return;
    }
    this.#teardown();
    const token = this.#token;
    session.index = index;
    const run = {
      token,
      engine,
      url: session.playUrl,
      loadingSince: Date.now(),
      firstFrame: false,
      closed: false,
      failed: false,
      impl: null,
      hls: null,
      mpegts: null,
      src: '',
      manifestParsed: false,
      mediaStage: 0,
      lastMediaErrorAt: 0,
      lastMediaHandledAt: 0,
      netRecoverAt: 0,
      autoplayStarted: false,
      resumeApplied: false,
      completed: false,
      mediaInfo: null,
      mpegtsStats: null,
      lastTime: this.#video.currentTime,
      lastProgressAt: Date.now(),
      healthySince: 0,
      stalls: 0,
      watchdog: 0,
      offs: [],
    };
    this.#run = run;
    this.#setEngine(engine);
    if (this.#state !== S.LOADING) this.#setState(S.LOADING);
    run.watchdog = setInterval(() => this.#watchdogTick(run), WATCHDOG_INTERVAL_MS);
    try {
      if (engine === Engine.HLS) this.#startHls(run);
      else if (engine === Engine.NATIVE) this.#startNative(run);
      else {
        this.#startMpegts(run, session.engineType === 'flv' ? 'flv' : 'mpegts').catch((err) => {
          this.#handleFailure(run, failure(E.UNKNOWN, MSG.unknown, {
            technical: String(err?.message || err),
            retryable: true,
            maxRetries: LIMITED_RETRIES,
            nextEngine: true,
          }));
        });
      }
    } catch (err) {
      this.#handleFailure(run, failure(E.UNKNOWN, MSG.unknown, {
        technical: `${engine}: ${err?.message || err}`, retryable: true, maxRetries: LIMITED_RETRIES,
        nextEngine: true,
      }));
    }
  }

  /** Release the current engine, timers, pending sniff and reconnect; reset the media element. */
  #teardown() {
    this.#token += 1;
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = 0;
    }
    if (this.#sniffAbort) {
      attempt(() => this.#sniffAbort.abort());
      this.#sniffAbort = null;
    }
    const run = this.#run;
    this.#run = null;
    const v = this.#video;
    if (run) {
      run.closed = true;
      clearInterval(run.watchdog);
      for (const off of run.offs.splice(0)) attempt(off);
      if (run.impl) attempt(() => run.impl.destroy());
    }
    if (run || attempt(() => v.hasAttribute('src'), false)) {
      attempt(() => {
        v.removeAttribute('src');
        v.load();
      });
    }
    this.#resetTracks();
  }

  /** True when `run` is the live run and still accepting events. */
  #isCurrent(run) {
    return !!run && run === this.#run && run.token === this.#token && !run.closed && !run.failed;
  }

  // ------------------------------------------------------------------------------------------ engines

  #startHls(run) {
    const hls = new Hls(hlsConfig({ lowLatency: this.#opts.lowLatency, startPosition: this.#resumeAt }));
    run.hls = hls;
    run.impl = { destroy: () => hls.destroy() };
    const Ev = Hls.Events;
    const on = (event, fn) => {
      if (!event) return;
      hls.on(event, (_name, data) => {
        if (this.#isCurrent(run)) fn(data || {});
      });
    };
    on(Ev.ERROR, (data) => this.#onHlsError(run, data));
    on(Ev.MANIFEST_PARSED, () => {
      run.manifestParsed = true;
      this.#updateHlsLevels(run);
      this.#updateHlsAudio(run);
      if (this.#manualLevel >= 0) {
        const count = attempt(() => hls.levels.length, 0);
        if (this.#manualLevel < count) attempt(() => { hls.currentLevel = this.#manualLevel; });
        else this.#manualLevel = -1;
      }
      if (this.#session?.wantPlay) this.#autoplay(run);
    });
    on(Ev.LEVEL_LOADED, (data) => {
      if (data.details && typeof data.details.live === 'boolean') this.#setLive(data.details.live);
    });
    on(Ev.LEVEL_SWITCHED, (data) => {
      const level = Number.isInteger(data.level) ? data.level : -1;
      this.#playingLevel = level;
      this.#emit('levelswitch', { level, auto: this.#manualLevel === -1, label: this.playingLevelLabel });
    });
    on(Ev.LEVELS_UPDATED, () => this.#updateHlsLevels(run));
    on(Ev.AUDIO_TRACKS_UPDATED, () => this.#updateHlsAudio(run));
    on(Ev.AUDIO_TRACK_SWITCHED, () => this.#updateHlsAudio(run));
    hls.attachMedia(this.#video);
    hls.loadSource(run.url);
  }

  #updateHlsLevels(run) {
    const raw = attempt(() => run.hls.levels, []) || [];
    this.#levels = buildLevelList(raw);
    if (this.#manualLevel >= raw.length) this.#manualLevel = -1;
    this.#emit('levels', { levels: this.#levels, current: this.#manualLevel });
  }

  #updateHlsAudio(run) {
    const raw = attempt(() => run.hls.audioTracks, []) || [];
    this.#audioTracks = raw.map((t, i) => ({
      index: i,
      label: trackLabel(t?.name, t?.lang, i),
      lang: t?.lang || '',
    }));
    const current = attempt(() => run.hls.audioTrack, -1);
    this.#currentAudio = Number.isInteger(current) ? current : -1;
    this.#emit('audiotracks', { tracks: this.#audioTracks, current: this.#currentAudio });
  }

  #onHlsError(run, data) {
    const T = Hls.ErrorTypes;
    const D = Hls.ErrorDetails;
    const details = String(data.details || '');
    if (!data.fatal) {
      if (details === D.BUFFER_STALLED_ERROR) {
        run.stalls += 1;
        if (run.firstFrame && this.#state === S.PLAYING) this.#setState(S.BUFFERING);
      }
      return; // hls.js recovers from non-fatal errors on its own
    }
    if (data.type === T.KEY_SYSTEM_ERROR || details.startsWith('keySystem')) {
      this.#handleFailure(run, failure(E.DRM, MSG.drm, { detail: MSG.drmDetail, technical: `hls.js: ${details}`,
        reason: 'drm' }));
      return;
    }
    if (data.type === T.NETWORK_ERROR) {
      this.#onHlsNetworkError(run, data, details);
      return;
    }
    if (data.type === T.MEDIA_ERROR) {
      this.#onHlsMediaError(run, details);
      return;
    }
    // MUX_ERROR / OTHER_ERROR (internal exceptions, attach failures): full reload.
    this.#handleFailure(run, failure(E.MEDIA, MSG.media, {
      detail: MSG.mediaDetail, technical: `hls.js: ${details}`, retryable: true, maxRetries: LIMITED_RETRIES,
      nextEngine: true,
    }));
  }

  #onHlsNetworkError(run, data, details) {
    const D = Hls.ErrorDetails;
    const status = Number(data.response?.code ?? data.networkDetails?.status ?? NaN);
    const timeout = /timeout/i.test(details);
    const loadError = /LoadError$/.test(details); // manifest/level/frag/key/audioTrack load errors
    const technical = `hls.js: ${details}${Number.isFinite(status) ? ` (status ${status})` : ''}`;

    if (details === D.MANIFEST_PARSING_ERROR || details === D.LEVEL_PARSING_ERROR) {
      this.#handleFailure(run, failure(E.MANIFEST, MSG.manifest, {
        detail: MSG.manifestDetail, technical, retryable: true, maxRetries: LIMITED_RETRIES, nextEngine: true,
      }));
      return;
    }
    if (status >= 400) {
      // 401/403 may be an Origin/Referer check that the native player (no CORS request) passes.
      const nextEngine = status === 401 || status === 403;
      this.#handleFailure(run, httpFailure(status, { technical, nextEngine }));
      return;
    }
    if (loadError && !(status > 0) && !run.firstFrame && !this.#session?.everPlayed) {
      // Status 0 before playback: CORS rejection or unreachable host. Native playback doesn't need CORS.
      // (A stream that already played passed CORS: then the server is just unreachable — keep reconnecting.)
      this.#handleFailure(run, corsFailure(technical));
      return;
    }
    if (run.manifestParsed && !run.netRecoverAt) {
      run.netRecoverAt = Date.now();
      try {
        run.hls.startLoad();
        return;
      } catch {
        /* fall through to a full reload */
      }
    }
    this.#handleFailure(run, timeout ? this.#timeoutFailure(MSG.serverTimeout, technical)
      : networkFailure(MSG.network, 'network', technical));
  }

  #onHlsMediaError(run, details) {
    const D = Hls.ErrorDetails;
    const technical = `hls.js: ${details}`;
    if (details === D.MANIFEST_INCOMPATIBLE_CODECS_ERROR || details === D.BUFFER_INCOMPATIBLE_CODECS_ERROR ||
      (details === D.BUFFER_ADD_CODEC_ERROR && !run.firstFrame)) {
      this.#handleFailure(run, codecFailure(technical));
      return;
    }
    const now = Date.now();
    // The media element's 'error' and hls.js's fatal error often report the same problem back to back.
    if (now - run.lastMediaHandledAt < 300) return;
    run.lastMediaHandledAt = now;
    if (now - run.lastMediaErrorAt > MEDIA_RECOVERY_WINDOW_MS) run.mediaStage = 0;
    run.lastMediaErrorAt = now;
    try {
      if (run.mediaStage === 0) {
        run.mediaStage = 1;
        run.hls.recoverMediaError();
        return;
      }
      if (run.mediaStage === 1) {
        run.mediaStage = 2;
        run.hls.swapAudioCodec();
        run.hls.recoverMediaError();
        return;
      }
    } catch {
      /* fall through to a full reload */
    }
    this.#handleFailure(run, mediaFailure(technical));
  }

  #startNative(run) {
    const v = this.#video;
    run.src = run.url;
    v.src = run.url;
    this.#bindNativeAudioTracks(run);
    this.#onMetadata();
    if (this.#session?.wantPlay) this.#autoplay(run);
  }

  #bindNativeAudioTracks(run) {
    const list = attempt(() => this.#video.audioTracks);
    if (!list || typeof list.addEventListener !== 'function') return;
    const update = () => {
      if (!this.#isCurrent(run)) return;
      const tracks = [];
      let current = -1;
      for (let i = 0; i < list.length; i++) {
        const t = list[i];
        tracks.push({ index: i, label: trackLabel(t?.label, t?.language, i), lang: t?.language || '' });
        if (t?.enabled && current === -1) current = i;
      }
      this.#audioTracks = tracks;
      this.#currentAudio = current;
      this.#emit('audiotracks', { tracks, current });
    };
    for (const type of ['addtrack', 'removetrack', 'change']) {
      list.addEventListener(type, update);
      run.offs.push(() => list.removeEventListener(type, update));
    }
  }

  async #startMpegts(run, type) {
    let mpegts = null;
    try {
      mpegts = resolveMpegts(await import('mpegts.js'));
    } catch (err) {
      if (!this.#isCurrent(run)) return;
      this.#handleFailure(run, failure(E.UNKNOWN, 'Couldn’t load the MPEG-TS player.', {
        detail: 'Check your connection and try again.', technical: String(err?.message || err), retryable: true,
        maxRetries: LIMITED_RETRIES, nextEngine: true,
      }));
      return;
    }
    if (!this.#isCurrent(run)) return;
    const features = mpegts ? attempt(() => mpegts.getFeatureList(), null) : null;
    if (!mpegts || !features?.mseLivePlayback) {
      this.#handleFailure(run, failure(E.UNSUPPORTED, MSG.noMse, { detail: MSG.formatDetail,
        technical: 'mpegts.js: mseLivePlayback unavailable', nextEngine: true, rank: RANK.FORMAT,
        reason: 'no-engine' }));
      return;
    }
    const player = mpegts.createPlayer({ type, isLive: true, url: run.url }, { ...MPEGTS_CONFIG });
    run.mpegts = player;
    run.impl = {
      destroy() {
        attempt(() => player.pause());
        attempt(() => player.unload());
        attempt(() => player.detachMediaElement());
        attempt(() => player.destroy());
      },
    };
    const Ev = mpegts.Events || {};
    const on = (event, fn) => {
      if (!event) return;
      player.on(event, (...args) => {
        if (this.#isCurrent(run)) fn(...args);
      });
    };
    on(Ev.ERROR, (errType, errDetail, info) => this.#onMpegtsError(run, mpegts, errType, errDetail, info));
    on(Ev.MEDIA_INFO, (info) => { run.mediaInfo = info || null; });
    on(Ev.STATISTICS_INFO, (stats) => { run.mpegtsStats = stats || null; });
    on(Ev.LOADING_COMPLETE, () => { run.completed = true; });
    player.attachMediaElement(this.#video);
    player.load();
    this.#setLive(true);
    if (this.#session?.wantPlay) this.#autoplay(run);
  }

  #onMpegtsError(run, mpegts, errType, errDetail, info) {
    const T = mpegts.ErrorTypes || {};
    const D = mpegts.ErrorDetails || {};
    const status = Number(info?.code);
    const technical = `mpegts.js: ${errType}/${errDetail}${info?.msg ? ` — ${info.msg}` : ''}`;
    if (errType === T.NETWORK_ERROR) {
      if (errDetail === D.NETWORK_STATUS_CODE_INVALID && status >= 400) {
        const nextEngine = status === 401 || status === 403;
        this.#handleFailure(run, httpFailure(status, { technical, nextEngine }));
      } else if (errDetail === D.NETWORK_EXCEPTION && !run.firstFrame && !this.#session?.everPlayed) {
        this.#handleFailure(run, corsFailure(technical));
      } else {
        const timeout = errDetail === D.NETWORK_TIMEOUT;
        this.#handleFailure(run, timeout ? this.#timeoutFailure(MSG.serverTimeout, technical)
          : networkFailure(MSG.network, 'network', technical));
      }
      return;
    }
    if (errType === T.MEDIA_ERROR) {
      const unsupported = errDetail === D.MEDIA_CODEC_UNSUPPORTED || errDetail === D.MEDIA_FORMAT_UNSUPPORTED;
      if (unsupported && !run.firstFrame) {
        this.#handleFailure(run, errDetail === D.MEDIA_CODEC_UNSUPPORTED ? codecFailure(technical)
          : failure(E.UNSUPPORTED, MSG.format, { detail: MSG.formatDetail, technical, nextEngine: true,
            rank: RANK.FORMAT, reason: 'format' }));
      } else {
        this.#handleFailure(run, mediaFailure(technical));
      }
      return;
    }
    this.#handleFailure(run, failure(E.UNKNOWN, MSG.unknown, { technical, retryable: true,
      maxRetries: LIMITED_RETRIES, nextEngine: true }));
  }

  // ------------------------------------------------------------------------------------------ playback

  #autoplay(run) {
    if (run.autoplayStarted || !this.#isCurrent(run)) return;
    run.autoplayStarted = true;
    const v = this.#video;
    const wasMuted = v.muted;
    safePlay(v).then(
      () => {},
      (err) => {
        if (!this.#isCurrent(run) || err?.name !== 'NotAllowedError') return; // AbortError etc.: ignore
        if (v.muted) {
          this.#autoplayBlocked();
          return;
        }
        attempt(() => { v.muted = true; });
        safePlay(v).then(
          () => {
            if (this.#isCurrent(run)) this.#emit('autoplaymuted', {});
          },
          (err2) => {
            if (!this.#isCurrent(run) || err2?.name === 'AbortError') return;
            attempt(() => { v.muted = wasMuted; });
            this.#autoplayBlocked();
          },
        );
      },
    );
  }

  #autoplayBlocked() {
    if (this.#session) this.#session.wantPlay = false;
    this.#setState(S.PAUSED, { reason: 'autoplay-blocked' });
  }

  #markFirstFrame(run) {
    if (run.firstFrame) return;
    run.firstFrame = true;
    run.lastTime = this.#video.currentTime;
    run.lastProgressAt = Date.now();
    this.#lastGoodEngine = run.engine;
    this.#resumeAt = null;
    if (this.#session) this.#session.everPlayed = true;
  }

  #onPlaying() {
    const run = this.#run;
    if (!this.#isCurrent(run)) return;
    this.#markFirstFrame(run);
    if (this.#session) this.#session.wantPlay = true;
    this.#setState(S.PLAYING);
    if (this.#recovering) {
      this.#recovering = false;
      this.#error = null;
      this.#emit('recovered', {});
    }
  }

  #onPlay() {
    const run = this.#run;
    if (!this.#isCurrent(run) || this.#state !== S.PAUSED) return;
    if (!run.firstFrame) this.#setState(S.LOADING);
    else if (this.#video.readyState < HAVE_FUTURE_DATA) this.#setState(S.BUFFERING);
  }

  #onPause() {
    const run = this.#run;
    if (!this.#isCurrent(run) || !this.#video.paused) return;
    // Before the first frame a pause comes from teardown/engine internals; users pause via pause().
    if (!run.firstFrame) return;
    if (this.#state === S.PLAYING || this.#state === S.BUFFERING || this.#state === S.LOADING) {
      if (this.#session) this.#session.wantPlay = false;
      this.#setState(S.PAUSED);
    }
  }

  #onWaiting(isStalledEvent) {
    const run = this.#run;
    if (!this.#isCurrent(run) || !run.firstFrame || this.#video.paused) return;
    if (isStalledEvent && this.#video.readyState >= HAVE_FUTURE_DATA) return; // spurious 'stalled' with data
    if (this.#state === S.PLAYING) {
      run.stalls += 1;
      this.#setState(S.BUFFERING);
    }
  }

  #onTimeUpdate() {
    const run = this.#run;
    if (!this.#isCurrent(run)) return;
    const v = this.#video;
    const t = v.currentTime;
    if (v.paused || t === run.lastTime) return;
    run.lastTime = t;
    run.lastProgressAt = Date.now();
    if (!run.firstFrame && t > 0 && v.readyState >= HAVE_CURRENT_DATA) this.#markFirstFrame(run);
    if (run.firstFrame && (this.#state === S.BUFFERING || this.#state === S.LOADING) &&
      v.readyState >= HAVE_FUTURE_DATA) {
      this.#onPlaying();
    }
  }

  #onMetadata() {
    const run = this.#run;
    if (!this.#isCurrent(run)) return;
    const v = this.#video;
    const d = v.duration;
    if (run.engine === Engine.NATIVE) {
      if (d === Infinity) this.#setLive(true);
      else if (Number.isFinite(d) && d > 0) this.#setLive(false);
    }
    const canResume = Number.isFinite(this.#resumeAt) && Number.isFinite(d) && d > 0;
    if (canResume && !run.resumeApplied && run.engine !== Engine.HLS) {
      run.resumeApplied = true;
      const target = Math.min(this.#resumeAt, Math.max(0, d - 1));
      attempt(() => { v.currentTime = target; });
    }
  }

  #onLoadedData() {
    const run = this.#run;
    if (!this.#isCurrent(run)) return;
    this.#markFirstFrame(run);
    if (this.#state === S.LOADING && this.#video.paused && !this.#session?.wantPlay) this.#setState(S.PAUSED);
  }

  #onEnded() {
    const run = this.#run;
    if (!this.#isCurrent(run)) return;
    if (this.#isLive === true) {
      this.#handleFailure(run, networkFailure(MSG.ended, 'ended'));
      return;
    }
    if (this.#session) this.#session.wantPlay = false;
    this.#setState(S.PAUSED, { reason: 'ended' });
  }

  #onVideoError() {
    const run = this.#run;
    if (!this.#isCurrent(run)) return;
    const err = attempt(() => this.#video.error);
    if (!err || err.code === MEDIA_ERR_ABORTED) return;
    const technical = `media element: code ${err.code}${err.message ? ` — ${err.message}` : ''}`;
    if (run.engine === Engine.HLS) {
      if (err.code === MEDIA_ERR_SRC_NOT_SUPPORTED && !run.firstFrame) {
        this.#handleFailure(run, codecFailure(technical));
      } else {
        this.#onHlsMediaError(run, 'mediaElementError');
      }
      return;
    }
    if (run.engine === Engine.MPEGTS) {
      const now = Date.now();
      if (now - run.lastMediaHandledAt < 300) return;
      run.lastMediaHandledAt = now;
      this.#handleFailure(run, mediaFailure(technical));
      return;
    }
    // Native: ignore late errors from a previous src.
    if (attempt(() => this.#video.getAttribute('src'), null) !== run.src) return;
    if (err.code === MEDIA_ERR_NETWORK) {
      this.#handleFailure(run, networkFailure(MSG.network, 'network', technical));
    } else if (err.code === MEDIA_ERR_DECODE) {
      this.#handleFailure(run, mediaFailure(technical, !run.firstFrame));
    } else if (err.code === MEDIA_ERR_SRC_NOT_SUPPORTED) {
      if (run.firstFrame || this.#session?.everPlayed) {
        // It played before, so the format is fine: the source went away (browsers report an unreachable
        // source this way too).
        this.#handleFailure(run, networkFailure(MSG.network, 'network', technical));
      } else {
        this.#handleFailure(run, failure(E.UNSUPPORTED, MSG.format, { detail: MSG.formatDetail, technical,
          nextEngine: true, ambiguous: true, rank: RANK.FORMAT, reason: 'format' }));
      }
    } else {
      this.#handleFailure(run, failure(E.UNKNOWN, MSG.unknown, { technical, retryable: true,
        maxRetries: LIMITED_RETRIES, nextEngine: true }));
    }
  }

  #watchdogTick(run) {
    if (!this.#isCurrent(run)) return;
    const v = this.#video;
    const now = Date.now();
    const state = this.#state;
    const t = v.currentTime;

    if (state === S.LOADING && !run.firstFrame) {
      if (now - run.loadingSince >= Math.max(this.#opts.loadTimeoutMs, this.#opts.stallTimeoutMs)) {
        this.#handleFailure(run, this.#timeoutFailure(MSG.timeout));
      }
      return;
    }

    const active = (state === S.PLAYING || state === S.BUFFERING || state === S.LOADING) && !v.paused;
    if (!active) {
      run.lastTime = t;
      run.lastProgressAt = now;
      run.healthySince = 0;
      return;
    }
    if (t !== run.lastTime) {
      run.lastTime = t;
      run.lastProgressAt = now;
    } else if (now - run.lastProgressAt >= this.#opts.stallTimeoutMs) {
      this.#handleFailure(run, networkFailure(MSG.stalled, 'stalled'));
      return;
    }

    // mpegts.js: the server closed a live connection and the buffer has drained.
    if (run.completed && this.#isLive === true && bufferAhead(v) < 0.5 && now - run.lastProgressAt >= 1500) {
      this.#handleFailure(run, networkFailure(MSG.closed, 'closed'));
      return;
    }

    const healthy = state === S.PLAYING && now - run.lastProgressAt < 2500;
    if (!healthy) {
      run.healthySince = 0;
      return;
    }
    if (!run.healthySince) run.healthySince = now;
    else if (now - run.healthySince >= this.#opts.healthyResetMs) {
      if (this.#attempt > 0) this.#attempt = 0;
      run.netRecoverAt = 0; // allow another in-place hls.js startLoad() recovery
    }
  }

  // ------------------------------------------------------------------------------------------ failures

  /** Entry point for every engine failure. Deferred to a microtask so engines are never destroyed
   * re-entrantly from inside their own event handlers. */
  #handleFailure(run, f) {
    if (!this.#isCurrent(run) || this.#destroyed) return;
    run.failed = true;
    queueMicrotask(() => {
      if (this.#run !== run || run.closed || run.token !== this.#token || this.#destroyed) return;
      this.#processFailure(run, f);
    });
  }

  #processFailure(run, f) {
    const session = this.#session;
    if (!session) return;
    session.failures.push(f);
    if (!this.#isOnline()) {
      this.#enterOfflineWait();
      return;
    }
    if (!run.firstFrame && f.nextEngine) {
      if (session.index + 1 < session.chain.length) {
        this.#tryEngine(session.index + 1);
        return;
      }
      this.#onCycleFailed(pickBest(session.failures));
      return;
    }
    this.#onCycleFailed(f);
  }

  /** A timeout. Before the stream ever played in this session it is most likely dead (a server that accepts
   * connections but never answers): retry only a little instead of spinning for minutes. */
  #timeoutFailure(message, technical = '') {
    const f = networkFailure(message, 'timeout', technical);
    if (!this.#session?.everPlayed) f.maxRetries = LIMITED_RETRIES;
    return f;
  }

  #onCycleFailed(cause) {
    const session = this.#session;
    if (!session) return;
    this.#captureResume();
    if (session.upgraded && !session.everPlayed && (NETWORKISH.has(cause.code) || cause.ambiguous)) {
      this.#fail(mixedContentFailure(true, cause.technical || cause.message));
      return;
    }
    if (!cause.retryable || !this.#opts.autoReconnect) {
      this.#fail(cause);
      return;
    }
    this.#scheduleReconnect(cause);
  }

  #scheduleReconnect(cause) {
    const max = Math.max(0, Math.min(this.#opts.maxRetries, cause.maxRetries));
    this.#attempt += 1;
    if (this.#attempt > max) {
      const n = this.#attempt - 1;
      this.#attempt = n;
      const message = n > 0 ? `Couldn’t reconnect after ${n} attempt${n === 1 ? '' : 's'}. ${cause.message}`
        : cause.message;
      this.#fail({ ...cause, message });
      return;
    }
    const delayMs = backoffDelay(this.#attempt);
    this.#teardown();
    this.#recovering = true;
    this.#setState(S.RECONNECTING);
    const { message: reason, code } = cause;
    this.#emit('reconnecting', { attempt: this.#attempt, max, delayMs, reason, code });
    const token = this.#token;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = 0;
      if (token !== this.#token || !this.#session || this.#destroyed) return;
      this.#startCycle();
    }, delayMs);
  }

  #reconnectNow() {
    if (!this.#session || this.#destroyed) return;
    this.#startCycle();
  }

  #fail(cause) {
    this.#teardown();
    this.#setEngine(null);
    this.#recovering = false;
    this.#offlineWait = false;
    this.#error = toPublicError(cause, true);
    this.#setState(S.ERROR);
    this.#emit('error', { error: this.#error });
  }

  /** Remember the VOD position so a reconnect can resume where playback stopped. */
  #captureResume() {
    if (!this.#run || this.#isLive !== false) return;
    const v = this.#video;
    const t = v.currentTime;
    const d = v.duration;
    if (Number.isFinite(t) && t > 1 && (!Number.isFinite(d) || t < d - 1)) this.#resumeAt = t;
  }

  // ------------------------------------------------------------------------------------------ connectivity

  #isOnline() {
    return globalThis.navigator?.onLine !== false;
  }

  #enterOfflineWait() {
    this.#captureResume();
    this.#teardown();
    this.#offlineWait = true;
    this.#recovering = true;
    this.#error = toPublicError(failure(E.OFFLINE, MSG.offline, { reason: 'offline' }), false);
    this.#emit('error', { error: this.#error });
    this.#setState(S.RECONNECTING, { reason: 'offline' });
  }

  #onOffline() {
    if (this.#destroyed || !this.#session || this.#offlineWait) return;
    const s = this.#state;
    if (s === S.LOADING || s === S.PLAYING || s === S.BUFFERING || s === S.RECONNECTING) {
      this.#enterOfflineWait();
    }
  }

  #onOnline() {
    if (this.#destroyed || !this.#session) return;
    if (this.#offlineWait) {
      this.#offlineWait = false;
      this.#startCycle();
    } else if (this.#state === S.RECONNECTING && this.#reconnectTimer) {
      this.#reconnectNow();
    }
  }

  // ------------------------------------------------------------------------------------------ state & events

  #setState(next, extra = {}) {
    if (this.#state === next) return;
    const prev = this.#state;
    this.#state = next;
    if (next === S.LOADING && this.#run) this.#run.loadingSince = Date.now();
    this.#emit('statechange', { state: next, prev, ...extra });
  }

  #setEngine(engine) {
    if (this.#engine === engine) return;
    this.#engine = engine;
    this.#emit('engine', { engine });
  }

  #setLive(value) {
    if (this.#isLive === value) return;
    this.#isLive = value;
    if (value !== null) this.#emit('live', { isLive: value });
  }

  #resetTracks() {
    const hadLevels = this.#levels.length > 0;
    const hadAudio = this.#audioTracks.length > 0;
    this.#levels = [];
    this.#playingLevel = -1;
    this.#audioTracks = [];
    this.#currentAudio = -1;
    if (hadLevels) this.#emit('levels', { levels: [], current: this.#manualLevel });
    if (hadAudio) this.#emit('audiotracks', { tracks: [], current: -1 });
  }

  #emit(type, detail) {
    if (this.#destroyed) return;
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}

function normalizeOptions(o) {
  const num = (value, fallback, min, max) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };
  return {
    ...o,
    autoReconnect: !!o.autoReconnect,
    maxRetries: Math.round(num(o.maxRetries, DEFAULT_PLAYER_OPTIONS.maxRetries, 0, 100)),
    upgradeInsecure: !!o.upgradeInsecure,
    lowLatency: !!o.lowLatency,
    preferNativeHls: !!o.preferNativeHls,
    autoplay: !!o.autoplay,
    sniff: o.sniff !== false,
    stallTimeoutMs: num(o.stallTimeoutMs, DEFAULT_PLAYER_OPTIONS.stallTimeoutMs, 1000, 600000),
    loadTimeoutMs: num(o.loadTimeoutMs, DEFAULT_PLAYER_OPTIONS.loadTimeoutMs, 1000, 600000),
    healthyResetMs: num(o.healthyResetMs, DEFAULT_PLAYER_OPTIONS.healthyResetMs, 0, 600000),
    sniffTimeoutMs: num(o.sniffTimeoutMs, DEFAULT_PLAYER_OPTIONS.sniffTimeoutMs, 500, 60000),
  };
}
