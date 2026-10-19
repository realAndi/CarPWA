# Terminal

A CarPlay home screen in the shape of a terminal: every CarPWA app and every
CarPlay app on the phone in one list, with what's playing, who's navigating
and how fast you're going next to it. Phosphor green by day, amber at night,
dark green on paper with a light appearance.

```
carpwa@my-car:~$ open spotify▊                  usb · night  21:14
┌─ apps 1/2 ─────────┐ ┌─ now playing ──────┐ ┌─ sys ──────────┐
│ > pwa Hello Car    │ │ Midnight City      │ │ nav Maps       │
│   car Maps         │ │ M83 · Spotify      │ │ spd 54 km/h    │
│   car Spotify      │ │ [###---] 1:02/4:03 │ │ hdg NE 045°    │
│   -- more (1/2) -- │ │ [|<]  [||]  [>|]   │ │ car Apple …    │
└────────────────────┘ └────────────────────┘ └────────────────┘
```

| permission | used for |
|---|---|
| `apps.launch` | `apps.open` on the list's entries |
| `media`, `media.control` | the now-playing pane and its three keys |
| `navigation` | the `nav` line: which apps give directions |
| `location` | speed and heading |

## How it works

- **The list never scrolls.** It fits as many rows as the screen has room
  for and pages with a `-- more --` row, like `more`. When the car limits
  lists while driving, it shows six entries at most.
- **Every action is echoed** on the prompt line (`open spotify`,
  `media next`), and so is every rejected call (`open maps: permission
  denied`), in red.
- **Knob first.** On knob and touchpad cars the first entry is selected when
  the page opens, and the selection is drawn in inverse video. Touching the
  screen hides it again.
- The progress bar is text: `[####----]`, extrapolated from `elapsed`,
  `elapsedAt` and `rate` once a second while something plays.
- Speed is in km/h, or mph when the phone's region is the US, the UK,
  Liberia or Myanmar.

## Running

```sh
carpwa sim examples/terminal --preset ultrawide --input knob --open
carpwa push examples/terminal            # on the phone
```

The CarPWA package also installs it, next to Hello Car.
