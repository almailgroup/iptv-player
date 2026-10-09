// Small, dependency-free helpers shared across the app.

export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function debounce(fn, wait = 100) {
  let timer = 0;
  const debounced = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
  debounced.cancel = () => clearTimeout(timer);
  debounced.flush = (...args) => {
    clearTimeout(timer);
    fn(...args);
  };
  return debounced;
}

export function throttle(fn, wait = 100) {
  let last = 0;
  let timer = 0;
  let pendingArgs = null;
  return (...args) => {
    const now = Date.now();
    const remaining = wait - (now - last);
    if (remaining <= 0) {
      last = now;
      fn(...args);
    } else {
      pendingArgs = args;
      if (!timer) {
        timer = setTimeout(() => {
          timer = 0;
          last = Date.now();
          fn(...pendingArgs);
        }, remaining);
      }
    }
  };
}

/**
 * cyrb53 — fast, well-distributed 53-bit string hash. Returned as a base-36 string.
 * Used for stable channel IDs (favorites survive reloads and playlist refreshes).
 */
export function hashString(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** Random-ish unique id with a prefix, e.g. uid('pl') -> "pl_lq3k9x2a7f". */
export function uid(prefix = 'id') {
  const rand =
    typeof crypto !== 'undefined' && crypto.getRandomValues
      ? Array.from(crypto.getRandomValues(new Uint32Array(2)), (n) => n.toString(36)).join('')
      : Math.random().toString(36).slice(2);
  return `${prefix}_${Date.now().toString(36)}${rand.slice(0, 8)}`;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
/** Locale-aware, numeric-aware comparison ("Channel 2" < "Channel 10"). */
export const naturalCompare = (a, b) => collator.compare(a, b);

const numberFormat = new Intl.NumberFormat();
export const formatCount = (n) => numberFormat.format(n);

export function formatBitrate(bps) {
  if (!Number.isFinite(bps) || bps <= 0) return '';
  if (bps >= 1e6) return `${(bps / 1e6).toFixed(bps >= 1e7 ? 0 : 1)} Mbps`;
  return `${Math.round(bps / 1e3)} kbps`;
}

/** 3725 -> "1:02:05", 65 -> "1:05". Non-finite values return "--:--". */
export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--';
  const s = Math.floor(seconds % 60);
  const m = Math.floor((seconds / 60) % 60);
  const h = Math.floor(seconds / 3600);
  const pad = (v) => String(v).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/** Parse a URL, returning null instead of throwing. */
export function tryParseUrl(value, base) {
  try {
    return new URL(String(value).trim(), base);
  } catch {
    return null;
  }
}

/** True for absolute http(s) URLs. */
export function isHttpUrl(value) {
  const url = tryParseUrl(value);
  return !!url && (url.protocol === 'http:' || url.protocol === 'https:');
}

/**
 * Returns the URL if it is safe to use as an <img src> (http, https, or data:image/*), else ''.
 * Playlist content is untrusted: never let `javascript:` or other schemes through.
 */
export function safeImageUrl(value) {
  if (!value || typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (/^data:image\/(png|jpe?g|gif|webp|svg\+xml|avif|bmp|x-icon);/i.test(trimmed)) return trimmed;
  const url = tryParseUrl(trimmed);
  if (url && (url.protocol === 'https:' || url.protocol === 'http:')) return url.href;
  return '';
}

/** Last path segment without extension, e.g. ".../lists/news.m3u?x=1" -> "news". */
export function fileNameFromUrl(value) {
  const url = tryParseUrl(value);
  if (!url) return '';
  const last = decodeURIComponentSafe(url.pathname.split('/').filter(Boolean).pop() || '');
  return last.replace(/\.(m3u8?|txt|ts|mp4|flv)$/i, '') || url.hostname;
}

export function decodeURIComponentSafe(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Up to two uppercase initials for avatar fallbacks. */
export function initials(name) {
  const words = String(name || '')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return '#';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

/** Deterministic hue (0–359) for a string — used to tint avatar fallbacks. */
export function hueFromString(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h % 360;
}

/** Trigger a client-side download of text content. */
export function downloadText(fileName, text, mime = 'audio/x-mpegurl') {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = fileName;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}

/** Copy text to the clipboard; resolves to true on success. */
export async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/** True when keyboard events should be left alone (user is typing). */
export function isTypingTarget(target) {
  if (!target || !(target instanceof Element)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (target.getAttribute('type') || 'text').toLowerCase();
    return !['checkbox', 'radio', 'range', 'button', 'submit', 'reset', 'color', 'file'].includes(type);
  }
  return false;
}

export const prefersReducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
