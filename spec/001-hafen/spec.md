# Feature Specification: Hafen — end-to-end tests for chat endpoints

**Feature Branch**: `001-hafen`

**Created**: 2026-10-05

**Status**: Draft

**Input**: User description: "A standalone, Postman-like tool for evaluating chat responses, with
hafen's UI design:
send chat requests to any provider (plain API requests, streaming or not); show replies as chat
boxes instead of JSON; validate replies with System One (TypeSafe's Jev); add rubrics for
validation like ADK's criteria; support LLM-as-judge; validate thinking events; parse responses with
JSONPath from the UI to make assertions; multi-turn tests (message → response: validations →
message → response: validations); metrics for every step and event (time taken, accuracy,
confidence, whichever apply) and a Gantt chart of every event; tests saved as JSON or YAML that run
directly as CI tests; plugins for providers, cheap assertions and judges. The UI stays exactly like
hafen's: a tree of features on the left, details on the right, the chat in the centre. Default to
the desktop app and CI; support the browser too. Include the gaps found in review: data-driven
tests, setup and auth steps, tool-call checks, baselines, redaction, performance testing,
network and user simulations, metric charts, reference answers, WebSockets and attachments,
prices, human review."

## User Scenarios & Testing *(mandatory)*

The people this is for test chat features end to end, the way users meet them: QA and test
engineers who already use API tools like Postman, and developers who ship chat endpoints. Most
won't write code to write a test. The endpoint is a black box: what it reports (its response, or
its stream) is what's tested.

### User Story 1 - Talk to any chat endpoint and see the reply as chat (Priority: P1)

A tester describes an endpoint once (its address, headers, the request body with the message in
it, and where the reply is in the response) and sends it messages. Replies appear as chat, live as
they stream in, or all at once from an endpoint that doesn't stream. Thinking and tool calls the
endpoint reports show in the reply, in the order they happened. Every reply shows how long it took
and the tokens used, and the raw request and response are a click away.

**Why this priority**: Everything else builds on sending a message and seeing what came back. On
its own it already replaces reading raw JSON in an API client.

**Independent Test**: Configure a provider for a local mock endpoint (streaming and not), send two
messages, and check that each reply shows as chat with its timings, and that the second request
carried the conversation so far.

**Acceptance Scenarios**:

1. **Given** a provider for a streaming endpoint, **When** the tester sends "hello", **Then** the
   reply appears in a chat bubble as it arrives, and the turn shows time to first token, total
   time and token counts (when the endpoint reports them).
2. **Given** a provider for an endpoint that answers with one JSON object whose reply text is at
   `$.data.reply`, **When** the tester sends a message, **Then** the bubble shows that text, and the
   full JSON is shown in the details panel.
3. **Given** an endpoint that reports thinking and a tool call before its answer, **When** the
   reply arrives, **Then** the bubble shows the thinking (collapsed, with its length in time), the
   tool call, then the answer, in that order.
4. **Given** an endpoint that fails (an error status, a timeout, a cut-off stream, a body that isn't
   what the provider expects), **When** the tester sends a message, **Then** the bubble says what
   went wrong, the raw response is shown, and the tester can send again.
5. **Given** a conversation in progress, **When** the tester sends the next message, **Then** the
   request carries the conversation the way the provider says: the whole history, or the session
   id the endpoint returned earlier.

---

### User Story 2 - Turn a conversation into a multi-turn test with checks (Priority: P1)

The tester saves a conversation as a test: each message they sent becomes a turn. They add checks
to each turn, mostly by clicking a field in the response (its JSONPath is filled in) and choosing
what it should be; or by picking a ready-made check (status, text contains, matches, latency,
length, schema). They run the test and see a pass or fail tag for each check under each reply, and
the test's result.

**Why this priority**: This is the product: a conversation, with checks on every reply, that can be
run again. It's the step from exploring to testing.

**Independent Test**: Against the mock endpoint, save a two-turn conversation as a test, add a
JSONPath check by clicking a field and a text check, run it, and see one pass and one fail where
expected.

**Acceptance Scenarios**:

1. **Given** a two-turn conversation, **When** the tester saves it as a test, **Then** a test with
   those two messages appears in the Suites tree, and the suite's file on disk contains it.
2. **Given** a response shown as a JSON tree, **When** the tester clicks `order.id` and chooses
   "equals" `4417`, **Then** that turn gets a check on `$.reply.order.id` equal to `4417`.
