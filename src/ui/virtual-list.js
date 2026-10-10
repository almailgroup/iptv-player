// Virtualized vertical list with fixed-height rows.
//
// Only the rows inside the viewport (plus `overscan` rows above and below) exist in the DOM. Rows are
// absolutely positioned inside a sizer element (whose height is the full list height) with
// `transform: translateY(index × rowHeight)`, and row elements are recycled: when a row scrolls out of
// range its element is handed back to `renderRow` for the next index that needs one. Scroll and resize
// updates are batched into one requestAnimationFrame. Very long lists whose real height would exceed what
// browsers can lay out (~17.9M px in Firefox) are transparently "compressed": the sizer is capped and the
// scroll offset is mapped onto the virtual offset, so 300k+ rows still work. An optional `endInset` reserves
// room under the last row for a bottom fade (mask) on the viewport: rows scrolled into view stay clear of it;
// `startInset` does the same for a top fade, which the CSS shows only once the list is scrolled
// (`data-scrolled` on the viewport while scrollTop > 0).

import { h } from '../lib/dom.js';
import { clamp } from '../lib/utils.js';

/** Max sizer height in px. Above this the list switches to the compressed scroll mapping. */
const MAX_SCROLL_HEIGHT = 8_000_000;
/** Hidden recycled rows kept beyond the rendered range (avoids re-creating rows on resize/flick). */
const SPARE_ROWS = 12;

const raf =
  typeof requestAnimationFrame === 'function'
    ? requestAnimationFrame
    : (fn) => setTimeout(() => fn(Date.now()), 16);
const caf = typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : clearTimeout;

/**
 * Create a virtual list.
 *
 * `renderRow(item, index, rowEl)` is called with `rowEl === null` when a new element is needed, otherwise
 * with a previously rendered element (possibly one that showed a different item — reset everything that
 * depends on the item). It must return the row element (usually the same one). The list owns the row's
 * `position`, `top`, `left`, `width`, `height`, `transform` and `display` inline styles, and removes the
 * row's `id` while it sits unused in the recycle pool (so ids never collide) — set the id on every call.
 *
 * @template T
 * @param {{
 *   rowHeight: number,
 *   overscan?: number,
 *   renderRow: (item: T, index: number, rowEl: HTMLElement | null) => HTMLElement,
 *   getKey?: (item: T, index: number) => string,
 *   onRangeChange?: (range: { start: number, end: number, visibleStart: number, visibleEnd: number }) => void,
 *   className?: string,
 *   endInset?: number,
 *   startInset?: number,
 * }} options
 *   `endInset` (px): the bottom of the viewport that is covered (e.g. faded out). The list gets that much
 *   extra scroll room after its last row, and scrollToIndex() keeps rows above it.
 *   `startInset` (px): the same for the top of the viewport, covered only once the list is scrolled (the
 *   first row starts clear of it at scrollTop 0): scrollToIndex() keeps rows below it.
 * @returns {{
 *   el: HTMLElement,
 *   setItems: (items: T[], opts?: { keepScroll?: boolean }) => void,
 *   scrollToIndex: (index: number, align?: 'auto' | 'center' | 'start' | 'end') => void,
 *   refresh: () => void,
 *   getItems: () => T[],
 *   getRange: () => { start: number, end: number, visibleStart: number, visibleEnd: number },
 *   getRow: (index: number) => HTMLElement | null,
 *   indexOfKey: (key: string) => number,
 *   pageSize: () => number,
 *   destroy: () => void,
 * }}
 *   `range.start/end` = rendered rows [start, end); `visibleStart/visibleEnd` = first/last row (inclusive)
 *   that is at least partially inside the viewport (-1 when empty).
 */
