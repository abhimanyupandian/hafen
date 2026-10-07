# Contract: the command-line runner

`hafen` runs suites in CI (or anywhere) with the same engine as the app. It needs Node 22 or newer.
It's the `hafen` package (`evals/packages/hafen/`: the engine and the CLI, with no Electron, React or
Playwright), installed on its own: `npm install hafen`, then `npx hafen …`. In the project, after `npm
ci --prefix evals`, the workspace's own: `npx hafen …` there, or `node
evals/packages/hafen/cli/hafen.js …`. The browser build's server with its relay is the app's, not the
package's: `npm run serve` (`evals/server/serve.js`; Options for `npm run serve`, below).

## Commands

```
hafen run [paths…] [options]       run suites (files or folders; default: the current folder)
hafen validate [paths…] [options]  check suites against the schema; sends nothing
hafen report <run-file> [options]  write reports from a run file (JUnit, Markdown, JSON)
hafen compare <run-file> --baseline <run-file> [options]
                                        compare two runs; exit 1 on regression
hafen pack [paths…] -o <file>      pack suites and everything they need into one file that runs them
                                        with Node alone
hafen --version | --help
```

Folders are searched for `*.hafen.yml`, `*.hafen.yaml` and `*.hafen.json`.

## Options for `run`

| Option | Meaning | Default |
|---|---|---|
| `--test <name>` | Only tests whose name contains this (repeatable) | all |
| `--tag <tag>` | Only tests with this tag (repeatable; any) | all |
| `--env <file>` | The environment: a `KEY=VALUE` file anywhere on the disk (`engine/env-file.js`), read by the command line, its values given to the engine as `environment: { name, values }` (and `env: name`). They fill `{{env.NAME}}`; its name, the file's without its extension (`staging.env`: `staging`), picks the suites' environment of that name. See Environments and secrets below | the suite's first environment |
| `--env <name>` | The suites' environment of that name, with no values given (`env: name`). Nothing is read from the folder: an `environments/<name>.yml` isn't | |
| `--secret <file>` | Secrets: a `KEY=VALUE` file anywhere on the disk. They fill `{{secret.NAME}}` (`host.secrets(NAME)`: the file's value, then the environment variable `NAME`). Also `--secrets`; one file | the environment's variables |
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
| `--network delay=<ms>,jitter=<ms>,kbps=<n>,drop=<rate>` | A network profile for every request: `delay` and `jitter` 0 or more, `kbps` above 0, `drop` from 0 to 1 (any other value is a setup error); a dropped response is cut off, whatever its size | none |
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

`validate` takes `--env`, `--secret`, `--var` (variables the run will be given) and `--env-check`.
With `--env <file>`, every `{{env.NAME}}` is checked against its values (the run's own check); with
`--env-check`, also every secret (`{{secret.NAME}}`, in the files and in plugins' code) against
`--secret`'s file, then the environment. The old spellings (`${env:NAME}`, `{{scope.NAME}}`, a
plugin's `{ secret: "NAME" }`) are problems with or without `--env-check`, each saying what to write
instead (test-file.md, Old spellings).

## Environments and secrets

`--env <file>` and `--secret <file>` are plain-text `KEY=VALUE` files (`engine/env-file.js`,
`parseEnvText`: `# comments`, blank lines, `export `, quotes), anywhere on the disk: the command line
reads them itself (`node:fs`), not through its host, whose reads stay in the project. The engine never
reads an environment's values from the project's folder: the command line passes them
(`runSuites`/`preflight` option `environment: { name, values }`, with `env: name`).

- `--env`'s value is a file when it has a `/` or `\` in it, or ends in `.env`, or a file of that name
  exists; otherwise it's an environment's name, with no values (the suites' environment of that name;
  a folder's `environments/<name>.yml` isn't read).
- `--secret`: the host's `secrets(NAME)` is the file's value (one it leaves empty, `NAME=`, isn't
  set by it), then `process.env[NAME]`, so CI's secrets as environment variables work with or without
  a file. Every value in the file is redacted from the output, every event and every report and run
  file (as the engine redacts each secret it fills in), wherever it shows, even one no file uses.