3. **Given** a test with checks, **When** the tester runs it, **Then** each reply shows a tag per
   check (pass, fail, unsure, skipped or error), and the test shows its result with counts
   (`passed 5/6`).
4. **Given** a check fails on turn 1, **When** the test is set to continue on failure, **Then** turn
   2 still runs; **when** it's set to stop, turn 2 is marked skipped.
5. **Given** turn 1 extracts `session` from `$.session_id`, **When** turn 2 runs, **Then** its
   request uses that value.
6. **Given** a test set to repeat 3 times with a pass rate of 0.67, **When** 2 of the 3 runs pass,
   **Then** the test passes and shows `2/3`.

---

### User Story 3 - Run the same tests in CI (Priority: P1)

The tests are files in the team's repository: the file the app saves is the test. A command-line
runner runs those files unchanged in CI, exits with a code that says whether tests failed or the
setup was broken, and writes reports CI systems show. A failed CI run's record opens in the app,
showing the same chat, checks and timeline.

**Why this priority**: Tests that only run by hand don't catch regressions. Running in CI is what
makes the tool part of a team's process.

**Independent Test**: Run a suite saved by the app with the command-line runner against the mock
endpoint; check the exit code, the JUnit report, and that the run file opens in the app with the
same results.

**Acceptance Scenarios**:

1. **Given** a suite file saved by the app, **When** the CI runner runs it against the same
   responses, **Then** every rule-based check gives the same result as in the app.
2. **Given** a failing check, **When** the runner finishes, **Then** it exits with the "tests
   failed" code, and the JUnit report names the test, the turn, the check and why it failed.
3. **Given** a missing environment variable or an invalid file, **When** the runner starts, **Then**
   it exits with the "setup error" code and names the file, the line and the variable, without
   sending any request.
4. **Given** the runner's `validate` command, **When** it runs on a folder of suites, **Then** it
   checks every file against the schema and sends nothing.
5. **Given** the run file a CI run wrote, **When** it's opened in the app, **Then** the app shows
   that run's conversation, check results and timeline.
6. **Given** a spending limit, **When** the run's cost reaches it, **Then** the runner stops,
   marks what didn't run as skipped, writes its reports, and exits with the "stopped early" code.

---

### User Story 4 - Judge replies with System One and LLM judges, with confidence (Priority: P1)

Some checks need judgement: "does the reply ask why they want a refund?". The tester adds System
One questions (choice, score or noul, through a System One API: TypeSafe's hosted Jev, or a
self-hosted endpoint serving the same API), or an LLM judge with a rubric of criteria, as in ADK. Judged results show
their value and how confident the judge was. A pass the judge wasn't sure about shows as "unsure",
not as a plain pass.

**Why this priority**: Rule checks can't test what a reply means. Confidence is what sets this tool
apart from pass/fail judges.

**Independent Test**: Add a noul check and a rubric judge to a turn, run against the mock endpoint
with a mock judge, and see the value, the confidence, and an "unsure" result when the confidence is
low.

**Acceptance Scenarios**:

1. **Given** a noul check "Does the reply ask why they want a refund?" with a minimum of 0.8,
   **When** the judge answers 0.91, **Then** the check passes, showing 0.91 and System One's
   confidence.
2. **Given** a judged check whose confidence is below the test's "unsure" threshold, **When** it
   runs, **Then** its tag shows "unsure" in the waiting colour, and CI treats it as the suite's
   unsure policy says (a warning by default).
3. **Given** an LLM judge with a rubric and 3 samples, **When** it runs, **Then** the result shows
   how many samples agreed (as confidence), the judge's reasons, and the tokens and cost it took.
4. **Given** a judge that can't be reached or answers nonsense, **When** the check runs, **Then**
   its result is "error", not "fail", and the report names the judge.
5. **Given** a check that targets `$.data.summary`, **When** it's judged, **Then** the judge sees
   only that value.

---

### User Story 5 - See every step on a timeline, with its metrics (Priority: P2)

Every step of a run is recorded with when it started and how long it took: the request, the first
byte, thinking, each tool call, the answer, each check and judge call, retries and errors. A
timeline (a Gantt chart) shows them all, grouped by turn. Metrics show wherever they apply: time
taken everywhere; accuracy where checks or rows are counted; confidence where judges answered.

**Why this priority**: It explains slow or failing turns at a glance, but tests are useful without
it.

