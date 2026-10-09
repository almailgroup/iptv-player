import { describe, it, expect } from 'vitest';
import { normalizeText, fuzzyMatch, searchChannels, highlight } from '../src/lib/fuzzy.js';

let nextId = 0;

/** Build a Channel-shaped object (same shape the parser produces). */
function ch(name, { groups = ['Uncategorized'], tvgId = '', chno = null, id } = {}) {
  nextId += 1;
  return {
    id: id || `c${nextId}`,
    index: nextId,
    name,
    url: `https://example.com/live/${nextId}.m3u8`,
    group: groups[0],
    groups,
    logo: '',
    tvgId,
    tvgName: '',
    chno,
    duration: -1,
    attrs: {},
    headers: {},
    drm: false,
  };
}

const names = (results) => results.map((r) => r.channel.name);
const ids = (results) => results.map((r) => r.channel.id);
const score = (query, target) => fuzzyMatch(query, target)?.score ?? null;

/** Render a fragment into a container so it can be inspected. */
function render(fragment) {
  const div = document.createElement('div');
  div.append(fragment);
  return div;
}

describe('normalizeText', () => {
  it('lowercases ASCII and returns an identity map', () => {
    expect(normalizeText('BBC One')).toEqual({ text: 'bbc one', map: [0, 1, 2, 3, 4, 5, 6] });
    expect(normalizeText('')).toEqual({ text: '', map: [] });
    expect(normalizeText(null)).toEqual({ text: '', map: [] });
  });

  it('strips precomposed and combining diacritics, mapping back to the raw string', () => {
    expect(normalizeText('Café')).toEqual({ text: 'cafe', map: [0, 1, 2, 3] });
    // "e" + U+0301 COMBINING ACUTE: the mark disappears, later chars keep their raw positions.
    expect(normalizeText('Café Ø')).toEqual({ text: 'cafe o', map: [0, 1, 2, 3, 5, 6] });
    expect(normalizeText('Télé Ñandú').text).toBe('tele nandu');
  });

  it('folds letters without a decomposition and compatibility forms', () => {
    expect(normalizeText('Straße')).toEqual({ text: 'strasse', map: [0, 1, 2, 3, 4, 4, 5] });
    expect(normalizeText('Łódź').text).toBe('lodz');
    expect(normalizeText('ＢＢＣ ᴴᴰ').text).toBe('bbc hd');
    // Invisible format chars vanish; the map skips over them.
    expect(normalizeText('a​b')).toEqual({ text: 'ab', map: [0, 2] });
  });
});

