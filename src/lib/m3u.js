// M3U / M3U8 playlist parser and serializer.
//
// Playlist content is untrusted: everything here is pure string processing (no DOM, no eval), logos are
// filtered through safeImageUrl(), and the attribute scanner is a hand-written single-pass loop, so hostile
// input can never trigger catastrophic regex backtracking. The hot path avoids needless allocations and
// regex work, keeping a 50k-entry playlist within the 300 ms parse budget in Node.

import { UNCATEGORIZED } from '../app/constants.js';
import {
  decodeURIComponentSafe,
  fileNameFromUrl,
  formatCount,
  hashString,
  safeImageUrl,
  tryParseUrl,
} from './utils.js';

// ---------------------------------------------------------------------------------------------------------
// Constants

const CH_TAB = 9;
const CH_LF = 10;
const CH_VT = 11;
const CH_FF = 12;
const CH_CR = 13;
const CH_SPACE = 32;
const CH_DQUOTE = 34;
const CH_HASH = 35;
const CH_SQUOTE = 39;
const CH_COMMA = 44;
const CH_COLON = 58;
const CH_LT = 60;
const CH_EQUALS = 61;
const CH_NBSP = 160;
const CH_BOM = 0xfeff;

/** Longest display name / group name we keep (hostile playlists can contain megabyte-long titles). */
const MAX_NAME_LENGTH = 300;
const MAX_GROUP_LENGTH = 200;
/** Upper bound on groups per channel (group-title="a;b;c;…"). */
const MAX_GROUPS_PER_CHANNEL = 24;

