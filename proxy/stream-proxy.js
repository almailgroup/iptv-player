// IPTV stream relay: a tiny, dependency-free relay that lets the IPTV Player (a static https:// site) play
// what browsers block on secure pages: insecure http:// streams (mixed content) and servers that send no CORS
// headers. It fetches the stream server-side and returns it over HTTPS with CORS headers.
//
// - Runs unmodified on Cloudflare Workers, Deno (`deno serve`) and Bun; proxy/deno.js is the entry point for
//   Deno Deploy and proxy/node-server.mjs adapts it to Node.js. Only web-standard APIs are used (fetch,
//   Request, Response, URL, Headers, TextDecoder).
// - Media is streamed through untouched (never buffered). HLS playlists, recognized by their first bytes
//   whatever their content type, are rewritten so that every variant, segment, key and rendition they
//   reference is fetched through the relay too.
// - Requests: `GET <relay>/?url=<encodeURIComponent(target)>` (canonical) or `GET <relay>/<target>`
//   (cors-anywhere style). `GET <relay>/` or `<relay>/?health` is a health check for the app's "Test" button.
// - Only pages from ALLOWED_ORIGINS may use it. It won't fetch localhost or private-network addresses, not
//   even through redirects (it follows them itself and checks every hop) or, given a `resolveHost` hook (as
//   proxy/deno.js and proxy/node-server.mjs pass), host names that point at them. It relays playlists and
//   media only: 2xx text, data and unlabeled bodies are refused unless they are playlists. It is not a web
//   proxy.
//
// Deployment guide and security notes: proxy/README.md.

/** Relay protocol version, reported by the health check. */
export const VERSION = 1;

/**
 * Web pages allowed to use this relay: exact origins (scheme://host[:port]). A single '*' entry allows every
 * website (not recommended: anyone could spend your bandwidth). Keep this declaration on ONE line — the app's
 * setup guide replaces the whole line with your site's origin.
 */
// prettier-ignore
export const ALLOWED_ORIGINS = ['https://almailgroup.github.io', 'http://localhost:5173', 'http://localhost:4173', 'http://127.0.0.1:5173', 'http://127.0.0.1:4173'];

const SERVICE_NAME = 'iptv-stream-relay';
const MAX_TARGET_LENGTH = 8192;
/** Redirects followed (and checked hop by hop) before giving up with 508. */
const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
/** Playlists up to this size are rewritten; anything larger is passed through untouched. */
const MAX_PLAYLIST_BYTES = 8 * 1024 * 1024;
/** How much of a body is read to tell whether it is an M3U playlist. */
const PEEK_BYTES = 1024;
/** "#EXTM3U", the first line of every M3U playlist. */
const M3U_SIGNATURE = [0x23, 0x45, 0x58, 0x54, 0x4d, 0x33, 0x55];
const UTF8_BOM = [0xef, 0xbb, 0xbf];
/**
 * Upstream content types of text, data, scripts and documents (text/html, JSON, XML, SVG …): a 2xx body of one
 * of these (or without a usable type) is relayed only when it starts with #EXTM3U or with the bytes of a media
 * format (see sniffMediaType), else refused with 415. The relay is for playlists and media, not a web proxy;
 * and what a private service answers is mostly text.
 */
const TEXTUAL_TYPE_RE = /^(?:text\/.*|application\/(?:json|xml|javascript|x-javascript|ecmascript)|.+\+(?:json|xml))$/;
/** Exceptions to TEXTUAL_TYPE_RE: media served with a text type (WebVTT subtitle segments of HLS streams). */
const TEXTUAL_MEDIA_TYPES = new Set(['text/vtt']);
/** Placeholder types that browsers treat like a missing one (they sniff the body). */
const UNKNOWN_TYPES = new Set(['*/*', 'unknown/unknown', 'application/unknown']);
/** MPEG-TS packets are 188 bytes, each starting with this sync byte. */
const TS_PACKET_BYTES = 188;
const TS_SYNC_BYTE = 0x47;
/** ISO-BMFF (MP4 / fMP4 / CMAF) boxes a media file or segment starts with. */
const BMFF_FIRST_BOXES = new Set(['ftyp', 'styp', 'moof', 'moov', 'sidx', 'emsg', 'prft']);
/** Sent when the client has no User-Agent; many IPTV servers only talk to "real" players. */
const DEFAULT_USER_AGENT = 'VLC/3.0.20 LibVLC/3.0.20';

const ALLOW_METHODS = 'GET, HEAD, OPTIONS';
const ALLOW_HEADERS = 'Range, Content-Type, Accept';
const EXPOSE_HEADERS = 'Content-Length, Content-Range, Accept-Ranges, Content-Type, X-Relay-Final-Url';
/** The only client headers passed upstream — never cookies, credentials, Origin or Referer. */
const FORWARDED_REQUEST_HEADERS = [
  'Range',
  'Accept',
  'Accept-Language',
  'User-Agent',
  'If-None-Match',
  'If-Modified-Since',
];
/** The only upstream headers passed back to the client (no cookies, server banners, CSP, CORS …). */
const COPIED_RESPONSE_HEADERS = [
  'Content-Type',
  'Content-Length',
  'Content-Range',
  'Accept-Ranges',
  'Cache-Control',
  'ETag',
  'Last-Modified',
  'Expires',
];
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

