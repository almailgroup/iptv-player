// Fuzzy channel search: diacritic-insensitive, multi-token AND matching with tiered scoring.
//
// Every query token is scored against a channel's name (weight 1.0) or, weaker, one of its groups (0.45), its
// tvg-id (0.35) or its channel number (an exact chno match counts as a strong name match). Per field the best
// tier wins:
//
//   exact 1000 · chno 900 · prefix 790–885 · word-start 590–705 · substring 400–490 · subsequence 101–360
//   · typo 50–95
//
// The ranges never overlap, so a better tier always outranks a worse one for the same token; within a tier,
// shorter targets, earlier positions and whole-word hits win. A channel's score is the sum of its token
// scores (plus a small bonus when a multi-word query appears verbatim in the name). Results are sorted by
// score; ties keep the input order.
//
// Normalized fields are cached per channel in a WeakMap (channels are immutable) and per string for group
// names (they repeat across thousands of channels), so repeated searches only pay for matching.

import { h } from './dom.js';

// -----------------------------------------------------------------------------------------------------------
// Tuning
// -----------------------------------------------------------------------------------------------------------

const SCORE_EXACT = 1000;
const SCORE_CHNO = 900;
const BASE_PREFIX = 800;
const BASE_WORD_START = 620;
const BASE_SUBSTRING = 430;
const SUBSEQ_MIN = 101;
const SUBSEQ_MAX = 360;
const TYPO_BASE = 65;

const RATIO_BONUS = 60; // × (token length / target length): shorter targets win ties
const WHOLE_WORD_BONUS = 25; // prefix / word-start match that ends at a word end ("bbc" in "BBC One")
const MAX_POSITION_PENALTY = 20;
const LENGTH_PENALTY = 0.05; // per normalized char of the target …
const MAX_LENGTH_PENALTY = 10; // … capped

const PHRASE_EXACT_BONUS = 300; // multi-word query equals the name
const PHRASE_PREFIX_BONUS = 200; // … starts the name
const PHRASE_BONUS = 120; // … appears in the name

const WEIGHT_GROUP = 0.45;
const WEIGHT_TVG = 0.35;
const GROUP_CAP = WEIGHT_GROUP * SCORE_EXACT; // a group hit can never score more than this
const TVG_CAP = WEIGHT_TVG * SCORE_EXACT;

// Subsequence alignment (fzf-like): bonuses for word-boundary hits and consecutive runs, affine gap penalty.
const BONUS_FIRST = 10; // match at index 0
const BONUS_BOUNDARY = 8; // match at a word start
const BONUS_CONSECUTIVE = 5;
const GAP_OPEN = 3;
const GAP_EXTEND = 1;
const START_PENALTY = 0.4; // per char before the first match …
const MAX_START_CHARS = 15; // … capped
const ACRONYM_SPAN_FACTOR = 3; // an all-word-start match may spread up to 3× the normal span limit

const MAX_SUBSEQ_TOKEN = 32; // longer tokens only match contiguously (or with a typo)
const MAX_DP_TARGET = 256; // longer targets use the compact-window alignment instead of the DP
const MAX_WINDOWS = 12; // candidate windows examined when looking for the most compact subsequence
const MAX_TYPO_TOKEN = 64;
const MAX_QUERY_LENGTH = 256;
const STRING_CACHE_MAX = 10000;
const CHAR_CACHE_MAX = 20000;

// -----------------------------------------------------------------------------------------------------------
// Normalization
// -----------------------------------------------------------------------------------------------------------

// eslint-disable-next-line no-control-regex
const ASCII_RE = /^[\x00-\x7f]*$/;
// Combining marks + invisible format chars (zero-width space/joiner, soft hyphen, bidi marks, BOM…).
const STRIP_RE = /[\p{M}\p{Cf}]/gu;
const WORD_CHAR_RE = /[\p{L}\p{N}]/u;
const UPPER_RE = /\p{Lu}/u;
const LOWER_RE = /\p{Ll}/u;
const MARK_RE = /\p{M}/u;
const WHITESPACE_RE = /\s+/;
const NUMBER_TOKEN_RE = /^#?\d{1,9}$/;

/** Letters that Unicode decomposition leaves alone but users type without the diacritic, plus typographic
 * quotes/dashes that users type as their ASCII counterparts. */
