// localStorage wrapper. Every call is exception-safe: storage can be missing, blocked (sandboxed iframes,
// disabled cookies, some private modes), full, or corrupt. When storage is unavailable the module falls back to
// an in-memory Map so the app keeps working for the current session (nothing is persisted, and writes report
// `false` / `ok: false` so callers can tell).
//
// Playlist text is stored gzip-compressed (CompressionStream) and base64-encoded with a `gz:` prefix, or as
// `raw:` + text when compression is unavailable or would not save space. Values without a prefix are read as
// legacy plain text.

import { KEYS, STORAGE_PREFIX } from '../app/constants.js';

const GZ_PREFIX = 'gz:';
const RAW_PREFIX = 'raw:';
const PROBE_KEY = `${STORAGE_PREFIX}__probe__`;

/** Bytes per btoa() call; a multiple of 3 so chunk outputs concatenate without inner padding. */
const B64_ENCODE_CHUNK = 3 * 8192;
/** Characters per atob() call; a multiple of 4 so every chunk decodes on its own. */
const B64_DECODE_CHUNK = 4 * 8192;

/** In-memory fallback used only when localStorage is unavailable. */
const memory = new Map();

/** Resolved backend: a Storage, `null` (unavailable → memory fallback) or `undefined` (not probed yet). */
let backend;

/**
 * Write generations per playlist key: a write that was superseded (by a newer write, a removal or
 * clearAllData) while it was compressing must not land afterwards.
 */
const generations = new Map();
let epoch = 0;

// ---------------------------------------------------------------------------------------------------------
// Backend detection & raw access

function resolveBackend() {
  let storage;
  try {
    storage = globalThis.localStorage;
  } catch {
    return null; // SecurityError: storage access denied
  }
  if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') return null;
  try {
    storage.setItem(PROBE_KEY, '1');
    storage.removeItem(PROBE_KEY);
    return storage;
  } catch (err) {
    // A full storage is still a working storage (reads succeed). A zero-quota storage (old Safari private
    // mode) throws a quota error while empty — treat that as unavailable.
    try {
      if (isQuotaError(err) && storage.length > 0) return storage;
    } catch {
      /* fall through */
    }
    return null;
  }
}

function getBackend() {
  if (backend === undefined) backend = resolveBackend();
  return backend;
}

function getRaw(key) {
  const storage = getBackend();
  if (!storage) return memory.has(key) ? memory.get(key) : null;
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * @returns {{ ok: boolean, error?: 'QUOTA'|'UNAVAILABLE' }}
 */
function setRaw(key, value) {
  const storage = getBackend();
  if (!storage) {
    memory.set(key, value);
    return { ok: false, error: 'UNAVAILABLE' };
  }
  try {
    storage.setItem(key, value);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: isQuotaError(err) ? 'QUOTA' : 'UNAVAILABLE' };
  }
}

function removeRaw(key) {
  memory.delete(key);
  const storage = getBackend();
  if (!storage) return;
  try {
    storage.removeItem(key);
  } catch {
    /* ignore */
  }
}

/** All keys (ours and others) currently in the active backend. */
function listKeys() {
  const storage = getBackend();
  if (!storage) return [...memory.keys()];
  const keys = [];
  try {
    const length = storage.length;
    for (let i = 0; i < length; i++) {
      const key = storage.key(i);
      if (typeof key === 'string') keys.push(key);
    }
  } catch {
    /* ignore — return what we have */
  }
  return keys;
}

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// ---------------------------------------------------------------------------------------------------------
// Public API: generic values

/**
 * True when localStorage can be used for persistence (probed once per session). When false, all functions
 * still work against an in-memory fallback that lasts until the page is reloaded.
 * @returns {boolean}
 */
export function isStorageAvailable() {
  return getBackend() !== null;
}

/**
 * True for "storage is full" errors across browsers (QuotaExceededError, Firefox's NS_ERROR_DOM_QUOTA_REACHED,
 * legacy DOMException codes 22 / 1014).
 * @param {unknown} err
 * @returns {boolean}
 */