**Independent Test**: Run a three-turn test with thinking and a tool call against the mock
endpoint, open the timeline, and check that every step is a bar at the right time, and that
clicking one selects it in the chat and the panel.

**Acceptance Scenarios**:

1. **Given** a finished run, **When** the tester opens the timeline, **Then** every step appears as
   a bar starting at its start time and as long as it took, grouped by turn and indented under the
   step it's part of.
2. **Given** the timeline, **When** the tester clicks a bar, **Then** the chat scrolls to that step
   and highlights it, and the panel shows its details and metrics; clicking a step in the chat
   highlights its bar.
3. **Given** a run in progress, **When** the tester watches the timeline, **Then** bars grow as the
   steps go on.
4. **Given** a turn, **When** it's selected, **Then** its metrics show: time to first token,
   thinking time, time to the first answer token, total time, tokens in, out and thinking, tokens
   per second, checks passed out of total, and the lowest confidence among its checks.

---

### User Story 6 - Check the model's thinking (Priority: P2)

For models that think before answering, checks can look at the thinking: that it happened, what it
considered, how long it was, that nothing private leaked into it, that the answer follows from it,
and that it came before a tool call. Thinking that the provider hides or only summarises is labelled
as such, and checks on hidden thinking are skipped rather than failed.

**Why this priority**: Reasoning models are common and their thinking matters, but most checks are
on the answer.

**Independent Test**: Against mock endpoints that return full thinking, a summary, and none,
run a test with thinking checks, and see them pass, pass on the summary, and skip.

**Acceptance Scenarios**:

1. **Given** a check that the reasoning considered the refund window, **When** the thinking says
   so, **Then** the check passes.
2. **Given** a provider that hides thinking, **When** a thinking check runs, **Then** it's skipped
   with the reason "thinking not returned", unless the check is marked required, in which case it
   fails.
3. **Given** a check that thinking stays under 4,000 tokens, **When** the provider reports 5,200
   thinking tokens, **Then** it fails, showing both numbers.
4. **Given** a check that the events go thinking → tool call → answer, **When** the endpoint
   answered before calling the tool, **Then** it fails, showing the order that happened.
5. **Given** a model that writes `<think>…</think>` in its text, **When** the reply arrives,
   **Then** the thinking is separated from the answer, even when a tag is split across two chunks.

---

### User Story 7 - Data-driven tests, setup steps and variables (Priority: P2)

A test runs once per row of a data file (CSV or JSON lines), with the row's values in its messages
and checks; its accuracy is the share of rows that passed. Tests can start with setup steps (a
login that returns a token, a request that creates a session) and end with teardown steps that run
even when the test fails. Named environments (local, staging) hold variables.

**Why this priority**: QA teams expect data files and logins from their API tools; without them,
real endpoints are hard to test. The core loop works without them.

**Independent Test**: Run a test with a 5-row data file and a login setup step against the mock
endpoint, and check that each row ran with its values and the token, and that the result shows
accuracy over 5 rows.

**Acceptance Scenarios**:

1. **Given** a data file of 200 rows, **When** the test runs, **Then** it runs once per row and
   reports accuracy as rows passed out of 200, with each row's result.
2. **Given** a setup step that extracts `token` from a login response, **When** the turns run,
   **Then** their requests use that token.
3. **Given** a test that fails, **When** it ends, **Then** its teardown steps still run.
4. **Given** two environments, **When** the tester switches from local to staging (or CI passes
   `--env staging`), **Then** the same test runs against staging's variables.

---

### User Story 8 - Check tool calls (Priority: P2)

Checks can look at the tools the endpoint reports calling: which were called, in what order
(exactly, in order, or in any order), and with what arguments. When the thing under test is a model
API that expects the caller to run its tools, the test supplies the tools' results.

**Why this priority**: Agents are tested by what they do, not only by what they say.

**Independent Test**: Against a mock endpoint that calls two tools, check order and arguments; then
against a mock model API that asks for a tool, supply a result and check the final answer uses it.

**Acceptance Scenarios**:

1. **Given** a check that `lookup_order` was called with `order_id` 4417, **When** it was called
   with 4418, **Then** the check fails, showing both values.
2. **Given** a check that tools ran in order `[lookup_order, issue_refund]`, **When** they ran in
   the other order, **Then** it fails; with "any order", it passes.
