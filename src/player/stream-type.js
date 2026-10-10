// Pure helpers for figuring out how a stream URL should be played. No DOM access, no side effects
// (except the network request in sniffStreamType), so everything here is unit-testable in Node.

import { tryParseUrl } from '../lib/utils.js';

/** Protocols that browsers can never play (no plugin APIs exist for them). */
const UNSUPPORTED_PROTOCOLS = new Set([
  'rtmp:', 'rtmps:', 'rtmpe:', 'rtmpt:', 'rtmpte:', 'rtmfp:',
  'rtsp:', 'rtsps:', 'rtspu:',
  'udp:', 'rtp:', 'srt:', 'igmp:',
  'mms:', 'mmsh:', 'mmst:', 'mmsu:',
]);

/** Protocols we try to play (everything else is unsupported, e.g. acestream://, magnet:). */
const PLAYABLE_PROTOCOLS = new Set(['http:', 'https:', 'blob:', 'data:', 'file:']);

const HLS_EXT = new Set(['m3u8', 'm3u']);
const MPEGTS_EXT = new Set(['ts', 'mts', 'm2ts', 'm2t', 'mp2t']);
const FLV_EXT = new Set(['flv']);
const NATIVE_EXT = new Set([
  'mp4', 'm4v', 'webm', 'ogv', 'ogg', 'oga', 'mov', 'mp3', 'aac', 'm4a', 'opus', 'wav', 'flac', 'mkv',
]);
const DASH_EXT = new Set(['mpd']);

/** Query-string keys whose values commonly hint at the container (Xtream Codes, middleware, CDNs). */
const QUERY_HINT_KEYS = ['type', 'format', 'output', 'ext', 'extension', 'container', 'stream_type'];

/** Base used to parse protocol-relative or relative URLs for extension detection only. */
const DETECT_BASE = 'http://stream.invalid/';

/**
 * Classify a stream URL without touching the network.
 *
 * Order: protocol → pathname extension → query hints → path heuristics. Returns 'unknown' when nothing
 * matched (e.g. Xtream style `http://host:8080/user/pass/1234`) — the player then sniffs the stream.
 *
 * @param {string} url
 * @returns {'hls'|'mpegts'|'flv'|'native'|'dash'|'unsupported'|'unknown'}
 */
export function detectStreamType(url) {
  const raw = String(url ?? '').trim();
  if (!raw) return 'unknown';

  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(raw);
  if (scheme) {
    const protocol = `${scheme[1].toLowerCase()}:`;
    if (UNSUPPORTED_PROTOCOLS.has(protocol)) return 'unsupported';
    if (!PLAYABLE_PROTOCOLS.has(protocol)) return 'unsupported';
    if (protocol === 'blob:' || protocol === 'data:') return detectDataOrBlob(raw);
  }

  const parsed = tryParseUrl(raw) || tryParseUrl(raw, DETECT_BASE);
  if (!parsed) return 'unknown';

  // 1. Extension of the last non-empty path segment.
  const segments = parsed.pathname.split('/').filter(Boolean);
  const last = segments.length ? safeDecode(segments[segments.length - 1]).toLowerCase() : '';
  const dot = last.lastIndexOf('.');
  if (dot >= 0) {
    const fromExt = typeFromExtension(last.slice(dot + 1));
    if (fromExt) return fromExt;
  }

  // 2. Query-string hints (type=m3u8, output=ts, format=hls…).
  for (const key of QUERY_HINT_KEYS) {
    for (const value of parsed.searchParams.getAll(key)) {
      const hint = typeFromHint(value);
      if (hint) return hint;
    }
  }

  // 3. Path heuristics.
  const path = safeDecode(parsed.pathname).toLowerCase();
  if (path.includes('/hls/') || path.includes('m3u8')) return 'hls';
  if (path.includes('format=mpd')) return 'dash'; // Unified Streaming: .ism/manifest(format=mpd-time-csf)
  if (safeDecode(parsed.search).toLowerCase().includes('.m3u8')) return 'hls';

  return 'unknown';
}

