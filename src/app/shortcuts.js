// Global keyboard shortcuts (see SHORTCUTS in ./shortcuts-list.js). One `keydown` listener on window, in the
// bubble phase, so focused widgets (search input, channel listbox, menus, sliders, dialogs) handle their own
// keys first; anything they `preventDefault()` is left alone here.

import { SHORTCUTS } from './shortcuts-list.js';
import { isTypingTarget } from '../lib/utils.js';
import { openShortcutsDialog } from '../ui/dialogs.js';
import { toast } from '../ui/toast.js';

const VOLUME_STEP = 0.05;
const SEEK_STEP = 10;

/** KeyboardEvent.key → shortcut id (single characters are matched case-insensitively). */
const KEY_TO_ID = new Map();
for (const shortcut of SHORTCUTS) {
  for (const key of shortcut.keys) KEY_TO_ID.set(key.length === 1 ? key.toLowerCase() : key, shortcut.id);
}

/** Widgets that use arrow / page keys themselves. */
const NAV_WIDGET = [
  '[role="listbox"]',
  '[role="menu"]',
  '[role="menubar"]',
  '[role="slider"]',
  '[role="radiogroup"]',
  '[role="tablist"]',
  '[role="tree"]',
  '[role="grid"]',
  '[role="spinbutton"]',
  'select',
  'input[type="range"]',
].join(',');

/** Elements that Space activates natively (or by ARIA convention). */
const SPACE_ACTIVATES = [
  'button',
  'a[href]',
  'summary',
  'label',
  'input[type="checkbox"]',
  'input[type="radio"]',
  'input[type="button"]',
  'input[type="submit"]',
  'input[type="reset"]',
  'input[type="file"]',
  '[role="button"]',
  '[role="link"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="tab"]',
  '[role="option"]',
  '[role="menuitem"]',
  '[role="menuitemradio"]',
  '[role="menuitemcheckbox"]',
].join(',');

/** Held keys auto-repeat only for these (toggles would flap). */
const REPEATABLE = new Set(['volumeUp', 'volumeDown', 'seekBack', 'seekForward']);

const isNavigationKey = (key) => key.startsWith('Arrow') || key === 'PageUp' || key === 'PageDown';

function resolveShortcut(key) {
  return KEY_TO_ID.get(key.length === 1 ? key.toLowerCase() : key) || null;
}

function hasBlockingModifier(e) {
  if (e.ctrlKey || e.metaKey || e.altKey) {
    // AltGr (Ctrl+Alt on Windows) produces characters like '/' or '?' on some keyboard layouts.
    const altGraph = typeof e.getModifierState === 'function' && e.getModifierState('AltGraph');
    return !(altGraph && e.key.length === 1);
  }
  return false;
}

/**
 * Install the global keyboard shortcuts.
 * @param {{
 *   store: ReturnType<import('./store.js').createStore>,
 *   actions: ReturnType<import('./controller.js').createController>,
 *   playerView?: { el: HTMLElement, player?: { canSeek: boolean }, togglePlay(): void, toggleMute(): void,
 *     volumeBy(delta: number): void, toggleFullscreen(): void, togglePip(): void, seekBy(sec: number): void,
 *     retry(): void, toggleStats(): void } | null,
 *   channelList?: { focusSearch(): void, clearSearch(): void } | null,
 * }} deps
 * @returns {() => void} uninstall
 */