3. **Given** a model API that asks the caller to run `get_weather`, **When** the test supplies a
   result for it, **Then** the runner sends it back and the turn continues to the final answer.

---

### User Story 9 - Catch regressions against a baseline, and see trends (Priority: P2)

A run can be compared with a baseline (the last run on the main branch, or a run the tester picks):
pass rate, latency (p50, p95), cost, and which checks flipped. CI can fail when a run is worse than
its baseline by more than a set amount. Charts show pass rate, latency and cost across runs.

**Why this priority**: Fixed thresholds miss slow decline; teams want to know "did this change make
it worse".

**Independent Test**: Run the same suite twice with the mock endpoint made slower the second time;
compare, and see the latency increase reported and CI failing on a 20% threshold.

**Acceptance Scenarios**:

1. **Given** a run and a baseline, **When** they're compared, **Then** the comparison shows pass
   rate, p50 and p95 latency, and cost for each, their change, and the checks that went from pass
   to fail or back.
2. **Given** a regression threshold of 10 percentage points on pass rate, **When** the pass rate
   falls from 94% to 81%, **Then** the CI runner exits with the "tests failed" code and says why.
3. **Given** 10 runs of a suite, **When** the tester opens its history, **Then** charts show pass
   rate, latency and cost over those runs.

---

### User Story 10 - Extend it with plugins (Priority: P2)

Teams add what isn't built in: providers for endpoints the configuration can't describe, checks
for their own rules, judges for their own models. A plugin works the same in the app and in CI.
Plugins never see raw secrets.

**Why this priority**: No built-in set covers every endpoint and rule. The configuration-only
provider covers most cases first.

**Independent Test**: Add a check plugin and a provider plugin from the repository, run a suite
that uses them in the app and in CI, and get the same results; check that the plugin couldn't read
an API key.

**Acceptance Scenarios**:

1. **Given** a check plugin in the repository, **When** a suite uses it, **Then** it appears with
   the built-in checks in the app and runs the same in CI.
2. **Given** a suite that names a plugin that isn't installed, **When** it runs in CI, **Then** the
   runner exits with the "setup error" code and names the plugin.
3. **Given** a provider plugin, **When** it makes a request, **Then** credentials are added for it,
   and it has no way to read their values.

---

### User Story 11 - Measure performance under load (Priority: P3)

The tester sends many requests at once (a number at a time, for a time or a count, ramping up) and
sees latency percentiles (p50, p95, p99) for total time and time to first token, tokens per second,
throughput, the error rate and how many requests were rate-limited, each with how many requests it
is based on.

**Why this priority**: Important before launch and for capacity, but separate from correctness.

**Independent Test**: Run a load test of 200 requests at 20 at a time against the mock endpoint
with a set delay, and check the percentiles match the delay and the sample count is shown.

**Acceptance Scenarios**:

1. **Given** a load test of 200 requests at 20 at a time, **When** it ends, **Then** it shows p50,
   p95 and p99 for total time and time to first token, tokens per second, requests per second,
   errors, rate-limited requests, and "of 200 requests".
2. **Given** a load test on a priced provider, **When** the tester starts it, **Then** the app shows
   the estimated cost and asks to confirm; in CI it needs an explicit flag.
3. **Given** the tester's machine can't keep up (its processor is saturated), **When** the test
   runs, **Then** the results say so, since the numbers would be the machine's, not the endpoint's.

---

### User Story 12 - Simulate networks and users (Priority: P3)

The tester sees how things behave under constraints: a slow or unreliable network (added delay,
limited bandwidth, dropped connections) for any endpoint; and a simulated user, where a model plays
the user from a scenario until a stop condition, with checks on every turn.

**Why this priority**: Valuable for streaming experiences and for finding unscripted paths, but not
needed to start testing.

**Independent Test**: Run the same test with 300ms of added delay and see time to first token rise
by about 300ms; run a simulated-user scenario for up to 5 turns and see checks on each.

**Acceptance Scenarios**:

1. **Given** a network profile adding 300ms, **When** a test runs, **Then** each request's time to
   first token rises by about 300ms, in the app and in CI alike.
2. **Given** a scenario "a customer whose parcel arrived broken wants a refund" with a stop
   condition "a refund is offered" and at most 6 turns, **When** it runs, **Then** a model plays the
   customer, the conversation stops when a refund is offered or after 6 turns, and every turn's
   checks run.

---

### User Story 13 - Use it in a browser (Priority: P3)

