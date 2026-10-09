// Tiny DOM helpers. Never use innerHTML with untrusted (playlist) data — use h() / text nodes.

/**
 * Create an element.
 *
 *   h('button', { class: 'btn', type: 'button', onClick: fn, 'aria-label': 'Play' }, icon('play'), 'Play')
 *
 * Props:
 *  - class / className: string, or array of strings (falsy entries ignored)
 *  - style: string or object ({ '--row-h': '56px', width: '10px' })
 *  - dataset: object -> data-* attributes
 *  - on<Event>: function -> addEventListener('<event>') (e.g. onClick, onKeydown, onPointerdown)
 *  - text: sets textContent
 *  - ref: function called with the element
 *  - value / checked / disabled / hidden / selected / tabIndex / htmlFor / id: set as DOM properties
 *  - aria-* / role: always set as strings (aria-pressed: false -> "false")
 *  - anything else: setAttribute (booleans: true -> "", false/null/undefined -> omitted)
 * Children: strings/numbers (text nodes), Nodes, arrays (flattened); null/undefined/false are skipped.
 */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  applyProps(el, props);
  append(el, children);
  return el;
}

const DOM_PROPS = new Set([
  'value',
  'checked',
  'disabled',
  'hidden',
  'selected',
  'tabIndex',
  'htmlFor',
  'id',
  'title',
  'type',
  'name',
  'placeholder',
  'autocomplete',
  'spellcheck',
  'multiple',
  'accept',
  'min',
  'max',
  'step',
  'src',
  'href',
  'alt',
  'loading',
  'decoding',
  'draggable',
]);

export function applyProps(el, props) {
  if (!props) return el;
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null) continue;
    if (key === 'class' || key === 'className') {
      const cls = Array.isArray(value) ? value.filter(Boolean).join(' ') : value;
      if (cls) el.setAttribute('class', cls);
    } else if (key === 'style') {
      if (typeof value === 'string') el.style.cssText = value;
      else
        for (const [prop, v] of Object.entries(value)) {
          if (v === undefined || v === null) continue;
          if (prop.startsWith('--')) el.style.setProperty(prop, String(v));
          else el.style[prop] = v;
        }
    } else if (key === 'dataset') {
      for (const [k, v] of Object.entries(value)) if (v !== undefined && v !== null) el.dataset[k] = v;
    } else if (key === 'text') {
      el.textContent = value;
    } else if (key === 'ref') {
      value(el);
    } else if (key.length > 2 && key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (DOM_PROPS.has(key) && !(el instanceof SVGElement)) {
      if (value !== false || key === 'checked' || key === 'disabled' || key === 'hidden' || key === 'selected')
        el[key] = value;
    } else if (key.startsWith('aria-') || key === 'role') {
      el.setAttribute(key, String(value)); // aria-pressed={false} must render "false"
    } else if (value === true) {
      el.setAttribute(key, '');
    } else if (value !== false) {
      el.setAttribute(key, String(value));
    }
  }
  return el;
}

export function append(parent, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false || child === true) continue;
    parent.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return parent;
}

/** Remove all children. */
export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

/** Replace all children of `el`. */
export function replaceChildren(el, ...children) {
  clear(el);
  return append(el, children);
}

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

/** addEventListener that returns an unsubscribe function. */
export function on(target, type, handler, options) {
  target.addEventListener(type, handler, options);
  return () => target.removeEventListener(type, handler, options);
}

/** Toggle a boolean attribute or class quickly. */
export function toggleClass(el, cls, force) {
  el.classList.toggle(cls, force);
}

/** Set a data-* attribute, removing it when value is null/undefined/false. */
export function setData(el, key, value) {
  if (value === null || value === undefined || value === false) delete el.dataset[key];
  else el.dataset[key] = value === true ? '' : String(value);
}
