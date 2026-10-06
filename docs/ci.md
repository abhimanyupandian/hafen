# Running in CI

The command line runs your suite files unchanged, so the tests you build in the app run on every
pull request. The examples here assume Hafen's folder is in your repository at `hafen/`, and your
suites are under `tests/`.

## The command

```sh
node hafen/cli/hafen.js run tests/ --env staging \
  --report junit:results/junit.xml \
  --report run:results/run.hafen-run.json \
  --report md:results/summary.md
```

In the app, **Copy CI command** (on a suite or a test) gives you this line for what's open, with its
environment and these reports.

## Secrets

Secrets are `${env:NAME}` in your files, or a scope's secrets as `{{scope.NAME}}`. In CI, both come
from the job's environment variables. Values are redacted from the output and from every report and
run file.

A secret that isn't set stops the run before anything is sent (exit `2`), naming the file, line and
variable. `validate --env-check` checks this without running anything.

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
      - run: npm ci --prefix hafen

      - name: Get the main branch's last run, to compare with
        uses: actions/cache/restore@v4
        with: { path: baseline/, key: hafen-main-${{ github.run_id }}, restore-keys: hafen-main- }

      - name: Run the tests
        run: >
          node hafen/cli/hafen.js run tests/
          --env staging --max-cost 2.00
          --report junit:results/junit.xml --report run:results/run.hafen-run.json --report md:results/summary.md
          $([ -f baseline/run.hafen-run.json ] && echo --baseline baseline/run.hafen-run.json)
        env:
          ACME_API_KEY: ${{ secrets.ACME_API_KEY }}
          JEV_API_KEY: ${{ secrets.JEV_API_KEY }}

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

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Everything passed (unsure results warn) |
| `1` | A test failed, or the run regressed past `--fail-on` against `--baseline` |
| `2` | A setup error: a file that doesn't parse or validate, a variable or secret that isn't set. Nothing was sent |
| `3` | Stopped early: `--max-cost`, `--bail`, or cancelled. Reports are written for what ran |

## Baselines and regressions

Compare a run with an earlier one, usually the main branch's last, and fail on a regression:

```sh
node hafen/cli/hafen.js run tests/ --baseline baseline/run.hafen-run.json --fail-on pass_rate=5,p95=20,cost=10
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