- A file that doesn't exist or can't be read is a setup error, exit `2`, nothing sent (`the
  environment file staging.env doesn't exist`, `the secrets file … can't be read: it's a folder`); so
  is a line that isn't `NAME=value`, at its file, line and column (`staging.env:4:1  line 4 isn't
  NAME=value`, then `1 problem: nothing was sent.`). A secrets file's problems never quote its lines.
  More than one secrets file is a setup error.
- A `{{env.NAME}}` the environment hasn't (its file's values, then the suite's environment of its
  name), or a `{{secret.NAME}}` that isn't set, is a setup error before anything is sent (exit `2`),
  at the file, line and column where it's used.

The app's **Copy CI command** gives `npx hafen run <paths> --env <file> --secret <file>
--report …`.

## `pack`

`hafen pack [paths…] -o <file>` (`--out`; default `<folder>.hafen-pack.mjs`): the suites the paths
name (as `run` finds them) and everything they need, in one ES module that runs them with Node 22
alone (`cli/pack.js`, `cli/pack-runtime.js`):

- hafen's command line, bundled with its packages (by rolldown, an optional dependency of hafen;
  without it, `pack` says to install it, exit `2`);
- the suites, and the files they name: providers (`providerFiles`), data files, prices files;
- the plugins they use: named in `plugins:` (a path, or a package: packed at
  `.hafen-pack/packages/<name>.js`, and resolved there), and the folder's they use by name (providers'
  kinds and fixtures, judges', checks'): each loaded first, then bundled with what it imports into one
  module. A name a suite uses that no plugin gives (or whose plugin doesn't load or bundle: an import
  that can't be found) is an error naming it, and nothing is packed. So is a plugin that names a
  secret the old way (`{ secret: "NAME" }`): a problem at its line, saying the new way.

Never an environment's values or a secret's: they're given where it runs (`--env <file>`, `--secret
<file>` or environment variables). The pack lists what it needs (`environment`, `secrets`): the
`{{env.NAME}}`s its files and plugins use; the secrets its files name (`{{secret.NAME}}`, a preset's
or System One's default key), less what its fixtures give, and the names its plugins' code writes as
`"{{secret.NAME}}"` (found in their text).
Next to it, never a value: `<pack>.env.example` (the environment's names, `NAME=` a line) and
`<pack>.secret.example` (the secrets' names, each after a `# used by …` line); none needed, no file.
`pack` prints what it packed, the environment values it uses and the secrets it needs (with the
examples' names), and how to run it (`node <pack> run --env <name>.env --secret <name>.secrets.env`).
A suite with problems packs nothing (exit `2`, the problems said). The file holds none of the packing
machine's paths (the bundler's region comments are left out; packing and serving are a stand-in
that says a pack can't).

Run: `node <pack> run | validate | report | compare [options]`, the command line's options, over the
pack's files: paths name suites in it (a suite's path, or a folder of them; none: all; one it hasn't is
a setup error listing what it has). `--env <file>` and `--secret <file>` as the command line's, read
from the disk where it runs; secrets the file hasn't from the environment. `validate --env-check` also
checks the names its plugins give. `info`: what's in it (suites, plugins with their kind, name, version
and how many files each was bundled from, other files, each with the start of its SHA-256), the
environment values it uses and the secrets it needs. `--version`: hafen's, the pack's name, when it was packed and with which hafen. `--help`: its
own. `serve` and `pack`: a setup error (exit `2`). Its plugins' workers are the pack's file again, in a
thread with no environment. A run's `where.pack` is the pack's name.

## Options for `npm run serve`

