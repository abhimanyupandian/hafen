# Contract: the app's UI

The Hafen app, built only from the [design system](../../design/README.md). Every part below
names the design-system component it is; the few new parts are the design system's
[Additions](../../design/components.md#additions). The same UI is the desktop app's window and the
browser build.

## The app

| | |
|---|---|
| Files | `evals/app/index.html` (the skeleton in [design/README.md](../../design/README.md#reusing-it-in-another-project)), `evals/app/js/main.jsx`, `evals/app/css/eval.css` |
| Title | `Hafen` |
| Address | `?tab=suites&_id=<test id>`, `?tab=conversations&_id=<conversation _id>`, `?tab=runs&_id=<run _id>`; nothing: the conversation (Back to it, from a test or a run, goes there) |
| Remembered state | `eval.*` keys ([patterns](../../design/patterns.md#remembered-state)) |

A part of the app that can't be drawn (a file written in a way nothing foresaw, say) says so in its
own place, `<what> couldn't be shown: <why>` with `try again`, rather than leaving the window blank:
each sidebar section, the thread (`#threadCrash`), the panel (`#panelCrash`) and the timeline on their
own. It's tried again when what's selected, or the folder's files, change.

```
┌─ sidebar ─────────────┬─ main ───────────────────────────────────────────────────────────────────┐
│ logo     [staging ▾]  │┌─ work ──────────────────────────────────────┬─ panel (340px) ──────────┐│
├───────────────────────┤│ ☰ title                         ▷  status  │ ICON  LABEL           ×  ││
│ ▾ SUITES        + …   │├─────────────────────────────────────────────┼──────────────────────────┤│
│   ▾ refunds.hafen.yml ││                                             │ fields, facts,           ││
│     ▾ refund for…  2/3││                                       user  │ JSON tree, …             ││
│        turn 1     6/6 ││   I want a refund for 4417                  │                          ││
│ ▾ RUNS      clear all ││                                             │                          ││
│   refund for…  failed ││   acme-support                              │                          ││
│ ▸ CHECKS              ││   + thinking · summary · 1.8 s              │                          ││
│                       ││   ↳ lookup_order · 0.4 s                    │                          ││
│                       ││   I'm sorry it arrived broken…              │                          ││
│                       ││   0.62 s to first token · 2.2 s · …         │                          ││
│                       ││   ● status 200  ● contains 4417  ● noul 0.91│                          ││
│                       │├─────────────────────────────────────────────┤                          ││
│                       ││ message box                         SEND    │                          ││
│                       │└─────────────────────────────────────────────┴──────────────────────────┘│
│                       │ ▾ TIMELINE   fit                                                          │
│                       │   (Gantt)                                                                 │
│ ⚙                   ▯ │ ▸ CONSOLE                                                                 │
└───────────────────────┴───────────────────────────────────────────────────────────────────────────┘
```

The frame is the design system's frame with a work area ([layout.md](../../design/layout.md#the-frame)):
the sidebar (`NavHead`, the sections, `NavFoot`, `NavResizer`), the `Scrim`; `main.main` with
`.work-area` (the `.work` column, holding the top bar, the thread and the message box, beside the
panel), then the Timeline dock and the `Console`, spanning the full width. Providers aren't in the
sidebar: they're in [Settings → Providers](#providers-settings).

**Collapsed** (wide screens: the design system's rail), the sidebar shows its sections as icons
(`.nav-rail#navRail`, a vertical toolbar between the head and the foot, each a ghost icon button
the foot's height, `--muted`, `--fg` on hover), in the sections' order: Conversations
(`#rail-conversations`, `chat`), Suites (`#rail-suites`, the `suite` icon), Checks (`#rail-checks`,
`check`) and Runs (`#rail-runs`, `runs`: a clock turning back, history's sign).

The sections, top to bottom: Conversations, Suites, Checks, Runs. A closed section shows its icon
where the arrow is (`chat`, `suite`, `check`, `runs`: 14px, `--muted`, `--fg` on hover, in the
arrow's place so the label doesn't move); an open one shows the arrow. A list row has a faint background
on hover (`--row-hover`: `--soft` at 55% over `--bg`), and `--soft` when it's the one open. One expands the sidebar, opens
that section if it's closed, scrolls to it and focuses its toggle.

## Sidebar

### Head

The logo at the left. At the right (`.nav-actions`), the **scope button** (`#scopeButton`, the
`scope` icon and the scope chosen, or "no scope": [Scope button](../../design/components.md#scope-button)).
A click opens Settings on Environments, where the scope is chosen (`Scope`, `.select#envScope`, then
`choose it`) among every scope there is: the folder's scope files (`environments/<scope>.yml`), the
open suites' environments, and the scopes that have secrets (known before a folder is open, so one of
those can be chosen with none open). The chosen one fills `{{scope.NAME}}` (its plain variables, then
its secrets) and picks the suites' environment of that name; it applies to runs and the message box
(as `--env` does in CI). The one chosen last is chosen again (after a reload, before a folder is
open); when none was, a folder's first environment is.
In the desktop window the logo is hidden and the button stays at the right, as the design system
says.

### Suites

`NavSection id="suitesSection" name="suites" label="Suites" bodyId="suitesBody" defaultOpen`.

- **Head actions:** `+` (`#newSuite`, ghost icon, "New suite": a new suite file each time,
  `tests.hafen.yml`, then `tests-2.hafen.yml`, …, with one test, using the first provider; the test
  opens); `open a folder` (`#openFolder`, a ghost icon button: the `import` icon, a folder with an
  arrow into it) or `open files` (`#openFile`, the same icon, browser build), shown only while the
  section is open.
- **Body**, padded as list sections (`0 8px 12px`):
  - With any suites, a [search field](../../design/components.md#search-field) (`#suitesSearch`,
    "Search by name or last run", staying at the top as the list scrolls): every word typed must be
    found (any case, any order). A suite whose name or file has them shows whole; else only its tests
    that have them, in their name, their tags or when each last ran (written any of the ways
    [dates are searched](#searching-by-date)), their suite opened to show them even if folded; else
    it's left out. None: "No suite or test matches “…”." (`#suitesNoMatch`). `×`
    (`#suitesSearchClear`) or Esc clears it.
  - The tree: a `List` (`#suiteList`) of `ListRow`s with `.tree-toggle`s, 14px indent per level:

| Row | id | Label | Size (coloured by `data-status`) | Click | × asks |
|---|---|---|---|---|---|
| Suite | `suite-<n>` (`data-file`: its file) | Its `name`, if the file gives one, else the file name; then its [group badge](../../design/components.md#group-badge) (`G2`) when it has a `group`. Its tooltip: the name, the file, and when it last ran (`last run 2 mins ago`, or `not run yet`) | its tests' results: `3 tests · 1 failed`, or its problems; then `▷` (`#suite-<n>-run`, "Run the suite": the whole suite, shown in the suite's view) and `+` (`#suite-<n>-add`, "New test": a test at the end of this suite, opened), shown on hover as × is | Expands it; the panel shows the suite (and its problems) | `delete file?`, then deletes the file from the opened folder (in the browser build with files opened one by one, it's only closed) |
| Test | `test-<id>` | The test's name; then its group badge (`G1`, `#test-<id>-group`) and, when it repeats, its [repeat badge](../../design/components.md#repeat-badge) (`×3`, `#test-<id>-repeat`: its `repeat`, or its suite's default). Its tooltip: the name, `runs 3 times`, when it last ran | its last result: `passed 3/3`, `failed 2/3`, `unsure`, `running…`, `—`; then `▷` (`#test-<id>-run`, "Run <name>": runs the test, and opens it), shown on hover as × is, off while the test runs (alone or in its suite's run) | Opens the test in the thread; the panel shows the test | `delete` |
| Turn | `turn-<id>-<i>` | Its icon (`.turn-icon`: the `test` icon, a box with a tick, 14px), coloured by how the turn last went: `--ok` passed, `--danger` failed or error, `--wait` unsure, and `--wait` too for a turn with no checks (or every one turned off), run or not, as nothing says it's right; `--muted` not run; while it runs, a [spinner](../../design/components.md#spinner) in `--run` instead; then the message, one line. (Its button is named `turn <i>: <message>`.) | its checks, a check turned off not counted: `6/6`, or `6 checks` before it runs; `0 checks` in `--wait` | Scrolls to the turn; the panel shows it | `delete` |

  **Right-click** on a suite's or a test's row opens a [context menu](../../design/components.md#context-menu):
  `Expand all` (`#menu-expand-all`) and `Collapse all` (`#menu-collapse-all`), each just its name: on a suite, the suite
  and its tests (collapsed, they stay so when it's opened again); on a test, its suite's tests (the
  suite stays open). The folding is remembered, as a toggle's is.

  Deleting a test or a suite also clears what was shown of it: its last results (the thread and
  the timeline), a run of it going on (stopped), and the explore conversation it was saved from.
  Its runs stay in Runs, as the record. After a delete, a selection inside what was deleted goes to
  what held it (the suite, the test, the turn); a selection after it in the same list stays on the
  same item; anything else stays as it was.

  Every edit says which test it's about (by id, or name) and what it deletes; if the file says
  otherwise (it was changed by something else), the edit is refused with a toast, nothing is
  written, and the folder is read again, so the app shows the file as it is. Edits are made one
  after another, so edits sent together all land.

  Statuses colour as everywhere ([patterns](../../design/patterns.md#status)): `passed` `--ok`,
  `failed` and `error` `--danger`, `unsure` `--wait`, `running` `--run`.
- **Empty:** `.note.placeholder` (`#suitesEmpty`), in the middle of the section: "Open a folder
  with your suites (`*.hafen.yml`), or press + to start one." (browser build: "Open a suite file,
  or press + to start one.")

Every placeholder (what an empty container says) sits in the middle of what holds it, its text
centred (`.placeholder`): an open sidebar section's, in the middle of the room it has (a section
squeezed by the others scrolls what it has rather than spill over the next one: Conversations and
Runs keep at least 140px open, Suites 180px); the thread's, in the middle of the conversation's
space; a panel's ("No checks yet…", "Run the test to see this turn's response.", "Not run yet."),
centred under what's above it; Settings' ("Nothing here.", no providers, plugins, scopes or
variables yet); the timeline's (see [Timeline dock](#timeline-dock)).

### Conversations

`NavSection id="conversationsSection" name="conversations" label="Conversations" defaultOpen`; head
action `+` (`#newConversation`, ghost icon, "New conversation": the thread empties for a new one,
with the same provider, and the message box has focus).

Every conversation is kept, after each message, in the app's database (IndexedDB `hafen`, store
`conversations`: `{ _id, title, provider, started, updated, run }`, `run` being its explore run, as a
run file has it). Two-line rows (`conversation-<_id>`), newest first: its name (its title, or its
first message) over `<provider> · <when it was last carried on, with its year: Oct 6, 2026, 14:02> ·
<n> turns`, a 1px `--line` between one and the next (none above the first); the one going on is active. Click: it opens in
the thread as it was (its turns and their steps on the timeline) and the next message carries it on,
its turns so far being the history that message goes with. `×` asks `delete?`. Empty (a placeholder,
`#conversationsEmpty`): "No conversations yet. Send a message to start one: each is kept here."
With any, a search field (`#conversationsSearch`, "Search by name or date"): by its name, its
provider, and when it was started or last carried on; none: "No conversation matches “…”."
(`#conversationsNoMatch`).

#### Searching by date

A date is found as it's written any of these ways (the time's own: local): `2026-10-06 14:02`,
`2026/10/06`, `06/10/2026`, `10/06/2026`, `6/10/2026`, `6.10.2026`, `Oct 6, 2026`, `October 6, 2026`,
`6 Oct 2026`, `6 October 2026`, the weekday (`Tuesday`), the time (`14:02`), `today`, `yesterday`, and
how long ago (`2 mins ago`). Each word of a search is looked for apart, so `refund oct 2026` finds a
refund test that ran in October 2026.

### Runs

`NavSection id="runsSection" name="runs" label="Runs" defaultOpen`; head actions `open` (`#openRun`,
ghost, `.when-open`: open a run file) and `clear all` (`#clearRuns`, asking `delete every run?`).
Two-line rows (`run-<_id>`): the test or suite name (` ×3` after a test's that repeats; ` · explore` or
` · load` after it for those modes) over how long ago it started and how long it took (`2 mins ago ·
4.1 s`; the time and date in its tooltip); size: the verdict or status (`passed`, `failed`, `unsure`,
`running…`, `stopped`, `interrupted`), coloured. Click opens the run (read-only). Empty (a
placeholder, `#runsEmpty`): "No runs yet. Each run is recorded here."

Runs go on at once: each run going on is a row at the top (`run-live-<token>`: the test's or the
suite's name over `just now · running…`; click opens it; `×` asks `stop?` and stops that run). A run
isn't started for something already running: a test running on its own or in its suite's run, or a
suite with any run going on in it (their `▷`s are off, or say Stop). Esc stops every run.

### Checks

`NavSection id="checksSection" name="checks" label="Checks"` (closed by default): the check types
as [palette cards](../../design/components.md#palette-card), each its icon and name over a line
saying what it checks, by group (`.palette-group#palette-group-<group>`, under a `.palette-heading`,
18px between groups):

| Group | Cards (`#palette-<id>`) |
|---|---|
| Response | Path, Text, Status, JSON |
| Metrics | Latency, Length, Tokens, Cost |
| Thinking and tools | Thinking, Tool called, Tool not called, Tool order, Sequence |
| System One | Noul, Choice, Score (named `System One · noul` and so on elsewhere) |
| LLM judges | Judge, Reference |

Clicking one (or Enter) adds it to the selected turn and opens it in the panel. Cards aren't
dragged (the cursor is a pointer; nothing is dropped on a turn). With no turn selected, the note
above them reads "Select a turn, then click a check to add it."

## Top bar

`header.topbar` ([layout](../../design/layout.md#top-bar)), in the work column:

| Part | Is |
|---|---|
| `#menu`, `.topbar-brand` | The drawer's button and the logo, small screens only |
| `#evalIcon` | Before the title, 16px `--muted`: what's open: `chat` (a conversation), `suite`, `test`, `runs` (a run); while the open test or suite runs, a [spinner](../../design/components.md#spinner) in `--run` (`data-running`) |
| `h1.title#evalTitle` | The open test's name, the suite's, the run's (`refund for a broken item · run`), or "New conversation" |
| `.topbar-badges` | After the title, for a test or a suite: its group badge (`#evalGroup`) and, for a test that repeats, its repeat badge (`#evalRepeat`, `×3`) |
| `#testHeaderRun` | With a test or a suite open: a ghost icon button (16px `run` icon, "Run this test" / "Run this suite", its `title` naming the shortcut: `⌘↵` on macOS, `Ctrl+Enter` elsewhere), before the badge; while it runs, the `stop` icon in `--run` ("Stop the run") |
| `#status` | One line (`role="status"`): `passed 5/6 · 4.1 s · 2 mins ago` (how long ago the shown run started, kept up to date every 30 s), `running…`, `not run yet`, `sending…`, or an error in `--danger` |

## Thread

`.scroller > .wrap.thread#thread` (`role="log"`), in one of three modes:

| Mode | When | Shows |
|---|---|---|
| Explore | No test, suite or run open | The conversation so far; the message box sends |
| Suite | A suite selected (its row, or a bar of its timeline) | Each test a group (`section.turn-group.suite-test#suiteTest-<i>`): its head (the name, `.suite-test-name`, opening the test; its group badge, `#suiteTest-<i>-group`, and repeat badge, `#suiteTest-<i>-repeat`; its last result, coloured, and how long ago it ran: `passed 3/3 · 2 mins ago`; `▷` running that test, shown as a turn's is), then its turns, one line each (`.suite-turn#suiteTest-<i>-turn-<j>`, named `turn <j>: <message>`: the turn's icon, coloured as in the sidebar, the message, its checks `4/5`), each opening that turn. The title is the suite's name; the message box is hidden. Empty: "This suite has no tests yet: press + on it under Suites, or Add test in its panel." |
| Test | A test open | The test's turns as the file has them now, each with its checks as badges. After a run, a turn shows the run's reply only if it was of that turn's message as the file has it now (its `user_template`), and a check shows a result only if it was of that check as it is now; a turn or check added, deleted, moved or changed since shows "Not run yet." / a badge with no result, never another's (the latest repeat) |
| Run | A run open | That run's conversation and results as it recorded them, read-only; the message box is hidden |

Each turn is a group (`section.turn-group#turn-<i>`, no rule between groups: 6px between them, 14px
above and 18px below inside one): a head (`.turn-head`: `TURN 2` as a `.label` in `--fg`, with `· row 3` / `· run 2` for
an instance (`· run 2 of 3`: a test that repeats shows its latest run unless another is picked in the panel's `Showing`); then a `.hint` saying how it went, coloured by status: `4/5 checks · 1.2 s`, `not run
yet · 3 checks`, `running…`, `error · 0.4 s`; a test's turn with no checks (or every one turned off), in `--wait`: `not run yet · 0 checks`, `0 checks · 1.2 s` (a conversation's turns have no checks to have, and don't say so); and, in a test, `▷` at the right, `#turn-<i>-run`,
running the test up to this turn, and then `×`, `#turn-<i>-delete`: both shown on hover, on the
selected turn, when focused and on touch screens (`▷` always while it's the stop of a run going on);
`×` asking `delete`: in a test it deletes the turn from the file; in a
conversation it deletes it from the conversation, the turns after it moving up, and the next message
going without it), then your message and the reply 16px apart.

A turn reads as one thing: a click anywhere in its group selects it (its head, its labels, the reply's
stats, the space around them), except on its own controls (buttons, links, a thinking's summary, a
check's badge, which do their own thing) or a click that ends selecting text. A group has the
list's look: a faint background on hover (`--row-hover`), and `--soft` when selected (its user
message a step darker, `--fg` at 7% over `--bg`, to stay apart from it).

**Right-click** on a test's turn (or the menu key / Shift+F10 on its `▷`) opens its [context
menu](../../design/components.md#context-menu) (`#contextMenu`):

| Item | Does |
|---|---|
| `Run this turn only` (`#menu-turn-only`) | Sends only this turn. The turns before it are carried, not sent: each its record from the test's last run (if it ran as the file has it now), else its fixed `reply`; what they extracted reaches it. A turn before it with neither is sent. The result says `· turn 3 only`; a carried turn's head says `carried · from the last run` (or `· its fixed reply`). A provider that keeps the conversation by session (`history: session`) gets none for it |
| `Run up to this turn` (`#menu-turn-upto`) | As `▷` on the turn: turns 1 to this one |
| `Run the test` (`#menu-turn-test`) | The whole test |
| `Delete this turn` (`#menu-turn-delete`) | Asks first ("Click again to delete it"), then deletes it from the file |

While the test runs, the menu has `Stop the run` only. In a conversation, it has `Delete this turn`
(from the conversation).

A turn, check or step picked in the thread or the timeline keeps the thread in the mode it was in: a
step of a test leaves the test showing; a turn picked in an open run leaves the run showing (its
panel shows that run's record). Nothing is dropped on a turn: checks are added from the palette by
clicking (with the turn selected).

The thread follows a reply as it arrives while it's at its bottom; scrolled up, it stays where it
is. **Sending a message** (or adding a turn from the message box) goes to the bottom, wherever the
thread was, and follows the reply from there.

Each turn is a pair of [messages](../../design/components.md#message-and-thread):

- **`article.msg.user`** (`#turn-<i>-user`): no label: the message on `--soft` at the thread's right,
  as in a chat (at most 85% of the width, its text left-aligned).
- **`article.msg.bot`** (`#turn-<i>-reply`): no label (no provider or model name: the reply speaks
  for itself); the [reply parts](../../design/components.md#reply-parts) in the order they happened: thinking (`+ thinking ·
  summary · 1.8 s`), tool calls (`↳ lookup_order · 0.4 s`), the text (`.msg-body.md`: **Markdown**,
  GitHub's flavour with line breaks kept, by marked; nothing in it runs or loads: raw HTML shows as
  text, links go only to http(s), mailto and `#` addresses and open in a new window, images are links;
  long words wrap, and only a code block or a table wider than the message scrolls sideways, on its
  own: the message itself never does; the streaming cursor while it arrives); then, under it, its
  foot (`.msg-foot`, 8px below, wrapping): `.msg-stats`, `0.62 s to first token · 2.2 s · 412 in ·
  96 out · 210 thinking · 48.2 tok/s · $0.0041` (parts that don't apply are left out; an error in
  `--danger`), and `copy` (`#turn-<i>-copy`, shown on hover, on the selected turn and on touch
  screens: the reply as it came, raw, to the clipboard; it says `copied` for 1.5 s); then the [check
  badges](../../design/components.md#check-badge) (`.msg-checks`; a check turned off is a badge
  with status `off`, grey, its name struck through).
- **An error turn:** the reply's text is the error, in `--danger`, with `show the response` (a
  `.panel-template`-style disclosure) under it.
- **Selected:** the turn, check or step selected anywhere (the tree, the timeline, the panel) gets
  the [selected-message marker](../../design/components.md#selected-message) and is scrolled into
  view.
- **Empty (explore):** `.empty` (a placeholder, in the middle of the conversation's space): "Choose a
  provider, then send a message. Save the conversation as a test when it's worth keeping." With no
  providers: "Add a provider under Providers to start."

Clicking a reply selects its turn (the panel shows it); a badge selects its check; thinking or a
tool line selects that step.

## Message box

`footer.composer` ([Message box](../../design/components.md#message-box)): `#input` and the primary
button (no large-editor button: the box grows with what's typed, up to 200px, then scrolls).

| Mode | Placeholder | Button | Does |
|---|---|---|---|
| Explore | "Type a message" ("Add a provider to send messages" with none) | `SEND` / `STOP` | Sends live |
| Test | "Add a turn to <test>" | `ADD TURN` | Adds the message as the test's next turn (saved to the file); it runs with the test |
| Run, Suite | (hidden) | | |

Enter sends or adds; Shift+Enter is a new line; Esc stops. With a test open, `⌘↵` / `Ctrl+Enter`
runs (see [Keyboard](#keyboard)) and adds nothing; exploring, it sends, as Enter does.

## Panel

`aside.panel#panel`, 340px ([layout](../../design/layout.md#panel)): a 52px head (`.block-label`
with the view's icon and label, at the left, after the back button when there is one; and the close
button `#panelClose` at the right), the body, and the foot (ids, the file, Delete). It shows one view
at a time, for what's selected.

The body's spacing is one rhythm, the same in every view: a field's label (`.field-head`) 6px over
what it names, and 18px below what's before it; facts, a row of buttons, and the request and raw
stream 14px below what's before them (a row of buttons straight under a label, 6px: the label's);
a number field's own label 6px over it; the foot 24px below; nothing spaced from the top of the body
(its padding is: 12px).

A nested view has a back button (`#panelBack`, a ghost icon button, the `back` icon, before its icon)
to what holds it: a check's and a step's go to its turn (a step with none: its test), a turn's to its
test (in an open run: the run), a test's to its suite. A row of buttons in the body wraps rather than
run out of the panel (they share the width; a label that doesn't fit is cut with an ellipsis), and
the body never scrolls sideways.

Every text field in the panel and in Settings, and the message box, checks the `{{scope.NAME}}`s in
it as it's typed, for the scope chosen now: one its variables and its secrets (or every scope's)
don't have, or none chosen, shows under the field (`.hint.error#<field>Problem`): `{{scope.nope}}
isn't in the scope "stage": add it in Settings → Environments (or Secrets)`. The field still saves
what's typed (a run with it would stop with a setup error).

The views:

### Conversation (explore)

Head: `provider` icon, `CONVERSATION`.

- `Provider` (`.select#convProvider`, with `manage` / `add one`): with turns already, another one
  carries the conversation on (its turns so far are the history), as a `.hint` under it says. It's off
  while a message is on its way (its reply would be lost). Opening another conversation, or starting
  a new one, stops a message on its way.
- `Name` (`.input#convTitle`, once it has turns): its title, saved on blur or Enter; empty, its first
  message stands for it.
- Facts (`dl.trace-facts`): turns, tokens, cost, p50, from the turns it has now.
- (No button for a new conversation here: the sidebar's `+` starts one.)
- `Save as test`: `Suite` (`.select#saveSuite`: the open folder's suites, and "New suite…"),
  `Name` (`.input#saveName`), and `SAVE AS TEST` (`.btn-primary#saveTest`). The test gets the
  conversation's messages as turns, and the replies' current values as suggested checks to accept
  or drop (status, and each path the reply text came from).
- Foot: `IdField` "Run _id", `Delete conversation` (`#convDelete`, asking `delete it?`).

### Suite

Head: `suite` icon, `SUITE`.

- `Name (in reports)` (`.input#suiteName`): the suite's `name`, edited in place (empty removes it;
  the file's name is its placeholder).
- `File name` (`.input#suiteFile`): the file's name without `.hafen.yml`; changing it renames the file
  in its folder (a name that's taken, or with characters other than letters, digits, `.`, `-` and
  `_`, is refused with a toast and put back; so is a rename while the suite runs). Its tests' last
  results follow it (a new suite given its old name doesn't take them; the results a run had are
  shown under its suites' names as renamed since, and not if what they're of was deleted since, in
  this folder: runs are kept with the folder they're of). A `.hint` shows the path.
- `Provider` (`.select#suiteProvider`, with `manage` in its head, which opens Settings → Providers):
  the folder's providers by name; choosing one writes the suite's `provider` as a path relative to
  it. A reference that isn't one of them shows as it is (`ollama2 (missing)`, a preset's name,
  `inline`), with the suite's problem below.
- `Group` (`.input#suiteGroup`, a whole number of 1 or more; empty removes it; another value isn't
  saved and the field shows the file's) and a `.hint#suiteGroupHint`: "Suites in the same group run
  one after another; different groups run at the same time. Suites with no group are one group."
  ([Groups](test-file.md#groups))
- Facts: tests, environments (names; secret values are kept in Settings → Secrets), judges, defaults
  (repeat, pass rate, history, on failure, unsure), plugins, last run (`14:02:11 · 2 mins ago`: the
  latest of its tests').
- `RUN SUITE` (`.btn-primary#suiteRun`; `STOP` while it runs; off while one of its tests runs on its
  own), `Add test` (`.btn#suiteAddTest`), `Copy CI command` (`.btn#suiteCopyCi`); then `Edit the file
  as YAML` (`.btn#suiteYamlEdit`): it reads the file as it is when pressed and opens it in the large
  editor (code style); Save validates and writes. Foot: the file path
(`.hint`), `Delete suite file` (`#suiteDelete`, asking `delete this file?`), which deletes the file
from the opened folder.

### Test

Head: `test` icon, `TEST`.

- `Name` (`.input#testName`), `Provider` (`.select#testProvider`: "the suite's (<name>)", then the
  folder's providers; choosing one writes the test's own `provider`, the suite's removes it),
  `Tags` (`.input#testTags`, comma-separated).
- `Runs`: a `.controls` row of `Repeat` (`.input#testRepeat`, number), `Pass rate`
  (`.input#testPassRate`) and `Group` (`.input#testGroup`, a whole number of 1 or more; empty removes
  it; another value isn't saved), with a `.hint#testGroupHint`: "Tests in the same group run one after
  another; different groups run at the same time. Tests with no group are one group."
  ([Groups](test-file.md#groups)); then `History`, `On failure`, `Unsure` (`.select`s); `Data`
  (`.input#testData`, a file path, with the row count as a `.hint`).
- `Setup` and `Teardown`: one line each per step (`.hint`), edited as YAML.
- `.controls`: `RUN` (`.btn-primary#testRun`, `STOP` while running) and `Copy CI command`
  (`.btn#testCopyCi`, which says `copied` for 1.5s).
- `Showing` (`.select#testInstance`, a test that ran more than once, by repeat or data row): which
  run the thread shows, `run 3 of 3 · passed`, failed ones first in the list; with none picked, the
  latest (the one going on, while it runs).
- `Last run` facts: status, passed (`2/3`), checks (`17/18`), accuracy, p50 and p95, tokens, cost,
  took, when (`14:02:11 · 2 mins ago`). With a history of 2 or more runs: `History`, three [small charts](../../design/components.md#small-charts)
  (pass rate, p95, cost over the last 20 runs).
- A `.hint`: "Click a turn for its checks and response."
- `Edit the suite as YAML` (`.btn#testYamlEdit`): the suite's file, as it is when pressed, in the
  large editor.
- Foot: `IdField` "Test id", the file (`.hint`), `Delete test` (asks `delete this test?`).

### Turn

Head: `test` icon, `TURN <i>`.

- `Message` (`.textarea#turnUser` with its max button); `Reply` (`.textarea#turnReply`, shown with
  pinned history).
- `Extract` (`.textarea.textarea-code#turnExtract`, YAML: `session: $.session_id`).
- `Checks` (its head says `<n> off` when any is turned off): `ul.check-cards#turnChecks`, a
  [check card](../../design/components.md#check-card) for each (`#turnCheck-<j>`), 8px apart: its
  kind (the check icon and its name: `PATH`, `STATUS`, `SYSTEM ONE · NOUL`, a plugin's type), how
  it last went (`#turnCheck-<j>-status`: `pass`, `fail`, `unsure`, `error`, `skipped`, `running…`,
  `not run`, or `off`), an `on` box (`#turnCheck-<j>-on`) and `×` (asks `delete`, then deletes the
  check); under them, what it checks (`#turnCheck-<j>-open`: `$.data.reply contains 4417`) and why it
  went as it did (`found 4417`, `confidence 0.5`). The card is coloured by its status (see the
  addition); a click anywhere on it (not on its controls) opens the check. Unticking `on` turns the
  check off: the file gets `enabled: false` on it (one line; the check written on one line stays on
  one line, its comment kept), it shows `off` (greyed, struck through) at once, and it's skipped
  when the test runs ([checks.md](checks.md#turning-a-check-off)). Ticking it again takes the key
  away, so the file is as it was. With no checks: a placeholder, "No checks yet: add one from Checks
  in the sidebar, or click a value of the response."
- `Response` (field head with `200 · 2.2 s` as its status): the [JSON tree](../../design/components.md#json-tree)
  (`#turnResponse`; an open object or array ends with its `}` or `]` on a row of its own, so the
  response's last line is there), or the text for a non-JSON body. Selecting a value shows its path over the
  box and an inline form: an operator (`.select#pathOp`: equals, contains, matches, exists, type
  is, <, >), a value (`.input#pathValue`, filled with the current value) and `Add check`
  (`.btn#pathAdd`).
- `Request` (`details.panel-template#turnRequest`, its summary `Request`): the redacted request;
  `Raw stream · <n> chunks` (`#turnStream`, a streamed response's chunks as they came) under it.
  Each is a row of its own (its summary 24px tall, `+` folded, `−` open, `--fg` when open), 14px
  below what's before them and 6px apart; opened, its content is 6px under its summary.
- `Thinking` (`.panel-output.panel-thinking`, when there was any), with its visibility as a `.hint`.
- Metrics facts: time to first token, thinking, first answer token, total, tokens, tokens/s, cost,
  checks, lowest confidence.
- Foot: `Delete turn`.

### Check

Head: `check` icon, `CHECK · <TYPE>`.

- The check as YAML (`.textarea.textarea-code#checkYaml`, with its max button), saved through the
  engine when it loses focus, with a pointer to [checks.md](checks.md) for each type's fields. (A form
  per type is a later refinement.)
- `On: run this check` (`.check#checkOn`): as the card's `on` box.
- A System One check: `Request to System One` (`#checkJudgeRequest`), the request it was judged with
  (the one its turn's System One checks share), as the step's panel shows it; while the run goes on
  and it's being asked, its last result reads "Judging…" and the request is there, `asking…`.
- `Last result`: the check's [card](../../design/components.md#check-card) (`#checkResultCard`, no
  controls; a check turned off shows `off`), then facts: status, value, confidence, expected, actual,
  reason, judge (kind and model), tokens, cost, took; the judge's full answer (`.panel-output`).
  Not run as it is now: a placeholder, "Not run yet."
- `Review` (judged checks): `Agree` and `Disagree` (`.btn`s, sharing the row), and a note
  (`.input`); the judge's agreement so far as a `.hint` (`agrees with you 41 of 50 times`).
- Foot: `Delete check`.

### Step

Head: `timeline` icon, `STEP · <KIND>`. Facts: kind, name, start, duration, status, its metrics;
then its content: the thinking text, a tool call's arguments and result (JSON trees), a request and
response, a judge's question and answer, a retry's reason.

A System One call (`judge_call`) shows `Request to System One` (`#stepJudgeRequest`): the request it
sent, all of it, as soon as it's sent (while the run goes on, and the call's still being answered:
`asking…` in `--run` in its head): `POST <endpoint>/v1/systemone` (`#stepJudgeRequestUrl`), its
headers as facts (`authorization` `[redacted]`: the key is never shown, nor any secret value), and
its body, as the pretty JSON it is (`state`, `model`, `questions`), in a `.panel-output` up to 480px
tall that scrolls; `copy` (in its head) copies the body. The check's panel shows the same for a
System One check.

### Run

Head: `run` icon, `RUN`.

- Facts: status, verdict, mode, where (desktop, browser or CI, and version), environment, started,
  took, tests, checks, latency p50/p95/p99 (with `n`), tokens, cost.
- `Showing` (`.select#runInstance`, for the test the thread shows, when it has more than one): each
  repeat and data row (`run 2 of 3`, `row 17 of 20 · failed`), failed ones first.
- `Tests`: a `List` of the run's tests, status-coloured; clicking one shows it in the thread (the run's
  first until one's picked). A test the open folder hasn't got (a CI run's, or a suite renamed since)
  shows as the run recorded it; its turns and checks open in the panel as the run recorded them too
  (read-only: `#turnFromRun` says so), and Back goes to the run, the same test still showing.
- `Compare with` (`.select#runBaseline`: earlier runs of the same suites, or a file): pass rate,
  p50, p95, cost, each `run · baseline · change`, and the checks that flipped.
- `.controls`: `export JSON` (`.btn#exportRun`), `run again` (`.btn#runAgain`: what ran, as it ran: its
  one test, up to its turn or only its turn as it was; or each of its suites whole. One whose test the
  folder hasn't got any more says so in a toast, and runs nothing).
- Foot: `IdField` "Run _id", `Delete run`.

## Timeline dock

The [Timeline addition](../../design/components.md#timeline): `section.console.collapsible.timeline`
(`#timeline`, label `Timeline`, toggle `#timelineToggle`, body `#timelineBody`), under the work
area and above the console, spanning the full width, open by default (`eval.section.timeline`).

- Shows the open run (or the explore conversation, or the open test's last run), for the repeat
  and row the panel shows.
- Head: `TIMELINE`, then `fit` (`#timelineFit`, ghost: fit the run to the width; with steps only)
  and a `.hint` with the total (`4.1 s · 37 steps`).
- Rows: one group per turn (`TURN 1`), and setup and teardown groups; load runs show one row per
  concurrent slot.
- Empty (`.no-steps` on the dock and its body): `.note.timeline-empty#timelineEmpty` "Run a test or
  send a message to see its steps here.", centred, 14px above and below; the dock is as tall as its
  note (not its set height), so the work area above has the room, and it isn't resized (its edge
  hides). With steps, it's as tall as it's set (`--timeline-h`, 240px at first).


"Fit" makes the chart the dock's width exactly (the last bar's duration label included): nothing to
scroll sideways until it's zoomed in. The wheel over the labels scrolls the chart up and down (the
labels move with it); ⌘/Ctrl and the wheel zoom, as over the chart.

With a suite open, the timeline is its latest run of the whole suite (or the one going on): the
suite's bar (coloured by how its tests went: failed if any did), and each test's bar under it,
folded (a test's chevron opens it to its steps; tests that start during a live run fold too, unless
opened). The suite's bar opens the suite; a test's opens that test. Before a whole run: "Run the
suite to see its tests here."

**Right-click** on a row that has steps under it (a suite, a test, a run, a turn, a request: its
`.timeline-label`, which has `data-kind`) opens a context menu: `Expand all` (`#menu-expand-all`: it
and every step under it open) and `Collapse all` (`#menu-collapse-all`: it and every group under it
folded, so opening it again shows them folded). A row with nothing under it has no menu.

What's folded or open is kept by each row's place (the kinds and names from the top: a suite's file,
a test's id, `run 1`, `turn 1`, a check's place, a step's name, counted among its siblings alike), not
by the run: running a test or a suite again shows the same steps folded or open as they were left, in
its view and in another (a test's turn folded in the test's view is folded in its suite's view too).
It's kept while the page is open, not saved: after a reload each view starts as it does (a suite's
tests folded).
## Load runs

A run in `load` mode shows, in the thread's place, a summary (a `.wrap` with facts: requests,
concurrency, duration, throughput, errors, rate-limited, latency p50/p95/p99 for total and first
token, each with `n`; a warning in `--danger` when the client was saturated), a latency-over-time
chart, and one sample request as a conversation under it.

## Notifications

When a run ends, a toast says how it went (`Passed: <test or suite>`, `Failed: …`, `Couldn't run`,
`Stopped`; `<checks> · <took>`), and, as Settings → Notifications says:

- **A sound**, unless you're looking at what ran: a suite's run, its view or one of its tests open; a
  test's run, it (a turn or a check of it) or its suite's view open; and the window in front. (`When
  it sounds: after every run` plays it anyway.) Passed runs rise (E5, B5), failed runs fall (G4, C4).
  Only for the outcomes chosen; a stopped run makes none.
- **The system's notification**, silent, while the window isn't in front (hidden, or another app's in
  front), for the outcomes chosen.

The toast (`.toast.clickable`, its `title` "Open it") and the system's notification, clicked, open what
ran: a test's run, the test (found by its id, wherever it is in its file now); a suite's run, the
suite's view. The system's brings the window forward first (the desktop app: `notify_system` with a
tag, which the page is told back, `hafen:notification`). Other toasts (an error) go to the system the
same way while the window isn't in front, if system notifications are on.

## Console

The design system's console, as an audit log: one line for each thing that happened, newest last,
in an OpenTelemetry-like shape: the time (`14:02:03.123`), a dotted name, its attributes as
`key=value` (quoted when they have spaces), then how it ended and how long it took. Never a request's
or reply's body, a header, or a secret's value.

| Name | When | Attributes |
|---|---|---|
| `engine.<command>` | Each engine command, when it's answered (`open`, `load`, `edit`, `create`, `write`, `read`, `remove`, `rename`, `run`, `send`, `saveConversation`, `configure`, …) | What it was about: the file, the edit (`op=set:tests.0.name`), what it found (`found="2 suites, 2 providers"`), a run's result (`result="failed 0/1"`), `concurrency`; then `ok` or `error: …`, and its time |
| `http.request` | Each HTTP call the engine makes (a run's, a conversation's, a judge's, a setup step's) | `method`, `url` (no user or password; query values whose names look like keys, tokens or secrets as `***`); then its status, its time to the end of its body, its size |
| `run.start`, `run.turn`, `run.test` | A run starting; each turn and test as it ends | The file, the test, `until_turn` / `only_turn`, `at_once`; a turn's checks (`4/5`); a test's status |
| `conversation.turn`, `conversation.open`, `conversation.delete`, `conversation.turn.delete`, `conversation.clear` | A conversation's events | Its turn, its name |
| `run.delete`, `run.clear`, `run.import` | Runs kept here | The run |
| `config.env`, `config.provider`, `config.secret`, `config.relay`, `config.theme` | A setting changed | Its new value; a secret's name and environment, and `set` or `forget` |

Errors (a failed command, an HTTP status of 400 or more, a call that didn't get an answer) are
`--danger`. The console keeps the last 3000 lines; `copy` puts them all on the clipboard.

## Settings

The design system's [settings modal](../../design/components.md#settings), opened from the
sidebar's foot, with the app's own panes. Its groups' headings (`.settings-group`: Storage,
Connection, Configurations, App) are bold capitals in `--fg` (mono 11px, 600, `.08em` apart). Its
foot (`#settingsUsage`) says the storage used: `Storage used` over the size (`#settingsUsageValue`,
`2.7 MB`, in `--fg`), the runs and conversations kept, and the browser's or the app's storage in
all, on hover.

A large editor opened from a pane (Edit the scope as YAML, a plugin's `edit`, a field's max button)
goes back to Settings when it closes: Cancel, Esc, a click outside it and Save close the editor only
(each modal acts on its own dialog's close; the editor is drawn inside Settings' React tree, which
would otherwise pass its close up to Settings).

| Group | Pane | Contents |
|---|---|---|
| Storage | Runs | Runs kept by the app, with sizes; delete one or clear all |
| Storage | Conversations | Conversations kept by the app (as Conversations lists them), with sizes; delete one or clear all |
| Connection | Providers | The open folder's providers ([below](#providers-settings)) |
| Connection | System One | System One's key, `JEV_API_KEY` (`.input#systemoneKey`, password; `save` `#systemoneSave`, `forget` `#systemoneForget`; `#systemoneKeyState` says `set` or `not set`), kept as a secret for every environment; a `.hint` says which checks use it, the endpoint and model they call unless a judge says otherwise, and how CI sets it; a link to System One's documentation |
| Connection | Relay (browser build) | The relay's address (default: where the app was served from) and whether it answers |
| Configurations | Environments | Each scope's plain variables ([Scopes](test-file.md#scopes)): `Scope` (`.select#envScope`, with `choose it` (`#envChoose`) to make it the one chosen); `add scope` (`#newScopeForm`: `.input#newScopeName`) makes `environments/<scope>.yml`; the scope's variables as rows (`envVar-<name>`: the name over `{{scope.<name>}}`, its value in a plain `.input` saved on blur or Enter, `×` deleting it); `add` (`#envVarAdd`: `.input#envVarName`, `.input#envVarValue`); `Edit the scope as YAML` (`#envYaml`); `Delete scope` (`#envDelete`, asking `delete its file?`). Saved in place, comments kept. With no folder open: "Open a folder first: a scope's variables are kept in its environments/ folder, as plain YAML."; when there are scopes all the same (a suite's environments, opened as files; scopes that have secrets), `Scope` and `choose it` stay, over "Open a folder to add scopes and their variables…". The scope button at the top of the sidebar opens this pane |
| Configurations | Secrets | Each scope's secret values, by name (`Scope`: `.select#secretsEnv`; the pane opens on "every scope"; a value for every scope applies where a scope has none of its own); `{{scope.NAME}}` and `${env:NAME}` both reach them: a row for each name the open files reference as `${env:NAME}` (and the presets' default keys), and for each name that has a value (`set`, or `set for every scope` when the value is kept for all of them). `JEV_API_KEY` isn't here: it's System One's, in its pane. `Add a secret` (`#secretAdd`: a name, `.input#secretName`, and a value, `.input#secretValue`) keeps any number under names of your own (letters, digits and `_`, not starting with a digit), for files to use as `${env:NAME}`. In the desktop app they're stored encrypted by the system; in the browser build, in this browser's storage, which the pane says plainly |
| Configurations | Plugins | The folder's plugins (every file in `plugins/`, and every plugin a suite names), each loaded to show it: a row (`plugin-<name>`) with `<name> · <kind> · <version>`, its file and the hosts it may reach, any problem loading it (in `--danger`), how to use it (`kind: plugin:<name>`, `{ type: <name> }`, or `judges: { mine: { kind: plugin, plugin: <name> } }`), "Any suite in the folder can use it: …", and the suites that use it (`.hint#plugin-<name>-used`: `Used by a.hafen.yml, b.hafen.yml`, those that name it in their `plugins` or use it by name; `Used by no suite yet`). There's nothing to add it to a suite: any suite uses the folder's plugins by name. `edit` (the file in the [code editor](../../design/components.md#code-editor): JavaScript in colour, Tab and Enter keeping its indent, `Format`); `×` (`#plugin-<name>-delete`, asking `delete file?`). `Add a plugin` (`#newPluginForm`: its kind, `.select#newPluginKind`: Provider, Check or Judge; its name, `.input#newPluginName`) writes `plugins/<name>.js` from a starting file that works as it is (`engine/plugin-templates.js`); a provider one also writes its provider file, `providers/<name>.yml` (`kind: plugin:<name>`; `<name>-2`… when that's taken), so it's in Providers at once. With no folder open: "Open a folder first: plugins are files in its plugins/ folder." |
| App | Appearance | Light, Dark, or As the system's |
| App | Notifications | What a run's end does besides its toast ([Notifications](#notifications)): `Play a sound when a run ends` (`.check#notifySound`, on); `When it sounds` (`.select#notifyWhen`, off without sound: "only when I'm not looking at what ran", the default, or "after every run"); `For runs that` `passed` (`#notifyPassed`) and `failed, or couldn't run` (`#notifyFailed`), both on; `System notifications` (`#notifySystem`: "Also show the system's notification when Hafen isn't in front": on in the desktop app; in a browser off until turned on, which asks the browser's permission; `#notifySystemState` says `allowed`, `blocked by the browser`, `asks the browser when turned on` or `this browser has none`); `Try it` (`#notifyTry`: the sound and a sample toast, and the system's if on). Kept in `eval.notifications` |

### Providers (Settings)

Each provider is a file in the open folder's `providers/` folder, which suites name and the command
line uses as it is. The pane shows one of three things; leaving it (another pane, or closing
Settings) goes back to the list.

- **The list:** `new provider` (`.btn#newProvider`, disabled until a folder is open), then a
  `.settings-list` (`#providerList`) of `.settings-row`s (`provider-<name>`): the name over a `.hint`
  (`<kind> · <file>`, a plugin's kind as `plugin:<name>`, `· has problems` in `--danger`, `· in use`
  for the conversation's), `edit` (`.btn#provider-<name>-open`) and `×` (`#provider-<name>-delete`,
  asking `delete file?`, then deleting the file from the opened folder). After them, each provider
  plugin in the folder that no provider file uses (`provider-plugin-<name>`: its name over
  `plugin:<name> · <file> · no provider file yet`), with `add provider`
  (`.btn#provider-plugin-<name>-add`), which writes its provider file and opens it. Empty: "No providers yet. Add one: Ollama, OpenAI,
  Anthropic, Gemini, or your own endpoint." With no folder open: "Open a folder first: providers
  are files in its providers/ folder."
- **A provider** (`edit`): `‹ all providers` (ghost, `#providersBack`); `Name`
  (`.input#providerName`): the file's name. Changing it (on blur or Enter) renames the file in its
  folder, keeping the extension, and points every suite that uses it at the new name (their
  comments kept); a name that's taken, or with characters other than letters, digits, `.`, `-` and
  `_`, is refused with a toast and put back. Facts (kind, file, url, model), its problems, `The
  provider (YAML)` (a code textarea with the max button; saved on blur when it parses), `TRY IT`
  (`.btn-primary#providerTry`: chooses it for the conversation, closes Settings and focuses the
  message box), `Delete provider` (`#providerDelete`, asking `delete this file?`).
- **A new provider** (`new provider`): `‹ all providers`, then a form (`#newProviderForm`):
  - `Kind` (`.select#newProviderKind`): every kind a provider can start from, in this order:
    Ollama, OpenAI chat completions, OpenAI responses, Anthropic messages, Gemini, HTTP endpoint ·
    one JSON reply, HTTP endpoint · streamed (SSE), HTTP endpoint · streamed (JSON lines),
    WebSocket; under it, a `.hint` (`#newProviderAbout`) saying what it's for.
  - `Name` (`.input#newProviderName`): the kind's short name (`ollama`, `openai`, `anthropic`, …),
    with `-2`, `-3` added when taken; a `.hint` shows the file (`providers/<name>.yml`).
  - For a preset: `Model` (`.input#newProviderModel`, Ollama's placeholder `gemma4`) and `Address`
    (`.input#newProviderBase`, the preset's default as its placeholder); a `.hint` names the key's
    secret (`${env:OPENAI_API_KEY}`, …; none for Ollama). Otherwise `URL` (`.input#newProviderUrl`).
  - `ADD PROVIDER` (`.btn-primary#newProviderCreate`) writes `providers/<name>.yml` (from
    `engine/providers/templates.js`: valid as written, with the options it doesn't set as
    comments; an HTTP endpoint's body sends `{{history}}`), opens it, and chooses it for the
    conversation. A name that's taken is refused in a `.hint.error` (`#newProviderError`).

The conversation panel's `Provider` and the Suite and Test panels' have `manage` (or `add one`)
in their heads, opening this pane.

## Keyboard

As the design system's [patterns](../../design/patterns.md#keyboard-and-pointer); Esc also stops a
run (but Esc in a dialog, Settings or the large editor, closes the dialog and does nothing else; a
menu's Esc closes the menu), and the timeline zooms and pans as it says.

`⌘↵` on macOS, `Ctrl+Enter` on Windows and Linux (either works on any), runs what's selected:

| Selected | Runs |
|---|---|
| A turn (or one of its checks or steps), in a test | The test up to and including that turn: the turns before it are its history; the ones after it, and the checks on the whole conversation, don't run. Its result says so (`passed 1/1 · to turn 2`) |
| A test | The test |
| A suite | The whole suite |
| Anything else (a conversation, a run) | Nothing |

While a run goes on, it stops it (as `▷` does). A field being typed in is saved first, and the run
reads the file after it; in the message box with a test open it runs (it doesn't add a turn);
exploring, the message box sends with it; in a dialog (the large editor) it's the dialog's (Save).

## Small screens and the desktop window

As the design system's [layout](../../design/layout.md#small-screens): at 860px and below the
sidebar is a drawer and the panel overlays the main column from the right (`min(340px, 92vw)`),
shown when something's selected (`.panel.shown`), or when the top bar's details button
(`#panelToggle`, the `sidebar` icon, small screens only) asks for it (the conversation's panel), and
closed with `×`. It's under the drawer and its scrim; something picked in the drawer closes the
drawer, so what's picked shows. In the desktop app, the top bars are the
window's title bar ([layout](../../design/layout.md#the-desktop-apps-window)).

The desktop app's icon is the logo's "h" on macOS's icon grid (an 824px plate, corner radius 185,
in 1024, with a soft shadow), white on a `#0a0a0a` plate: the logo as the app shows it in light
mode, and hafen's own icon inverted, so the two tell apart in the Dock.
`desktop/icons/source.svg` is the source; `npm run icons` makes `icon.png` (1024px), `icon.icns`
and `icon.ico` from it. Run with `npm run app` it's set as the Dock's icon on macOS and the
window's on Windows and Linux; packages get it from `desktop/builder.json`.

### Its name

The app is **Hafen** wherever it's seen: the window's title, the menu bar and the Dock (its bundle's
name: `Hafen.app` in development, made by `desktop/start.js`; a package's `CFBundleName`), macOS's
app menu (`About Hafen`, `Hide Hafen`, `Quit Hafen`), About, the CLI (`hafen`). Inside, it's **Hafen
Lab** (`app.setName`): the name of its data folder (`~/Library/Application Support/Hafen Lab` on
macOS) and of its keychain entry, and of a package's file (`Hafen Lab.app`, its id `dev.hafen.lab`).
That keeps it apart from the hafen desktop app in this repository (`app.hafen.desktop`, data folder
`hafen`), which, on a disk that ignores case, "Hafen" would share: its storage and its one-window
lock, so only one of them could be open. `HAFEN_LAB_DATA` names another data folder (the tests').

Before, it was "hafen eval" (data folder `hafen eval`, database `hafen-eval`, run files
`*.hafen-eval-run.json`). What that kept is carried over, once:

- **The desktop app:** at its first start (`desktop/carry-over.js`, before the window opens), the old
  data folder's page storage (`IndexedDB`: runs and conversations; `Local Storage`: the sidebar's
  state, the theme, the folder opened last) and `window.json` are copied into the new one, each only
  if the new one hasn't got it (copied beside its place, then moved in: a copy that stops part way
  leaves nothing half there, and is tried again next time); then `carried-over.json` marks it done.
  Secrets aren't: the system keeps their key under the app's name, so they're entered again
  (Settings → Secrets, and System One). The old folder is left as it was.
- **The database** (desktop and browser): when the page opens it, the old database's runs and
  conversations are copied into `hafen` (one already there is kept), then the old one is deleted.
- **Run files:** one of kind `hafen-eval-run` opens (in the app, and in the CLI's `report` and
  `compare`) as a Hafen run; exported again, it's of kind `hafen-run`.

## Ids

Every control above has the id given. Rows: `suite-<n>`, `test-<id>`, `turn-<id>-<i>`,
`run-<_id>`, `provider-<name>`, with `-open` and `-delete`. Messages: `turn-<i>-user`,
`turn-<i>-reply`. Badges: `check-<turn>-<i>`. Timeline bars: `span-<_id>`. While a run is going,
`<html data-running>`.
