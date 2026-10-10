// Logo art: fits a channel logo (<img> inside a base.css .avatar plate) to its plate.
//
// Real tvg-logo images are transparent PNGs of any aspect ratio, often with wide transparent margins, and
// sometimes drawn in white for dark backgrounds. Once a logo has loaded, fitLogo():
//  - marks wide wordmarks (data-shape="wide") from naturalWidth / naturalHeight, so they get less padding;
//  - samples the logo once per URL, in idle time: a second, CORS-mode Image is drawn into a tiny canvas
//    and its pixels give the opaque bounding box (--logo-box, used as object-view-box to trim transparent
//    margins), the mean luminance of the opaque pixels (data-tone: "light" logos get a dark plate, "dark"
//    ones are told apart for the dimmed-row style) and, for opaque images, a solid edge colour (data-fill=
//    "matte": the plate takes it, so a logo on its own white or coloured box sits seamlessly). Near-square
//    logos that are solid inside their box (app-icon style) fill the whole avatar (data-fill="bleed").
// Hosts that send no CORS headers can't be sampled (the canvas would be tainted): those logos keep the
// light plate. Results are cached by URL, so recycled list rows apply them synchronously; only logos that
// are still on screen when their turn comes are sampled, a few at a time.

/** Long side of the sampling canvas, px (the box is then accurate to ~2%). */
const SAMPLE_SIZE = 48;
/** A pixel counts as part of the logo from this alpha (0–255): anti-aliasing fringes and faint glows don't. */
const ALPHA_MIN = 40;
/** CORS sample downloads in flight at once. */
const MAX_ACTIVE = 3;
/** Cached results (by URL); the oldest are dropped beyond this. */
const MAX_ENTRIES = 3000;
/** Logos waiting for a sample; during a long fling the oldest (long off screen) are dropped. */
const MAX_QUEUE = 120;
const SAMPLE_TIMEOUT_MS = 8000;
/** Aspect ratio (of the trimmed logo) from which it is drawn as a wide wordmark. */
const WIDE_RATIO = 1.6;
/** Mean linear luminance of the opaque pixels above which a logo is "light" (white / pale) … */
const LIGHT_LUMA = 0.5;
/** … and below which it is "dark" ink. */
const DARK_LUMA = 0.08;

/** No usable sample (CORS refused, broken image, nothing opaque): the logo keeps the default plate. */
const NONE = Object.freeze({ none: true });

/** sRGB channel (0–255) -> linear light, for relative luminance. */
const LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  LINEAR[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

const results = new Map(); // url -> frozen art | NONE
const waiting = new Map(); // url -> Set<{ avatar, img }> still interested in it
const queue = []; // urls to sample (unique), newest last: the newest are the rows on screen now
const inflight = new Set(); // urls being sampled
let active = 0;
let pumpHandle = 0;
let canvas = null; // the sampling canvas; false when there is no 2D canvas
let ctx = null;
let viewBoxSupport = null;

const ric =
  typeof requestIdleCallback === 'function'
    ? (fn) => requestIdleCallback(fn, { timeout: 1200 })
    : (fn) => setTimeout(fn, 80);

/** A 2D canvas to sample with (none in test DOMs): created once; without it logos are never sampled. */
function sampler() {
  if (canvas === null) {
    try {
      canvas = document.createElement('canvas');
      ctx = canvas.getContext('2d', { willReadFrequently: true }) || null;
    } catch {
      ctx = null;
    }
    if (!ctx) canvas = false;
  }
  return ctx;
}

function supportsViewBox() {
  if (viewBoxSupport === null) {
    try {
      viewBoxSupport = typeof CSS !== 'undefined' && CSS.supports('object-view-box', 'inset(1% 2% 3% 4%)');
    } catch {
      viewBoxSupport = false;
    }
  }
  return viewBoxSupport;
}

/**
 * Read a logo's art from RGBA pixels (exported for tests).
 * @param {Uint8ClampedArray | Uint8Array | number[]} data RGBA, row-major
 * @param {number} w
 * @param {number} h
 * @returns {{ box: number[], fill: number, coverage: number, luma: number, tone: string, matte: string } | typeof NONE}
 *   box = [left, top, right, bottom] as fractions of the image; fill = opaque share of the box;
 *   coverage = opaque share of the image; luma = mean linear luminance of the opaque pixels (alpha-weighted);
 *   tone = 'light' | 'dark' | 'mid' (only for logos with real transparency, else 'mid'); matte = the edge
 *   colour as "rgb(r g b)" when the image is opaque all around its edge in one even colour, else ''.
 */
export function analyseLogoPixels(data, w, h) {
  if (!data || !(w > 0) || !(h > 0) || data.length < w * h * 4) return NONE;
  let opaque = 0;
  let weight = 0;
  let luma = 0;
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  // Edge ring: is the image opaque all around, and in one even colour?
  let edge = 0;
  let edgeOpaque = 0;
  let er = 0;
  let eg = 0;
  let eb = 0;
  let er2 = 0;
  let eg2 = 0;
  let eb2 = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const a = data[i + 3];
      const onEdge = x === 0 || y === 0 || x === w - 1 || y === h - 1;
      if (onEdge) edge++;
      if (a < ALPHA_MIN) continue;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      opaque++;
      const k = a / 255;
      weight += k;
      luma += k * (0.2126 * LINEAR[r] + 0.7152 * LINEAR[g] + 0.0722 * LINEAR[b]);
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (onEdge && a >= 250) {
        edgeOpaque++;
        er += r;
        eg += g;
        eb += b;
        er2 += r * r;
        eg2 += g * g;
        eb2 += b * b;
      }
    }
  }
  if (!opaque || !(weight > 0)) return NONE;
  const coverage = opaque / (w * h);
  const fill = opaque / ((x1 - x0 + 1) * (y1 - y0 + 1));
  const mean = luma / weight;
  const transparent = coverage < 0.9;
  const tone = !transparent ? 'mid' : mean > LIGHT_LUMA ? 'light' : mean < DARK_LUMA ? 'dark' : 'mid';
  let matte = '';
  if (edgeOpaque >= edge * 0.98) {
    const n = edgeOpaque;
    const mr = er / n;
    const mg = eg / n;
    const mb = eb / n;
    const spread = Math.sqrt(Math.max(0, er2 / n - mr * mr, eg2 / n - mg * mg, eb2 / n - mb * mb));
    if (spread < 14) matte = `rgb(${Math.round(mr)} ${Math.round(mg)} ${Math.round(mb)})`;
  }
  return Object.freeze({
    box: [x0 / w, y0 / h, (x1 + 1) / w, (y1 + 1) / h],
    fill,
    coverage,
    luma: mean,
    tone,
    matte,
  });
}

