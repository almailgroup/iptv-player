import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  detectStreamType,
  upgradeToHttps,
  isMixedContent,
  sniffStreamType,
  backoffDelay,
  classifyBytes,
  classifyContentType,
} from '../src/player/stream-type.js';

describe('detectStreamType', () => {
  const table = [
    // HLS by extension
    ['https://example.com/live/stream.m3u8', 'hls'],
    ['https://example.com/live/stream.M3U8?token=abc&exp=1', 'hls'],
    ['http://example.com/channels/playlist.m3u', 'hls'],
    ['https://demo.unified-streaming.com/k8s/features/stable/video/tos/tears-of-steel.ism/.m3u8', 'hls'],
    ['https://example.com/video.m3u8/', 'hls'],
    ['//cdn.example.com/live/index.m3u8', 'hls'],
    // MPEG-TS / FLV
    ['http://host.tv:8080/live/user/pass/1234.ts', 'mpegts'],
    ['http://host.tv/vod/movie.mts', 'mpegts'],
    ['http://host.tv/vod/movie.m2ts', 'mpegts'],
    ['http://host.tv/live/stream.flv', 'flv'],
    // Native containers
    ['https://cdn.example.com/movie.mp4', 'native'],
    ['https://cdn.example.com/movie.M4V', 'native'],
    ['https://cdn.example.com/clip.webm', 'native'],
    ['https://cdn.example.com/clip.ogv', 'native'],
    ['https://radio.example.com/live.ogg', 'native'],
    ['https://cdn.example.com/clip.mov', 'native'],
    ['http://radio.example.com:8000/stream.mp3', 'native'],
    ['http://radio.example.com:8000/;stream.mp3', 'native'],
    ['https://radio.example.com/live.aac', 'native'],
    ['https://radio.example.com/live.m4a', 'native'],
    ['https://radio.example.com/live.opus', 'native'],
    ['https://cdn.example.com/sound.wav', 'native'],
    ['https://cdn.example.com/movie.mkv', 'native'],
    // DASH
    ['https://cdn.example.com/dash/manifest.mpd', 'dash'],
    ['https://cdn.example.com/video.ism/manifest(format=mpd-time-csf)', 'dash'],
    // Unsupported protocols
    ['rtmp://live.example.com/app/stream', 'unsupported'],
    ['rtmps://live.example.com/app/stream', 'unsupported'],
    ['rtsp://camera.local:554/stream1', 'unsupported'],
    ['udp://@239.0.0.1:1234', 'unsupported'],
    ['rtp://239.0.0.1:5004', 'unsupported'],
    ['mms://media.example.com/stream', 'unsupported'],
    ['mmsh://media.example.com/stream', 'unsupported'],
    ['srt://example.com:9000?streamid=abc', 'unsupported'],
    ['acestream://0123456789abcdef', 'unsupported'],
    // Query hints
    ['http://host.tv/play.php?id=5&type=m3u8', 'hls'],
    ['http://host.tv/stream?format=m3u8', 'hls'],
    ['http://host.tv/live/get?id=1&output=hls', 'hls'],
    ['http://host.tv/live/get?id=1&output=m3u8', 'hls'],
    ['http://host.tv/live/get?id=1&output=ts', 'mpegts'],
    ['http://host.tv/live/get?id=1&output=mpegts', 'mpegts'],
    // Path heuristics
    ['https://cdn.example.com/hls/channel1', 'hls'],
    ['https://cdn.example.com/channel/m3u8/index', 'hls'],
    ['https://proxy.example.com/redirect?url=https%3A%2F%2Fx.example%2Fa.m3u8', 'hls'],
    // Unknown
    ['http://host.tv:8080/user/pass/1234', 'unknown'],
    ['https://example.com/', 'unknown'],
    ['https://example.com/watch.php?id=7', 'unknown'],
    ['', 'unknown'],
    ['not a url', 'unknown'],
  ];

  it.each(table)('%s → %s', (url, expected) => {
    expect(detectStreamType(url)).toBe(expected);
  });

  it('has a large table', () => {
    expect(table.length).toBeGreaterThanOrEqual(25);
  });

  it('tolerates non-string input', () => {
    expect(detectStreamType(null)).toBe('unknown');
    expect(detectStreamType(undefined)).toBe('unknown');
  });

  it('extension wins over misleading query hints', () => {
    expect(detectStreamType('https://x.example/movie.mp4?type=m3u8')).toBe('native');
  });
});

