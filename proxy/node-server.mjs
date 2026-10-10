#!/usr/bin/env node
// Node.js adapter for the IPTV stream relay (./stream-proxy.js): run your own relay on a VPS, a home server,
// a hosting platform (Render, Railway, Fly.io …) or your own computer. No dependencies; Node 18+.
//
//   node proxy/node-server.mjs [--port 8787] [--host 127.0.0.1] [--public-url https://relay.example.com]
//                              [--allow-private]
//
// Environment variables (command-line flags win):
//   PORT, HOST       where to listen (default 127.0.0.1:8787 — use --host 0.0.0.0 on a server)
//   ALLOWED_ORIGINS  comma-separated sites allowed to use the relay; replaces the list in stream-proxy.js
//   PUBLIC_URL       the relay's public https:// origin when it runs behind a reverse proxy or TLS terminator
//   ALLOW_PRIVATE=1  same as --allow-private: also relay localhost / private-network streams (only for
//                    testing, or a relay on a trusted home network)
//
// Bodies are streamed in both directions with backpressure (media is never buffered), and a client that
// disconnects aborts its upstream request. Host names are looked up before they are requested, so names that
// point at private addresses are refused too (unless --allow-private; DNS rebinding remains possible, see
// proxy/README.md).

import { lookup } from 'node:dns/promises';
import { realpathSync } from 'node:fs';
import http from 'node:http';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { ALLOWED_ORIGINS, VERSION, handleRequest } from './stream-proxy.js';

export const DEFAULT_PORT = 8787;
export const DEFAULT_HOST = '127.0.0.1';

const USAGE = `IPTV stream relay v${VERSION}

Usage: node proxy/node-server.mjs [--port 8787] [--host 127.0.0.1] [--public-url https://relay.example.com]
                                  [--allow-private]

  --allow-private   also relay streams on localhost and private networks (192.168.x.x …);
                    only for testing or a relay on a trusted home network

Environment variables (flags win):
  PORT              port to listen on (default ${DEFAULT_PORT})
  HOST              address to listen on (default ${DEFAULT_HOST}; use 0.0.0.0 on a server)
  ALLOWED_ORIGINS   comma-separated origins allowed to use the relay, e.g. https://you.github.io
                    ('*' allows every website — not recommended)
  PUBLIC_URL        public https:// origin of the relay when it runs behind a reverse proxy
  ALLOW_PRIVATE     1 = --allow-private`;

/**
 * Resolve the server options from command-line arguments and environment variables (flags win over env).
 * @param {string[]} [argv]  the arguments after the script name
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ port: number, host: string, allowedOrigins: string[], publicUrl: string,
 *   allowPrivateTargets: boolean, help: boolean }}
 * @throws {Error} for an unknown option or an invalid value (the message is meant for the user)
 */
export function parseOptions(argv = process.argv.slice(2), env = process.env) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      flags.help = true;
      continue;
    }
    if (arg === '--allow-private') {
      flags['allow-private'] = true;
      continue;
    }
    if (arg.startsWith('--allow-private=')) throw new Error('--allow-private takes no value');
    const match = /^--(port|host|public-url)(?:=(.*))?$/.exec(arg);
    if (!match) throw new Error(`Unknown option: ${arg}`);
    const value = match[2] ?? argv[++i];
    if (value === undefined || value === '') throw new Error(`Missing value for --${match[1]}`);
    flags[match[1]] = value;
  }
  return {
    port: parsePort(flags.port ?? (env.PORT || DEFAULT_PORT)),
    host: String(flags.host ?? (env.HOST || DEFAULT_HOST)).trim(),
    allowedOrigins: parseOriginList(env.ALLOWED_ORIGINS),
    publicUrl: parsePublicUrl(flags['public-url'] ?? (env.PUBLIC_URL || '')),
    allowPrivateTargets: flags['allow-private'] ?? parseSwitch('ALLOW_PRIVATE', env.ALLOW_PRIVATE),
    help: Boolean(flags.help),
  };
}

/** An on/off environment variable: 1/true/yes/on or 0/false/no/off (unset or blank = off). */
function parseSwitch(name, value) {
  const text = String(value ?? '')
    .trim()
    .toLowerCase();
  if (/^(?:1|true|yes|on)$/.test(text)) return true;
  if (/^(?:0|false|no|off)?$/.test(text)) return false;
  throw new Error(`Invalid ${name}: "${value}" (use 1 to turn it on, 0 to turn it off)`);
}

