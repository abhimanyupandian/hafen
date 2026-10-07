# Running in CI

The command line runs your suite files unchanged, so the tests you build in the app run on every
pull request. It's the `hafen` package: the examples here assume it's one of your repository's dev
dependencies ([Installing](#installing)), and your suites are under `tests/`.

## The command

```sh
npx hafen run tests/ --env environments/staging.env --secret "$RUNNER_TEMP/staging.secrets.env" \
  --report junit:results/junit.xml \
  --report run:results/run.hafen-run.json \
  --report md:results/summary.md
```

In the app, **Copy CI command** (on a suite or a test) gives you the `run` line for what's open, with
the scope's files (`--env staging.env --secret staging.secret.env`, as Settings → Environments and
Secrets export them) and the JUnit and run file reports.

## Installing

The command line is the `hafen` package: the engine and the CLI, with no Electron, React, Vite or
Playwright (those are the app's). Add it to your repository, and CI's `npm ci` installs it:

```sh
npm install --save-dev hafen
```

| Install | `node_modules` | Runs |
|---|---|---|
| `npm install hafen` | About 52 MB | `run`, `validate`, `report`, `compare`, `pack` |
| `npm install hafen --omit=optional` | About 9 MB | `run`, `validate`, `report`, `compare`. Not `pack`: it bundles with rolldown, an optional dependency, and says so |
| A [pack](#running-a-pack) | None: one file and Node 22 | Its suites: `run`, `validate`, `report`, `compare` |

(Most of the difference is native binaries that `--omit=optional` leaves out: rolldown's, and the
TypeScript compiler's that json-p3 brings, which running suites doesn't need.)

Until `hafen` is on npm, make its package in Hafen's repository and install that:

```sh
npm pack -w hafen                          # in Hafen's repository: hafen-0.1.0.tgz
npm install --save-dev ./hafen-0.1.0.tgz   # in yours
```

## Environments and secrets

`{{env.NAME}}` in your files is a value of the environment, and `{{secret.NAME}}` a secret. The
command line takes both from `KEY=VALUE` files you name, anywhere on the disk
([Environments and secrets](cli.md#environments-and-secrets)):

- **`--env <file>`**: the environment's values. They aren't secret, so commit the file
  (`environments/staging.env`, one for each environment). Its name (`staging`) picks each suite's
  environment of that name.
- **`--secret <file>`**: the secrets. Never commit this one: in CI, write it from the CI's secrets
  as the job runs, outside the checkout (`$RUNNER_TEMP` on GitHub Actions), as below. Or leave it out
  and give the secrets as the job's environment variables: a name the file hasn't (or with no file,
  every name) comes from the environment variable of that name.

Secrets are redacted from the output and from every report and run file: every value in the secrets
file, and every secret taken from the environment. The environment's values aren't secret, and
aren't redacted.

A value or secret that isn't set stops the run before anything is sent (exit `2`), naming the file,
line and variable. That's every `{{env.NAME}}` and `{{secret.NAME}}` your files use, and every one a
plugin writes in its code (`"{{secret.ACME_PASSWORD}}"`, named at that line of the plugin). So does
an `--env` or `--secret` file that doesn't exist, or has a line that isn't `NAME=value`.
`validate --env-check` checks the same without running anything: run it with the same files,
environment variables and `--var`s as the run, and a suite that passes it isn't stopped by that check.
Without `--env-check`, `validate` checks every `{{env.NAME}}` (against `--env`'s file, then the
suite's `environments:`), but not the secrets.

**Old spellings.** `${env:NAME}`, `{{scope.NAME}}` and a plugin's `{ secret: "NAME" }` stop the run
too (exit `2`), each at its line, saying what to write instead: `{{secret.NAME}}`, or `{{env.NAME}}`
for a value of the environment ([Old spellings](test-files.md#old-spellings)). A folder's
`environments/<name>.yml` isn't read: give the values with `--env <file>`.

## GitHub Actions

```yaml
# .github/workflows/ai-tests.yml
name: AI tests
on: [pull_request, push]
jobs:
  hafen:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci   # hafen is one of package.json's devDependencies

      - name: Get the main branch's last run, to compare with
        uses: actions/cache/restore@v4
        with: { path: baseline/, key: hafen-main-${{ github.run_id }}, restore-keys: hafen-main- }

      # The secrets file, from one CI secret that holds it all (KEY=VALUE lines), outside the checkout
      - name: Write the secrets file
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

      - name: Keep this run as main's baseline
        if: github.ref == 'refs/heads/main' && success()
        run: mkdir -p baseline && cp results/run.hafen-run.json baseline/run.hafen-run.json
      - if: github.ref == 'refs/heads/main' && success()
        uses: actions/cache/save@v4
        with: { path: baseline/, key: hafen-main-${{ github.run_id }} }
```

The Markdown summary also appears on the job's page, through `GITHUB_STEP_SUMMARY`.

With the secrets as CI secrets of their own instead, leave out the file: give them to the run step
as environment variables, and drop `--secret`.

```yaml
      - name: Run the tests
        run: >
          npx hafen run tests/ --env environments/staging.env
          --report junit:results/junit.xml --report run:results/run.hafen-run.json --report md:results/summary.md
        env:
          ACME_API_KEY: ${{ secrets.ACME_API_KEY }}
          JEV_API_KEY: ${{ secrets.JEV_API_KEY }}
```

## Running a pack

The leanest way to run in CI: a [pack](cli.md#pack) is one file that runs your suites with Node 22
alone. No hafen install, no `npm ci`, no `node_modules`. Make it where hafen is installed (with
rolldown, its optional dependency), and commit it with the `.env.example` and `.secret.example`
written next to it:

```sh
npx hafen pack tests/ -o ci/refunds.hafen-pack.mjs
```

```yaml
# .github/workflows/ai-tests.yml
name: AI tests
on: [pull_request, push]
jobs:
  hafen:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }

      - name: Run the tests
        run: >
          node ci/refunds.hafen-pack.mjs run
          --env environments/staging.env --max-cost 2.00
          --report junit:results/junit.xml --report run:results/run.hafen-run.json --report md:results/summary.md
        env:
          ACME_PASSWORD: ${{ secrets.ACME_PASSWORD }}

      - if: always()
        uses: actions/upload-artifact@v4
        with: { name: hafen, path: results/ }
```

The baseline steps above work the same with a pack. A pack is a snapshot: pack again when the suites,
their providers or their plugins change, and commit it again. (Or pack in a job of its own, after
`npm ci`, and hand the file to the jobs that run it as a build artifact.) `node
ci/refunds.hafen-pack.mjs info` says what's in it (each file with its hash), and `validate --env
<file> --env-check` says whether every value and secret it needs is set.

A pack holds your suites, the files they name and their plugins, as they are. Never an environment's
values or a secret's: only the names its suites, providers and plugins use (`{{env.NAME}}`,
`{{secret.NAME}}`). It takes them where it runs, as the command line does: `--env <file>`, and
`--secret <file>` or environment variables.

### The names a pack needs

`pack` also writes the names a pack needs next to it, never a value, so both files are safe to
commit:

- `ci/refunds.hafen-pack.env.example`: the environment's names (`{{env.NAME}}`), to fill in a copy of
  for each environment, such as `environments/staging.env`.
- `ci/refunds.hafen-pack.secret.example`: the secrets' names, each with what uses it: the list of
  secrets to give the CI job.

A pack that needs no environment values, or no secrets, gets no file for them.

```
# The secrets refunds.hafen-pack.mjs needs: their names, never their values. Fill in a copy (never commit
# it) and give it with --secret, or set them as environment variables where it runs:
#   node refunds.hafen-pack.mjs run --env staging.env --secret staging.secrets.env

# used by plugins/acme-login.js
ACME_PASSWORD=
```

To run the pack on your machine, fill in copies and name them:

```sh
cp ci/refunds.hafen-pack.secret.example ~/secrets/staging.secrets.env   # then fill in the values
node ci/refunds.hafen-pack.mjs run --env environments/staging.env --secret ~/secrets/staging.secrets.env
```

Keep the secrets file out of the repository (outside it, as here, or in `.gitignore`). A secret the
file leaves empty (`NAME=`) is taken from the environment variable of that name; set in neither, the
run stops before anything is sent (exit `2`). The same works with the command line: `npx hafen run
tests/ --env environments/staging.env --secret ~/secrets/staging.secrets.env`.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Everything passed (unsure results warn) |
| `1` | A test failed, or the run regressed past `--fail-on` against `--baseline` |
| `2` | A setup error. Found before the run: a file that doesn't parse or validate, a variable, environment value or secret that isn't set, an `--env` or `--secret` file that doesn't exist or has a line that isn't `NAME=value` (nothing was sent). Or found as it ran: a suite's setup step or a provider's `beforeAll` fixture that failed (that suite's tests weren't sent; what ran before, and `afterAll` fixtures, were) |
| `3` | Stopped early: `--max-cost`, `--bail`, or cancelled. Reports are written for what ran |

## Baselines and regressions

Compare a run with an earlier one, usually the main branch's last, and fail on a regression:

```sh
npx hafen run tests/ --baseline baseline/run.hafen-run.json --fail-on pass_rate=5,p95=20,cost=10
```

| Threshold | Fails when |
|---|---|
| `pass_rate=<points>` | The pass rate falls by more than this many points (default `5`) |
| `p95=<percent>` | p95 latency rises by more than this percentage |
| `cost=<percent>` | Cost rises by more than this percentage |

The Markdown report shows both runs' numbers side by side. In the app, a run's **Compare with**
shows them too, with the checks that flipped.

## Keeping costs in check

- `--max-cost <usd>` stops the run when its cost reaches the limit (exit `3`). Costs need
  [prices](providers.md#prices).
- `--tag smoke` runs only tests with that tag, for example on every pull request, with the full suite
  on `main`.
- `--repeat 1` overrides the files' repeat counts for a quick run.

## Looking at a CI run

Download the run file from the job's artifacts and open it in the app (**Runs** → open). You'll see
the same conversation, check results and timeline as if it had run on your machine.
