import { describe, expect, it } from 'vitest';
import {
  groupChannels,
  isHlsManifest,
  looksLikeM3U,
  makeChannelId,
  parseM3U,
  serializeM3U,
} from '../src/lib/m3u.js';
import { hashString } from '../src/lib/utils.js';
import { UNCATEGORIZED } from '../src/app/constants.js';

/** Join lines with LF (tests that care about line endings build their own strings). */
const m3u = (...lines) => lines.join('\n');

const CHANNEL_KEYS = [
  'attrs',
  'chno',
  'drm',
  'duration',
  'group',
  'groups',
  'headers',
  'id',
  'index',
  'logo',
  'name',
  'tvgId',
  'tvgName',
  'url',
].sort();

/** Asserts the full Channel shape from the spec's data model. */
function expectChannelShape(ch, index) {
  expect(Object.keys(ch).sort()).toEqual(CHANNEL_KEYS);
  expect(typeof ch.id).toBe('string');
  expect(ch.id.length).toBeGreaterThan(0);
  expect(ch.index).toBe(index);
  expect(typeof ch.name).toBe('string');
  expect(ch.name.trim()).toBe(ch.name);
  expect(ch.name.length).toBeGreaterThan(0);
  expect(typeof ch.url).toBe('string');
  expect(Array.isArray(ch.groups)).toBe(true);
  expect(ch.groups.length).toBeGreaterThan(0);
  expect(ch.group).toBe(ch.groups[0]);
  expect(typeof ch.logo).toBe('string');
  expect(typeof ch.tvgId).toBe('string');
  expect(typeof ch.tvgName).toBe('string');
  expect(ch.chno === null || Number.isInteger(ch.chno)).toBe(true);
  expect(typeof ch.duration).toBe('number');
  expect(ch.attrs && typeof ch.attrs).toBe('object');
  expect(ch.headers && typeof ch.headers).toBe('object');
  expect(typeof ch.drm).toBe('boolean');
}

describe('parseM3U — structure', () => {
  it('parses a typical extended playlist into fully-shaped channels', () => {
    const { channels, meta, warnings } = parseM3U(
      m3u(
        '#EXTM3U',
        '#EXTINF:-1 tvg-id="bbc1.uk" tvg-name="BBC One" tvg-logo="https://img.example/bbc1.png" ' +
          'group-title="UK",BBC One HD',
        'https://streams.example/bbc1/index.m3u8',
        '#EXTINF:-1 tvg-id="cnn.us" group-title="News",CNN',
        'http://streams.example/cnn.m3u8',
        'https://streams.example/plain/news24.m3u8',
      ),
    );
    expect(warnings).toEqual([]);
    expect(meta).toEqual({ title: '', epgUrl: '', attrs: {}, isHlsManifest: false });
    expect(channels).toHaveLength(3);
    channels.forEach((ch, i) => expectChannelShape(ch, i));

    const [bbc, cnn, plain] = channels;
    expect(bbc).toMatchObject({
      name: 'BBC One HD',
      url: 'https://streams.example/bbc1/index.m3u8',
      group: 'UK',
      groups: ['UK'],
      logo: 'https://img.example/bbc1.png',
      tvgId: 'bbc1.uk',
      tvgName: 'BBC One',
      chno: null,
      duration: -1,
      headers: {},
      drm: false,
    });
    expect(bbc.attrs).toEqual({
      'tvg-id': 'bbc1.uk',
      'tvg-name': 'BBC One',
      'tvg-logo': 'https://img.example/bbc1.png',
      'group-title': 'UK',
    });
    expect(bbc.id).toBe(makeChannelId('BBC One HD', 'https://streams.example/bbc1/index.m3u8'));
    expect(cnn).toMatchObject({ name: 'CNN', group: 'News', tvgId: 'cnn.us', logo: '' });
    // A bare URL line without #EXTINF still becomes a channel, named from the URL.
    expect(plain).toMatchObject({ name: 'news24', group: UNCATEGORIZED, groups: [UNCATEGORIZED], attrs: {} });
    expect('playlistId' in plain).toBe(false);
  });

  it('strips a BOM and handles CRLF, CR-only and mixed line endings with padded lines', () => {
    const lines = [
      '#EXTM3U',
      '  #EXTINF:-1 group-title="A",One  ',
      '\thttp://a.example/1.m3u8\t',
      '',
      '#EXTINF:-1,Two',
      'http://a.example/2.m3u8',
      '#EXTINF:-1,Three',
      'http://a.example/3.m3u8',
    ];
    const crlf = `\uFEFF${lines.join('\r\n')}\r\n`;
    const cr = `\uFEFF${lines.join('\r')}`;
    const mixed = `\uFEFF${lines.slice(0, 3).join('\r\n')}\n${lines.slice(3, 6).join('\r')}\n${lines.slice(6).join('\n')}`;
    for (const text of [crlf, cr, mixed]) {
      const { channels, warnings } = parseM3U(text);
      expect(warnings).toEqual([]);
      expect(channels.map((c) => c.name)).toEqual(['One', 'Two', 'Three']);
      expect(channels.map((c) => c.url)).toEqual([
        'http://a.example/1.m3u8',
        'http://a.example/2.m3u8',
        'http://a.example/3.m3u8',
      ]);
      expect(channels[0].group).toBe('A');
    }
  });

  it('returns an empty result for empty or non-string input', () => {
    for (const input of ['', '   \n\n', '#EXTM3U', null, undefined, 42, {}]) {
      const result = parseM3U(input);
      expect(result.channels).toEqual([]);
      expect(result.meta.isHlsManifest).toBe(false);
    }
  });
});

