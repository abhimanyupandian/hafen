# Contract: the test file

A suite is one YAML or JSON file. The app writes it, people edit it, and the CLI runs it unchanged.
Its exact shape is [suite.schema.json](suite.schema.json); this page explains it.

## Names and places

- **File names:** `*.hafen.yml`, `*.hafen.yaml` or `*.hafen.json`. The app and the CLI find suites
  in a folder by these names.
- **Providers:** `providers/*.yml` beside the suites, by convention; any path works.
- **Data files:** CSV or JSON lines, by path relative to the suite.
- **Prices:** `prices.yml`, by path from a suite.
- **Runs (CLI):** `.hafen/runs/` in the current folder (without `--report`), git-ignored. The app
  keeps its runs itself.
- **The app's workspace** holds these files laid out the same way; Import copies them in, Export
  writes them out to a folder, with the same paths and text ([contracts/ui.md](ui.md#the-workspace)).

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
  default: { kind: systemone }                          # TypeSafe's System One (Jev); key: the secret JEV_API_KEY
  rubric:  { kind: llm, provider: claude-judge, samples: 3 }   # an LLM judge
providers:
  claude-judge: providers/anthropic-judge.yml

defaults:
  repeat: 3
  pass_rate: 0.67
  unsure: warn            # fail (the default) | warn | pass
  timeout_ms: 60000

setup:
  - name: log in
    request:
      url: "{{env.base_url}}/auth"
      method: POST
      body: { user: "qa-bot", password: "{{secret.ACME_QA_PASSWORD}}" }
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
| `provider` | yes, here or on every test | A provider: a name under `providers`, a preset (`openai-chat`, `openai-responses`, `anthropic-messages`, `gemini`, `ollama`), `plugin:<name>` or a file path, looked up in that order; an A2A agent (`kind: a2a`); or an inline provider object ([provider.md](provider.md)) |
| `providers` | | Named providers, used by judges, simulated users, or tests that override `provider` |
| `environments` | | Named sets of values; the chosen environment's ([Environments and secrets](#environments-and-secrets)) is `{{env.NAME}}` where the values passed don't have NAME, and each is a `{{name}}` too; with no environment passed (the CLI with no `--env`), the first; with one passed (the app's scope, or no scope), only the one of its name. A value can't be called `env`, `secret` or `secrets` |
| `variables` | | Suite variables. A variable can't be called `env`, `secret` or `secrets` (or `env.…`): `{{env.x}}` is the environment's, `{{secret.x}}` a secret |
| `judges` | | Named judges ([checks.md](checks.md#judges)); `default` is used when a check names none |
| `defaults` | | Test settings every test starts from |
| `setup`, `teardown` | | Steps around the whole suite |
| `plugins` | | More plugin modules: paths relative to the suite (`./plugins/acme.js`), or package names (found from the folder, in Node: the CLI and the desktop app). The folder's own plugins (`plugins/*.js`: the app's workspace; the CLI's current folder, and each folder it's given) need no naming: any suite uses them by name (`kind: plugin:acme`, a judge's `plugin: acme`, a check's `type: acme`). Each is loaded, in a worker of its own, before anything is sent; one that can't be found or loaded, or a name no plugin has, is a setup error |
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
| `provider` | Overrides the suite's: a name under the suite's `providers`, or anything the suite's `provider` can be. A name that's none of them (no provider, preset or file) is a problem listing the suite's provider names, with the one it most likely meant |
| `data` | A CSV (with a header row) or JSON-lines file; the test runs once per row; `{{row.<column>}}` ([Data rows](#data-rows)) |
| `row_name` | Each data row's name: a template filled in with the row ([Data rows](#data-rows)). Without it, the row's first column's value |
| `setup`, `teardown` | Steps; teardown always runs |
| `turns` | The conversation |
| `simulate` | A simulated user: `{ user: <provider name>, scenario, stop_when, max_turns, expect_each: [checks] }`. **Not built yet:** the file loads with a warning on it, and running the test is an error saying so (never a pass with nothing sent) |
| `expect_conversation` | Checks after the last turn, on the whole conversation |
| `repeat`, `pass_rate`, `history`, `on_fail`, `unsure`, `unsure_below`, `timeout_ms`, `retries`, `network`, `load` | Settings ([data-model.md](../data-model.md#testsettings)). `unsure`: how an unsure result counts, `fail` (the default), `warn` or `pass` ([checks.md, Unsure](checks.md#unsure)); a judged check can say its own |

### Data rows

A test with `data` runs once per row (numbered from 1), the row's values as `{{row.<column>}}`. Each
row has a name, recorded on its runs, turns and fixtures in the run file (`row_name`,
[run-file.md](run-file.md)) and said wherever the row is, in one format: `row 3: a refund please`
(none: `row 3`). The command line's lines, every report (JUnit's case `orders [row 3: a refund
please]`) and the app say it so ([cli.md](cli.md#reports), [ui.md](ui.md)).

- Without `row_name`: the value of the row's first column (a CSV file's first header column; a JSON
  line's first key).
- `row_name`: a template filled in with the row's scope: `{{row.<column>}}`, the suite's variables,
  what the suite's setup steps extract, the builtins, and `{{env.NAME}}`. Never `{{secret.NAME}}`: a row's
  name is in every report (a problem, [Validation](#validation)).
- Either way: made text (a JSON value as JSON), each run of whitespace one space, trimmed, and cut at
  60 characters ending with `…`. Empty: no name.
- One that can't be filled in as the run goes (a JSON line without that key): no name; the row runs as
  it would, never failing for its name.

A row's name is redacted as everything in the run is: a secret's value in a data cell shows as
`[redacted]` in it, in the run file, every report and every event.

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
| `extract` | `{ <variable>: <path> }`, read from the response (`$.…`). A variable can't be called `env`, `secret` or `secrets` |
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
| `{{name}}` | Extractions and setup steps, then the data row, then suite `variables`, then the suite's environment of the chosen name | Latest extraction wins. Not found: a setup error before anything is sent |
| `{{row.col}}` | The data file's current row | |
| `{{run.id}}`, `{{test.name}}`, `{{turn.index}}`, `{{repeat}}` | The run | For ids in requests |
| `{{env.NAME}}` | The chosen environment: what a provider's fixture set with `env.set` in this run (or conversation: [provider.md](provider.md#fixtures)), then the values passed (the app's, for its scope; `--env <file>`), then the suite's `environments.<name>` ([Environments and secrets](#environments-and-secrets)) | `{{env.db.host}}`: the key `db.host` first, else `db`'s `host`. Missing: a setup error (one a `beforeAll` or `before` fixture sets counts as set) |
| `{{secret.NAME}}` (or `{{secrets.NAME}}`) | A secret: the app's, kept for its scope; `--secret <file>`, then the process environment, in the CLI | Never written to files; every value is redacted in runs and reports. Missing: a setup error |
| `${env:NAME}`, `{{scope.NAME}}` | The old ways ([Old spellings](#old-spellings)) | A problem where it's written, saying the new way. Never filled in |

A value that's entirely one `{{name}}` keeps its type (`equals: "{{row.order}}"` compares as the
row's value, a number when it parses as one); inside other text it's text.

`{{env.NAME}}` and `{{secret.NAME}}` are filled in wherever text is: a provider's fields, a suite's,
a test's, a turn's and a check's, steps, judges, and a message typed in a conversation (its other
`{{…}}` are sent as typed). Within a value, only in text the files wrote: a template's own text, and
the values of the suite's `variables`, its environments', the environment's and `--var`'s. Never in
what a `{{name}}` brings in from elsewhere: an extraction from a reply, a data row, the message. (A
reply that says `{{secret.CI_TOKEN}}` doesn't have the secret sent back with the next turn: it goes as
written.) One that isn't there is never sent as written: it's an error saying why,

- `{{env.base_url}} isn't set: the environment "stage" has no base_url`
- `{{env.base_url}} isn't set: no environment is chosen (the app's scope, or --env <file> in the CLI)`
- `{{secret.API_KEY}} isn't set for the scope "stage"` (`{{secret.API_KEY}} isn't set`, with none chosen);
  the CLI says where it looked instead: `{{secret.API_KEY}} isn't set (not in the --secret file or the
  environment)` (`files`, with several), or with no `--secret`, `(not in the environment: set it, or
  pass --secret <file>)`
- `{{tier}} isn't set: of the suite's environments, "stage", "prod" give it, and none of them is
  chosen` (or `not "qa"`): a `{{name}}` only the suite's `environments` give, the chosen one lacking it
- `{{secret.1KEY}}: "1KEY" isn't a name (letters, digits, _ . -, not starting with a digit)`: a
  `{{secret.NAME}}` or `{{env.NAME}}` whose name breaks the one rule for names (`engine/env-file.js`,
  `NAME`: KEY=VALUE files, fixtures' values and the app's names follow it too); never looked up

said before anything is sent, where it's first used, when the files show it.

Files a suite names (its `provider`s, `data`, `prices`, `plugins`) are read only in the app's
workspace, or the current folder and the project of each path given (the command line's: the
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
   they're made in; one only its `environments` give, from the chosen one's) or what the run gives
   (`--var name=value`); every `{{env.NAME}}` from the chosen environment (with none chosen, each is
   a problem saying so), or one a provider's `beforeAll` or `before` fixture sets with `env.set`
   ([provider.md](provider.md#fixtures)); and every `{{secret.NAME}}` the run needs is set (only the chosen
   environment's block of `environments` is looked at for them) (`validate --env-check`; a run checks it before sending anything, including the
   presets' default keys, System One's, and the secrets its plugins write in their code).
5. Every path parses; every regular expression compiles; every judge it names is declared; every
   check that isn't turned off has what its type needs ([checks.md](checks.md#what-a-check-needs)),
   and a `confidence` only where it means something ([checks.md](checks.md#confidence)); every
   fixture a provider lists is in a list its `phases` name ([provider.md](provider.md#fixtures)).
6. No variable, environment's value or extraction is called `env`, `secret` or `secrets`; every
   `{{env.NAME}}` and `{{secret.NAME}}` names a name (`engine/env-file.js`, `NAME`).
7. A `row_name` is on a test with `data` (`tests.0.row_name: row_name names a data row: this test has
   no data file (data)`), has no `{{secret.NAME}}` (`a row's name can't hold a secret
   ({{secret.API_KEY}}): it's shown in every report`), and each `{{row.<column>}}` in it is a column
   of the data file (a CSV file's header; the keys its JSON lines have): `{{row.qestion}} isn't a
   column of data/orders.csv (did you mean {{row.question}}?)`, or, with none close, its columns.

Each problem is reported with the file, the line and column, and what to fix. A secret that isn't set
is reported where it's first used: its `{{secret.NAME}}` in the suite or in the provider file that
has it (or a plugin's file); a preset's default key at its provider's `kind` (or where the suite
names the preset); System One's at its judge (with none declared, at the first check that asks it).
An `{{env.NAME}}`, the same way. The old ways (`${env:NAME}`, `{{scope.NAME}}`, a plugin's
`{ secret: "NAME" }`) are problems, each where it's first written, saying the new way
([Old spellings](#old-spellings)).

## Environments and secrets

An environment is a named set of values to switch between, as stage and prod: Postman's
environments. Its values and the secrets aren't read from the folder: whoever runs the engine passes
them.

- **The app:** the global values and each scope's are kept in the app, the secrets in the app's
  keystore (the global ones, and each scope's). With every run, check and message it passes the
  environment: `{ name: scope, values: { ...global, ...scope } }` for the scope chosen (the scope
  button; the app merges, a scope's value winning), `{ name: "", values: global }` for no scope.
  Its host's `secrets(NAME, { env })` gives the scope's secret, else the global one's, and
  `knownSecrets(env)` every one of them, to redact.
- **The CLI:** `--env <file>` is a KEY=VALUE file of the environment's values (its name is the file's:
  `staging.env`, staging), `--secret <file>` one of secrets (then the process environment), each
  anywhere on the disk, each as often as wanted, a later file's values winning ([cli.md](cli.md)).

```sh
# staging.env
base_url=https://staging.acme.example
db.host = db.internal          # a dotted name is one name: {{env.db.host}}
```

```sh
# staging.secrets.env: never in version control
API_KEY=sk-…
```

```yaml
# providers/acme.yml
url: "{{env.base_url}}/chat"
headers: { Authorization: "Bearer {{secret.API_KEY}}" }
```

`{{env.NAME}}` is the value passed, else the suite's `environments.<name>` (for that name: so a suite
with an `environments:` block works with none passed, its first with no environment passed at all).
An environment passed (`{ name, values }`, or `null` for none) never falls back to the suite's first:
the suite's `environments.<name>` is used only for a name that isn't `""`, so the app's "no scope"
(`name: ""`) uses none of them. A run and a conversation's message choose the same way
(`engine/runner.js`, `environmentOf`). Values passed for a name the suite has no environment of are
its environment all the same. Only the chosen environment's block is read for the names a run needs
(its secrets, its `{{env.NAME}}`s): another's don't stop it. `{{secret.NAME}}` is the host's secret
of that name for the chosen scope (what a provider's fixture gave first), looked up once a run (once a
message in a conversation) and kept: one changed while it goes doesn't change its later turns. Only
text is a secret's value: a host's lookup that finds anything else (a prototype's function) has found
none. Every secret the host knows for the scope (`knownSecrets(env)`) is redacted, used or not. Plugins are
given the environment's values as `env`, never a secret; their requests have `{{secret.NAME}}` and
`{{env.NAME}}` filled in by the engine as they leave ([provider.md](provider.md#code-plugins)).

A name chosen with no values passed (`--env staging`) is that name's environment: the suites'
`environments.staging`, and nothing more (a folder's `environments/staging.yml` isn't read). A name
that's none of a suite's environments, with no values passed, is a problem before anything is sent
(`there's no environment or scope "staging" (local)`), unless the host keeps secrets for it (a scope
with only secrets, in the app).

## Old spellings

`${env:NAME}`, `{{scope.NAME}}` and a plugin's `{ secret: "NAME" }` (a header's value, or a value in
a JSON body) are problems, each where it's first written, saying what to write instead: the suite
doesn't validate, and a run sends nothing (exit 2). Nothing fills them in: one met as a run goes (in
a value given at run time, or a request a plugin builds) is an error saying the same.

```
providers/acme.yml:3:35  ${env:ACME_KEY} is the old way to write a secret: write {{secret.ACME_KEY}}
providers/acme.yml:2:7  {{scope.base_url}} is the old way: write {{env.base_url}} (a value of the environment) or {{secret.base_url}} (a secret)
plugins/acme-login.js:14:48  { secret: "ACME_PASSWORD" } is the old way to name a secret: write "{{secret.ACME_PASSWORD}}" in the request (a header's "Bearer {{secret.ACME_PASSWORD}}")
```

A folder's `environments/<name>.yml` isn't read, by the app or the CLI.
