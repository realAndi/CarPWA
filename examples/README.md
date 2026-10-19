# CarPWA examples

Four complete apps to read, run and copy. Each one is a folder with a
`carpwa.json`, plain HTML/CSS and ES modules, and loads the SDK from the
paths carpwad serves on every app port:

```html
<link rel="stylesheet" href="/_carpwa/carpwa.css">
<script src="/_carpwa/sdk.js"></script>
<script type="module" src="app.js"></script>
```

| app | shows | permissions |
|---|---|---|
| [`hello-car/`](hello-car/) | car and screen info, live night mode / appearance / limited UI, banner, close, knob focus. About 80 lines of JS. | none |
| [`now-playing/`](now-playing/) | full-screen player: artwork, frame-accurate progress without polling, transport and ±15 s skips | `media`, `media.control` |
| [`dashboard/`](dashboard/) | multi-widget home screen for 800×480, 1280×720 and 1920×720: clock, weather over `net.fetch`, mini player, navigation, speed, car, inter-app channel, persisted settings | `media`, `media.control`, `navigation`, `location`, `network` |
| [`terminal/`](terminal/) | a CarPlay home screen as a terminal: every CarPWA and CarPlay app in one paged list (`apps.open`), now playing with controls, navigating apps, speed and heading; green by day, amber at night | `apps.launch`, `media`, `media.control`, `navigation`, `location` |

All four are dark-first with a working light appearance, keep touch
targets at least 52 px and text at least 15 px (Hello Car and Terminal go
down to 44/40 px targets and 13 px text on screens under 320 px tall, such
as 1920×720 at @3x), respect the
`--carpwa-safe-*` insets, don't scroll, can be driven entirely with a knob,
and handle every rejected SDK call with a short message instead of an
uncaught error.

## Running

```sh
carpwa validate examples/dashboard
carpwa sim examples/dashboard --open                 # 800×480 touch head unit
carpwa sim examples/dashboard --screen 1920x720 --input knob
```

## Icons

`tools/make-icons.mjs` draws the four `icon.png` files: 512×512, opaque, no
pre-rounded corners (CarPlay applies its own mask). It needs only Node and
`node:zlib`:

```sh
node examples/tools/make-icons.mjs            # all icons
node examples/tools/make-icons.mjs dashboard  # one
```