Without the desktop app, the same app works in a browser for endpoints that let a web page call
them, or through the project's own relay (`hafen serve`), which the tester runs. When a
browser blocks a call, the app says so and what to do.

**Why this priority**: The desktop app and CI are the defaults; the browser is a convenience.

**Independent Test**: Open the browser build, run a test against an endpoint that allows page
calls, then against one that doesn't, with and without the relay.

**Acceptance Scenarios**:

1. **Given** an endpoint that allows calls from web pages, **When** a test runs in the browser,
   **Then** it runs as in the desktop app.
2. **Given** an endpoint that doesn't, **When** a test runs, **Then** the turn's error says the
   browser blocked the call, and suggests the desktop app or a relay.
3. **Given** the relay running and allowing that endpoint, **When** the test runs again,
   **Then** it goes through the relay and runs.

---

### Edge Cases

- **Streams:** a stream cut off midway (the turn is an error, keeping what arrived); an SSE stream
  with no end marker (it ends when the connection closes); a JSON line or event split across
  chunks; a `<think>` tag split across chunks; very long replies (the view stays responsive).
- **Responses:** a success status with an error in the body; a body that isn't JSON when a path
  check expects JSON (the check is an error: "response isn't JSON"); text that isn't UTF-8; empty
  replies.
- **Paths:** a JSONPath that matches nothing (fails "no match", while `exists: false` passes); one
  that matches several values (operators apply to any match unless the check says all).
- **Network:** rate limiting with `retry-after` (waits, retries, records each retry); timeouts;
  redirects; an endpoint that's down (an error, not a failure).
- **Judges:** unreachable, slow, or answering something unusable (error); input longer than the
  judge accepts (error "too long", never cut short).
- **Repeats:** some repeats error while others pass (errors count as not passing, and are reported
  separately).
- **Files:** a suite edited outside the app while open (the app reloads it; if the app has unsaved
  changes too, it asks which to keep); comments and unknown keys (kept, with a warning for unknown
  keys); a file from a newer version (refused, saying so); two runs of the same file at once.
- **Variables and secrets:** a variable used but never set (setup error before anything is sent); a
  secret value that appears in a response (redacted in saved runs and reports).
- **Stopping:** the tester stops a run (status stopped, what ran is kept); the app closes mid-run
  (status interrupted when next opened); CI cancels the job (partial reports written).
- **Thinking replay:** a provider that requires earlier thinking blocks to be sent back unchanged
  (kept exactly as received in live mode; never mixed into pinned turns).
- **Scale:** a run of 50 turns with thinking and tools (the chat and timeline stay usable); a data
  file of 10,000 rows (results page through).

## Requirements *(mandatory)*

### Functional Requirements

**Providers and requests**

- **FR-001**: Users MUST be able to define a provider by configuration alone: address, method,
  headers, request body template with variables, response kind (one JSON object, SSE stream,
  newline-delimited JSON stream, or WebSocket), and the paths to the reply text, thinking, tool
  calls, token usage and session id.
- **FR-002**: The system MUST include ready-made providers for OpenAI-compatible chat APIs,
  OpenAI's Responses API, Anthropic's Messages API and Google's Gemini API.
- **FR-003**: The system MUST carry a conversation to the endpoint as its provider says: the whole
  message history, or a session id or cookie taken from earlier responses.
- **FR-004**: In live history mode the system MUST send back, unchanged, any parts of earlier
  replies the provider requires (such as signed or encrypted thinking blocks).
- **FR-005**: The system MUST record each turn's request (with secrets redacted) and raw response.
- **FR-006**: The system MUST time out a turn after a configurable time (120 seconds by default) and
  retry rate-limited and server errors with backoff, honouring `retry-after`, up to a configurable
  number of times (2 by default), recording each retry.
- **FR-007**: Users MUST be able to attach files and images to a turn, for providers whose
  configuration says how to send them.

**Chat view**

- **FR-010**: The system MUST show each turn as chat: the user's message, then the reply with its
  thinking (collapsed), its tool calls, and its answer, in the order they happened, live while
  streaming.
- **FR-011**: Each reply MUST show a metrics line: time to first token, total time, tokens in, out
  and thinking (when reported), tokens per second, and cost (when priced).
- **FR-012**: Users MUST be able to send messages to a provider to explore it, and save the
  conversation as a test.
