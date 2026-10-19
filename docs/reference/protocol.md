# Wire protocol

This is the contract between the four moving parts of CarPWA. You only need it
if you are writing a native plugin, a tool that talks to `carpwad`, or porting
the SDK to another language. App developers use the [JS API](js-api.md).

```
┌─ CarPlay.app (DashBoard) ──────┐              ┌─ CarPWA.app (launcher, sandboxed) ────┐
│ CarPWA.dylib (the tweak)       │ ── opens ──► │ one window on the car screen          │
│  · an icon per CarPWA app      │              │  · a WKWebView per app, car bridge    │
│  · launches CarPlay apps,      │ ◄─ requests ─│  · built-in modules, native plugins   │
│    goes home                   │              │  · CarKit: session, nav, car URLs     │
└────────────────────────────────┘              └───────────────────┬───────────────────┘
                                                                    │ page (HTML/JS)
                                                                    │ ws://127.0.0.1:<app port>/_carpwa/ws
                                                                    ▼
                                             ┌─ carpwad (launch daemon, user mobile) ──────┐
                                             │ control server 127.0.0.1:47800              │
                                             │ one server per app 127.0.0.1:47801…         │
                                             │ storage · channels · net proxy · dev reload │
                                             └─────────────────────────────────────────────┘
```

Pages run in the launcher app, not in CarPlay.app: on iOS 17 the platform
sandbox policy only lets processes in the container sandbox start WebKit's
processes, and CarPlay.app is not one. The launcher is a CarPlay app of its
own (`CARCapableApp`, like CarPlay Settings) and gets a plain UIKit window
on the car screen. The tweak in CarPlay.app adds the icons, opens the
launcher on an app, and does what only DashBoard can (see
`Shared/CPWALauncher.h` for that contract).

A page therefore has **two transports**:

| transport | lives in | carries modules |
|---|---|---|
| **car bridge** | `window.webkit.messageHandlers.carpwa` (only in the launcher) | `car`, `screen`, `media`, `nav`, `location`, `input`, `ui`, `apps`, `system`, and every native plugin module |
| **server bridge** | WebSocket to the app's own port | `storage`, `channel`, `net`, `app`, `dev` |

The SDK routes by module name. Unknown module names go to the car bridge,
because that is where native plugins register.

## Envelope

Every message on both transports is a JSON object.

### Call (page → native)

```json
{ "id": 12, "type": "call", "module": "media", "method": "play", "params": {} }
```

`id` is a positive integer chosen by the caller, unique per transport while the
call is outstanding. `params` is always an object (may be empty).

### Result / error (native → page)

```json
{ "id": 12, "type": "result", "result": { "ok": true } }
{ "id": 12, "type": "error",  "error": { "code": "EPERM", "message": "media.control not granted" } }
```

On the car bridge the reply travels through `WKScriptMessageHandlerWithReply`.
The native side replies with the bare `result` value, or with an error string of
the form `"CODE: message"`; the SDK turns that into the same shape as above.

### Event (native → page)

```json
{ "type": "event", "module": "car", "event": "nightMode", "data": { "nightMode": true } }
```

On the car bridge events are delivered by the host calling
`window.__carpwa_native_event(<event object>)`.

### Subscriptions

Native modules only start expensive observers when someone listens. Every
module accepts two reserved methods:

```json
{ "id": 3, "type": "call", "module": "media", "method": "$subscribe",   "params": { "event": "nowPlaying" } }
{ "id": 4, "type": "call", "module": "media", "method": "$unsubscribe", "params": { "event": "nowPlaying" } }
```

`"event": "*"` subscribes to every event of that module.

### Introspection

The car bridge answers `{ "module": "$registry", "method": "modules" }` with

```json
[ { "name": "media", "methods": ["getNowPlaying", "play", "..."], "events": ["nowPlaying", "playbackState"], "permission": null } ]
```

## Error codes

