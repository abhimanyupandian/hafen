# The app

The app is where you explore an endpoint, build tests from what it says, run them, and read the
results. It comes two ways, with the same UI:

| | Start it | Notes |
|---|---|---|
| **Desktop app** | `npm run app` | Electron. Opens a folder of suites and works on its files directly. The engine runs in a background Node process, as in CI, so endpoints that don't allow web pages to call them still work, and secret values never reach the page |
| **Browser build** | `npm run build`, then `node cli/hafen.js serve --allow-endpoint <url>` | The same app in a browser at `http://127.0.0.1:8790`. Opens suite files rather than a folder. Endpoints that refuse web pages are reached through the relay, which calls only the endpoints you allow |

To package the desktop app (a `.app` on macOS, an installer on Windows, an AppImage on Linux), run
`npm run app:build`. Packages are written to `release/`.

## The layout

```
┌─ sidebar ─────────────┬─ work area ─────────────────────────────────┬─ panel ──────────────────┐
│ logo     [staging ▾]  │ title                            ▷  status  │ what's selected       ×  │
├───────────────────────┼─────────────────────────────────────────────┼──────────────────────────┤
│ ▾ CONVERSATIONS       │                                       user  │ fields, facts,           │
│ ▾ SUITES        + …   │   I want a refund for 4417                  │ the JSON tree, …         │
│   ▾ refunds.hafen.yml │                                             │                          │
│     ▾ refund for… 2/3 │   acme-support                              │                          │
│        turn 1     6/6 │   + thinking · summary · 1.8 s              │                          │
│ ▸ CHECKS              │   ↳ lookup_order · 0.4 s                    │                          │
│ ▾ RUNS                │   I'm sorry it arrived broken…              │                          │
│   refund for… failed  │   0.62 s to first token · 2.2 s · …         │                          │
│                       │   ● status 200  ● contains 4417  ● noul 0.91│                          │
│                       ├─────────────────────────────────────────────┤                          │
│                       │ message box                          SEND   │                          │
│                       ├─────────────────────────────────────────────┴──────────────────────────┤
│                       │ ▾ TIMELINE   fit                                                       │
│ ⚙                     │ ▸ CONSOLE                                                              │
└───────────────────────┴────────────────────────────────────────────────────────────────────────┘
```

### Sidebar

- **Scope button** (top right): the scope chosen, such as `staging`. It fills `{{scope.NAME}}` in
  your files and picks each suite's environment of that name. Click it to choose another
  ([Scopes](test-files.md#scopes)).
- **Conversations:** every conversation you've had while exploring, kept after each message. Open
  one to carry it on. Search by name, provider or date.
- **Suites:** your suite files as a tree of suites, tests and turns, each with its last result.
  `+` starts a new suite; **open a folder** (or **open files** in the browser build) loads yours.
  `▷` on a row runs that suite or test. Right-click for **Expand all** and **Collapse all**.
- **Checks:** every kind of check, as cards: Response (Path, Text, Status, JSON), Metrics (Latency,
  Length, Tokens, Cost), Thinking and tools (Thinking, Tool called, Tool not called, Tool order,
  Sequence), System One (Noul, Choice, Score) and LLM judges (Judge, Reference). Select a turn, then
  click a card to add that check to it.
- **Runs:** every run, newest first, with runs going on at the top. Click one to open it (read-only).
  **open** loads a run file, from CI for example.
- **Settings:** the gear at the bottom.

On wide screens the sidebar collapses to a rail of icons. On small screens it's a drawer.

### Thread

The middle of the window is the conversation: your message, then each reply with its thinking
(collapsed, with its time), its tool calls (`↳ lookup_order · 0.4 s`), its text (Markdown), a stats
line (time to first token, total time, tokens, cost) and a badge for each check. Everything streams
in as it arrives.

### Message box

- **Exploring:** sends the message live. Enter sends, Shift+Enter adds a line, Esc stops.
- **With a test open:** adds the message as the test's next turn, saved to the file.

### Panel

The panel on the right shows whatever is selected:

| Selected | The panel shows |
|---|---|
| A conversation | Its provider, its totals, and **Save as test** (into a suite of the folder, or a new one). The replies' current values come as suggested checks to keep or drop |
| A suite | Its name, file, provider and group, and its facts. **Run suite**, **Add test**, **Copy CI command**, and **Edit the file as YAML** |
| A test | Its provider, tags, repeat, pass rate, group, history, on failure, unsure, data file, setup and teardown; its last run, with charts of pass rate, p95 and cost over its last 20 runs; **Copy CI command** |
| A turn | Its message, extractions and checks (as cards you can turn off and on), the response as a JSON tree, the request that was sent, the raw stream, thinking and metrics. Click a value in the response to check it: choose an operator and **Add check** |
| A check | The check as YAML, its last result (value, confidence, expected, actual, reason, the judge's full answer), and the request a System One judge was asked. **Agree** or **Disagree** to review a judge |
| A step of the timeline | What happened in it: thinking, a tool call's arguments and result, a request and its response, a judge's question and answer, a retry's reason |
| A run | Its summary (verdict, where it ran, latency p50/p95/p99, tokens, cost), its tests, **Compare with** an earlier run, **export JSON** and **run again** |

### Timeline

The **Timeline** under the work area draws every step of the run as a bar: one group per turn
(plus setup and teardown), with requests, thinking, tool calls, the answer, checks and judge calls
inside. Bars grow while the run goes on. Click a bar to scroll the thread to it and open it in the
panel. **fit** fits the run to the width; `⌘`/`Ctrl` and the wheel zoom.

With a suite open, the timeline shows its latest run: the suite's bar, with each test's bar
folded under it.

### Console

The **Console** at the bottom logs everything that happened, one line each, as an audit log.

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
| Connection | Providers | The folder's providers: add one (Ollama, OpenAI, Anthropic, Gemini, an HTTP endpoint, a WebSocket), edit its YAML, rename it, **Try it** |
| Connection | System One | The `JEV_API_KEY` that System One checks use |
| Connection | Relay | The relay's address and whether it answers (browser build) |
| Configurations | Environments | Each scope's plain variables (`environments/<scope>.yml`), and which scope is chosen |
| Configurations | Secrets | Each scope's secret values, by name. Files use them as `${env:NAME}` or `{{scope.NAME}}` |
| Configurations | Plugins | The folder's plugins: add one from a starting file, edit it, see which suites use it |
| App | Appearance | Light, dark, or as the system's |
| App | Notifications | A sound and system notifications when a run ends |

**Secrets:** in the desktop app, secret values are stored encrypted by the system. In the browser
build they're kept in that browser's storage, and the pane says so. Secret values are never written
to your files, and they're redacted from every run, report and log.

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
- **Secrets** are in the system's keychain, under *Hafen Lab*.

If you used Hafen when it was called *hafen eval*, its runs, conversations and settings are copied
over the first time the app starts. Secrets aren't: enter them again in Settings → Secrets and
Settings → System One.
