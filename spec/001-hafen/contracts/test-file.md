# Contract: the test file

A suite is one YAML or JSON file. The app writes it, people edit it, and the CLI runs it unchanged.
Its exact shape is [suite.schema.json](suite.schema.json); this page explains it.

## Names and places

- **File names:** `*.hafen.yml`, `*.hafen.yaml` or `*.hafen.json`. The app and the CLI find suites
  in a folder by these names.
- **Providers:** `providers/*.yml` beside the suites, by convention; any path works.
- **Data files:** CSV or JSON lines, by path relative to the suite.
- **Prices:** `prices.yml`, by path from a suite.
- **Runs (desktop app):** `.hafen/runs/` in the opened folder, git-ignored.

YAML files can name the schema for editors on their first line:

```yaml
# yaml-language-server: $schema=https://…/suite.schema.json
```

(The published address is set when the schema is published; until then, a path to
`spec/001-hafen/contracts/suite.schema.json`.)

## A complete example

```yaml
# tests/support/refund.hafen.yml
version: 1
name: Support bot · refunds
provider: providers/acme-support.yml

environments:
  local:   { base_url: "http://localhost:8791" }
  staging: { base_url: "https://staging.acme.example" }

variables:
  customer: Priya

judges:
  default: { kind: systemone }                          # TypeSafe's System One (Jev); key from ${env:JEV_API_KEY}
  rubric:  { kind: llm, provider: claude-judge, samples: 3 }   # an LLM judge
providers:
  claude-judge: providers/anthropic-judge.yml

defaults:
  repeat: 3
  pass_rate: 0.67
  unsure: warn            # pass | warn | fail
  timeout_ms: 60000

setup:
  - name: log in
    request:
      url: "{{base_url}}/auth"
      method: POST
      body: { user: "qa-bot", password: "${env:ACME_QA_PASSWORD}" }
    extract:
      token: $.access_token

tests:
  - name: refund for a broken item
    id: t_8f2k1q9z
    tags: [refunds, smoke]
    turns:
      - user: "Hi, I'm {{customer}}. I want a refund for order 4417"
        extract:
          session: $.session_id
        expect:
          - { type: status, equals: 200 }
          - { path: $.reply.text, contains: "4417" }
          - { path: $.reply.order.id, equals: 4417 }
          - { type: latency, max_ms: 3000 }
          - { on: thinking, type: present }
          - type: systemone.noul
            question: Does the reply ask why they want a refund?
            min: 0.8
      - user: "It arrived broken"
        expect:
          - { path: "$.reply.actions[*].type", contains: refund }
          - type: tool.called
            tool: lookup_order
            args: { $.order_id: 4417 }
          - type: judge
            judge: rubric
            rubric:
              - Offers a refund without asking for a photo first
              - Apologises once, not repeatedly
            min: 0.7
    expect_conversation:
      - { type: systemone.noul, question: "Was the customer's problem resolved?", min: 0.7 }

  - name: refund questions from the data file
    data: data/refund-questions.csv     # columns: question, order
    repeat: 1
    turns:
      - user: "{{row.question}}"
        expect:
          - { path: $.reply.order.id, equals: "{{row.order}}" }
```

## Top-level keys

