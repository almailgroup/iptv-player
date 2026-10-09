// Playlist downloading and file reading, with friendly, actionable errors.
//
// fetchPlaylist() handles the usual IPTV pain points in a static web app: mixed content (http:// playlists on
// an https:// page → try the https:// version first), servers without CORS headers (optional CORS proxy),
// timeouts / stalled downloads, oversized responses (streaming size cap), and legacy encodings (UTF-8 with a
// windows-1252 fallback; UTF-16 with BOM).

import { isHlsManifest, looksLikeM3U } from './m3u.js';
import { formatBytes, tryParseUrl } from './utils.js';

export const DEFAULT_TIMEOUT_MS = 25000;
export const DEFAULT_MAX_BYTES = 60 * 1024 * 1024;

/** setTimeout() fires immediately for delays above 2^31 − 1 ms; treat larger values as "no timeout". */
const MAX_TIMER_MS = 2147483647;

const ACCEPTED_EXTENSIONS = new Set(['m3u', 'm3u8', 'txt']);
const ACCEPTED_TYPES = new Set([
  'audio/x-mpegurl',
  'audio/mpegurl',
  'application/x-mpegurl',
  'application/mpegurl',
  'application/vnd.apple.mpegurl',
  'text/plain',
]);

/** Error codes, also usable for `err.code === LOAD_ERROR.CORS` style checks. */
export const LOAD_ERROR = Object.freeze({
  INVALID_URL: 'INVALID_URL',
  MIXED_CONTENT: 'MIXED_CONTENT',
  NETWORK: 'NETWORK',
  CORS: 'CORS',
  HTTP: 'HTTP',
  TIMEOUT: 'TIMEOUT',
  EMPTY: 'EMPTY',
  NOT_M3U: 'NOT_M3U',
  TOO_LARGE: 'TOO_LARGE',
  ABORTED: 'ABORTED',
  FILE_TYPE: 'FILE_TYPE',
  READ: 'READ',
});

/**
 * Error thrown by the loader. `code` is one of LOAD_ERROR; `status` is the HTTP status for 'HTTP' errors (else
 * null). `message` is already a friendly sentence suitable for toasts and dialogs. `details` carries context
 * used to tailor the copy (e.g. `{ source: 'url'|'file', viaProxy, timeoutMs, maxBytes, fileName, html,
 * offline, reason }`).
 */
export class PlaylistLoadError extends Error {
  /**
   * @param {string} code
   * @param {string} [message]
   * @param {{ status?: number, cause?: unknown, details?: Record<string, unknown> }} [options]
   */
  constructor(code, message, { status, cause, details } = {}) {
    const info = { ...(details || {}) };
    const httpStatus = typeof status === 'number' && Number.isFinite(status) ? status : null;
    const text = message || buildMessage(code, { ...info, status: httpStatus });
    super(text, cause === undefined ? undefined : { cause });
    this.name = 'PlaylistLoadError';
    this.code = code;
    this.status = httpStatus;
    this.details = info;
  }
}

/** Create a PlaylistLoadError whose message is the friendly copy for its code + details. */
function loadError(code, details = {}, { status, cause } = {}) {
  return new PlaylistLoadError(code, '', { status, cause, details });
}

// ---------------------------------------------------------------------------------------------------------
// URL handling

const SCHEME_RE = /^([a-z][a-z0-9+.-]*):/i;
const WRAPPING_PAIRS = [
  ['"', '"'],
  ["'", "'"],
  ['<', '>'],
  ['“', '”'],
  ['`', '`'],
];

/**
 * Clean up a user-entered playlist URL: trims (and strips wrapping quotes / angle brackets), adds
 * `https://` when the scheme is missing (also for `//host/…` and `host:port/…`) and validates it is an
 * absolute http(s) URL with a plausible host. Returns the normalized href.
 * @param {string} input
 * @returns {string}
 * @throws {PlaylistLoadError} code 'INVALID_URL'
 */
