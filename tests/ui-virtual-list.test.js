// Virtual list: the end inset (room for a bottom fade) — extra scroll space after the last row, and rows
// scrolled into view kept above it; the start inset (a top fade shown once scrolled) and data-scrolled.

import { afterEach, describe, expect, it } from 'vitest';
import { createVirtualList } from '../src/ui/virtual-list.js';

const ROW = 50;

function setup({ endInset, startInset, count = 100, viewport = 200 } = {}) {
  const vl = createVirtualList({
    rowHeight: ROW,
    endInset,
    startInset,
    renderRow: (item, index, el) => {
      const row = el || document.createElement('div');
      row.textContent = String(item);
      return row;
    },
  });
  // happy-dom has no layout: give the viewport a height.
  Object.defineProperty(vl.el, 'clientHeight', { configurable: true, get: () => viewport });
  document.body.append(vl.el);
  vl.setItems(Array.from({ length: count }, (_, i) => i));
  return vl;
}

let current = null;
afterEach(() => {
  current?.destroy();
  current = null;
  document.body.replaceChildren();
});

describe('virtual list end inset', () => {
  it('adds the inset after the last row', () => {
    current = setup({ endInset: 30 });
    expect(current.el.firstElementChild.style.height).toBe(`${100 * ROW + 30}px`);
  });

  it('keeps rows scrolled into view above the inset', () => {
    current = setup({ endInset: 30 });
    current.scrollToIndex(5); // row bottom at 300px; the clear part of the 200px viewport is 170px
    expect(current.el.scrollTop).toBe(300 - 170);
    current.scrollToIndex(99, 'end'); // the last row ends 30px above the viewport bottom
    expect(current.el.scrollTop).toBe(100 * ROW + 30 - 200);
    expect(current.pageSize()).toBe(Math.floor(170 / ROW) - 1);
  });

  it('behaves as before without an inset', () => {
    current = setup();
    expect(current.el.firstElementChild.style.height).toBe(`${100 * ROW}px`);
    current.scrollToIndex(5);
    expect(current.el.scrollTop).toBe(300 - 200);
    expect(current.pageSize()).toBe(Math.floor(200 / ROW) - 1);
  });

  it('adds no room to an empty list', () => {
    current = setup({ endInset: 30, count: 0 });
    expect(current.el.firstElementChild.style.height).toBe('0px');
  });
});

describe('virtual list start inset (top fade)', () => {
  const scrollTo = (vl, top) => {
    vl.el.scrollTop = top;
    vl.el.dispatchEvent(new Event('scroll'));
    vl.refresh(); // render now instead of on the next animation frame
  };

  it('marks the viewport data-scrolled only while it is scrolled', () => {
    current = setup({ startInset: 16 });
    expect(current.el.hasAttribute('data-scrolled')).toBe(false);
    scrollTo(current, 120);
    expect(current.el.hasAttribute('data-scrolled')).toBe(true);
    scrollTo(current, 0);
    expect(current.el.hasAttribute('data-scrolled')).toBe(false);
  });

  it('keeps rows scrolled into view below the inset', () => {
    current = setup({ startInset: 16, endInset: 30 });
    scrollTo(current, 1000); // rows 20… on screen
    current.scrollToIndex(10); // above the viewport: its top lands 16px below the viewport top
    expect(current.el.scrollTop).toBe(10 * ROW - 16);
    current.scrollToIndex(40); // below: it ends above the bottom inset
    expect(current.el.scrollTop).toBe(41 * ROW - (200 - 30));
    current.scrollToIndex(60, 'start');
    expect(current.el.scrollTop).toBe(60 * ROW - 16);
    expect(current.pageSize()).toBe(Math.floor((200 - 30 - 16) / ROW) - 1);
  });

  it('lets the first row start at the very top', () => {
    current = setup({ startInset: 16 });
    scrollTo(current, 300);
    current.scrollToIndex(0);
    expect(current.el.scrollTop).toBe(0);
    current.scrollToIndex(2); // already clear of the (now hidden) fade: no scroll
    expect(current.el.scrollTop).toBe(0);
  });
});
