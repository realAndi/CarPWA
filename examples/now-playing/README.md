# Now Playing

A full-screen player for whatever the phone is playing: large artwork over a
blurred copy of itself, title, artist and album, a live progress bar,
previous / play-pause / next, ±15 s skips, and the app the audio comes from.

![icon](icon.png)

| | |
|---|---|
| id | `com.carpwa.example.nowplaying` |
| permissions | `media` (read what is playing), `media.control` (the buttons) |
| files | `carpwa.json`, `index.html`, `style.css`, `app.js`, `icon.png` |

## Patterns worth copying

- **A progress bar that never polls.** `NowPlaying` gives `elapsed` as of
  `elapsedAt` (ms since epoch) together with the playback `rate`. `position()`
  extrapolates from those three values on every `requestAnimationFrame`, and
  the loop only runs while something is playing. The time labels change only
  when the whole second changes.
- **Artwork only when it changes.** `media.getArtwork(size)` is called when
  `artworkId` differs from the one on screen, sized to the element times
  `devicePixelRatio`. A token check drops a stale response if the track
  changed while the image loaded, and `img.decode()` runs first so the swap
  doesn't flash.
- **Optimistic controls.** Play/pause and the skips update the screen at once
  (`rebase()` re-samples the position "now"), then the phone's `nowPlaying` /
  `playbackState` events confirm the change. If the call fails, the old state
  comes back and a short toast says why.
- **`playbackState` has no position.** The handler freezes or restarts the
  local clock, then fetches `getNowPlaying()` once for the authoritative value.
- **Empty and error states.** *Nothing playing* offers a Play button.
  `ENOTCAR` and `EPERM` explain themselves and hide buttons that can't help.
  `EUNAVAILABLE` and `ETIMEOUT` offer *Try again*.
- **Background and foreground.** `ui.on('background')` stops the animation
  loop. `ui.on('foreground')` refetches, because events may have been missed
  while another CarPlay app was on screen.
- **Knob.** `focus.enable()` covers the five transport buttons in on-screen
  order. When the screen switches between player and empty state, or a skip
  button gets disabled (live radio has no duration), `keepFocus()` moves focus
  to something visible.

## APIs used

`media.getNowPlaying()`, `media.getArtwork()`, `media.togglePlayPause()`,
`media.play()`, `media.previous()`, `media.next()`, `media.skip()`,
`media.on('nowPlaying' | 'playbackState')`, `ui.on('foreground' | 'background')`,
`screen.info`, `focus.enable()`, `focus.set()`, `focus.current`.

## Run it

```sh
carpwa sim examples/now-playing --open
carpwa sim examples/now-playing --input knob --screen 1280x720
```

The simulator has a mock player: press play in its media panel, or in the app.
