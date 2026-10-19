# The `carpwa` CLI

`carpwa` is the developer tool for CarPWA apps. It scaffolds and validates
apps, runs them in a desktop CarPlay simulator, moves them to the phone over
SSH, and builds `.deb` packages. It needs Node.js 18 or newer and has no npm
dependencies.

```sh
npm install -g ./cli        # from this repository; or: cd cli && npm link
carpwa --help
```

## Global options

These work with every command, anywhere on the command line.

| option | default | what |
|---|---|---|
| `--host <ssh host>` | `$CARPWA_HOST`, else `iphone` | Passed to `ssh` as is, so `user@192.168.1.20`, an IP, or a `Host` alias from `~/.ssh/config` all work. |
| `--verbose` | off | Prints every `ssh` command line, HTTP request and status, and stack traces for unexpected errors. |
| `--help`, `-h` | | Help for the command. |
| `--version` | | The CLI version. |

Every command exits `0` on success and non-zero with a one-line `✗ …` error on
failure. Commands that read an app folder validate `carpwa.json` first and stop
before doing anything else when it has errors.

| environment | what |
|---|---|
| `CARPWA_HOST` | default for `--host` |
| `CARPWA_HOME` | where the simulator keeps its data (default `~/.carpwa`) |
| `CARPWA_SSH` | the `ssh` binary to run (default `ssh` from `PATH`) |
| `NO_COLOR` | turn off colours |

## Commands