describe('parseM3U — header', () => {
  it('reads the EPG url from x-tvg-url / url-tvg / tvg-url (first of a comma-separated list) and #PLAYLIST', () => {
    const a = parseM3U(
      m3u(
        '#EXTM3U X-TVG-URL="https://epg.example/a.xml.gz, https://epg.example/b.xml" tvg-shift=2',
        '#PLAYLIST:My  &amp; Playlist',
        '#PLAYLIST:Ignored second title',
        'http://s.example/1.m3u8',
      ),
    );
    expect(a.meta.epgUrl).toBe('https://epg.example/a.xml.gz');
    expect(a.meta.title).toBe('My & Playlist');
    expect(a.meta.attrs).toEqual({
      'x-tvg-url': 'https://epg.example/a.xml.gz, https://epg.example/b.xml',
      'tvg-shift': '2',
    });

    expect(parseM3U('#EXTM3U url-tvg="http://epg.example/guide.xml"\nhttp://s/1').meta.epgUrl).toBe(
      'http://epg.example/guide.xml',
    );
    expect(parseM3U("#EXTM3U tvg-url='https://epg.example/t.xml'\nhttp://s/1").meta.epgUrl).toBe(
      'https://epg.example/t.xml',
    );
    // Unusable values are skipped in favor of the next candidate; relative ones resolve against baseUrl.
    expect(
      parseM3U('#EXTM3U x-tvg-url="javascript:alert(1)" url-tvg="https://epg.example/ok.xml"\nhttp://s/1').meta
        .epgUrl,
    ).toBe('https://epg.example/ok.xml');
    expect(
      parseM3U('#EXTM3U x-tvg-url="guide.xml"\nhttp://s/1', { baseUrl: 'https://lists.example/tv/all.m3u' }).meta
        .epgUrl,
    ).toBe('https://lists.example/tv/guide.xml');
    expect(parseM3U('#EXTM3U\nhttp://s/1').meta.epgUrl).toBe('');
  });
});

