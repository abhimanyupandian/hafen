# Patterns

Conventions that hold across the components, taken from hafen's UI. A project that reuses the
system follows them as closely as it follows the tokens.

## Status

One set of words and colours for anything that runs.

| Status words | Colour | Where it shows |
|---|---|---|
| `waiting`, `queued` | `--wait` | Text: a row's size, a card's status. Fill: `--wait-soft` with `--wait-line` |
| `running` | `--run` | Same, with `--run-…`; badges blink |
| `done`, `passed` | `--ok` | Same, with `--ok-…` |
| `error`, `failed`, `interrupted` | `--danger` | Same, with `--bad-soft`, `--bad-line` |
| `skipped` | (none) | Faded to opacity .55 |
| `stopped` | `--muted` | Text only |

Lists colour their `.list-size` by the row's `data-status` (as hafen does: app.css:66–69,
build.css:24–26). A page whose rows have statuses adds the same rules for its list.

While anything runs on a page, `<html>` has `data-running`.

## Deleting and clearing

- Nothing is deleted on one click. Every delete is a `ConfirmButton`: the first click asks, the
  second deletes; moving away cancels.
- **A row:** `×` at its right (shown on hover), asking `delete`.
- **Everything in a section:** a ghost `clear all` in its head, shown only while it's open and has
  something, asking `delete every <thing>?`.
- **The selected thing:** a ghost `Delete <thing>` at the panel's foot, asking `delete this
  <thing>?`, `--danger` on hover.
- Deleting something that's in use says why it can't, in the console (`stop the run before
  deleting it`), and doesn't delete it.

## Remembered state

What the user sets up stays as they left it, in localStorage under the project's prefix
(`<app>.*`), with every key listed in one `KEYS` object (`lib/store.js`):

| Key | What |
|---|---|
| `<app>.section.<id>` | Each collapsible section and dock, open or closed |
| `<app>.navCollapsed`, `<app>.navWidth` | The sidebar collapsed (wide screens), its width |
| `<app>.consoleHeight` (and each dock's height) | The console's height |
| `<app>.theme` | Light, dark or system |
| `<app>.active…` | What was open |

A remembered size that equals the default is removed rather than stored. Storage that fails
(private windows) fails quietly: the page works with the defaults. Other tabs follow changes
(`storage` events).

## Ids and names

- Every control has an `id` and an accessible name (`aria-label` or a `<label>`).
- Ids are camelCase and say what the thing is: `#newTest`, `#clearRuns`, `#testRun`,
  `#consoleToggle`. A section's are `#<id>`, `#<name>Toggle`, `#<name>Label`, `#<bodyId>`.
- Rows, cards and editors have ids made from what they show: `#<kind>-<_id>`, with `-open` and
  `-delete` for their buttons.
- Regions, dialogs, separators, tabs and logs have their roles (`role="log"`, `separator`,
  `tablist`, `status`).
- Data that lives in the app has an `_id` the user can see and copy (an `IdField`), and the address
  uses it.

## Words

- **Ghost actions are lowercase:** `clear all`, `copy`, `clear`, `export JSON`, `show the request`.
  Panel deletes are sentence case: `Delete test`. Primary buttons are written in sentence case and
  shown uppercase by CSS (`Run` → `RUN`).
- **Labels** are written in sentence case and shown uppercase (`Runs` → `RUNS`).
- **Notes say what to do:** `No runs yet. Each run is recorded here.`
- **Statuses are lowercase words**: `done`, `running…`, `skipped: <reason>`.
- **Separator:** ` · ` between parts of one line: `run 2 · 1.2 s · 120 in · 48 out`.
- **Symbols:** `×` deletes, `+` adds, `↗` opens a link elsewhere, `…` for something in progress
  or cut short, `→` for "goes to", `✓` / `✗` for matched or not.

### Numbers

| What | Format | Example |
|---|---|---|
| Durations | seconds, one decimal, a space before `s` | `1.2 s` |
| Tokens | `<in> in · <out> out` | `120 in · 48 out` |
| Speed | one decimal | `48.2 tok/s` |
| Sizes | GB with one decimal, MB and KB whole | `1.2 GB`, `45 MB`, `3 KB` |
| Times | 24-hour; today's as the time, earlier days as date and time | `14:02:11`, `Oct 3, 14:02` |
| Counts | the word in the singular for 1 | `1 test`, `3 tests` |
| Percentages | whole numbers | `45%`, `100%` |

## Empty, loading and busy

- **Empty:** a `.note` where the content would be, saying what goes there and how to add it. A
  `clear all` hides when there's nothing to clear.
- **Loading the page:** the loader, for at least a second, so every load looks the same.
- **Waiting on work:** the progress cursor (`whileBusy`), a blinking badge dot, a status line
  (`#status`) or a row's status.
- **Progress:** in the console, a progress line updates in place instead of adding lines.
- **Long jobs** go on in the background, and announce themselves when they end with a toast (and a
  chime when done or failed). One that ends within a few seconds isn't announced.

## Errors

- What went wrong is said where it happened, in `--danger`: a field's note (`.hint.error`, with
  `role="alert"`), a status line, an output block, a row's status.
- The console gets the details (`say(text, "err")`).
- An error never leaves the page stuck: work that fails is recorded as far as it got.

## Addresses

- The page's address says what's open, with `?tab=<section>&_id=<_id>`, so a link or a reload
  opens it again, and Back and Forward step through what was opened (`lib/url.js`).
- Following an address that names something that isn't there says so in the console and leaves the
  page as it is.

## Exports

A thing that can be saved to a file has `export JSON` (a ghost button in its head, or a button in
its panel), which downloads `<_id>.<app>-<kind>.json`.

## Keyboard and pointer

| Input | Does |
|---|---|
| Esc | Stops what's running; closes the drawer, a modal, the tooltip |
| Enter / Shift+Enter | In the message box: send / new line |
| ⌘/Ctrl+Enter | In the large editor: save |
| Space + drag | Pan a scrolling chart or canvas |
| Ctrl/⌘ + wheel or pinch | Zoom around the pointer |
| Arrows (Shift for bigger steps), Home, End | Move a focused resize handle |
| Double-click a resize handle | Back to the default size |
| Tab | Every control is reachable; focus shows with a `--fg` border or outline |

## Where code goes

- `services/` (or the project's engine): logic with no DOM, which can run outside a page. Emits bus
  events when its data changes.
- `components/`: reusable UI with no knowledge of the app.
- The app's views: the parts of a page, which use services and components and talk through the
  event bus.
- Comments say what a thing is for and why, in plain sentences.
