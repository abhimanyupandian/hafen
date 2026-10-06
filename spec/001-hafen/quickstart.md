# Quickstart: validating Hafen

Scenarios that show the project works, end to end, once it's built. Each says what to run and what
should happen. They use the mock endpoint and the reference suites in `evals/tests/fixtures/`, so
they need no keys and cost nothing (except where marked).

Formats and behaviours are defined in [contracts/](contracts/) and [data-model.md](data-model.md);
this page only checks them. Commands run from the repository's root.

## Prerequisites

- Node 22 or newer, and npm.
- `npm ci --prefix evals`.
- The mock endpoint, in its own terminal:

  ```sh
  node evals/tests/fixtures/mock-endpoint.mjs --port 8791
  ```

  It answers on `http://localhost:8791/<scenario>`: `json`, `sse`, `ndjson`, `ws`, `thinking/full`,
  `thinking/summary`, `thinking/omitted`, `thinking/tags`, `tools`, `tools/ask` (a model API that
  wants tool results), `tools/answer-first`, `session`, `slow?ms=…`, `cut`, `error/500`,
  `ratelimit`, `flaky?rate=0.9`, `nocors`, and mock judges at `/systemone` and `/judge`.

## 1. Explore an endpoint (US1)

```sh
npm --prefix evals run app      # the desktop app
```

1. Under **Providers**, press **+**, choose `http`, URL `http://localhost:8791/sse`, stream `sse`,
   and the event paths the mock's README lists.
2. Send `hello`. **Expect:** the reply streams into a message; the stats line shows time to first
   token, total, tokens; the badge in the top bar is on.
3. Switch the provider to `…/json` (stream `none`, text `$.data.reply`) and send again. **Expect:**
   the reply appears at once; the panel's Response shows the JSON tree.
4. Use `…/thinking/full` and `…/tools`. **Expect:** thinking (collapsed, with its time) and
   `↳ lookup_order · …` before the text, in order.
5. Use `…/error/500` and `…/cut`. **Expect:** the message shows the error (and, for `cut`, the text
   that arrived); sending again works.
