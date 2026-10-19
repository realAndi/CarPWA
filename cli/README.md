# carpwa: the CarPWA developer CLI

Build web apps that run full-screen on the CarPlay screen of a jailbroken
iPhone: scaffold an app, run it in a desktop CarPlay simulator, push it to the
phone with live reload, and package it as a `.deb`.

Node.js 18 or newer. No npm dependencies.

```sh
npm install -g ./cli          # or: cd cli && npm link
carpwa create my-app --template media
cd my-app
carpwa sim --open             # desktop simulator with a mock car
carpwa doctor                 # is the phone reachable and set up?
carpwa dev                    # push on every save, page console in the terminal
```

| command | what it does |
|---|---|
| `create <dir>` | scaffold an app (`--template blank\|media\|dashboard`, `--id`, `--name`) |
| `validate [dir]` | check `carpwa.json`, the start page and the icon |
| `sim [dir]` | the desktop simulator (`--preset`, `--input`, `--port`, `--open`) |
| `doctor` | check SSH, CarPWA and carpwad on the phone, read-only |
| `push [dir]` | sync the app to the phone |
| `dev [dir]` | push, then sync and reload on every save; stream logs |
| `list` / `reload <id>` / `remove <id>` | manage apps on the phone |
| `logs [--app <id>]` | stream page console output |
| `package [dir]` | build a rootless `.deb` |

Device commands go through the system `ssh` (`--host`, default
`$CARPWA_HOST`, else `iphone`). Full reference: [docs/reference/cli.md](../docs/reference/cli.md).
The simulator: [docs/guides/simulator.md](../docs/guides/simulator.md).

## Developing the CLI

```sh
node --test cli/test   # from the repository root, or `npm test` in cli/
npm pack               # prepack copies ../sdk/js into vendor/ for the published package
```

The tests run every device command against a fake carpwad through a fake
`ssh` (`test/helpers/`), so they never touch a phone. The SDK is read from
`../sdk/js/` when running from the repository and from `vendor/` in the
published package.
