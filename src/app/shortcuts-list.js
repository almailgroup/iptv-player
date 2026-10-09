// Canonical keyboard shortcut list — the handler (shortcuts.js) and the help dialog both use it.
// `keys` are KeyboardEvent.key values (case-insensitive for letters); `label` is what users see.

export const SHORTCUTS = Object.freeze([
  { id: 'togglePlay', keys: [' ', 'k'], label: ['Space', 'K'], description: 'Play / pause' },
  { id: 'toggleMute', keys: ['m'], label: ['M'], description: 'Mute / unmute' },
  { id: 'volumeUp', keys: ['ArrowUp'], label: ['↑'], description: 'Volume up' },
  { id: 'volumeDown', keys: ['ArrowDown'], label: ['↓'], description: 'Volume down' },
  { id: 'seekBack', keys: ['ArrowLeft'], label: ['←'], description: 'Rewind 10 s (seekable streams)' },
  { id: 'seekForward', keys: ['ArrowRight'], label: ['→'], description: 'Forward 10 s (seekable streams)' },
  { id: 'toggleFullscreen', keys: ['f'], label: ['F'], description: 'Toggle fullscreen' },
  { id: 'togglePip', keys: ['p'], label: ['P'], description: 'Picture-in-picture' },
  { id: 'nextChannel', keys: ['n', 'PageDown'], label: ['N', 'PgDn'], description: 'Next channel' },
  { id: 'prevChannel', keys: ['b', 'PageUp'], label: ['B', 'PgUp'], description: 'Previous channel' },
  { id: 'toggleFavorite', keys: ['s'], label: ['S'], description: 'Star / unstar current channel' },
  { id: 'retry', keys: ['r'], label: ['R'], description: 'Reload stream' },
  { id: 'toggleStats', keys: ['i'], label: ['I'], description: 'Show stream info' },
  { id: 'focusSearch', keys: ['/'], label: ['/'], description: 'Search channels' },
  { id: 'escape', keys: ['Escape'], label: ['Esc'], description: 'Clear search / close panels' },
  { id: 'showShortcuts', keys: ['?'], label: ['?'], description: 'Show keyboard shortcuts' },
]);