describe('parseM3U — #EXTINF attribute scanner', () => {
  it('keeps commas, spaces and "=" inside quoted values; the title starts after the first comma outside quotes', () => {
    const { channels } = parseM3U(
      m3u(
        '#EXTM3U',
        '#EXTINF:-1 tvg-name="News, Weather & Sport" group-title="News, Info" ' +
          'catchup-source="?utc={utc}&lutc={lutc}" tvg-id="a=b",Live: News, Weather & Sport',
        'http://s.example/news.m3u8',
      ),
    );
    const [ch] = channels;
    expect(ch.name).toBe('Live: News, Weather & Sport');
    expect(ch.tvgName).toBe('News, Weather & Sport');
    expect(ch.groups).toEqual(['News, Info']);
    expect(ch.tvgId).toBe('a=b');
    expect(ch.attrs['catchup-source']).toBe('?utc={utc}&lutc={lutc}');
  });

  it("supports single-quoted and unquoted values, case-insensitive keys and spaces around '='", () => {
    const { channels } = parseM3U(
      m3u(
        '#EXTM3U',
        "#EXTINF:-1 TVG-ID=abc.us Group-Title='Rock \"n\" Roll' tvg-chno = 7 tvg-logo= \"https://l.example/a.png\"" +
          ',Rock Channel',
        'http://s.example/rock.m3u8',
      ),
    );
    const [ch] = channels;
    expect(ch.tvgId).toBe('abc.us');
    expect(ch.groups).toEqual(['Rock "n" Roll']);
    expect(ch.chno).toBe(7);
    expect(ch.logo).toBe('https://l.example/a.png');
    expect(ch.name).toBe('Rock Channel');
    expect(Object.keys(ch.attrs)).toEqual(['tvg-id', 'group-title', 'tvg-chno', 'tvg-logo']);
  });

  it('treats an empty unquoted value followed by another attribute as empty', () => {
    const { channels } = parseM3U(
      m3u('#EXTINF:-1 tvg-name= tvg-id="next" group-title=,Title', 'http://s.example/1'),
    );
    const [ch] = channels;
    expect(ch.attrs).toEqual({ 'tvg-name': '', 'tvg-id': 'next', 'group-title': '' });
    expect(ch).toMatchObject({ name: 'Title', tvgName: '', tvgId: 'next', group: UNCATEGORIZED });
  });

  it('tolerates a missing or glued duration, extra spaces and parses numeric durations', () => {
    const { channels } = parseM3U(
      m3u(
        '#EXTINF:,No Duration',
        'http://s.example/1',
        '#EXTINF:tvg-id="x1" group-title="G",Attributes First',
        'http://s.example/2',
        '#EXTINF:   120.5    tvg-id="x2"   ,   Spaced Out   ',
        'http://s.example/3',
        '#EXTINF:-1tvg-id="glued",Glued',
        'http://s.example/4',
        '#extinf:0,Lower Case Tag',
        'http://s.example/5',
      ),
    );
    expect(channels.map((c) => c.name)).toEqual([
      'No Duration',
      'Attributes First',
      'Spaced Out',
      'Glued',
      'Lower Case Tag',
    ]);
    expect(channels.map((c) => c.duration)).toEqual([-1, -1, 120.5, -1, 0]);
    expect(channels[1]).toMatchObject({ tvgId: 'x1', group: 'G' });
    expect(channels[2].tvgId).toBe('x2');
    expect(channels[3].tvgId).toBe('glued');
    expect(channels[3].attrs).toEqual({ 'tvg-id': 'glued' });
  });

  it('tolerates a missing comma and a tvg-name without a title', () => {
    const { channels } = parseM3U(
      m3u(
        '#EXTINF:-1 tvg-id="x" group-title="Movies" Channel Without Comma',
        'http://s.example/1',
        '#EXTINF:-1 tvg-name="Name From Tvg" tvg-id="y"',
        'http://s.example/2',
        '#EXTINF:-1 tvg-name="Comma, Inside Quotes"',
        'http://s.example/3',
        '#EXTINF:-1 tvg-name="Fallback",   ',
        'http://s.example/4',
      ),
    );
    expect(channels.map((c) => c.name)).toEqual([
      'Channel Without Comma',
      'Name From Tvg',
      'Comma, Inside Quotes',
      'Fallback',
    ]);
    expect(channels[0].group).toBe('Movies');
    expect(channels[1].tvgName).toBe('Name From Tvg');
  });

  it('keeps the first non-empty value of a repeated key and ignores prototype keys', () => {
    const { channels } = parseM3U(
      m3u(
        '#EXTINF:-1 tvg-id="" tvg-id="second" tvg-id="third" __proto__="x" constructor="c",T',
        'http://s.example/1',
      ),
    );
    const [ch] = channels;
    expect(ch.tvgId).toBe('second');
    expect(Object.getPrototypeOf(ch.attrs)).toBe(Object.prototype);
    expect(Object.keys(ch.attrs)).toEqual(['tvg-id', 'constructor']);
    expect(ch.attrs.constructor).toBe('c');
  });

  it('decodes common HTML entities in titles as plain text (no double decoding)', () => {
    const { channels } = parseM3U(
      m3u(
        '#EXTINF:-1 tvg-name="Tom &amp; Jerry" group-title="Kids &amp; Family",' +
          'Tom &amp; Jerry &quot;Classic&quot; &#39;HD&#39; &lt;b&gt; &#x41;&#66; &amp;lt; &unknown; &',
        'http://s.example/1',
        '#EXTINF:-1,&lt;script&gt;alert(1)&lt;/script&gt;',
        'http://s.example/2',
      ),
    );
    expect(channels[0].name).toBe('Tom & Jerry "Classic" \'HD\' <b> AB &lt; &unknown; &');
    expect(channels[0].tvgName).toBe('Tom & Jerry');
    expect(channels[0].groups).toEqual(['Kids & Family']);
    // Decoded markup stays a literal string — the parser never builds DOM.
    expect(channels[1].name).toBe('<script>alert(1)</script>');
  });

  it('collapses control characters / whitespace runs in names and caps hostile lengths', () => {
    const longTitle = `${'A'.repeat(5000)} tail`;
    const { channels } = parseM3U(
      m3u('#EXTINF:-1,Multi \t  Space\u0000Name', 'http://s/1', `#EXTINF:-1,${longTitle}`, 'http://s/2'),
    );
    expect(channels[0].name).toBe('Multi Space Name');
    expect(channels[1].name.length).toBeLessThanOrEqual(300);
    expect(channels[1].name.startsWith('AAAA')).toBe(true);
  });
});