const LINE_SPLIT_RE = /\r\n|\r|\n/;
const SCHEME_RE = /^([a-z][a-z0-9+.-]*):/i;
const WHITESPACE_RE = /\s/;
const PATH_HINT_RE = /[/.?]/;
const DISPLAY_SPACE_RE = /[\s\u0000-\u001f\u007f-\u009f]+/g;
const NEWLINE_RE = /[\r\n\u2028\u2029]+/g;
const ENTITY_RE = /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z]{2,6}));/g;
const ENTITY_START_RE = /&(?=#\d{1,7};|#[xX][0-9a-fA-F]{1,6};|[a-zA-Z]{2,6};)/g;
const IMAGE_PATH_RE = /\.(?:png|jpe?g|gif|webp|svg|avif|bmp|ico)(?:[?#]|$)/i;
const INTEGER_PREFIX_RE = /^\d{1,9}/;
const GLUED_DURATION_RE = /^[-+]?\d{1,9}(?:\.\d{1,9})?(?=[a-z])/i;
const ATTR_KEY_RE = /^[^\s"'=,]+$/;
const EXTENSION_RE = /\.[a-z0-9]{1,5}$/i;

/** HLS tags that only appear in real HLS manifests (master or media playlists), at the start of a line. */
const HLS_TAG_RE = /^[ \t\uFEFF]*#EXT-X-(?:STREAM-INF|TARGETDURATION|MEDIA-SEQUENCE)\b/im;
/** IPTV-playlist attributes — never present in HLS manifests. Used to avoid misdetecting mixed files. */
const IPTV_ATTR_RE = /(?:tvg-(?:id|name|logo|chno)|group-title)[ \t]*=/i;
const M3U_MARKER_RE = /^[ \t\uFEFF]*#EXT(?:M3U|INF)/im;
const HTTP_LINE_RE = /^[ \t\uFEFF]*(https?:\/\/[^\s|]+)/gim;

const NAMED_ENTITIES = new Map([
  ['amp', '&'],
  ['quot', '"'],
  ['apos', "'"],
  ['lt', '<'],
  ['gt', '>'],
  ['nbsp', ' '],
]);

/** Schemes that must never become a channel URL. */
const BLOCKED_SCHEMES = new Set([
  'javascript', 'vbscript', 'data', 'file', 'blob', 'about', 'filesystem', 'view-source',
  'chrome', 'chrome-extension', 'moz-extension', 'safari-extension', 'ms-browser-extension',
  'intent', 'mailto', 'tel', 'sms', 'content', 'res', 'resource',
]);

/** File names that say nothing about a channel ("…/news/index.m3u8") — we look one level up instead. */
const GENERIC_FILE_NAMES = new Set([
  'index', 'playlist', 'master', 'manifest', 'chunklist', 'chunks', 'stream', 'live', 'mono', 'video',
  'play', 'main', 'output', 'media', 'hls', 'tracks-v1a1', 'prog_index', 'iframe_index',
]);

/** Shared, frozen group list for channels without any group. */
const NO_GROUPS = Object.freeze([UNCATEGORIZED]);

// ---------------------------------------------------------------------------------------------------------
// Small helpers

const isSpace = (c) =>
  c === CH_SPACE || c === CH_TAB || c === CH_VT || c === CH_FF || c === CH_NBSP || c === CH_CR || c === CH_LF;

/** Characters (≥ U+0080) that DISPLAY_SPACE_RE rewrites: C1 controls, NBSP and Unicode spaces. */
const isWideSpecial = (c) =>
  c <= 0xa0 ||
  c === 0x1680 ||
  (c >= 0x2000 && c <= 0x200a) ||
  c === 0x2028 ||
  c === 0x2029 ||
  c === 0x202f ||
  c === 0x205f ||
  c === 0x3000 ||
  c === CH_BOM;

const plural = (n, one, many) => `${formatCount(n)} ${n === 1 ? one : many}`;

/** Decode the common HTML entities playlists contain. Output is plain text — never parsed as markup. */
function decodeEntities(str) {
  if (str.indexOf('&') === -1) return str;
  return str.replace(ENTITY_RE, (match, dec, hex, name) => {
    if (name !== undefined) {
      const value = NAMED_ENTITIES.get(name.toLowerCase());
      return value === undefined ? match : value;
    }
    const code = dec !== undefined ? Number.parseInt(dec, 10) : Number.parseInt(hex, 16);
    if (
      !Number.isFinite(code) ||
      code > 0x10ffff ||
      (code >= 0xd800 && code <= 0xdfff) ||
      code < 0x20 ||
      (code >= 0x7f && code <= 0x9f)
    ) {
      return code === CH_TAB || code === CH_LF || code === CH_CR ? ' ' : '';
    }
    return String.fromCodePoint(code);
  });
}

/**
 * Collapse whitespace runs / control characters into single spaces, trim, and cap the length.
 * Fast path: most names are already clean, which a single char loop can prove without allocating.
 */
function tidy(str, max) {
  const n = str.length;
  let clean = n <= max;
  let prevSpace = true; // a leading space needs tidying
  for (let i = 0; clean && i < n; i++) {
    const c = str.charCodeAt(i);
    if (c <= CH_SPACE || c === 127) {
      if (c !== CH_SPACE || prevSpace) clean = false;
      prevSpace = true;
    } else {
      if (c >= 128 && isWideSpecial(c)) clean = false;
      prevSpace = false;
    }
  }
  if (clean && !(prevSpace && n > 0)) return str;
  let out = str.replace(DISPLAY_SPACE_RE, ' ').trim();
  if (out.length > max) {
    // Never cut a surrogate pair (emoji, rare CJK) in half.
    const last = out.charCodeAt(max - 1);
    out = out.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max).trimEnd();
  }
  return out;
}

/** Display text from playlist metadata: entity-decoded, whitespace-collapsed, length-capped. */
const displayText = (str, max = MAX_NAME_LENGTH) => (str ? tidy(decodeEntities(str), max) : '');

/** Remove surrounding matching quotes from a directive value (`"Mozilla/5.0"` → `Mozilla/5.0`). */
function unquote(value) {
  const v = value.trim();
  if (v.length >= 2) {
    const first = v.charCodeAt(0);
    if ((first === CH_DQUOTE || first === CH_SQUOTE) && v.charCodeAt(v.length - 1) === first) {
      return v.slice(1, -1).trim();
    }
  }
  return v;
}

const oneLine = (value) => String(value ?? '').replace(NEWLINE_RE, ' ').trim();

/** Case-insensitive `line.startsWith(tag)` for an upper-case `#TAG`, without allocating. */
function hasTag(line, tag) {
  const n = tag.length;
  if (line.length < n) return false;
  for (let i = 1; i < n; i++) {
    let c = line.charCodeAt(i);
    if (c >= 97 && c <= 122) c -= 32;
    if (c !== tag.charCodeAt(i)) return false;
  }
  return true;
}

/** Text after `#TAG` (and its optional colon). */
function directiveValue(line, tagLength) {
  return line.slice(line.charCodeAt(tagLength) === CH_COLON ? tagLength + 1 : tagLength).trim();
}

/** Lower-cased attribute key; the most common keys come back as literals (no allocation). */
function keyAt(str, start, end) {
  switch (end - start) {
    case 6:
      if (str.startsWith('tvg-id', start)) return 'tvg-id';
      break;
    case 8:
      if (str.startsWith('tvg-name', start)) return 'tvg-name';
      if (str.startsWith('tvg-logo', start)) return 'tvg-logo';
      if (str.startsWith('tvg-chno', start)) return 'tvg-chno';
      break;
    case 11:
      if (str.startsWith('group-title', start)) return 'group-title';
      break;
    default:
      break;
  }
  return str.slice(start, end).toLowerCase();
}

/** Store an attribute: the first non-empty value of a key wins. */
function setAttr(attrs, key, rawValue) {
  if (key === '__proto__') return;
  const value = rawValue.trim();
  const prev = attrs[key];
  // Own values are always strings, so a non-string means "unset" (or an inherited Object.prototype member).
  if (typeof prev !== 'string' || (prev === '' && value !== '')) attrs[key] = value;
}

// ---------------------------------------------------------------------------------------------------------
// Attribute scanner (hand-written, linear)

/**
 * Scan `key="value"`, `key='value'` and `key=value` pairs from `pos` and store them (lower-cased keys) in
 * `attrs`. Quoted values may contain commas, spaces and `=`; unquoted values end at whitespace or a comma.
 * Quotes only open a value directly after `=`; an unterminated quote ends at the next comma.
 * Scanning stops at the first comma outside quoted values: the rest of the string is the title. When there is
 * no such comma, bare words (tokens without `=`) form the title, which tolerates a missing comma as in
 * `#EXTINF:-1 tvg-id="x" Channel Name`. Single forward pass — linear in the input length.
 * @returns {string} raw title ('' when the line carries none)
 */
function scanAttributes(str, pos, attrs) {
  const n = str.length;
  let i = pos;
  let bare = null;
  while (i < n) {
    let c = str.charCodeAt(i);
    if (isSpace(c)) {
      i++;
      continue;
    }
    if (c === CH_COMMA) return str.slice(i + 1);

    const keyStart = i;
    while (i < n) {
      c = str.charCodeAt(i);
      if (c === CH_EQUALS || c === CH_COMMA || isSpace(c)) break;
      i++;
    }
    const keyEnd = i;
    let j = i;
    while (j < n && isSpace(str.charCodeAt(j))) j++;

    if (j >= n || str.charCodeAt(j) !== CH_EQUALS) {
      // Bare word: ignored when a title comma follows, otherwise part of the title.
      (bare ||= []).push(str.slice(keyStart, keyEnd));
      continue;
    }

    i = j + 1;
    let k = i;
    while (k < n && isSpace(str.charCodeAt(k))) k++;
    const q = k < n ? str.charCodeAt(k) : 0;
    let value;
    if (q === CH_DQUOTE || q === CH_SQUOTE) {
      const close = str.indexOf(q === CH_DQUOTE ? '"' : "'", k + 1);
      if (close !== -1) {
        value = str.slice(k + 1, close);
        i = close + 1;
      } else {
        let end = str.indexOf(',', k + 1);
        if (end === -1) end = n;
        value = str.slice(k + 1, end);
        i = end;
      }
    } else {
      // Unquoted: up to whitespace or a comma. After `key= ` (space), the next token is the value
      // (`tvg-chno = 7`) unless it is itself an attribute (`tvg-name= tvg-id="x"` → empty value).
      let end = k;
      let hasEquals = false;
      while (end < n) {
        c = str.charCodeAt(end);
        if (c === CH_COMMA || isSpace(c)) break;
        if (c === CH_EQUALS) hasEquals = true;
        end++;
      }
      if (k > i && hasEquals) {
        value = '';
        i = k;
      } else {
        value = str.slice(k, end);
        i = end;
      }
    }
    if (keyEnd > keyStart) setAttr(attrs, keyAt(str, keyStart, keyEnd), value);
  }
  return bare ? bare.join(' ') : '';
}

/**
 * Parse the part of an EXTINF line after `#EXTINF:` → duration, attributes and raw title.
 * Tolerates a missing duration (`#EXTINF:,Title`, `#EXTINF:tvg-id="x",Title`), extra spaces and a missing
 * comma.
 */
function parseExtinf(body) {
  const n = body.length;
  let i = 0;
  while (i < n && isSpace(body.charCodeAt(i))) i++;

  let duration = -1;
  const tokenStart = i;
  while (i < n) {
    const c = body.charCodeAt(i);
    if (c === CH_COMMA || isSpace(c)) break;
    i++;
  }
  if (i > tokenStart) {
    const token = body.slice(tokenStart, i);
    const value = Number(token);
    if (Number.isFinite(value)) {
      duration = value;
    } else {
      // Not a plain number: an attribute glued to the duration (`-1tvg-id="x"`), or no duration at all
      // (an attribute or a bare title) — rescan from the first character that isn't part of the number.
      const glued = GLUED_DURATION_RE.exec(token);
      if (glued && token.indexOf('=', glued[0].length) !== -1) {
        duration = Number(glued[0]);
        i = tokenStart + glued[0].length;
      } else {
        i = tokenStart;
      }
    }
  }

  const attrs = {};
  const title = scanAttributes(body, i, attrs);
  return { duration, attrs, title };
}

// ---------------------------------------------------------------------------------------------------------
// URL handling

const isHttpPrefix = (value) => value.startsWith('https://') || value.startsWith('http://');

function httpResult(url) {
  if (!url) return { kind: 'invalid' };
  const href = url.href;
  // Special schemes always have a host once parsed, so checking the scheme is enough.
  if (!href.startsWith('https:') && !href.startsWith('http:')) return { kind: 'invalid' };
  return { kind: 'http', url: href };
}

/**
 * Classify a URL line (pipe headers already removed).
 *   'http'     = absolute http(s) URL (normalized href; relative / protocol-relative links resolved),
 *   'stream'   = another `scheme://` link (rtmp, rtsp, udp, rtp, mms, srt…) kept as-is — browsers can't play
 *                these, the player reports them as unsupported,
 *   'invalid'  = a link we refuse (javascript:, data:, file:, local paths, unparsable),
 *   'relative' = relative link without a usable base URL,
 *   'text'     = stray text that is not a link at all.
 * @returns {{ kind: 'http', url: string } | { kind: 'stream', url: string, scheme: string }
 *   | { kind: 'invalid'|'relative'|'text' }}
 */
function classifyUrl(raw, base) {
  if (!raw) return { kind: 'text' };
  if (isHttpPrefix(raw)) return httpResult(tryParseUrl(raw));

  if (raw.startsWith('//')) {
    // Protocol-relative: inherit the playlist's scheme, or assume https.
    return httpResult(base ? tryParseUrl(raw, base.href) : tryParseUrl(`https:${raw}`));
  }

  const scheme = SCHEME_RE.exec(raw);
  if (scheme) {
    const name = scheme[1].toLowerCase();
    if (name === 'http' || name === 'https') return httpResult(tryParseUrl(raw));
    const rest = raw.slice(scheme[0].length);
    // Windows drive paths ("C:\videos\a.ts", "D:/x.ts") are local files, not URLs.
    if (name.length === 1 && (rest.startsWith('\\') || rest.startsWith('/'))) return { kind: 'invalid' };
    if (BLOCKED_SCHEMES.has(name)) return { kind: 'invalid' };
    if (rest.startsWith('//')) {
      return rest.length > 2 ? { kind: 'stream', url: raw, scheme: name } : { kind: 'invalid' };
    }
    // "Note: something" is a sentence, not a link; "foo:bar" is an unusable link.
    return WHITESPACE_RE.test(raw) ? { kind: 'text' } : { kind: 'invalid' };
  }

  // No scheme: a relative reference if it looks like a path, otherwise stray text.
  if (WHITESPACE_RE.test(raw) || !PATH_HINT_RE.test(raw)) return { kind: 'text' };
  if (!base) return { kind: 'relative' };
  return httpResult(tryParseUrl(raw, base.href));
}

/**
 * Resolve a logo reference to a safe <img> URL ('' when unusable). HTML-escaped playlists write `&amp;` in
 * logo query strings (and our own exports escape `"` as `&quot;`), so entities are decoded first.
 */
function resolveLogo(raw, base) {
  if (!raw) return '';
  const decoded = raw.indexOf('&') === -1 ? raw : decodeEntities(raw);
  if (isHttpPrefix(decoded)) return safeImageUrl(decoded);
  const value = decoded.trim();
  if (!value) return '';
  if (SCHEME_RE.test(value)) return safeImageUrl(value); // data:image/…, HTTP:// — anything else is rejected
  if (value.startsWith('//')) {
    const url = base ? tryParseUrl(value, base.href) : tryParseUrl(`https:${value}`);
    return url ? safeImageUrl(url.href) : '';
  }
  // Relative logo paths only when they clearly point at an image ("N/A", "none" etc. are ignored).
  if (base && !WHITESPACE_RE.test(value) && IMAGE_PATH_RE.test(value)) {
    const url = tryParseUrl(value, base.href);
    return url ? safeImageUrl(url.href) : '';
  }
  return '';
}

/** Map a header / VLC option name to our headers shape. Returns true when the key was recognized. */
function applyHeader(headers, key, value) {
  if (!value) return false;
  switch (key) {
    case 'user-agent':
    case 'http-user-agent':
      headers.userAgent = value;
      return true;
    case 'referer':
    case 'referrer':
    case 'http-referer':
    case 'http-referrer':
      headers.referrer = value;
      return true;
    case 'origin':
    case 'http-origin':
      headers.origin = value;
      return true;
    default:
      return false;
  }
}

/** Kodi pipe headers: `User-Agent=Foo&Referer=http%3A%2F%2Fr` (URL-encoded values) → headers, in place. */
function parsePipeHeaders(spec, headers) {
  for (const part of spec.split('&')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const key = decodeURIComponentSafe(part.slice(0, eq)).trim().toLowerCase();
    applyHeader(headers, key, unquote(decodeURIComponentSafe(part.slice(eq + 1))));
  }
}

/** `#EXTHTTP:{"User-Agent":"…","Referer":"…"}` (TiviMate / OTT Navigator extension) → headers, in place. */
function parseExtHttp(value, headers) {
  if (!value || value.length > 8192) return;
  try {
    const data = JSON.parse(value);
    if (!data || typeof data !== 'object' || Array.isArray(data)) return;
    for (const [key, val] of Object.entries(data)) {
      if (typeof val === 'string') applyHeader(headers, key.trim().toLowerCase(), val.trim());
    }
  } catch {
    /* malformed JSON — ignore the directive */
  }
}

const stripExtension = (name) => name.replace(EXTENSION_RE, '');
const isGenericName = (name) => GENERIC_FILE_NAMES.has(stripExtension(name).toLowerCase());

/**
 * Display name for an entry without a title: the file name (fileNameFromUrl), walking up the path when it is
 * generic ("…/news/index.m3u8" → "news"), else the hostname, else "Channel N".
 */
function deriveName(url, position) {
  let name = fileNameFromUrl(url);
  const parsed = name && isGenericName(name) ? tryParseUrl(url) : null;
  if (parsed) {
    const segments = parsed.pathname.split('/').filter(Boolean);
    name = parsed.hostname;
    for (let k = segments.length - 2; k >= 0; k--) {
      const segment = stripExtension(decodeURIComponentSafe(segments[k]));
      if (segment && !isGenericName(segment)) {
        name = segment;
        break;
      }
    }
  }
  name = name ? tidy(name, MAX_NAME_LENGTH) : '';
  return name || `Channel ${position}`;
}

function parseChno(attrs) {
  const value = attrs['tvg-chno'] || attrs['channel-number'] || attrs['tvg-num'];
  if (!value) return null;
  const match = INTEGER_PREFIX_RE.exec(value);
  if (match) return Number(match[0]);
  // The first key held junk: try the others before giving up.
  for (const key of ['channel-number', 'tvg-num']) {
    const alt = attrs[key];
    const m = alt && alt !== value ? INTEGER_PREFIX_RE.exec(alt) : null;
    if (m) return Number(m[0]);
  }
  return null;
}

/** Header attributes that carry the XMLTV guide URL(s), in order of preference. */
const EPG_ATTRS = ['x-tvg-url', 'url-tvg', 'tvg-url'];

/**
 * First usable EPG URL from the `#EXTM3U` header: `x-tvg-url` / `url-tvg` / `tvg-url`, each of which may hold
 * a comma-separated list. Relative references resolve against the playlist URL; only http(s) is accepted.
 */
function findEpgUrl(headerAttrs, base) {
  for (const key of EPG_ATTRS) {
    const raw = headerAttrs[key];
    if (typeof raw !== 'string' || !raw) continue;
    const list = raw.indexOf('&') === -1 ? raw : decodeEntities(raw);
    for (const part of list.split(',')) {
      const candidate = part.trim();
      if (!candidate) continue;
      const url = tryParseUrl(candidate, base ? base.href : undefined);
      if (url && (url.protocol === 'http:' || url.protocol === 'https:')) return url.href;
    }
  }
  return '';
}

/** `"News; World ;;News"` → `['News', 'World']` (trimmed, entity-decoded, non-empty, deduped). */
function splitGroups(raw) {
  const groups = [];
  // Decode first so the ';' of an entity ("Kids &amp; Family") is not mistaken for a separator.
  for (const part of decodeEntities(raw).split(';')) {
    const name = tidy(part, MAX_GROUP_LENGTH);
    if (name && !groups.includes(name)) {
      groups.push(name);
      if (groups.length >= MAX_GROUPS_PER_CHANNEL) break;
    }
  }
  return groups;
}

// ---------------------------------------------------------------------------------------------------------
// Public API

/**
 * Stable channel id: hash of the display name and the stream URL.
 * @param {string} name
 * @param {string} url
 * @returns {string}
 */
export function makeChannelId(name, url) {
  return hashString(`${name ?? ''}\n${url ?? ''}`);
}

/**
 * True when the text is an HLS manifest (a single stream's master or media playlist) rather than an IPTV
 * channel list: it has `#EXT-X-STREAM-INF`, `#EXT-X-TARGETDURATION` or `#EXT-X-MEDIA-SEQUENCE` at the start of
 * a line. Files that also carry IPTV channel attributes (`tvg-*`, `group-title`) are treated as channel lists.
 * @param {string} text
 * @returns {boolean}
 */
export function isHlsManifest(text) {
  if (typeof text !== 'string' || !text) return false;
  return HLS_TAG_RE.test(text) && !IPTV_ATTR_RE.test(text);
}

/**
 * Cheap sniff used to validate downloads/uploads: has an `#EXTM3U` / `#EXTINF` line, or at least one http(s)
 * URL line. HTML/XML documents (error pages, GitHub "blob" pages…) are rejected.
 * @param {string} text
 * @returns {boolean}
 */
export function looksLikeM3U(text) {
  if (typeof text !== 'string' || !text) return false;
  let start = text.charCodeAt(0) === CH_BOM ? 1 : 0;
  while (start < text.length && isSpace(text.charCodeAt(start))) start++;
  if (start >= text.length || text.charCodeAt(start) === CH_LT) return false;
  if (M3U_MARKER_RE.test(text)) return true;
  HTTP_LINE_RE.lastIndex = 0;
  let match;
  while ((match = HTTP_LINE_RE.exec(text)) !== null) {
    if (tryParseUrl(match[1])) {
      HTTP_LINE_RE.lastIndex = 0;
      return true;
    }
  }
  return false;
}

/**
 * Parse an M3U / M3U8 (extended or plain) playlist into Channel objects (see the data model in the spec).
 *
 * Supports `#EXTM3U` header attributes (x-tvg-url / url-tvg / tvg-url → meta.epgUrl), `#PLAYLIST`, `#EXTINF`
 * with quoted/unquoted attributes, `#EXTGRP`, `#EXTIMG`, `#EXTVLCOPT` (user agent / referrer / origin),
 * `#EXTHTTP` JSON headers, `#KODIPROP` license properties (→ drm) and stream headers, Kodi pipe headers
 * (`url|User-Agent=…`), relative URLs (resolved against `baseUrl`) and plain URL-per-line lists. Directives
 * apply to the next URL only. Channels are plain objects that must be treated as immutable; channels with the
 * same group-title share one frozen `groups` array.
 *
 * Problems never throw: they are summarized in `warnings` (one human-readable sentence per problem type).
 * An HLS manifest (a single stream, not a channel list) yields `meta.isHlsManifest = true` and no channels.
 *
 * @param {string} text playlist content
 * @param {{ baseUrl?: string }} [options] URL the playlist was downloaded from (for relative links)
 * @returns {{
 *   channels: object[],
 *   meta: { title: string, epgUrl: string, attrs: Record<string, string>, isHlsManifest: boolean },
 *   warnings: string[],
 * }}
 */
export function parseM3U(text, { baseUrl } = {}) {
  const meta = { title: '', epgUrl: '', attrs: {}, isHlsManifest: false };
  const channels = [];
  const warnings = [];
  if (typeof text !== 'string' || !text) return { channels, meta, warnings };

  if (isHlsManifest(text)) {
    meta.isHlsManifest = true;
    return { channels, meta, warnings };
  }

  const parsedBase = baseUrl ? tryParseUrl(baseUrl) : null;
  const base =
    parsedBase && (parsedBase.protocol === 'http:' || parsedBase.protocol === 'https:') ? parsedBase : null;

  const source = text.charCodeAt(0) === CH_BOM ? text.slice(1) : text;
  const lines = source.indexOf('\r') === -1 ? source.split('\n') : source.split(LINE_SPLIT_RE);

  const idCounts = new Map();
  const groupCache = new Map();
  const extGroupCache = new Map();
  const unsupportedSchemes = new Set();
  let unsupportedCount = 0;
  let drmCount = 0;
  let invalidCount = 0;
  let relativeCount = 0;
  let orphanCount = 0;

  // Pending per-entry state; reset after every URL line ("directives apply to the next URL only").
  let entry = null; // { duration, attrs, title } from #EXTINF
  let extGroup = '';
  let extImage = '';
  let headers = null;
  let drm = false;

  const resetPending = () => {
    entry = null;
    extGroup = '';
    extImage = '';
    headers = null;
    drm = false;
  };

  // Channels with the same group-title share one frozen groups array (less work, far less memory).
  const groupsFor = (raw) => {
    let groups = groupCache.get(raw);
    if (groups === undefined) {
      const list = splitGroups(raw);
      groups = list.length ? Object.freeze(list) : null;
      groupCache.set(raw, groups);
    }
    return groups;
  };
  // #EXTGRP names a single group (no ';' splitting).
  const singleGroup = (raw) => {
    let groups = extGroupCache.get(raw);
    if (groups === undefined) {
      const name = displayText(raw, MAX_GROUP_LENGTH);
      groups = name ? Object.freeze([name]) : null;
      extGroupCache.set(raw, groups);
    }
    return groups;
  };

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li].trim();
    if (!line) continue;

    if (line.charCodeAt(0) === CH_HASH) {
      if (hasTag(line, '#EXTINF')) {
        if (entry) orphanCount++;
        entry = parseExtinf(directiveValue(line, 7));
      } else if (hasTag(line, '#EXTVLCOPT')) {
        const value = directiveValue(line, 10);
        const eq = value.indexOf('=');
        if (eq > 0) {
          applyHeader((headers ||= {}), value.slice(0, eq).trim().toLowerCase(), unquote(value.slice(eq + 1)));
        }
      } else if (hasTag(line, '#KODIPROP')) {
        const value = directiveValue(line, 9);
        const eq = value.indexOf('=');
        const propValue = eq > 0 ? value.slice(eq + 1).trim() : '';
        if (propValue) {
          const key = value.slice(0, eq).trim().toLowerCase();
          if (
            key.endsWith('license_type') ||
            key.endsWith('license_key') ||
            key === 'inputstream.adaptive.drm' ||
            key === 'inputstream.adaptive.drm_legacy'
          ) {
            drm = true;
          } else if (key.endsWith('.stream_headers') || key.endsWith('.manifest_headers')) {
            // inputstream.adaptive.stream_headers=User-Agent=…&Referer=… (same encoding as pipe headers)
            parsePipeHeaders(propValue, (headers ||= {}));
          }
        }
      } else if (hasTag(line, '#EXTGRP')) {
        extGroup = directiveValue(line, 7);
      } else if (hasTag(line, '#EXTIMG')) {
        extImage = directiveValue(line, 7);
      } else if (hasTag(line, '#EXTHTTP')) {
        parseExtHttp(directiveValue(line, 8), (headers ||= {}));
      } else if (hasTag(line, '#EXTM3U')) {
        scanAttributes(directiveValue(line, 7), 0, meta.attrs);
      } else if (hasTag(line, '#PLAYLIST')) {
        if (!meta.title) meta.title = displayText(directiveValue(line, 9));
      }
      continue; // other tags and comments are ignored
    }

    // URL line (some generators wrap it in quotes), optionally followed by Kodi pipe headers.
    const first = line.charCodeAt(0);
    const urlLine = first === CH_DQUOTE || first === CH_SQUOTE ? unquote(line) : line;
    const pipe = urlLine.indexOf('|');
    const target = classifyUrl(pipe === -1 ? urlLine : urlLine.slice(0, pipe).trim(), base);

    if (target.kind === 'text') {
      // Stray text: drop it but keep the pending #EXTINF for the real URL that may follow.
      invalidCount++;
      continue;
    }
    if (target.kind === 'invalid' || target.kind === 'relative') {
      if (target.kind === 'invalid') invalidCount++;
      else relativeCount++;
      resetPending();
      continue;
    }

    const attrs = entry ? entry.attrs : {};

    // Header precedence: EXTINF attributes < #EXTVLCOPT / #EXTHTTP < pipe headers.
    const channelHeaders = {};
    const attrAgent = attrs['http-user-agent'] || attrs['user-agent'];
    if (attrAgent) channelHeaders.userAgent = attrAgent;
    const attrReferrer =
      attrs['http-referrer'] || attrs['http-referer'] || attrs.referrer || attrs.referer;
    if (attrReferrer) channelHeaders.referrer = attrReferrer;
    if (headers) Object.assign(channelHeaders, headers);
    if (pipe !== -1) parsePipeHeaders(urlLine.slice(pipe + 1), channelHeaders);

    const position = channels.length;
    const rawTitle = entry ? entry.title : '';
    const title = displayText(rawTitle);
    const rawTvgName = attrs['tvg-name'];
    const tvgName = rawTvgName ? (rawTvgName === rawTitle ? title : displayText(rawTvgName)) : '';
    const name = title || tvgName || deriveName(target.url, position + 1);

    const groups =
      (attrs['group-title'] && groupsFor(attrs['group-title'])) ||
      (extGroup && singleGroup(extGroup)) ||
      (attrs['tvg-group'] && groupsFor(attrs['tvg-group'])) ||
      NO_GROUPS;

    const logo =
      resolveLogo(attrs['tvg-logo'], base) || resolveLogo(attrs.logo, base) || resolveLogo(extImage, base);

    const baseId = makeChannelId(name, target.url);
    const seen = idCounts.get(baseId) || 0;
    idCounts.set(baseId, seen + 1);

    if (target.kind === 'stream') {
      unsupportedCount++;
      unsupportedSchemes.add(target.scheme);
    }
    if (drm) drmCount++;

    const tvgId = attrs['tvg-id'];
    channels.push({
      id: seen === 0 ? baseId : `${baseId}~${seen + 1}`,
      index: position,
      name,
      url: target.url,
      group: groups[0],
      groups,
      logo,
      tvgId: tvgId ? decodeEntities(tvgId) : '',
      tvgName,
      chno: parseChno(attrs),
      duration: entry ? entry.duration : -1,
      attrs,
      headers: channelHeaders,
      drm,
    });
    resetPending();
  }
  if (entry) orphanCount++;

  meta.epgUrl = findEpgUrl(meta.attrs, base);

  // One summary warning per problem type, most important first.
  if (unsupportedCount) {
    const schemes = [...unsupportedSchemes].slice(0, 3).map((s) => `${s}://`).join(', ');
    const more = unsupportedSchemes.size > 3 ? ', …' : '';
    warnings.push(
      `${plural(unsupportedCount, 'channel uses a protocol', 'channels use protocols')} browsers can’t play ` +
        `(${schemes}${more}).`,
    );
  }
  if (drmCount) {
    warnings.push(
      `${plural(drmCount, 'channel is', 'channels are')} DRM-protected and can’t play in the browser.`,
    );
  }
  if (invalidCount) {
    warnings.push(
      `Skipped ${plural(invalidCount, 'line that isn’t', 'lines that aren’t')} a valid stream URL.`,
    );
  }
  if (relativeCount) {
    warnings.push(
      `Skipped ${plural(relativeCount, 'relative link', 'relative links')} — ` +
        'load the playlist from its URL so they can be resolved.',
    );
  }
  if (orphanCount) {
    warnings.push(`Skipped ${plural(orphanCount, 'entry', 'entries')} without a stream URL.`);
  }

  return { channels, meta, warnings };
}

/**
 * Group channels by their groups, in order of first appearance. A channel counts once in each of its groups.
 * `firstIndex` is the `index` of the first channel in the group (its array position for snapshot channels).
 * @param {object[]} channels
 * @returns {Array<{ name: string, count: number, firstIndex: number }>}
 */
export function groupChannels(channels) {
  if (!Array.isArray(channels)) return [];
  const map = new Map();
  for (let i = 0; i < channels.length; i++) {
    const ch = channels[i];
    if (!ch) continue;
    const groups = Array.isArray(ch.groups) && ch.groups.length ? ch.groups : [ch.group || UNCATEGORIZED];
    const position = typeof ch.index === 'number' && ch.index >= 0 ? ch.index : i;
    for (let g = 0; g < groups.length; g++) {
      const name = groups[g];
      if (!name || (g > 0 && groups.indexOf(name) !== g)) continue; // count a channel once per group
      const group = map.get(name);
      if (group) group.count++;
      else map.set(name, { name, count: 1, firstIndex: position });
    }
  }
  return [...map.values()];
}

/**
 * Text the parser entity-decodes (titles, tvg-name, group-title, tvg-id, logos): an `&` that would start an
 * entity is written as `&amp;`, so "A &lt; B" (literally) survives a serialize → parse round trip. A plain
 * "A & B" is left alone, which keeps exports readable for other players.
 */
const escapeText = (value) => oneLine(value).replace(ENTITY_START_RE, '&amp;');

/** Attribute value for export: single line, double quotes escaped as an entity. */
const escapeAttr = (value) => oneLine(value).replace(/"/g, '&quot;');

/** Attribute value the parser entity-decodes: entity starts and double quotes escaped. */
const escapeDecodedAttr = (value) => escapeText(value).replace(/"/g, '&quot;');

/** Attributes rewritten from the canonical Channel fields on export (so they never appear twice). */
const CANONICAL_ATTRS = new Set([
  'tvg-id', 'tvg-name', 'tvg-logo', 'logo', 'tvg-chno', 'channel-number', 'tvg-num', 'group-title',
]);

/**
 * Serialize channels to an extended M3U playlist (playlist / favorites exports).
 * One `#EXTINF` + URL per channel; attribute values are single-line with `"` escaped as `&quot;` (and, in the
 * fields the parser entity-decodes, `&` escaped where it would start an entity); headers are written as
 * `#EXTVLCOPT` lines. Parsing the output yields the same names, URLs, ids, groups, logos, tvg ids, tvg names,
 * channel numbers, durations and headers. DRM license properties are not part of the Channel model, so `drm`
 * does not survive an export.
 * @param {object[]} channels Channel objects or snapshot channels
 * @param {{ title?: string, epgUrl?: string }} [options]
 * @returns {string}
 */
export function serializeM3U(channels, { title, epgUrl } = {}) {
  const out = [epgUrl ? `#EXTM3U x-tvg-url="${escapeDecodedAttr(epgUrl)}"` : '#EXTM3U'];
  const playlistTitle = escapeText(title);
  if (playlistTitle) out.push(`#PLAYLIST:${playlistTitle}`);

  for (const ch of Array.isArray(channels) ? channels : []) {
    if (!ch || typeof ch !== 'object') continue;
    const url = oneLine(ch.url);
    if (!url || url.startsWith('#')) continue;

    const parts = [];
    const add = (key, value, escape = escapeDecodedAttr) => {
      const v = value === null || value === undefined ? '' : String(value);
      if (v) parts.push(`${key}="${escape(v)}"`);
    };
    add('tvg-id', ch.tvgId);
    add('tvg-name', ch.tvgName);
    add('tvg-logo', ch.logo);
    add('tvg-chno', Number.isFinite(ch.chno) ? ch.chno : '', escapeAttr);

    let groups = Array.isArray(ch.groups) && ch.groups.length ? ch.groups : [ch.group];
    groups = groups.filter((g) => typeof g === 'string' && g.trim());
    if (groups.length === 1 && groups[0] === UNCATEGORIZED) groups = [];
    // A single group containing ';' goes into #EXTGRP so it isn't split into several groups on re-import.
    const extGroup = groups.length === 1 && groups[0].includes(';') ? groups[0] : '';
    if (groups.length && !extGroup) add('group-title', groups.join(';'));

    if (ch.attrs && typeof ch.attrs === 'object') {
      for (const [key, value] of Object.entries(ch.attrs)) {
        if (CANONICAL_ATTRS.has(key) || !ATTR_KEY_RE.test(key)) continue;
        parts.push(`${key}="${escapeAttr(value)}"`);
      }
    }

    const duration = Number.isFinite(ch.duration) ? ch.duration : -1;
    const name = escapeText(ch.name) || 'Untitled';
    out.push(`#EXTINF:${duration}${parts.length ? ` ${parts.join(' ')}` : ''},${name}`);
    if (extGroup) out.push(`#EXTGRP:${escapeText(extGroup)}`);

    const h = ch.headers && typeof ch.headers === 'object' ? ch.headers : {};
    if (h.userAgent) out.push(`#EXTVLCOPT:http-user-agent=${oneLine(h.userAgent)}`);
    if (h.referrer) out.push(`#EXTVLCOPT:http-referrer=${oneLine(h.referrer)}`);
    if (h.origin) out.push(`#EXTVLCOPT:http-origin=${oneLine(h.origin)}`);
    out.push(url);
  }
  return `${out.join('\n')}\n`;
}
