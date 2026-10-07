# Command line

`hafen` runs suites with the same engine as the app, so a test gives the same result in both. It
needs Node 22 or newer. It's the `hafen` package (`packages/hafen/` in Hafen's repository), which
installs on its own, with no Electron, React or Playwright (see
[Running in CI](ci.md#installing)):

```sh
npm install --save-dev hafen
npx hafen <command> …
```

In Hafen's repository, after `npm ci`, `npx hafen …` runs the workspace's own (or
`node packages/hafen/cli/hafen.js …`). The browser build's server, with its relay, is the app's:
`npm run serve` in Hafen's repository ([The app](app.md#the-browser-build)).

## Commands

```
hafen run [paths…] [options]       run suites (files or folders; default: the current folder)
hafen validate [paths…] [options]  check suites; sends nothing
hafen report <run-file> --report <format>:<path>
                                   write reports from a run file
hafen compare <run-file> --baseline <run-file> [--fail-on …]
                                   compare two runs; exit 1 on a regression
hafen pack [paths…] -o <file.mjs>  pack suites and everything they need into one file that runs
                                   them with Node alone (see pack)
hafen --version | --help
```

Folders are searched for `*.hafen.yml`, `*.hafen.yaml` and `*.hafen.json`, leaving out
`node_modules`, `.git`, `.hafen`, `dist` and `release`.

## `run`

| Option | Meaning | Default |
|---|---|---|
| `--test <name>` | Only tests whose name contains this (repeatable) | all |
| `--tag <tag>` | Only tests with this tag (repeatable; any of them) | all |
| `--env <file>` | The environment's values, from a `KEY=VALUE` file anywhere on the disk: they fill `{{env.NAME}}`. The file's name without its extension (`staging.env`: `staging`) is the environment's, and picks each suite's environment of that name. See [Environments and secrets](#environments-and-secrets) | each suite's first environment |
| `--env <name>` | Each suite's environment of that name, with no file. Nothing is read from the folder (not an `environments/<name>.yml`) | |
| `--secret <file>` | Secrets, from a `KEY=VALUE` file anywhere on the disk (never committed): they fill `{{secret.NAME}}`. A name it hasn't comes from the environment variable of that name. Also `--secrets` | the environment's variables |
| `--var name=value` | Set a variable (repeatable) | |
| `--repeat <n>` | Override every test's repeat count | the file's |
| `--unsure pass\|warn\|fail` | Override how unsure results count | the file's |
| `--max-cost <usd>` | Stop when the run's cost reaches this. It needs prices: with no price anywhere (no suite's `prices`, no provider's `price`) every cost is unknown, so it's a setup error | none |
| `--bail` | Stop at the first failed test | off |
| `--timeout <ms>` | Override every turn's timeout | the file's |
| `--report <format>:<path>` | Write a report (repeatable): `junit`, `run`, `md` or `json`. `-` as the path is standard output. See [Reports](#reports) | a run file in `.hafen/runs/` |
| `--baseline <run-file>` | Compare with this run, and fail on a regression | none |
| `--fail-on pass_rate=<points>,p95=<percent>,cost=<percent>` | What counts as a regression (see [`compare`](#report-and-compare)). Only with `--baseline`: without one it's a setup error | `pass_rate=5` |
| `--load` | Allow tests with `load:` (load mode isn't built yet: a chosen load test is a setup error) | off: they're skipped |
| `--network delay=<ms>,jitter=<ms>,kbps=<n>,drop=<rate>` | A network profile for every request: a delay (give or take `jitter`) before each response, bandwidth, and a share of responses cut off partway (any response, a stream or a JSON reply; `drop=1` cuts off every one). `delay` and `jitter` are 0 or more, `kbps` above 0, `drop` from 0 to 1: anything else is a setup error | none |
| `--redact email,card,phone` | Also redact these patterns, as well as each suite's `redact` (a name that isn't one of these is an error) | secrets, secret headers and each suite's `redact` |
| `--quiet`, `--verbose` | Less or more output | |
| `--no-color` | Plain output (also when `NO_COLOR` is set, or output isn't a terminal) | |

What runs at the same time is set by the files' [groups](test-files.md#groups). There's no
concurrency option.

A number option that isn't a number (`--max-cost $1`, `--timeout 5s`) is a setup error, never "no
limit". So is an option that would do nothing: `--fail-on` without `--baseline`, `--max-cost` with no
prices. Each says so, and nothing is sent:

```
--fail-on compares with a baseline: add --baseline <run file>
--max-cost needs prices: no suite has prices and no provider has a price, so the run's cost is unknown; add prices to the suite or a provider's price, or leave out --max-cost
--network drop takes a rate from 0 to 1 (1 drops every response), not 5
```

## Environments and secrets

`{{env.NAME}}` in a suite, a provider file or a plugin is a value of the environment the run uses, and
`{{secret.NAME}}` (or `{{secrets.NAME}}`) is a secret ([Variables](test-files.md#variables)). Both
come from plain-text files you name on the command line, anywhere on your disk (outside the project
too): Hafen doesn't look for them in the project's folder.

```
# staging.env: the environment's values (fine to commit)
base_url=https://staging.acme.example
region=eu

# staging.secrets.env: secrets (never committed)
ACME_API_KEY=sk-…
```

```sh
npx hafen run tests/ --env environments/staging.env --secret ~/secrets/staging.secrets.env
```

One `NAME=value` a line. Blank lines and `# comments` are skipped, spaces around `=` are fine, and an
`export ` before the name is ignored. A value in double quotes takes `\n`, `\t`, `\"` and `\\`; one in
single quotes is taken as it's written. Every value is text.

- **`--env <file>`**: its values fill `{{env.NAME}}`. Its name is the file's without its extension
  (`staging.env`: `staging`): it picks each suite's environment of that name (`environments:
  staging:`), and it's the run's `env` in the run file. `--env` takes a file when its value looks like a
  path (a `/` or `\` in it, or `.env` at its end) or a file of that name exists; otherwise it's a name
  (`--env staging`): each suite's environment of that name, with no file. A folder's
  `environments/staging.yml` isn't read.
- **`--secret <file>`** (or `--secrets`): its values fill `{{secret.NAME}}`. A name the file hasn't,
  or leaves empty (`NAME=`), comes from the environment variable of that name, so secrets that CI
  gives as environment variables work with a file or without one. When both have it, the file's wins.

A `{{env.NAME}}` the environment hasn't, or a `{{secret.NAME}}` that isn't set, stops the run before
anything is sent (exit `2`), naming the file, line and column where it's used:

```
providers/acme.yml:2:7  {{env.base_url}} isn't set: the environment "prod" has no base_url

1 problem: nothing was sent.
```

```
providers/acme.yml:3:35  {{secret.ACME_API_KEY}} isn't set (not in the --secret file or the environment)

1 problem: nothing was sent.
```

So does a file that doesn't exist or can't be read, or a line in one that isn't `NAME=value` (at its
file, line and column; a secrets file's problems never show what's in the line):

```
the environment file environments/prod.env doesn't exist
```

```
/home/me/secrets/staging.secrets.env:4:1  line 4 isn't NAME=value

1 problem: nothing was sent.
```

Nothing printed or written holds a secret: every value in the secrets file, and every secret the run
fills in from the environment, is redacted from the output, every report and the run file
(`[redacted]`), wherever it shows (a reply that says it back too).

**Old spellings.** `${env:NAME}`, `{{scope.NAME}}` and a plugin's `{ secret: "NAME" }` are problems,
each at its file, line and column, saying what to write instead: `validate` exits `2`, and so does
`run`, with nothing sent ([Old spellings](test-files.md#old-spellings)).

```
providers/acme.yml:3:35  ${env:ACME_KEY} is the old way to write a secret: write {{secret.ACME_KEY}}
providers/acme.yml:2:7  {{scope.base_url}} is the old way: write {{env.base_url}} (a value of the environment) or {{secret.base_url}} (a secret)

2 problems: nothing was sent.
```

## `validate`

Checks suites without sending anything, with the same check `run` makes before it sends: they parse,
match the schema, have no key Hafen doesn't know, name files, plugins and check types that exist, and
use variables, judges and an `--env` that are declared ([Validation](test-files.md#validation)).
Takes `--env`, `--secret`, `--var`, and `--env-check`. With `--env <file>`, every `{{env.NAME}}` is
checked against the file. With `--env-check`, every secret is checked too: each `{{secret.NAME}}`
(from `--secret`'s file, then the environment) and each one a plugin writes in its code. With
`--env-check`, run with the same files, environment variables and `--var`s as the run, a suite that
passes `validate` isn't stopped by `run`'s check before it sends anything (a suite's setup step or a
provider's `beforeAll` fixture can still fail once it runs). Without `--env-check`, secrets aren't
checked.

## `report` and `compare`

`report` writes reports from a run file, for example one downloaded from a CI job:

```sh
npx hafen report run.hafen-run.json --report md:summary.md --report junit:junit.xml
```

With no `--report`, it prints the Markdown summary. A format that isn't one, or a path that can't be
written, exits `2` before anything is written. A report that still can't be written says so, the
others are written, and it exits `2`.

`compare` compares a run with a baseline and exits `1` if it regressed past `--fail-on`: the pass
rate fell by more than `pass_rate` points, p95 latency rose by more than `p95` percent, or the cost by
more than `cost` percent. p95 must also have risen by 50 ms or more: a rise under that is noise (4 ms
to 11 ms is +175%), never a regression. It prints the Markdown summary with the comparison; a run whose
tests passed but that regressed is headed `## Hafen · regressed`.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Every test ran and passed (unsure results counted as the `unsure` setting says) |
| `1` | A test failed, or the run regressed past `--fail-on` |
| `2` | A setup error. Found before the run: a file that doesn't parse or validate, an old spelling (`${env:NAME}`, `{{scope.NAME}}`, a plugin's `{ secret: "NAME" }`), a missing variable, environment value, secret, file or plugin, an `--env` or `--secret` file that doesn't exist or has a line that isn't `NAME=value`, an option that's wrong or would do nothing, a report that can't be written, or no tests to run (nothing was sent). Or found as it ran: a suite's setup step or a provider's `beforeAll` fixture that failed (that suite's tests weren't sent; what ran before, and `afterAll` fixtures, were). Also a run that passed, but whose report couldn't be written after all |
| `3` | Stopped early: `--max-cost`, `--bail`, or cancelled. Reports are written for what ran: a test that had already failed counts as failed, one that never ran as skipped |

A test whose turns hit errors (endpoint down, judge unreachable) and no failures also exits `1`;
reports list those as errors, not failures.

A report that can't be written never hides how the tests went: a failed run still exits `1`, a stopped
one `3`. Only a run that passed exits `2` instead of `0`, since CI would miss what the report says.

## Output

One line per test as it ends, then a summary:

```
✓ refunds › refund for a broken item   3/3   6/6 checks   4.1 s   $0.0124
✗ refunds › refund questions from the data file   188/200 rows   188/200 checks   41.2 s   $0.21
    row 17 · turn 1 · $.reply.order.id = {{row.order}}: 4413 ≠ 4431
    row 18 · turn 1 · error: timed out after 60 s
    row 19 · conversation · $[*].reply contains refund: didn't find refund
    …9 more (see the report)
! billing › proration   3/3   3/4 checks   2.0 s
    unsure: noul 0.58 (confidence 0.41)
✗ billing › logged in   0/1   0/2 checks   0.3 s
    setup "log in" failed: status 500

2 suites · 4 tests · 1 failed · 1 error · 1 unsure · 412 checks · p50 1.2 s · p95 2.8 s · $0.23 · 1 min 12 s
Run file: .hafen/runs/k3f9….hafen-run.json
```

Each test's line shows its runs (or data rows) that passed, its checks that passed, its time and its
cost, then up to three lines on what went wrong. A provider's [fixture](plugins.md#fixtures) that
fails gets a line of its own (`⚙ fixture acme-logout · afterAll · providers/acme.yml  failed: …`).
`--verbose` adds a line per turn, per fixture, and per HTTP call a plugin or fixture made. The
summary counts the fixtures that ran (`· 3 fixtures (1 failed)`). Nothing printed holds a secret.

Setup errors name the file, line and column (a secret, where it's first used):

```
tests/support/refund.hafen.yml:30:42  {{secret.ACME_QA_PASSWORD}} isn't set (not in the --secret file or the environment)
```

With no `--secret`, it says `(not in the environment: set it, or pass --secret <file>)`.

## Reports

| Format | Contents |
|---|---|
| `junit` | One `<testsuite>` per suite file and one `<testcase>` per test (per row for data tests), with a `<failure>` per failed check, an `<error>` per error, and pass rate, latency, tokens and cost as properties. Each test's fixtures in its `<system-out>` (failed ones in `<system-err>`), the run's own in each suite's |
| `run` | The run file: every step, turn and result. Open it in the app to see the conversation and the timeline |
| `md` | A summary for a CI job page or a pull request comment: totals, a table of tests, failures with reasons (a turn's checks, and the whole conversation's: `expect_conversation`), the fixtures that ran, the baseline comparison |
| `json` | The run's summary, every check result (each with `from`: `"turn"`, with its `turn`, or `"conversation"` for `expect_conversation`, with `turn: null`; they add up to `summary.checks`), every fixture that ran and every HTTP call a plugin or fixture made, for dashboards |

When `GITHUB_STEP_SUMMARY` is set, the Markdown summary is added to the job's summary.

Costs show to the cent, or a smaller one to two significant digits (`$0.000017`, never `$0.0000`); a
`cost` check's reason shows every digit (`$0.000017 > $0.000001`).

Each report's path is checked before anything is sent: a path that's a folder, or whose folder can't
be made or written in, is a setup error (`can't write the md report to /nonexistent-dir/x.md: the
folder /nonexistent-dir can't be made (read-only file system)`). One that still can't be written at
the end (a full disk) is said in a line, `couldn't write the md report to …: …`, and the others are
still written. Never a stack trace.

## `pack`

Packs suites, and everything they need, into **one file that runs anywhere with Node 22 alone**: no
hafen install, no `npm ci`, no project checkout, no `node_modules`.

```sh
npx hafen pack tests/ -o refunds.hafen-pack.mjs
```

```
packed refunds.hafen-pack.mjs (828 kB)
  1 suite · 1 provider · 2 plugins (bundled with 6 files) · 1 data file
  environment values it uses, from --env <file>: base_url (their names are in refunds.hafen-pack.env.example)
  secrets it needs, from --secret <file> or the environment: ACME_PASSWORD (their names are in refunds.hafen-pack.secret.example)
  run it: node refunds.hafen-pack.mjs run --env stage.env --secret stage.secrets.env
```

What goes in:

- Hafen's command line, bundled with the packages it uses.
- The suites you name (files or folders, as `run` takes them), and every file they reference:
  providers, data files and prices files.
- Every plugin the suites use (named in `plugins:`, or the folder's used by name, fixtures included).
  Each is bundled with what it imports: files anywhere, packages from `node_modules`, JSON.

What stays out: **the environment's values and the secrets**. They're given where the pack runs, as
they are to `run`: `--env <file>`, and `--secret <file>` or environment variables. The pack lists what
it needs: the `{{env.NAME}}`s its files and plugins use, and the secrets: those the files name
(`{{secret.NAME}}`, and a preset's or System One's default key), and those its plugins write in their
code (`"{{secret.NAME}}"`). A name a fixture gives isn't listed: the fixture gives it as the pack runs.

Their names also go next to the pack, never a value, to fill in copies of (`NAME=`, one per line):

- `refunds.hafen-pack.env.example`: the environment's names. Fill in a copy for each environment
  (`stage.env`, `prod.env`) and give it with `--env`.
- `refunds.hafen-pack.secret.example`: the secrets' names, each with what uses it. Fill in a copy
  (never committed) and give it with `--secret`, or set them as environment variables
  ([Running in CI](ci.md#running-a-pack)).

A pack that needs no environment values, or no secrets, gets no file for them.

Nothing is packed if a suite has a problem, or if a plugin it uses can't be loaded or bundled (an
import that isn't installed, say) or names a secret the old way (`{ secret: "NAME" }`): `pack` says
why and exits `2`. None of your machine's paths go into
the file.

Running a pack takes the same commands and options as `hafen` itself:

```sh
node refunds.hafen-pack.mjs run --env stage.env --secret stage.secrets.env   # every suite in it
node refunds.hafen-pack.mjs run tests/refunds.hafen.yml --env stage.env      # one, by its path; secrets from the environment
node refunds.hafen-pack.mjs validate --env stage.env --secret stage.secrets.env --env-check   # every value and secret set?
node refunds.hafen-pack.mjs info                                             # what's in it, with hashes
node refunds.hafen-pack.mjs --help
```

The `--env` and `--secret` files are read where it runs, from any folder. Reports and run files are
written there too, and a run file records which pack ran (`where.pack`). A pack can't `pack`: that
needs hafen itself.

Packing uses rolldown, an optional dependency of hafen: `npm install hafen` installs it, and
`--omit=optional` leaves it out (then `pack` says to install it, and exits `2`). Running a pack needs
no install at all.

## `serve`, now the app's

`hafen serve` served the browser build with its relay. That's the app's now, since it serves the
app's build: in Hafen's repository, `npm run serve -- --allow-endpoint <url>`, with the same options
([The app](app.md#the-browser-build)). `hafen serve` says so, and exits `2`.