describe('parseM3U — names, groups and logos', () => {
  it('derives a name from the URL, else the hostname, else "Channel N"', () => {
    const { channels } = parseM3U(
      m3u(
        'https://cdn.example/channels/Sky%20News.m3u8?token=1',
        'https://cdn.example/euronews/index.m3u8',
        'https://cdn.example/',
        'udp://@239.0.0.1:1234',
      ),
    );
    expect(channels.map((c) => c.name)).toEqual(['Sky News', 'euronews', 'cdn.example', '239.0.0.1']);
    channels.forEach((ch, i) => expectChannelShape(ch, i));
  });

  it("splits group-title on ';' (trimmed, non-empty, deduped) and sets group = groups[0]", () => {
    const { channels } = parseM3U(
      m3u(
        '#EXTINF:-1 group-title="News; World ;; News ;Sports;",Multi',
        'http://s/1',
        '#EXTINF:-1 group-title=" ; ",Blank Groups',
        'http://s/2',
        '#EXTINF:-1 group-title="News; World ;; News ;Sports;",Same Raw Value',
        'http://s/3',
      ),
    );
    expect(channels[0].groups).toEqual(['News', 'World', 'Sports']);
    expect(channels[0].group).toBe('News');
    expect(channels[1].groups).toEqual([UNCATEGORIZED]);
    expect(channels[1].group).toBe(UNCATEGORIZED);
    expect(channels[2].groups).toEqual(['News', 'World', 'Sports']);
  });

  it('uses #EXTGRP when there is no group-title, otherwise group-title wins; default is Uncategorized', () => {
    const { channels } = parseM3U(
      m3u(
        '#EXTINF:-1,From Extgrp',
        '#EXTGRP:Movies; Classics',
        'http://s/1',
        '#EXTGRP:Ignored',
        '#EXTINF:-1 group-title="Sports",Title Wins',
        'http://s/2',
        '#EXTINF:-1,No Group',
        'http://s/3',
      ),
    );
    // #EXTGRP names a single group (no ';' splitting).
    expect(channels[0].groups).toEqual(['Movies; Classics']);
    expect(channels[1].groups).toEqual(['Sports']);
    expect(channels[2].groups).toEqual([UNCATEGORIZED]);
  });

  it('takes the logo from tvg-logo, then logo, then #EXTIMG — only safe image URLs', () => {
    const { channels } = parseM3U(
      m3u(
        '#EXTINF:-1 tvg-logo="https://l.example/a.png?w=1&amp;h=2",A',
        'http://s/1',
        '#EXTINF:-1 tvg-logo="" logo="https://l.example/b.png",B',
        'http://s/2',
        '#EXTINF:-1,C',
        '#EXTIMG:https://l.example/c.jpg',
        'http://s/3',
        '#EXTINF:-1 tvg-logo="javascript:alert(1)",D',
        'http://s/4',
        '#EXTINF:-1 tvg-logo="logos/e.png",E',
        'http://s/5',
        '#EXTINF:-1 tvg-logo="data:image/png;base64,iVBORw0KGgo=",F',
        'http://s/6',
        '#EXTINF:-1 tvg-logo="N/A",G',
        'http://s/7',
      ),
      { baseUrl: 'https://lists.example/tv/list.m3u' },
    );
    expect(channels.map((c) => c.logo)).toEqual([
      'https://l.example/a.png?w=1&h=2',
      'https://l.example/b.png',
      'https://l.example/c.jpg',
      '',
      'https://lists.example/tv/logos/e.png',
      'data:image/png;base64,iVBORw0KGgo=',
      '',
    ]);
  });

  it('reads chno from tvg-chno, channel-number or tvg-num (integers only)', () => {
    const { channels } = parseM3U(
      m3u(
        '#EXTINF:-1 tvg-chno="101",A',
        'http://s/1',
        '#EXTINF:-1 channel-number="7",B',
        'http://s/2',
        '#EXTINF:-1 tvg-num="0042",C',
        'http://s/3',
        '#EXTINF:-1 tvg-chno="n/a",D',
        'http://s/4',
        '#EXTINF:-1 tvg-chno="abc" channel-number="12",E',
        'http://s/5',
        '#EXTINF:-1,F',
        'http://s/6',
      ),
    );
    expect(channels.map((c) => c.chno)).toEqual([101, 7, 42, null, 12, null]);
  });
});

