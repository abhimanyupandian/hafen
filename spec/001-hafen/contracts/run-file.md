# Contract: the run file

Every run, in the app or in CI, is recorded in one format of the project's own
([research §15](../research.md#15-the-run-file-a-format-of-the-projects-own)): a JSON document with
the run, every step as a span, every turn, every result and a summary. The app keeps runs in its
IndexedDB database (`hafen`, store `runs`) and exports them as `<_id>.hafen-run.json`;
the CLI writes the same file. Opening one in the app (Runs → open, or dropping it on the window)
adds it to the list.

## Top level

```jsonc
{
  "_id": "k3f9x2q8m1w7c4ta",
  "kind": "hafen-run",
  "version": 1,
  "mode": "test",                    // "test" | "explore" | "load"
  "started": 1791190931000,          // epoch ms
  "ended": 1791191003120,
  "ms": 72120,
  "status": "done",                  // running | done | error | stopped | interrupted
  "verdict": "failed",               // passed | failed | unsure | null (stopped: failed if a test failed before the stop, else null)
  "where": { "app": "cli", "version": "0.2.0", "os": "linux", "node": "22.11.0" },
  "suites": [{ "file": "tests/support/refund.hafen.yml", "name": "Support bot · refunds", "sha256": "…" }],
  "settings": { "env": "staging", "filters": { "tag": ["smoke"] }, "unsure": "warn", "network": null, "until_turn": null, "only_turn": null, "redact": ["headers", "secrets"] },
  "spans": [ … ],
  "turns": [ … ],
  "tests": [ … ],                    // each test's result: status, passed/total, its instances
  "summary": { … },
  "reviews": [],
  "baseline": null,
  "stopped": null,                   // why, when status is stopped ("the run's cost reached the limit ($2)")
  "error": null,                     // { message, file?, line?, column?, all: [every problem] } when status is error
  "fixtures": []                     // each provider fixture that ran: { name, phase, provider?, test?, status, ms, provides, calls, error? }
}
```

Readers ignore fields they don't know. A reader refuses a `version` higher than it knows, or a
different `kind`, saying so. A run file from before the app was Hafen (`kind: "hafen-eval-run"`,
`*.hafen-eval-run.json`) is the same format: it's read as a `hafen-run` (and written out again as
one).

## Spans

Every step, as a flat list in start order; `parent` makes the tree
([data-model.md](../data-model.md#span)):

```jsonc
{ "_id": "s1", "parent": null, "kind": "run", "name": "run", "start": 0, "end": 72120, "status": "ok" }
{ "_id": "s2", "parent": "s1", "kind": "test", "name": "refund for a broken item", "start": 3, "end": 4114, "status": "pass",
  "metrics": { "ms": 4111, "checks": { "passed": 6, "failed": 0, "unsure": 0, "skipped": 0, "error": 0, "total": 6 }, "accuracy": 1 } }
{ "_id": "s3", "parent": "s2", "kind": "turn", "name": "turn 1", "start": 3, "end": 2210, "status": "pass", "ref": { "turn": 0 },
  "metrics": { "ms": 2207, "ttft_ms": 620, "first_thinking_ms": 640, "thinking_ms": 1180, "first_answer_ms": 1840,
               "tokens": { "input": 412, "output": 96, "thinking": 210 }, "tokens_per_s": 48.2, "cost": 0.0041, "confidence": 0.82 } }
{ "_id": "s4", "parent": "s3", "kind": "request", "name": "POST /v1/chat", "start": 3, "end": 2190, "status": "ok" }
{ "_id": "s5", "parent": "s4", "kind": "thinking", "name": "thinking (summary)", "start": 643, "end": 1823, "status": "ok", "ref": { "turn": 0, "event": 0 } }
{ "_id": "s6", "parent": "s4", "kind": "tool_call", "name": "lookup_order", "start": 1830, "end": 1835, "status": "ok", "ref": { "turn": 0, "event": 1 } }
{ "_id": "s7", "parent": "s4", "kind": "answer", "name": "answer", "start": 1843, "end": 2188, "status": "ok", "ref": { "turn": 0, "event": 3 } }
{ "_id": "s8", "parent": "s3", "kind": "check", "name": "noul 0.91", "start": 2191, "end": 2209, "status": "pass", "ref": { "turn": 0, "check": 1 },
  "metrics": { "ms": 18, "confidence": 0.82 } }
{ "_id": "s9", "parent": "s8", "kind": "judge_call", "name": "systemone", "start": 2191, "end": 2208, "status": "ok", "metrics": { "tokens": { "input": 180, "output": 4 } } }
```

`start` and `end` are milliseconds from the run's `started`, from a monotonic clock. A span still
running has no `end`.

In turns, a streamed `text` or `thinking` event is the merged pieces: `t` is when the first arrived and
`t_end` when the last did. A streamed turn's `response` also has `assembled`: what `on: response`
paths read for it (`{ text, thinking, tool_calls, usage, last }`).

`settings.only_turn` is a turn's index when only that turn was sent (the app's "Run this turn only"):
the turns before it are in the run as they were carried (each record has `carried`: `"last run"`, its
record from the test's last run, or `"fixed reply"`), not sent; their results don't count to the
test's; each of its tests' records has `only_turn` too.

`settings.until_turn` is a turn's index when the run went up to that turn only (the app's "run up to
this turn"): each test ran its turns up to and including it, and no conversation checks; each of
its tests' records then has `until_turn` too. A run with no `filters` and no `until_turn` is a run
of its whole suites (the suite's view shows its latest).

Spans: a suite's has `ref: { suite }` and its status says how its tests went (`fail` if any failed or
errored, `pass` if any passed, `skipped` when stopped); a test's has `ref: { suite, test }` (the test's
id, or name).

## Turns

```jsonc
{
  "test": "t_8f2k1q9z", "repeat": 1, "row": null, "index": 0,
  "user": "Hi, I'm Priya. I want a refund for order 4417",
  "user_template": "Hi, I'm {{customer}}. I want a refund for order 4417",
  "events": [
    { "type": "thinking", "t": 640, "text": "The customer wants…", "visibility": "summary" },
    { "type": "tool_call", "t": 1827, "id": "c1", "name": "lookup_order", "args": { "order_id": 4417 } },
    { "type": "tool_result", "t": 1832, "id": "c1", "name": "lookup_order", "result": { "status": "delivered" } },
    { "type": "text", "t": 1840, "text": "I'm sorry it arrived broken. Could you tell me…" },
    { "type": "usage", "t": 2185, "input": 412, "output": 96, "thinking": 210 },
    { "type": "done", "t": 2187, "finish": "stop" }
  ],
  "reply": "I'm sorry it arrived broken. Could you tell me…",
  "thinking": [{ "text": "The customer wants…", "visibility": "summary" }],
  "request": { "url": "https://staging.acme.example/v1/chat", "method": "POST",
               "headers": { "Authorization": "[redacted]", "X-Client": "hafen" }, "body": { "…": "…" } },
  "response": { "status": 200, "headers": { "content-type": "text/event-stream" }, "chunks": ["…"], "chunks_total": 84 },
  "raw_blocks": [ ],
  "variables": { "session": "sess_29f…" },
  "results": [
    { "check": { "type": "status", "equals": 200 }, "status": "pass", "reason": "status 200", "actual": 200, "expected": 200, "ms": 0 },
    { "check": { "type": "systemone.noul", "question": "Does the reply ask why they want a refund?", "min": 0.8 },
      "status": "pass", "reason": "0.91 ≥ 0.8", "value": 0.91, "confidence": 0.82,
      "judge": { "kind": "systemone", "endpoint": "https://…", "model": "…", "raw": { "…": "…" } }, "usage": { "input": 180, "output": 4 }, "ms": 18 }
  ],
  "metrics": { "…": "as the turn's span" }
}
```

## Tests

```jsonc
{
  "suite": "tests/support/refund.hafen.yml", "id": "t_8f2k1q9z", "name": "refund for a broken item", "index": 0,
  "status": "passed",                // passed | failed | error | skipped | stopped (cut short by the run's stop before it had failed)
  "passed": 2, "total": 3, "accuracy": 0.667, "unsure": false,
  "settings": { "repeat": 3, "pass_rate": 0.67, "history": "live", "on_fail": "continue", "unsure": "warn" },
  "instances": [{ "repeat": 1, "row": null, "status": "passed", "turns": [0, 1], "results": [ … ], "conversation_results": [ … ] }]
}
```

`instances[].turns` are indexes into the run's `turns`.

## Summary

```jsonc
{
  "tests": { "passed": 2, "failed": 1, "unsure": 0, "error": 0, "skipped": 0, "total": 3 },
  "checks": { "passed": 410, "failed": 12, "unsure": 1, "skipped": 0, "error": 2, "total": 425 },
  "latency": { "total": { "p50": 1210, "p95": 2800, "p99": 3900, "n": 212 }, "ttft": { "p50": 540, "p95": 990, "p99": 1400, "n": 212 } },
  "tokens": { "input": 98234, "output": 20412, "thinking": 40210 },
  "cost": 0.23,                      // absent when any priced call had no price; never 0 for unknown
  "load": null                       // load runs: throughput, errors, client saturation
}
```

## Size

- A turn keeps its raw stream as `chunks`, at most 2,000 chunks or 5 MB, whichever comes first;
  past that it keeps the first and last 500 and records `chunks_total`. The events are always kept
  whole.
- A response body over 5 MB is kept cut to its first 5 MB, with `body_truncated: true`. (The checks
  ran on the whole body; only the record is cut.)
- Load runs keep every request's timings and status, but bodies only for errors and a sample of 20.

## Redaction

Applied before a span or turn is stored or written ([research §21](../research.md#21-redaction)):
secret headers become `"[redacted]"`; every resolved secret's value (4 characters or more) is
replaced with `"[redacted]"` wherever it appears (request, response, events, variables, reasons), as
it is and JSON-escaped, URL- or form-encoded, or in base64, and in a raw stream as the text its chunks
join into; the suite's `redact.patterns` replace matches with `"[email]"`, `"[card]"` (Luhn-valid,
starting 2–6), `"[phone]"` (7–15 digits after `+` or in groups; never an IP, a port, a date or hex). The run records which
rules applied (`settings.redact`).

## Reviews

```jsonc
{ "result": { "turn": 0, "check": 1 }, "agree": false, "by": "priya", "at": 1791191120000, "note": "it did ask why" }
```

Added in the app; kept with the run, and exported with it.