function detectDataOrBlob(raw) {
  if (/^data:application\/(vnd\.apple\.mpegurl|x-mpegurl)/i.test(raw)) return 'hls';
  if (/^data:(video|audio)\//i.test(raw)) return 'native';
  return 'unknown';
}

function typeFromExtension(ext) {
  if (HLS_EXT.has(ext)) return 'hls';
  if (MPEGTS_EXT.has(ext)) return 'mpegts';
  if (FLV_EXT.has(ext)) return 'flv';
  if (NATIVE_EXT.has(ext)) return 'native';
  if (DASH_EXT.has(ext)) return 'dash';
  return null;
}

function typeFromHint(value) {
  const v = String(value || '').trim().toLowerCase().replace(/^\./, '');
  if (v === 'm3u8' || v === 'hls' || v === 'm3u8-aapl') return 'hls';
  if (v === 'ts' || v === 'mpegts' || v === 'mpeg-ts' || v === 'm2ts') return 'mpegts';
  if (v === 'flv') return 'flv';
  if (v === 'mpd' || v === 'dash') return 'dash';
  if (v === 'mp4' || v === 'webm') return 'native';
  return null;
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Rewrite an `http:` URL to `https:` (same host, path and query; default port dropped).
 * Any other input is returned unchanged.
 * @param {string} url
 * @returns {string}
 */
export function upgradeToHttps(url) {
  const raw = String(url ?? '').trim();
  const parsed = tryParseUrl(raw);
  if (!parsed || parsed.protocol !== 'http:') return raw;
  parsed.protocol = 'https:'; // an explicit :443 becomes the default port and is dropped
  return parsed.href;
}

/** Hosts browsers treat as "potentially trustworthy": http:// requests to them are not blocked. */
function isLoopbackHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '::1' ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  );
}

/**
 * True when loading `url` from a page served over `pageProtocol` would be blocked as mixed content
 * (https page + http stream). Loopback hosts are exempt, as in all modern browsers.
 * @param {string} url
 * @param {string} [pageProtocol]
 * @returns {boolean}
 */
export function isMixedContent(url, pageProtocol = globalThis.location?.protocol) {
  if (String(pageProtocol || '').toLowerCase() !== 'https:') return false;
  const parsed = tryParseUrl(String(url ?? '').trim());
  if (!parsed || parsed.protocol !== 'http:') return false;
  return !isLoopbackHost(parsed.hostname);
}

/**
 * Names that only resolve on this machine or a local network: the ones the stream relay refuses too (see
 * isPrivateHost() in proxy/stream-proxy.js). Single-label names (`tvheadend`, `nas`) are local as well.
 */