describe('parseM3U — directives and headers', () => {
  it('maps #EXTVLCOPT user agent / referrer / origin to headers for the next URL only', () => {
    const { channels } = parseM3U(
      m3u(
        '#EXTINF:-1,A',
        '#EXTVLCOPT:http-user-agent="Mozilla/5.0 (Smart TV)"',
        '#EXTVLCOPT:http-referrer=https://ref.example/page?x=1',
        '#EXTVLCOPT:http-origin=https://origin.example',
        '#EXTVLCOPT:network-caching=1000',
        'http://s/1',
        '#EXTINF:-1,B',
        '#EXTVLCOPT:HTTP-REFERER=https://other.example/',
        'http://s/2',
        '#EXTINF:-1,C',
        'http://s/3',
      ),
    );
    expect(channels[0].headers).toEqual({
      userAgent: 'Mozilla/5.0 (Smart TV)',
      referrer: 'https://ref.example/page?x=1',
      origin: 'https://origin.example',
    });
    expect(channels[1].headers).toEqual({ referrer: 'https://other.example/' });
    expect(channels[2].headers).toEqual({});
  });

  it('flags #KODIPROP license_type / license_key as DRM (next URL only) and warns once', () => {
    const { channels, warnings } = parseM3U(
      m3u(
        '#EXTINF:-1,Widevine',
        '#KODIPROP:inputstream.adaptive.manifest_type=mpd',
        '#KODIPROP:inputstream.adaptive.license_type=com.widevine.alpha',
        'https://s.example/w.mpd',
        '#EXTINF:-1,ClearKey',
        '#KODIPROP:inputstream.adaptive.license_key=https://keys.example/k',
        'https://s.example/c.mpd',
        '#EXTINF:-1,Free',
        '#KODIPROP:inputstream=inputstream.adaptive',
        '#KODIPROP:inputstream.adaptive.stream_headers=User-Agent=Kodi%2F20&Referer=https%3A%2F%2Fr.example%2F',
        'https://s.example/free.m3u8',
      ),
    );
    expect(channels.map((c) => c.drm)).toEqual([true, true, false]);
    expect(channels[2].headers).toEqual({ userAgent: 'Kodi/20', referrer: 'https://r.example/' });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/2 channels are DRM-protected/);
  });

  it('strips Kodi pipe headers from the URL and URL-decodes them (pipe headers win)', () => {
    const { channels } = parseM3U(
      m3u(
        '#EXTINF:-1,Piped',
        '#EXTVLCOPT:http-user-agent=FromVlcOpt',
        'http://x.example/y.m3u8|User-Agent=Foo%20Bar%2F1.0&Referer=http://r.example/&ORIGIN=https%3A%2F%2Fo.example' +
          '&X-Custom=1',
        '#EXTINF:-1,Piped lower',
        'https://x.example/z.m3u8|user-agent=lower&referrer=https%3A%2F%2Fref.example',
      ),
    );
    expect(channels[0].url).toBe('http://x.example/y.m3u8');
    expect(channels[0].headers).toEqual({
      userAgent: 'Foo Bar/1.0',
      referrer: 'http://r.example/',
      origin: 'https://o.example',
    });
    expect(channels[1].url).toBe('https://x.example/z.m3u8');
    expect(channels[1].headers).toEqual({ userAgent: 'lower', referrer: 'https://ref.example' });
  });

  it('accepts URL lines wrapped in quotes', () => {
    const { channels, warnings } = parseM3U(
      m3u(
        '#EXTINF:-1,Double',
        '"https://q.example/double.m3u8"',
        '#EXTINF:-1,Single',
        "'https://q.example/single.m3u8|User-Agent=Quoted'",
      ),
      { baseUrl: 'https://lists.example/a.m3u' },
    );
    expect(warnings).toEqual([]);
    expect(channels.map((c) => c.url)).toEqual(['https://q.example/double.m3u8', 'https://q.example/single.m3u8']);
    expect(channels[1].headers).toEqual({ userAgent: 'Quoted' });
  });

  it('reads #EXTHTTP JSON headers and ignores malformed JSON', () => {
    const { channels } = parseM3U(
      m3u(
        '#EXTINF:-1,A',
        '#EXTHTTP:{"User-Agent":"Json UA","Referer":"https://json.example/","Cookie":"x"}',
        'http://s/1',
        '#EXTINF:-1,B',
        '#EXTHTTP:{not json',
        'http://s/2',
      ),
    );
    expect(channels[0].headers).toEqual({ userAgent: 'Json UA', referrer: 'https://json.example/' });
    expect(channels[1].headers).toEqual({});
  });

  it('applies #EXTGRP / #EXTIMG / headers / DRM to the next URL only', () => {
    const { channels } = parseM3U(
      m3u(
        '#EXTGRP:Pending Group',
        '#EXTIMG:https://l.example/p.png',
        '#EXTVLCOPT:http-user-agent=UA',
        '#KODIPROP:inputstream.adaptive.license_type=clearkey',
        'http://s/first',
        'http://s/second',
      ),
    );
    expect(channels[0]).toMatchObject({
      group: 'Pending Group',
      logo: 'https://l.example/p.png',
      headers: { userAgent: 'UA' },
      drm: true,
    });
    expect(channels[1]).toMatchObject({ group: UNCATEGORIZED, logo: '', headers: {}, drm: false });
  });
});

