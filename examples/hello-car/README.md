# Hello Car

The smallest useful CarPWA app: about 80 lines of JavaScript that read the car
and the screen, follow the car's live state, and talk back. Start here.

![icon](icon.png)

| | |
|---|---|
| id | `com.carpwa.example.hello` |
| permissions | none |
| files | `carpwa.json`, `index.html`, `style.css`, `app.js`, `icon.png` |

## What it shows

- **The car**: name, manufacturer and model, and whether CarPlay is wired or
  wireless (`car.getInfo()`).
- **The screen**: the size of the app's area in CSS pixels, its scale, and
  the car's main input: touchscreen, knob or touchpad (`screen.getInfo()`).
- **Live state**: night mode, light or dark appearance, and whether the car
  is limiting the UI while driving. The badges update from the `nightMode`,
  `appearance` and `limitedUI` events, which carry only the changed field and
  get merged into one object.
- **Talking back**: *Show banner* calls `ui.banner()`; *Close* calls
  `ui.close()`, which returns to the CarPlay home screen while the page keeps
  running.
- **Knob and touch**: `CarPWA.focus.enable()` lets a knob or touchpad move
  between the two buttons and press them. The first button is highlighted
  only when the knob is the car's main input, so touch cars don't start with
  a focus ring.
- **Calm failures**: every call handles its rejection. Opened in a plain
  browser, the page says *Not on CarPlay* (`ENOTCAR`) instead of throwing.

The colours, the knob focus ring and the safe-area padding come from
`/_carpwa/carpwa.css`. The page follows the car's appearance with no code of
its own, because the SDK sets `data-carpwa-appearance` on `<html>`.

## APIs used

`CarPWA.ready()`, `CarPWA.env.mode`, `car.getInfo()`, `car.getState()`,
`car.on('nightMode' | 'appearance' | 'limitedUI' | 'connect' | 'disconnect')`,
`screen.getInfo()`, `screen.on('change')`, `screen.info`, `ui.banner()`,
`ui.close()`, `focus.enable()`.

## Run it

```sh
carpwa sim examples/hello-car --open
carpwa sim examples/hello-car --input knob        # try it with a knob
carpwa sim examples/hello-car --screen 1920x720   # ultrawide layout
```

In the simulator, toggle night mode, appearance and limited UI and watch the
badges follow.