describe('fuzzyMatch', () => {
  it('ranks tiers: exact > prefix > word-start > substring > subsequence', () => {
    const scores = ['News', 'News 24', 'Sky News', 'Skynews', 'Nxexwxs'].map((t) => score('news', t));
    expect(scores.every((s) => typeof s === 'number' && s > 0)).toBe(true);
    for (let i = 1; i < scores.length; i++) expect(scores[i - 1]).toBeGreaterThan(scores[i]);
    expect(fuzzyMatch('news', 'Weather')).toBeNull();
  });

  it('treats camelCase boundaries as word starts', () => {
    expect(score('news', 'SkyNews')).toBeGreaterThan(score('news', 'Skynews'));
    expect(score('news', 'ESPNews')).toBeGreaterThan(score('news', 'Skynews'));
    expect(fuzzyMatch('news', 'SkyNews').indices).toEqual([3, 4, 5, 6]);
  });

  it('single-char tokens match prefix > word-start > substring only', () => {
    const prefix = score('s', 'Sky');
    const wordStart = score('s', 'Fox Sports');
    const substring = score('s', 'Bus');
    expect(prefix).toBeGreaterThan(wordStart);
    expect(wordStart).toBeGreaterThan(substring);
    expect(fuzzyMatch('q', 'Pizza')).toBeNull();
  });

  it('lets shorter targets win ties slightly', () => {
    expect(score('bbc', 'BBC One')).toBeGreaterThan(score('bbc', 'BBC One Scotland HD'));
    expect(score('sport', 'Eurosport')).toBeGreaterThan(score('sport', 'Eurosport Extra'));
  });

  it('returns sorted, unique raw indices for multi-token queries', () => {
    expect(fuzzyMatch('one bbc', 'BBC One HD').indices).toEqual([0, 1, 2, 4, 5, 6]);
    expect(fuzzyMatch('bbc b', 'BBC One').indices).toEqual([0, 1, 2]);
    expect(fuzzyMatch('bbc zzz', 'BBC One')).toBeNull(); // AND semantics
  });

  it('is diacritic-insensitive and maps indices back through precomposed chars', () => {
    expect(score('cafe', 'Café')).toBe(1000);
    expect(fuzzyMatch(normalizeText('CAFÉ').text, 'Cafe')).not.toBeNull();
    expect(fuzzyMatch('tele', 'Café Télé').indices).toEqual([5, 6, 7, 8]);
  });

  it('maps indices back through combining marks and expanded letters', () => {
    // C0 a1 f2 e3 ́4 ␠5 T6 e7 ́8 l9 e10 ́11 — every accent stays attached to its base letter.
    expect(fuzzyMatch('tele', 'Café Télé').indices).toEqual([6, 7, 8, 9, 10, 11]);
    expect(fuzzyMatch('strasse', 'Straße 1').indices).toEqual([0, 1, 2, 3, 4, 5]);
    expect(fuzzyMatch('stras', 'Straße').indices).toEqual([0, 1, 2, 3, 4]);
  });

  it('rejects absurdly spread subsequences but accepts compact ones', () => {
    expect(fuzzyMatch('abc', `a${'x'.repeat(20)}b${'x'.repeat(20)}c`)).toBeNull();
    expect(fuzzyMatch('ab', 'axxxxxxb')).toBeNull();
    const compact = fuzzyMatch('nws', 'News');
    expect(compact.indices).toEqual([0, 2, 3]);
    expect(compact.score).toBeLessThan(score('news', 'Skynews')); // subsequence < substring
  });

  it('keeps acronym-style subsequences on word starts', () => {
    const hit = fuzzyMatch('nbc', 'National Broadcasting Company');
    expect(hit.indices).toEqual([0, 9, 14]);
    expect(hit.score).toBeLessThan(400);
  });

  it('tolerates one adjacent transposition with a low score', () => {
    const hit = fuzzyMatch('epsn', 'ESPN 2');
    expect(hit.indices).toEqual([0, 1, 2, 3]);
    expect(hit.score).toBeGreaterThan(0);
    expect(hit.score).toBeLessThan(score('nws', 'News')); // below any subsequence match
  });

  it('tolerates one extra or missing char', () => {
    expect(fuzzyMatch('disccovery', 'Discovery Channel').indices).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(fuzzyMatch('dicovery', 'Discovery')).not.toBeNull();
    expect(fuzzyMatch('spotrs', 'Sky Sports').indices).toEqual([4, 5, 6, 7, 8, 9]);
  });

  it('limits typo tolerance to tokens of 4+ chars at word starts', () => {
    expect(fuzzyMatch('cnm', 'CNN')).toBeNull();
    expect(fuzzyMatch('epsn', 'Xespnx')).toBeNull();
    expect(fuzzyMatch('spotrs', 'Skysports')).toBeNull();
  });

  it('handles blank queries and odd targets', () => {
    expect(fuzzyMatch('', 'News')).toEqual({ score: 0, indices: [] });
    expect(fuzzyMatch('   ', 'News')).toEqual({ score: 0, indices: [] });
    expect(fuzzyMatch('news', null)).toBeNull();
    expect(fuzzyMatch('1', 1)).toEqual({ score: 1000, indices: [0] });
  });
});