const LOCAL_NAME_RE = /(?:^|\.)(?:localhost|local|localdomain|internal|intranet|lan|home|corp|home\.arpa)$/;
/** The authority (`user@host:port`) of an http(s) URL, as the URL parser delimits it. */
const HTTP_AUTHORITY_RE = /^[\x00-\x20]*https?:\/\/([^/?#\\]*)/i;
const OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
/** IPv4 in the URL parser's own spelling (no leading zeros, hex or shortened forms such as `127.1`). */
const CANONICAL_IPV4_RE = new RegExp(`^${OCTET}\\.${OCTET}\\.${OCTET}\\.${OCTET}$`);
const PLAIN_NAME_RE = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*$/;
/** A numeric last label makes the URL parser read the host as an IPv4 address (`0x7f.1`, `3232235777`). */
const NUMERIC_LABEL_RE = /(?:^|\.)(?:\d+|0x[0-9a-f]*)$/;

/**
 * The host of an http(s) URL — lowercased, without userinfo and port — when the URL parser would keep it as
 * written (a plain DNS name or a canonical IPv4 address), else null. Spares parsing the common URLs.
 */
function plainHttpHost(url) {
  const authority = HTTP_AUTHORITY_RE.exec(url)?.[1];
  if (authority === undefined) return null;
  const hostPort = authority.slice(authority.lastIndexOf('@') + 1);
  const port = /:(\d*)$/.exec(hostPort);
  if (port && port[1].length > 4) return null; // may be out of range: let the parser judge the URL
  const host = (port ? hostPort.slice(0, port.index) : hostPort).toLowerCase();
  if (CANONICAL_IPV4_RE.test(host)) return host;
  return PLAIN_NAME_RE.test(host) && !NUMERIC_LABEL_RE.test(host) ? host : null;
}

function isPrivateIpv4(octets) {
  const [a, b] = octets;
  return (
    a === 0 || // "this network", incl. 0.0.0.0
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // shared address space (carrier-grade NAT)
    (a === 169 && b === 254) || // link-local
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

/** @param {string} text  an IPv6 address as the URL parser serializes it (lowercase hex, no brackets) */
function isPrivateIpv6(text) {
  const halves = text.split('::');
  if (halves.length > 2) return false;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0) return false;
  const w = [...head, ...Array(fill).fill('0'), ...tail].map((word) =>
    /^[0-9a-f]{1,4}$/.test(word) ? parseInt(word, 16) : NaN);
  if (w.length !== 8 || !w.every((word) => word >= 0)) return false;
  const zeros = (from, to) => w.slice(from, to).every((word) => word === 0);
  const v4 = () => [w[6] >> 8, w[6] & 0xff, w[7] >> 8, w[7] & 0xff];
  if (zeros(0, 7) && w[7] <= 1) return true; // :: and ::1
  if (zeros(0, 5) && (w[5] === 0xffff || w[5] === 0)) return isPrivateIpv4(v4()); // IPv4-mapped / -compatible
  return (w[0] & 0xfe00) === 0xfc00 || (w[0] & 0xffc0) === 0xfe80; // unique-local fc00::/7, link-local fe80::/10
}

function isPrivateNetworkHost(host) {
  if (host.startsWith('[')) return isPrivateIpv6(host.slice(1, -1));
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (v4) return isPrivateIpv4(v4.slice(1).map(Number));
  const name = host.endsWith('.') ? host.slice(0, -1) : host;
  return name !== '' && (!name.includes('.') || LOCAL_NAME_RE.test(name));
}

/**
 * True when an http(s) URL points at this computer or a local network: a loopback, private (10/8, 172.16/12,
 * 192.168/16), link-local (169.254/16), shared (100.64/10) or 0/8 IPv4 address; an IPv6 loopback,
 * unique-local (fc00::/7), link-local (fe80::/10) or IPv4-mapped one of those; `localhost`, a single-label
 * name or a local-only domain (`.local`, `.lan`, `.home.arpa` …). A stream relay on the internet can't reach
 * such a host (and refuses to try). Only literals are judged: what a public name resolves to is up to DNS.
 * @param {string} url
 * @returns {boolean}
 */
export function isPrivateNetworkUrl(url) {
  const raw = typeof url === 'string' ? url : '';
  if (!raw) return false;
  let host = plainHttpHost(raw);
  if (host === null) {
    const parsed = tryParseUrl(raw);
    if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) return false;
    host = parsed.hostname.toLowerCase();
  }
  return isPrivateNetworkHost(host);
}

/** How many bytes we want before classifying (TS needs ≥ 3 packets + an offset; 2 KB is plenty). */
const SNIFF_WANT_BYTES = 2048;
/** Hard cap: never buffer more than this, then cancel the body. */
const SNIFF_MAX_BYTES = 64 * 1024;

/**
 * Fetch the first bytes of a stream and classify it by signature (falling back to Content-Type).
 * Any failure (CORS, network, timeout, abort, non-2xx) resolves to null — this never rejects.
 *
 * @param {string} url
 * @param {{ signal?: AbortSignal, timeoutMs?: number }} [options]
 * @returns {Promise<'hls'|'mpegts'|'flv'|'native'|null>}
 */
export async function sniffStreamType(url, { signal, timeoutMs = 5000 } = {}) {
  if (typeof globalThis.fetch !== 'function') return null;
  const parsed = tryParseUrl(String(url ?? '').trim());
  if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) return null;
  if (signal?.aborted) return null;

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener?.('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), Math.max(0, timeoutMs));
  let reader = null;

  try {
    const res = await globalThis.fetch(parsed.href, {
      signal: controller.signal,
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'follow',
    });
    if (!res || (!res.ok && res.status !== 206)) return null;

    const contentType = String(res.headers?.get?.('content-type') || '').toLowerCase();
    let bytes = new Uint8Array(0);
    try {
      if (res.body && typeof res.body.getReader === 'function') {
        reader = res.body.getReader();
        bytes = await readPrefix(reader);
      } else if (typeof res.arrayBuffer === 'function') {
        bytes = new Uint8Array(await res.arrayBuffer()).subarray(0, SNIFF_MAX_BYTES);
      }
    } catch {
      // Body read failed or timed out — the Content-Type may still be enough.
    }

    const fromBytes = classifyBytes(bytes);
    if (fromBytes) return fromBytes;
    const fromType = classifyContentType(contentType);
    if (fromType) return fromType;
    if (res.url && res.url !== parsed.href) {
      const redirected = detectStreamType(res.url);
      if (redirected === 'hls' || redirected === 'mpegts' || redirected === 'flv' || redirected === 'native') {
        return redirected;
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onAbort);
    if (reader) {
      try {
        reader.cancel().catch(() => {});
      } catch {
        /* already released */
      }
    }
    controller.abort();
  }
}

async function readPrefix(reader) {
  const chunks = [];
  let total = 0;
  while (total < SNIFF_WANT_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value && value.byteLength) {
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      chunks.push(chunk);
      total += chunk.byteLength;
      if (total >= SNIFF_MAX_BYTES) break;
    }
  }
  const out = new Uint8Array(Math.min(total, SNIFF_MAX_BYTES));
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= out.length) break;
    const part = chunk.subarray(0, out.length - offset);
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const ascii = (bytes, start, length) => {
  let s = '';
  for (let i = start; i < start + length && i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
};

/** Look for MPEG-TS sync bytes (0x47) repeating at the packet size (188, 192 for M2TS, 204 with FEC). */
function hasTsSync(bytes) {
  for (const size of [188, 192, 204]) {
    if (bytes.length <= size) continue;
    const maxOffset = Math.min(size, bytes.length - size);
    for (let o = 0; o < maxOffset; o++) {
      if (bytes[o] !== 0x47 || bytes[o + size] !== 0x47) continue;
      // Confirm with a third packet when we have the data (avoids random matches in binary data).
      if (o + 2 * size < bytes.length && bytes[o + 2 * size] !== 0x47) continue;
      return true;
    }
  }
  return false;
}

/**
 * Classify the first bytes of a stream.
 * @param {Uint8Array} bytes
 * @returns {'hls'|'mpegts'|'flv'|'native'|null}
 */
export function classifyBytes(bytes) {
  if (!bytes || !bytes.length) return null;

  // Text: skip a UTF-8 BOM and leading whitespace.
  let start = 0;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) start = 3;
  while (start < bytes.length && (bytes[start] === 0x20 || bytes[start] === 0x09 || bytes[start] === 0x0a ||
    bytes[start] === 0x0d)) start++;
  if (ascii(bytes, start, 7) === '#EXTM3U') return 'hls';

  if (ascii(bytes, 0, 3) === 'FLV') return 'flv';
  if (hasTsSync(bytes)) return 'mpegts';

  const box = ascii(bytes, 4, 4);
  if (box === 'ftyp' || box === 'styp' || box === 'moov') return 'native';
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return 'native'; // EBML
  const magic4 = ascii(bytes, 0, 4);
  if (magic4 === 'OggS' || magic4 === 'fLaC') return 'native';
  if (magic4 === 'RIFF' && ascii(bytes, 8, 4) === 'WAVE') return 'native';
  if (ascii(bytes, 0, 3) === 'ID3') return 'native';
  // MPEG audio / ADTS AAC frame sync (11 set bits).
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return 'native';

  // A playlist preceded by junk/comments.
  const head = ascii(bytes, start, Math.min(bytes.length - start, 1024));
  if (head.includes('#EXTINF') || head.includes('#EXT-X-')) return 'hls';
  return null;
}

/**
 * Classify a Content-Type header value.
 * @param {string} contentType
 * @returns {'hls'|'mpegts'|'flv'|'native'|null}
 */
export function classifyContentType(contentType) {
  const type = String(contentType || '').split(';')[0].trim().toLowerCase();
  if (!type) return null;
  if (type.includes('mpegurl')) return 'hls';
  if (type.includes('mp2t') || type.includes('mpegts') || type === 'video/m2ts') return 'mpegts';
  if (type === 'video/x-flv' || type === 'video/flv') return 'flv';
  if (type.includes('dash+xml')) return null;
  if (type.startsWith('video/') || type.startsWith('audio/')) return 'native';
  return null;
}

/**
 * Exponential backoff with symmetric jitter, capped at `max`.
 * attempt 1 → ~base, 2 → ~2×base, 3 → ~4×base … (each ±jitter), never above `max` and never negative.
 *
 * @param {number} attempt  1-based attempt number
 * @param {{ base?: number, max?: number, jitter?: number }} [options]
 * @returns {number} delay in ms (integer)
 */
export function backoffDelay(attempt, { base = 1000, max = 15000, jitter = 0.2 } = {}) {
  const n = Math.max(1, Math.floor(Number(attempt)) || 1);
  const safeBase = Math.max(0, Number(base) || 0);
  const safeMax = Math.max(0, Number(max) || 0);
  const raw = Math.min(safeMax, safeBase * 2 ** Math.min(n - 1, 30));
  const j = Math.min(1, Math.max(0, Number(jitter) || 0));
  const factor = 1 + (Math.random() * 2 - 1) * j;
  return Math.round(Math.min(safeMax, Math.max(0, raw * factor)));
}