const HLS_TAG_RE = /^[ \t﻿]*#EXT-X-(?:TARGETDURATION|STREAM-INF|MEDIA-SEQUENCE|PLAYLIST-TYPE|MAP)\b/m;
const PLAYLIST_PATH_RE = /\.m3u8?$/i;
/** A Content-Range of a whole body: `bytes 0-(n-1)/n`. */
const WHOLE_RANGE_RE = /^bytes\s+0-(\d+)\/(\d+)$/i;
const LINE_BREAK_RE = /(\r\n|\n|\r)/;
/** The `#EXT…:` prefix of a tag line, before its attribute list. */
const TAG_PREFIX_RE = /^\s*#EXT[A-Z0-9-]*:/;
/** One `NAME=` of an attribute list (sticky: matched at a given position). */
const ATTRIBUTE_NAME_RE = /[ \t]*([A-Za-z0-9_-]+)=/y;
/** Attributes whose value is a URI: `URI`, `*-URI` (SERVER-URI, X-ASSET-URI …) and `X-ASSET-LIST`. */
const URI_ATTRIBUTE_NAME_RE = /^(?:URI|[A-Z0-9-]+-URI|X-ASSET-LIST)$/;
/** Host names that only resolve on this machine or a private network. */
const LOCAL_NAME_RE = /\.(?:localhost|local|localdomain|internal|intranet|lan|home|corp|home\.arpa)$/;

/**
 * Handle one relay request and return the response to send. Never throws: unexpected failures become a plain
 * 500 (no stack traces), an unreachable upstream a 502.
 *
 * - `OPTIONS` → CORS preflight (204) for allowed origins; `GET`/`HEAD` are relayed; other methods → 405.
 * - No target (`/` or `?health`) → health check JSON, with CORS headers only for allowed origins. Any other
 *   path without a target → 404.
 * - The caller's origin comes from `Origin`, else from `Referer` (native <video> requests send no Origin) and
 *   must be in `allowedOrigins` → else 403.
 * - Targets must be absolute http(s) URLs without credentials (400), at most 8192 characters long (414) and
 *   not on localhost / a private network (403) unless `allowPrivateTargets` is set. Where the relay itself
 *   runs (the request's URL or Host) never matters: both are up to the client.
 * - With `resolveHost`, a target host name is looked up first: a name with any private address is refused
 *   (403), one that doesn't resolve answers 502. fetch() then resolves the name again on its own, so a DNS
 *   answer that changes in between (DNS rebinding) is not caught; IP literals are never looked up.
 * - A target on the relay's own host and port (the request URL's) is refused with 400, so the relay can't be
 *   made to call itself in a loop (as far as it can recognize its own address).
 * - Redirects are followed here, up to 5 (else 508), and every hop is checked like the target before it is
 *   requested.
 * - A 2xx body must be a playlist or media: one with a text, data, script or document type (`text/*` except
 *   `text/vtt`, JSON, XML, JavaScript, SVG …) or no usable type at all is refused with 415 unless it starts
 *   with `#EXTM3U` or with the bytes of a media format (MPEG-TS, MP4, WebM, FLV, packed audio), which is
 *   then relabeled with that format's type (a HEAD, which has no body to check, is refused unless the path
 *   ends in `.m3u8` / `.m3u`).
 * - HLS playlists (up to 8 MB) are rewritten so every URI they reference goes through the relay; everything
 *   else is streamed through untouched. `Range` is not forwarded to `.m3u8` / `.m3u` paths, and a 206 that
 *   holds the whole body is rewritten (and answered) like a 200; other 206s are never rewritten.
 *
 * @param {Request} request
 * @param {{ allowedOrigins?: string[] | string, fetchImpl?: typeof fetch, allowPrivateTargets?: boolean,
 *   resolveHost?: (hostname: string) => Promise<string[]> }} [options] `allowedOrigins`: exact origins, or
 *   `['*']` for everyone; `fetchImpl`: the fetch for upstream requests; `allowPrivateTargets`: also relay
 *   localhost / private-network targets (only for testing, or a relay on a trusted home network);
 *   `resolveHost`: the IP addresses a host name resolves to (IPv4 and IPv6), for the private-network check;
 *   it may resolve to `null` when lookups are unavailable on the platform (the name is then not checked).
 * @returns {Promise<Response>}
 */
export async function handleRequest(
  request,
  { allowedOrigins = ALLOWED_ORIGINS, fetchImpl = fetch, allowPrivateTargets = false, resolveHost } = {},
) {
  try {
    // Strictly `true`: a stray truthy value (e.g. the string "false" from a config file) must not unlock it.
    const allowPrivate = allowPrivateTargets === true;
    const resolve = typeof resolveHost === 'function' ? resolveHost : null;
    return await route(request, { allowedOrigins, fetchImpl, allowPrivate, resolveHost: resolve });
  } catch {
    return textResponse(500, 'Relay error');
  }
}

async function route(request, { allowedOrigins, fetchImpl, allowPrivate, resolveHost }) {
  const url = new URL(request.url);
  const method = String(request.method || 'GET').toUpperCase();
  const allowOrigin = corsOriginFor(request, allowedOrigins);
  const cors = allowOrigin ? corsHeaders(allowOrigin) : {};

  if (method === 'OPTIONS') {
    return allowOrigin ? preflightResponse(request, allowOrigin) : textResponse(403, 'Origin not allowed');
  }
  if (method !== 'GET' && method !== 'HEAD') {
    return textResponse(405, 'Method not allowed', { ...cors, Allow: ALLOW_METHODS });
  }

  const requested = readTarget(url);
  if (!requested) {
    if (url.pathname === '/' || url.searchParams.has('health')) return healthResponse(cors, method);
    return textResponse(404, 'Not found', cors, method);
  }
  if (!allowOrigin) return textResponse(403, 'Origin not allowed', {}, method);

  const parsed = parseTarget(requested.raw);
  if (parsed.error) return textResponse(parsed.status, parsed.error, cors, method);
  const target = parsed.target;
  const policy = { allowPrivate, resolveHost, self: endpointOf(url) }; // see refusal()
  const refused = await refusal(target, policy);
  if (refused) return textResponse(refused.status, refused.error, cors, method);
  if (requested.form === 'query') appendDeliveryDirectives(target, url);

  const relayBase = requested.form === 'path' ? `${url.origin}/` : `${url.origin}${url.pathname}?url=`;
  const toProxyUrl =
    requested.form === 'path' ? (abs) => relayBase + abs : (abs) => relayBase + encodeURIComponent(abs);
  return relay({ request, method, target, cors, policy, toProxyUrl, fetchImpl });
}