| command | needs the phone | summary |
|---|---|---|
| [`create`](#carpwa-create) | no | scaffold an app |
| [`validate`](#carpwa-validate) | no | check `carpwa.json`, start page and icon |
| [`sim`](#carpwa-sim) | no | desktop simulator |
| [`package`](#carpwa-package) | no | build a `.deb` |
| [`doctor`](#carpwa-doctor) | yes | check SSH, CarPWA and `carpwad` (read-only) |
| [`push`](#carpwa-push) | yes | sync the app to the phone |
| [`dev`](#carpwa-dev) | yes | push, then sync and reload on every save; stream logs |
| [`list`](#carpwa-list) | yes | apps on the phone |
| [`reload`](#carpwa-reload) | yes | reload an app's open pages |
| [`remove`](#carpwa-remove) | yes | delete a pushed app |
| [`logs`](#carpwa-logs) | yes | stream page console output |
| [`open`](#carpwa-open) | – | not available over SSH in v1 |

---

### `carpwa create`

```
carpwa create <dir> [--template blank|media|dashboard] [--id <id>] [--name <name>] [--force]
```

Writes a ready-to-run app without asking anything: `carpwa.json`,
`index.html` (loads `/_carpwa/carpwa.css` and `/_carpwa/sdk.js`), `app.js`,
`style.css`, a generated 512×512 `icon.png` (square, no rounded corners;
CarPlay applies its own mask) and a short `README.md`.

| option | default | what |
|---|---|---|
| `--template` | `blank` | `blank`: car name, night mode and screen size. `media`: now playing with transport controls and knob focus (`media`, `media.control`). `dashboard`: clock, now playing and a setting kept in `CarPWA.storage` (`media`). |
| `--id` | `com.example.<folder>` | Must match `^[A-Za-z0-9.-]{1,128}$`. |
| `--name` | the folder name, title-cased | `short_name` is derived from it (12 characters at most). |
| `--force` | off | write into a folder that is not empty |

```
$ carpwa create hello-car --template blank --id com.you.hellocar --name "Hello Car"
✓ Created Hello Car (com.you.hellocar, blank template) in hello-car/
  + carpwa.json
  + app.js
  + index.html
  + style.css
  + icon.png
  + README.md

Next:
  cd hello-car
  carpwa sim --open     # run it in the desktop simulator
  carpwa dev            # push to the phone with live reload
```

### `carpwa validate`

```
carpwa validate [dir] [--json] [--strict]
```

Checks the manifest against [the manifest rules](../guides/manifest.md):
required `id` and `name`, the id pattern, known permissions, `network.allow`
entries (bare hosts or `*.domain`) and that they come with the `network`
permission, that `start_url` and `icon` exist inside the folder, and that the
icon is a square PNG of at least 180×180 (read from its IHDR chunk). Warnings
point out likely mistakes that still work: labels CarPlay will truncate, a
non-reverse-DNS id, `media.control` without `media`, `car.raw`, misspelled
field names.

| option | what |
|---|---|
| `--json` | `{ valid, dir, errors, warnings, manifest }` with defaults filled in |
| `--strict` | warnings fail too |

```
$ carpwa validate hello-car
✓ Hello Car com.you.hellocar 1.0.0 is valid
  label        Hello Car
  start        index.html
  icon         icon.png
  background   #000000
  permissions  none

$ carpwa validate broken
✗ broken/carpwa.json: unknown permission "netwrok" (did you mean "network"?). Known: media, media.control, navigation, location, network, apps.launch, vehicle.identity, car.raw
✗ broken/carpwa.json: "network.allow" lists hosts but "permissions" lacks "network"
! broken/carpwa.json: "short_name" "A very long label" is 17 characters; CarPlay truncates icon labels past ~12
```

### `carpwa sim`

```
carpwa sim [dir] [--port 5173] [--strict-port] [--preset standard|wide|ultrawide|square]
           [--input touch|knob|touchpad] [--open] [--reset-storage]
```

Runs the app in the desktop simulator; see [the simulator guide](../guides/simulator.md).
One server on `127.0.0.1` serves, on the same origin:

| path | what |
|---|---|
| `/` | the app folder: static files with their MIME types, the `spa` fallback, `Cache-Control: no-cache`, nothing outside the folder and no dot-files |
| `/_carpwa/sdk.js`, `/_carpwa/sdk.mjs`, `/_carpwa/carpwa.css` | the SDK; `sdk.mjs` is `sdk.js` plus `export default globalThis.CarPWA;` |
| `/_carpwa/manifest` | the manifest with defaults filled in |
| `/_carpwa/ws` | the server bridge (`storage`, `channel`, `net`, `app`, `dev`); `?sim=1`, no key |
| `/__carpwa_sim/` | the simulator page |

| option | default | what |
|---|---|---|
| `--port` | `5173` | the next free port is used when it is taken |
| `--strict-port` | off | fail instead |
| `--preset` | `standard` | the app's size in CSS px: `standard` 800×480, `wide` 1280×720, `ultrawide` 1920×720, `square` 1024×768 |
| `--input` | `touch` | the interaction model the car reports |
| `--open` | off | open the simulator in your browser |
| `--reset-storage` | off | start with empty storage |

The folder is watched. On every change the simulator sends `dev.reload` to
each page connection (the SDK reloads the page) and re-reads `carpwa.json`; a
manifest with errors is shown on the simulated screen while the last valid one
keeps serving. Page console output (`dev.log`) is printed with the app id,
coloured by level.

```
$ carpwa sim hello-car

  CarPWA simulator  Hello Car · com.you.hellocar

  ➜  Simulator  http://127.0.0.1:5173/__carpwa_sim/
  ➜  App only   http://127.0.0.1:5173/index.html
  ➜  Screen     standard 800×480, touch input
  ➜  Storage    /Users/you/.carpwa/sim/com.you.hellocar/storage.json

  Watching for changes. Page console output appears below. Ctrl-C to stop.

19:23:42 com.you.hellocar starting up {"early":true}
19:23:44 reload app.js → dev.reload to 1 page
```

### `carpwa package`

```
carpwa package [dir] [--out dist] [--maintainer "Name <email>"] [--depiction-url <url>]
```

Builds an installable rootless package in pure Node (`ar` container, ustar
archives, gzip).

| part | contents |
|---|---|
| `data.tar.gz` | the app at `./var/jb/Library/CarPWA/Apps/<id>/`; files 0644, folders 0755, owner root:wheel. Same file selection as `push`. |
| `control` | `Package: <id, lowercased>`, `Name`, `Version` (from `carpwa.json`; must start with a digit), `Architecture: iphoneos-arm64`, `Depends: com.andi.carpwa (>= 1.0)` (or `min_carpwa` when that is higher), `Section: CarPWA`, `Description` (the manifest's `description`, else its name), `Maintainer`/`Author` (the flag, else `git config user.name`/`user.email`), `Depiction` when given, `Installed-Size` |
| `postinst`, `postrm` | `#!/var/jb/usr/bin/sh` + `/var/jb/usr/bin/carpwactl rescan \|\| true`, mode 0755 |

The output is `<out>/<id>_<version>_iphoneos-arm64.deb`. When `dpkg-deb` is on
`PATH`, the package is read back with `dpkg-deb -I` and `-c` and every path,
owner and file count is checked; otherwise that step is skipped.

```
$ carpwa package hello-car --maintainer "You <you@example.com>"
✓ Built dist/com.you.hellocar_1.0.0_iphoneos-arm64.deb (66.3 KB, 6 files)
  installs to /var/jb/Library/CarPWA/Apps/com.you.hellocar/
✓ dpkg-deb -I and -c read it: 6 files under /var/jb/Library/CarPWA/Apps/com.you.hellocar/
```

---

## Talking to the phone

Device commands run the system `ssh` binary; there is no SSH library. For each
command the CLI:

1. finds the jailbreak root: `ssh <host> 'test -d /var/jb && echo /var/jb || echo'`
   (paths are then `<jbroot>/var/mobile/Library/CarPWA/…`, so rootful phones work too);
2. reads the dev token: `ssh <host> cat <jbroot>/var/mobile/Library/CarPWA/dev-token`;
3. opens a tunnel to the control server:
   `ssh -N -o ExitOnForwardFailure=yes -L <free local port>:127.0.0.1:47800 <host>`,
   waits until the local port accepts, and talks HTTP with `X-CarPWA-Token`;
4. checks `/_carpwa/health`, and that the token is accepted (`401` means it is not).

Tunnels are killed when the CLI exits, including on Ctrl-C. Use SSH keys:
with password logins `ssh` asks once per step.

Over USB instead of Wi-Fi, forward SSH with `iproxy 2222 22` and add a host to
`~/.ssh/config`:

```
Host iphone
  HostName 127.0.0.1
  Port 2222
  User mobile
```

### `carpwa doctor`

```
carpwa doctor [--host <ssh host>]
```

Runs the checks below in order and prints `✓` or `✗` with a fix for each
failure. It only reads: `true`, `test -d`, `dpkg -s`, `cat`, `sw_vers`/`plutil`
over SSH, and `GET /_carpwa/health` and `GET /_carpwa/apps` through a tunnel.
When SSH fails, the remaining checks are skipped. Exits 1 if anything failed.

| check | how |
|---|---|
| ssh reachable | `ssh <host> true` |
| jbroot found | `/var/jb` exists |
| CarPWA installed | `dpkg -s com.andi.carpwa` reports `install ok installed` |
| carpwad running | `/_carpwa/health` through the tunnel |
| token readable | the dev token file can be read, and carpwad accepts it |
| iOS version | `sw_vers -productVersion`, falling back to `plutil` on `SystemVersion.plist` |

```
$ carpwa doctor
carpwa doctor · ssh host "iphone"

✓ ssh reachable      `ssh iphone` works
✓ jbroot found       /var/jb (rootless)
✗ CarPWA installed   com.andi.carpwa is not installed
                     fix: install CarPWA from its repo in Sileo or Zebra, or `apt install com.andi.carpwa`
✓ carpwad running    carpwad 1.0.0 on 127.0.0.1:47800
✓ token readable     /var/jb/var/mobile/Library/CarPWA/dev-token (accepted)
✓ iOS version        iOS 16.5

1 check failed
```

### `carpwa push`

```
carpwa push [dir] [--reload] [--host <ssh host>]
```

Validates, then runs the [sync protocol](protocol.md#control-server-12700147800):
`POST /_carpwa/dev/apps/<id>/sync` with `{ files: { path: sha1 } }`, a `PUT` to
`/_carpwa/dev/apps/<id>/files/<path>` (each segment URL-encoded) for every path
in `need`, then `POST …/commit` with `{ remove }`. Only changed files travel;
files deleted locally are removed on the phone. Prints the app entry.

Never sent: dot-files and dot-folders (`.git`, `.DS_Store`, `.env`, …),
`node_modules/`, `*.deb`, and anything matched by a `.carpwaignore` in the app
folder: one gitignore-style pattern per line (`*`, `**`, `?`, trailing `/` for
folders, leading `/` to anchor, `!` to re-include, `#` comments).

| option | what |
|---|---|
| `--reload` | also `POST …/reload` afterwards |

```
$ carpwa push hello-car
✓ Pushed Hello Car 1.0.0 to iphone: 6 of 6 files uploaded (68.4 KB)
  id       com.you.hellocar
  name     Hello Car
  version  1.0.0
  port     47801
  url      http://127.0.0.1:47801/index.html
  origin   user
  path     /var/jb/var/mobile/Library/CarPWA/Apps/com.you.hellocar
```

### `carpwa dev`

```
carpwa dev [dir] [--no-logs] [--host <ssh host>]
```

`push` and reload, then:

- watches the folder (debounced 150 ms) and on every save syncs incrementally
  and calls `POST /_carpwa/dev/apps/<id>/reload`; a broken `carpwa.json` pauses
  syncing until it is fixed;
- opens the control WebSocket (`/_carpwa/ws?devtoken=…`) through the same
  tunnel, calls `dev.tailLogs { app }` and prints `dev.log` events live;
- forwards the app's own port and prints a desktop URL,
  `http://localhost:<port>/<start_url>?carpwa_devtoken=<token>`, that opens the
  app in a desktop browser with the phone's real server bridge. The local port
  is the app's port when it is free, because carpwad only accepts that port in
  `Origin`;
- reopens the tunnel when it drops (phone asleep, Wi-Fi change), resyncs and
  resumes the logs.

`--no-logs` skips the log stream. Ctrl-C stops it and closes every tunnel.

```
$ carpwa dev hello-car
✓ Pushed Hello Car 1.0.0 to iphone: 6 of 6 files uploaded (68.4 KB)
  id       com.you.hellocar
  …
  reloaded 1 page
  desktop  http://localhost:47801/index.html?carpwa_devtoken=9f2c41d7e0

  Watching /Users/you/hello-car; saves sync to the phone. Ctrl-C to stop.

19:26:28 com.you.hellocar info ready on Head Unit S1
19:26:29 sync ↑ app.js (1.8 KB, reloaded 1)
```

### `carpwa list`

```
carpwa list [--json] [--host <ssh host>]
```

`GET /_carpwa/apps` as a table; `--json` prints the reply.

```
$ carpwa list
ID                             NAME         VERSION  PORT   ORIGIN
com.carpwa.example.nowplaying  Now Playing  1.0.0    47802  system
com.you.hellocar               Hello Car    1.0.0    47801  user
```

### `carpwa reload`

```
carpwa reload <id> [--host <ssh host>]
```

`POST /_carpwa/dev/apps/<id>/reload`; prints how many pages got `dev.reload`.

```
$ carpwa reload com.you.hellocar
✓ Reloaded com.you.hellocar: 1 page
```

### `carpwa remove`

```
carpwa remove <id> [--host <ssh host>]
```

`DELETE /_carpwa/dev/apps/<id>` for an app you pushed. Packaged apps (origin
`system`) are refused before anything is sent. The app's storage stays on the
phone.

```
$ carpwa remove com.carpwa.example.nowplaying
✗ com.carpwa.example.nowplaying was installed from a package (origin "system"); remove it with Sileo, Zebra or apt instead
```

### `carpwa logs`

```
carpwa logs [--app <id>] [--host <ssh host>]
```

Streams `dev.log` from the control WebSocket (`dev.tailLogs`) until Ctrl-C.
Every line has the time, the app id and the level. Without `--app`, every app.

```
$ carpwa logs --app com.you.hellocar
Following com.you.hellocar on iphone. Ctrl-C to stop.
19:26:31 com.you.hellocar warn low fuel {"range":12}
```

### `carpwa open`

```
carpwa open <id>
```

Opening an app remotely is not supported over SSH in v1. The command says so
and exits `0`; the app is on the CarPlay home screen.

## Troubleshooting

| message | what to do |
|---|---|
| `cannot reach iphone over SSH: …` | Make `ssh iphone` (or your `--host`) work by itself first; `carpwa doctor` walks through it. |
| `cannot read the dev token at …` | CarPWA is not installed, or `carpwad` never started. |
| `carpwad is not answering on …` | The package is installed but the daemon is down; see `carpwa doctor`. |
| `carpwad on … refused the dev token (HTTP 401)` | The token was regenerated (reinstall); just run the command again. |
| `carpwa.json has N errors` | Run `carpwa validate` for the list. |
