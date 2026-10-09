// Modal dialogs built on the native <dialog> element. showModal() gives us the top layer, a focus trap,
// inertness of everything behind the dialog and Esc handling for free; on top of that we add enter/exit
// animations, backdrop clicks, focus restoration and the small confirm / prompt helpers.

import { h } from '../lib/dom.js';
import { prefersReducedMotion, uid } from '../lib/utils.js';
import { icon } from './icons.js';
import { closePopover } from './popover.js';

const SIZES = ['sm', 'md', 'lg'];
/** Safety net in case `transitionend` never fires (hidden tab, interrupted transition…). */
const EXIT_FALLBACK_MS = 360;
const FOCUSABLE = [
  'button:not([disabled])',
  'a[href]',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');
/** Elements a dialog must never be appended into, even when they are the fullscreen element. */
const NON_CONTAINERS = new Set(['VIDEO', 'AUDIO', 'IFRAME', 'IMG', 'CANVAS', 'OBJECT', 'EMBED']);

/**
 * Open modals, bottom → top.
 * @type {Array<{ el: HTMLDialogElement, previous: HTMLElement|null, state: 'open'|'closing'|'closed' }>}
 */
const stack = [];

function topOpenModal() {
  for (let i = stack.length - 1; i >= 0; i--) if (stack[i].state === 'open') return stack[i];
  return null;
}

/** Where new dialogs (and rescued toasts) live: the fullscreen element when there is one, else <body>. */
function modalHost() {
  const fs = document.fullscreenElement || document.webkitFullscreenElement || null;
  if (fs && fs.isConnected && !NON_CONTAINERS.has(fs.tagName)) return fs;
  return document.body;
}

function firstFocusable(root) {
  if (!root) return null;
  for (const el of root.querySelectorAll(FOCUSABLE)) {
    if (!el.closest('[hidden], [inert]')) return el;
  }
  return null;
}

function resolveElement(target, root) {
  if (!target) return null;
  if (typeof target === 'string') {
    try {
      return root.querySelector(target);
    } catch {
      return null;
    }
  }
  return target instanceof Element ? target : null;
}

/** Focus an element; returns true when it actually received focus (inert / hidden targets don't). */
function focusElement(el) {
  if (!el || !el.isConnected || typeof el.focus !== 'function') return false;
  try {
    el.focus({ preventScroll: true });
  } catch {
    return false;
  }
  return document.activeElement === el;
}

/**
 * If toast.js placed the toast container inside a dialog (so toasts render above the modal), move it out
 * when the dialog starts closing — otherwise visible toasts would vanish together with the dialog.
 * Closing dialogs carry `.is-closing`, so a toast host lookup can skip them.
 */
function rescueToasts(dialog) {
  const toasts = dialog.querySelector('#toasts');
  if (!toasts) return;
  const next = topOpenModal();
  (next ? next.el : modalHost()).append(toasts);
}

/**
 * Open a modal dialog.
 *
 * @param {{
 *   title: string | Node,
 *   description?: string | Node | Array<string|Node>,
 *   body?: Node | string | Array<Node|string>,
 *   footer?: Node | Node[],
 *   size?: 'sm'|'md'|'lg',
 *   onClose?: (result: any) => void,
 *   initialFocus?: HTMLElement | string,
 *   dismissible?: boolean,
 *   className?: string,
 *   role?: 'dialog'|'alertdialog',
 *   returnFocus?: HTMLElement | (() => HTMLElement | null | undefined),
 * }} options
 *   - `footer` nodes are right-aligned; give a node the class `md-footer-start` to pin it to the left.
 *   - `initialFocus`: element or selector (within the dialog). Defaults to the first focusable control in
 *     the body, then the footer, then the close button.
 *   - `dismissible: false` hides the close button and ignores Esc / backdrop clicks.
 *   - `returnFocus` (optional) overrides where focus goes after closing; a function is evaluated once the
 *     dialog has finished closing. Defaults to the element focused before opening.
 * @returns {{ el: HTMLDialogElement, close: (result?: any) => void, result: Promise<any> }}
 *   `result` resolves with the value passed to `close()` (undefined when dismissed) as soon as closing
 *   starts; `onClose` is called at the same moment.
 */
export function openModal(options = {}) {
  const {
    title = '',
    description,
    body,
    footer,
    size = 'md',
    onClose,
    initialFocus,
    dismissible = true,
    className,
    role,
    returnFocus,
  } = options;

  // An anchored popover outside the dialog would become inert (and look orphaned) — close it first.
  closePopover();

  // Remember where focus was. When the opener sits inside a dialog that is already closing (e.g. a
  // confirm that resolved and immediately opened another dialog), inherit that dialog's return target.
  const active = document.activeElement;
  const owner = stack.find((m) => m.el.contains(active));
  const previous =
    owner && owner.state !== 'open'
      ? owner.previous
      : active && active !== document.body && typeof active.focus === 'function'
        ? active
        : null;

  const titleId = uid('md-title');
  const descId = description ? uid('md-desc') : null;

  const closeBtn = dismissible
    ? h(
        'button',
        {
          type: 'button',
          class: 'icon-btn icon-btn-sm md-close',
          'aria-label': 'Close',
          onClick: () => close(),
        },
        icon('close', { size: 18 }),
      )
    : null;

  const header = h(
    'header',
    { class: 'md-header' },
    h(
      'div',
      { class: 'md-heading' },
      h('h2', { class: 'md-title', id: titleId }, title),
      descId ? h('div', { class: 'md-description', id: descId }, description) : null,
    ),
    closeBtn,
  );
  const hasBody = body !== undefined && body !== null && body !== false;
  const bodyEl = hasBody ? h('div', { class: 'md-body' }, body) : null;
  const footerNodes = [footer].flat(Infinity).filter(Boolean);
  const footerEl = footerNodes.length ? h('footer', { class: 'md-footer' }, footerNodes) : null;

  const el = h(
    'dialog',
    {
      class: ['md', `md-${SIZES.includes(size) ? size : 'md'}`, !hasBody && 'md-no-body', className],
      role: role === 'alertdialog' ? 'alertdialog' : undefined,
      'aria-labelledby': titleId,
      'aria-describedby': descId || undefined,
      tabIndex: -1,
    },
    header,
    bodyEl,
    footerEl,
  );

  const entry = { el, previous, state: 'open' };
  let resolveResult;
  const result = new Promise((resolve) => {
    resolveResult = resolve;
  });
  let exitTimer = 0;
  let pointerDownOnBackdrop = false;

  // Clicks on ::backdrop are dispatched to the <dialog> itself, outside its border box. Require the
  // press to *start* on the backdrop too, so selecting text inside and releasing outside doesn't close.
  const isOnBackdrop = (e) => {
    if (e.target !== el) return false;
    const r = el.getBoundingClientRect();
    return e.clientX < r.left || e.clientX >= r.right || e.clientY < r.top || e.clientY >= r.bottom;
  };
  el.addEventListener('pointerdown', (e) => {
    pointerDownOnBackdrop = isOnBackdrop(e);
  });
  el.addEventListener('click', (e) => {
    const fromBackdrop = pointerDownOnBackdrop && isOnBackdrop(e);
    pointerDownOnBackdrop = false;
    if (fromBackdrop && dismissible) close();
  });
  // Esc (and Android back): run our animated close instead of the instant native one.
  el.addEventListener('cancel', (e) => {
    e.preventDefault();
    if (dismissible) close();
  });
  // Browsers may close the dialog without a cancelable `cancel` (e.g. repeated Esc without user
  // activation). Keep our bookkeeping in sync when that happens.
  el.addEventListener('close', () => {
    if (entry.state === 'open') close();
    else if (entry.state === 'closing') finalize();
  });
  el.addEventListener('transitionend', (e) => {
    if (entry.state === 'closing' && e.target === el && e.propertyName === 'opacity') finalize();
  });
  if (bodyEl) {
    bodyEl.addEventListener('scroll', () => el.toggleAttribute('data-scrolled', bodyEl.scrollTop > 0), {
      passive: true,
    });
  }

  function close(value) {
    if (entry.state !== 'open') return;
    entry.state = 'closing';
    el.classList.remove('is-open');
    el.classList.add('is-closing');
    // Move toasts out now: the exit transform would otherwise re-anchor and clip them for a moment.
    rescueToasts(el);
    resolveResult(value);
    if (typeof onClose === 'function') {
      try {
        onClose(value);
      } catch (err) {
        console.error(err);
      }
    }
    // Without an exit animation, still finalize asynchronously so `result` continuations can update the
    // page (e.g. remove a deleted row) before focus is restored.
    const animated = el.open && el.isConnected && !prefersReducedMotion();
    exitTimer = setTimeout(finalize, animated ? EXIT_FALLBACK_MS : 0);
  }

  function finalize() {
    if (entry.state === 'closed') return;
    entry.state = 'closed';
    clearTimeout(exitTimer);
    const index = stack.indexOf(entry);
    if (index !== -1) stack.splice(index, 1);
    const ae = document.activeElement;
    const focusWasInside = !ae || ae === document.body || el.contains(ae);
    rescueToasts(el);
    if (el.open) {
      try {
        el.close();
      } catch {
        el.removeAttribute('open');
      }
    }
    el.remove();
    if (focusWasInside) restoreFocus();
  }

  function restoreFocus() {
    let target = null;
    try {
      target = typeof returnFocus === 'function' ? returnFocus() : returnFocus;
    } catch {
      target = null;
    }
    if (focusElement(target) || focusElement(previous)) return;
    // The opener is gone (e.g. its row was deleted): keep focus inside the dialog that is now on top.
    const top = topOpenModal();
    if (top) {
      const fallback = firstFocusable(top.el.querySelector('.md-body')) || firstFocusable(top.el);
      if (!focusElement(fallback)) focusElement(top.el);
    }
  }

  function focusInitial() {
    const target =
      resolveElement(initialFocus, el) ||
      bodyEl?.querySelector('[autofocus]') ||
      firstFocusable(bodyEl) ||
      firstFocusable(footerEl) ||
      closeBtn;
    if (!focusElement(target)) focusElement(el);
  }

  stack.push(entry);
  modalHost().append(el);
  try {
    el.showModal();
  } catch {
    // Very old engines or an unexpected state: fall back to a non-modal open dialog.
    el.setAttribute('open', '');
  }
  // Flush styles so the enter transition starts from the initial (transparent, scaled) state.
  el.getBoundingClientRect();
  el.classList.add('is-open');
  focusInitial();

  return { el, close, result };
}

/**
 * Ask the user to confirm an action.
 * @param {{ title: string, message?: string | Node | Array<string|Node>, confirmLabel?: string,
 *   cancelLabel?: string, danger?: boolean, returnFocus?: HTMLElement | (() => HTMLElement|null) }} opts
 * @returns {Promise<boolean>} true only when the confirm button was pressed.
 */
export function confirmDialog({
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
  returnFocus,
} = {}) {
  let handle = null;
  const cancelBtn = h('button', {
    type: 'button',
    class: 'btn btn-secondary',
    text: cancelLabel,
    onClick: () => handle?.close(false),
  });
  const confirmBtn = h('button', {
    type: 'button',
    class: ['btn', danger ? 'btn-danger md-btn-danger' : 'btn-primary'],
    text: confirmLabel,
    onClick: () => handle?.close(true),
  });
  handle = openModal({
    title,
    description: message,
    footer: [cancelBtn, confirmBtn],
    size: 'sm',
    role: 'alertdialog',
    className: ['md-confirm', danger && 'is-danger'].filter(Boolean).join(' '),
    // Destructive actions default to the safe choice.
    initialFocus: danger ? cancelBtn : confirmBtn,
    returnFocus,
  });
  return handle.result.then((value) => value === true);
}

/**
 * Ask the user for a single line of text.
 * @param {{
 *   title: string, label: string, value?: string, placeholder?: string, confirmLabel?: string,
 *   cancelLabel?: string, description?: string, maxLength?: number, required?: boolean,
 *   validate?: (value: string) => string | boolean | null | undefined
 *     | Promise<string | boolean | null | undefined>,
 *   returnFocus?: HTMLElement | (() => HTMLElement|null),
 * }} opts
 *   `validate` receives the trimmed value and returns an error message (or `false`) to reject it; any
 *   other falsy / `true` result accepts it. Empty values are rejected when `required` (default true).
 * @returns {Promise<string|null>} the trimmed value, or null when cancelled.
 */
export function promptDialog({
  title,
  label,
  value = '',
  placeholder = '',
  confirmLabel = 'Save',
  cancelLabel = 'Cancel',
  description,
  maxLength = 200,
  required = true,
  validate,
  returnFocus,
} = {}) {
  let handle = null;
  let validating = false;
  const formId = uid('md-prompt');
  const inputId = `${formId}-input`;
  const errorId = `${formId}-error`;

  const error = h('p', { class: 'field-error md-error', id: errorId, 'aria-live': 'polite' });
  const input = h('input', {
    class: 'input',
    id: inputId,
    type: 'text',
    value: String(value ?? ''),
    placeholder,
    autocomplete: 'off',
    maxlength: maxLength,
    'aria-describedby': errorId,
    'aria-invalid': 'false',
    onInput: () => setError(''),
  });
  input.setAttribute('spellcheck', 'false');

  function setError(message) {
    error.textContent = message;
    input.setAttribute('aria-invalid', String(!!message));
  }

  async function submit() {
    if (validating || !handle) return;
    const next = input.value.trim();
    let message = '';
    if (required && !next) {
      message = `${label || 'This field'} can’t be empty.`;
    } else if (typeof validate === 'function') {
      validating = true;
      try {
        const verdict = await validate(next);
        if (typeof verdict === 'string') message = verdict;
        else if (verdict === false) message = 'Please enter a valid value.';
      } catch (err) {
        message = (err && err.message) || 'Please enter a valid value.';
      } finally {
        validating = false;
      }
    }
    if (message) {
      setError(message);
      input.focus();
      input.select();
      return;
    }
    handle.close(next);
  }

  const form = h(
    'form',
    {
      class: 'md-form',
      id: formId,
      novalidate: true,
      onSubmit: (e) => {
        e.preventDefault();
        submit();
      },
    },
    h(
      'div',
      { class: 'field' },
      h('label', { class: 'field-label', htmlFor: inputId, text: label || title }),
      input,
      error,
    ),
  );
  const cancelBtn = h('button', {
    type: 'button',
    class: 'btn btn-secondary',
    text: cancelLabel,
    onClick: () => handle?.close(null),
  });
  const submitBtn = h('button', {
    type: 'submit',
    class: 'btn btn-primary',
    form: formId,
    text: confirmLabel,
  });

  handle = openModal({
    title,
    description,
    body: form,
    footer: [cancelBtn, submitBtn],
    size: 'sm',
    className: 'md-prompt',
    initialFocus: input,
    returnFocus,
  });
  input.select();
  return handle.result.then((v) => (typeof v === 'string' ? v : null));
}
