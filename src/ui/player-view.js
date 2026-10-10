// Player view — the hero of the app: the video box (custom controls and overlays) and the now-playing card
// below it. It owns everything inside #stage (SPEC §3.5).
//
// The view never talks to streaming engines directly: it drives the Player (src/player/player.js) and mirrors
// its state into `data-*` attributes on the `.pv` root. player.css uses those attributes to decide which layer
// (idle hero, status, error panel, big play button, controls…) is visible, so the JS stays declarative.
//
// Attributes on `.pv` (see player.css):
//   data-state     idle | ready | loading | playing | paused | buffering | reconnecting | error
//   data-controls  visible | hidden
//   data-idle      boot | welcome | select | busy | failed      (which idle variant to show)
//   data-error     danger | warning | neutral                  (tint of the error panel)
//   data-input     mouse | touch                               (last pointer type)
//   presence flags data-has-channel, data-live, data-seekable, data-fullscreen, data-pip, data-stats,
//                  data-unmute, data-scrubbing

import { h, on, replaceChildren, setData } from '../lib/dom.js';
import {
  clamp,
  copyText,
  formatBitrate,
  formatCount,
  formatDuration,
  hueFromString,
  initials,
  safeImageUrl,
} from '../lib/utils.js';
import { APP_NAME, CATEGORY } from '../app/constants.js';
import { effectiveRelay, hasBuiltinRelay, isBuiltinRelayActive, streamRelay } from '../app/relay.js';
import { isFavorite, selectVisibleChannels } from '../app/selectors.js';
import { SHORTCUTS } from '../app/shortcuts-list.js';
import { Player, PlayerErrorCode, PlayerState } from '../player/player.js';
import { icon, setIcon } from './icons.js';
import { openMenu } from './popover.js';
import { toast } from './toast.js';
import { openAddPlaylistDialog, openProxyGuide, openSettingsDialog, proxyHealthUrl } from './dialogs.js';

const HIDE_DELAY = 2800; // controls auto-hide while playing (mouse)
const TOUCH_HIDE_DELAY = 3600; // a little longer on touch — there is no hover to bring them back
const LEAVE_HIDE_DELAY = 700; // pointer left the player
const CLICK_DELAY = 200; // single click waits this long so a double click can cancel it
const OSD_DURATION = 900;
const SEEK_STEP = 5; // seconds per arrow key on the seek slider
const SEEK_PAGE = 30; // seconds per PageUp/PageDown on the seek slider
const BEHIND_LIVE_SET = 45; // seconds of drift (vs. the best observed latency) before we flag "behind live"
const BEHIND_LIVE_CLEAR = 3; // back within this many seconds of the best observed latency = at the live edge
const PAUSE_BEHIND_MS = 3000; // pausing a live stream for longer than this leaves you behind the live edge
const ICON_SIZE = 20;
const SLIDER_KEYS = new Set([
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'Home',
  'End',
  'PageUp',
  'PageDown',
]);

const S = PlayerState;
const E = PlayerErrorCode;

/** Spec-ordered tip row shown under the player when nothing is playing. */
const TIP_IDS = ['togglePlay', 'toggleFullscreen', 'focusSearch', 'showShortcuts'];
const TIP_LABELS = {
  togglePlay: 'Play / pause',
  toggleFullscreen: 'Fullscreen',
  focusSearch: 'Search',
  showShortcuts: 'All shortcuts',
};

const STAT_ROWS = [
  ['state', 'State'],
  ['engine', 'Engine'],
  ['route', 'Route'],
  ['mode', 'Stream'],
  ['resolution', 'Resolution'],
  ['bitrate', 'Bitrate'],
  ['bandwidth', 'Bandwidth'],
  ['buffer', 'Buffer'],
  ['latency', 'Latency'],
  ['dropped', 'Dropped'],
  ['attempt', 'Reconnects'],
  ['url', 'URL'],
];

const REASONS = {
  stalled: 'The stream stopped responding.',
  stall: 'The stream stopped responding.',
  network: 'The connection to the stream was lost.',
  media: 'The video could not be decoded.',
  offline: 'Your device is offline.',
  ended: 'The stream ended unexpectedly.',
  timeout: 'The stream took too long to respond.',
};

/** MIXED_CONTENT detail copy (the Player's own detail doesn't know about the relay settings). */
const MIXED_DETAIL = {
  upgraded: 'Its HTTPS version didn’t work either. ',
  noRelay:
    'Set up your own free relay to play it here (about 5 minutes), or use an HTTPS link if your provider ' +
    'offers one.',
  builtinOff:
    'Turn the built-in relay back on in Settings to play it here, or use an HTTPS link if your provider ' +
    'offers one.',
  streamsOff: 'Turn on “Play blocked streams through the relay” in Settings to play it here.',
  relayReady: 'A relay is set up now — press Retry to play it through the relay.',
};
/** Copy for streams that failed through the relay (names the relay in use, unlike the Player's wording). */
const RELAY_FAILED = {
  builtin: {
    message: 'Couldn’t play this stream through the built-in relay.',
    detail: 'The stream may be offline, region-locked, or refusing relays. Try again later.',
  },
  own: {
    message: 'Couldn’t play this stream through your relay.',
    detail:
      'Check that your relay’s address is correct and that it’s running (Settings → Network), or try ' +
      'again later.',
  },
  // The relay it failed through has been switched off or removed since.
  gone: {
    message: 'Couldn’t play this stream through the relay.',
    detail: 'Try again, or pick another channel.',
  },
};
/**
 * Copy for a failure through a relay that doesn't answer at all — its health check failed too: it is down, out
 * of its free quota, or blocked on this network. That is the relay's problem, not the channel's.
 */
const RELAY_DOWN = {
  builtin: {
    title: 'Relay unavailable',
    message: 'Couldn’t reach the built-in relay.',
    detail: 'It may be down or busy right now. Try again in a few minutes.',
  },
  own: {
    title: 'Relay unavailable',
    message: 'Couldn’t reach your relay.',
    detail: 'Check that it’s running and that its address is correct (Settings → Network), or try again later.',
  },
};
/** Upper bound for the relay health check that follows a failure through the relay (see mayBeRelayDown). */
const RELAY_PROBE_TIMEOUT_MS = 8000;
/** How many channels (stream URLs) the once-per-channel "Playing through your relay" notice remembers. */
const PROXY_NOTICE_LIMIT = 200;
/**
 * Fatal errors that say nothing about the channel itself, so they aren't remembered as failures: blocked
 * autoplay, being offline, and blocked insecure streams: without a relay (the list flags those as "HTTP"
 * already — a stored failure would outlive setting a relay up) or on the local network (flagged "Local").
 */
const UNREPORTED_ERRORS = new Set([E.AUTOPLAY, E.OFFLINE, E.MIXED_CONTENT]);

let instances = 0;

/**
 * Which relay is in play for the error panel and status copy (see src/app/relay.js).
 * @returns {{ any: boolean, streams: boolean, builtin: boolean, own: boolean, builtinOff: boolean }}
 *   `any`: some relay is set (own or built-in); `streams`: streams may play through it; `builtin`: that
 *   relay is this site's built-in one; `own`: the user set their own; `builtinOff`: the site has a built-in
 *   relay but the user switched it off (and has no own relay).
 */
function relayContext(settings = {}) {
  const any = !!effectiveRelay(settings);
  return {
    any,
    streams: !!streamRelay(settings),
    builtin: isBuiltinRelayActive(settings),
    own: !!String(settings.corsProxy || '').trim(),
    builtinOff: !any && hasBuiltinRelay(),
  };
}

/** Map store settings to Player options (SPEC §3.4 constructor options). */
function playerOptionsFrom(settings = {}) {
  const retries = Number(settings.maxRetries);
  return {
    autoplay: settings.autoplay !== false,
    autoReconnect: settings.autoReconnect !== false,
    maxRetries: Number.isFinite(retries) ? clamp(Math.round(retries), 1, 30) : 8,
    upgradeInsecure: settings.upgradeInsecure !== false,
    lowLatency: settings.lowLatency !== false,
    preferNativeHls: !!settings.preferNativeHls,
    streamProxy: streamRelay(settings),
  };
}

/** Swallow promise rejections from fire-and-forget media calls (play() AbortError etc.). */
function settle(value) {
  if (value && typeof value.then === 'function') value.then(undefined, () => {});
}

function setText(el, text) {
  const value = text == null ? '' : String(text);
  if (el.textContent !== value) el.textContent = value;
}

/** Swap a button's icon only when it actually changes (keeps hover states stable). */
function swapIcon(container, name, size = ICON_SIZE) {
  if (container.dataset.icon === name) return;
  container.dataset.icon = name;
  setIcon(container, name, { size });
}

function setLabel(el, label, shortcut) {
  if (el.getAttribute('aria-label') !== label) el.setAttribute('aria-label', label);
  const title = shortcut ? `${label} (${shortcut})` : label;
  if (el.title !== title) el.title = title;
}

const fullscreenElement = () => document.fullscreenElement || document.webkitFullscreenElement || null;

let languageNames = null;
function languageName(code) {
  if (!code) return '';
  try {
    languageNames ??= new Intl.DisplayNames([navigator.language || 'en'], { type: 'language' });
    const name = languageNames.of(code);
    return name && name !== code ? name : code.toUpperCase();
  } catch {
    return String(code).toUpperCase();
  }
}

function trackLabel(track, i) {
  if (!track) return 'Default';
  return track.label || languageName(track.lang) || `Track ${i + 1}`;
}

function levelShort(level) {
  if (!level) return '';
  const label = typeof level.label === 'string' ? level.label.split(' · ')[0].trim() : '';
  if (label) return label;
  if (level.height) return `${level.height}p`;
  return formatBitrate(level.bitrate) || `Level ${Number(level.index) + 1}`;
}

/** Secondary text for a quality menu item (bitrate), unless the label already says it. */
function levelHint(level) {
  const hint = (typeof level.detail === 'string' && level.detail) || formatBitrate(level.bitrate);
  return hint && !levelShort(level).includes(hint) ? hint : '';
}

function reasonText(reason) {
  if (!reason) return '';
  if (typeof reason === 'object') return typeof reason.message === 'string' ? reason.message : '';
  const value = String(reason);
  const known = REASONS[value.toLowerCase()];
  if (known) return known;
  // Only show sentence-like reasons; internal codes ("fragLoadError") would just be noise.
  return /\s/.test(value) && value.length <= 160 ? value : '';
}

/**
 * The relay couldn't fetch the stream (unreachable, blocked or refused) — the Player's generic "couldn't play
 * through the relay" failures, as opposed to specific answers such as a 404 that came back through it.
 */
function isRelayReachFailure(error) {
  if (!error?.viaProxy) return false;
  if (error.code === E.NETWORK || error.code === E.CORS) return true;
  const status = Number(error.status) || 0;
  return error.code === E.HTTP && (status === 401 || status === 403);
}

/**
 * A failure through the relay that came with no HTTP status at all. The relay answers every request it
 * receives — upstream failures included (502, 404 …), with CORS headers — so this may mean that the relay
 * itself didn't answer (down, over its quota, blocked on this network), or that the stream kept it waiting
 * until the player gave up. Its health check tells the two apart.
 */
function mayBeRelayDown(error) {
  return isRelayReachFailure(error) && !(Number(error?.status) > 0);
}

const NO_RELAY = Object.freeze({
  any: false,
  streams: false,
  builtin: false,
  own: false,
  builtinOff: false,
  down: false,
});

/** RELAY_FAILED (or, once its health check failed, RELAY_DOWN) copy for the relay in use. */
function relayFailureCopy(relay) {
  if (relay.down && (relay.builtin || relay.own)) return relay.builtin ? RELAY_DOWN.builtin : RELAY_DOWN.own;
  if (relay.builtin) return RELAY_FAILED.builtin;
  return relay.own ? RELAY_FAILED.own : RELAY_FAILED.gone;
}

/**
 * The Player's reconnect reasons carry its own wording for relay failures ("Couldn’t play this stream through
 * the relay.") and no other hint: reword that one for the relay in use, pass everything else through.
 */
function relayAwareReason(text, relay) {
  return /\bthrough (?:the|your) (?:relay|proxy)\b/i.test(text) ? relayFailureCopy(relay).message : text;
}

/**
 * Copy + presentation for a Player error.
 * @param {object} error the Player's public error
 * @param {ReturnType<typeof relayContext> & { down?: boolean }} [relay] the relay settings right now (see
 *   relayContext()); `down`: the relay's health check failed after this error (see mayBeRelayDown())
 */