const FOLD = new Map([
  ['ø', 'o'],
  ['đ', 'd'],
  ['ð', 'd'],
  ['ł', 'l'],
  ['ħ', 'h'],
  ['ŧ', 't'],
  ['ı', 'i'],
  ['ȷ', 'j'],
  ['ß', 'ss'],
  ['æ', 'ae'],
  ['œ', 'oe'],
  ['þ', 'th'],
  ['ς', 'σ'],
  ['‘', "'"],
  ['’', "'"],
  ['‚', "'"],
  ['‛', "'"],
  ['“', '"'],
  ['”', '"'],
  ['„', '"'],
  ['‐', '-'],
  ['‑', '-'],
  ['‒', '-'],
  ['–', '-'],
  ['—', '-'],
  ['−', '-'],
]);

const isLowSurrogate = (c) => c >= 0xdc00 && c <= 0xdfff;
const isHighSurrogate = (c) => c >= 0xd800 && c <= 0xdbff;
const isDigit = (c) => c >= 48 && c <= 57;

/** Non-ASCII code point (as a string) → folded string; '' for chars that vanish (marks, zero-width chars). */
const charCache = new Map();

function foldChar(ch) {
  let out = charCache.get(ch);
  if (out !== undefined) return out;
  // NFKD (not just NFD) also folds the compatibility forms IPTV names love:
  // "ᴴᴰ" → "HD", "ＢＢＣ" → "BBC", "𝐁𝐁𝐂" → "BBC", "ﬁ" → "fi".
  const base = ch.normalize('NFKD').replace(STRIP_RE, '').toLowerCase();
  out = '';
  for (const c of base) out += FOLD.get(c) ?? c;
  out = out.replace(STRIP_RE, ''); // toLowerCase('İ') re-introduces a combining dot
  if (charCache.size >= CHAR_CACHE_MAX) charCache.clear();
  charCache.set(ch, out);
  return out;
}

/**
 * Normalize without materializing an identity map (map === null means normalized index === raw index, which
 * is the case for every pure-ASCII string — the vast majority of channel names).
 * @param {string} str
 * @returns {{ text: string, map: number[] | null }}
 */
function normalizeInternal(str) {
  if (ASCII_RE.test(str)) return { text: str.toLowerCase(), map: null };
  let text = '';
  const map = [];
  for (let i = 0; i < str.length; ) {
    const code = str.charCodeAt(i);
    if (code < 128) {
      text += code >= 65 && code <= 90 ? String.fromCharCode(code + 32) : str[i];
      map.push(i);
      i += 1;
      continue;
    }
    const size = isHighSurrogate(code) && isLowSurrogate(str.charCodeAt(i + 1)) ? 2 : 1;
    const ch = size === 2 ? str.slice(i, i + 2) : str[i];
    const out = foldChar(ch);
    if (out === ch) {
      text += ch;
      for (let k = 0; k < size; k++) map.push(i + k);
    } else {
      // Every output char maps to the start of its source char; chars that fold to '' are dropped.
      text += out;
      for (let k = 0; k < out.length; k++) map.push(i);
    }
    i += size;
  }
  return { text, map };
}

/**
 * Lowercase and strip diacritics (Unicode NFKD with combining marks removed, plus a few letters such as
 * ø / ł / ß that do not decompose), keeping a map back to the original string.
 *
 *   normalizeText('Café')        → { text: 'cafe', map: [0, 1, 2, 3] }
 *   normalizeText('Café!') → { text: 'cafe!', map: [0, 1, 2, 3, 5] }
 *   normalizeText('Straße')      → { text: 'strasse', map: [0, 1, 2, 3, 4, 4, 5] }
 *
 * @param {string} str
 * @returns {{ text: string, map: number[] }} `map[i]` is the index in `str` of normalized char `i`.
 */
export function normalizeText(str) {
  const raw = toText(str);
  const { text, map } = normalizeInternal(raw);
  if (map) return { text, map };
  const identity = new Array(text.length);
  for (let i = 0; i < identity.length; i++) identity[i] = i;
  return { text, map: identity };
}

function toText(value) {
  if (typeof value === 'string') return value;
  return value == null ? '' : String(value);
}

// -----------------------------------------------------------------------------------------------------------
// Prepared fields & caches
// -----------------------------------------------------------------------------------------------------------

/**
 * Bucketed "which characters occur" bitmask. A token can only match a field contiguously or as a subsequence
 * when every bit of the token's mask is present in the field's mask (with one typo: all but one) — an O(1)
 * rejection for the vast majority of channels. Buckets: a–z one bit each, digits share 3 bits, other ASCII
 * 1 bit, non-ASCII 2 bits. Collisions only make the filter less selective, never wrong.
 */
function charBit(c) {
  if (c >= 97 && c <= 122) return 1 << (c - 97);
  if (isDigit(c)) return 1 << (26 + ((c - 48) % 3));
  if (c < 128) return 1 << 29;
  return c & 1 ? 1 << 30 : 1 << 31;
}

