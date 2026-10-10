// Shared constants. Keep this file dependency-free.

export const APP_NAME = 'IPTV Player';

/** localStorage key namespace. Bump the version segment only with a migration. */
export const STORAGE_PREFIX = 'iptvp.v1.';

export const KEYS = Object.freeze({
  settings: `${STORAGE_PREFIX}settings`,
  theme: `${STORAGE_PREFIX}theme`, // also read by public/theme-init.js — keep in sync
  playlists: `${STORAGE_PREFIX}playlists`,
  playlistContent: (id) => `${STORAGE_PREFIX}pl.${id}`,
  favorites: `${STORAGE_PREFIX}favorites`,
  recents: `${STORAGE_PREFIX}recents`,
  session: `${STORAGE_PREFIX}session`,
  health: `${STORAGE_PREFIX}health`, // recently failed channels: { [channelId]: { code, title, at } }
});

/** Built-in relay values that switch it off (compared case-insensitively). */
const RELAY_OFF_VALUES = new Set(['off', 'false', 'none', '0']);
/** The only hosts an http:// built-in relay may use (browsers let https pages reach them; local testing). */
const LOOPBACK_RELAY_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * A built-in relay setting as the relay to use, else '': empty and "off" / "false" / "none" / "0" (any case)
 * mean no built-in relay; anything but an https:// URL — or an http:// one on localhost, 127.0.0.1 or [::1] —
 * is refused (an http:// relay elsewhere is blocked on the https site), and reported to `warn`. A usable
 * value is returned as written (trimmed): its exact form matters to buildProxyUrl().
 * @param {unknown} value
 * @param {(message: string) => void} [warn]
 * @returns {string}
 */
export function normalizeBuiltinRelay(value, warn) {
  const raw = String(value ?? '').trim();
  if (!raw || RELAY_OFF_VALUES.has(raw.toLowerCase())) return '';
  let url = null;
  try {
    url = new URL(raw);
  } catch {
    /* not an absolute URL */
  }
  const secure = url?.protocol === 'https:' || (url?.protocol === 'http:' && LOOPBACK_RELAY_HOSTS.has(url.hostname));
  if (secure && !url.username && !url.password) return raw;
  warn?.(
    `Ignoring the built-in relay ${JSON.stringify(raw)}: use an https:// URL (http://localhost for testing), ` +
      'or "off" to disable it.',
  );
  return '';
}

/**
 * This site's built-in stream relay (see proxy/ and README "Play HTTP / blocked streams"). Used when the user
 * hasn't configured a relay of their own, so insecure http:// and CORS-blocked channels play by default.
 * Forks can override it at build time with the VITE_BUILTIN_RELAY environment variable (a relay URL, or
 * "off" to disable it); an empty/unset variable keeps DEFAULT_BUILTIN_RELAY. Both are checked with
 * normalizeBuiltinRelay(): an unusable value means no built-in relay (and a console warning).
 */
const DEFAULT_BUILTIN_RELAY = 'https://iptv-player-56eab5bpcqzs.almailgroup.deno.net';
const ENV_RELAY = String(import.meta.env?.VITE_BUILTIN_RELAY ?? '').trim();
export const BUILTIN_RELAY_URL = normalizeBuiltinRelay(ENV_RELAY || DEFAULT_BUILTIN_RELAY, (message) =>
  console.warn(`[${APP_NAME}] ${message}`),
);

/** Accent palettes. `swatch` is used for the picker preview only; real colors live in tokens.css. */
export const ACCENTS = Object.freeze([
  { id: 'azure', name: 'Deep Azure', swatch: '#3b82f6' },
  { id: 'emerald', name: 'Emerald Green', swatch: '#10b981' },
  { id: 'cyberpunk', name: 'Neon Cyberpunk', swatch: '#ff2bd6', swatch2: '#00e5ff' },
  { id: 'amber', name: 'Warm Amber', swatch: '#f5a524' },
  { id: 'slate', name: 'Monochrome Slate', swatch: '#cbd5e1' },
  { id: 'rose', name: 'Crimson Rose', swatch: '#f43f5e' },
  { id: 'violet', name: 'Royal Violet', swatch: '#8b5cf6' },
]);

export const MODES = Object.freeze(['dark', 'light']);

export const DEFAULT_THEME = Object.freeze({ accent: 'azure', mode: 'dark' });

export const DEFAULT_SETTINGS = Object.freeze({
  autoReconnect: true, // retry broken/stalled streams automatically
  maxRetries: 8, // reconnect attempts before giving up (1–30)
  upgradeInsecure: true, // on https pages, try https:// for http:// streams
  autoplay: true, // start playback as soon as a channel is selected
  rememberLastChannel: true, // restore the last channel on reload
  showLogos: true, // show channel logos in the list
  lowLatency: true, // hls.js low-latency mode for LL-HLS streams
  preferNativeHls: false, // use the browser's native HLS instead of hls.js when available
  corsProxy: '', // the user's OWN relay for playlists AND streams (see proxy/); overrides the built-in relay
  useBuiltinRelay: true, // fall back to BUILTIN_RELAY_URL when no own relay is set
  proxyStreams: true, // play blocked streams (insecure http://, no CORS) through the relay
  hideUnplayable: false, // hide channels that can't play here (unsupported formats, DRM, recently failed)
  autoRefreshHours: 24, // re-download URL playlists in the background when older than this (0 = never)
  ambientColor: true, // tint the background with the playing video's colours ("Ambient colour from video")
});

export const DEFAULT_SESSION = Object.freeze({
  activePlaylistId: null,
  lastChannelId: null,
  category: 'all',
  sort: 'playlist', // 'playlist' | 'name'
  groupSort: 'name', // 'name' | 'playlist'
  volume: 1,
  muted: false,
});

/** Category identifiers used in state.category. Groups are encoded as `group:<name>`. */
export const CATEGORY = Object.freeze({
  all: 'all',
  favorites: 'favorites',
  recent: 'recent',
  groupPrefix: 'group:',
});

export const UNCATEGORIZED = 'Uncategorized';

export const MAX_RECENTS = 40;

/** Third-party community playlists offered as one-click suggestions in the "Add playlist" dialog. */
export const SUGGESTED_PLAYLISTS = Object.freeze([
  { name: 'iptv-org · News', url: 'https://iptv-org.github.io/iptv/categories/news.m3u' },
  { name: 'iptv-org · Music', url: 'https://iptv-org.github.io/iptv/categories/music.m3u' },
  { name: 'iptv-org · Documentary', url: 'https://iptv-org.github.io/iptv/categories/documentary.m3u' },
  { name: 'iptv-org · Sports', url: 'https://iptv-org.github.io/iptv/categories/sports.m3u' },
  { name: 'iptv-org · All channels (large)', url: 'https://iptv-org.github.io/iptv/index.m3u' },
]);
