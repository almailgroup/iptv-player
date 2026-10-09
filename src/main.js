// Entry point: builds the store and controller, mounts the three columns, and wires the app-shell behaviour
// (sidebar drawer, global playlist drag & drop, keyboard shortcuts, ready state).

import './styles/index.css';

import { APP_NAME } from './app/constants.js';
import { createStore } from './app/store.js';
import { createController, createInitialState, initApp } from './app/controller.js';
import { installShortcuts } from './app/shortcuts.js';
import { createSidebar } from './ui/sidebar.js';
import { createChannelList } from './ui/channel-list.js';
import { createPlayerView } from './ui/player-view.js';
import { h, on } from './lib/dom.js';
import { icon } from './ui/icons.js';
import { toast } from './ui/toast.js';

const DRAWER_QUERY = '(max-width: 1100px)';
const BACKDROP_FADE_MS = 200; // matches --dur
const DROP_WATCHDOG_MS = 1200; // hide the overlay if the browser never sends dragleave
const MAX_DROPPED_FILES = 10;
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Create a UI component and append its element; a failing component must not take the whole app down. */
function mount(name, container, factory, failures) {
  try {
    const component = factory();
    if (component?.el && container) container.append(component.el);
    return component || null;
  } catch (err) {
    console.error(`[${APP_NAME}] Failed to start the ${name}.`, err);
    failures.push(name);
    return null;
  }
}

const isVisible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);

function focusInto(container) {
  const preferred = container.querySelector('[aria-current="page"]');
  const target =
    (preferred && isVisible(preferred) ? preferred : null) ||
    Array.from(container.querySelectorAll(FOCUSABLE)).find((el) => isVisible(el)) ||
    null;
  target?.focus({ preventScroll: true });
}

/**
 * Off-canvas sidebar on ≤ 1100px: `store.sidebarOpen` ↔ `#app.is-sidebar-open`, backdrop, focus handling.
 * (Escape is handled by the global shortcuts.)
 */
function setupSidebarDrawer({ store, actions, app, sidebar, backdrop, channels, stage }) {
  const media = typeof matchMedia === 'function' ? matchMedia(DRAWER_QUERY) : null;
  const isDrawer = () => !!media?.matches;
  let returnFocus = null;
  let hideTimer = 0;
  let wasOpen = false;

  const showBackdrop = () => {
    clearTimeout(hideTimer);
    backdrop.classList.remove('is-leaving');
    backdrop.hidden = false;
  };
  const hideBackdrop = () => {
    clearTimeout(hideTimer);
    if (backdrop.hidden) return;
    backdrop.classList.add('is-leaving');
    hideTimer = setTimeout(() => {
      backdrop.hidden = true;
      backdrop.classList.remove('is-leaving');
    }, BACKDROP_FADE_MS);
  };

  const apply = (requested) => {
    const open = requested && isDrawer();
    app.classList.toggle('is-sidebar-open', open);
    // While the drawer is open the rest of the app is inert (focus stays in the drawer, AT ignores the rest).
    channels.inert = open;
    stage.inert = open;
    if (open) {
      showBackdrop();
      if (!wasOpen) {
        const active = document.activeElement;
        returnFocus =
          active instanceof HTMLElement && active !== document.body && !sidebar.contains(active) ? active : null;
        requestAnimationFrame(() => {
          if (app.classList.contains('is-sidebar-open')) focusInto(sidebar);
        });
      }
    } else {
      hideBackdrop();
      if (wasOpen && sidebar.contains(document.activeElement)) {
        const fallback = channels.querySelector('.cl-menu-btn');
        const target = returnFocus?.isConnected && isVisible(returnFocus) ? returnFocus : fallback;
        target?.focus({ preventScroll: true });
      }
      returnFocus = null;
    }
    wasOpen = open;
  };

  const unsubscribe = store.select((s) => s.sidebarOpen, apply, { immediate: true });
  const offBackdrop = on(app, 'click', (e) => {
    if (e.target instanceof Element && e.target.closest('[data-action="close-sidebar"]')) {
      actions.setSidebarOpen(false);
    }
  });
  const onMediaChange = () => {
    if (!isDrawer() && store.get().sidebarOpen) actions.setSidebarOpen(false);
    else apply(store.get().sidebarOpen);
  };
  media?.addEventListener?.('change', onMediaChange);

  return () => {
    unsubscribe();
    offBackdrop();
    media?.removeEventListener?.('change', onMediaChange);
    clearTimeout(hideTimer);
  };
}

