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

| `type` | Fields | Passes when | Notes |
|---|---|---|---|
| `path` | `path`, an operator | The operator passes | Written without `type` |
| `status` | an operator (usually `equals`) | The HTTP status passes | WebSocket turns have none: error |
| `contains`, `not_contains`, `matches` | `value` or the operator | As the operator, on the reply text | Shorthand: `{ contains: "4417" }` |
| `latency` | `max_ms`, `first_token_ms?` | Total time (and time to first token) within limits | |
| `length` | `min_length`, `max_length` | The reply's length within limits | Characters |
| `json` | `schema?` | The reply text parses as JSON (and validates) | For endpoints that answer JSON in text |
| `tokens` | `max_tokens`, `on?` | Output tokens (or thinking tokens with `on: thinking`) within the limit | Error when not reported |
| `cost` | `max_cost` | The turn's cost within the limit | Error without a price |
| `thinking.present` | `required?` | Thinking was returned | Written `{ on: thinking, type: present }` too |
| `tool.called` | `tool`, `args?` (`{ <path>: value }`), `times?` | The tool was called (with matching arguments, that many times) | |
| `tool.not_called` | `tool` | It wasn't | |
| `tool.order` | `order: [names]`, `match: exact \| in_order \| any_order` | Calls happened in that order | `exact`: exactly these, in order; `in_order`: these in order, others allowed between; `any_order`: all present |
| `sequence` | `value: [kinds]` | The events happened in this order | Kinds: `thinking`, `text`, `tool_call`, `tool_call:<name>`, `tool_result`; others between are ignored |

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

The full answer (probabilities, legend, raw) is kept in the result's `judge.raw`. The request it was
asked with, all of it (`{ state, model, questions }`, the address, the headers, the key hidden), is on
the call's step (`judge_call`, its `request`: [data-model.md](../data-model.md#span)), from the moment
it's sent: the app shows it on the step and on each of the checks it asks for, during the run.

### LLM judge

| `type` | Fields | Passes when | Value | Confidence |
|---|---|---|---|---|
| `judge` | `rubric` (one criterion or a list), `min?` (default 1: all criteria), `judge?` (a named judge), `samples?` | Most samples pass: a sample passes when its share of criteria met reaches `min` (a tie fails) | Criteria met ÷ criteria, averaged over samples | The share of samples agreeing with the verdict |
| `reference` | `reference` (the expected answer), `min?` (default 0.8), `judge?` | The reply means the same as the reference, by the judge (or by embedding similarity when the judge is an embeddings provider) | The similarity | As `judge` (or none, for embeddings) |

An LLM judge is asked, for each criterion, whether the input meets it and why, in a fixed prompt
that asks for JSON; an answer that doesn't parse is retried once, then the check is an error. Its
tokens and cost are counted on the check.

### Unsure

A judged check whose confidence is below `unsure_below` (from the check, the test, or 0.6) is
`unsure`, whatever its value. How `unsure` counts is the test's `unsure` setting: `pass`, `warn`
(counts as passed, and is reported as a warning; the default) or `fail`.

### Judges

Declared in the suite and named by checks:

```yaml
judges:
  default:   { kind: systemone }                             # TypeSafe's hosted Jev; key from ${env:JEV_API_KEY}
  selfhosted: { kind: systemone, endpoint: "http://judge.internal:8080", api_key: "${env:JUDGE_KEY}" }
  rubric:    { kind: llm, provider: claude-judge, samples: 3 }
```

What a judge is given is exactly what the check selects, never shortened. Input longer than the
judge accepts is an error that says so.

## Turning a check off

Any check takes `enabled` (default `true`). With `enabled: false` it's turned off: it isn't looked
at (its variables aren't resolved, a judge it names isn't asked, a plugin isn't called) and its
result is `skipped`, reason `turned off (enabled: false)`. Skipped, it doesn't fail its turn or test,
and isn't counted in accuracy (as any skipped check). So that a check that won't run can't stop a
run, loading a suite doesn't check a turned-off check's variables, `{{scope.…}}`s, `${env:…}`s, paths
or judge, and the schema is all it must meet. The same holds for a test's `expect_conversation` and
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
| `error` | The input isn't there or isn't the right kind (not JSON for a path, no status on a WebSocket); a regular expression or path is invalid; a judge was unreachable, timed out or answered something unusable; a value it needs wasn't reported (tokens, cost) |

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
  async check({ value, turn, conversation, params, transport, signal }) {
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
  async judge({ input, question, params, transport, signal }) {
    const res = await transport.fetch({ url: "https://judge.acme.example/v1", method: "POST",
      headers: { authorization: { secret: "HOUSE_JUDGE_KEY", prefix: "Bearer " } }, body: { input, question }, signal });
    const { score, certainty, why } = await res.json();
    return { value: score, confidence: certainty, reason: why, usage: { input: 0, output: 0 } };
  },
};
```

A check plugin returns `{ status, reason, value?, confidence?, actual?, expected? }`; a judge
plugin `{ value, confidence?, reason, usage?, raw? }`, and the check that uses it (`type: judge`
with `judge: <name>` naming `{ kind: plugin, plugin: house }`) applies `min`, `max` and
`unsure_below`.

Suites use a check plugin by its name as the `type` (`{ type: polite }`): the folder's plugins
(`plugins/*.js`) need no naming in the suite's `plugins`. Plugins run in a worker and never see secret
values ([provider.md](provider.md#code-plugins)).