- **FR-013**: Users MUST be able to see each turn's request and response, with JSON shown as a tree
  they can browse.

**Tests and checks**

- **FR-020**: A test MUST be an ordered list of turns (a message, optional extractions, checks),
  with optional setup and teardown steps, conversation-level checks, and settings: repeat count,
  pass rate, history mode, stop on failure, unsure policy and timeout.
- **FR-021**: Users MUST be able to add a check by clicking a field in a response, with its path
  filled in, and choosing an operator: equals, doesn't equal, contains, doesn't contain, matches a
  pattern, exists, is of type, length within limits, number comparisons, or matches a JSON Schema.
- **FR-022**: Every check MUST accept an optional path selecting the value it checks; without one,
  it checks the reply text.
- **FR-023**: Paths MUST follow JSONPath as standardised in RFC 9535. When a path matches several
  values, operators MUST pass if any value passes, unless the check asks for all.
- **FR-024**: The system MUST include rule checks for: response status, latency (total and to first
  token), reply length, text contains or matches, JSON Schema, token counts, and cost.
- **FR-025**: Every check result MUST be one of pass, fail, unsure, skipped or error, with a reason,
  and with a value and confidence where the check produces them.
- **FR-026**: Users MUST be able to extract values from a response into variables that later turns
  and steps use.
- **FR-027**: The system MUST support two history modes: live (each turn sees the endpoint's actual
  earlier replies) and pinned (earlier replies are fixed in the test).
- **FR-028**: The system MUST repeat a test a set number of times and pass it when the share of
  passing repeats reaches its pass rate, showing the count (`2/3`).
- **FR-029**: Users MUST be able to compare a reply with a reference answer by meaning, using a
  judge or embedding similarity with a threshold.

**Judges**