function describeError(error, relay = NO_RELAY) {
  const code = error?.code;
  const status = Number(error?.status) || 0;
  const out = {
    title: 'Something went wrong',
    icon: 'alert',
    kind: 'danger',
    skip: false,
    fallback: '',
    detail: undefined,
  };
  if (code != null) {
    switch (code) {
      case E.MIXED_CONTENT: {
        if (error?.localNetwork) {
          // On the local network: no relay can reach it. The Player's detail says what does work.
          Object.assign(out, {
            title: 'Blocked insecure stream',
            kind: 'warning',
            skip: true,
            fallback: 'This channel uses an insecure HTTP stream, which browsers block on secure (HTTPS) pages.',
          });
          break;
        }
        const upgraded = /\bhttps version\b/i.test(String(error?.detail || ''));
        let advice = MIXED_DETAIL.noRelay;
        if (relay.streams) advice = MIXED_DETAIL.relayReady;
        else if (relay.any) advice = MIXED_DETAIL.streamsOff;
        else if (relay.builtinOff) advice = MIXED_DETAIL.builtinOff;
        Object.assign(out, {
          title: 'Blocked insecure stream',
          kind: 'warning',
          // Without a relay nothing changes on retry; once one is on, retrying is the fix.
          skip: !relay.streams,
          fallback: 'This channel uses an insecure HTTP stream, which browsers block on secure (HTTPS) pages.',
          detail: (upgraded ? MIXED_DETAIL.upgraded : '') + advice,
        });
        break;
      }
      case E.UNSUPPORTED:
        Object.assign(out, {
          title: 'Format not supported',
          icon: 'tv',
          kind: 'warning',
          skip: true,
          fallback: "This stream format can't be played in a web browser.",
        });
        break;
      case E.DRM:
        Object.assign(out, {
          title: 'Protected content',
          kind: 'warning',
          skip: true,
          fallback: 'DRM-protected channels are not supported in the browser player.',
        });
        break;
      case E.OFFLINE:
        Object.assign(out, {
          title: "You're offline",
          icon: 'wifi-off',
          kind: 'neutral',
          fallback: 'Check your internet connection — playback resumes when you are back online.',
        });
        break;
      case E.CORS:
        Object.assign(out, {
          title: "Can't reach this stream",
          icon: 'broadcast',
          fallback: "The server may be offline, or it doesn't allow playback in web browsers.",
        });
        break;
      case E.NETWORK:
        Object.assign(out, {
          title: 'Stream unavailable',
          icon: 'wifi-off',
          fallback: 'The connection to the stream was lost.',
        });
        break;
      case E.HTTP:
        if (status === 401 || status === 403) {
          Object.assign(out, { title: 'Access denied', fallback: 'The stream server refused the request.' });
        } else if (status === 404 || status === 410) {
          Object.assign(out, {
            title: 'Channel not found',
            fallback: 'The stream no longer exists at this address.',
          });
        } else if (status >= 500) {
          Object.assign(out, { title: 'Server error', fallback: 'The stream server is having problems.' });
        } else {
          Object.assign(out, { title: 'Stream unavailable', fallback: 'The stream server returned an error.' });
        }
        break;
      case E.MANIFEST:
        Object.assign(out, { title: 'Invalid stream', fallback: "The stream's playlist couldn't be read." });
        break;
      case E.MEDIA:
        Object.assign(out, { title: 'Playback error', fallback: "The video couldn't be decoded." });
        break;
      case E.AUTOPLAY:
        Object.assign(out, {
          title: 'Playback blocked',
          icon: 'play',
          kind: 'neutral',
          fallback: 'Your browser blocked automatic playback. Press play to start.',
        });
        break;
      default:
        break;
    }
  }
  // The Player says "the relay" for every relay failure; name the relay that's actually in use.
  const relayCopy = isRelayReachFailure(error) ? relayFailureCopy(relay) : null;
  if (relayCopy?.title) out.title = relayCopy.title;
  const message = relayCopy?.message || (typeof error?.message === 'string' && error.message.trim()) ||
    out.fallback || 'The stream stopped unexpectedly.';
  const details = [];
  const detail = relayCopy ? relayCopy.detail : typeof out.detail === 'string' ? out.detail : error?.detail;
  if (typeof detail === 'string' && detail.trim() && detail.trim() !== message) details.push(detail.trim());
  if (status && !message.includes(String(status))) details.push(`HTTP ${status}`);
  return { ...out, message, detail: details.join(' · ') };
}

/** Blocked by the browser (insecure stream on a secure page, or no CORS) — what a stream relay fixes, except
 * on the local network (a relay can't reach it). */
function isProxyFixable(error) {
  if (!error || error.viaProxy || error.localNetwork) return false;
  return !!error.canUseProxy || error.code === E.MIXED_CONTENT || error.code === E.CORS;
}

/**
 * Create the player view.
 * @param {{ store: ReturnType<import('../app/store.js').createStore>, actions: Record<string, Function> }} deps
 * @returns {{
 *   el: HTMLElement, player: Player,
 *   togglePlay(): void, toggleMute(): void, setVolume(v: number): void, volumeBy(delta: number): void,
 *   toggleFullscreen(): Promise<void>, togglePip(): Promise<void>, seekBy(sec: number): boolean, retry(): void,
 *   toggleStats(): void, focus(): void, destroy(): void,
 * }}
 */
