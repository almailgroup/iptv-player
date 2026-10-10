// "Can this channel play here?" — the static checks behind the channel list's flags: protocols and formats
// browsers can't play, DRM, and insecure http:// streams an https page blocks — when no relay is in effect, or
// always for streams on the local network (a relay on the internet can't reach those).
// Pure and cheap: it runs for every rendered row (and over a whole category when unplayable channels are
// hidden), so results are small shared frozen objects and the common case skips URL parsing entirely.

import { detectStreamType, isMixedContent, isPrivateNetworkUrl } from '../player/stream-type.js';

/**
 * @typedef {object} Playability
 * @property {'unsupported'|'drm'|'insecure'|'failed'} kind
 * @property {string} label  short flag text ("Not supported", "DRM", "HTTP", "Local", "Unavailable")
 * @property {string} title  one-sentence reason (tooltip)
 * @property {number} [at]   'failed' only: when the channel last failed (ms since epoch)
 */

const DASH = Object.freeze({
  kind: 'unsupported',
  label: 'Not supported',
  title: 'MPEG-DASH streams aren’t supported.',
});
const DRM = Object.freeze({ kind: 'drm', label: 'DRM', title: 'DRM-protected — can’t play in the browser.' });
const INSECURE = Object.freeze({
  kind: 'insecure',
  label: 'HTTP',
  title: 'Insecure http:// stream — browsers block it on this secure site.',
});
const LOCAL = Object.freeze({
  kind: 'insecure',
  label: 'Local',
  title: 'Local-network http:// stream — can’t play on this secure site.',
});
/** scheme -> frozen 'unsupported' result (one per scheme seen, e.g. rtmp, rtsp, udp). */
const protocolResults = new Map();
const MAX_PROTOCOL_RESULTS = 64;

const SCHEME = /^([a-z][a-z0-9+.-]*):/i;
const HTTP_SCHEME = /^https?:/i;
const INSECURE_SCHEME = /^\s*http:/i; // only these can be mixed content (saves isMixedContent's URL parsing)
/**
 * The only static verdict detectStreamType can reach for an http(s) URL is 'dash', and only through an "mpd"
 * or "dash" extension, query hint or path — text that can't be there without one of these substrings unless
 * it is percent-encoded or split by tabs/newlines (which the URL parser drops). URLs matching none of them
 * skip detectStreamType's URL parsing, which is most of the cost of this module.
 */
const MAYBE_DASH = /mpd|dash|[%\t\n\r]/i;

function protocolResult(url) {
  const scheme = (SCHEME.exec(url)?.[1] || '').toLowerCase();
  let result = protocolResults.get(scheme);
  if (!result) {
    const title = scheme
      ? `${scheme}:// streams can’t be played in a browser.`
      : 'This stream can’t be played in a browser.';
    result = Object.freeze({ kind: 'unsupported', label: 'Not supported', title });
    if (protocolResults.size >= MAX_PROTOCOL_RESULTS) protocolResults.clear();
    protocolResults.set(scheme, result);
  }
  return result;
}

/**
 * Why a channel can't play on this page, judged from its URL and flags alone (no network) — the same up-front
 * checks the player makes. In order: unsupported protocol, MPEG-DASH, DRM, then mixed content (an http://
 * stream on an https page): on the local network ('Local', relay or not — see isPrivateNetworkUrl), else
 * when no stream relay is in effect ('HTTP').
 *
 * @param {{ url?: string, drm?: boolean }} channel
 * @param {{ pageProtocol?: string, streamRelay?: string }} [options]
 *   `pageProtocol` defaults to the current page's (location.protocol); `streamRelay` is the relay streams
 *   play through ('' = none, see streamRelay() in src/app/relay.js).
 * @returns {Playability | null} null when nothing is known to stop it from playing. Results are frozen and
 *   shared — never mutate them.
 */
export function staticPlayability(channel, { pageProtocol, streamRelay } = {}) {
  const url = typeof channel?.url === 'string' ? channel.url : '';
  if (url) {
    const type = HTTP_SCHEME.test(url) && !MAYBE_DASH.test(url) ? 'unknown' : detectStreamType(url);
    if (type === 'unsupported') return protocolResult(url.trim());
    if (type === 'dash') return DASH;
  }
  if (channel?.drm) return DRM;
  if (!INSECURE_SCHEME.test(url)) return null;
  const local = isPrivateNetworkUrl(url); // no URL parsing for ordinary hosts
  if (!local && streamRelay) return null;
  return isMixedContent(url, pageProtocol) ? (local ? LOCAL : INSECURE) : null;
}
