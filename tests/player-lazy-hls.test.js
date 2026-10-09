// hls.js is a lazily imported chunk: these tests cover when it is fetched and what happens while it loads or
// when it can't be loaded. Each test gets fresh module state (vi.resetModules) so the import cache is empty.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const ctl = vi.hoisted(() => ({ imports: 0, fail: false, gate: null, instances: [] }));

// Registered per test (vi.doMock + vi.resetModules) so every test starts with hls.js not yet imported.
const hlsFactory = async () => {
  ctl.imports += 1;
  if (ctl.gate) await ctl.gate;
  if (ctl.fail) throw new Error('Failed to fetch dynamically imported module');
  class FakeHls {
    static isSupported() {
      return true;
    }
    static Events = { ERROR: 'hlsError', MANIFEST_PARSED: 'hlsManifestParsed' };
    static ErrorTypes = { NETWORK_ERROR: 'networkError', MEDIA_ERROR: 'mediaError' };
    static ErrorDetails = {};
    constructor(config) {
      this.config = config;
      this.destroyed = false;
      ctl.instances.push(this);
    }
    on() {}
    attachMedia(media) {
      this.media = media;
    }
    loadSource(url) {
      this.url = url;
    }
    destroy() {
      this.destroyed = true;
    }
  }
  return { default: FakeHls };
};

const flush = async (n = 40) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

function createVideo({ nativeHls = '' } = {}) {
  const video = document.createElement('video');
  video.canPlayType = vi.fn((type) => (/mpegurl/i.test(type) ? nativeHls : ''));
  video.play = vi.fn(() => Promise.resolve());
  video.pause = vi.fn();
  video.load = vi.fn();
  return video;
}

let player;
async function setup(videoOptions) {
  const mod = await import('../src/player/player.js');
  player = new mod.Player(createVideo(videoOptions), { pageProtocol: 'https:', sniff: false });
  return mod;
}

beforeEach(() => {
  vi.resetModules();
  vi.doMock('hls.js', hlsFactory);
  Object.assign(ctl, { imports: 0, fail: false, gate: null, instances: [] });
});

afterEach(() => {
  player?.destroy();
  player = null;
  vi.useRealTimers();
});

describe('Player — lazy hls.js', () => {
  it('does not fetch hls.js for native or MPEG-TS streams', async () => {
    await setup();
    await player.load({ url: 'https://cdn.example.com/clip.webm' });
    expect(player.engine).toBe('native');
    await player.load({ url: 'https://cdn.example.com/live/42.ts' });
    expect(ctl.imports).toBe(0);

    await player.load({ url: 'https://cdn.example.com/live/index.m3u8' });
    expect(ctl.imports).toBe(1);
    expect(ctl.instances).toHaveLength(1);
    expect(player.engine).toBe('hls.js');
    expect(ctl.instances[0].config.workerPath).toMatch(/hls\.worker/);
  });

  it('only starts the last channel when switching while hls.js is still loading', async () => {
    let open;
    ctl.gate = new Promise((resolve) => {
      open = resolve;
    });
    await setup();
    const loads = [1, 2, 3].map((n) => player.load({ url: `https://cdn.example.com/ch${n}.m3u8` }));
    await flush();
    expect(player.state).toBe('loading');
    expect(ctl.instances).toHaveLength(0);
    open();
    await Promise.all(loads);
    expect(ctl.imports).toBe(1);
    expect(ctl.instances).toHaveLength(1);
    expect(ctl.instances[0].url).toBe('https://cdn.example.com/ch3.m3u8');
  });

  it('falls back to native HLS when hls.js fails to load', async () => {
    ctl.fail = true;
    await setup({ nativeHls: 'maybe' });
    await player.load({ url: 'https://cdn.example.com/live/index.m3u8' });
    expect(player.engine).toBe('native');
    expect(player.state).toBe('loading');
  });

  it('retries a failed hls.js load with backoff and plays once it loads', async () => {
    vi.useFakeTimers();
    ctl.fail = true;
    await setup();
    const reconnecting = [];
    player.addEventListener('reconnecting', (e) => reconnecting.push(e.detail));
    await player.load({ url: 'https://cdn.example.com/live/index.m3u8' });
    await flush();
    expect(player.state).toBe('reconnecting');
    expect(reconnecting[0]).toMatchObject({ attempt: 1, code: 'UNKNOWN' });
    expect(reconnecting[0].reason).toBe('Couldn’t load the HLS player.');

    ctl.fail = false;
    await vi.advanceTimersByTimeAsync(reconnecting[0].delayMs);
    await flush();
    expect(ctl.instances).toHaveLength(1);
    expect(player.engine).toBe('hls.js');
    expect(player.state).toBe('loading');
  });

  it('gives a clear error (not "browser can’t play HLS") when hls.js never loads', async () => {
    vi.useFakeTimers();
    ctl.fail = true;
    await setup();
    player.setOptions({ autoReconnect: false });
    await player.load({ url: 'https://cdn.example.com/live/index.m3u8' });
    await flush();
    expect(player.state).toBe('error');
    expect(player.error).toMatchObject({ code: 'UNKNOWN', message: 'Couldn’t load the HLS player.' });
  });

  it('times out an hls.js import that never settles', async () => {
    vi.useFakeTimers();
    ctl.gate = new Promise(() => {});
    await setup();
    player.setOptions({ autoReconnect: false, loadTimeoutMs: 5000 });
    const done = player.load({ url: 'https://cdn.example.com/live/index.m3u8' });
    await flush();
    expect(player.state).toBe('loading');
    await vi.advanceTimersByTimeAsync(5000);
    await done;
    expect(player.state).toBe('error');
    expect(player.error.technical).toMatch(/hls\.js load timed out/);
    expect(vi.getTimerCount()).toBe(0);
  });
});
