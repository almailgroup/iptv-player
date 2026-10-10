// The stream relay loader (makeProxyLoader) against the REAL hls.js: its default XHR loader does the
// requests, retries, timeouts and aborts, and a real Hls instance parses what comes back. Only XMLHttpRequest
// is faked, so these tests catch any mismatch between the wrapper and hls.js' loader contract.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Hls from 'hls.js';
import { makeProxyLoader } from '../src/player/player.js';

const PROXY = 'https://relay.example.deno.dev';
const relayed = (url) => `${PROXY}/?url=${encodeURIComponent(url)}`;
const STREAM = 'http://1.2.3.4:8080/live/index.m3u8';

/** A scriptable XMLHttpRequest: requests are recorded; tests answer them with respond(). */
class FakeXhr {
  static all = [];
  readyState = 0;
  status = 0;
  statusText = '';
  responseType = '';
  response = null;
  responseText = '';
  responseURL = '';
  responseHeaders = {};
  aborted = false;
  open(method, url) {
    this.method = method;
    this.url = url;
    this.readyState = 1;
  }
  setRequestHeader() {}
  send() {
    FakeXhr.all.push(this);
  }
  abort() {
    this.aborted = true;
  }
  getAllResponseHeaders() {
    return Object.entries(this.responseHeaders).map(([k, v]) => `${k}: ${v}\r\n`).join('');
  }
  getResponseHeader(name) {
    return this.responseHeaders[name.toLowerCase()] ?? null;
  }
  /** Finish the request. Through the relay, the browser reports the relay URL as responseURL. */
  respond(status, body = '', { headers = {} } = {}) {
    this.status = status;
    this.statusText = status >= 200 && status < 300 ? 'OK' : 'Error';
    this.responseURL = this.url;
    this.responseHeaders = headers;
    this.responseText = typeof body === 'string' ? body : '';
    this.response = body;
    this.readyState = 4;
    this.onreadystatechange?.();
  }
}

const lastXhr = () => FakeXhr.all[FakeXhr.all.length - 1];

const policy = (overrides = {}) => ({
  loadPolicy: {
    maxTimeToFirstByteMs: 10000,
    maxLoadTimeMs: 20000,
    timeoutRetry: null,
    errorRetry: null,
    ...overrides,
  },
  timeout: 20000,
  maxRetry: 0,
  retryDelay: 0,
  maxRetryDelay: 0,
});

const manifestContext = (url = STREAM) => ({ url, type: 'manifest', responseType: 'text', level: 0 });

function callbacks() {
  return { onSuccess: vi.fn(), onError: vi.fn(), onTimeout: vi.fn(), onAbort: vi.fn() };
}

function createLoader() {
  const RelayLoader = makeProxyLoader(Hls, PROXY);
  return new RelayLoader({ ...Hls.DefaultConfig });
}

