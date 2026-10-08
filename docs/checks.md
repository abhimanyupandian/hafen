# Checks and judges

A check looks at one part of a turn and says **pass**, **fail**, **unsure**, **skipped** or
**error**, always with a reason. Rule checks decide by rule. Judged checks ask a judge, and also
report a value and a confidence.

Checks go in a turn's `expect` list, or in a test's `expect_conversation` to check the whole
conversation:

```yaml
expect:
  - { type: status, equals: 200 }
  - { path: $.reply.order.id, equals: 4417 }
  - { contains: "refund", ignore_case: true }
  - { type: latency, max_ms: 3000, first_token_ms: 800 }
  - { type: systemone.noul, question: "Does the reply ask why they want a refund?", min: 0.8 }
```

## What a check looks at

`on` picks the input, and `path` (optional) picks a value inside it.

| `on` | The input | The default for |
|---|---|---|
| `reply` | The reply text | checks without a `path` |
| `response` | The parsed response body, or for streams the assembled response: `{ text, thinking, tool_calls, usage, last }` (`last` is the final chunk) | checks with a `path` |
| `thinking` | The thinking text, with its visibility | |
| `turn` | `{ user, reply, thinking, tool_calls, usage, metrics }` | |
| `events` | The events in order (for `sequence`) | |
| `tools` | The tool calls and results, in order | |
| `conversation` | Every turn so far: `[{ user, reply, thinking, tool_calls }]` | `expect_conversation` |

## Operators

Any check can use these on the value it selects. A `path` with an operator and no `type` is a path
check.

| Operator | Passes when |
|---|---|
| `equals: v` | The value equals `v` (deep equality for objects and arrays; numbers compare as numbers) |
| `not_equals: v` | It doesn't |
| `contains: v` | A string contains `v` (`ignore_case: true` to ignore case), or an array has an element equal to `v` |
| `not_contains: v` | It doesn't |
| `matches: re` | A string matches the regular expression (JavaScript syntax; flags as `/…/i`) |
| `exists: true \| false` | The path matched something / nothing |
| `type_is: t` | `string`, `number`, `integer`, `boolean`, `object`, `array` or `null` |
| `min_length`, `max_length` | A string's characters, or an array's items, are within limits. Characters as a reader counts them: an accented letter, an emoji (👋🏽) or a flag is one |
| `lt`, `lte`, `gt`, `gte` | Number comparisons (combine them for a range) |
| `schema: s` | The value validates against a JSON Schema (inline, or a file) |

When a path matches several values, the check passes if any passes, or with `all: true`, if every
one does. A path that matches nothing fails with "no match", except `exists: false`.

## Rule checks

| `type` | Needs | Also takes | Passes when |
|---|---|---|---|
| `path` | `path` and an operator | | The operator passes. Written without `type` |
| `status` | nothing (without an operator, `equals: 200`) | an operator (usually `equals`) | The HTTP status passes |
| `contains`, `not_contains`, `matches` | `value`, or the operator of its name | `ignore_case?` | The reply text passes. Shorthand: `{ contains: "4417" }` |
| `latency` | `max_ms` or `first_token_ms` (or both) | | Total time (and time to first token) are within limits |
| `length` | `min_length` or `max_length` (or both) | | The reply's length in characters (as `min_length` counts them) is within limits |
| `json` | nothing | `schema?` | The reply text parses as JSON (and validates) |
| `tokens` | `max_tokens` | `on?` | Output tokens (or thinking tokens, with `on: thinking`) are within the limit |
| `cost` | `max_cost` | | The turn's cost is within the limit. Needs a [price](providers.md#prices) |
| `thinking.present` | nothing | `required?` | Thinking was returned. Also written `{ on: thinking, type: present }` |
| `tool.called` | `tool` | `args?` (`{ <path>: value }`), `times?` | The tool was called (with those arguments, that many times) |
| `tool.not_called` | `tool` | | It wasn't |
| `tool.order` | `order: [names]` | `match?: exact \| in_order \| any_order` (default `in_order`) | The calls happened in that order. `exact`: exactly these; `in_order`: these in order, others allowed between; `any_order`: all present |
| `sequence` | `value: [kinds]` | | Events happened in this order. Kinds: `thinking`, `text`, `tool_call`, `tool_call:<name>`, `tool_result`; others between are ignored |