export function normalizePlaylistUrl(input) {
  let value = String(input ?? '').trim();
  for (const [open, close] of WRAPPING_PAIRS) {
    if (value.length > 1 && value.startsWith(open) && value.endsWith(close)) {
      value = value.slice(open.length, -close.length).trim();
    }
  }
  if (!value) throw loadError('INVALID_URL', { reason: 'empty' });

  let candidate = value;
  let implicitScheme = false;
  const scheme = SCHEME_RE.exec(value);
  if (value.startsWith('//')) {
    candidate = `https:${value}`;
    implicitScheme = true;
  } else if (scheme && /^https?$/i.test(scheme[1])) {
    candidate = value;
  } else if (scheme && !/^\d/.test(value.slice(scheme[0].length))) {
    // ftp://, file://, rtmp://, javascript:, data: … ("host:8080/…" is a host with a port, handled below)
    throw loadError('INVALID_URL', { reason: 'scheme', scheme: scheme[1].toLowerCase() });
  } else {
    candidate = `https://${value}`;
    implicitScheme = true;
  }

  const url = tryParseUrl(candidate);
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname) {
    throw loadError('INVALID_URL', { reason: 'syntax' });
  }
  if (implicitScheme && !isPlausibleHost(url.hostname)) throw loadError('INVALID_URL', { reason: 'syntax' });
  if (url.username || url.password) throw loadError('INVALID_URL', { reason: 'credentials' });
  return url.href;
}

/** A bare word like "news" is almost certainly not meant as a host when the user typed no scheme. */
function isPlausibleHost(hostname) {
  return hostname.includes('.') || hostname.startsWith('[') || hostname === 'localhost';
}

/** Loopback hosts are exempt from mixed-content blocking in browsers ("potentially trustworthy"). */
function isLoopbackHost(hostname) {
  const host = hostname.toLowerCase();
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '[::1]' ||
    /^127(?:\.\d{1,3}){3}$/.test(host)
  );
}

function toHttps(href) {
  const url = new URL(href);
  url.protocol = 'https:';
  if (url.port === '80') url.port = '';
  return url.href;
}

/**
 * Build the request URL for a CORS proxy. A `{url}` placeholder is replaced with the encoded target; a proxy
 * ending in `=` (e.g. `https://proxy.example/?url=`) gets the encoded target appended; any other proxy is used
 * as a plain prefix (`https://proxy.example/` + target). Returns '' when the result isn't an http(s) URL.
 * @param {string} proxy
 * @param {string} targetUrl
 * @returns {string}
 */
export function buildProxyUrl(proxy, targetUrl) {
  const base = typeof proxy === 'string' ? proxy.trim() : '';
  if (!base) return '';
  let result;
  if (/\{url\}/i.test(base)) result = base.replace(/\{url\}/gi, encodeURIComponent(targetUrl));
  else if (base.endsWith('=')) result = base + encodeURIComponent(targetUrl);
  else result = base + targetUrl;
  const parsed = tryParseUrl(result);
  return parsed && (parsed.protocol === 'http:' || parsed.protocol === 'https:') ? result : '';
}

// ---------------------------------------------------------------------------------------------------------
// Downloading

/**
 * Download a playlist and return its decoded text.
 *
 * - Validates/normalizes the URL (see normalizePlaylistUrl).
 * - Mixed content: when the page is https: and the URL is http: (not loopback), the https: version is tried
 *   first; if that fails and a `corsProxy` is set, the proxy is tried with the ORIGINAL url; otherwise
 *   'MIXED_CONTENT' is thrown.
 * - A network/CORS failure (fetch TypeError) is retried through `corsProxy` when set, else 'CORS' is thrown
 *   ('NETWORK' when the browser reports being offline).
 * - `timeoutMs` bounds the wait for the response headers and every pause between body chunks (a slow but
 *   steady download of a big playlist is not cut off; a stalled one is). 0/Infinity disables it.
 * - The body is streamed with a `maxBytes` cap ('TOO_LARGE'), decoded as UTF-8 (windows-1252 fallback when the
 *   bytes aren't valid UTF-8 and look like a legacy 8-bit encoding; UTF-16 with BOM) and validated
 *   ('EMPTY', 'NOT_M3U').
 *
 * `finalUrl` is the URL the content really came from (after redirects / the https upgrade); through a proxy
 * it is the original playlist URL (use it as base URL for relative entries).
 *
 * @param {string} url
 * @param {{ signal?: AbortSignal, timeoutMs?: number, corsProxy?: string, maxBytes?: number,
 *   pageProtocol?: string }} [options]
 * @returns {Promise<{ text: string, finalUrl: string, viaProxy: boolean, upgraded: boolean }>}
 * @throws {PlaylistLoadError}
 */