describe('parseM3U — URLs, ids and warnings', () => {
  it('resolves relative and protocol-relative URLs against a valid baseUrl', () => {
    const text = m3u(
      '#EXTINF:-1,Rel',
      'streams/one.m3u8',
      '#EXTINF:-1,Up',
      '../two.m3u8',
      '#EXTINF:-1,Root',
      '/live/three.m3u8',
      '#EXTINF:-1,Proto',
      '//cdn.example/four.m3u8',
      '#EXTINF:-1,Upper Scheme',
      'HTTPS://CDN.Example/Five.m3u8',
    );
    const { channels, warnings } = parseM3U(text, { baseUrl: 'http://lists.example/tv/all.m3u' });
    expect(warnings).toEqual([]);
    expect(channels.map((c) => c.url)).toEqual([
      'http://lists.example/tv/streams/one.m3u8',
      'http://lists.example/two.m3u8',
      'http://lists.example/live/three.m3u8',
      'http://cdn.example/four.m3u8',
      'https://cdn.example/Five.m3u8',
    ]);
  });

  it('skips relative URLs without (or with an invalid) baseUrl, with one summary warning', () => {
    const text = m3u('#EXTINF:-1,Rel', 'streams/one.m3u8', '#EXTINF:-1,Abs', 'http://s.example/abs.m3u8');
    for (const baseUrl of [undefined, 'not a url', 'file:///home/me/list.m3u']) {
      const { channels, warnings } = parseM3U(text, { baseUrl });
      expect(channels.map((c) => c.name)).toEqual(['Abs']);
      expect(channels[0].index).toBe(0);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/1 relative link/);
    }
    // Protocol-relative links still work without a base (https is assumed).
    expect(parseM3U('//cdn.example/x.m3u8').channels[0].url).toBe('https://cdn.example/x.m3u8');
  });

  it('suffixes duplicate ids with ~2, ~3… in order and uses makeChannelId(name, url)', () => {
    const { channels } = parseM3U(
      m3u(
        '#EXTINF:-1,Same',
        'http://s/a',
        '#EXTINF:-1,Same',
        'http://s/a',
        '#EXTINF:-1,Other',
        'http://s/a',
        '#EXTINF:-1,Same',
        'http://s/a',
      ),
    );
    const base = makeChannelId('Same', 'http://s/a');
    expect(channels.map((c) => c.id)).toEqual([base, `${base}~2`, makeChannelId('Other', 'http://s/a'), `${base}~3`]);
    expect(new Set(channels.map((c) => c.id)).size).toBe(4);
    // Stable across parses (favorites survive reloads).
    expect(parseM3U('#EXTINF:-1,Same\nhttp://s/a').channels[0].id).toBe(base);
  });

  it('makeChannelId is hashString(name + "\\n" + url)', () => {
    expect(makeChannelId('BBC One', 'https://s/1.m3u8')).toBe(hashString('BBC One\nhttps://s/1.m3u8'));
    expect(makeChannelId('a', 'b')).not.toBe(makeChannelId('a', 'c'));
    expect(makeChannelId('a\nb', 'c')).toBe(makeChannelId('a', 'b\nc')); // documented hash input
  });

  it('keeps rtmp/rtsp/udp/rtp/mms channels with ONE summary warning naming the count', () => {
    const { channels, warnings } = parseM3U(
      m3u(
        '#EXTINF:-1,RTMP',
        'rtmp://live.example/app/stream',
        '#EXTINF:-1,RTSP',
        'rtsp://cam.example:554/feed',
        '#EXTINF:-1,UDP',
        'udp://@239.1.1.1:5000',
        '#EXTINF:-1,RTP',
        'rtp://239.1.1.2:5004',
        '#EXTINF:-1,MMS',
        'mms://media.example/live',
        '#EXTINF:-1,OK',
        'https://ok.example/live.m3u8',
      ),
    );
    expect(channels.map((c) => c.url)).toEqual([
      'rtmp://live.example/app/stream',
      'rtsp://cam.example:554/feed',
      'udp://@239.1.1.1:5000',
      'rtp://239.1.1.2:5004',
      'mms://media.example/live',
      'https://ok.example/live.m3u8',
    ]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^5 channels use protocols/);
    expect(warnings[0]).toContain('rtmp://');
  });

  it('drops stray text and unsafe links with a summary warning, keeping a pending #EXTINF for the next URL', () => {
    const { channels, warnings } = parseM3U(
      m3u(
        '#EXTM3U',
        'This playlist is maintained by someone',
        '#EXTINF:-1,Kept',
        'Some stray text between',
        'http://s.example/kept.m3u8',
        '#EXTINF:-1,Evil',
        'javascript:alert(1)',
        '#EXTINF:-1,Local',
        'C:\\Videos\\movie.ts',
        '#EXTINF:-1,Data',
        'data:text/html,<b>x</b>',
        'http://s.example/after.m3u8',
      ),
    );
    expect(channels.map((c) => c.name)).toEqual(['Kept', 'after']);
    expect(channels.map((c) => c.index)).toEqual([0, 1]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^Skipped 5 lines/);
  });

  it('ignores unknown tags and comments, and warns about #EXTINF entries without a URL', () => {
    const { channels, warnings } = parseM3U(
      m3u(
        '#EXTM3U',
        '# just a comment with http://not-a-channel.example',
        '#EXT-X-VERSION:3',
        '#EXTALB:Album',
        '#EXTINF:-1,Orphan (followed by another EXTINF)',
        '#EXTINF:-1,Real',
        'http://s.example/real.m3u8',
        '#EXTINF:-1,Orphan at end',
      ),
    );
    expect(channels.map((c) => c.name)).toEqual(['Real']);
    expect(warnings).toEqual(['Skipped 2 entries without a stream URL.']);
  });
});

