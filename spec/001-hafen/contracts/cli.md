# Contract: the command-line runner

`hafen` runs suites in CI (or anywhere) with the same engine as the app, and serves the
browser build with its relay. It needs Node 22 or newer. From the project: `node
evals/cli/hafen.js …` (after `npm ci --prefix evals`); once published: `npx hafen …`.

## Commands

```
hafen run [paths…] [options]       run suites (files or folders; default: the current folder)
hafen validate [paths…] [options]  check suites against the schema; sends nothing
hafen report <run-file> [options]  write reports from a run file (JUnit, Markdown, JSON)
hafen compare <run-file> --baseline <run-file> [options]
                                        compare two runs; exit 1 on regression
hafen serve [options]              serve the browser build, with the relay
hafen --version | --help
```

Folders are searched for `*.hafen.yml`, `*.hafen.yaml` and `*.hafen.json`.

## Options for `run`

| Option | Meaning | Default |
|---|---|---|
| `--test <name>` | Only tests whose name contains this (repeatable) | all |
| `--tag <tag>` | Only tests with this tag (repeatable; any) | all |
| `--env <name>` | The scope (and the suites' environment of that name) to use: `{{scope.NAME}}` comes from `environments/<name>.yml` in the folder, then from the job's environment variables (its secrets) ([Scopes](test-file.md#scopes)) | the suite's first environment |
| `--var name=value` | Set a variable (repeatable) | |
| `--repeat <n>` | Override every test's repeat count | the file's |
| `--unsure pass\|warn\|fail` | Override how unsure results count | the file's |
| `--max-cost <usd>` | Stop when the run's cost reaches this | none |
| `--bail` | Stop at the first failed test | off |
| `--timeout <ms>` | Override every turn's timeout | the file's |
| `--report <format>:<path>` | Write a report (repeatable): `junit`, `run` (the run file), `md`, `json`. `-` as the path means standard output | `run:.hafen/runs/<_id>.hafen-run.json` |
| `--baseline <run-file>` | Compare with this run, and fail on regression past the thresholds | none |
| `--fail-on pass_rate=<points>,p95=<percent>,cost=<percent>` | Regression thresholds | `pass_rate=5` |
| `--load` | Allow tests with `load:` to run (otherwise they're skipped; see Load tests below: not built yet) | off |
| `--network delay=<ms>,kbps=<n>,drop=<rate>` | A network profile for every request | none |
| `--redact email,card,phone` | Also redact these patterns | headers and secrets only |

| `--quiet` / `--verbose` | Less / more output | normal |
| `--no-color` | Plain output (also when `NO_COLOR` is set or output isn't a terminal) | |

A number option that isn't one (`--max-cost $1`, `--timeout 5s`, `--repeat 1.5`) is a configuration
error, exit `2`, saying what it takes: never taken as "no limit". `--repeat` and `--timeout` are whole
numbers, 1 or more; `--max-cost`, 0 or more. An option that isn't one, or one missing its value, is
said plainly with the help, exit `2`.

**What runs at once** is said by the files' groups ([Groups](test-file.md#groups)): suites and tests in
the same group one after another, different groups at the same time, none one group. There's no
`--concurrency` (nor `HAFEN_CONCURRENCY`): either given is a setup error saying so, exit `2` (an empty
`HAFEN_CONCURRENCY`, a CI variable that isn't set, is nothing).

Paths: files and folders (a folder is searched for `*.hafen.yml`, `.yaml`, `.json`, leaving out
`node_modules`, `.git`, `.hafen`, `dist` and `release`), in the current folder or anywhere. Files are
read only in the current folder and in the project of each path given (the nearest folder above it
with a `.git` or a `package.json`; else the path's own folder): a suite that names a file elsewhere
(`data: /home/me/.aws/credentials`) has a problem saying so, and exits `2`.

**Load tests** (`load:`): skipped without `--load`, saying so. Load mode (many requests at once,
ramped up, with percentiles: spec US11) isn't built yet, so with `--load` a load test that's chosen
is a setup error naming it (exit `2`, nothing sent), rather than sent once as any test and passed.

`validate` takes `--env`, `--var` (variables the run will be given) and `--env-check` (also check that every `${env:…}` is set).

## Options for `serve`

| Option | Meaning | Default |
|---|---|---|
| `--port <n>` | Where to listen (a whole number, 0 to 65535); one that's taken is a setup error, exit `2`, saying so | `8790` |
| `--host <address>` | The address to listen on | `127.0.0.1` |
| `--allow-endpoint <url>` | An endpoint the relay may call (repeatable; a prefix: `https://api.acme.example/`). Also `HAFEN_ENDPOINTS`, comma-separated | none: the relay refuses everything |

The relay only answers the pages it serves (it checks `Origin`; and, listening on a loopback address,
only a page that reached it by a loopback name, `127.0.0.1` or `localhost`, so a site whose name was
made to point at this machine, DNS rebinding, isn't taken for its own), passes streams through
unchanged, and says in a header when it refused a call (`X-Hafen-Relay: refused`), so the app can tell
the user why.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Every test ran and passed (unsure results counted as the unsure policy says) |
| `1` | At least one test failed, or the run regressed past `--fail-on` thresholds |
| `2` | Setup or configuration error: a file that doesn't parse or validate, a newer `version`, a missing variable, secret, file or plugin; or no tests ran (the suites have none, or none match `--test` / `--tag`). Nothing was sent, or what was sent can't be trusted |
| `3` | Stopped early: `--max-cost` reached, `--bail`, or cancelled (SIGINT, SIGTERM). Reports are written for what ran |

A test whose turns hit errors (endpoint down, judge unreachable) and no failures makes the run fail
with code 1, and the reports list them as errors, not failures.

## Output

While running, one line per test as it ends, then a summary:

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
– billing › soak   a load test (needs --load, or confirming in the app)

2 suites · 5 tests · 1 failed · 1 error · 1 unsure · 412 checks · p50 1.2 s · p95 2.8 s · $0.23 · 1 min 12 s
Run file: .hafen/runs/k3f9….hafen-run.json
```

A test's line: its runs (or rows) that passed, its checks that passed (one turned off isn't
counted), its time and its cost (when priced); then what went wrong, a line each, at most three: where
(the row, the run when it repeats, the turn, or `conversation`), the check and why, or why the turn
broke (once, not for each of its checks), or why a setup step failed. The summary counts errors
apart from failures (`1 error`, when there are any). `--verbose` adds a line per turn with its
checks. Nothing printed holds a secret: every event the runner sends out (to the output, or the
app's page) is redacted as the run file is.

Errors in the setup are printed with the file, line and column, and how to fix them:

```
tests/support/refund.hafen.yml:14:18  ${env:ACME_QA_PASSWORD} isn't set
```

## Reports

| Format | Contents |
|---|---|
| `junit` | One `<testsuite>` per suite file; one `<testcase>` per test (per row for data tests: `name [row 17]`); a `<failure>` per failed check (message: the check and why; text: the turn's message and reply excerpt), an `<error>` per error, `<skipped>` for skipped tests; `<properties>` with pass rate, checks, p50 and p95 latency, tokens and cost. Unsure results with `warn` go in `<system-out>` |
| `run` | The run file ([run-file.md](run-file.md)): open it in the app to see the chat and timeline |
| `md` | A summary for a CI job page or pull request comment: totals, a table of tests, failures with reasons, the baseline comparison |
| `json` | The run's summary and every check result, for dashboards |

## Environment

| Variable | Use |
|---|---|
| any `${env:NAME}` a suite uses | Secrets and settings |
| `NO_COLOR` | Plain output |
| `GITHUB_STEP_SUMMARY` | When set, the Markdown summary is appended to it |

## In CI

```yaml
# .github/workflows/ai-tests.yml
name: AI tests
on: [pull_request, push]
jobs:
  eval:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci --prefix evals
      - name: Get the main branch's last run, to compare with
        uses: actions/cache/restore@v4
        with: { path: baseline/, key: hafen-main-${{ github.run_id }}, restore-keys: hafen-main- }
      - name: Run the tests
        run: >
          node evals/cli/hafen.js run tests/
          --env staging --max-cost 2.00
          --report junit:results/junit.xml --report run:results/run.hafen-run.json --report md:results/summary.md
          $([ -f baseline/run.hafen-run.json ] && echo --baseline baseline/run.hafen-run.json)
        env:
          ACME_QA_PASSWORD: ${{ secrets.ACME_QA_PASSWORD }}
          JEV_API_KEY: ${{ secrets.JEV_API_KEY }}
      - if: always()
        uses: actions/upload-artifact@v4
        with: { name: hafen, path: results/ }
      - if: github.ref == 'refs/heads/main' && success()
        run: mkdir -p baseline && cp results/run.hafen-run.json baseline/run.hafen-run.json
      - if: github.ref == 'refs/heads/main' && success()
        uses: actions/cache/save@v4
        with: { path: baseline/, key: hafen-main-${{ github.run_id }} }
```

The app's **Copy CI command** gives the `run` line for the open suite or test, with its
environment and the reports above.