export async function fetchPlaylist(
  url,
  {
    signal,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    corsProxy = '',
    maxBytes = DEFAULT_MAX_BYTES,
    pageProtocol = globalThis.location?.protocol,
  } = {},
) {
  const target = normalizePlaylistUrl(url);
  throwIfAborted(signal);
  const settings = { signal, timeoutMs: sanitizeTimeout(timeoutMs), maxBytes: sanitizeMaxBytes(maxBytes) };
  const proxyUrl = buildProxyUrl(corsProxy, target);
  const parsed = new URL(target);
  const mixed = pageProtocol === 'https:' && parsed.protocol === 'http:' && !isLoopbackHost(parsed.hostname);

  if (mixed) {
    const secureUrl = toHttps(target);
    let upgradeError;
    try {
      const result = await attempt(secureUrl, settings);
      return { text: result.text, finalUrl: result.url || secureUrl, viaProxy: false, upgraded: true };
    } catch (err) {
      if (isTerminal(err)) throw err;
      upgradeError = err;
    }
    if (proxyUrl) return viaProxy(proxyUrl, target, settings);
    throw loadError('MIXED_CONTENT', { url: target }, { cause: upgradeError });
  }

  try {
    const result = await attempt(target, settings);
    return { text: result.text, finalUrl: result.url || target, viaProxy: false, upgraded: false };
  } catch (err) {
    if (proxyUrl && err instanceof PlaylistLoadError && err.code === 'CORS') {
      return viaProxy(proxyUrl, target, settings);
    }
    throw err;
  }
}

async function viaProxy(proxyUrl, target, settings) {
  throwIfAborted(settings.signal);
  try {
    const result = await attempt(proxyUrl, settings);
    return { text: result.text, finalUrl: target, viaProxy: true, upgraded: false };
  } catch (err) {
    if (!(err instanceof PlaylistLoadError)) throw err;
    if (err.code === 'CORS') throw loadError('NETWORK', { viaProxy: true }, { cause: err });
    if (err.details.viaProxy) throw err;
    throw new PlaylistLoadError(err.code, '', {
      status: err.status ?? undefined,
      cause: err.cause,
      details: { ...err.details, viaProxy: true },
    });
  }
}

/** Errors that make further fallbacks pointless. */
function isTerminal(err) {
  if (!(err instanceof PlaylistLoadError)) return true;
  return err.code === 'ABORTED' || err.code === 'TOO_LARGE' || err.details.offline === true;
}

function sanitizeTimeout(ms) {
  const n = Number(ms);
  return Number.isFinite(n) && n > 0 && n <= MAX_TIMER_MS ? n : 0;
}

function sanitizeMaxBytes(n) {
  if (n === Infinity) return Infinity;
  const value = Number(n);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_MAX_BYTES;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw loadError('ABORTED');
}

const isOffline = () => globalThis.navigator?.onLine === false;

/**
 * One request: fetch → status check → capped body read → decode → validate.
 * @returns {Promise<{ text: string, url: string }>}
 */
async function attempt(requestUrl, { signal, timeoutMs, maxBytes }) {
  const controller = new AbortController();
  let timedOut = false;
  let timer = 0;
  const arm = () => {
    if (!timeoutMs) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
  };
  const onCallerAbort = () => controller.abort();
  signal?.addEventListener('abort', onCallerAbort, { once: true });

  /** Map an abort/timeout to its error, or null when it was neither. */
  const abortReason = (cause) => {
    if (signal?.aborted) return loadError('ABORTED', {}, { cause });
    if (timedOut) return loadError('TIMEOUT', { timeoutMs }, { cause });
    return null;
  };

  try {
    arm();
    let response;
    try {
      response = await abortable(
        globalThis.fetch(requestUrl, {
          signal: controller.signal,
          credentials: 'omit',
          cache: 'no-cache',
          redirect: 'follow',
        }),
        controller.signal,
      );
    } catch (err) {
      const aborted = abortReason(err);
      if (aborted) throw aborted;
      if (err?.name === 'AbortError') throw loadError('ABORTED', {}, { cause: err });
      if (isOffline()) throw loadError('NETWORK', { offline: true }, { cause: err });
      // fetch() rejects with a TypeError for DNS/connection failures AND for CORS blocks — scripts can't
      // tell them apart.
      throw loadError('CORS', {}, { cause: err });
    }

    if (!response || typeof response !== 'object') throw loadError('NETWORK', { reason: 'no-response' });
    if (!response.ok) {
      cancelBody(response);
      throw loadError('HTTP', { statusText: response.statusText || '' }, { status: response.status });
    }

    let bytes;
    try {
      bytes = await readBody(response, { maxBytes, signal: controller.signal, onChunk: arm });
    } catch (err) {
      if (err instanceof PlaylistLoadError) throw err;
      const aborted = abortReason(err);
      if (aborted) throw aborted;
      throw loadError('NETWORK', { reason: 'interrupted', offline: isOffline() || undefined }, { cause: err });
    }

    const text = decodePlaylistBytes(bytes);
    validatePlaylistText(text, 'url');
    return { text, url: typeof response.url === 'string' ? response.url : '' };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onCallerAbort);
  }
}

