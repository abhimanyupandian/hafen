# Tokens

All from `web/public/css/tokens.css` unless a line says otherwise. Components and layout use
these custom properties, never raw values, with the exceptions listed under
[Fixed values](#fixed-values).

## Theme

The theme is `<html data-theme="light|dark">`. Light is `:root` (tokens.css:4–37); dark overrides
it under `:root[data-theme="dark"]` (tokens.css:39–54). Each sets `color-scheme` to match, so
native controls and scrollbars follow.

The user picks Light (the default), Dark, or As the system's (Settings → Appearance), kept in
localStorage as `<app>.theme` (`hafen.theme` in hafen). An inline script in each page's `<head>`
applies it before the page draws; `lib/prefs.js` keeps it in step afterwards (other tabs, the
system changing) and emits `theme:changed`.

## Colours

### Base

| Token | Light | Dark | Used for |
|---|---|---|---|
| `--bg` | `#ffffff` | `#0a0a0a` | Page, panels, controls, cards |
| `--fg` | `#0a0a0a` | `#ededed` | Text, focus and hover borders, primary button fill, open/selected bars |
| `--muted` | `#737373` | `#8f8f8f` | Secondary text: labels, hints, notes, list rows not selected, chevrons |
| `--line` | `#e5e5e5` | `#262626` | Every 1px line and border |
| `--soft` | `#f5f5f5` | `#151515` | Quiet fills: selected row, user message, id field, output blocks, a canvas-like background |
| `--danger` | `#c62828` | `#ff6b6b` | Errors, failed status text, delete confirmations |

### Status

Kept mild: a text colour, a soft fill and a line for each (tokens.css:11–15, 46–49). Cards and
other filled things use the soft fill with the line; text uses the first.

| State | Text (light / dark) | Soft fill (light / dark) | Line (light / dark) |
|---|---|---|---|
| Waiting, queued | `--wait` `#8a6a00` / `#e2c15c` | `--wait-soft` `#fffbea` / `#1e1909` | `--wait-line` `#ecd889` / `#5e4c16` |
| Running | `--run` `#2563eb` / `#8fb3ff` | `--run-soft` `#f3f7ff` / `#111a2b` | `--run-line` `#b9cdf8` / `#2c4675` |
| Done | `--ok` `#2f7d4f` / `#86d1a3` | `--ok-soft` `#f3faf5` / `#101d16` | `--ok-line` `#b7dcc4` / `#2a5a3d` |
| Failed, error | `--danger` (above) | `--bad-soft` `#fdf4f4` / `#241314` | `--bad-line` `#efc4c4` / `#6b3133` |

There's no `--bad` text token: failed text is `--danger`.

### Special purpose

| Token | Light | Dark | Used for |
|---|---|---|---|
| `--arrow` | `#b4b4b4` | `#8f8f8f` | Connector lines between cards; lighter than `--fg` so the cards stand out |
| `--logo-line` | `#000000` | `#262626` | The logo tile's 1px outline |
| `--log-bg` | `#ffffff` | `#0b0b0b` | Console and long-output background (a terminal in dark) |
| `--log-fg` | `#404040` | `#c8c8c8` | Console output text |
| `--log-cmd` | `#0a0a0a` | `#ffffff` | Console commands (`$ …`) |
| `--log-dim` | `#737373` | `#7a7a7a` | Console log lines |
| `--log-err` | `#c62828` | `#ff6b6b` | Console errors |

### Overlays (fixed values)

| Where | Value | Source |
|---|---|---|
| Modal backdrop, drawer scrim | `rgb(0 0 0 / .4)` | components.css:217, app.css:184 |
| Modal shadow | `0 16px 48px rgb(0 0 0 / .18)` | components.css:215 |
| Toast shadow (with its accent bar) | `inset 3px 0 0 <accent>, 0 8px 24px rgb(0 0 0 / .14)` | components.css:329–333 |
| A card being dragged | `0 6px 20px rgb(0 0 0 / .12)` | build.css:117 |

## Type

| Token | Value |
|---|---|
| `--sans` | `ui-sans-serif, system-ui, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif` |
| `--mono` | `ui-monospace, "SF Mono", Menlo, Consolas, monospace` |
| `--control-font` | `12px` |

The body is `15px/1.6 var(--sans)`, antialiased (tokens.css:58–63). Buttons, selects, text areas
and inputs inherit the font (tokens.css:64), so a plain `.textarea` is 15px sans.

Every text style in use, largest first:

| Style | Font | Size / line height | Weight | Other | Classes |
|---|---|---|---|---|---|
| Body, messages, message box | sans | 15px / 1.6 (message box: 20px lines) | 400 | | `body`, `.msg-body`, `.textarea-lg` |
| Settings pane title | sans | 15px | 500 | | `.settings-title` |
| Page title | sans | 14px | 500 | one line, ellipsis | `.title` |
| Rows, notes, tabs | sans | 13px | 400 | | `.list-open`, `.note`, `.settings-tab`, `.settings-row-name` |
| Small headings | sans | 13px | 500 | | `.toast-title`, `.settings-subtitle` |
| Palette text | sans | 12.5px / 1.45 | 400 | | `.palette-text` |
| Brand | mono | 13px / 1 | 600 | letter-spacing −.01em | `.brand` |
| Controls | mono | 12px / 1 | 500 (inputs and selects 400) | | `.btn`, `.input`, `.select select`, `.segmented`, `.check` |
| Primary button | mono | 12px / 1 | 500 | uppercase, letter-spacing .06em | `.btn-primary` |
| Code | mono | 12px / 18px | 400 | tab size 2 | `.textarea-code` |
| Facts, output | mono | 12px / 1.4 (facts), 12px / 1.5 (output) | 400 | | `.trace-facts`, `.panel-output`, `.panel-code` |
| Logs | mono | 11.5px / 1.5 | 400 | pre-wrap | `.console-body`, `.msg-sent pre` |
| Label | mono | 11px / 1 | 500 | uppercase, letter-spacing .08em, `--muted` | `.label` |
| Hint | mono | 11px / 1.4 | 400 | `--muted` | `.hint`, `.tooltip`, `.toast-text`, `.msg-stats` |
| Ghost button | mono | 11px / 1 | 400 | `--muted` | `.btn-ghost` |
| Small data | mono | 11px / 1 (size), 11px / 1.2 (detail) | 400 | `--muted` | `.list-size`, `.list-detail` |

Labels in a heading that's open, a modal head or a panel head are `--fg`; elsewhere `--muted`.

## Sizes

| Token | Value | Used for |
|---|---|---|
| `--control` | `32px` | Every control and list row: buttons, inputs, selects, segmented, checkbox rows, settings tabs |
| `--control-lg` | `44px` | The message box and its Send button, two-line list rows, the max button beside the message box |
| `--control-pad` | `10px` | Horizontal padding inside inputs and selects |
| `--bar` | `52px` | Top bars: sidebar head, top bar, panel heads, modal heads |
| `--foot` | `40px` | Console head and sidebar foot (41px each with their 1px top line) |
| `--rail` | `52px` | The collapsed sidebar's width |
| `--gutter` | `16px` | Page edge padding |

Set at run time (by `makeResizable`, `web/js/components/resizer.js`), with their defaults:

| Property | Default | Range | Set by |
|---|---|---|---|
| `--nav-w` | `300px` | 240px to half the window | the sidebar's resizer |
| `--console-h` | `200px` | 60px to the whole column | the console's resizer |
| `--window-buttons` | `84px` | (macOS desktop app only) | app.css:205 |

### Fixed values

Sizes used directly, all multiples of the grid the tokens set:

| What | Value | Source |
|---|---|---|
| Small button in a label row, id field | 24px tall (icon buttons 24×24) | components.css:75–76, 87–89 |
| Tree toggle | 20px wide | components.css:180 |
| Section head | 40px (section min height 41px with its line) | app.css:37–39 |
| Badge dot | 7×7, 1px border, round | components.css:114 |
| Chevron | 6×6, 1.5px borders, rotated −45° closed, 45° open | components.css:159–163 |
| Select arrow | 5×5, 1.5px borders, 11px from the right | components.css:61–65 |
| Checkbox | 14×14, `accent-color: var(--fg)` | components.css:145 |
| Panel | 340px wide | build.css:151 |
| Settings modal | `min(880px, 100vw − 32px)` × `min(620px, 100vh − 32px)`; its nav 220px | components.css:231–233 |
| Large editor | `min(960px, 100vw − 32px)` × `min(760px, 100vh − 32px)` | components.css:293 |
| Message column | max 740px, centred | app.css:121 |
| Zoom buttons | 28px tall; level at least 52px wide | components.css:299–302 |
| Tooltip | max `min(420px, 100vw − 16px)` | components.css:312 |
| Toasts | `min(340px, 100vw − 32px)` wide | components.css:322 |
| Loader mark | 32×32 | components.css:131 |
| Logo tile | 32×32 with a 1px `--logo-line` outline | app.css:21 |

## Spacing

There's no spacing scale token. Gaps and paddings in use are 2, 3, 4, 5, 6, 8, 10, 12, 14, 16, 20
and 28px (plus a few that centre text in a fixed height, like a text area's 9px); new layouts use
the same values.

| Where | Padding / gap |
|---|---|
| Section head | `0 16px 0 8px`, gap 8 |
| Section body | `0 16px 16px` (list sections: `0 8px 12px`, their notes `0 8px`) |
| Top bar | `0 16px`, gap 12 |
| Panel head / modal head | `0 8px 0 16px` |
| Panel body | `12px 16px 16px` |
| Modal foot | `12px 16px`, gap 8 |
| Settings content | `14px 20px 20px`, gap 10 |
| Message thread | 28px above and below; 28px between messages; label 8px above the text |
| User message | `10px 14px` on `--soft` |
| Message box area | `12px 16px` |
| Field label row | 12px above (0 when first), 4px below, at least 24px tall |
| A row of controls | gap 8 |
| Console body | `8px 16px` |

## Lines, corners, focus

- **Lines:** always `1px solid var(--line)`.
- **Corners:** square. `border-radius: 0` on buttons, fields and modals; no other radius in use
  except the badge dot (round).
- **Hover and focus:** a control's border turns `--fg` (`.btn`, `.input`, `.select`). Where there's
  no border, a 1px `--fg` outline, inset 1–2px (`.list-open`, tabs, toggles, segmented) or 2px out
  (`.btn-primary`, checkbox).
- **Open and selected:** an inset bar in `--fg`: 2px down an open section (5px beside its heading),
  a selected settings tab, a selected card.
- **Disabled:** buttons at opacity .35, fields and checkboxes at .5; the pointer stays default.

## Layers

| z-index | What |
|---|---|
| 100 | Loader |
| 50 | Tooltip |
| Top layer | Modals (`<dialog>`), toasts (a popover, above modals) |
| 21 | Panel, when it overlays the main column (small screens) |
| 20 | Zoom buttons, a floating menu button |
| 10 | Sidebar as a drawer |
| 9 | Scrim behind the drawer |
| 6 | Resize handles |

## Motion

| What | Animation | Source |
|---|---|---|
| Chevron opening and closing | `transform .15s` | components.css:161 |
| Drawer sliding in and out | `transform .2s` | app.css:180 |
| Toast in | slides from the right, `.3s cubic-bezier(.2, .8, .2, 1)` | components.css:330 |
| Toast out | `.25s ease-in` | components.css:334 |
| Blink (busy dot, streaming cursor) | `1s steps(1) infinite`, off at 50% | components.css:116–119 |
| Loader | fades in `.2s`, then pulses to opacity .35 every `1.2s ease-in-out` | components.css:131–133 |

The open bar on sections changes at once (no transition), so it never lingers. With reduced
motion, toasts move in `.01s`.