function maskOf(text) {
  let mask = 0;
  for (let i = 0; i < text.length; i++) mask |= charBit(text.charCodeAt(i));
  return mask;
}

/** True when the token's characters can all occur in the field (`slack` = 1 lets one bucket be missing). */
function maskAllows(tokMask, fieldMask, slack = 0) {
  const missing = tokMask & ~fieldMask;
  if (!missing) return true;
  return slack > 0 && (missing & (missing - 1)) === 0;
}

/** @typedef {{ raw: string, text: string, map: number[] | null, mask: number }} Field */

/** @returns {Field} */
function makeField(raw) {
  const { text, map } = normalizeInternal(raw);
  return { raw, text, map, mask: maskOf(text) };
}

/** Bounded cache for strings that repeat across channels (group names) and for fuzzyMatch() targets. */
const stringFields = new Map();

/** @returns {Field} */
function stringField(raw) {
  let field = stringFields.get(raw);
  if (!field) {
    field = makeField(raw);
    if (stringFields.size >= STRING_CACHE_MAX) stringFields.clear();
    stringFields.set(raw, field);
  }
  return field;
}

/**
 * Per-channel normalized fields. Channels are immutable; the raw name is re-checked anyway (one string
 * comparison) so a reused object can never serve stale data.
 * @type {WeakMap<object, { name: Field, tvgRaw: string | undefined, tvg: Field | null }>}
 */
const channelFields = new WeakMap();

function prepareChannel(channel) {
  const name = toText(channel.name);
  let prep = channelFields.get(channel);
  if (!prep || prep.name.raw !== name) {
    prep = { name: makeField(name), tvgRaw: undefined, tvg: null };
    channelFields.set(channel, prep);
  }
  return prep;
}

/** tvg-id field, normalized lazily (it is only consulted when the name is not a strong match). */
function tvgField(prep, channel) {
  const raw = toText(channel.tvgId);
  if (prep.tvgRaw !== raw) {
    prep.tvgRaw = raw;
    prep.tvg = raw ? makeField(raw) : null;
  }
  return prep.tvg;
}

const EMPTY = Object.freeze([]);

function channelGroups(channel) {
  if (Array.isArray(channel.groups) && channel.groups.length) return channel.groups;
  return typeof channel.group === 'string' && channel.group ? [channel.group] : EMPTY;
}

function channelNumber(channel) {
  const { chno } = channel;
  if (typeof chno === 'number') return Number.isFinite(chno) ? chno : null;
  if (typeof chno === 'string' && /^\d{1,9}$/.test(chno.trim())) return parseInt(chno, 10);
  return null;
}

// -----------------------------------------------------------------------------------------------------------
// Word boundaries
// -----------------------------------------------------------------------------------------------------------

function isWordAt(text, j) {
  if (j < 0 || j >= text.length) return false;
  const c = text.charCodeAt(j);
  if (c < 128) return (c >= 97 && c <= 122) || isDigit(c) || (c >= 65 && c <= 90);
  if (isLowSurrogate(c)) return j > 0 && isHighSurrogate(text.charCodeAt(j - 1)) && isWordAt(text, j - 1);
  return WORD_CHAR_RE.test(String.fromCodePoint(text.codePointAt(j)));
}

/** 1 = uppercase letter, -1 = lowercase letter, 0 = anything else (in the RAW string, for camelCase). */
function caseAt(raw, idx) {
  const c = raw.charCodeAt(idx);
  if (c >= 65 && c <= 90) return 1;
  if (c >= 97 && c <= 122) return -1;
  if (c < 128 || Number.isNaN(c)) return 0;
  const ch = raw[idx];
  if (UPPER_RE.test(ch)) return 1;
  return LOWER_RE.test(ch) ? -1 : 0;
}

/**
 * True when normalized position `j` starts a word: index 0, after any non-alphanumeric char (space - _ . | :
 * ( [ / …), at a letter↔digit transition ("BBC1"), or at a camelCase boundary in the raw string ("SkyNews",
 * "ESPNews" → "News").
 */
function isBoundary(field, j) {
  if (j <= 0) return true;
  const { text } = field;
  if (j >= text.length) return false;
  if (!isWordAt(text, j - 1)) return true;
  if (!isWordAt(text, j)) return false;
  if (isDigit(text.charCodeAt(j)) !== isDigit(text.charCodeAt(j - 1))) return true;
  const { map, raw } = field;
  const rc = map ? map[j] : j;
  const rp = map ? map[j - 1] : j - 1;
  if (rc === rp || caseAt(raw, rc) !== 1) return false;
  const prevCase = caseAt(raw, rp);
  if (prevCase === -1) return true; // fooBar
  if (prevCase === 1 && j + 1 < text.length && isWordAt(text, j + 1)) {
    const rn = map ? map[j + 1] : j + 1;
    return rn !== rc && caseAt(raw, rn) === -1; // FOOBar → "Bar"
  }
  return false;
}