describe('searchChannels', () => {
  it('returns null for a blank query and [] for no channels', () => {
    const list = [ch('News')];
    expect(searchChannels(list, '')).toBeNull();
    expect(searchChannels(list, '  \t ')).toBeNull();
    expect(searchChannels(list, null)).toBeNull();
    expect(searchChannels([], 'news')).toEqual([]);
  });

  it('orders results by tier and drops non-matches', () => {
    const list = ['Nxexwxs', 'Skynews', 'Weather', 'Sky News', 'News 24', 'News'].map((n) => ch(n));
    const results = searchChannels(list, 'news');
    expect(names(results)).toEqual(['News', 'News 24', 'Sky News', 'Skynews', 'Nxexwxs']);
    expect(results[0].indices).toEqual([0, 1, 2, 3]);
    expect(results[2].indices).toEqual([4, 5, 6, 7]);
  });

  it('requires every token to match (AND), in any order', () => {
    const list = [ch('Sky News'), ch('Sky Sports 1'), ch('BT Sports')];
    expect(names(searchChannels(list, 'sky sports'))).toEqual(['Sky Sports 1']);
    expect(names(searchChannels(list, 'SPORTS   sky'))).toEqual(['Sky Sports 1']);
    expect(searchChannels(list, 'sky sports 1')[0].indices).toEqual([0, 1, 2, 4, 5, 6, 7, 8, 9, 11]);
  });

  it('matches groups more weakly than names, with empty indices', () => {
    const list = [ch('CNN International', { groups: ['News'] }), ch('News Now', { groups: ['General'] })];
    const results = searchChannels(list, 'news');
    expect(names(results)).toEqual(['News Now', 'CNN International']);
    expect(results[1].indices).toEqual([]);
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });

  it('matches any of several groups and combines group and name tokens', () => {
    const list = [
      ch('BBC One', { groups: ['UK', 'Entertainment'] }),
      ch('BBC America', { groups: ['US'] }),
      ch('ITV', { groups: ['UK'] }),
    ];
    const results = searchChannels(list, 'uk bbc');
    expect(names(results)).toEqual(['BBC One']);
    expect(results[0].indices).toEqual([0, 1, 2]);
    expect(names(searchChannels(list, 'entertainment'))).toEqual(['BBC One']);
  });

  it('weights name > group > tvg-id', () => {
    const list = [
      ch('Das Erste', { tvgId: 'ARD.de' }),
      ch('Tagesschau 24', { groups: ['ARD'] }),
      ch('ARD Mediathek'),
    ];
    const results = searchChannels(list, 'ard');
    expect(names(results)).toEqual(['ARD Mediathek', 'Tagesschau 24', 'Das Erste']);
    expect(results[1].indices).toEqual([]);
    expect(results[2].indices).toEqual([]);
  });

  it('treats an exact chno as a strong name match', () => {
    const list = [ch('Channel 1010', { chno: 5 }), ch('Movies', { chno: 101 }), ch('Kids', { chno: 7 })];
    const results = searchChannels(list, '101');
    expect(names(results)).toEqual(['Movies', 'Channel 1010']);
    expect(results[0].indices).toEqual([]);
    expect(names(searchChannels(list, '#101'))).toEqual(['Movies']);
    expect(names(searchChannels(list, 'kids 7'))).toEqual(['Kids']);
    expect(names(searchChannels(list, '10'))).toEqual(['Channel 1010']); // chno must match exactly
  });

  it('is diacritic-insensitive in both directions', () => {
    const list = [ch('Café Ñandú'), ch('Nandu TV'), ch('Télé Monte Carlo')];
    expect(names(searchChannels(list, 'cafe'))).toEqual(['Café Ñandú']);
    expect(names(searchChannels(list, 'ÑANDU'))).toEqual(['Nandu TV', 'Café Ñandú']);
    expect(searchChannels(list, 'tele')[0].indices).toEqual([0, 1, 2, 3]);
  });

  it('finds typos but ranks them below real matches', () => {
    const list = [ch('Sky Sports'), ch('Spotrs Weekly'), ch('Sky News')];
    const results = searchChannels(list, 'spotrs');
    expect(names(results)).toEqual(['Spotrs Weekly', 'Sky Sports']);
    expect(results[1].indices).toEqual([4, 5, 6, 7, 8, 9]);
  });

  it('typo-matches group names when nothing else matches', () => {
    const list = [ch('Eurosport 1', { groups: ['Sports'] }), ch('Arte', { groups: ['Culture'] })];
    const results = searchChannels(list, 'sprots');
    expect(names(results)).toEqual(['Eurosport 1']);
    expect(results[0].indices).toEqual([]);
  });

  it('keeps the input order for equal scores (stable)', () => {
    const list = [
      ch('News', { id: 'a' }),
      ch('Alpha', { id: 'b', groups: ['News'] }),
      ch('News', { id: 'c' }),
      ch('Beta', { id: 'd', groups: ['News'] }),
      ch('News', { id: 'e' }),
    ];
    expect(ids(searchChannels(list, 'news'))).toEqual(['a', 'c', 'e', 'b', 'd']);
    expect(ids(searchChannels(list.slice().reverse(), 'news'))).toEqual(['e', 'c', 'a', 'd', 'b']);
  });

  it('honors the limit option', () => {
    const list = Array.from({ length: 50 }, (_, i) => ch(`News ${i}`));
    expect(searchChannels(list, 'news', { limit: 5 })).toHaveLength(5);
    expect(names(searchChannels(list, 'news', { limit: 2 }))).toEqual(['News 0', 'News 1']);
    expect(searchChannels(list, 'news', { limit: 0 })).toEqual([]);
    expect(searchChannels(list, 'news')).toHaveLength(50);
  });

  it('caches per channel without mutating (frozen) channels and stays consistent', () => {
    const list = [ch('Ünïcödé News'), ch('Plain News'), ch('Other')].map((c) => Object.freeze(c));
    const first = searchChannels(list, 'unicode');
    const again = searchChannels(list.slice(), 'unicode');
    expect(again).toEqual(first);
    expect(names(first)).toEqual(['Ünïcödé News']);
    expect(first[0].indices).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(names(searchChannels(list, 'news'))).toEqual(['Plain News', 'Ünïcödé News']);
  });

  it('adds a phrase bonus when a multi-word query appears verbatim', () => {
    const list = [ch('One BBC Show'), ch('BBC One')];
    expect(names(searchChannels(list, 'bbc one'))).toEqual(['BBC One', 'One BBC Show']);
  });

  it('ranks realistic channel names sensibly', () => {
    const list = [
      ['BBC One HD', 'UK'], ['BBC One London', 'UK'], ['BBC Two HD', 'UK'], ['BBC News HD', 'UK News'],
      ['CBBC', 'Kids'], ['CNN', 'News'], ['CNN International', 'News'], ['CNBC', 'Business'],
      ['Cartoon Network', 'Kids'], ['ESPN', 'Sports'], ['ESPN 2', 'Sports'], ['ESPN2 HD', 'Sports'],
      ['ESPNews', 'Sports'], ['Fox Sports 1', 'Sports'], ['FOX Sports Racing', 'Sports'], ['Fox News Channel', 'News'],
      ['Fox Soccer Plus', 'Sports'], ['TF1', 'France'], ['TF1 Séries Films', 'France'], ['TFX', 'France'],
      ['RTL', 'Germany'], ['RTL Zwei', 'Germany'], ['Super RTL', 'Germany'], ['Sky Sports F1', 'UK Sports'],
    ].map(([name, group]) => ch(name, { groups: [group] }));
    const top = (q, n) => names(searchChannels(list, q)).slice(0, n);
    expect(top('bbc one hd', 2)).toEqual(['BBC One HD']);
    expect(top('bbc one', 2)).toEqual(['BBC One HD', 'BBC One London']);
    expect(top('cnn', 3)).toEqual(['CNN', 'CNN International', 'Cartoon Network']);
    expect(top('espn 2', 2)).toEqual(['ESPN 2', 'ESPN2 HD']);
    expect(top('fox sports', 3)).toEqual(['Fox Sports 1', 'FOX Sports Racing', 'Fox Soccer Plus']);
    expect(top('tf1', 3)).toEqual(['TF1', 'TF1 Séries Films', 'Sky Sports F1']);
    expect(top('rtl', 3)).toEqual(['RTL', 'RTL Zwei', 'Super RTL']);
    expect(top('series films', 1)).toEqual(['TF1 Séries Films']); // diacritic-insensitive
    expect(names(searchChannels(list, 'espn')).slice(0, 5)).toEqual(['ESPN', 'ESPN 2', 'ESPN2 HD', 'ESPNews']);
  });

  it('searches 20k channels with a 6-char query quickly', () => {
    const words = ['news', 'sport', 'movie', 'cinema', 'kids', 'music', 'docu', 'discovery', 'channel', 'hd',
      'uk', 'us', 'de', 'plus', 'one', 'max', 'live', 'world', 'family', 'action', 'comedy', 'drama'];
    const groupNames = ['News', 'Sports', 'Movies', 'Kids', 'Music', 'Documentary', 'UK', 'USA', 'Germany'];
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
    const list = [];
    for (let i = 0; i < 20000; i++) {
      const parts = Array.from({ length: 2 + Math.floor(rnd() * 3) }, () => pick(words));
      let name = `${parts.map((w) => w[0].toUpperCase() + w.slice(1)).join(' ')} ${i}`;
      if (i % 9 === 0) name = `Télé ${name}`;
      list.push(ch(name, { groups: [pick(groupNames)], tvgId: `${parts.join('.')}.${i}`, chno: i }));
    }

    let t = performance.now();
    const cold = searchChannels(list, 'cinema'); // includes normalizing every name once
    const coldMs = performance.now() - t;

    t = performance.now();
    const runs = 5;
    let warm;
    for (let k = 0; k < runs; k++) warm = searchChannels(list, 'discov');
    const warmMs = (performance.now() - t) / runs;

    expect(cold.length).toBeGreaterThan(100);
    expect(warm.length).toBeGreaterThan(100);
    expect(warm[0].channel.name.toLowerCase()).toContain('discov');
    expect(coldMs).toBeLessThan(1000);
    expect(warmMs).toBeLessThan(150);
  });
});

