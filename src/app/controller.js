// App controller: owns every state transition (the `actions` API handed to the UI modules), persistence to
// localStorage, playlist ingest/refresh and the start-up flow. UI modules never write to the store directly.

import {
  ACCENTS,
  CATEGORY,
  DEFAULT_SESSION,
  DEFAULT_SETTINGS,
  DEFAULT_THEME,
  KEYS,
  MAX_RECENTS,
  MODES,
  UNCATEGORIZED,
} from './constants.js';
import {
  categoryExists,
  channelToSnapshot,
  isFavorite,
  selectActivePlaylist,
  selectChannelMap,
  selectVisibleChannels,
  snapshotToChannel,
} from './selectors.js';
import { DEMO_M3U, DEMO_PLAYLIST_NAME } from './demo.js';
import { effectiveRelay } from './relay.js';
import { groupChannels, makeChannelId, parseM3U, serializeM3U } from '../lib/m3u.js';
import {
  clearAllData as clearStoredData,
  isStorageAvailable,
  readJSON,
  readPlaylistText,
  removePlaylistText,
  writeJSON,
  writePlaylistText,
} from '../lib/storage.js';
import {
  PlaylistLoadError,
  describeLoadError,
  fetchPlaylist,
  normalizePlaylistUrl,
  readPlaylistFile,
} from '../lib/playlist-loader.js';
import {
  clamp,
  debounce,
  downloadText,
  fileNameFromUrl,
  formatCount,
  isHttpUrl,
  tryParseUrl,
  uid,
} from '../lib/utils.js';
import { applyTheme } from '../ui/theme.js';
import { toast } from '../ui/toast.js';

const SESSION_DEBOUNCE_MS = 400;
const HEALTH_DEBOUNCE_MS = 500;
/** Remembered playback failures (state.health) are dropped after this long: streams come back. */
export const HEALTH_TTL_MS = 12 * 3_600_000;
const MAX_HEALTH_ENTRIES = 1500; // the newest ones are kept
const MAX_HEALTH_CODE = 32;
const MAX_HEALTH_TITLE = 120;
const HEALTH_CLOCK_SKEW_MS = 60_000; // tolerated for entries dated slightly in the future (clock adjustments)
const LANE_ADD = 'add'; // adding a playlist: a newer add supersedes an older one
const LANE_CONTENT = 'content'; // downloading the content of the playlist being shown
const AUTO_REFRESH_DELAY_MS = 4000; // let the first stream start before re-downloading in the background
const HOUR_MS = 3_600_000;
const MAX_NAME_LENGTH = 120;
const MAX_QUERY_LENGTH = 200;
const DIRECT_GROUP = 'Direct';

const SORTS = ['playlist', 'name'];
const GROUP_SORTS = ['name', 'playlist'];
const SOURCE_KINDS = new Set(['url', 'file', 'demo']);
const ACCENT_IDS = new Set(ACCENTS.map((a) => a.id));
const LOAD_ERROR_CODES = new Set([
  'INVALID_URL',
  'MIXED_CONTENT',
  'NETWORK',
  'CORS',
  'HTTP',
  'TIMEOUT',
  'EMPTY',
  'NOT_M3U',
  'TOO_LARGE',
  'ABORTED',
  'FILE_TYPE',
  'READ',
]);

const MSG = {
  empty: 'No channels found in this playlist.',
  notFound: 'That playlist no longer exists.',
  cacheUrl: 'Playlist is too large to cache offline — it will be downloaded again on reload.',
  cacheFile: 'Playlist is too large to save — re-upload it after reloading.',
  cacheUnavailableUrl: 'Browser storage is unavailable, so this playlist will be downloaded again on reload.',
  cacheUnavailableFile:
    'Browser storage is unavailable, so this playlist can’t be saved — re-upload it after reloading.',
  storageWrite: 'Couldn’t save your changes — browser storage is full or unavailable.',
  storageUnavailable:
    'Browser storage is unavailable — playlists and settings won’t be kept after you close this tab.',
  hlsFile: 'This file is a single HLS stream manifest, not a channel list. Add it by its URL instead.',
  refreshFile: 'Playlists loaded from a file can’t be refreshed — upload the file again instead.',
  aborted: 'The download was cancelled.',
  badStreamLink: 'The stream link in the address isn’t a valid http(s) URL.',
  generic: 'Something went wrong. Please try again.',
  channelFailed: 'This channel didn’t play the last time it was tried.',
};

const noop = () => {};
const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const countLabel = (n) => `${formatCount(n)} ${n === 1 ? 'channel' : 'channels'}`;

/** Collapse whitespace and cap the length ('' when not a string). */
function cleanText(value, maxLength) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

/** Collapse whitespace and cap the length of a user/playlist supplied name ('' when not a usable string). */
function cleanName(value) {
  return cleanText(value, MAX_NAME_LENGTH);
}

// ---------------------------------------------------------------------------------------------------------
// Sanitizers for persisted data (storage content may be stale, corrupt or written by another version)

/** Numbers and numeric strings only (`Number(null)`, `Number(true)` and `Number('')` would be 0 / 1). */
const toNumber = (value) =>
  typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;

function coerceSetting(key, value) {
  const fallback = DEFAULT_SETTINGS[key];
  if (key === 'maxRetries') {
    const n = Math.round(toNumber(value));
    return Number.isFinite(n) ? clamp(n, 1, 30) : undefined;
  }
  if (key === 'autoRefreshHours') {
    const n = toNumber(value);
    return Number.isFinite(n) && n >= 0 ? Math.min(n, 24 * 365) : undefined;
  }
  if (key === 'corsProxy') {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed === '' || isHttpUrl(trimmed) ? trimmed : undefined;
  }
  if (typeof fallback === 'boolean') {
    if (typeof value === 'boolean') return value;
    return value === 0 || value === 1 ? value === 1 : undefined;
  }
  if (typeof fallback === 'number') return Number.isFinite(toNumber(value)) ? toNumber(value) : undefined;
  if (typeof fallback === 'string') return typeof value === 'string' ? value : undefined;
  return undefined;
}

/** Settings merged over DEFAULT_SETTINGS; unknown keys dropped, invalid values replaced by defaults. */
export function sanitizeSettings(raw) {
  const settings = { ...DEFAULT_SETTINGS };
  if (!isObject(raw)) return settings;
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (!(key in raw)) continue;
    const value = coerceSetting(key, raw[key]);
    if (value !== undefined) settings[key] = value;
  }
  // Settings from the release before stream relaying have no proxyStreams: their corsProxy was a proxy for
  // playlist downloads only, so it must not start carrying video. (This release always saves proxyStreams.)
  if (settings.corsProxy && !Object.hasOwn(raw, 'proxyStreams')) settings.proxyStreams = false;
  return settings;
}

/** `{ accent, mode }` with unknown values replaced by DEFAULT_THEME. */
export function sanitizeTheme(raw) {
  return {
    accent: isObject(raw) && ACCENT_IDS.has(raw.accent) ? raw.accent : DEFAULT_THEME.accent,
    mode: isObject(raw) && MODES.includes(raw.mode) ? raw.mode : DEFAULT_THEME.mode,
  };
}

