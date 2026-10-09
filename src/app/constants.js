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
});

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
  corsProxy: '', // optional prefix for *playlist* downloads, e.g. "https://my-proxy.example/?url="
  autoRefreshHours: 24, // re-download URL playlists in the background when older than this (0 = never)
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
