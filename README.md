# CarPWA

Web apps on the CarPlay screen of a jailbroken iPhone.

A CarPWA app is a folder of HTML, CSS and JavaScript with a small manifest.
On the phone, each app gets its own icon on the CarPlay home screen and
runs full screen in a web view, talking to the car through a JavaScript
SDK: car and screen info, night mode, now playing and media controls,
navigation state, location, knob input, alerts and banners, and launching
other apps.

This needs a jailbreak and is not something the App Store would allow.
It has been built and tested on one setup so far: an iPhone 15 Pro on
iOS 17.3, Dopamine (rootless) with ElleKit, against Apple's CarPlay
Simulator. Expect rough edges.

## How it fits together

| directory | |
|---|---|
| `Launcher/` | `CarPWA.app`, a CarPlay app of its own (like CarPlay Settings) that shows the pages and runs the car bridge, the built-in modules and native plugins |
| `Tweak/` | loaded into CarPlay.app: an icon per CarPWA app, opens the launcher, launches other CarPlay apps on its behalf |
| `Daemon/` | `carpwad`, which serves every app from 127.0.0.1 and provides storage, channels between apps, a network proxy and live reload |
| `Shared/` | code the tweak and the launcher both use |
| `sdk/js/` | the page SDK (`carpwa.js`, `carpwa.css`) and its TypeScript definitions |
| `libcarpwa/`, `sdk/native/` | the API for native plugins |
| `cli/` | the `carpwa` command: create, validate, simulate and push apps |
| `examples/` | four complete apps |
| `docs/` | the manifest, the CLI and the wire protocol |

The pages run in a separate app rather than inside CarPlay.app because on
iOS 17 the sandbox only lets ordinary sandboxed apps start WebKit's helper
processes, and CarPlay.app isn't one. `docs/reference/protocol.md` has the
details.

## Building

You need [Theos](https://theos.dev) and Xcode for the package, and Node 18
or later for the CLI.

```sh
make package            # the .deb ends up in packages/
make -C Daemon test     # daemon tests, on macOS
(cd cli && npm test)    # CLI tests
```

Install the package on the phone and restart CarPlay:

```sh
scp packages/com.andi.carpwa_*.deb iphone:/tmp/
ssh -t iphone 'sudo dpkg -i /tmp/com.andi.carpwa_*.deb && killall -9 CarPlay'
```

## Writing an app

```sh
npm install -g ./cli
carpwa create my-app
carpwa sim my-app --open      # a CarPlay head unit in the browser
carpwa push my-app            # onto the phone, over SSH
```

Start with `docs/guides/manifest.md` and `sdk/js/carpwa.d.ts`, then
`docs/reference/cli.md`. The apps in `examples/` show most of the API.

## If CarPlay won't start

The tweak stays off while this file exists:

```sh
ssh iphone 'touch /var/jb/var/mobile/Library/CarPWA/disable-tweak && killall -9 CarPlay'
```
