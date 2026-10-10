# The app

The app is where you explore an endpoint, build tests from what it says, run them, and read the
results. It comes two ways, with the same UI:

| | Start it | Notes |
|---|---|---|
| **Desktop app** | `npm run app` | Electron. Keeps your suites, providers and plugins itself, in its data folder. The engine runs in a background Node process, as in CI, so endpoints that don't allow web pages to call them still work, and secret values never reach the page |
| **Browser build** | `npm run build`, then `npm run serve -- --allow-endpoint <url>` | The same app in a browser at `http://127.0.0.1:8790`. Keeps your suites, providers and plugins in that browser's own storage. Endpoints that refuse web pages are reached through the relay, which calls only the endpoints you allow |

Either way there's nothing to open first: the app keeps your work, and [Export](#import-and-export)
writes suites to a folder, as plain files, for git and CI.

To package the desktop app (a `.app` on macOS, an installer on Windows, an AppImage on Linux), run
`npm run app:build`. Packages are written to `release/`.

## The browser build

`npm run serve` (`node server/serve.js`) serves the browser build (run `npm run build` first) with a
relay, for endpoints that don't allow web pages to call them. It's the app's, in Hafen's repository,
not the `hafen` package's (it was `hafen serve`).

```sh
npm run build
npm run serve -- --allow-endpoint https://api.acme.example/    # http://127.0.0.1:8790
```

| Option | Meaning | Default |
|---|---|---|
| `--port <n>` | Where to listen | `8790` |
| `--host <address>` | The address to listen on | `127.0.0.1` |
| `--allow-endpoint <url>` | An endpoint the relay may call: a prefix, such as `https://api.acme.example/` (repeatable; or `HAFEN_ENDPOINTS`, comma-separated) | none: the relay refuses everything |

The relay answers only the pages it serves, passes streams through unchanged, and says when it
refused a call, so the app can tell you why. A port that's taken, or isn't one, is said in a line
(exit `2`).

## The layout

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="screenshots/test-dark.png">
  <img alt="The app: the sidebar with suites and runs, a test's conversation with check badges, the turn's panel on the right, and the timeline below" src="screenshots/test-light.png">
</picture>

The sidebar is on the left, the conversation is in the middle, the panel is on the right, and the
timeline and the console run along the bottom.

### Sidebar

