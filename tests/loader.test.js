import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PlaylistLoadError,
  buildProxyUrl,
  describeLoadError,
  fetchPlaylist,
  normalizePlaylistUrl,
  readPlaylistFile,
} from '../src/lib/playlist-loader.js';

// Simple, faithful stand-ins for the parser's sniffers so these tests don't depend on src/lib/m3u.js.
vi.mock('../src/lib/m3u.js', () => ({
  looksLikeM3U: (text) => {
    if (typeof text !== 'string' || !text.trim()) return false;
    if (/^[\s\uFEFF]*</.test(text)) return false;
    return /^[ \t\uFEFF]*#EXT(?:M3U|INF)/im.test(text) || /^[ \t]*https?:\/\/\S+/im.test(text);
  },
  isHlsManifest: (text) =>
    typeof text === 'string' && /^[ \t\uFEFF]*#EXT-X-(?:STREAM-INF|TARGETDURATION|MEDIA-SEQUENCE)\b/im.test(text),
}));


const M3U = '#EXTM3U\n#EXTINF:-1 tvg-id="a" group-title="News",Channel A\nhttps://cdn.example/a.m3u8\n';
const HLS_MASTER =
  '#EXT-X-STREAM-INF:BANDWIDTH=1280000,RESOLUTION=1280x720\nlow/index.m3u8\n' +
  '#EXT-X-STREAM-INF:BANDWIDTH=2560000,RESOLUTION=1920x1080\nhigh/index.m3u8\n';

/** Run `fn`, expecting it to reject with a PlaylistLoadError; returns the error. */
async function catchLoadError(promiseOrFn) {
  try {
    await (typeof promiseOrFn === 'function' ? promiseOrFn() : promiseOrFn);
  } catch (err) {
    expect(err).toBeInstanceOf(PlaylistLoadError);
    return err;
  }
  throw new Error('Expected a PlaylistLoadError to be thrown');
}

function stubFetch(impl) {
  const mock = vi.fn(impl);
  vi.stubGlobal('fetch', mock);
  return mock;
}

/** A Response whose body is streamed in the given chunks (no content-length). */
function streamResponse(chunks, { status = 200, delayMs = 0 } = {}) {
  let i = 0;
  const body = new ReadableStream({
    async pull(controller) {
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      if (i < chunks.length) controller.enqueue(chunks[i++]);
      else controller.close();
    },
  });
  return new Response(body, { status });
}

/** A body that sends one chunk and then stalls forever. */
function stallingResponse(first) {
  let sent = false;
  const body = new ReadableStream({
    pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(new TextEncoder().encode(first));
      }
      return new Promise(() => {}); // never resolves
    },
  });
  return new Response(body, { status: 200 });
}