export function createVirtualList(options) {
  const {
    rowHeight,
    overscan = 6,
    renderRow,
    getKey,
    onRangeChange,
    className,
    endInset = 0,
    startInset = 0,
  } = options || {};
  if (!(Number.isFinite(rowHeight) && rowHeight > 0)) {
    throw new TypeError('createVirtualList: rowHeight must be a positive number');
  }
  if (typeof renderRow !== 'function') throw new TypeError('createVirtualList: renderRow must be a function');
  const keyOf = typeof getKey === 'function' ? getKey : (_item, index) => String(index);
  const over = Math.max(0, Math.floor(overscan));
  const inset = Number.isFinite(endInset) && endInset > 0 ? endInset : 0;
  const topInset = Number.isFinite(startInset) && startInset > 0 ? startInset : 0;

  const sizer = h('div', {
    class: 'vl-sizer',
    role: 'none',
    style: { position: 'relative', width: '100%', height: '0px' },
  });
  const el = h(
    'div',
    {
      class: ['vl', className],
      // overflow-anchor: none — scroll anchoring must never "fix" our scrollTop when rows are recycled.
      style: { position: 'relative', overflowY: 'auto', overflowX: 'hidden', overflowAnchor: 'none' },
    },
    sizer,
  );

  /** @type {T[]} */
  let items = [];
  /** index -> row element currently showing that index */
  const mounted = new Map();
  /** recycled, hidden row elements */
  const pool = [];
  /** row element -> { index, item, y } */
  const rowInfo = new WeakMap();
  const prepared = new WeakSet();

  let viewportH = 0; // cached clientHeight from ResizeObserver (0 = unknown / hidden)
  let frame = 0;
  let destroyed = false;
  let keyIndex = null; // lazily built Map<key, index>
  /** scroll request made while the viewport had no size (hidden); applied on the next resize */
  let pendingScroll = null;
  let range = { start: 0, end: 0, visibleStart: 0, visibleEnd: -1 };
  let scrolled = false; // mirrored as data-scrolled (the CSS top fade)

  function viewportHeight() {
    if (viewportH > 0) return viewportH;
    const measured = el.clientHeight;
    if (measured > 0) return measured;
    // Not laid out yet (detached or display:none): render a screenful so the first paint isn't empty.
    return (typeof window !== 'undefined' && window.innerHeight) || 800;
  }

  /**
   * total = height of all rows; full = the virtual scroll height (rows + endInset); sizerH = the real one
   * (capped); `avail` = the part of the viewport between the start and end insets.
   */
  function metrics() {
    const total = items.length * rowHeight;
    const full = total > 0 ? total + inset : 0;
    const vh = viewportHeight();
    const sizerH = Math.min(full, MAX_SCROLL_HEIGHT);
    const scaled = full > sizerH && sizerH > vh;
    const ratio = scaled ? (full - vh) / (sizerH - vh) : 1;
    const avail = Math.max(rowHeight, vh - inset - topInset);
    return { total, full, vh, avail, sizerH, scaled, ratio };
  }

  function prepare(row) {
    if (prepared.has(row)) return;
    prepared.add(row);
    row.classList.add('vl-row');
    const s = row.style;
    s.position = 'absolute';
    s.top = '0px';
    s.left = '0px';
    s.width = '100%';
    s.height = `${rowHeight}px`;
  }

  function release(row) {
    rowInfo.delete(row);
    row.style.display = 'none';
    row.removeAttribute('id');
    pool.push(row);
  }

  function place(row, info, y) {
    if (info.y === y) return;
    info.y = y;
    row.style.transform = `translateY(${y}px)`;
  }

  /**
   * Bring the DOM in sync with scroll position and items.
   * @param {boolean} force re-render every rendered row even if its item did not change
   */
  function render(force) {
    if (frame) {
      caf(frame);
      frame = 0;
    }
    if (destroyed) return;
    const n = items.length;
    const m = metrics();
    const scrollTop = el.scrollTop;
    const virtualTop = m.scaled ? scrollTop * m.ratio : scrollTop;
    if (scrolled !== scrollTop > 0) {
      scrolled = scrollTop > 0;
      if (scrolled) el.dataset.scrolled = '';
      else delete el.dataset.scrolled;
    }
    // In compressed mode rows are placed relative to the current scroll offset.
    const offset = m.scaled ? scrollTop - virtualTop : 0;

    let visibleStart = 0;
    let visibleEnd = -1;
    if (n > 0) {
      visibleStart = clamp(Math.floor(virtualTop / rowHeight), 0, n - 1);
      visibleEnd = clamp(Math.ceil((virtualTop + m.vh) / rowHeight) - 1, visibleStart, n - 1);
    }
    const start = n > 0 ? Math.max(0, visibleStart - over) : 0;
    const end = n > 0 ? Math.min(n, visibleEnd + 1 + over) : 0;

    for (const [index, row] of mounted) {
      if (index < start || index >= end) {
        mounted.delete(index);
        release(row);
      }
    }

    for (let i = start; i < end; i++) {
      const item = items[i];
      const current = mounted.get(i);
      const info = current && rowInfo.get(current);
      if (current && info && !force && info.item === item) {
        place(current, info, i * rowHeight + offset);
        continue;
      }
      const reuse = current || pool.pop() || null;
      const row = renderRow(item, i, reuse);
      if (!row) {
        mounted.delete(i);
        if (reuse) release(reuse);
        continue;
      }
      if (reuse && row !== reuse) {
        reuse.remove();
        rowInfo.delete(reuse);
      }
      prepare(row);
      if (row.parentNode !== sizer) sizer.append(row);
      if (row.style.display) row.style.display = '';
      const prevInfo = rowInfo.get(row);
      const nextInfo = { index: i, item, y: prevInfo ? prevInfo.y : NaN };
      rowInfo.set(row, nextInfo);
      row.dataset.key = keyOf(item, i);
      mounted.set(i, row);
      place(row, nextInfo, i * rowHeight + offset);
    }

    // Keep a few spare rows for fast flicks / resizes; drop the rest.
    while (pool.length > SPARE_ROWS) pool.pop().remove();

    if (
      range.start !== start ||
      range.end !== end ||
      range.visibleStart !== visibleStart ||
      range.visibleEnd !== visibleEnd
    ) {
      range = { start, end, visibleStart, visibleEnd };
      onRangeChange?.({ ...range });
    }
  }

  function schedule() {
    if (frame || destroyed) return;
    frame = raf(() => {
      frame = 0;
      render(false);
    });
  }

  const onScroll = () => schedule();
  el.addEventListener('scroll', onScroll, { passive: true });

  let ro = null;
  const onWindowResize = () => measure();
  function measure() {
    if (destroyed) return;
    const next = el.clientHeight;
    if (next === viewportH) return;
    viewportH = next;
    if (next > 0 && pendingScroll) {
      const { index, align } = pendingScroll;
      pendingScroll = null;
      scrollToIndex(index, align);
      return;
    }
    schedule();
  }
  if (typeof ResizeObserver === 'function') {
    ro = new ResizeObserver(() => measure());
    ro.observe(el);
  } else if (typeof window !== 'undefined') {
    window.addEventListener('resize', onWindowResize);
  }

  /**
   * Replace the list items.
   * @param {T[]} next
   * @param {{ keepScroll?: boolean }} [opts] keepScroll: keep the scroll offset (clamped) instead of
   *   jumping back to the top.
   */
  function setItems(next, { keepScroll = false } = {}) {
    if (destroyed) return;
    items = Array.isArray(next) ? next : Array.from(next || []);
    keyIndex = null;
    const m = metrics();
    sizer.style.height = `${m.sizerH}px`;
    if (!keepScroll) {
      pendingScroll = null;
      if (el.scrollTop !== 0) el.scrollTop = 0;
    }
    render(true);
  }

  /**
   * Scroll so that row `index` is visible.
   * @param {number} index
   * @param {'auto'|'center'|'start'|'end'} [align] 'auto' scrolls the minimum amount (no-op when visible).
   */
  function scrollToIndex(index, align = 'auto') {
    if (destroyed) return;
    const n = items.length;
    if (!n || !Number.isFinite(index)) return;
    const i = clamp(Math.trunc(index), 0, n - 1);
    // Hidden or not laid out yet: browsers ignore scrollTop now, so also re-apply it on the next resize.
    pendingScroll = el.clientHeight === 0 ? { index: i, align } : null;
    const m = metrics();
    const scrollTop = el.scrollTop;
    const virtualTop = m.scaled ? scrollTop * m.ratio : scrollTop;
    // Offsets of the clear window, [virtualTop + topInset, virtualTop + topInset + avail], from the row.
    const top = i * rowHeight - topInset;
    const bottom = top + rowHeight;
    let target = null;
    if (align === 'start') target = top;
    else if (align === 'end') target = bottom - m.avail;
    else if (align === 'center') target = top - (m.avail - rowHeight) / 2;
    else if (top < virtualTop) target = top;
    else if (bottom > virtualTop + m.avail) target = bottom - m.avail;

    if (target !== null) {
      target = clamp(target, 0, Math.max(0, m.full - m.vh));
      const nextScroll = m.scaled ? target / m.ratio : target;
      if (Math.abs(nextScroll - scrollTop) >= 1) el.scrollTop = nextScroll;
    }
    render(false);
  }

  /** Re-render all rendered rows (call after external state that rows depend on changed). */
  function refresh() {
    if (destroyed) return;
    render(true);
  }

  function getRow(index) {
    return mounted.get(index) || null;
  }

  function indexOfKey(key) {
    if (!keyIndex) {
      keyIndex = new Map();
      for (let i = 0; i < items.length; i++) {
        const k = keyOf(items[i], i);
        if (!keyIndex.has(k)) keyIndex.set(k, i);
      }
    }
    const found = keyIndex.get(key);
    return found === undefined ? -1 : found;
  }

  /** Number of rows to move for PageUp / PageDown. */
  function pageSize() {
    return Math.max(1, Math.floor(metrics().avail / rowHeight) - 1);
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    if (frame) caf(frame);
    frame = 0;
    el.removeEventListener('scroll', onScroll);
    if (ro) ro.disconnect();
    else if (typeof window !== 'undefined') window.removeEventListener('resize', onWindowResize);
    mounted.clear();
    pool.length = 0;
    items = [];
    keyIndex = null;
  }

  return {
    el,
    setItems,
    scrollToIndex,
    refresh,
    getItems: () => items,
    getRange: () => ({ ...range }),
    getRow,
    indexOfKey,
    pageSize,
    destroy,
  };
}
