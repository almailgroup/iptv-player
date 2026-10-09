import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KEYS, STORAGE_PREFIX } from '../src/app/constants.js';
import {
  clearAllData,
  estimateUsage,
  isQuotaError,
  isStorageAvailable,
  readJSON,
  readPlaylistText,
  removeKey,
  removePlaylistText,
  writeJSON,
  writePlaylistText,
} from '../src/lib/storage.js';

// happy-dom's localStorage is a Proxy: vi.restoreAllMocks() does not undo spies on it, mockRestore() does.
const storageSpies = [];
function spyStorage(method) {
  const spy = vi.spyOn(localStorage, method);
  storageSpies.push(spy);
  return spy;
}
function restoreStorageSpies() {
  while (storageSpies.length) storageSpies.pop().mockRestore();
}

const quotaError = () => new DOMException('The quota has been exceeded.', 'QuotaExceededError');

/** A realistic, compressible playlist. */
function makePlaylist(count) {
  const lines = ['#EXTM3U x-tvg-url="https://epg.example/guide.xml"'];
  for (let i = 0; i < count; i++) {
    lines.push(
      `#EXTINF:-1 tvg-id="ch${i}.example" tvg-logo="https://logo.example/${i}.png" group-title="Group ${i % 17}",Channel ${i} · Café ${i * 7919}`,
      `https://stream.example/live/${(i * 2654435761) % 1000003}/index.m3u8?token=${(i * 40503) % 65536}`,
    );
  }
  return lines.join('\n');
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  restoreStorageSpies();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('isStorageAvailable / isQuotaError', () => {
  it('reports the happy-dom localStorage as available and leaves no probe key behind', () => {
    expect(isStorageAvailable()).toBe(true);
    expect(localStorage.length).toBe(0);
  });

  it('recognizes quota errors across browsers', () => {
    expect(isQuotaError(quotaError())).toBe(true);
    expect(isQuotaError({ name: 'NS_ERROR_DOM_QUOTA_REACHED' })).toBe(true);
    expect(isQuotaError({ name: 'Error', code: 22 })).toBe(true);
    expect(isQuotaError({ name: 'Error', code: 1014 })).toBe(true);
    expect(isQuotaError(new Error('Storage quota exceeded'))).toBe(true);
  });

  it('rejects non-quota errors', () => {
    expect(isQuotaError(new DOMException('denied', 'SecurityError'))).toBe(false);
    expect(isQuotaError(new TypeError('x is undefined'))).toBe(false);
    expect(isQuotaError(null)).toBe(false);
    expect(isQuotaError('QuotaExceededError')).toBe(false);
  });
});

describe('readJSON / writeJSON / removeKey', () => {
  it('round-trips values', () => {
    const key = `${STORAGE_PREFIX}test`;
    expect(writeJSON(key, { a: 1, list: [1, 2, 3], s: 'héllo' })).toBe(true);
    expect(readJSON(key, {})).toEqual({ a: 1, list: [1, 2, 3], s: 'héllo' });
    expect(writeJSON(key, 42)).toBe(true);
    expect(readJSON(key, 0)).toBe(42);
    expect(writeJSON(key, false)).toBe(true);
    expect(readJSON(key, true)).toBe(false);
  });

  it('returns the fallback for missing keys', () => {
    expect(readJSON(`${STORAGE_PREFIX}missing`, 'fallback')).toBe('fallback');
    expect(readJSON(`${STORAGE_PREFIX}missing`)).toBeUndefined();
  });

  it('returns the fallback for corrupt JSON', () => {
    localStorage.setItem(KEYS.settings, '{"autoplay": tru');
    expect(readJSON(KEYS.settings, { ok: 1 })).toEqual({ ok: 1 });
    localStorage.setItem(KEYS.favorites, 'undefined');
    expect(readJSON(KEYS.favorites, [])).toEqual([]);
  });

  it('returns the fallback for a stored null or a mismatched shape', () => {
    localStorage.setItem(KEYS.favorites, 'null');
    expect(readJSON(KEYS.favorites, [])).toEqual([]);
    localStorage.setItem(KEYS.favorites, '{"not":"an array"}');
    expect(readJSON(KEYS.favorites, [])).toEqual([]);
    localStorage.setItem(KEYS.settings, '[1,2]');
    expect(readJSON(KEYS.settings, { a: 1 })).toEqual({ a: 1 });
    localStorage.setItem(KEYS.settings, '"text"');
    expect(readJSON(KEYS.settings, { a: 1 })).toEqual({ a: 1 });
  });

  it('returns false instead of throwing for unserializable values', () => {
    const circular = {};
    circular.self = circular;
    expect(writeJSON(`${STORAGE_PREFIX}c`, circular)).toBe(false);
    expect(writeJSON(`${STORAGE_PREFIX}b`, { n: 10n })).toBe(false);
    expect(writeJSON(`${STORAGE_PREFIX}f`, () => 1)).toBe(false);
  });

  it('treats writing undefined as a removal', () => {
    const key = `${STORAGE_PREFIX}u`;
    writeJSON(key, 1);
    expect(writeJSON(key, undefined)).toBe(true);
    expect(localStorage.getItem(key)).toBeNull();
  });

  it('returns false on quota errors and keeps the previous value', () => {
    const key = KEYS.favorites;
    writeJSON(key, [1]);
    spyStorage('setItem').mockImplementation(() => {
      throw quotaError();
    });
    expect(() => writeJSON(key, [1, 2])).not.toThrow();
    expect(writeJSON(key, [1, 2])).toBe(false);
    restoreStorageSpies();
    expect(readJSON(key, [])).toEqual([1]);
  });

  it('returns false when setItem fails for other reasons', () => {
    spyStorage('setItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    expect(writeJSON(KEYS.theme, { accent: 'rose' })).toBe(false);
  });

  it('survives getItem throwing', () => {
    spyStorage('getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    expect(readJSON(KEYS.theme, 'fb')).toBe('fb');
  });

  it('removes keys and never throws', () => {
    writeJSON(KEYS.recents, [1]);
    removeKey(KEYS.recents);
    expect(localStorage.getItem(KEYS.recents)).toBeNull();
    expect(() => removeKey(`${STORAGE_PREFIX}never-written`)).not.toThrow();
    spyStorage('removeItem').mockImplementation(() => {
      throw new Error('boom');
    });
    expect(() => removeKey(KEYS.recents)).not.toThrow();
  });
});

describe('playlist text', () => {
  it('compresses playlists (gz: prefix) and reads them back exactly', async () => {
    const text = makePlaylist(500);
    const result = await writePlaylistText('pl_gz', text);
    expect(result.ok).toBe(true);
    expect(result.compressed).toBe(true);
    expect(result.error).toBeUndefined();

    const stored = localStorage.getItem(KEYS.playlistContent('pl_gz'));
    expect(stored.startsWith('gz:')).toBe(true);
    expect(stored.length).toBeLessThan(text.length / 3);
    expect(result.bytes).toBe(stored.length * 2);
    expect(await readPlaylistText('pl_gz')).toBe(text);
  });

  it('handles large payloads without overflowing the stack (chunked base64)', async () => {
    const text = makePlaylist(40000); // ~6 MB of text → multi-MB base64
    expect(text.length).toBeGreaterThan(5_000_000);
    const result = await writePlaylistText('pl_big', text);
    expect(result).toMatchObject({ ok: true, compressed: true });
    expect(result.bytes).toBeGreaterThan(400_000);
    expect(await readPlaylistText('pl_big')).toBe(text);
  });

  it('round-trips non-ASCII text through gzip (UTF-8)', async () => {
    const text = `#EXTM3U\n${'#EXTINF:-1 group-title="Ελληνικά;日本語",Канал 1 — Ünïcödé 🎬\nhttps://x.example/a.m3u8\n'.repeat(50)}`;
    await writePlaylistText('pl_utf', text);
    expect(await readPlaylistText('pl_utf')).toBe(text);
  });

  it('stores raw text when CompressionStream is unavailable', async () => {
    vi.stubGlobal('CompressionStream', undefined);
    try {
      const text = makePlaylist(20);
      const result = await writePlaylistText('pl_raw', text);
      expect(result).toEqual({ ok: true, bytes: (text.length + 4) * 2, compressed: false });
      expect(localStorage.getItem(KEYS.playlistContent('pl_raw'))).toBe(`raw:${text}`);
      expect(await readPlaylistText('pl_raw')).toBe(text);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('stores raw text when compression would not save space', async () => {
    const text = '#EXTM3U\nhttps://a.example/1';
    const result = await writePlaylistText('pl_tiny', text);
    expect(result.compressed).toBe(false);
    expect(localStorage.getItem(KEYS.playlistContent('pl_tiny'))).toBe(`raw:${text}`);
    expect(await readPlaylistText('pl_tiny')).toBe(text);
  });

  it('falls back to raw when compression throws', async () => {
    vi.stubGlobal(
      'CompressionStream',
      class {
        constructor() {
          throw new Error('not supported');
        }
      },
    );
    try {
      const text = makePlaylist(50);
      const result = await writePlaylistText('pl_cs_err', text);
      expect(result).toMatchObject({ ok: true, compressed: false });
      expect(await readPlaylistText('pl_cs_err')).toBe(text);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('round-trips an empty playlist text', async () => {
    const result = await writePlaylistText('pl_empty', '');
    expect(result.ok).toBe(true);
    expect(await readPlaylistText('pl_empty')).toBe('');
  });

  it('reads legacy plain-text values', async () => {
    localStorage.setItem(KEYS.playlistContent('legacy'), '#EXTM3U\n#EXTINF:-1,A\nhttp://a/1');
    expect(await readPlaylistText('legacy')).toBe('#EXTM3U\n#EXTINF:-1,A\nhttp://a/1');
  });

  it('returns null for missing and corrupt compressed content', async () => {
    expect(await readPlaylistText('nope')).toBeNull();
    localStorage.setItem(KEYS.playlistContent('bad1'), 'gz:!!!not-base64!!!');
    expect(await readPlaylistText('bad1')).toBeNull();
    localStorage.setItem(KEYS.playlistContent('bad2'), `gz:${btoa('definitely not gzip data')}`);
    expect(await readPlaylistText('bad2')).toBeNull();
  });

  it('returns ok:false with QUOTA when the playlist does not fit, without touching other playlists', async () => {
    await writePlaylistText('keep', makePlaylist(30));
    await writePlaylistText('target', makePlaylist(10)); // stale copy that must be dropped
    const setItem = spyStorage('setItem').mockImplementation(() => {
      throw quotaError();
    });
    const removeItem = spyStorage('removeItem');

    const result = await writePlaylistText('target', makePlaylist(2000));
    expect(result.ok).toBe(false);
    expect(result.error).toBe('QUOTA');
    expect(result.compressed).toBe(true);
    expect(result.bytes).toBeGreaterThan(0);
    expect(setItem).toHaveBeenCalledTimes(1); // compressed attempt only — no raw retry, no eviction loop
    expect(removeItem.mock.calls.map((c) => c[0])).toEqual([KEYS.playlistContent('target')]);

    restoreStorageSpies();
    expect(await readPlaylistText('keep')).toBe(makePlaylist(30));
    expect(await readPlaylistText('target')).toBeNull();
  });

  it('reports UNAVAILABLE for non-quota setItem failures', async () => {
    spyStorage('setItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    const result = await writePlaylistText('x', makePlaylist(5));
    expect(result).toMatchObject({ ok: false, error: 'UNAVAILABLE' });
  });

  it('removes playlist text', async () => {
    await writePlaylistText('gone', makePlaylist(5));
    removePlaylistText('gone');
    expect(localStorage.getItem(KEYS.playlistContent('gone'))).toBeNull();
    expect(await readPlaylistText('gone')).toBeNull();
  });

  it('does not resurrect a playlist removed while its write was compressing', async () => {
    const pending = writePlaylistText('racy', makePlaylist(200));
    removePlaylistText('racy');
    const result = await pending;
    expect(result.superseded).toBe(true);
    expect(localStorage.getItem(KEYS.playlistContent('racy'))).toBeNull();
  });

  it('keeps the newest of two overlapping writes', async () => {
    const first = writePlaylistText('dup', makePlaylist(300));
    const second = writePlaylistText('dup', makePlaylist(3));
    const [a, b] = await Promise.all([first, second]);
    expect(a.superseded).toBe(true);
    expect(b.ok).toBe(true);
    expect(await readPlaylistText('dup')).toBe(makePlaylist(3));
  });
});

describe('estimateUsage / clearAllData', () => {
  it('estimates usage of prefixed keys only (UTF-16: chars × 2)', () => {
    localStorage.setItem('other-app', 'x'.repeat(1000));
    writeJSON(KEYS.settings, { a: 1 });
    writeJSON(KEYS.theme, { accent: 'azure', mode: 'dark' });
    const expected =
      (KEYS.settings.length + JSON.stringify({ a: 1 }).length) * 2 +
      (KEYS.theme.length + JSON.stringify({ accent: 'azure', mode: 'dark' }).length) * 2;
    expect(estimateUsage()).toEqual({ bytes: expected, keys: 2 });
  });

  it('reports zero when nothing is stored', () => {
    expect(estimateUsage()).toEqual({ bytes: 0, keys: 0 });
  });

  it('clearAllData removes only keys starting with STORAGE_PREFIX', async () => {
    localStorage.setItem('other-app', 'keep me');
    localStorage.setItem('iptvp.v0.old', 'not ours (different version prefix)');
    writeJSON(KEYS.settings, { a: 1 });
    writeJSON(KEYS.favorites, [1]);
    await writePlaylistText('p1', makePlaylist(10));
    expect(estimateUsage().keys).toBe(3);

    clearAllData();

    expect(estimateUsage()).toEqual({ bytes: 0, keys: 0 });
    expect(localStorage.getItem('other-app')).toBe('keep me');
    expect(localStorage.getItem('iptvp.v0.old')).toBe('not ours (different version prefix)');
    expect(localStorage.length).toBe(2);
  });

  it('clearAllData cancels in-flight playlist writes', async () => {
    const pending = writePlaylistText('late', makePlaylist(200));
    clearAllData();
    await pending;
    expect(localStorage.getItem(KEYS.playlistContent('late'))).toBeNull();
  });
});

describe('when localStorage is unavailable', () => {
  /** Load a fresh copy of the module (its availability probe is cached per module instance). */
  async function loadWithStorage(descriptor) {
    vi.resetModules();
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, ...descriptor });
    const mod = await import('../src/lib/storage.js');
    const restore = () => {
      if (original) Object.defineProperty(globalThis, 'localStorage', original);
      else delete globalThis.localStorage;
    };
    return { mod, restore };
  }

  it('falls back to memory when accessing localStorage throws (SecurityError)', async () => {
    const { mod, restore } = await loadWithStorage({
      get() {
        throw new DOMException('The operation is insecure.', 'SecurityError');
      },
    });
    try {
      expect(mod.isStorageAvailable()).toBe(false);
      expect(mod.writeJSON(KEYS.settings, { a: 1 })).toBe(false); // not persisted…
      expect(mod.readJSON(KEYS.settings, {})).toEqual({ a: 1 }); // …but usable this session
      expect(mod.estimateUsage().keys).toBe(1);

      const text = makePlaylist(20);
      const result = await mod.writePlaylistText('mem', text);
      expect(result).toMatchObject({ ok: false, error: 'UNAVAILABLE', compressed: false });
      expect(await mod.readPlaylistText('mem')).toBe(text);
      mod.removePlaylistText('mem');
      expect(await mod.readPlaylistText('mem')).toBeNull();

      mod.clearAllData();
      expect(mod.readJSON(KEYS.settings, 'gone')).toBe('gone');
      expect(mod.estimateUsage()).toEqual({ bytes: 0, keys: 0 });
    } finally {
      restore();
    }
  });

  it('falls back to memory when localStorage is missing', async () => {
    const { mod, restore } = await loadWithStorage({ value: undefined, writable: true });
    try {
      expect(mod.isStorageAvailable()).toBe(false);
      mod.writeJSON(KEYS.theme, { accent: 'rose' });
      expect(mod.readJSON(KEYS.theme, null)).toEqual({ accent: 'rose' });
      mod.removeKey(KEYS.theme);
      expect(mod.readJSON(KEYS.theme, null)).toBeNull();
    } finally {
      restore();
    }
  });

  it('treats a zero-quota storage (old Safari private mode) as unavailable', async () => {
    const zeroQuota = {
      length: 0,
      getItem: () => null,
      setItem: () => {
        throw quotaError();
      },
      removeItem: () => {},
      key: () => null,
    };
    const { mod, restore } = await loadWithStorage({ value: zeroQuota, writable: true });
    try {
      expect(mod.isStorageAvailable()).toBe(false);
    } finally {
      restore();
    }
  });

  it('treats a full (but non-empty) storage as available', async () => {
    const data = new Map([['iptvp.v1.settings', '{"a":1}']]);
    const full = {
      get length() {
        return data.size;
      },
      getItem: (k) => (data.has(k) ? data.get(k) : null),
      setItem: () => {
        throw quotaError();
      },
      removeItem: (k) => data.delete(k),
      key: (i) => [...data.keys()][i] ?? null,
    };
    const { mod, restore } = await loadWithStorage({ value: full, writable: true });
    try {
      expect(mod.isStorageAvailable()).toBe(true);
      expect(mod.readJSON(KEYS.settings, {})).toEqual({ a: 1 });
      expect(mod.writeJSON(KEYS.settings, { a: 2 })).toBe(false);
      const result = await mod.writePlaylistText('p', makePlaylist(50));
      expect(result).toMatchObject({ ok: false, error: 'QUOTA' });
    } finally {
      restore();
    }
  });
});