describe('upgradeToHttps', () => {
  it('switches http to https keeping host, path and query', () => {
    expect(upgradeToHttps('http://example.com/live/a.m3u8?t=1')).toBe('https://example.com/live/a.m3u8?t=1');
  });

  it('keeps explicit non-default ports', () => {
    expect(upgradeToHttps('http://example.com:8080/x.ts')).toBe('https://example.com:8080/x.ts');
  });

  it('drops a port that becomes the default', () => {
    expect(upgradeToHttps('http://example.com:443/x')).toBe('https://example.com/x');
  });

  it('leaves https, other schemes and garbage untouched', () => {
    expect(upgradeToHttps('https://example.com/x')).toBe('https://example.com/x');
    expect(upgradeToHttps('rtmp://example.com/live')).toBe('rtmp://example.com/live');
    expect(upgradeToHttps('not a url')).toBe('not a url');
    expect(upgradeToHttps('')).toBe('');
  });
});

describe('isMixedContent', () => {
  it('flags http streams on https pages', () => {
    expect(isMixedContent('http://example.com/a.m3u8', 'https:')).toBe(true);
  });

  it('does not flag https streams or http pages', () => {
    expect(isMixedContent('https://example.com/a.m3u8', 'https:')).toBe(false);
    expect(isMixedContent('http://example.com/a.m3u8', 'http:')).toBe(false);
    expect(isMixedContent('http://example.com/a.m3u8', 'file:')).toBe(false);
  });

  it('exempts loopback hosts (potentially trustworthy origins)', () => {
    expect(isMixedContent('http://localhost:8080/a.m3u8', 'https:')).toBe(false);
    expect(isMixedContent('http://127.0.0.1/a.m3u8', 'https:')).toBe(false);
    expect(isMixedContent('http://[::1]:8000/a.m3u8', 'https:')).toBe(false);
    expect(isMixedContent('http://tv.localhost/a.m3u8', 'https:')).toBe(false);
  });

  it('ignores non-http URLs and garbage', () => {
    expect(isMixedContent('rtmp://example.com/live', 'https:')).toBe(false);
    expect(isMixedContent('garbage', 'https:')).toBe(false);
  });

  it('defaults to location.protocol', () => {
    const expected = globalThis.location?.protocol === 'https:';
    expect(isMixedContent('http://example.com/a.m3u8')).toBe(expected);
  });
});

describe('backoffDelay', () => {
  afterEach(() => vi.restoreAllMocks());

  it('doubles from the base and caps at max (no jitter at random = 0.5)', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    expect(backoffDelay(1)).toBe(1000);
    expect(backoffDelay(2)).toBe(2000);
    expect(backoffDelay(3)).toBe(4000);
    expect(backoffDelay(4)).toBe(8000);
    expect(backoffDelay(5)).toBe(15000);
    expect(backoffDelay(50)).toBe(15000);
  });

  it('applies symmetric jitter within ±20% and never exceeds max', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    expect(backoffDelay(1)).toBe(800);
    expect(backoffDelay(5)).toBe(12000);
    vi.spyOn(Math, 'random').mockReturnValue(0.999999);
    expect(backoffDelay(1)).toBe(1200);
    expect(backoffDelay(5)).toBe(15000);
  });

  it('stays within bounds for random samples', () => {
    for (let attempt = 1; attempt <= 10; attempt++) {
      const raw = Math.min(15000, 1000 * 2 ** (attempt - 1));
      for (let i = 0; i < 200; i++) {
        const d = backoffDelay(attempt);
        expect(Number.isInteger(d)).toBe(true);
        expect(d).toBeGreaterThanOrEqual(Math.floor(raw * 0.8));
        expect(d).toBeLessThanOrEqual(Math.min(15000, Math.ceil(raw * 1.2)));
      }
    }
  });

  it('treats invalid attempts as the first attempt', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    expect(backoffDelay(0)).toBe(1000);
    expect(backoffDelay(-3)).toBe(1000);
    expect(backoffDelay(Number.NaN)).toBe(1000);
  });

  it('honors custom options', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.9);
    expect(backoffDelay(3, { base: 500, max: 60000, jitter: 0 })).toBe(2000);
    expect(backoffDelay(10, { base: 500, max: 3000, jitter: 0 })).toBe(3000);
  });
});

