// Which stream relay is in effect. The user's own relay (settings.corsProxy) wins; otherwise this site's
// built-in relay (BUILTIN_RELAY_URL) is used unless the user switched it off.

import { BUILTIN_RELAY_URL } from './constants.js';

export const hasBuiltinRelay = () => BUILTIN_RELAY_URL !== '';

/** Relay used for playlist downloads and streams ('' = none). */
export function effectiveRelay(settings = {}) {
  const own = typeof settings.corsProxy === 'string' ? settings.corsProxy.trim() : '';
  if (own) return own;
  return settings.useBuiltinRelay !== false ? BUILTIN_RELAY_URL : '';
}

/** Relay used for streams ('' = streams never go through a relay). */
export function streamRelay(settings = {}) {
  return settings.proxyStreams !== false ? effectiveRelay(settings) : '';
}

/** True when the relay in effect is the built-in one (not the user's own). */
export function isBuiltinRelayActive(settings = {}) {
  return hasBuiltinRelay() && effectiveRelay(settings) === BUILTIN_RELAY_URL && !String(settings.corsProxy || '').trim();
}
