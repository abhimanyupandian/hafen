# Layout

The app frame, from hafen's `web/public/css/app.css` (frame, top bar, message thread, small
screens, desktop window) and `web/public/css/build.css` (the panel).

## The frame

```
┌─ .app (flex row, 100% tall) ───────────────────────────────────────────────────────────────────┐
│┌─ aside.nav#nav ──────┐┌─ main.main#main (flex column) ──────────────────────────────────────┐│
││ .nav-head      52px  ││┌─ .work-area (flex row) ──────────────────────────┬─ aside.panel ──┐││
││  logo · actions      │││ .work (flex column)                              │ .panel-head 52 │││
│├──────────────────────┤││  header.topbar                            52px   ├────────────────┤││
││ .nav-body (scrolls)  │││  .scroller (flex 1)                              │ .panel-body    │││
││  section             │││    .wrap.thread (≤740px, centred)                │  (scrolls)     │││
││  section             │││  footer.composer                                 │  .panel-foot   │││
││  …                   ││└──────────────────────────────────────────────────┴──── 340px ─────┘││
││                      ││ docks: head 40px (+1px line) · body                                 ││
│├──────────────────────┤│ section.console  head 40px (+1px line) · body                       ││
││ .nav-foot 41px       ││                                                                     ││
│└──────────── ↔ ───────┘└─────────────────────────────────────────────────────────────────────┘│
└────────────────────────────────────────────────────────────────────────────────────────────────┘
   .nav-resizer (6px, right edge)
```

The sidebar and the main column are always there. A page that shows details of a selection puts
its content and the panel side by side in a work area at the top of the main column, as hafen
does (`.build-area`: build.css:78); the docks and the console span the full width under
both. A page without a panel puts its content straight in the main column. Rendered by the page's
`main.jsx`:

```jsx
<aside className="nav" id="nav" aria-label="Sidebar">
  <NavHead … />
  <div className="nav-body" id="navBody">{/* sections */}</div>
  <NavFoot />
  <NavResizer />
</aside>
<Scrim />
<main className="main" id="main">
  <div className="work-area">
    <div className="work">
      <header className="topbar" id="topbar">…</header>
      {/* the page's content */}
    </div>
    <aside className="panel" id="panel">…</aside>
  </div>
  {/* docks */}
  <Console />
</main>
{/* overlays: <Tooltip />, the settings modal, <Toasts /> */}
```

`.work-area` is `.build-area`'s rules (`position: relative; flex: 1; min-height: 0; display:
flex`); `.work` is a flex column taking the width left (`flex: 1; min-width: 0; display: flex;
flex-direction: column`), as `.main` is.

### How the edges line up

These alignments are deliberate; every page keeps them.

- **Top:** the sidebar's head (`.nav-head`), the top bar (`.topbar`), the panel's head
  (`.panel-head`), which sits beside the top bar, and modal heads (`.modal-head`) are all `--bar` (52px) tall, with a 1px `--line`
  along the bottom, inside the 52px. Their bottom lines meet across the window.
- **Bottom:** the sidebar's foot (`.nav-foot`) is 41px (`--foot` + 1px), with its line on top. The
  console's head is 40px under the console's own 1px top line. Their top lines meet.
- **Sections:** each sidebar section has a 1px line on top and a 40px head, so a closed section is
  41px, the same height as the foot.

## Sidebar

`aside.nav` (app.css:10–40).

- **Width:** `--nav-w`, 300px by default, dragged from its right edge (`.nav-resizer`, 6px wide)
  between 240px and half the window. A double-click resets it; arrow keys move it 16px (64px with
  Shift); Home and End go to the ends. Remembered (`<app>.navWidth`). While hovered or dragged the
  edge shows a 2px `--muted` line.
- **Head** (`.nav-head`): the logo (`.brand`) at the left; the page's controls (`.nav-actions`) at
  the right. Padding `0 16px`.
- **Body** (`.nav-body`): the page's sections, top to bottom, scrolling when they don't fit. The
  first section has no top line.
- **Foot** (`.nav-foot`): Settings (sliders icon; a gear in the Eval project: [Additions](components.md#icons)) at the left, collapse (sidebar icon) at the right,
  both ghost icon buttons. Padding `0 9px` (the gutter less 7px, so the icons line up with text
  above).

### Sections

Each is a `NavSection` (a collapsible, see [components](components.md#collapsible-section)). Open
sections share the height that's left (`flex: 1 1 0`); a closed one is just its head. When
everything is open on a short screen, the sidebar scrolls rather than squash a heading.

A page tunes how each open section takes space, by its id, with one of these (as hafen does,
app.css:42–98, build.css:7–9):

| Rule when open | Use for |
|---|---|
| `flex: 1 1 0` (the default), with a `min-height` (140–180px) | Lists that should share what's left equally |
| `flex: none`, its list capped (`max-height: calc(N * var(--control))`, scrolling past N rows) | A short list sized to its content |
| `flex: 1 1 auto` | Content that needs its own height first, then shares |
| `flex: 0 1 auto` | Content sized to itself that may shrink |

Section bodies are padded `0 16px 16px`. Bodies that hold a list use `0 8px 12px`, with their notes
padded `0 8px`, so a row's text lines up with the heading's label.

### Collapsed: a rail

On screens wider than 860px, the foot's collapse button shrinks the sidebar to a 52px rail
(`--rail`), remembered (`<app>.navCollapsed`). The rail keeps the logo at the top and, at the
bottom, Settings above the expand button, each a full-width button as tall as the console's head;
the line between them meets the console's (app.css:165–172).

### Small screens: a drawer

At 860px and narrower the sidebar becomes a drawer: fixed, `min(320px, 88vw)` wide, slid off to the
left and in (`transform .2s`) when `body.nav-open`, over a `.scrim` (`rgb(0 0 0 / .4)`) that closes
it. The resizer is hidden. A menu button in the top bar opens it, with the logo beside it.

## Main column

`main.main`: a flex column that takes the width left (`flex: 1; min-width: 0`): the work area (or
the content), then the docks, then the console, always last.

### Top bar

`header.topbar` (app.css:110–119): 52px, padding `0 16px`, gap 12, line underneath.

| Part | What |
|---|---|
| `#menu` | Ghost icon button that opens the drawer; small screens only |
| `.topbar-brand` | The logo; small screens only |
| `h1.title` | What's open, 14px 500, one line with ellipsis; takes the space left |
| `.model-status` | Up to 70% wide: a badge (a `.btn.badge`, at most 280px) and a status line (`#status`, 11px mono `--muted`, one line) |

