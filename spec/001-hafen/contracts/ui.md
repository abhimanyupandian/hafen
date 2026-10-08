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
own. It's tried again when what's selected, or the files, change.

## The workspace

The app keeps its own work; the user never picks a folder to work in. Its suites (`*.hafen.yml`),
providers (`providers/*.yml`), plugins (`plugins/*.js`) and data files are plain files, laid out as
the engine reads a folder, in the app's **workspace**, opened by itself as the app starts: in the
desktop app `<the data folder>/workspace/` (`HAFEN_LAB_DATA` names another data folder), the engine's
host rooted there (`desktop/engine-host.js`: the main process hands it the path with each port); in
the browser build the Origin Private File System's `workspace/` folder (`navigator.storage
.getDirectory()`), in the engine's worker (`worker.js`; a browser that can't keep one has it in memory,
and says so). Nothing shows its path as a folder of the user's: the app says it keeps them.
Conversations and runs are kept in IndexedDB, as before; a run isn't also written beside the suites.

- **First start:** an empty workspace. The thread offers the first steps (`Add a provider`, `New
  conversation`, `New suite`: [The thread's first steps](../../design/components.md#the-threads-first-steps));
  everything (a provider, a conversation, a suite, a plugin, a scope) can be added at once.
- **Import** (the Suites section's head, [`import`](../../design/components.md#suites-import-and-export),
  `#importSuites`: `Import suite files…`, `Import a folder…`; and its empty note's `import some`,
  `#suitesImport`, the same two): files or a folder picked with the system's picker (the desktop
  app's open dialog, in its main process: `import_pick`; a browser's `showOpenFilePicker` or
  `showDirectoryPicker`, read only, or a file input where there's none). The engine lists the
  folder's suites (`suites { from }`) and what they use (`dependencies { files, from }`: each suite,
  its provider files, data files, prices file, JSON Schemas, and its plugins: the entries it names,
  and the folder's `plugins/*.js` it uses by name, each with the files it imports by a relative path;
  never a secret), and copies them into the workspace at the same paths (`copyPlan`, then `copy`).
  Files picked in a browser come without their folders: each is found by the path a suite names it by
  (a script picked is a plugin, in `plugins/`).
  A file here with the same text is left as it is. Files here with another text are asked about once
  ([question dialog](../../design/components.md#question-dialog), `#question`, listing them): `Replace`,
  `Keep both` (theirs written as `name-2.yml` and the suites imported pointed at them, comments kept; a
  plugin is used by its name, so yours stays), `Skip`, or `Cancel` (closing it the same). A toast says
  what came in (`Imported 2 suites from repo`), the console lists each file, each problem (a file a
  suite names that isn't there, an import outside the folder) and each plugin package (not a file),
  and the first suite imported opens.
- **Export** (a suite's panel, `Export…`, `#suiteExport`; the Suites head's `export all`; Copy CI
  command before the suite was exported): the [Export dialog](../../design/components.md#export-dialog)
  (`#exportDialog`) lists what goes (`dependencies { files }`: the suites and everything they use) and,
  when Globals or the scope chosen has values, `Also write globals.env and <scope>.env` (`#exportEnv`,
  on: each one's own values, as Settings → Environments' Export writes them; only the files that have
  any). `Export` (`#exportGo`) and `Export with secrets` (`#exportWithSecrets`, a ConfirmButton asking
  `write them in plain text?`: also `globals.secret.env` and `<scope>.secret.env`, each one's own
  secrets, only the ones that have any; written by the desktop app's main process into the folder,
  never through the page) ask for a folder (the desktop app's dialog, `export_pick`; a browser's
  `showDirectoryPicker`, read and write) and write the files there with the same paths, so `npx hafen
  run <folder> --env <folder>/globals.env --env <folder>/<scope>.env --secret
  <folder>/globals.secret.env --secret <folder>/<scope>.secret.env` runs them as they are (a later
  `--env` or `--secret` file's names over an earlier one's: the scope's over Globals', as in the app).
  Files there with another text (or a secrets file there) are listed first ([question
  dialog](../../design/components.md#question-dialog): `Cancel`, `Overwrite`); files there with the
  same text aren't written again. Where each suite went is remembered (`eval.exports`: its path, its
  name, its path as CI runs it, the scope it was for, the `.env` files and the secrets files written,
  in order, when), following a rename, forgotten on delete. A toast says where (`Exported
  smoke.hafen.yml to hafen-tests`), the console lists each file.
- **Copy CI command** (`#suiteCopyCi`, `#testCopyCi`) copies the command that runs the folder the suite
  was last exported to: `npx hafen run "<its path as CI runs it>" [--env …] [--secret …] [--test
  "<name>"] --report junit:results/junit.xml --report run:results/run.hafen-run.json`. Its path: in the
  desktop app, from the top of the git repository it's in, else the whole path; in a browser, its
  name. It names exactly the files that export wrote, inside that folder, in the order they're read:
  `--env <path>/globals.env --env <path>/<scope>.env --secret <path>/globals.secret.env --secret
  <path>/<scope>.secret.env`, each only when it was written; never a file that wasn't. Under it,
  `#suiteCiHint` (`#testCiHint`) says where it went and when, with which files, and when no `.env` file
  went with it though there are values now, that CI would run without them. Not exported yet: the
  hint says so, with `Export it` (`#suiteCiHintExport`), and the button opens the Export dialog instead
  of copying.
- **The folder the desktop app opened before** (`eval.root`, from when it worked on a folder of the
  user's): on the first start of this version it's offered once, before anything else ([question
  dialog](../../design/components.md#question-dialog), `Your suites`: `Import the suites from <name>?`,
  `Not now` / `Import`); `Import` imports its suites as Import a folder does (the main process opens
  it, once: `import_legacy`). Either way `eval.root` is forgotten. (The browser build never remembered
  a folder.)

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
`scope` icon and the scope chosen; `data-scope` its name, "" for none. With none chosen, no words: the
icon alone, greyed out as a disabled field is (opacity .5; still a button), with a small `!` badge over
its top right corner (`.scope-alert`), its `title` and `aria-label` `No scope chosen: choose one`:
[Scope button](../../design/components.md#scope-button)).
A click opens Settings on Environments, where the scope is chosen (a scope's row, then `choose it`;
or Globals, then `choose no scope`) among the scopes made in the app (Settings → Environments), and
only those. A suite's `environments:` block gives a scope of the same name values too, but doesn't make
one, and neither do secrets. A scope is a name, its environment values and its secrets, as the command
line's `--env` and `--secret` files are: the app keeps any number, so one is swapped for another here.

**Globals** are values and secrets for every scope, kept as a scope's are but in no scope (they can't
be renamed or deleted, and aren't in the scope button's list); `globals`, `global` and `every-scope`
are no scope's names, nor is one ending `.secret` (their files would meet Globals' or another
scope's). A name both have is the scope's (it **overrides** Globals); one only Globals has is
Globals'; one only the scope has, the scope's. With no scope chosen, Globals' are all there is. So the
chosen one fills `{{env.NAME}}` (its values over Globals', then the suites' environment of its name)
and `{{secret.NAME}}` / `{{secrets.NAME}}` (its secrets, then Globals', then, in the desktop app, the
environment variable it was started with). The old ways, `{{scope.NAME}}` and `${env:NAME}`, fill
nothing: a field that has one says what to write instead, as the engine does. It applies to runs, the
message box and a suite's check before it's run: every engine call that runs or checks something
(`preflight`, `run`, `send`) passes `environment: { name, values }`, always: for a scope, `{ name:
<scope>, values: <its values over Globals'> }` (with `env: <scope>`); with none chosen, `{ name: "",
values: <Globals' values> }`; so the engine never reads an environment from the files, nor takes a
suite's first. A suite's check before it's run is the engine's `preflight` (`{ files, env,
environment }` → for each suite, `{ file, problems, warnings }`: what `hafen validate` lists, secrets
taken as set). A switch applies to a conversation's next message; a run or a message takes the
secrets as they are when it starts. The one chosen last is chosen again (after a reload), if it's
still one of the app's; `no scope`, chosen, stays chosen; when none ever was, the first scope there is
is, as the app starts.

**Where they're kept.** Environment values: localStorage, in both builds (`eval.scopes`, the names in
the order they were made; `eval.scope.<name>`, a scope's values, one key a scope; `eval.globals`,
Globals'). Secrets: in the desktop app, the main process's `secrets.json` in the app's data folder,
keyed by scope (`""`: Globals'; a scope with no secrets left isn't in the file), each value with
whether it's encrypted (`{ "encrypted": true, "value": <base64> }`, with the system's keychain through
safeStorage, whenever the system offers it; `{ "encrypted": false, "value": <text> }` when it doesn't,
which Settings → Secrets says), handed to the engine's process as they change, and to the page only
when shown (`show`, `edit as .env`); in the browser build, `eval.secrets` (unencrypted, as Settings →
Secrets says), given to the engine's worker (`configure`) as they change. Other tabs and windows
follow a change to either (`storage` events). The engine's hosts look a secret up by its own name only
(nothing an object inherits, such as `constructor`), and tell the engine every secret value the scope
and Globals hold (`knownSecrets(scope)`), so run files hide each one, used or not.

**Deleting a scope** (Settings → Environments or Secrets: `Delete scope`, or a scope's menu, asking
first) deletes all of it at once:
its secrets (the keystore's or the browser's storage), then its entry and its values (`eval.scopes`,
`eval.scope.<name>`); it's gone from the scope button's list, Environments and Secrets, and, if it was
the one chosen, no scope is chosen after it. Nothing brings it back: not a reload, a restart of the
desktop app, a suite's environment of its name, nor a file. (An `environments/<scope>.yml` file, the
old way, isn't read by the app at all.)
In the desktop window the logo is hidden and the button stays at the right, as the design system
says.

### Suites

`NavSection id="suitesSection" name="suites" label="Suites" bodyId="suitesBody" defaultOpen`.

- **Head actions:** `+` (`#newSuite`, ghost icon, "New suite": the [new suite
  form](../../design/components.md#new-suite-form), named first: `tests.hafen.yml`, then
  `tests-2.hafen.yml`, …, with one test, using the provider in use; the test opens); then, as Runs'
  `open` and `clear all` are, ghost text actions shown only while the section is open
  ([Suites import and export](../../design/components.md#suites-import-and-export), [The
  workspace](#the-workspace)): `import` (`#importSuites`: a menu under it, Import suite files…, Import a
  folder…) and `export all` (`#exportSuites`: the Export dialog for every suite; only with a suite).
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
| Suite | `suite-<n>` (`data-file`: its file) | Its `name`, if the file gives one, else the file name; then its [group badge](../../design/components.md#group-badge) (`G2`) when it has a `group`. Its tooltip: the name, the file, and when it last ran (`last run 2 mins ago`, or `not run yet`) | its tests' last tries, each counted in its own word: `3 tests · 1 failed · 1 error · 1 couldn't run` (stopped ones aren't counted), or its problems; then `▷` (`#suite-<n>-run`, "Run the suite": the whole suite, shown in the suite's view) and `+` (`#suite-<n>-add`, "New test": a test at the end of this suite, opened), shown on hover as × is | Expands it; the panel shows the suite (and its problems) | `delete file?`, then deletes the suite (its file, from the workspace) |
| Test | `test-<id>` | The test's name; then its group badge (`G1`, `#test-<id>-group`) and, when it repeats, its [repeat badge](../../design/components.md#repeat-badge) (`×3`, `#test-<id>-repeat`: its `repeat`, or its suite's default). Its tooltip: the name, `runs 3 times`, when it last ran | its last try (a run of it, or of its suite, that broke off before it counts: [Statuses](#statuses)): `passed 3/3`, `failed 2/3`, `unsure 2/3`, `error`, `couldn't run`, `stopped`, `running…`, `—`, its tooltip saying why for an error or couldn't run; then `▷` (`#test-<id>-run`, "Run <name>": runs the test, and opens it), shown on hover as × is, off while the test runs (alone or in its suite's run) | Opens the test in the thread; the panel shows the test | `delete` |
| Turn | `turn-<id>-<i>` | Its icon (`.turn-icon`: the `test` icon, a box with a tick, 14px), coloured by how the turn last went: `--ok` passed, `--danger` failed or error, `--wait` unsure, and `--wait` too for a turn with no checks (or every one turned off), run or not, as nothing says it's right; `--muted` not run, skipped or stopped; while it runs, a [spinner](../../design/components.md#spinner) in `--run` instead; then the message, one line. (Its button is named `turn <i>: <message>`.) | its checks, a check turned off not counted: `6/6`, or `6 checks` before it runs; `0 checks` in `--wait`; `stopped` or `skipped` (in `--muted`) for a turn that ran none of them | Scrolls to the turn; the panel shows it | `delete` |

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
  written, and the files are read again, so the app shows the file as it is. Edits are made one
  after another, so edits sent together all land.

  Statuses colour as everywhere ([patterns](../../design/patterns.md#status)): `passed` `--ok`,
  `failed`, `error` and `couldn't run` `--danger`, `unsure` `--wait`, `running` `--run`, `stopped`
  and `skipped` `--muted`.
- **Empty:** `.note.placeholder` (`#suitesEmpty`), in the middle of the section: "No suites yet:
  press + to start one, or import some from files or a folder." (`import some`, `#suitesImport`, an
  `.inline-link` opening the Import items under it, as the head's `import` does)

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
4.1 s`; the time and date in its tooltip); size: how it went, in the [same words](#statuses) as the
Suites tree and the top bar (`passed`, `failed`, `error`, `couldn't run`, `stopped`, `unsure`,
`running…`; a run of one test: the test's), coloured, its tooltip saying why for an error. A run of one
test that broke off before it is named for that test, as any run of one test is. Click opens the run (read-only). Empty (a
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

## Statuses

How a run, a test and a turn went is said in one set of words everywhere (the top bar, the Suites
tree and a suite's count, a suite's view, Runs, the panel, a toast), the engine's: `passed`
(`unsure` when the judges weren't sure), `failed`, `error` (the endpoint, a judge, a fixture or a
setup step broke: not a failure of what's tested), `stopped`, `skipped`; and `couldn't run` for a run
the engine refused before sending anything (what `hafen validate` would list: a value the scope hasn't
got, a missing secret, a check type that isn't one). A run of one test says the test's word; a run of
several says `failed` if any failed, else `error` if any erred, else `stopped`, `unsure` or `passed`.
A check's unsure result shows as it counted (its `unsure` setting, kept on the result): `fail` under
`fail`, its reason `unsure: <why> (unsure counts as failed)`; `pass` under `pass`; `unsure` only
under `warn` (and in a run from before the setting was kept), so a result that failed its test never
looks like a pass, in the check's badge and card, its turn's colour or its turn's count.

A test's status is its **last try**: its latest run, or a later run of its suite, even one that broke
off before it reached the test (`error`, or `couldn't run`), which has no result for it but is how it
last went; nothing ran, so it isn't shown as a result (no counts), and the run before it isn't shown
in its place. Why is always a click or a point away: the top bar's `title`, the test's row's tooltip,
the thread ([Run error](../../design/components.md#run-error)) and the panel's `Last run`.

`failed`, `error` and `couldn't run` are `--danger`; `stopped` and `skipped` `--muted` (a stopped test
or message is never coloured as a failure).

## Top bar

`header.topbar` ([layout](../../design/layout.md#top-bar)), in the work column:

| Part | Is |
|---|---|
| `#menu`, `.topbar-brand` | The drawer's button and the logo, small screens only |
| `#evalIcon` | Before the title, 16px `--muted`: what's open: `chat` (a conversation), `suite`, `test`, `runs` (a run); while the open test or suite runs, a [spinner](../../design/components.md#spinner) in `--run` (`data-running`) |
| `h1.title#evalTitle` | The open test's name, the suite's, the run's (`refund for a broken item · run`: its one test's, also when it broke off before it; else its suites'), or "New conversation" |
| `.topbar-badges` | After the title, for a test or a suite: its group badge (`#evalGroup`) and, for a test that repeats, its repeat badge (`#evalRepeat`, `×3`) |
| `#testHeaderRun` | With a test or a suite open: a ghost icon button (16px `run` icon, "Run this test" / "Run this suite", its `title` naming the shortcut: `⌘↵` on macOS, `Ctrl+Enter` elsewhere), before the badge; while it runs, the `stop` icon in `--run` ("Stop the run") |
| `#status` | One line (`role="status"`, `data-status` the [status](#statuses)): how the test's, the suite's or the run's last try went, `passed 5/6 · 4.1 s · 2 mins ago` (how long ago it started, kept up to date every 30 s); `error · 0.04 s · just now` (its `title` saying why in full); `couldn't run: <the first problem>` (its `title`: every one); `stopped · 1.2 s · just now` in `--muted`; `running…`, `not run yet`, `sending…`; an error or a failure in `--danger` |

## Thread

`.scroller > .wrap.thread#thread` (`role="log"`), in one of three modes:

| Mode | When | Shows |
|---|---|---|
| Explore | No test, suite or run open | The conversation so far; the message box sends |
| Suite | A suite selected (its row, or a bar of its timeline) | Each test a group (`section.turn-group.suite-test#suiteTest-<i>`): its head (the name, `.suite-test-name`, opening the test; its group badge, `#suiteTest-<i>-group`, and repeat badge, `#suiteTest-<i>-repeat`; its last result, coloured, and how long ago it ran: `passed 3/3 · 2 mins ago`; `▷` running that test, shown as a turn's is), then its turns, one line each (`.suite-turn#suiteTest-<i>-turn-<j>`, named `turn <j>: <message>`: the turn's icon, coloured as in the sidebar, the message, its checks `4/5`), each opening that turn. The title is the suite's name; the message box is hidden. Empty: "This suite has no tests yet: press + on it under Suites, or Add test in its panel." |
| Test | A test open | The test's turns as the file has them now, each with its checks as badges. After a run, a turn shows the run's reply only if it was of that turn's message as the file has it now (its `user_template`), and a check shows a result only if it was of that check as it is now; a turn or check added, deleted, moved or changed since shows "Not run yet." / a badge with no result, never another's (the latest repeat). Its last try broke off before it (an error, or couldn't run): a [run error](../../design/components.md#run-error) (`#runError`) above its turns says why, and the turns are as never run by it |
| Run | A run open | That run's conversation and results as it recorded them, read-only; the message box is hidden. One that broke off before its tests shows its [run error](../../design/components.md#run-error) (`#runError`: `couldn't run` and each problem, or `error` and why) where the conversation would be, never "This test isn't in your suites." |

Each turn is a group (`section.turn-group#turn-<i>`, no rule between groups: 6px between them, 14px
above and 18px below inside one): a head (`.turn-head`: `TURN 2` as a `.label` in `--fg`, with `· row 3: a refund please` (a data row by its
number and name, as the reports say it: [test-file.md, Data rows](test-file.md#data-rows); `· row 3` for one with no name) / `· run 2` for
an instance (`· run 2 of 3`: a test that repeats shows its latest run unless another is picked in the panel's `Showing`), cut with an ellipsis when it's too long for the head; then a `.hint` saying how it went, coloured by status: `4/5 checks · 1.2 s`, `not run
yet · 3 checks`, `running…`, `error · 0.4 s`, `stopped · 0.5 s` (in `--muted`: stopped on purpose isn't an error); a test's turn with no checks (or every one turned off), in `--wait`: `not run yet · 0 checks`, `0 checks · 1.2 s` (a conversation's turns have no checks to have, and don't say so); and, in a test, `▷` at the right, `#turn-<i>-run`,
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
  `.panel-template`-style disclosure) under it. A turn stopped on purpose isn't one: what came, ending
  `…`, then `stopped` in `--muted` (`#turn-<i>-cut`); none came, `Stopped before any reply came.`
- **Selected:** the turn, check or step selected anywhere (the tree, the timeline, the panel) gets
  the [selected-message marker](../../design/components.md#selected-message) and is scrolled into
  view.
- **Empty (explore):** `.empty#threadEmpty` (a placeholder, in the middle of the conversation's
  space): "Choose a provider, then send a message. Save the conversation as a test when it's worth
  keeping." With no providers: "Add a provider (an endpoint to talk to) to start: then talk to it, and
  save what's worth keeping as a test." Under it, the first steps as buttons ([The thread's first
  steps](../../design/components.md#the-threads-first-steps)): `Add a provider` (`#threadAddProvider`,
  the primary with no providers), `New conversation` (`#threadNewConversation`), `New suite`
  (`#threadNewSuite`).

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

A message the engine refused before sending it comes back in the box, the reason under it
(`.hint.error#sendProblem`). A problem the provider is known to have before anything is sent (a
fixture the app hasn't got, say) is said only in the panel, by the provider (Conversation's
`#convFixturesProblem`), not under the box nor in the top bar; Send is off meanwhile, its `title`
`Can't send: …` ([Message box problems](../../design/components.md#message-box-problems)).

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

Every text field in the panel and in Settings, and the message box, checks what it takes from the
scope as it's typed, for the scope chosen now: an `{{env.NAME}}` its values, Globals' (or an open
suite's environment of its name) haven't got; a `{{secret.NAME}}` (`{{secrets.NAME}}`) it and Globals
have no secret for (nor a fixture gives); an old way to write one (`${env:NAME}`, `{{scope.NAME}}`),
which fills nothing, said with what to write instead, as the engine says it (`${env:API_KEY} is the
old way to write a secret: write {{secret.API_KEY}}`). It shows under the field
(`.hint.error#<field>Problem`): `{{env.nope}} isn't in the scope "stage" or in Globals: add it in
Settings → Environments`; `{{secret.KEY}} isn't a secret of the scope "stage" or of Globals: add it in
Settings → Secrets`; with no scope chosen, `{{env.nope}} isn't in Globals, and no scope is chosen: add
it in Settings → Environments`. The field still saves what's typed (a run with it would stop with a setup error,
said in its toast and the console; a message, in its turn, and nothing is sent). Every such field takes
a template: none is a `type="url"` field the browser would refuse one in.

The views:

### Conversation (explore)

Head: `provider` icon, `CONVERSATION`.

- `Provider` (`.select#convProvider`, with `manage` / `add one`): the providers kept, less a
  provider file whose kind names a plugin that isn't a provider (a fixture's, a check's: from the
  engine's list of the plugins kept, `open`/`load`'s `plugins`, each loaded once per text). With
  turns already, another one
  carries the conversation on (its turns so far are the history), as a `.hint` under it says. It's off
  while a message is on its way (its reply would be lost). Opening another conversation, or starting
  a new one, stops a message on its way.
- `Fixtures` (the chosen provider's): a field head with `edit` (`#convFixturesEdit`, ghost: Settings →
  Providers, that provider), then what it runs, in order, as facts (`#convFixtures`: `once, before the
  run` → `acme-login → warm`, one per list that has any; a name the plugins kept haven't, with
  `(missing)`), or `#convFixturesNone` ("None yet: edit adds some…"; "Choose a provider file…" with
  none chosen). The suite's and the test's provider pickers have the same (`#suiteProviderFixtures…`,
  `#testProviderFixtures…`: the provider the test runs with, its own or the suite's), and the same
  filter (only providers to pick). Under the conversation's, when the provider a message goes to has a
  problem the app can see before sending (its fixtures can't be read or name one twice, a fixture or a
  provider plugin the app and the suite haven't got): `#convFixturesProblem` (`.hint.error`,
  `role="alert"`: `ollama: the fixture "login" (fixtures.beforeAll) isn't in the folder's plugins/ or
  the suite's plugins`) with `edit the provider` (`#convFixturesFix`: Settings → Providers, that
  provider), in place of the fixtures' own line for the same thing. It's said here only; Send is off.
- `Name` (`.input#convTitle`, once it has turns): its title, saved on blur or Enter; empty, its first
  message stands for it.
- Facts (`dl.trace-facts`): turns, tokens, cost, p50, from the turns it has now.
- (No button for a new conversation here: the sidebar's `+` starts one.)
- `Save as test`: `Suite` (`.select#saveSuite`: the suites kept, and "New suite…"),
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
  shown under its suites' names as renamed since, and not if what they're of was deleted since), and
  so does where it was last exported to. A `.hint` shows the path.
- `Provider` (`.select#suiteProvider`, with `manage` in its head, which opens Settings → Providers):
  the providers kept, by name; choosing one writes the suite's `provider` as a path relative to
  it. A reference that isn't one of them shows as it is (`ollama2 (missing)`, a preset's name,
  `inline`), with the suite's problem below.
- `Group` (`.input#suiteGroup`, a whole number of 1 or more; empty removes it; another value isn't
  saved and the field shows the file's) and a `.hint#suiteGroupHint`: "Suites in the same group run
  one after another; different groups run at the same time. Suites with no group are one group."
  ([Groups](test-file.md#groups))
- Facts: tests, environments (names; secret values are kept in Settings → Secrets), judges, defaults
  (repeat, pass rate, history, on failure, unsure), plugins, last run (`14:02:11 · 2 mins ago`: the
  latest of its tests').
- Its problems (an old way its files, or its plugins, write a secret or an environment's value is one,
  saying the new way: `${env:API_KEY} is the old way to write a secret: write {{secret.API_KEY}}`),
  then its warnings as the file was read (`.hint.panel-note`, joined by ` · `): a test with no checks,
  what isn't built yet.
- `RUN SUITE` (`.btn-primary#suiteRun`; `STOP` while it runs; off while one of its tests runs on its
  own) and `Add test` (`.btn#suiteAddTest`); a row of `Export…` (`.btn#suiteExport`: the [Export
  dialog](../../design/components.md#export-dialog), [The workspace](#the-workspace)) and `Copy CI
  command` (`.btn#suiteCopyCi`: the command that runs the folder it was last exported to, `npx hafen
  run "<folder>" --env … --secret … --report junit:… --report run:…`; not exported yet, it opens the
  Export dialog); under them, `.hint#suiteCiHint` (where it went and when, with which files; not
  exported yet, that it isn't, with `Export it`); then `Edit the file as YAML` (`.btn#suiteYamlEdit`): it reads the file as it is when
  pressed and opens it in the large editor (code style); Save validates and writes. Foot: the file
  path (`.hint`), `Delete suite file` (`#suiteDelete`, asking `delete this file?`), which deletes the
  suite (its file, from the workspace).

### Test

Head: `test` icon, `TEST`.

- `Name` (`.input#testName`), `Provider` (`.select#testProvider`: "the suite's (<name>)", then the
  providers kept; choosing one writes the test's own `provider`, the suite's removes it),
  `Tags` (`.input#testTags`, comma-separated).
- `Runs`: a `.controls` row of `Repeat` (`.input#testRepeat`, number), `Pass rate`
  (`.input#testPassRate`) and `Group` (`.input#testGroup`, a whole number of 1 or more; empty removes
  it; another value isn't saved), with a `.hint#testGroupHint`: "Tests in the same group run one after
  another; different groups run at the same time. Tests with no group are one group."
  ([Groups](test-file.md#groups)); then `History`, `On failure`, `Unsure` (`.select`s); `Data`
  (`.input#testData`, a file path, with the row count as a `.hint`); with a data file (or a
  `row_name` in the file), `Row names` (`.input#testRowName`, placeholder `first column`): the
  test's `row_name`, each row's name ([Data rows](test-file.md#data-rows)); empty removes it; with a
  `.hint#testRowNameHint`: "Each row's name in the reports and the thread (row 3: …): its first
  column's value, or a template such as {{row.question}} ({{row.order}}). Cut at 60 characters;
  never a secret."
- `Setup` and `Teardown`: one line each per step (`.hint`), edited as YAML.
- `.controls`: `RUN` (`.btn-primary#testRun`, `STOP` while running) and `Copy CI command`
  (`.btn#testCopyCi`, which says `copied` for 1.5s: the suite's, with `--test "<name>"`; its hint
  `.hint#testCiHint`).
- `Showing` (`.select#testInstance`, a test that ran more than once, by repeat or data row): which
  run the thread shows, `run 3 of 3 · passed`, a row by its name, `row 2: a refund please · failed`
  (`· run 2` when it repeats), failed ones first in the list; with none picked, the latest (the one
  going on, while it runs).
- `Last run` facts: status, passed (`2/3`), checks (`17/18`), accuracy, p50 and p95, tokens, cost,
  took, when (`14:02:11 · 2 mins ago`). A last try that broke off before it: its status (`error` or
  `couldn't run`, `#testLastStatus`, in `--danger`) and when, then why (`ul.problems#testRunError`: the
  error, or each problem the run's check found), and nothing to count. With a history of 2 or more runs: `History`, three [small charts](../../design/components.md#small-charts)
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
- `Review` (judged checks): **not built yet** (FR-040). Planned: `Agree` and `Disagree` (`.btn`s,
  sharing the row), and a note (`.input`); the judge's agreement so far as a `.hint` (`agrees with
  you 41 of 50 times`). Nothing in the app shows it today.
- Foot: `Delete check`.

### Step

Head: `timeline` icon, `STEP · <KIND>`. Facts: kind, name, start, duration, status, its metrics;
then its content: the thinking text, a tool call's arguments and result (JSON trees), a request and
response, a judge's question and answer, a retry's reason.

A fixture (`fixture`) shows facts (`#stepFixture`): fixture, when (its phase), provider, gave (the
names, never values), set (the environment's names it set with `env.set`, never values), stop (`said to
stop`, when its `run()` returned false), calls, error. A plugin's or fixture's call (`call`) shows `Request`, its plugin
in its head (`#stepCallPlugin`, `fixture acme-login`), `METHOD url` (`#stepCallUrl`), its headers as
facts (`#stepCallHeaders`), its body (`#stepCallBody`, pretty JSON when it's JSON); then `Response`,
its status in its head (`#stepCallStatus`; `waiting…` while it's going, `no response` when it failed
first), its error (`#stepCallError`), its headers (`#stepCallResponseHeaders`) and the start of its
body (`#stepCallResponseBody`). Secrets show as `[redacted]`.

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
  repeat and data row (`run 2 of 3`, `row 17: where is order 4431 · failed`), failed ones first.
- `Tests`: a `List` of the run's tests, status-coloured; clicking one shows it in the thread (the run's
  first until one's picked). None (it broke off before its tests): a placeholder, `#runTestsNone`, "None
  ran: it broke off before its tests." or "None ran: it was refused before anything was sent." A test
  the app hasn't got (a CI run's, or a suite renamed since) shows as the run recorded it; its
  turns and checks open in the panel as the run recorded them too (read-only: `#turnFromRun` says so),
  and Back goes to the run, the same test still showing.
- `Compare with` (`.select#runBaseline`: earlier runs of the same suites, or a file): pass rate,
  p50, p95, cost, each `run · baseline · change`, and the checks that flipped.
- `.controls`: `export JSON` (`.btn#exportRun`), `run again` (`.btn#runAgain`: what ran, as it ran: its
  one test, up to its turn or only its turn as it was; or each of its suites whole. One whose test the
  app hasn't got any more says so in a toast, and runs nothing).
- Foot: `IdField` "Run _id", `Delete run`.

## Timeline dock

The [Timeline addition](../../design/components.md#timeline): `section.console.collapsible.timeline`
(`#timeline`, label `Timeline`, toggle `#timelineToggle`, body `#timelineBody`), under the work
area and above the console, spanning the full width, open by default (`eval.section.timeline`).

- Shows the open run (or the explore conversation, or the open test's last run), for the repeat
  and row the panel shows.
- Head: `TIMELINE`, then `fit` (`#timelineFit`, ghost: fit the run to the width; with steps only)
  and a `.hint` with the total (`4.1 s · 37 steps`); when what it shows has fixtures,
  `hide fixtures` / `show fixtures` (`#timelineFixtures`, ghost, `aria-pressed` when hidden): the
  fixtures' steps (and the calls under them) left out, or shown again. One choice with the console's,
  remembered (`eval.fixtures`: `hidden` or `shown`).
- A provider's fixtures are steps (`fixture`, named `<fixture> · <phase>`), each plugin's or
  fixture's HTTP call too (`call`, under what made it).
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

When a run ends, a toast says how it went, in the [same words](#statuses) (`Passed: <test or suite>`,
`Passed, unsure: …`, `Failed: …`, `Error: …`, `Couldn't run: …`, `Stopped: …`; `<checks> · <took>`, or
why it broke off), its accent `--danger` for a failure or an error, `--ok` for a pass, `--muted` when
stopped; and, as Settings → Notifications says (error and couldn't run as failed runs):

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
| `http.request` | Each HTTP call the engine makes (a run's, a conversation's, a judge's, a setup step's, a plugin's, a fixture's) | `method`, `url` (no user or password; query values whose names look like keys, tokens or secrets as `***`), `via` (the plugin or fixture that made it: `fixture:acme-login`, `provider:acme`); then its status, its time to the end of its body, its size |
| `run.fixture`, `conversation.fixture` | Each provider fixture, as it ends | `name`, `phase`, `provider`, `test`, `calls`; `ok · gave NAMES` (never values) or `error: …` |
| `run.start`, `run.turn`, `run.test` | A run starting; each turn and test as it ends | The file, the test, `until_turn` / `only_turn`, `at_once`; a turn's checks (`4/5`); a test's status |
| `conversation.turn`, `conversation.open`, `conversation.delete`, `conversation.turn.delete`, `conversation.clear` | A conversation's events | Its turn, its name |
| `run.delete`, `run.clear`, `run.import` | Runs kept here | The run |
| `config.scope`, `config.provider`, `config.secret`, `config.relay`, `config.theme` | A setting changed | Its new value (the scope chosen, `none`); a secret's name and scope (`globals` for Globals'), and `set`, `forget`, `import` or `show` (shown in Settings) |
| `scope.create`, `scope.duplicate`, `scope.value`, `scope.rename`, `scope.delete`, `scope.import`, `scope.export`, `scope.export.secrets` | A scope made (or duplicated: `from`), renamed or deleted; a value set or deleted; values imported (from a `.env` file) or exported | The scope (`globals` for Globals); a value's name (never a secret's value), how many were imported, the file |

Errors (a failed command, an HTTP status of 400 or more, a call that didn't get an answer) are
`--danger`. The console keeps the last 3000 lines; `copy` puts what it shows on the clipboard.

Lines about a provider's fixtures (`*.fixture`, and `http.request` with `via=fixture:…`) are tagged
(`data-tag="fixture"`): `hide fixtures` / `show fixtures` in the console's head (`#consoleFixtures`,
once the providers have fixtures, or while they're hidden) leaves them out. One choice with
the timeline's.

## Settings

The design system's [settings modal](../../design/components.md#settings), opened from the
sidebar's foot, with the app's own panes. Its groups' headings (`.settings-group`: Storage,
Connection, Configurations, App) are bold capitals in `--fg` (mono 11px, 600, `.08em` apart). Its
foot (`#settingsUsage`) says the storage used: `Storage used` over the size (`#settingsUsageValue`,
`2.7 MB`, in `--fg`), the runs and conversations kept, and the browser's or the app's storage in
all, on hover.

A large editor opened from a pane (Environments' `Edit as .env`, a plugin's `edit`, a field's max button)
goes back to Settings when it closes: Cancel, Esc, a click outside it and Save close the editor only
(each modal acts on its own dialog's close; the editor is drawn inside Settings' React tree, which
would otherwise pass its close up to Settings).

| Group | Pane | Contents |
|---|---|---|
| Storage | Runs | Runs kept by the app, with sizes; delete one or clear all |
| Storage | Conversations | Conversations kept by the app (as Conversations lists them), with sizes; delete one or clear all |
| Connection | Providers | The providers kept ([below](#providers-settings)) |
| Connection | System One | System One's key, `JEV_API_KEY` (`.input#systemoneKey`, password; `save` `#systemoneSave`, `forget` `#systemoneForget`, a ConfirmButton asking `forget it?`; `#systemoneKeyState` says `set` or `not set`), kept as a secret in Globals; a `.hint` says which checks use it, the endpoint and model they call unless a judge says otherwise, and how CI sets it; a link to System One's documentation |
| Connection | Relay (browser build) | The relay's address (default: where the app was served from) and whether it answers |
| Configurations | Environments | Environment values ([Head](#head)), apart from the suites, as [scope panes](../../design/components.md#scope-panes). Down the left: **Globals** (`#envGlobals`), a line, then **Scopes** (`#envScopes`, each `#envScope-<name>`: the scope chosen with a ✓; `2 not set` (`--danger`) when the open files use names it hasn't got, Globals' counted in; `more` and a right-click: `Choose it`, `Rename`, `Duplicate`, `Delete`), `+` (`#newScope`) opening `#newScopeForm` (`.input#newScopeName`, `add`: letters, digits, `.`, `-`, `_`; not taken, not `globals`, `global` or `every-scope`, not ending `.secret`; shown once made). On the right, the entry picked (it opens on the scope chosen, or Globals with none): its head (a scope's name, `.input#envScopeName`, renaming it on Enter or blur: its values and secrets go with it, and it stays chosen; a name that won't do is refused, said, and put back; `choose it` (`#envChoose`) or `chosen now` (`#envChosen`); Globals: `Globals`, and `choose no scope` or `no scope chosen`; `more` (`#envMore`)); `#envSearch` (`Search variables`: by name or value); `import .env` (`#envImport`, a file picker, `#envImportFile`: each name the file has is set, the others stay; a file that isn't one says its first problem and where, and changes nothing), `export .env` (`#envExport`: downloads `globals.env` or `<scope>.env`, the entry's own values), `edit as .env` (`#envText`: the entry's own values as a `.env` file's text in the large editor; saved, they're its values); the table (`#envVars`: `VARIABLE`, `VALUE`, `SOURCE`), a row a name (`#envVar-<name>`, `data-source`): the name over `{{env.<name>}}` (and `not used by the open files` when they don't), its value in an `.input` saved on blur or Enter, its source (`this scope`, `overrides Globals`, `from Globals`, `not set`; on Globals, `overridden in …`), `×` (`#envVar-<name>-delete`, asking `delete`) or, inherited, `override` (`#envVar-<name>-override`: the scope's own, Globals' value to start from); the names the open files use that neither has, `not set`; Globals' it doesn't override, muted, `from Globals`; the add row last (`#envVarAdd`: `.input#envVarName`, `.input#envVarValue`, no button: Enter in either adds it; a name as a `.env` file's and the engine's: letters, digits, `_`, `.`, `-`, not starting with a digit). For a scope, `Delete scope` (`#envDelete`, asking `delete its values and secrets?`: the scope, all of it, its entry, its values and its secrets, from every list and store, for good ([Head](#head)); the scope chosen, no scope is chosen after it). No scopes yet: "No scopes yet: add one (stage, prod…)." (`#environmentsEmpty`). The scope button at the top of the sidebar opens this pane |
| Configurations | Secrets | Secrets, as Environments: the same entries (`#secretsGlobals`, `#secretsScopes`, `#secretsScope-<name>`: `2 not set` counts the secrets the open files use that it and Globals haven't got; the same `+`, menu and head: `#secretsScopeName`, `#secretsChoose`, `#secretsChosen`, `#secretsMore`), `#secretsSearch` (by name), `import .env` (`#secretsImport`, `#secretsImportFile`: into the entry shown; a name that won't do changes nothing, and a problem never quotes what's in a line), `export .env` (`#secretsExport`, a ConfirmButton asking `write them in plain text?`; it writes `globals.secret.env` or `<scope>.secret.env`, the entry's own, what `--secret` reads in CI: the desktop app's main process asks where and writes it (mode 600), so the values never pass through the page; a browser downloads it), `edit as .env` (`#secretsText`: the entry's own secrets as text, read for it; saved, they're its secrets, a name taken out forgotten), and the table (`#secretsList`: `NAME`, `VALUE`, `SOURCE`, `show all`/`hide all` (`#secretsRevealAll`)): a row for each name the open files use (`{{secret.NAME}}`, `{{secrets.NAME}}`; and the presets' default keys) and each name that has a value (`#secret-<name>`: its value a password field, `••••••••`, never shown until `show` (`#secret-<name>-reveal`): then as text, until `hide`; a new value typed in it is kept on blur or Enter; its source as Environments'; `forget` (`#secret-<name>-forget`, a ConfirmButton asking `forget it?`), or, inherited, `override` (`#secret-<name>-override`); `not set` in `--danger`), and the add row (`#secretAdd`: `.input#secretName`, `.input#secretValue`, no button: Enter in either adds it, or, with no value yet, goes to the value; a name as Environments'). `JEV_API_KEY` isn't here: it's System One's, in its pane. They're kept, in the desktop app, encrypted by the system when it can (else unencrypted in the app's data folder, until it can); in the browser build, in this browser's storage, unencrypted: while they're unencrypted, one line over the panes says so (`.note#secretsNote`), and nothing else explains the pane in words. `#secretsExport`'s `title` names the file it writes, in plain text. Secrets kept for a name that isn't a scope now (from before the scopes were only the ones made here: keys of the desktop app's `secrets.json`, read by name, never a value; or of `eval.secrets`) aren't any scope's and aren't used; while there are any, the pane ends with `Secrets of scopes that no longer exist` (`#goneScopes`): a row each (`#goneScope-<name>`), the name over its secrets' names, and `delete` (`#goneScope-<name>-delete`, a ConfirmButton asking `delete its secrets?`: that name's secrets go from the keystore, or the browser's storage; nothing else does). They're never deleted by themselves, and never make a scope |
| Configurations | Plugins | The plugins kept (every file in `plugins/`, and every plugin a suite names), each loaded to show it: a row (`plugin-<name>`) with `<name> · <kind> · <version>`, its file and the hosts it may reach, for a fixture the names it gives (`.hint#plugin-<name>-provides`: `Gives ACME_COOKIE, ACME_CSRF, for the run`) and the lists it runs in, its phases (`.hint#plugin-<name>-phases`: `Runs in beforeAll, afterAll`; all four when it doesn't say), any problem loading it (in `--danger`), how to use it (`kind: plugin:<name>`, `{ type: <name> }`, `judges: { mine: { kind: plugin, plugin: <name> } }`, or `fixture: <name>`), "Any suite can use it: …" ("Any provider …" for a fixture), and the suites that use it (`.hint#plugin-<name>-used`: `Used by a.hafen.yml, b.hafen.yml`, those that name it in their `plugins` or use it by name; `Used by no suite yet`). There's nothing to add it to a suite: any suite uses the plugins kept by name. `edit` (the file in the [code editor](../../design/components.md#code-editor): JavaScript in colour, Tab and Enter keeping its indent, `Format`); `×` (`#plugin-<name>-delete`, asking `delete file?`). `Add a plugin` (`#newPluginForm`: its kind, `.select#newPluginKind`: Provider, Check, Judge or Fixture; its name, `.input#newPluginName`) writes `plugins/<name>.js` from a starting file that works as it is (`engine/plugin-templates.js`); a provider one also writes its provider file, `providers/<name>.yml` (`kind: plugin:<name>`; `<name>-2`… when that's taken), so it's in Providers at once, and a provider one is one of a new provider's kinds (`plugin:<name>`) at once. |
| App | Appearance | `Theme`: Light, System or Dark, side by side, the one chosen pressed (a [segmented choice](../../design/components.md#segmented-choice): `#themeChoice`, `role=radiogroup`; `#themeLight`, `#themeSystem`, `#themeDark`, `role=radio`, `aria-checked`; the arrows choose the next). System (the default) is the system's, following it as it changes. Kept in `eval.theme` (`light`, `system`, `dark`). The desktop window is drawn before the page in the theme the page last applied, or, with System or nothing chosen yet (a first start), the system's now, so a dark system never sees a light window first (`window.json`: `{ applied, choice }`) |
| App | Notifications | What a run's end does besides its toast ([Notifications](#notifications)), in [groups](../../design/components.md#settings-groups), a line between them, each under its name: **Sound** (`#notifySoundGroup`): `Play a sound when a run ends` (`.check#notifySound`, on); `When it sounds` (`.select#notifyWhen`, off without sound: "only when I'm not looking at what ran", the default, or "after every run"); **For runs that** (`#notifyRunsGroup`): `passed` (`#notifyPassed`) and `failed, or couldn't run` (`#notifyFailed`), both on; **System notifications** (`#notifySystemGroup`; `#notifySystem`: "Also show the system's notification when Hafen isn't in front": on in the desktop app; in a browser off until turned on, which asks the browser's permission; `#notifySystemState`, at the right of its name, says `allowed`, `blocked by the browser`, `asks the browser when turned on` or `this browser has none`); then, under a line of its own, `Try it` (`#notifyTry`: the sound and a sample toast, and the system's if on). Kept in `eval.notifications` |

### Providers (Settings)

Each provider is a file the app keeps (`providers/<name>.yml` in its workspace), which suites name,
and which Export writes with the suites that use it, for the command line to use as it is. The pane shows one of three things; leaving it (another pane, or closing
Settings) goes back to the list.

- **The list:** `new provider` (`.btn#newProvider`), then a
  `.settings-list` (`#providerList`) of `.settings-row`s (`provider-<name>`): the name over a `.hint`
  (`<kind> · <file>`, a plugin's kind as `plugin:<name>`, `· has problems` in `--danger`, `· in use`
  for the conversation's), `edit` (`.btn#provider-<name>-open`) and `×` (`#provider-<name>-delete`,
  asking `delete file?`, then deleting the file). After them, each provider plugin kept that no
  provider file uses (`provider-plugin-<name>`: its name over
  `plugin:<name> · <file> · no provider file yet`), with `add provider`
  (`.btn#provider-plugin-<name>-add`), which writes its provider file and opens it. Empty: "No
  providers yet. Add one: Ollama, OpenAI, Anthropic, Gemini, your own endpoint, or one of your
  provider plugins."
- **A provider**'s `Fixtures` (`#providerFixtures`, between its problems and its YAML, in its own
  [section](../../design/components.md#settings-sections), `#providerFixturesSection`: open by default
  when the provider has fixtures, or a problem with them; closed, its head says what it runs, in order,
  `#providerFixturesSummary`: `acme-login → reset-cart`, `none yet`, `· has problems` in `--danger`;
  a panel's fixtures `edit`, `edit the provider` and the way back from a fixture's `code` open it): a
  hint (where they're kept, that every suite using it runs them), then a section for each list
  (`#providerFixtures-<beforeAll|before|after|afterAll>`), its name in plain words (`Once, before the
  run`, `Before each test`, `After each test`, `Once, after the run`) over when it runs; its fixtures as
  rows in their order (`#providerFixtures-<list>-<i>`: the place, the name as written, what it gives or,
  in `--danger`, `isn't one of your fixture plugins`, or, for one in a list its phases don't name, `runs
  only in beforeAll, afterAll: it can't be in this list` (the engine refuses it too, and a message to the
  provider is stopped before it's sent, as for a fixture that isn't there), `↑` `↓` `×`: `-up`, `-down`,
  `-remove`); then `+ add a fixture` (`.select#providerFixtures-<list>-add`: the fixture plugins kept,
  each with what it gives; one whose phases don't name the list listed but not to pick, `acme-login
  (runs only in beforeAll, afterAll)`, as one in it already is; `No fixture plugins yet` with none),
  which adds one at the end. Each change is written in the provider's file at once (comments
  kept; a list left empty leaves the file; none, the key goes). A `fixtures` the file has that can't be
  read is said (`#providerFixturesProblem`), to fix in the YAML. With no fixture plugins, `add one in
  Plugins` (Settings → Plugins).
- **A provider** (`edit`): `‹ all providers` (ghost, `#providersBack`); `Name`
  (`.input#providerName`): the file's name. Changing it (on blur or Enter) renames the file,
  keeping the extension, and points every suite that uses it at the new name (their
  comments kept); a name that's taken, or with characters other than letters, digits, `.`, `-` and
  `_`, is refused with a toast and put back. Facts (kind, file, url, model), its problems, its
  fixtures (above), then its `YAML`, in its own section (`#providerYamlSection`, closed by default;
  closed, its head says `kind: http · 12 lines`, or why what's typed isn't saved, in `--danger`): the
  file, a code textarea named by its path, with the max button; saved on blur when it parses. Each
  section is open or closed as it was last left, for every provider (`eval.section.providerFixturesSection`,
  `eval.section.providerYamlSection`). YAML that doesn't parse opens its section to say why when it's
  left or tried, closed or not. `TRY IT`
  (`.btn-primary#providerTry`: chooses it for the conversation, closes Settings and focuses the
  message box), `Delete provider` (`#providerDelete`, asking `delete this file?`).
- **A new provider** (`new provider`): `‹ all providers`, then a form (`#newProviderForm`):
  - `Kind` (`.select#newProviderKind`): every kind a provider can start from, in this order:
    Ollama, OpenAI chat completions, OpenAI responses, Anthropic messages, Gemini, HTTP endpoint ·
    one JSON reply, HTTP endpoint · streamed (SSE), HTTP endpoint · streamed (JSON lines),
    WebSocket, A2A agent; then, under `Your provider plugins` (an `<optgroup>`), each provider plugin
    kept, `<name> (plugin)` (its value `plugin:<name>`; one added in Settings → Plugins is there at
    once); under it, a `.hint` (`#newProviderAbout`) saying what it's for (a plugin's: its file and
    version, and that the file says `kind: plugin:<name>`). (An A2A agent's `URL` is where its agent
    card is: the file gets `card:`.)
  - `Name` (`.input#newProviderName`): the kind's short name (`ollama`, `openai`, `anthropic`, …),
    with `-2`, `-3` added when taken; a `.hint` shows the file (`providers/<name>.yml`).
  - For a provider plugin, nothing more: the file it makes is `kind: plugin:<name>` (as Plugins'
    makes one), its other fields the plugin's settings, to add in its YAML.
  - For a preset: `Model` (`.input#newProviderModel`, Ollama's placeholder `gemma4`) and `Address`
    (`.input#newProviderBase`, a text field, the preset's default as its placeholder: it takes a
    template, `{{env.base_url}}/v1`); a `.hint#newProviderKey` names the key's secret
    (`{{secret.OPENAI_API_KEY}}`, …; none for Ollama). Otherwise `URL` (`.input#newProviderUrl`,
    placeholder `{{env.base_url}}/chat`).
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