// ---------------------------------------------------------------------------------------------------------
// Origins & CORS

/** The Access-Control-Allow-Origin value for this request ('*' or the caller's origin); '' when refused. */
function corsOriginFor(request, allowedOrigins) {
  const entries = Array.isArray(allowedOrigins) ? allowedOrigins : String(allowedOrigins ?? '').split(',');
  const allowed = entries.map((entry) => String(entry ?? '').trim()).filter(Boolean);
  if (allowed.includes('*')) return '*';
  const origin = callerOrigin(request);
  if (!origin) return '';
  return allowed.some((entry) => parseOrigin(entry) === origin) ? origin : '';
}

/** The page origin behind a request: the `Origin` header, else the origin of the `Referer`. */
function callerOrigin(request) {
  const origin = request.headers.get('Origin');
  if (origin !== null) return parseOrigin(origin); // "null" (sandboxed / opaque) is never allowed
  const referer = request.headers.get('Referer');
  return referer ? parseOrigin(referer) : '';
}

/** Normalized `scheme://host[:port]` of a URL or origin (lower-case, default port dropped), or ''. */
function parseOrigin(value) {
  const url = tryParseUrl(String(value).trim());
  return url && url.origin !== 'null' ? url.origin : '';
}

function corsHeaders(allowOrigin) {
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Expose-Headers': EXPOSE_HEADERS,
    Vary: 'Origin',
  };
}

function preflightResponse(request, allowOrigin) {
  const headers = new Headers({
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': ALLOW_METHODS,
    'Access-Control-Allow-Headers': ALLOW_HEADERS,
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  });
  // Chrome's Private Network Access preflight, sent when an https:// page talks to a relay on this computer.
  if (request.headers.get('Access-Control-Request-Private-Network') === 'true') {
    headers.set('Access-Control-Allow-Private-Network', 'true');
  }
  return new Response(null, { status: 204, headers });
}

// ---------------------------------------------------------------------------------------------------------
// Targets

/**
 * Extract the requested target: path form (`/http://host/x.m3u8?a=1`, everything after the first `/`) or
 * query form (`/?url=<encoded>`). Returns null when the request names no target.
 * @returns {{ form: 'path' | 'query', raw: string } | null}
 */
