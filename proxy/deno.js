// Deno Deploy / `deno run --allow-net proxy/deno.js` entry point for the stream relay.
import { handleRequest } from './stream-proxy.js';

/** Errors that mean DNS lookups aren't available here at all (not merely that a name has no records). */
const LOOKUP_UNAVAILABLE = new Set(['NotSupported', 'PermissionDenied', 'NotCapable']);
let lookupsAvailable = typeof Deno.resolveDns === 'function';
/**
 * Every address a host name resolves to (A and AAAA records), so that the relay also refuses names that
 * point at private addresses. Rejects when a name doesn't resolve; resolves to `null` (no check) if the
 * platform doesn't allow DNS lookups at all.
 * @param {string} hostname
 * @returns {Promise<string[] | null>}
 */
async function resolveHost(hostname) {
  if (!lookupsAvailable) return null; // can't look names up here: relay as if there were no resolver
  let unavailable = false;
  const lookup = async (type) => {
    try {
      return await Deno.resolveDns(hostname, type);
    } catch (err) {
      if (err instanceof TypeError || LOOKUP_UNAVAILABLE.has(err?.name)) unavailable = true;
      return null; // e.g. no AAAA records
    }
  };
  const [v4, v6] = await Promise.all([lookup('A'), lookup('AAAA')]);
  if (v4 || v6) return [...(v4 || []), ...(v6 || [])];
  if (unavailable) {
    lookupsAvailable = false;
    console.warn('DNS lookups are unavailable here; host names are no longer checked for private addresses.');
    return null;
  }
  throw new Error(`Couldn't resolve ${hostname}`);
}

Deno.serve((request) => handleRequest(request, { resolveHost }));