// ---------------------------------------------------------------------------------------------------------

const enc = (text) => new TextEncoder().encode(text);

function tsBytes(packets = 4, offset = 0) {
  const bytes = new Uint8Array(offset + packets * 188);
  for (let i = 0; i < offset; i++) bytes[i] = 0x11;
  for (let p = 0; p < packets; p++) {
    bytes[offset + p * 188] = 0x47;
    for (let i = 1; i < 188; i++) bytes[offset + p * 188 + i] = (i * 7) & 0x3f;
  }
  return bytes;
}

/** Minimal fetch Response stand-in with a streaming body. */
function fakeResponse({ chunks = [], contentType = '', status = 200, url = '', infinite = null } = {}) {
  const state = { reads: 0, cancelled: false };
  const queue = chunks.map((c) => (typeof c === 'string' ? enc(c) : c));
  const reader = {
    read: vi.fn(async () => {
      state.reads += 1;
      if (infinite) return { done: false, value: infinite() };
      if (!queue.length) return { done: true, value: undefined };
      return { done: false, value: queue.shift() };
    }),
    cancel: vi.fn(async () => {
      state.cancelled = true;
    }),
  };
  return {
    state,
    reader,
    response: {
      ok: status >= 200 && status < 300,
      status,
      url,
      headers: { get: (name) => (name.toLowerCase() === 'content-type' ? contentType : null) },
      body: { getReader: () => reader },
    },
  };
}

