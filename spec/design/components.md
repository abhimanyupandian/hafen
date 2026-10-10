# Components

Each component as it is in hafen's `web/`: what it's for, its markup and classes, its React API
where it has one, its states, how it behaves, and its ids. Styles are in hafen's
`web/public/css/components.css` unless noted; React components in `web/js/components/`.

The last section, [Additions](#additions), proposes components that projects reusing the system
need. They're built only from the tokens and existing parts, and none exists in hafen's code.

## Text

| Class | Style | For |
|---|---|---|
| `.label` | mono 11px, 500, uppercase, letter-spacing .08em, `--muted`, one line | Section headings, panel and modal heads, a type's name |
| `.hint` | mono 11px/1.4, `--muted` | Field labels, small explanations, statuses beside a field |
| `.note` | sans 13px, `--muted`, no margin | Empty states and explanations in sections and panels |
| `.error` | `--danger` | Added to any of the above, or to `.panel-output`, `.msg-stats` |
| `.title` | sans 14px, 500, one line with ellipsis | The title in the top bar |

## Buttons

`<button class="btn …">` (components.css:15–39). Every button is `--control` (32px) tall, square,
with a 1px `--line` border on `--bg`, mono 12px 500, its content centred with a 6px gap.

| Variant | Classes | Look | For |
|---|---|---|---|
| Default | `.btn` | Outlined; border turns `--fg` on hover and focus | Secondary actions: `export JSON`, `Cancel` |
| Primary | `.btn.btn-primary` | Filled `--fg`, text `--bg`, uppercase, .06em; focus ring 1px `--fg` 2px out | The main action: `RUN`, `SEND`, `SAVE` |
| Primary, stopping | `.btn.btn-primary.stop` | Inverted: `--bg` fill, `--fg` text and border | The same button while what it started runs: `STOP` |
| Ghost | `.btn.btn-ghost` | No border or fill, `--muted` mono 11px 400, padding 0 4px; `--fg` on hover | Small actions in heads and rows: `clear all`, `copy`, `×`, `export JSON` |
| Ghost, confirming | `.btn.btn-ghost.confirm` | `--danger` | A ghost delete asking "delete?" (see ConfirmButton) |
| Icon | `.btn.btn-icon` | Square, 32×32, no padding | Icon-only buttons: `+`, close, settings, collapse |
| Large | `.btn.btn-lg` | 44px tall, padding 0 18px | Beside the message box |

Disabled buttons are at opacity .35 with the default pointer, and don't change on hover. Inside a
`.field-head` a button is 24px tall (24×24 for icon buttons). An icon in a button never takes the
click (`pointer-events: none`).

### ConfirmButton

`ConfirmButton` (`confirm.jsx`): a button that asks before acting. The first click turns its text
into `question`; the second runs `onConfirm`. Moving away (blur or mouse leave) cancels. With
`.btn-ghost`, the asking state is `--danger` (`.confirm`).

```jsx
<ConfirmButton className="btn btn-ghost when-open" id="clearItems" label="clear all"
               question="delete every item?" onConfirm={() => items.clear()} />
```

Every delete and clear uses it: list rows' `×` (question `delete`), `clear all` (question `delete
every …?`), a panel's `Delete <thing>` (question `delete this <thing>?`).

## Fields

| Class | Look | Notes |
|---|---|---|
| `.input` | 32px, mono 12px, padding `0 10px`, 1px `--line` border, square | Border `--fg` on focus; placeholder `--muted`; disabled at .5 |
| `.textarea` | Padding `9px 12px`, line height 1.5, sans 15px (inherited), not resizable, scrolls | `autoGrow()` (`lib/dom.js`) fits it to its text up to its `max-height` |
| `.textarea.textarea-code` | mono 12px/18px, tab size 2 | JSON, YAML and code |
| `.textarea.textarea-lg` | One line is exactly 44px: 20px lines, padding centred | The message box |
| `.select` | A `<label class="select">` around a `<select>`: 32px, mono 12px, padding `0 30px 0 10px`, its own arrow (5px, 11px from the right) | Border `--fg` on hover and focus |
| `.check` | `<label class="check"><input type="checkbox"> Label</label>`: 32px row, 14px box, mono 12px 500, `accent-color: var(--fg)` | Disabled at .5 |

### Select

`Select` (`select.jsx`) renders the `<select>`'s options from `[value, label, disabled?]` pairs, or
`{group, options}` for an `<optgroup>`, with `value` selected:

```jsx
<label className="select"><Select id="modelSelect" options={[["a", "Model A"], ["b", "Model B"]]} value={model} onChange={…} /></label>
```

### Field label row

`.field-head` (components.css:73–77): a row 24px or more, 12px above (none when it's first), 4px
below. The label at the left (`<label class="hint">` or `<span class="hint">`), `.field-actions`
at the right (status text, small buttons, the max button).

```jsx
<div className="field-head">
  <label className="hint" htmlFor="messageInput">Message</label>
  <span className="field-actions"><MaxButton … /></span>
</div>
<textarea className="textarea" id="messageInput" rows={3} />
```

### A row of controls

`.controls` (components.css:93–94): flex row, gap 8, aligned to the bottom; `.grow` on the child
that takes the width. In the panel every button in it shares the width (`.panel-body .controls
.btn { flex: 1 }`).

### Large editor

`MaxButton` (`editor.jsx`): a ghost icon button (maximize icon, 14px) for a text field. It opens the
field's text in a modal editor (`min(960px, 100vw − 32px)` × `min(760px, 100vh − 32px)`): head with
the field's name and close, a text area filling it, and a foot with the hint `⌘/Ctrl+Enter saves ·
Esc cancels`, `Cancel` and `SAVE`. Save hands the text to `onSave`, which treats it as typed.
`.textarea-code` fields open in code style.

```jsx
<MaxButton fieldRef={inputRef} fieldId="messageInput" label="Message" onSave={(text) => { … }} />
```

Its id is `#<fieldId>Max`; the editor's are `#editor`, `#editorText`, `#editorSave`,
`#editorCancel`, `#editorClose`.

### Id field

`IdField` (`id-field.jsx`): a read-only `_id` with a copy button. The label is a `.hint`; the value
is a 24px `.input.input-id` on `--soft`, `--muted`, mono 11px, no border; the copy button (copy
icon, 14px) turns `--ok` for 1.2s once copied.

```jsx
<IdField id="itemId" label="_id" value={item._id} />
```

## Segmented

`<nav class="segmented"><a aria-current="page">One</a><a>Two</a></nav>` (components.css:98–106):
an outlined 32px group of links or buttons, 1px lines between them, mono 12px 500. The current one
is filled `--fg` with `--bg` text; the others are `--muted`, `--fg` on hover. For switching
between views.

## Badge

A status that looks like a button, with a dot (components.css:112–117):

```html
<button class="btn badge on"><span class="badge-dot"></span><span class="badge-text">acme-support</span></button>
```

| State | Look | Meaning (for example, a connection) |
|---|---|---|
| `.on` | Filled dot | Ready, working |
| `.busy` | Filled dot, blinking (1s) | In progress |
| `.off` | Hollow dot, `--muted` text | None, or not ready |

The dot is 7×7, round, a 1px border in the text colour; gap 8 to the text, which ends with an
ellipsis.

## Icons and logo

`Icon` (`icons.jsx`): line icons on an 18×18 grid, `stroke="currentColor"`, stroke width 1.5, no
fill, decorative (`aria-hidden`): the button or text beside one names it. Drawn at 18px by
default, 16px in heads and labels, 14px in small buttons.

| Name | Drawing | For |
|---|---|---|
| `plus`, `minus` | `+`, `−` | New, zoom |
| `copy` | Two overlapping squares | Copy |
| `maximize` | Two diagonal arrows | Open in the large editor |
| `settings` | Two sliders | Settings |
| `sidebar` | A panel with a left column | Collapse or expand the sidebar |
| `menu` | Two lines | Open the drawer |
| `close` | `×` | Close |

hafen's set also has icons for its own features; a project adds its own the same way
([Additions](#icons)).

`Logo` (`logo.jsx`): the project's mark as a 32×32 tile with a 1px `--logo-line` outline: a black
tile in light, a white one in dark (two SVGs). It follows the theme.

## Collapsible section

`NavSection` (`collapsible.jsx`), the sidebar's sections; `useCollapsible(id, defaultOpen,
onToggle)` for anything else that opens and closes (the console and docks use it).

```jsx
<NavSection id="itemsSection" name="items" label="Items" bodyId="itemsBody" defaultOpen
            actions={<ConfirmButton className="btn btn-ghost when-open" … />}>
  …
</NavSection>
```

renders

```html
<section class="section collapsible open" id="itemsSection" aria-labelledby="itemsLabel">
  <div class="section-head collapsible-head">
    <button class="collapsible-toggle" id="itemsToggle" aria-expanded="true" aria-controls="itemsBody">
      <span class="chev"></span><span class="label" id="itemsLabel">Items</span>
    </button>
    <!-- actions -->
  </div>
  <div class="section-body collapsible-body" id="itemsBody">…</div>
</section>
```

- **Head:** 40px, the toggle (chevron and label) taking the width, then the actions.
- **Closed:** chevron pointing right, label and chevron `--muted`; the body isn't shown; actions
  marked `.when-open` are hidden.
- **Open:** chevron pointing down; label and chevron `--fg`; a 2px `--fg` bar down the section's
  left edge, 5px beside its head. The bar appears and goes at once.
- **Hover:** the label and chevron turn `--fg`.
- **Remembered:** open or closed, per section id (`<app>.section.<id>`); until toggled, it's
  `defaultOpen`.

## Tree toggle

`.tree-toggle` (components.css:179–185): a 20px-wide button holding a chevron, before a list row's
text, that shows or hides the rows under it (`aria-expanded`). A row with nothing under it gets an
empty `<span class="tree-toggle">` so its text still lines up. Rows are indented 14px per level.

## List

`List` and `ListRow` (`list.jsx`), styles components.css:189–209.

```jsx
<List id="itemList" aria-label="Items">
  <ListRow id={`item-${it._id}`} label={it.name} detail="14:02:11 · 3.4 s" size="done"
           active={it._id === openId} onOpen={…} onDelete={…} deleteLabel="Delete item"
           data={{ status: it.status }} />
</List>
```

| Part | Look |
|---|---|
| `.list-row` | 32px flex row; 44px with a `detail` (`.two-line`) |
| `.list-open` | The main button: sans 13px `--muted`, one line with ellipsis, padding 0 8px; `--fg` on hover or when the row is active |
| `.list-label` / `.list-detail` | With a detail: the label over the detail (mono 11px/1.2 `--muted`), 3px apart |
| `.list-size` | At the right: mono 11px `--muted`; coloured by status (see [patterns](patterns.md#status)) |
| `.list-del` | `×` (a ghost ConfirmButton), hidden until the row is hovered or focused; `delete` in `--danger` while asking. Always shown on touch screens |
| `.list-add` (Addition) | A row's own action before `×` (`ListRow`'s `actions`), e.g. a suite's `+` that adds a test: a 24px ghost icon button (14px icon), `--muted`, `--fg` on hover, shown as `×` is |
| `.list-more` (Addition) | A row's menu, with the `more` icon: as `.list-add`, but over the row's right end ([Scope panes](#scope-panes)) |
| `.active` | The row on `--soft`, its text `--fg`, `aria-current="true"` |

- **Ids:** with `id`, the row is `#<id>`, its button `#<id>-open`, its `×` `#<id>-delete`.
- **No `×`** (an Addition): a row with no `onDelete` can't be deleted from the list, and has none.
- **Data:** `data={{ status }}` becomes `data-status`, which colours `.list-size`.
- **`before`:** goes ahead of the button (a tree toggle).
- **Focus:** after the list redraws, the control that had focus has it again (found by id).

## Facts

A two-column list of facts (build.css:53–55):

```html
<dl class="trace-facts"><dt>status</dt><dd>done</dd><dt>tokens</dt><dd>120 in · 48 out</dd></dl>
```

mono 12px/1.4; names `--muted` in the first column, values in `--fg`, wrapping anywhere; gaps
4px down, 12px across.

## Output blocks

| Class | Look | For |
|---|---|---|
| `.panel-output` | `<pre>`: padding `8px 10px`, 1px `--line` border, `--soft` fill, mono 12px/1.5, wraps; 44–320px tall, scrolls | An output, a request or a response |
| `.panel-output.error` | Text `--danger` | A failed output |
| `.panel-code` | As `.panel-output`, without the height limits | A command or snippet to copy |
| `#panel .panel-output` | 240px, resizable down to 64px from its bottom right corner | The panel's main output |
| `.panel-thinking` | 120px, `--muted` text | A model's thinking |

## Disclosures

Collapsed details use `<details>`:

| Class | Summary | For |
|---|---|---|
| `.msg-sent` | mono 11px `--muted`, prefixed `+ ` closed and `− ` open, no marker; `--fg` on hover | Extra detail under a message |
| `.trace-run` | mono 12px `--muted` (`--fg` open), with a line above | Repeated records (each run of something), all folded but the last |
| `.panel-template` | mono 11px `--muted`, 24px tall, prefixed `+` closed and `−` open (14px), no marker; `--fg` on hover and open; its content 6px under it | A long value shown on request, named for what it is: `Request`, `Raw stream · 12 chunks` (eval: each a row of its own, 6px apart) |

Inside `.msg-sent`, each part is a `.hint` label over a `<pre>` (mono 11.5px/1.5 `--muted`, 1px
border, up to 200px tall).

## Palette card

`.palette` and `.palette-item` (build.css:61–74): a column of outlined cards, 8px apart, each
padded `10px 12px`: a `.block-label` (an icon, 16px, and a `.label` in `--fg`) over a line of
`.palette-text` (sans 12.5px/1.45 `--muted`). The border turns `--fg` on hover; a focused card has
a 1px `--fg` outline inside; the cursor is `grab`; a card being dragged fades to .4. Clicking or
Enter adds what it stands for; dragging it onto a target does the same there.

(eval: cards aren't dragged: the cursor is a pointer (none while there's nowhere to add to), and
clicking or Enter adds. They're grouped, see [Palette groups](#palette-groups).)

## Modal

`Modal` and `CloseButton` (`modal.jsx`), styles components.css:213–228. A `<dialog>` at the end of
`<body>`, opened with `showModal()`: focus stays inside, Esc closes, the page behind can't be used,
focus returns where it was. A click on the backdrop closes it.

```jsx
<Modal id="editor" label="Edit Message" className="editor" onClose={…} dialogRef={dialogRef}>
  <div className="modal-head"><span className="label">Message</span><CloseButton dialogRef={dialogRef} id="editorClose" /></div>
  <div className="editor-body">…</div>
  <div className="modal-foot"><span className="hint">…</span><button className="btn">Cancel</button><button className="btn btn-primary">Save</button></div>
</Modal>
```

- **Box:** 1px `--line` border, `--bg`, shadow `0 16px 48px rgb(0 0 0 / .18)`, at most `100vw −
  32px` by `100vh − 32px`, a flex column.
- **Head:** 52px, padding `0 8px 0 16px`, line under it; its `.label` in `--fg`; the close button
  (close icon, 16px) at the right.
- **Foot:** padding `12px 16px`, line above; a `.hint` pushed to the left, buttons at the right,
  8px apart.

### Settings

The settings modal (`settings/modal.jsx`, components.css:231–290), opened from the sidebar's foot:
880×620 (or the window less 32px). Its left column (220px, line on its right) has the logo and
`SETTINGS`, then options grouped under `.hint` headings (for example Storage, Connection, App),
each a 32px tab (sans 13px `--muted`; the selected one `--fg` on `--soft` with a 2px `--fg` bar);
storage used is at the bottom. The right side shows the selected option: a 15px 500 title, a note,
and its content (lists of `.settings-row`s 48px or taller with a line under each, forms,
statuses).

Options are data: each is a pane in a list (`settings/panes.js`), either a list of what's kept
(`items()`, `remove(item)`, `clear()`) or a `Body` component. Adding a pane adds the option.

## Tooltip

`toggleTooltip(anchor, text)` and `<Tooltip />` (`tooltip.jsx`): a click opens a tooltip under the
element; one shows at a time; a click elsewhere, Esc, scrolling or resizing closes it. It's
inverted (`--fg` fill, `--bg` text), mono 11px/1.4, padding `6px 10px`, up to 420px wide, wraps,
6px under its anchor with left edges lined up, kept 8px inside the window. The anchor gets
`aria-describedby`. (Hover hints elsewhere are plain `title` attributes.)

## Notifications

`notify({ title, text, kind, sound, onClick })` and `<Toasts />` (`toast.jsx`), styles
components.css:320–339.

- A toast slides in at the top right, stays 5 seconds once the page can be seen, then slides out
  (250ms); a click runs `onClick` and dismisses it. With `onClick` (an Addition) it's `.clickable`: a
  pointer, its `title` "Open it", its title underlined on hover.
- **Look:** `--bg`, 1px `--line` border, a 3px accent bar on its left (`--muted`; `--ok` with
  `kind: "ok"`, `--danger` with `kind: "error"`), a soft shadow; title sans 13px 500, text mono
  11px `--muted`.
- They're in the top layer (a popover), above an open modal.
- `sound` plays a chime (`lib/sound.js`). When the window isn't in front, the system shows it too
  (`system`, or by default as the project's settings say: the Eval project's
  [Notifications](../001-hafen/contracts/ui.md#notifications)), and a click on that does `onClick`.

## Console

`<Console />` and `write(text, kind)` (`console.jsx`), styles components.css:350–362. One per page,
at the bottom of the main column.

- **Head** (40px): the collapsible toggle (`CONSOLE`), then ghost `copy` and `clear`, shown only
  while open. `copy` says `copied`, `nothing to copy` or `couldn't copy` for 1.5s.
- **Body:** `--console-h` tall (200px), on `--log-bg`, mono 11.5px/1.5, wrapping; `role="log"`.
- **Lines:** `cmd` (prefixed `$ `, `--log-cmd`), `out` (`--log-fg`), `log` (`--log-dim`), `err`
  (`--log-err`). A progress line (`… 45%`) replaces the previous one with the same text before the
  number, if it's among the last 8. At most 3,000 lines.
- **Follows** new lines while scrolled to the bottom; opens at the bottom.
- **Resizes** from its top edge (`.console-resizer`), 60px up to the whole column; remembered.
- Code writes to it with `say(text, kind)` (`lib/log.js`).

## Resizer

`makeResizable(handle, { key, label, initial, min, max, apply, axis, direction })` (`resizer.js`):
makes an element a resize handle. Drag it, or focus it and use the arrow keys (16px, 64px with
Shift; Home and End for the ends); a double-click resets it. The size is remembered under `key`.
It's a `separator` with a value for screen readers, titled `Drag to resize <label> (double-click
resets)`. While dragging, `<html>` has `.resizing-x` or `.resizing-y`, which sets the cursor
everywhere and stops text selection.

## Zoom and pan

- `createZoom({ area, apply, wheel })` and `<Zoom zoom id label groupLabel />` (`zoom.jsx`): zoom
  from 25% to 200% in steps (25, 33, 50, 67, 80, 90, 100, 110, 125, 150, 175, 200), with Ctrl or ⌘
  and the wheel (or a pinch) around the pointer. The buttons are a group at the area's bottom
  right (12px in): `−`, the level (click for 100%) and `+`, 28px tall, outlined, on `--bg`.
- `panWithSpace(area)` (`pan.js`): hold Space over a scrolling area and drag to move around it, as
  in design tools; the cursor is a hand (grab, grabbing). Plain scrolling also moves around.

## Loader and busy cursor

- **Loader:** `<html class="loading">` hides the page and shows the logo mark centred on `--bg`,
  fading in and pulsing, until `pageReady()` (`lib/dom.js`), at least 1 second after the page
  started loading. If the script never finishes, the page shows anyway after 8 seconds.
- **Busy:** `whileBusy(promise)` puts `<html class="busy">` (the progress cursor everywhere) until
  the work is done.

## Sidebar parts

From `sidebar.jsx`:

| Component | What |
|---|---|
| `NavHead` | The logo at the left; the page's controls at the right (the app's: the [scope button](#scope-button)) |
| `NavFoot()` | Settings (`#openSettings`, the gear) and collapse/expand (`#collapseNav`), ghost icon buttons |
| `NavResizer()` | The right edge handle (`#navResizer`) |
| `Scrim()` | Behind the drawer (`#scrim`); a click closes the drawer |
| `MenuButton({ className })` | Opens the drawer, or expands the rail (`#menu`) |
| `initSidebar()` | Applies the remembered collapsed state; call once after the first draw |

## Top bar

See [layout](layout.md#top-bar). Its status area is a badge (a click shows more about what it
stands for) and a one-line status (`#status`, `role="status"`, `--danger` with `.error`).

## Panel

See [layout](layout.md#panel). Its body is one of two shapes, both with the same head and foot:

- **A form** for the selected thing: fields with label rows, a `.controls` row with its primary
  action (`RUN` / `STOP`), more fields, an output with its status beside the label (`1.2 s · 120
  in · 48 out`), then the foot: ids and `Delete <thing>`.
- **Details** (`DetailsPanel`, any `{ icon, label, Body }`): fields, facts, a row of buttons
  (`export JSON`, …), a hint, then the foot.

## Message and thread

`.msg` and `.thread` (app.css:121–153).

```html
<article class="msg user" id="msg-<_id>" aria-label="You">
  <span class="label">you</span>
  <div class="msg-body">How do I…</div>
  <details class="msg-sent"><summary>sent with …</summary>…</details>
</article>
<article class="msg bot" aria-label="acme-support">
  <span class="label">acme-support</span>
  <div class="msg-body streaming">You can…</div>
  <div class="msg-stats">120 tok · 48.2 tok/s</div>
</article>
```

- **Label:** the `.label` style without uppercase or letter spacing, 8px above the text: `you`, or
  who replied.
- **Body:** pre-wrapped, breaking anywhere. The user's is on `--soft`, padded `10px 14px`; the
  reply has no fill. Reply text is escaped HTML with `**bold**` kept (`formatText`, `lib/format.js`).
- **Streaming:** a blinking 7px block cursor in `--fg` after the text.
- **Stats:** under a reply, mono 11px `--muted` (`--danger` with an error).
- **Actions:** under a reply, underlined ghost buttons 24px tall (`.msg-fixes`), 4px down and 12px
  across.
- **Empty thread:** a centred `.empty` note, 10vh from the top, `--muted`.

## Message box

`footer.composer` (app.css:156–159): the message box (`.textarea.textarea-lg`), its max button,
and the primary button (`.btn-primary.btn-lg`, `SEND`) that becomes `STOP` while working. Enter
sends; Shift+Enter is a new line; Esc stops. (The Eval project leaves out the max button: its box
grows with what's typed.)

## State and events

How components get their data (`hooks.js`, `lib/events.js`):

- `createStore(initial)` → `{ get, set, subscribe }`, and `useStore(store)`: state that code
  outside React changes and components draw.
- `createDraw()` and `useDraw(draw)`: a store that only counts, for components that read their
  data from a module.
- `useEvent(name)`: draw again when a bus event fires.
- `emit(name, detail)` and `on(name, handler)`: the event bus. Services (no DOM) emit
  `<thing>:changed` events; views and components listen. Each project lists its event names at
  the top of its `events.js`.

## Additions

**Proposed for projects that reuse the system (first, [the Eval project](../001-hafen/spec.md));
none exists in hafen's code.** Each is built only from the tokens and the parts above, and is
added here before it's built (Eval constitution, principle I).

### Check badge

The result of one check, under a reply: a small card, tinted by how the check went, with the badge's
dot kept:

```html
<button class="btn btn-ghost badge check-badge" data-status="pass" title="contains 4417: found at 12">
  <span class="badge-dot"></span><span class="badge-text">contains 4417</span>
</button>
```

| Rule | Value |
|---|---|
| Size | 22px tall, padded `0 7px`, the dot 6px and 6px from the name; square corners |
| Text | mono 11px (the ghost button's) |
| Tone by `data-status` | `pass`: `--ok` text and dot, `--ok-soft` fill, `--ok-line` edge; `fail` and `error`: `--danger`, `--bad-soft`, `--bad-line`; `unsure`: `--wait`, `--wait-soft`, `--wait-line`; `running`: `--run`, `--run-soft`, `--run-line` (dot blinking, as `.badge.busy`); `skipped`, none (not run yet) and `off` (turned off, its name struck through): `--muted` text on `--bg`, a `--line` edge |
| Dot | Filled for pass, fail, unsure and running; hollow for skipped, error and not run yet |
| Value | Scored checks add their value after the name: `noul 0.91` |
| Hover, focus | The edge in the card's tone (`--fg` for the muted ones) |
| Selected | `.selected` (`aria-pressed`): the edge in its tone, doubled (an inset 1px shadow) |
| Click | Selects the check (its details in the panel) |
| Title | The check, its result and reason |

A row of them (`.msg-checks`) wraps, 6px apart both ways, 10px under the stats line.

### Reply parts

In a reply (which has no label), in the order they happened, before the text:

- **Thinking:** a `.msg-sent` disclosure (`details.msg-sent.msg-thinking`) whose summary reads
  `thinking · summary · 1.8 s` (the visibility: full, summary, progress, omitted, redacted). Open,
  its text is the disclosure's `<pre>`.
- **Tool calls:** one `.hint` line each (`.msg-tool`): `↳ lookup_order · 0.4 s`; a click selects it.
- **Text:** `.msg-body`, as now.
- **Cut short:** a reply that failed after some of its text came (a stream cut off) shows that text as
  any reply's, its last block ending `…` in `--muted` (`.msg-body.md.cut`), then the error under it as
  `.msg-body.error`: `cut short: network error`. (One that failed before any text came shows only the
  error, with `show the response` for a body that came.) Its stats leave out `to first token` when no
  text came.
- **Stopped:** a reply stopped on purpose (Esc, Stop) isn't an error, and isn't coloured as one: what
  came shows as a cut-short reply's (`.msg-body.md.cut`, ending `…`), then `stopped` under it as
  `.msg-body.hint`, in `--muted`; none came, `Stopped before any reply came.` (`.msg-body.hint`). Its
  turn's head says `stopped · 0.5 s` in `--muted` ([patterns](patterns.md#status): stopped is text only).

Then its foot (`.msg-foot`, 8px under the text, wrapping, 4px down and 10px across): the stats line
(`.msg-stats`) and `copy`; then the check badges.

### Selected message

A turn, check or step selected anywhere (the thread itself, a tree, the timeline, the panel) is
marked in the thread by its turn's group: `--soft` behind it, as a selected list row has (see [Turn
groups and row hover](#turn-groups-and-row-hover)), and scrolled into view.

### Turn groups and row hover

A thread's turn (or a suite's test) is a group (`section.turn-group`): no rule between groups, 6px
apart; padded 14px 14px 18px, its edges 14px outside the column so its text lines up with the rest;
a head (`.turn-head`: a `.label` in `--fg`, cut with an ellipsis when it's too long for the head (a
data row's name: `TURN 1 · ROW 3: A REFUND PLEASE`), a status-coloured `.hint`, and its actions at the right:
`▷` and `×`, ghost, 24px, `--muted`, shown (opacity 1, else 0) when the group is pointed at or
selected, when focused, on touch screens, and `▷` while it's a running run's stop).
A click anywhere in it selects it, except on its own controls. Hover: a faint background,
`--row-hover` (`color-mix(in srgb, var(--soft) 55%, var(--bg))`); selected: `--soft`, its user
message a step darker (`--fg` at 7% over `--bg`). A list row (`.list-row`) has the same hover.

### Section icons, back buttons, field problems

- **Section icons:** `NavSection` takes an `icon`: closed, the section shows it where the arrow is
  (`.section-icon`, 14px, `--muted`, `--fg` on hover; in the arrow's 6px place, its margins -4px, so
  the label doesn't move); open, the arrow.
- **A section's name gives way to its actions:** in a sidebar section's head, when its actions need
  the room (Suites' `+`, `import` and `export all` in a sidebar narrower than its default), the label
  is cut with an ellipsis (`overflow: hidden`, `text-overflow: ellipsis`, `min-width: 0`) rather than
  covered.
- **Back:** a panel head can have `#panelBack` (a ghost icon button, the `back` icon) before its
  icon: to what holds the view.
- **Field problems:** a field's problem shows right under it: `.hint.error.field-problem`
  (`--danger`, 4px above), as it's typed.

### Markdown replies

A reply's text (`.msg-body.md`) is Markdown (marked; GitHub's flavour, line breaks kept), and safe:
raw HTML shows as text, links go only to http(s), mailto and `#` (new window,
`rel="noreferrer noopener"`), images are links. Paragraphs, lists and headings 10px apart (headings
15–17px, 600); inline `code` in mono 12.5px; code blocks 10px 12px; tables with 1px `--line` cells.
Code, code blocks and table heads sit on a 7% wash of `--fg`, not on `--soft`: a selected turn is
`--soft`, and they'd vanish into it. Code blocks and tables scroll sideways on their own, long words
wrap, and the message itself never scrolls sideways. `copy` (a ghost 20px button in the reply's
foot, after its stats, mono 11px, shown on hover and on the selected turn) copies the reply as it
came.

### Context menu

`ContextMenu` (one in the page) and `openMenu(event, { label, items })`: a menu at the pointer (a
right-click), or under the control a key came from (the menu key, Shift+F10), kept inside the window.

| Part | Rule |
|---|---|
| Menu | `.context-menu#contextMenu` (`role="menu"`, `aria-label`): fixed, `--bg`, 1px `--line` border, a soft shadow (`0 10px 28px rgba(0,0,0,.14)`), 4px above and below its items, at least 240px wide |
| Item | `button.context-menu-item` (`role="menuitem"`, `#menu-<id>`): 13px sans in `--fg`, 7px 12px; its label at the left, a `.hint` at the right (a shortcut, what it's about); `--soft` on hover or focus; disabled ones in `--muted` |
| Danger | `.danger`: `--danger`. An item with `confirm` asks first: its first pick shows the question (`Click again to delete it`, `.confirm`), the second does it |
| Line | `.context-menu-line` (`role="separator"`): 1px `--line`, 4px above and below |
| Keys | It opens with its first item focused; ↑/↓ move (round), Home/End, Enter picks, Esc or Tab close it, focus going back where it was |
| Closes | On a pick, Esc, Tab, a pointer down outside it, the window resized or left. Not on a scroll (a thread scrolls by itself while a run streams) |
| In a modal | Opened while a modal is open (Settings), it's drawn inside the modal's dialog, so it's in the top layer with it, above it, and can be used; elsewhere, at the end of the page. Esc closes the menu, not the modal |

### Small charts

Trend lines in the panel (pass rate, p95, cost over runs): SVG, 308×64 (the panel's width less its
padding), a 1px `--line` baseline and top line, the series as a 1.5px `--fg` line (a second series
`--muted`), points 3px; the latest value at the right in mono 11px `--fg`, the axis labels in mono
11px `--muted`. A point that failed is a `--danger` dot. No fills, no gridlines, no legend boxes:
the field label says what it is.

### JSON tree

A JSON response, browsable, in the panel: the `.panel-output` box with one row per key.

| Rule | Value |
|---|---|
| Box | `.panel-output` (padding, border, `--soft`, mono 12px/1.5), no height limit in the panel |
| Rows | 20px tall; objects and arrays have a `.tree-toggle` chevron and show `{3}` or `[12]` when folded; 14px indent per level |
| Text | keys `--muted`, values `--fg` (as facts); strings in quotes |
| Hover | The row on `--bg` |
| Click on a value | Selects it: the row gets a 2px `--fg` inset bar, and its path (`$.reply.order.id`) shows in a `.hint` above the box with `Add check` (a `.btn`, 24px) |
| End | An open object or array ends with its `}` or `]` on a row of its own (`.json-row.json-end`), at the object's indent, in `--muted`, after its last child: the value's last line is always there. Folded, it has none |

### Timeline

The steps of a run on a time axis (a Gantt chart), in a [dock](layout.md#docks-and-the-console)
above the console: a `section.console.collapsible.timeline` with the console's 40px head
(`TIMELINE`, then ghost `fit`), the same resizable top edge (remembered as `<app>.timelineHeight`;
by default a fifth of the window's height, between 120px and 240px, so the thread keeps most of
it), and its own body. The console itself doesn't change.

| Part | Rule |
|---|---|
| Body | `--bg`; a 200px label column (resizable like the sidebar, remembered as `<app>.timelineLabels`; never more than 40% of the body, so a phone keeps room for the chart) and the chart, which scrolls both ways with no scrollbars (the wheel or trackpad, or Space and drag) |
| Axis | 24px, stays on top while scrolling; ticks as 1px `--line` lines down the chart, at least 64px apart at any width or zoom, so their labels never overlap; labels mono 11px `--muted` (`0 s`, `0.5 s`, `1 s`) |
| Rows | 24px; group rows start a group, with a `.tree-toggle` and a `.label` (`TURN 1`); step rows are indented 14px per level, their name in mono 11px `--muted` |
| Bars | 14px tall, centred in the row, 1px border; steps: `--soft` fill, `--line` border; checks and judge calls by status: pass `--ok-soft`/`--ok-line`, fail and error `--bad-soft`/`--bad-line`, unsure `--wait-soft`/`--wait-line`, running `--run-soft`/`--run-line`; skipped at opacity .55 |
| Duration | mono 11px `--muted`, 6px after the bar's end: `1.8 s` |
| Selected | `--fg` border with a 2px inset bar; its row on `--soft` |
| Live | Bars grow while running; a 1px `--run` line marks now |
| Zoom | The `Zoom` group is the corner cell over the label column, beside the axis (`top: 0; left: 0`, as wide as the column, its buttons 23px tall, a 1px line on its right and under it: the axis's height, its line running on under it), on `--bg`: never over a bar or a tick, and the labels scroll under it as the bars do under the axis. It zooms the time axis (25% to 200%); Ctrl or ⌘ and the wheel zoom around the pointer; Space and drag pans (`panWithSpace`) |
| Hover | `title`: the step, start, duration and its metrics |
| Click | Selects the step: the thread scrolls to it and highlights it, and the panel shows it |
| Empty | No label column; the note (`.note.timeline-empty`) is centred across the whole body, 14px above and below, and the body is as tall as it (not the dock's set height); the top edge doesn't resize it. (The state's class is `.no-steps`, not `.empty`: that's the thread's placeholder) |

### Check card

A check as a [palette card](#palette-card), coloured by how it last went: a turn's checks (a
`ul.check-cards`, 8px apart) and a check's last result.

```html
<li class="check-card openable" data-status="pass">
  <div class="check-card-head">
    <span class="block-label"><svg class="icon icon-check"/><span class="label">Path</span></span>
    <span class="check-card-status">pass</span>
    <label class="check check-card-on"><input type="checkbox" checked> <span>on</span></label>
    <button class="btn btn-ghost list-del">×</button>
  </div>
  <button class="check-card-text">$.data.reply contains 4417</button>
  <span class="check-card-reason">found 4417</span>
</li>
```

| Rule | Value |
|---|---|
| Card | The palette card's: `--bg`, 1px `--line` border, `10px 12px`, 6px between its rows; with a 2px inset bar at its left in its status's colour (`--line` before it has run) |
| Head | The `.block-label` (the check icon, 16px, and its kind as a `.label`: `PATH`, `SYSTEM ONE · NOUL`), then its status in mono 11px (`pass`, `fail`, `unsure`, `error`, `skipped`, `running…`, `not run`, `off`), an `on` box (`.check` at 20px, mono 11px `--muted`) and `×` (always shown, 20px), at the right. A check that failed or errored has the `fail` icon (✗) in place of the check icon (✓): a tick never stands beside `fail` |
| What it checks | `.check-card-text`: mono 12px/1.5 `--fg`, wrapping anywhere |
| Why | `.check-card-reason`: sans 12.5px/1.45 `--muted` (the result's reason, its confidence) |
| Colour by `data-status` | `pass` `--ok`, `fail` and `error` `--danger`, `unsure` `--wait`, `running` `--run`: the bar, the icon, the label and the status; others `--muted` |
| Off | `data-status="off"`: its kind and what it checks at .5, what it checks struck through; the reason says it's skipped |
| Hover, click | Openable (in a list): the border `--fg` on hover; a click anywhere but on its controls opens the check |
| The `on` box | Shows what's asked for at once, and what's saved once it is (or what was, if saving failed) |

### Turn icon

A turn in a list (the sidebar's tree, a suite's view) is shown by its icon, not its number: the
`test` icon (a box with a tick), 14px, `.turn-icon` inside the row's button, 8px before its text, in
the colour of how the turn last went: `running` `--run`, `passed` `--ok`, `failed` and `error`
`--danger`, `unsure` `--wait`, `unchecked` (no checks, or every one turned off: nothing says it's
right) `--wait`, not run, skipped or stopped `--muted`. A row's size (`0 checks`) and a turn head's summary
take the same colour; a turn stopped or skipped ran none of its checks, and its size says `stopped` or
`skipped`, not `0/2`. The row's
button is named for screen readers with the number: `turn 2: It arrived broken`.

### Palette groups

A palette's cards by group (`.palette-group`, 8px between its heading and cards, 18px between
groups), each under a `.palette-heading`: mono 11px, 600, `.08em` apart, capitals, `--muted`.

### Placeholders

What an empty container says (`.placeholder`, on a `.note`, `.hint` or `.empty`) sits in its middle,
its text centred: in an open sidebar section, in the middle of the room it has (`margin: auto 0`,
16px 8px); in the thread, in the middle of the conversation's space (the thread holding only it is
a centred column at least as tall as the scroller); in the panel, 14px 8px under what's above it; in
Settings, 16px 8px.

### Settings headings

The settings modal's group headings (`.settings-group`) are bold capitals: mono 11px, 600, `.08em`
apart, in `--fg`. Its foot (`.settings-usage`) is `Storage used` over the size in `--fg`.

### A part that couldn't be drawn

`.crash` (`role="alert"`): in the place of what couldn't be drawn (with that place's class, so it
keeps its room: the panel's border, the thread's scroller), a centred column 8px apart, 24px 16px,
at least 80px tall: a `.note.placeholder` (`<what> couldn't be shown: <why>`) over a ghost
`try again`.

### The panel on a small screen

At 860px and below the panel (`.panel`) shows only with `.shown` (something selected, or asked for),
at `z-index` 8: under the drawer (10) and its scrim (9). The top bar's `#panelToggle` (a ghost icon
button, the `sidebar` icon, 16px, `--muted`, `--fg` while the panel shows; small screens only, as the
menu's button) asks for it. The panel covers the top bar's right end, so its own head has
`#panelHide` (the same button, `--fg`, just before its ×; small screens only): it hides the panel and
keeps what's selected (the test stays open in the thread), where × closes it.

### Panel spacing

One rhythm in the panel's body: a `.field-head` 18px below what's before it and 6px over what it
names; `dl.trace-facts`, a `.controls` row and `.panel-template`s 14px below what's before them (a
row straight under a label: 6px); a number field's own label 6px over it; the foot 24px below; the
first thing in the body not spaced from its top. The head's `.block-label` sits right after the back
button (`margin-right: auto`), the × at the far end.

### Icons

Added to a project's `Icon` set, drawn as the others (18×18, stroke 1.5, no fill):

| Name | Proposed drawing (SVG paths) | For |
|---|---|---|
| `suite` | `<rect x="2.5" y="5.5" width="13" height="10"/><path d="M4.5 3h9"/>` | A suite file |
| `test` | `<rect x="2.5" y="2.5" width="13" height="13"/><path d="M5.5 9l2.5 2.5 4.5-5"/>` | A test |
| `check` | `<path d="M3.5 9.5l3.5 3.5 7.5-8"/>` | A check |
| `provider` | `<path d="M6.5 2.5v4M11.5 2.5v4M4.5 6.5h9v2.5a4.5 4.5 0 0 1-9 0zM9 13.5v2.5"/>` | A provider (an endpoint) |
| `timeline` | `<path d="M2.5 4.5h7M5.5 9h8M8.5 13.5h7"/>` | The timeline |
| `run` | `<path d="M5.5 3.5l9 5.5-9 5.5z"/>` | A run; the button that runs a test |
| `runs` | `<path d="M3.6 10.5A5.6 5.6 0 1 0 4.4 5.6"/><path d="M3.8 2.8v3.1h3.1"/><path d="M9 6v3.3l2.3 1.4"/>` | Runs, their history: a clock turning back (the collapsed sidebar's icon) |
| `chat` | `<path d="M3 4.5h12v8H8.5L5.5 15v-2.5H3z"/>` | Conversations (the collapsed sidebar's icon) |
| `back` | `<path d="M11 4.5L6.5 9l4.5 4.5"/>` | Back, to what holds this |
| `stop` | `<rect x="4.5" y="4.5" width="9" height="9"/>` | Stopping a run |
| `scope` | `<path d="M9 2.5l6.5 3.25L9 9 2.5 5.75z"/><path d="M2.5 9.25L9 12.5l6.5-3.25M2.5 12.5L9 15.75l6.5-3.25"/>` (round joins) | A scope (stage, prod…): stacked layers; the scope button |
| `settings` (changed) | A gear: an outline of eight teeth (r 7.2 at the tips, 5.3 between them, round joins) around a hub (`<circle cx="9" cy="9" r="2.25"/>`) | Settings, in place of the two sliders (`#openSettings`, the gallery) |
| `fail` | `<path d="M5 5l8 8M13 5l-8 8"/>` (a ✗, a little smaller than `close`'s ×, the size of `check`'s ✓) | A check that failed or errored (its card) |
| `more` | `<circle cx="4" cy="9" r=".9"/><circle cx="9" cy="9" r=".9"/><circle cx="14" cy="9" r=".9"/>` (three dots, in a row) | More actions: a row's or a head's menu ([Scope panes](#scope-panes)) |

They're reviewed next to the existing icons, at 14, 16 and 18px, in both themes, before they're
used.

### Scope button

The sidebar head's control for the scope (in place of a select): a ghost button (`.scope-button`,
`#scopeButton`, `data-scope` the scope chosen, "" for none) with the `scope` icon (18px, in
`.scope-icon`) and the scope chosen (`.scope-name`, mono 11px, cut with an ellipsis), 6px apart, padded
`0 6px`, at most 160px wide; `--muted`, `--fg` on hover. A click opens Settings on Environments
(`openSettings("environments")`), where a scope is chosen. Its `title` and `aria-label` name the scope
(`Scope: stage. Choose a scope`).

**No scope chosen** (`.scope-button.none`): no words, the icon alone, greyed out as a disabled field
is (opacity .5: it still opens the choice), with an alert badge over the icon's top right corner. Its
`title` and `aria-label` say it: `No scope chosen: choose one`.

| Part | Look |
|---|---|
| `.scope-icon` | The icon's box (18×18), which the badge is placed on; greyed out with it |
| `.scope-alert` | `!` (`aria-hidden`: the button's name says it), a 10×10 square, mono 10px/10px 600, centred, `--bg` on `--muted` (`--fg` as the button is pointed at or focused, as its icon turns); 6px up and 6px right of the icon's corner, so it sits clear of the icon's lines |

### Scrollbars

Every part of the app that scrolls (the sidebar's sections, the chat, the panel, Settings, editors,
the console, long output) has a thin, quiet scrollbar, the same on every system (Windows draws wide
grey ones with arrows by default):

| Rule | Value |
|---|---|
| Width | 8px; the chat's (`#scroller`) 5px |
| Thumb | `--fg` at 16% over the background, inset 2px (1px in the chat), rounded, at least 24px long (32px in the chat); 32% on hover, 45% while dragged |
| Track, corner, arrows | None: transparent, no buttons |
| Where | `::-webkit-scrollbar` (Chromium, the desktop app). Browsers without it (Firefox): `scrollbar-width: thin` and `scrollbar-color` in the same tones. The standard properties aren't set where `::-webkit-scrollbar` is, since Chromium then ignores the latter |
| Timeline chart | None at all (moved by the wheel or Space and drag) |

### Code editor

The large editor for JavaScript (a plugin's file: `field.language: "javascript"`), from
`design/code.js` (no library):

| Rule | Value |
|---|---|
| Layout | `.code-edit`: the text area (`#editorText.code-edit-text`, see-through text, `--fg` caret, a `--run` selection at 28%) over its colours (`pre#editorColors.code-edit-colors`, `aria-hidden`), both mono 12px/18px, padded `9px 12px` inside a 1px edge, no wrapping; they scroll together |
| Colours | comments `--muted`, strings (template ones too) `--ok`, numbers `--wait`, keywords `--run`, a call's name `--danger`; everything else `--fg` |
| Tab, Shift+Tab | Two spaces in (the selected lines each, or at the caret), or out; the text keeps focus |
| Enter | The line's indent; a level more after an opening bracket; with its closer right after, the closer on a line of its own |
| A closing bracket first on a line | Back a level |
| Format (`.btn#editorFormat`, ⇧⌥F) | Each line indented two spaces a level by the brackets still open before it (the lines that opened them, a level each), a line starting with `.`, `?`, `:`, `&&` or `\|\|` a level more; ends of lines trimmed; a line inside a comment or a template string over several lines left as it is. The plugins' starting files come back as they are |
| Foot hint | `Tab indents · ⇧⌥F formats · ⌘/Ctrl+Enter saves · Esc cancels` |

Edits go in as typed (`insertText`), so ⌘Z undoes them, Format too.

### Group badge

A suite's or a test's `group` ([Groups](../001-hafen/contracts/test-file.md#groups)), after its name
(the suite list, the suite's view, the top bar): `GroupBadge` (`design/badges.jsx`), `.group-badge`
with `data-group` 1 to 8 (a group over 8 takes `((n − 1) mod 8) + 1`'s colour), text `G2`, its
`title` saying what a group does.

| Rule | Value |
|---|---|
| Size | 16px tall, padded `0 4px`, mono 10px (500), square, `flex: none` (a list row's label is cut before it) |
| Colour | The group's (`--group-1` … `--group-8`: blue, green, amber, purple, teal, pink, olive, slate; each with a lighter one for dark): its text, its edge at 45%, its fill at 10% over `--bg`. The same number has the same colour everywhere, a suite's and a test's alike |

### Repeat badge

`×3` after a test's name when it runs more than once (its `repeat`, or its suite's default):
`RepeatBadge`, `.repeat-badge`, the group badge's size, `--muted` on `--bg` with a `--line` edge; its
`title` `Runs 3 times`.

### Spinner

`Spinner` (`design/badges.jsx`): an 18×18 circle (stroke 1.75, at 25%) with a quarter of it drawn
whole, turning once every 0.9 s (3 s when the system asks for less motion), in `currentColor`. It
stands for what's running in place of its icon: a turn's (`.turn-icon[data-status="running"]`, so
`--run`) and the top bar's (`#evalIcon`, 16px, `--run`).

### List row extras

`ListRow` takes `extra` (marks after the label: badges), drawn inside its button after the label
(`.list-open.has-extra`: a row of the label, cut with an ellipsis, then the marks, 6px apart), and
`onContextMenu`, for the row's right-click.

### Search field

A list's search (`SearchField`, `design/search.jsx`), at the top of a sidebar section's body and kept
there as the list scrolls (`position: sticky`, on `--bg`, 6px under it): a `.input.search-input` 28px
tall, mono 11px, with the `search` icon (a magnifier, 14px, `--muted`) inside at its left and, once
there's text, a ghost `×` (`#<id>Clear`, 24px) inside at its right; Esc clears it (and isn't passed
on). Its placeholder says what it searches ("Search by name or date").

| Name | Proposed drawing (SVG paths) | For |
|---|---|---|
| `search` | `<circle cx="7.75" cy="7.75" r="4.75"/><path d="M11.25 11.25l4.25 4.25"/>` | A search field |
| `bell` | `<path d="M4.5 13V8.5a4.5 4.5 0 0 1 9 0V13l1.5 1.5H3z"/><path d="M7.5 16h3"/>` | Notifications |


### Toasts under the top bars

`<Toasts anchor="scroller" />`: with an `anchor` (an element's id), the toasts sit at that element's
top right, 8px in (16px from its right edge), instead of the window's: the app anchors them to the
thread (`#scroller`), which starts under the top bar and ends at the panel, so a toast never covers
the top bar's, the panel's, a dock's or the message box's controls (the panel's back and ×
especially). Where the panel overlays the thread (small screens) and leaves it too narrow for one
(less than 240px), they take the thread's whole width under the top bar. While a modal is open they
go back to the window's top right (over the backdrop, above the modal, as before). Width, look and
motion are unchanged.

### Console when empty

An open console with no lines (none written yet, or all cleared, or all hidden) shows a note in
place of the log (`.note.console-empty`, `No lines yet: what the app does is logged here.`),
centred, 14px above and below, and its body is as tall as the note, not `--console-h`; its top edge
doesn't resize it (as the timeline's empty state).

### Message box problems

- **Known before sending:** the provider the message would go to has a problem the app can see (its
  fixtures can't be read, name one twice, or name one the app hasn't got; a provider plugin that
  isn't there). It's said only in the panel, by the provider, under its fixtures
  (`.hint.error.fixtures-hint#convFixturesProblem`, `role="alert"`: `<provider>: <the problem>`, then
  `edit the provider`, an `.inline-link` to Settings → Providers, `#convFixturesFix`), in place of the
  fixtures' own line for the same thing (a list that names one twice, or can't be read); not under the
  box, nor in the top bar. Send is off meanwhile, its `title` the reason (`Can't send: …`).
- **Refused when sent:** under the message box (`footer.composer`), in the place of a field's problem
  (`.hint.error.field-problem#sendProblem`, `role="alert"`): the engine refused the message before
  sending it (a provider that can't load), and the message is put back in the box (unless something
  else has been typed since). A message that was sent stays in the thread as a turn, whatever happened
  to it.

### Settings: the head stays, and unsaved edits are asked about

- The content's head (`.settings-content-head`: the title, its count and `clear all`) stays at the
  top of the content as it scrolls (`position: sticky`, on `--bg`), so the close button, which sits
  over the head's right end, never floats over a field.
- A pane can say that leaving would lose something (`guardSettings(fn)`: `fn()` returns a question,
  or nothing): Settings → Providers' YAML when it doesn't parse. Closing (×, Esc, the backdrop),
  another option, or the pane's own back is refused the first time: the close button turns into
  `discard edits?` (a ghost button in `--danger`, as a ConfirmButton asking), and the pane says why
  under the field. Trying again goes ahead. Changing the text asks again next time.

### New suite form

The Suites section's `+` (`#newSuite`) doesn't make a file at once: it opens a row at the top of the
section's body (`form.controls.new-suite-form#newSuiteForm`, above the search): an `.input.grow`
(`#newSuiteName`, 28px as the search field, its placeholder the next free name: `tests`, then
`tests-2`), and `add` (`.btn`, 28px, submits); under it a `.hint` with the file it makes and the
provider it will use (`tests.hafen.yml · provider mock`: the conversation's, else the one used last,
else the first). Enter adds, Esc (or `+` again) closes it. A name that won't do says why under it
(`.hint.error.field-problem`), as Save as test's Suite name does; an empty name takes the
placeholder's.

### List rows: the count is cut first

In the Suites list a suite's row size (`2 tests · 1 failed`) is cut, with an ellipsis, before its name is:
the name keeps its width first (`.list-open` `flex: 1 1 auto`), the size gives way first (`flex-shrink`
1000, at least 5 characters wide). Its full text is in the row's `title`.

### The thread's first steps

The app keeps its own work, so there's nothing to open first. A new conversation with no turns yet
(the first start among them) has the thread's note (`.empty#threadEmpty`) with the first steps under
it as buttons (`.empty-actions`: a row, centred, wrapping, 8px apart, 14px under the note): `Add a
provider` (`#threadAddProvider`: Settings → Providers' new provider), `New conversation`
(`#threadNewConversation`: the sidebar's `+` does the same) and `New suite` (`#threadNewSuite`: the
Suites section's [New suite form](#new-suite-form), opened, and the sidebar with it). The next step
to take is the primary (`.btn-primary`): `Add a provider` while there's none; with one, none is (the
message box is). The Suites section's note offers Import as a link in its text (`No suites yet: press +
to start one, or import some from files or a folder.`, `#suitesImport`, `.btn.btn-ghost.inline-link`,
opening the Import items under it, as the head's [`import`](#suites-import-and-export) does). The panel's
`add one` (a provider) opens the new provider form.

### Suites import and export

Importing and exporting suites: ghost text actions in the Suites section's head after `+`, as Runs'
`open` and `clear all` are (`.when-open`: shown only while the section's open). `import`
(`#importSuites`, `aria-haspopup="menu"`) opens a [context menu](#context-menu) under itself (as one
opened from the keyboard is): `Import suite files…` (`#menu-import-files`, its hint `*.hafen.yml`) and
`Import a folder…` (`#menu-import-folder`, `its suites`); each picks with the system's own picker (the
desktop app's dialog; a browser's file or folder picker), then goes on in the app, asking a
[question](#question-dialog) when files there have another text. `export all` (`#exportSuites`, shown
only with a suite, as `clear all` is only with something to clear) opens the [Export
dialog](#export-dialog) for every suite.

### Question dialog

A question asked part way through something the user started (Import: files that are here already
with another text; Export: files in the folder already; the first start of this version: import the
suites of the folder the app opened before?): a [modal](#modal) (`#question`, `.modal.question`),
`min(480px, 100vw − 32px)` wide.

| Part | Is |
|---|---|
| Head | The modal's: a `.label` (`IMPORT`, `EXPORT`, `YOUR SUITES`), then close (`#questionClose`) |
| Body | `.question-body`: padded `--gutter`, a column 10px apart, scrolling when it's taller than the window allows. First the question as a `.note` (`#questionNote`: `1 file from repo is here already, with another text:`), then what it's about as a `.panel-code` list (`#questionFiles`, one path a line, at most 200px tall, scrolling), then a `.hint` saying what each answer does (`#questionHint`) |
| Foot | The modal's: one `.btn` per answer, the one that changes nothing first (`Cancel`, `Not now`), the main one last and primary (`Replace`, `Overwrite`, `Import`), focused as it opens. Import's: `Cancel`, `Skip`, `Keep both`, `Replace` (`#questionCancel`, `#questionSkip`, `#questionBoth`, `#questionReplace`); Export's: `Cancel`, `Overwrite`; the folder before: `Not now`, `Import` (`#questionLater`, `#questionImport`) |
| Closed | Esc, ×, or a click on the backdrop answer what changes nothing |

### Export dialog

Export (a suite panel's `Export…`, `#suiteExport`; the Suites head's `export all`; Copy CI command
before the suite has been exported): a [question dialog](#question-dialog)'s box (`#exportDialog`,
`.modal.question`), its head `EXPORT` and close (`#exportClose`).

| Part | Is |
|---|---|
| Body | A `.note` (`#exportNote`): what's written, and where it goes (`Writes smoke.hafen.yml and everything it uses to a folder you pick, as plain files with the same paths: …`); a `.field-head` with a `.hint` (`4 files, never a secret`), 4px over the files as a `.panel-code` list (`#exportFiles`, `Reading what they use…` until they're known); a `.hint.error` for each file a suite names that isn't there, a `.hint` for plugin packages (not files); then, when Globals or the scope chosen has values, a `.check` (`#exportEnv`, on) naming the files it writes, only the ones with values, Globals' first (`Also write globals.env and stage.env: the values of Globals and of the stage scope`), else a `.hint` (`#exportNoScope`) saying there are none to write; with secrets kept for either, a `.hint` (`#exportSecretsHint`) naming the files Export with secrets writes (`globals.secret.env and stage.secret.env`) in plain text, to keep out of version control; and where it was last exported (`#exportLast`, `.hint`) |
| Foot | `Cancel` (`#exportCancel`), `Export with secrets` (`#exportWithSecrets`, a ConfirmButton asking `write them in plain text?`, only with secrets kept), and `Export` (`#exportGo`, primary). Each then asks for a folder; done, the dialog closes and a toast says where they went |

The suite's panel says where it was last exported to under Copy CI command (`#suiteCiHint`: `Runs
hafen-tests, exported 2 mins ago with globals.env and stage.env: export again after a change.`),
naming only the files that export wrote, which are the ones the command names; not exported yet,
that it isn't, with `Export it` as an `.inline-link` (`#suiteCiHintExport`), and Copy CI command
opens the Export dialog instead of copying.

### Scope panes

Settings → Environments and Settings → Secrets are alike, as an API client's environments are: the
entries down the left, the one picked on the right (`.scope-panes`, a flex row; at 640px and narrower,
where Settings stacks, a column: the entries above, a line under them instead of beside).

Neither says how it works in words: no note under the title, none under the table. The one line kept
is a warning, on Secrets only, while its values are kept unencrypted (`.note#secretsNote`, one line,
over the panes): in the browser build `Kept in this browser's storage, unencrypted: use the desktop
app for keys that matter.`, in the desktop app on a system that offers it no encryption `Kept
unencrypted: this system offers the app no encryption yet.`

The panes fill the rest of the content (`flex: 1 0 auto`), and, last in it, run to its bottom edge (its
20px bottom padding taken into them: `margin-bottom: -20px`, each side padded 20px at its bottom), so
the line down the entries' right runs the whole height, however little the entry has.

Every action in them is a [button](#buttons), outlined (`.btn`), never a ghost one: 28px tall, as the
fields beside them, and 24px in a label row (the entries' heads, the table's head). Icon-only ones are
`.btn.btn-icon`, square (28×28; 24×24 in the entries). One that asks first is a ConfirmButton, which
asks with its text, as `Export with secrets` does.

**The entries** (`nav.scope-list`: 168px wide, a 1px `--line` down its right, 12px between it and
the entry; a column):

| Part | Is |
|---|---|
| Head | `.scope-list-head`: a row 32px tall, padded `0 0 0 8px`: a `.label` (`GLOBALS`, `SCOPES`), and its action at the right: Scopes' `+` (`#newScope`, `.btn.btn-icon` 24×24, the `plus` icon at 14px, `aria-expanded` while its form is open) |
| Globals | A [list](#list) of one row (`#envGlobals`, `#secretsGlobals`), pinned at the top: what applies in every scope, and alone when none is chosen |
| Line | `.scope-list-line` (`role="separator"`): 1px `--line`, 8px above and below |
| Scopes | A list (`#envScopes`, `#secretsScopes`) of rows (`#envScope-<name>`, `#secretsScope-<name>`), in the order they were made |
| A row | A [list row](#list) with no `×` (32px; sans 13px `--muted`; `--fg` on `--soft`, `aria-current`, when it's the entry shown): its name, cut with an ellipsis; after it (`extra`) on the scope chosen, the `check` icon (14px, `--fg`, its `title` `Chosen now`); at its right its `.list-size`: how many names the open files use that it hasn't got, Globals' counted in (`2 not set`, `--danger`), else nothing; then, on a scope, `more` (`.list-more`, `#<row id>-more`: `.btn.btn-icon` 24×24, the `more` icon at 14px, over the row's right end, 4px in from it and its top, on the row's background, shown only while the row's pointed at or it's focused, so it takes no room from the name; on touch screens, always, after the size), which opens its [context menu](#context-menu) under it, as a right-click on the row does |
| New scope | Under Scopes' head, while `+` has it open (and always while there are no scopes): `form.controls.new-scope-form#newScopeForm`, as the [New suite form](#new-suite-form): an `.input.grow` (`#newScopeName`, 28px, mono 11px, its placeholder `stage, prod…`) and `add` (`.btn`, 28px); a name that won't do says why under it (`.hint.error.field-problem#newScopeProblem`). Enter adds it and shows it; Esc (or `+` again) closes it |
| No scopes | A `.note` under the form, padded `4px 8px` (`#environmentsEmpty`: `No scopes yet: add one (stage, prod…).`) |

A scope's menu (`<name>: what to do`): `Choose it` (`#menu-scope-choose`; disabled on the scope
chosen), `Rename` (`#menu-scope-rename`: the scope shown, its name field focused, its text selected),
`Duplicate` (`#menu-scope-duplicate`: a new scope, `<name>-copy` (or `-copy-2`…), with its values and
its secrets, shown), a line, then `Delete` (`#menu-scope-delete`, `.danger`, asking `Click again to
delete its values and secrets`).

**The entry's head** (`.scope-head`: a row at least 32px tall, its items centred, gap 8):

| Part | Is |
|---|---|
| Name | A scope's: its name field (`.input.scope-name-field`, `#envScopeName`, `#secretsScopeName`, named `Scope name`): sans 13px 500 `--fg`, 32px, its border `transparent` until pointed at (`--line`) or focused (`--fg`), padded `0 8px` and pulled 8px left, so its text lines up with the table's; it takes the width left. Enter, or leaving it, renames; Esc puts it back. Globals': `h3.scope-title`, `Globals`, sans 13px 500 (`.settings-subtitle`'s), taking the width left |
| Chosen | On a scope: `choose it` (`.btn`, 28px, `#envChoose`, `#secretsChoose`), or, when it's the one chosen, `chosen now` in its place (`.btn`, disabled, `#envChosen`, `#secretsChosen`). On Globals: `choose no scope` (`.btn`): Globals alone; or, when none is chosen, `no scope chosen` (`.btn`, disabled) |
| More | On a scope: `more` (`#envMore`, `#secretsMore`, `.btn.btn-icon` 28×28, the `more` icon at 14px): its menu, under it |

**Its tools** (`.scope-tools`: a row 10px under the head, its items centred, gap 8, wrapping, 8px
between its lines): `import .env` (`#envImport`, `#secretsImport`, opening a hidden file input),
`export .env` (`#envExport`, its `title` the file it downloads; Secrets' `#secretsExport` a
ConfirmButton asking `write them in plain text?`, its `title` `Write stage.secret.env, in plain text`)
and `edit as .env` (`#envText`, `#secretsText`: the large editor, code style), each a `.btn` 28px; then
the [search field](#search-field), taking the rest of the row and at least 200px of it (here not
sticky, nothing under it; `#envSearch`, `#secretsSearch`, its placeholder `Search variables` or `Search
secrets`), so at Settings' width it's a line of its own under the buttons, as wide as the table it
searches.

**Its table** (`.vars`, `role="table"`, 10px under the tools): one row a name, on a grid of three
columns, 8px apart, which every row shares (`grid-template-columns: subgrid`): the name (as wide as
the widest name needs, at most 25%: `fit-content(25%)`), its value (all the rest: `minmax(0, 1fr)`),
and where it comes from, last (as wide as its words need, at most 68px: `fit-content(68px)`, its words
wrapping). A row's buttons are in its value's cell, after the value: the value takes what they leave,
so they take nothing from the other rows, and a long value (`https://stage.acme.example`) shows whole
at Settings' width.

| Part | Is |
|---|---|
| Head | `.vars-head` (`role="row"`): 32px, a 1px `--line` under it; a `.label` a column (`role="columnheader"`): `VARIABLE`, `VALUE`, `SOURCE` (Secrets: `NAME`, `VALUE`, `SOURCE`; the value's followed by `show all` or `hide all`, `#secretsRevealAll`, a `.btn` 24px tall) |
| Row | `.vars-row` (`role="row"`, `#envVar-<name>`, `#secret-<name>`, `data-source`: `own`, `override`, `globals` or `unset`): at least 44px, padded `6px 0`, a 1px `--line` under it, so rows are divided |
| Name | Sans 13px `--fg`, one line with an ellipsis (`.vars-name`), over a `.hint` (`.vars-use`): how a file uses it (`{{env.base_url}}`, `{{secret.API_KEY}}`), with ` · not used by the open files` when they don't |
| Value | `.vars-cell`: a row, 4px apart, the value taking the width its buttons leave. An `.input` 28px (mono 12px), saved when it's left or on Enter; Esc puts it back. A secret's is a password field, empty, its placeholder `••••••••` (never its value) until `show` (`#secret-<name>-reveal`, `.btn` 28px, after the field) puts the value in it as text, until `hide`; `show all` shows every row's. An empty value left changes nothing (`forget` forgets) |
| Buttons | After the value (and a secret's `show`), at the cell's right end: `×` (`#envVar-<name>-delete`, `.btn.btn-icon` 28×28, a ConfirmButton asking `delete`, as wide as the question while it asks), a secret's `forget` (`#secret-<name>-forget`, `.btn`, asking `forget it?`); an inherited row's `override` (`#envVar-<name>-override`, `#secret-<name>-override`, `.btn`: a value of the scope's own, from Globals' (a secret's: the add row, its name in, its value focused)) |
| Source | A `.hint` (`.vars-source`), wrapping: `this scope`; `overrides Globals` (Globals has the name too); `from Globals` (inherited: the row's name and value `--muted`, its value as text (`.vars-value`, mono 12px, one line, padded as a field's), not a field); `not set` (`--danger`: the open files use the name, and neither the entry nor Globals has it; its field's placeholder `its value`); on Globals' own rows `Globals`, then `· overridden in stage, prod` when scopes have their own |
| Add row | The last row, always there (`form.vars-row.vars-add`, `#envVarAdd`, `#secretAdd`): the name (`.input`, 28px, `#envVarName`, `#secretName`, its placeholder `New variable` or `New secret`) and the value (`#envVarValue`, `#secretValue`, its placeholder `its value, then Enter`; a secret's a password field), and no button: Enter in either adds it, then the name is focused for the next. An environment's value may be empty; a secret's may not, so Enter with no value goes to the value (and, with no name, to the name). A name that won't do says why, in the pane's error |
| Nothing | No rows: a `.note` row (`#envVarsEmpty`, `#secretsEmpty`), padded `12px 0`, a line under it: what goes here; a search that matches none: `No variables match "x".` |

The rows go: the entry's own, in the order they were added; the names the open files use that neither
it nor Globals has (`not set`), by name; then, on a scope, Globals' it doesn't override (`from
Globals`). The search keeps the
rows whose name, or (an environment's) value, has its text, case aside; the add row always stays.
An error from the pane is a `.hint.error` (`role="alert"`) under the tools. Under the table, only what
the state needs: on Secrets, the names a provider's fixture gives when a run starts, while there are any
(`#secretsFromFixtures`, a `.hint`). On a scope, the entry ends with its foot, as the panel's
(`.panel-foot`: 16px above, a line, 12px under it): `Delete scope` (`#envDelete`, `#secretsDelete`, a
`.btn` 28px at its left, a ConfirmButton asking `delete its values and secrets?`).

Secrets kept for names that aren't scopes now (Settings → Secrets, under the panes, only while there
are any) are a `.settings-list` under their own `.field-head` (a `.hint`: `Secrets of scopes that no
longer exist`), one `.settings-row` per name: the name over a `.hint` of its secrets' names (`API_KEY,
TOKEN`; never a value), and `delete`, a `.btn` ConfirmButton asking `delete its secrets?`.

### Run error

A run that broke off before it reached its tests (refused before sending anything, or a provider's
fixture or a suite's setup that failed) has no turns to show: the thread shows why where they would be,
above a test's turns (as the file has them, not run by it), above a suite's tests, or alone in an open
run. It's laid out as a [turn group](#turn-groups-and-row-hover) but isn't one: nothing in it to pick,
so no hover and no pointer.

```html
<section class="run-error" id="runError" data-status="error" aria-label="The run: couldn't run">
  <div class="turn-head"><span class="label">Run</span>
    <span class="hint turn-summary" data-status="error">couldn't run · nothing was sent · just now</span></div>
  <div class="msg-body error" id="runError-0">providers/acme.yml:2: {{env.base_url}} isn't set: …</div>
</section>
```

| Part | Is |
|---|---|
| Box | `section.run-error`: a turn group's (padded 14px 14px 18px, its edges 14px outside the column), 6px above the group after it |
| Head | `.turn-head`: `RUN` (a `.label` in `--fg`), then a `.hint` in `--danger`: `couldn't run · nothing was sent · just now`, or `error · 0.04 s · just now` |
| Why | One `.msg-body.error` each (sans, `--danger`), 6px apart: every problem the run's check found before sending (`<file>:<line>: ` first when it has them), or the error it broke off with (`auth.hafen.yml: the fixture "acme-login" (beforeAll) failed: …`) |


### Settings sections

A part of a Settings pane that opens and closes, as the sidebar's [sections](#collapsible-section)
do: Settings → Providers' `Fixtures` and `YAML`, so a provider shows its name and facts first, and
each long part only when it's wanted. `SettingsSection` (`design/collapsible.jsx`), on
`useCollapsible`: open or closed is remembered per section (`<app>.section.<id>`), the same for every
provider; until it's toggled, `defaultOpen` (Fixtures: open when the provider has any, or a problem with
them; YAML: closed). Code opens one as a click on its toggle would (`openSection(name)`, as the rail
opens a sidebar section): the pane does, to show what's wrong in it (YAML that doesn't parse, as it's
left or tried), or what a link asked for (a panel's fixtures `edit`).

```html
<div class="settings-sections">
  <section class="settings-section collapsible" id="providerFixturesSection" aria-labelledby="providerFixturesLabel">
    <div class="settings-section-head collapsible-head">
      <button class="collapsible-toggle" id="providerFixturesToggle" aria-expanded="false" aria-controls="providerFixturesBody">
        <span class="chev"></span><span class="label" id="providerFixturesLabel">Fixtures</span>
        <span class="hint settings-section-summary" id="providerFixturesSummary">acme-login → reset-cart</span>
      </button>
    </div>
    <div class="settings-section-body collapsible-body" id="providerFixturesBody">…</div>
  </section>
  …
</div>
```

| Part | Is |
|---|---|
| Run | `.settings-sections`: the sections one after another, nothing between them, out to the content's edges (`margin: 0 -20px`, as its sticky head is), 6px more than the content's gap above and below it, a 1px `--line` under the last |
| Section | `.settings-section.collapsible`: a 1px `--line` on top. Open: the open bar (2px `--fg` down its left edge, 5px beside its head), as a sidebar section's |
| Head | `.settings-section-head.collapsible-head`: 40px (a section head's), padded `0 20px 0 12px`, so with the toggle's own 8px its arrow lines up with the pane's text. The toggle (`#<name>Toggle`, `aria-expanded`, `aria-controls`) takes the width: the arrow, the `.label` (`#<name>Label`: `FIXTURES`, `YAML`; `--muted`, `--fg` open or pointed at) and, only while it's closed, what's in it: `.hint.settings-section-summary` (`#<name>Summary`), one line cut with an ellipsis, `--muted` (`acme-login → reset-cart`, `kind: http · 12 lines`, `none yet`), in `--danger` (`.error`) when what's in it has a problem (`… · has problems`, the YAML's `Not saved` reason) |
| Body | `.settings-section-body.collapsible-body` (`#<name>Body`): padded `0 20px 16px`, a column 10px apart, as the content is; what's first in it isn't spaced from its top. Closed, it isn't shown, but stays in the page (a field in it keeps what's typed) |

### Segmented choice

A setting with a few values, all shown, one chosen: Settings → Appearance's theme (`Light`, `System`,
`Dark`). `SegmentedChoice` (`design/select.jsx`): the [segmented](#segmented) group as a radio group,
`div.segmented[role=radiogroup]` (named by its field label, `aria-labelledby`), in a `.controls` row
so it's as wide as its values, a `button[role=radio]` for each (`aria-checked`; an id each:
`#themeLight`, `#themeSystem`, `#themeDark`), each with a `title` saying what it does.

```jsx
<SegmentedChoice id="themeChoice" labelledBy="themeLabel" value={theme} onChange={setTheme}
                 options={[["light", "Light", "Always light", "themeLight"], …]} />
```

| Rule | Value |
|---|---|
| Look | The segmented's: an outlined 32px group, 1px `--line` between the values, mono 12px 500, padded `0 12px`; the buttons have no fill or border of their own |
| Chosen | `[aria-checked="true"]`: filled `--fg` with `--bg` text, as the segmented's current one |
| Others | `--muted`, `--fg` on hover; the pointer |
| Focus | The segmented's: a 1px `--fg` outline, 2px inside |
| Keys | As a radio group's: only the chosen one takes Tab; ←/→ (and ↑/↓) move to the next value round, and choose it; Home and End, the first and last. A click chooses |

### Settings groups

A Settings pane with several settings (Notifications) keeps them in groups, each under its name, a
line between them, as the [scope panes](#scope-panes) head their parts (`GLOBALS`, `SCOPES`):
`SettingsGroup` (`design/collapsible.jsx`, beside `SettingsSection`; `{ id, label, state }`):

```html
<section class="settings-block" id="notifySoundGroup" aria-labelledby="notifySoundGroupLabel">
  <div class="settings-block-head"><h3 class="label" id="notifySoundGroupLabel">Sound</h3></div>
  …its settings
</section>
```

| Part | Is |
|---|---|
| Group | `section.settings-block`: a 1px `--line` on top, its settings in a column under its head, 6px more than the content's gap under the last |
| Head | `.settings-block-head`: a row 32px tall (as `.scope-list-head`): its name as a `.label` (`h3`, `SOUND`, `FOR RUNS THAT`, `SYSTEM NOTIFICATIONS`) at the left, and at the right what it needs to say about them all (a `.hint`: the browser's permission) |
| In it | Its fields as anywhere (a field's label row, a select, `.check`s); a `.hint` 6px under what it explains |
| Last | The pane's own actions (Notifications' `Try it`) after the last group, under a line of their own: a group with no head (`.settings-block`), its `.controls` 12px under the line |
