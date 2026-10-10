// Logo art: reading a logo's pixels (opaque box, tone, matte edge) and fitting a loaded logo to its plate.

import { afterEach, describe, expect, it } from 'vitest';
import { analyseLogoPixels, fitLogo, peekLogoArt, resetLogo } from '../src/ui/logo-art.js';

/** An RGBA buffer of w×h filled with `bg`, with `fg` painted over the rect [x0, y0, x1, y1). */
function pixels(w, h, { bg = [0, 0, 0, 0], fg = null, rect = null } = {}) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const inside = rect && x >= rect[0] && x < rect[2] && y >= rect[1] && y < rect[3];
      data.set(inside ? fg : bg, (y * w + x) * 4);
    }
  }
  return data;
}

/** An <img> inside an avatar, with the natural size a loaded image would report. */
function loadedLogo(width, height) {
  const avatar = document.createElement('span');
  avatar.className = 'avatar';
  const img = document.createElement('img');
  Object.defineProperty(img, 'naturalWidth', { configurable: true, get: () => width });
  Object.defineProperty(img, 'naturalHeight', { configurable: true, get: () => height });
  avatar.append(img);
  document.body.append(avatar);
  return { avatar, img };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('analyseLogoPixels', () => {
  it('finds the opaque box of a wordmark with transparent margins', () => {
    const art = analyseLogoPixels(pixels(40, 20, { fg: [20, 20, 20, 255], rect: [4, 8, 30, 12] }), 40, 20);
    expect(art.box).toEqual([4 / 40, 8 / 20, 30 / 40, 12 / 20]);
    expect(art.fill).toBe(1);
    expect(art.coverage).toBeCloseTo((26 * 4) / 800, 5);
  });

  it('tells white, dark-ink and coloured transparent logos apart', () => {
    const rect = [4, 4, 16, 16];
    const of = (fg) => analyseLogoPixels(pixels(20, 20, { fg, rect }), 20, 20).tone;
    expect(of([255, 255, 255, 255])).toBe('light');
    expect(of([250, 214, 40, 255])).toBe('light'); // yellow: unreadable on a light plate
    expect(of([10, 12, 20, 255])).toBe('dark');
    expect(of([200, 30, 40, 255])).toBe('mid');
  });

  it('ignores faint pixels (anti-aliasing, glows)', () => {
    const data = pixels(20, 20, { bg: [255, 255, 255, 20], fg: [0, 0, 0, 255], rect: [5, 5, 15, 15] });
    const art = analyseLogoPixels(data, 20, 20);
    expect(art.box).toEqual([0.25, 0.25, 0.75, 0.75]);
    expect(art.tone).toBe('dark');
  });

  it('gives opaque images no tone, and an even edge colour as their matte', () => {
    const art = analyseLogoPixels(
      pixels(20, 10, { bg: [255, 255, 255, 255], fg: [200, 0, 0, 255], rect: [6, 3, 14, 7] }),
      20,
      10,
    );
    expect(art.tone).toBe('mid');
    expect(art.matte).toBe('rgb(255 255 255)');
    expect(art.box).toEqual([0, 0, 1, 1]);
  });

  it('has no matte when the edge is transparent or uneven', () => {
    const transparent = analyseLogoPixels(pixels(10, 10, { fg: [0, 0, 0, 255], rect: [2, 2, 8, 8] }), 10, 10);
    expect(transparent.matte).toBe('');
    // A left/right split edge: black and white halves.
    const split = analyseLogoPixels(
      pixels(10, 10, { bg: [255, 255, 255, 255], fg: [0, 0, 0, 255], rect: [0, 0, 5, 10] }),
      10,
      10,
    );
    expect(split.matte).toBe('');
  });

  it('returns the "none" result for empty or invalid input', () => {
    expect(analyseLogoPixels(pixels(8, 8), 8, 8).none).toBe(true);
    expect(analyseLogoPixels(null, 8, 8).none).toBe(true);
    expect(analyseLogoPixels(new Uint8ClampedArray(4), 8, 8).none).toBe(true);
  });
});

describe('fitLogo', () => {
  it('marks wide wordmarks from the natural size right away', () => {
    const wide = loadedLogo(420, 140);
    fitLogo(wide.avatar, wide.img, 'https://logos.example/wide.png');
    expect(wide.avatar.dataset.shape).toBe('wide');

    const square = loadedLogo(256, 256);
    fitLogo(square.avatar, square.img, 'https://logos.example/square.png');
    expect(square.avatar.dataset.shape).toBeUndefined();
  });

  it('does nothing for an image that has not loaded', () => {
    const { avatar, img } = loadedLogo(0, 0);
    fitLogo(avatar, img, 'https://logos.example/pending.png');
    expect(avatar.dataset.shape).toBeUndefined();
    expect(peekLogoArt('https://logos.example/pending.png')).toBeUndefined();
  });

  it('resetLogo clears everything fitLogo set', () => {
    const { avatar } = loadedLogo(420, 140);
    avatar.dataset.shape = 'wide';
    avatar.dataset.tone = 'light';
    avatar.dataset.fill = 'matte';
    avatar.style.setProperty('--logo-box', 'inset(1% 2% 3% 4%)');
    avatar.style.setProperty('--logo-matte', 'rgb(1 2 3)');
    resetLogo(avatar);
    expect(Object.keys(avatar.dataset)).toEqual([]);
    expect(avatar.style.getPropertyValue('--logo-box')).toBe('');
    expect(avatar.style.getPropertyValue('--logo-matte')).toBe('');
  });
});