describe('sniffStreamType', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const sniffWith = async (opts, url = 'https://example.com/stream') => {
    const fake = fakeResponse(opts);
    const fetchMock = vi.fn(async () => fake.response);
    vi.stubGlobal('fetch', fetchMock);
    const result = await sniffStreamType(url);
    return { result, fetchMock, fake };
  };

  it('detects HLS playlists', async () => {
    const { result, fetchMock } = await sniffWith({ chunks: ['#EXTM3U\n#EXT-X-VERSION:3\n'] });
    expect(result).toBe('hls');
    const [, init] = fetchMock.mock.calls[0];
    expect(init.credentials).toBe('omit');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('detects HLS with a BOM and leading whitespace', async () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x0a, ...enc('#EXTM3U\n')]);
    expect((await sniffWith({ chunks: [bytes] })).result).toBe('hls');
  });

  it('detects MPEG-TS sync bytes, also when starting mid-packet', async () => {
    expect((await sniffWith({ chunks: [tsBytes(4)] })).result).toBe('mpegts');
    expect((await sniffWith({ chunks: [tsBytes(5, 37)] })).result).toBe('mpegts');
  });

  it('detects MPEG-TS split across chunks', async () => {
    const bytes = tsBytes(6);
    expect((await sniffWith({ chunks: [bytes.slice(0, 100), bytes.slice(100, 500), bytes.slice(500)] })).result)
      .toBe('mpegts');
  });

  it('detects FLV', async () => {
    expect((await sniffWith({ chunks: [new Uint8Array([0x46, 0x4c, 0x56, 0x01, 0x05, 0, 0, 0, 9])] })).result)
      .toBe('flv');
  });

  it('detects native containers (MP4, WebM/MKV, Ogg, ID3/MP3)', async () => {
    const mp4 = new Uint8Array([0, 0, 0, 0x18, ...enc('ftypisom'), 0, 0, 2, 0]);
    expect((await sniffWith({ chunks: [mp4] })).result).toBe('native');
    const ebml = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3]);
    expect((await sniffWith({ chunks: [ebml] })).result).toBe('native');
    expect((await sniffWith({ chunks: [enc('OggS\0\x02')] })).result).toBe('native');
    expect((await sniffWith({ chunks: [enc('ID3\x04\0\0')] })).result).toBe('native');
  });

  it('falls back to the Content-Type header', async () => {
    const junk = [new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])];
    const byType = async (contentType) => (await sniffWith({ chunks: junk, contentType })).result;
    expect(await byType('application/vnd.apple.mpegurl')).toBe('hls');
    expect(await byType('audio/x-mpegurl; charset=utf-8')).toBe('hls');
    expect(await byType('video/MP2T')).toBe('mpegts');
    expect(await byType('video/x-flv')).toBe('flv');
    expect(await byType('video/mp4')).toBe('native');
    expect(await byType('audio/mpeg')).toBe('native');
  });

  it('uses the redirect target URL as a last resort', async () => {
    const { result } = await sniffWith({
      chunks: [new Uint8Array([1, 2, 3])],
      contentType: 'application/octet-stream',
      url: 'https://cdn.example.com/live/index.m3u8',
    });
    expect(result).toBe('hls');
  });

  it('returns null for unrecognized content', async () => {
    const { result } = await sniffWith({ chunks: ['<!doctype html><html>'], contentType: 'text/html' });
    expect(result).toBeNull();
  });

  it('returns null for non-2xx responses', async () => {
    expect((await sniffWith({ chunks: ['#EXTM3U'], status: 404 })).result).toBeNull();
  });

  it('returns null when fetch fails (CORS / network)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }));
    await expect(sniffStreamType('https://example.com/x')).resolves.toBeNull();
  });

  it('returns null without fetching for non-http URLs', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(sniffStreamType('rtmp://example.com/live')).resolves.toBeNull();
    await expect(sniffStreamType('garbage')).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('times out and resolves null', async () => {
    vi.stubGlobal('fetch', vi.fn((url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    })));
    await expect(sniffStreamType('https://example.com/slow', { timeoutMs: 20 })).resolves.toBeNull();
  });

  it('honors the caller abort signal', async () => {
    vi.stubGlobal('fetch', vi.fn((url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    })));
    const controller = new AbortController();
    const { signal } = controller;
    const pending = sniffStreamType('https://example.com/slow', { signal, timeoutMs: 60000 });
    controller.abort();
    await expect(pending).resolves.toBeNull();
    await expect(sniffStreamType('https://example.com/x', { signal: controller.signal })).resolves.toBeNull();
  });

  it('reads only a small prefix of endless streams and cancels the body', async () => {
    const chunk = tsBytes(87); // 16,356 bytes per read, forever
    const { result, fake } = await sniffWith({ infinite: () => chunk });
    expect(result).toBe('mpegts');
    expect(fake.state.reads).toBeLessThanOrEqual(4); // ≤ 64 KB
    expect(fake.reader.cancel).toHaveBeenCalled();
  });

  it('still classifies by Content-Type when reading the body fails', async () => {
    const fake = fakeResponse({ contentType: 'video/mp2t' });
    fake.reader.read.mockRejectedValue(new TypeError('network error'));
    vi.stubGlobal('fetch', vi.fn(async () => fake.response));
    await expect(sniffStreamType('https://example.com/x')).resolves.toBe('mpegts');
  });
});

describe('classifyBytes / classifyContentType', () => {
  it('handles empty input', () => {
    expect(classifyBytes(new Uint8Array(0))).toBeNull();
    expect(classifyBytes(null)).toBeNull();
    expect(classifyContentType('')).toBeNull();
  });

  it('does not mistake a single 0x47 byte for MPEG-TS', () => {
    const bytes = new Uint8Array(600);
    bytes[0] = 0x47;
    expect(classifyBytes(bytes)).toBeNull();
  });

  it('detects M2TS (192-byte packets)', () => {
    const bytes = new Uint8Array(192 * 4);
    for (let p = 0; p < 4; p++) bytes[p * 192 + 4] = 0x47;
    expect(classifyBytes(bytes)).toBe('mpegts');
  });

  it('detects playlists preceded by comments', () => {
    expect(classifyBytes(enc('# generated\n#EXTINF:-1,News\nhttp://x/a.ts\n'))).toBe('hls');
  });

  it('ignores DASH manifests and generic types', () => {
    expect(classifyContentType('application/dash+xml')).toBeNull();
    expect(classifyContentType('application/octet-stream')).toBeNull();
    expect(classifyContentType('text/plain')).toBeNull();
  });
});
