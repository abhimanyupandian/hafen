# Command line

`hafen` runs suites with the same engine as the app, so a test gives the same result in both. It
also serves the browser build, with its relay. It needs Node 22 or newer.

From Hafen's folder, after `npm ci`:

```sh
node cli/hafen.js <command> …
```

## Commands

```
hafen run [paths…] [options]       run suites (files or folders; default: the current folder)
hafen validate [paths…] [options]  check suites; sends nothing
hafen report <run-file> --report <format>:<path>
                                   write reports from a run file
hafen compare <run-file> --baseline <run-file> [--fail-on …]
                                   compare two runs; exit 1 on a regression
hafen serve [options]              serve the browser build, with the relay
hafen --version | --help
```

Folders are searched for `*.hafen.yml`, `*.hafen.yaml` and `*.hafen.json`, leaving out
`node_modules`, `.git`, `.hafen`, `dist` and `release`.

## `run`

| Option | Meaning | Default |
|---|---|---|
| `--test <name>` | Only tests whose name contains this (repeatable) | all |
| `--tag <tag>` | Only tests with this tag (repeatable; any of them) | all |
| `--env <name>` | The [scope](test-files.md#scopes) to use, and each suite's environment of that name | each suite's first environment |
| `--var name=value` | Set a variable (repeatable) | |
| `--repeat <n>` | Override every test's repeat count | the file's |
| `--unsure pass\|warn\|fail` | Override how unsure results count | the file's |
| `--max-cost <usd>` | Stop when the run's cost reaches this | none |
| `--bail` | Stop at the first failed test | off |
| `--timeout <ms>` | Override every turn's timeout | the file's |
| `--report <format>:<path>` | Write a report (repeatable): `junit`, `run`, `md` or `json`. `-` as the path is standard output | a run file in `.hafen/runs/` |
| `--baseline <run-file>` | Compare with this run, and fail on a regression | none |
| `--fail-on pass_rate=<points>,p95=<percent>,cost=<percent>` | What counts as a regression | `pass_rate=5` |
| `--load` | Allow tests with `load:` (load mode isn't built yet: a chosen load test is a setup error) | off: they're skipped |
| `--network delay=<ms>,kbps=<n>,drop=<rate>` | A network profile for every request | none |
| `--redact email,card,phone` | Also redact these patterns | headers and secrets only |
| `--quiet`, `--verbose` | Less or more output | |
| `--no-color` | Plain output (also when `NO_COLOR` is set, or output isn't a terminal) | |

What runs at the same time is set by the files' [groups](test-files.md#groups). There's no
concurrency option.

A number option that isn't a number (`--max-cost $1`, `--timeout 5s`) is a setup error, never "no
limit".

## `validate`

Checks suites without sending anything: they parse, match the schema, name files that exist, and
use variables and judges that are declared. Takes `--env`, `--var`, and `--env-check` (also check
that every `${env:…}` is set).

## `report` and `compare`

`report` writes reports from a run file, for example one downloaded from a CI job:

```sh
node cli/hafen.js report run.hafen-run.json --report md:summary.md --report junit:junit.xml
```

`compare` compares a run with a baseline and exits `1` if it regressed past `--fail-on`.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Every test ran and passed (unsure results counted as the `unsure` setting says) |
| `1` | A test failed, or the run regressed past `--fail-on` |
| `2` | A setup error: a file that doesn't parse or validate, a missing variable, secret, file or plugin, or no tests to run. Nothing was sent |
| `3` | Stopped early: `--max-cost`, `--bail`, or cancelled. Reports are written for what ran |

A test whose turns hit errors (endpoint down, judge unreachable) and no failures also exits `1`;
reports list those as errors, not failures.

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
cost, then up to three lines on what went wrong. `--verbose` adds a line per turn. Nothing printed
holds a secret.

Setup errors name the file, line and column:

```
tests/support/refund.hafen.yml:14:18  ${env:ACME_QA_PASSWORD} isn't set
```

## Reports

| Format | Contents |
|---|---|
| `junit` | One `<testsuite>` per suite file and one `<testcase>` per test (per row for data tests), with a `<failure>` per failed check, an `<error>` per error, and pass rate, latency, tokens and cost as properties |
| `run` | The run file: every step, turn and result. Open it in the app to see the conversation and the timeline |
| `md` | A summary for a CI job page or a pull request comment: totals, a table of tests, failures with reasons, the baseline comparison |
| `json` | The run's summary and every check result, for dashboards |

When `GITHUB_STEP_SUMMARY` is set, the Markdown summary is added to the job's summary.

## `serve`

Serves the browser build (run `npm run build` first) with a relay, for endpoints that don't allow
web pages to call them.

| Option | Meaning | Default |
|---|---|---|
| `--port <n>` | Where to listen | `8790` |
| `--host <address>` | The address to listen on | `127.0.0.1` |
| `--allow-endpoint <url>` | An endpoint the relay may call: a prefix, such as `https://api.acme.example/` (repeatable; or `HAFEN_ENDPOINTS`, comma-separated) | none: the relay refuses everything |

The relay answers only the pages it serves, passes streams through unchanged, and says when it
refused a call, so the app can tell you why.