/** Session merged over DEFAULT_SESSION with type checks. */
export function sanitizeSession(raw) {
  const session = { ...DEFAULT_SESSION };
  if (!isObject(raw)) return session;
  if (typeof raw.activePlaylistId === 'string' && raw.activePlaylistId) {
    session.activePlaylistId = raw.activePlaylistId;
  }
  if (typeof raw.lastChannelId === 'string' && raw.lastChannelId) session.lastChannelId = raw.lastChannelId;
  if (typeof raw.category === 'string' && raw.category) session.category = raw.category;
  if (SORTS.includes(raw.sort)) session.sort = raw.sort;
  if (GROUP_SORTS.includes(raw.groupSort)) session.groupSort = raw.groupSort;
  if (Number.isFinite(raw.volume)) session.volume = clamp(raw.volume, 0, 1);
  if (typeof raw.muted === 'boolean') session.muted = raw.muted;
  return session;
}

function sanitizeSource(raw) {
  if (!isObject(raw) || !SOURCE_KINDS.has(raw.kind)) return null;
  const source = { kind: raw.kind };
  if (raw.kind === 'url') {
    if (!isHttpUrl(raw.url)) return null;
    source.url = String(raw.url).trim();
  }
  if (typeof raw.fileName === 'string' && raw.fileName.trim()) source.fileName = raw.fileName.trim();
  return source;
}

function sanitizePlaylist(raw) {
  if (!isObject(raw) || typeof raw.id !== 'string' || !raw.id) return null;
  const source = sanitizeSource(raw.source);
  if (!source) return null;
  const count = (v) => (Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
  const now = Date.now();
  const meta = {
    id: raw.id,
    name: cleanName(raw.name) || 'Playlist',
    source,
    channelCount: count(raw.channelCount),
    groupCount: count(raw.groupCount),
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : now,
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0,
    cached: raw.cached !== false,
  };
  if (typeof raw.epgUrl === 'string' && raw.epgUrl) meta.epgUrl = raw.epgUrl;
  return meta;
}

function sanitizePlaylists(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const meta = sanitizePlaylist(item);
    if (!meta || seen.has(meta.id)) continue;
    seen.add(meta.id);
    out.push(meta);
  }
  return out;
}

const SNAPSHOT_HEADERS = ['userAgent', 'referrer', 'origin'];
const MAX_SNAPSHOT_GROUPS = 8;

/**
 * One stored favorite/recent snapshot with every field type-checked (the UI calls string methods on names,
 * groups and logos, so a corrupt value must never get through). null when it has no string id + url.
 */
function sanitizeSnapshot(raw) {
  if (!isObject(raw) || typeof raw.id !== 'string' || !raw.id) return null;
  if (typeof raw.url !== 'string' || !raw.url.trim()) return null;
  const text = (value) => (typeof value === 'string' ? value : '');
  const snap = {
    id: raw.id,
    name: text(raw.name),
    url: raw.url.trim(),
    logo: text(raw.logo),
    group: text(raw.group) || UNCATEGORIZED,
    tvgId: text(raw.tvgId),
    playlistId: typeof raw.playlistId === 'string' && raw.playlistId ? raw.playlistId : null,
  };
  if (Array.isArray(raw.groups)) {
    const groups = [...new Set(raw.groups.filter((g) => typeof g === 'string' && g))];
    if (groups.length > 1) snap.groups = groups.slice(0, MAX_SNAPSHOT_GROUPS);
  }
  if (isObject(raw.headers)) {
    const headers = {};
    for (const key of SNAPSHOT_HEADERS) {
      if (typeof raw.headers[key] === 'string' && raw.headers[key]) headers[key] = raw.headers[key];
    }
    if (Object.keys(headers).length) snap.headers = headers;
  }
  if (raw.drm === true) snap.drm = true;
  if (Number.isFinite(raw.addedAt)) snap.addedAt = raw.addedAt;
  if (Number.isFinite(raw.watchedAt)) snap.watchedAt = raw.watchedAt;
  return snap;
}

/** Favorite/recent snapshots: valid entries only (see sanitizeSnapshot), deduped by id (first wins). */
function sanitizeSnapshots(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const snap = sanitizeSnapshot(item);
    if (!snap || seen.has(snap.id)) continue;
    seen.add(snap.id);
    out.push(snap);
  }
  return out;
}

const isFreshHealth = (at, now) =>
  Number.isFinite(at) && now - at <= HEALTH_TTL_MS && at - now <= HEALTH_CLOCK_SKEW_MS;

/** A health map from [channelId, entry] pairs, capped to the newest MAX_HEALTH_ENTRIES (entries as-is). */
function healthFromEntries(entries) {
  if (entries.length > MAX_HEALTH_ENTRIES) {
    entries.sort((a, b) => b[1].at - a[1].at);
    entries.length = MAX_HEALTH_ENTRIES;
  }
  const health = {};
  for (const [id, entry] of entries) health[id] = entry;
  return health;
}

/** Ids usable as health keys: non-empty strings that can't touch the prototype when assigned. */
const isHealthId = (id) => typeof id === 'string' && id !== '' && id !== '__proto__';

/**
 * Stored playback-failure memory `{ [channelId]: { code, title, at } }`: plain object of plain-object
 * entries with a string `code` (≤ 32 chars), string `title` (≤ 120) and finite `at`; anything else, entries
 * older than HEALTH_TTL_MS (or dated more than a minute ahead) and all but the newest 1500 are dropped.
 * @param {unknown} raw
 * @param {number} [now]
 * @returns {Record<string, { code: string, title: string, at: number }>}
 */
export function sanitizeHealth(raw, now = Date.now()) {
  if (!isObject(raw)) return {};
  const entries = [];
  for (const [id, value] of Object.entries(raw)) {
    if (!isHealthId(id) || !isObject(value)) continue;
    const { code, title, at } = value;
    if (typeof code !== 'string' || code.length > MAX_HEALTH_CODE) continue;
    if (typeof title !== 'string' || title.length > MAX_HEALTH_TITLE) continue;
    if (!isFreshHealth(at, now)) continue;
    entries.push([id, { code, title, at }]);
  }
  return healthFromEntries(entries);
}

/**
 * Build the initial app state from localStorage (defaults merged, everything validated). The active
 * playlist's channels are loaded later by `actions.init()`.
 * @returns {object} state for `createStore()`
 */
export function createInitialState() {
  const settings = sanitizeSettings(readJSON(KEYS.settings, null));
  const theme = sanitizeTheme(readJSON(KEYS.theme, null));
  const session = sanitizeSession(readJSON(KEYS.session, null));
  const playlists = sanitizePlaylists(readJSON(KEYS.playlists, null));
  const favorites = sanitizeSnapshots(readJSON(KEYS.favorites, null));
  const recents = sanitizeSnapshots(readJSON(KEYS.recents, null)).slice(0, MAX_RECENTS);
  const health = sanitizeHealth(readJSON(KEYS.health, null));
  const activePlaylistId = playlists.some((p) => p.id === session.activePlaylistId)
    ? session.activePlaylistId
    : (playlists[0]?.id ?? null);
  // Library categories don't depend on the playlist content, so they can be restored right away.
  const libraryCategory = session.category === CATEGORY.favorites || session.category === CATEGORY.recent;
  const category = libraryCategory ? session.category : CATEGORY.all;

  return {
    ready: false,
    busy: null,
    playlists,
    activePlaylistId,
    playlistError: null,
    channels: [],
    groups: [],
    category,
    query: '',
    sort: session.sort,
    groupSort: session.groupSort,
    favorites,
    recents,
    // Recent playback failures { [channelId]: { code, title, at } } (markChannelFailed, selectPlayability).
    health,
    currentChannel: null,
    playRequest: 0,
    // Player state ('idle' | 'loading' | 'playing' | …) published by the player view; never persisted.
    playbackState: 'idle',
    theme,
    settings,
    volume: session.volume,
    muted: session.muted,
    sidebarOpen: false,
  };
}