`hafen serve` is no longer the package's: it says, in a line, that serving is the app's (`npm run
serve`), a setup error (exit `2`). `npm run serve -- [options]` (`node evals/server/serve.js`) takes:

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
| `2` | Setup or configuration error: a file that doesn't parse or validate, a newer `version`, a missing variable, environment value, secret, file or plugin, an `--env` or `--secret` file that doesn't exist or has a line that isn't `NAME=value`; or no tests ran (the suites have none, or none match `--test` / `--tag`). Nothing was sent, or what was sent can't be trusted |
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
apart from failures (`1 error`, when there are any), and the fixtures that ran (`3 fixtures (1
failed)`, when there are any). A provider's fixture that fails has a line as it ends, always
(`⚙ fixture acme-logout · afterAll · providers/acme.yml  failed: …`: an after or afterAll one changes no
result, so this is where it's seen). `--verbose` adds a line per turn with its checks, per fixture as
it ends (`⚙ fixture acme-login · beforeAll · providers/acme.yml  ok  0.4 s  gave ACME_COOKIE · 1 call`),
and per HTTP call a plugin or fixture made (`POST auth.acme.example/login  200  0.1 s  (fixture
acme-login)`). Nothing printed holds a secret: every event the runner sends out (to the output, or the
app's page) is redacted as the run file is.

Errors in the setup are printed with the file, line and column, and how to fix them:

```
tests/support/refund.hafen.yml:14:18  {{secret.ACME_QA_PASSWORD}} isn't set
```

## Reports

| Format | Contents |
|---|---|
| `junit` | One `<testsuite>` per suite file; one `<testcase>` per test (per row for data tests: `name [row 17]`); a `<failure>` per failed check (message: the check and why; text: the turn's message and reply excerpt), an `<error>` per error, `<skipped>` for skipped tests; `<properties>` with pass rate, checks, p50 and p95 latency, tokens and cost (and fixtures, fixtures_failed). Unsure results with `warn` go in `<system-out>`; so does a line for each provider fixture that ran for the case (a failed one in `<system-err>` too), and the run's own (beforeAll, afterAll) in each suite's |
| `run` | The run file ([run-file.md](run-file.md)): open it in the app to see the chat and timeline |
| `md` | A summary for a CI job page or pull request comment: totals, a table of tests, failures with reasons, a table of the fixtures that ran, the baseline comparison |
| `json` | The run's summary, every check result, every fixture that ran (`fixtures`) and every HTTP call a plugin or fixture made (`calls`: plugin, call, status, error, ms, what made it), for dashboards |

## Environment

| Variable | Use |
|---|---|
| any `{{secret.NAME}}` a suite uses | Its secret, when `--secret`'s file hasn't it |
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
      - run: npm ci   # hafen, one of the repository's devDependencies
      - name: Get the main branch's last run, to compare with
        uses: actions/cache/restore@v4
        with: { path: baseline/, key: hafen-main-${{ github.run_id }}, restore-keys: hafen-main- }
      - name: Write the secrets file (one CI secret holding its KEY=VALUE lines), outside the checkout
        run: printf '%s\n' "$HAFEN_SECRETS" > "$RUNNER_TEMP/staging.secrets.env"
        env:
          HAFEN_SECRETS: ${{ secrets.HAFEN_STAGING_SECRETS }}
      - name: Run the tests
        run: >
          npx hafen run tests/
          --env environments/staging.env --secret "$RUNNER_TEMP/staging.secrets.env" --max-cost 2.00
          --report junit:results/junit.xml --report run:results/run.hafen-run.json --report md:results/summary.md
          $([ -f baseline/run.hafen-run.json ] && echo --baseline baseline/run.hafen-run.json)
      - if: always()
        uses: actions/upload-artifact@v4
        with: { name: hafen, path: results/ }
      - if: github.ref == 'refs/heads/main' && success()
        run: mkdir -p baseline && cp results/run.hafen-run.json baseline/run.hafen-run.json
      - if: github.ref == 'refs/heads/main' && success()
        uses: actions/cache/save@v4
        with: { path: baseline/, key: hafen-main-${{ github.run_id }} }
```

Or, with no secrets file, the secrets as the run step's environment variables (`env: { ACME_QA_PASSWORD:
${{ secrets.ACME_QA_PASSWORD }} }`) and no `--secret`. The app's **Copy CI command** gives the `run`
line for the open suite or test, with the scope's files (`--env <scope>.env`, `--secret
<scope>.secret.env`, as Settings → Environments and Secrets export them) and the `junit` and `run`
reports.