describe('highlight', () => {
  it('wraps indices in merged <mark class="hl"> runs', () => {
    const div = render(highlight('BBC One', [0, 1, 2, 4]));
    const marks = div.querySelectorAll('mark');
    expect(div.textContent).toBe('BBC One');
    expect(marks).toHaveLength(2);
    expect(marks[0].textContent).toBe('BBC');
    expect(marks[1].textContent).toBe('O');
    expect([...marks].every((m) => m.className === 'hl')).toBe(true);
    expect(div.childNodes).toHaveLength(4); // mark, " ", mark, "ne"
  });

  it('returns plain text when there is nothing to highlight', () => {
    for (const indices of [[], null, undefined]) {
      const frag = highlight('News', indices);
      expect(frag.childNodes).toHaveLength(1);
      expect(frag.firstChild.nodeType).toBe(3); // TEXT_NODE
      expect(frag.textContent).toBe('News');
    }
    expect(highlight('', [0]).childNodes).toHaveLength(0);
  });

  it('treats markup in names as text', () => {
    const name = '<img src=x onerror=alert(1)>';
    const div = render(highlight(name, [0, 1, 2, 3]));
    expect(div.querySelector('img')).toBeNull();
    expect(div.textContent).toBe(name);
    expect(div.querySelector('mark').textContent).toBe('<img');
  });

  it('tolerates unsorted, duplicate and out-of-range indices', () => {
    const div = render(highlight('abcdef', [5, 1, 1, 0, 99, -1, 2.5, NaN]));
    expect([...div.querySelectorAll('mark')].map((m) => m.textContent)).toEqual(['ab', 'f']);
    expect(div.textContent).toBe('abcdef');
  });

  it('keeps combining marks and surrogate pairs inside a mark', () => {
    expect(render(highlight('Café', [3])).querySelector('mark').textContent).toBe('é');
    expect(render(highlight('a😀b', [1])).querySelector('mark').textContent).toBe('😀');
    expect(render(highlight('a😀b', [2])).querySelector('mark').textContent).toBe('😀');
  });

  it('renders searchChannels indices end-to-end through diacritics', () => {
    const channel = ch('Télé Monte-Carlo');
    const [result] = searchChannels([channel], 'tele carlo');
    const div = render(highlight(channel.name, result.indices));
    expect([...div.querySelectorAll('mark.hl')].map((m) => m.textContent)).toEqual(['Télé', 'Carlo']);
    expect(div.textContent).toBe(channel.name);
  });
});