function parsePort(value) {
  const text = String(value).trim();
  const port = Number(text);
  if (!/^\d+$/.test(text) || port > 65535) throw new Error(`Invalid port: ${text}`);
  return port;
}

/** `ALLOWED_ORIGINS` → normalized origins ('*' kept); unset or blank → the list in stream-proxy.js. */
function parseOriginList(value) {
  const entries = String(value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (!entries.length) return [...ALLOWED_ORIGINS];
  return entries.map((entry) => {
    if (entry === '*') return '*';
    const origin = tryParseUrl(entry)?.origin;
    if (!origin || origin === 'null') {
      throw new Error(`Invalid origin in ALLOWED_ORIGINS: "${entry}" (use e.g. https://you.github.io)`);
    }
    return origin;
  });
}

function parsePublicUrl(value) {
  const text = String(value).trim();
  if (!text) return '';
  const url = tryParseUrl(text);
  const isOrigin = url && /^https?:$/.test(url.protocol) && url.pathname === '/' && !url.search && !url.hash;
  if (!isOrigin || url.username || url.password) {
    throw new Error(`Invalid public URL: "${text}" (use the bare origin, e.g. https://relay.example.com)`);
  }
  return url.origin;
}

/**
 * Every address a host name resolves to (IPv4 and IPv6, as the system resolver that fetch() uses sees it), for
 * the relay's private-network check. Rejects when the name doesn't resolve.
 * @param {string} hostname
 * @returns {Promise<string[]>}
 */
export async function resolveHost(hostname) {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

/**
 * Create (but don't start) an HTTP server that serves the relay.
 *
 * The request URL handed to the relay is `publicUrl` when set, else built from the `Host` header and
 * `X-Forwarded-Proto`. It is only the base for rewritten playlist URLs and never unlocks anything: both
 * headers are up to the client. Localhost / private-network targets, also host names that resolve to such
 * addresses, are refused unless `allowPrivateTargets` is set (only for testing, or a relay on a trusted home
 * network).
 *
 * @param {{ allowedOrigins?: string[], publicUrl?: string, allowPrivateTargets?: boolean,
 *   fetchImpl?: typeof fetch, resolveHost?: (hostname: string) => Promise<string[]>,
 *   onError?: (err: unknown) => void }} [options]  `resolveHost` defaults to node:dns (see resolveHost())
 * @returns {import('node:http').Server}
 */
export function createRelayServer({
  allowedOrigins = ALLOWED_ORIGINS,
  publicUrl = '',
  allowPrivateTargets = false,
  fetchImpl = globalThis.fetch,
  resolveHost: resolve = resolveHost,
  onError = (err) => console.error(`Relay error: ${err?.message || err}`),
} = {}) {
  const relayOptions = { allowedOrigins, fetchImpl, allowPrivateTargets, resolveHost: resolve };
  return http.createServer((req, res) => {
    serve(req, res, publicUrl, relayOptions).catch((err) => {
      onError(err);
      if (!res.headersSent && !res.destroyed) sendText(res, 500, 'Relay error');
      else res.destroy();
    });
  });
}

async function serve(req, res, publicUrl, relayOptions) {
  const controller = new AbortController();
  // 'close' also fires after a complete response; only an unfinished one means the client went away.
  res.on('close', () => {
    if (!res.writableFinished) controller.abort();
  });

  const base = requestBase(req, publicUrl);
  if (!base) return sendText(res, 400, 'Invalid Host header');
  if (!req.url.startsWith('/')) return sendText(res, 400, 'Bad request');

  let request;
  try {
    request = toWebRequest(req, base.origin + req.url, controller.signal);
  } catch {
    // e.g. TRACE, which fetch's Request refuses to represent
    return req.method === 'GET' || req.method === 'HEAD'
      ? sendText(res, 400, 'Bad request')
      : sendText(res, 405, 'Method not allowed', { Allow: 'GET, HEAD, OPTIONS' });
  }

  const response = await handleRequest(request, relayOptions);
  await sendResponse(req, res, response);
}

/** The origin the client used to reach the relay, or null when the Host header is unusable. */
function requestBase(req, publicUrl) {
  if (publicUrl) return new URL(publicUrl);
  const forwarded = String(req.headers['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  const secure = forwarded ? forwarded === 'https' : Boolean(req.socket.encrypted);
  const proto = secure ? 'https' : 'http';
  const host = req.headers.host || socketHost(req.socket);
  const base = tryParseUrl(`${proto}://${host}`);
  // A Host header is just `host[:port]`; anything that parses into more (user info, a path …) is bogus.
  const isPlain = base && base.host === base.href.slice(proto.length + 3, -1);
  return isPlain ? base : null;
}

/** `address:port` of the local end of the connection (for HTTP/1.0 clients that send no Host header). */
function socketHost(socket) {
  let address = String(socket.localAddress || '127.0.0.1').replace(/%.*$/, '');
  if (address.startsWith('::ffff:') && isIP(address.slice(7)) === 4) address = address.slice(7);
  return `${isIP(address) === 6 ? `[${address}]` : address}:${socket.localPort}`;
}

/** node:http request → web Request (the body, if any, is streamed, not buffered). */
function toWebRequest(req, url, signal) {
  const headers = new Headers();
  for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
    if (!req.rawHeaders[i].startsWith(':')) headers.append(req.rawHeaders[i], req.rawHeaders[i + 1]);
  }
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  return new Request(url, {
    method: req.method,
    headers,
    signal,
    ...(hasBody ? { body: lazyBody(req), duplex: 'half' } : {}),
  });
}

/**
 * The request body as a web stream that only touches `req` once someone reads it. The relay never reads a
 * body (it answers 405), and an untouched body is drained by node:http itself after the response, which keeps
 * the connection usable for the next request (destroying it instead could reset the response in flight).
 */
function lazyBody(req) {
  let chunks;
  return new ReadableStream(
    {
      async pull(controller) {
        chunks ??= req[Symbol.asyncIterator]();
        const { done, value } = await chunks.next();
        if (done) controller.close();
        else controller.enqueue(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
      },
      async cancel() {
        await chunks?.return?.();
      },
    },
    { highWaterMark: 0 },
  );
}

/** Web Response → node:http response, streaming the body with backpressure. */
async function sendResponse(req, res, response) {
  if (res.destroyed) {
    response.body?.cancel().catch(() => {});
    return;
  }
  const headers = {};
  response.headers.forEach((value, name) => {
    headers[name] = value;
  });
  res.writeHead(response.status, headers);
  if (!response.body || req.method === 'HEAD') {
    response.body?.cancel().catch(() => {});
    res.end();
    return;
  }
  try {
    await pipeline(Readable.fromWeb(response.body), res);
  } catch {
    // The client disconnected or the upstream connection broke mid-stream; pipeline() has already torn
    // down both sides (which also cancels the upstream body).
  }
}

function sendText(res, status, message, extraHeaders = {}) {
  if (res.destroyed) return;
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  res.end(message);
}

function tryParseUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function formatAddress(host, port) {
  return `http://${isIP(host) === 6 ? `[${host}]` : host}:${port}`;
}

function main() {
  let options;
  try {
    options = parseOptions();
  } catch (err) {
    console.error(`${err.message}\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    console.log(USAGE);
    return;
  }

  const server = createRelayServer(options);
  server.on('error', (err) => {
    console.error(
      err.code === 'EADDRINUSE'
        ? `Port ${options.port} is already in use. Pick another one with --port.`
        : `Couldn't start the relay: ${err.message}`,
    );
    process.exit(1);
  });
  server.listen(options.port, options.host, () => {
    const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
    console.log(`IPTV stream relay v${VERSION} listening on ${formatAddress(options.host, port)}`);
    if (options.host === '0.0.0.0' || options.host === '::') {
      console.log(`On this computer: http://localhost:${port}`);
    }
    if (options.publicUrl) console.log(`Public URL: ${options.publicUrl}`);
    console.log(`Allowed origins: ${options.allowedOrigins.join(', ')}`);
    if (options.allowedOrigins.includes('*')) {
      console.log('Warning: ALLOWED_ORIGINS=* lets every website use this relay (and your bandwidth).');
    }
    if (options.allowPrivateTargets) {
      console.log(
        'Warning: --allow-private lets callers reach localhost and your private network through this ' +
          'relay. Use it only for testing or on a trusted home network.',
      );
    }
    console.log('Press Ctrl+C to stop.');
  });

  const shutdown = () => {
    server.close();
    server.closeAllConnections?.(); // live streams never end on their own
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

function isEntryPoint() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) main();