/** True when a match ending right before normalized position `end` ends a whole word. */
function isWordEnd(field, end) {
  return end >= field.text.length || !isWordAt(field.text, end) || isBoundary(field, end);
}

// -----------------------------------------------------------------------------------------------------------
// Token matchers. Each returns null or a Hit with NORMALIZED positions: either the contiguous range
// [start, start + len) (positions === null) or explicit `positions`.
// -----------------------------------------------------------------------------------------------------------

/** @typedef {{ score: number, start: number, len: number, positions: number[] | null }} Hit */

const lengthPenalty = (n) => Math.min(n * LENGTH_PENALTY, MAX_LENGTH_PENALTY);

/** Exact / prefix / word-start prefix / substring. @returns {Hit | null} */
function contiguousMatch(tok, field) {
  const { text } = field;
  const n = text.length;
  const m = tok.length;
  if (m === 0 || m > n) return null;
  const pos = text.indexOf(tok);
  if (pos < 0) return null;
  if (pos === 0 && m === n) return { score: SCORE_EXACT, start: 0, len: m, positions: null };
  const ratio = (m / n) * RATIO_BONUS;
  const lenPen = lengthPenalty(n);
  if (pos === 0) {
    const whole = isWordEnd(field, m) ? WHOLE_WORD_BONUS : 0;
    return { score: BASE_PREFIX + ratio + whole - lenPen, start: 0, len: m, positions: null };
  }
  for (let p = pos; p >= 0; p = text.indexOf(tok, p + 1)) {
    if (!isBoundary(field, p)) continue;
    const whole = isWordEnd(field, p + m) ? WHOLE_WORD_BONUS : 0;
    const posPen = Math.min(p * 0.4, MAX_POSITION_PENALTY);
    return { score: BASE_WORD_START + ratio + whole - posPen - lenPen, start: p, len: m, positions: null };
  }
  const posPen = Math.min(pos * 0.5, MAX_POSITION_PENALTY);
  return { score: BASE_SUBSTRING + ratio - posPen - lenPen, start: pos, len: m, positions: null };
}

const charBonus = (field, j) => (isBoundary(field, j) ? (j === 0 ? BONUS_FIRST : BONUS_BOUNDARY) : 0);
const startPenalty = (j) => Math.min(j, MAX_START_CHARS) * START_PENALTY;

/** Raw alignment quality of explicit positions (the same formula the DP maximizes). */
function alignmentScore(positions, field) {
  let score = 0;
  let prev = -1;
  for (let i = 0; i < positions.length; i++) {
    const j = positions[i];
    score += charBonus(field, j);
    if (i === 0) score -= startPenalty(j);
    else if (j === prev + 1) score += BONUS_CONSECUTIVE;
    else score -= GAP_OPEN + GAP_EXTEND * (j - prev - 2);
    prev = j;
  }
  return score;
}

/** Map a raw alignment score into the subsequence tier. @returns {Hit} */
function subsequenceHit(rawScore, positions, n) {
  const m = positions.length;
  const quality = Math.min(1, Math.max(0, (rawScore / m + 4) / 13)); // ≈ -4…9 points per char → 0…1
  const floor = SUBSEQ_MIN + MAX_LENGTH_PENALTY;
  const score = floor + quality * (SUBSEQ_MAX - floor) - lengthPenalty(n);
  return { score, start: positions[0], len: 0, positions };
}

// Reusable DP buffers (the search is synchronous, so sharing them is safe).
const DP_SCORE = new Float64Array(MAX_SUBSEQ_TOKEN * MAX_DP_TARGET);
const DP_FROM = new Int16Array(MAX_SUBSEQ_TOKEN * MAX_DP_TARGET);
const DP_BONUS = new Float64Array(MAX_DP_TARGET);
const NEG = -Infinity;

/**
 * Best-scoring subsequence alignment of `tok` in `field.text` (fzf-v2-style DP with affine gaps), O(m·n).
 * Caller guarantees m ≤ MAX_SUBSEQ_TOKEN and n ≤ MAX_DP_TARGET.
 * @returns {{ score: number, positions: number[] } | null}
 */