- **FR-035**: The system MUST support System One checks (choice, score and noul) through any System
  One API endpoint (TypeSafe's hosted Jev, or a self-hosted one), with an expected answer or
  threshold, and report the answer with its probabilities or confidence.
- **FR-036**: The system MUST support LLM-as-judge checks with a rubric of one or more criteria,
  using any configured provider, sampling a set number of times, and report how many samples agreed
  as the confidence.
- **FR-037**: A judged check whose confidence is below its unsure threshold MUST be "unsure", not
  pass or fail.
- **FR-038**: A judge MUST see exactly what the check selects (the reply, a path's value, the
  thinking, or the whole conversation) and MUST NOT shorten it; input over the judge's limit is an
  error saying it's too long.
- **FR-039**: A judge that can't be reached or gives an unusable answer MUST produce an error result,
  distinct from a failed check.
- **FR-040**: Users MUST be able to mark a judged result as agreeing or not with their own
  judgement, and see each judge's agreement with those marks.

**Thinking**

- **FR-045**: The system MUST capture thinking however a provider reports it (separate fields or
  blocks, summaries, or tags in the text) and record its visibility: full, summary, progress notes,
  omitted or redacted.
- **FR-046**: Checks MUST be able to target the thinking, the answer, the whole turn, or the ordered
  list of events.
- **FR-047**: A check on thinking that was omitted or redacted MUST be skipped, unless the check is
  marked required, in which case it fails.
- **FR-048**: When a test checks thinking and a provider returns readable thinking only on request,
  the provider MUST request it.
- **FR-049**: The system MUST measure time to first thinking token, thinking duration, and thinking
  tokens where the provider reports them.

**Tools**

- **FR-050**: The system MUST record the tool calls and results an endpoint reports, in order.
- **FR-051**: Users MUST be able to check that a tool was or wasn't called, the order of calls
  (exact, in order, any order), and arguments by path.
- **FR-052**: Users MUST be able to supply tool results in a test, which the runner sends back to a
  model API that expects the caller to run its tools.

**Metrics and timeline**

- **FR-055**: The system MUST record every step of a run with its start, end, status, the step it's
  part of, and its metrics: turns, requests, first byte, thinking, tool calls and results, answers,
  checks, judge calls, retries, errors, and setup and teardown steps. Times are measured from the
  run's start on a clock that can't go backwards.
- **FR-056**: The system MUST report time taken for every step; accuracy (checks passed out of
  checks run) for turns and tests, and pass rate across repeats and data rows; and confidence for
  judged checks, with each turn showing its lowest.
- **FR-057**: The system MUST show a timeline of all steps as bars on a time axis, grouped by turn,
  growing live while running, zoomable and pannable, and linked both ways to the chat and the
  details panel.
- **FR-059**: Each run MUST have a summary: tests passed, checks passed, p50 and p95 latency, tokens,
  cost and duration.

**Files and CI**

- **FR-060**: Suites MUST be stored as YAML or JSON files following one published schema. The app
  MUST read and write those files directly; in a browser it opens and downloads them.
- **FR-061**: Saving from the app MUST keep a file's comments, key order and formatting.
- **FR-062**: Suite and provider files MUST reference secrets (`${env:NAME}`) and never contain
  them; the app keeps secret values in the system's keychain (desktop) or a git-ignored local file.
- **FR-063**: A command-line runner MUST run suites (files and folders, filtered by name or tag) and
  validate them without sending anything, with options for reports, environment, repeats,
  concurrency, unsure policy, spending limit, stopping at the first failure, and a baseline.
- **FR-064**: The runner MUST exit 0 when everything passed, 1 when tests failed, 2 on a setup or
  configuration error, and 3 when it stopped early (spending limit or cancelled).
- **FR-065**: The runner MUST write a JUnit XML report, a run file, a Markdown summary and a JSON
  summary, as asked.
- **FR-066**: A run file MUST open in the app, showing the run's conversation, checks and timeline.
- **FR-067**: The app MUST offer the command that runs the open suite or test in CI, ready to copy.
- **FR-068**: Files MUST state their schema version; the runner and app MUST refuse a newer major
  version with a setup error that says so.
- **FR-069**: When cancelled, the runner MUST write its reports for what ran, with the run marked
  stopped.

**Data, setup and environments**

- **FR-070**: A test MUST be able to run once per row of a CSV or JSON-lines file, using the row's
  values, reporting each row's result and accuracy across rows.
- **FR-071**: Tests MUST be able to have setup and teardown steps (HTTP requests with extractions);
  teardown MUST run even when the test fails.
- **FR-072**: Users MUST be able to define named environments of variables and pick one in the app
  or on the command line.

**Baselines and history**

- **FR-075**: The system MUST keep a history of runs: in the app's storage, and as run files in a
  folder for CI.
- **FR-076**: Users MUST be able to compare a run with a baseline (pass rate, p50 and p95 latency,
  cost, flipped checks), and CI MUST be able to fail on a regression beyond set thresholds.
- **FR-077**: The system MUST chart pass rate, latency and cost across a suite's runs.

**Plugins**

- **FR-080**: The system MUST support provider, check and judge plugins: providers described by
  configuration files, and code plugins with a documented interface. A plugin MUST behave the same
  in the app and in CI.
- **FR-081**: Code plugins MUST NOT receive secret values; they make requests through a transport
  that adds credentials.
- **FR-082**: Plugins MUST declare a name and version; a suite that names one that isn't available
  MUST fail with a setup error.

**Performance**

- **FR-090**: Users MUST be able to run a load test (concurrency, a duration or request count, ramp
  up) and see p50, p95 and p99 for total time and time to first token, tokens per second,
  throughput, error rate and rate-limited requests, each with its sample count.
- **FR-091**: Starting a load test MUST ask for confirmation in the app (with the estimated cost when
  priced) and an explicit flag in CI.
- **FR-092**: Load tests MUST NOT run inside a browser page, and MUST warn when the machine running
  them is saturated.

**Simulation**

- **FR-095**: Users MUST be able to simulate network conditions (added delay, bandwidth limit,
  dropped connections) for any provider, the same in the app and CI.
- **FR-097**: Users MUST be able to run a simulated user: a configured model plays the user from a
  scenario until a stop condition or a turn limit, with checks on every turn and at the end.

**Browser**

- **FR-100**: In a browser, the system MUST run tests against endpoints that allow web pages to call
  them, or through the project's relay; when a call is blocked, it MUST say so and suggest
  the desktop app or a relay.

**Privacy and cost**

- **FR-105**: Run files and reports MUST be redacted before they're saved: authorization headers,
  known secret values, and, when enabled, personal-data patterns.
- **FR-106**: The relay MUST only relay to endpoints on its allowlist, and only for its own pages.
- **FR-107**: Users MUST be able to set prices per model; cost MUST show as unknown when there's no
  price, never as zero.

**UI**

- **FR-110**: The app's UI MUST be built only from the design system (`spec/design/`) and look and
  behave exactly as it describes; anything new is added to the design system before it's used.
- **FR-111**: The app MUST have the tree of suites, runs, providers and checks in the sidebar, the
  conversation in the centre, details in the panel on the right, and the timeline and console at
  the bottom.
- **FR-112**: Every control MUST have an id and an accessible name, and the app's address MUST
  reopen what was open.
- **FR-113**: The app MUST support the light and dark themes, small screens (sidebar as a drawer)
  and the desktop window, as the design system describes.

### Key Entities

- **Suite**: a file of tests, with shared defaults, variables and the provider they use.
- **Test**: an ordered list of turns with its settings, setup and teardown, and conversation checks;
  optionally a data file it runs once per row of.
- **Turn**: one user message, what to extract from the response, the checks on the reply, and
  optionally tool results to supply or a fixed reply (pinned history).
- **Check**: a rule or a judgement on part of a turn (reply, a path's value, thinking, events,
  tools), with what makes it pass.
- **Judge**: what answers a judged check: a System One source or an LLM with a rubric.
- **Provider**: how to talk to one endpoint: request shape, response shape, history, thinking,
  prices.
- **Environment**: a named set of variables; secrets are referenced, not stored.
- **Data file**: rows of values a test runs once per row.
- **Run**: one execution of suites, tests or a load test: its settings, every step, every result and
  its summary.
- **Step**: one timed part of a run (a request, thinking, a tool call, a check…), part of a turn or
  of another step.
- **Event**: what an endpoint reported, normalised: thinking, text, tool call, tool result, usage,
  done.
- **Check result**: pass, fail, unsure, skipped or error, with a reason, value and confidence.
- **Baseline comparison**: a run set against another, with the differences that matter.
- **Plugin**: a provider, check or judge someone added, with its name and version.
- **Price**: what a model costs per token in and out.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A tester who knows an endpoint's address and response shape can go from nothing to a
  saved two-turn test with three checks in under 10 minutes, without writing code.
- **SC-002**: On a reference suite of 50 tests run against recorded responses, rule-based check
  results agree 100% between the app and the CI runner.
- **SC-003**: Across a set of seeded mistakes, every configuration error ends in the "setup error"
  exit, and every failing check in the "tests failed" exit; none is confused for the other.
- **SC-004**: Every step of a run appears on the timeline within 5ms of its recorded start and
  duration, and a 50-turn run's timeline appears in under 1 second.
- **SC-005**: A run file from CI, opened in the app, shows the same check results, conversation and
  step count as the CI report.
- **SC-006**: Against an endpoint that answers correctly 90% of the time, a suite using repeats and
  pass rates gives the same verdict in at least 9 of 10 CI runs.
- **SC-007**: Scanning every saved run file and report from the reference suite for the secrets it
  used finds none.
- **SC-008**: Every rule of the app's copied design-system stylesheets is identical to hafen's, its gallery of
  components matches its baseline screenshots with no differences, and the app's styles use no colour,
  size or font outside the design tokens.
- **SC-009**: A load test reports p50, p95 and p99 with their sample count, and at 50 requests at a
  time the runner adds less than 5ms to the median.
- **SC-010**: After 50 judged results are marked by a person, the app shows each judge's agreement
  with those marks.

## Assumptions

- Hafen is a standalone project: its own desktop app, command-line runner and browser build,
  sharing no code, storage, settings or data with any other app. Its UI follows hafen's design
  system exactly.
- The first users are QA and test engineers and developers who ship chat features; they know API
  tools but may not write code.
- The desktop app and CI are the default environments; the browser is supported with the limits
  browsers impose on calls to other sites.
- Endpoints are black boxes: only what they report can be tested. Teams that own an endpoint can
  make it report more (its own step events), which a provider can map.
- System One checks need a System One API endpoint and key: TypeSafe's hosted Jev, or a
  self-hosted endpoint serving the same API. In CI, it must be reachable from the runner.
- No judge model is bundled: LLM judges use whichever provider the suite names.
- Suites live in the team's repository; in the desktop app the tester opens that folder.
- "Unsure" results warn in CI by default; a suite or the command line can make them pass or fail.
- Prices are entered by the user; without them, cost shows as unknown.
- Load tests are only run against endpoints the tester may load, and cost money; the tool asks
  before starting one.
- Out of scope for this feature: sharing suites and results between team members through a service,
  scheduled runs against production, ready-made safety test packs, and turning production logs
  into tests. These come later.
