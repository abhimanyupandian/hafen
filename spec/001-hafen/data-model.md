# Data model: Eval

The entities from the [spec](spec.md#key-entities), their fields, rules and states. Types are
written TypeScript-style for clarity; the code is JavaScript ([research §3](research.md#3-the-engines-language-javascript)).
What's stored in files is defined exactly by the JSON Schemas in [contracts/](contracts/); the run
file by [contracts/run-file.md](contracts/run-file.md).

```
Suite file ─┬─ defaults, variables, setup/teardown
            ├─ provider ──────────────► Provider (file, preset or plugin)
            └─ tests[] ─ Test ─┬─ data ─► Data file (rows)
                               ├─ setup[] / teardown[] ─ Step
                               └─ turns[] ─ Turn ─┬─ extract
                                                  ├─ tools (mocked results)
                                                  └─ expect[] ─ Check ─► Judge (System One | LLM | plugin)

Run ───────────┬─ spans[] ─ Span (tree: run → test → repeat/row → turn → steps)
                ├─ turns[] ─ TurnRecord ─┬─ events[] ─ TurnEvent
                │                        ├─ raw request / response (redacted)
                │                        └─ results[] ─ CheckResult
                └─ summary ─ Metrics            Baseline comparison: Run × Run
```

## Suite

A YAML or JSON file; see [test-file.md](contracts/test-file.md).

| Field | Type | Rules |
|---|---|---|
| `version` | `1` | Required. A higher major version is refused |
| `name` | string | Defaults to the file name |
| `group` | integer ≥ 1 | Suites in the same group run one after another, groups at once; none is one group ([Groups](contracts/test-file.md#groups)) |
| `provider` | string \| Provider | A provider file's path, a preset name, a plugin name, or inline |
| `providers` | `{ [name]: string \| Provider }` | Named providers, for judges and tests that use another |
| `environments` | `{ [name]: { [var]: string } }` | Named variable sets, by the chosen environment's name (the app's scope, `--env`); each is `{{env.NAME}}` where the environment's values passed don't have NAME ([Environments and secrets](contracts/test-file.md#environments-and-secrets)), and a `{{name}}` |
| `variables` | `{ [var]: string \| number \| boolean }` | Suite variables. None (nor an environment's value, nor an extraction) is called `env`, `secret` or `secrets` |
| `defaults` | TestSettings | Settings every test starts from |
| `setup`, `teardown` | Step[] | Run once around the whole suite |
| `plugins` | `string[]` | More plugin modules (paths or package names); the folder's `plugins/*.js` are used by name without them |
| `prices` | string \| PriceTable | A prices file or inline |
| `tests` | Test[] | At least one |

## Test

| Field | Type | Rules |
|---|---|---|
| `name` | string | Required, unique in the suite |
| `id` | string | Stable id the app assigns (`t_` + 8 characters) so results follow renames; kept in the file |
| `tags` | string[] | For `--tag` filters |
| `group` | integer ≥ 1 | Tests in the same group run one after another, groups at once; none is one group ([Groups](contracts/test-file.md#groups)) |
| `provider` | string \| Provider | Overrides the suite's |
| `data` | string \| `{ file, limit?, shuffle? }` | A CSV or JSON-lines file; one run per row |
| `row_name` | string | Each row's name, a template filled in with the row (never a secret); without it, the row's first column's value ([Data file](#data-file)). Only with `data` |
| `setup`, `teardown` | Step[] | Teardown always runs |
| `turns` | Turn[] | At least one, unless `simulate` is set |
| `simulate` | Simulation | A simulated user instead of (or after) scripted turns |
| `expect_conversation` | Check[] | Checks after the last turn, on the whole conversation |
| settings | TestSettings | Overrides the suite's defaults |

### TestSettings

| Field | Type | Default |
|---|---|---|
| `repeat` | integer ≥ 1 | `1` |
| `pass_rate` | number 0–1 | `1` |
| `history` | `"live"` \| `"pinned"` | `"live"` |
| `on_fail` | `"continue"` \| `"stop"` | `"continue"` |
| `unsure` | `"pass"` \| `"warn"` \| `"fail"` | `"fail"` |
| `unsure_below` | number 0–1 | `0.6` |
| `timeout_ms` | integer | `120000` (per turn) |
| `retries` | integer ≥ 0 | `2` (rate limits and server errors) |
| `network` | NetworkProfile | none |
| `redact` | `{ patterns?: ("email"\|"card"\|"phone")[], headers?: string[] }` | headers only |

## Turn

| Field | Type | Rules |
|---|---|---|
| `user` | string \| ContentPart[] | Required. Variables (`{{…}}`) resolved before sending |
| `attachments` | `{ file, type? }[]` | Sent as the provider says; refused if it can't |
| `reply` | string | Pinned history only: the fixed reply earlier turns use instead of the live one |
| `extract` | `{ [var]: path }` | Values from the response into variables, for later turns |
| `tools` | `{ [tool]: ToolMock }` | Results to send back to a model API that asks for tools |
| `expect` | Check[] | Checks on this turn |

`ToolMock` is a fixed result (`{ result: any }`) or a list matched by arguments
(`{ when: { [path]: value }, result: any }[]`, the first match wins; no match is an error).

## Check

One object per check; see [checks.md](contracts/checks.md) for every type.

| Field | Type | Rules |
|---|---|---|
| `type` | string | A built-in check or a plugin's. May be left out when an operator is given (`{ path, equals }` is a path check) |
| `name` | string | Shown on its badge; defaults to a short form of the check (`contains 4417`) |
| `enabled` | boolean | Default `true`. `false` turns it off: it's skipped (reason "turned off (enabled: false)"), not looked at, not counted ([checks.md](contracts/checks.md#turning-a-check-off)) |
| `on` | `"response"` \| `"reply"` \| `"thinking"` \| `"turn"` \| `"events"` \| `"tools"` \| `"conversation"` | What it looks at; default `reply` (the reply text), or `response` (the parsed body) when `path` is set |
| `path` | string | RFC 9535 JSONPath into what `on` selects |
| `all` | boolean | With several matches: every value must pass (default: any) |
| operators | see checks.md | `equals`, `not_equals`, `contains`, `not_contains`, `matches`, `exists`, `type_is`, `min_length`, `max_length`, `lt`, `lte`, `gt`, `gte`, `schema` |
| `required` | boolean | On thinking: fail instead of skip when thinking wasn't returned |
| `unsure_below` | number | Overrides the test's |
| `unsure` | `"pass"` \| `"warn"` \| `"fail"` | Overrides the test's (`--unsure` overrides both) |
| `confidence` | number 0–1 (below 1) | Judged checks: pass only with the judge's confidence above it (never unsure); not with `unsure_below` or `unsure` |
| judge fields | see checks.md | `question`, `options`, `min`, `max`, `rubric`, `judge`, `samples`, `reference` |

Rules: a check has exactly one type; unknown fields are kept and warned about; a check with no
operator and no type is a setup error.

## Judge

| `kind` | Fields | Answers with |
|---|---|---|
| `systemone` | `endpoint?` (default TypeSafe's hosted Jev), `api_key?` (default `"{{secret.JEV_API_KEY}}"`), `model?` | value, probabilities, confidence |
| `llm` | `provider` (a named provider), `samples` (default 3), `temperature?` | verdict per criterion, reasons, agreement |
| `plugin` | `plugin`, its own fields | value, confidence, reason |

Judges are named in the suite (`judges: { default: …, strict: … }`) and referred to by name from
checks; `default` is used when a check doesn't name one.

## Provider

See [provider.md](contracts/provider.md).

| Field | Type | Rules |
|---|---|---|
| `kind` | `"http"` \| `"websocket"` \| a preset (`openai-chat`, `openai-responses`, `anthropic-messages`, `gemini`) \| `plugin:<name>` | Required |
| `url`, `method`, `headers`, `body` | | HTTP request template; variables, `{{env.NAME}}` and `{{secret.NAME}}` resolved at send time |
| `history` | `"messages"` \| `"session"` \| `"none"` | How a conversation is carried |
| `stream` | `"none"` \| `"sse"` \| `"ndjson"` | How the reply arrives |
| `response` | ResponseMap | Paths to text, thinking, tool calls, usage, session id (per event when streaming) |
| `think_tags` | `[open, close]` | Tags around thinking in text, e.g. `["<think>", "</think>"]` |
| `thinking` | `{ request?: object }` | Body changes that ask for readable thinking, applied when a test checks thinking |
| `secret_headers` | string[] | Extra headers to redact |
| `price` | `{ input, output, cached_input? }` | USD per million tokens |
| `timeout_ms`, `retries` | integer | Override the test's |

## Step (setup and teardown)

| Field | Type | Rules |
|---|---|---|
| `name` | string | Shown on the timeline |
| `request` | `{ url, method?, headers?, body? }` | An HTTP request, templated |
| `extract` | `{ [var]: path }` | Into variables |
| `expect` | Check[] | A failed setup check stops the test (an error, not a failure of the test's own checks) |

## Simulation

| Field | Type | Rules |
|---|---|---|
| `user` | string | A named provider that plays the user |
| `scenario` | string | Who the user is and what they want |
| `stop_when` | string | A condition, judged after each reply |
| `max_turns` | integer | Required, ≥ 1 |
| `expect_each` | Check[] | Checks on every reply |

## NetworkProfile

| Field | Meaning |
|---|---|
| `delay_ms`, `jitter_ms` | Added before the first byte, and its random spread |
| `kbps` | Bandwidth, both ways |
| `drop_rate` | 0–1, the share of requests cut off mid-stream |

## Data file

CSV with a header row, or JSON lines (one object per line). Each row becomes `{{row.<column>}}`.
Rows are numbered from 1 in results. A row whose values don't parse is an error for that row only.

Each row has a name, `row_name` on its instances, turn records and fixtures' `test`: the test's
`row_name` filled in with the row, else the value of its first column (a CSV file's header order, a
JSON line's first key); on one line, cut at 60 characters with `…`; none when empty or when it can't
be filled in. Everything that says a row says `row 3: <its name>` (none: `row 3`)
([test-file.md, Data rows](contracts/test-file.md#data-rows)).

## Run

The record of one run; stored in the app's IndexedDB database (`hafen`, store `runs`) and
written as `<_id>.hafen-run.json`. Full format in [run-file.md](contracts/run-file.md).

| Field | Type | Notes |
|---|---|---|
| `_id` | string | 16 random characters (`[0-9a-z]`) |
| `kind` | `"hafen-run"` | |
| `version` | `1` | |
| `mode` | `"test"` \| `"explore"` \| `"load"` | |
| `started`, `ended`, `ms` | number | Epoch ms; `ms` is the duration |
| `status` | RunStatus | below |
| `verdict` | `"passed"` \| `"failed"` \| `"unsure"` \| null | Null until the run ends, and for explore runs |
| `where` | `{ app: "desktop"\|"browser"\|"cli", version, os, node?, browser? }` | |
| `suites` | `{ file, name, sha256 }[]` | What ran, and the files' hashes |
| `settings` | object | Environment name (not values), filters, profiles, overrides |
| `spans` | Span[] | Every step |
| `turns` | TurnRecord[] | Every turn's events, request, response and results |
| `summary` | Metrics | |
| `reviews` | `{ result, agree, by?, at }[]` | Human review marks (not built yet: FR-040; nothing writes it today) |
| `baseline` | Comparison | When compared |

### RunStatus

```
           ┌──────────► done         (everything ran; see verdict)
running ───┼──────────► error        (setup or configuration error: nothing, or not everything, could run)
           ├──────────► stopped      (stopped by the user, a spending limit, or cancellation)
           └──────────► interrupted  (the app closed or the process died; found on next open)
```

## Span

| Field | Type | Notes |
|---|---|---|
| `_id` | string | |
| `parent` | string \| null | The span it's part of |
| `kind` | SpanKind | `run`, `suite`, `test`, `repeat`, `row`, `turn`, `setup`, `teardown`, `request`, `first_byte`, `thinking`, `tool_call`, `tool_result`, `answer`, `check`, `judge_call`, `retry`, `error`, `user_sim` (a simulated user's message), `fixture` (a provider's fixture running, named `<fixture> · <phase>`: beforeAll under the suite, before and after under the instance, afterAll under the run, any under the turn in a conversation; its `fixture: { name, phase, provider }`, its metrics' `provides` and `calls`, `stop: true` when it returned false (said to stop), `sets` (the environment names it set with env.set), its `error`), `call` (an HTTP call a plugin or fixture made, under what made it: its `plugin`, `request`, `response`, `error`; [provider.md](contracts/provider.md#plugins-calls)) |
| `name` | string | What the timeline shows: `lookup_order`, `contains 4417` |
| `start`, `end` | number | Milliseconds from the run's start, from a monotonic clock; `end` absent while running |
| `status` | `"running"` \| `"ok"` \| `"pass"` \| `"fail"` \| `"unsure"` \| `"skipped"` \| `"error"` | Steps are `ok` or `error`; checks use check results |
| `ref` | `{ turn?, check?, event?, checks? }` | Links to the turn record, check result or event; a System One call's, the turn's checks it asks for (`checks`, their places in the turn's results) |
| `metrics` | Metrics | What applies to it |
| `request` | `{ method, url, headers, body }` | A System One call's (`judge_call`): the request as it was sent, all of it, `body` as the JSON it is (`{ state, model, questions }`), but its key: the `authorization` header is `[redacted]`, and every secret value the run used is redacted wherever it is. Set as the call starts, so it's there (and sent to the app) while the call is being answered |

A span changed as it goes (a check's name with its value, a call's request) is sent to the app as it
is (an `update`), as its start and end are.

Rules: a child starts no earlier than its parent; an ended parent's children have ended; spans are
appended in start order.

## TurnEvent

What an endpoint reported, normalised ([research §11](research.md#11-one-event-model-for-every-provider)):

```ts
type TurnEvent =
  | { type: "thinking";    t: number; text: string; visibility: "full" | "summary" | "progress" | "omitted" | "redacted" }
  | { type: "text";        t: number; text: string }
  | { type: "tool_call";   t: number; id: string; name: string; args: unknown }
  | { type: "tool_result"; t: number; id: string; name: string; result: unknown; mocked?: boolean }
  | { type: "usage";       t: number; input?: number; output?: number; thinking?: number; cached?: number }
  | { type: "done";        t: number; finish?: string }
  | { type: "error";       t: number; message: string; status?: number };
```

`t` is milliseconds from the turn's request. Consecutive deltas of the same kind are merged into one
event when recorded, keeping the first `t` and the last arrival as the span's end.

## TurnRecord

| Field | Type | Notes |
|---|---|---|
| `test`, `repeat`, `row`, `index` | | Where it is |
| `row_name` | string? | A data row's name, when it has one ([Data file](#data-file)) |
| `user` | string | The message as sent (variables resolved, secrets redacted) |
| `user_template` | string \| ContentPart[] | The message as the test file had it (before variables), so a view can tell whether this record is still of the turn the file now has. Each check result likewise keeps its `check` as the file had it |
| `events` | TurnEvent[] | In order |
| `reply` | string | The text events joined |
| `thinking` | `{ text, visibility }[]` | |
| `request` | `{ url, method, headers, body }` | Redacted |
| `response` | `{ status, headers, body?, chunks? }` | Redacted; `body` parsed when JSON; `chunks` for streams, capped (see run-file.md) |
| `raw_blocks` | unknown[] | What the provider needs replayed (live history) |
| `variables` | `{ [var]: string }` | Extracted here (secret values redacted) |
| `results` | CheckResult[] | |
| `metrics` | Metrics | |

## CheckResult

| Field | Type | Notes |
|---|---|---|
| `check` | Check | As run (variables resolved) |
| `status` | `"pass"` \| `"fail"` \| `"unsure"` \| `"skipped"` \| `"error"` | |
| `reason` | string | Always set: why it passed, failed, was skipped, or errored |
| `actual` | unknown | The value checked (cut to 2 KB for display; the full value is in the turn) |
| `expected` | unknown | |
| `value` | number | Scored checks: the score, the noul, the similarity |
| `confidence` | number 0–1 | Judged checks only |
| `judge` | `{ kind, model, samples?, answers?, raw? }` | What the judge said |
| `usage`, `cost` | | The judge's |
| `ms` | number | Time the check took |

```
                ┌─► pass
pending ─► running ─┼─► fail
   │                ├─► unsure   (judged, its value passes, confidence below unsure_below)
   │                └─► error    (couldn't be decided: unreachable judge, invalid path, not JSON)
   └──────────────────► skipped  (its turn didn't run; thinking not returned and not required)
```

## Metrics

Every field is optional; only what applies is set and shown ([research §13](research.md#13-confidence-unsure-accuracy)).

| Field | Applies to | Meaning |
|---|---|---|
| `ms` | every span | Time taken |
| `ttft_ms` | turn, request | Time to the first byte of the reply |
| `first_thinking_ms`, `thinking_ms` | turn | When thinking started; how long it lasted |
| `first_answer_ms` | turn | Time to the first answer token |
| `tokens` | turn, judge call, run | `{ input, output, thinking?, cached? }` |
| `tokens_per_s` | turn | Output tokens per second while it generated. Output tokens count the thinking (Gemini's are apart, and added): with the thinking shown, all of them over the time from the first thinking or answer token to the last; with it hidden (counted, not shown), the answer's tokens (less the thinking's) over the answer's time |
| `cost` | turn, judge call, run | USD; absent (not 0) without a price |
| `checks` | turn, test, run | `{ passed, failed, unsure, skipped, error, total }` |
| `accuracy` | turn, test, row set | Passed ÷ run |
| `pass_rate` | test | Repeats passed ÷ repeats, with both counts |
| `confidence` | check, turn | The check's; for a turn, its lowest |
| `latency` | run, load | `{ p50, p95, p99, n }` for total and for ttft |
| `throughput` | load | Requests and tokens per second |
| `errors` | load, run | `{ count, rate, rate_limited }` |
| `client` | load | `{ cpu, event_loop_delay_p99, saturated }` |

## Comparison (baseline)

| Field | Notes |
|---|---|
| `baseline` | The baseline run's `_id`, file and date |
| `pass_rate`, `latency.p50`, `latency.p95`, `cost` | Each `{ run, baseline, change }` |
| `flipped` | Checks that went pass → fail or fail → pass, by test, turn and check name |
| `thresholds`, `regressed` | The thresholds used and which were crossed |

## Plugin

| Field | Notes |
|---|---|
| `kind` | `provider`, `check` or `judge` |
| `name`, `version` | Required; suites refer to `name` |
| `hosts` | Hosts a provider or judge plugin may call; the transport refuses others |
| entry points | See [provider.md](contracts/provider.md#code-plugins) and [checks.md](contracts/checks.md#plugins) |