function bestAlignment(tok, field) {
  const { text } = field;
  const n = text.length;
  const m = tok.length;
  for (let j = 0; j < n; j++) DP_BONUS[j] = charBonus(field, j);

  const c0 = tok.charCodeAt(0);
  for (let j = 0; j < n; j++) DP_SCORE[j] = text.charCodeAt(j) === c0 ? DP_BONUS[j] - startPenalty(j) : NEG;

  for (let i = 1; i < m; i++) {
    const row = i * n;
    const prevRow = row - n;
    const c = tok.charCodeAt(i);
    let run = NEG; // max over k ≤ j-2 of score[i-1][k] + GAP_EXTEND·k
    let runK = -1;
    for (let j = 0; j < n; j++) {
      if (j >= 2) {
        const v = DP_SCORE[prevRow + j - 2];
        if (v !== NEG && v + GAP_EXTEND * (j - 2) > run) {
          run = v + GAP_EXTEND * (j - 2);
          runK = j - 2;
        }
      }
      if (j < i || text.charCodeAt(j) !== c) {
        DP_SCORE[row + j] = NEG;
        continue;
      }
      let best = NEG;
      let from = -1;
      const diag = DP_SCORE[prevRow + j - 1];
      if (diag !== NEG) {
        best = diag + BONUS_CONSECUTIVE;
        from = j - 1;
      }
      if (runK >= 0) {
        const gapped = run - GAP_OPEN - GAP_EXTEND * (j - 2);
        if (gapped > best) {
          best = gapped;
          from = runK;
        }
      }
      DP_SCORE[row + j] = from < 0 ? NEG : best + DP_BONUS[j];
      DP_FROM[row + j] = from;
    }
  }

  const last = (m - 1) * n;
  let bestEnd = -1;
  let bestScore = NEG;
  for (let j = m - 1; j < n; j++) {
    if (DP_SCORE[last + j] > bestScore) {
      bestScore = DP_SCORE[last + j];
      bestEnd = j;
    }
  }
  if (bestEnd < 0) return null;
  const positions = new Array(m);
  for (let i = m - 1, j = bestEnd; i >= 0; i--) {
    positions[i] = j;
    if (i > 0) j = DP_FROM[i * n + j];
  }
  return { score: bestScore, positions };
}

/**
 * Most compact window [start, end] of `text` that contains `tok` as a subsequence: scan forward to the first
 * complete match, backward to that match's latest start, then repeat from the next start (bounded).
 * @returns {{ start: number, end: number } | null} null when `tok` is not a subsequence of `text`
 */
function compactWindow(tok, text) {
  const n = text.length;
  const m = tok.length;
  let best = null;
  let from = 0;
  for (let iter = 0; iter < MAX_WINDOWS && from < n; iter++) {
    let ti = 0;
    let j = from;
    for (; j < n; j++) if (text.charCodeAt(j) === tok.charCodeAt(ti) && ++ti === m) break;
    if (ti < m) break;
    const end = j;
    for (ti = m - 1; j >= from; j--) if (text.charCodeAt(j) === tok.charCodeAt(ti) && --ti < 0) break;
    if (!best || end - j < best.end - best.start) best = { start: j, end };
    if (end - j + 1 === m) break;
    from = j + 1;
  }
  return best;
}

/** Leftmost subsequence positions, scanning from `from`. */
function greedyPositions(tok, text, from) {
  const positions = [];
  for (let j = from, ti = 0; j < text.length && ti < tok.length; j++) {
    if (text.charCodeAt(j) === tok.charCodeAt(ti)) {
      positions.push(j);
      ti++;
    }
  }
  return positions.length === tok.length ? positions : null;
}

/** Every token char on a word start, in order ("nbc" → "National Broadcasting Company"). */
function acronymPositions(tok, field) {
  const { text } = field;
  const positions = [];
  for (let j = 0, ti = 0; j < text.length && ti < tok.length; j++) {
    if (text.charCodeAt(j) === tok.charCodeAt(ti) && isBoundary(field, j)) {
      positions.push(j);
      ti++;
    }
  }
  return positions.length === tok.length ? positions : null;
}

function allBoundaries(positions, field) {
  for (const p of positions) if (!isBoundary(field, p)) return false;
  return true;
}

const spanOf = (positions) => positions[positions.length - 1] - positions[0] + 1;

/** Max span of an accepted subsequence: 3×len + 6 for tokens ≥ 3 chars; 2-char tokens must be ~adjacent. */
const spanLimit = (m) => (m >= 3 ? 3 * m + 6 : 4);

/**
 * Fuzzy subsequence match with span rejection. Tokens shorter than 2 chars never match this way. A match
 * that is too spread out is only kept when every char starts a word (an acronym), within a wider bound.
 * @returns {Hit | null}
 */
