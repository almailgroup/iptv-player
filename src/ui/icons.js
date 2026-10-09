// Inline SVG icon set (24×24 grid, 2px round strokes). Built with createElementNS — no innerHTML.

const SVG_NS = 'http://www.w3.org/2000/svg';

// Shape shorthands: [tag, attrs]. `fill: true` fills the shape with currentColor instead of stroking it.
const p = (d, extra) => ['path', { d, ...extra }];
const c = (cx, cy, r, extra) => ['circle', { cx, cy, r, ...extra }];
const r = (x, y, width, height, rx = 0, extra) => ['rect', { x, y, width, height, rx, ...extra }];
const FILL = { fill: 'currentColor', stroke: 'none' };

const SPEAKER = p('M11 5 6 9H2v6h4l5 4V5z');

export const ICONS = {
  logo: [r(2, 4, 20, 14, 3), p('M10 8.6v5.8l5-2.9z', FILL), p('M8 21h8')],
  play: [p('M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5z', FILL)],
  pause: [r(6, 4, 4, 16, 1, FILL), r(14, 4, 4, 16, 1, FILL)],
  'volume-high': [SPEAKER, p('M15.5 8.5a5 5 0 0 1 0 7'), p('M19 5a10 10 0 0 1 0 14')],
  'volume-low': [SPEAKER, p('M15.5 8.5a5 5 0 0 1 0 7')],
  'volume-mute': [SPEAKER, p('m22 9-6 6'), p('m16 9 6 6')],
  fullscreen: [
    p('M8 3H5a2 2 0 0 0-2 2v3'),
    p('M21 8V5a2 2 0 0 0-2-2h-3'),
    p('M3 16v3a2 2 0 0 0 2 2h3'),
    p('M16 21h3a2 2 0 0 0 2-2v-3'),
  ],
  'fullscreen-exit': [
    p('M8 3v3a2 2 0 0 1-2 2H3'),
    p('M21 8h-3a2 2 0 0 1-2-2V3'),
    p('M3 16h3a2 2 0 0 1 2 2v3'),
    p('M16 21v-3a2 2 0 0 1 2-2h3'),
  ],
  pip: [r(2, 4, 20, 16, 2), r(12, 11, 7, 6, 1, FILL)],
  star: [p('M12 2.5l2.94 5.96 6.56.95-4.75 4.63 1.12 6.53L12 17.5l-5.87 3.07 1.12-6.53L2.5 9.41l6.56-.95L12 2.5z')],
  'star-filled': [
    p('M12 2.5l2.94 5.96 6.56.95-4.75 4.63 1.12 6.53L12 17.5l-5.87 3.07 1.12-6.53L2.5 9.41l6.56-.95L12 2.5z', {
      fill: 'currentColor',
    }),
  ],
  search: [c(11, 11, 7.5), p('m20.5 20.5-4.2-4.2')],
  plus: [p('M12 5v14'), p('M5 12h14')],
  upload: [p('M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4'), p('m17 8-5-5-5 5'), p('M12 3v12')],
  download: [p('M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4'), p('m7 10 5 5 5-5'), p('M12 15V3')],
  link: [
    p('M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71'),
    p('M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71'),
  ],
  trash: [
    p('M3 6h18'),
    p('M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6'),
    p('M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2'),
  ],
  refresh: [p('M21 12a9 9 0 1 1-2.64-6.36'), p('M21 3v6h-6')],
  settings: [
    p('M4 21v-7'),
    p('M4 10V3'),
    p('M12 21v-9'),
    p('M12 8V3'),
    p('M20 21v-5'),
    p('M20 12V3'),
    p('M1 14h6'),
    p('M9 8h6'),
    p('M17 16h6'),
  ],
  palette: [
    p('M12 22a10 10 0 1 1 10-10c0 2.2-1.8 3.5-4 3.5h-1.6a1.9 1.9 0 0 0-1.4 3.2A1.9 1.9 0 0 1 12 22z'),
    c(7.5, 10.5, 1.3, FILL),
    c(10.5, 6.5, 1.3, FILL),
    c(15.5, 7, 1.3, FILL),
    c(17.5, 11.5, 1.3, FILL),
  ],
  close: [p('M18 6 6 18'), p('m6 6 12 12')],
  menu: [p('M3 6h18'), p('M3 12h18'), p('M3 18h18')],
  'chevron-down': [p('m6 9 6 6 6-6')],
  'chevron-up': [p('m18 15-6-6-6 6')],
  'chevron-left': [p('m15 18-6-6 6-6')],
  'chevron-right': [p('m9 18 6-6-6-6')],
  'skip-back': [p('M19 20 9 12l10-8v16z', FILL), p('M5 19V5')],
  'skip-forward': [p('M5 4l10 8-10 8V4z', FILL), p('M19 5v14')],
  tv: [r(2, 7, 20, 15, 2), p('m17 2-5 5-5-5')],
  alert: [
    p('M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z'),
    p('M12 9v4'),
    p('M12 17h.01'),
  ],
  'wifi-off': [
    p('m2 2 20 20'),
    p('M8.5 16.5a5 5 0 0 1 7 0'),
    p('M2 8.82a15 15 0 0 1 4.17-2.65'),
    p('M10.66 5c4.01-.36 8.14.9 11.34 3.76'),
    p('M16.85 11.25a10 10 0 0 1 2.22 1.68'),
    p('M5 13a10 10 0 0 1 5.24-2.76'),
    p('M12 20h.01'),
  ],
  keyboard: [
    r(2, 5, 20, 14, 2),
    p('M6 9h.01'),
    p('M10 9h.01'),
    p('M14 9h.01'),
    p('M18 9h.01'),
    p('M6 13h.01'),
    p('M18 13h.01'),
    p('M10 13h4'),
    p('M7 16h10'),
  ],
  sun: [
    c(12, 12, 4),
    p('M12 2v2'),
    p('M12 20v2'),
    p('m4.93 4.93 1.41 1.41'),
    p('m17.66 17.66 1.41 1.41'),
    p('M2 12h2'),
    p('M20 12h2'),
    p('m6.34 17.66-1.41 1.41'),
    p('m19.07 4.93-1.41 1.41'),
  ],
  moon: [p('M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z')],
  layers: [p('m12 2 10 5-10 5L2 7l10-5z'), p('m2 17 10 5 10-5'), p('m2 12 10 5 10-5')],
  check: [p('M20 6 9 17l-5-5')],
  edit: [p('M12 20h9'), p('M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z')],
  folder: [
    p(
      'M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2z',
    ),
  ],
  clock: [c(12, 12, 10), p('M12 6v6l4 2')],
  list: [p('M8 6h13'), p('M8 12h13'), p('M8 18h13'), p('M3 6h.01'), p('M3 12h.01'), p('M3 18h.01')],
  grid: [r(3, 3, 7, 7, 1), r(14, 3, 7, 7, 1), r(14, 14, 7, 7, 1), r(3, 14, 7, 7, 1)],
  info: [c(12, 12, 10), p('M12 16v-4'), p('M12 8h.01')],
  copy: [r(9, 9, 13, 13, 2), p('M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1')],
  external: [p('M15 3h6v6'), p('M10 14 21 3'), p('M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6')],
  code: [p('m16 18 6-6-6-6'), p('m8 6-6 6 6 6')],
  sort: [p('m3 16 4 4 4-4'), p('M7 20V4'), p('m21 8-4-4-4 4'), p('M17 4v16')],
  filter: [p('M22 3H2l8 9.46V19l4 2v-8.54L22 3z')],
  broadcast: [
    p('M4.9 19.1C1 15.2 1 8.8 4.9 4.9'),
    p('M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5'),
    c(12, 12, 2),
    p('M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5'),
    p('M19.1 4.9C23 8.8 23 15.1 19.1 19'),
  ],
  loader: [p('M21 12a9 9 0 1 1-6.22-8.56')],
  file: [p('M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z'), p('M14 2v6h6')],
  more: [c(5, 12, 1.5, FILL), c(12, 12, 1.5, FILL), c(19, 12, 1.5, FILL)],
  'rotate-ccw': [p('M3 12a9 9 0 1 0 3-6.7L3 8'), p('M3 3v5h5')],
  'rotate-cw': [p('M21 12a9 9 0 1 1-3-6.7L21 8'), p('M21 3v5h-5')],
  activity: [p('M22 12h-4l-3 9L9 3l-3 9H2')],
  'arrow-right': [p('M5 12h14'), p('m12 5 7 7-7 7')],
};

/**
 * Create an SVG icon element.
 * @param {keyof ICONS} name
 * @param {{ size?: number, class?: string, title?: string, strokeWidth?: number }} [opts]
 * @returns {SVGSVGElement}
 */
export function icon(name, opts = {}) {
  const { size = 18, title, strokeWidth = 2 } = opts;
  const shapes = ICONS[name];
  if (!shapes) throw new Error(`Unknown icon: ${name}`);
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', String(strokeWidth));
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('class', ['icon', `icon-${name}`, opts.class].filter(Boolean).join(' '));
  svg.setAttribute('focusable', 'false');
  if (title) {
    svg.setAttribute('role', 'img');
    const t = document.createElementNS(SVG_NS, 'title');
    t.textContent = title;
    svg.append(t);
  } else {
    svg.setAttribute('aria-hidden', 'true');
  }
  for (const [tag, attrs] of shapes) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    svg.append(node);
  }
  return svg;
}

/** Swap the icon inside a container (e.g. a button) in place. */
export function setIcon(container, name, opts) {
  const next = icon(name, opts);
  const current = container.querySelector(':scope > svg.icon');
  if (current) current.replaceWith(next);
  else container.prepend(next);
  return next;
}