| code | meaning |
|---|---|
| `EINVAL` | bad or missing parameter |
| `EPERM` | the app's manifest does not grant the required permission |
| `ENOTFOUND` | no such module, method, key, app or channel |
| `EUNAVAILABLE` | the feature exists but cannot run right now (no CarPlay session, no media playing, private API missing on this iOS version) |
| `ENOTCAR` | a car-bridge module was called outside CarPlay (desktop browser, Safari) |
| `ETIMEOUT` | no reply within the SDK timeout (default 15 s) |
| `EINTERNAL` | anything else; `message` says what |

## Values

Results are plain JSON. Native code converts before replying:

- `NSDate` → milliseconds since the Unix epoch (number)
- `NSData` → base64 string
- `CGRect` → `{ "x", "y", "width", "height" }`, `UIEdgeInsets` → `{ "top", "left", "bottom", "right" }`
- images → `data:image/png;base64,…` URLs
- `NaN` / `±Inf` → `null`

## Server bridge

### Connecting

```
GET /_carpwa/ws?key=<sessionKey> HTTP/1.1
Upgrade: websocket
Origin: http://127.0.0.1:<app port>
```

`carpwad` accepts the upgrade only when **both** hold:

1. `Origin` is exactly `http://127.0.0.1:<that port>` or `http://localhost:<that port>` (blocks other
   web pages on the phone from talking to your app's storage), and
2. `key` matches the app's current session key, **or** `devtoken` matches the
   developer token (see below).

The session key is random per daemon start, written to
`<jbroot>/var/mobile/Library/CarPWA/run/apps.json`, and injected into the page by
the launcher as `window.__CARPWA_NATIVE__.sessionKey`. Sandboxed App Store apps cannot
read the jailbreak root, so they cannot learn it.

The app is identified by the **port** the socket arrived on, never by anything
the page says. Text frames only; one envelope per frame.

### Server modules

| module.method | params | result | permission |
|---|---|---|---|
| `app.info` | – | `{ id, name, version, port, permissions, origin }` | – |
| `app.list` | – | `[ { id, name, version, port, url } ]` | – |
| `storage.get` | `{ key }` | value or `null` | – |
| `storage.set` | `{ key, value }` | `true` | – |
| `storage.remove` | `{ key }` | `true` | – |
| `storage.keys` | – | `[string]` | – |
| `storage.getAll` | – | `{ key: value }` | – |
| `storage.clear` | – | `true` | – |
| `channel.publish` | `{ channel, data }` | number of receivers | – |
| `channel.join` | `{ channel }` | `true` | – |
| `channel.leave` | `{ channel }` | `true` | – |
| `net.fetch` | `{ url, method?, headers?, body?, bodyEncoding?: "text"\|"base64", timeout? }` | `{ status, statusText, headers, url, body, bodyEncoding }` | `network` |
| `dev.log` | `{ level, args: [any], ts }` | `true` – appended to the daemon's log ring buffer and streamed to `carpwa dev` / `carpwa logs` | – |
| `dev.tailLogs` | `{ app? }` | `true` – this connection starts receiving `dev.log` events (dev-token connections only) | dev token |
| `dev.untailLogs` | – | `true` | dev token |

Server events:

| module.event | data |
|---|---|
| `channel.message` | `{ channel, data, from }` (`from` is the sender app id, or `"native"`/`"dev"`) |
| `storage.changed` | `{ key, value }` (when another connection of the same app wrote it; `key` is `null` after `clear`) |
| `dev.reload` | `{ reason }` – the page should `location.reload()`; the SDK does this for you |
| `dev.log` | `{ app, level, args, ts }` – only on connections that called `dev.tailLogs` |

Storage is a JSON object per app at
`<jbroot>/var/mobile/Library/CarPWA/Data/<app id>/storage.json`, capped at 5 MiB.
Values are any JSON value.

`net.fetch` only reaches hosts listed in the manifest's `network.allow` (exact
host, or `*.example.com` for subdomains). Responses whose `Content-Type` is
textual (`text/*`, JSON, XML, JavaScript) come back as text; everything else as
base64.