function subsequenceMatch(tok, field) {
  const { text } = field;
  const n = text.length;
  const m = tok.length;
  if (m < 2 || m > MAX_SUBSEQ_TOKEN || m > n) return null;
  const win = compactWindow(tok, text);
  if (!win) return null;
  const limit = spanLimit(m);
  let positions;
  if (win.end - win.start + 1 > limit) {
    positions = acronymPositions(tok, field);
    if (!positions || spanOf(positions) > ACRONYM_SPAN_FACTOR * limit) return null;
  } else {
    const best = n <= MAX_DP_TARGET ? bestAlignment(tok, field) : null;
    if (best) {
      const span = spanOf(best.positions);
      if (span <= limit || (span <= ACRONYM_SPAN_FACTOR * limit && allBoundaries(best.positions, field))) {
        return subsequenceHit(best.score, best.positions, n);
      }
    }
    // The DP preferred a wider alignment (word-start hits) than allowed: fall back to the compact window.
    positions = greedyPositions(tok, text, win.start);
    if (!positions) return null;
  }
  return subsequenceHit(alignmentScore(positions, field), positions, n);
}

function sameRun(a, ai, b, bi, len) {
  if (bi + len > b.length) return false;
  for (let i = 0; i < len; i++) if (a.charCodeAt(ai + i) !== b.charCodeAt(bi + i)) return false;
  return true;
}

/**
 * Length of the text matched at `p` when `tok` equals text[p…] up to ONE adjacent transposition, one missing
 * char or one extra char; 0 when it does not.
 */
function oneEditPrefix(tok, text, p) {
  const m = tok.length;
  let k = 0;
  while (k < m && p + k < text.length && tok.charCodeAt(k) === text.charCodeAt(p + k)) k++;
  if (k === m) return m;
  if (
    k + 1 < m &&
    tok.charCodeAt(k) === text.charCodeAt(p + k + 1) &&
    tok.charCodeAt(k + 1) === text.charCodeAt(p + k) &&
    sameRun(tok, k + 2, text, p + k + 2, m - k - 2)
  ) {
    return m; // transposition: "epsn" → "espn"
  }
  if (sameRun(tok, k, text, p + k + 1, m - k)) return m + 1; // missing char: "dicovery" → "discovery"
  if (sameRun(tok, k + 1, text, p + k, m - k - 1)) return m - 1; // extra char: "disccovery" → "discovery"
  return 0;
}

/**
 * Cheap typo tolerance for tokens ≥ 4 chars: one adjacent transposition, one missing or one extra char,
 * checked only at word starts. Scores below every subsequence match. @returns {Hit | null}
 */
function typoMatch(tok, field) {
  const t = tok.text;
  const m = t.length;
  const { text } = field;
  const n = text.length;
  if (!tok.typo || n < m - 1 || !maskAllows(tok.mask, field.mask, 1)) return null;
  const c0 = t.charCodeAt(0);
  const c1 = t.charCodeAt(1);
  for (let p = 0; p <= n - (m - 1); p++) {
    const t0 = text.charCodeAt(p);
    // Any one-edit match starting at p needs one of these (keeps the scan cheap).
    if (t0 !== c0 && t0 !== c1 && text.charCodeAt(p + 1) !== c0) continue;
    if (!isBoundary(field, p)) continue;
    const len = oneEditPrefix(t, text, p);
    if (!len) continue;
    const score =
      TYPO_BASE + (p === 0 ? 15 : 0) + 15 * Math.min(1, m / n) - Math.min(p * 0.3, 10) - lengthPenalty(n) / 2;
    return { score, start: p, len: Math.min(len, n - p), positions: null };
  }
  return null;
}

/**
 * Contiguous tiers first, then subsequence (the tiers never overlap, so the first hit is the best). Secondary
 * fields (groups, tvg-id) need 3+ chars for a subsequence match: a 2-letter fuzzy hit on a group name like
 * "Entertainment" would otherwise pull in the whole group. @returns {Hit | null}
 */
function strictMatch(tok, field, secondary = false) {
  if (!maskAllows(tok.mask, field.mask)) return null;
  const hit = contiguousMatch(tok.text, field);
  if (hit || !tok.subseq || (secondary && tok.text.length < 3)) return hit;
  return subsequenceMatch(tok.text, field);
}

// -----------------------------------------------------------------------------------------------------------
// Query handling
// -----------------------------------------------------------------------------------------------------------

/**
 * @typedef {{ text: string, mask: number, subseq: boolean, typo: boolean, num: number | null }} Token
 * @typedef {{ tokens: Token[], phrase: string }} ParsedQuery
 */