/** Window-wide drag & drop of playlist files with a full-screen "Drop to load playlist" overlay. */
function setupDropZone({ actions }) {
  const overlay = h(
    'div',
    { class: 'app-dropzone', 'aria-hidden': 'true' },
    h(
      'div',
      { class: 'app-dropzone-panel' },
      h('span', { class: 'app-dropzone-icon' }, icon('upload', { size: 28 })),
      h('p', { class: 'app-dropzone-title', text: 'Drop to load playlist' }),
      h('p', { class: 'app-dropzone-hint', text: 'M3U or M3U8 files' }),
    ),
  );
  document.body.append(overlay);

  let depth = 0;
  let internalDrag = false; // a drag that started inside the page (e.g. a channel logo image)
  let watchdog = 0;

  const hasFiles = (e) => {
    const types = e.dataTransfer?.types;
    return !!types && Array.from(types).includes('Files');
  };
  const modalOpen = () => !!document.querySelector('dialog[open]');
  const show = () => {
    overlay.classList.add('is-active');
    clearTimeout(watchdog);
    watchdog = setTimeout(hide, DROP_WATCHDOG_MS);
  };
  function hide() {
    depth = 0;
    clearTimeout(watchdog);
    overlay.classList.remove('is-active');
  }

  async function loadFiles(files) {
    for (const file of files.slice(0, MAX_DROPPED_FILES)) {
      try {
        await actions.addPlaylistFromFile(file);
      } catch {
        /* the controller already reported it */
      }
    }
  }

  const offs = [
    on(window, 'dragstart', () => {
      internalDrag = true;
    }),
    on(window, 'dragend', () => {
      internalDrag = false;
      hide();
    }),
    on(window, 'dragenter', (e) => {
      if (internalDrag || !hasFiles(e)) return;
      e.preventDefault();
      depth += 1;
      if (!modalOpen()) show();
    }),
    on(window, 'dragover', (e) => {
      if (internalDrag || !hasFiles(e)) return;
      // A drop target inside the page (e.g. the add-playlist dialog) already accepted it.
      if (e.defaultPrevented) {
        hide();
        return;
      }
      e.preventDefault(); // otherwise the browser navigates to the dropped file
      const blocked = modalOpen();
      if (e.dataTransfer) e.dataTransfer.dropEffect = blocked ? 'none' : 'copy';
      if (blocked) hide();
      else show();
    }),
    on(window, 'dragleave', (e) => {
      if (internalDrag || !hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0 || e.relatedTarget === null) hide();
    }),
    on(window, 'drop', (e) => {
      if (internalDrag) {
        internalDrag = false;
        return;
      }
      if (!hasFiles(e)) return;
      const handled = e.defaultPrevented;
      e.preventDefault();
      hide();
      if (handled || modalOpen()) return;
      const files = Array.from(e.dataTransfer?.files || []);
      if (files.length) loadFiles(files);
    }),
  ];

  return () => {
    offs.forEach((off) => off());
    clearTimeout(watchdog);
    overlay.remove();
  };
}

function start() {
  const app = document.getElementById('app');
  const sidebarEl = document.getElementById('sidebar');
  const channelsEl = document.getElementById('channels');
  const stageEl = document.getElementById('stage');
  const backdrop = app?.querySelector('.sidebar-backdrop');
  if (!app || !sidebarEl || !channelsEl || !stageEl || !backdrop) {
    console.error(`[${APP_NAME}] The page is missing the app shell markup.`);
    return;
  }

  const store = createStore(createInitialState());
  const actions = createController(store);

  store.select(
    (s) => s.ready,
    (ready) => {
      app.dataset.ready = ready ? 'true' : 'false';
    },
    { immediate: true },
  );

  const failures = [];
  mount('sidebar', sidebarEl, () => createSidebar({ store, actions }), failures);
  const channelList = mount('channel list', channelsEl, () => createChannelList({ store, actions }), failures);
  const playerView = mount('player', stageEl, () => createPlayerView({ store, actions }), failures);
  if (failures.length) {
    const message = `Part of the app (${failures.join(', ')}) failed to load. Try reloading the page.`;
    toast.error(message, { duration: 0 });
  }

  installShortcuts({ store, actions, playerView, channelList });
  setupSidebarDrawer({
    store,
    actions,
    app,
    sidebar: sidebarEl,
    backdrop,
    channels: channelsEl,
    stage: stageEl,
  });
  setupDropZone({ actions });

  initApp(store, actions)
    .catch((err) => {
      console.error(`[${APP_NAME}] Start-up failed.`, err);
      toast.error('Something went wrong while starting the player. Try reloading the page.');
    })
    .finally(() => {
      if (!store.get().ready) store.set({ ready: true });
    });
}

start();
