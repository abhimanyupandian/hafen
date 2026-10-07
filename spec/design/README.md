# Design system

A reusable design system, written down from hafen's UI (`web/`) as it is on 2026-10-05 (commit
`41e9765` and the working tree), so other projects can look and behave exactly like it.

**hafen's code is the source of truth.** The values here are copied from it, with the file and
line they come from. If this spec and that code ever differ, the code wins and this spec is
corrected.

| File | Contents |
|---|---|
| [tokens.md](tokens.md) | Colours (light and dark), status colours, type, sizes, spacing, lines, shadows, layers, motion |
| [layout.md](layout.md) | The app frame: sidebar, main column, top bar, panel, bottom docks; how they line up; small screens; the desktop window |
| [components.md](components.md) | Every reusable component: anatomy, classes, React API, states, behaviour, ids. Ends with the **Additions**: new components proposed for projects that reuse the system |
| [patterns.md](patterns.md) | Conventions across components: statuses, deleting, remembered state, ids, wording and number formats, empty and loading states, addresses, keyboard |

## The look, in brief

- **Monochrome.** Black on white, or near-white on near-black in dark. Grey for anything secondary.
  Colour is used only for status (waiting, running, done, failed) and danger.
- **Square and flat.** No rounded corners anywhere (`border-radius: 0`). 1px lines in `--line`
  separate and outline things. Shadows only on things that float (modals, toasts, a card being
  dragged).
- **Two typefaces.** Monospace for controls, labels, hints and data; the system sans-serif for
  content (messages, lists, notes, titles).
- **A few heights that everything lines up to.** 32px for every control and list row, 44px for the
  message box and two-line rows, 52px for every top bar and panel head, 40px for section and dock
  heads (41px with their top line).
- **Open things show it.** An open section has a bar down its left edge (thicker beside its
  heading), and its label and arrow turn from grey to the text colour.
- **Remembered.** Sections opened or closed, the sidebar's width and whether it's collapsed, dock
  heights, the theme: all kept between visits.
- **Named.** Every control has an `id` and an accessible name, for automation and assistive tech.
- **As the system's by default** (light or dark, following it as it changes), light or dark by choice,
  switched on `<html data-theme>`.

## Where it comes from in hafen

| Source | What |
|---|---|
| `web/public/css/tokens.css` | Design tokens and base element styles |
| `web/public/css/components.css` | Reusable components |
| `web/public/css/app.css` | The frame (sidebar, main column, top bar, message thread, message box), small screens, the desktop window |
| `web/public/css/build.css` | The panel, facts list, palette cards and details disclosures (among page-specific rules) |
| `web/js/components/` | The React components: sidebar parts, collapsible section, list row, confirm button, select, console, modal, editor, id field, icons, logo, resizer, pan, zoom, tooltip, toasts, and the store hooks |

## Reusing it in another project

A project reuses the system by copying these, unchanged except where noted, and building only
from them (plus the [Additions](components.md#additions) it needs, built from the same tokens):

| Copy | Change |
|---|---|
| `tokens.css` | Its comments only |
| `components.css` | Its comments, and leaving out the rules for the source project's own features (its settings panes) |
| The frame rules from `app.css`: `.app`, `.nav*`, `.section*`, `.main`, `.topbar`, `.title`, `.wrap`, `.scroller`, `.thread`, `.empty`, `.msg*`, `.composer`, the rail, the drawer, the desktop window rules | Nothing |
| The panel, facts, palette and details rules from `build.css` (`.panel*`, `.trace-facts`, `.palette*`, `.block-label`, `.trace-run`, `.panel-template`, `.panel-output`, `.panel-code`, `.panel-thinking`) | Nothing |
| `web/js/components/*` | `NavHead`'s right side holds the project's own controls |
| `web/js/lib/` helpers they use (`store.js`, `events.js`, `dom.js`, `prefs.js`, `clipboard.js`) | The storage key prefix (`hafen.` → the project's) and `KEYS`; the event names |
| The page skeleton below | The title, the theme key, the logo |

A page's skeleton (from hafen's `web/build.html`, with the project's names in `<…>`):

```html
<!doctype html>
<html lang="en" class="loading">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title><app></title>
<link rel="icon" href="icons/favicon.ico" sizes="any">
<link rel="icon" href="icons/<mark>.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="icons/apple-touch-icon.png">
<script>/* the theme, and in the desktop app its window's look, set before the page draws */ try { if (window.<appBridge>) document.documentElement.classList.add("app-window", `app-${window.<appBridge>.platform}`); const t = localStorage.getItem("<app>.theme") ?? "system"; document.documentElement.dataset.theme = t === "dark" || (t === "system" && matchMedia("(prefers-color-scheme: dark)").matches) ? "dark" : "light"; } catch {}</script>
<link rel="stylesheet" href="css/tokens.css">
<link rel="stylesheet" href="css/components.css">
<link rel="stylesheet" href="css/frame.css">
<link rel="stylesheet" href="css/<page>.css">
<script type="module" src="js/main.jsx"></script>
</head>
<body>
<div class="loader" id="loader" role="status" aria-label="Loading"><img class="loader-mark" src="icons/<mark>-black.svg" alt=""></div>
<div class="app" id="app"></div>
</body>
</html>
```

The page's `main.jsx` renders the frame into `#app` (see [layout.md](layout.md#the-frame)): the
sidebar (`NavHead`, sections, `NavFoot`, `NavResizer`), the `Scrim`, the main column ending with its
docks and the `Console`, the panel if the page has one, and the overlays (`Tooltip`, the settings
modal, `Toasts`). It calls `initSidebar()` once drawn and `pageReady()` once it has started, which
drops the loader.

**Checking it matches:** a parity test checks that every rule the copied stylesheets keep is still
hafen's, declaration for declaration, and the project renders every component it uses on a gallery page whose screenshots, in
both themes, are compared with a baseline on every change. A difference fails unless this spec was
changed on purpose.
