# IPTV Player

A fast, minimalist IPTV player that runs entirely in the browser.
Load an M3U/M3U8 playlist by URL or file, browse channels by group, search with fuzzy matching,
pin favorites, and watch live HLS streams with automatic error recovery. It's built as a static site
for **GitHub Pages**, with a small stream relay for the channels that browsers block.

## Features

- **Playlists:** load `.m3u` / `.m3u8` files by URL, file picker, or drag-and-drop. You can keep several
  playlists, then switch, refresh, rename, download, or delete them.
- **Robust parser:** reads `#EXTINF` attributes (`tvg-id`, `tvg-name`, `tvg-logo`, `group-title`
  including `;` multi-groups, `tvg-chno`), plus `#EXTGRP`, `#EXTVLCOPT`, `#KODIPROP`, Kodi `|header`
  syntax, relative URLs, BOM/CRLF input, and duplicate entries.
- **Browse & search:** a category sidebar (All / Favorites / Recently watched / playlist groups), real-time
  fuzzy search that ignores accents and tolerates typos, and a virtualized list that stays smooth with
  20k+ channels.
- **Favorites:** star any channel to pin it, export your favorites as an `.m3u` file.
- **Player:**
  - Engines: [hls.js](https://github.com/video-dev/hls.js) for HLS, native HLS on Safari/iOS,
    [mpegts.js](https://github.com/xqq/mpegts.js) for raw MPEG-TS/FLV streams, and HTML5 video for MP4/WebM.
  - Controls: custom auto-hiding controls, fullscreen, picture-in-picture, volume, quality and audio-track
    selection, and a live-edge button or seek bar.
  - Extras: stream stats and Media Session (OS media keys).
- **Resilience:**
  - Auto-reconnect with exponential backoff and a stall watchdog.
  - Recovery from media errors and offline/online changes.
  - Plain-language error messages for CORS, HTTP status, insecure HTTP streams, unsupported formats and DRM.
- **Built-in relay:** insecure `http://` and CORS-blocked channels play through the site's stream relay,
  with nothing to set up. You can switch it off or use your own relay instead.
- **Playability labels:** channels that can't play here (unsupported formats, DRM, insecure streams without
  a relay, or channels that just failed) are flagged in the list, and the sort menu can hide them.
- **Design:** rounded glass panels over a soft colour field, with a floating pill control bar, a now-playing
  card and an Up next / Recently watched / Favorites shelf under the player. The background can pick up the
  colours of the playing video (**Settings → Ambient colour from video**).
- **Themes:** dark by default, with a light mode and 7 accent palettes: Deep Azure, Emerald Green,
  Neon Cyberpunk, Warm Amber, Monochrome Slate, Crimson Rose and Royal Violet.
- **Persistence:** playlists (gzip-compressed), favorites, recent channels, theme, settings, volume and the
  last channel are saved to `localStorage`.
- **Keyboard first:** press `?` in the app for the full list.

  | Key | Action |
  | --- | --- |
  | `Space` / `K` | Play or pause |
  | `F` | Fullscreen |
  | `M` | Mute |
  | `P` | Picture-in-picture |
  | `/` | Search |
  | `N` / `B` | Next / previous channel |
  | `S` | Star the current channel |

- **Shareable links:**
  - `?playlist=<url>` opens a playlist you already have; an unknown playlist is added only after you confirm
    the prompt.
  - `?play=<stream-url>&name=<title>` plays a single stream.
  - Both are ignored when the app is embedded in another site's frame.

## Quick start

```bash
npm install
npm run dev       # http://localhost:5173
npm test          # unit tests (Vitest)
npm run build     # production build in dist/
npm run preview   # serve the production build locally
```

Requires Node.js 20.19+ (CI uses Node 24).

## Deploying to GitHub Pages

The workflow at `.github/workflows/deploy.yml` tests, builds and deploys the site on every push to `main`.
It can also be started by hand from the **Actions** tab.

You only need to set this up once: in the repository, open **Settings → Pages** and set
**Build and deployment → Source** to **GitHub Actions**.

The site will then be published at `https://<owner>.github.io/<repo>/`. The build uses relative asset
paths (`base: './'`), so it works under any sub-path or custom domain without changes.

The built-in stream relay is deployed separately, once, on Deno Deploy straight from this repository; see
[Play HTTP / blocked streams](#play-http--blocked-streams-built-in-relay).

## Browser limitations

This is a pure front-end app, so the browser's security rules apply to every stream. The site's built-in
relay gets around CORS and mixed content; see
[Play HTTP / blocked streams](#play-http--blocked-streams-built-in-relay).

- **CORS:**
  - Playlists and HLS streams are downloaded with `fetch`/XHR, so the server must allow cross-origin
    requests.
  - Blocked playlist downloads and streams are retried through the relay. Without one, download the
    playlist file and upload it instead.
- **Mixed content:**
  - Browsers block insecure `http://` streams on secure `https://` pages, including GitHub Pages. No
    setting inside the page can change this.
  - The player plays such streams through the relay. Without a relay, it first tries the same stream over
    `https://`, then explains the problem and offers to set up a relay of your own.
  - Running the player locally over http (`npm run dev`) also works for HTTP-only providers.
- **Unsupported formats:**
  - DRM-protected channels, MPEG-DASH (`.mpd`), and `rtmp://` / `rtsp://` / `udp://` streams can't be
    played in a browser, with or without a relay. They are labeled in the channel list.
  - Custom `User-Agent`/`Referer` headers from playlists can't be sent by browsers either.

## Play HTTP / blocked streams (built-in relay)

Many IPTV channels are plain `http://` streams, often on raw IP addresses and custom ports
(`http://1.2.3.4:8080/live/index.m3u8`). Many `https://` servers don't send CORS headers either. A secure
page can't play either kind. The only way around this is a relay: it fetches the stream on a server and
passes it on over HTTPS with CORS headers.

**This site ships with a relay, so `http://` and blocked channels play by default.** Visitors don't set
anything up: channels that the browser blocks play through the relay automatically, and blocked playlist
downloads are retried through it too. Channels that play directly never touch it.

- **Privacy:** when a channel plays through the relay, your viewing of it passes through the relay's host,
  which sees the stream's address and your IP address and keeps the usual request logs. The relay itself
  stores nothing. To avoid it, switch off **Use the built-in relay** in **Settings → Network**, or use your
  own relay there.
- **Limits:** the relay runs on a free tier with usage quotas. When they run out, blocked channels stop
  playing until the quota resets. Streams that are offline, region-locked or refuse relays won't play
  either. Channels that recently failed are labeled in the list.

### Deploying the built-in relay (site owner, once)

The relay is `proxy/stream-proxy.js`, a single dependency-free file. `proxy/deno.js` and the repository's
`deno.json` let Deno Deploy run it straight from this repository:

1. Sign in at [console.deno.com](https://console.deno.com) with GitHub (free).
2. Create a new app from the `iptv-player` repository. There's no build step: `deno.json` sets the
   entrypoint `proxy/deno.js`. If the dashboard asks anyway, choose no framework preset and no build
   step, with the entrypoint `proxy/deno.js`.
3. Deploy, then copy the app's `https://` URL. `<url>/?health` should answer `{"ok":true,…}`.
4. Build the URL into the site: set `DEFAULT_BUILTIN_RELAY` in `src/app/constants.js`, or add the
   repository variable `BUILTIN_RELAY` (**Settings → Secrets and variables → Actions → Variables**), which
   wins over it. Then redeploy the site.

The relay only serves the sites in the `ALLOWED_ORIGINS` line of `proxy/stream-proxy.js`, which already
lists `https://almailgroup.github.io`. Cloudflare Workers can't reach streams on IP addresses or custom
ports, which is why the built-in relay runs on Deno Deploy.

**Forks** inherit this site's relay address, but that relay doesn't serve other sites. Deploy your own
relay from your fork, add your site's origin to `ALLOWED_ORIGINS`, and point your site at it with
`BUILTIN_RELAY` or `DEFAULT_BUILTIN_RELAY`. Or set `BUILTIN_RELAY` to `off` to build without a built-in
relay.

### Your own relay (optional)

Anyone can use a relay of their own instead, for example to keep their viewing off the site's relay. In
**Settings → Network**, follow the relay setup guide: **Copy relay code** gives you the relay already set
up for your site. Deploy it on Deno Deploy or Cloudflare Workers, or run `node proxy/node-server.mjs` on a
server or your own computer, then paste its address into the app.

For deployment options, settings and security notes, see [proxy/README.md](proxy/README.md).

## Project structure

```text
index.html               App shell (Vite entry)
public/                  Static files copied as-is (favicon, manifest, pre-paint theme script)
src/main.js              Bootstraps the store, controller and UI
src/app/                 State store, selectors, controller (actions), shortcuts, demo playlist
src/lib/                 M3U parser, fuzzy search, storage, playlist loader, DOM/utility helpers
src/player/              Playback engine (hls.js / native / mpegts.js), stream type detection
src/ui/                  Player view, sidebar, channel list, virtual list, dialogs, theme, popovers, toasts
src/styles/              Design tokens + themes and component styles
src/assets/fonts/        Self-hosted Figtree variable font (SIL Open Font License)
proxy/                   Stream relay for http:// and CORS-blocked streams (Deno Deploy, Workers, Node)
deno.json                Deno Deploy config: runs the relay (proxy/deno.js), no build step
tests/                   Vitest unit tests
.github/workflows/       GitHub Pages deployment
```

## Privacy & security

Everything stays in your browser. There's no analytics and no account. Playlists and streams are fetched
directly from the URLs you provide, except those the browser blocks: they go through the stream relay
(see [Play HTTP / blocked streams](#play-http--blocked-streams-built-in-relay)), which you can switch off.

- Playlist content is untrusted. It is only ever rendered as text, so a channel name or logo can't run
  script.
- Logos are limited to `http(s)` and `data:image` URLs.
- The production build ships a strict Content-Security-Policy: no inline scripts or styles, workers from the
  app's own origin only.
- To keep a hostile playlist from freezing the page or filling storage, the parser caps oversized names,
  URLs, logos and headers, and keeps at most 3,000 groups.
- Playlist downloads send no cookies.
- Stream and playlist requests send only the app's origin as the referrer.