export function createPlayerView({ store, actions }) {
  const uid = `pv${++instances}`;
  const offs = [];
  const listen = (target, type, fn, opts) => {
    if (target && typeof target.addEventListener === 'function') offs.push(on(target, type, fn, opts));
  };

  // ---- View state -----------------------------------------------------------------------------------------
  let viewState = 'idle';
  let pendingLoad = false;
  let loadSeq = 0;
  let lastError = null;
  let levels = [];
  let playingLevel = -1;
  let playingLabel = '';
  let audioTracks = [];
  let currentAudio = -1;
  let reconnect = null; // { attempt, max, deadline, reason }
  let reconnectTimer = 0;
  let offlineWait = false; // RECONNECTING because the device went offline (no attempts consumed)
  let autoplayBlocked = false; // PAUSED because the browser refused autoplay
  let autoMuted = false;
  let volumeIntentAt = -Infinity; // not 0: performance.now() starts near 0 and would look like a fresh intent
  let lastVolume = 1;
  let controlsShown = true;
  let hideTimer = 0;
  let pointerInControls = false;
  let menuHandle = null;
  let menuClosedAt = 0;
  let keyboardMode = false;
  let lastPointerType = 'mouse';
  let lastMove = { x: NaN, y: NaN };
  let pendingClick = 0;
  let clickToggledAt = 0;
  let scrub = null; // { id, time }
  let statsOpen = false;
  let statsTimer = 0;
  let osdTimer = 0;
  let announceTimer = 0;
  let behindLive = false;
  let liveBaseline = Infinity;
  let pausedAt = 0;
  let iosFullscreen = false;
  let orientationLocked = false;
  let navAvailable = false;
  let proxyNotice = ''; // stream URL that switched to the relay and hasn't played yet ('proxy' event)
  const proxyNoticed = new Set(); // stream URLs that already showed the "through your relay" toast
  let reportFor = null; // channel of the current load (health reports: markChannelOk / markChannelFailed)
  let reportedOk = false; // its playing state was reported since the load started / last failed
  let destroyed = false;

  const hasChannel = () => !!store.get().currentChannel;
  const currentChannel = () => store.get().currentChannel;
  const hasMedia = () => viewState === 'playing' || viewState === 'paused' || viewState === 'buffering';
  const markVolumeIntent = () => {
    volumeIntentAt = performance.now();
  };
  const viaProxy = () => player.viaProxy === true;
  const relayNow = () => relayContext(store.get().settings || {});
  let relayProbe = null; // { controller, timer } of the pending relay health check (see checkRelayThenReport)
  let relayDownError = null; // the error after which the relay's health check failed too
  /** relayNow() for presenting `err`: also tells whether the relay turned out to be unreachable then. */
  const relayFor = (err) => ({ ...relayNow(), down: !!err && err === relayDownError });

  // ---- Shared button helpers ------------------------------------------------------------------------------
  /**
   * Mouse clicks on player buttons must not leave focus on the button (Space would re-activate it instead of
   * toggling playback). Keep focus on the player root instead; keyboard users are unaffected.
   */
  const keepFocusOnPlayer = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    if (document.activeElement !== root) root.focus({ preventScroll: true });
  };

  const ctrlBtn = (name, label, onClick, extraClass, shortcut) => {
    const btn = h(
      'button',
      { type: 'button', class: ['pv-btn', extraClass], onClick, onMousedown: keepFocusOnPlayer },
      icon(name, { size: ICON_SIZE }),
    );
    btn.dataset.icon = name;
    setLabel(btn, label, shortcut);
    return btn;
  };

  // ---- Video ----------------------------------------------------------------------------------------------
  const video = h('video', {
    class: 'pv-video',
    playsinline: true,
    'webkit-playsinline': true,
    preload: 'auto',
    'x-webkit-airplay': 'allow',
    tabIndex: -1,
  });
  video.playsInline = true;
  video.controls = false;

  const initial = store.get();
  const initialVolume = Number(initial.volume);
  video.volume = Number.isFinite(initialVolume) ? clamp(initialVolume, 0, 1) : 1;
  video.muted = !!initial.muted;
  lastVolume = video.volume > 0 ? video.volume : 1;

  // Transparent layer above the video that receives clicks/taps (play/pause, double-click fullscreen).
  const hit = h('div', { class: 'pv-hit', 'aria-hidden': 'true' });

  // ---- Idle layer (welcome hero / select prompt / busy / failed) ------------------------------------------
  const demoSpinner = h('span', { class: 'spinner spinner-sm', hidden: true, 'aria-hidden': 'true' });
  const heroAddBtn = h(
    'button',
    { type: 'button', class: 'btn btn-primary btn-lg pv-hero-btn', onClick: () => openAdd() },
    icon('plus', { size: 18 }),
    'Add playlist',
  );
  const heroDemoBtn = h(
    'button',
    { type: 'button', class: 'btn btn-secondary btn-lg pv-hero-btn', onClick: () => loadDemo() },
    icon('play', { size: 16 }),
    demoSpinner,
    'Try demo channels',
  );
  const welcome = h(
    'div',
    { class: 'pv-hero pv-idle-welcome' },
    h('div', { class: 'pv-hero-logo', 'aria-hidden': 'true' }, icon('logo', { size: 34, strokeWidth: 1.75 })),
    h('h2', { class: 'pv-hero-title', text: 'Your channels, beautifully simple.' }),
    h('p', {
      class: 'pv-hero-text',
      text:
        'Add an M3U playlist by link or file and start watching in seconds. Everything stays in your browser.',
    }),
    h('div', { class: 'pv-hero-actions' }, heroAddBtn, heroDemoBtn),
    h('p', { class: 'pv-hero-hint' }, icon('upload', { size: 14 }), 'or drop an .m3u file anywhere'),
  );

  const selectPrompt = h(
    'div',
    { class: 'pv-prompt pv-idle-select' },
    h('div', { class: 'pv-prompt-icon', 'aria-hidden': 'true' }, icon('tv', { size: 26, strokeWidth: 1.75 })),
    h('h2', { class: 'pv-prompt-title', text: 'Select a channel to start watching' }),
    h(
      'p',
      { class: 'pv-prompt-text' },
      h(
        'span',
        { class: 'pv-when-pointer' },
        'Pick one from the list, or press ',
        h('kbd', { class: 'kbd' }, '/'),
        ' to search.',
      ),
      h('span', { class: 'pv-when-touch' }, 'Pick a channel from the list to begin.'),
    ),
  );

  const busyTitle = h('h2', { class: 'pv-prompt-title', text: 'Loading playlist…' });
  const busyPrompt = h(
    'div',
    { class: 'pv-prompt pv-idle-busy' },
    h('div', { class: 'spinner', 'aria-hidden': 'true' }),
    busyTitle,
  );

  const failedText = h('p', { class: 'pv-prompt-text' });
  const failedRetryBtn = h(
    'button',
    { type: 'button', class: 'btn btn-secondary btn-sm', onClick: () => retryPlaylist() },
    icon('refresh', { size: 15 }),
    'Try again',
  );
  const failedAddBtn = h(
    'button',
    { type: 'button', class: 'btn btn-ghost btn-sm', onClick: () => openAdd() },
    icon('plus', { size: 15 }),
    'Add playlist',
  );
  const failedPrompt = h(
    'div',
    { class: 'pv-prompt pv-idle-failed' },
    h(
      'div',
      { class: 'pv-prompt-icon pv-prompt-icon-danger', 'aria-hidden': 'true' },
      icon('alert', { size: 24 }),
    ),
    h('h2', { class: 'pv-prompt-title', text: "This playlist couldn't be loaded" }),
    failedText,
    h('div', { class: 'pv-prompt-actions' }, failedRetryBtn, failedAddBtn),
  );

  const idleLayer = h('div', { class: 'pv-idle' }, welcome, selectPrompt, busyPrompt, failedPrompt);

  // ---- Status layer (connecting / buffering / reconnecting) -----------------------------------------------
  const statusText = h('p', { class: 'pv-status-text' });
  const statusSub = h('p', { class: 'pv-status-sub' });
  const statusRetryBtn = h(
    'button',
    { type: 'button', class: 'pv-chip-btn pv-status-retry', onClick: () => retry() },
    icon('refresh', { size: 14 }),
    'Retry now',
  );
  const statusLayer = h(
    'div',
    { class: 'pv-status' },
    h('div', { class: 'spinner spinner-lg pv-status-spinner', 'aria-hidden': 'true' }),
    statusText,
    statusSub,
    statusRetryBtn,
  );

  // ---- Big play button, unmute pill, OSD, PiP placeholder -------------------------------------------------
  const bigPlayBtn = h(
    'button',
    { type: 'button', class: 'pv-bigplay', onClick: () => togglePlay(), onMousedown: keepFocusOnPlayer },
    icon('play', { size: 30 }),
  );
  setLabel(bigPlayBtn, 'Play', 'Space');
  const bigPlay = h('div', { class: 'pv-bigplay-wrap' }, bigPlayBtn);

  const unmuteBtn = h(
    'button',
    {
      type: 'button',
      class: 'pv-unmute',
      'aria-label': 'Unmute',
      onClick: () => unmute(),
      onMousedown: keepFocusOnPlayer,
    },
    icon('volume-mute', { size: 16 }),
    h('span', { class: 'pv-when-touch', 'aria-hidden': 'true', text: 'Tap to unmute' }),
    h('span', { class: 'pv-when-pointer', 'aria-hidden': 'true', text: 'Click to unmute' }),
  );

  const osdText = h('span', { class: 'pv-osd-text' });
  const osdMeter = h('span', { class: 'pv-osd-meter', hidden: true }, h('span', { class: 'pv-osd-meter-fill' }));
  const osd = h(
    'div',
    { class: 'pv-osd', 'aria-hidden': 'true' },
    icon('volume-high', { size: 16 }),
    osdText,
    osdMeter,
  );

  const pipNote = h(
    'div',
    { class: 'pv-pipnote' },
    icon('pip', { size: 30, strokeWidth: 1.6 }),
    h('p', { text: 'Playing in picture-in-picture' }),
    h(
      'button',
      { type: 'button', class: 'pv-chip-btn', onClick: () => togglePip(), onMousedown: keepFocusOnPlayer },
      'Return to player',
    ),
  );

  // ---- Error panel ----------------------------------------------------------------------------------------
  const errTitleId = `${uid}-error-title`;
  const errIcon = h('div', { class: 'pv-error-icon', 'aria-hidden': 'true' }, icon('alert', { size: 22 }));
  errIcon.dataset.icon = 'alert';
  const errTitle = h('h2', { class: 'pv-error-title', id: errTitleId });
  const errMessage = h('p', { class: 'pv-error-message' });
  const errDetail = h('p', { class: 'pv-error-detail' });
  const errRetryBtn = h(
    'button',
    { type: 'button', class: 'btn btn-sm pv-err-btn', onClick: () => retry() },
    icon('refresh', { size: 15 }),
    'Retry',
  );
  const errNextBtn = h(
    'button',
    { type: 'button', class: 'btn btn-sm pv-err-btn', onClick: () => actions.playNext() },
    icon('skip-forward', { size: 15 }),
    'Next channel',
  );
  const errCopyBtn = h(
    'button',
    { type: 'button', class: 'btn btn-sm pv-err-btn pv-glass pv-err-copy', onClick: () => copyUrl() },
    icon('copy', { size: 15 }),
    'Copy stream URL',
  );
  // Blocked by the browser and no relay at all → the setup guide; a relay that's switched off, or the user's
  // own relay failed → the relay settings.
  const errProxyBtn = h(
    'button',
    { type: 'button', class: 'btn btn-sm pv-err-btn pv-err-proxy', onClick: () => openProxyFix() },
    icon('broadcast', { size: 15 }),
    'Fix with a relay',
  );
  const errProxySettingsBtn = h(
    'button',
    { type: 'button', class: 'btn btn-sm pv-err-btn pv-err-proxy', onClick: () => openProxySettings() },
    icon('settings', { size: 15 }),
    'Relay settings',
  );
  const errActions = h(
    'div',
    { class: 'pv-error-actions' },
    errRetryBtn,
    errNextBtn,
    errProxyBtn,
    errProxySettingsBtn,
    errCopyBtn,
  );
  /** Classes a button keeps whatever its rank in the error panel. */
  const errBtnClass = new Map([
    [errCopyBtn, ' pv-err-copy'],
    [errProxyBtn, ' pv-err-proxy'],
    [errProxySettingsBtn, ' pv-err-proxy'],
  ]);
  const errorPanel = h(
    'div',
    { class: 'pv-error', role: 'group', 'aria-labelledby': errTitleId },
    h('div', { class: 'pv-error-card' }, errIcon, errTitle, errMessage, errDetail, errActions),
  );

  // ---- Top bar --------------------------------------------------------------------------------------------
  const topAvatar = h('span', { class: 'pv-top-avatar' });
  const topTitle = h('div', { class: 'pv-top-title truncate' });
  const topSub = h('div', { class: 'pv-top-sub truncate' });
  const topBar = h('div', { class: 'pv-top' }, topAvatar, h('div', { class: 'pv-top-text' }, topTitle, topSub));

  // ---- Stats overlay --------------------------------------------------------------------------------------
  const statCells = {};
  const statsGrid = h('dl', { class: 'pv-stats-grid' });
  for (const [key, label] of STAT_ROWS) {
    const dd = h('dd', { class: key === 'url' ? 'pv-stats-url' : undefined, text: '—' });
    statCells[key] = dd;
    statsGrid.append(h('div', { class: 'pv-stats-row' }, h('dt', { text: label }), dd));
  }
  const statsCopyBtn = h(
    'button',
    {
      type: 'button',
      class: 'pv-btn pv-btn-xs',
      'aria-label': 'Copy stream URL',
      title: 'Copy stream URL',
      onClick: () => copyUrl(),
      onMousedown: keepFocusOnPlayer,
    },
    icon('copy', { size: 14 }),
  );
  const statsCloseBtn = h(
    'button',
    {
      type: 'button',
      class: 'pv-btn pv-btn-xs',
      'aria-label': 'Close stream info',
      title: 'Close (I)',
      onClick: () => toggleStats(false),
      onMousedown: keepFocusOnPlayer,
    },
    icon('close', { size: 14 }),
  );
  const statsPanel = h(
    'div',
    { class: 'pv-stats', role: 'group', 'aria-label': 'Stream info', hidden: true },
    h(
      'div',
      { class: 'pv-stats-head' },
      h('span', { class: 'pv-stats-title' }, icon('activity', { size: 14 }), 'Stream info'),
      h('span', { class: 'pv-stats-tools' }, statsCopyBtn, statsCloseBtn),
    ),
    statsGrid,
  );

  // ---- Control bar ----------------------------------------------------------------------------------------
  const prevBtn = ctrlBtn('skip-back', 'Previous channel', () => actions.playPrev(), 'pv-prev', 'B');
  const playBtn = ctrlBtn('play', 'Play', () => togglePlay(), 'pv-play', 'Space');
  const nextBtn = ctrlBtn('skip-forward', 'Next channel', () => actions.playNext(), 'pv-next', 'N');
  playBtn.setAttribute('aria-keyshortcuts', 'Space K');
  prevBtn.setAttribute('aria-keyshortcuts', 'B PageUp');
  nextBtn.setAttribute('aria-keyshortcuts', 'N PageDown');

  const muteBtn = ctrlBtn('volume-high', 'Mute', () => toggleMuteInternal(false), 'pv-mute', 'M');
  muteBtn.setAttribute('aria-keyshortcuts', 'M');
  const volumeSlider = h('input', {
    type: 'range',
    class: 'pv-volume-slider',
    min: '0',
    max: '1',
    step: '0.01',
    'aria-label': 'Volume',
    onInput: (e) => setVolumeInternal(Number(e.target.value)),
    onKeydown: (e) => {
      // Keep arrow keys on the slider instead of the global seek/volume shortcuts.
      if (SLIDER_KEYS.has(e.key)) e.stopPropagation();
    },
  });
  const volumeWrap = h('div', { class: 'pv-volume-wrap' }, volumeSlider);
  const volumeGroup = h('div', { class: 'pv-volume' }, muteBtn, volumeWrap);

  const liveLabel = h('span', { class: 'pv-live-label', text: 'Live' });
  const liveBtn = h(
    'button',
    {
      type: 'button',
      class: 'badge badge-live pv-live',
      hidden: true,
      onClick: () => goLive(),
      onMousedown: keepFocusOnPlayer,
    },
    liveLabel,
  );
  setLabel(liveBtn, 'Live');

  const timeCur = h('span', { class: 'pv-time-cur', text: '0:00' });
  const timeDur = h('span', { class: 'pv-time-dur', text: '0:00' });
  const timeEl = h(
    'div',
    { class: 'pv-time', hidden: true, 'aria-hidden': 'true' },
    timeCur,
    h('span', { class: 'pv-time-sep', text: ' / ' }),
    timeDur,
  );

  const statsBtn = ctrlBtn('activity', 'Stream info', () => toggleStats(), 'pv-stats-btn', 'I');
  statsBtn.setAttribute('aria-pressed', 'false');

  const audioText = h('span', { class: 'pv-btn-text' });
  const audioBtn = h(
    'button',
    {
      type: 'button',
      class: 'pv-btn pv-btn-labeled pv-audio',
      hidden: true,
      'aria-haspopup': 'menu',
      'aria-expanded': 'false',
      onClick: () => openAudioMenu(),
      onMousedown: keepFocusOnPlayer,
    },
    icon('list', { size: ICON_SIZE }),
    audioText,
  );
  setLabel(audioBtn, 'Audio track');

  const qualityText = h('span', { class: 'pv-btn-text' });
  const qualityBtn = h(
    'button',
    {
      type: 'button',
      class: 'pv-btn pv-btn-labeled pv-quality',
      hidden: true,
      'aria-haspopup': 'menu',
      'aria-expanded': 'false',
      onClick: () => openQualityMenu(),
      onMousedown: keepFocusOnPlayer,
    },
    icon('layers', { size: ICON_SIZE }),
    qualityText,
  );
  setLabel(qualityBtn, 'Quality');

  const pipBtn = ctrlBtn('pip', 'Picture-in-picture', () => togglePip(), 'pv-pip-btn', 'P');
  pipBtn.setAttribute('aria-pressed', 'false');
  const fsBtn = ctrlBtn('fullscreen', 'Fullscreen', () => toggleFullscreen(), 'pv-fs-btn', 'F');

  // Seek bar (custom slider: played + buffered ranges, hover tooltip, keyboard support).
  const seekTip = h('div', { class: 'pv-seek-tip', 'aria-hidden': 'true' });
  const seekTrack = h(
    'div',
    { class: 'pv-seek-track' },
    h('div', { class: 'pv-seek-buffered' }),
    h('div', { class: 'pv-seek-hover' }),
    h('div', { class: 'pv-seek-played' }),
  );
  const seek = h(
    'div',
    {
      class: 'pv-seek',
      role: 'slider',
      tabIndex: 0,
      hidden: true,
      'aria-label': 'Seek',
      'aria-valuemin': '0',
      'aria-valuemax': '0',
      'aria-valuenow': '0',
    },
    seekTrack,
    h('div', { class: 'pv-seek-thumb' }),
    seekTip,
  );

  const barLeft = h(
    'div',
    { class: 'pv-bar-group pv-bar-left' },
    prevBtn,
    playBtn,
    nextBtn,
    volumeGroup,
    liveBtn,
    timeEl,
  );
  const barRight = h(
    'div',
    { class: 'pv-bar-group pv-bar-right' },
    statsBtn,
    audioBtn,
    qualityBtn,
    pipBtn,
    fsBtn,
  );
  const bar = h('div', { class: 'pv-bar' }, barLeft, barRight);
  const controls = h('div', { class: 'pv-controls', role: 'group', 'aria-label': 'Player controls' }, seek, bar);

  const announcer = h('div', {
    class: 'visually-hidden',
    role: 'status',
    'aria-live': 'polite',
    'aria-atomic': 'true',
  });

  // ---- Root -----------------------------------------------------------------------------------------------
  const root = h(
    'div',
    {
      class: 'pv',
      role: 'group',
      'aria-label': 'Video player',
      tabIndex: -1,
      dataset: { state: 'idle', controls: 'visible', idle: 'boot', input: 'mouse' },
    },
    video,
    hit,
    pipNote,
    statusLayer,
    bigPlay,
    osd,
    topBar,
    statsPanel,
    controls,
    unmuteBtn,
    errorPanel,
    idleLayer,
    announcer,
  );

  // ---- Now-playing card -----------------------------------------------------------------------------------
  const infoAvatar = h('div', { class: 'pv-info-avatar' });
  const infoTitle = h('h1', { class: 'pv-info-title' });
  const infoGroups = h('div', { class: 'pv-info-groups' });
  const infoChno = h('span', { class: 'pv-info-chno', hidden: true });
  const infoStatusText = h('span', { class: 'pv-info-status-text' });
  const infoStatus = h(
    'span',
    { class: 'pv-info-status' },
    h('span', { class: 'pv-dot', 'aria-hidden': 'true' }),
    infoStatusText,
  );
  const infoMeta = h('div', { class: 'pv-info-meta' }, infoGroups, infoChno, infoStatus);

  const infoBtn = (name, label, onClick, extraClass, shortcut) => {
    const btn = h(
      'button',
      { type: 'button', class: ['icon-btn pv-info-btn', extraClass], onClick, onMousedown: keepFocusOnPlayer },
      icon(name, { size: 18 }),
    );
    btn.dataset.icon = name;
    setLabel(btn, label, shortcut);
    return btn;
  };
  const favBtn = infoBtn('star', 'Add to favorites', () => toggleFavorite(), 'pv-fav', 'S');
  favBtn.setAttribute('aria-pressed', 'false');
  const copyBtn = infoBtn('link', 'Copy stream URL', () => copyUrl(), 'pv-copy');
  const infoPrevBtn = infoBtn('skip-back', 'Previous channel', () => actions.playPrev(), 'pv-info-nav', 'B');
  const infoNextBtn = infoBtn('skip-forward', 'Next channel', () => actions.playNext(), 'pv-info-nav', 'N');

  const infoMain = h(
    'div',
    { class: 'pv-info-main' },
    infoAvatar,
    h('div', { class: 'pv-info-text' }, infoTitle, infoMeta),
    h(
      'div',
      { class: 'pv-info-actions' },
      favBtn,
      copyBtn,
      h('span', { class: 'pv-info-sep', 'aria-hidden': 'true' }),
      infoPrevBtn,
      infoNextBtn,
    ),
  );

  const tips = h(
    'div',
    { class: 'pv-tips', 'aria-label': 'Keyboard shortcuts' },
    TIP_IDS.map((id) => {
      const sc = SHORTCUTS.find((s) => s.id === id);
      if (!sc) return null;
      return h(
        'span',
        { class: 'pv-tip' },
        h('kbd', { class: 'kbd', text: sc.label[0] }),
        h('span', { text: TIP_LABELS[id] || sc.description }),
      );
    }),
  );

  const info = h('section', { class: 'pv-info', 'aria-label': 'Now playing', hidden: true }, infoMain, tips);
  const el = h('div', { class: 'pv-stage-inner' }, root, info);

  // ---- Player ---------------------------------------------------------------------------------------------
  const player = new Player(video, playerOptionsFrom(store.get().settings || {}));
  const onPlayer = (type, fn) => {
    player.addEventListener(type, fn);
    offs.push(() => player.removeEventListener(type, fn));
  };

  // ---------------------------------------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------------------------------------

  function computeViewState() {
    if (!hasChannel()) return 'idle';
    switch (player.state) {
      case S.LOADING:
        return 'loading';
      case S.PLAYING:
        return 'playing';
      case S.PAUSED:
        return 'paused';
      case S.BUFFERING:
        return 'buffering';
      case S.RECONNECTING:
        return 'reconnecting';
      case S.ERROR:
        return 'error';
      default:
        return pendingLoad ? 'loading' : 'ready';
    }
  }

  function currentError() {
    return player.error || lastError;
  }

  function isOffline() {
    if (offlineWait || (typeof navigator !== 'undefined' && navigator.onLine === false)) return true;
    return viewState === 'reconnecting' && !reconnect && currentError()?.code === E.OFFLINE;
  }

  function renderState() {
    if (destroyed) return;
    const prev = viewState;
    const next = computeViewState();
    viewState = next;
    root.dataset.state = next;

    const playingish = ['playing', 'buffering', 'loading', 'reconnecting'].includes(next);
    swapIcon(playBtn, playingish ? 'pause' : 'play');
    setLabel(playBtn, playingish ? 'Pause' : 'Play', 'Space');

    renderStatus();
    if (next === 'error') renderError();
    renderTimeline();
    renderInfoStatus();
    renderPip();
    renderMediaSessionState();
    if (statsOpen) renderStats();

    if (next !== prev) onViewStateChange(prev, next);
  }

  function onViewStateChange(prev, next) {
    const ch = currentChannel();
    if (next === 'paused' && (prev === 'playing' || prev === 'buffering') && live()) pausedAt = Date.now();
    if (next === 'playing' && pausedAt) {
      // Resuming a live stream after a real pause leaves you behind the live edge.
      if (live() && Date.now() - pausedAt > PAUSE_BEHIND_MS) behindLive = true;
      pausedAt = 0;
    }

    if (next === 'idle' || next === 'error') {
      closeMenu();
      setUnmutePill(false, true);
    }

    if (next === 'playing' || next === 'buffering') scheduleHide();
    else {
      clearHideTimer();
      setControlsShown(true);
    }

    // Announcements for assistive tech (buffering is intentionally silent).
    if (next === 'loading' && prev !== 'loading' && ch && !reconnect) announce(`Connecting to ${ch.name}`);
    else if (next === 'playing' && (prev === 'loading' || prev === 'reconnecting' || prev === 'ready') && ch) {
      announce(`Playing ${ch.name}`);
    } else if (next === 'paused' && autoplayBlocked) announce('Autoplay was blocked. Press play to start.');
    else if (next === 'paused' && (prev === 'playing' || prev === 'buffering')) announce('Paused');
    else if (next === 'error') {
      const info = describeError(currentError(), relayFor(currentError()));
      announce(`${info.title}. ${info.message}`);
      // If the user was operating the player by keyboard, move focus to the primary recovery action.
      const ae = document.activeElement;
      if (ae && ae !== root && root.contains(ae) && !errorPanel.contains(ae)) {
        requestAnimationFrame(() => {
          if (viewState === 'error') errActions.firstElementChild?.focus({ preventScroll: true });
        });
      }
    }
  }

  function renderStatus() {
    const st = viewState;
    statusRetryBtn.hidden = st !== 'reconnecting';
    if (st === 'loading') {
      const connecting = viaProxy() ? 'Connecting via relay…' : 'Connecting…';
      setText(statusText, reconnect ? reconnectLabel() : connecting);
      setText(statusSub, currentChannel()?.name || '');
    } else if (st === 'buffering') {
      setText(statusText, 'Buffering…');
      setText(statusSub, '');
    } else if (st === 'reconnecting') {
      setText(statusText, reconnectLabel());
      const sub = isOffline()
        ? 'Waiting for the network to come back…'
        : relayAwareReason(reasonText(reconnect?.reason), relayNow());
      setText(statusSub, sub);
    }
  }

  function reconnectLabel() {
    if (isOffline()) return "You're offline";
    if (!reconnect) return 'Reconnecting…';
    const parts = ['Reconnecting'];
    if (reconnect.attempt) {
      parts.push(`attempt ${reconnect.attempt}${reconnect.max ? ` of ${reconnect.max}` : ''}`);
    }
    const secs = Math.ceil((reconnect.deadline - performance.now()) / 1000);
    if (viewState === 'reconnecting' && secs >= 1) parts.push(`in ${secs}s`);
    return `${parts.join(' · ')}${viewState === 'reconnecting' && secs >= 1 ? '' : '…'}`;
  }

  function startCountdown(detail = {}) {
    const delay = Math.max(0, Number(detail.delayMs) || 0);
    reconnect = {
      attempt: Number(detail.attempt) || Number(player.attempt) || 0,
      max: Number(detail.max) || playerOptionsFrom(store.get().settings || {}).maxRetries,
      deadline: performance.now() + delay,
      reason: detail.reason,
    };
    clearInterval(reconnectTimer);
    reconnectTimer = setInterval(() => {
      if (viewState !== 'reconnecting' && viewState !== 'loading') return;
      renderStatus();
      renderInfoStatus();
    }, 250);
    renderState();
    const attemptText = reconnect.attempt ? `, attempt ${reconnect.attempt} of ${reconnect.max}` : '';
    announce(
      isOffline()
        ? 'You are offline. Waiting for the connection to come back.'
        : `Connection lost. Reconnecting${attemptText}.`,
    );
  }

  function stopCountdown() {
    clearInterval(reconnectTimer);
    reconnectTimer = 0;
    reconnect = null;
  }

  function renderError() {
    const err = currentError();
    const relay = relayFor(err);
    const info = describeError(err, relay);
    root.dataset.error = info.kind;
    swapIcon(errIcon, info.icon, 22);
    setText(errTitle, info.title);
    setText(errMessage, info.message);
    setText(errDetail, info.detail);
    errDetail.hidden = !info.detail;

    // Blocked by the browser and streams can't use a relay right now: offer the fix first — the setup guide
    // when there's no relay at all, else Settings (a relay that's switched off). Retrying an insecure stream
    // can't help until then. The user's own relay failing also points to Settings; the built-in one doesn't
    // (there's nothing to configure), only Retry / Next channel.
    const fixable = isProxyFixable(err) && !relay.streams;
    const offerGuide = fixable && !relay.any && !relay.builtinOff;
    const offerSettings = (fixable && !offerGuide) || (!!err?.viaProxy && relay.own);
    const first = info.skip ? errNextBtn : errRetryBtn;
    const second = info.skip ? errRetryBtn : errNextBtn;
    const order = [first, second, errProxySettingsBtn, errProxyBtn, errCopyBtn];
    const lead = offerGuide ? errProxyBtn : fixable ? errProxySettingsBtn : null;
    if (lead) order.unshift(...order.splice(order.indexOf(lead), 1));
    errProxyBtn.hidden = !offerGuide;
    errProxySettingsBtn.hidden = !offerSettings;
    // Retrying a blocked insecure stream changes nothing: not before a relay is on, never on the local network.
    errRetryBtn.hidden = (fixable || !!err?.localNetwork) && err?.code === E.MIXED_CONTENT;
    errCopyBtn.hidden = !currentChannel()?.url;
    order.forEach((btn, i) => {
      const rank = i === 0 ? 'btn btn-primary btn-sm pv-err-btn' : 'btn btn-sm pv-err-btn pv-glass';
      const cls = rank + (errBtnClass.get(btn) || '');
      if (btn.className !== cls) btn.className = cls;
      // Reorder in place only when needed: moving a focused button would drop its focus.
      if (errActions.children[i] !== btn) errActions.insertBefore(btn, errActions.children[i] || null);
    });
    setData(errActions, 'crowded', order.filter((btn) => !btn.hidden).length > 3);
    errNextBtn.disabled = !navAvailable;
  }

  // ---- Timeline (live badge, VOD time, seek bar) ----------------------------------------------------------

  function live() {
    return !!player.isLive;
  }

  function seekableEnd() {
    const s = video.seekable;
    if (!s || !s.length) return NaN;
    try {
      return s.end(s.length - 1);
    } catch {
      return NaN;
    }
  }

  /** Seekable range for the seek bar: the DVR window for live streams, 0…duration for VOD. */
  function seekRange(isLive = live()) {
    if (isLive) {
      const s = video.seekable;
      if (!s || !s.length) return null;
      try {
        const start = s.start(0);
        const end = s.end(s.length - 1);
        const ok = Number.isFinite(start) && Number.isFinite(end) && end - start > 1;
        return ok ? { start, end, live: true } : null;
      } catch {
        return null;
      }
    }
    const d = video.duration;
    return Number.isFinite(d) && d > 0 ? { start: 0, end: d, live: false } : null;
  }

  function renderTimeline() {
    const media = hasMedia();
    const isLive = media && live();
    const range = media && player.canSeek ? seekRange(isLive) : null;
    setData(root, 'live', isLive);
    setData(root, 'seekable', !!range);
    liveBtn.hidden = !isLive;
    seek.hidden = !range;
    const dur = video.duration;
    const showTime = media && !isLive && Number.isFinite(dur) && dur > 0;
    timeEl.hidden = !showTime;

    const pos = scrub ? scrub.time : video.currentTime || 0;
    if (isLive) renderLiveEdge(range);
    if (showTime) {
      setText(timeCur, formatDuration(pos));
      setText(timeDur, formatDuration(dur));
    }
    if (range) paintSeek(range, pos);
  }

  function renderLiveEdge(range) {
    // `isBehindLive` is an engine extra (not in the base contract) — preferred when present.
    const engineBehind = player.isBehindLive;
    const edge = range ? range.end : seekableEnd();
    if (typeof engineBehind === 'boolean' && !scrub) {
      behindLive = engineBehind;
    } else if (Number.isFinite(edge) && !scrub) {
      const lag = edge - (video.currentTime || 0);
      if (viewState === 'playing' && !video.paused && lag >= 0) liveBaseline = Math.min(liveBaseline, lag);
      const delta = lag - liveBaseline;
      if (behindLive && viewState === 'playing' && delta < BEHIND_LIVE_CLEAR) behindLive = false;
      else if (!behindLive && Number.isFinite(delta) && delta > BEHIND_LIVE_SET) behindLive = true;
    }
    setData(liveBtn, 'behind', behindLive);
    setText(liveLabel, behindLive ? 'Go live' : 'Live');
    setLabel(liveBtn, behindLive ? 'Jump to live' : 'Live — watching at the live edge');
  }

  function paintSeek(range, pos) {
    const span = range.end - range.start;
    const frac = span > 0 ? clamp((pos - range.start) / span, 0, 1) : 0;
    let bufferedEnd = pos;
    const b = video.buffered;
    for (let i = 0; i < (b ? b.length : 0); i++) {
      try {
        if (b.start(i) <= pos + 0.5 && b.end(i) >= pos) {
          bufferedEnd = b.end(i);
          break;
        }
      } catch {
        break;
      }
    }
    const bufferedFrac = span > 0 ? clamp((bufferedEnd - range.start) / span, 0, 1) : 0;
    seek.style.setProperty('--pv-seek-played', frac.toFixed(4));
    seek.style.setProperty('--pv-seek-buffered', bufferedFrac.toFixed(4));
    seek.setAttribute('aria-valuemax', String(Math.max(0, Math.round(span))));
    seek.setAttribute('aria-valuenow', String(Math.round(clamp(pos - range.start, 0, span))));
    if (range.live) {
      const behind = Math.max(0, range.end - pos);
      const text = behind < 5 ? 'At the live edge' : `${formatDuration(behind)} behind live`;
      seek.setAttribute('aria-valuetext', text);
    } else {
      seek.setAttribute('aria-valuetext', `${formatDuration(pos)} of ${formatDuration(range.end)}`);
    }
  }

  function timeAt(clientX, range) {
    const rect = seekTrack.getBoundingClientRect();
    const frac = rect.width > 0 ? clamp((clientX - rect.left) / rect.width, 0, 1) : 0;
    return range.start + frac * (range.end - range.start);
  }

  function showSeekTip(clientX, range) {
    const t = timeAt(clientX, range);
    const rect = seek.getBoundingClientRect();
    const trackRect = seekTrack.getBoundingClientRect();
    const frac = trackRect.width > 0 ? clamp((clientX - trackRect.left) / trackRect.width, 0, 1) : 0;
    let label = formatDuration(t);
    if (range.live) label = range.end - t < BEHIND_LIVE_CLEAR ? 'Live' : `−${formatDuration(range.end - t)}`;
    setText(seekTip, label);
    const half = seekTip.offsetWidth / 2 || 20;
    const x = clamp(clientX - rect.left, half, Math.max(half, rect.width - half));
    seek.style.setProperty('--pv-seek-tip-x', `${Math.round(x)}px`);
    seek.style.setProperty('--pv-seek-hover', frac.toFixed(4));
    setData(seek, 'tip', true);
  }

  function hideSeekTip() {
    if (scrub) return;
    setData(seek, 'tip', false);
    seek.style.setProperty('--pv-seek-hover', '0');
  }

  function seekTo(t) {
    const isLive = live();
    const range = seekRange(isLive);
    if (!range) return;
    const target = clamp(t, range.start, range.end);
    if (isLive && range.end - target < BEHIND_LIVE_CLEAR) {
      goLive();
      return;
    }
    try {
      video.currentTime = target;
    } catch {
      /* not seekable right now */
    }
    if (isLive) behindLive = true;
    renderTimeline();
  }

  // ---- Volume ---------------------------------------------------------------------------------------------

  function renderVolume() {
    const muted = video.muted || video.volume === 0;
    const vol = muted ? 0 : video.volume;
    swapIcon(muteBtn, muted ? 'volume-mute' : vol < 0.5 ? 'volume-low' : 'volume-high');
    setLabel(muteBtn, muted ? 'Unmute' : 'Mute', 'M');
    const rounded = Math.round(vol * 100) / 100;
    if (Number(volumeSlider.value) !== rounded) volumeSlider.value = String(rounded);
    volumeSlider.style.setProperty('--pv-vol', `${Math.round(vol * 100)}%`);
    volumeSlider.setAttribute('aria-valuetext', muted ? 'Muted' : `${Math.round(vol * 100)}%`);
  }

  function onVolumeChange() {
    const s = store.get();
    const userDriven = performance.now() - volumeIntentAt < 1500;
    if (video.muted && !userDriven && !s.muted) {
      // Muted by the player for the browser's autoplay policy — not the user's preference; don't persist it.
      autoMuted = true;
      renderVolume();
      return;
    }
    if (!video.muted) {
      autoMuted = false;
      setUnmutePill(false);
    }
    if (!video.muted && video.volume > 0) lastVolume = video.volume;
    renderVolume();
    const volume = Math.round(video.volume * 100) / 100;
    if (Math.abs((Number(s.volume) || 0) - volume) > 0.001 || !!s.muted !== video.muted) {
      actions.setVolumeState({ volume, muted: video.muted });
    }
  }

  function setVolumeInternal(v, { osd: withOsd = false } = {}) {
    const vol = clamp(Number.isFinite(v) ? v : 0, 0, 1);
    markVolumeIntent();
    autoMuted = false;
    setUnmutePill(false);
    try {
      video.volume = vol;
    } catch {
      /* iOS: volume is read-only */
    }
    video.muted = vol === 0;
    if (vol > 0) lastVolume = vol;
    renderVolume();
    if (withOsd) showVolumeOsd();
  }

  function toggleMuteInternal(withOsd) {
    markVolumeIntent();
    autoMuted = false;
    setUnmutePill(false);
    if (video.muted || video.volume === 0) {
      video.muted = false;
      if (video.volume === 0) {
        try {
          video.volume = lastVolume > 0 ? lastVolume : 0.5;
        } catch {
          /* read-only volume */
        }
      }
    } else {
      video.muted = true;
    }
    renderVolume();
    if (withOsd) showVolumeOsd();
  }

  function unmute() {
    markVolumeIntent();
    autoMuted = false;
    video.muted = false;
    if (video.volume === 0) {
      try {
        video.volume = lastVolume > 0 ? lastVolume : 0.5;
      } catch {
        /* read-only volume */
      }
    }
    setUnmutePill(false);
    renderVolume();
    showVolumeOsd();
  }

  function setUnmutePill(show, keepAutoMuted = false) {
    setData(root, 'unmute', !!show);
    if (!show && !keepAutoMuted && !video.muted) autoMuted = false;
  }

  function showVolumeOsd() {
    const muted = video.muted || video.volume === 0;
    const pct = muted ? 0 : Math.round(video.volume * 100);
    const name = muted ? 'volume-mute' : pct < 50 ? 'volume-low' : 'volume-high';
    showOsd(name, muted ? 'Muted' : `${pct}%`, pct / 100);
  }

  function syncVolumeFromStore() {
    const s = store.get();
    const vol = Number(s.volume);
    if (autoMuted) return; // keep the autoplay mute until the user decides
    if (Number.isFinite(vol) && Math.abs(video.volume - vol) > 0.001) {
      markVolumeIntent();
      try {
        video.volume = clamp(vol, 0, 1);
      } catch {
        /* read-only volume */
      }
    }
    if (video.muted !== !!s.muted) {
      markVolumeIntent();
      video.muted = !!s.muted;
    }
  }

  // ---- OSD & announcements --------------------------------------------------------------------------------

  function showOsd(iconName, text, level) {
    setIcon(osd, iconName, { size: 16 });
    setText(osdText, text);
    osdMeter.hidden = level == null;
    if (level != null) osd.style.setProperty('--pv-osd-level', String(clamp(level, 0, 1)));
    osd.classList.add('is-on');
    clearTimeout(osdTimer);
    osdTimer = setTimeout(() => osd.classList.remove('is-on'), OSD_DURATION);
  }

  function announce(message) {
    if (!message) return;
    clearTimeout(announceTimer);
    announcer.textContent = '';
    announceTimer = setTimeout(() => {
      announcer.textContent = message;
    }, 80);
  }

  // ---- Quality & audio menus ------------------------------------------------------------------------------

  function selectedLevel() {
    const v = Number(player.currentLevel);
    return Number.isFinite(v) ? v : -1;
  }

  function isAutoLevel() {
    const a = player.autoLevel;
    if (typeof a === 'boolean') return a;
    return selectedLevel() === -1;
  }

  function playingIndex() {
    if (playingLevel >= 0) return playingLevel;
    const v = Number(player.playingLevel); // engine extra (not in the base contract) — optional
    return Number.isInteger(v) ? v : -1;
  }

  function playingLevelObj() {
    let lv = levels.find((l) => l.index === playingIndex());
    if (!lv) {
      const sel = selectedLevel();
      if (sel >= 0) lv = levels.find((l) => l.index === sel);
    }
    return lv || null;
  }

  /** Short label of the level actually playing ('' when unknown). */
  function playingShort() {
    const lv = levels.find((l) => l.index === playingIndex());
    if (lv) return levelShort(lv);
    if (playingLabel) return playingLabel.split(' · ')[0];
    return levelShort(playingLevelObj());
  }

  function renderQuality() {
    const show = levels.length > 1 && hasChannel();
    qualityBtn.hidden = !show;
    if (!show) return;
    const auto = isAutoLevel();
    const current = playingShort();
    const label = auto
      ? current
        ? `Auto · ${current}`
        : 'Auto'
      : levelShort(levels.find((l) => l.index === selectedLevel())) || current || 'Quality';
    setText(qualityText, label);
    setLabel(qualityBtn, `Quality: ${label}`);
    const height = auto
      ? playingLevelObj()?.height || video.videoHeight
      : levels.find((l) => l.index === selectedLevel())?.height;
    setData(qualityBtn, 'hd', (Number(height) || 0) >= 720);
  }

  function openQualityMenu() {
    if (!levels.length) return;
    const auto = isAutoLevel();
    const sel = selectedLevel();
    const current = playingShort();
    const items = [
      { type: 'label', label: 'Quality' },
      {
        label: 'Auto',
        hint: auto && current ? current : '',
        checked: auto,
        onSelect: () => setLevel(-1),
      },
      ...levels.map((lv) => ({
        label: levelShort(lv),
        hint: levelHint(lv),
        checked: !auto && sel === lv.index,
        onSelect: () => setLevel(lv.index),
      })),
    ];
    openPlayerMenu(qualityBtn, items, 'Quality');
  }

  function setLevel(index) {
    try {
      player.setLevel(index);
    } catch {
      return;
    }
    if (index >= 0) playingLevel = index;
    renderQuality();
    renderInfoStatus();
    const lv = levels.find((l) => l.index === index);
    showOsd('layers', index === -1 ? 'Auto quality' : levelShort(lv) || 'Quality changed');
  }

  function currentAudioIndex() {
    const v = Number(player.currentAudioTrack);
    return Number.isFinite(v) && v >= 0 ? v : currentAudio;
  }

  function renderAudio() {
    const show = audioTracks.length > 1 && hasChannel();
    audioBtn.hidden = !show;
    if (!show) return;
    const idx = currentAudioIndex();
    const pos = audioTracks.findIndex((t) => t.index === idx);
    const track = audioTracks[pos];
    const short = track?.lang ? String(track.lang).slice(0, 3).toUpperCase() : 'Audio';
    setText(audioText, short);
    setLabel(audioBtn, `Audio track: ${trackLabel(track, Math.max(0, pos))}`);
  }

  function openAudioMenu() {
    if (audioTracks.length < 2) return;
    const idx = currentAudioIndex();
    const items = [
      { type: 'label', label: 'Audio' },
      ...audioTracks.map((t, i) => {
        const label = trackLabel(t, i);
        const lang = t.lang ? String(t.lang).toUpperCase() : '';
        return {
          label,
          hint: lang && !label.toUpperCase().includes(lang) ? lang : '',
          checked: t.index === idx,
          onSelect: () => {
            try {
              player.setAudioTrack(t.index);
            } catch {
              return;
            }
            currentAudio = t.index;
            renderAudio();
            showOsd('list', label);
          },
        };
      }),
    ];
    openPlayerMenu(audioBtn, items, 'Audio track');
  }

  function openPlayerMenu(anchor, items, label) {
    let handle = null;
    handle = openMenu({
      anchor,
      items,
      placement: 'top-end',
      container: root,
      className: 'pv-menu',
      label,
      onClose: () => {
        if (menuHandle === handle) menuHandle = null;
        menuClosedAt = performance.now();
        requestAnimationFrame(() => {
          if (destroyed) return;
          const ae = document.activeElement;
          // Menu closed by keyboard selection: return focus to its button (standard menu-button behavior).
          if (keyboardMode && (!ae || ae === document.body) && anchor.isConnected && !anchor.hidden) {
            anchor.focus({ preventScroll: true });
          }
          scheduleHide();
        });
      },
    });
    menuHandle = handle;
    if (handle) {
      clearHideTimer();
      setControlsShown(true);
    }
  }

  function closeMenu() {
    menuHandle?.close();
    menuHandle = null;
  }

  // ---- Stats overlay --------------------------------------------------------------------------------------

  function setStat(key, value) {
    setText(statCells[key], value || '—');
  }

  function renderStats() {
    if (!statsOpen) return;
    let st = {};
    try {
      st = player.getStats() || {};
    } catch {
      st = {};
    }
    const ch = currentChannel();
    const media = hasMedia();
    const width = Number(st.width) || video.videoWidth || 0;
    const height = Number(st.height) || video.videoHeight || 0;
    let levelText = '';
    if (typeof st.level === 'string') levelText = st.level;
    else {
      const index = st.level && typeof st.level === 'object' ? Number(st.level.index) : Number(st.level);
      levelText = levelShort(levels.find((l) => l.index === index)) || playingShort();
    }

    setStat('state', viewState.charAt(0).toUpperCase() + viewState.slice(1));
    setStat('engine', st.engine || player.engine || '');
    const relayed = typeof st.viaProxy === 'boolean' ? st.viaProxy : viaProxy();
    setStat('route', relayed ? 'Via relay' : hasChannel() && viewState !== 'idle' ? 'Direct' : '');
    setStat('mode', media ? (live() ? (player.canSeek ? 'Live · DVR' : 'Live') : 'On demand') : '');
    setStat('resolution', width && height ? `${width} × ${height}` : '');
    const bitrate = formatBitrate(Number(st.bitrate));
    setStat('bitrate', [levelText, levelText.includes(bitrate) ? '' : bitrate].filter(Boolean).join(' · '));
    setStat('bandwidth', formatBitrate(Number(st.bandwidth)));
    const buffer = Number(st.bufferAhead);
    setStat('buffer', Number.isFinite(buffer) && st.bufferAhead != null ? `${buffer.toFixed(1)} s` : '');
    const latency = Number(st.latency);
    setStat('latency', Number.isFinite(latency) && latency > 0 ? `${latency.toFixed(1)} s` : '');
    const dropped = Number(st.droppedFrames) || 0;
    const total = Number(st.totalFrames) || 0;
    const droppedPct = dropped && total ? ` (${((dropped / total) * 100).toFixed(1)}%)` : '';
    setStat('dropped', total ? `${formatCount(dropped)} / ${formatCount(total)}${droppedPct}` : '');
    setStat('attempt', String(Number(player.attempt) || 0));
    const url = st.url || ch?.url || '';
    setStat('url', url);
    statCells.url.title = url;
    statsCopyBtn.hidden = !url;
  }

  function toggleStats(force) {
    const next = typeof force === 'boolean' ? force : !statsOpen;
    if (next === statsOpen) return;
    statsOpen = next;
    statsPanel.hidden = !next;
    setData(root, 'stats', next);
    statsBtn.setAttribute('aria-pressed', String(next));
    clearInterval(statsTimer);
    statsTimer = 0;
    if (next) {
      renderStats();
      statsTimer = setInterval(renderStats, 1000);
      revealControls();
    }
  }

  // ---- Now-playing card & top bar -------------------------------------------------------------------------

  function buildAvatar(channel, size) {
    const showLogos = store.get().settings?.showLogos !== false;
    const elAvatar = h('span', {
      class: 'avatar pv-avatar',
      style: { '--size': `${size}px` },
      'aria-hidden': 'true',
    });
    const fallback = () => {
      elAvatar.classList.add('avatar-fallback');
      elAvatar.style.setProperty('--hue', String(hueFromString(channel.name || '')));
      replaceChildren(elAvatar, initials(channel.name));
    };
    const logo = showLogos ? safeImageUrl(channel.logo) : '';
    if (!logo) {
      fallback();
      return elAvatar;
    }
    const img = h('img', { alt: '', decoding: 'async', referrerpolicy: 'no-referrer', src: logo });
    img.draggable = false;
    img.addEventListener('error', fallback, { once: true });
    elAvatar.append(img);
    return elAvatar;
  }

  function channelGroups(ch) {
    const list = Array.isArray(ch.groups) && ch.groups.length ? ch.groups : ch.group ? [ch.group] : [];
    return [...new Set(list.filter(Boolean))];
  }

  function renderChannel() {
    const s = store.get();
    const ch = s.currentChannel;
    setData(root, 'hasChannel', !!ch);
    document.title = ch ? `${ch.name} · ${APP_NAME}` : APP_NAME;
    video.setAttribute('aria-label', ch ? ch.name : 'No channel selected');
    root.setAttribute('aria-label', ch ? `Video player: ${ch.name}` : 'Video player');

    if (!ch) {
      replaceChildren(topAvatar);
      setText(topTitle, '');
      setText(topSub, '');
      replaceChildren(infoAvatar);
      setText(infoTitle, '');
      replaceChildren(infoGroups);
      infoChno.hidden = true;
    } else {
      const groups = channelGroups(ch);
      const chno = ch.chno != null && ch.chno !== '' ? `#${ch.chno}` : '';
      replaceChildren(topAvatar, buildAvatar(ch, 32));
      setText(topTitle, ch.name);
      setText(topSub, [groups[0], chno].filter(Boolean).join(' · '));
      replaceChildren(infoAvatar, buildAvatar(ch, 48));
      setText(infoTitle, ch.name);
      infoTitle.title = ch.name;
      setText(infoChno, chno);
      infoChno.hidden = !chno;
      renderChips();
    }
    renderInfoVisibility();
    renderFavorite();
    renderQuality();
    renderAudio();
    renderMediaSessionMetadata();
    if (statsOpen) renderStats();
  }

  function renderAvatars() {
    const ch = currentChannel();
    if (!ch) return;
    replaceChildren(topAvatar, buildAvatar(ch, 32));
    replaceChildren(infoAvatar, buildAvatar(ch, 48));
  }

  function renderChips() {
    const s = store.get();
    const ch = s.currentChannel;
    if (!ch) {
      replaceChildren(infoGroups);
      return;
    }
    const groups = channelGroups(ch);
    const known = new Set((s.groups || []).map((g) => g.name));
    const shown = groups.slice(0, 3);
    const chips = shown.map((g) => {
      const category = CATEGORY.groupPrefix + g;
      if (!known.has(g)) return h('span', { class: 'chip pv-chip' }, h('span', { class: 'truncate', text: g }));
      return h(
        'button',
        {
          type: 'button',
          class: ['chip pv-chip', s.category === category && 'is-active'],
          title: `Show all channels in ${g}`,
          'aria-pressed': String(s.category === category),
          onClick: () => actions.setCategory(category),
          onMousedown: keepFocusOnPlayer,
        },
        h('span', { class: 'truncate', text: g }),
      );
    });
    if (groups.length > shown.length) {
      chips.push(
        h('span', {
          class: 'chip pv-chip pv-chip-more',
          title: groups.slice(shown.length).join(', '),
          text: `+${groups.length - shown.length}`,
        }),
      );
    }
    replaceChildren(infoGroups, chips);
    infoGroups.hidden = !chips.length;
  }

  function renderInfoVisibility() {
    const s = store.get();
    const ch = s.currentChannel;
    setData(info, 'empty', !ch);
    info.hidden = !ch && (!s.ready || !(s.playlists || []).length);
  }

  function renderFavorite() {
    const ch = currentChannel();
    const fav = !!ch && isFavorite(store.get(), ch.id);
    favBtn.disabled = !ch;
    favBtn.setAttribute('aria-pressed', String(fav));
    swapIcon(favBtn, fav ? 'star-filled' : 'star', 18);
    setLabel(favBtn, fav ? 'Remove from favorites' : 'Add to favorites', 'S');
  }

  function resolutionLabel() {
    if (video.videoHeight) return `${video.videoHeight}p`;
    const current = playingShort();
    if (current) return current;
    if (hasMedia() && video.readyState >= 1 && !video.videoWidth) return 'Audio only';
    return '';
  }

  function statusSummary() {
    const route = viaProxy() ? 'via relay' : '';
    switch (viewState) {
      case 'loading':
        if (reconnect) return { kind: 'wait', text: 'Reconnecting…' };
        return { kind: 'wait', text: route ? 'Connecting via relay…' : 'Connecting…' };
      case 'buffering':
        return { kind: 'wait', text: 'Buffering…' };
      case 'reconnecting':
        if (isOffline()) return { kind: 'wait', text: 'Offline · waiting for network' };
        return {
          kind: 'wait',
          text: reconnect?.attempt ? `Reconnecting · ${reconnect.attempt}/${reconnect.max}` : 'Reconnecting…',
        };
      case 'error':
        return { kind: 'error', text: describeError(currentError(), relayFor(currentError())).title };
      case 'paused':
        if (autoplayBlocked) return { kind: 'paused', text: 'Press play to start' };
        return {
          kind: 'paused',
          text: ['Paused', live() ? 'Live' : '', resolutionLabel(), route].filter(Boolean).join(' · '),
        };
      case 'ready':
        return { kind: 'paused', text: 'Ready to play' };
      case 'playing':
        return {
          kind: live() ? 'live' : 'ok',
          text: [live() ? 'Live' : 'On demand', resolutionLabel(), player.engine, route]
            .filter(Boolean)
            .join(' · '),
        };
      default:
        return { kind: 'idle', text: '' };
    }
  }

  function renderInfoStatus() {
    const { kind, text } = statusSummary();
    infoStatus.dataset.kind = kind;
    setText(infoStatusText, text);
    infoStatus.hidden = !text;
  }

  function renderNav() {
    for (const btn of [prevBtn, nextBtn, infoPrevBtn, infoNextBtn]) btn.disabled = !navAvailable;
    errNextBtn.disabled = !navAvailable;
  }

  // ---- Idle layer -----------------------------------------------------------------------------------------

  function idleVariant(s) {
    if (!s.ready) return 'boot';
    if (s.busy && !s.channels.length) return 'busy';
    if (!s.playlists.length) return 'welcome';
    if (s.playlistError && !s.channels.length) return 'failed';
    return 'select';
  }

  function renderIdle() {
    const s = store.get();
    const variant = idleVariant(s);
    root.dataset.idle = variant;
    if (variant === 'busy') setText(busyTitle, s.busy?.message || 'Loading playlist…');
    if (variant === 'failed') {
      setText(failedText, s.playlistError?.message || 'Check the playlist address and your connection.');
      const meta = s.playlists.find((p) => p.id === s.playlistError?.playlistId);
      failedRetryBtn.hidden = meta?.source?.kind !== 'url';
    }
    renderInfoVisibility();
  }

  function openAdd(opts = {}) {
    try {
      openAddPlaylistDialog({ store, actions, ...opts });
    } catch (err) {
      toast.error(err?.message || "Couldn't open the dialog.");
    }
  }

  // ---- Stream relay (proxy) -------------------------------------------------------------------------------

  /** "Fix with a relay": the setup guide; once it saved a working relay, replay the blocked channel. */
  function openProxyFix() {
    const ch = currentChannel();
    let handle = null;
    try {
      handle = openProxyGuide({ store, actions });
    } catch (err) {
      toast.error(err?.message || "Couldn't open the dialog.");
      return;
    }
    retryAfter(handle, ch, (result) => !!result?.working && relayNow().streams);
  }

  /** "Relay settings": Settings; replay the channel if the relay streams play through changed there. */
  function openProxySettings() {
    const ch = currentChannel();
    const before = streamRelay(store.get().settings || {});
    let handle = null;
    try {
      handle = openSettingsDialog({ store, actions });
    } catch (err) {
      toast.error(err?.message || "Couldn't open the dialog.");
      return;
    }
    retryAfter(handle, ch, () => {
      const after = streamRelay(store.get().settings || {});
      return !!after && after !== before;
    });
  }

  /** When a dialog closes and `shouldRetry(result)`, retry — if the same channel's error is still showing. */
  function retryAfter(handle, ch, shouldRetry) {
    Promise.resolve(handle?.result).then(
      (result) => {
        if (destroyed || !ch || currentChannel() !== ch || player.state !== S.ERROR) return;
        if (shouldRetry(result)) retry();
      },
      () => {},
    );
  }

  /**
   * "Playing through your relay" — once per channel, when a stream that switched to the user's own relay
   * starts. The built-in relay is how the site plays such channels by default, so it only shows in the
   * status line ("via relay") and stream info.
   */
  function noticeProxy() {
    const key = proxyNotice;
    proxyNotice = '';
    if (!key || proxyNoticed.has(key) || !viaProxy() || relayNow().builtin) return;
    if (proxyNoticed.size >= PROXY_NOTICE_LIMIT) proxyNoticed.clear();
    proxyNoticed.add(key);
    toast.info('Playing through your relay');
  }

  // ---- Channel health (the channel list's "Unavailable" flags, see markChannelFailed) -------------------

  /** Mark the channel the current load is for as playable once it plays (again, after a failure). */
  function reportPlaying() {
    if (reportedOk || !isReportable()) return;
    reportedOk = true;
    actions.markChannelOk?.(reportFor);
  }

  /** Remember a fatal failure of the current load, titled like the error panel shows it. */
  function reportFailure(error) {
    if (!error || error.fatal === false || UNREPORTED_ERRORS.has(error.code) || !isReportable()) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return; // not the channel's fault
    reportedOk = false;
    const { title } = describeError(error, relayNow());
    actions.markChannelFailed?.(reportFor, { code: String(error.code ?? ''), title });
  }

  /**
   * A failure through the relay without any HTTP answer (see mayBeRelayDown): before blaming the channel, ask
   * the relay's health check whether the relay itself is down. A relay outage — or a used-up free quota —
   * must not flag every channel tried meanwhile as "Unavailable" (and hide them); the error panel then says
   * that the relay can't be reached instead.
   */
  function checkRelayThenReport(error) {
    cancelRelayProbe();
    const url = proxyHealthUrl(streamRelay(store.get().settings || {}));
    if (!url || typeof fetch !== 'function') {
      reportFailure(error);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RELAY_PROBE_TIMEOUT_MS);
    const probe = { controller, timer };
    relayProbe = probe;
    const seq = loadSeq;
    let request;
    try {
      request = fetch(url, { cache: 'no-store', credentials: 'omit', signal: controller.signal });
    } catch (err) {
      request = Promise.reject(err);
    }
    Promise.resolve(request)
      .then(
        (res) => !!res?.ok,
        () => false,
      )
      .then((reachable) => {
        if (relayProbe !== probe) return; // cancelled: a new load, Retry, or the view went away
        cancelRelayProbe();
        if (destroyed || seq !== loadSeq || currentError() !== error) return;
        if (reachable) {
          reportFailure(error);
          return;
        }
        relayDownError = error;
        renderState();
        const info = describeError(error, relayFor(error));
        announce(`${info.title}. ${info.message}`);
      });
  }

  function cancelRelayProbe() {
    if (!relayProbe) return;
    clearTimeout(relayProbe.timer);
    relayProbe.controller.abort();
    relayProbe = null;
  }

  /** Player events belong to `reportFor` only while it's still the current channel. */
  function isReportable() {
    return !!reportFor && currentChannel()?.id === reportFor.id;
  }

  async function loadDemo() {
    if (heroDemoBtn.disabled) return;
    heroDemoBtn.disabled = true;
    heroDemoBtn.setAttribute('aria-busy', 'true');
    demoSpinner.hidden = false;
    heroDemoBtn.querySelector(':scope > svg.icon')?.setAttribute('hidden', '');
    try {
      await actions.addDemoPlaylist();
      // First-run delight: start the first demo channel right away.
      const s = store.get();
      if (!destroyed && !s.currentChannel && s.channels.length) actions.playChannel(s.channels[0]);
    } catch {
      /* the controller already showed a toast */
    } finally {
      heroDemoBtn.disabled = false;
      heroDemoBtn.removeAttribute('aria-busy');
      demoSpinner.hidden = true;
      heroDemoBtn.querySelector(':scope > svg.icon')?.removeAttribute('hidden');
    }
  }

  function retryPlaylist() {
    const s = store.get();
    const id = s.playlistError?.playlistId || s.activePlaylistId;
    if (!id) return;
    settle(actions.refreshPlaylist(id));
  }

  // ---- Media Session --------------------------------------------------------------------------------------

  const mediaSession =
    typeof navigator !== 'undefined' && 'mediaSession' in navigator ? navigator.mediaSession : null;
  const mediaHandlers = {
    play: () => {
      if (hasChannel()) togglePlayTo(true);
    },
    pause: () => {
      if (hasChannel()) togglePlayTo(false);
    },
    previoustrack: () => actions.playPrev(),
    nexttrack: () => actions.playNext(),
  };

  function setMediaHandlers(enabled) {
    if (!mediaSession) return;
    for (const [name, fn] of Object.entries(mediaHandlers)) {
      try {
        mediaSession.setActionHandler(name, enabled ? fn : null);
      } catch {
        /* action not supported by this browser */
      }
    }
  }

  function renderMediaSessionMetadata() {
    if (!mediaSession) return;
    const ch = currentChannel();
    try {
      if (!ch) {
        mediaSession.metadata = null;
        return;
      }
      if (typeof MediaMetadata !== 'function') return;
      const logo = safeImageUrl(ch.logo);
      mediaSession.metadata = new MediaMetadata({
        title: ch.name,
        artist: ch.group || '',
        album: APP_NAME,
        artwork: logo ? [{ src: logo }] : [],
      });
    } catch {
      /* invalid artwork URL etc. — metadata is best-effort */
    }
  }

  function renderMediaSessionState() {
    if (!mediaSession) return;
    try {
      mediaSession.playbackState =
        viewState === 'playing' || viewState === 'buffering'
          ? 'playing'
          : viewState === 'paused' || viewState === 'ready'
            ? 'paused'
            : 'none';
    } catch {
      /* ignore */
    }
  }

  // ---- Controls auto-hide ---------------------------------------------------------------------------------

  function setControlsShown(visible) {
    if (controlsShown === visible) return;
    controlsShown = visible;
    root.dataset.controls = visible ? 'visible' : 'hidden';
    if (!visible) hideSeekTip();
  }

  function clearHideTimer() {
    clearTimeout(hideTimer);
    hideTimer = 0;
  }

  function keyboardFocusInside() {
    const ae = document.activeElement;
    if (!ae || ae === root || !root.contains(ae)) return false;
    try {
      return ae.matches(':focus-visible');
    } catch {
      return keyboardMode;
    }
  }

  function canAutoHide() {
    return (
      (viewState === 'playing' || viewState === 'buffering') &&
      !menuHandle &&
      !pointerInControls &&
      !scrub &&
      !keyboardFocusInside()
    );
  }

  function scheduleHide(delay) {
    clearHideTimer();
    if (!canAutoHide()) return;
    const ms = delay ?? (lastPointerType === 'mouse' ? HIDE_DELAY : TOUCH_HIDE_DELAY);
    hideTimer = setTimeout(() => {
      hideTimer = 0;
      if (canAutoHide()) setControlsShown(false);
    }, ms);
  }

  function revealControls(delay) {
    if (!hasChannel()) return;
    setControlsShown(true);
    scheduleHide(delay);
  }

  // ---- Playback commands ----------------------------------------------------------------------------------

  function resetStreamUi() {
    levels = [];
    playingLevel = -1;
    playingLabel = '';
    audioTracks = [];
    currentAudio = -1;
    lastError = null;
    relayDownError = null;
    cancelRelayProbe();
    offlineWait = false;
    autoplayBlocked = false;
    behindLive = false;
    liveBaseline = Infinity;
    pausedAt = 0;
    proxyNotice = '';
    stopCountdown();
    setUnmutePill(false, true);
    scrub = null;
    setData(root, 'scrubbing', false);
    closeMenu();
    renderQuality();
    renderAudio();
  }

  function loadCurrent() {
    const ch = currentChannel();
    if (!ch) return;
    const seq = ++loadSeq;
    resetStreamUi();
    if (autoMuted) {
      // A new channel is a fresh chance to play with sound (the click that chose it is a user gesture).
      autoMuted = false;
      video.muted = !!store.get().muted;
    }
    pendingLoad = true;
    reportFor = ch;
    reportedOk = false;
    publishPlaybackState(S.LOADING); // don't leave the previous channel's state (e.g. 'error') in the store
    renderState();
    let result;
    try {
      result = player.load({ url: ch.url, name: ch.name, drm: !!ch.drm });
    } catch (err) {
      result = Promise.reject(err);
    }
    Promise.resolve(result)
      .catch(() => {})
      .then(() => {
        if (seq !== loadSeq || destroyed) return;
        pendingLoad = false;
        renderState();
      });
    revealControls();
  }

  function exitPip() {
    try {
      if (document.pictureInPictureElement === video) settle(document.exitPictureInPicture());
      else if (video.webkitPresentationMode === 'picture-in-picture') video.webkitSetPresentationMode('inline');
    } catch {
      /* ignore */
    }
  }

  function stopPlayback() {
    loadSeq++;
    pendingLoad = false;
    reportFor = null;
    resetStreamUi();
    exitPip();
    try {
      player.stop();
    } catch {
      /* ignore */
    }
    publishPlaybackState(S.IDLE);
  }

  /** Explicitly play (true) or pause (false). */
  function togglePlayTo(play) {
    const st = player.state;
    if (st === S.ERROR) return retry();
    if (st === S.IDLE && !pendingLoad) return loadCurrent();
    if (play) settle(player.play());
    else player.pause();
  }

  function togglePlay() {
    if (!hasChannel()) return;
    const st = player.state;
    if (st === S.ERROR) {
      retry();
      return;
    }
    if (st === S.IDLE && !pendingLoad) {
      loadCurrent();
      return;
    }
    settle(player.togglePlay());
    revealControls();
  }

  function retry() {
    if (!hasChannel()) return;
    if (player.state === S.IDLE && !pendingLoad) {
      loadCurrent();
      return;
    }
    stopCountdown();
    lastError = null;
    relayDownError = null;
    cancelRelayProbe();
    try {
      player.retry();
    } catch {
      loadCurrent();
      return;
    }
    renderState();
    revealControls();
  }

  function seekBy(seconds) {
    const delta = Number(seconds) || 0;
    if (!hasChannel() || !delta || !player.canSeek) return false;
    try {
      player.seekBy(delta);
    } catch {
      return false;
    }
    if (live() && delta < 0) behindLive = true;
    showOsd(delta < 0 ? 'rotate-ccw' : 'rotate-cw', `${delta < 0 ? '−' : '+'}${Math.abs(delta)} s`);
    revealControls();
    renderTimeline();
    return true;
  }

  function goLive() {
    try {
      player.goLive();
    } catch {
      /* ignore */
    }
    behindLive = false;
    renderTimeline();
    revealControls();
  }

  function toggleFavorite() {
    const ch = currentChannel();
    if (!ch) return;
    actions.toggleFavorite(ch);
    renderFavorite();
  }

  async function copyUrl() {
    const ch = currentChannel();
    if (!ch?.url) return;
    const ok = await copyText(ch.url);
    if (ok) toast.success('Stream URL copied');
    else toast.error("Couldn't copy the stream URL");
  }

  // ---- Picture-in-picture ---------------------------------------------------------------------------------

  let pipMode = null;
  if (document.pictureInPictureEnabled && typeof video.requestPictureInPicture === 'function') {
    pipMode = 'standard';
  } else if (
    typeof video.webkitSupportsPresentationMode === 'function' &&
    video.webkitSupportsPresentationMode('picture-in-picture')
  ) {
    pipMode = 'webkit';
  }
  pipBtn.hidden = !pipMode;

  function pipActive() {
    if (pipMode === 'standard') return document.pictureInPictureElement === video;
    if (pipMode === 'webkit') return video.webkitPresentationMode === 'picture-in-picture';
    return false;
  }

  function renderPip() {
    if (!pipMode) return;
    const active = pipActive();
    setData(root, 'pip', active);
    pipBtn.setAttribute('aria-pressed', String(active));
    setLabel(pipBtn, active ? 'Exit picture-in-picture' : 'Picture-in-picture', 'P');
    pipBtn.disabled = !active && (video.readyState < 1 || !hasMedia());
  }

  async function togglePip() {
    if (!pipMode) {
      toast.info("Picture-in-picture isn't supported in this browser.");
      return;
    }
    try {
      if (pipActive()) {
        if (pipMode === 'standard') await document.exitPictureInPicture();
        else video.webkitSetPresentationMode('inline');
        return;
      }
      if (!hasChannel() || video.readyState < 1) {
        toast.info('Start playing a channel to use picture-in-picture.');
        return;
      }
      if (pipMode === 'standard') await video.requestPictureInPicture();
      else video.webkitSetPresentationMode('picture-in-picture');
    } catch {
      toast.error("Picture-in-picture isn't available right now.");
    } finally {
      renderPip();
    }
  }

  // ---- Fullscreen -----------------------------------------------------------------------------------------

  const fsSupported = !!(document.fullscreenEnabled || document.webkitFullscreenEnabled);
  const iosFsAvailable = !fsSupported && typeof video.webkitEnterFullscreen === 'function';
  fsBtn.hidden = !fsSupported && !iosFsAvailable;

  function isFullscreen() {
    return fullscreenElement() === root || iosFullscreen;
  }

  function lockLandscape() {
    try {
      const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
      const landscapeVideo = !video.videoWidth || video.videoWidth >= video.videoHeight;
      const orientation = typeof screen !== 'undefined' ? screen.orientation : null;
      if (!coarse || !landscapeVideo || !orientation?.lock) return;
      const res = orientation.lock('landscape');
      orientationLocked = true;
      if (res && typeof res.then === 'function') {
        res.then(undefined, () => {
          orientationLocked = false;
        });
      }
    } catch {
      orientationLocked = false;
    }
  }

  function unlockOrientation() {
    if (!orientationLocked) return;
    orientationLocked = false;
    try {
      screen.orientation?.unlock?.();
    } catch {
      /* ignore */
    }
  }

  async function toggleFullscreen() {
    try {
      if (fullscreenElement()) {
        const exit = document.exitFullscreen || document.webkitExitFullscreen;
        if (exit) await exit.call(document);
        return;
      }
      if (iosFullscreen) {
        video.webkitExitFullscreen?.();
        return;
      }
      if (fsSupported) {
        if (root.requestFullscreen) await root.requestFullscreen({ navigationUI: 'hide' });
        else if (root.webkitRequestFullscreen) root.webkitRequestFullscreen();
        lockLandscape();
        return;
      }
      if (iosFsAvailable) {
        if (video.readyState < 1) {
          toast.info('Start playing a channel to go fullscreen.');
          return;
        }
        video.webkitEnterFullscreen();
        return;
      }
      toast.info("Fullscreen isn't available here.");
    } catch {
      // Element fullscreen refused (e.g. iframe without permission): try the iOS video fallback once.
      if (typeof video.webkitEnterFullscreen === 'function' && video.readyState >= 1) {
        try {
          video.webkitEnterFullscreen();
          return;
        } catch {
          /* fall through */
        }
      }
      toast.error("Couldn't enter fullscreen.");
    }
  }

  function renderFullscreen() {
    const fs = isFullscreen();
    setData(root, 'fullscreen', fullscreenElement() === root);
    swapIcon(fsBtn, fs ? 'fullscreen-exit' : 'fullscreen');
    setLabel(fsBtn, fs ? 'Exit fullscreen' : 'Fullscreen', 'F');
    if (!fs) unlockOrientation();
    menuHandle?.reposition?.();
    revealControls();
  }

  // ---------------------------------------------------------------------------------------------------------
  // Event wiring
  // ---------------------------------------------------------------------------------------------------------

  /** Mirror the engine state into the store (`state.playbackState`, a PlayerState value) for other views. */
  function publishPlaybackState(state) {
    if (store.get().playbackState !== state) store.set({ playbackState: state });
  }

  // Player events (SPEC §3.4 — CustomEvent with e.detail).
  onPlayer('statechange', (e) => {
    const state = e.detail?.state ?? player.state;
    const reason = e.detail?.reason;
    publishPlaybackState(state);
    offlineWait = state === S.RECONNECTING && reason === 'offline';
    autoplayBlocked = state === S.PAUSED && reason === 'autoplay-blocked';
    if (state !== S.IDLE) pendingLoad = false;
    if (state === S.PLAYING || state === S.PAUSED || state === S.ERROR || state === S.IDLE) stopCountdown();
    if (state === S.PLAYING) {
      noticeProxy();
      reportPlaying();
    } else if (state === S.ERROR || state === S.IDLE) proxyNotice = '';
    renderState();
  });
  onPlayer('error', (e) => {
    const error = e.detail?.error || player.error;
    lastError = error || lastError;
    if (error?.fatal !== false && mayBeRelayDown(error)) checkRelayThenReport(error);
    else reportFailure(error);
    renderState();
  });
  onPlayer('reconnecting', (e) => startCountdown(e.detail || {}));
  onPlayer('levels', (e) => {
    const raw = Array.isArray(e.detail?.levels) ? e.detail.levels : player.levels;
    const list = Array.isArray(raw) ? raw : [];
    levels = list.filter((l) => l && Number.isFinite(Number(l.index)));
    renderQuality();
    renderInfoStatus();
  });
  onPlayer('levelswitch', (e) => {
    const lv = e.detail?.level;
    const index = lv && typeof lv === 'object' ? Number(lv.index) : Number(lv);
    if (Number.isFinite(index)) playingLevel = index;
    playingLabel = typeof e.detail?.label === 'string' ? e.detail.label : '';
    renderQuality();
    renderInfoStatus();
    if (statsOpen) renderStats();
  });
  onPlayer('audiotracks', (e) => {
    const raw = Array.isArray(e.detail?.tracks) ? e.detail.tracks : player.audioTracks;
    const list = Array.isArray(raw) ? raw : [];
    audioTracks = list.filter(Boolean);
    const cur = Number(e.detail?.current);
    currentAudio = Number.isFinite(cur) ? cur : currentAudio;
    renderAudio();
  });
  onPlayer('engine', () => {
    renderInfoStatus();
    if (statsOpen) renderStats();
  });
  onPlayer('autoplaymuted', () => {
    autoMuted = true;
    setUnmutePill(true);
    renderVolume();
    announce('Playing muted. Use the unmute button to turn the sound on.');
  });
  onPlayer('live', () => {
    renderTimeline();
    renderInfoStatus();
  });
  // The direct load failed (CORS, refused…) and the Player switched to the relay: say so once it plays.
  onPlayer('proxy', () => {
    proxyNotice = currentChannel()?.url || '';
    renderState();
  });
  onPlayer('recovered', () => {
    behindLive = false;
    liveBaseline = Infinity;
    stopCountdown();
    showOsd('check', 'Reconnected');
    announce('Reconnected');
    renderState();
  });

  // Video element.
  const renderTimelineOnly = () => renderTimeline();
  for (const type of ['timeupdate', 'durationchange', 'progress', 'seeking', 'seeked', 'ratechange']) {
    listen(video, type, renderTimelineOnly);
  }
  listen(video, 'volumechange', onVolumeChange);
  listen(video, 'loadedmetadata', () => {
    renderTimeline();
    renderInfoStatus();
    renderPip();
  });
  listen(video, 'resize', () => {
    renderInfoStatus();
    if (statsOpen) renderStats();
  });
  listen(video, 'emptied', () => {
    renderPip();
    renderTimeline();
  });
  listen(video, 'enterpictureinpicture', renderPip);
  listen(video, 'leavepictureinpicture', renderPip);
  listen(video, 'webkitpresentationmodechanged', renderPip);
  listen(video, 'webkitbeginfullscreen', () => {
    iosFullscreen = true;
    renderFullscreen();
  });
  listen(video, 'webkitendfullscreen', () => {
    iosFullscreen = false;
    renderFullscreen();
  });

  // Fullscreen + connectivity.
  listen(document, 'fullscreenchange', renderFullscreen);
  listen(document, 'webkitfullscreenchange', renderFullscreen);
  listen(window, 'online', renderState);
  listen(window, 'offline', renderState);

  // Track keyboard vs pointer interaction (focus restoration after menus).
  listen(document, 'keydown', () => (keyboardMode = true), true);
  listen(document, 'pointerdown', () => (keyboardMode = false), true);

  // Pointer activity on the player.
  listen(root, 'pointerdown', (e) => {
    lastPointerType = e.pointerType || 'mouse';
    root.dataset.input = lastPointerType === 'mouse' ? 'mouse' : 'touch';
    if (lastPointerType !== 'mouse' && controls.contains(e.target)) revealControls(TOUCH_HIDE_DELAY);
  });
  listen(root, 'pointermove', (e) => {
    if (e.pointerType !== 'mouse') return;
    // Browsers fire synthetic moves when content under a resting cursor changes — ignore those.
    if (e.clientX === lastMove.x && e.clientY === lastMove.y) return;
    lastMove = { x: e.clientX, y: e.clientY };
    lastPointerType = 'mouse';
    root.dataset.input = 'mouse';
    revealControls();
  });
  listen(root, 'pointerleave', (e) => {
    if (e.pointerType !== 'mouse') return;
    pointerInControls = false;
    lastMove = { x: NaN, y: NaN };
    scheduleHide(LEAVE_HIDE_DELAY);
  });
  for (const zone of [bar, seek]) {
    listen(zone, 'pointerenter', (e) => {
      if (e.pointerType !== 'mouse') return;
      pointerInControls = true;
      clearHideTimer();
    });
    listen(zone, 'pointerleave', (e) => {
      if (e.pointerType !== 'mouse') return;
      pointerInControls = false;
      scheduleHide();
    });
  }
  listen(root, 'keydown', () => {
    if (hasChannel() && viewState !== 'idle') {
      setControlsShown(true);
      scheduleHide();
    }
  });
  listen(root, 'focusin', () => {
    if (keyboardFocusInside()) {
      clearHideTimer();
      setControlsShown(true);
    }
  });
  listen(root, 'focusout', () => {
    requestAnimationFrame(() => {
      if (!destroyed) scheduleHide();
    });
  });

  // Click / tap on the video surface.
  listen(hit, 'click', (e) => {
    if (!hasChannel() || viewState === 'idle' || viewState === 'error') return;
    // A click that just dismissed a quality/audio menu shouldn't also toggle playback.
    if (performance.now() - menuClosedAt < 350) return;
    if (lastPointerType !== 'mouse') {
      // Touch: the first tap only reveals the controls; a tap while they're visible toggles playback.
      if (!controlsShown) {
        revealControls(TOUCH_HIDE_DELAY);
        return;
      }
      if (viewState === 'loading' || viewState === 'reconnecting') {
        revealControls(TOUCH_HIDE_DELAY);
        return;
      }
      togglePlay();
      revealControls(TOUCH_HIDE_DELAY);
      return;
    }
    if (e.detail >= 2) {
      // Double click → fullscreen. Cancel the pending single-click toggle, or undo it if it already ran.
      if (pendingClick) {
        clearTimeout(pendingClick);
        pendingClick = 0;
      } else if (e.detail === 2 && clickToggledAt && performance.now() - clickToggledAt < 600) {
        togglePlay();
      }
      clickToggledAt = 0;
      if (e.detail === 2) toggleFullscreen();
      return;
    }
    clearTimeout(pendingClick);
    pendingClick = setTimeout(() => {
      pendingClick = 0;
      if (viewState === 'loading' || viewState === 'reconnecting') return;
      clickToggledAt = performance.now();
      togglePlay();
    }, CLICK_DELAY);
  });

  // Seek bar: pointer scrubbing + keyboard.
  listen(seek, 'pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const range = seekRange();
    if (!range) return;
    e.preventDefault();
    try {
      seek.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    scrub = { id: e.pointerId, time: timeAt(e.clientX, range) };
    setData(root, 'scrubbing', true);
    clearHideTimer();
    showSeekTip(e.clientX, range);
    renderTimeline();
  });
  listen(seek, 'pointermove', (e) => {
    const range = seekRange();
    if (!range) return;
    if (scrub && e.pointerId === scrub.id) {
      scrub.time = timeAt(e.clientX, range);
      showSeekTip(e.clientX, range);
      renderTimeline();
    } else if (!scrub && e.pointerType === 'mouse') {
      showSeekTip(e.clientX, range);
    }
  });
  const endScrub = (e, commit) => {
    if (!scrub || e.pointerId !== scrub.id) return;
    const t = scrub.time;
    scrub = null;
    setData(root, 'scrubbing', false);
    try {
      seek.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    if (commit) seekTo(t);
    if (e.pointerType !== 'mouse') hideSeekTip();
    renderTimeline();
    scheduleHide();
  };
  listen(seek, 'pointerup', (e) => endScrub(e, true));
  listen(seek, 'pointercancel', (e) => endScrub(e, false));
  listen(seek, 'pointerleave', () => hideSeekTip());
  listen(seek, 'keydown', (e) => {
    const range = seekRange();
    if (!range) return;
    const now = video.currentTime || 0;
    let target = null;
    switch (e.key) {
      case 'ArrowLeft':
      case 'ArrowDown':
        target = now - SEEK_STEP;
        break;
      case 'ArrowRight':
      case 'ArrowUp':
        target = now + SEEK_STEP;
        break;
      case 'PageDown':
        target = now - SEEK_PAGE;
        break;
      case 'PageUp':
        target = now + SEEK_PAGE;
        break;
      case 'Home':
        target = range.start;
        break;
      case 'End':
        target = range.end;
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
    seekTo(target);
    revealControls();
  });

  // ---------------------------------------------------------------------------------------------------------
  // Store subscriptions
  // ---------------------------------------------------------------------------------------------------------

  const navSelector = (s) => {
    const { items } = selectVisibleChannels(s);
    if (!items.length) return false;
    if (!s.currentChannel) return true;
    return items.length > 1 || items[0].channel.id !== s.currentChannel.id;
  };

  const unsubs = [
    store.select(
      (s) => s.currentChannel,
      (ch, prev) => {
        if (!ch && prev) stopPlayback();
        renderChannel();
        renderState();
      },
      { immediate: true },
    ),
    store.select(
      (s) => s.playRequest,
      (n) => {
        if (n > 0 && hasChannel()) loadCurrent();
      },
      { immediate: true },
    ),
    store.select(
      (s) => s.settings,
      (settings) => {
        try {
          player.setOptions(playerOptionsFrom(settings || {}));
        } catch {
          /* ignore */
        }
        // The error panel's relay actions and copy depend on which relay is in use.
        if (viewState === 'error') renderError();
      },
    ),
    store.select((s) => s.settings?.showLogos, renderAvatars),
    store.select((s) => s.favorites, renderFavorite),
    store.select(idleVariant, renderIdle, { immediate: true }),
    store.select((s) => s.busy, renderIdle),
    store.select((s) => s.playlistError, renderIdle),
    store.select((s) => s.playlists.length, renderInfoVisibility),
    store.select((s) => s.groups, renderChips),
    store.select((s) => s.category, renderChips),
    store.select(
      navSelector,
      (value) => {
        navAvailable = value;
        renderNav();
      },
      { immediate: true },
    ),
    store.select((s) => s.volume, syncVolumeFromStore),
    store.select((s) => s.muted, syncVolumeFromStore),
  ];

  setMediaHandlers(true);
  publishPlaybackState(player.state);
  renderVolume();
  renderFullscreen();
  setControlsShown(true);

  // ---------------------------------------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------------------------------------

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    cancelRelayProbe();
    for (const off of unsubs.splice(0)) off();
    for (const off of offs.splice(0)) off();
    clearHideTimer();
    clearTimeout(pendingClick);
    clearTimeout(osdTimer);
    clearTimeout(announceTimer);
    clearInterval(statsTimer);
    stopCountdown();
    closeMenu();
    setMediaHandlers(false);
    if (mediaSession) {
      try {
        mediaSession.metadata = null;
        mediaSession.playbackState = 'none';
      } catch {
        /* ignore */
      }
    }
    unlockOrientation();
    exitPip();
    try {
      player.destroy();
    } catch {
      /* ignore */
    }
    publishPlaybackState(S.IDLE);
    el.remove();
  }

  return {
    el,
    player,
    togglePlay,
    toggleMute: () => {
      toggleMuteInternal(true);
      revealControls();
    },
    setVolume: (v) => {
      setVolumeInternal(Number(v), { osd: true });
      revealControls();
    },
    volumeBy: (delta) => {
      const base = video.muted ? 0 : video.volume;
      setVolumeInternal(Math.round((base + (Number(delta) || 0)) * 100) / 100, { osd: true });
      revealControls();
    },
    toggleFullscreen,
    togglePip,
    seekBy,
    retry,
    toggleStats: () => toggleStats(),
    focus: () => root.focus({ preventScroll: true }),
    destroy,
  };
}