export function isQuotaError(err) {
  if (!err || typeof err !== 'object') return false;
  const { name, code, message } = /** @type {any} */ (err);
  if (name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED') return true;
  if (code === 22 || code === 1014) return true;
  return typeof message === 'string' && /quota/i.test(message) && /exceed|reached|full/i.test(message);
}

/**
 * Read and parse a JSON value. Returns `fallback` when the key is missing, the JSON is corrupt, the stored
 * value is `null`, or its shape doesn't match the fallback (array fallback → must be an array; plain-object
 * fallback → must be a plain object).
 * @template T
 * @param {string} key
 * @param {T} [fallback]
 * @returns {T | any}
 */
export function readJSON(key, fallback) {
  const raw = getRaw(key);
  if (raw === null || raw === undefined) return fallback;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fallback;
  }
  if (parsed === null || parsed === undefined) return fallback;
  if (Array.isArray(fallback) && !Array.isArray(parsed)) return fallback;
  if (isPlainObject(fallback) && !isPlainObject(parsed)) return fallback;
  return parsed;
}

/**
 * Serialize and store a JSON value. Never throws. Returns false when the value can't be serialized, storage is
 * full, or storage is unavailable (the value is then kept in memory for this session). Writing `undefined`
 * removes the key.
 * @param {string} key
 * @param {unknown} value
 * @returns {boolean}
 */
export function writeJSON(key, value) {
  if (value === undefined) {
    removeKey(key);
    return true;
  }
  let json;
  try {
    json = JSON.stringify(value);
  } catch {
    return false; // circular structure, BigInt…
  }
  if (typeof json !== 'string') return false; // functions / symbols
  return setRaw(key, json).ok;
}

/**
 * Remove a key (no-op when missing). Never throws.
 * @param {string} key
 */
export function removeKey(key) {
  removeRaw(key);
}

// ---------------------------------------------------------------------------------------------------------
// Public API: playlist content

/**
 * Store the raw text of a playlist under `KEYS.playlistContent(id)`. The text is gzip-compressed and base64
 * encoded (`gz:` prefix) when CompressionStream is available and that is smaller; otherwise it is stored as
 * `raw:` + text. Other playlists are never evicted to make room: on a quota error the result is `ok: false`
 * and any stale copy of THIS playlist is removed (so an outdated version is never served later).
 *
 * If a newer write, a removal of the same playlist, or clearAllData() happens while compressing, nothing is
 * written and `{ ok: true, superseded: true }` is returned (the newer operation wins).
 *
 * `bytes` is the stored value's size as browsers account for it (UTF-16: characters × 2).
 * @param {string} id
 * @param {string} text
 * @returns {Promise<{ ok: boolean, bytes: number, compressed: boolean, error?: 'QUOTA'|'UNAVAILABLE',
 *   superseded?: boolean }>}
 */
export async function writePlaylistText(id, text) {
  const key = KEYS.playlistContent(id);
  const source = typeof text === 'string' ? text : String(text ?? '');
  const generation = (generations.get(key) || 0) + 1;
  generations.set(key, generation);
  const startEpoch = epoch;

  let value = RAW_PREFIX + source;
  let compressed = false;
  if (getBackend() && canCompress() && source.length > 0) {
    try {
      const encoded = GZ_PREFIX + bytesToBase64(await gzip(source));
      if (encoded.length < value.length) {
        value = encoded;
        compressed = true;
      }
    } catch {
      /* compression failed — store raw */
    }
  }

  const bytes = value.length * 2;
  if (generations.get(key) !== generation || epoch !== startEpoch) {
    return { ok: true, bytes, compressed, superseded: true };
  }
  const result = setRaw(key, value);
  if (result.ok) return { ok: true, bytes, compressed };
  if (result.error === 'QUOTA') removeRaw(key);
  return { ok: false, bytes, compressed, error: result.error };
}

/**
 * Read a playlist's stored text. Handles `gz:` (gzip + base64), `raw:` and legacy un-prefixed plain text.
 * Returns null when missing or when the compressed payload is corrupt / can't be decompressed.
 * @param {string} id
 * @returns {Promise<string | null>}
 */
export async function readPlaylistText(id) {
  const value = getRaw(KEYS.playlistContent(id));
  if (typeof value !== 'string') return null;
  if (value.startsWith(RAW_PREFIX)) return value.slice(RAW_PREFIX.length);
  if (value.startsWith(GZ_PREFIX)) {
    if (typeof DecompressionStream !== 'function') return null;
    try {
      return await gunzip(base64ToBytes(value.slice(GZ_PREFIX.length)));
    } catch {
      return null;
    }
  }
  return value; // legacy: plain text written by an older version
}

/**
 * Remove a playlist's stored text (and cancel an in-flight write for it). Never throws.
 * @param {string} id
 */
