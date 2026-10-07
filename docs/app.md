# The app

The app is where you explore an endpoint, build tests from what it says, run them, and read the
results. It comes two ways, with the same UI:

| | Start it | Notes |
|---|---|---|
| **Desktop app** | `npm run app` | Electron. Opens a folder of suites and works on its files directly. The engine runs in a background Node process, as in CI, so endpoints that don't allow web pages to call them still work, and secret values never reach the page |
| **Browser build** | `npm run build`, then `npm run serve -- --allow-endpoint <url>` | The same app in a browser at `http://127.0.0.1:8790`. Opens suite files rather than a folder. Endpoints that refuse web pages are reached through the relay, which calls only the endpoints you allow |

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

- **Scope button** (top right): the scope chosen, such as `staging`. Its values fill `{{env.NAME}}`
  in your files and messages, its secrets `{{secret.NAME}}`, and each suite's environment of that name
  applies. With none chosen, it's just its icon, greyed out, with a small **!** at its corner. Click
  it to choose one, or to add and edit scopes ([Scopes](#scopes)). It applies to the next run, and to a conversation's next message:
  choose another while exploring and the conversation carries on in that scope (its provider's
  fixtures run again for it).
- **Conversations:** every conversation you've had while exploring, kept after each message. Open
  one to carry it on. Search by name, provider or date.
- **Suites:** your suite files as a tree of suites, tests and turns, each with its last result.
  `+` starts a new suite: name it (or leave the name it offers, `tests`) and press Enter; it uses
  the provider you're exploring with, or the one you used last. **Open a folder** (or **open
  files** in the browser build) loads yours. `▷` on a row runs that suite or test. Right-click for
  **Expand all** and **Collapse all**. Search by name, tag, how a test last went (`failed`,
  `stopped`, `passed`) or when it last ran. A suite with problems says how many: everything a run
  would refuse before sending anything (a check type that isn't one, a plugin that isn't there, a
  variable nothing sets), as `hafen validate` lists them, before you run it.
- **Checks:** every kind of check, as cards: Response (Path, Text, Status, JSON), Metrics (Latency,
  Length, Tokens, Cost), Thinking and tools (Thinking, Tool called, Tool not called, Tool order,
  Sequence), System One (Noul, Choice, Score) and LLM judges (Judge, Reference). Select a turn, then
  click a card to add that check to it.
- **Runs:** every run, newest first, with runs going on at the top. Click one to open it (read-only).
  **open** loads a run file, from CI for example.
- **Settings:** the gear at the bottom.

On wide screens the sidebar collapses to a rail of icons. On small screens it's a drawer.

The first time, with no folder open, the middle of the window and the Suites section both offer
**Open a folder**; the panel's provider field says **open a folder** too, since providers are files
in one.

### Thread

The middle of the window is the conversation: your message, then each reply with its thinking
(collapsed, with its time), its tool calls (`↳ lookup_order · 0.4 s`), its text (Markdown), a stats
line (time to first token, total time, tokens, cost) and a badge for each check. Everything streams
in as it arrives.

### Message box

- **Exploring:** sends the message live. Enter sends, Shift+Enter adds a line, Esc stops.
- **With a test open:** adds the message as the test's next turn, saved to the file.

What you type isn't lost. If the provider has a problem the app can see (a fixture it names isn't
in the folder), it's said in the panel on the right, under the provider's fixtures, with **edit the
provider**, and Send is off until it's fixed (point at Send to see why). If a message is refused
before it's sent, it goes back in the box with the reason under it.

### Panel

The panel on the right shows whatever is selected:

