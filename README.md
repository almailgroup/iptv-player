# IPTV Player

A fast, minimalist IPTV player that runs entirely in the browser: no server or backend.
Load an M3U/M3U8 playlist by URL or file, browse channels by group, search with fuzzy matching,
pin favorites, and watch live HLS streams with automatic error recovery. It's built as a static site
for **GitHub Pages**.

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

## Browser limitations

This is a pure front-end app, so the browser's security rules apply to every stream:

- **CORS:**
  - Playlists and HLS streams are downloaded with `fetch`/XHR, so the server must allow cross-origin
    requests.
  - If a playlist URL is blocked, download the file and upload it instead. You can also set an optional
    CORS proxy in **Settings**; it's used for playlist downloads only.
- **Mixed content:**
  - Browsers block insecure `http://` streams on secure `https://` pages, including GitHub Pages.
  - The player first tries the same stream over `https://`, and explains the problem if that fails.
  - For HTTP-only providers, run the player locally over http (`npm run dev`).
- **Unsupported formats:**
  - DRM-protected channels, MPEG-DASH (`.mpd`), and `rtmp://` / `rtsp://` / `udp://` streams can't be
    played in a browser.
  - Custom `User-Agent`/`Referer` headers from playlists can't be sent by browsers either.

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
tests/                   Vitest unit tests
.github/workflows/       GitHub Pages deployment
```

## Privacy & security

Everything stays in your browser. There's no analytics, no account, and no backend. Playlists and streams
are fetched directly from the URLs you provide.

- Playlist content is untrusted. It is only ever rendered as text, so a channel name or logo can't run
  script.
- Logos are limited to `http(s)` and `data:image` URLs.
- The production build ships a strict Content-Security-Policy: no inline scripts or styles, workers from the
  app's own origin only.
- To keep a hostile playlist from freezing the page or filling storage, the parser caps oversized names,
  URLs, logos and headers, and keeps at most 3,000 groups.
- Playlist downloads send no cookies.
- Stream and playlist requests send only the app's origin as the referrer.
