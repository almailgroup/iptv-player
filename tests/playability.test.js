// staticPlayability tests: the up-front "can this channel play here?" checks (src/lib/playability.js).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { staticPlayability } from '../src/lib/playability.js';
import { detectStreamType } from '../src/player/stream-type.js';

const HTTPS_PAGE = { pageProtocol: 'https:', streamRelay: '' };
const RELAY = 'https://relay.example.test';
const check = (url, options = HTTPS_PAGE, extra = {}) => staticPlayability({ url, ...extra }, options);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('staticPlayability', () => {
  it.each([
    ['rtmp://live.example.com/app/stream', 'rtmp'],
    ['RTSP://camera.example:554/stream1', 'rtsp'],
    ['udp://@239.0.0.1:1234', 'udp'],
    ['rtp://239.0.0.1:5004', 'rtp'],
    ['mms://media.example.com/stream', 'mms'],
    ['srt://example.com:9000?streamid=abc', 'srt'],
    ['acestream://0123456789abcdef', 'acestream'],
    ['  rtmps://live.example.com/app/stream  ', 'rtmps'],
  ])('flags %s as an unsupported protocol', (url, scheme) => {
    expect(check(url)).toEqual({
      kind: 'unsupported',
      label: 'Not supported',
      title: `${scheme}:// streams can’t be played in a browser.`,
    });
  });

  it.each([
    'https://cdn.example.com/dash/manifest.mpd',
    'https://cdn.example.com/dash/MANIFEST.MPD?token=1',
    'http://cdn.example.com/video.ism/manifest(format=mpd-time-csf)',
    'https://cdn.example.com/live/get?id=1&format=dash',
    'https://cdn.example.com/live/manifest%2Empd', // percent-encoded extension
    'https://cdn.example.com/live/manifest.m\tpd', // the URL parser drops tabs
    '//cdn.example.com/live/manifest.mpd',
  ])('flags MPEG-DASH (%s)', (url) => {
    expect(check(url)).toEqual({
      kind: 'unsupported',
      label: 'Not supported',
      title: 'MPEG-DASH streams aren’t supported.',
    });
  });

  it('flags DRM-protected channels', () => {
    expect(check('https://cdn.example.com/live.m3u8', HTTPS_PAGE, { drm: true })).toEqual({
      kind: 'drm',
      label: 'DRM',
      title: 'DRM-protected — can’t play in the browser.',
    });
  });

  it('flags insecure http:// streams on an https page unless a stream relay is in effect', () => {
    const insecure = {
      kind: 'insecure',
      label: 'HTTP',
      title: 'Insecure http:// stream — browsers block it on this secure site.',
    };
    expect(check('http://1.2.3.4:8080/live/index.m3u8')).toEqual(insecure);
    expect(check('HTTP://tv.example/live/index.m3u8')).toEqual(insecure);
    expect(check(' http://tv.example/live/1234')).toEqual(insecure);
    expect(check('http://1.2.3.4:8080/live/index.m3u8', { pageProtocol: 'https:', streamRelay: RELAY })).toBeNull();
    expect(check('http://1.2.3.4:8080/live/index.m3u8', { pageProtocol: 'http:', streamRelay: '' })).toBeNull();
    // Loopback is never mixed content.
    expect(check('http://localhost:8080/live.m3u8')).toBeNull();
    expect(check('http://127.0.0.1:8080/live.m3u8')).toBeNull();
  });

  it('flags local-network http:// streams on an https page, relay or not (a relay can’t reach them)', () => {
    const local = {
      kind: 'insecure',
      label: 'Local',
      title: 'Local-network http:// stream — can’t play on this secure site.',
    };
    const withRelay = { pageProtocol: 'https:', streamRelay: RELAY };
    for (const url of [
      'http://192.168.1.20:9981/stream/channel/1',
      'http://10.0.0.2/live/index.m3u8',
      'http://172.20.1.1:8080/u/p/1001',
      'http://[fd00::12]:8096/videos/1/stream.ts',
      'http://nas.local:8096/live.m3u8',
      'HTTP://tvheadend:9981/stream/channel/2',
      ' http://router.home.arpa/x.ts',
    ]) {
      expect(check(url, withRelay), url).toEqual(local);
      expect(check(url), url).toEqual(local);
    }
    expect(check('http://192.168.1.20:9981/x', withRelay)).toBe(check('http://box.lan/y', HTTPS_PAGE));
    expect(Object.isFrozen(check('http://box.lan/y'))).toBe(true);
    // Not mixed content: nothing to flag.
    expect(check('http://192.168.1.20:9981/x', { pageProtocol: 'http:', streamRelay: RELAY })).toBeNull();
    expect(check('https://192.168.1.20/live.m3u8', withRelay)).toBeNull();
    expect(check('http://127.0.0.1:8080/live.m3u8', withRelay)).toBeNull(); // loopback is allowed
    // Public hosts still play through the relay.
    expect(check('http://1.2.3.4:8080/live/index.m3u8', withRelay)).toBeNull();
    expect(check('http://tv.example/live/index.m3u8', withRelay)).toBeNull();
  });

  it('defaults the page protocol to the current page’s', () => {
    expect(staticPlayability({ url: 'http://tv.example/live.m3u8' })).toBeNull(); // the test page is http:
    vi.stubGlobal('location', { protocol: 'https:' });
    expect(staticPlayability({ url: 'http://tv.example/live.m3u8' })).toMatchObject({ kind: 'insecure' });
  });

  it('returns null for channels that can be tried', () => {
    for (const url of [
      'https://cdn.example.com/live/index.m3u8',
      'https://dash.example.com/live/index.m3u8', // "dash" in the host name only
      'https://cdn.example.com/watch?v=dashboard',
      'https://host.tv:8080/user/pass/1234',
      'https://cdn.example.com/movie.mp4',
    ]) {
      expect(check(url), url).toBeNull();
    }
    expect(staticPlayability({ url: 'http://tv.example/x.m3u8' }, { pageProtocol: 'https:', streamRelay: RELAY }))
      .toBeNull();
  });

  it('applies the checks in order: protocol, DASH, DRM, then mixed content', () => {
    expect(check('rtmp://live.example.com/app', HTTPS_PAGE, { drm: true }).kind).toBe('unsupported');
    expect(check('https://cdn.example.com/a.mpd', HTTPS_PAGE, { drm: true }).title).toMatch(/DASH/);
    expect(check('http://tv.example/live.m3u8', HTTPS_PAGE, { drm: true }).kind).toBe('drm');
  });

  it('tolerates channels without a usable URL', () => {
    expect(staticPlayability(null)).toBeNull();
    expect(staticPlayability({}, HTTPS_PAGE)).toBeNull();
    expect(staticPlayability({ url: 42 }, HTTPS_PAGE)).toBeNull();
    expect(staticPlayability({ url: '', drm: true }, HTTPS_PAGE)).toMatchObject({ kind: 'drm' });
  });

  it('returns frozen, shared result objects', () => {
    const a = check('rtmp://a.example/app');
    expect(Object.isFrozen(a)).toBe(true);
    expect(check('rtmp://b.example/other')).toBe(a);
    expect(check('rtsp://b.example/other')).not.toBe(a);
    expect(check('https://a.example/x.mpd')).toBe(check('https://b.example/y.mpd'));
    expect(check('http://a.example/x.m3u8')).toBe(check('http://b.example/y.ts'));
  });

  it('agrees with detectStreamType on every DASH / unsupported verdict (fast path included)', () => {
    const corpus = [
      'https://example.com/live/stream.m3u8',
      'http://host.tv:8080/live/user/pass/1234.ts',
      'http://host.tv/live/stream.flv',
      'https://cdn.example.com/movie.mp4',
      'https://cdn.example.com/dash/manifest.mpd',
      'https://cdn.example.com/dash/manifest.mpd/',
      'https://cdn.example.com/video.ism/manifest(format=mpd-time-csf)',
      'https://cdn.example.com/video.ism/manifest(format=m3u8-aapl)',
      'https://cdn.example.com/get?type=mpd',
      'https://cdn.example.com/get?output=.MPD',
      'https://cdn.example.com/get?format=DASH',
      'https://cdn.example.com/get?format=dash&x=1',
      'https://cdn.example.com/get?ext=%6Dpd',
      'https://cdn.example.com/%6D%70%64/live.m3u8',
      'https://cdn.example.com/a.%4DPD',
      'https://cdn.example.com/a.mp\nd',
      'https://cdn.example.com/a.mp\rd',
      'https://cdn.example.com/a.m\tpd',
      'https://dash.example.com/live.m3u8',
      'https://cdn.example.com/mpd/live.ts',
      'http://host.tv/play.php?id=5&type=m3u8',
      'https://cdn.example.com/stream?format=mpd',
      'HTTPS://CDN.EXAMPLE.COM/A.MPD',
      'http://',
      'https://[::1',
    ];
    const withRelay = { pageProtocol: 'https:', streamRelay: RELAY };
    for (const url of corpus) {
      const type = detectStreamType(url);
      const expected = type === 'dash' || type === 'unsupported' ? 'unsupported' : null;
      expect(staticPlayability({ url }, withRelay)?.kind ?? null, url).toBe(expected);
    }
  });
});
