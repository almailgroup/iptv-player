// Lightweight toast notifications: a glass card with a tinted status disc, the message (plus an optional
// sub-line), an optional action and a dismiss button.

import { h } from '../lib/dom.js';
import { icon } from './icons.js';

const MAX_VISIBLE = 4;
const TYPE_ICON = { info: 'info', success: 'check', warning: 'alert', error: 'alert' };
// A message longer than this with more than one sentence is shown as a title + muted sub-line.
const SPLIT_MIN_LENGTH = 56;
const QUOTE_PAIRS = { '“': '”', '‘': '’', '(': ')', '"': '"' };

/**
 * Split "First sentence. The rest…" at its first sentence break outside quotes and brackets (so a
 * playlist name such as “Dr. Who TV” stays whole) into a title, without its full stop, and a sub-line.
 * Short or single-sentence messages are returned whole.
 * @param {string} message
 * @returns {[string, string]} [title, detail] (detail '' when not split)
 */
export function splitMessage(message) {
  const text = String(message ?? '');
  if (text.length <= SPLIT_MIN_LENGTH) return [text, ''];
  const closers = [];
  for (let i = 0; i < text.length - 2; i++) {
    const ch = text[i];
    if (closers.length && ch === closers[closers.length - 1]) closers.pop();
    else if (QUOTE_PAIRS[ch]) closers.push(QUOTE_PAIRS[ch]);
    else if (!closers.length && /[.!?]/.test(ch) && /\s/.test(text[i + 1])) {
      const rest = text.slice(i + 1).trim();
      // The next sentence starts with a capital, a digit or an opening quote ("e.g. a" is not a break).
      if (i >= 12 && /^[\p{Lu}\d“‘"(]/u.test(rest)) return [text.slice(0, ch === '.' ? i : i + 1), rest];
    }
  }
  return [text, ''];
}

function topModalDialog() {
  const open = document.querySelectorAll('dialog[open]:not(.is-closing)');
  for (let i = open.length - 1; i >= 0; i--) {
    try {
      if (open[i].matches(':modal')) return open[i];
    } catch {
      return open[i]; // engines without :modal support
    }
  }
  return null;
}

function fullscreenHost() {
  const el = document.fullscreenElement;
  return el && !(el instanceof HTMLVideoElement) ? el : null;
}

function getContainer() {
  let el = document.getElementById('toasts');
  if (!el) {
    el = h('div', { id: 'toasts', class: 'toasts', 'aria-live': 'polite', 'aria-atomic': 'false' });
    document.body.append(el);
  }
  // Toasts must render inside the top-most modal <dialog> (top layer) or the fullscreen element to be
  // visible and clickable while either is showing.
  const host = topModalDialog() || fullscreenHost() || document.body;
  if (el.parentElement !== host) host.append(el);
  return el;
}

/**
 * Show a toast.
 * @param {string} message
 * @param {{ type?: 'info'|'success'|'warning'|'error', duration?: number, detail?: string,
 *   action?: { label: string, onClick: () => void } }} [opts]
 *   duration 0 keeps the toast until dismissed. Errors default to 7s, others to 3.5s. `detail` is a muted
 *   second line under the message; without one, a long message is split at its first sentence break
 *   (splitMessage).
 * @returns {{ dismiss: () => void, el: HTMLElement }}
 */
export function toast(message, opts = {}) {
  const { type = 'info', action } = opts;
  const [title, detail] = opts.detail ? [message, opts.detail] : splitMessage(message);
  const duration = opts.duration ?? (type === 'error' ? 7000 : type === 'warning' ? 5500 : 3500);
  const container = getContainer();

  let timer = 0;
  const dismiss = () => {
    clearTimeout(timer);
    if (!el.isConnected) return;
    el.classList.remove('is-visible');
    el.classList.add('is-leaving');
    setTimeout(() => el.remove(), 220);
  };

  const el = h(
    'div',
    { class: ['toast', `toast-${type}`], role: type === 'error' ? 'alert' : 'status' },
    icon(TYPE_ICON[type] || 'info', { size: 18, class: 'toast-icon' }),
    h(
      'div',
      { class: ['toast-text', detail && 'has-detail'] },
      h('div', { class: 'toast-message', text: title }),
      detail ? h('div', { class: 'toast-detail', text: detail }) : null,
    ),
    action
      ? h('button', {
          type: 'button',
          class: 'toast-action',
          text: action.label,
          onClick: () => {
            dismiss();
            action.onClick();
          },
        })
      : null,
    h(
      'button',
      { type: 'button', class: 'toast-close', 'aria-label': 'Dismiss', onClick: dismiss },
      icon('close', { size: 16 }),
    ),
  );

  const start = () => {
    clearTimeout(timer);
    if (duration > 0) timer = setTimeout(dismiss, duration);
  };
  // Hold the toast while it is hovered or holds keyboard focus (e.g. tabbing to its action button).
  let hovered = false;
  let focused = false;
  const hold = () => clearTimeout(timer);
  const release = () => {
    if (!hovered && !focused) start();
  };
  el.addEventListener('pointerenter', () => {
    hovered = true;
    hold();
  });
  el.addEventListener('pointerleave', () => {
    hovered = false;
    release();
  });
  el.addEventListener('focusin', () => {
    focused = true;
    hold();
  });
  el.addEventListener('focusout', (e) => {
    if (el.contains(e.relatedTarget)) return;
    focused = false;
    release();
  });

  container.append(el);
  const toasts = container.querySelectorAll('.toast:not(.is-leaving)');
  if (toasts.length > MAX_VISIBLE) toasts[0].remove();
  requestAnimationFrame(() => el.classList.add('is-visible'));
  start();
  return { dismiss, el };
}

toast.info = (m, o) => toast(m, { ...o, type: 'info' });
toast.success = (m, o) => toast(m, { ...o, type: 'success' });
toast.warning = (m, o) => toast(m, { ...o, type: 'warning' });
toast.error = (m, o) => toast(m, { ...o, type: 'error' });