// ---------------------------------------------------------------------------------------------------------
// Pure helpers

function sameUrl(a, b) {
  const canon = (u) => {
    const parsed = tryParseUrl(u);
    return parsed ? parsed.href.replace(/^https?:/i, '') : String(u || '').trim();
  };
  return canon(a) === canon(b);
}

function findPlaylistByUrl(playlists, url) {
  return playlists.find((p) => p.source.kind === 'url' && sameUrl(p.source.url, url)) || null;
}

function defaultPlaylistName(source, title) {
  if (title) return title;
  if (source.kind === 'demo') return DEMO_PLAYLIST_NAME;
  if (source.kind === 'url') return cleanName(fileNameFromUrl(source.url)) || 'Playlist';
  if (source.fileName) return cleanName(source.fileName.replace(/\.[^./\\]+$/, '')) || 'Playlist';
  return 'Playlist';
}

/** File name for downloads: strips characters that are invalid on common file systems. */
function toFileName(name, fallback = 'playlist') {
  const base = String(name || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 80);
  return `${base || fallback}.m3u`;
}

/** A Channel-shaped object for a single stream URL (HLS manifests added as playlists, `?play=` links). */
function makeStreamChannel(url, name, group = UNCATEGORIZED) {
  return {
    id: makeChannelId(name, url),
    index: 0,
    name,
    url,
    group,
    groups: [group],
    logo: '',
    tvgId: '',
    tvgName: '',
    chno: null,
    duration: -1,
    attrs: {},
    headers: {},
    drm: false,
  };
}

function makeDirectChannel(rawUrl, rawName) {
  const parsed = tryParseUrl(rawUrl);
  if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) return null;
  const url = parsed.href;
  const name = cleanName(rawName) || cleanName(fileNameFromUrl(url)) || 'Stream';
  return { ...makeStreamChannel(url, name, DIRECT_GROUP), index: -1 };
}

/**
 * Parse playlist text for a source. An HLS manifest (one stream's own playlist) becomes a single channel
 * pointing at the source URL; the stored text is then a one-entry M3U so reloads give the same channel id.
 * @returns {{ text: string, channels: object[], groups: object[], title: string, epgUrl: string,
 *   warnings: string[] }}
 */
function parseContent(text, source, name) {
  const baseUrl = source.kind === 'url' ? source.url : undefined;
  const result = parseM3U(text, { baseUrl });
  if (result.meta?.isHlsManifest) {
    if (!source.url) throw new Error(MSG.hlsFile);
    const channelName = cleanName(name) || cleanName(fileNameFromUrl(source.url)) || 'Stream';
    const channel = makeStreamChannel(source.url, channelName);
    return {
      text: serializeM3U([channel], { title: channelName }),
      channels: [channel],
      groups: groupChannels([channel]),
      title: channelName,
      epgUrl: '',
      warnings: [],
    };
  }
  const channels = Array.isArray(result.channels) ? result.channels : [];
  return {
    text,
    channels,
    groups: groupChannels(channels),
    title: cleanName(result.meta?.title),
    epgUrl: typeof result.meta?.epgUrl === 'string' ? result.meta.epgUrl : '',
    warnings: Array.isArray(result.warnings) ? result.warnings : [],
  };
}

/** True when a refreshed channel list renders and plays exactly like the current one. */
function sameChannels(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x.id !== y.id || x.logo !== y.logo || x.chno !== y.chno || x.tvgId !== y.tvgId || x.drm !== y.drm) {
      return false;
    }
    if (x.groups.length !== y.groups.length || x.groups.some((g, j) => g !== y.groups[j])) return false;
  }
  return true;
}

function isAbortError(err) {
  return !!err && (err.code === 'ABORTED' || err.name === 'AbortError');
}

function isLoadError(err) {
  return err instanceof PlaylistLoadError || (!!err && LOAD_ERROR_CODES.has(err.code));
}

/** User-facing sentence for any error thrown while loading playlists. */
function describeError(err) {
  if (isLoadError(err)) {
    try {
      const message = describeLoadError(err);
      if (typeof message === 'string' && message) return message;
    } catch {
      /* fall back to the raw message */
    }
  }
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === 'string' && err) return err;
  return MSG.generic;
}

/** The same error with a user-friendly `message` (wrapped when the original can't be modified). */
function friendlyError(err) {
  const message = describeError(err);
  if (err instanceof Error) {
    if (err.message === message) return err;
    try {
      err.message = message;
      if (err.message === message) return err;
    } catch {
      /* frozen or read-only — wrap below */
    }
    const wrapped = new Error(message, { cause: err });
    if (err.code) wrapped.code = err.code;
    return wrapped;
  }
  return new Error(message);
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw new PlaylistLoadError('ABORTED', MSG.aborted);
}

// ---------------------------------------------------------------------------------------------------------
// Controller

/**
 * Create the `actions` API (spec §2) bound to `store`, and install persistence (immediate writes for
 * settings/theme/favorites/recents/playlists, debounced session/health + pagehide flush, cross-tab sync).
 * Call `actions.init()` (or `initApp(store, actions)`) once the UI is mounted.
 * @param {ReturnType<import('./store.js').createStore>} store
 */
