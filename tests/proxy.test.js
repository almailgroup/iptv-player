// @vitest-environment node
// The relay is server code: test it against Node's own fetch/Request/Response (what Deno, Bun and Cloudflare
// Workers also provide) instead of the DOM shims of the default happy-dom environment.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import relayWorker, {
  ALLOWED_ORIGINS,
  VERSION,
  handleRequest,
  isHlsPlaylist,
  isPrivateHost,
  rewritePlaylist,
} from '../proxy/stream-proxy.js';
import { createRelayServer, parseOptions, resolveHost } from '../proxy/node-server.mjs';

const RELAY_SOURCE_PATH = fileURLToPath(new URL('../proxy/stream-proxy.js', import.meta.url));
const NODE_SERVER_PATH = fileURLToPath(new URL('../proxy/node-server.mjs', import.meta.url));
const DENO_ENTRY_PATH = fileURLToPath(new URL('../proxy/deno.js', import.meta.url));
const DENO_CONFIG_PATH = fileURLToPath(new URL('../deno.json', import.meta.url));

const RELAY = 'https://relay.example';
const APP_ORIGIN = 'https://almailgroup.github.io';
const EXPOSED = 'Content-Length, Content-Range, Accept-Ranges, Content-Type, X-Relay-Final-Url';

const encoder = new TextEncoder();
const bytes = (text) => encoder.encode(text);
/** Relay URL in the canonical query form. */
const viaQuery = (target, relay = RELAY) => `${relay}/?url=${encodeURIComponent(target)}`;

/** A request to the relay; sends `Origin: <app>` unless `origin` is null. */
function relayRequest(pathOrUrl, { method = 'GET', origin = APP_ORIGIN, headers = {}, base = RELAY } = {}) {
  const all = new Headers(headers);
  if (origin !== null) all.set('Origin', origin);
  const url = /^https?:\/\//.test(pathOrUrl) ? pathOrUrl : base + pathOrUrl;
  return new Request(url, { method, headers: all });
}

/** A vi.fn() fetch mock; `respond(url, init)` returns the upstream Response (default: a small TS body). */
function mockFetch(respond = () => new Response('media', { headers: { 'Content-Type': 'video/mp2t' } })) {
  return vi.fn(async (url, init) => respond(url, init));
}

/** Give a constructed Response the `url` fetch() would report after redirects. */
function withUrl(response, url) {
  Object.defineProperty(response, 'url', { value: url });
  return response;
}

/** A body that yields `chunks` one by one, with the source kept open until `finish()` is called. */
function controlledStream(chunks) {
  let controller;
  const stream = new ReadableStream({
    start(c) {
      controller = c;
      for (const chunk of chunks) c.enqueue(bytes(chunk));
    },
  });
  return {
    stream,
    finish(last = '') {
      if (last) controller.enqueue(bytes(last));
      controller.close();
    },
  };
}

/** The body as text with a leading BOM kept (`Response#text()` strips it). */
async function rawText(response) {
  return new TextDecoder('utf-8', { ignoreBOM: true }).decode(await response.arrayBuffer());
}

async function readAll(reader) {
  let text = '';
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    text += decoder.decode(value, { stream: true });
  }
}

// ---------------------------------------------------------------------------------------------------------

describe('module shape (the app machine-edits this file)', () => {
  const source = readFileSync(RELAY_SOURCE_PATH, 'utf8');
  const MARKER = '// ---- entry point (the in-app setup guide swaps this block for the chosen platform) ----';

  it('has exactly one single-line ALLOWED_ORIGINS declaration the guide can replace', () => {
    const matches = source.match(/^export const ALLOWED_ORIGINS = .*;$/gm);
    expect(matches).toEqual([
      "export const ALLOWED_ORIGINS = ['https://almailgroup.github.io', 'http://localhost:5173', " +
        "'http://localhost:4173', 'http://127.0.0.1:5173', 'http://127.0.0.1:4173'];",
    ]);
    expect(ALLOWED_ORIGINS).toContain(APP_ORIGIN);
    expect(VERSION).toBe(1);
  });

  it('ends with the marked entry-point block and uses no imports or Node-only globals', () => {
    expect(
      source.endsWith(`${MARKER}\nexport default { fetch: (request) => handleRequest(request) };\n`),
    ).toBe(true);
    expect(source.split(MARKER)).toHaveLength(2);
    expect(source).not.toMatch(/^\s*import\b|\brequire\(|\bprocess\.|\bBuffer\b|\bDeno\./m);
  });

  it('default export (Workers / Bun / deno serve) delegates to handleRequest', async () => {
    const response = await relayWorker.fetch(relayRequest('/?health'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, service: 'iptv-stream-relay', version: 1 });
  });

  it('proxy/deno.js (Deno Deploy) serves the relay through Deno.serve', async () => {
    const serve = vi.fn();
    // A and AAAA records by name; anything else fails like Deno.resolveDns does (NotFound).
    const records = {
      'cdn.example': { A: ['93.184.216.34'], AAAA: ['2606:2800:220:1:248:1893:25c8:1946'] },
      '127.0.0.1.nip.io': { A: ['127.0.0.1'] },
      'v6.example': { A: ['93.184.216.34'], AAAA: ['::1'] },
    };
    const resolveDns = vi.fn(async (host, type) => {
      if (!records[host]?.[type]) throw new Error(`NotFound: ${host} ${type}`);
      return records[host][type];
    });
    const fetchImpl = mockFetch();
    vi.stubGlobal('Deno', { serve, resolveDns });
    vi.stubGlobal('fetch', fetchImpl);
    try {
      await import('../proxy/deno.js');
      expect(serve).toHaveBeenCalledTimes(1);
      const handler = serve.mock.calls[0][0];
      const response = await handler(relayRequest('/?health', { base: 'https://iptv-relay.example.deno.net' }));
      expect(response.status).toBe(200);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe(APP_ORIGIN);
      expect(await response.json()).toEqual({ ok: true, service: 'iptv-stream-relay', version: 1 });
      // The default allowlist and the private-target refusal hold there too.
      const stranger = relayRequest(viaQuery('https://a.example/b.ts'), { origin: 'https://evil.example' });
      expect((await handler(stranger)).status).toBe(403);
      const loopback = relayRequest(viaQuery('http://127.0.0.1/a.ts', 'http://localhost:8000'));
      expect((await handler(loopback)).status).toBe(403);
      expect(resolveDns).not.toHaveBeenCalled();

      // Host names are looked up (A and AAAA): any private address refuses the target before it is fetched.
      for (const host of ['127.0.0.1.nip.io', 'v6.example']) {
        const refused = await handler(relayRequest(viaQuery(`http://${host}/a.ts`)));
        expect(refused.status, host).toBe(403);
        expect(await refused.text()).toBe('Target not allowed');
      }
      const unknown = await handler(relayRequest(viaQuery('http://nxdomain.example/a.ts')));
      expect(unknown.status).toBe(502);
      expect(await unknown.text()).toBe('Upstream unreachable');
      expect(fetchImpl).not.toHaveBeenCalled();
      const ok = await handler(relayRequest(viaQuery('https://cdn.example/a.ts')));
      expect(ok.status).toBe(200);
      expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual(['https://cdn.example/a.ts']);
      expect(resolveDns.mock.calls).toEqual(
        expect.arrayContaining([
          ['cdn.example', 'A'],
          ['cdn.example', 'AAAA'],
        ]),
      );
    } finally {
      vi.unstubAllGlobals();
    }
    const entry = readFileSync(DENO_ENTRY_PATH, 'utf8');
    expect(entry).toMatch(/^\/\/ Deno Deploy \/ `deno run --allow-net proxy\/deno\.js` entry point/);
    expect(entry).toContain("import { handleRequest } from './stream-proxy.js';\n");
    expect(entry.trimEnd().endsWith('Deno.serve((request) => handleRequest(request, { resolveHost }));')).toBe(
      true,
    );
  });

  it('deno.json makes Deno Deploy run proxy/deno.js with no install or build step', () => {
    const config = JSON.parse(readFileSync(DENO_CONFIG_PATH, 'utf8'));
    expect(config.deploy).toEqual({ runtime: { type: 'dynamic', entrypoint: './proxy/deno.js' } });
    expect(resolve(dirname(DENO_CONFIG_PATH), config.deploy.runtime.entrypoint)).toBe(DENO_ENTRY_PATH);
    expect(existsSync(DENO_ENTRY_PATH)).toBe(true);
    // Nothing that would affect the Vite app (tasks, imports, compiler options …).
    expect(Object.keys(config).sort()).toEqual(['deploy', 'lock']);
  });

  it('still works after the guide rewrites it for Deno Deploy', () => {
    const deno = source
      .replace(
        /^export const ALLOWED_ORIGINS = .*;$/m,
        "export const ALLOWED_ORIGINS = ['https://me.example'];",
      )
      .replace(/\/\/ ---- entry point[\s\S]*$/, 'Deno.serve((request) => handleRequest(request));\n');
    const stub = `globalThis.Deno = { serve: async (handler) => {
      const request = new Request('https://x.deno.dev/?health', { headers: { Origin: 'https://me.example' } });
      const res = await handler(request);
      console.log(res.status, res.headers.get('access-control-allow-origin'), await res.text());
    } };\n`;
    const run = spawnSync(process.execPath, ['--input-type=module'], {
      input: stub + deno,
      encoding: 'utf8',
    });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout.trim()).toBe(
      '200 https://me.example {"ok":true,"service":"iptv-stream-relay","version":1}',
    );
  });
});

// ---------------------------------------------------------------------------------------------------------

describe('isHlsPlaylist', () => {
  it('recognizes master and media playlists', () => {
    expect(isHlsPlaylist('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nlow.m3u8\n')).toBe(true);
    expect(isHlsPlaylist('#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\na.ts\n')).toBe(true);
    expect(isHlsPlaylist('#EXTM3U\r\n#EXT-X-MEDIA-SEQUENCE:7\r\n')).toBe(true);
    expect(isHlsPlaylist('#EXTM3U\n#EXT-X-PLAYLIST-TYPE:VOD\n')).toBe(true);
    expect(isHlsPlaylist('﻿#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n')).toBe(true);
  });

  it('rejects IPTV channel lists and non-playlists', () => {
    const channels =
      '#EXTM3U x-tvg-url="https://epg.example/guide.xml"\n' +
      '#EXTINF:-1 tvg-id="fox.us" tvg-logo="https://l.example/fox.png" group-title="News",Fox News (720p)\n' +
      'http://1.2.3.4:8080/live/index.m3u8\n' +
      '#EXTINF:-1 tvg-name="Odd" group-title="Misc",Has #EXT-X-STREAM-INF in its title\n' +
      'https://cdn.example/odd.m3u8\n';
    expect(isHlsPlaylist(channels)).toBe(false);
    expect(isHlsPlaylist('')).toBe(false);
    expect(isHlsPlaylist('<html><body>#EXT-X-TARGETDURATION</body></html>')).toBe(false);
    expect(isHlsPlaylist(null)).toBe(false);
    expect(isHlsPlaylist(bytes('#EXT-X-TARGETDURATION:6'))).toBe(false);
  });
});

