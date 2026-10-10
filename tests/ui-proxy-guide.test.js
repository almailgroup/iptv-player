// Stream relay UI (src/ui/dialogs.js): the relay code the setup guide copies (loaded lazily), the health check
// behind "Test" / "Save & test", the "Play blocked channels" guide and the Settings relay controls — with and
// without a built-in relay (VITE_BUILTIN_RELAY).
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import RELAY_SOURCE from '../proxy/stream-proxy.js?raw';
import DENO_JS from '../proxy/deno.js?raw';
import { createStore } from '../src/app/store.js';
import { DEFAULT_SETTINGS } from '../src/app/constants.js';
import {
  checkProxyHealth,
  loadRelaySource,
  openProxyGuide,
  openSettingsDialog,
  proxyHealthUrl,
  relaySourceFor as relaySourceForSource,
} from '../src/ui/dialogs.js';

const ENTRY_MARKER =
  '// ---- entry point (the in-app setup guide swaps this block for the chosen platform) ----';
const DEV = [
  'http://localhost:5173',
  'http://localhost:4173',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:4173',
];
const ORIGINS_LINE = /^export const ALLOWED_ORIGINS = .*;$/m;

const healthy = (version = 1) =>
  new Response(JSON.stringify({ ok: true, service: 'iptv-stream-relay', version }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

const flush = async (n = 20) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

/** Resolve once `check` returns truthy (polling microtasks and short timers). */
async function until(check, { tries = 60 } = {}) {
  for (let i = 0; i < tries; i++) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('condition not met');
}

function makeStore(settings = {}) {
  return createStore({
    ready: true,
    busy: null,
    playlists: [],
    theme: { accent: 'azure', mode: 'dark' },
    settings: { ...DEFAULT_SETTINGS, ...settings },
  });
}

function makeActions(store) {
  return {
    updateSettings: vi.fn((patch) => store.set((s) => ({ settings: { ...s.settings, ...patch } }))),
    setAccent: vi.fn(),
    setMode: vi.fn(),
    clearAllData: vi.fn(),
  };
}

const openHandles = [];
const track = (handle) => {
  openHandles.push(handle);
  return handle;
};

beforeEach(() => {
  document.body.replaceChildren();
});

afterEach(async () => {
  for (const handle of openHandles.splice(0)) handle.close();
  await new Promise((resolve) => setTimeout(resolve, 0));
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.happyDOM?.setURL('http://localhost:3000/');
});

// ---------------------------------------------------------------------------------------------------------

describe('relay source', () => {
  it('is loaded on demand, not bundled into the dialogs module', async () => {
    const module = readFileSync(join(process.cwd(), 'src/ui/dialogs.js'), 'utf8');
    expect(module).not.toMatch(/^import [^;]*stream-proxy\.js\?raw/m);
    expect(module).toContain("import('../../proxy/stream-proxy.js?raw')");
    const first = loadRelaySource();
    expect(loadRelaySource()).toBe(first); // cached
    expect(await first).toBe(RELAY_SOURCE);
  });
});

describe('relaySourceFor', () => {
  const allowed = (source) => source.match(ORIGINS_LINE)?.[0];
  const relaySourceFor = (platform, ...origin) => relaySourceForSource(RELAY_SOURCE, platform, ...origin);

  it('lists this site plus the local dev servers on the single ALLOWED_ORIGINS line', () => {
    const source = relaySourceFor('cloudflare', 'https://me.github.io');
    expect(allowed(source)).toBe(
      `export const ALLOWED_ORIGINS = [${['https://me.github.io', ...DEV].map((o) => `'${o}'`).join(', ')}];`,
    );
    expect(source.match(/^export const ALLOWED_ORIGINS/gm)).toHaveLength(1);
    expect(source).not.toContain('almailgroup.github.io');
  });

  it('normalizes the origin and skips duplicates or non-http(s) origins', () => {
    const normalized = allowed(relaySourceFor('deno', 'HTTPS://Me.GitHub.io:443/iptv/'));
    expect(normalized).toContain("['https://me.github.io', ");
    const dev = allowed(relaySourceFor('deno', 'http://localhost:5173'));
    expect(dev.match(/localhost:5173/g)).toHaveLength(1);
    expect(allowed(relaySourceFor('deno', 'null'))).toBe(
      `export const ALLOWED_ORIGINS = [${DEV.map((o) => `'${o}'`).join(', ')}];`,
    );
  });

  it('defaults to this page’s origin', () => {
    window.happyDOM.setURL('https://iptv.example.org/player/?x=1');
    expect(allowed(relaySourceFor('cloudflare'))).toContain("['https://iptv.example.org', ");
  });

  it('keeps the default-export entry point for Cloudflare Workers', () => {
    const source = relaySourceFor('cloudflare', 'https://me.github.io');
    expect(source).toContain(ENTRY_MARKER);
    expect(source).toMatch(/export default \{ fetch: \(request\) => handleRequest\(request\) \};\s*$/);
    expect(source).not.toContain('Deno.serve');
  });

  it('swaps the entry point block for Deno.serve on Deno Deploy', () => {
    const source = relaySourceFor('deno', 'https://me.github.io');
    expect(source).not.toContain(ENTRY_MARKER);
    expect(source).not.toMatch(/^export default/m);
    expect(source.trimEnd().endsWith('Deno.serve((request) => handleRequest(request, { resolveHost }));')).toBe(
      true,
    );
    // Everything before the entry point is the relay, untouched apart from the origins line.
    const head = RELAY_SOURCE.slice(0, RELAY_SOURCE.indexOf(ENTRY_MARKER));
    expect(source.startsWith(head.replace(ORIGINS_LINE, allowed(source)))).toBe(true);
  });

  it('gives the Deno Deploy relay the DNS lookup of proxy/deno.js, so names of private addresses are refused', () => {
    const source = relaySourceFor('deno', 'https://me.github.io');
    const tail = (text) => text.slice(text.indexOf('async function resolveHost('));
    expect(tail(source)).toBe(tail(DENO_JS));
    // Run the copied code with a stand-in for Deno: a name of a loopback address is refused before any fetch,
    // a name that doesn't resolve answers 502, and the health check still works.
    const stub = `globalThis.fetch = async (url) => { console.log('fetched', String(url)); return new Response('x'); };
      globalThis.Deno = {
        resolveDns: async (host, type) => {
          if (host === '127.0.0.1.nip.io' && type === 'A') return ['127.0.0.1'];
          throw new Error('NotFound');
        },
        serve: async (handler) => {
          const ask = async (path) => {
            const res = await handler(new Request('https://x.deno.dev' + path, { headers: { Origin: 'https://me.github.io' } }));
            console.log(res.status, await res.text());
          };
          await ask('/?health');
          await ask('/?url=' + encodeURIComponent('http://127.0.0.1.nip.io/a.ts'));
          await ask('/?url=' + encodeURIComponent('http://nxdomain.invalid/a.ts'));
        },
      };\n`;
    const out = execFileSync(process.execPath, ['--input-type=module'], { input: stub + source, encoding: 'utf8' });
    expect(out.trim().split('\n')).toEqual([
      '200 {"ok":true,"service":"iptv-stream-relay","version":1}',
      '403 Target not allowed',
      '502 Upstream unreachable',
    ]);
  });

  it('produces valid JavaScript modules for both platforms', () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-src-'));
    try {
      for (const platform of ['deno', 'cloudflare']) {
        const file = join(dir, `${platform}.mjs`);
        writeFileSync(file, relaySourceFor(platform, "https://o'brien.example"));
        expect(() => execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })).not.toThrow();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('proxyHealthUrl', () => {
  it.each([
    ['https://relay.deno.dev', 'https://relay.deno.dev/?health'],
    ['https://relay.deno.dev/', 'https://relay.deno.dev/?health'],
    ['https://relay.deno.dev/?url=', 'https://relay.deno.dev/?health'],
    ['https://relay.deno.dev/?url={url}', 'https://relay.deno.dev/?health'],
    ['https://host.example/relay/{url}', 'https://host.example/relay/?health'],
    ['  https://host.example:8443/r/?url=#x ', 'https://host.example:8443/r/?health'],
    ['http://localhost:8787', 'http://localhost:8787/?health'],
    ['https://user:pw@host.example/', 'https://host.example/?health'],
  ])('%s → %s', (proxy, expected) => {
    expect(proxyHealthUrl(proxy)).toBe(expected);
  });

  it.each(['', 'relay.deno.dev', 'ftp://host/', null, undefined])('rejects %s', (proxy) => {
    expect(proxyHealthUrl(proxy)).toBe('');
  });
});

describe('checkProxyHealth', () => {
  it('reports a working relay with its version', async () => {
    const fetchImpl = vi.fn(async () => healthy(1));
    const result = await checkProxyHealth('https://relay.deno.dev/?url=', { fetchImpl });
    expect(result).toEqual({ status: 'ok', version: 1, message: 'Relay is working (v1)' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://relay.deno.dev/?health');
    expect(init).toMatchObject({ method: 'GET', cache: 'no-store', credentials: 'omit' });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('uses the global fetch by default', async () => {
    const fetchMock = vi.fn(async () => healthy(1));
    vi.stubGlobal('fetch', fetchMock);
    expect((await checkProxyHealth('https://relay.deno.dev')).status).toBe('ok');
    expect(fetchMock).toHaveBeenCalledWith('https://relay.deno.dev/?health', expect.any(Object));
  });

  it('compares the reported version with the bundled relay code', async () => {
    const bundled = Number(/^export const VERSION = (\d+);/m.exec(RELAY_SOURCE)[1]);
    const check = (version) =>
      checkProxyHealth('https://relay.deno.dev', { fetchImpl: async () => healthy(version) });
    expect(await check(bundled + 1)).toEqual({
      status: 'ok',
      version: bundled + 1,
      message: `Relay is working (v${bundled + 1})`,
    });
    // A missing or malformed version is "unknown", not an error.
    expect(await check(0.5)).toEqual({ status: 'ok', version: 0, message: 'Relay is working' });
    expect(await check('2')).toEqual({ status: 'ok', version: 0, message: 'Relay is working' });
    if (bundled > 1) {
      const old = await check(bundled - 1);
      expect(old.status).toBe('warning');
      expect(old.message).toContain('out of date');
    }
  });

  it('reports a relay older than the shipped code as out of date', async () => {
    vi.resetModules();
    vi.doMock('../proxy/stream-proxy.js?raw', () => ({ default: 'export const VERSION = 3;\n' }));
    try {
      const dialogs = await import('../src/ui/dialogs.js');
      const check = (version) =>
        dialogs.checkProxyHealth('https://relay.deno.dev', { fetchImpl: async () => healthy(version) });
      expect(await check(2)).toEqual({
        status: 'warning',
        version: 2,
        message:
          'Relay is working (v2), but it’s out of date. Copy the relay code again and redeploy it to update.',
      });
      expect((await check(3)).status).toBe('ok');
    } finally {
      vi.doUnmock('../proxy/stream-proxy.js?raw');
      vi.resetModules();
    }
  });

  it('tells "running but not allowing this site" apart from "unreachable"', async () => {
    window.happyDOM.setURL('https://me.github.io/iptv/');
    const blocked = vi.fn(async (url, init) => {
      if (init.mode === 'no-cors') return new Response(null, { status: 200 });
      throw new TypeError('Failed to fetch');
    });
    const notAllowed = await checkProxyHealth('https://relay.deno.dev', { fetchImpl: blocked });
    expect(notAllowed.status).toBe('error');
    expect(notAllowed.message).toContain('doesn’t allow this site (https://me.github.io)');
    expect(blocked).toHaveBeenCalledTimes(2);

    const down = await checkProxyHealth('https://relay.deno.dev', {
      fetchImpl: async () => {
        throw new TypeError('Failed to fetch');
      },
    });
    expect(down).toEqual({
      status: 'error',
      message: 'Couldn’t reach the relay. Check the address and that the relay is deployed.',
    });
  });

  it('reports HTTP errors and foreign services', async () => {
    const http = (status) => async () => new Response('nope', { status });
    expect((await checkProxyHealth('https://p.example', { fetchImpl: http(403) })).message).toBe(
      'The relay refused this site (HTTP 403).',
    );
    const failing = await checkProxyHealth('https://p.example', { fetchImpl: http(502) });
    expect(failing.message).toContain('HTTP 502');
    const html = await checkProxyHealth('https://p.example', {
      fetchImpl: async () => new Response('<!doctype html><title>Hi</title>', { status: 200 }),
    });
    expect(html.status).toBe('warning');
    expect(html.message).toContain('isn’t the IPTV stream relay');
    const other = await checkProxyHealth('https://p.example', {
      fetchImpl: async () => new Response(JSON.stringify({ ok: true, service: 'other' }), { status: 200 }),
    });
    expect(other.status).toBe('warning');
  });

  it('times out, and returns null when the caller aborts', async () => {
    const hang = (url, init) =>
      new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      });
    const timedOut = await checkProxyHealth('https://p.example', { fetchImpl: hang, timeoutMs: 20 });
    expect(timedOut.status).toBe('error');
    expect(timedOut.message).toContain('didn’t answer within 10 seconds');

    const controller = new AbortController();
    const pending = checkProxyHealth('https://p.example', { fetchImpl: hang, signal: controller.signal });
    controller.abort();
    expect(await pending).toBeNull();

    const fetchImpl = vi.fn();
    expect(await checkProxyHealth('https://p.example', { fetchImpl, signal: AbortSignal.abort() })).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects settings that are not http(s) URLs without a request', async () => {
    const fetchImpl = vi.fn();
    const result = await checkProxyHealth('relay.deno.dev', { fetchImpl });
    expect(result.status).toBe('error');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------------------

describe('openProxyGuide', () => {
  function mountGuide(settings) {
    const store = makeStore(settings);
    const actions = makeActions(store);
    const handle = track(openProxyGuide({ store, actions }));
    const el = handle.el;
    const tabs = [...el.querySelectorAll('[role="tab"]')];
    const panels = [...el.querySelectorAll('[role="tabpanel"]')];
    const input = el.querySelector('.dlg-guide-connect input');
    const save = el.querySelector('.dlg-save-test');
    return { store, actions, handle, el, tabs, panels, input, save };
  }

  it('explains the problem and offers Deno Deploy (recommended) and Cloudflare Workers', () => {
    const { el, tabs, panels } = mountGuide();
    expect(el.querySelector('.md-title').textContent).toBe('Play blocked channels');
    const why = el.querySelector('.dlg-guide-why').textContent;
    expect(why).toContain('insecure http://');
    expect(why).toContain('Free');
    expect(why).toContain('About 5 minutes');
    expect(why).toContain('Your traffic goes through your relay');

    expect(tabs.map((t) => t.textContent)).toEqual(['Deno DeployRecommended', 'Cloudflare Workers']);
    expect(tabs[0].getAttribute('aria-selected')).toBe('true');
    expect(panels[0].hidden).toBe(false);
    expect(panels[1].hidden).toBe(true);
    expect(tabs[0].getAttribute('aria-controls')).toBe(panels[0].id);

    const denoSteps = [...panels[0].querySelectorAll('.dlg-step')].map((s) => s.textContent);
    expect(denoSteps).toHaveLength(5);
    expect(denoSteps[0]).toContain('console.deno.com');
    expect(denoSteps[1]).toContain('playground');
    expect(denoSteps[2]).toContain('Copy relay code');
    expect(denoSteps[3]).toContain('Deploy');
    expect(denoSteps[4]).toContain('https://');
    expect(denoSteps[4]).toContain('.deno.net');
    expect(denoSteps[4]).toContain('.deno.dev');

    const cfText = panels[1].textContent;
    expect(cfText).toContain(
      'Can’t reach streams on IP addresses or custom ports — use Deno Deploy for those.',
    );
    expect(cfText).toContain('Workers & Pages → Create → Worker');
    expect(cfText).toContain('Edit code');
    expect(cfText).toContain('https://….workers.dev');
    expect(el.querySelector('.dlg-guide-own').textContent).toContain('proxy/node-server.mjs');
  });

  it('opens every link in a new tab without referrer', () => {
    const { el } = mountGuide();
    const links = [...el.querySelectorAll('a')];
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      'https://console.deno.com',
      'https://dash.cloudflare.com',
      'https://github.com/almailgroup/iptv-player/blob/main/proxy/README.md',
    ]);
    for (const a of links) {
      expect(a.target).toBe('_blank');
      expect(a.rel).toBe('noopener noreferrer');
    }
  });

  it('switches platforms by click and arrow keys, remembering the choice', () => {
    const { el, tabs, panels, input, handle } = mountGuide();
    tabs[1].click();
    expect(tabs[1].getAttribute('aria-selected')).toBe('true');
    expect(panels[0].hidden).toBe(true);
    expect(panels[1].hidden).toBe(false);
    expect(input.placeholder).toBe('https://your-relay.workers.dev');
    tabs[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(tabs[0].getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(tabs[0]);
    tabs[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect(tabs[1].getAttribute('aria-selected')).toBe('true');
    expect(el.isConnected).toBe(true);

    handle.close();
    const again = mountGuide();
    expect(again.tabs[1].getAttribute('aria-selected')).toBe('true');
    again.tabs[0].click(); // leave the default for the other tests
  });

  it('returns the open guide instead of stacking a second one', () => {
    const { handle, store, actions } = mountGuide();
    expect(openProxyGuide({ store, actions })).toBe(handle);
    expect(document.querySelectorAll('.dlg-guide-dialog')).toHaveLength(1);
  });

  it('copies the platform’s relay code and confirms with a toast', async () => {
    window.happyDOM.setURL('https://me.github.io/iptv/');
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    const { panels, tabs } = mountGuide();
    panels[0].querySelector('.dlg-copy-btn').click();
    await until(() => writeText.mock.calls.length);
    expect(writeText.mock.calls[0][0]).toBe(relaySourceForSource(RELAY_SOURCE, 'deno', 'https://me.github.io'));
    await until(() => document.querySelector('.toast-message'));
    expect(document.querySelector('.toast-message').textContent).toBe('Relay code copied');
    expect(panels[0].querySelector('.dlg-copy-btn').textContent).toBe('Copied');

    tabs[1].click();
    panels[1].querySelector('.dlg-copy-btn').click();
    await until(() => writeText.mock.calls.length === 2);
    expect(writeText.mock.calls[1][0]).toBe(
      relaySourceForSource(RELAY_SOURCE, 'cloudflare', 'https://me.github.io'),
    );
    tabs[0].click();
  });

  it('validates the address before saving', async () => {
    window.happyDOM.setURL('https://me.github.io/');
    const { input, save, actions, el } = mountGuide();
    const error = el.querySelector('.dlg-guide-connect .field-error');
    save.click();
    expect(error.textContent).toContain('Paste your relay’s address');
    expect(input.getAttribute('aria-invalid')).toBe('true');

    input.value = 'relay.deno.dev';
    input.dispatchEvent(new Event('input'));
    expect(error.textContent).toBe('');
    save.click();
    expect(error.textContent).toContain('full http(s) address');

    input.value = 'http://203.0.113.9:8787';
    save.click();
    expect(error.textContent).toContain('Use an https:// address');
    expect(actions.updateSettings).not.toHaveBeenCalled();
  });

  it('saves, enables proxyStreams, tests the relay and reports the result', async () => {
    window.happyDOM.setURL('https://me.github.io/');
    const fetchMock = vi.fn(async () => healthy(1));
    vi.stubGlobal('fetch', fetchMock);
    const { input, save, actions, store, el, handle } = mountGuide({ proxyStreams: false });
    input.value = '  https://my-relay.deno.dev ';
    save.click();
    expect(actions.updateSettings).toHaveBeenCalledWith({
      corsProxy: 'https://my-relay.deno.dev',
      proxyStreams: true,
    });
    expect(store.get().settings).toMatchObject({ corsProxy: 'https://my-relay.deno.dev', proxyStreams: true });
    expect(save.textContent).toBe('Testing…');
    const check = el.querySelector('.dlg-guide-connect .dlg-check');
    await until(() => check.dataset.status === 'ok');
    expect(fetchMock).toHaveBeenCalledWith('https://my-relay.deno.dev/?health', expect.any(Object));
    expect(check.textContent).toBe('Relay is working (v1). Blocked channels will now play through it.');
    expect(save.textContent).toBe('Save & test');
    expect(el.querySelector('.md-footer .btn').classList.contains('btn-primary')).toBe(true);

    el.querySelector('.md-footer .btn').click();
    await expect(handle.result).resolves.toEqual({ proxy: 'https://my-relay.deno.dev', working: true });
  });

  it('allows http://localhost relays on secure pages and reports a failed test', async () => {
    window.happyDOM.setURL('https://me.github.io/');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    const { input, save, el, handle } = mountGuide();
    input.value = 'http://localhost:8787';
    save.click();
    const check = el.querySelector('.dlg-guide-connect .dlg-check');
    await until(() => check.dataset.status === 'error');
    expect(check.textContent).toContain('Couldn’t reach the relay');
    handle.close();
    await expect(handle.result).resolves.toEqual({ proxy: 'http://localhost:8787', working: false });
  });

  it('resolves undefined when closed without saving, and drops an edited test', async () => {
    let finish;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (url, init) =>
          new Promise((resolve, reject) => {
            finish = () => resolve(healthy(1));
            init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
          }),
      ),
    );
    const first = mountGuide();
    first.input.value = 'https://my-relay.deno.dev';
    first.save.click();
    first.input.value = 'https://other.deno.dev';
    first.input.dispatchEvent(new Event('input'));
    finish();
    await flush();
    expect(first.el.querySelector('.dlg-guide-connect .dlg-check').textContent).toBe('');
    expect(first.save.textContent).toBe('Save & test');
    first.handle.close();
    await expect(first.handle.result).resolves.toEqual({ proxy: 'https://my-relay.deno.dev', working: false });

    const second = mountGuide();
    second.handle.close();
    await expect(second.handle.result).resolves.toBeUndefined();
  });

  it('prefills the saved proxy', () => {
    const { input } = mountGuide({ corsProxy: 'https://saved.deno.dev' });
    expect(input.value).toBe('https://saved.deno.dev');
  });
});

// ---------------------------------------------------------------------------------------------------------

describe('Settings — relay', () => {
  function mountSettings(settings) {
    const store = makeStore(settings);
    const actions = makeActions(store);
    const handle = track(openSettingsDialog({ store, actions }));
    const row = handle.el.querySelector('.dlg-row-proxy');
    const input = row.querySelector('input');
    const test = row.querySelector('.dlg-proxy-test');
    const streams = [...handle.el.querySelectorAll('.dlg-row-switch')].find((r) =>
      r.textContent.includes('Play blocked streams through the relay'),
    );
    return { store, actions, handle, row, input, test, streams, streamsInput: streams.querySelector('input') };
  }

  it('labels the field "Relay (optional)" with the relay hint, without a built-in relay switch', () => {
    const { row, input, handle } = mountSettings();
    expect(handle.el.textContent).not.toContain('Use the built-in relay');
    expect(row.querySelector('.dlg-row-label').textContent).toBe('Relay (optional)');
    expect(row.querySelector('.dlg-row-hint').textContent).toBe(
      'Your own relay for streams and playlists that browsers block (insecure HTTP or missing CORS). ' +
        'Leave empty to disable.',
    );
    expect(input.placeholder).toBe('https://your-relay.deno.dev');
  });

  it('enables "Play blocked streams through the relay" only once a relay is set', () => {
    const { streams, streamsInput, store, actions } = mountSettings();
    expect(streamsInput.checked).toBe(true);
    expect(streamsInput.disabled).toBe(true);
    expect(streams.classList.contains('is-disabled')).toBe(true);

    store.set({ settings: { ...store.get().settings, corsProxy: 'https://relay.deno.dev' } });
    expect(streamsInput.disabled).toBe(false);
    expect(streams.classList.contains('is-disabled')).toBe(false);
    streamsInput.checked = false;
    streamsInput.dispatchEvent(new Event('change'));
    expect(actions.updateSettings).toHaveBeenLastCalledWith({ proxyStreams: false });
  });

  it('tests the typed relay (saving it first) and shows the result inline', async () => {
    const fetchMock = vi.fn(async () => healthy(1));
    vi.stubGlobal('fetch', fetchMock);
    const { input, test, row, actions } = mountSettings();
    expect(test.disabled).toBe(true);
    input.value = 'https://relay.deno.dev';
    input.dispatchEvent(new Event('input'));
    expect(test.disabled).toBe(false);
    test.click();
    expect(actions.updateSettings).toHaveBeenCalledWith({ corsProxy: 'https://relay.deno.dev' });
    const check = row.querySelector('.dlg-check');
    expect(check.textContent).toBe('Testing your relay…');
    await until(() => check.dataset.status === 'ok');
    expect(check.textContent).toBe('Relay is working (v1)');
    expect(fetchMock).toHaveBeenCalledWith('https://relay.deno.dev/?health', expect.any(Object));

    input.value = 'https://relay2.deno.dev';
    input.dispatchEvent(new Event('input'));
    expect(check.textContent).toBe('');
  });

  it('shows validation errors instead of testing', () => {
    window.happyDOM.setURL('https://me.github.io/');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { input, test, row } = mountSettings();
    input.value = 'http://203.0.113.9:8080';
    input.dispatchEvent(new Event('input'));
    test.click();
    expect(row.querySelector('.field-error').textContent).toContain('Use an https:// address');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('opens the setup guide', () => {
    const { row } = mountSettings();
    row.querySelector('.dlg-link-btn').click();
    const guide = document.querySelector('.dlg-guide-dialog');
    expect(guide).not.toBeNull();
    track({ close: () => guide.querySelector('.md-close').click() });
  });
});

// ---------------------------------------------------------------------------------------------------------

describe('with a built-in relay', () => {
  const BUILTIN = 'https://relay.example.test';
  let dialogs;
  let freshStore;
  let defaults;

  beforeAll(async () => {
    vi.stubEnv('VITE_BUILTIN_RELAY', BUILTIN);
    vi.resetModules();
    dialogs = await import('../src/ui/dialogs.js');
    freshStore = (await import('../src/app/store.js')).createStore;
    defaults = (await import('../src/app/constants.js')).DEFAULT_SETTINGS;
  });

  afterAll(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  function mountSettings(settings) {
    const store = freshStore({
      ready: true,
      busy: null,
      playlists: [],
      theme: { accent: 'azure', mode: 'dark' },
      settings: { ...defaults, ...settings },
    });
    const actions = makeActions(store);
    const handle = track(dialogs.openSettingsDialog({ store, actions }));
    const switchRow = (label) =>
      [...handle.el.querySelectorAll('.dlg-row-switch')].find((r) => r.textContent.includes(label));
    const builtinRow = switchRow('Use the built-in relay');
    const streams = switchRow('Play blocked streams through the relay');
    const row = handle.el.querySelector('.dlg-row-proxy');
    return {
      store,
      actions,
      handle,
      row,
      builtinRow,
      builtinInput: builtinRow.querySelector('input'),
      builtinHint: () => builtinRow.querySelector('.dlg-row-hint').textContent,
      streams,
      streamsInput: streams.querySelector('input'),
      input: row.querySelector('input'),
      test: row.querySelector('.dlg-proxy-test'),
      check: row.querySelector('.dlg-check'),
    };
  }

  it('shows "Use the built-in relay" above the optional own relay', () => {
    const { handle, row, builtinRow, builtinInput, builtinHint } = mountSettings();
    const network = [...handle.el.querySelectorAll('.dlg-section')].find(
      (sec) => sec.querySelector('.dlg-section-title').textContent === 'Network',
    );
    const rows = [...network.querySelectorAll('.dlg-card > .dlg-row')];
    expect(rows.map((r) => r.querySelector('.dlg-row-label').textContent)).toEqual([
      'Use the built-in relay',
      'Your own relay (optional)',
      'Play blocked streams through the relay',
    ]);
    expect(rows[0]).toBe(builtinRow);
    expect(builtinInput.checked).toBe(true);
    expect(builtinHint()).toBe(
      'Lets insecure (http://) and blocked channels play. Your viewing of those channels passes through ' +
        'this site’s relay.',
    );
    expect(row.querySelector('.dlg-row-hint').textContent).toBe('Overrides the built-in relay.');
    expect(row.querySelector('.dlg-link-btn').textContent).toBe('Set up your own relay…');
  });

  it('enables relay streaming and Test with the built-in relay alone', () => {
    const { builtinInput, streams, streamsInput, test, actions, store, builtinHint } = mountSettings();
    expect(streamsInput.disabled).toBe(false);
    expect(streams.classList.contains('is-disabled')).toBe(false);
    expect(test.disabled).toBe(false);
    expect(test.title).toBe('Test the built-in relay');

    builtinInput.checked = false;
    builtinInput.dispatchEvent(new Event('change'));
    expect(actions.updateSettings).toHaveBeenLastCalledWith({ useBuiltinRelay: false });
    expect(streamsInput.disabled).toBe(true);
    expect(test.disabled).toBe(true);

    // The user's own relay takes over (the built-in switch no longer matters).
    store.set({ settings: { ...store.get().settings, corsProxy: 'https://mine.deno.dev' } });
    expect(streamsInput.disabled).toBe(false);
    expect(test.title).toBe('Test your relay');
    expect(builtinHint()).toBe('Not used while your own relay is set below.');
  });

  it('tests the built-in relay when no own relay is typed, worded for visitors', async () => {
    const fetchMock = vi.fn(async () => healthy(1));
    vi.stubGlobal('fetch', fetchMock);
    const { test, check, builtinInput, actions } = mountSettings();
    test.click();
    expect(actions.updateSettings).not.toHaveBeenCalled(); // nothing typed, nothing saved
    expect(check.textContent).toBe('Testing the built-in relay…');
    await until(() => check.dataset.status === 'ok');
    expect(fetchMock).toHaveBeenCalledWith(`${BUILTIN}/?health`, expect.any(Object));
    expect(check.textContent).toBe('The built-in relay is working (v1)');

    // Switching it off makes that result stale.
    builtinInput.checked = false;
    builtinInput.dispatchEvent(new Event('change'));
    expect(check.textContent).toBe('');
  });

  it('reports a failing built-in relay without setup advice', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    const { test, check } = mountSettings();
    test.click();
    await until(() => check.dataset.status === 'error');
    expect(check.textContent).toBe(
      'The built-in relay isn’t working right now. Try again later, or set up your own relay.',
    );
  });

  it('presents the guide as optional, for using an own relay', () => {
    const store = freshStore({ ready: true, playlists: [], settings: { ...defaults } });
    const handle = track(dialogs.openProxyGuide({ store, actions: makeActions(store) }));
    expect(handle.el.querySelector('.md-title').textContent).toBe('Use your own relay');
    const why = handle.el.querySelector('.dlg-guide-why').textContent;
    expect(why).toContain('You probably don’t need this.');
    expect(why).toContain('already plays insecure (http://) and blocked channels through its built-in relay');
    expect(handle.el.querySelectorAll('[role="tab"]')).toHaveLength(2);
  });
});
