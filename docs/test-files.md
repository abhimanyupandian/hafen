# Test files

A suite is one YAML (or JSON) file in your repository. The app writes it, you can edit it by hand,
and the command line runs it unchanged.

## Where files go

| What | Where |
|---|---|
| Suites | `*.hafen.yml`, `*.hafen.yaml` or `*.hafen.json`, anywhere in the folder |
| Providers | `providers/*.yml`, by convention (any path works) |
| Scopes | `environments/<scope>.yml` |
| Plugins | `plugins/*.js` |
| Data files | CSV or JSON lines, by a path relative to the suite |
| Prices | `prices.yml`, by a path from a suite |
| Runs (desktop app) | `.hafen/runs/` in the opened folder. Git-ignore it |

The app and the CLI find suites in a folder by their names. Files a suite names (providers, data,
prices, plugins) must be inside the opened folder (the app) or the project being run (the CLI).
Anything outside is refused, and nothing of it is read or sent.

Editors that support JSON Schema can check your files as you type. Point a suite at Hafen's
`suite.schema.json` on its first line:

```yaml
# yaml-language-server: $schema=path/to/suite.schema.json
```

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
  default: { kind: systemone }                                 # TypeSafe's System One; key from ${env:JEV_API_KEY}
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

## Suite keys

| Key | Required | Meaning |
|---|---|---|
| `version` | yes | `1` |
| `name` | | Shown in the app and in reports. Defaults to the file's name |
| `group` | | The suite's group, a whole number of 1 or more ([Groups](#groups)) |
| `provider` | yes, here or on every test | A provider file's path, a preset (`openai-chat`, `openai-responses`, `anthropic-messages`, `gemini`, `ollama`), `plugin:<name>`, or a provider written inline ([Providers](providers.md)) |
| `providers` | | Named providers, for judges or for tests that use another provider |
| `environments` | | Named sets of variables. One is chosen per run (`--env`, or the app's scope button); the first is the default |
| `variables` | | The suite's variables |
| `judges` | | Named judges ([Judges](checks.md#judges)). `default` is used when a check names none |
| `defaults` | | Settings every test starts from |
| `setup`, `teardown` | | Steps around the whole suite ([Steps](#steps)) |
| `plugins` | | More plugins: paths from the suite (`./plugins/acme.js`) or package names. The folder's own `plugins/*.js` need no naming |
| `prices` | | A prices file, or `{ <model>: { input, output, cached_input? } }` in USD per million tokens |
| `redact` | | More to redact: `{ patterns: [email, card, phone], headers: [x-session-token] }` |
| `tests` | yes | The tests. An empty list is valid, with a warning |

## Test keys

| Key | Meaning |
|---|---|
| `name` | Required, and unique in the file |
| `id` | A stable id (`t_` and 8 characters), so history follows a rename. The app writes it; optional by hand |
| `tags` | For `--tag` |
| `group` | The test's group in its suite ([Groups](#groups)) |
| `provider` | Overrides the suite's |
| `data` | A CSV file (with a header row) or a JSON-lines file. The test runs once per row; use `{{row.<column>}}` |
| `setup`, `teardown` | Steps around the test. Teardown always runs |
| `turns` | The conversation ([Turns](#turns)) |
| `expect_conversation` | Checks on the whole conversation, after the last turn |
| `repeat` | How many times to run the test (default `1`) |
| `pass_rate` | The share of runs that must pass, such as `0.67` (default `1`) |
| `history` | What each turn sends of the conversation: `live` (the default), or `pinned` (earlier turns' `reply` values stand in for the endpoint's) |
| `on_fail` | `continue` (the default), or `stop` to skip the remaining turns after a failed check |
| `unsure`, `unsure_below` | How [unsure results](checks.md#unsure) count, and below which confidence a judged result is unsure |
| `timeout_ms`, `retries` | Per turn (defaults: 120000 ms, and 2 retries on rate limits and server errors) |
| `network` | A network profile: `{ delay_ms, jitter_ms, kbps, drop_rate }` |

## Turns

| Key | Meaning |
|---|---|
| `user` | The message |
| `reply` | With `history: pinned`, the reply earlier turns are given instead of the live one |
| `extract` | `{ <variable>: <path> }`, read from the response, for later turns and steps |
| `tools` | Results to give a model API that asks for a tool: `{ get_weather: { result: { temp: 21 } } }`, or a list of `{ when: { $.city: Paris }, result: … }` |
| `expect` | The turn's [checks](checks.md) |

Images and other files in a message (`user` as a list of parts, `attachments`) aren't built yet. A
file that has them loads with a warning, and running that turn is an error that says so. Nothing is
sent.

## Steps

`setup` and `teardown` are lists of plain HTTP steps:

```yaml
- name: create a session
  request: { url: "{{base_url}}/sessions", method: POST, headers: { Authorization: "Bearer {{token}}" } }
  extract: { session: $.id }
  expect: [ { type: status, equals: 201 } ]
```

A setup step whose checks fail stops its test (or the suite, for suite setup) with an error. The
test's teardown still runs.

## Variables

| Syntax | Comes from |
|---|---|
| `{{name}}` | Extractions and setup steps, then the data row, then the suite's `variables`, then the chosen environment. The latest extraction wins |
| `{{row.col}}` | The data file's current row |
| `{{scope.NAME}}` | The chosen scope ([Scopes](#scopes)) |
| `{{run.id}}`, `{{test.name}}`, `{{turn.index}}`, `{{repeat}}` | The run |
| `${env:NAME}` | A secret: what a provider's [fixture](plugins.md#fixtures) gave in this run, then the process's environment in CI, or the app's stored secrets |

A variable nothing sets stops the run before anything is sent. Set one from the command line with
`--var name=value`.

A value that is exactly one `{{name}}` keeps its type: `equals: "{{row.order}}"` compares as a
number when the row's value is one. Inside other text, it's text.

**Secrets** are `${env:NAME}` only, and never written to files. Their values are redacted from every
run file and report. `${env:…}` is filled in only in text your files wrote, never in text that came
from elsewhere (a reply, a data row): a reply that says `${env:CI_TOKEN}` doesn't get the secret sent
back.

## Scopes

A scope is a named set of values to switch between, such as `stage` and `prod`. The chosen scope
(the app's scope button, or `--env <scope>` on the command line) fills `{{scope.NAME}}` anywhere a
variable can go: a provider's address or headers, a message, a check. A name is looked up in:

1. the scope's **plain variables**, `environments/<scope>.yml` in the folder, kept in version
   control (`{{scope.db.host}}` reaches into a map);
2. then its **secrets**, kept by the app (Settings → Secrets), or the job's environment variables in
   CI. They're redacted wherever they appear.

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

The chosen scope also picks each suite's environment of the same name, when it has one.

## Groups

What runs at the same time is set in the files, by groups:

- A suite's tests with the same `group` run one after another, in the file's order. Tests in
  different groups run at the same time. Tests with no `group` form one group of their own, so a
  suite with no groups runs its tests one after another.
- Suites work the same way, by their top-level `group`.
- A test's repeats, data rows and turns always run in order.

```yaml
group: 1                 # this suite runs alongside suites of other groups
tests:
  - { name: refunds, group: 1, turns: […] }      # refunds, then returns
  - { name: returns, group: 1, turns: […] }
  - { name: billing, group: 2, turns: […] }      # alongside them
```

`--bail` and `--max-cost` stop every group.

## Paths

Paths are [RFC 9535](https://www.rfc-editor.org/rfc/rfc9535) JSONPath. They apply to what a check
looks at ([What a check looks at](checks.md#what-a-check-looks-at)): by default, the parsed response
body for a JSON reply, or, for a stream, the reply assembled from it (text, thinking, tool calls and
usage, plus the last chunk's fields).

- A path that matches nothing fails with "no match", except with `exists: false`.
- With several matches, a check passes if any match passes. `all: true` needs every one.
- In YAML, quote paths that have `[` or `*`: `"$.items[*].id"`.

## How the app edits files

- Comments, blank lines, key order, quoting and one-line `{ … }` maps stay as they were.
- An edit changes only the lines it's about. Adding a check is one line.
- Keys the app doesn't know are kept, with a warning.
- New entries follow the style of their neighbours.
- Windows line endings and a byte order mark are kept. JSON files are written with 2-space
  indentation, keys in their order.

## Validation

`hafen validate` and the app check that:

1. the file parses, and its `version` is supported;
2. it matches the schema;
3. every provider, data file, prices file and plugin it names exists;
4. every `{{name}}` can be resolved, and every `${env:NAME}` the run needs is set (`--env-check`);
5. every path parses, every regular expression compiles, and every judge it names is declared.

Each problem comes with the file, line and column, and what to fix:

```
tests/support/refund.hafen.yml:14:18  ${env:ACME_QA_PASSWORD} isn't set
```

## Not built yet

These parts of the format load (with a warning) but don't run yet. Running them is an error that
says so, never a silent pass:

- `simulate:` on a test (a simulated user).
- Images and file attachments in a message.
- `load:` on a test (load tests): skipped without `--load`, and an error with it.
