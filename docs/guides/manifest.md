# The app manifest: `carpwa.json`

Every CarPWA app is a folder with a `carpwa.json` at its root. Everything else
in the folder is served as-is by the app's own local web server.

```
my-app/
├── carpwa.json
├── icon.png
├── index.html
└── …anything else (js, css, images, fonts, wasm)
```

## Example

```json
{
  "id": "com.example.dashboard",
  "name": "Dashboard",
  "short_name": "Dash",
  "version": "1.2.0",
  "start_url": "index.html",
  "icon": "icon.png",
  "background_color": "#000000",
  "spa": true,
  "permissions": ["media", "media.control", "network"],
  "network": { "allow": ["api.open-meteo.com", "*.example.com"] }
}
```

## Fields

| field | required | default | notes |
|---|---|---|---|
| `id` | **yes** | – | Reverse-DNS, letters, digits, `.` and `-` only, at most 128 characters. It names the folder on the phone, the storage bucket and the stable port. Never change it after shipping. |
| `name` | **yes** | – | Shown in alerts, `carpwa` output and the CarPlay icon label when `short_name` is missing. |
| `short_name` | no | `name` | The CarPlay icon label. Keep it under ~12 characters; CarPlay truncates. |
| `version` | no | `"0.0.0"` | Free-form, shown in `carpwa list` and `app.info()`. |
| `start_url` | no | `"index.html"` | Path relative to the app folder. May include a query string. |
| `icon` | no | `"icon.png"` | Square PNG, at least 180×180. CarPlay masks it to its own shape, so do not pre-round the corners. |
| `background_color` | no | `"#000000"` | Painted behind the web view while the page loads. Match your page background to avoid a flash. |
| `spa` | no | `false` | When `true`, any path that is not a file serves `start_url` (client-side routing). |
| `permissions` | no | `[]` | See below. |
| `network.allow` | no | `[]` | Hosts `CarPWA.net.fetch` may reach. `example.com` matches only itself; `*.example.com` matches subdomains (not the bare domain). Requires the `network` permission. |
| `min_carpwa` | no | – | Lowest CarPWA version your app supports, e.g. `"1.0"`. Older installs refuse to list the app. |

Unknown fields are ignored, so you can keep a standard web `manifest.json` next
to it for when the same site is opened in Safari.

## Permissions

Most of the API needs no permission. These do, and the call fails with
`EPERM` without them:

| permission | unlocks |
|---|---|
| `media` | `media.getNowPlaying`, `media.getArtwork`, `media` events |
| `media.control` | `media.play/pause/togglePlayPause/stop/next/previous/seek/skip` |
| `navigation` | `nav.getState`, `nav` events, `nav.requestOwnership/releaseOwnership` |
| `location` | `location.getCurrent`, `location.watch` |
| `network` | `net.fetch` (plus each host in `network.allow`) |
| `apps.launch` | `apps.open`, `apps.openURL` |
| `vehicle.identity` | `serialNumber` in `car.getInfo` |
| `car.raw` | `car.sendCommand`, `car.requestCarUI`, `car` events `remoteEvent` and `openURL` |

Always available: `car.getInfo` (without the serial number), `car.getState`,
`car` state events, `screen.*`, `input.*`, `ui.*`, `apps.list`, `system.*`,
`app.*`, `storage.*`, `channel(...)`, and anything a native plugin exposes
without declaring a permission.

Permissions are a contract with the person installing your app. Ask for what
you use. `car.raw` in particular talks to the head unit directly and can put
some cars in odd states; leave it out unless you know you need it.

## Validation

`carpwa validate` (and every `carpwa push` / `carpwa dev`) checks the manifest
before anything is copied to the phone. On the phone, an app whose manifest
does not parse or lacks `id`/`name` is skipped and logged; it never takes the
other apps down with it.