| Selected | The panel shows |
|---|---|
| A conversation | Its provider and its **Fixtures**, its totals, and **Save as test** (into a suite of the folder, or a new one). Each turn becomes a test turn with a check of the status its reply came with (`status 200`); keep it, turn it off, or delete it from the turn, and add more there |
| A suite | Its name, file, provider (and its **Fixtures**) and group, and its facts. **Run suite**, **Add test**, **Copy CI command** (with the scope's files: [Scopes](#scopes)), and **Edit the file as YAML** |
| A test | Its provider (and its **Fixtures**), tags, repeat, pass rate, group, history, on failure, unsure, data file, setup and teardown; its last run, with charts of pass rate, p95 and cost over its last 20 runs; **Copy CI command** |
| A turn | Its message, extractions and checks (as cards you can turn off and on), the response as a JSON tree, the request that was sent, the raw stream, thinking and metrics. Click a value in the response to check it: choose an operator and **Add check** |
| A check | The check as YAML, its last result (value, confidence, expected, actual, reason, the judge's full answer), and the request a System One judge was asked. **Agree** or **Disagree** to review a judge |
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

Everything you do is written to the suite's file straight away. The app keeps the file's comments,
blank lines, key order and quoting, and changes only the lines an edit is about. If something else
changes the file, the app reads it again and shows it as it is.

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
| Connection | Providers | The folder's providers: add one (Ollama, OpenAI, Anthropic, Gemini, an HTTP endpoint, a WebSocket, an A2A agent), set its [fixtures](plugins.md#fixtures) (a list for each of the four, each in its order), edit its YAML, rename it, **Try it**. YAML that doesn't parse isn't saved, and isn't lost: it stays in the field with the problem and its line under it, **Try it** waits until it's fixed, and closing Settings asks (**discard edits?**) before it throws your edits away |
| Connection | System One | The `JEV_API_KEY` that System One checks use |
| Connection | Relay | The relay's address and whether it answers (browser build) |
| Configurations | Environments | Your scopes and each one's environment values (`{{env.NAME}}`), and which scope is chosen. Import and export `.env` files |
| Configurations | Secrets | Each scope's secrets, and the ones kept for every scope (`{{secret.NAME}}`). Import and export `.env` files |
| Configurations | Plugins | The folder's plugins: add one from a starting file, edit it, see which suites use it. A fixture's or a call's link (on the timeline, in the panel, in a provider's fixtures) opens its code; closing the editor takes you back where the link was |
| App | Appearance | Light, dark, or as the system's (the default: until you choose, the app follows the system) |
| App | Notifications | A sound and system notifications when a run ends |

## Scopes

A scope is a set of values to switch between, such as `staging` and `prod`: a name, its
**environment values** and its **secrets**. It works the way the command line's `--env` and
`--secret` files do; the app just keeps as many as you like and swaps between them with the scope
button. Your files say what they take from the scope chosen:

```yaml
# providers/acme.yml
url: "{{env.base_url}}/chat"
headers: { Authorization: "Bearer {{secret.ACME_KEY}}" }
```

`{{env.NAME}}` is one of the scope's environment values (or, failing that, the suite's
`environments:` entry of the scope's name); `{{secret.NAME}}` (or `{{secrets.NAME}}`) is one of its
secrets, or one kept for every scope. They work in suites, providers, plugins' settings and the
message box. A name the scope hasn't got is an error: a run stops before it sends anything and says
why, a message's turn says why and nothing is sent, and a field says so under it as you type.
The old ways to write them, `{{scope.NAME}}` and `${env:NAME}`, fill nothing: a file that has one
can't run until it's written the new way, and a field that has one says what to write instead.

- **Settings → Environments** (the scope button opens it): **add scope**, then its values as
  `NAME = value` rows: add, change (saved as you leave the field), delete (`×`, then **delete**).
  Rename a scope in its **Name** field; **Delete scope** asks first, then deletes all of it at once:
  the scope, its values and its secrets. It's gone from every list, and nothing brings it back (a
  suite's `environments:` entry of its name doesn't make a scope, and neither do secrets: the scopes
  are only the ones you add here). **Import .env** reads a `KEY=VALUE` file into the scope, **Export
  .env** writes `<scope>.env`, and **Edit as .env** edits them all as text. Choose **no scope** in the
  list to use none.
- **Settings → Secrets:** the same for the scope's secrets, which are never shown once saved.
  **forget** asks first (**forget it?**). **Import .env** reads a secrets file; **Export .env** asks
  first (**write them in plain text?**), then writes `<scope>.secret.env`, with the scope's own
  secrets and the ones kept for every scope: keep it out of version control. The pane opens on the
  scope chosen; **every scope** holds values that apply wherever a scope has none of its own.

**Where they're kept:** environment values in the app's storage (the browser's, in the browser
build), one entry a scope, never in your folder. Secrets: in the desktop app, encrypted by the
system's keychain, in the app's data folder; in the browser build, in that browser's storage,
unencrypted (the pane says so). Secret values are never written to your files, and they're redacted
from every run, report and log. A change applies from the next run or message.

**In CI**, export the scope's two files and pass them: **Copy CI command** gives
`npx hafen run "smoke.hafen.yml" --env staging.env --secret staging.secret.env --report …`
for the scope chosen.

**A folder from before scopes were the app's** (values in `environments/<scope>.yml` files): the app
doesn't read those files. Add the scope in Settings → Environments and give it the file's values
(add them, or **Edit as .env** and write them as `NAME=value` lines), and its secrets in Settings →
Secrets.

## Keyboard

| Keys | Does |
|---|---|
| `⌘↵` / `Ctrl+Enter` | Runs what's selected, or stops the run going on |
| Esc | Stops every run (in a dialog, closes it instead) |
| Enter / Shift+Enter | In the message box: send / a new line |
| `⌘`/`Ctrl` + wheel | Zooms the timeline |

## Where the desktop app keeps things

- **Your files** stay in the folder you opened. Runs of that folder are also written to its
  `.hafen/runs/` folder (git-ignore it).
- **Runs, conversations and app state** are kept in the app's data folder, *Hafen Lab*
  (`~/Library/Application Support/Hafen Lab` on macOS). Set `HAFEN_LAB_DATA` to use another folder.
- **Secrets** are in `secrets.json` in that folder, each value encrypted with a key the system's
  keychain keeps under *Hafen Lab*. Scopes' environment values are in its page storage.

If you used Hafen when it was called *hafen eval*, its runs, conversations and settings are copied
over the first time the app starts. Secrets aren't: enter them again in Settings → Secrets and
Settings → System One.