describe('rewritePlaylist', () => {
  const wrap = (url) => `R(${url})`;

  it('rewrites a master playlist: variants, renditions, I-frame and session URIs', () => {
    const master = [
      '#EXTM3U',
      '#EXT-X-VERSION:6',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",DEFAULT=YES,URI="audio/en.m3u8"',
      '#EXT-X-MEDIA:TYPE=CLOSED-CAPTIONS,GROUP-ID="cc",NAME="CC1",INSTREAM-ID="CC1"',
      '#EXT-X-STREAM-INF:BANDWIDTH=1280000,RESOLUTION=1280x720,AUDIO="aud"',
      '720p/index.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=2560000,RESOLUTION=1920x1080,AUDIO="aud"',
      '/hd/1080p.m3u8?token=a%2Bb',
      '#EXT-X-STREAM-INF:BANDWIDTH=640000',
      'https://cdn2.example/360p.m3u8',
      '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=86000,URI="iframes.m3u8"',
      '#EXT-X-SESSION-DATA:DATA-ID="com.example.title",URI="https://meta.example/title.json"',
      '#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES,URI="skd://key-id",KEYFORMAT="com.apple.streamingkeydelivery"',
      '',
    ].join('\n');
    expect(rewritePlaylist(master, 'http://1.2.3.4:8080/live/master.m3u8', wrap)).toBe(
      [
        '#EXTM3U',
        '#EXT-X-VERSION:6',
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",DEFAULT=YES,' +
          'URI="R(http://1.2.3.4:8080/live/audio/en.m3u8)"',
        '#EXT-X-MEDIA:TYPE=CLOSED-CAPTIONS,GROUP-ID="cc",NAME="CC1",INSTREAM-ID="CC1"',
        '#EXT-X-STREAM-INF:BANDWIDTH=1280000,RESOLUTION=1280x720,AUDIO="aud"',
        'R(http://1.2.3.4:8080/live/720p/index.m3u8)',
        '#EXT-X-STREAM-INF:BANDWIDTH=2560000,RESOLUTION=1920x1080,AUDIO="aud"',
        'R(http://1.2.3.4:8080/hd/1080p.m3u8?token=a%2Bb)',
        '#EXT-X-STREAM-INF:BANDWIDTH=640000',
        'R(https://cdn2.example/360p.m3u8)',
        '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=86000,URI="R(http://1.2.3.4:8080/live/iframes.m3u8)"',
        '#EXT-X-SESSION-DATA:DATA-ID="com.example.title",URI="R(https://meta.example/title.json)"',
        '#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES,URI="skd://key-id",KEYFORMAT="com.apple.streamingkeydelivery"',
        '',
      ].join('\n'),
    );
  });

  it('rewrites a media playlist: segments, KEY, MAP, PART, PRELOAD-HINT and RENDITION-REPORT URIs', () => {
    const media = [
      '#EXTM3U',
      '#EXT-X-TARGETDURATION:4',
      '#EXT-X-MEDIA-SEQUENCE:100',
      '#EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES,PART-HOLD-BACK=1.0',
      '#EXT-X-MAP:URI="init.mp4",BYTERANGE="720@0"',
      '#EXT-X-KEY:METHOD=AES-128,URI="https://keys.example/k?id=1",IV=0x00000000000000000000000000000001',
      '#EXTINF:4.0,',
      'seg100.m4s',
      '#EXT-X-PART:DURATION=0.33334,URI="seg101.0.m4s",INDEPENDENT=YES',
      '#EXT-X-PRELOAD-HINT:TYPE=PART,URI="seg101.1.m4s"',
      '#EXT-X-RENDITION-REPORT:URI="../720p/index.m3u8",LAST-MSN=101,LAST-PART=0',
    ].join('\n');
    expect(rewritePlaylist(media, 'https://cdn.example/live/1080p/index.m3u8', wrap)).toBe(
      [
        '#EXTM3U',
        '#EXT-X-TARGETDURATION:4',
        '#EXT-X-MEDIA-SEQUENCE:100',
        '#EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES,PART-HOLD-BACK=1.0',
        '#EXT-X-MAP:URI="R(https://cdn.example/live/1080p/init.mp4)",BYTERANGE="720@0"',
        '#EXT-X-KEY:METHOD=AES-128,URI="R(https://keys.example/k?id=1)",IV=0x00000000000000000000000000000001',
        '#EXTINF:4.0,',
        'R(https://cdn.example/live/1080p/seg100.m4s)',
        '#EXT-X-PART:DURATION=0.33334,URI="R(https://cdn.example/live/1080p/seg101.0.m4s)",INDEPENDENT=YES',
        '#EXT-X-PRELOAD-HINT:TYPE=PART,URI="R(https://cdn.example/live/1080p/seg101.1.m4s)"',
        '#EXT-X-RENDITION-REPORT:URI="R(https://cdn.example/live/720p/index.m3u8)",LAST-MSN=101,LAST-PART=0',
      ].join('\n'),
    );
  });

  it('leaves data:, skd: and other non-http(s) URIs untouched', () => {
    const text = [
      '#EXT-X-TARGETDURATION:6',
      '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="data:text/plain;base64,AAAA",KEYFORMAT="identity"',
      '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://twelve",KEYFORMAT="com.apple.streamingkeydelivery"',
      '#EXT-X-KEY:METHOD=NONE,URI=""',
      'rtmp://live.example/app/stream',
      'data:video/mp2t;base64,R0dHRw==',
    ].join('\n');
    expect(rewritePlaylist(text, 'https://cdn.example/a/index.m3u8', wrap)).toBe(text);
  });

  it('preserves CRLF / CR / LF line endings, a BOM, blank lines, comments and surrounding whitespace', () => {
    const text =
      '﻿#EXTM3U\r\n#EXT-X-TARGETDURATION:6\r\n\r\n# comment URI="c.ts"\r#EXTINF:6,\n  a.ts \t\r\nb.ts';
    expect(rewritePlaylist(text, 'http://h.example/x/', wrap)).toBe(
      '﻿#EXTM3U\r\n#EXT-X-TARGETDURATION:6\r\n\r\n# comment URI="c.ts"\r#EXTINF:6,\n' +
        '  R(http://h.example/x/a.ts) \t\r\nR(http://h.example/x/b.ts)',
    );
  });

  it('keeps relative URIs as they are when the base URL is unusable', () => {
    expect(
      rewritePlaylist('#EXT-X-TARGETDURATION:6\nseg.ts\nhttps://a.example/b.ts\n', 'not a url', wrap),
    ).toBe('#EXT-X-TARGETDURATION:6\nseg.ts\nR(https://a.example/b.ts)\n');
  });

  it('rewrites every *-URI attribute and X-ASSET-LIST (content steering, interstitials)', () => {
    const base = 'https://cdn.example/live/index.m3u8';
    const text = [
      '#EXT-X-CONTENT-STEERING:SERVER-URI="/steering?video=1",PATHWAY-ID="CDN-A"',
      '#EXT-X-DATERANGE:ID="ad1",CLASS="com.apple.hls.interstitial",START-DATE="2026-10-09T10:00:00Z",' +
        'X-ASSET-URI="ads/spot.m3u8",X-RESUME-OFFSET=0',
      '#EXT-X-DATERANGE:ID="ad2",CLASS="com.apple.hls.interstitial",' +
        'X-ASSET-LIST="https://ads.example/l.json"',
      '#EXT-X-SESSION-DATA:DATA-ID="com.example.lyrics",URI="lyrics.json",LANGUAGE="en"',
    ].join('\n');
    expect(rewritePlaylist(text, base, wrap)).toBe(
      [
        '#EXT-X-CONTENT-STEERING:SERVER-URI="R(https://cdn.example/steering?video=1)",PATHWAY-ID="CDN-A"',
        '#EXT-X-DATERANGE:ID="ad1",CLASS="com.apple.hls.interstitial",START-DATE="2026-10-09T10:00:00Z",' +
          'X-ASSET-URI="R(https://cdn.example/live/ads/spot.m3u8)",X-RESUME-OFFSET=0',
        '#EXT-X-DATERANGE:ID="ad2",CLASS="com.apple.hls.interstitial",' +
          'X-ASSET-LIST="R(https://ads.example/l.json)"',
        '#EXT-X-SESSION-DATA:DATA-ID="com.example.lyrics",URI="R(https://cdn.example/live/lyrics.json)",' +
          'LANGUAGE="en"',
      ].join('\n'),
    );
  });

  it('parses attribute lists with their quoting: ",URI=" inside another quoted value is just text', () => {
    const base = 'https://cdn.example/live/index.m3u8';
    const cases = [
      [
        '#EXT-X-DATERANGE:ID="x",X-COM-NOTE="see,URI=",X-ASSET-URI="a.m3u8"',
        '#EXT-X-DATERANGE:ID="x",X-COM-NOTE="see,URI=",X-ASSET-URI="R(https://cdn.example/live/a.m3u8)"',
      ],
      [
        '#EXT-X-MEDIA:TYPE=AUDIO,NAME="Dub, URI=\'b.m3u8\'",URI="en.m3u8"',
        '#EXT-X-MEDIA:TYPE=AUDIO,NAME="Dub, URI=\'b.m3u8\'",URI="R(https://cdn.example/live/en.m3u8)"',
      ],
      [
        '#EXT-X-STREAM-INF:BANDWIDTH=1,CODECS="avc1.64001f,mp4a.40.2",RESOLUTION=1280x720',
        '#EXT-X-STREAM-INF:BANDWIDTH=1,CODECS="avc1.64001f,mp4a.40.2",RESOLUTION=1280x720',
      ],
      // Not attribute lists: an #EXTINF title is free text; date, byte range and numbers have no attributes.
      ['#EXTINF:6,URI="title.ts"'],
      ['#EXT-X-PROGRAM-DATE-TIME:2026-10-09T10:00:00.000Z'],
      ['#EXT-X-BYTERANGE:720@0'],
      // Malformed: parsing stops at the first thing that isn't an attribute (or an unterminated quoted
      // string); attributes before it are still rewritten.
      ['#EXT-X-MAP:URI="init.mp4'],
      [
        '#EXT-X-PART:URI="p.m4s",DURATION=1,X-NOTE="oops,URI="q.m4s"',
        '#EXT-X-PART:URI="R(https://cdn.example/live/p.m4s)",DURATION=1,X-NOTE="oops,URI="q.m4s"',
      ],
      [
        '  #EXT-X-KEY:METHOD=AES-128, URI="k.bin" , IV=0x1',
        '  #EXT-X-KEY:METHOD=AES-128, URI="R(https://cdn.example/live/k.bin)" , IV=0x1',
      ],
    ];
    for (const [line, expected = line] of cases) {
      expect(rewritePlaylist(`#EXT-X-TARGETDURATION:6\n${line}\n`, base, wrap), line).toBe(
        `#EXT-X-TARGETDURATION:6\n${expected}\n`,
      );
    }
  });
});

// ---------------------------------------------------------------------------------------------------------