export function installShortcuts({ store, actions, playerView, channelList }) {
  const hasChannel = () => !!store.get().currentChannel;

  /** The player surface itself (its root or the video), where Space always means play/pause. */
  const isPlayerSurface = (el) => {
    const root = playerView?.el;
    if (!el || !root) return false;
    return el === root || el.tagName === 'VIDEO' || (el.classList?.contains('pv') && root.contains(el));
  };

  /**
   * Handlers return `false` when they did nothing, so the browser's default for the key still applies.
   * @type {Record<string, (e: KeyboardEvent, target: Element|null) => (void|false)>}
   */
  const handlers = {
    togglePlay(e, target) {
      if (e.key === ' ' && target?.closest(SPACE_ACTIVATES) && !isPlayerSurface(target)) return false;
      if (!hasChannel() || !playerView) return false;
      playerView.togglePlay();
    },
    toggleMute() {
      if (!playerView) return false;
      playerView.toggleMute();
    },
    volumeUp() {
      if (!playerView) return false;
      playerView.volumeBy(VOLUME_STEP);
    },
    volumeDown() {
      if (!playerView) return false;
      playerView.volumeBy(-VOLUME_STEP);
    },
    seekBack() {
      if (!hasChannel() || !playerView?.player?.canSeek) return false;
      playerView.seekBy(-SEEK_STEP);
    },
    seekForward() {
      if (!hasChannel() || !playerView?.player?.canSeek) return false;
      playerView.seekBy(SEEK_STEP);
    },
    toggleFullscreen() {
      if (!hasChannel() || !playerView) return false;
      playerView.toggleFullscreen();
    },
    togglePip() {
      if (!hasChannel() || !playerView) return false;
      playerView.togglePip();
    },
    nextChannel() {
      actions.playNext();
    },
    prevChannel() {
      actions.playPrev();
    },
    toggleFavorite() {
      const channel = store.get().currentChannel;
      if (!channel) return false;
      const added = actions.toggleFavorite(channel);
      toast(added ? 'Added to favorites' : 'Removed from favorites', {
        type: added ? 'success' : 'info',
        duration: 2200,
      });
    },
    retry() {
      if (!hasChannel() || !playerView) return false;
      playerView.retry();
    },
    toggleStats() {
      if (!hasChannel() || !playerView) return false;
      playerView.toggleStats();
    },
    focusSearch() {
      if (!channelList) return false;
      if (store.get().sidebarOpen) actions.setSidebarOpen(false);
      channelList.focusSearch();
    },
    escape(e, target) {
      const state = store.get();
      if (state.sidebarOpen) {
        actions.setSidebarOpen(false);
      } else if (state.query) {
        if (channelList) channelList.clearSearch();
        else actions.setQuery('');
      } else {
        // Only blur what still has focus (a widget may have moved focus while handling Escape itself).
        if (target instanceof HTMLElement && target !== document.body && document.activeElement === target) {
          target.blur();
        }
        return false; // nothing to cancel
      }
      return undefined;
    },
    showShortcuts() {
      openShortcutsDialog();
    },
  };

  function onKeyDown(e) {
    if (e.defaultPrevented || e.isComposing) return;
    const { key } = e;
    if (!key || key === 'Unidentified' || key === 'Dead' || key === 'Process') return;
    if (hasBlockingModifier(e)) return;
    const id = resolveShortcut(key);
    if (!id) return;
    // Shift+Space / Shift+Arrows / Shift+PageUp… are scrolling and selection gestures — leave them alone.
    if (e.shiftKey && (key === ' ' || key.length > 1)) return;
    // Modal dialogs own the keyboard (they handle Escape themselves).
    if (document.querySelector('dialog[open]')) return;

    const target = e.target instanceof Element ? e.target : null;
    if (id !== 'escape' && isTypingTarget(target)) return;
    // Open popovers/menus handle their own keys (they close themselves on Escape).
    if (target?.closest('.popover')) return;
    if (isNavigationKey(key) && target?.closest(NAV_WIDGET)) return;
    if (e.repeat && !REPEATABLE.has(id)) {
      if (id === 'togglePlay' && key === ' ' && !target?.closest(SPACE_ACTIVATES)) e.preventDefault();
      return;
    }

    const handled = handlers[id]?.(e, target);
    if (handled !== false) e.preventDefault();
  }

  window.addEventListener('keydown', onKeyDown);
  return () => window.removeEventListener('keydown', onKeyDown);
}