beforeEach(() => {
  FakeXhr.all = [];
  vi.stubGlobal('XMLHttpRequest', FakeXhr);
  // hls.js' retry log message reads a bare `status`, which browsers resolve to the legacy `window.status`.
  vi.stubGlobal('status', '');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('makeProxyLoader with hls.js’ default loader', () => {
  it('requests through the relay and reports back with hls.js’ own context and the stream URL', () => {
    const loader = createLoader();
    const context = manifestContext();
    const cb = callbacks();
    loader.load(context, policy(), cb);
    expect(FakeXhr.all).toHaveLength(1);
    expect(lastXhr()).toMatchObject({ method: 'GET', url: relayed(STREAM), responseType: 'text' });
    expect(loader.context).toBe(context);
    expect(loader.stats.loading.start).toBeGreaterThan(0);

    lastXhr().respond(200, '#EXTM3U\n');
    expect(cb.onSuccess).toHaveBeenCalledTimes(1);
    const [response, stats, ctx, networkDetails] = cb.onSuccess.mock.calls[0];
    expect(response).toEqual({ url: STREAM, data: '#EXTM3U\n', code: 200 });
    expect(stats).toBe(loader.stats);
    expect(stats.loaded).toBe(8);
    expect(ctx).toBe(context);
    expect(networkDetails).toBe(lastXhr());
  });

  it('retries through the relay', async () => {
    vi.useFakeTimers();
    const loader = createLoader();
    const context = manifestContext();
    const cb = callbacks();
    const errorRetry = { maxNumRetry: 1, retryDelayMs: 100, maxRetryDelayMs: 100 };
    loader.load(context, policy({ errorRetry }), cb);
    lastXhr().respond(503);
    expect(cb.onError).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(FakeXhr.all).toHaveLength(2);
    expect(lastXhr().url).toBe(relayed(STREAM));
    lastXhr().respond(200, '#EXTM3U\n');
    expect(cb.onSuccess.mock.calls[0][2]).toBe(context);
    expect(loader.stats.retry).toBe(1);
  });

  it('reports errors, timeouts and aborts with hls.js’ own context', async () => {
    let loader = createLoader();
    let context = manifestContext();
    let cb = callbacks();
    loader.load(context, policy(), cb);
    lastXhr().respond(404);
    expect(cb.onError).toHaveBeenCalledWith({ code: 404, text: 'Error' }, context, lastXhr(), loader.stats);

    vi.useFakeTimers();
    loader = createLoader();
    context = manifestContext();
    cb = callbacks();
    loader.load(context, policy({ maxTimeToFirstByteMs: 1000 }), cb);
    await vi.advanceTimersByTimeAsync(1000);
    expect(cb.onTimeout).toHaveBeenCalledWith(loader.stats, context, lastXhr());
    expect(lastXhr().aborted).toBe(true);

    loader = createLoader();
    context = manifestContext();
    cb = callbacks();
    loader.load(context, policy(), cb);
    loader.abort();
    expect(lastXhr().aborted).toBe(true);
    expect(loader.stats.aborted).toBe(true);
    expect(cb.onAbort).toHaveBeenCalledWith(loader.stats, context, lastXhr());
    loader.destroy();
    expect(loader.context).toBeNull();
    expect(loader.stats).toBeNull(); // as the default loader after destroy()
  });

  it('is single-use like the default loader', () => {
    const loader = createLoader();
    const context = manifestContext();
    loader.load(context, policy(), callbacks());
    expect(() => loader.load(manifestContext('https://other.example/x.m3u8'), policy(), callbacks()))
      .toThrow(/only be used once/);
    expect(loader.context).toBe(context);
    expect(FakeXhr.all).toHaveLength(1);
  });

  it('exposes the response headers hls.js reads (Age, Retry-After)', () => {
    const loader = createLoader();
    loader.load(manifestContext(), policy(), callbacks());
    lastXhr().respond(200, '#EXTM3U\n', { headers: { age: '12', 'retry-after': '5' } });
    expect(loader.getCacheAge()).toBe(12);
    expect(loader.getResponseHeader('Retry-After')).toBe('5');
  });

  it('fails clearly when hls.js has no default loader', () => {
    expect(() => makeProxyLoader({ DefaultConfig: {} }, PROXY)).toThrow(TypeError);
    expect(() => makeProxyLoader(null, PROXY)).toThrow(TypeError);
  });
});

describe('makeProxyLoader in a real hls.js instance', () => {
  let hls = null;

  afterEach(() => {
    hls?.destroy();
    hls = null;
  });

  /** Load `STREAM` through the relay, answer the manifest request with `body`, resolve MANIFEST_PARSED. */
  async function loadManifest(body) {
    hls = new Hls({ loader: makeProxyLoader(Hls, PROXY), enableWorker: false });
    const parsed = new Promise((resolve) => {
      hls.on(Hls.Events.MANIFEST_PARSED, (_event, data) => resolve(data));
    });
    hls.loadSource(STREAM);
    await vi.waitFor(() => expect(FakeXhr.all).toHaveLength(1));
    expect(lastXhr().url).toBe(relayed(STREAM));
    lastXhr().respond(200, body);
    return parsed;
  }

  it('resolves relative playlist URIs against the stream URL, then relays those requests', async () => {
    const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1280000,RESOLUTION=1280x720\nlow/index.m3u8\n';
    const data = await loadManifest(master);
    expect(data.levels.map((level) => level.url)).toEqual([['http://1.2.3.4:8080/live/low/index.m3u8']]);
    hls.startLoad();
    await vi.waitFor(() => expect(FakeXhr.all).toHaveLength(2));
    expect(lastXhr().url).toBe(relayed('http://1.2.3.4:8080/live/low/index.m3u8'));
  });

  it('does not wrap URIs the relay already rewrote', async () => {
    const variant = relayed('http://cdn.example/live/low/index.m3u8');
    const master = `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1280000,RESOLUTION=1280x720\n${variant}\n`;
    const data = await loadManifest(master);
    expect(data.levels[0].url).toEqual([variant]);
    hls.startLoad();
    await vi.waitFor(() => expect(FakeXhr.all).toHaveLength(2));
    expect(lastXhr().url).toBe(variant);
  });
});