/** @returns {ParsedQuery | null} null when the query is blank */
function parseQuery(query) {
  let raw = toText(query);
  if (raw.length > MAX_QUERY_LENGTH) raw = raw.slice(0, MAX_QUERY_LENGTH);
  const words = normalizeInternal(raw).text.split(WHITESPACE_RE).filter(Boolean);
  if (!words.length) return null;
  // Unique tokens, longest first: long tokens are the most selective, so non-matches are rejected sooner.
  const unique = [...new Set(words)].sort((a, b) => b.length - a.length);
  const tokens = unique.map((text) => {
    const num = NUMBER_TOKEN_RE.test(text) ? parseInt(text.replace('#', ''), 10) : null;
    return {
      text,
      mask: maskOf(text),
      subseq: text.length >= 2 && text.length <= MAX_SUBSEQ_TOKEN,
      // Numbers are looked up exactly: "#101" must not typo-match "Channel 1010".
      typo: num === null && text.length >= 4 && text.length <= MAX_TYPO_TOKEN,
      num,
    };
  });
  return { tokens, phrase: words.length > 1 ? words.join(' ') : '' };
}

function phraseBonus(parsed, field) {
  if (!parsed.phrase) return 0;
  const pos = field.text.indexOf(parsed.phrase);
  if (pos < 0) return 0;
  if (pos === 0) return field.text.length === parsed.phrase.length ? PHRASE_EXACT_BONUS : PHRASE_PREFIX_BONUS;
  return PHRASE_BONUS;
}

/**
 * Normalized hits → sorted, unique RAW indices. A normalized char covers its raw char plus any raw chars that
 * were dropped right after it (combining accents, zero-width chars), so "é" is highlighted as a whole.
 */
function hitsToIndices(hits, field) {
  const out = [];
  if (!hits || !hits.length) return out;
  const { map } = field;
  const push = (p) => {
    if (!map) {
      out.push(p);
      return;
    }
    const start = map[p];
    let k = p + 1;
    while (k < map.length && map[k] === start) k++;
    const end = k < map.length ? map[k] : field.raw.length;
    for (let r = start; r < end; r++) out.push(r);
  };
  for (const hit of hits) {
    if (hit.positions) for (const p of hit.positions) push(p);
    else for (let p = hit.start; p < hit.start + hit.len; p++) push(p);
  }
  if (hits.length === 1 && !map && !hits[0].positions) return out; // already sorted and unique
  out.sort((a, b) => a - b);
  let w = 0;
  for (let i = 0; i < out.length; i++) if (i === 0 || out[i] !== out[w - 1]) out[w++] = out[i];
  out.length = w;
  return out;
}

/**
 * Best weighted group score for token #ti, memoized per unique group string for the current search (group
 * names repeat across thousands of channels).
 */
function groupScore(tok, ti, channel, ctx, typo) {
  const groups = channelGroups(channel);
  if (!groups.length) return 0;
  const memo = (typo ? ctx.groupTypo : ctx.groupStrict)[ti];
  let best = 0;
  for (const group of groups) {
    if (typeof group !== 'string' || !group) continue;
    let score = memo.get(group);
    if (score === undefined) {
      const field = stringField(group);
      const hit = typo ? typoMatch(tok, field) : strictMatch(tok, field, true);
      score = hit ? hit.score * WEIGHT_GROUP : 0;
      memo.set(group, score);
    }
    if (score > best) best = score;
  }
  return best;
}

/**
 * Score one token against one channel: the best of its name (with typo fallback), chno, groups and tvg-id;
 * groups get a typo fallback only when nothing else matched. Returns 0 when nothing matched. Sets
 * `ctx.hit` to the NAME hit (or null), so the name is highlighted even when another field scored higher.
 */
function scoreToken(tok, ti, prep, channel, ctx) {
  let hit = strictMatch(tok, prep.name);
  if (!hit) hit = typoMatch(tok, prep.name);
  ctx.hit = hit;
  let score = hit ? hit.score : 0;

  if (tok.num !== null && score < SCORE_CHNO && channelNumber(channel) === tok.num) score = SCORE_CHNO;
  if (score < GROUP_CAP) score = Math.max(score, groupScore(tok, ti, channel, ctx, false));
  if (score < TVG_CAP) {
    const tvg = tvgField(prep, channel);
    const tvgHit = tvg ? strictMatch(tok, tvg, true) : null;
    if (tvgHit) score = Math.max(score, tvgHit.score * WEIGHT_TVG);
  }
  if (score === 0 && tok.typo) score = groupScore(tok, ti, channel, ctx, true);
  return score;
}

// -----------------------------------------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------------------------------------

/**
 * Match a query against a single string.
 *
 * The query is expected to be normalized already (lowercase, no diacritics); it is normalized again
 * defensively, which is idempotent. Multi-word queries require every word to match (AND).
 *
 * @param {string} query
 * @param {string} target raw (display) string
 * @returns {{ score: number, indices: number[] } | null} `indices` are positions in the RAW target (sorted,
 *   unique); null when some token does not match. A blank query matches everything with score 0.
 */