Rule checks have no confidence.

## Judged checks

### System One

[TypeSafe's](https://docs.typesafe.ai/introduction) primitives, asked of the selected input through
a System One judge: TypeSafe's hosted Jev by default, or a self-hosted endpoint serving the same
API. Each check is one atomic question. The checks on a turn that use the same judge are asked
together, in one request.

| `type` | Fields | Passes when | Value |
|---|---|---|---|
| `systemone.noul` | `question`, `min?` (default 0.5), `max?` | The truth value is within `min`–`max` | The truth value, 0–1 |
| `systemone.choice` | `question`, `options` (2 or more), `equals` (an option, or a list of acceptable ones) | The chosen option is acceptable | The chosen option's probability |
| `systemone.score` | `question`, `rubric?` (what each score means), `min?`, `max?` | The score is within `min`–`max` | The score |

Each needs its `question`, and a choice its `options` and `equals` too. Each takes `confidence?` as
well ([Confidence](#confidence)), or `unsure_below?` and `unsure?` ([Unsure](#unsure)).

The confidence is the API's own when it gives one. The full answer and the exact request are kept,
and the app shows both on the check and on the judge call's step.

Set the key in the app (Settings → System One). On the command line it's the secret `JEV_API_KEY`:
in the `--secret` file, or an environment variable.

### LLM judges

| `type` | Fields | Passes when | Value | Confidence |
|---|---|---|---|---|
| `judge` | `rubric` (one criterion or a list), `min?` (default 1: every criterion), `judge?`, `samples?` | Most samples pass. A sample passes when its share of criteria met reaches `min` | Criteria met ÷ criteria, averaged over samples | The share of samples that agree with the verdict |
| `reference` | `reference` (the expected answer), `min?` (default 0.8), `judge?` | The reply means the same as the reference | The similarity | As `judge` |

A `judge` check needs its `rubric` (one whose judge is a [plugin](plugins.md#check-and-judge-plugins) can
ask its `question` instead), and a `reference` check its `reference`. Both take `confidence?`
([Confidence](#confidence)), or `unsure_below?` and `unsure?` ([Unsure](#unsure)).

An LLM judge is asked, for each criterion, whether the input meets it and why. An answer that
doesn't parse is retried once, then the check is an error. The judge's tokens and cost are counted
on the check.

### Confidence

Any judged check (`systemone.noul`, `systemone.choice`, `systemone.score`, `judge`, `reference`)
can ask for a minimum confidence. With `confidence: 0.5`, the check passes only when its value
passes **and** the judge's confidence is above 0.5 (0.5 itself isn't). Otherwise it fails, and the
reason says both:

```yaml
expect:
  - { type: systemone.noul, question: "Does the reply ask why?", min: 0.8, confidence: 0.5 }
```

```
✗ noul 0.91: 0.91 within 0.8–1, but confidence 0.42 isn't above 0.5
✗ noul 0.12: 0.12 outside 0.8–1, and confidence 0.42 isn't above 0.5
```

The confidence a judge gives is the one in the tables above: System One's own (or, for a `noul`
without one, the value's distance from 0.5, doubled), and for an LLM judge the share of samples that
agree. A judge that gives none (a choice answered without a confidence or probabilities, or a judge
plugin that returns no `confidence`) makes the check an **error** saying so: it can't tell.

`confidence` is a number from 0 to just under 1. Anything else, or `confidence` on a rule check (a
`contains` check has no confidence), is a problem where it's written, before anything is sent.

### Unsure

A judged check whose value passes, but whose confidence is below `unsure_below` (from the check, the
test, or 0.6), is **unsure**. A value that misses (0.55 against `min: 0.8`, a wrong choice, a score
out of range, a rubric not met) **fails**, however low the confidence: low confidence never turns a
failing value into unsure.

How an unsure result counts is the `unsure` setting: `fail` (the default: it counts as failed, so the
test fails and the run exits `1`), `warn` (it counts as passed, and the test is reported as unsure: a
warning) or `pass` (it counts as passed, quietly). The most specific says it: the check's own
`unsure`, then the test's, then the suite's `defaults`; `--unsure` on the command line overrides them
all.

```yaml
expect:
  - { type: systemone.noul, question: "Does the reply ask why?", min: 0.5, unsure: warn }
```

A test that failed because a result was unsure says so, and how to let it pass:

```
✗ refunds › polite   0/1   0/1 checks   1.1 s
    turn 1 · noul 0.58: unsure: 0.58 within 0.5–1, but confidence 0.16 is below 0.6 (unsure counts as failed; --unsure warn to let it pass)
```

A check with `confidence` is never unsure: its own number decides pass or fail, and the test's
`unsure_below` and `unsure` don't apply to it. So a check takes one or the other: `confidence` with
`unsure_below` or `unsure` on one check is a problem before a run. The checks without `confidence`
are unsure as above.

### Judges

Declare judges in the suite, and name them in checks:

```yaml
judges:
  default:    { kind: systemone }                     # TypeSafe's hosted Jev; key: the secret JEV_API_KEY
  selfhosted: { kind: systemone, endpoint: "http://judge.internal:8080", api_key: "{{secret.JUDGE_KEY}}" }
  rubric:     { kind: llm, provider: claude-judge, samples: 3 }
```

`default` is used when a check names no judge. A judge is given exactly what the check selects,
never shortened; input longer than the judge accepts is an error that says so.

You can also write your own check or judge as a [plugin](plugins.md#check-and-judge-plugins). It gets
the check's fields and the chosen environment's values (`env`), never a secret.

## What a check needs

Each type needs the fields above: a `tool.called` check its `tool`, a `length` check a limit. Without
them it would look at nothing and pass (`{ type: tool.not_called }` with no `tool`: "undefined wasn't
called"). So a check that lacks one is a problem where it's written, before anything is sent
(`validate` and `run` exit `2`), naming the type and what it needs, and the key you most likely meant
when another one is in its place:

```
tests/support/refund.hafen.yml:8:13  a tool.not_called check needs tool (the tool's name): "name" is the check's own label (did you mean "tool"?)
tests/support/refund.hafen.yml:9:13  a length check needs min_length or max_length (a limit in characters)
tests/support/refund.hafen.yml:10:13  a tool.order check needs order (the tools' names, in order): "value" is for contains, not_contains, matches and sequence checks (did you mean "order"?)
```

A check turned off isn't looked at. One that runs anyway without what it needs is an error with
that reason, never a pass.

## Turning a check off

Any check takes `enabled` (default `true`). With `enabled: false`, it isn't looked at, and its result
is **skipped**: "turned off (enabled: false)". It doesn't fail its turn and isn't counted.

```yaml
expect:
  - { type: status, equals: 200 }
  - { type: systemone.noul, question: "Does it ask why?", min: 0.8, enabled: false }   # for now
```

In the app, untick a check's **on** box. Ticking it again removes the key, so the file is as it was.

## Skipped and error

| Result | When |
|---|---|
| **skipped** | It's turned off; its turn didn't run (an earlier check failed and `on_fail: stop`); or it checks thinking that wasn't returned and isn't `required` |
| **error** | The input isn't there or isn't the right kind (not JSON for a path, no status on a WebSocket); a regular expression or path is invalid; a judge was unreachable, timed out or answered something unusable; a value it needs wasn't reported (tokens, cost, a judge's confidence for a check with `confidence`); a field its type needs is missing ([a problem](#what-a-check-needs) before a run) |

Errors don't count as passed. A test with errors and no failures reports both, and fails the run.