| Key | Required | Meaning |
|---|---|---|
| `version` | yes | `1`. A higher major version is refused (exit 2) |
| `name` | | Shown in the app and reports; defaults to the file name |
| `group` | | The suite's group, a whole number of 1 or more ([Groups](#groups)) |
| `provider` | yes, here or on every test | A provider: a file path, a preset (`openai-chat`, `openai-responses`, `anthropic-messages`, `gemini`, `ollama`), `plugin:<name>`, or an inline provider object ([provider.md](provider.md)) |
| `providers` | | Named providers, used by judges, simulated users, or tests that override `provider` |
| `environments` | | Named sets of variables; one is chosen per run (`--env`, or the app's environment picker); the first is the default |
| `variables` | | Suite variables |
| `judges` | | Named judges ([checks.md](checks.md#judges)); `default` is used when a check names none |
| `defaults` | | Test settings every test starts from |
| `setup`, `teardown` | | Steps around the whole suite |
| `plugins` | | More plugin modules: paths relative to the suite (`./plugins/acme.js`), or package names (found from the folder, in Node: the CLI and the desktop app). The folder's own plugins (`plugins/*.js`: the app's opened folder, the CLI's current folder) need no naming: any suite uses them by name (`kind: plugin:acme`, a judge's `plugin: acme`, a check's `type: acme`). Each is loaded, in a worker of its own, before anything is sent; one that can't be found or loaded, or a name no plugin has, is a setup error |
| `prices` | | A prices file path, or `{ <model>: { input, output, cached_input? } }` (USD per million tokens) |
| `redact` | | `{ patterns: [email, card, phone], headers: [x-session-token] }`, added to the defaults |
| `tests` | yes | The tests. An empty list (`tests: []`) is valid, with the warning "no tests yet"; running only empty suites (or a `--test` / `--tag` that matches nothing) exits 2 |

## Test keys

| Key | Meaning |
|---|---|
| `name` | Required; unique in the file |
| `id` | Stable id (`t_` + 8 characters), written by the app the first time it saves a test, so history follows a rename. Optional in hand-written files |
| `tags` | For `--tag` |
| `group` | The test's group in its suite, a whole number of 1 or more ([Groups](#groups)) |
| `provider` | Overrides the suite's |
| `data` | A CSV (with a header row) or JSON-lines file; the test runs once per row; `{{row.<column>}}` |
| `setup`, `teardown` | Steps; teardown always runs |
| `turns` | The conversation |
| `simulate` | A simulated user: `{ user: <provider name>, scenario, stop_when, max_turns, expect_each: [checks] }`. **Not built yet:** the file loads with a warning on it, and running the test is an error saying so (never a pass with nothing sent) |
| `expect_conversation` | Checks after the last turn, on the whole conversation |
| `repeat`, `pass_rate`, `history`, `on_fail`, `unsure`, `unsure_below`, `timeout_ms`, `retries`, `network`, `load` | Settings ([data-model.md](../data-model.md#testsettings)) |

`load` turns a test into a load test (needs `--load` in CI and confirmation in the app; load mode
isn't built yet: without `--load` it's skipped, with it a setup error, [cli.md](cli.md#options-for-run)):

```yaml
load: { concurrency: 20, requests: 200, ramp_s: 10 }   # or duration_s instead of requests
```

## Groups

What runs at the same time is said in the files, by groups (there's no "at once" setting, in the
app or the command line):

- A suite's tests with the same `group` run one after another, in the file's order; tests in
  different groups run at the same time. Tests with no `group` are one group of their own (so a
  suite with no groups runs its tests one after another).
- The suites of a run, the same way, by their top-level `group`: the same group one after another,
  in the order given; different groups at the same time; suites with none, one group.
- A test's repeats, data rows and turns always go in order.

```yaml
group: 1                 # this suite runs alongside suites of other groups
tests:
  - { name: refunds, group: 1, turns: […] }      # refunds, then returns
  - { name: returns, group: 1, turns: […] }
  - { name: billing, group: 2, turns: […] }      # alongside them
```

`--bail` and `--max-cost` stop every group. A suite whose setup fails doesn't stop the suites after
it in its group; the run is a setup error once they've run.

## Turn keys

| Key | Meaning |
|---|---|
| `user` | The message. A string, or a list of parts for providers that take them: `[{ text: "…" }, { image: images/receipt.png }]`. Text parts are sent joined by newlines; **other parts (an image, a file) aren't built yet:** a warning on the file, and running the turn is an error saying so, nothing sent (never the text alone) |
| `attachments` | `[{ file: docs/invoice.pdf, type?: application/pdf }]`, sent as the provider says. **Not built yet:** as other parts |
| `reply` | With `history: pinned`: the reply earlier turns are given instead of the live one |
| `extract` | `{ <variable>: <path> }`, read from the response (`$.…`) |
| `tools` | Results to give a model API that asks for tools: `{ get_weather: { result: { temp: 21 } } }`, or a list `[{ when: { $.city: Paris }, result: … }]` |
| `expect` | The checks ([checks.md](checks.md)); one with `enabled: false` is turned off: skipped, and not counted ([Turning a check off](checks.md#turning-a-check-off)) |

## Steps (setup and teardown)

```yaml
- name: create a session
  request: { url: "{{base_url}}/sessions", method: POST, headers: { Authorization: "Bearer {{token}}" } }
  extract: { session: $.id }
  expect: [ { type: status, equals: 201 } ]
```

A setup step whose checks fail stops its test (or the suite, for suite setup) with an error; the
test's teardown still runs.

## Variables

| Syntax | Comes from | Notes |
|---|---|---|
| `{{name}}` | Extractions and setup steps, then the data row, then suite `variables`, then the chosen environment | Latest extraction wins. Not found: a setup error before anything is sent |
| `{{row.col}}` | The data file's current row | |
| `{{run.id}}`, `{{test.name}}`, `{{turn.index}}`, `{{repeat}}` | The run | For ids in requests |
| `${env:NAME}` | The process environment (CI), or the app's stored secrets for the chosen environment | Never written to files; every value is redacted in runs and reports. Missing: a setup error |

A value that's entirely one `{{name}}` keeps its type (`equals: "{{row.order}}"` compares as the
row's value, a number when it parses as one); inside other text it's text.

`${env:NAME}` is filled in only in text the files wrote: a template's own text, and the values of the
suite's `variables`, its environments', a scope's file's and `--var`'s. Never in what a `{{name}}`
brings in from elsewhere: an extraction from a reply, a data row, the message. (A reply that says
`${env:CI_TOKEN}` doesn't have the secret sent back with the next turn: it goes as written.)

Files a suite names (its `provider`s, `data`, `prices`, `plugins`) are read only in the opened folder
(the app's), or the current folder and the project of each path given (the command line's: the
nearest folder above it with a `.git` or a `package.json`, else its own folder). Links are followed
first. One elsewhere is a problem that says so (`the data file /… isn't in the opened folder`), and
nothing of it is read or sent.

## Paths

[RFC 9535](https://www.rfc-editor.org/rfc/rfc9535) JSONPath, applied to what the check's `on`
selects ([checks.md](checks.md#what-a-check-looks-at)): by default the parsed response body for
non-streaming JSON, or the assembled final response for streams (the reply text, thinking, tool
calls and usage gathered into one object, plus the last chunk's fields).

- A path that matches nothing: operators fail with "no match"; `exists: false` passes.
- Several matches: an operator passes if any match passes; `all: true` needs every one.
- In YAML, quote paths with `[` or `*` (`"$.items[*].id"`).

## What the app keeps when it saves

- Comments, blank lines, key order, quoting style and flow-style maps (`{ … }`) stay as they were.
- An edit changes only the lines it's about: a value on its line; inside a one-line `{ … }` or `[ … ]`
  (a check written on one line), that one line, its comment kept; a key with no value (`name:`) gets
  it on its line; a text of several lines (a message) goes as a block (`|-`) under its key, a comment
  on its line staying on the block's first line. A list or map left empty (`tests: []`, when its last
  test is deleted) that gets maps again is written as a block, not one line. (A `{ … }` or `[ … ]`
  written over several lines, or with comments in it, is written by the YAML library, which keeps the
  comments and may respace other lines.)
- A key the app doesn't know is kept, and the app shows a warning on its row.
- New entries are written in the style of their neighbours.
- Windows line endings (CRLF) and a byte order mark stay.
- JSON files are written with 2-space indentation, keys in their existing order.
- A file with a list or a map written as something else (`tests:` as a map, an empty `-`, `tags:` as
  text) loads with its problems, and the app shows it as best it can (that list empty, that item an
  empty map, in its place) but won't edit it: it's fixed as YAML (`Edit the file as YAML`) first.

## Validation

`hafen validate` and the app check:

1. The file parses (YAML or JSON), and `version` is supported.
2. It matches the schema.
3. Every provider, data file, prices file and plugin it names exists.
4. Every `{{name}}` can be resolved from what the file declares (extractions count from the turn
   they're made in) or what the run gives (`--var name=value`), and every `${env:NAME}` the run needs
   is set (`validate --env-check`; a run checks it before sending anything, including the presets'
   default keys and System One's).
5. Every path parses; every regular expression compiles; every judge it names is declared.

Each problem is reported with the file, the line and column, and what to fix.

## Scopes

A scope is a named set of values to switch between, as stage and prod: Postman's environments. The
one chosen (the app's scope button, Settings → Environments; `--env <scope>` in CI) fills `{{scope.NAME}}` anywhere a
variable can be (a provider's address or headers, a message, a check):

1. its **plain variables**: `environments/<scope>.yml` in the folder (a map of names to values,
   plain YAML, kept in version control; `{{scope.db.host}}` reaches into one);
2. else its **secrets**: kept by the app (Settings → Secrets, per scope or for every scope), or in
   CI the job's environment variables. A secret's value is redacted wherever it appears, as
   `${env:…}`'s are.

```yaml
# environments/stage.yml
base_url: https://stage.acme.example
team: refunds
```

```yaml
# providers/acme.yml
url: "{{scope.base_url}}/chat"
headers: { Authorization: "Bearer {{scope.API_KEY}}" }   # API_KEY: a secret of the stage scope
```

A name the chosen scope has neither of, or `{{scope.…}}` with no scope chosen, is a setup error
before anything is sent. The chosen scope also picks the suites' `environments.<scope>` (when they
have one); a scope with its own file is a choice even where a suite's environments don't name it.