export function fuzzyMatch(query, target) {
  const parsed = parseQuery(query);
  if (!parsed) return { score: 0, indices: [] };
  const field = stringField(toText(target));
  let score = 0;
  const hits = [];
  for (const tok of parsed.tokens) {
    const hit = strictMatch(tok, field) || typoMatch(tok, field);
    if (!hit) return null;
    score += hit.score;
    hits.push(hit);
  }
  return { score: score + phraseBonus(parsed, field), indices: hitsToIndices(hits, field) };
}

/**
 * Search channels by name (and, weaker, groups / tvg-id / channel number). Every whitespace-separated query
 * token must match (AND).
 *
 * @param {Iterable<object>} channels
 * @param {string} query raw user input
 * @param {{ limit?: number }} [options]
 * @returns {Array<{ channel: object, score: number, indices: number[] }> | null}
 *   null when the query is blank. Sorted by score (desc); ties keep the input order. `indices` are
 *   positions in `channel.name` (empty when only a group / tvg-id / chno matched).
 */
export function searchChannels(channels, query, { limit = Infinity } = {}) {
  const parsed = parseQuery(query);
  if (!parsed) return null;
  const list = Array.isArray(channels) ? channels : Array.from(channels || []);
  const max = Number.isNaN(Number(limit)) ? Infinity : Math.max(0, Math.floor(Number(limit)));
  if (max === 0) return [];

  const { tokens } = parsed;
  const ctx = {
    hit: null,
    groupStrict: tokens.map(() => new Map()),
    groupTypo: tokens.map(() => new Map()),
  };
  const matches = [];

  for (let i = 0; i < list.length; i++) {
    const channel = list[i];
    if (!channel || typeof channel !== 'object') continue;
    const prep = prepareChannel(channel);
    let total = 0;
    let hits = null;
    let t = 0;
    for (; t < tokens.length; t++) {
      const score = scoreToken(tokens[t], t, prep, channel, ctx);
      if (score <= 0) break;
      total += score;
      if (ctx.hit) (hits ||= []).push(ctx.hit);
    }
    if (t < tokens.length) continue;
    const score = total + phraseBonus(parsed, prep.name);
    matches.push({ channel, score, hits, field: prep.name, order: i });
  }

  matches.sort((a, b) => b.score - a.score || a.order - b.order);
  const count = Math.min(matches.length, max);
  const results = new Array(count);
  for (let i = 0; i < count; i++) {
    const m = matches[i];
    results[i] = { channel: m.channel, score: m.score, indices: hitsToIndices(m.hits, m.field) };
  }
  return results;
}

/** Chars that must stay with the preceding char (low surrogate of a pair, combining marks). */
function isContinuation(str, j) {
  const c = str.charCodeAt(j);
  if (isLowSurrogate(c)) return isHighSurrogate(str.charCodeAt(j - 1));
  return c >= 0x300 && MARK_RE.test(str[j]);
}

/**
 * Render `text` with the given indices wrapped in `<mark class="hl">` runs (adjacent indices merged). Built
 * from text nodes only — safe for untrusted playlist strings. Out-of-range / duplicate / unsorted indices are
 * tolerated, and runs are widened so a surrogate pair or a combining accent is never split from its base
 * char.
 *
 * @param {string} text
 * @param {Iterable<number> | null | undefined} indices positions in `text`
 * @returns {DocumentFragment}
 */
export function highlight(text, indices) {
  const str = toText(text);
  const fragment = document.createDocumentFragment();
  if (!str) return fragment;
  const n = str.length;
  const marked = new Uint8Array(n);
  let any = false;
  if (indices && typeof indices[Symbol.iterator] === 'function') {
    for (const value of indices) {
      const i = Number(value);
      if (Number.isInteger(i) && i >= 0 && i < n) {
        marked[i] = 1;
        any = true;
      }
    }
  }
  if (!any) {
    fragment.append(document.createTextNode(str));
    return fragment;
  }
  for (let i = 0; i < n; i++) {
    if (!marked[i]) continue;
    if (i > 0 && isContinuation(str, i) && isLowSurrogate(str.charCodeAt(i))) marked[i - 1] = 1;
    for (let j = i + 1; j < n && !marked[j] && isContinuation(str, j); j++) marked[j] = 1;
  }
  for (let i = 0; i < n; ) {
    const on = marked[i];
    let j = i + 1;
    while (j < n && marked[j] === on) j++;
    const segment = str.slice(i, j);
    fragment.append(on ? h('mark', { class: 'hl' }, segment) : document.createTextNode(segment));
    i = j;
  }
  return fragment;
}