export function createController(store) {
  let disposed = false; // set by clearAllData()/destroy(): nothing is persisted afterwards
  let applyingRemote = false; // true while applying another tab's change (don't write it back)
  let storageWarned = false;
  let intentSeq = 0; // bumped by every "show this playlist" intent; stale loads don't activate
  const busyStack = []; // messages of the running tasks; the newest one is shown
  const lanes = new Map(); // lane -> AbortController of its in-flight task (a new task supersedes it)
  const tasks = new Set(); // AbortControllers of every in-flight task
  const background = new Map(); // playlistId -> AbortController of a silent auto-refresh
  const autoRefreshTried = new Set();
  const timers = new Set();
  let pendingRestore = null; // { playlistId, category, lastChannelId } — applied once that playlist loads
  let initPromise = null;
  let lastChannelId = sanitizeSession(readJSON(KEYS.session, null)).lastChannelId;
  const cleanups = [];

  const get = () => store.get();
  const findPlaylist = (id) => get().playlists.find((p) => p.id === id) || null;

  // ---- Persistence ---------------------------------------------------------------------------------------

  function save(key, value) {
    if (disposed || applyingRemote) return;
    if (!writeJSON(key, value) && !storageWarned) {
      storageWarned = true;
      toast.warning(MSG.storageWrite);
    }
  }

  const sessionOf = (s) => ({
    activePlaylistId: s.activePlaylistId,
    lastChannelId,
    category: s.category,
    sort: s.sort,
    groupSort: s.groupSort,
    volume: s.volume,
    muted: s.muted,
  });
  // Only a pending change is flushed on pagehide / tab hide: an idle tab must not overwrite the session
  // another tab saved in the meantime.
  let sessionPending = false;
  const writeSession = debounce(() => {
    sessionPending = false;
    save(KEYS.session, sessionOf(get()));
  }, SESSION_DEBOUNCE_MS);
  const saveSession = () => {
    sessionPending = true;
    writeSession();
  };
  const SESSION_FIELDS = ['activePlaylistId', 'category', 'sort', 'groupSort', 'volume', 'muted'];

  // Health changes come in bursts (a failing channel, then the next one): written debounced, flushed on
  // pagehide / tab hide like the session.
  let healthPending = false;
  const writeHealth = debounce(() => {
    healthPending = false;
    save(KEYS.health, get().health);
  }, HEALTH_DEBOUNCE_MS);

  cleanups.push(
    store.subscribe((s, prev) => {
      if (disposed) return;
      let dirty = SESSION_FIELDS.some((key) => s[key] !== prev[key]);
      if (s.currentChannel !== prev.currentChannel) {
        const id = s.currentChannel?.id ?? null;
        if (id !== lastChannelId) {
          lastChannelId = id;
          dirty = true;
        }
      }
      if (dirty) saveSession();
    }),
    store.select((s) => s.settings, (value) => save(KEYS.settings, value)),
    store.select((s) => s.playlists, (value) => save(KEYS.playlists, value)),
    store.select((s) => s.favorites, (value) => save(KEYS.favorites, value)),
    store.select((s) => s.recents, (value) => save(KEYS.recents, value)),
    store.select(
      (s) => s.health,
      () => {
        if (disposed) return;
        if (applyingRemote) {
          // Adopted from another tab, which already saved it; a write still pending here would only echo it.
          writeHealth.cancel();
          healthPending = false;
          return;
        }
        healthPending = true;
        writeHealth();
      },
    ),
    store.select(
      (s) => s.theme,
      (theme) => {
        applyTheme(theme);
        save(KEYS.theme, theme);
      },
    ),
  );

  const flushWrites = () => {
    if (disposed) return;
    if (sessionPending) writeSession.flush();
    if (healthPending) writeHealth.flush();
  };
  const onVisibilityChange = () => {
    if (document.visibilityState === 'hidden') flushWrites();
    else pruneHealth(); // a tab resumed after a long sleep shouldn't keep flagging long-expired failures
  };

  /** Drop expired health entries (no state change when none expired). */
  function pruneHealth() {
    const now = Date.now();
    const entries = Object.entries(get().health);
    const fresh = entries.filter(([, entry]) => isFreshHealth(entry.at, now));
    if (fresh.length !== entries.length) store.set({ health: healthFromEntries(fresh) });
  }

  /**
   * Another tab saved its playlist list (added, renamed, removed…): adopt it, so a later write from this
   * tab can't drop the other tab's playlists. When it removed the playlist shown here, move on like a local
   * removal would.
   */
  function adoptRemotePlaylists(playlists) {
    const s = get();
    if (JSON.stringify(s.playlists) === JSON.stringify(playlists)) return;
    const index = s.playlists.findIndex((p) => p.id === s.activePlaylistId);
    for (const p of s.playlists) {
      if (playlists.some((q) => q.id === p.id)) continue;
      background.get(p.id)?.abort();
      background.delete(p.id);
    }
    applyingRemote = true;
    try {
      if (index === -1 || playlists.some((p) => p.id === s.activePlaylistId)) store.set({ playlists });
      else leaveRemovedPlaylist(playlists, index);
    } finally {
      applyingRemote = false;
    }
  }

  /**
   * Another tab changed one of our keys: adopt favorites/recents/theme/settings/health/playlists (no
   * write-back).
   */
  const onStorage = (e) => {
    if (disposed || !e.key) return;
    try {
      if (e.storageArea && e.storageArea !== globalThis.localStorage) return;
    } catch {
      return;
    }
    const s = get();
    let key;
    let value;
    if (e.key === KEYS.favorites) {
      key = 'favorites';
      value = sanitizeSnapshots(readJSON(KEYS.favorites, null));
    } else if (e.key === KEYS.recents) {
      key = 'recents';
      value = sanitizeSnapshots(readJSON(KEYS.recents, null)).slice(0, MAX_RECENTS);
    } else if (e.key === KEYS.theme) {
      key = 'theme';
      value = sanitizeTheme(readJSON(KEYS.theme, null));
    } else if (e.key === KEYS.settings) {
      key = 'settings';
      value = sanitizeSettings(readJSON(KEYS.settings, null));
    } else if (e.key === KEYS.health) {
      key = 'health';
      value = sanitizeHealth(readJSON(KEYS.health, null));
    } else if (e.key === KEYS.playlists) {
      adoptRemotePlaylists(sanitizePlaylists(readJSON(KEYS.playlists, null)));
      return;
    } else return;
    if (JSON.stringify(s[key]) === JSON.stringify(value)) return;
    applyingRemote = true;
    try {
      store.set({ [key]: value });
    } finally {
      applyingRemote = false;
    }
  };

  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', flushWrites);
    window.addEventListener('storage', onStorage);
    document.addEventListener('visibilitychange', onVisibilityChange);
    cleanups.push(() => {
      window.removeEventListener('pagehide', flushWrites);
      window.removeEventListener('storage', onStorage);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    });
  }

  // ---- Busy state & download tasks ------------------------------------------------------------------------

  function beginBusy(message) {
    const entry = { message };
    busyStack.push(entry);
    store.set({ busy: entry });
    return () => {
      const index = busyStack.indexOf(entry);
      if (index !== -1) busyStack.splice(index, 1);
      store.set({ busy: busyStack.at(-1) || null });
    };
  }

  /** Toast an error and return it with a friendly message (for `throw report(err)`). */
  function report(err) {
    const error = friendlyError(err);
    if (!isAbortError(error)) toast.error(error.message);
    return error;
  }

  /**
   * Run a task that may download: shows the busy indicator and toasts failures (except cancellations).
   * Rejects with a friendly error. A new task aborts the in-flight one of the same `lane` only — adding a
   * playlist must not cancel the download of the playlist on screen (that would leave it empty).
   */
  async function runTask(message, task, { onError, lane } = {}) {
    if (lane) lanes.get(lane)?.abort();
    const controller = new AbortController();
    if (lane) lanes.set(lane, controller);
    tasks.add(controller);
    const endBusy = beginBusy(message);
    try {
      return await task(controller.signal);
    } catch (err) {
      const error = friendlyError(err);
      if (!isAbortError(error)) {
        if (onError) onError(error);
        else toast.error(error.message);
      }
      throw error;
    } finally {
      if (lane && lanes.get(lane) === controller) lanes.delete(lane);
      tasks.delete(controller);
      endBusy();
    }
  }

  function abortAll() {
    for (const controller of tasks) controller.abort();
    for (const controller of background.values()) controller.abort();
  }

  function later(fn, ms) {
    const timer = setTimeout(() => {
      timers.delete(timer);
      fn();
    }, ms);
    timers.add(timer);
  }

  // ---- Playlist content -----------------------------------------------------------------------------------

  /** Persist playlist text; on failure drop any stale copy and (optionally) warn. Returns `cached`. */
  async function persistContent(id, text, source, { warn = true } = {}) {
    let result = null;
    try {
      result = await writePlaylistText(id, text);
    } catch {
      result = null;
    }
    if (result?.ok) return true;
    // Drop a stale stored copy. Without localStorage at all, the in-memory copy the storage module kept is
    // the only one this session has (e.g. to switch back to an uploaded file), so it stays.
    if (isStorageAvailable()) removePlaylistText(id);
    if (warn && source.kind !== 'demo') {
      const unavailable = result?.error === 'UNAVAILABLE';
      if (source.kind === 'file') toast.warning(unavailable ? MSG.cacheUnavailableFile : MSG.cacheFile);
      else toast.warning(unavailable ? MSG.cacheUnavailableUrl : MSG.cacheUrl);
    }
    return false;
  }

  /** Stored content of a playlist, parsed (null when nothing usable is cached). */
  async function loadCached(meta) {
    let text = null;
    if (meta.source.kind === 'demo') text = DEMO_M3U;
    else {
      try {
        text = await readPlaylistText(meta.id);
      } catch {
        text = null;
      }
    }
    if (typeof text !== 'string' || !text) return null;
    try {
      const parsed = parseContent(text, meta.source, meta.name);
      return parsed.channels.length ? parsed : null;
    } catch {
      return null;
    }
  }

  function upsertPlaylist(meta) {
    store.set((s) => {
      const index = s.playlists.findIndex((p) => p.id === meta.id);
      const playlists = s.playlists.slice();
      if (index === -1) playlists.push(meta);
      else playlists[index] = meta;
      return { playlists };
    });
  }

  /** Keep stored counts in sync with the parsed content (e.g. after a parser upgrade). */
  function syncMeta(meta, parsed, { cached = meta.cached } = {}) {
    const epgUrl = parsed.epgUrl || undefined;
    if (
      meta.channelCount === parsed.channels.length &&
      meta.groupCount === parsed.groups.length &&
      meta.epgUrl === epgUrl &&
      meta.cached === cached
    ) {
      return meta;
    }
    const next = { ...meta, channelCount: parsed.channels.length, groupCount: parsed.groups.length, cached };
    if (epgUrl) next.epgUrl = epgUrl;
    else delete next.epgUrl;
    upsertPlaylist(next);
    return next;
  }

  function findSnapshotChannel(id) {
    const s = get();
    const snap = s.favorites.find((f) => f.id === id) || s.recents.find((r) => r.id === id);
    return snap ? snapshotToChannel(snap) : null;
  }

  /** Start-up restore for `playlistId` while its content is unavailable: last channel from snapshots. */
  function restoreFromSnapshots(playlistId) {
    const pending = pendingRestore;
    if (!pending || pending.playlistId !== playlistId || !pending.lastChannelId) return;
    if (get().currentChannel) {
      pending.lastChannelId = null;
      return;
    }
    const channel = findSnapshotChannel(pending.lastChannelId);
    if (channel) {
      pending.lastChannelId = null;
      play(channel, { record: false });
    }
  }

  /**
   * Make `meta` the active playlist showing `parsed`. `resetView` → category 'all' and empty query;
   * otherwise the current category is kept when it still exists. Applies a pending start-up restore.
   */
  function showPlaylist(meta, parsed, { resetView }) {
    const s = get();
    const view = { ...s, groups: parsed.groups };
    let category = resetView ? CATEGORY.all : s.category;
    const pending = pendingRestore && pendingRestore.playlistId === meta.id ? pendingRestore : null;
    if (pending) {
      pendingRestore = null;
      if (pending.category && category === CATEGORY.all && categoryExists(view, pending.category)) {
        category = pending.category;
      }
    }
    if (!categoryExists(view, category)) category = CATEGORY.all;

    const patch = {
      activePlaylistId: meta.id,
      channels: parsed.channels,
      groups: parsed.groups,
      playlistError: null,
      category,
    };
    if (resetView) patch.query = '';
    store.set(patch);

    if (pending?.lastChannelId && !get().currentChannel) {
      const id = pending.lastChannelId;
      const channel = selectChannelMap(get()).get(id) || findSnapshotChannel(id);
      if (channel) play(channel, { record: false });
    }
  }

  /**
   * The active playlist was removed (here or in another tab): show the one that took its place in
   * `playlists` (the list without it; `index` = its old position), or the empty library.
   */
  function leaveRemovedPlaylist(playlists, index) {
    const s = get();
    if (pendingRestore?.playlistId === s.activePlaylistId) pendingRestore = null;
    const next = playlists[Math.min(index, playlists.length - 1)] || null;
    if (next) {
      // Keep the old list on screen for the few ms until the next playlist's content is ready.
      store.set({ playlists, activePlaylistId: next.id, playlistError: null });
      activate(next, { resetView: true }).catch(noop);
      return;
    }
    beginActivation(null);
    const keepCategory = s.category === CATEGORY.favorites || s.category === CATEGORY.recent;
    store.set({
      playlists,
      activePlaylistId: null,
      channels: [],
      groups: [],
      playlistError: null,
      category: keepCategory ? s.category : CATEGORY.all,
      query: '',
    });
  }

  /** A new "show this playlist" intent; drops a pending restore that belongs to another playlist. */
  function beginActivation(playlistId) {
    if (pendingRestore && pendingRestore.playlistId !== playlistId) pendingRestore = null;
    return ++intentSeq;
  }

  /**
   * Save freshly loaded content for a new or existing playlist and (when still wanted) activate it.
   * @returns {Promise<object>} PlaylistMeta
   */
  async function ingest(text, { name, source, signal, intent }) {
    const explicitName = cleanName(name);
    const parsed = parseContent(text, source, explicitName);
    if (!parsed.channels.length) throw new Error(MSG.empty);
    throwIfAborted(signal);

    const before = get();
    const existing =
      source.kind === 'url'
        ? findPlaylistByUrl(before.playlists, source.url)
        : source.kind === 'demo'
          ? before.playlists.find((p) => p.source.kind === 'demo') || null
          : null;
    const id = existing?.id ?? uid('pl');
    if (existing) {
      background.get(id)?.abort();
      background.delete(id);
    }

    const cached = await persistContent(id, parsed.text, source);
    const current = findPlaylist(id); // may have been removed while saving
    const now = Date.now();
    const meta = {
      id,
      name: explicitName || current?.name || defaultPlaylistName(source, parsed.title),
      source,
      channelCount: parsed.channels.length,
      groupCount: parsed.groups.length,
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
      cached,
    };
    if (parsed.epgUrl) meta.epgUrl = parsed.epgUrl;
    upsertPlaylist(meta);

    const activated = intent === intentSeq;
    if (activated) showPlaylist(meta, parsed, { resetView: true });
    else if (get().activePlaylistId === id) showPlaylist(meta, parsed, { resetView: false });

    let message = `Loaded ${countLabel(meta.channelCount)} from “${meta.name}”`;
    if (parsed.warnings.length) message += `. ${parsed.warnings[0]}`;
    toast.success(message, {
      duration: parsed.warnings.length ? 6000 : undefined,
      action:
        activated || get().activePlaylistId === id
          ? undefined
          : { label: 'Open', onClick: () => actions.switchPlaylist(id).catch(noop) },
    });
    return meta;
  }

  /**
   * Replace the content of an existing playlist (refresh / first download). Updates the visible channels in
   * place when it is the active playlist. Returns null when the playlist was removed in the meantime.
   */
  async function applyContent(id, text, { silent }) {
    const meta = findPlaylist(id);
    if (!meta) return null;
    const parsed = parseContent(text, meta.source, meta.name);
    if (!parsed.channels.length) throw new Error(MSG.empty);
    const cached = await persistContent(id, parsed.text, meta.source, { warn: !silent });
    const current = findPlaylist(id);
    if (!current) {
      removePlaylistText(id);
      return null;
    }
    const next = {
      ...current,
      channelCount: parsed.channels.length,
      groupCount: parsed.groups.length,
      updatedAt: Date.now(),
      cached,
    };
    if (parsed.epgUrl) next.epgUrl = parsed.epgUrl;
    else delete next.epgUrl;
    upsertPlaylist(next);
    const s = get();
    // Unchanged content keeps the current arrays so the list doesn't re-render (and keeps its scroll).
    if (s.activePlaylistId === id && (s.playlistError || !sameChannels(s.channels, parsed.channels))) {
      showPlaylist(next, parsed, { resetView: false });
    }
    return { meta: next, prevCount: current.channelCount };
  }

  async function downloadInto(id, { signal, silent }) {
    const meta = findPlaylist(id);
    if (!meta) return null;
    const corsProxy = effectiveRelay(get().settings);
    const result = await fetchPlaylist(meta.source.url, { signal, corsProxy });
    throwIfAborted(signal);
    return applyContent(id, result.text, { silent });
  }

  /** Failure to load the active playlist's content: inline error state + toast with Retry. */
  function onActiveLoadError(id, error) {
    const s = get();
    if (s.activePlaylistId !== id) return; // the user moved on — nothing to report
    if (!s.channels.length) store.set({ playlistError: { playlistId: id, message: error.message } });
    restoreFromSnapshots(id);
    const meta = findPlaylist(id);
    toast.error(
      error.message,
      meta?.source.kind === 'url'
        ? { action: { label: 'Retry', onClick: () => actions.refreshPlaylist(id).catch(noop) } }
        : undefined,
    );
  }

  /** Re-download a stale URL playlist in the background (once per session); toasts only when it changed. */
  function scheduleAutoRefresh(meta) {
    if (!meta || meta.source.kind !== 'url' || autoRefreshTried.has(meta.id)) return;
    const hours = Number(get().settings.autoRefreshHours) || 0;
    if (hours <= 0 || Date.now() - (meta.updatedAt || 0) < hours * HOUR_MS) return;
    autoRefreshTried.add(meta.id);
    later(() => {
      if (disposed || background.has(meta.id) || !findPlaylist(meta.id)) return;
      if (globalThis.navigator?.onLine === false) {
        autoRefreshTried.delete(meta.id); // try again on the next activation
        return;
      }
      const controller = new AbortController();
      background.set(meta.id, controller);
      (async () => {
        try {
          const result = await fetchPlaylist(meta.source.url, {
            signal: controller.signal,
            corsProxy: effectiveRelay(get().settings),
          });
          if (controller.signal.aborted) return;
          const applied = await applyContent(meta.id, result.text, { silent: true });
          if (applied && applied.meta.channelCount !== applied.prevCount) {
            toast.info(`Playlist updated · ${countLabel(applied.meta.channelCount)}`);
          }
        } catch {
          /* silent: the cached copy stays in use */
        } finally {
          if (background.get(meta.id) === controller) background.delete(meta.id);
        }
      })();
    }, AUTO_REFRESH_DELAY_MS);
  }

  /** Show a stored playlist: cached content first, else (URL playlists) download it. */
  async function activate(meta, { resetView }) {
    const intent = beginActivation(meta.id);
    const parsed = await loadCached(meta);
    if (intent !== intentSeq) return;
    const current = findPlaylist(meta.id);
    if (!current) return;

    if (parsed) {
      const cached = current.source.kind === 'demo' ? current.cached : isStorageAvailable();
      showPlaylist(syncMeta(current, parsed, { cached }), parsed, { resetView });
      scheduleAutoRefresh(findPlaylist(meta.id));
      return;
    }

    const patch = { activePlaylistId: current.id, channels: [], groups: [], playlistError: null };
    if (resetView) Object.assign(patch, { category: CATEGORY.all, query: '' });
    store.set(patch);

    if (current.source.kind !== 'url') {
      const message =
        `“${current.name}” is no longer stored in this browser. Upload the file again to use it.`;
      store.set({ playlistError: { playlistId: current.id, message } });
      restoreFromSnapshots(current.id);
      toast.error(message);
      throw new Error(message);
    }

    await runTask(
      `Downloading “${current.name}”…`,
      (signal) => downloadInto(current.id, { signal, silent: true }),
      { onError: (error) => onActiveLoadError(current.id, error), lane: LANE_CONTENT },
    );
  }

  // ---- Playback & library helpers -------------------------------------------------------------------------

  function playlistIdFor(s, channel) {
    if (channel.playlistId) return channel.playlistId;
    return selectChannelMap(s).has(channel.id) ? s.activePlaylistId : null;
  }

  function play(channel, { record = true } = {}) {
    if (!channel || typeof channel.url !== 'string' || !channel.url) return;
    store.set((s) => {
      // playbackState resets in the same update so the list never paints the previous channel's state.
      const patch = { currentChannel: channel, playRequest: s.playRequest + 1, playbackState: 'loading' };
      if (record) {
        const snap = { ...channelToSnapshot(channel, playlistIdFor(s, channel)), watchedAt: Date.now() };
        patch.recents = [snap, ...s.recents.filter((r) => r.id !== channel.id)].slice(0, MAX_RECENTS);
      }
      return patch;
    });
  }

  function step(delta) {
    const s = get();
    const { items } = selectVisibleChannels(s);
    if (!items.length) return;
    const currentId = s.currentChannel?.id;
    const index = currentId ? items.findIndex((item) => item.channel.id === currentId) : -1;
    const first = delta > 0 ? 0 : items.length - 1;
    const next = index === -1 ? first : (index + delta + items.length) % items.length;
    // In "Recently watched", re-recording would move the channel to the top and make next/prev ping-pong.
    play(items[next].channel, { record: s.category !== CATEGORY.recent });
  }

  // ---- Start-up -------------------------------------------------------------------------------------------

  /** Read and strip `?playlist=` / `?play=` / `?name=` from the address bar. */
  /** True when embedded in another page's frame (or when that can't be determined). */
  function isFramed() {
    try {
      return globalThis.top !== globalThis.self;
    } catch {
      return true;
    }
  }

  function takeQueryParams() {
    const loc = globalThis.location;
    const empty = { playlist: '', play: '', name: '' };
    if (!loc || !loc.search) return empty;
    if (isFramed()) return empty; // a framing page must not be able to inject playlists or streams
    const params = new URLSearchParams(loc.search);
    if (!params.has('playlist') && !params.has('play') && !params.has('name')) return empty;
    const result = {
      playlist: (params.get('playlist') || '').trim(),
      play: (params.get('play') || '').trim(),
      name: (params.get('name') || '').trim(),
    };
    params.delete('playlist');
    params.delete('play');
    params.delete('name');
    const query = params.toString();
    try {
      const next = `${loc.pathname}${query ? `?${query}` : ''}${loc.hash}`;
      globalThis.history?.replaceState(globalThis.history.state, '', next);
    } catch {
      /* sandboxed / file: URLs — leaving the params in place is harmless */
    }
    return result;
  }

  function offerSharedPlaylist(url, name) {
    const host = tryParseUrl(url)?.host || url;
    toast.info(`This link wants to add a playlist from “${host}”.`, {
      duration: 0,
      action: {
        label: 'Add playlist',
        onClick: () => actions.addPlaylistFromUrl({ url, name }).catch(noop),
      },
    });
  }

  async function runInit() {
    const state = get();
    applyTheme(state.theme);
    if (!isStorageAvailable()) {
      storageWarned = true;
      toast.warning(MSG.storageUnavailable);
    }

    const session = sanitizeSession(readJSON(KEYS.session, null));
    const params = takeQueryParams();

    let target = selectActivePlaylist(state);
    let addUrl = '';
    if (params.playlist) {
      try {
        const url = normalizePlaylistUrl(params.playlist);
        const existing = findPlaylistByUrl(state.playlists, url);
        if (existing) target = existing;
        else addUrl = url;
      } catch (err) {
        toast.error(describeError(err));
      }
    }
    const direct = params.play ? makeDirectChannel(params.play, params.name) : null;
    if (params.play && !direct) toast.error(MSG.badStreamLink);
    const lastId = !params.play && state.settings.rememberLastChannel ? session.lastChannelId : null;

    // Phase 1 — local only (fast): cached content, restored category and last channel.
    let shown = false;
    let needsDownload = false;
    if (target) {
      pendingRestore = {
        playlistId: target.id,
        category: target.id === state.activePlaylistId ? session.category : CATEGORY.all,
        lastChannelId: lastId,
      };
      const intent = beginActivation(target.id);
      const parsed = await loadCached(target);
      const current = findPlaylist(target.id);
      if (intent === intentSeq && current) {
        if (parsed) {
          const cached = current.source.kind === 'demo' ? current.cached : isStorageAvailable();
          showPlaylist(syncMeta(current, parsed, { cached }), parsed, { resetView: false });
          shown = true;
        } else {
          needsDownload = true;
          store.set({ activePlaylistId: current.id, channels: [], groups: [], playlistError: null });
          restoreFromSnapshots(current.id); // play the last channel from its snapshot while downloading
        }
      }
    } else if (lastId) {
      const channel = findSnapshotChannel(lastId);
      if (channel) play(channel, { record: false });
    }
    if (direct) play(direct);
    store.set({ ready: true });

    // Phase 2 — network.
    // A shared ?playlist= link for an unknown URL is only added after the user confirms it, so a link
    // can't silently install (and keep auto-refreshing) a third-party playlist.
    if (addUrl) offerSharedPlaylist(addUrl, direct ? undefined : params.name || undefined);
    if (needsDownload && target && findPlaylist(target.id) && get().activePlaylistId === target.id) {
      await activate(findPlaylist(target.id), { resetView: false }).catch(noop);
    } else if (shown && target) {
      scheduleAutoRefresh(findPlaylist(target.id));
    }
  }

  // ---- Public API -----------------------------------------------------------------------------------------

  const actions = {
    /** Load the active playlist, restore the session, handle query params. Idempotent. */
    init() {
      if (!initPromise) initPromise = runInit();
      return initPromise;
    },

    // Playlists ------------------------------------------------------------------------------------------

    /** Download, parse, persist and activate a playlist URL (a playlist with the same URL is refreshed). */
    async addPlaylistFromUrl({ url, name } = {}) {
      let normalized;
      try {
        normalized = normalizePlaylistUrl(url);
      } catch (err) {
        throw report(err);
      }
      const intent = beginActivation(null);
      return runTask(
        'Downloading playlist…',
        async (signal) => {
          const corsProxy = effectiveRelay(get().settings);
          const result = await fetchPlaylist(normalized, { signal, corsProxy });
          throwIfAborted(signal);
          // Remember the https:// form when the loader had to upgrade an http:// link on an https page.
          const sourceUrl = result.upgraded ? normalized.replace(/^http:/i, 'https:') : normalized;
          return ingest(result.text, { name, source: { kind: 'url', url: sourceUrl }, signal, intent });
        },
        { lane: LANE_ADD },
      );
    },

    /** Read, parse, persist and activate an uploaded/dropped playlist file. */
    async addPlaylistFromFile(file, { name } = {}) {
      if (!file || typeof file !== 'object') throw report(new Error('No playlist file was selected.'));
      const intent = beginActivation(null);
      const fileName = typeof file.name === 'string' && file.name.trim() ? file.name.trim() : '';
      return runTask(
        fileName ? `Reading “${fileName}”…` : 'Reading playlist…',
        async (signal) => {
          const text = await readPlaylistFile(file);
          throwIfAborted(signal);
          const source = fileName ? { kind: 'file', fileName } : { kind: 'file' };
          return ingest(text, { name, source, signal, intent });
        },
        { lane: LANE_ADD },
      );
    },

    /** Ingest playlist text directly (`source` defaults to a file source). */
    async addPlaylistFromText(text, { name, source } = {}) {
      if (typeof text !== 'string' || !text.trim()) throw report(new Error(MSG.empty));
      const src = sanitizeSource(source) || { kind: 'file' };
      const intent = beginActivation(null);
      return runTask('Loading playlist…', (signal) => ingest(text, { name, source: src, signal, intent }), {
        lane: LANE_ADD,
      });
    },

    /** Add (or re-open) the built-in demo playlist. */
    addDemoPlaylist() {
      return actions.addPlaylistFromText(DEMO_M3U, { name: DEMO_PLAYLIST_NAME, source: { kind: 'demo' } });
    },

    /** Make a stored playlist active (from cache, or downloaded for uncached URL playlists). */
    async switchPlaylist(id) {
      const meta = findPlaylist(id);
      if (!meta) throw report(new Error(MSG.notFound));
      const s = get();
      if (s.activePlaylistId === id && !s.playlistError && s.channels.length) return;
      await activate(meta, { resetView: true });
    },

    /** Re-download a URL playlist (the demo playlist is re-read from the bundle). */
    async refreshPlaylist(id) {
      const meta = findPlaylist(id);
      if (!meta) throw report(new Error(MSG.notFound));
      if (meta.source.kind === 'file') throw report(new Error(MSG.refreshFile));
      background.get(id)?.abort();
      background.delete(id);
      await runTask(
        `Refreshing “${meta.name}”…`,
        async (signal) => {
          const applied =
            meta.source.kind === 'demo'
              ? await applyContent(id, DEMO_M3U, { silent: false })
              : await downloadInto(id, { signal, silent: false });
          if (applied) {
            toast.success(`“${applied.meta.name}” updated · ${countLabel(applied.meta.channelCount)}`);
          }
        },
        {
          onError: (error) => {
            if (get().activePlaylistId === id) onActiveLoadError(id, error);
            else toast.error(error.message);
          },
          lane: `refresh:${id}`,
        },
      );
    },

    /** Rename a playlist (blank names are ignored). */
    renamePlaylist(id, name) {
      const clean = cleanName(name);
      const meta = findPlaylist(id);
      if (!meta || !clean || clean === meta.name) return;
      upsertPlaylist({ ...meta, name: clean });
    },

    /** Delete a playlist and its stored content. The UI confirms first. */
    removePlaylist(id) {
      const s = get();
      const index = s.playlists.findIndex((p) => p.id === id);
      if (index === -1) return;
      background.get(id)?.abort();
      background.delete(id);
      removePlaylistText(id);
      const playlists = s.playlists.filter((p) => p.id !== id);
      if (s.activePlaylistId !== id) {
        store.set({ playlists });
        return;
      }
      leaveRemovedPlaylist(playlists, index);
    },

    /** Download a playlist as .m3u (stored text; re-downloaded when it isn't cached). */
    async exportPlaylist(id) {
      const meta = findPlaylist(id);
      if (!meta) throw report(new Error(MSG.notFound));
      let text = null;
      if (meta.source.kind === 'demo') text = DEMO_M3U;
      else {
        try {
          text = await readPlaylistText(id);
        } catch {
          text = null;
        }
      }
      if (!text) {
        const s = get();
        if (s.activePlaylistId === id && s.channels.length) {
          text = serializeM3U(s.channels, { title: meta.name, epgUrl: meta.epgUrl });
        } else if (meta.source.kind === 'url') {
          text = await runTask(`Downloading “${meta.name}”…`, async (signal) => {
            const corsProxy = effectiveRelay(get().settings);
            const result = await fetchPlaylist(meta.source.url, { signal, corsProxy });
            throwIfAborted(signal);
            return parseContent(result.text, meta.source, meta.name).text;
          });
        }
      }
      if (!text) {
        const message = `“${meta.name}” isn’t stored in this browser anymore. Upload the file again.`;
        throw report(new Error(message));
      }
      downloadText(toFileName(meta.name), text);
    },

    /** Download the favorites as an .m3u playlist. */
    exportFavorites() {
      const s = get();
      if (!s.favorites.length) {
        toast.info('No favorites to export yet — star some channels first.');
        return;
      }
      const map = selectChannelMap(s);
      const channels = s.favorites.map((snap) => map.get(snap.id) || snapshotToChannel(snap));
      downloadText('favorites.m3u', serializeM3U(channels, { title: 'Favorites' }));
    },

    // Browsing -------------------------------------------------------------------------------------------

    setCategory(category) {
      if (typeof category !== 'string' || !categoryExists(get(), category)) return;
      if (pendingRestore) pendingRestore.category = null; // the user's choice wins over the restore
      store.set({ category });
    },

    setQuery(query) {
      const value = typeof query === 'string' ? query : String(query ?? '');
      store.set({ query: value.slice(0, MAX_QUERY_LENGTH) });
    },

    setSort(sort) {
      if (SORTS.includes(sort)) store.set({ sort });
    },

    setGroupSort(groupSort) {
      if (GROUP_SORTS.includes(groupSort)) store.set({ groupSort });
    },

    setSidebarOpen(open) {
      store.set({ sidebarOpen: !!open });
    },

    // Playback -------------------------------------------------------------------------------------------

    /** Select a channel for playback (always bumps playRequest so the player reloads) and record it. */
    playChannel(channel) {
      play(channel);
    },

    playNext() {
      step(1);
    },

    playPrev() {
      step(-1);
    },

    stopPlayback() {
      store.set({ currentChannel: null });
    },

    setVolumeState({ volume, muted } = {}) {
      const patch = {};
      if (Number.isFinite(volume)) patch.volume = clamp(volume, 0, 1);
      if (typeof muted === 'boolean') patch.muted = muted;
      store.set(patch);
    },

    // Favorites ------------------------------------------------------------------------------------------

    /** Star/unstar a channel. Returns the new state (true = favorite). */
    toggleFavorite(channel) {
      if (!channel || typeof channel.id !== 'string' || !channel.url) return false;
      const s = get();
      if (isFavorite(s, channel.id)) {
        store.set({ favorites: s.favorites.filter((f) => f.id !== channel.id) });
        return false;
      }
      const snap = { ...channelToSnapshot(channel, playlistIdFor(s, channel)), addedAt: Date.now() };
      store.set({ favorites: [...s.favorites, snap] });
      return true;
    },

    removeFavorite(id) {
      const s = get();
      if (!s.favorites.some((f) => f.id === id)) return;
      store.set({ favorites: s.favorites.filter((f) => f.id !== id) });
    },

    clearRecents() {
      if (get().recents.length) store.set({ recents: [] });
    },

    // Channel health -------------------------------------------------------------------------------------

    /**
     * Remember that a channel failed to play (shown as "Unavailable" in the list, and hidden with
     * `settings.hideUnplayable`) until it plays again or HEALTH_TTL_MS pass. Updates an existing entry.
     * @param {{ id: string }} channel
     * @param {{ code?: string, title?: string }} [details] the player's error code and the message shown
     */
    markChannelFailed(channel, { code, title } = {}) {
      const id = channel?.id;
      if (!isHealthId(id)) return;
      const now = Date.now();
      const entry = {
        code: cleanText(code, MAX_HEALTH_CODE),
        title: cleanText(title, MAX_HEALTH_TITLE) || MSG.channelFailed,
        at: now,
      };
      store.set((s) => {
        const entries = Object.entries(s.health).filter(([key, e]) => key !== id && isFreshHealth(e.at, now));
        entries.push([id, entry]);
        return { health: healthFromEntries(entries) };
      });
    },

    /** Forget a channel's failure once it plays (no state change when there was none). */
    markChannelOk(channel) {
      const id = channel?.id;
      const { health } = get();
      if (typeof id !== 'string' || !Object.hasOwn(health, id)) return;
      const next = { ...health };
      delete next[id];
      store.set({ health: next });
    },

    /** Forget every remembered failure. */
    clearHealth() {
      if (Object.keys(get().health).length) store.set({ health: {} });
    },

    // Theme & settings -----------------------------------------------------------------------------------

    setAccent(accent) {
      const { theme } = get();
      if (ACCENT_IDS.has(accent) && theme.accent !== accent) store.set({ theme: { ...theme, accent } });
    },

    setMode(mode) {
      const { theme } = get();
      if (MODES.includes(mode) && theme.mode !== mode) store.set({ theme: { ...theme, mode } });
    },

    toggleMode() {
      actions.setMode(get().theme.mode === 'dark' ? 'light' : 'dark');
    },

    /** Merge a settings patch (unknown keys and invalid values are ignored). */
    updateSettings(patch) {
      if (!isObject(patch)) return;
      const current = get().settings;
      const next = { ...current };
      let changed = false;
      for (const [key, raw] of Object.entries(patch)) {
        if (!Object.hasOwn(DEFAULT_SETTINGS, key)) continue;
        const value = coerceSetting(key, raw);
        if (value === undefined || Object.is(next[key], value)) continue;
        next[key] = value;
        changed = true;
      }
      if (changed) store.set({ settings: next });
    },

    /** Wipe all of our localStorage keys and reload the page. */
    clearAllData() {
      disposed = true;
      writeSession.cancel();
      writeHealth.cancel();
      abortAll();
      clearStoredData();
      try {
        globalThis.location.reload();
      } catch {
        /* not reloadable (tests / sandbox) — persistence is already disabled */
      }
    },

    /** Flush pending writes and remove every listener/timer (tests, hot reload). */
    destroy() {
      flushWrites();
      disposed = true;
      writeSession.cancel();
      writeHealth.cancel();
      abortAll();
      background.clear();
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      for (const cleanup of cleanups.splice(0)) cleanup();
    },
  };

  return actions;
}

/**
 * Start-up flow (spec §3.8): load/parse the active playlist, restore category and last channel, handle
 * `?playlist=` / `?play=` / `?name=`, schedule the background auto-refresh. Same as `actions.init()`.
 * @param {ReturnType<import('./store.js').createStore>} _store kept for API symmetry
 * @param {ReturnType<typeof createController>} actions
 * @returns {Promise<void>}
 */
export function initApp(_store, actions) {
  return actions.init();
}
