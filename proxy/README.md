# IPTV stream relay

Browsers won't play insecure `http://` streams on a secure `https://` page such as GitHub Pages (mixed content),
and they block `https://` streams whose servers send no CORS headers. Nothing inside the page can get around
this. The relay in this folder can: it fetches the stream on a server and passes it on over HTTPS with CORS
headers.

**This site ships with a relay, so `http://` and blocked channels play by default.** The site owner deploys it
once on Deno Deploy and its address is built into the site; visitors don't set anything up. In **Settings →
Network** anyone can switch the built-in relay off or use a relay of their own instead.

- `stream-proxy.js` is the relay: one dependency-free file that runs unmodified on Deno, Cloudflare Workers
  and Bun.
- `deno.js` is the entry point for Deno Deploy. The repository's `deno.json` points Deno Deploy at it.
- `node-server.mjs` runs the same relay on Node.js.
- Video is streamed straight through and never stored. HLS playlists are rewritten so their variants,
  segments and keys also go through the relay.

## 1. The built-in relay (site owner, once)

### Deploy it on Deno Deploy

Deno Deploy's free tier has no documented limits on which addresses it can fetch, so streams on raw IP
addresses and custom ports work too. The relay deploys straight from this repository, with no build step.

1. Sign in at [console.deno.com](https://console.deno.com) with your GitHub account (free).
2. Create a new app from the `iptv-player` repository. Let Deno Deploy access the repository if it asks.
3. Keep the app configuration as it is: `deno.json` already tells Deno Deploy to run `proxy/deno.js`. If the
   dashboard asks for settings anyway, choose **no build step / no framework preset**, leave the install
   and build commands empty, and set a dynamic runtime with the entrypoint `proxy/deno.js`.
4. Deploy, and wait until the build has finished.
5. Copy the app's `https://` URL. Opening `<url>/?health` should show
   `{"ok":true,"service":"iptv-stream-relay","version":1}`.

Deno Deploy builds every new commit, so the relay stays in step with the site.

### Build its address into the site

Use either one:

- **`DEFAULT_BUILTIN_RELAY`** in `src/app/constants.js`: set it to the app's URL and commit. Every build
  includes it, including local ones.
- **The repository variable `BUILTIN_RELAY`**: in the repository, open **Settings → Secrets and variables →
  Actions → Variables** and add `BUILTIN_RELAY` with the app's URL. The deploy workflow passes it to the
  build, and it wins over `DEFAULT_BUILTIN_RELAY`. The value `off` builds the site without a built-in relay.

Then deploy the site again: push to `main`, or run the deploy workflow from the **Actions** tab.

### Allowed sites

The relay only serves the pages listed in the `ALLOWED_ORIGINS` line of `stream-proxy.js`. It already lists
`https://almailgroup.github.io` and the local dev servers. If the site moves, for example to a custom domain,
add the new origin to that line (keep it on one line) and push.

### Forks

A fork inherits this site's built-in relay address, but that relay only serves `almailgroup.github.io`. In a
fork, either:

- run your own: deploy the relay from your fork as above, put your site's origin (such as
  `https://you.github.io`) in the `ALLOWED_ORIGINS` line of `stream-proxy.js`, and point your site at it with
  `BUILTIN_RELAY` or `DEFAULT_BUILTIN_RELAY`, or
- set the repository variable `BUILTIN_RELAY` to `off` to build without a built-in relay.

### Privacy and limits

- **Viewing passes through the relay.** When a channel plays through it, the relay's host sees which stream
  addresses are requested and from which IP address, like any web host. The relay itself logs and stores
  nothing, but the hosting platform keeps its usual request logs. The app says so next to the switch in
  **Settings → Network** that turns the built-in relay off.
- **Free-tier quotas.** Every byte of relayed video counts against the hosting platform's free-tier limits
  (requests, traffic, CPU time). When they run out, channels that need the relay stop playing until the
  quota resets. Channels that play directly are not affected.
- **Not every stream works.** Some servers are offline, region-locked, or refuse requests from data
  centers. No relay can fix that.
- **Cloudflare Workers can't reach streams on IP addresses or custom ports** (such as
  `http://1.2.3.4:8080/…`), and many IPTV streams use them. That's why the built-in relay runs on Deno Deploy.

## 2. Your own relay (optional)

Anyone can use a relay of their own instead of the built-in one, for example to keep their viewing off the
site's relay or when its quota is used up. It's free and takes about 5 minutes. In the app, open **Settings
→ Network** and follow the relay setup guide: it gives you the relay code already set up for your site.

### Deno Deploy (recommended)

