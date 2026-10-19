# The desktop simulator

`carpwa sim` runs your app in a browser tab that behaves like a CarPlay head
unit, so most of the work happens on your desk instead of in the car. It needs
no phone and no jailbreak.

```sh
carpwa sim my-app --open                      # 800×480, touch
carpwa sim my-app --preset ultrawide --input knob
```

Open `http://127.0.0.1:5173/__carpwa_sim/` (the CLI prints the address). The
app itself is also served at `/`, as a plain page in browser mode.

## What you see

- **The head unit.** A CarPlay-style status bar (time, signal, recent apps and
  a Home button) next to your app, which runs in an iframe of exactly the
  preset's size in CSS px: `standard` 800×480, `wide` 1280×720, `ultrawide`
  1920×720, `square` 1024×768. The whole unit scales to fit the window; the
  zoom menu shows it at 50–200 % instead.
- **Home.** The Home button (or `H`, or `ui.close()`) sends `ui.background`
  and shows a CarPlay home grid with your icon. Tapping the icon sends
  `ui.foreground` and brings the app back. Maps and Music in the dock open
  stand-in screens, as `apps.open` does for stock apps.
- **Hardware controls** under the screen: a knob (scroll to rotate, click to
  select) with nudge arrows, a touchpad when the interaction model is
  touchpad, Back and Home keys, and steering-wheel media keys.
- **The inspector** on the right, described below.

The toolbar shows the app, whether `carpwa.json` is valid, status chips (night,
limited UI, knob, playing, navigating…), the preset, zoom, Reload, "open the
app alone in a tab" and the inspector toggle.

## The inspector

| tab | what you can do |
|---|---|
| Car | connect/disconnect the phone; enforce permissions on or off; right-hand drive; appearance (light, dark, or auto from night mode); night mode; limited UI with separate keyboard and lists limits; preset, interaction model and safe-area insets (with an overlay); a knob pad (rotate ↺/↻ = `previous`/`next`, nudge ↑↓←→, select down/up, Back); car name, model, manufacturer and fuel types; raw `car.raw` events |
| Media | a now-playing player whose play/pause really changes state and advances `elapsed`; next/previous, seek, stop, source app; an editor for title, artist, album and duration; a small library |
| Location | navigating on/off and the list of navigation apps; a place or exact lat/lon; "simulate drive" moves the point every second at the chosen speed and course; location services off (sends `location.error`) |
| Storage | the app's storage, editable; edits reach open pages as `storage.changed` |
| Console | every car-bridge and server-bridge call with params, result or error and time, every event sent to the page, and the page's console output; filters for calls, events, console and errors |
| Channels | watch every `channel.publish`, join channels (they then count as receivers), publish as `dev` or `native` |
| App | the manifest, validation problems, the permission matrix, and the page's live subscriptions |

Keyboard: `[` and `]` rotate, arrows nudge, Enter selects (down on press, up
on release), Esc is Back, `H` Home, `R` reloads the app, `I` toggles the
inspector. Inside the app frame these keys only act as car input in knob and
touchpad mode, so a touch app keeps normal keyboard behaviour.

Settings stick per browser tab; new `--preset`/`--input` flags win.

## What it emulates

The SDK finds the simulator through `window.parent.__CARPWA_SIM__`, reports
`CarPWA.env.mode === 'simulator'` with `devMode` on, and uses both transports
exactly as on the phone.

**Car bridge** (answered by the simulator page): every method and event of
`car`, `screen`, `media`, `nav`, `location`, `input`, `ui`, `apps` and
`system` in `carpwa.d.ts`, plus `$subscribe`/`$unsubscribe` and
`$registry.modules`.

- Data has the shapes in `carpwa.d.ts`. `screen.width`/`height` are the
  preset; `car.viewArea` is the app's rectangle next to the status bar.
- Only events the page subscribed to are delivered. `car.state` carries
  `{ state, changed }`, followed by the narrow `nightMode`, `appearance`,
  `limitedUI` and `viewArea` events. `screen.change` follows a preset,
  interaction-model or safe-area change.
- Permissions are enforced as in the [manifest guide](manifest.md): a missing
  one fails with `EPERM` and a message naming it, subscribing to a protected
  event too, and `serialNumber` only appears with `vehicle.identity`. Switch
  enforcement off in the Car or App tab to experiment.
- `ui.alert` draws a CarPlay-style alert and resolves with the chosen action's
  id (Back picks the `cancel` action); `ui.banner` slides in at the top;
  `ui.setBackgroundColor` paints behind the page.
- `input.setCaptureMode('app')` turns the knob, touchpad and keys into
  `move`/`select` events; in `native` mode the simulator moves DOM focus, as
  WebKit would. `interceptBack(true)` turns Back into `input.back`.
- With the phone "disconnected", `car.disconnect` fires and calls other than
  `car.getInfo`/`getState`, `screen.getInfo`, `system.*` and `apps.list` fail
  with `EUNAVAILABLE`.
- `media.getArtwork` returns a generated JPEG `data:` URL.
- `apps.open` with your own id brings the app back; stock CarPlay ids open a
  stand-in screen; any other id is logged and resolves `true`.

**Server bridge** (answered by the CLI on `/_carpwa/ws`):

- `storage` persists to `~/.carpwa/sim/<app id>/storage.json` (5 MiB cap) and
  sends `storage.changed` to the app's other connections.
- `channel` join/leave/publish/message, `from` is the app id.
- `net.fetch` makes the real request from Node, only to hosts in
  `network.allow` (`*.domain` included), re-checking every redirect, with the
  `network` permission; textual responses come back as text, the rest base64.
- `app.info`, `app.list`.
- `dev.log` prints in the terminal with the app id, coloured by level.
  Output from the moment the SDK loads is kept until the bridge connects.

**Live reload.** The CLI watches the app folder; on any change it sends
`dev.reload` to every page connection and the SDK reloads the page (a page
without the SDK is reloaded by the simulator). Changes to `carpwa.json` are
re-validated: errors show on the screen while the last valid manifest keeps
serving, and permissions update without restarting.

## Limits

The simulator is a browser, not CarPlay. Before shipping, check on a real car:

| on the desk | in the car |
|---|---|
| Your desktop browser's engine, fonts and performance. | WebKit in the CarPWA launcher on the phone, at the phone's speed, with iOS fonts. |
| Clicks are mouse events. | Touch screens deliver touch events (and some cars only low-fidelity touch). |
| Knob, touchpad and limited-UI behaviour follow what the inspector says. | Each car decides when it limits UI, how its knob maps to directions, and its real safe area and scale. |
| Presets are four common sizes at scale 1. | Displays come in many sizes and scales, sometimes several (instrument cluster). |
| Media, navigation and location are mock data. | Real now-playing info from the phone, real Maps state, GPS fixes as often as iOS sends them. |
| `net.fetch` runs from your Mac's network. | It runs on the phone, possibly on cellular. |
| One app, served by the CLI. | Several apps, each on its own port, with real `app.list`, session keys and ports. |
| Alerts and banners are drawn by the simulator. | They are drawn by CarPlay and look and time out like CarPlay's. |
| `car.raw` commands are logged, not sent. | They reach the head unit; some cars react badly. |

Native plugins are not loaded: calls to a plugin module answer `ENOTFOUND`, as
they would on a phone without that plugin. The SDK's 15-second call timeout
applies, so an alert left open longer rejects with `ETIMEOUT`, as it would on
the phone.
