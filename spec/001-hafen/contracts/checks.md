# Contract: checks and judges

A check looks at one part of a turn and says pass, fail, unsure, skipped or error, always with a
reason ([data-model.md](../data-model.md#checkresult)). Rule checks decide by rule; judged checks
ask a judge and also report a value and a confidence.

## What a check looks at

`on` picks the input; `path` (optional) picks a value inside it.

| `on` | The input | Default for |
|---|---|---|
| `reply` | The reply text (the text events joined) | checks without a `path` |
| `response` | The parsed response body (non-streaming JSON), or the assembled response for streams: `{ text, thinking, tool_calls, usage, last }` where `last` is the final chunk | checks with a `path` |
| `thinking` | The thinking text, with its visibility | |
| `turn` | `{ user, reply, thinking, tool_calls, usage, metrics }` | |
| `events` | The ordered events (for `sequence`) | |
| `tools` | The tool calls and results, in order | |
| `conversation` | Every turn so far: `[{ user, reply, thinking, tool_calls }]` (a path reaches into it: `$[*].reply`, `$[0].user`; a judge is given all of it) | a test's `expect_conversation` checks |

## Operators

Any check can use these on the value it selects. With a `path` and an operator and no `type`, the
check is a path check (the `type` is `path`).

| Operator | Passes when |
|---|---|
| `equals: v` | The value equals `v` (deep equality for objects and arrays; numbers compare as numbers) |
| `not_equals: v` | It doesn't |
| `contains: v` | A string contains `v` (with `ignore_case: true`, ignoring case); an array has an element equal to `v` |
| `not_contains: v` | It doesn't |
| `matches: re` | A string matches the regular expression (JavaScript syntax; flags with `/…/i`) |
| `exists: true \| false` | The path matched something / nothing |
| `type_is: t` | `string`, `number`, `integer`, `boolean`, `object`, `array` or `null` |
| `min_length`, `max_length` | A string's characters or an array's items within limits |
| `lt`, `lte`, `gt`, `gte` | Number comparisons (several may be combined: a range) |
| `schema: s` | The value validates against a JSON Schema (inline, or a file path) |

When a path matches several values, the check passes if any value passes, or with `all: true` if
every one does. A path that matches nothing fails with "no match" (except `exists: false`).

## Built-in rule checks

| `type` | Needs | Also takes | Passes when | Notes |
|---|---|---|---|---|
| `path` | `path` and an operator | | The operator passes | Written without `type` |
| `status` | nothing (no operator: `equals: 200`) | an operator (usually `equals`) | The HTTP status passes | WebSocket turns have none: error |
| `contains`, `not_contains`, `matches` | `value`, or the operator of its name | `ignore_case?` | As the operator, on the reply text | Shorthand: `{ contains: "4417" }` |
| `latency` | `max_ms` or `first_token_ms` (or both) | | Total time (and time to first token) within limits | |
| `length` | `min_length` or `max_length` (or both) | | The reply's length within limits | Characters |
| `json` | nothing | `schema?` | The reply text parses as JSON (and validates) | For endpoints that answer JSON in text |
| `tokens` | `max_tokens` | `on?` | Output tokens (or thinking tokens with `on: thinking`) within the limit | Error when not reported |
| `cost` | `max_cost` | | The turn's cost within the limit | Error without a price |
| `thinking.present` | nothing | `required?` | Thinking was returned | Written `{ on: thinking, type: present }` too |
| `tool.called` | `tool` | `args?` (`{ <path>: value }`), `times?` | The tool was called (with matching arguments, that many times) | |
| `tool.not_called` | `tool` | | It wasn't | |
| `tool.order` | `order: [names]` (one or more) | `match?: exact \| in_order \| any_order` (default `in_order`) | Calls happened in that order | `exact`: exactly these, in order; `in_order`: these in order, others allowed between; `any_order`: all present |
| `sequence` | `value: [kinds]` (a list of one or more) | | The events happened in this order | Kinds: `thinking`, `text`, `tool_call`, `tool_call:<name>`, `tool_result`; others between are ignored |

Rule checks have no confidence.

## Judged checks

### System One

TypeSafe's primitives ([docs](https://docs.typesafe.ai/introduction)), asked of the selected input
through a System One judge: an API endpoint (TypeSafe's hosted Jev by default, or a self-hosted
one serving the same API; [research §14](../research.md#14-system-one-judges-by-api-endpoint)).
Each check is one atomic question; the checks on a turn that use the same judge are asked together
in one request.

| `type` | Fields | Passes when | Value | Confidence |
|---|---|---|---|---|
| `systemone.noul` | `question`, `min?` (default 0.5), `max?` | The truth value is within `min`–`max` | The truth value (0–1) | The API's `confidence`, else the value's distance from 0.5, doubled |
| `systemone.choice` | `question`, `options` (2+), `equals` (an option, or a list of acceptable ones) | The chosen option is acceptable | The chosen option's probability | The API's `confidence`, else that probability |
| `systemone.score` | `question`, `rubric?` (what each score means), `min?`, `max?` | The score is within `min`–`max` | The score | The API's `confidence`, else the probability of that score |

Each needs its `question`; a choice its `options` and `equals` too. Each takes `confidence?`
([Confidence](#confidence)).

The full answer (probabilities, legend, raw) is kept in the result's `judge.raw`. The request it was
asked with, all of it (`{ state, model, questions }`, the address, the headers, the key hidden), is on
the call's step (`judge_call`, its `request`: [data-model.md](../data-model.md#span)), from the moment
it's sent: the app shows it on the step and on each of the checks it asks for, during the run.

### LLM judge

| `type` | Fields | Passes when | Value | Confidence |
|---|---|---|---|---|
| `judge` | `rubric` (one criterion or a list), `min?` (default 1: all criteria), `judge?` (a named judge), `samples?` | Most samples pass: a sample passes when its share of criteria met reaches `min` (a tie fails) | Criteria met ÷ criteria, averaged over samples | The share of samples agreeing with the verdict |
| `reference` | `reference` (the expected answer), `min?` (default 0.8), `judge?` | The reply means the same as the reference, by the judge (or by embedding similarity when the judge is an embeddings provider) | The similarity | As `judge` (or none, for embeddings) |

A `judge` check needs its `rubric` (one whose judge is a plugin's can ask its `question` instead); a
`reference` check its `reference`. Both take `confidence?` ([Confidence](#confidence)).

An LLM judge is asked, for each criterion, whether the input meets it and why, in a fixed prompt
that asks for JSON; an answer that doesn't parse is retried once, then the check is an error. Its
tokens and cost are counted on the check.

### Confidence

A judged check's `confidence` (a number, 0 ≤ it < 1: the schema's `exclusiveMaximum`, as above 1 is
never met) is the least confidence it passes with: the check is `pass` only when its value passes and
the judge's confidence (the table's Confidence column; a judge plugin's `confidence`) is strictly
greater than it. Otherwise it's `fail`, its reason the value's with the confidence added:
`0.91 within 0.8–1, but confidence 0.42 isn't above 0.5` (the value passed), `0.12 outside 0.5–1, and
confidence 0.42 isn't above 0.5` (it didn't; when the confidence is above, the value's reason alone).
A judge that gives no confidence (not a finite number: a choice answered without `confidence` or
`probabilities`, a judge plugin returning none) makes it `error`: `the judge gave no confidence, so
confidence: 0.5 can't be checked (<the value's reason>)`. The result keeps its `value`, `confidence`
(to the thousandth, as every judged result's) and `judge`.

Loading a suite makes each of these a problem at its line and column (nothing is sent): a
`confidence` that isn't a number in that range (the schema's); one on a built-in check that isn't
judged (`confidence is for judged checks (systemone.noul, systemone.choice, systemone.score, judge,
reference): a contains check has none`, at the key); and one with an `unsure_below` or `unsure` on
the same check (`a check with confidence passes or fails by it (it's never unsure), so its
unsure_below does nothing: take one of them out`, at `unsure_below`; the same of `unsure`, at
`unsure`). A check plugin's check takes what fields it wants: its `confidence` is its own (in
`params`).

### Unsure

A judged check whose value passes, but whose confidence is below `unsure_below` (from the check, the
test, or 0.6), is `unsure`, its reason the value's with the confidence added: `0.55 within 0.5–1, but
confidence 0.1 is below 0.6`. A value that misses its criterion (outside `min`–`max`, a choice not
acceptable, a rubric's verdict not met) is `fail`, whatever the confidence: low confidence never makes
a failing value `unsure`.

How `unsure` counts is the `unsure` setting, the most specific saying it: `--unsure` (over all), the
check's own `unsure`, the test's, the suite's `defaults`, Hafen's. `fail` (the default): it counts as
failed, so its turn, run or row, and the test (by its pass rate), fail, and the run exits 1; `warn`:
it counts as passed, and the test that passes with one is reported as unsure (the run's verdict
`unsure`, exit 0); `pass`: it counts as passed, quietly. The result keeps how it counted (`unsure:
"fail"`, run-file.md). One that counts as failed is said, wherever what went wrong is said (the
command line, JUnit, Markdown, JSON), as `<check>: unsure: <reason> (unsure counts as failed;
--unsure warn to let it pass)`; one that counted as passed, in JUnit's `<system-out>` and the
Markdown's Unsure section, as `<where> · unsure: <check>: <reason> (counted as passed: unsure is
warn)`.

A check with `confidence` is never `unsure`: its own number decides `pass` or `fail`, and the test's
(or the default) `unsure_below` and `unsure` don't apply to it. The checks without it are as above.

### Judges

Declared in the suite and named by checks:

```yaml
judges:
  default:   { kind: systemone }                             # TypeSafe's hosted Jev; key: the secret JEV_API_KEY
  selfhosted: { kind: systemone, endpoint: "http://judge.internal:8080", api_key: "{{secret.JUDGE_KEY}}" }
  rubric:    { kind: llm, provider: claude-judge, samples: 3 }
```

What a judge is given is exactly what the check selects, never shortened. Input longer than the
judge accepts is an error that says so.

## What a check needs

Each type needs what its table says (Needs; for judged checks, the fields without `?`): without it, a
check would look at nothing and pass (`{ type: tool.not_called }` with no `tool`: "undefined wasn't
called"; `{ type: length }` with no limit). A field is missing when it's left out, `null` or empty
(`""`, `[]`; an operator only when it's left out, as `equals: null` tests for null). Loading a suite
makes each check that lacks one (a turn's, the conversation's, a setup or teardown step's) a problem
at the check's line and column, so nothing is sent (`validate` and `run` exit `2`), naming the type
and what it needs, with what it is (`the tool's name`), and, when a key that's another's is in its
place, what that key is and the one meant:

```
refund.hafen.yml:8:13  a tool.not_called check needs tool (the tool's name): "name" is the check's own label (did you mean "tool"?)
refund.hafen.yml:9:13  a length check needs min_length or max_length (a limit in characters)
refund.hafen.yml:11:13  a sequence check needs value (a list of event kinds, in order): "order" is for tool.order checks (did you mean "value"?)
```

An unknown key that's the field misspelled (`tol:`) is said once, as that key (`unknown key "tol"
(did you mean "tool"?)`). A turned-off check isn't looked at. A run checks it again as each check
runs: one that lacks a field is `error` with the same reason (a judge isn't asked), never `pass`.

## Turning a check off

Any check takes `enabled` (default `true`). With `enabled: false` it's turned off: it isn't looked
at (its variables aren't resolved, a judge it names isn't asked, a plugin isn't called) and its
result is `skipped`, reason `turned off (enabled: false)`. Skipped, it doesn't fail its turn or test,
and isn't counted in accuracy (as any skipped check). So that a check that won't run can't stop a
run, loading a suite doesn't check a turned-off check's variables, `{{env.…}}`s, `{{secret.…}}`s (or
an old spelling, `{{scope.…}}` or `${env:…}`), paths or judge, and the schema is all it must meet. The same holds for a test's `expect_conversation` and
a setup or teardown step's `expect` (a step whose checks are all off goes by its status, as one with
none does).

```yaml
expect:
  - { type: status, equals: 200 }
  - { type: systemone.noul, question: "Does it ask why?", min: 0.8, enabled: false }   # for now
```

The app turns one off and on from its card (the turn's panel, or the check's): off writes
`enabled: false` on it; on again takes the key away, so the file is as it was.

## Skipped and error

| Result | When |
|---|---|
| `skipped` | It's turned off (`enabled: false`; reason: "turned off (enabled: false)"); its turn didn't run (an earlier check failed and `on_fail: stop`); it checks thinking that was `omitted` or `redacted` and isn't `required` (reason: "thinking not returned") |
| `error` | The input isn't there or isn't the right kind (not JSON for a path, no status on a WebSocket); a regular expression or path is invalid; a judge was unreachable, timed out or answered something unusable; a value it needs wasn't reported (tokens, cost, a judge's confidence for a check with `confidence`); a field its type needs is missing ([a problem](#what-a-check-needs) before a run) |

Errors don't count as passed. A test with errors and no failures reports both.

## Plugins

A check or judge plugin is an ES module whose default export is:

```js
// plugins/polite.js
export default {
  kind: "check",
  name: "polite",
  version: "1.0.0",
  // params: the check's fields from the suite. value: what on/path selected.
  async check({ value, turn, conversation, params, env, transport, signal }) {
    const rude = /\b(stupid|idiot)\b/i.test(String(value));
    return { status: rude ? "fail" : "pass", reason: rude ? "found an insult" : "no insults" };
  },
};
```

```js
// plugins/house-judge.js
export default {
  kind: "judge",
  name: "house",
  version: "2.1.0",
  hosts: ["judge.acme.example"],
  async judge({ input, question, params, env, transport, signal }) {
    const res = await transport.fetch({ url: "https://judge.acme.example/v1", method: "POST",
      headers: { authorization: "Bearer {{secret.HOUSE_JUDGE_KEY}}" }, body: { input, question }, signal });
    const { score, certainty, why } = await res.json();
    return { value: score, confidence: certainty, reason: why, usage: { input: 0, output: 0 } };
  },
};
```

A check plugin returns `{ status, reason, value?, confidence?, actual?, expected? }`; a judge
plugin `{ value, confidence?, reason, usage?, raw? }`, and the check that uses it (`type: judge`
with `judge: <name>` naming `{ kind: plugin, plugin: house }`) applies `min`, `max`, `confidence`,
`unsure_below` and `unsure`.

A check plugin's `check` gets `{ value, turn, conversation, params, env }` and a judge plugin's
`judge` gets `{ input, question, params, env }`, each with `transport` and `signal`: `env` is the
chosen environment's values (the values passed, over the suite's `environments.<name>`), never a
secret. A request's `{{secret.NAME}}` is filled in by the engine as it leaves
([provider.md](provider.md#code-plugins)).

Suites use a check plugin by its name as the `type` (`{ type: polite }`): the folder's plugins
(`plugins/*.js`) need no naming in the suite's `plugins`. Plugins run in a worker and never see secret
values; the worker has no `fetch` of its own, only `transport.fetch`, to the plugin's `hosts`
([provider.md](provider.md#code-plugins)). Plugins are trusted code, not sandboxed.
