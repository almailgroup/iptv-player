// Lightweight toast notifications.

import { h } from '../lib/dom.js';
import { icon } from './icons.js';

const MAX_VISIBLE = 4;
const TYPE_ICON = { info: 'info', success: 'check', warning: 'alert', error: 'alert' };

function getContainer() {
  let el = document.getElementById('toasts');
  if (!el) {
    el = h('div', { id: 'toasts', class: 'toasts', 'aria-live': 'polite', 'aria-atomic': 'false' });
    document.body.append(el);
  }
  // Toasts must render inside the fullscreen element to be visible while fullscreen.
  const host = document.fullscreenElement || document.body;
  if (el.parentElement !== host) host.append(el);
  return el;
}

/**
 * Show a toast.
 * @param {string} message
 * @param {{ type?: 'info'|'success'|'warning'|'error', duration?: number, action?: { label: string, onClick: () => void } }} [opts]
 *   duration 0 keeps the toast until dismissed. Errors default to 7s, others to 3.5s.
 * @returns {{ dismiss: () => void, el: HTMLElement }}
 */
export function toast(message, opts = {}) {
  const { type = 'info', action } = opts;
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
    h('div', { class: 'toast-message', text: message }),
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
    h('button', { type: 'button', class: 'toast-close', 'aria-label': 'Dismiss', onClick: dismiss }, icon('close', { size: 16 })),
  );

  const start = () => {
    if (duration > 0) timer = setTimeout(dismiss, duration);
  };
  el.addEventListener('pointerenter', () => clearTimeout(timer));
  el.addEventListener('pointerleave', start);

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