6. Use `…/session` with `history: session`. **Expect:** the second request carries the session id
   from the first reply (the panel's Request shows it).

## 2. Make a test with checks (US2)

1. With a two-turn conversation open, in the panel: Suite "New suite…", name `smoke`, **SAVE AS
   TEST**. **Expect:** `smoke.hafen.yml` appears in the folder and in the Suites tree.
2. Select turn 1; in Response, click `order.id`, choose `equals`, keep `4417`, **Add check**.
   **Expect:** the file gains `{ path: $.reply.order.id, equals: 4417 }` under that turn, and its
   comments and other keys are untouched (`git diff` shows only that line).
3. From **Checks**, add **Text** `contains: "refund"` to turn 2. **RUN**. **Expect:** badges under
   each reply, one failing where the mock's reply lacks "refund"; the tree shows `failed`.
4. Set **On failure** to `stop`, run again. **Expect:** turn 2 is skipped.
5. Set **Repeat** 3, **Pass rate** 0.67, provider `…/flaky?rate=0.9`. **Expect:** `passed 3/3` or
   `2/3` most times, with the count shown.

## 3. Run it in CI (US3)

```sh
node evals/cli/hafen.js validate evals/tests/fixtures/suites
node evals/cli/hafen.js run evals/tests/fixtures/suites/smoke.hafen.yml \
  --report junit:out/junit.xml --report run:out/run.hafen-run.json --report md:out/summary.md
echo "exit $?"
```

**Expect:**

- `validate` prints nothing wrong and sends no requests (the mock's log shows none).
- `run` prints one line per test and a summary; exit `1` (a check fails by design in this suite).
- `out/junit.xml` names the failing test, turn and check.
- Unset a variable the suite needs (`unset MOCK_TOKEN`) and run again: exit `2`, with the file,
  line and variable named, and no requests sent.
- `--max-cost 0.000001` with a priced provider: exit `3`, reports written, the rest skipped.
- Open `out/run.hafen-run.json` in the app (**Runs → open**). **Expect:** the same
  conversation, results and timeline as the CI output described.
- Rule-check results in the app and the CLI agree on `reference-50.hafen.yml` (SC-002):
  `node evals/tests/cli/compare-app-cli.mjs` reports 100%.

## 4. Judges and confidence (US4)

Use `evals/tests/fixtures/suites/judged.hafen.yml` (its judges point at the mock's `/systemone`
and `/judge`).

**Expect:** a noul check passing with its value and confidence; a check the mock answers with low
confidence shown as `unsure` (amber) and reported as a warning by the CLI; an LLM judge showing
`2/3` agreement; with the mock judge stopped, those checks are `error`, not `fail`.

*Optional, costs money:* set `judges.default` to `{ kind: systemone }` with `JEV_API_KEY`
(TypeSafe's hosted Jev) and run the same suite.

## 5. Timeline and metrics (US5)

Run `evals/tests/fixtures/suites/steps.hafen.yml` (thinking, a tool call, three turns) in the app.

**Expect:** the Timeline dock shows every step as a bar, grouped by turn; clicking a bar scrolls the
thread to it and opens it in the panel; bars grow while it runs; a selected turn's facts show time
to first token, thinking, first answer token, tokens and tokens/s.

## 6. Thinking (US6)

Run `evals/tests/fixtures/suites/thinking.hafen.yml` against `thinking/full`, `thinking/summary`,
`thinking/omitted` and `thinking/tags`.

**Expect:** content checks pass on full and summary (labelled `summary`); skipped on omitted
("thinking not returned"), failed where marked `required`; tags split correctly even across chunks;
the `sequence` check fails against `tools/answer-first`, showing the order.

## 7. Data, setup, environments (US7)

Run `evals/tests/fixtures/suites/data.hafen.yml` (a 5-row CSV, a login setup step) with
`--env local`.

**Expect:** 5 runs of the test, each with its row's values and the login's token; accuracy `x/5`;
the teardown request in the mock's log even when a row fails.

## 8. Tools (US8)

Run `evals/tests/fixtures/suites/tools.hafen.yml`. **Expect:** argument and order checks pass and
fail as labelled; against `tools/ask`, the runner sends the mocked result and the final reply uses
it.

## 9. Baselines (US9)

```sh
node evals/cli/hafen.js run evals/tests/fixtures/suites/smoke.hafen.yml --report run:out/a.json
MOCK_DELAY_MS=400 node evals/cli/hafen.js run evals/tests/fixtures/suites/smoke.hafen.yml \
  --baseline out/a.json --fail-on p95=20
```

**Expect:** the second run exits `1`, saying p95 rose past 20%; the Markdown summary shows both
runs' numbers. In the app, the Run panel's **Compare with** shows the same.

## 10. Plugins (US10)

Run `evals/tests/fixtures/suites/plugins.hafen.yml` (a check plugin and a provider plugin from
`evals/tests/fixtures/plugins/`) in the app and the CLI. **Expect:** the same results; the provider
plugin's test that tries to read `process.env` or the key finds nothing; removing a plugin file
makes the CLI exit `2` naming it.

## 11. Load (US11)

```sh
node evals/cli/hafen.js run evals/tests/fixtures/suites/load.hafen.yml --load
```

(`load: { concurrency: 20, requests: 200 }` against `slow?ms=200`.) **Expect:** p50 near 200ms,
p95 and p99 shown with `n=200`; without `--load` the test is skipped. In the browser build, the
load test can't start and says why.

## 12. Simulation (US12)

- `--network delay=300`: time to first token rises by about 300ms on every turn, in the app and the
  CLI.
- `evals/tests/fixtures/suites/simulate.hafen.yml`: the mock plays a customer; the conversation
  stops when the stop condition is met or at `max_turns`; checks run on each turn.
- An endpoint on a weaker machine: run the endpoint itself in a container with limits, and test it
  as usual:

  ```sh
  docker run --rm --cpus 1 --memory 512m -p 8792:8792 -v "$PWD/evals":/w -w /w node:22 \
    node tests/fixtures/mock-endpoint.mjs --port 8792
  ```

## 13. Browser build (US13)

```sh
npm --prefix evals run build
node evals/cli/hafen.js serve --allow-endpoint http://localhost:8791/nocors    # http://127.0.0.1:8790
```

**Expect:** against the mock's ordinary scenarios (which allow page calls) tests run as in the
desktop app; against `…/nocors` they run through the relay; stop `serve`, open the build as static
files, and `…/nocors` fails with a message saying the browser blocked the call and suggesting the
desktop app or the relay.

## 14. UI and privacy (SC-007, SC-008)

```sh
npm --prefix evals run test:visual     # the gallery against its baseline screenshots
npm --prefix evals test                # engine, CLI, relay and contract tests (Node)
npm --prefix evals run test:browser    # the engine tests in a browser; the app end to end
grep -R -F "$MOCK_SECRET" out/ && echo LEAK || echo clean
```

**Expect:** no visual differences; all tests pass; `clean`. Also: `grep -R -E "from ['\"]\.\./\.\./(web|electron|server)" evals/` finds nothing (the project imports nothing from outside
`evals/`).