## Control server (`127.0.0.1:47800`)

Everything except `/_carpwa/health` requires the header
`X-CarPWA-Token: <devtoken>`. The dev token is created on first start at
`<jbroot>/var/mobile/Library/CarPWA/dev-token` (mode 0600, owner mobile). The
`carpwa` CLI reads it over SSH; nothing on the phone without root or mobile shell
access can.

| method & path | body | result |
|---|---|---|
| `GET /_carpwa/health` | – | `{ ok, version }` |
| `GET /_carpwa/apps` | – | `[ { id, name, version, port, url, origin: "system"\|"user", path } ]` |
| `POST /_carpwa/dev/rescan` | – | the new app list |
| `POST /_carpwa/dev/apps/<id>/sync` | `{ files: { "<relative path>": "<sha1 hex>" } }` | `{ need: [paths], remove: [paths] }` |
| `PUT /_carpwa/dev/apps/<id>/files/<relative path>` | raw bytes | `{ ok }` |
| `POST /_carpwa/dev/apps/<id>/commit` | `{ remove: [paths] }` | the app entry (rescans, assigns a port, notifies the tweak) |
| `POST /_carpwa/dev/apps/<id>/reload` | – | `{ clients }` – sends `dev.reload` to every open page of that app |
| `DELETE /_carpwa/dev/apps/<id>` | – | `{ ok }` – user apps only |
| `GET /_carpwa/ws?devtoken=…` | WebSocket | a dev/tool connection: may `channel.*` and receives `channel.message` for joined channels |

A sync is: `sync` (send the hash of every local file) → `PUT` every path in
`need` → `commit` with the `remove` list. Only user apps (under
`var/mobile/Library/CarPWA/Apps`) can be written; package-installed apps under
`Library/CarPWA/Apps` are read-only.

## Files on the phone

All paths are relative to the jailbreak root (`/var/jb` on rootless).

| path | owner | what |
|---|---|---|
| `Library/CarPWA/Apps/<id>/` | dpkg | apps installed from packages |
| `Library/CarPWA/Plugins/*.dylib` | dpkg | native plugins, loaded into the launcher |
| `var/mobile/Library/CarPWA/Apps/<id>/` | mobile | apps pushed with `carpwa dev` / `carpwa push` |
| `var/mobile/Library/CarPWA/Data/<id>/storage.json` | mobile | `storage.*` |
| `var/mobile/Library/CarPWA/run/apps.json` | mobile | live registry: ids, ports, session keys, icon paths |
| `var/mobile/Library/CarPWA/ports.json` | mobile | stable port assignments |
| `var/mobile/Library/CarPWA/dev-token` | mobile, 0600 | control-server token |
| `var/mobile/Library/CarPWA/config.json` | mobile | `{ "devMode": true, "basePort": 47800 }` |

`run/apps.json`:

```json
{
  "version": 1,
  "controlPort": 47800,
  "generatedAt": 1760000000000,
  "devMode": true,
  "apps": [
    {
      "id": "com.example.hello",
      "name": "Hello Car",
      "shortName": "Hello",
      "version": "1.0.0",
      "port": 47801,
      "url": "http://127.0.0.1:47801/index.html",
      "sessionKey": "9f2c…",
      "icon": "/var/jb/var/mobile/Library/CarPWA/Apps/com.example.hello/icon.png",
      "path": "/var/jb/var/mobile/Library/CarPWA/Apps/com.example.hello",
      "permissions": ["media"],
      "backgroundColor": "#000000",
      "origin": "user"
    }
  ]
}
```

When this file changes, `carpwad` posts the Darwin notification
`com.andi.carpwa/apps-changed`; the tweak re-reads it and rebuilds its icons,
and the launcher updates its open pages.

`carpwad` rescans the app folders when it receives the Darwin notification
`com.andi.carpwa/rescan`. Package maintainer scripts send it with
`carpwactl rescan`, which is installed with CarPWA.