function readTarget(url) {
  const path = url.pathname.slice(1);
  if (/^https?(?::|%3a)/i.test(path)) {
    let raw = path + url.search;
    if (/^https?%3a/i.test(raw)) raw = safeDecodeURIComponent(raw); // a fully encoded target
    // Proxies in front of the relay may merge the slashes in "/https://…" into one.
    return { form: 'path', raw: raw.replace(/^(https?):\/*/i, '$1://') };
  }
  if (url.searchParams.has('url')) return { form: 'query', raw: url.searchParams.get('url').trim() };
  return null;
}

/**
 * The checks of form every URL the relay requests must pass (the target and each redirect hop): an absolute
 * http(s) URL, not too long, without credentials. See refusal() for where it may lead.
 * @param {string} raw
 * @returns {{ target: URL, error?: undefined } | { error: string, status: number }}
 */
function parseTarget(raw) {
  if (!raw) return { status: 400, error: 'Missing target URL' };
  if (raw.length > MAX_TARGET_LENGTH) return { status: 414, error: 'Target URL too long' };
  const target = tryParseUrl(raw);
  if (!target || !isHttpUrl(target) || !target.hostname) {
    return { status: 400, error: 'Invalid target URL (use an absolute http:// or https:// URL)' };
  }
  if (target.href.length > MAX_TARGET_LENGTH) return { status: 414, error: 'Target URL too long' };
  if (target.username || target.password) {
    return { status: 400, error: 'Credentials in the target URL are not allowed' };
  }
  return { target };
}

/**
 * Why the relay won't request `target` (a URL that passed parseTarget()), or null when it may: a private host
 * (403) unless `allowPrivate`, the relay itself (400), and with `resolveHost` a host name that has a private
 * address (403) or doesn't resolve (502).
 * @param {URL} target
 * @param {{ allowPrivate: boolean, resolveHost: ((hostname: string) => Promise<string[]>) | null,
 *   self: string }} policy  `self`: the relay's own endpoint (see endpointOf())
 * @returns {Promise<{ status: number, error: string } | null>}
 */
async function refusal(target, { allowPrivate, resolveHost, self }) {
  if (!allowPrivate && isPrivateHost(target.hostname)) return { status: 403, error: 'Target not allowed' };
  if (endpointOf(target) === self) return { status: 400, error: 'Refusing to relay to itself' };
  if (allowPrivate || !resolveHost || isIpLiteral(target.hostname)) return null;
  let addresses;
  try {
    addresses = await resolveHost(target.hostname);
  } catch {
    return { status: 502, error: 'Upstream unreachable' };
  }
  if (addresses === null) return null; // lookups unavailable on this platform: same as having no resolver
  if (!Array.isArray(addresses) || !addresses.length) return { status: 502, error: 'Upstream unreachable' };
  // ANY private address: which one fetch() picks is up to it.
  return addresses.some((address) => isPrivateHost(String(address)))
    ? { status: 403, error: 'Target not allowed' }
    : null;
}

/** `host:port` of a URL with the port always spelled out and no trailing dot, to compare endpoints. */
function endpointOf(url) {
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  return `${url.hostname.replace(/\.$/, '')}:${port}`;
}

/** Whether a URL hostname is an IP address (the URL parser has already canonicalized IPv4 spellings). */
function isIpLiteral(hostname) {
  return hostname.startsWith('[') || parseIpv4(hostname.replace(/\.$/, '')) !== null;
}

/**
 * Low-latency HLS players append delivery directives (`_HLS_msn`, `_HLS_part`, `_HLS_skip`) to the playlist
 * URL; in the query form they land on the relay URL, so pass them on to the real playlist.
 */
function appendDeliveryDirectives(target, url) {
  const directives = [];
  for (const [key, value] of url.searchParams) {
    if (key.startsWith('_HLS_')) directives.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
  }
  if (!directives.length) return;
  target.search = `${target.search ? `${target.search}&` : '?'}${directives.join('&')}`;
}

/**
 * Whether `host` (a URL hostname or a bare IP address) is this machine or a private network: `localhost`,
 * `*.localhost`, single-label names and private-use domains (`.local`, `.internal`, `.home.arpa` …), plus
 * loopback, private, link-local, shared (100.64/10), unique-local, documentation (TEST-NET-1/2/3,
 * 2001:db8::/32), multicast and reserved IP addresses — including IPv4 addresses embedded in IPv6
 * (`::ffff:127.0.0.1`, `::ffff:0:127.0.0.1`, NAT64). None of these is reachable on the public internet; where
 * one is routed at all, it leads into a private network. Only the name or address itself is checked: what a
 * host name resolves to is handleRequest's `resolveHost` hook's business.
 * @param {string} host
 * @returns {boolean}
 */
export function isPrivateHost(host) {
  let name = String(host ?? '')
    .trim()
    .toLowerCase();
  if (!name || /[\s/\\@?#]/.test(name)) return false;
  if (!name.startsWith('[') && name.includes(':')) name = `[${name.replace(/%.*$/, '')}]`; // bare IPv6
  // The URL parser canonicalizes 127.1, 0x7f.0.0.1, 2130706433, [::ffff:127.0.0.1] … to one spelling.
  const parsed = tryParseUrl(`http://${name}/`);
  if (!parsed) return false;
  name = parsed.hostname.replace(/\.$/, '');
  if (name.startsWith('[')) return isPrivateIpv6(name.slice(1, -1));
  const v4 = parseIpv4(name);
  if (v4) return isPrivateIpv4(v4);
  return !name.includes('.') || LOCAL_NAME_RE.test(name);
}

function parseIpv4(name) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(name);
  if (!match) return null;
  const octets = match.slice(1).map(Number);
  return octets.every((octet) => octet <= 255) ? octets : null;
}

function isPrivateIpv4([a, b, c]) {
  return (
    a === 0 || // "this network", incl. 0.0.0.0
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // shared address space (carrier-grade NAT)
    (a === 169 && b === 254) || // link-local, incl. cloud metadata endpoints
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) || // IETF protocol assignments, TEST-NET-1
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51 && c === 100) || // TEST-NET-2
    (a === 203 && b === 0 && c === 113) || // TEST-NET-3
    a >= 224 // multicast, reserved, broadcast
  );
}

/** @param {string} text  canonical (URL-serialized) IPv6 address without brackets */
function isPrivateIpv6(text) {
  const halves = text.split('::');
  if (halves.length > 2) return false;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  const w = [...head, ...Array(Math.max(fill, 0)).fill('0'), ...tail].map((word) => parseInt(word, 16));
  if (w.length !== 8 || w.some((word) => !(word >= 0 && word <= 0xffff))) return false;

  const zeros = (from, to) => w.slice(from, to).every((word) => word === 0);
  const v4 = (hi, lo) => [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];
  if (zeros(0, 8) || (zeros(0, 7) && w[7] === 1)) return true; // :: and ::1
  if (zeros(0, 5) && w[5] === 0xffff) return isPrivateIpv4(v4(w[6], w[7])); // IPv4-mapped
  if (zeros(0, 4) && w[4] === 0xffff && w[5] === 0) return isPrivateIpv4(v4(w[6], w[7])); // IPv4-translated
  if (zeros(0, 6)) return isPrivateIpv4(v4(w[6], w[7])); // IPv4-compatible (deprecated)
  if (w[0] === 0x64 && w[1] === 0xff9b && zeros(2, 6)) return isPrivateIpv4(v4(w[6], w[7])); // NAT64
  if (w[0] === 0x64 && w[1] === 0xff9b && w[2] === 1) return true; // local-use NAT64 64:ff9b:1::/48
  if (w[0] === 0x2002) return isPrivateIpv4(v4(w[1], w[2])); // 6to4
  return (
    (w[0] & 0xfe00) === 0xfc00 || // unique local fc00::/7
    (w[0] & 0xffc0) === 0xfe80 || // link-local fe80::/10
    (w[0] & 0xffc0) === 0xfec0 || // site-local fec0::/10 (deprecated)
    (w[0] === 0x2001 && w[1] === 0xdb8) || // documentation 2001:db8::/32
    (w[0] & 0xff00) === 0xff00 // multicast
  );
}

// ---------------------------------------------------------------------------------------------------------
// Relaying

async function relay({ request, method, target, cors, policy, toProxyUrl, fetchImpl }) {
  const upstreamHeaders = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) upstreamHeaders.set(name, value);
  }
  if (!upstreamHeaders.has('User-Agent')) upstreamHeaders.set('User-Agent', DEFAULT_USER_AGENT);

  const fetched = await fetchUpstream(target, {
    method,
    headers: upstreamHeaders,
    signal: request.signal,
    fetchImpl,
    policy,
  });
  if (fetched.error) return textResponse(fetched.status, fetched.error, cors, method);
  const { upstream, finalUrl } = fetched;

  const status = upstream.status;
  const type = mimeType(upstream.headers.get('Content-Type'));
  const urls = [target, finalUrl];
  const playlistPath = urls.some((url) => PLAYLIST_PATH_RE.test(url.pathname));
  // A 2xx text, data or unlabeled body is relayed only if it turns out to be a playlist (see TEXTUAL_TYPE_RE).
  const mustBePlaylist = status >= 200 && status < 300 && !NULL_BODY_STATUSES.has(status) && isTextual(type);

  const headers = new Headers(cors);
  for (const name of COPIED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  // fetch() hands over the body already decoded, so a compressed length no longer matches it.
  const encoding = (upstream.headers.get('Content-Encoding') || '').trim().toLowerCase();
  if (encoding && encoding !== 'identity') headers.delete('Content-Length');
  headers.set('X-Relay-Final-Url', finalUrl.href);
  headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
  // Defense in depth: never let relayed content run as a page on the relay's own origin, or be read as
  // anything but its declared type.
  headers.set('Content-Security-Policy', 'sandbox');
  headers.set('X-Content-Type-Options', 'nosniff');

  const media = !mustBePlaylist && isClearlyMedia(type, urls);

  if (method === 'HEAD' || NULL_BODY_STATUSES.has(status) || !upstream.body) {
    discard(upstream.body);
    // A HEAD has no body to check: only a playlist address gets the benefit of the doubt.
    if (method === 'HEAD' && mustBePlaylist && !playlistPath) {
      return textResponse(415, 'Not a media stream', cors, method);
    }
    // A GET of what looks like a playlist could be rewritten, and then it has another length.
    const playlistLike = type.includes('mpegurl') || playlistPath;
    if (status === 200 && !media && playlistLike) headers.delete('Content-Length');
    return new Response(null, { status, headers });
  }

  // A 206 of the whole body (a player asked for `bytes=0-`) is as good as a 200; other ranges are never
  // rewritten, since the result would no longer match the range.
  const whole = status === 200 || (status === 206 && isWholeRange(upstream.headers.get('Content-Range')));
  const declaredLength = Number(upstream.headers.get('Content-Length'));
  const rewritable = whole && !media && !(declaredLength > MAX_PLAYLIST_BYTES);
  if (!mustBePlaylist && !rewritable) return new Response(upstream.body, { status, headers });

  // Whatever the content type says, only the first bytes tell whether this is a playlist: servers label
  // playlists text/plain or octet-stream, and endless TS streams sit at .m3u8 paths.
  const reader = upstream.body.getReader();
  let read;
  try {
    read = await peekM3u(reader);
    if (read.isM3u && rewritable) read = await readUpTo(reader, read, MAX_PLAYLIST_BYTES);
  } catch {
    reader.cancel().catch(() => {});
    return textResponse(502, 'Upstream unreachable', cors, method);
  }
  if (!read.isM3u && mustBePlaylist) {
    // Media mislabeled as text or not labeled at all (Apache serves `.ts` files as
    // text/vnd.trolltech.linguist) still plays: its first bytes tell, and no page or API answer starts so.
    let sniffed = '';
    try {
      sniffed = await peekMediaType(reader, read);
    } catch {
      reader.cancel().catch(() => {});
      return textResponse(502, 'Upstream unreachable', cors, method);
    }
    if (!sniffed) {
      reader.cancel().catch(() => {});
      return textResponse(415, 'Not a media stream', cors, method);
    }
    headers.set('Content-Type', sniffed);
  }
  // Not a playlist, a partial one, or too big to rewrite: replay what was read, then the rest, untouched.
  if (!read.isM3u || !rewritable || !read.complete) {
    return new Response(replayStream(read.chunks, reader), { status, headers });
  }

  headers.delete('Content-Length');
  const bytes = concatBytes(read.chunks, read.size);
  const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
  if (!isHlsPlaylist(text)) return new Response(bytes, { status, headers }); // e.g. a channel list

  headers.set('Content-Type', 'application/vnd.apple.mpegurl');
  headers.set('Cache-Control', 'no-store');
  // Validators and ranges describe the upstream bytes, not the rewrite.
  headers.delete('Accept-Ranges');
  headers.delete('Content-Range');
  headers.delete('ETag');
  return new Response(rewritePlaylist(text, finalUrl.href, toProxyUrl), { status: 200, headers });
}

/**
 * Fetch `target`, following redirects here rather than in fetch() so that every hop passes the same checks
 * as the target itself (form, private hosts, the relay itself, DNS) BEFORE anything is sent to it. Method and
 * forwarded headers stay the same on every hop, except that `Range` is never sent to a `.m3u8` / `.m3u` path
 * (a partial playlist couldn't be rewritten). A redirect without a Location is handed back as it is.
 * @returns {Promise<{ upstream: Response, finalUrl: URL, error?: undefined }
 *   | { status: number, error: string }>}
 */
async function fetchUpstream(target, { method, headers, signal, fetchImpl, policy }) {
  let url = target;
  for (let redirects = 0; ; redirects++) {
    let hopHeaders = headers;
    if (headers.has('Range') && PLAYLIST_PATH_RE.test(url.pathname)) {
      hopHeaders = new Headers(headers);
      hopHeaders.delete('Range');
    }
    let upstream;
    try {
      upstream = await fetchImpl(url.href, { method, headers: hopHeaders, redirect: 'manual', signal });
    } catch {
      return { status: 502, error: 'Upstream unreachable' };
    }
    // A missing response, or an opaque redirect (status 0) from a runtime that hides them.
    if (!upstream || !upstream.headers || !(upstream.status >= 200 && upstream.status <= 599)) {
      discard(upstream?.body);
      return { status: 502, error: 'Upstream unreachable' };
    }

    const location = REDIRECT_STATUSES.has(upstream.status) ? upstream.headers.get('Location') : null;
    if (!location) return settle(upstream, url, policy);
    discard(upstream.body);
    if (redirects >= MAX_REDIRECTS) return { status: 508, error: 'Too many redirects' };

    const next = resolveUrl(location.trim(), url.href);
    const parsed = next ? parseTarget(next.href) : null;
    // A malformed Location is the upstream's fault; a hop that is refused is answered like such a target.
    if (!parsed || parsed.error) return { status: 502, error: 'Invalid redirect from upstream' };
    const refused = await refusal(parsed.target, policy);
    if (refused) return refused;
    url = parsed.target;
  }
}

/**
 * The final upstream response and the URL it came from. Should a fetch() follow redirects on its own despite
 * `redirect: 'manual'` (none of the supported runtimes does), it reports where it ended up: what a refused
 * address answered is never handed out.
 */
async function settle(upstream, requested, policy) {
  const reported = tryParseUrl(upstream.url || '');
  if (!reported || !isHttpUrl(reported) || reported.href === requested.href) {
    return { upstream, finalUrl: requested };
  }
  const refused = await refusal(reported, policy);
  if (refused) {
    discard(upstream.body);
    return refused;
  }
  return { upstream, finalUrl: reported };
}

/** The lower-case MIME type of a Content-Type header, without parameters ('' when missing). */
function mimeType(contentType) {
  return String(contentType || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
}

/**
 * Whether a 2xx body of this MIME type must turn out to be a playlist to be relayed: text, data, scripts and
 * documents (TEXTUAL_TYPE_RE, except the M3U and WebVTT types), and a missing, malformed or unknown type.
 */
function isTextual(type) {
  if (type.includes('mpegurl') || TEXTUAL_MEDIA_TYPES.has(type)) return false;
  return !/^[^/]+\/[^/]+$/.test(type) || UNKNOWN_TYPES.has(type) || TEXTUAL_TYPE_RE.test(type);
}

/**
 * Whether the upstream says the body is media or other binary data that can't be a playlist: `video/*` and
 * `audio/*` (except the M3U types), `image/*`, and octet-stream unless the path ends in `.m3u8` / `.m3u`.
 * Everything else is peeked at.
 */
function isClearlyMedia(type, urls) {
  if (type.includes('mpegurl')) return false;
  if (type.startsWith('video/') || type.startsWith('audio/') || type.startsWith('image/')) return true;
  if (type.endsWith('/octet-stream')) return !urls.some((url) => PLAYLIST_PATH_RE.test(url.pathname));
  return false;
}

/** Whether a Content-Range header covers a whole body: `bytes 0-(n-1)/n`. */
function isWholeRange(contentRange) {
  const match = WHOLE_RANGE_RE.exec(String(contentRange || '').trim());
  return Boolean(match) && Number(match[1]) + 1 === Number(match[2]);
}

/**
 * Read the first chunk(s) of a body, up to PEEK_BYTES, just until it is clear whether it starts like an M3U
 * playlist. The chunks read are returned for replaying.
 * @param {ReadableStreamDefaultReader} reader
 * @returns {Promise<{ isM3u: boolean, chunks: Uint8Array[], size: number, complete: boolean }>}
 */
async function peekM3u(reader) {
  const chunks = [];
  let size = 0;
  let head = new Uint8Array(0);
  for (;;) {
    const { done, value } = await reader.read();
    if (!done) {
      const chunk = toBytes(value);
      if (chunk.byteLength) {
        chunks.push(chunk);
        size += chunk.byteLength;
        if (head.byteLength < PEEK_BYTES) {
          const more = chunk.subarray(0, PEEK_BYTES - head.byteLength);
          head = concatBytes([head, more], head.byteLength + more.byteLength);
        }
      }
    }
    const isM3u = startsLikeM3u(head, done || head.byteLength >= PEEK_BYTES);
    if (isM3u !== undefined) return { isM3u, chunks, size, complete: done };
  }
}

/**
 * Keep reading a body that isn't a playlist (`read`, from peekM3u) until its first bytes show whether it is
 * media (see sniffMediaType). The chunks read are added to `read` for replaying.
 * @param {ReadableStreamDefaultReader} reader
 * @param {{ chunks: Uint8Array[], size: number, complete: boolean }} read
 * @returns {Promise<string>} the media type the bytes show, or ''
 */
async function peekMediaType(reader, read) {
  for (;;) {
    const head = firstBytes(read.chunks, PEEK_BYTES);
    const type = sniffMediaType(head, read.complete || head.byteLength >= PEEK_BYTES);
    if (type !== undefined) return type;
    const { done, value } = await reader.read();
    if (done) {
      read.complete = true;
    } else {
      const chunk = toBytes(value);
      read.chunks.push(chunk);
      read.size += chunk.byteLength;
    }
  }
}

/**
 * The media type that `head`, the first bytes of a body, shows: MPEG-TS (a sync byte at 0 and 188), MP4 /
 * fMP4 (an ISO-BMFF box such as `ftyp` or `moof` of a plausible size), WebM / Matroska (EBML), FLV, and packed
 * audio (an ID3 tag, ADTS AAC, MP2 / MP3 frames). '' for anything else, `undefined` while more bytes are
 * needed to tell (never when `final`). None of these starts like text, so no page or API answer gets through.
 * @param {Uint8Array} head
 * @param {boolean} final  no more bytes will come
 * @returns {string | undefined}
 */
function sniffMediaType(head, final) {
  const n = head.byteLength;
  const short = () => (final ? false : undefined); // the bytes ran out before it was clear
  /** Whether `head` starts with `bytes`: true / false, or undefined while it fits so far. */
  const starts = (bytes) => {
    for (let i = 0; i < bytes.length; i++) {
      if (i >= n) return short();
      if (head[i] !== bytes[i]) return false;
    }
    return true;
  };
  /** Each returns the type, false, or undefined (more bytes needed). */
  const detectors = [
    () => {
      const sync = starts([TS_SYNC_BYTE]);
      if (sync !== true) return sync;
      if (n > TS_PACKET_BYTES) return head[TS_PACKET_BYTES] === TS_SYNC_BYTE && 'video/mp2t';
      return final ? n === TS_PACKET_BYTES && 'video/mp2t' : undefined; // a single packet is a whole body
    },
    () => {
      const small = starts([0]); // a first box under 16 MB (a text byte would make it far larger)
      if (small !== true) return small;
      if (n < 8) return short();
      const size = (head[1] << 16) | (head[2] << 8) | head[3];
      const box = String.fromCharCode(head[4], head[5], head[6], head[7]);
      return BMFF_FIRST_BOXES.has(box) && (size >= 8 || size === 1) && 'video/mp4';
    },
    () => starts([0x1a, 0x45, 0xdf, 0xa3]) && 'video/webm', // EBML
    () => starts([0x46, 0x4c, 0x56, 0x01]) && 'video/x-flv', // "FLV" 1
    () => {
      const tag = starts([0x49, 0x44, 0x33]); // "ID3"
      if (tag !== true) return tag;
      if (n < 4) return short();
      return head[3] >= 2 && head[3] <= 4 && 'audio/aac'; // ID3v2.2–2.4 (HLS packed audio)
    },
    () => {
      const sync = starts([0xff]);
      if (sync !== true) return sync;
      if (n < 3) return short();
      // ADTS: 12 sync bits, layer 0, a valid sampling rate.
      if ((head[1] & 0xf6) === 0xf0) return ((head[2] >> 2) & 0x0f) < 13 && 'audio/aac';
      // MPEG audio layer II / III: 11 sync bits, a valid bitrate and sampling rate. (Layer I is left out: FF FE
      // is also the byte order mark of UTF-16 text.)
      const layer = head[1] & 0x06;
      const valid = (head[2] & 0xf0) !== 0xf0 && (head[2] & 0x0c) !== 0x0c;
      return (head[1] & 0xe0) === 0xe0 && (layer === 0x02 || layer === 0x04) && valid && 'audio/mpeg';
    },
  ];
  let pending = false;
  for (const detect of detectors) {
    const type = detect();
    if (type) return type;
    if (type === undefined) pending = true;
  }
  return pending ? undefined : '';
}

/**
 * Whether `head`, the first bytes of a body, starts with `#EXTM3U` after an optional UTF-8 BOM and
 * whitespace; `undefined` while more bytes are needed to tell (never when `final`).
 * @param {Uint8Array} head
 * @param {boolean} final  no more bytes will come
 * @returns {boolean | undefined}
 */
function startsLikeM3u(head, final) {
  let i = 0;
  while (i < UTF8_BOM.length && i < head.length && head[i] === UTF8_BOM[i]) i++;
  if (i > 0 && i < UTF8_BOM.length) return i === head.length && !final ? undefined : false; // part of a BOM
  while (i < head.length && isWhitespaceByte(head[i])) i++;
  for (const byte of M3U_SIGNATURE) {
    if (i >= head.length) return final ? false : undefined;
    if (head[i++] !== byte) return false;
  }
  return true;
}

function isWhitespaceByte(byte) {
  return byte === 0x20 || (byte >= 0x09 && byte <= 0x0d); // space, \t \n \v \f \r
}

/**
 * Keep reading a body whose first `read.chunks` were already read, up to `limit` bytes in all. `complete`
 * tells whether the whole body fit; if not, `chunks` holds what was read and `reader` the rest.
 * @param {ReadableStreamDefaultReader} reader
 * @param {{ chunks: Uint8Array[], size: number, complete: boolean }} read
 * @param {number} limit
 */
async function readUpTo(reader, { chunks, size, complete }, limit) {
  const result = { isM3u: true, chunks, size, complete };
  while (!result.complete && result.size <= limit) {
    const { done, value } = await reader.read();
    if (done) {
      result.complete = true;
    } else {
      const chunk = toBytes(value);
      chunks.push(chunk);
      result.size += chunk.byteLength;
    }
  }
  if (result.size > limit) result.complete = false;
  return result;
}

/** A body that replays `chunks` (already read) followed by the rest of `reader`, with backpressure. */
function replayStream(chunks, reader) {
  let index = 0;
  return new ReadableStream({
    async pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(chunks[index]);
        chunks[index++] = null; // release it once handed over
        return;
      }
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(toBytes(value));
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

/** The first `max` bytes (or fewer) of `chunks`, copied into one array. */
function firstBytes(chunks, max) {
  const parts = [];
  let size = 0;
  for (const chunk of chunks) {
    if (size >= max) break;
    const part = chunk.subarray(0, max - size);
    parts.push(part);
    size += part.byteLength;
  }
  return concatBytes(parts, size);
}

function concatBytes(chunks, size) {
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function toBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (typeof value === 'string') return new TextEncoder().encode(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return new Uint8Array(value);
}

/** Release an unused upstream body (it's not needed and would otherwise hold the connection). */
function discard(body) {
  try {
    body?.cancel?.()?.catch?.(() => {});
  } catch {
    /* already locked or consumed */
  }
}

// ---------------------------------------------------------------------------------------------------------
// Playlists

/**
 * Whether `text` is an HLS media or master playlist (it has `#EXT-X-TARGETDURATION`, `#EXT-X-STREAM-INF`,
 * `#EXT-X-MEDIA-SEQUENCE`, `#EXT-X-PLAYLIST-TYPE` or `#EXT-X-MAP`). An IPTV channel list (`#EXTINF` entries
 * with tvg-* attributes) is not, so it is never rewritten.
 * @param {string} text
 * @returns {boolean}
 */
export function isHlsPlaylist(text) {
  return typeof text === 'string' && HLS_TAG_RE.test(text);
}

/**
 * Rewrite an HLS playlist so every URI it references goes through the relay: URI lines and, in the attribute
 * lists of tag lines, the quoted values of every `URI` attribute (EXT-X-KEY, EXT-X-MAP, EXT-X-MEDIA,
 * EXT-X-I-FRAME-STREAM-INF, EXT-X-PART, EXT-X-PRELOAD-HINT, EXT-X-RENDITION-REPORT, EXT-X-SESSION-KEY,
 * EXT-X-SESSION-DATA …), of every `*-URI` attribute (EXT-X-CONTENT-STEERING's SERVER-URI, EXT-X-DATERANGE's
 * X-ASSET-URI …) and of `X-ASSET-LIST` are resolved against `baseUrl` and, when http(s), replaced with
 * `toProxyUrl(absoluteUrl)`. Attribute lists are parsed with their quoting, so text inside another quoted
 * value (even `,URI="`) is never mistaken for an attribute; `#EXTINF` titles are free text and left alone.
 * `data:`, `skd:` and other URIs, line endings and all other content are kept exactly as they are.
 * @param {string} text
 * @param {string} baseUrl  the URL the playlist was really loaded from (after redirects)
 * @param {(absoluteUrl: string) => string} toProxyUrl
 * @returns {string}
 */
export function rewritePlaylist(text, baseUrl, toProxyUrl) {
  const proxify = (uri) => {
    if (!uri.trim()) return uri;
    const absolute = resolveUrl(uri.trim(), baseUrl);
    return absolute && isHttpUrl(absolute) ? toProxyUrl(absolute.href) : uri;
  };
  const parts = String(text ?? '').split(LINE_BREAK_RE); // [line, break, line, break, …, line]
  for (let i = 0; i < parts.length; i += 2) parts[i] = rewriteLine(parts[i], proxify);
  return parts.join('');
}

function rewriteLine(line, proxify) {
  const content = line.trim(); // trim() also strips a BOM
  if (!content) return line;
  if (content.startsWith('#')) {
    // Comments carry no URIs, and an #EXTINF title is free text, not an attribute list.
    if (!content.startsWith('#EXT') || content.startsWith('#EXTINF:')) return line;
    return rewriteAttributeUris(line, proxify);
  }
  const start = line.length - line.trimStart().length;
  return line.slice(0, start) + proxify(content) + line.slice(start + content.length);
}

/**
 * Rewrite the URI attributes in the attribute list of a tag line (`#EXT-X-KEY:METHOD=AES-128,URI="k.bin"`),
 * following the HLS grammar: `NAME=value` pairs separated by commas, where a quoted-string value runs to the
 * next double quote and may contain commas. Parsing stops at the first thing that isn't an attribute (tags
 * such as `#EXT-X-TARGETDURATION:6` have none); the rest of the line is kept as it is.
 */
function rewriteAttributeUris(line, proxify) {
  const prefix = TAG_PREFIX_RE.exec(line);
  if (!prefix) return line;
  let out = '';
  let copied = 0; // line[0, copied) is in `out` already
  let at = prefix[0].length;
  while (at < line.length) {
    ATTRIBUTE_NAME_RE.lastIndex = at;
    const attribute = ATTRIBUTE_NAME_RE.exec(line);
    if (!attribute) break;
    at = ATTRIBUTE_NAME_RE.lastIndex;
    if (line[at] === '"') {
      const close = line.indexOf('"', at + 1);
      if (close < 0) break; // an unterminated quoted string
      if (URI_ATTRIBUTE_NAME_RE.test(attribute[1].toUpperCase())) {
        out += line.slice(copied, at + 1) + proxify(line.slice(at + 1, close));
        copied = close;
      }
      at = close + 1;
    } else {
      const comma = line.indexOf(',', at); // numbers, hex, enumerated strings, resolutions
      at = comma < 0 ? line.length : comma;
    }
    while (line[at] === ' ' || line[at] === '\t') at++;
    if (line[at] !== ',') break;
    at++;
  }
  return out + line.slice(copied);
}

function resolveUrl(uri, baseUrl) {
  try {
    return new URL(uri, baseUrl);
  } catch {
    return tryParseUrl(uri); // no usable base: absolute URIs still work
  }
}

// ---------------------------------------------------------------------------------------------------------
// Helpers

function tryParseUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function isHttpUrl(url) {
  return url.protocol === 'http:' || url.protocol === 'https:';
}

function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function healthResponse(cors, method) {
  const body = JSON.stringify({ ok: true, service: SERVICE_NAME, version: VERSION });
  return new Response(method === 'HEAD' ? null : body, {
    status: 200,
    headers: {
      ...cors,
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function textResponse(status, message, extraHeaders = {}, method = 'GET') {
  return new Response(method === 'HEAD' ? null : message, {
    status,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders,
    },
  });
}

// ---- entry point (the in-app setup guide swaps this block for the chosen platform) ----
export default { fetch: (request) => handleRequest(request) };
