// Built-in demo playlist: public, CORS-enabled HTTPS test streams so the player can be tried without a
// playlist of your own. Loaded through `actions.addDemoPlaylist()` like any other playlist.

export const DEMO_PLAYLIST_NAME = 'Demo channels';

/** Demo entries — kept as data so the M3U below is always well-formed. */
const DEMO_CHANNELS = [
  {
    name: 'Akamai Live Test',
    tvgId: 'akamai.live.demo',
    group: 'Live',
    url: 'https://cph-p2p-msl.akamaized.net/hls/live/2000341/test/master.m3u8',
  },
  {
    name: 'Live Test 2',
    tvgId: 'akamai.eight.demo',
    group: 'Live',
    url: 'https://moctobpltc-i.akamaihd.net/hls/live/571329/eight/playlist.m3u8',
  },
  {
    name: 'Unified Streaming Live',
    tvgId: 'unified.live.demo',
    group: 'Live',
    url: 'https://demo.unified-streaming.com/k8s/live/stable/live.isml/.m3u8',
  },
  {
    name: 'Big Buck Bunny (Mux)',
    tvgId: 'mux.bbb.demo',
    group: 'On demand',
    url: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8',
  },
  {
    name: 'Apple BipBop fMP4',
    tvgId: 'apple.bipbop.demo',
    group: 'On demand',
    url: 'https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/master.m3u8',
  },
  {
    name: 'Tears of Steel',
    tvgId: 'unified.tos.demo',
    group: 'On demand',
    url: 'https://demo.unified-streaming.com/k8s/features/stable/video/tears-of-steel/tears-of-steel.ism/.m3u8',
  },
  {
    name: 'Sintel',
    tvgId: 'bitmovin.sintel.demo',
    group: 'On demand',
    url: 'https://bitdash-a.akamaihd.net/content/sintel/hls/playlist.m3u8',
  },
  {
    name: 'Art of Motion',
    tvgId: 'bitmovin.artofmotion.demo',
    group: 'On demand',
    url: 'https://bitdash-a.akamaihd.net/content/MI201109210084_1/m3u8s/f08e80da-bf1d-4e3d-8899-f0f6155f6efa.m3u8',
  },
  {
    name: 'Elephants Dream (MP4)',
    tvgId: 'google.elephantsdream.demo',
    group: 'On demand',
    url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4',
  },
];

/**
 * The demo playlist as extended M3U text (`#EXTINF` with tvg-id, tvg-chno and group-title).
 * @type {string}
 */
export const DEMO_M3U = [
  '#EXTM3U',
  `#PLAYLIST:${DEMO_PLAYLIST_NAME}`,
  ...DEMO_CHANNELS.flatMap((ch, i) => [
    `#EXTINF:-1 tvg-id="${ch.tvgId}" tvg-name="${ch.name}" tvg-chno="${i + 1}" group-title="${ch.group}",${ch.name}`,
    ch.url,
  ]),
  '',
].join('\n');