describe('isHlsManifest / looksLikeM3U', () => {
  const master = m3u(
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-STREAM-INF:BANDWIDTH=1280000,RESOLUTION=1280x720',
    '720p.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=2560000,RESOLUTION=1920x1080',
    '1080p.m3u8',
  );
  const media = m3u('#EXTM3U', '#EXT-X-TARGETDURATION:6', '#EXTINF:6.0,', 'seg0.ts', '#EXTINF:6.0,', 'seg1.ts');
  const mediaSeq = m3u('#EXTM3U', '#EXT-X-MEDIA-SEQUENCE:120', '#EXTINF:4,', 'seg120.ts');

  it('detects HLS master and media manifests, and parseM3U returns no channels for them', () => {
    expect(isHlsManifest(master)).toBe(true);
    expect(isHlsManifest(media)).toBe(true);
    expect(isHlsManifest(`\uFEFF${mediaSeq.replace(/\n/g, '\r\n')}`)).toBe(true);
    for (const text of [master, media, mediaSeq]) {
      const result = parseM3U(text, { baseUrl: 'https://cdn.example/live/master.m3u8' });
      expect(result.meta.isHlsManifest).toBe(true);
      expect(result.channels).toEqual([]);
      expect(result.warnings).toEqual([]);
    }
  });

  it('does not treat IPTV channel lists as HLS manifests', () => {
    const iptv = m3u('#EXTM3U', '#EXTINF:-1 tvg-id="a" group-title="News",A', 'http://s/a.m3u8');
    expect(isHlsManifest(iptv)).toBe(false);
    expect(isHlsManifest('#EXTM3U\n#EXTINF:-1,A\nhttp://s/a.m3u8')).toBe(false);
    // A tag name mentioned mid-line is not a tag.
    expect(isHlsManifest('#EXTM3U\n#EXTINF:-1,About #EXT-X-STREAM-INF\nhttp://s/a')).toBe(false);
    // A channel list that happens to carry stray HLS tags is still a channel list.
    expect(isHlsManifest(`${iptv}\n#EXT-X-TARGETDURATION:6`)).toBe(false);
    expect(isHlsManifest('')).toBe(false);
    expect(isHlsManifest(null)).toBe(false);
  });

  it('looksLikeM3U accepts playlists and URL lists, rejects HTML and junk', () => {
    expect(looksLikeM3U('#EXTM3U\n')).toBe(true);
    expect(looksLikeM3U('\uFEFF#EXTM3U x-tvg-url="a"')).toBe(true);
    expect(looksLikeM3U('#EXTINF:-1,Only extinf\nhttp://s/1')).toBe(true);
    expect(looksLikeM3U('#extm3u')).toBe(true);
    expect(looksLikeM3U('http://s.example/a.m3u8\nhttp://s.example/b.m3u8')).toBe(true);
    expect(looksLikeM3U('title line\n  https://s.example/a.ts')).toBe(true);
    expect(looksLikeM3U(master)).toBe(true);

    expect(looksLikeM3U('<!DOCTYPE html><html><body>#EXTM3U</body></html>')).toBe(false);
    expect(looksLikeM3U('  <html>\nhttp://s.example/a.m3u8')).toBe(false);
    expect(looksLikeM3U('{"error":"not found","url":"http://s/x"}')).toBe(false);
    expect(looksLikeM3U('just some text\nwith http://inline.example links')).toBe(false);
    expect(looksLikeM3U('rtmp://only.example/stream')).toBe(false);
    expect(looksLikeM3U('')).toBe(false);
    expect(looksLikeM3U(undefined)).toBe(false);
  });
});

describe('groupChannels', () => {
  it('lists groups in appearance order, counting a channel once in each of its groups', () => {
    const { channels } = parseM3U(
      m3u(
        '#EXTINF:-1 group-title="News;Sports",A',
        'http://s/a',
        '#EXTINF:-1,B',
        'http://s/b',
        '#EXTINF:-1 group-title="Sports",C',
        'http://s/c',
        '#EXTINF:-1 group-title="Kids;News",D',
        'http://s/d',
      ),
    );
    expect(groupChannels(channels)).toEqual([
      { name: 'News', count: 2, firstIndex: 0 },
      { name: 'Sports', count: 2, firstIndex: 0 },
      { name: UNCATEGORIZED, count: 1, firstIndex: 1 },
      { name: 'Kids', count: 1, firstIndex: 3 },
    ]);
  });

  it('handles empty input, snapshot channels (index -1) and channels without a groups array', () => {
    expect(groupChannels([])).toEqual([]);
    expect(groupChannels(null)).toEqual([]);
    expect(
      groupChannels([
        { index: -1, group: 'Fav', groups: ['Fav'] },
        { index: -1, group: 'Fav' },
        { index: -1, groups: ['X', 'X'] },
        { index: -1 },
      ]),
    ).toEqual([
      { name: 'Fav', count: 2, firstIndex: 0 },
      { name: 'X', count: 1, firstIndex: 2 },
      { name: UNCATEGORIZED, count: 1, firstIndex: 3 },
    ]);
  });
});

