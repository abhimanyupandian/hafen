# Test files

A suite is one YAML (or JSON) file in your repository. The app writes it, you can edit it by hand,
and the command line runs it unchanged.

## Where files go

| What | Where |
|---|---|
| Suites | `*.hafen.yml`, `*.hafen.yaml` or `*.hafen.json`, anywhere in the folder (the app's workspace, or one it exported) |
| Providers | `providers/*.yml`, by convention (any path works) |
| Plugins | `plugins/*.js` |
| Data files | CSV or JSON lines, by a path relative to the suite |
| Prices | `prices.yml`, by a path from a suite |
| Runs (CLI) | `.hafen/runs/` in the current folder, without `--report`. Git-ignore it (the app keeps its runs itself) |

The app keeps these files itself, laid out the same way, in its workspace ([Import and
export](app.md#import-and-export)); Export writes them to a folder as they are. The app and the CLI
find suites in a folder by their names. Files a suite names (providers, data, prices, plugins) must
be inside the app's workspace (the app) or the project being run (the CLI). Anything outside is
refused, and nothing of it is read or sent.

An environment's values and the secrets aren't in the folder at all: the app keeps them, and the
CLI reads files you name ([Environments and secrets](#environments-and-secrets)).

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
  default: { kind: systemone }                                 # TypeSafe's System One; key: the secret JEV_API_KEY
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

## Suite keys

| Key | Required | Meaning |
|---|---|---|
| `version` | yes | `1` |
| `name` | | Shown in the app and in reports. Defaults to the file's name |
| `group` | | The suite's group, a whole number of 1 or more ([Groups](#groups)) |
| `provider` | yes, here or on every test | A name under `providers`, a preset (`openai-chat`, `openai-responses`, `anthropic-messages`, `gemini`, `ollama`), `plugin:<name>` or a provider file's path, looked up in that order; an A2A agent (`kind: a2a`); or a provider written inline ([Providers](providers.md)) |
| `providers` | | Named providers, for judges or for tests that use another provider: each names one as `provider: <name>` |
| `environments` | | Named sets of values. The chosen environment's (the app's scope, or `--env`) fills `{{env.NAME}}` where the values given don't have NAME, and each is a `{{name}}` too. With none chosen, the first ([Environments and secrets](#environments-and-secrets)) |
| `variables` | | The suite's variables. A variable (or an environment's value) can't be called `env`, `secret` or `secrets` |
| `judges` | | Named judges ([Judges](checks.md#judges)). `default` is used when a check names none |
| `defaults` | | Settings every test starts from |
| `setup`, `teardown` | | Steps around the whole suite ([Steps](#steps)) |
| `plugins` | | More plugins: paths from the suite (`./plugins/acme.js`) or package names. The folder's own `plugins/*.js` need no naming |
| `prices` | | A prices file, or `{ <model>: { input, output, cached_input? } }` in USD per million tokens |
| `redact` | | More to redact from runs and reports: `{ patterns: [email, card, phone], headers: [x-session-token] }`. A named header's value is hidden wherever it shows, as a secret's is. `phone`: 7 to 15 digits after a `+` or in groups (never an IP address, a host's port, a date or a hex string); `card`: a card number that passes the Luhn check, starting 2 to 6 |
| `tests` | yes | The tests. An empty list is valid, with a warning |

## Test keys

| Key | Meaning |
|---|---|
| `name` | Required, and unique in the file |
| `id` | A stable id (`t_` and 8 characters), so history follows a rename. The app writes it; optional by hand |
| `tags` | For `--tag` |
| `group` | The test's group in its suite ([Groups](#groups)) |
| `provider` | Overrides the suite's: a name under the suite's `providers`, or anything the suite's `provider` can be. A name that's none of them is a problem, with the names there are |
| `data` | A CSV file (with a header row) or a JSON-lines file. The test runs once per row; use `{{row.<column>}}` ([Data rows](#data-rows)) |
| `row_name` | Each data row's name in the reports and the app, a template: `"{{row.question}} ({{row.order}})"`. Without it, the row's first column's value ([Data rows](#data-rows)) |
| `setup`, `teardown` | Steps around the test. Teardown always runs |
| `turns` | The conversation ([Turns](#turns)) |
| `expect_conversation` | Checks on the whole conversation, after the last turn |
| `repeat` | How many times to run the test (default `1`) |
| `pass_rate` | The share of runs that must pass, such as `0.67` (default `1`) |
| `history` | What each turn sends of the conversation: `live` (the default), or `pinned` (earlier turns' `reply` values stand in for the endpoint's). A provider with `history: none` sends none of it ([Conversation history](providers.md#conversation-history)) |
| `on_fail` | `continue` (the default), or `stop` to skip the remaining turns after a failed check |
| `unsure`, `unsure_below` | How [unsure results](checks.md#unsure) count (`fail`, the default: as failed; `warn`: as passed, with a warning; `pass`: as passed), and below which confidence a judged result whose value passes is unsure (default `0.6`). A check can say its own of both |
| `timeout_ms`, `retries` | Per turn (defaults: 120000 ms, and 2 retries on rate limits and server errors). A provider can set them too |

A test's settings come from, the most specific first:

1. the test's own keys;
2. the suite's `defaults`;
3. its provider's `timeout_ms` and `retries` ([Providers](providers.md));
4. Hafen's defaults, above.

So a provider with `timeout_ms: 300` times out its turns after 300 ms unless the suite's `defaults`
or the test say otherwise. On the command line, `--timeout` (and `--repeat`, `--unsure`) override
all of them.

## Data rows

A test with `data` runs once per row of its data file, a CSV file with a header row or a JSON-lines
file (one object a line), rows numbered from 1. `{{row.<column>}}` is the row's value of a column.

Each row has a name, said wherever the row is: the command line's lines, every report (JUnit names a
row's case `orders [row 3: a refund please]`) and the app (`row 3: a refund please`):

- Without `row_name`, it's the value of the row's first column: a CSV file's first column in its
  header, a JSON line's first key.
- `row_name` is a template filled in with the row: `{{row.<column>}}`, the suite's variables and
  `{{env.NAME}}`. Never a secret: a row's name is shown in every report, so a `{{secret.NAME}}` in it
  is a problem.
- Either way, it's on one line (each run of spaces, tabs and line breaks one space), and cut at 60
  characters, ending with `…`. An empty one is none: the row is `row 3`.
- A row whose `row_name` can't be filled in (a JSON line without that key) has no name. It still
  runs: its name never fails it.

```yaml
  - name: orders
    data: data/orders.csv                      # question,order
    row_name: "{{row.question}} ({{row.order}})"
```

The number stays in front of the name: it keeps the rows in order, and two rows of the same name
apart. A data cell's text is redacted in the name as everywhere: a secret's value in one shows as
`[redacted]`. A run file from before row names says `row 3`.

## Turns

| Key | Meaning |
|---|---|
| `user` | The message |
| `reply` | With `history: pinned`, the reply earlier turns are given instead of the live one |
| `extract` | `{ <variable>: <path> }`, read from the response, for later turns and steps. A variable can't be called `env`, `secret` or `secrets` |
| `tools` | Results to give a model API that asks for a tool: `{ get_weather: { result: { temp: 21 } } }`, or a list of `{ when: { $.city: Paris }, result: … }` |
| `expect` | The turn's [checks](checks.md) |


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
| `{{name}}` | Extractions and setup steps, then the data row, then the suite's `variables`, then the suite's `environments:` entry for the chosen environment. The latest extraction wins |
| `{{row.col}}` | The data file's current row |
| `{{env.NAME}}` | A value of the chosen environment: what a provider's [fixture](plugins.md#setting-the-environments-values) set with `env.set` in this run, then the app's scope, or `--env <file>` on the command line, then the suite's `environments:` entry of its name ([Environments and secrets](#environments-and-secrets)) |
| `{{secret.NAME}}` | A secret: what a provider's [fixture](plugins.md#fixtures) gave in this run, then the app's secrets for the scope, or, on the command line, the `--secret` file and then the environment variables. `{{secrets.NAME}}` works too |
| `{{run.id}}`, `{{test.name}}`, `{{turn.index}}`, `{{repeat}}` | The run |

A variable nothing sets stops the run before anything is sent. Set one from the command line with
`--var name=value`.

A value that is exactly one `{{name}}` keeps its type: `equals: "{{row.order}}"` compares as a
number when the row's value is one. Inside other text, it's text.

`{{env.NAME}}` and `{{secret.NAME}}` work wherever text does: a suite's, a test's, a turn's and a
check's fields, steps, judges, providers, and a message typed in the app. They work inside the
values of `variables` and `environments:` too (`api: "{{env.base_url}}/v2"`, then `{{api}}`). A
dotted name is that key first, else it reaches into a value: `{{env.db.host}}`. One that isn't set
stops the run before anything is sent, where it's first used:

```
tests/support/refund.hafen.yml:28:13  {{env.base_url}} isn't set: the environment "prod" has no base_url
```

**Secrets** are written `{{secret.NAME}}`, never as their values. Their values are redacted from
every run file and report: as they are, and where they show JSON-escaped, URL- or form-encoded, or
in base64 (in a Basic login, say), even split across a stream's chunks. Every secret kept for the
run's scope is redacted, whether a suite uses it or not (a reply that says one back): the app's for
the scope, and every value in the command line's `--secret` files. A value shorter than 4
characters isn't redacted (it would cut `yes` or `443` out of ordinary text). An environment's values
aren't secret, and aren't redacted.

A secret is read once a run (and once a message in a conversation), when it's first needed: one
changed, renamed or deleted while a run goes doesn't change its later turns.

`{{env.…}}` and `{{secret.…}}` are filled in only in text your files wrote, never in text that came
from elsewhere (a reply, a data row, an extraction): a reply that says `{{secret.CI_TOKEN}}` doesn't
get the secret sent back. It goes as written.

## Environments and secrets

An environment is a named set of values to switch between, such as `staging` and `prod`: an address,
a region. Secrets are keys, tokens and passwords. Neither is read from your folder: whoever runs the
suite gives them.

| | Environment values: `{{env.NAME}}` | Secrets: `{{secret.NAME}}` |
|---|---|---|
| **The app** | The global values, and the scope chosen with the scope button over them (its value wins where both have a name), kept by the app (Environments). With no scope chosen, the global values alone | The scope's secrets, then the global ones (Secrets): encrypted by the system in the desktop app, in the browser's storage in the browser build |
| **The command line** | `--env <file>`: a `KEY=VALUE` file anywhere on the disk; several, a later file's values winning | `--secret <file>`: a `KEY=VALUE` file anywhere on the disk (several, a later file's winning), then the environment variables |

```sh
# staging.env: the environment's values (fine to commit)
base_url=https://staging.acme.example
db.host = db.internal          # a dotted name is one name: {{env.db.host}}
```

```sh
# staging.secrets.env: secrets (never in version control)
ACME_API_KEY=sk-…
```

```yaml
# providers/acme.yml
url: "{{env.base_url}}/chat"
headers: { Authorization: "Bearer {{secret.ACME_API_KEY}}" }
```

```sh
npx hafen run tests/ --env staging.env --secret ~/secrets/staging.secrets.env
```

The environment's name is the file's, without its extension: `staging.env` is `staging` (with
several `--env`s, the last one's). It picks each suite's `environments:` entry of that name, which
fills any `{{env.NAME}}` the files haven't. So a suite with its own `environments:` needs no file:
`--env staging` picks that entry by name, and with no `--env` the first entry is used. In the app, the
scope's name does the same; with no scope chosen, none of a suite's entries is used (never the
first), only the global values. Only the chosen entry is read for the names a run needs: a secret or
`{{env.NAME}}` that only another entry's values use doesn't stop it.

A `{{name}}` that only a suite's `environments:` entries give (none of its `variables`, no
extraction or setup step) needs the chosen one to have it. When it hasn't (no scope, or another
environment), that stops the run before anything is sent, where it's first used:

```
providers/acme.yml:4:20  {{tier}} isn't set: of the suite's environments, "staging", "prod" give it, and none of them is chosen
```

A `KEY=VALUE` file has one `NAME=value` a line:

| Line | Means |
|---|---|
| `region=eu`, `region = eu` | A value. Spaces around `=` are fine |
| `export REGION=eu` | The same: `export ` before the name is ignored |
| `# a comment`, a blank line | Skipped. A `#` after a value starts a comment only after a space, so `url=https://acme.example/#top` keeps its `#top` |
| `token= # fill in` | Empty: the comment isn't the value |
| `greeting="Hi,\n\"you\""` | Double quotes take `\n`, `\t`, `\"` and `\\` |
| `path='C:\temp\new'` | Single quotes: as written |

Every value is text. A name is letters, digits, `_`, `.` and `-`, not starting with a digit, and is
set once: one rule for every name, in these files, in `{{env.NAME}}` and `{{secret.NAME}}`, in what a
fixture gives, and in the app. A `{{secret.NAME}}` or `{{env.NAME}}` whose name breaks it
(`{{secret.1KEY}}`) is a problem where it's written. A line that isn't `NAME=value` is a problem at
its file, line and column: the command line stops before anything is sent, and the app's import
changes nothing. The app's Environments and Secrets import and export the same files.

**Plugins** get the environment's values as `env`, never a secret. A plugin's request writes a
secret as `"Bearer {{secret.NAME}}"`, and Hafen fills it in as the request leaves
([Plugins](plugins.md#trust-the-network-and-secrets)).

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
- Keys Hafen doesn't know stay in the file, and are a problem until they're fixed (see
  [Validation](#validation)).
- New entries follow the style of their neighbours.
- Windows line endings and a byte order mark are kept. JSON files are written with 2-space
  indentation, keys in their order.

## Validation

`hafen validate` and the app check that:

1. the file parses, and its `version` is supported;
2. it matches the schema, and has no key Hafen doesn't know;
3. every provider, data file, prices file and plugin it names exists, and every check's `type` is
   Hafen's or a check plugin's;
4. every `{{name}}` can be resolved (one only the suite's `environments:` give, from the chosen
   one), every `{{env.NAME}}` is in the chosen environment (or a provider's `beforeAll` or `before`
   [fixture sets it](plugins.md#setting-the-environments-values)), the environment `--env` names exists,
   and every secret the run needs is set (`--env-check`): each `{{secret.NAME}}`, a preset's or
   System One's default key, and each `{{secret.NAME}}` a plugin writes in its code. Of a suite's
   `environments:`, only the chosen one's values are looked at for the names they need;
5. every path parses, every regular expression compiles, every judge it names is declared, and every
   check has what its type needs (a `tool.called` check its `tool`, a `length` check a limit:
   [What a check needs](checks.md#what-a-check-needs)), and a `confidence` only on a judged check
   ([Confidence](checks.md#confidence)); every fixture a provider lists is in a list its `phases`
   name;
6. no two tests in a file have the same name;
7. no variable, environment's value or extraction is called `env`, `secret` or `secrets`
   (`{{env.x}}` is the environment's, `{{secret.x}}` a secret), and every `{{env.NAME}}` and
   `{{secret.NAME}}` names a name (letters, digits, `_`, `.` and `-`, not starting with a digit);
8. a `row_name` is on a test with `data`, has no `{{secret.NAME}}`, and each `{{row.<column>}}` in it
   is a column of the data file, or it says the one it most likely meant ([Data rows](#data-rows)).

`validate` is the same check a run makes before it sends anything. A suite that fails it stops every
run (exit `2`, nothing sent). With `--env-check`, run with the same `--env` and `--secret` files,
environment variables and `--var`s as the run, a suite that passes it isn't stopped by that check. (A
run that has started can still stop with a setup error: a suite's setup step, or a provider's
`beforeAll` fixture, that fails; or stop early, exit `3`, when a `beforeAll` fixture says to.)

Without `--env-check`, secrets aren't looked at, so a suite that passes can still be stopped by one
that isn't set. Every `{{env.NAME}}` is checked either way.

A key Hafen doesn't know would otherwise do nothing, silently: an `expcet:` whose checks never run
would let the test pass. So each is a problem, saying the key it most likely meant. It stays in the
file. Keys of your own (an owner, a ticket) start with `x-`, as `x-owner: qa`, and are left alone. A
provider with [fixtures](plugins.md) gives them its other keys as their settings, so there only a
misspelling of one of Hafen's own keys is a problem.

```
tests/support/refund.hafen.yml:12:9  tests.0.turns.0: unknown key "expcet" (did you mean "expect"?)
tests/support/refund.hafen.yml:15:21  "contians" isn't a check type (did you mean "contains"?)
tests/support/refund.hafen.yml:16:13  a tool.not_called check needs tool (the tool's name): "name" is the check's own label (did you mean "tool"?)
```

A test with no checks is a warning, not a problem: it passes whenever each turn gets a reply.

Each problem comes with the file, line and column, and what to fix. A secret that isn't set is
named where it's first used: in the suite, or in the provider file that uses it. A preset's own key
(`ANTHROPIC_API_KEY`) is named at the provider's `kind`, and System One's (`JEV_API_KEY`) at its judge.
An `{{env.NAME}}` the environment hasn't is named at its first use too, and a secret a plugin writes
at that line of the plugin's file. A name that can't be used is named where it's set. A problem with
a provider's fixtures is named at the fixture in its list (`fixtures.before`):

```
tests/support/refund.hafen.yml:30:42  {{secret.ACME_QA_PASSWORD}} isn't set (not in the --secret file or the environment)
tests/support/providers/anthropic-judge.yml:1:7  {{secret.ANTHROPIC_API_KEY}} isn't set (not in the --secret file or the environment)
tests/support/refund.hafen.yml:28:13  {{env.base_url}} isn't set: the environment "prod" has no base_url
plugins/acme-login.js:14:47  {{secret.ACME_PASSWORD}} isn't set (not in the --secret file or the environment) (the fixture plugin "acme-login" names it)
tests/support/refund.hafen.yml:11:3  variables.env: a variable can't be called "env" ({{env.NAME}} is a value of the environment): call it something else
tests/support/refund.hafen.yml:40:16  tests.2.row_name: {{row.qestion}} isn't a column of data/orders.csv (did you mean {{row.question}}?)
```

With no `--secret` file, a secret that isn't set says `(not in the environment: set it, or pass
--secret <file>)`. In the app, it says the scope: `{{secret.ACME_QA_PASSWORD}} isn't set for the scope
"staging"`.

A file a suite names (a provider, data, prices or schema file, or a plugin) by a path that climbs out
of the folder (`../outside.yml` from a suite at its top) is outside it, wherever that leads,
and said so: `provider: the provider file ../outside.yml isn't in the opened folder (only files in
it are read)`.