### Message thread and message box

- `.scroller` takes the height left and scrolls; inside it `.wrap.thread` is at most 740px wide,
  centred, padded `0 16px`, with 28px above and below.
- Messages are 28px apart. See [Message](components.md#message-and-thread).
- `footer.composer` (app.css:156–159): line on top, padding `12px 16px`, a `.controls` row: the
  message box (`.textarea.textarea-lg.grow`, up to 200px tall), its max button (44×44, outlined)
  and the primary button (`.btn.btn-primary.btn-lg`).

## Panel

`aside.panel` (build.css:151–202): 340px, line on its left, `--bg`, the full height of the work
area, at its right.

- **Head** (`.panel-head`): 52px, padding `0 8px 0 16px`. At the left a `.block-label` (an icon,
  16px, and a `.label` in `--fg`, e.g. `TEST`); at the right a ghost close button.
- **Body** (`.panel-body`): scrolls; padding `12px 16px 16px`; a column of field label rows
  (`.field-head`), fields, `.controls` rows (their buttons share the width), output blocks
  (`.panel-output`), facts and hints.
- **Foot** (`.panel-foot`, inside the body at its end): 16px above, a line, 12px below it; the ids
  (`IdField`s, `.panel-ids`) and a ghost Delete button (`.panel-delete`) that turns `--danger` on
  hover.

## Docks and the console

A dock is a collapsible section at the bottom of the main column, built on the console's frame
(components.css:350–362): a 40px head under a 1px top line, a body whose height is a remembered
custom property, and a top edge (`.console-resizer`, 7px, centred on the line) that drags it taller,
up to the whole column less what can't shrink.

The **console** is always the last one: head `CONSOLE`, then `copy` and `clear` (shown only while
open); body `--console-h` (200px by default), remembered (`<app>.consoleHeight`); open by default.
See [Console](components.md#console). Other docks sit above it.

(eval: the thread comes first. The console is **closed by default** (opened, it's remembered as any
section is), and open with nothing in it, it's only as tall as its note ([Console when
empty](components.md#console-when-empty)). The timeline's default height is a fifth of the window's,
between 120px and 240px ([Timeline](components.md#timeline)). So the thread is at least half the
window's height at 1440×900, and about half at 1024×768, until the docks are opened or dragged
taller.)

## Overlays

| What | Where |
|---|---|
| Modal | Centred `<dialog>`, at most `100vw − 32px` by `100vh − 32px`, over a 40% black backdrop |
| Tooltip | Under its anchor, 6px below, left edges lined up, kept 8px inside the window |
| Toasts | Top right: 12px from the top, 16px from the right, 340px wide, stacked 8px apart, above modals. (eval: under the top bars, at the top right of the thread, 8px in, so they never cover a bar's controls, the panel or the docks: [Toasts under the top bars](components.md#toasts-under-the-top-bars)) |
| Loader | Full screen on `--bg`, the logo mark centred, until the page has drawn (at least 1s) |

## Small screens

| Width | Change |
|---|---|
| ≤ 860px | The sidebar becomes a drawer; the top bar shows the menu button and logo; the panel overlays the main column from the right, its full height (`min(340px, 92vw)`, z-index 21; `.main` is `position: relative`), shown when something is selected and closed with its `×` (eval: hidden, what's selected kept, with its own hide button: [The panel on a small screen](components.md#the-panel-on-a-small-screen)) |
| ≤ 640px | The settings modal stacks: its options become a row of tabs above the content |
| ≤ 560px | The title hides; the status takes the top bar |

## The desktop app's window

In a desktop app (Electron) the page's `<html>` has `.app-window` and `.app-<platform>` (`darwin`,
`win32`, `linux`), set before it draws (app.css:192–219).

- No title bar: the top bars (`.nav-head`, `.topbar`, `.panel-head`) are the window's. Dragging one
  moves the window; the controls in them stay clickable.
- The logo is hidden in the sidebar's head and the top bar (the window is the app's); the head's
  controls move to the right.
- **macOS:** the window buttons sit in the first top bar from the left. The sidebar's head is
  padded 84px on the left (`--window-buttons`); with the sidebar a rail, the top bar is padded
  `84px − 52px` and the rail's edge starts below the top bar; with it a drawer, the top bar is
  padded 84px.
- **Windows and Linux:** the window's buttons are drawn over the top bars' right end, which are
  padded to leave room for them (`env(titlebar-area-x)`, `env(titlebar-area-width)`).
