// Anchored popovers and menus. Positioned with `position: fixed` so they also work inside a
// fullscreen element — pass that element as `container` (only descendants of the fullscreen
// element are visible while fullscreen).

import { h } from '../lib/dom.js';
import { icon } from './icons.js';

let active = null;

/** Close the currently open popover, if any. */
export function closePopover() {
  active?.close();
}

/**
 * Open a floating panel anchored to `anchor`.
 * @param {{
 *   anchor: HTMLElement,
 *   content: Node,
 *   placement?: 'bottom-start'|'bottom-end'|'top-start'|'top-end'|'right-start'|'right-end',
 *   container?: HTMLElement,
 *   className?: string,
 *   offset?: number,
 *   matchWidth?: boolean,
 *   label?: string,
 *   onClose?: () => void,
 *   focus?: boolean,
 *   role?: string,
 * }} opts
 */
export function openPopover(opts) {
  const {
    anchor,
    content,
    placement = 'bottom-start',
    container = document.body,
    className,
    offset = 8,
    matchWidth = false,
    label,
    onClose,
    focus = true,
    role = 'dialog',
  } = opts;

  // Toggle behaviour: clicking the same anchor again closes it.
  if (active && active.anchor === anchor) {
    active.close();
    return null;
  }
  active?.close();

  const el = h(
    'div',
    { class: ['popover', className], role, 'aria-label': role === 'dialog' ? label : undefined, tabIndex: -1 },
    content,
  );
  el.dataset.placement = placement;
  container.append(el);
  anchor.setAttribute('aria-expanded', 'true');

  const reposition = () => {
    const a = anchor.getBoundingClientRect();
    if (matchWidth) el.style.minWidth = `${a.width}px`;
    const pw = el.offsetWidth;
    const ph = el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const [side, align] = placement.split('-');
    let top;
    let left;
    if (side === 'right') {
      left = a.right + offset;
      if (left + pw > vw - 8) left = a.left - pw - offset;
      top = align === 'end' ? a.bottom - ph : a.top;
    } else {
      const below = a.bottom + offset;
      const above = a.top - offset - ph;
      if (side === 'top') top = above >= 8 || below + ph > vh - 8 ? above : below;
      else top = below + ph <= vh - 8 || above < 8 ? below : above;
      left = align === 'end' ? a.right - pw : a.left;
    }
    left = Math.max(8, Math.min(left, vw - pw - 8));
    top = Math.max(8, Math.min(top, vh - ph - 8));
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
  };

  const onPointerDown = (e) => {
    if (!el.contains(e.target) && !anchor.contains(e.target)) close();
  };
  const onKeyDown = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
      anchor.focus?.();
    } else if (e.key === 'Tab' && !el.contains(document.activeElement)) {
      close();
    }
  };
  const onFocusOut = () => {
    // Close when focus leaves both the popover and its anchor (e.g. tabbing away).
    requestAnimationFrame(() => {
      const ae = document.activeElement;
      if (handle === active && ae && ae !== document.body && !el.contains(ae) && !anchor.contains(ae)) close();
    });
  };

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener('pointerdown', onPointerDown, true);
    document.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('resize', reposition);
    window.removeEventListener('scroll', reposition, true);
    el.removeEventListener('focusout', onFocusOut);
    anchor.setAttribute('aria-expanded', 'false');
    el.remove();
    if (active === handle) active = null;
    onClose?.();
  }

  const handle = { el, anchor, close, reposition };
  active = handle;

  reposition();
  requestAnimationFrame(() => {
    if (closed) return;
    reposition();
    el.classList.add('is-open');
  });
  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('resize', reposition);
  window.addEventListener('scroll', reposition, true);
  el.addEventListener('focusout', onFocusOut);

  if (focus) {
    const first = el.querySelector(
      '[aria-checked="true"], [autofocus], button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    (first || el).focus({ preventScroll: true });
  }
  return handle;
}

/**
 * Open a keyboard-navigable menu.
 * Items: { label, icon?, hint?, checked?, disabled?, danger?, onSelect() }
 *      | { type: 'separator' } | { type: 'label', label }
 * `checked` (boolean) renders a radio-style item with a check mark.
 */
export function openMenu({ anchor, items, placement = 'bottom-start', container, className, label, onClose }) {
  const menu = h('div', { class: 'menu', role: 'menu', 'aria-label': label });
  const buttons = [];
  let handle;

  for (const item of items) {
    if (!item) continue;
    if (item.type === 'separator') {
      menu.append(h('div', { class: 'menu-separator', role: 'separator' }));
      continue;
    }
    if (item.type === 'label') {
      menu.append(h('div', { class: 'menu-label', text: item.label }));
      continue;
    }
    const isRadio = typeof item.checked === 'boolean';
    const btn = h(
      'button',
      {
        type: 'button',
        class: ['menu-item', item.danger && 'is-danger', item.checked && 'is-checked'],
        role: isRadio ? 'menuitemradio' : 'menuitem',
        'aria-checked': isRadio ? String(item.checked) : undefined,
        disabled: !!item.disabled,
        tabIndex: -1,
        onClick: () => {
          handle?.close();
          item.onSelect?.();
        },
      },
      item.icon ? icon(item.icon, { size: 16 }) : isRadio ? h('span', { class: 'menu-icon-spacer' }) : null,
      h('span', { class: 'menu-item-label', text: item.label }),
      item.hint ? h('span', { class: 'menu-item-hint', text: item.hint }) : null,
      isRadio && item.checked ? icon('check', { size: 16, class: 'menu-check' }) : null,
    );
    buttons.push(btn);
    menu.append(btn);
  }

  const enabled = () => buttons.filter((b) => !b.disabled);
  const focusAt = (i) => {
    const list = enabled();
    if (!list.length) return;
    list[(i + list.length) % list.length].focus();
  };
  menu.addEventListener('keydown', (e) => {
    const list = enabled();
    const idx = list.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      focusAt(idx + 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      focusAt(idx - 1);
    } else if (e.key === 'Home') {
      e.preventDefault();
      focusAt(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      focusAt(list.length - 1);
    }
  });
  buttons.forEach((b) => b.addEventListener('pointermove', () => b.focus({ preventScroll: true })));

  handle = openPopover({
    anchor,
    content: menu,
    placement,
    container,
    className: ['popover-menu', className].filter(Boolean).join(' '),
    label,
    onClose,
    focus: false,
    role: 'presentation',
  });
  if (handle) {
    const checked = buttons.find((b) => b.getAttribute('aria-checked') === 'true' && !b.disabled);
    (checked || enabled()[0])?.focus({ preventScroll: true });
  }
  return handle;
}