/** Sample a loaded CORS image (throws when the canvas is tainted, i.e. the host sent no CORS headers). */
function sampleImage(image) {
  const w = image.naturalWidth;
  const h = image.naturalHeight;
  if (!(w > 0 && h > 0) || !sampler()) return NONE;
  const scale = SAMPLE_SIZE / Math.max(w, h);
  const cw = Math.max(1, Math.round(w * scale));
  const ch = Math.max(1, Math.round(h * scale));
  canvas.width = cw;
  canvas.height = ch;
  ctx.clearRect(0, 0, cw, ch);
  ctx.drawImage(image, 0, 0, cw, ch);
  return analyseLogoPixels(ctx.getImageData(0, 0, cw, ch).data, cw, ch);
}

function remember(url, art) {
  if (results.size >= MAX_ENTRIES) results.delete(results.keys().next().value);
  results.set(url, art);
}

const isLive = ({ avatar, img }) => img.parentNode === avatar && avatar.isConnected;

function liveSubscribers(url) {
  const subs = waiting.get(url);
  if (!subs) return null;
  for (const sub of subs) if (!isLive(sub)) subs.delete(sub);
  if (!subs.size) {
    waiting.delete(url);
    return null;
  }
  return subs;
}

function finish(url, art) {
  active--;
  inflight.delete(url);
  remember(url, art);
  const subs = liveSubscribers(url);
  waiting.delete(url);
  if (subs) for (const { avatar, img } of subs) applyArt(avatar, img, art);
  schedule();
}

function startSample(url) {
  active++;
  inflight.add(url);
  const image = new Image();
  let settled = false;
  const settle = (art) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    image.onload = null;
    image.onerror = null;
    if (!image.complete) image.removeAttribute('src');
    finish(url, art);
  };
  const timer = setTimeout(() => settle(NONE), SAMPLE_TIMEOUT_MS);
  image.onload = () => {
    let art = NONE;
    try {
      art = sampleImage(image);
    } catch {
      art = NONE; // tainted canvas: no CORS headers on this host
    }
    settle(art);
  };
  image.onerror = () => settle(NONE);
  image.crossOrigin = 'anonymous';
  image.referrerPolicy = 'no-referrer';
  image.decoding = 'async';
  image.src = url;
}