1. In the app's setup guide, pick **Deno Deploy** and click **Copy relay code**.
2. Sign in at [console.deno.com](https://console.deno.com) (free) and create a new playground or app.
3. Paste the code, replacing everything that's there, and deploy.
4. Copy the app's `https://` URL and paste it into the app.

Doing it by hand instead? Copy `stream-proxy.js`, put your site's origin in the `ALLOWED_ORIGINS` line, and
replace the last two lines (from `// ---- entry point` to the end) with the end of `deno.js`, which also looks
up host names so that names of private addresses are refused (see [Security](#security-and-fair-use)):

```js
async function resolveHost(hostname) {
  const lookup = async (type) => {
    try {
      return await Deno.resolveDns(hostname, type);
    } catch {
      return null; // e.g. no AAAA records
    }
  };
  const [v4, v6] = await Promise.all([lookup('A'), lookup('AAAA')]);
  if (!v4 && !v6) throw new Error(`Couldn't resolve ${hostname}`);
  return [...(v4 || []), ...(v6 || [])];
}

Deno.serve((request) => handleRequest(request, { resolveHost }));
```

To run it locally with Deno, no changes are needed: `deno run --allow-net proxy/deno.js`, or
`deno serve --allow-net proxy/stream-proxy.js` (which doesn't look up host names).

### Cloudflare Workers

> **Limitation:** Workers can't reach streams on IP addresses or custom ports (such as
> `http://1.2.3.4:8080/…`), and many IPTV streams use them. Use Deno Deploy or Node.js for those.

1. In the app's setup guide, pick **Cloudflare Workers** and click **Copy relay code**.
2. In the [Cloudflare dashboard](https://dash.cloudflare.com), open **Workers & Pages → Create → Worker**
   and click **Deploy**.
3. Click **Edit code**, paste the code (replacing everything) and click **Deploy**.
4. Copy the worker's URL (`https://….workers.dev`) and paste it into the app.

### Node.js (VPS, home server, Render, Railway, Fly.io …)

Node.js 18 or newer is all you need. There are no dependencies, so skip `npm install`. Run it from a copy of
this repository; its `package.json` marks the files as ES modules.

```bash
git clone https://github.com/almailgroup/iptv-player.git
cd iptv-player
ALLOWED_ORIGINS=https://you.github.io node proxy/node-server.mjs --host 0.0.0.0
```

| Flag / variable                      | Default              | Meaning                                                                     |
| ------------------------------------ | -------------------- | --------------------------------------------------------------------------- |
| `--port`, `PORT`                     | `8787`               | Port to listen on (hosting platforms set `PORT` for you).                   |
| `--host`, `HOST`                     | `127.0.0.1`          | Address to listen on. Use `0.0.0.0` on a server or in a container.          |
| `ALLOWED_ORIGINS`                    | the list in the file | Comma-separated sites that may use the relay, e.g. `https://you.github.io`. |
| `--public-url`, `PUBLIC_URL`         | (from `Host`)        | The relay's public `https://` origin, if it runs behind a reverse proxy.    |
| `--allow-private`, `ALLOW_PRIVATE=1` | off                  | Also relay streams on localhost and private networks. See below.            |

Browsers need **HTTPS** to talk to the relay from a secure page, so put it behind something that provides it:

- Hosting platforms (Render, Railway, Fly.io …) do this for you. Use the start command
  `node proxy/node-server.mjs --host 0.0.0.0`.
- On your own server, use a reverse proxy such as Caddy: `relay.example.com { reverse_proxy 127.0.0.1:8787 }`.
  Make sure the proxy passes on the original `Host` header and `X-Forwarded-Proto`, or set `PUBLIC_URL`.
  Rewritten playlists point at that address.

Prefer Bun? `PORT=8787 bun proxy/stream-proxy.js` runs the relay file directly.

### Your own computer

```bash
node proxy/node-server.mjs
```

Then enter `http://localhost:8787` as your relay in the app. Browsers allow `http://localhost` even from
`https://` pages, though Chrome may ask whether the site may access devices on your local network: allow it.
This only works on that computer, while the relay is running.

Like every relay, it refuses streams on your home network (a NAS, a TV tuner) unless you start it with
`--allow-private` (or `ALLOW_PRIVATE=1`). Use that **only for testing or on a trusted home network**: anyone
who can use the relay can then reach the devices on your network through it.

## How to talk to it

| Request                                          | Answer                                                       |
| ------------------------------------------------ | ------------------------------------------------------------ |
| `GET /?url=<encodeURIComponent(target)>`         | The target, relayed (the canonical form the app uses).       |
| `GET /<target>`, e.g. `/http://host:8080/x.m3u8` | The same, cors-anywhere style.                               |
| `GET /` or `GET /?health`                        | `{"ok":true,"service":"iptv-stream-relay","version":1}`      |
| `OPTIONS …`                                      | A CORS preflight for allowed sites. `HEAD` works like `GET`. |

The relay follows up to 5 redirects itself and checks every address before it requests it. A response whose
first bytes are `#EXTM3U` is read as a playlist, whatever its content type, and HLS playlists are rewritten;
media is streamed through untouched. `Range` is not passed on for `.m3u8` / `.m3u` addresses, so playlists
always come whole; a `206` that holds the whole body (`bytes 0-(n-1)/n`) is rewritten and answered as a
`200`, and other `206` answers are passed on as they are. Each relayed response carries `X-Relay-Final-Url`:
the stream's address after redirects.

Errors are short plain-text answers:

- `400` for a missing or invalid target, or a user name and password in it, and "Refusing to relay to itself"
  for a target on the relay's own address.
- `403` for "Origin not allowed" or "Target not allowed" (a private address or a host name that resolves to
  one, also as a redirect target).
- `405` for methods other than GET, HEAD and OPTIONS, and `414` for a target over 8,192 characters.
- `415` "Not a media stream" when the target isn't a playlist or media: a `2xx` answer with a text, data or
  document type (`text/*` other than `text/vtt` subtitles, JSON, XML, JavaScript, SVG …) or no content type at
  all is relayed only when it starts with `#EXTM3U`. A `HEAD`, which has no body to check, is refused unless
  the address ends in `.m3u8` or `.m3u`.
- `502` for "Upstream unreachable" (also a host name that doesn't resolve) or "Invalid redirect from
  upstream", and `508` for "Too many redirects".

Quick check from a terminal:

```bash
curl -i -H 'Origin: https://you.github.io' \
  'https://my-relay.deno.dev/?url=https%3A%2F%2Ftest-streams.mux.dev%2Fx36xhzz%2Fx36xhzz.m3u8'
```

## Security and fair use

- **Only your site.** The relay only serves pages from `ALLOWED_ORIGINS`, using the `Origin` header or, for
  `<video>` requests, the `Referer`. This stops other websites from using your relay, but any program can fake
  these headers, so don't advertise the address. `'*'` lets every website use it and is not recommended.
- **It's your bandwidth.** Every byte of video goes through your relay and counts against its free-tier
  limits (requests, traffic, CPU time).
- **No access to private networks.** The relay refuses `localhost` and private, link-local, unique-local and
  other non-public addresses (documentation and reserved ranges, IPv4 inside IPv6, NAT64), including cloud
  metadata endpoints, as targets and as redirect destinations. It follows redirects itself and checks each
  one before requesting it. Where the relay runs never matters: it doesn't trust its own address, the `Host`
  header or `X-Forwarded-For`, which a client can fake. Only `--allow-private` lifts this.
- **Host names are looked up too.** On Deno (`deno.js`) and Node.js (`node-server.mjs`) the relay resolves
  every host name before requesting it and refuses it if any of its addresses is private, so names such as
  `127.0.0.1.nip.io` that point at a private address don't get through either. A name that doesn't resolve
  is answered with `502`. One gap remains: `fetch()` resolves the name again on its own, so a DNS server that
  answers with a public address for the check and a private one a moment later (DNS rebinding) can still get
  a request through. If the relay runs inside a network with unprotected internal services, also limit its
  outgoing traffic with a firewall. On Cloudflare Workers the relay can't look names up (Workers have no
  built-in DNS lookup) and checks addresses only as written; Workers send their requests from Cloudflare's
  network, not from a private network of yours. Run on its own (`deno serve`, Bun), `stream-proxy.js`
  doesn't look names up either.
- **Not a web proxy.** A `2xx` answer is relayed only if it is a playlist or media: web pages, text, JSON,
  XML, scripts, SVG and answers without a content type are refused unless they start with `#EXTM3U` or with
  the bytes of a media format (MPEG-TS, MP4, WebM, FLV, AAC/MP3), so mislabeled segments (Apache serves `.ts`
  files as `text/vnd.trolltech.linguist`) still play; those are passed on with the format's type. This also
  keeps the relay from passing on what an internal service or a third-party API answers. Relayed
  responses are sandboxed and marked `nosniff`, so they can't run as pages on the relay's address or be read
  as another type.
- **No loops.** A target on the relay's own address (host and port) is refused, so a relay that allows every
  website (`'*'`) can't be made to call itself over and over. It only recognizes the address it was called
  by, not other names or IP addresses of the same relay, which is one more reason to keep `'*'` off.
- **Nothing personal is passed on.** Requests to stream servers never include your cookies, `Authorization`,
  `Origin` or `Referer`. Only `Range`, `Accept`, `Accept-Language`, `User-Agent` and cache validators are
  forwarded. Cookies and other server headers never come back. The relay itself logs and stores nothing; your
  hosting platform may keep its usual request logs.
- **Only relay streams you're allowed to watch.**
- **Updating:** the health check reports the relay's version. A relay deployed from the repository updates
  itself with every push; for a copied one, copy the code again and redeploy.