export function removePlaylistText(id) {
  const key = KEYS.playlistContent(id);
  generations.set(key, (generations.get(key) || 0) + 1);
  removeRaw(key);
}

/**
 * Approximate storage used by this app: only keys starting with STORAGE_PREFIX, counted as UTF-16
 * ((key.length + value.length) × 2 bytes), the way browsers account for localStorage quota.
 * @returns {{ bytes: number, keys: number }}
 */
export function estimateUsage() {
  let bytes = 0;
  let keys = 0;
  for (const key of listKeys()) {
    if (!key.startsWith(STORAGE_PREFIX)) continue;
    const value = getRaw(key);
    keys += 1;
    bytes += (key.length + (typeof value === 'string' ? value.length : 0)) * 2;
  }
  return { bytes, keys };
}

/**
 * Remove every key that starts with STORAGE_PREFIX (keys of other apps on the same origin are left alone).
 * Pending playlist writes are cancelled. Never throws.
 */
export function clearAllData() {
  epoch += 1;
  generations.clear();
  for (const key of listKeys()) {
    if (key.startsWith(STORAGE_PREFIX)) removeRaw(key);
  }
  for (const key of [...memory.keys()]) {
    if (key.startsWith(STORAGE_PREFIX)) memory.delete(key);
  }
}

// ---------------------------------------------------------------------------------------------------------
// Compression & base64 helpers

function canCompress() {
  return (
    typeof CompressionStream === 'function' &&
    typeof DecompressionStream === 'function' &&
    typeof TextEncoder === 'function' &&
    typeof TextDecoder === 'function'
  );
}

/** Pipe `input` through a transform stream and collect the output chunks. */
async function transformBytes(transform, input, onChunk) {
  const writer = transform.writable.getWriter();
  // Write without awaiting first: awaiting before reading could deadlock on backpressure.
  const writing = writer.write(input).then(() => writer.close());
  writing.catch(() => {}); // surfaced through the readable side / awaited below
  const reader = transform.readable.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) onChunk(value instanceof Uint8Array ? value : new Uint8Array(value));
  }
  await writing;
}

/**
 * @param {string} text
 * @returns {Promise<Uint8Array>}
 */
async function gzip(text) {
  const chunks = [];
  let total = 0;
  await transformBytes(new CompressionStream('gzip'), new TextEncoder().encode(text), (chunk) => {
    chunks.push(chunk);
    total += chunk.byteLength;
  });
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * @param {Uint8Array} bytes
 * @returns {Promise<string>}
 */
async function gunzip(bytes) {
  const decoder = new TextDecoder('utf-8');
  const parts = [];
  await transformBytes(new DecompressionStream('gzip'), bytes, (chunk) => {
    parts.push(decoder.decode(chunk, { stream: true }));
  });
  parts.push(decoder.decode());
  return parts.join('');
}

/**
 * Base64-encode bytes without spreading huge arrays into String.fromCharCode (which overflows the stack).
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function bytesToBase64(bytes) {
  if (typeof bytes.toBase64 === 'function') return bytes.toBase64();
  const parts = [];
  for (let i = 0; i < bytes.length; i += B64_ENCODE_CHUNK) {
    const chunk = bytes.subarray(i, i + B64_ENCODE_CHUNK);
    let binary = '';
    for (let j = 0; j < chunk.length; j += 4096) {
      binary += String.fromCharCode.apply(null, chunk.subarray(j, j + 4096));
    }
    parts.push(btoa(binary));
  }
  return parts.join('');
}

/**
 * Decode base64 (standard alphabet, padded) in chunks. Throws on invalid input.
 * @param {string} base64
 * @returns {Uint8Array}
 */
function base64ToBytes(base64) {
  if (typeof Uint8Array.fromBase64 === 'function') return Uint8Array.fromBase64(base64);
  if (base64.length % 4 !== 0) throw new Error('Invalid base64 length');
  let padding = 0;
  if (base64.endsWith('==')) padding = 2;
  else if (base64.endsWith('=')) padding = 1;
  const out = new Uint8Array((base64.length / 4) * 3 - padding);
  let offset = 0;
  for (let i = 0; i < base64.length; i += B64_DECODE_CHUNK) {
    const binary = atob(base64.slice(i, i + B64_DECODE_CHUNK));
    for (let j = 0; j < binary.length; j++) out[offset++] = binary.charCodeAt(j);
  }
  return out;
}