/** Race a promise against an abort signal (some fetch implementations/mocks ignore `signal`). */
function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      Promise.resolve(promise).catch(() => {});
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      return;
    }
    const onAbort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

function cancelBody(response) {
  try {
    const result = response.body?.cancel?.();
    if (result && typeof result.catch === 'function') result.catch(() => {});
  } catch {
    /* body locked or already consumed */
  }
}

/**
 * Read a response body into bytes, enforcing `maxBytes` while streaming.
 * @returns {Promise<Uint8Array>}
 */
async function readBody(response, { maxBytes, signal, onChunk }) {
  const tooLarge = () => loadError('TOO_LARGE', { maxBytes, source: 'url' });
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    cancelBody(response);
    throw tooLarge();
  }

  const body = response.body;
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    const chunks = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await abortable(reader.read(), signal);
        if (done) break;
        if (!value) continue;
        const chunk = toBytes(value);
        total += chunk.byteLength;
        if (total > maxBytes) throw tooLarge();
        chunks.push(chunk);
        onChunk();
      }
    } catch (err) {
      try {
        reader.cancel().catch(() => {});
      } catch {
        /* ignore */
      }
      throw err;
    }
    return concatBytes(chunks, total);
  }

  if (typeof response.arrayBuffer === 'function') {
    const buffer = await abortable(response.arrayBuffer(), signal);
    if (buffer.byteLength > maxBytes) throw tooLarge();
    return new Uint8Array(buffer);
  }
  const text = await abortable(response.text(), signal);
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength > maxBytes) throw tooLarge();
  return bytes;
}

function toBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (typeof value === 'string') return new TextEncoder().encode(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return new Uint8Array(value);
}

function concatBytes(chunks, total) {
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Decoding & validation

/**
 * Decode playlist bytes: UTF-16 when a UTF-16 BOM is present; otherwise UTF-8 (BOM stripped), falling back to
 * windows-1252 when the bytes are not valid UTF-8 and the invalid sequences outnumber the valid non-ASCII
 * characters (i.e. it is a legacy 8-bit file, not a UTF-8 file with a few broken bytes).
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function decodePlaylistBytes(bytes) {
  if (bytes.length >= 2) {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return safeDecode('utf-16le', bytes);
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return safeDecode('utf-16be', bytes);
  }
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  const replacements = countReplacementChars(utf8);
  if (replacements === 0) return utf8;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return utf8; // valid UTF-8 that contains literal U+FFFD characters
  } catch {
    /* invalid UTF-8 */
  }
  if (replacements < countValidNonAscii(utf8)) return utf8;
  try {
    return new TextDecoder('windows-1252').decode(bytes);
  } catch {
    return utf8;
  }
}

function safeDecode(encoding, bytes) {
  try {
    return new TextDecoder(encoding).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

function countReplacementChars(text) {
  let count = 0;
  let index = text.indexOf('\uFFFD');
  while (index !== -1) {
    count++;
    index = text.indexOf('\uFFFD', index + 1);
  }
  return count;
}

function countValidNonAscii(text) {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code > 0x7f && code !== 0xfffd && code !== 0xfeff) count++;
  }
  return count;
}

/** Throws 'EMPTY' / 'NOT_M3U' for content that can't be a playlist. */
function validatePlaylistText(text, source) {
  if (!text || !text.trim()) throw loadError('EMPTY', { source });
  if (!looksLikeM3U(text) && !isHlsManifest(text)) {
    const html = /^[\s\uFEFF]*</.test(text) && /<(?:!doctype|html|head|body|\?xml)\b/i.test(text.slice(0, 2048));
    throw loadError('NOT_M3U', { source, html });
  }
}

// ---------------------------------------------------------------------------------------------------------
// Files