describe('handleRequest: health, methods and preflight', () => {
  it('answers the health check with CORS for an allowed origin and no-store', async () => {
    const fetchImpl = mockFetch();
    for (const path of ['/', '/?health', '/?health=1&t=123']) {
      const response = await handleRequest(relayRequest(path), { fetchImpl });
      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toMatch(/^application\/json/);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe(APP_ORIGIN);
      expect(await response.text()).toBe('{"ok":true,"service":"iptv-stream-relay","version":1}');
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('answers the health check for anyone, but without CORS headers for unknown origins', async () => {
    for (const origin of ['https://evil.example', null]) {
      const response = await handleRequest(relayRequest('/?health', { origin }));
      expect(response.status).toBe(200);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
    }
    const head = await handleRequest(relayRequest('/', { method: 'HEAD' }));
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    expect((await handleRequest(relayRequest('/favicon.ico'))).status).toBe(404);
  });

  it('answers CORS preflights for allowed origins only', async () => {
    const ok = await handleRequest(
      relayRequest('/?url=x', { method: 'OPTIONS', headers: { 'Access-Control-Request-Headers': 'range' } }),
    );
    expect(ok.status).toBe(204);
    expect(Object.fromEntries(ok.headers)).toMatchObject({
      'access-control-allow-origin': APP_ORIGIN,
      'access-control-allow-methods': 'GET, HEAD, OPTIONS',
      'access-control-allow-headers': 'Range, Content-Type, Accept',
      'access-control-max-age': '86400',
      vary: 'Origin',
    });
    expect(ok.headers.get('Access-Control-Allow-Private-Network')).toBeNull();

    const local = await handleRequest(
      relayRequest('/', { method: 'OPTIONS', headers: { 'Access-Control-Request-Private-Network': 'true' } }),
    );
    expect(local.headers.get('Access-Control-Allow-Private-Network')).toBe('true');

    const denied = await handleRequest(
      relayRequest('/', { method: 'OPTIONS', origin: 'https://evil.example' }),
    );
    expect(denied.status).toBe(403);
    expect(denied.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('rejects other methods with 405', async () => {
    const fetchImpl = mockFetch();
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const response = await handleRequest(relayRequest(viaQuery('https://cdn.example/a.ts'), { method }), {
        fetchImpl,
      });
      expect(response.status).toBe(405);
      expect(response.headers.get('Allow')).toBe('GET, HEAD, OPTIONS');
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe(APP_ORIGIN);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('handleRequest: origin allowlist', () => {
  const target = viaQuery('https://cdn.example/live/a.ts');

  it('refuses requests without Origin or Referer, and unknown origins', async () => {
    const fetchImpl = mockFetch();
    for (const origin of [
      null,
      'https://evil.example',
      'https://almailgroup.github.io.evil.example',
      'null',
    ]) {
      const response = await handleRequest(relayRequest(target, { origin }), { fetchImpl });
      expect(response.status).toBe(403);
      expect(await response.text()).toBe('Origin not allowed');
      expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('falls back to the Referer origin without an Origin header (native <video>), not for null', async () => {
    const fetchImpl = mockFetch();
    const referred = await handleRequest(
      relayRequest(target, { origin: null, headers: { Referer: `${APP_ORIGIN}/iptv-player/` } }),
      { fetchImpl },
    );
    expect(referred.status).toBe(200);
    expect(referred.headers.get('Access-Control-Allow-Origin')).toBe(APP_ORIGIN);

    const opaque = await handleRequest(
      relayRequest(target, { origin: 'null', headers: { Referer: `${APP_ORIGIN}/` } }),
      { fetchImpl },
    );
    expect(opaque.status).toBe(403);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('matches origins case-insensitively and ignores paths / default ports in the allowlist', async () => {
    const allowedOrigins = ['HTTPS://My.Example.COM:443/iptv/', 'http://LOCALHOST:5173'];
    for (const origin of ['https://my.example.com', 'http://localhost:5173']) {
      const response = await handleRequest(relayRequest(target, { origin }), {
        allowedOrigins,
        fetchImpl: mockFetch(),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe(origin);
    }
    const otherPort = await handleRequest(relayRequest(target, { origin: 'http://localhost:5174' }), {
      allowedOrigins,
      fetchImpl: mockFetch(),
    });
    expect(otherPort.status).toBe(403);
  });

  it("allows everyone with a '*' entry and answers Access-Control-Allow-Origin: *", async () => {
    for (const origin of ['https://anyone.example', null]) {
      const response = await handleRequest(relayRequest(target, { origin }), {
        allowedOrigins: ['*'],
        fetchImpl: mockFetch(),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    }
  });

  it('accepts the allowlist as a comma-separated string', async () => {
    const response = await handleRequest(relayRequest(target, { origin: 'https://b.example' }), {
      allowedOrigins: 'https://a.example, https://b.example',
      fetchImpl: mockFetch(),
    });
    expect(response.status).toBe(200);
  });
});

describe('handleRequest: targets', () => {
  it('fetches the query-form target with GET, redirect: manual and the request signal', async () => {
    const fetchImpl = mockFetch();
    const request = relayRequest(viaQuery('http://1.2.3.4:8080/live/user/pass/1234.ts?token=a+b&x=%2F'));
    const response = await handleRequest(request, { fetchImpl });
    expect(response.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('http://1.2.3.4:8080/live/user/pass/1234.ts?token=a+b&x=%2F');
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual' });
    expect(init.signal).toBe(request.signal);
  });

  it('accepts the path form, also with merged slashes or a fully encoded target', async () => {
    const cases = [
      ['/http://host.example:8080/path/x.m3u8?token=1', 'http://host.example:8080/path/x.m3u8?token=1'],
      ['/https://cdn.example/a.ts?url=ignored', 'https://cdn.example/a.ts?url=ignored'],
      ['/http:/host.example/x.ts', 'http://host.example/x.ts'],
      [`/${encodeURIComponent('https://cdn.example/a b.ts?x=1')}`, 'https://cdn.example/a%20b.ts?x=1'],
    ];
    for (const [path, expected] of cases) {
      const fetchImpl = mockFetch();
      const response = await handleRequest(relayRequest(path), { fetchImpl });
      expect(response.status, path).toBe(200);
      expect(fetchImpl.mock.calls[0][0]).toBe(expected);
    }
  });

  it('passes low-latency HLS delivery directives on to the real playlist (query form)', async () => {
    const fetchImpl = mockFetch();
    await handleRequest(
      relayRequest(`${viaQuery('https://cdn.example/live.m3u8?t=1')}&_HLS_msn=12&_HLS_part=3`),
      {
        fetchImpl,
      },
    );
    expect(fetchImpl.mock.calls[0][0]).toBe('https://cdn.example/live.m3u8?t=1&_HLS_msn=12&_HLS_part=3');
  });

  it('rejects missing, relative, non-http(s) and malformed targets with 400', async () => {
    const fetchImpl = mockFetch();
    for (const path of [
      '/?url=',
      viaQuery('/relative/path.m3u8'),
      viaQuery('ftp://files.example/a.ts'),
      viaQuery('javascript:alert(1)'),
      viaQuery('file:///etc/passwd'),
      viaQuery('not a url'),
      '/http://',
    ]) {
      const response = await handleRequest(relayRequest(path), { fetchImpl });
      expect(response.status, path).toBe(400);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe(APP_ORIGIN);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects credentials in the target URL (400) and targets over 8192 characters (414)', async () => {
    const fetchImpl = mockFetch();
    for (const target of ['http://user:pass@iptv.example/live.ts', 'https://user@iptv.example/live.ts']) {
      const response = await handleRequest(relayRequest(viaQuery(target)), { fetchImpl });
      expect(response.status).toBe(400);
      expect(await response.text()).toMatch(/credentials/i);
    }
    const long = `https://cdn.example/${'a'.repeat(8200)}`;
    expect((await handleRequest(relayRequest(viaQuery(long)), { fetchImpl })).status).toBe(414);
    expect((await handleRequest(relayRequest(`/${long}`), { fetchImpl })).status).toBe(414);
    const fits = `https://cdn.example/${'a'.repeat(8000)}`;
    expect((await handleRequest(relayRequest(viaQuery(fits)), { fetchImpl })).status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('refuses localhost, private, link-local and unique-local targets (403)', async () => {
    const fetchImpl = mockFetch();
    const blocked = [
      'http://localhost/x.ts',
      'http://LOCALHOST:8080/x.ts',
      'http://tv.localhost/x.ts',
      'http://localhost./x.ts',
      'http://127.0.0.1/x.ts',
      'http://127.1/x.ts',
      'http://2130706433/x.ts',
      'http://0x7f.0.0.1/x.ts',
      'http://10.1.2.3:8080/x.ts',
      'http://172.16.0.1/x.ts',
      'http://172.31.255.254/x.ts',
      'http://192.168.1.1/x.ts',
      'http://169.254.169.254/latest/meta-data/',
      'http://100.64.0.1/x.ts',
      'http://100.127.255.254/x.ts',
      'http://0.0.0.0/x.ts',
      'http://[::1]/x.ts',
      'http://[::]/x.ts',
      'http://[fc00::1]/x.ts',
      'http://[fd12:3456::1]/x.ts',
      'http://[fe80::1]/x.ts',
      'http://[::ffff:127.0.0.1]/x.ts',
      'http://[::ffff:192.168.0.1]/x.ts',
      'http://[::ffff:0:7f00:1]/x.ts',
      'http://[64:ff9b:1::a00:1]/x.ts',
      'http://router/x.ts',
      'http://nas.local/x.ts',
      'http://metadata.google.internal/computeMetadata/v1/',
    ];
    for (const target of blocked) {
      const response = await handleRequest(relayRequest(viaQuery(target)), { fetchImpl });
      expect(response.status, target).toBe(403);
      expect(await response.text()).toBe('Target not allowed');
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('relays public addresses that merely look close to private ranges', async () => {
    const allowed = [
      'http://172.32.0.1/x.ts',
      'http://172.15.255.255/x.ts',
      'http://100.128.0.1/x.ts',
      'http://192.169.0.1/x.ts',
      'http://11.0.0.1/x.ts',
      'http://8.8.8.8:8080/x.ts',
      'http://[2001:4860:4860::8888]/x.ts',
      'http://localhost.example.com/x.ts',
    ];
    for (const target of allowed) {
      const response = await handleRequest(relayRequest(viaQuery(target)), { fetchImpl: mockFetch() });
      expect(response.status, target).toBe(200);
    }
  });

  const LOCAL_CASES = [
    ['http://localhost:8787', 'http://127.0.0.1:9000/live/a.ts'],
    ['http://127.0.0.1:8787', 'http://localhost:8080/x.m3u8'],
    ['http://[::1]:8787', 'http://192.168.1.20/x.ts'],
    ['http://192.168.1.10:8787', 'http://192.168.1.20:8000/stream'],
  ];

  it('never trusts where the relay seems to run: a local URL or Host header unlocks nothing', async () => {
    const fetchImpl = mockFetch();
    for (const [base, target] of LOCAL_CASES) {
      const headers = { Host: new URL(base).host, 'X-Forwarded-For': '127.0.0.1', 'X-Real-IP': '127.0.0.1' };
      const response = await handleRequest(relayRequest(viaQuery(target, base), { headers }), { fetchImpl });
      expect(response.status, `${base} → ${target}`).toBe(403);
      expect(await response.text()).toBe('Target not allowed');
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('relays private targets only with allowPrivateTargets: true', async () => {
    for (const [base, target] of LOCAL_CASES) {
      const fetchImpl = mockFetch();
      const response = await handleRequest(relayRequest(viaQuery(target, base)), {
        fetchImpl,
        allowPrivateTargets: true,
      });
      expect(response.status, `${base} → ${target}`).toBe(200);
      expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([target]);
    }
    for (const allowPrivateTargets of ['true', 1, {}]) {
      const fetchImpl = mockFetch();
      const response = await handleRequest(relayRequest(viaQuery('http://10.0.0.1/a.ts')), {
        fetchImpl,
        allowPrivateTargets,
      });
      expect(response.status, String(allowPrivateTargets)).toBe(403);
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });

  it('isPrivateHost also understands bare socket addresses', () => {
    for (const host of ['::1', '::ffff:127.0.0.1', '127.0.0.1', 'fe80::1%eth0', '10.0.0.1', 'fd00::5']) {
      expect(isPrivateHost(host), host).toBe(true);
    }
    for (const host of ['8.8.4.4', '2606:4700::1111', 'example.com', '', 'a/b', 'evil.example@127.0.0.1']) {
      expect(isPrivateHost(host), host).toBe(false);
    }
  });

  it('isPrivateHost sees IPv4 in IPv4-translated (::ffff:0:a.b.c.d) addresses; NAT64 local-use is private', () => {
    for (const host of [
      '::ffff:0:7f00:1',
      '::ffff:0:127.0.0.1',
      '[::ffff:0:a9fe:a9fe]', // 169.254.169.254
      '::ffff:0:192.168.1.1',
      '64:ff9b:1::a00:1', // NAT64 local-use prefix 64:ff9b:1::/48, any embedded address
      '64:ff9b:1::808:808',
      '64:ff9b:1:ffff:ffff::1',
    ]) {
      expect(isPrivateHost(host), host).toBe(true);
    }
    for (const host of ['::ffff:0:808:808', '64:ff9b::808:808', '64:ff9b:2::1']) {
      expect(isPrivateHost(host), host).toBe(false);
    }
  });

  it('isPrivateHost refuses documentation (TEST-NET) addresses, which are never on the public internet', () => {
    // Regression: some networks route them internally (a container whose own address was 192.0.2.2 could be
    // reached through the relay without --allow-private).
    for (const host of ['192.0.2.2', '198.51.100.7', '203.0.113.5', '2001:db8::1', '::ffff:192.0.2.2']) {
      expect(isPrivateHost(host), host).toBe(true);
    }
    for (const host of ['192.0.3.1', '198.51.101.1', '203.0.114.1', '2001:db9::1']) {
      expect(isPrivateHost(host), host).toBe(false);
    }
  });
});

describe('handleRequest: redirects', () => {
  /** A 3xx upstream answer; no Location header when `location` is null. */
  const redirect = (location, status = 302, body = 'moved') =>
    new Response(body, { status, headers: location === null ? {} : { Location: location } });
  /** A fetch mock that answers by URL (`routes[url]()`), 404 for anything else. */
  const routeFetch = (routes) =>
    vi.fn(async (url) => (routes[url] ? routes[url]() : new Response('not found', { status: 404 })));
  const requested = (fetchImpl) => fetchImpl.mock.calls.map(([url]) => url);

  it('follows redirects itself, resolving relative Locations, with the same method and headers', async () => {
    let cancelled = false;
    const movedBody = new ReadableStream({
      cancel() {
        cancelled = true;
      },
    });
    const fetchImpl = routeFetch({
      'https://short.example/ch/1': () => redirect('/live/index.m3u8?t=1', 302, movedBody),
      'https://short.example/live/index.m3u8?t=1': () => redirect('https://edge.cdn.example/s/abc/', 301),
      'https://edge.cdn.example/s/abc/': () => redirect('v.m3u8', 307),
      'https://edge.cdn.example/s/abc/v.m3u8': () =>
        new Response('#EXTM3U\n#EXT-X-TARGETDURATION:6\nseg.ts\n', {
          headers: { 'Content-Type': 'application/vnd.apple.mpegurl' },
        }),
    });
    const response = await handleRequest(
      relayRequest(viaQuery('https://short.example/ch/1'), { headers: { 'User-Agent': 'TestPlayer/1' } }),
      { fetchImpl },
    );
    expect(response.status).toBe(200);
    expect(requested(fetchImpl)).toEqual([
      'https://short.example/ch/1',
      'https://short.example/live/index.m3u8?t=1',
      'https://edge.cdn.example/s/abc/',
      'https://edge.cdn.example/s/abc/v.m3u8',
    ]);
    for (const [, init] of fetchImpl.mock.calls) {
      expect(init).toMatchObject({ method: 'GET', redirect: 'manual' });
      expect(init.headers.get('User-Agent')).toBe('TestPlayer/1');
    }
    expect(cancelled).toBe(true); // redirect bodies are released, not left hanging
    expect(response.headers.get('X-Relay-Final-Url')).toBe('https://edge.cdn.example/s/abc/v.m3u8');
    expect(await response.text()).toBe(
      `#EXTM3U\n#EXT-X-TARGETDURATION:6\n${viaQuery('https://edge.cdn.example/s/abc/seg.ts')}\n`,
    );
  });

  it('keeps HEAD on every hop, also after a 303', async () => {
    const fetchImpl = routeFetch({
      'https://a.example/x.mp4': () => redirect('https://b.example/x.mp4', 303, null),
      'https://b.example/x.mp4': () =>
        new Response(null, { headers: { 'Content-Type': 'video/mp4', 'Content-Length': '42' } }),
    });
    const request = relayRequest(viaQuery('https://a.example/x.mp4'), { method: 'HEAD' });
    const response = await handleRequest(request, { fetchImpl });
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Length')).toBe('42');
    expect(fetchImpl.mock.calls.map(([, init]) => init.method)).toEqual(['HEAD', 'HEAD']);
  });

  it('checks every hop before requesting it: a redirect to a private address is never sent', async () => {
    for (const location of [
      'http://169.254.169.254/latest/meta-data/',
      'http://127.0.0.1:8080/admin',
      '//localhost/x.ts',
      'http://[::ffff:10.0.0.1]/x.ts',
      'http://nas.local/x.ts',
    ]) {
      const fetchImpl = routeFetch({
        'https://short.example/x': () => redirect('https://hop.example/y', 301),
        'https://hop.example/y': () => redirect(location),
      });
      const response = await handleRequest(relayRequest(viaQuery('https://short.example/x')), { fetchImpl });
      expect(response.status, location).toBe(403);
      expect(await response.text()).toBe('Target not allowed');
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe(APP_ORIGIN);
      expect(requested(fetchImpl)).toEqual(['https://short.example/x', 'https://hop.example/y']);
    }

    const fetchImpl = routeFetch({
      'https://short.example/x': () => redirect('http://192.168.1.20:8000/live.ts'),
      'http://192.168.1.20:8000/live.ts': () =>
        new Response('media', { headers: { 'Content-Type': 'video/mp2t' } }),
    });
    const allowed = await handleRequest(relayRequest(viaQuery('https://short.example/x')), {
      fetchImpl,
      allowPrivateTargets: true,
    });
    expect(allowed.status).toBe(200);
    expect(await allowed.text()).toBe('media');
  });

  it('answers 502 for a redirect to a non-http(s), credentialed, long or broken URL, unsent', async () => {
    for (const location of [
      'ftp://files.example/a.ts',
      'javascript:alert(1)',
      'data:text/plain,hi',
      'http://user:pass@cdn.example/a.ts',
      `https://cdn.example/${'a'.repeat(8200)}`,
      'http://[oops/',
    ]) {
      const fetchImpl = routeFetch({ 'https://short.example/x': () => redirect(location) });
      const response = await handleRequest(relayRequest(viaQuery('https://short.example/x')), { fetchImpl });
      expect(response.status, location).toBe(502);
      expect(await response.text()).toBe('Invalid redirect from upstream');
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it('follows at most 5 redirects, then answers 508 "Too many redirects"', async () => {
    const chain = (hops) => {
      const routes = {};
      for (let i = 0; i < hops; i++) routes[`https://loop.example/${i}`] = () => redirect(`/${i + 1}`);
      routes[`https://loop.example/${hops}`] = () =>
        new Response('media', { headers: { 'Content-Type': 'video/mp2t' } });
      return routeFetch(routes);
    };
    const five = chain(5);
    const ok = await handleRequest(relayRequest(viaQuery('https://loop.example/0')), { fetchImpl: five });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('X-Relay-Final-Url')).toBe('https://loop.example/5');
    expect(five).toHaveBeenCalledTimes(6);

    const six = chain(6);
    const tooMany = await handleRequest(relayRequest(viaQuery('https://loop.example/0')), { fetchImpl: six });
    expect(tooMany.status).toBe(508);
    expect(await tooMany.text()).toBe('Too many redirects');
    expect(tooMany.headers.get('Access-Control-Allow-Origin')).toBe(APP_ORIGIN);
    expect(six).toHaveBeenCalledTimes(6);
    expect(requested(six)).not.toContain('https://loop.example/6');
  });

  it('passes a redirect without a Location through as it is', async () => {
    const fetchImpl = mockFetch(() => redirect(null, 302, 'no location'));
    const response = await handleRequest(relayRequest(viaQuery('https://odd.example/x.ts')), { fetchImpl });
    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBeNull();
    expect(response.headers.get('X-Relay-Final-Url')).toBe('https://odd.example/x.ts');
    expect(await response.text()).toBe('no location');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('answers 502 when a hop is unreachable or the runtime hides the redirect (opaque)', async () => {
    const unreachable = vi.fn(async (url) => {
      if (url === 'https://short.example/x') return redirect('https://dead.example/y');
      throw new TypeError('fetch failed');
    });
    const response = await handleRequest(relayRequest(viaQuery('https://short.example/x')), {
      fetchImpl: unreachable,
    });
    expect(response.status).toBe(502);
    expect(await response.text()).toBe('Upstream unreachable');

    const opaque = { type: 'opaqueredirect', status: 0, headers: new Headers(), body: null, url: '' };
    const hidden = await handleRequest(relayRequest(viaQuery('https://short.example/x')), {
      fetchImpl: vi.fn(async () => opaque),
    });
    expect(hidden.status).toBe(502);
  });

  it('still refuses what a fetch that followed redirects on its own got from a private address', async () => {
    const followedToMetadata = () =>
      withUrl(new Response('secret'), 'http://169.254.169.254/latest/meta-data/');
    const refused = await handleRequest(relayRequest(viaQuery('https://short.example/x')), {
      fetchImpl: mockFetch(followedToMetadata),
    });
    expect(refused.status).toBe(403);
    expect(await refused.text()).toBe('Target not allowed');

    const followed = await handleRequest(relayRequest(viaQuery('https://short.example/x')), {
      fetchImpl: mockFetch(() =>
        withUrl(new Response('media', { headers: { 'Content-Type': 'video/mp2t' } }), 'https://edge.example/y'),
      ),
    });
    expect(followed.status).toBe(200);
    expect(followed.headers.get('X-Relay-Final-Url')).toBe('https://edge.example/y');
  });
});

describe('handleRequest: host names of private addresses (resolveHost)', () => {
  const DNS = {
    'cdn.example': ['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946'],
    'short.example': ['93.184.216.34'],
    '127.0.0.1.nip.io': ['127.0.0.1'],
    'localtest.me': ['127.0.0.1', '::1'],
    '169.254.169.254.nip.io': ['169.254.169.254'],
    'half.example': ['93.184.216.34', '10.0.0.7'],
    'v6.example': ['2606:4700::1111', 'fd00::1'],
    'mapped.example': ['::ffff:192.168.1.1'],
    'empty.example': [],
  };
  /** A resolveHost mock answering from DNS; unknown names fail like NXDOMAIN. */
  const resolver = (table = DNS) =>
    vi.fn(async (host) => {
      if (!Object.hasOwn(table, host)) throw new Error(`queryA ENOTFOUND ${host}`);
      return table[host];
    });

  it('refuses a target whose name resolves to any private address (403), before requesting it', async () => {
    for (const host of [
      '127.0.0.1.nip.io',
      'localtest.me',
      '169.254.169.254.nip.io',
      'half.example',
      'v6.example',
      'mapped.example',
    ]) {
      const fetchImpl = mockFetch();
      const resolveHost = resolver();
      const response = await handleRequest(relayRequest(viaQuery(`http://${host}:8080/latest/x.ts`)), {
        fetchImpl,
        resolveHost,
      });
      expect(response.status, host).toBe(403);
      expect(await response.text()).toBe('Target not allowed');
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe(APP_ORIGIN);
      expect(resolveHost.mock.calls).toEqual([[host]]);
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });

  it('relays names of public addresses; IP literals and private names are not looked up', async () => {
    const resolveHost = resolver();
    const fetchImpl = mockFetch();
    const response = await handleRequest(relayRequest(viaQuery('https://CDN.example/live/a.ts')), {
      fetchImpl,
      resolveHost,
    });
    expect(response.status).toBe(200);
    expect(resolveHost.mock.calls).toEqual([['cdn.example']]);
    for (const target of [
      'http://8.8.8.8:8080/x.ts',
      'http://134744072/x.ts',
      'http://8.8.8.8./x.ts',
      'http://[2001:4860:4860::8888]/x.ts',
    ]) {
      const literal = await handleRequest(relayRequest(viaQuery(target)), { fetchImpl, resolveHost });
      expect(literal.status, target).toBe(200);
    }
    for (const target of ['http://localhost/x.ts', 'http://nas.local/x.ts', 'http://10.0.0.1/x.ts']) {
      const refused = await handleRequest(relayRequest(viaQuery(target)), { fetchImpl, resolveHost });
      expect(refused.status, target).toBe(403);
    }
    expect(resolveHost).toHaveBeenCalledTimes(1);
  });

  it('answers 502 "Upstream unreachable" when a name does not resolve, unsent', async () => {
    const answers = [
      () => Promise.reject(new Error('ENOTFOUND')),
      () => Promise.resolve([]),
      () => Promise.resolve(undefined),
      () => {
        throw new Error('sync failure');
      },
    ];
    for (const answer of answers) {
      const fetchImpl = mockFetch();
      const response = await handleRequest(relayRequest(viaQuery('https://gone.example/a.ts')), {
        fetchImpl,
        resolveHost: vi.fn(answer),
      });
      expect(response.status).toBe(502);
      expect(await response.text()).toBe('Upstream unreachable');
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe(APP_ORIGIN);
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });

  it('looks up every redirect hop before requesting it', async () => {
    const resolveHost = resolver();
    const fetchImpl = vi.fn(async (url) =>
      url === 'https://short.example/x'
        ? new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1.nip.io:8080/admin' } })
        : new Response('secret', { headers: { 'Content-Type': 'video/mp2t' } }),
    );
    const response = await handleRequest(relayRequest(viaQuery('https://short.example/x')), {
      fetchImpl,
      resolveHost,
    });
    expect(response.status).toBe(403);
    expect(await response.text()).toBe('Target not allowed');
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual(['https://short.example/x']);
    expect(resolveHost.mock.calls).toEqual([['short.example'], ['127.0.0.1.nip.io']]);

    const deadEnd = vi.fn(
      async () => new Response(null, { status: 301, headers: { Location: '//gone.example/' } }),
    );
    const unresolved = await handleRequest(relayRequest(viaQuery('https://short.example/x')), {
      fetchImpl: deadEnd,
      resolveHost: resolver(),
    });
    expect(unresolved.status).toBe(502);
    expect(await unresolved.text()).toBe('Upstream unreachable');
    expect(deadEnd).toHaveBeenCalledTimes(1);

    // A fetch that followed redirects on its own (none of the supported runtimes does) is checked too.
    const followed = await handleRequest(relayRequest(viaQuery('https://short.example/x')), {
      fetchImpl: mockFetch(() => withUrl(new Response('secret'), 'http://localtest.me/admin')),
      resolveHost: resolver(),
    });
    expect(followed.status).toBe(403);
  });

  it('looks nothing up for refused callers or with allowPrivateTargets', async () => {
    const resolveHost = resolver();
    const stranger = relayRequest(viaQuery('http://localtest.me/x.ts'), { origin: 'https://evil.example' });
    expect((await handleRequest(stranger, { fetchImpl: mockFetch(), resolveHost })).status).toBe(403);
    const fetchImpl = mockFetch();
    const trusted = await handleRequest(relayRequest(viaQuery('http://localtest.me/x.ts')), {
      fetchImpl,
      resolveHost,
      allowPrivateTargets: true,
    });
    expect(trusted.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(resolveHost).not.toHaveBeenCalled();
  });
});

describe('handleRequest: the relay itself as a target', () => {
  it('refuses targets on its own host and port with 400, in both forms and with "*"', async () => {
    for (const [base, target] of [
      ['https://relay.example', 'https://relay.example/?url=https%3A%2F%2Fcdn.example%2Fa.ts'],
      ['https://relay.example', 'https://RELAY.example.:443/http://cdn.example/a.ts'],
      ['https://relay.example', 'http://relay.example:443/?health'],
      ['http://relay.example:8787', 'http://relay.example:8787/x'],
    ]) {
      for (const request of [
        relayRequest(viaQuery(target, base), { origin: 'https://anyone.example' }),
        relayRequest(`${base}/${target}`, { origin: 'https://anyone.example' }),
      ]) {
        const fetchImpl = mockFetch();
        const response = await handleRequest(request, { fetchImpl, allowedOrigins: ['*'] });
        expect(response.status, `${request.url}`).toBe(400);
        expect(await response.text()).toBe('Refusing to relay to itself');
        expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
        expect(fetchImpl).not.toHaveBeenCalled();
      }
    }
  });

  it('refuses redirects to itself, and relays other ports and hosts', async () => {
    const fetchImpl = mockFetch((url) =>
      url === 'https://loop.example/x'
        ? new Response(null, {
            status: 302,
            headers: { Location: `${RELAY}/?url=https%3A%2F%2Floop.example%2Fx` },
          })
        : new Response('media', { headers: { 'Content-Type': 'video/mp2t' } }),
    );
    const looped = await handleRequest(relayRequest(viaQuery('https://loop.example/x')), { fetchImpl });
    expect(looped.status).toBe(400);
    expect(await looped.text()).toBe('Refusing to relay to itself');
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    for (const target of [
      'https://relay.example:8443/a.ts',
      'http://relay.example/a.ts',
      'https://cdn.relay.example/a.ts',
    ]) {
      const response = await handleRequest(relayRequest(viaQuery(target)), { fetchImpl: mockFetch() });
      expect(response.status, target).toBe(200);
    }
  });
});

describe('handleRequest: upstream request and response', () => {
  it('forwards only Range, Accept, Accept-Language, User-Agent and conditional headers', async () => {
    const fetchImpl = mockFetch();
    await handleRequest(
      relayRequest(viaQuery('https://cdn.example/a.ts'), {
        headers: {
          Range: 'bytes=0-99',
          Accept: '*/*',
          'Accept-Language': 'de-DE',
          'User-Agent': 'Mozilla/5.0 Test',
          'If-None-Match': '"abc"',
          'If-Modified-Since': 'Wed, 21 Oct 2026 07:28:00 GMT',
          Cookie: 'session=secret',
          Authorization: 'Bearer secret',
          Referer: `${APP_ORIGIN}/`,
          'X-Forwarded-For': '203.0.113.9',
          'X-Custom': '1',
        },
      }),
      { fetchImpl },
    );
    const sent = Object.fromEntries(fetchImpl.mock.calls[0][1].headers);
    expect(sent).toEqual({
      range: 'bytes=0-99',
      accept: '*/*',
      'accept-language': 'de-DE',
      'user-agent': 'Mozilla/5.0 Test',
      'if-none-match': '"abc"',
      'if-modified-since': 'Wed, 21 Oct 2026 07:28:00 GMT',
    });
  });

  it('sends a VLC-like User-Agent when the client has none', async () => {
    const fetchImpl = mockFetch();
    await handleRequest(relayRequest(viaQuery('https://cdn.example/a.ts')), { fetchImpl });
    expect(fetchImpl.mock.calls[0][1].headers.get('User-Agent')).toBe('VLC/3.0.20 LibVLC/3.0.20');
  });

  it('copies only the safe upstream headers and adds CORS, exposed headers, final URL and CORP', async () => {
    const upstreamHeaders = {
      'Content-Type': 'video/mp2t',
      'Content-Length': '5',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'max-age=60',
      ETag: '"v1"',
      'Last-Modified': 'Wed, 21 Oct 2026 07:28:00 GMT',
      Expires: 'Wed, 21 Oct 2026 08:28:00 GMT',
      'Set-Cookie': 'tracking=1',
      Server: 'secret-box/1.0',
      'X-Powered-By': 'PHP',
      'Access-Control-Allow-Origin': 'https://somewhere.example',
      'Content-Security-Policy': "default-src 'none'",
    };
    const fetchImpl = mockFetch(() => new Response('media', { headers: upstreamHeaders }));
    const response = await handleRequest(relayRequest(viaQuery('https://cdn.example/a.ts')), { fetchImpl });
    expect(Object.fromEntries(response.headers)).toEqual({
      'content-type': 'video/mp2t',
      'content-length': '5',
      'accept-ranges': 'bytes',
      'cache-control': 'max-age=60',
      etag: '"v1"',
      'last-modified': 'Wed, 21 Oct 2026 07:28:00 GMT',
      expires: 'Wed, 21 Oct 2026 08:28:00 GMT',
      'access-control-allow-origin': APP_ORIGIN,
      'access-control-expose-headers': EXPOSED,
      vary: 'Origin',
      'x-relay-final-url': 'https://cdn.example/a.ts',
      'cross-origin-resource-policy': 'cross-origin',
      'content-security-policy': 'sandbox',
      'x-content-type-options': 'nosniff',
    });
    expect(await response.text()).toBe('media');
  });

  it('drops Content-Length when the upstream body was compressed (fetch hands it over decoded)', async () => {
    const fetchImpl = mockFetch(
      () =>
        new Response('decoded', {
          headers: { 'Content-Type': 'video/mp2t', 'Content-Encoding': 'gzip', 'Content-Length': '3' },
        }),
    );
    const response = await handleRequest(relayRequest(viaQuery('https://cdn.example/a.ts')), { fetchImpl });
    expect(response.headers.get('Content-Length')).toBeNull();
    expect(response.headers.get('Content-Encoding')).toBeNull();
  });

  it('passes 206 range responses through', async () => {
    const fetchImpl = mockFetch(
      () =>
        new Response('0123456789', {
          status: 206,
          headers: {
            'Content-Type': 'video/mp4',
            'Content-Range': 'bytes 100-109/5000',
            'Content-Length': '10',
            'Accept-Ranges': 'bytes',
          },
        }),
    );
    const response = await handleRequest(
      relayRequest(viaQuery('https://cdn.example/movie.mp4'), { headers: { Range: 'bytes=100-109' } }),
      { fetchImpl },
    );
    expect(fetchImpl.mock.calls[0][1].headers.get('Range')).toBe('bytes=100-109');
    expect(response.status).toBe(206);
    expect(response.headers.get('Content-Range')).toBe('bytes 100-109/5000');
    expect(response.headers.get('Content-Length')).toBe('10');
    expect(response.headers.get('Accept-Ranges')).toBe('bytes');
    expect(await response.text()).toBe('0123456789');
  });

  it('streams media bodies through without buffering them', async () => {
    const source = controlledStream(['chunk-1|']);
    const fetchImpl = mockFetch(
      () => new Response(source.stream, { headers: { 'Content-Type': 'video/mp2t' } }),
    );
    const response = await handleRequest(relayRequest('/http://1.2.3.4:8080/live/1.ts'), { fetchImpl });
    expect(response.status).toBe(200);
    const reader = response.body.getReader();
    const first = await reader.read(); // the upstream body is still open here
    expect(new TextDecoder().decode(first.value)).toBe('chunk-1|');
    source.finish('chunk-2');
    expect(await readAll(reader)).toBe('chunk-2');
  });

  it('relays HEAD, 304 and upstream error statuses without a body where required', async () => {
    const headFetch = mockFetch(
      () => new Response(null, { headers: { 'Content-Type': 'video/mp4', 'Content-Length': '1234' } }),
    );
    const head = await handleRequest(
      relayRequest(viaQuery('https://cdn.example/a.mp4'), { method: 'HEAD' }),
      {
        fetchImpl: headFetch,
      },
    );
    expect(headFetch.mock.calls[0][1].method).toBe('HEAD');
    expect(head.status).toBe(200);
    expect(head.headers.get('Content-Length')).toBe('1234');
    expect(head.body).toBeNull();

    const notModified = await handleRequest(relayRequest(viaQuery('https://cdn.example/a.ts')), {
      fetchImpl: mockFetch(() => new Response(null, { status: 304, headers: { ETag: '"v1"' } })),
    });
    expect(notModified.status).toBe(304);
    expect(notModified.headers.get('ETag')).toBe('"v1"');

    const missing = await handleRequest(relayRequest(viaQuery('https://cdn.example/gone.m3u8')), {
      fetchImpl: mockFetch(
        () =>
          new Response('#EXT-X-TARGETDURATION:6\na.ts', {
            status: 404,
            headers: { 'Content-Type': 'audio/mpegurl' },
          }),
      ),
    });
    expect(missing.status).toBe(404);
    expect(await missing.text()).toBe('#EXT-X-TARGETDURATION:6\na.ts'); // error bodies are never rewritten
  });

  it('answers 502 "Upstream unreachable" when the upstream fetch fails, leaking no details', async () => {
    const failing = vi.fn(async () => {
      throw new TypeError('fetch failed: getaddrinfo ENOTFOUND dead.example at /srv/relay.js:1:1');
    });
    const response = await handleRequest(relayRequest(viaQuery('https://dead.example/a.ts')), {
      fetchImpl: failing,
    });
    expect(response.status).toBe(502);
    expect(await response.text()).toBe('Upstream unreachable');
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(APP_ORIGIN);

    const empty = await handleRequest(relayRequest(viaQuery('https://dead.example/a.ts')), {
      fetchImpl: vi.fn(async () => undefined),
    });
    expect(empty.status).toBe(502);
  });

  /** A body that records whether the relay cancelled it (refused bodies are released, not left hanging). */
  const cancellable = (text) => {
    const body = {
      cancelled: false,
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue(bytes(text));
        },
        cancel() {
          body.cancelled = true;
        },
      }),
    };
    return body;
  };
  const TEXTUAL_TYPES = [
    'text/html',
    'text/html; charset=utf-8',
    'TEXT/HTML',
    'application/xhtml+xml',
    'text/plain',
    'text/xml',
    'text/css',
    'text/javascript',
    'application/json',
    'application/problem+json',
    'application/xml',
    'application/rss+xml',
    'application/javascript',
    'image/svg+xml',
    'html', // malformed: no subtype
    '*/*', // placeholders that browsers treat like a missing type
    'unknown/unknown',
    'application/unknown',
    null, // unlabeled
  ];

  it('refuses 2xx text, data, script and unlabeled bodies with 415 unless they are playlists', async () => {
    for (const type of TEXTUAL_TYPES) {
      for (const text of ['<!doctype html><title>Login</title>', '{"AccessKeyId":"secret"}', 'x']) {
        const body = cancellable(text);
        const upstream = new Response(body.stream);
        if (type) upstream.headers.set('Content-Type', type);
        const response = await handleRequest(relayRequest(viaQuery('https://site.example/index.m3u8')), {
          fetchImpl: mockFetch(() => upstream),
        });
        expect(response.status, `${type} ${text}`).toBe(415);
        expect(await response.text()).toBe('Not a media stream');
        expect(response.headers.get('Access-Control-Allow-Origin')).toBe(APP_ORIGIN);
        expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
        expect(body.cancelled).toBe(true);
      }
      const empty = new Response('');
      if (type) empty.headers.set('Content-Type', type);
      else empty.headers.delete('Content-Type');
      const nothing = await handleRequest(relayRequest(viaQuery('https://site.example/a')), {
        fetchImpl: mockFetch(() => empty),
      });
      expect(nothing.status, `${type} (empty)`).toBe(415);
    }
    for (const status of [201, 203, 206]) {
      const partial = await handleRequest(relayRequest(viaQuery('https://site.example/')), {
        fetchImpl: mockFetch(() => new Response('<p>', { status, headers: { 'Content-Type': 'text/html' } })),
      });
      expect(partial.status, String(status)).toBe(415);
    }
  });

  it('relays 2xx text-typed (even text/html) or unlabeled bodies that start with #EXTM3U as playlists', async () => {
    const media = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nseg1.ts\n';
    const channels = '#EXTM3U\n#EXTINF:-1 tvg-id="a",A\nhttp://1.2.3.4/a.ts\n';
    for (const type of TEXTUAL_TYPES) {
      const playlist = new Response(bytes(media));
      if (type) playlist.headers.set('Content-Type', type);
      const response = await handleRequest(relayRequest(viaQuery('https://cdn.example/live/play.php?id=1')), {
        fetchImpl: mockFetch(() => playlist),
      });
      expect(response.status, String(type)).toBe(200);
      expect(response.headers.get('Content-Type')).toBe('application/vnd.apple.mpegurl');
      expect(await response.text()).toBe(
        `#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\n${viaQuery('https://cdn.example/live/seg1.ts')}\n`,
      );

      const list = new Response(bytes(channels));
      if (type) list.headers.set('Content-Type', type);
      const listed = await handleRequest(relayRequest(viaQuery('https://lists.example/get.php')), {
        fetchImpl: mockFetch(() => list),
      });
      expect(listed.status, String(type)).toBe(200);
      expect(await listed.text()).toBe(channels); // a channel list: never rewritten
    }
  });

  it('relays media mislabeled as text or unlabeled when its first bytes show the format, relabeled', async () => {
    const pad = (head, size) => {
      const out = new Uint8Array(size);
      out.set(head);
      return out;
    };
    const ts = pad([0x47, 0x40, 0x00, 0x10], 376);
    ts[188] = 0x47;
    const box = (type, size = 24) => pad([0, 0, 0, size, ...bytes(type)], 64);
    const samples = [
      ['MPEG-TS', ts, 'video/mp2t'],
      ['one TS packet', ts.slice(0, 188), 'video/mp2t'],
      ['fMP4 init (ftyp)', box('ftyp'), 'video/mp4'],
      ['fMP4 segment (styp)', box('styp'), 'video/mp4'],
      ['fMP4 fragment (moof)', box('moof', 100), 'video/mp4'],
      ['WebM', pad([0x1a, 0x45, 0xdf, 0xa3, 0x9f], 32), 'video/webm'],
      ['FLV', pad([...bytes('FLV'), 0x01, 0x05], 32), 'video/x-flv'],
      ['ID3-tagged packed audio', pad([...bytes('ID3'), 0x04, 0x00], 32), 'audio/aac'],
      ['ADTS AAC', pad([0xff, 0xf1, 0x50, 0x80], 32), 'audio/aac'],
      ['MP3', pad([0xff, 0xfb, 0x90, 0x64], 32), 'audio/mpeg'],
    ];
    // e.g. Apache's type for .ts files, a server's text/plain, or none at all
    for (const type of ['text/vnd.trolltech.linguist', 'text/plain', 'application/json', null]) {
      for (const [name, body, expected] of samples) {
        const upstream = new Response(body, { headers: { 'Content-Length': String(body.byteLength) } });
        if (type) upstream.headers.set('Content-Type', type);
        else upstream.headers.delete('Content-Type');
        const response = await handleRequest(relayRequest(viaQuery('https://cdn.example/live/seg1.ts')), {
          fetchImpl: mockFetch(() => upstream),
        });
        expect(response.status, `${type} ${name}`).toBe(200);
        expect(response.headers.get('Content-Type'), `${type} ${name}`).toBe(expected);
        expect(response.headers.get('Content-Length')).toBe(String(body.byteLength));
        expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(body);
      }
    }
    // A body that arrives a byte at a time is read on until it is clear, then relayed whole.
    let i = 0;
    const trickle = new ReadableStream({
      pull(controller) {
        if (i < ts.byteLength) controller.enqueue(ts.subarray(i, ++i));
        else controller.close();
      },
    });
    const trickled = await handleRequest(relayRequest(viaQuery('https://cdn.example/seg2.ts')), {
      fetchImpl: mockFetch(() => new Response(trickle, { headers: { 'Content-Type': 'text/plain' } })),
    });
    expect(trickled.status).toBe(200);
    expect(trickled.headers.get('Content-Type')).toBe('video/mp2t');
    expect(new Uint8Array(await trickled.arrayBuffer())).toEqual(ts);
    // A range of it, too (the app's stream sniffing asks for the first bytes).
    const partial = await handleRequest(
      relayRequest(viaQuery('https://cdn.example/seg3.ts'), { headers: { Range: 'bytes=0-375' } }),
      {
        fetchImpl: mockFetch(
          () =>
            new Response(ts, {
              status: 206,
              headers: { 'Content-Type': 'text/plain', 'Content-Range': 'bytes 0-375/9000' },
            }),
        ),
      },
    );
    expect(partial.status).toBe(206);
    expect(partial.headers.get('Content-Type')).toBe('video/mp2t');
    expect(partial.headers.get('Content-Range')).toBe('bytes 0-375/9000');
  });

  it('still refuses text that merely starts like a media signature', async () => {
    const utf16 = new Uint8Array([0xff, 0xfe, ...bytes('<\0h\0t\0m\0l\0>\0')]); // UTF-16 text with a BOM
    const notTs = bytes(`G${'o'.repeat(300)}`); // "G…": no second sync byte at 188
    for (const body of [bytes('G'), bytes('GET / HTTP/1.1\r\n'), notTs, bytes('ID3 tags explained'), utf16,
      bytes('xxxxftyp'), bytes('FLV is a format'), new Uint8Array([0xff, 0xf1])]) {
      const upstream = new Response(body, { headers: { 'Content-Type': 'text/plain' } });
      const response = await handleRequest(relayRequest(viaQuery('https://site.example/a')), {
        fetchImpl: mockFetch(() => upstream),
      });
      expect(response.status, new TextDecoder().decode(body).slice(0, 20)).toBe(415);
      expect(await response.text()).toBe('Not a media stream');
    }
    // A HEAD has no body to tell from, so a mislabeled segment is still refused there.
    const head = await handleRequest(relayRequest(viaQuery('https://cdn.example/seg1.ts'), { method: 'HEAD' }), {
      fetchImpl: mockFetch(() => new Response(null, { headers: { 'Content-Type': 'text/plain' } })),
    });
    expect(head.status).toBe(415);
  });

  it('relays media and binary types without asking for #EXTM3U, also WebVTT subtitle segments', async () => {
    for (const type of [
      'video/mp2t',
      'video/mp4',
      'audio/aac',
      'audio/mpeg',
      'application/vnd.apple.mpegurl',
      'application/x-mpegURL',
      'audio/x-mpegurl',
      'text/x-mpegurl',
      'application/octet-stream',
      'binary/octet-stream',
      'application/mp4',
      'image/png',
      'text/vtt',
      'text/vtt; charset=utf-8',
    ]) {
      const body = 'G-binary-or-WEBVTT';
      const response = await handleRequest(relayRequest(viaQuery('https://cdn.example/live/seg1')), {
        fetchImpl: mockFetch(() => new Response(body, { headers: { 'Content-Type': type } })),
      });
      expect(response.status, type).toBe(200);
      expect(response.headers.get('Content-Type')).toBe(type);
      expect(await response.text()).toBe(body);
    }
  });

  it('answers a HEAD of a 2xx text-typed or unlabeled response with 415 unless it is at a playlist path', async () => {
    const head = (type, path) =>
      handleRequest(relayRequest(viaQuery(`https://site.example${path}`), { method: 'HEAD' }), {
        fetchImpl: mockFetch(() => new Response(null, { headers: type ? { 'Content-Type': type } : {} })),
      });
    for (const type of ['text/html', 'application/json', 'text/plain', null]) {
      const refused = await head(type, '/login');
      expect(refused.status, String(type)).toBe(415);
      expect(await refused.text()).toBe('');
      expect(refused.headers.get('Access-Control-Allow-Origin')).toBe(APP_ORIGIN);
      // Without a body there is nothing to check; a playlist address gets the benefit of the doubt.
      expect((await head(type, '/live/index.m3u8')).status, String(type)).toBe(200);
      expect((await head(type, '/list.M3U')).status, String(type)).toBe(200);
    }
    expect((await head('video/mp4', '/movie')).status).toBe(200);
  });

  it('passes error pages through with their status (only 2xx bodies are checked)', async () => {
    const notFound = await handleRequest(relayRequest(viaQuery('https://cdn.example/gone.ts')), {
      fetchImpl: mockFetch(
        () => new Response('<h1>404</h1>', { status: 404, headers: { 'Content-Type': 'text/html' } }),
      ),
    });
    expect(notFound.status).toBe(404);
    expect(notFound.headers.get('Content-Type')).toBe('text/html');
    expect(notFound.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(notFound.headers.get('Content-Security-Policy')).toBe('sandbox');
    expect(await notFound.text()).toBe('<h1>404</h1>');
  });

  it('marks every relayed response nosniff: media, playlists, channel lists, HEAD and redirects', async () => {
    const answers = [
      () => new Response('ts', { headers: { 'Content-Type': 'video/mp2t' } }),
      () =>
        new Response('#EXTM3U\n#EXT-X-TARGETDURATION:6\na.ts\n', { headers: { 'Content-Type': 'text/plain' } }),
      () => new Response('#EXTM3U\n#EXTINF:-1,A\nhttp://a.example/a.ts\n'),
      () => new Response(null, { status: 304 }),
      () => new Response('moved', { status: 302 }),
    ];
    for (const answer of answers) {
      const response = await handleRequest(relayRequest(viaQuery('https://cdn.example/live/x')), {
        fetchImpl: mockFetch(answer),
      });
      expect(response.headers.get('X-Content-Type-Options'), String(response.status)).toBe('nosniff');
    }
  });

  it('turns unexpected internal failures into a plain 500', async () => {
    const broken = { url: 'not a url', method: 'GET', headers: new Headers() };
    const response = await handleRequest(broken);
    expect(response.status).toBe(500);
    expect(await response.text()).toBe('Relay error');
  });
});

describe('handleRequest: playlists', () => {
  const MEDIA =
    '#EXTM3U\r\n#EXT-X-TARGETDURATION:6\r\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\r\n#EXTINF:6,\r\nseg1.ts\r\n';
  const mpegurl = (text, headers = {}) =>
    mockFetch(
      () => new Response(text, { headers: { 'Content-Type': 'application/vnd.apple.mpegurl', ...headers } }),
    );

  it('rewrites HLS playlists to query-form relay URLs (keeping the relay path)', async () => {
    const fetchImpl = mpegurl(MEDIA, {
      'Content-Length': String(MEDIA.length),
      ETag: '"p1"',
      'Accept-Ranges': 'bytes',
    });
    const target = 'http://1.2.3.4:8080/live/index.m3u8';
    const response = await handleRequest(relayRequest(viaQuery(target, `${RELAY}/relay`)), { fetchImpl });
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/vnd.apple.mpegurl');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Content-Length')).toBeNull();
    expect(response.headers.get('ETag')).toBeNull();
    expect(response.headers.get('Accept-Ranges')).toBeNull();
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(APP_ORIGIN);
    const relay = `${RELAY}/relay/?url=`;
    expect(await response.text()).toBe(
      '#EXTM3U\r\n#EXT-X-TARGETDURATION:6\r\n' +
        `#EXT-X-KEY:METHOD=AES-128,URI="${relay}${encodeURIComponent('http://1.2.3.4:8080/live/key.bin')}"\r\n` +
        `#EXTINF:6,\r\n${relay}${encodeURIComponent('http://1.2.3.4:8080/live/seg1.ts')}\r\n`,
    );
  });

  it('rewrites to path-form relay URLs when the request used the path form', async () => {
    const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nlow/index.m3u8?t=1\n';
    const response = await handleRequest(relayRequest('/http://1.2.3.4:8080/live/master.m3u8'), {
      fetchImpl: mpegurl(master),
    });
    expect(await response.text()).toBe(
      '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nhttps://relay.example/http://1.2.3.4:8080/live/low/index.m3u8?t=1\n',
    );
  });

  it('detects playlists by their first bytes, whatever the content type or path', async () => {
    const cases = [
      ['text/plain', '/live/index.m3u8'],
      ['application/octet-stream', '/live/INDEX.M3U'],
      ['binary/octet-stream', '/live/index.m3u8'],
      [null, '/live/index.m3u8'],
      // Query-form URLs of native players and servers with generic types: no playlist extension at all.
      ['text/plain', '/live/play.php'],
      [null, '/live/stream'],
      ['application/json', '/live/channel'],
      ['application/vnd.apple.mpegurl', '/live/x'],
    ];
    for (const [type, path] of cases) {
      const upstream = new Response(MEDIA);
      if (type) upstream.headers.set('Content-Type', type);
      else upstream.headers.delete('Content-Type');
      const response = await handleRequest(relayRequest(viaQuery(`https://cdn.example${path}?id=7`)), {
        fetchImpl: mockFetch(() => upstream),
      });
      expect(response.headers.get('Content-Type'), `${type} ${path}`).toBe('application/vnd.apple.mpegurl');
      expect(await response.text()).toContain(
        `/?url=${encodeURIComponent('https://cdn.example/live/seg1.ts')}`,
      );
    }
  });

  it('accepts a BOM and whitespace before #EXTM3U, and a signature split across tiny chunks', async () => {
    const text = '\uFEFF \r\n\t#EXTM3U\n#EXT-X-TARGETDURATION:6\nseg.ts\n';
    const data = bytes(text);
    let offset = 0;
    const trickle = new ReadableStream({
      pull(controller) {
        if (offset >= data.byteLength) return controller.close();
        controller.enqueue(data.slice(offset, offset + 1)); // one byte at a time, BOM included
        offset += 1;
      },
    });
    const response = await handleRequest(relayRequest(viaQuery('https://cdn.example/live')), {
      fetchImpl: mockFetch(() => new Response(trickle, { headers: { 'Content-Type': 'text/plain' } })),
    });
    expect(response.headers.get('Content-Type')).toBe('application/vnd.apple.mpegurl');
    expect(await rawText(response)).toBe(
      `\uFEFF \r\n\t#EXTM3U\n#EXT-X-TARGETDURATION:6\n${viaQuery('https://cdn.example/seg.ts')}\n`,
    );
  });

  it('streams a non-playlist after peeking at its first chunk: endless TS at a .m3u8 path', async () => {
    const ts = String.fromCharCode(0x47) + 'ts-packet-1|';
    const source = controlledStream([ts]);
    const fetchImpl = mockFetch(
      () =>
        new Response(source.stream, {
          headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': '1000000' },
        }),
    );
    const response = await handleRequest(relayRequest(viaQuery('http://1.2.3.4:8080/live/ch.m3u8')), {
      fetchImpl,
    });
    // Answered while the upstream body is still open: only the first chunk was read.
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/octet-stream');
    expect(response.headers.get('Content-Length')).toBe('1000000'); // the bytes are passed on untouched
    const reader = response.body.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(ts);
    source.finish('ts-packet-2');
    expect(await readAll(reader)).toBe('ts-packet-2');
  });

  it('passes other bodies through as they are: no #EXTM3U, or only whitespace in 1 KB', async () => {
    const bodies = [
      '#EXT-X-TARGETDURATION:6\nseg.ts\n', // HLS tags but no #EXTM3U header: not a playlist
      '#extm3u\n#EXT-X-TARGETDURATION:6\nseg.ts\n',
      'WEBVTT\n\n00:00.000 --> 00:01.000\nhi\n',
      `${' '.repeat(1024)}#EXTM3U\n#EXT-X-TARGETDURATION:6\nseg.ts\n`,
      '',
      '\uFEFF',
    ];
    for (const body of bodies) {
      const response = await handleRequest(relayRequest(viaQuery('https://cdn.example/live.m3u8')), {
        fetchImpl: mpegurl(body),
      });
      expect(response.status).toBe(200);
      expect(await rawText(response), JSON.stringify(body.slice(0, 30))).toBe(body);
    }
  });

  it('does not peek at media or binary types (octet-stream without a playlist path)', async () => {
    for (const [type, path] of [
      ['video/mp2t', '/live/odd.m3u8'],
      ['audio/aac', '/radio.m3u'],
      ['image/png', '/logo.m3u8'],
      ['application/octet-stream', '/live/1.ts'],
    ]) {
      const source = controlledStream(['#EXTM3U\n#EXT-X-TARGETDURATION:6\nseg.ts\n']);
      const response = await handleRequest(relayRequest(viaQuery(`https://cdn.example${path}`)), {
        fetchImpl: mockFetch(() => new Response(source.stream, { headers: { 'Content-Type': type } })),
      });
      expect(response.headers.get('Content-Type'), type).toBe(type);
      const reader = response.body.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toBe(
        '#EXTM3U\n#EXT-X-TARGETDURATION:6\nseg.ts\n',
      );
      source.finish();
      expect(await readAll(reader)).toBe('');
    }
  });

  it('drops Content-Length on HEAD only where a GET could be rewritten', async () => {
    const head = (type, path) =>
      handleRequest(relayRequest(viaQuery(`https://cdn.example${path}`), { method: 'HEAD' }), {
        fetchImpl: mockFetch(
          () => new Response(null, { headers: { 'Content-Type': type, 'Content-Length': '321' } }),
        ),
      });
    expect((await head('application/vnd.apple.mpegurl', '/x')).headers.get('Content-Length')).toBeNull();
    expect((await head('text/plain', '/live/index.m3u8')).headers.get('Content-Length')).toBeNull();
    expect((await head('video/mp2t', '/live/index.m3u8')).headers.get('Content-Length')).toBe('321');
    expect((await head('video/mp4', '/movie.mp4')).headers.get('Content-Length')).toBe('321');
  });

  it('resolves relative URIs against the final URL after redirects', async () => {
    const fetchImpl = mockFetch((url) =>
      url === 'http://short.example/channel.m3u8'
        ? new Response(null, {
            status: 302,
            headers: { Location: 'https://edge7.cdn.example/session/abc/index.m3u8' },
          })
        : new Response('#EXTM3U\n#EXT-X-TARGETDURATION:6\nseg.ts\n/root.ts\n', {
            headers: { 'Content-Type': 'application/x-mpegURL' },
          }),
    );
    const response = await handleRequest(relayRequest(viaQuery('http://short.example/channel.m3u8')), {
      fetchImpl,
    });
    expect(response.headers.get('X-Relay-Final-Url')).toBe(
      'https://edge7.cdn.example/session/abc/index.m3u8',
    );
    expect(await response.text()).toBe(
      '#EXTM3U\n#EXT-X-TARGETDURATION:6\n' +
        `${viaQuery('https://edge7.cdn.example/session/abc/seg.ts')}\n` +
        `${viaQuery('https://edge7.cdn.example/root.ts')}\n`,
    );
  });

  it('returns IPTV channel lists byte-for-byte (no rewriting), without Content-Length', async () => {
    const list = new Uint8Array([
      ...bytes('#EXTM3U\n#EXTINF:-1 tvg-id="a" group-title="Caf'),
      0xe9, // windows-1252 "é": not valid UTF-8, must survive untouched
      ...bytes('",A\nhttp://1.2.3.4:8080/live/a.m3u8\n'),
    ]);
    const fetchImpl = mockFetch(
      () =>
        new Response(list, {
          headers: { 'Content-Type': 'audio/x-mpegurl', 'Content-Length': String(list.length) },
        }),
    );
    const response = await handleRequest(relayRequest(viaQuery('https://lists.example/index.m3u')), {
      fetchImpl,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('audio/x-mpegurl');
    expect(response.headers.get('Content-Length')).toBeNull();
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(list);
  });

  it('passes playlists over 8 MB through unmodified (declared or streamed)', async () => {
    const declared = await handleRequest(relayRequest(viaQuery('https://cdn.example/big.m3u8')), {
      fetchImpl: mpegurl(MEDIA, { 'Content-Length': String(9 * 1024 * 1024) }),
    });
    expect(declared.headers.get('Content-Length')).toBe(String(9 * 1024 * 1024));
    expect(await declared.text()).toBe(MEDIA);

    const big = `#EXTM3U\n#EXT-X-TARGETDURATION:6\n${'#EXTINF:6,\nsegment-000000.ts\n'.repeat(300000)}`;
    const data = bytes(big);
    expect(data.byteLength).toBeGreaterThan(8 * 1024 * 1024);
    let offset = 0;
    const stream = new ReadableStream({
      pull(controller) {
        if (offset >= data.byteLength) return controller.close();
        controller.enqueue(data.slice(offset, offset + 65536));
        offset += 65536;
      },
    });
    const streamed = await handleRequest(relayRequest(viaQuery('https://cdn.example/big.m3u8')), {
      fetchImpl: mockFetch(
        () => new Response(stream, { headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } }),
      ),
    });
    expect(streamed.headers.get('Content-Type')).toBe('application/vnd.apple.mpegurl');
    const out = new Uint8Array(await streamed.arrayBuffer());
    expect(out.byteLength).toBe(data.byteLength);
    expect(Buffer.from(out).equals(Buffer.from(data))).toBe(true);
  });

  it('does not forward Range to playlist paths (.m3u8 / .m3u) on any hop, so playlists come whole', async () => {
    const fetchImpl = vi.fn(async (url) =>
      url === 'https://cdn.example/ch/1'
        ? new Response(null, { status: 302, headers: { Location: '/live/index.M3U8?t=1' } })
        : new Response(MEDIA, { headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } }),
    );
    const response = await handleRequest(
      relayRequest(viaQuery('https://cdn.example/ch/1'), { headers: { Range: 'bytes=0-' } }),
      { fetchImpl },
    );
    expect(fetchImpl.mock.calls.map(([, init]) => init.headers.get('Range'))).toEqual(['bytes=0-', null]);
    expect(fetchImpl.mock.calls[1][1].headers.get('User-Agent')).toBe('VLC/3.0.20 LibVLC/3.0.20');
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(viaQuery('https://cdn.example/live/seg1.ts'));

    for (const [path, range] of [
      ['/a.m3u8', null],
      ['/b.m3u?x=1', null],
      ['/c.ts', 'bytes=0-1'],
      ['/d.mp4', 'bytes=0-1'],
    ]) {
      const media = mockFetch();
      const request = relayRequest(viaQuery(`https://cdn.example${path}`), { headers: { Range: 'bytes=0-1' } });
      await handleRequest(request, { fetchImpl: media });
      expect(media.mock.calls[0][1].headers.get('Range'), path).toBe(range);
    }
  });

  it('rewrites a 206 that holds the whole playlist (bytes 0-(n-1)/n), answering 200 without Content-Range', async () => {
    const n = MEDIA.length;
    for (const type of ['application/vnd.apple.mpegurl', 'text/plain', null]) {
      const whole = new Response(bytes(MEDIA), {
        status: 206,
        headers: { 'Content-Range': `bytes 0-${n - 1}/${n}`, 'Content-Length': String(n) },
      });
      if (type) whole.headers.set('Content-Type', type);
      const response = await handleRequest(
        relayRequest(viaQuery('https://cdn.example/live/play?id=1'), { headers: { Range: 'bytes=0-' } }),
        { fetchImpl: mockFetch(() => whole) },
      );
      expect(response.status, String(type)).toBe(200);
      expect(response.headers.get('Content-Range')).toBeNull();
      expect(response.headers.get('Content-Length')).toBeNull();
      expect(response.headers.get('Content-Type')).toBe('application/vnd.apple.mpegurl');
      expect(await response.text()).toContain(viaQuery('https://cdn.example/live/seg1.ts'));
    }

    // Partial ranges (and channel lists) are passed on as they are.
    for (const [range, body] of [
      [`bytes 0-9/${n}`, MEDIA.slice(0, 10)],
      [`bytes 0-${n - 1}/*`, MEDIA],
      [`bytes 0-${n - 1}/${n + 1}`, MEDIA],
      [`bytes 1-${n - 1}/${n}`, MEDIA.slice(1)],
    ]) {
      for (const type of ['application/vnd.apple.mpegurl', 'text/plain']) {
        const partial = new Response(body, {
          status: 206,
          headers: { 'Content-Range': range, 'Content-Type': type },
        });
        const response = await handleRequest(relayRequest(viaQuery('https://cdn.example/live/play')), {
          fetchImpl: mockFetch(() => partial),
        });
        const expected = type === 'text/plain' && !body.startsWith('#EXTM3U') ? 415 : 206;
        expect(response.status, `${type} ${range}`).toBe(expected);
        if (expected === 206) {
          expect(response.headers.get('Content-Range')).toBe(range);
          expect(await response.text()).toBe(body);
        }
      }
    }
    const list = '#EXTM3U\n#EXTINF:-1,A\nhttp://a.example/a.ts\n';
    const wholeList = new Response(list, {
      status: 206,
      headers: {
        'Content-Range': `bytes 0-${list.length - 1}/${list.length}`,
        'Content-Type': 'audio/x-mpegurl',
      },
    });
    const listed = await handleRequest(relayRequest(viaQuery('https://lists.example/all')), {
      fetchImpl: mockFetch(() => wholeList),
    });
    expect(listed.status).toBe(206);
    expect(listed.headers.get('Content-Range')).toBe(`bytes 0-${list.length - 1}/${list.length}`);
    expect(await listed.text()).toBe(list);
  });

  it('answers 502 when the playlist body breaks off while being read', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(bytes('#EXTM3U\n'));
        controller.error(new Error('connection reset'));
      },
    });
    const response = await handleRequest(relayRequest(viaQuery('https://cdn.example/live.m3u8')), {
      fetchImpl: mpegurl(stream),
    });
    expect(response.status).toBe(502);
  });
});

// ---------------------------------------------------------------------------------------------------------

describe('node-server options', () => {
  it('uses defaults, environment variables, and flags that win over them', () => {
    expect(parseOptions([], {})).toEqual({
      port: 8787,
      host: '127.0.0.1',
      allowedOrigins: ALLOWED_ORIGINS,
      publicUrl: '',
      allowPrivateTargets: false,
      help: false,
    });
    const env = {
      PORT: '9000',
      HOST: '0.0.0.0',
      ALLOWED_ORIGINS: ' https://Me.GitHub.io/ , http://localhost:5173,',
    };
    expect(parseOptions([], env)).toMatchObject({
      port: 9000,
      host: '0.0.0.0',
      allowedOrigins: ['https://me.github.io', 'http://localhost:5173'],
    });
    expect(
      parseOptions(['--port', '1234', '--host=::', '--public-url', 'https://relay.example.com/'], env),
    ).toMatchObject({
      port: 1234,
      host: '::',
      publicUrl: 'https://relay.example.com',
    });
    expect(parseOptions(['--help'], {}).help).toBe(true);
    expect(parseOptions([], { ALLOWED_ORIGINS: '*' }).allowedOrigins).toEqual(['*']);
  });

  it('allows private targets only with --allow-private or ALLOW_PRIVATE=1', () => {
    expect(parseOptions(['--allow-private'], {}).allowPrivateTargets).toBe(true);
    expect(parseOptions(['--port', '1', '--allow-private'], { ALLOW_PRIVATE: '0' }).allowPrivateTargets).toBe(
      true,
    );
    for (const value of ['1', 'true', 'YES', ' on ']) {
      expect(parseOptions([], { ALLOW_PRIVATE: value }).allowPrivateTargets, value).toBe(true);
    }
    for (const value of [undefined, '', '0', 'false', 'No', 'off']) {
      expect(parseOptions([], { ALLOW_PRIVATE: value }).allowPrivateTargets, value).toBe(false);
    }
  });

  it('rejects unknown options and invalid values', () => {
    expect(() => parseOptions(['--prot', '1'], {})).toThrow(/Unknown option/);
    expect(() => parseOptions(['--port'], {})).toThrow(/Missing value/);
    expect(() => parseOptions(['--port', 'abc'], {})).toThrow(/Invalid port/);
    expect(() => parseOptions([], { PORT: '70000' })).toThrow(/Invalid port/);
    expect(() => parseOptions([], { ALLOWED_ORIGINS: 'localhost:5173' })).toThrow(/Invalid origin/);
    expect(() => parseOptions(['--public-url', 'https://relay.example.com/sub'], {})).toThrow(/public URL/);
    expect(() => parseOptions(['--allow-private=1'], {})).toThrow(/takes no value/);
    expect(() => parseOptions([], { ALLOW_PRIVATE: 'maybe' })).toThrow(/Invalid ALLOW_PRIVATE/);
  });
});

describe('node-server (real sockets)', () => {
  const APP = 'http://app.test';
  /** Upstream routes, set per test: pathname → (req, res) handler. */
  const routes = new Map();
  let upstream;
  let relay;
  let upstreamBase;
  let relayBase;

  const listen = (server) =>
    new Promise((resolve) =>
      server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)),
    );
  const stop = (server) =>
    new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
  const get = (url, init = {}) => fetch(url, { ...init, headers: { Origin: APP, ...(init.headers || {}) } });

  beforeAll(async () => {
    upstream = http.createServer((req, res) => {
      const handler = routes.get(new URL(req.url, 'http://upstream').pathname);
      if (handler) return handler(req, res);
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('no such route');
    });
    upstreamBase = await listen(upstream);
    // The test upstream runs on 127.0.0.1, a private address.
    relay = createRelayServer({ allowedOrigins: [APP], allowPrivateTargets: true, onError: () => {} });
    relayBase = await listen(relay);
  });

  afterEach(() => routes.clear());

  afterAll(async () => {
    await Promise.all([stop(relay), stop(upstream)]);
  });

  it('serves the health check', async () => {
    const response = await get(`${relayBase}/?health`);
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe(APP);
    expect(await response.json()).toEqual({ ok: true, service: 'iptv-stream-relay', version: 1 });
  });

  it('streams media to the client before the upstream response has finished', async () => {
    let finishUpstream;
    routes.set('/live/stream.ts', (req, res) => {
      res.writeHead(200, { 'Content-Type': 'video/mp2t' });
      res.write('chunk-1|');
      finishUpstream = () => res.end('chunk-2');
    });
    const response = await get(viaQuery(`${upstreamBase}/live/stream.ts`, relayBase));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('video/mp2t');
    const reader = response.body.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('chunk-1|');
    finishUpstream();
    expect(await readAll(reader)).toBe('chunk-2');
  });

  it('aborts the upstream request when the client disconnects', async () => {
    let upstreamClosed;
    const closed = new Promise((resolve) => {
      upstreamClosed = resolve;
    });
    routes.set('/live/endless.ts', (req, res) => {
      res.writeHead(200, { 'Content-Type': 'video/mp2t' });
      res.write('first');
      res.on('close', () => upstreamClosed(res.writableFinished));
    });
    const controller = new AbortController();
    const response = await get(viaQuery(`${upstreamBase}/live/endless.ts`, relayBase), {
      signal: controller.signal,
    });
    const reader = response.body.getReader();
    await reader.read();
    controller.abort();
    await expect(
      Promise.race([closed, new Promise((r) => setTimeout(() => r('timeout'), 3000))]),
    ).resolves.toBe(false);
  });

  it('rewrites playlists with absolute relay URLs that work when followed', async () => {
    routes.set('/live/index.m3u8', (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      res.end('#EXTM3U\r\n#EXT-X-TARGETDURATION:6\r\n#EXTINF:6,\r\nseg1.ts?n=1\r\n');
    });
    routes.set('/live/seg1.ts', (req, res) => {
      res.writeHead(200, { 'Content-Type': 'video/mp2t' });
      res.end(`segment ${new URL(req.url, 'http://x').search} ua=${req.headers['user-agent']}`);
    });
    const playlist = await get(viaQuery(`${upstreamBase}/live/index.m3u8`, relayBase));
    const text = await playlist.text();
    const segmentUrl = viaQuery(`${upstreamBase}/live/seg1.ts?n=1`, relayBase);
    expect(text).toBe(`#EXTM3U\r\n#EXT-X-TARGETDURATION:6\r\n#EXTINF:6,\r\n${segmentUrl}\r\n`);
    const segment = await get(segmentUrl, { headers: { 'User-Agent': 'TestPlayer/1.0' } });
    expect(await segment.text()).toBe('segment ?n=1 ua=TestPlayer/1.0');

    const pathForm = await get(`${relayBase}/${upstreamBase}/live/index.m3u8`);
    expect(await pathForm.text()).toContain(`\r\n${relayBase}/${upstreamBase}/live/seg1.ts?n=1\r\n`);

    const forwarded = await get(viaQuery(`${upstreamBase}/live/index.m3u8`, relayBase), {
      headers: { 'X-Forwarded-Proto': 'https' },
    });
    expect(await forwarded.text()).toContain(`\r\n${relayBase.replace('http:', 'https:')}/?url=`);
  });

  it('passes Range requests and HEAD through, and refuses other methods', async () => {
    routes.set('/movie.mp4', (req, res) => {
      if (req.headers.range === 'bytes=2-5') {
        res.writeHead(206, {
          'Content-Type': 'video/mp4',
          'Content-Range': 'bytes 2-5/10',
          'Content-Length': '4',
        });
        return res.end('2345');
      }
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': '10', 'Accept-Ranges': 'bytes' });
      res.end(req.method === 'HEAD' ? undefined : '0123456789');
    });
    const target = viaQuery(`${upstreamBase}/movie.mp4`, relayBase);
    const partial = await get(target, { headers: { Range: 'bytes=2-5' } });
    expect(partial.status).toBe(206);
    expect(partial.headers.get('content-range')).toBe('bytes 2-5/10');
    expect(await partial.text()).toBe('2345');

    const head = await get(target, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe('10');

    const post = await get(target, { method: 'POST', body: 'x'.repeat(100000) });
    expect(post.status).toBe(405);
  });

  it('keeps a keep-alive connection usable after refusing a request with a large body', async () => {
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const send = (method, body) =>
      new Promise((resolve, reject) => {
        const { port } = new URL(relayBase);
        const headers = { Origin: APP };
        const req = http.request(
          { host: '127.0.0.1', port, path: '/?health', method, agent, headers },
          (res) => {
            res.resume();
            res.on('end', () => resolve({ status: res.statusCode, reused: req.reusedSocket }));
          },
        );
        req.on('error', reject);
        req.end(body);
      });
    try {
      expect(await send('POST', Buffer.alloc(1024 * 1024, 120))).toMatchObject({ status: 405 });
      expect(await send('GET')).toEqual({ status: 200, reused: true });
    } finally {
      agent.destroy();
    }
  });

  it('follows redirects with Node’s own fetch (real 3xx responses), up to 5', async () => {
    routes.set('/redir/start', (req, res) => {
      res.writeHead(302, { Location: 'next/index.m3u8?s=1' });
      res.end('moved');
    });
    routes.set('/redir/next/index.m3u8', (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' }); // a playlist with a generic type
      res.end('#EXTM3U\n#EXT-X-TARGETDURATION:6\nseg.ts\n');
    });
    for (let i = 0; i < 6; i++) {
      routes.set(`/loop/${i}`, (req, res) => {
        res.writeHead(307, { Location: `/loop/${i + 1}` });
        res.end();
      });
    }
    const playlist = await get(viaQuery(`${upstreamBase}/redir/start`, relayBase));
    expect(playlist.status).toBe(200);
    expect(playlist.headers.get('x-relay-final-url')).toBe(`${upstreamBase}/redir/next/index.m3u8?s=1`);
    expect(await playlist.text()).toBe(
      `#EXTM3U\n#EXT-X-TARGETDURATION:6\n${viaQuery(`${upstreamBase}/redir/next/seg.ts`, relayBase)}\n`,
    );
    const loop = await get(viaQuery(`${upstreamBase}/loop/0`, relayBase));
    expect(loop.status).toBe(508);
  });

  it('without allowPrivateTargets, a local Host or X-Forwarded-For unlocks no private target', async () => {
    const fetchImpl = vi.fn(async () => new Response('media'));
    const server = createRelayServer({ allowedOrigins: [APP], fetchImpl, onError: () => {} });
    const base = await listen(server);
    const send = (headers) =>
      new Promise((resolve, reject) => {
        const path = `/?url=${encodeURIComponent(`${upstreamBase}/live/a.ts`)}`;
        const { port } = new URL(base);
        const options = { host: '127.0.0.1', port, path, headers: { Origin: APP, ...headers } };
        const req = http.request(options, (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => (body += chunk));
          res.on('end', () => resolve({ status: res.statusCode, body }));
        });
        req.on('error', reject);
        req.end();
      });
    try {
      for (const headers of [
        {},
        { Host: 'localhost:8787' },
        { Host: '127.0.0.1', 'X-Forwarded-For': '127.0.0.1', 'X-Real-IP': '10.0.0.1' },
        { Host: '[::1]:8787', Forwarded: 'for=127.0.0.1;proto=http' },
      ]) {
        expect(await send(headers), JSON.stringify(headers)).toEqual({
          status: 403,
          body: 'Target not allowed',
        });
      }
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      await stop(server);
    }
  });

  it('with a public URL: rewrites to it; private targets stay refused', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response('#EXTM3U\n#EXT-X-TARGETDURATION:6\nseg.ts\n', {
          headers: { 'Content-Type': 'application/x-mpegurl' },
        }),
    );
    const server = createRelayServer({
      allowedOrigins: [APP],
      publicUrl: 'https://relay.example.com',
      fetchImpl,
      resolveHost: async () => ['93.184.216.34'],
      onError: () => {},
    });
    const base = await listen(server);
    try {
      const response = await get(viaQuery('https://cdn.example/live.m3u8', base));
      const segment = viaQuery('https://cdn.example/seg.ts', 'https://relay.example.com');
      expect(await response.text()).toBe(`#EXTM3U\n#EXT-X-TARGETDURATION:6\n${segment}\n`);
      const privateTarget = await get(viaQuery(`${upstreamBase}/live/index.m3u8`, base));
      expect(privateTarget.status).toBe(403);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      await stop(server);
    }
  });

  it('looks up host names with node:dns and refuses names of private addresses (by default)', async () => {
    const loopback = await resolveHost('localhost');
    expect(loopback.length).toBeGreaterThan(0);
    expect(loopback.every((address) => isPrivateHost(address)), String(loopback)).toBe(true);
    await expect(resolveHost('relay-test.invalid')).rejects.toThrow();

    const fetchImpl = vi.fn(async () => new Response('media', { headers: { 'Content-Type': 'video/mp2t' } }));
    const servers = [
      createRelayServer({ allowedOrigins: [APP], fetchImpl, onError: () => {} }),
      createRelayServer({ allowedOrigins: [APP], fetchImpl, resolveHost: async () => ['8.8.8.8', '10.1.2.3'] }),
    ];
    const [plain, custom] = await Promise.all(servers.map(listen));
    try {
      const unresolvable = await get(viaQuery('http://relay-test.invalid/a.ts', plain));
      expect(unresolvable.status).toBe(502); // the default resolver ran: fetch() was never reached
      expect(await unresolvable.text()).toBe('Upstream unreachable');
      const refused = await get(viaQuery('http://tv.example/a.ts', custom));
      expect(refused.status).toBe(403);
      expect(await refused.text()).toBe('Target not allowed');
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      await Promise.all(servers.map(stop));
    }
  });

  it('runs from the command line (node proxy/node-server.mjs --port 0)', async () => {
    routes.set('/cli/index.m3u8', (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      res.end('#EXTM3U\n#EXT-X-TARGETDURATION:6\na.ts\n');
    });
    const env = { ...process.env, ALLOWED_ORIGINS: APP };
    delete env.PUBLIC_URL;
    delete env.ALLOW_PRIVATE;
    const args = [NODE_SERVER_PATH, '--port', '0', '--host', '127.0.0.1', '--allow-private'];
    const child = spawn(process.execPath, args, { env });
    let output = '';
    try {
      const base = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`relay did not start: ${output}`)), 5000);
        child.stdout.on('data', (chunk) => {
          output += chunk;
          const match = /listening on (http:\/\/127\.0\.0\.1:\d+)[\s\S]*Press Ctrl\+C/.exec(output);
          if (match) {
            clearTimeout(timer);
            resolve(match[1]);
          }
        });
        child.on('exit', (code) => reject(new Error(`relay exited with ${code}: ${output}`)));
      });
      expect((await get(`${base}/`)).status).toBe(200);
      expect(output).toMatch(/--allow-private lets callers reach localhost/);
      const playlist = await get(viaQuery(`${upstreamBase}/cli/index.m3u8`, base));
      expect(await playlist.text()).toBe(
        `#EXTM3U\n#EXT-X-TARGETDURATION:6\n${viaQuery(`${upstreamBase}/cli/a.ts`, base)}\n`,
      );
      expect((await fetch(`${base}/?url=x`, { headers: { Origin: 'https://evil.example' } })).status).toBe(
        403,
      );
    } finally {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGTERM');
      await exited;
    }
  });

  it('prints usage for --help and fails clearly on bad options', () => {
    const help = spawnSync(process.execPath, [NODE_SERVER_PATH, '--help'], { encoding: 'utf8' });
    expect(help.status).toBe(0);
    expect(help.stdout).toMatch(/Usage: node proxy\/node-server\.mjs/);
    const bad = spawnSync(process.execPath, [NODE_SERVER_PATH, '--port', 'nope'], { encoding: 'utf8' });
    expect(bad.status).toBe(2);
    expect(bad.stderr).toMatch(/Invalid port: nope/);
  });
});

describe('platforms without DNS lookups', () => {
  it('relays a host name unchecked when the resolver reports lookups as unavailable (null)', async () => {
    const fetchImpl = mockFetch();
    const response = await handleRequest(relayRequest(viaQuery('https://cdn.example/a.ts')), {
      allowedOrigins: [APP_ORIGIN],
      fetchImpl,
      resolveHost: async () => null,
    });
    expect(response.status).toBe(200);
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual(['https://cdn.example/a.ts']);
  });

  it('proxy/deno.js keeps relaying when Deno Deploy refuses DNS lookups, and stops asking', async () => {
    vi.resetModules();
    const serve = vi.fn();
    const denied = Object.assign(new Error('Requires net access'), { name: 'PermissionDenied' });
    const resolveDns = vi.fn(async () => {
      throw denied;
    });
    const fetchImpl = mockFetch();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('Deno', { serve, resolveDns });
    vi.stubGlobal('fetch', fetchImpl);
    try {
      await import('../proxy/deno.js');
      const handler = serve.mock.calls[0][0];
      for (const path of ['a.ts', 'b.ts']) {
        const response = await handler(relayRequest(viaQuery(`https://cdn.example/${path}`)));
        expect(response.status, path).toBe(200);
      }
      expect(resolveDns).toHaveBeenCalledTimes(2); // A + AAAA for the first request only
      expect(warn).toHaveBeenCalledTimes(1);
      // Literal private targets are still refused without DNS.
      expect((await handler(relayRequest(viaQuery('http://10.0.0.1/a.ts')))).status).toBe(403);
    } finally {
      warn.mockRestore();
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });
});
