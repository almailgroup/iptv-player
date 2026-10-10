// Popovers & menus: Tab leaving a panel continues from its anchor; menu labels form valid ARIA groups.
// Toasts: the auto-dismiss timer holds while a toast has keyboard focus; long messages get a sub-line.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { closePopover, openMenu, openPopover } from '../src/ui/popover.js';
import { splitMessage, toast } from '../src/ui/toast.js';

const tab = (shiftKey = false) =>
  document.activeElement.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true }),
  );

function anchorButton() {
  const before = document.createElement('button');
  const anchor = document.createElement('button');
  const after = document.createElement('button');
  before.textContent = 'before';
  anchor.textContent = 'anchor';
  after.textContent = 'after';
  document.body.append(before, anchor, after);
  return anchor;
}

afterEach(() => {
  closePopover();
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe('openMenu', () => {
  it('closes on Tab and hands focus back to the anchor so tabbing continues after it', () => {
    const anchor = anchorButton();
    const handle = openMenu({ anchor, items: [{ label: 'One' }, { label: 'Two' }], label: 'Things' });
    expect(handle.el.contains(document.activeElement)).toBe(true);
    tab();
    expect(handle.el.isConnected).toBe(false);
    expect(document.activeElement).toBe(anchor);
    expect(anchor.getAttribute('aria-expanded')).toBe('false');
  });

  it('wraps items that follow a label in a labelled group (menus may only own items/groups)', () => {
    const anchor = anchorButton();
    const handle = openMenu({
      anchor,
      label: 'Sort channels',
      items: [
        { type: 'label', label: 'Sort by' },
        { label: 'Playlist order', checked: true },
        { label: 'Name A–Z', checked: false },
        { type: 'separator' },
        { label: 'Other' },
      ],
    });
    const menu = handle.el.querySelector('[role="menu"]');
    const allowed = new Set(['group', 'separator', 'menuitem', 'menuitemradio', 'menuitemcheckbox']);
    for (const child of menu.children) expect(allowed.has(child.getAttribute('role'))).toBe(true);
    const group = menu.querySelector('[role="group"]');
    const label = document.getElementById(group.getAttribute('aria-labelledby'));
    expect(label.textContent).toBe('Sort by');
    expect(group.querySelectorAll('[role="menuitemradio"]')).toHaveLength(2);
    // The separator ends the group.
    expect(menu.lastElementChild.getAttribute('role')).toBe('menuitem');
    expect(menu.lastElementChild.textContent).toBe('Other');
    // Focus starts on the checked item and arrows still walk all items.
    expect(document.activeElement.textContent).toBe('Playlist order');
  });
});

describe('openPopover (dialog panel)', () => {
  function panel() {
    const first = document.createElement('button');
    const last = document.createElement('button');
    first.textContent = 'first';
    last.textContent = 'last';
    const content = document.createElement('div');
    content.append(first, last);
    return { content, first, last };
  }

  it('keeps Tab inside while there are more controls, then leaves through the anchor', () => {
    const anchor = anchorButton();
    const { content, first, last } = panel();
    const handle = openPopover({ anchor, content, label: 'Panel' });
    expect(document.activeElement).toBe(first);
    tab();
    expect(handle.el.isConnected).toBe(true); // browser moves focus to `last` itself
    last.focus();
    tab();
    expect(handle.el.isConnected).toBe(false);
    expect(document.activeElement).toBe(anchor);
  });

  it('Shift+Tab from the first control closes and returns to the anchor', () => {
    const anchor = anchorButton();
    const { content } = panel();
    const handle = openPopover({ anchor, content, label: 'Panel' });
    tab(true);
    expect(handle.el.isConnected).toBe(false);
    expect(document.activeElement).toBe(anchor);
  });
});

describe('toast', () => {
  it('does not auto-dismiss while it holds keyboard focus', () => {
    vi.useFakeTimers();
    const { el } = toast('Saved', { duration: 1000, action: { label: 'Undo', onClick: () => {} } });
    const action = el.querySelector('.toast-action');
    action.focus();
    vi.advanceTimersByTime(5000);
    expect(el.isConnected).toBe(true);
    action.blur();
    vi.advanceTimersByTime(1000 + 300);
    expect(el.isConnected).toBe(false);
  });

  it('shows a long two-sentence message as a title and a muted sub-line', () => {
    const { el } = toast(
      'Loaded 147 channels from “Dr. Who TV”. 1 channel uses a protocol browsers can’t play (rtmp://).',
    );
    expect(el.querySelector('.toast-message').textContent).toBe('Loaded 147 channels from “Dr. Who TV”');
    expect(el.querySelector('.toast-detail').textContent).toBe(
      '1 channel uses a protocol browsers can’t play (rtmp://).',
    );
    expect(el.querySelector('.toast-text').classList.contains('has-detail')).toBe(true);
  });

  it('keeps an explicit detail and leaves short messages whole', () => {
    const { el } = toast('Relay code copied. Paste it.', { detail: 'Replace everything.' });
    expect(el.querySelector('.toast-message').textContent).toBe('Relay code copied. Paste it.');
    expect(el.querySelector('.toast-detail').textContent).toBe('Replace everything.');
    expect(splitMessage('Something went wrong. Please try again.')).toEqual([
      'Something went wrong. Please try again.',
      '',
    ]);
  });

  it('splits only at a sentence break outside quotes and brackets', () => {
    const manifest = 'This file is a single HLS stream manifest, not a channel list. Add it by its URL.';
    expect(splitMessage(manifest)).toEqual([
      'This file is a single HLS stream manifest, not a channel list',
      'Add it by its URL.',
    ]);
    const bracketed = 'Playlists from a file (e.g. Downloads. Or Desktop) can’t be refreshed without it';
    expect(splitMessage(bracketed)).toEqual([bracketed, '']);
    const lowercase = 'Couldn’t reach the server, e.g. because you are offline. or it moved elsewhere';
    expect(splitMessage(lowercase)).toEqual([lowercase, '']);
    const question = 'Is the link still valid? Check it and try adding the playlist again later';
    expect(splitMessage(question)).toEqual([
      'Is the link still valid?',
      'Check it and try adding the playlist again later',
    ]);
  });
});