/**
 * Read an uploaded playlist file. Accepts `.m3u`, `.m3u8`, `.txt` names or M3U/plain-text MIME types (or an
 * empty type, which many OSes report for .m3u); enforces `maxBytes`; decodes like fetchPlaylist (UTF-8 with
 * windows-1252 fallback) and validates the content.
 * @param {File | Blob} file
 * @param {{ maxBytes?: number }} [options]
 * @returns {Promise<string>}
 * @throws {PlaylistLoadError} 'FILE_TYPE' | 'TOO_LARGE' | 'READ' | 'EMPTY' | 'NOT_M3U'
 */
export async function readPlaylistFile(file, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
  if (!file || (typeof file.arrayBuffer !== 'function' && typeof file.text !== 'function')) {
    throw loadError('READ', { reason: 'missing' });
  }
  const fileName = typeof file.name === 'string' ? file.name : '';
  const type = String(file.type || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  const extension = /\.([a-z0-9]+)$/i.exec(fileName)?.[1].toLowerCase() || '';
  if (!ACCEPTED_EXTENSIONS.has(extension) && type !== '' && !ACCEPTED_TYPES.has(type)) {
    throw loadError('FILE_TYPE', { fileName, type });
  }
  const cap = sanitizeMaxBytes(maxBytes);
  if (Number.isFinite(file.size) && file.size > cap) {
    throw loadError('TOO_LARGE', { maxBytes: cap, source: 'file', fileName });
  }

  let text;
  try {
    if (typeof file.arrayBuffer === 'function') {
      const buffer = await file.arrayBuffer();
      if (buffer.byteLength > cap) throw loadError('TOO_LARGE', { maxBytes: cap, source: 'file', fileName });
      text = decodePlaylistBytes(new Uint8Array(buffer));
    } else {
      text = await file.text();
    }
  } catch (err) {
    if (err instanceof PlaylistLoadError) throw err;
    throw loadError('READ', { fileName }, { cause: err });
  }
  if (typeof text !== 'string') throw loadError('READ', { fileName });
  validatePlaylistText(text, 'file');
  return text;
}

// ---------------------------------------------------------------------------------------------------------
// Messages

const quoted = (value) => `“${value}”`;
const sizeLabel = (bytes) => formatBytes(bytes).replace(/\.0 /, ' ');
/** Join sentences, skipping empty parts. */
const say = (...sentences) => sentences.filter(Boolean).join(' ');

const UPLOAD_OR_PROXY = 'download the file and upload it here, or set up a CORS proxy in Settings';
const EXAMPLE_URL = 'https://example.com/playlist.m3u';

function httpMessage(status, statusText, viaProxy) {
  const label = status ? `HTTP ${status}${statusText ? ` ${statusText}` : ''}` : 'an HTTP error';
  const proxyNote = viaProxy && 'The request went through your CORS proxy — check its address in Settings.';
  let text;
  if (status === 401 || status === 403) {
    text = say(
      `Access to this playlist was denied (${label}).`,
      'The link may have expired, or it may require a valid subscription or login.',
    );
  } else if (status === 404 || status === 410) {
    text = `The playlist wasn't found (${label}). Check that the link is correct and still active.`;
  } else if (status === 407) {
    text = `A proxy requires authentication (${label}). Check your network or CORS proxy settings.`;
  } else if (status === 408 || status === 504 || status === 524) {
    text = `The server took too long to respond (${label}). Try again in a moment.`;
  } else if (status === 429) {
    text = `The server is limiting requests (${label}). Wait a minute, then try again.`;
  } else if (status >= 500) {
    text = `The playlist server ran into a problem (${label}). Try again later.`;
  } else if (status >= 400) {
    text = `The server rejected the request (${label}). Check that the link is correct.`;
  } else {
    text = `The server responded with an unexpected status (${label}). Check the link or try again later.`;
  }
  return say(text, proxyNote);
}

/** Friendly copy for a code + details. */
function buildMessage(code, details = {}) {
  const { source, viaProxy, status, statusText, timeoutMs, maxBytes, fileName, html, offline, reason, scheme } =
    details;
  switch (code) {
    case 'INVALID_URL':
      if (reason === 'empty') return `Enter a playlist URL, e.g. ${EXAMPLE_URL}.`;
      if (reason === 'scheme') {
        const kind = scheme ? `Links starting with ${quoted(`${scheme}:`)}` : 'This kind of link';
        return `${kind} can't be loaded here. Use an http:// or https:// link to an .m3u / .m3u8 playlist.`;
      }
      if (reason === 'credentials') {
        return say(
          "Links with a username and password before the host (user:pass@host) can't be downloaded",
          'by the browser. Use a link that passes them as query parameters, or download the file and upload it.',
        );
      }
      return `That doesn't look like a valid playlist link. Enter a full URL such as ${EXAMPLE_URL}.`;
    case 'MIXED_CONTENT':
      return say(
        'This playlist uses an insecure http:// link, and browsers block insecure downloads on',
        'secure (https://) sites — no https:// version of the link was available.',
        `Use an https:// link, ${UPLOAD_OR_PROXY}.`,
      );
    case 'NETWORK':
      if (offline) return 'You appear to be offline. Check your internet connection and try again.';
      if (viaProxy) {
        return say(
          "Couldn't download the playlist, not even through your CORS proxy.",
          'Check the link and the proxy address in Settings, or download the file and upload it here.',
        );
      }
      if (reason === 'interrupted') {
        return say(
          'The connection was interrupted while downloading the playlist.',
          'Check your connection and try again.',
        );
      }
      return "Couldn't reach the playlist server. Check your internet connection and the link, then try again.";
    case 'CORS':
      return say(
        "Couldn't download the playlist.",
        'The server may not allow downloads from other websites (CORS), or it may be offline.',
        `Check the link, or ${UPLOAD_OR_PROXY}.`,
      );
    case 'HTTP':
      return httpMessage(status, statusText, viaProxy);
    case 'TIMEOUT':
      return say(
        `The playlist server took too long to respond${
          timeoutMs ? ` (no response for ${Math.round(timeoutMs / 1000)} s)` : ''
        }.`,
        'It may be slow or overloaded — try again later, or download the file and upload it here.',
      );
    case 'EMPTY':
      if (source === 'file') return 'This file is empty. Choose a playlist file that contains channels.';
      return say(
        'The playlist is empty — the server returned no content.',
        'Check that the link is correct and still active.',
      );
    case 'NOT_M3U':
      if (source === 'file') {
        return say(
          "This file isn't an M3U playlist.",
          'Choose an .m3u or .m3u8 file (a text file with #EXTINF entries or stream links).',
        );
      }
      if (html) {
        return say(
          'The link returned a web page instead of a playlist.',
          'Use the direct (raw) link to the .m3u / .m3u8 file.',
        );
      }
      return "The link didn't return an M3U playlist. Check that it points directly to an .m3u / .m3u8 file.";
    case 'TOO_LARGE':
      return say(
        `This playlist is too large${Number.isFinite(maxBytes) ? ` (over ${sizeLabel(maxBytes)})` : ''}.`,
        'Try a smaller playlist, for example a single country or category.',
      );
    case 'ABORTED':
      return 'The download was cancelled.';
    case 'FILE_TYPE':
      return say(
        `${fileName ? `${quoted(fileName)} isn't` : "This file isn't"} a playlist file.`,
        'Choose an .m3u, .m3u8 or .txt file.',
      );
    case 'READ':
      if (reason === 'missing') return 'No file was selected. Choose an .m3u or .m3u8 playlist file.';
      return say(
        `${fileName ? `${quoted(fileName)} couldn't` : "The file couldn't"} be read.`,
        'It may have been moved or deleted — try selecting it again.',
      );
    default:
      return 'Something went wrong while loading the playlist. Please try again.';
  }
}

const FETCH_FAILURE_RE = /failed to fetch|networkerror|load failed|network request failed|fetch failed/i;

/**
 * A friendly, actionable sentence (or two) describing any loading error — PlaylistLoadError codes get
 * tailored copy; other errors fall back to sensible defaults.
 * @param {unknown} err
 * @returns {string}
 */
export function describeLoadError(err) {
  if (!err) return buildMessage('');
  if (typeof err === 'string') return err;
  const e = /** @type {any} */ (err);
  if (typeof e.code === 'string' && Object.hasOwn(LOAD_ERROR, e.code)) {
    return buildMessage(e.code, { ...(e.details || {}), status: e.status ?? null });
  }
  if (e.name === 'AbortError') return buildMessage('ABORTED');
  if (e.name === 'TimeoutError') return buildMessage('TIMEOUT');
  if (isQuota(e)) return 'Browser storage is full. Remove a playlist you no longer need and try again.';
  if (e.name === 'TypeError' && FETCH_FAILURE_RE.test(String(e.message || ''))) return buildMessage('CORS');
  if (typeof e.message === 'string' && e.message.trim()) return e.message.trim();
  return buildMessage('');
}

function isQuota(e) {
  return e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED';
}
