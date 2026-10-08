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
| `couldn't run` (eval) | `--danger` | As `error` (its `data-status`), with why after it where there's room: `couldn't run: <the first problem>` |
| `skipped` | (none) | Faded to opacity .55 |
| `stopped` | `--muted` | Text only |

Lists colour their `.list-size` by the row's `data-status` (as hafen does: app.css:66–69,
build.css:24–26). A page whose rows have statuses adds the same rules for its list.

**One set of words** (eval): a run, a test and a turn say how they went in the engine's words
(`passed`, `failed`, `error`, `stopped`, `skipped`; `unsure`, a pass the judges weren't sure of), and
`couldn't run` for a run refused before it sent anything; the same word wherever it shows (the top
bar, the Suites tree, a suite's count, Runs, a toast). A run of one test says the test's word. A run
that broke off before its test (an error, or couldn't run) is that test's last try, shown in place of
the run before it; an error says why in its `title` where the line has no room. Stopped is never
coloured as a failure.

While anything runs on a page, `<html>` has `data-running`.

## Deleting and clearing

- Nothing is deleted on one click. Every delete is a `ConfirmButton`: the first click asks, the
  second deletes; moving away cancels.
- **A row:** `×` at its right (shown on hover), asking `delete`.
- **Everything in a section:** a ghost `clear all` in its head, shown only while it's open and has
  something, asking `delete every <thing>?`.
- **The selected thing:** a ghost `Delete <thing>` at the panel's foot, asking `delete this
  <thing>?`, `--danger` on hover.
- **Forgetting a kept value** (a secret, a key) is a delete: a ghost `forget` ConfirmButton,
  asking `forget it?`.
- (eval) **In the [scope panes](components.md#scope-panes)** (Settings → Environments, Secrets) every
  one of these is an outlined `.btn` (a row's `×` a `.btn.btn-icon`), as all their actions are, never
  a ghost one; each still asks first, with its text.
- **Writing secrets out in plain text** (a secrets file's export) asks first, as a delete does: a
  ConfirmButton whose question says so (`write them in plain text?`), with a `.hint` beside it saying
  where the file goes and to keep it out of version control (in the scope panes, which have no notes,
  the button's `title` says where it goes).
- Deleting something that's in use says why it can't, in the console (`stop the run before
  deleting it`), and doesn't delete it.
- **Edits that can't be saved** (YAML that doesn't parse) are never thrown away on one action: what
  would leave them (closing Settings, another option, back) asks first, as a delete does: the first
  try is refused, says why where they are, and the close button asks `discard edits?`; the second
  goes. An action that only uses them (**Try it**) is refused, and says why, every time. Edits that
  can be saved are saved as they're left.

## Remembered state

What the user sets up stays as they left it, in localStorage under the project's prefix
(`<app>.*`), with every key listed in one `KEYS` object (`lib/store.js`):

| Key | What |
|---|---|
| `<app>.section.<id>` | Each collapsible section and dock, open or closed |
| `<app>.navCollapsed`, `<app>.navWidth` | The sidebar collapsed (wide screens), its width |
| `<app>.consoleHeight` (and each dock's height) | The console's height |
| `<app>.theme` | Light, dark or system (unset: the system's) |
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
- **The first steps are controls, not only words** (eval): where the note's way to start is an
  action (add a provider, start a conversation, a suite), the thread's note has them as buttons under
  it, the next one to take the primary, and a section's note has its own as a link in its text
  (`.inline-link`: import some). Nothing asks for a step that isn't needed: the app keeps its work
  itself, so there's nothing to open before anything can be added.
- **Placeholders say what's missing**, never something that looks like a value (`No tags yet`, not
  `smoke, refunds`).
- **Nothing chosen** (eval): a control that shows a choice the page needs (the scope), with none made,
  shows no words: its icon alone, greyed out as a disabled field is, with a small `!` badge over the
  icon's top right corner ([Scope button](components.md#scope-button)). It still opens the choice, and
  its `title` and `aria-label` say that nothing's chosen.
- **Loading the page:** the loader, for at least a second, so every load looks the same.
- **Waiting on work:** the progress cursor (`whileBusy`), a blinking badge dot, a status line
  (`#status`) or a row's status.
- **Progress:** in the console, a progress line updates in place instead of adding lines.
- **Long jobs** go on in the background, and announce themselves when they end with a toast (and a
  chime when done or failed). One that ends within a few seconds isn't announced.

## Errors

- What went wrong is said where it happened, in `--danger`: a field's note (`.hint.error`, with
  `role="alert"`), a status line, an output block, a row's status.
- The console gets the details (`say(text, "err")`), once per change: a file read again with the
  same problems doesn't log them again.
- An error never leaves the page stuck: work that fails is recorded as far as it got.
- **Nothing typed is lost** (eval): a message that couldn't be sent stays in the box, the reason
  under it ([Message box problems](components.md#message-box-problems)). A problem known before
  sending (a provider whose fixture isn't there) is said in the panel, by the provider, before you
  send, and Send is off.

## Addresses

- The page's address says what's open, with `?tab=<section>&_id=<_id>`, so a link or a reload
  opens it again, and Back and Forward step through what was opened (`lib/url.js`).
- Following an address that names something that isn't there says so in the console and leaves the
  page as it is.

## Exports

A thing that can be saved to a file has `export JSON` (a ghost button in its head, or a button in
its panel), which downloads `<_id>.<app>-<kind>.json`.

(eval) Suites go out to a folder the user picks, with everything they use, as plain files
(`Export…`, the [Export dialog](components.md#export-dialog)); files in it already are listed and
asked about first, and secrets go only when asked for in plain text, as a delete asks. They come in
the same way (Import: files or a folder picked, the Suites head's
[`import`](components.md#suites-import-and-export)), a file here already with another text asked
about once.

## Keyboard and pointer

| Input | Does |
|---|---|
| Esc | Stops what's running; closes the drawer, a modal, the tooltip |
| Enter / Shift+Enter | In the message box: send / new line |
| Enter | (eval) In a scope pane's last row (a name and its value): adds it; there's no add button |
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