describe('serializeM3U', () => {
  const canonical = (ch) => ({
    id: ch.id,
    index: ch.index,
    name: ch.name,
    url: ch.url,
    group: ch.group,
    groups: [...ch.groups],
    logo: ch.logo,
    tvgId: ch.tvgId,
    tvgName: ch.tvgName,
    chno: ch.chno,
    duration: ch.duration,
    headers: ch.headers,
  });

  it('round-trips parse → serialize → parse with identical channels (ids, groups, headers…)', () => {
    const source = m3u(
      '#EXTM3U x-tvg-url="https://epg.example/guide.xml"',
      '#EXTINF:-1 tvg-id="a.us" tvg-name=\'Say "Hi"\' tvg-logo="https://l.example/a.png?x=1&amp;y=2" ' +
        'group-title="News; World" tvg-chno="5" catchup="default",News, Weather &amp; More',
      '#EXTVLCOPT:http-user-agent=Mozilla/5.0',
      'http://s.example/a.m3u8|Referer=https%3A%2F%2Fref.example%2F&Origin=https://o.example',
      '#EXTINF:120,Literal &amp;lt;tag&amp;gt; &amp;amp; ampersand',
      '#EXTGRP:Movies; Classics',
      'https://s.example/movie.mp4',
      '#EXTINF:-1,Same',
      'https://s.example/dup',
      '#EXTINF:-1,Same',
      'https://s.example/dup',
      'rtmp://live.example/app/stream',
      'https://cdn.example/plain/derived.m3u8',
    );
    const first = parseM3U(source);
    const text = serializeM3U(first.channels, { title: 'Exported', epgUrl: first.meta.epgUrl });
    const second = parseM3U(text);

    expect(second.channels.map(canonical)).toEqual(first.channels.map(canonical));
    expect(second.meta.title).toBe('Exported');
    expect(second.meta.epgUrl).toBe('https://epg.example/guide.xml');
    expect(first.channels[1].name).toBe('Literal &lt;tag&gt; &amp; ampersand');
    expect(first.channels[1].groups).toEqual(['Movies; Classics']);
    expect(second.channels[0].attrs.catchup).toBe('default');
    // Serializing again is stable.
    expect(serializeM3U(second.channels, { title: 'Exported', epgUrl: second.meta.epgUrl })).toBe(text);
  });

  it('writes one #EXTINF + URL per channel with escaped, single-line attribute values', () => {
    const text = serializeM3U(
      [
        {
          id: 'x',
          index: -1,
          name: 'Line\nBreak "Quoted"',
          url: 'https://s.example/1.m3u8',
          group: UNCATEGORIZED,
          groups: [UNCATEGORIZED],
          logo: '',
          tvgId: 'id"1',
          tvgName: '',
          chno: null,
          duration: -1,
          attrs: { 'bad key': 'x', 'x-custom': 'a"b' },
          headers: { userAgent: 'UA', origin: 'https://o.example' },
          drm: false,
          playlistId: 'pl_1',
        },
        // Minimal snapshot-like objects work too.
        { name: 'Snap', url: 'https://s.example/2.m3u8', group: 'Fav' },
        { name: 'No url' },
        null,
      ],
      { title: 'Favorites' },
    );
    expect(text).toBe(
      [
        '#EXTM3U',
        '#PLAYLIST:Favorites',
        '#EXTINF:-1 tvg-id="id&quot;1" x-custom="a&quot;b",Line Break "Quoted"',
        '#EXTVLCOPT:http-user-agent=UA',
        '#EXTVLCOPT:http-origin=https://o.example',
        'https://s.example/1.m3u8',
        '#EXTINF:-1 group-title="Fav",Snap',
        'https://s.example/2.m3u8',
        '',
      ].join('\n'),
    );
    const reparsed = parseM3U(text);
    expect(reparsed.channels.map((c) => [c.name, c.tvgId, c.group])).toEqual([
      ['Line Break "Quoted"', 'id"1', UNCATEGORIZED],
      ['Snap', '', 'Fav'],
    ]);
    expect(serializeM3U([])).toBe('#EXTM3U\n');
  });
});

describe('robustness and performance', () => {
  it('scans hostile attribute soup in linear time (no catastrophic backtracking)', () => {
    const soup = 'a="'.repeat(20000) + "b='".repeat(20000) + '=,'.repeat(20000) + ' x'.repeat(20000);
    const lines = [];
    for (let i = 0; i < 20; i++) lines.push(`#EXTINF:-1 ${soup}`, `http://s.example/${i}`);
    const start = performance.now();
    const { channels } = parseM3U(lines.join('\n'));
    const elapsed = performance.now() - start;
    expect(channels).toHaveLength(20);
    channels.forEach((ch, i) => expectChannelShape(ch, i));
    expect(elapsed).toBeLessThan(2000);
    expect(isHlsManifest(soup)).toBe(false);
    expect(looksLikeM3U(soup)).toBe(false);
  });

  it('parses 50,000 entries quickly (perf smoke test)', () => {
    const lines = ['#EXTM3U x-tvg-url="https://epg.example/guide.xml.gz"'];
    for (let i = 0; i < 50000; i++) {
      lines.push(
        `#EXTINF:-1 tvg-id="channel${i}.example" tvg-name="Channel ${i}" ` +
          `tvg-logo="https://logos.example/${i % 5000}.png" group-title="Group ${i % 250}",Channel ${i} HD`,
        `https://streams.example/live/${i}/index.m3u8`,
      );
    }
    const text = lines.join('\n');
    parseM3U(text.slice(0, 20000)); // warm up the JIT a little

    const start = performance.now();
    const { channels, warnings } = parseM3U(text);
    const elapsed = performance.now() - start;

    expect(channels).toHaveLength(50000);
    expect(warnings).toEqual([]);
    expect(channels[49999]).toMatchObject({
      index: 49999,
      name: 'Channel 49999 HD',
      group: 'Group 249',
      url: 'https://streams.example/live/49999/index.m3u8',
    });
    expect(groupChannels(channels)).toHaveLength(250);
    // Target is < 300 ms in Node; the threshold is generous so slow CI machines don't flake.
    expect(elapsed).toBeLessThan(1500);
  });
});