/** Minimal response-like object (lets tests control `url`, headers and body). */
function fakeResponse({ text = M3U, status = 200, url = '', headers = {}, statusText = '' } = {}) {
  const bytes = typeof text === 'string' ? new TextEncoder().encode(text) : text;
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    url,
    headers: new Headers(headers),
    body: null,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------------------------------------

describe('PlaylistLoadError', () => {
  it('carries code, status, cause and a friendly default message', () => {
    const cause = new TypeError('Failed to fetch');
    const err = new PlaylistLoadError('HTTP', undefined, { status: 404, cause });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('PlaylistLoadError');
    expect(err.code).toBe('HTTP');
    expect(err.status).toBe(404);
    expect(err.cause).toBe(cause);
    expect(err.message).toMatch(/404/);
  });

  it('keeps an explicit message and defaults status to null', () => {
    const err = new PlaylistLoadError('NETWORK', 'Custom message');
    expect(err.message).toBe('Custom message');
    expect(err.status).toBeNull();
  });
});

describe('normalizePlaylistUrl', () => {
  it.each([
    ['https://example.com/list.m3u', 'https://example.com/list.m3u'],
    ['  https://example.com/list.m3u  ', 'https://example.com/list.m3u'],
    ['http://example.com/list.m3u', 'http://example.com/list.m3u'],
    ['HTTPS://Example.COM/List.m3u', 'https://example.com/List.m3u'],
    ['example.com/list.m3u', 'https://example.com/list.m3u'],
    ['www.example.com', 'https://www.example.com/'],
    ['//cdn.example.com/a.m3u8', 'https://cdn.example.com/a.m3u8'],
    ['example.com:8080/get.php?username=u&password=p&type=m3u_plus', 'https://example.com:8080/get.php?username=u&password=p&type=m3u_plus'],
    ['localhost:34400/m3u/list.m3u', 'https://localhost:34400/m3u/list.m3u'],
    ['192.168.1.10:8000/playlist.m3u', 'https://192.168.1.10:8000/playlist.m3u'],
    ['"https://example.com/quoted.m3u"', 'https://example.com/quoted.m3u'],
    ['<https://example.com/angle.m3u>', 'https://example.com/angle.m3u'],
    ['https://example.com/a b.m3u', 'https://example.com/a%20b.m3u'],
  ])('%s → %s', (input, expected) => {
    expect(normalizePlaylistUrl(input)).toBe(expected);
  });

  it.each([
    ['', 'empty'],
    ['   ', 'empty'],
    [null, 'empty'],
    ['ftp://example.com/list.m3u', 'scheme'],
    ['file:///home/me/list.m3u', 'scheme'],
    ['rtmp://example.com/live', 'scheme'],
    ['javascript:alert(1)', 'scheme'],
    ['data:text/plain,hello', 'scheme'],
    ['hello world', 'syntax'],
    ['news', 'syntax'],
    ['https://', 'syntax'],
    ['https://user:pass@example.com/list.m3u', 'credentials'],
  ])('rejects %j (%s)', async (input, reason) => {
    const err = await catchLoadError(() => normalizePlaylistUrl(input));
    expect(err.code).toBe('INVALID_URL');
    expect(err.details.reason).toBe(reason);
    expect(err.message.length).toBeGreaterThan(20);
  });
});

describe('buildProxyUrl', () => {
  const target = 'http://example.com/list.m3u?a=1&b=2';

  it('appends the encoded URL when the proxy ends with "="', () => {
    expect(buildProxyUrl('https://proxy.example/?url=', target)).toBe(
      `https://proxy.example/?url=${encodeURIComponent(target)}`,
    );
  });

  it('replaces a {url} placeholder with the encoded URL', () => {
    expect(buildProxyUrl('https://proxy.example/fetch/{url}?raw=1', target)).toBe(
      `https://proxy.example/fetch/${encodeURIComponent(target)}?raw=1`,
    );
  });

  it('uses other proxies as a plain prefix', () => {
    expect(buildProxyUrl('https://proxy.example/', target)).toBe(`https://proxy.example/${target}`);
  });

  it('returns an empty string for empty or invalid proxies', () => {
    expect(buildProxyUrl('', target)).toBe('');
    expect(buildProxyUrl('   ', target)).toBe('');
    expect(buildProxyUrl(undefined, target)).toBe('');
    expect(buildProxyUrl('proxy.example/?url=', target)).toBe('');
  });
});

// ---------------------------------------------------------------------------------------------------------

describe('fetchPlaylist', () => {
  beforeEach(() => {
    vi.stubGlobal('navigator', { ...globalThis.navigator, onLine: true });
  });

  it('downloads and returns the text with fetch options per spec', async () => {
    const fetch = stubFetch(async () => new Response(M3U, { status: 200 }));
    const result = await fetchPlaylist('https://example.com/list.m3u', { pageProtocol: 'https:' });
    expect(result).toEqual({
      text: M3U,
      finalUrl: 'https://example.com/list.m3u',
      viaProxy: false,
      upgraded: false,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://example.com/list.m3u');
    expect(init).toMatchObject({ credentials: 'omit', cache: 'no-cache', redirect: 'follow' });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('normalizes scheme-less input before fetching', async () => {
    const fetch = stubFetch(async () => new Response(M3U));
    await fetchPlaylist('example.com/list.m3u', { pageProtocol: 'https:' });
    expect(fetch.mock.calls[0][0]).toBe('https://example.com/list.m3u');
  });

  it('reports the final URL after redirects', async () => {
    stubFetch(async () => fakeResponse({ url: 'https://cdn.example/real/list.m3u' }));
    const result = await fetchPlaylist('https://example.com/short', { pageProtocol: 'https:' });
    expect(result.finalUrl).toBe('https://cdn.example/real/list.m3u');
    expect(result.text).toBe(M3U);
  });

  it('reads streamed bodies made of several chunks', async () => {
    const encoder = new TextEncoder();
    const parts = ['#EXTM3U\n#EXTINF:-1,Caf', 'é\nhttps://a.example/1.m3u8\n'];
    // split the UTF-8 "é" across chunks to check decoding is done on the whole body
    const bytes = encoder.encode(parts.join(''));
    const cut = encoder.encode(parts[0]).length + 1;
    stubFetch(async () => streamResponse([bytes.slice(0, cut), bytes.slice(cut)]));
    const { text } = await fetchPlaylist('https://example.com/list.m3u', { pageProtocol: 'https:' });
    expect(text).toBe(parts.join(''));
  });

  it('accepts HLS manifests (the controller turns them into a single channel)', async () => {
    stubFetch(async () => new Response(HLS_MASTER));
    const { text } = await fetchPlaylist('https://example.com/master.m3u8', { pageProtocol: 'https:' });
    expect(text).toBe(HLS_MASTER);
  });

  it('accepts plain URL-per-line lists', async () => {
    stubFetch(async () => new Response('https://a.example/1.m3u8\nhttps://a.example/2.m3u8\n'));
    await expect(fetchPlaylist('https://example.com/list.txt', { pageProtocol: 'https:' })).resolves.toBeTruthy();
  });

  it('throws INVALID_URL without calling fetch', async () => {
    const fetch = stubFetch(async () => new Response(M3U));
    const err = await catchLoadError(fetchPlaylist('ftp://example.com/list.m3u'));
    expect(err.code).toBe('INVALID_URL');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('throws HTTP with the status for non-2xx responses', async () => {
    stubFetch(async () => new Response('Not found', { status: 404, statusText: 'Not Found' }));
    const err = await catchLoadError(fetchPlaylist('https://example.com/missing.m3u', { pageProtocol: 'https:' }));
    expect(err.code).toBe('HTTP');
    expect(err.status).toBe(404);
    expect(err.message).toMatch(/404/);
    expect(describeLoadError(err)).toMatch(/wasn't found/);
  });

  it('does not retry HTTP errors through the proxy', async () => {
    const fetch = stubFetch(async () => new Response('', { status: 403 }));
    const err = await catchLoadError(
      fetchPlaylist('https://example.com/a.m3u', { pageProtocol: 'https:', corsProxy: 'https://proxy.example/?url=' }),
    );
    expect(err.code).toBe('HTTP');
    expect(err.status).toBe(403);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('maps a fetch TypeError to CORS when no proxy is configured', async () => {
    stubFetch(async () => {
      throw new TypeError('Failed to fetch');
    });
    const err = await catchLoadError(fetchPlaylist('https://example.com/list.m3u', { pageProtocol: 'https:' }));
    expect(err.code).toBe('CORS');
    expect(err.cause).toBeInstanceOf(TypeError);
    expect(err.message).toMatch(/other websites|CORS/);
    expect(err.message).toMatch(/upload/);
    expect(err.message).toMatch(/proxy/i);
  });

  it('maps a fetch TypeError to NETWORK (offline) when the browser is offline', async () => {
    vi.stubGlobal('navigator', { onLine: false });
    const fetch = stubFetch(async () => {
      throw new TypeError('Failed to fetch');
    });
    const err = await catchLoadError(
      fetchPlaylist('https://example.com/list.m3u', { pageProtocol: 'https:', corsProxy: 'https://p.example/?u=' }),
    );
    expect(err.code).toBe('NETWORK');
    expect(err.details.offline).toBe(true);
    expect(err.message).toMatch(/offline/);
    expect(fetch).toHaveBeenCalledTimes(1); // no pointless proxy retry while offline
  });

  it('retries through the CORS proxy ("=" suffix → encoded URL)', async () => {
    const target = 'https://example.com/list.m3u?type=m3u_plus&output=ts';
    const fetch = stubFetch(async (url) => {
      if (url === target) throw new TypeError('Failed to fetch');
      return new Response(M3U);
    });
    const result = await fetchPlaylist(target, {
      pageProtocol: 'https:',
      corsProxy: 'https://proxy.example/?url=',
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1][0]).toBe(`https://proxy.example/?url=${encodeURIComponent(target)}`);
    expect(result).toEqual({ text: M3U, finalUrl: target, viaProxy: true, upgraded: false });
  });

  it('retries through the CORS proxy ({url} placeholder and plain prefix)', async () => {
    const target = 'https://example.com/list.m3u';
    const fetch = stubFetch(async (url) => {
      if (url === target) throw new TypeError('Failed to fetch');
      return new Response(M3U);
    });
    await fetchPlaylist(target, { pageProtocol: 'https:', corsProxy: 'https://p.example/raw?u={url}&x=1' });
    expect(fetch.mock.calls[1][0]).toBe(`https://p.example/raw?u=${encodeURIComponent(target)}&x=1`);

    fetch.mockClear();
    await fetchPlaylist(target, { pageProtocol: 'https:', corsProxy: 'https://p.example/' });
    expect(fetch.mock.calls[1][0]).toBe(`https://p.example/${target}`);
  });

  it('throws NETWORK (via proxy) when the proxy is unreachable too', async () => {
    stubFetch(async () => {
      throw new TypeError('Failed to fetch');
    });
    const err = await catchLoadError(
      fetchPlaylist('https://example.com/list.m3u', { pageProtocol: 'https:', corsProxy: 'https://p.example/?url=' }),
    );
    expect(err.code).toBe('NETWORK');
    expect(err.details.viaProxy).toBe(true);
    expect(err.message).toMatch(/proxy/);
  });

  it('marks HTTP errors returned by the proxy', async () => {
    stubFetch(async (url) => {
      if (url.startsWith('https://example.com')) throw new TypeError('Failed to fetch');
      return new Response('', { status: 502 });
    });
    const err = await catchLoadError(
      fetchPlaylist('https://example.com/list.m3u', { pageProtocol: 'https:', corsProxy: 'https://p.example/?url=' }),
    );
    expect(err.code).toBe('HTTP');
    expect(err.status).toBe(502);
    expect(err.details.viaProxy).toBe(true);
    expect(err.message).toMatch(/CORS proxy/);
  });

  it('throws TIMEOUT when the server does not respond in time', async () => {
    stubFetch(() => new Promise(() => {})); // ignores the abort signal entirely
    const err = await catchLoadError(
      fetchPlaylist('https://example.com/slow.m3u', { pageProtocol: 'https:', timeoutMs: 30 }),
    );
    expect(err.code).toBe('TIMEOUT');
  });

  it('aborts the underlying request on timeout', async () => {
    let seenSignal;
    stubFetch(
      (url, init) =>
        new Promise((resolve, reject) => {
          seenSignal = init.signal;
          init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        }),
    );
    const err = await catchLoadError(
      fetchPlaylist('https://example.com/slow.m3u', { pageProtocol: 'https:', timeoutMs: 20 }),
    );
    expect(err.code).toBe('TIMEOUT');
    expect(seenSignal.aborted).toBe(true);
  });

  it('throws TIMEOUT when the body stalls mid-download', async () => {
    stubFetch(async () => stallingResponse('#EXTM3U\n'));
    const err = await catchLoadError(
      fetchPlaylist('https://example.com/stall.m3u', { pageProtocol: 'https:', timeoutMs: 40 }),
    );
    expect(err.code).toBe('TIMEOUT');
  });

  it('does not time out a slow but steady download (idle timeout resets per chunk)', async () => {
    const encoder = new TextEncoder();
    const chunks = ['#EXTM3U\n', '#EXTINF:-1,A\n', 'https://a.example/1.m3u8\n', '#EXTINF:-1,B\n'].map((c) =>
      encoder.encode(c),
    );
    stubFetch(async () => streamResponse(chunks, { delayMs: 25 }));
    const { text } = await fetchPlaylist('https://example.com/steady.m3u', { pageProtocol: 'https:', timeoutMs: 60 });
    expect(text).toContain('#EXTINF:-1,B');
  });

  it('throws ABORTED when the caller aborts', async () => {
    stubFetch(() => new Promise(() => {}));
    const controller = new AbortController();
    const promise = fetchPlaylist('https://example.com/list.m3u', { signal: controller.signal, pageProtocol: 'https:' });
    setTimeout(() => controller.abort(), 5);
    const err = await catchLoadError(promise);
    expect(err.code).toBe('ABORTED');
  });

  it('throws ABORTED immediately for an already-aborted signal', async () => {
    const fetch = stubFetch(async () => new Response(M3U));
    const controller = new AbortController();
    controller.abort();
    const err = await catchLoadError(
      fetchPlaylist('https://example.com/list.m3u', { signal: controller.signal, pageProtocol: 'https:' }),
    );
    expect(err.code).toBe('ABORTED');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not fall back to the proxy after a caller abort', async () => {
    const controller = new AbortController();
    const fetch = stubFetch(async () => {
      controller.abort();
      throw new DOMException('Aborted', 'AbortError');
    });
    const err = await catchLoadError(
      fetchPlaylist('https://example.com/list.m3u', {
        signal: controller.signal,
        pageProtocol: 'https:',
        corsProxy: 'https://p.example/?url=',
      }),
    );
    expect(err.code).toBe('ABORTED');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('throws EMPTY for empty or whitespace-only bodies', async () => {
    stubFetch(async () => new Response('  \n\r\n\t '));
    const err = await catchLoadError(fetchPlaylist('https://example.com/empty.m3u', { pageProtocol: 'https:' }));
    expect(err.code).toBe('EMPTY');
    stubFetch(async () => new Response(''));
    expect((await catchLoadError(fetchPlaylist('https://example.com/e.m3u', { pageProtocol: 'https:' }))).code).toBe(
      'EMPTY',
    );
  });

  it('throws NOT_M3U for HTML pages and other content', async () => {
    stubFetch(async () => new Response('<!DOCTYPE html><html><body>Login</body></html>'));
    const err = await catchLoadError(fetchPlaylist('https://example.com/page', { pageProtocol: 'https:' }));
    expect(err.code).toBe('NOT_M3U');
    expect(err.details.html).toBe(true);
    expect(err.message).toMatch(/web page/);

    stubFetch(async () => new Response('{"error":"invalid credentials"}'));
    const err2 = await catchLoadError(fetchPlaylist('https://example.com/api', { pageProtocol: 'https:' }));
    expect(err2.code).toBe('NOT_M3U');
    expect(err2.details.html).toBe(false);
  });

  it('throws TOO_LARGE while streaming past maxBytes', async () => {
    const chunk = new TextEncoder().encode(`#EXTM3U\n${'x'.repeat(1000)}\n`);
    let pulls = 0;
    const body = new ReadableStream({
      pull(controller) {
        pulls++;
        controller.enqueue(chunk);
      },
    });
    stubFetch(async () => new Response(body));
    const err = await catchLoadError(
      fetchPlaylist('https://example.com/huge.m3u', { pageProtocol: 'https:', maxBytes: 5000 }),
    );
    expect(err.code).toBe('TOO_LARGE');
    expect(pulls).toBeLessThan(10); // stopped reading early
  });

  it('throws TOO_LARGE early from Content-Length', async () => {
    stubFetch(async () => fakeResponse({ headers: { 'content-length': String(100 * 1024 * 1024) } }));
    const err = await catchLoadError(fetchPlaylist('https://example.com/huge.m3u', { pageProtocol: 'https:' }));
    expect(err.code).toBe('TOO_LARGE');
    expect(err.message).toMatch(/60 MB/);
  });

  it('throws TOO_LARGE for non-streaming bodies over the cap', async () => {
    stubFetch(async () => fakeResponse({ text: `#EXTM3U\n${'y'.repeat(500)}` }));
    const err = await catchLoadError(
      fetchPlaylist('https://example.com/a.m3u', { pageProtocol: 'https:', maxBytes: 100 }),
    );
    expect(err.code).toBe('TOO_LARGE');
  });

  it('throws NETWORK when the connection drops mid-body', async () => {
    let sent = false;
    const body = new ReadableStream({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(new TextEncoder().encode('#EXTM3U\n'));
        } else controller.error(new TypeError('network error'));
      },
    });
    stubFetch(async () => new Response(body));
    const err = await catchLoadError(fetchPlaylist('https://example.com/a.m3u', { pageProtocol: 'https:' }));
    expect(err.code).toBe('NETWORK');
    expect(err.details.reason).toBe('interrupted');
  });

  describe('encodings', () => {
    it('decodes windows-1252 / Latin-1 playlists', async () => {
      const latin1 = Uint8Array.from(
        '#EXTM3U\n#EXTINF:-1 group-title="Fran\xe7ais",Caf\xe9 T\xe9l\xe9\nhttp://a.example/1.ts\n',
        (c) => c.charCodeAt(0),
      );
      stubFetch(async () => fakeResponse({ text: latin1 }));
      const { text } = await fetchPlaylist('https://example.com/latin1.m3u', { pageProtocol: 'https:' });
      expect(text).toContain('Café Télé');
      expect(text).toContain('Français');
      expect(text).not.toContain('\uFFFD');
    });

    it('keeps UTF-8 (and strips the BOM)', async () => {
      const utf8 = new TextEncoder().encode(`\uFEFF#EXTM3U\n#EXTINF:-1,Канал Ünï 日本\nhttps://a.example/1.m3u8\n`);
      stubFetch(async () => fakeResponse({ text: utf8 }));
      const { text } = await fetchPlaylist('https://example.com/utf8.m3u', { pageProtocol: 'https:' });
      expect(text.startsWith('#EXTM3U')).toBe(true);
      expect(text).toContain('Канал Ünï 日本');
    });

    it('keeps UTF-8 when only a few bytes are broken among many valid characters', async () => {
      const valid = new TextEncoder().encode(`#EXTM3U\n#EXTINF:-1,Канал Первый Второй Третий\nhttps://a/1\n`);
      const bytes = new Uint8Array(valid.length + 1);
      bytes.set(valid);
      bytes[valid.length] = 0xff; // one stray invalid byte
      stubFetch(async () => fakeResponse({ text: bytes }));
      const { text } = await fetchPlaylist('https://example.com/mixed.m3u', { pageProtocol: 'https:' });
      expect(text).toContain('Канал Первый');
    });

    it('decodes UTF-16 with a BOM', async () => {
      const source = '#EXTM3U\n#EXTINF:-1,Ünïcode\nhttps://a.example/1.m3u8\n';
      const bytes = new Uint8Array(2 + source.length * 2);
      bytes[0] = 0xff;
      bytes[1] = 0xfe;
      for (let i = 0; i < source.length; i++) {
        bytes[2 + i * 2] = source.charCodeAt(i) & 0xff;
        bytes[3 + i * 2] = source.charCodeAt(i) >> 8;
      }
      stubFetch(async () => fakeResponse({ text: bytes }));
      const { text } = await fetchPlaylist('https://example.com/utf16.m3u', { pageProtocol: 'https:' });
      expect(text).toBe(source);
    });
  });

  describe('mixed content (https page, http playlist)', () => {
    const httpUrl = 'http://example.com/list.m3u';

    it('upgrades to https first', async () => {
      const fetch = stubFetch(async () => new Response(M3U));
      const result = await fetchPlaylist(httpUrl, { pageProtocol: 'https:' });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch.mock.calls[0][0]).toBe('https://example.com/list.m3u');
      expect(result).toEqual({ text: M3U, finalUrl: 'https://example.com/list.m3u', viaProxy: false, upgraded: true });
    });

    it('drops an explicit :80 port when upgrading', async () => {
      const fetch = stubFetch(async () => new Response(M3U));
      await fetchPlaylist('http://example.com:80/list.m3u', { pageProtocol: 'https:' });
      expect(fetch.mock.calls[0][0]).toBe('https://example.com/list.m3u');
    });

    it('throws MIXED_CONTENT when the https version fails and no proxy is set', async () => {
      const fetch = stubFetch(async () => {
        throw new TypeError('Failed to fetch');
      });
      const err = await catchLoadError(fetchPlaylist(httpUrl, { pageProtocol: 'https:' }));
      expect(err.code).toBe('MIXED_CONTENT');
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch.mock.calls[0][0]).toBe('https://example.com/list.m3u'); // never the blocked http URL
      expect(err.message).toMatch(/insecure/);
      expect(err.message).toMatch(/https:\/\/ link/);
      expect(err.message).toMatch(/upload/);
      expect(err.message).toMatch(/CORS proxy in Settings/);
    });

    it('also throws MIXED_CONTENT when the https version returns an error or a non-playlist', async () => {
      stubFetch(async () => new Response('', { status: 404 }));
      expect((await catchLoadError(fetchPlaylist(httpUrl, { pageProtocol: 'https:' }))).code).toBe('MIXED_CONTENT');
      stubFetch(async () => new Response('<html><body>Default vhost</body></html>'));
      expect((await catchLoadError(fetchPlaylist(httpUrl, { pageProtocol: 'https:' }))).code).toBe('MIXED_CONTENT');
    });

    it('falls back to the proxy with the ORIGINAL http URL', async () => {
      const fetch = stubFetch(async (url) => {
        if (url.startsWith('https://example.com')) throw new TypeError('Failed to fetch');
        return new Response(M3U);
      });
      const result = await fetchPlaylist(httpUrl, { pageProtocol: 'https:', corsProxy: 'https://proxy.example/?url=' });
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(fetch.mock.calls[1][0]).toBe(`https://proxy.example/?url=${encodeURIComponent(httpUrl)}`);
      expect(result).toEqual({ text: M3U, finalUrl: httpUrl, viaProxy: true, upgraded: false });
    });

    it('does not upgrade when the page itself is http:', async () => {
      const fetch = stubFetch(async () => new Response(M3U));
      const result = await fetchPlaylist(httpUrl, { pageProtocol: 'http:' });
      expect(fetch.mock.calls[0][0]).toBe(httpUrl);
      expect(result.upgraded).toBe(false);
    });

    it('defaults pageProtocol to location.protocol', async () => {
      expect(globalThis.location.protocol).toBe('http:'); // happy-dom default
      const fetch = stubFetch(async () => new Response(M3U));
      await fetchPlaylist(httpUrl);
      expect(fetch.mock.calls[0][0]).toBe(httpUrl);
    });

    it('does not upgrade loopback hosts (browsers allow them on https pages)', async () => {
      const fetch = stubFetch(async () => new Response(M3U));
      const result = await fetchPlaylist('http://localhost:34400/m3u/list.m3u', { pageProtocol: 'https:' });
      expect(fetch.mock.calls[0][0]).toBe('http://localhost:34400/m3u/list.m3u');
      expect(result.upgraded).toBe(false);
      await fetchPlaylist('http://127.0.0.1:8080/a.m3u', { pageProtocol: 'https:' });
      expect(fetch.mock.calls[1][0]).toBe('http://127.0.0.1:8080/a.m3u');
    });

    it('rethrows TOO_LARGE from the upgraded attempt instead of masking it', async () => {
      stubFetch(async () => fakeResponse({ headers: { 'content-length': '999999999' } }));
      const err = await catchLoadError(fetchPlaylist(httpUrl, { pageProtocol: 'https:' }));
      expect(err.code).toBe('TOO_LARGE');
    });
  });
});

// ---------------------------------------------------------------------------------------------------------

describe('readPlaylistFile', () => {
  it('reads .m3u files', async () => {
    const file = new File([M3U], 'channels.m3u', { type: '' });
    await expect(readPlaylistFile(file)).resolves.toBe(M3U);
  });

  it.each([
    ['list.m3u8', 'application/vnd.apple.mpegurl'],
    ['list.M3U', 'audio/x-mpegurl'],
    ['list.txt', 'text/plain'],
    ['playlist', 'audio/x-mpegurl'],
    ['playlist', 'application/x-mpegurl'],
    ['playlist', 'text/plain;charset=utf-8'],
    ['playlist', ''],
    ['list.m3u', 'application/octet-stream'],
  ])('accepts %s (%s)', async (name, type) => {
    await expect(readPlaylistFile(new File([M3U], name, { type }))).resolves.toBe(M3U);
  });

  it.each([
    ['movie.mp4', 'video/mp4'],
    ['photo.png', 'image/png'],
    ['archive.zip', 'application/zip'],
  ])('rejects %s (%s) with FILE_TYPE', async (name, type) => {
    const err = await catchLoadError(readPlaylistFile(new File([M3U], name, { type })));
    expect(err.code).toBe('FILE_TYPE');
    expect(err.message).toContain(name);
  });

  it('enforces maxBytes', async () => {
    const file = new File([`#EXTM3U\n${'x'.repeat(200)}`], 'big.m3u');
    const err = await catchLoadError(readPlaylistFile(file, { maxBytes: 100 }));
    expect(err.code).toBe('TOO_LARGE');
    expect(err.details.source).toBe('file');
  });

  it('throws EMPTY for empty files', async () => {
    const err = await catchLoadError(readPlaylistFile(new File([''], 'empty.m3u')));
    expect(err.code).toBe('EMPTY');
    expect(err.message).toMatch(/file is empty/);
  });

  it('throws NOT_M3U for text files that are not playlists', async () => {
    const err = await catchLoadError(readPlaylistFile(new File(['just some notes'], 'notes.txt')));
    expect(err.code).toBe('NOT_M3U');
    expect(err.message).toMatch(/isn't an M3U playlist/);
  });

  it('accepts HLS manifests', async () => {
    await expect(readPlaylistFile(new File([HLS_MASTER], 'master.m3u8'))).resolves.toBe(HLS_MASTER);
  });

  it('decodes Latin-1 files', async () => {
    const bytes = Uint8Array.from('#EXTM3U\n#EXTINF:-1,Caf\xe9\nhttp://a/1\n', (c) => c.charCodeAt(0));
    const text = await readPlaylistFile(new File([bytes], 'latin1.m3u'));
    expect(text).toContain('Café');
  });

  it('throws READ when the file cannot be read', async () => {
    const broken = {
      name: 'gone.m3u',
      type: '',
      size: 10,
      arrayBuffer: () => Promise.reject(new DOMException('The file could not be read.', 'NotReadableError')),
    };
    const err = await catchLoadError(readPlaylistFile(broken));
    expect(err.code).toBe('READ');
    expect(err.message).toContain('gone.m3u');
  });

  it('throws READ when no file is given', async () => {
    expect((await catchLoadError(readPlaylistFile(null))).code).toBe('READ');
  });

  it('falls back to file.text() for blob-likes without arrayBuffer()', async () => {
    const blobLike = { name: 'a.m3u', type: '', size: M3U.length, text: async () => M3U };
    await expect(readPlaylistFile(blobLike)).resolves.toBe(M3U);
  });
});

// ---------------------------------------------------------------------------------------------------------

describe('describeLoadError', () => {
  const describeCode = (code, opts) => describeLoadError(new PlaylistLoadError(code, undefined, opts));

  it.each([
    ['INVALID_URL', /valid playlist link/],
    ['MIXED_CONTENT', /insecure.*https:\/\/ link.*upload.*CORS proxy/s],
    ['NETWORK', /Couldn't reach/],
    ['CORS', /other websites.*upload.*CORS proxy/s],
    ['HTTP', /HTTP/],
    ['TIMEOUT', /too long/],
    ['EMPTY', /empty/],
    ['NOT_M3U', /M3U/],
    ['TOO_LARGE', /too large/],
    ['ABORTED', /cancelled/],
    ['FILE_TYPE', /\.m3u, \.m3u8 or \.txt/],
    ['READ', /couldn't be read/],
  ])('has friendly copy for %s', (code, pattern) => {
    const text = describeCode(code);
    expect(text).toMatch(pattern);
    expect(text).toMatch(/[.!]$/);
    expect(text.length).toBeGreaterThan(15);
  });

  it.each([
    [401, /denied/],
    [403, /denied/],
    [404, /wasn't found/],
    [410, /wasn't found/],
    [429, /limiting/],
    [500, /ran into a problem/],
    [503, /ran into a problem/],
    [504, /too long/],
    [400, /rejected/],
  ])('tailors HTTP %i copy', (status, pattern) => {
    const text = describeCode('HTTP', { status });
    expect(text).toMatch(pattern);
    expect(text).toContain(String(status));
  });

  it('uses details for tailored copy', () => {
    expect(describeCode('TIMEOUT', { details: { timeoutMs: 25000 } })).toMatch(/25 s/);
    expect(describeCode('TOO_LARGE', { details: { maxBytes: 60 * 1024 * 1024 } })).toMatch(/over 60 MB/);
    expect(describeCode('NETWORK', { details: { offline: true } })).toMatch(/offline/);
    expect(describeCode('NOT_M3U', { details: { html: true } })).toMatch(/web page/);
    expect(describeCode('FILE_TYPE', { details: { fileName: 'clip.mp4' } })).toContain('“clip.mp4”');
    expect(describeCode('INVALID_URL', { details: { reason: 'scheme', scheme: 'rtmp' } })).toMatch(/rtmp:/);
  });

  it('matches the message of thrown errors', async () => {
    stubFetch(async () => new Response('', { status: 404 }));
    const err = await catchLoadError(fetchPlaylist('https://example.com/x.m3u', { pageProtocol: 'https:' }));
    expect(describeLoadError(err)).toBe(err.message);
  });

  it('handles foreign errors and odd values', () => {
    expect(describeLoadError(new DOMException('Aborted', 'AbortError'))).toMatch(/cancelled/);
    expect(describeLoadError(new TypeError('Failed to fetch'))).toMatch(/other websites/);
    expect(describeLoadError(new Error('No channels found in this playlist.'))).toBe(
      'No channels found in this playlist.',
    );
    expect(describeLoadError('Plain string message.')).toBe('Plain string message.');
    expect(describeLoadError(null)).toMatch(/Something went wrong/);
    expect(describeLoadError({})).toMatch(/Something went wrong/);
    expect(describeLoadError({ code: 'ECONNRESET', message: '' })).toMatch(/Something went wrong/);
    expect(describeLoadError({ code: 'toString' })).toMatch(/Something went wrong/);
    expect(describeLoadError({ code: 'CORS' })).toMatch(/other websites/); // duck-typed errors
  });
});