function pump(deadline) {
  pumpHandle = 0;
  while (active < MAX_ACTIVE && queue.length) {
    if (deadline && typeof deadline.timeRemaining === 'function' && !deadline.didTimeout) {
      if (deadline.timeRemaining() < 2) break;
    }
    const url = queue.pop();
    if (results.has(url)) {
      const subs = liveSubscribers(url);
      waiting.delete(url);
      if (subs) for (const { avatar, img } of subs) applyArt(avatar, img, results.get(url));
      continue;
    }
    if (inflight.has(url)) continue; // its subscribers are told when that sample lands
    if (!liveSubscribers(url)) continue; // scrolled away before its turn
    startSample(url);
  }
  if (queue.length) schedule();
}

function schedule() {
  if (pumpHandle || !queue.length || active >= MAX_ACTIVE) return;
  pumpHandle = ric(pump) || 1;
}

function request(url, avatar, img) {
  let subs = waiting.get(url);
  if (!subs) {
    subs = new Set();
    waiting.set(url, subs);
  }
  subs.add({ avatar, img });
  const at = queue.lastIndexOf(url);
  if (at !== -1) queue.splice(at, 1);
  queue.push(url);
  // Keep the queue bounded during long flings: the oldest entries are long off screen.
  if (queue.length > MAX_QUEUE) {
    for (const old of queue.splice(0, queue.length - MAX_QUEUE)) if (!inflight.has(old)) waiting.delete(old);
  }
  schedule();
}

const pct = (n) => `${Math.max(0, Math.round(n * 1000) / 10)}%`;

/** The plate's look from the natural aspect alone (no sample, or not yet). */
function applyShape(avatar, ratio) {
  if (ratio >= WIDE_RATIO) avatar.dataset.shape = 'wide';
  else delete avatar.dataset.shape;
}

function applyArt(avatar, img, art) {
  if (!art || art.none) return;
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  if (!(w > 0 && h > 0)) return;
  // The opaque box plus one sample pixel of margin, so anti-aliased edges aren't cut; trimmed only when
  // that takes off more than a sliver.
  const m = 1 / SAMPLE_SIZE;
  const [l, t, r, b] = art.box;
  const cut = [Math.max(0, l - m), Math.max(0, t - m), Math.min(1, r + m), Math.min(1, b + m)];
  const trims = supportsViewBox() && Math.max(cut[0], cut[1], 1 - cut[2], 1 - cut[3]) >= 0.02;
  const box = trims ? cut : [0, 0, 1, 1];
  if (trims) {
    avatar.style.setProperty(
      '--logo-box',
      `inset(${pct(box[1])} ${pct(1 - box[2])} ${pct(1 - box[3])} ${pct(box[0])})`,
    );
  } else avatar.style.removeProperty('--logo-box');
  const ratio = (w * (box[2] - box[0])) / (h * (box[3] - box[1]));
  applyShape(avatar, ratio);
  // App-icon style (a solid, near-square shape filling its box): edge to edge, no plate around it. Without
  // object-view-box support only when it already fills the image.
  const square = ratio > 0.8 && ratio < 1.25;
  const solid = art.fill >= 0.9 && (trims || art.coverage >= 0.85);
  if (square && solid) avatar.dataset.fill = 'bleed';
  else if (art.matte) {
    avatar.dataset.fill = 'matte';
    avatar.style.setProperty('--logo-matte', art.matte);
  } else delete avatar.dataset.fill;
  avatar.dataset.tone = art.tone;
}

/**
 * Fit a loaded logo to its plate (see the file header). Call it from the <img>'s load event (and right away
 * when the image is already complete). The avatar must be the img's parent; when the img has been replaced
 * by the time a sample arrives, the sample is only cached.
 * @param {HTMLElement} avatar the .avatar element
 * @param {HTMLImageElement} img its logo image
 * @param {string} url the logo URL (the cache key; normally img.src)
 */
export function fitLogo(avatar, img, url) {
  if (!avatar || !img || !url) return;
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  if (!(w > 0 && h > 0)) return;
  const art = results.get(url);
  if (art) {
    if (art.none) applyShape(avatar, w / h);
    else applyArt(avatar, img, art);
    return;
  }
  applyShape(avatar, w / h);
  if (typeof Image !== 'function' || !sampler()) return;
  request(url, avatar, img);
}

/** Clear what fitLogo() set (for an avatar that is about to show another logo or initials). */
export function resetLogo(avatar) {
  if (!avatar) return;
  delete avatar.dataset.shape;
  delete avatar.dataset.tone;
  delete avatar.dataset.fill;
  avatar.style.removeProperty('--logo-box');
  avatar.style.removeProperty('--logo-matte');
}

/** The cached sample for a logo URL: an art object, `{ none: true }`, or undefined when not sampled yet. */
export function peekLogoArt(url) {
  return results.get(url);
}