- **Scope button** (top right): the scope chosen, such as `staging`. Its values (over Globals') fill
  `{{env.NAME}}` in your files and messages, its secrets (over Globals') `{{secret.NAME}}`, and each
  suite's environment of that name applies. With none chosen, it's just its icon, greyed out, with a
  small **!** at its corner, and Globals are all there is. Click it to choose one, or to add and edit
  scopes and Globals ([Scopes](#scopes)). It applies to the next run, and to a conversation's next message:
  choose another while exploring and the conversation carries on in that scope (its provider's
  fixtures run again for it).
- **Conversations:** every conversation you've had while exploring, kept after each message. Open
  one to carry it on. Search by name, provider or date.
- **Suites:** your suites as a tree of suites, tests and turns, each with how its last try went
  ([Statuses](#statuses)). `+` starts a new suite: name it (or leave the name it offers, `tests`)
  and press Enter; it uses the provider you're exploring with, or the one you used last. Beside it,
  **import** has **Import suite files…** and **Import a folder…**, and **export all** exports every
  suite ([Import and export](#import-and-export)). `▷` on a row runs that suite or test. Right-click for
  **Expand all** and **Collapse all**. Search by name, tag, how a test last went (`failed`,
  `error`, `couldn't run`, `stopped`, `passed`) or when it last ran. A suite with problems says how
  many: everything a run would refuse before sending anything (a check type that isn't one, a plugin
  that isn't there, a variable nothing sets), as `hafen validate` lists them, before you run it.
- **Checks:** every kind of check, as cards: Response (Path, Text, Status, JSON), Metrics (Latency,
  Length, Tokens, Cost), Thinking and tools (Thinking, Tool called, Tool not called, Tool order,
  Sequence), System One (Noul, Choice, Score) and LLM judges (Judge, Reference). Select a turn, then
  click a card to add that check to it.
- **Runs:** every run, newest first, with runs going on at the top, each saying how it went in the
  same words as the tree. Click one to open it (read-only): one that broke off before its test shows
  why in the middle, under the test's name. **open** loads a run file, from CI for example.
- **Settings:** the gear at the bottom.

On wide screens the sidebar collapses to a rail of icons. On small screens it's a drawer.

The first time, the middle of the window offers the first steps: **Add a provider** (an endpoint to
talk to), **New conversation** and **New suite**. The Suites section offers to **import some** from
files or a folder, and the panel's provider field to **add one**.

### Thread

The middle of the window is the conversation: your message, then each reply with its thinking
(collapsed, with its time), its tool calls (`↳ lookup_order · 0.4 s`), its text (Markdown), a stats
line (time to first token, total time, tokens, cost) and a badge for each check. Everything streams
in as it arrives. A reply you stop is greyed, `stopped`, not shown as an error.

### Statuses

A test, a run and a turn say how they went in the same words everywhere (the top bar, the Suites
tree, Runs, the panel, the toast): `passed`, `failed`, `error`, `stopped`, and `couldn't run`.

- **error:** something broke that isn't what's tested: the endpoint, a judge, a provider's fixture (a
  login it couldn't reach), a setup step. In red, with why in the status's tooltip and the panel.
- **couldn't run:** the run was refused before it sent anything (a `{{env.NAME}}` the scope hasn't
  got, no scope chosen, a missing secret). The top bar says the first problem: `couldn't run:
  {{env.base_url}} isn't set…`.
- **stopped:** you stopped it. Grey, not red: nothing failed.

What a test shows is its **last try**, even one that broke off before it: the top bar, its row (and
its suite's count: `2 tests · 1 failed · 1 error`) and the test itself say `error` or `couldn't run`,
not the result before it, and the middle of the window says why above its turns (which weren't run
by it). Run it again once it's fixed.

### Message box

- **Exploring:** sends the message live. Enter sends, Shift+Enter adds a line, Esc stops.
- **With a test open:** adds the message as the test's next turn, saved to the file.

What you type isn't lost. If the provider has a problem the app can see (a fixture it names isn't
among your plugins), it's said in the panel on the right, under the provider's fixtures, with **edit the
provider**, and Send is off until it's fixed (point at Send to see why). If a message is refused
before it's sent, it goes back in the box with the reason under it.

### Panel

The panel on the right shows whatever is selected:

| Selected | The panel shows |
|---|---|
| A conversation | Its provider and its **Fixtures**, its totals, and **Save as test** (into one of your suites, or a new one). Each turn becomes a test turn with a check of the status its reply came with (`status 200`); keep it, turn it off, or delete it from the turn, and add more there |
| A suite | Its name, file, provider (and its **Fixtures**) and group, and its facts. **Run suite**, **Add test**, **Export…** and **Copy CI command** ([Import and export](#import-and-export)), and **Edit the file as YAML** |
| A test | Its provider (and its **Fixtures**), tags, repeat, pass rate, group, history, on failure, unsure, data file and, with one, **Row names** (each row's name, `row_name`: empty, its first column's value; [Data rows](test-files.md#data-rows)), setup and teardown; its last run, with charts of pass rate, p95 and cost over its last 20 runs; **Showing**, which run or data row the thread shows (a row by its name: `row 3: a refund please`); **Copy CI command** |
| A turn | Its message, extractions and checks (as cards you can turn off and on), the response as a JSON tree, the request that was sent, the raw stream, thinking and metrics. Click a value in the response to check it: choose an operator and **Add check** |
| A check | The check as YAML, its last result (value, confidence, expected, actual, reason, the judge's full answer), and the request a System One judge was asked |
| A step of the timeline | What happened in it: thinking, a tool call's arguments and result, a request and its response, a judge's question and answer, a retry's reason, a fixture (when it ran, what it gave), a plugin's or fixture's HTTP call (what it sent and what came back, secrets redacted) |
| A run | Its summary (verdict, where it ran, latency p50/p95/p99, tokens, cost), its tests, **Compare with** an earlier run, **export JSON** and **run again** |

### Timeline

The **Timeline** under the work area draws every step of the run as a bar: one group per turn
(plus setup and teardown), with requests, thinking, tool calls, the answer, checks and judge calls
inside. Bars grow while the run goes on. Click a bar to scroll the thread to it and open it in the
panel. **fit** fits the run to the width; `⌘`/`Ctrl` and the wheel zoom.

With a suite open, the timeline shows its latest run: the suite's bar, with each test's bar
folded under it.

The zoom buttons (`−`, the level, `+`) sit in the corner above the step names, so they never cover a
bar. Drag the timeline's top edge to make it taller; it remembers.

A provider's [fixtures](plugins.md#fixtures) are steps too, each with the HTTP calls it made, and so
is every call a plugin makes. When a run has fixtures, **hide fixtures** in the timeline's head hides
them (from the console too), and **show fixtures** brings them back.

### Console

The **Console** at the bottom logs everything that happened, one line each, as an audit log: each
fixture as it ends (a conversation's `after` and `afterAll` ones too, when you leave it), and each
HTTP call, saying which plugin or fixture made it. Its **hide fixtures** is the timeline's. It
starts closed, so the conversation has the room: click **Console** to open it (it remembers), and
drag its top edge to make it taller. A suite's problems are logged once each, not again every time
its file is read.

Notifications (a run that ended, something that couldn't be saved) appear at the top right of the
conversation, under the top bar, so they never cover the panel or the top bar's buttons.

On a small screen the panel slides over the conversation: its hide button (next to `×`) puts it
away and keeps what's open open; the top bar's button brings it back.

## Building tests

1. **Explore.** Pick a provider, send messages, and see what comes back.
2. **Save as test.** In the panel, choose a suite (or *New suite…*), name the test, and press
   **Save as test**. The conversation's messages become the test's turns.
3. **Add checks.** Select a turn, then click a value in its response, or a card under **Checks**.
4. **Run.** Press `▷`, or `⌘↵` (`Ctrl+Enter` on Windows and Linux).

Everything you do is saved straight away, to the suite as the app keeps it: a plain YAML file. The
app keeps the file's comments, blank lines, key order and quoting, and changes only the lines an edit
is about, so the file Export writes, once committed, shows a one-field change as a one-line diff.

## Running

| Selected | `⌘↵` / `Ctrl+Enter` runs |
|---|---|
| A turn (or one of its checks) | The test up to and including that turn |
| A test | The test |
| A suite | The whole suite |

While a run goes on, the same shortcut (or `▷`, or Esc) stops it. Several runs can go on at once.
When a run ends you get a toast, and, if you like, a sound and a system notification (Settings →
Notifications).

## Settings

| Group | Pane | What it's for |
|---|---|---|
| Storage | Runs, Conversations | What the app keeps, with sizes. Delete one, or clear all |
| Connection | Providers | Your providers: add one (Ollama, OpenAI, Anthropic, Gemini, an HTTP endpoint, or one of your provider plugins: `plugin:<name>`), set its [fixtures](plugins.md#fixtures) (a list for each of the four, each in its order; a fixture is offered only in the lists it runs in, its `phases`), edit its YAML, rename it, **Try it**. **Fixtures** and **YAML** each open and close (Fixtures is open when the provider has some, YAML closed until you open it, and each stays as you leave it, for every provider); closed, each says what's in it (`acme-login → reset-cart`, `kind: http · 12 lines`). YAML that doesn't parse isn't saved, and isn't lost: it stays in the field with the problem and its line under it, **Try it** waits until it's fixed, and closing Settings asks (**discard edits?**) before it throws your edits away, opening the YAML to show why |
| Connection | System One | The `JEV_API_KEY` that System One checks use |
| Connection | Relay | The relay's address and whether it answers (browser build) |
| Configurations | Environments | Globals and your scopes, each with its environment values (`{{env.NAME}}`), and which scope is chosen. Search, import, export and edit them as `.env` files |
| Configurations | Secrets | Globals' and each scope's secrets (`{{secret.NAME}}`), masked until you show them. Search, import, export and edit them as `.env` files |
| Configurations | Plugins | Your plugins: add one from a starting file (a provider plugin is then a kind a new provider can be, and comes with a provider file of its own), edit it, see which suites use it, and the lists a fixture runs in. A fixture's or a call's link (on the timeline, in the panel, in a provider's fixtures) opens its code; closing the editor takes you back where the link was |
| App | Appearance | **Light**, **System** or **Dark**, side by side (System, the default, follows the system as it changes) |
| App | Notifications | When a run ends: a **Sound** (and when it plays), **For runs that** passed or failed, and **System notifications**, each a group of its own; **Try it** |

## Scopes

A scope is a set of values to switch between, such as `staging` and `prod`: a name, its
**environment values** and its **secrets**. It works the way the command line's `--env` and
`--secret` files do; the app just keeps as many as you like and swaps between them with the scope
button. **Globals** hold values and secrets for every scope. Your files say what they take from the
scope chosen:

```yaml
# providers/acme.yml
url: "{{env.base_url}}/chat"
headers: { Authorization: "Bearer {{secret.ACME_KEY}}" }
```

`{{env.NAME}}` is one of the scope's environment values, else Globals' (or, failing both, the suite's
`environments:` entry of the scope's name); `{{secret.NAME}}` (or `{{secrets.NAME}}`) is one of its
secrets, else Globals'. So a name only Globals has is Globals', a name both have is the scope's (it
**overrides** Globals), and a name only the scope has is the scope's. With no scope chosen, Globals'
are all there is. They work in suites, providers, plugins' settings and the message box. A name
neither has is an error: a run stops before it sends anything and says why, a message's turn says why
and nothing is sent, and a field says so under it as you type.

**Settings → Environments** (the scope button opens it) and **Settings → Secrets** look alike, as an
API client's environments do:

- **On the left**, **Globals** at the top, then a line, then your **Scopes**. The scope chosen has a
  ✓; a scope (or Globals) missing names your files use says how many (`2 not set`). **+** adds a scope
  (letters, digits, `.`, `-` and `_`; not `globals`, `global` or `every-scope`, and not ending
  `.secret`, since its files would meet another's). Each scope's **⋯** (or a right-click) has
  **Choose it**, **Rename**, **Duplicate** (a copy with its values and secrets) and **Delete** (asking
  first).
- **On the right**, the one you picked: its name (click it to rename a scope), **choose it** (or, on
  Globals, **choose no scope**), a search, **import .env**, **export .env** and **edit as .env**, and a
  table: each name with how a file uses it (`{{env.base_url}}`), its value (changed as you leave the
  field) and its **Source**: `this scope`, `overrides Globals`, `from Globals` (Globals' value,
  greyed: **override** gives the scope its own, starting from Globals'), or `not set` (your files use
  it and neither has it: type its value there). On Globals, a name some scopes override says which.
  The last row adds a name: type it and its value, then press Enter (there's no add button). `×`
  (asking **delete**) deletes one. **Delete scope** at the end asks
  first, then deletes all of the scope at once: its values and its secrets. It's gone from every
  list, and nothing brings it back (a suite's `environments:` entry of its name doesn't make a scope,
  and neither do secrets).
- **Secrets** are masked: **show** shows one (**show all** every one) until you hide it; type a new
  value over the dots to change it. **forget** asks first (**forget it?**). **export .env** asks first
  (**write them in plain text?**), then writes the entry's own: `globals.secret.env` or
  `<scope>.secret.env`; keep it out of version control. Secrets kept for a name that isn't a scope now
  (from before the scopes were only the ones you add) aren't used; while there are any, **Secrets of
  scopes that no longer exist** at the end of the pane lists each name with its secrets' names, and
  **delete** (asking **delete its secrets?**) deletes them.

**Import .env** reads a `KEY=VALUE` file into the entry shown (a name is letters, digits, `_`, `.`
and `-`, as the command line's files take it, so `db.password` is fine); a file that isn't one says
its first problem and where, and changes nothing (a secrets file's problem never shows what's in the
line). **Export .env** writes the entry's own: `globals.env` or `<scope>.env`. **Edit as .env** edits
them all as text.

**Where they're kept:** environment values in the app's storage (the browser's, in the browser
build), one entry a scope and one for Globals, never in your suites' files. Secrets: in the desktop
app, in the app's data folder, each encrypted by the system's keychain (and marked as such; on a
system that offers no encryption, they're kept unencrypted, the pane says so, and they're encrypted
once it can); in the browser build, in that browser's storage, unencrypted (the pane says so). Another
tab or window follows a change. Secret values are never written to your files, and they're redacted
from every run, report and log, used or not. A change applies from the next run or message.

**In CI**, give the run the files Export writes: `globals.env` and `<scope>.env` (and, asked first,
`globals.secret.env` and `<scope>.secret.env`) beside the suites, each only when it has something in
it; a later `--env` or `--secret` file wins, so the scope's override Globals' as in the app. **Copy CI
command** names exactly the files that export wrote ([Import and export](#import-and-export)).

**Suites from before scopes were the app's** (values in `environments/<scope>.yml` files): the app
doesn't read those files. Add the scope in Settings → Environments and give it the file's values
(add them, or **edit as .env** and write them as `NAME=value` lines), and its secrets in Settings →
Secrets.

## Import and export

The app keeps your suites, providers, plugins and data files itself, as plain files, in its
**workspace**: in the desktop app, its data folder's `workspace/`; in the browser build, that
browser's own storage (its private file system). You never pick a folder to work in. To bring suites
in, or take them out for git and CI, you import and export them.

- **Import** (the Suites section's **import**, or its note's **import some**): **Import suite
  files…** or **Import a folder…** (the folder's suites, in its subfolders too). Each suite comes in
  with everything it uses, at the same paths: its provider files, data files, prices file and JSON
  Schemas, and its plugins (the ones it names, and the ones in `plugins/` it uses by name: a
  provider's `kind: plugin:acme` or fixtures, a judge, a check's type), each with the files it
  imports. Never a secret: they aren't files. A file that's here already with the same text is left
  as it is; if any are here with another text, you're asked once, listing them: **Replace** (theirs
  over yours), **Keep both** (theirs beside yours as `name-2.yml`, the suites imported using them; a
  plugin is used by its name, so yours stays), **Skip** (yours stay, theirs aren't imported) or
  **Cancel**. A toast says what came in, and the console lists each file. In a browser, files picked
  one by one come without their folders: pick a suite's provider, data and plugin files with it, and
  each is found by the path the suite names it by (or import the folder).
- **Export** (a suite's panel → **Export…**, or Suites → **export all**): the dialog lists what goes
  (the suites and everything they use, as Import brings in), and **Also write globals.env and
  `<scope>.env`** (Globals' values and the scope chosen's, each its own, only the ones that have any:
  on). **Export** asks for a folder and writes them there as plain files with the same paths, so `npx
  hafen run <folder> --env <folder>/globals.env --env <folder>/<scope>.env` runs them as they are;
  **Export with secrets** asks first (**write them in plain text?**) and also writes
  `globals.secret.env` and `<scope>.secret.env` (keep them out of version control). Files in the folder already with another
  text are listed and asked about first (**Overwrite** or **Cancel**). Export into your repository,
  and commit the folder ([Running in CI](ci.md)).
- **Copy CI command** (a suite's or a test's panel) copies the command that runs the folder the suite
  was last exported to: `npx hafen run "hafen-tests" --env hafen-tests/globals.env --env
  hafen-tests/staging.env --secret hafen-tests/globals.secret.env --secret
  hafen-tests/staging.secret.env --report …` (in the desktop app, the folder's path from the top of its
  git repository; outside one, its whole path; a browser knows only its name). It names exactly the
  files that export wrote there, never one it didn't. Under it, the panel says where it was exported,
  when and with which files; never exported, it says so, and the button opens Export instead.

**The folder the desktop app opened before** (when it worked on a folder of yours): the first time
this version starts, it asks once, **Import the suites from <folder>?**: **Import** copies them in (as
Import a folder does; the folder stays as it is), **Not now** leaves them (Import a folder… brings
them in any time). Either way it isn't asked again.

## Keyboard

| Keys | Does |
|---|---|
| `⌘↵` / `Ctrl+Enter` | Runs what's selected, or stops the run going on |
| Esc | Stops every run (in a dialog, closes it instead) |
| Enter / Shift+Enter | In the message box: send / a new line |
| `⌘`/`Ctrl` + wheel | Zooms the timeline |

## Where the desktop app keeps things

- **Everything** is kept in the app's data folder, *Hafen Lab* (`~/Library/Application
  Support/Hafen Lab` on macOS). Set `HAFEN_LAB_DATA` to use another folder.
- **Your suites, providers, plugins and data files** are plain files in its `workspace/` folder, as
  the engine reads them (leave it to the app: [Export](#import-and-export) writes copies for git).
- **Runs, conversations and app state** are in its page storage (IndexedDB and Local Storage).
- **Secrets** are in `secrets.json` in that folder, by scope (`""` is Globals'), each value encrypted
  with a key the system's keychain keeps under *Hafen Lab* and marked as encrypted
  (`{ "encrypted": true, "value": … }`). Scopes' and Globals' environment values are in its page
  storage.
