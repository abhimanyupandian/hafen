---

description: "Tasks for Hafen: end-to-end tests for chat endpoints"
---

# Tasks: Hafen — end-to-end tests for chat endpoints

**Input**: Design documents from `spec/001-hafen/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md),
[data-model.md](data-model.md), [contracts/](contracts/), and the design system in
[spec/design/](../design/README.md)

**Tests**: Included. The constitution (principle VI) requires contract tests before the code they
cover, and visual tests of the design system before any UI work.

**Organization**: by user story, in priority order. Each story can be built and checked on its
own once the foundation is in place.

**Status (2026-10-05)**: the MVP (Phases 1–6: US1–US4) is built and tested, with most of US5–US9 and
parts of US12–US13 and Phase 16. Open: reloading suites edited outside the app (T054), the app/CLI
agreement suite (T066), the timeline's speed test (T079), plugins (US10), load tests (US11), simulated
users (T098, T100), the browser's blocked-call test (T101's second half), reference, WebSocket and
attachment tests (T104–T106), human review (T107), accessibility and overhead tests (T109, T112), and
the quickstart's remaining fixture suites (T114).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on unfinished tasks)
- **[Story]**: the user story it belongs to (US1 … US13)
- Paths are from the repository's root; everything is under `evals/`

---

## Phase 1: Setup

**Purpose**: the project, its tooling, and the references that keep the UI exact

- [x] T001 Create the project: evals/package.json (React, Vite, Electron, `yaml`, `ajv`, the JSONPath library after T007; Playwright and electron-builder as devDependencies; scripts `dev`, `build`, `app`, `app:build`, `test` (`node --test tests/engine tests/cli`), `test:browser`, `test:visual`), evals/vite.config.js, evals/README.md, evals/.gitignore
- [x] T002 [P] Create evals/tests/{engine,cli,browser,visual}/ and evals/tests/fixtures/{suites,streams,plugins}/, with evals/tests/README.md saying what each holds and how to run it
- [x] T003 [P] Add evals/playwright.config.js: start the Vite dev server and the mock endpoint (port 8791)
- [x] T004 Add the design parity test: every rule the copied stylesheets keep is hafen's, the logo byte for byte, and every frame rule they share with the same declarations (research §28), in evals/tests/engine/design-parity.test.js
- [x] T005 Copy the design system into the project as spec/design/README.md lists (tokens.css, components.css, the frame rules as frame.css, the panel, facts, palette and details rules; the generic components and lib helpers), changing only the storage prefix (`eval.`), the logo and the sidebar head's controls, into evals/app/css/ and evals/app/js/design/ and evals/app/js/lib/; build evals/app/gallery.html showing every component; add evals/tests/visual/gallery.spec.js comparing it, in both themes, with its baseline screenshots
- [x] T006 [P] Add a test that nothing under evals/ imports from outside evals/ (evals/tests/engine/standalone.test.js)
- [x] T007 [P] Run the JSONPath Compliance Test Suite against candidate libraries in evals/tests/engine/jsonpath-compliance.test.js; record the choice (or the decision to write our own) in research.md §9

---

## Phase 2: Foundational (blocks every story)

**Purpose**: the engine's core, the hosts it runs in, and the app's frame

**⚠️ CRITICAL**: no user story work starts until this phase is done

- [x] T008 Start the mock endpoint with `json`, `sse` and `ndjson` scenarios, a request log, and `?ms=` delays in evals/tests/fixtures/mock-endpoint.mjs
- [x] T009 [P] Copy the schemas into evals/engine/files/schema/ and add evals/tests/engine/schema-sync.test.js, which fails if they differ from spec/001-hafen/contracts/
- [x] T010 [P] Write schema contract tests (valid and invalid suites and providers) in evals/tests/engine/suite-schema.test.js
- [x] T011 Parse and validate suite and provider files (YAML and JSON, Ajv, errors with file, line and column) in evals/engine/files/suite-file.js
- [x] T012 [P] Write tests, then implement variables (`{{…}}`, `${env:…}`, the resolution order, typed whole-value substitution, missing names as setup errors) in evals/tests/engine/vars.test.js and evals/engine/vars.js
- [x] T013 [P] Write tests, then wrap JSONPath with any/all semantics and "no match" in evals/tests/engine/jsonpath.test.js and evals/engine/jsonpath.js
- [x] T014 [P] Write tests, then implement the transport interface, timeouts, abort, and retries with backoff and `retry-after` in evals/tests/engine/transport.test.js and evals/engine/transport.js
- [x] T015 [P] Write tests (events and lines split across chunks; no done marker; dropped connection), then implement SSE and NDJSON parsing in evals/tests/engine/stream.test.js, evals/engine/stream/sse.js and ndjson.js
- [x] T016 Implement TurnEvents, delta merging and the assembled response in evals/engine/events.js
- [x] T017 Write tests (parent and child rules, monotonic times, percentiles), then implement the span recorder in evals/tests/engine/spans.test.js and evals/engine/spans.js
- [x] T018 [P] Write tests, then implement redaction (headers, every resolved `${env:…}` value, optional patterns) in evals/tests/engine/redact.test.js and evals/engine/redact.js
- [x] T019 Write tests, then implement the run file reader and writer (`kind`, `version`, sizes and caps per contracts/run-file.md) in evals/tests/engine/run-file.test.js and evals/engine/reports/run-file.js
- [x] T020 Implement the engine's entry (`run`, `explore`, `validate`, emitting events through a host: transport, files, secrets, clock) and a minimal turn loop in evals/engine/index.js and runner.js
- [x] T021 [P] Add the icons `suite`, `test`, `check`, `provider`, `timeline`, `run` (spec/design/components.md, Additions) to evals/app/js/design/icons.jsx; review them at 14, 16 and 18px in both themes; add them to the gallery
- [x] T022 Build the app's frame: evals/app/index.html, evals/app/js/main.jsx (sidebar with the environment picker, empty sections, the work area with top bar, thread, message box and panel, the console), evals/app/css/eval.css; the runs database (IndexedDB `hafen`) in evals/app/js/lib/idb.js
- [x] T023 Build the hosts: a Web Worker host in evals/app/js/host.js; the desktop app in evals/desktop/ (main.js: the window without a title bar, the utility process from engine-host.js, a `MessageChannelMain` port to the UI through preload.cjs, opening, reading, writing and watching folders, secrets with `safeStorage`; builder.json)
- [x] T024 Add the CLI's skeleton (arguments, a Node host: `fetch` transport, files, environment; exit codes) in evals/cli/hafen.js, with evals/tests/cli/exit-codes.test.js written first

**Checkpoint**: the engine runs a turn against the mock endpoint in Node, in a Worker and in the desktop app's utility process; the app shows its empty frame; the gallery matches the references

---

## Phase 3: User Story 1 - Talk to any chat endpoint and see the reply as chat (Priority: P1) 🎯 MVP

**Goal**: configure a provider, send messages, see replies as chat, live or not, with thinking, tools and timings

**Independent Test**: quickstart §1

### Tests for User Story 1 ⚠️

> Write these first and see them fail

- [x] T025 [P] [US1] Contract tests for the `http` provider (one JSON reply, SSE, NDJSON, error bodies, a cut stream, `session` and `messages` history, pinned history as plain text) in evals/tests/engine/provider-http.test.js
- [x] T026 [P] [US1] Contract tests for the presets against recorded streams (openai-chat with `reasoning_content`, openai-responses, anthropic-messages with thinking blocks and replay, gemini with thoughts) in evals/tests/engine/presets.test.js and evals/tests/fixtures/streams/
- [x] T027 [P] [US1] Tests for `<think>` tags split across chunks in evals/tests/engine/think-tags.test.js

### Implementation for User Story 1

- [x] T028 [US1] Add mock scenarios `thinking/full|summary|omitted|tags`, `tools`, `session`, `error/500`, `cut`, `slow` in evals/tests/fixtures/mock-endpoint.mjs
- [x] T029 [US1] Implement the configured provider (request templating, history modes, response maps, stream event rules, think tags, asking for thinking) in evals/engine/providers/http.js
- [x] T030 [P] [US1] Implement the tag splitter in evals/engine/stream/think-tags.js
- [x] T031 [P] [US1] Implement the presets in evals/engine/providers/presets/ (openai-chat.js, openai-responses.js, anthropic-messages.js, gemini.js), checking each mapping against the API's current docs (research §11)
- [x] T032 [US1] Implement explore mode in the engine (send a turn, stream events, record spans, keep raw blocks for replay, record the explore run) in evals/engine/index.js
- [x] T033 [P] [US1] Build the JSON tree (spec/design/components.md, JSON tree) in evals/app/js/design/json-tree.jsx with its rules in evals/app/css/components.css; add it to the gallery
- [x] T034 [US1] Build the thread with reply parts (thinking disclosure, tool lines, text, stats line, error turns) in evals/app/js/views/thread.jsx, with the reply-part rules in evals/app/css/components.css
- [x] T035 [US1] Build the message box (explore: Send and Stop) in evals/app/js/views/composer.jsx
- [x] T036 [US1] Add the top bar's provider badge and status in evals/app/js/main.jsx
- [x] T037 [US1] Build the Providers section and the Provider view (form, edit as YAML, Try it) in evals/app/js/views/providers.jsx and evals/app/js/views/panel.jsx
- [x] T038 [US1] Build the Conversation view (provider, history, facts, the request and response) in evals/app/js/views/panel.jsx
- [x] T039 [US1] End-to-end test of quickstart §1 in evals/tests/browser/explore.spec.js
- [x] T040 [US1] Document the app and providers in evals/README.md

**Checkpoint**: a tester can describe an endpoint and chat with it, live or not, and see what came back

---

## Phase 4: User Story 2 - Turn a conversation into a multi-turn test with checks (Priority: P1)

**Goal**: save as test, add checks (by clicking a field, or from the palette), run, see results per turn

**Independent Test**: quickstart §2

### Tests for User Story 2 ⚠️

- [x] T041 [P] [US2] Contract tests for rule checks (path operators with any and all, status, text, latency, length, JSON, schema; "no match"; errors for non-JSON) in evals/tests/engine/checks-rules.test.js
- [x] T042 [P] [US2] Round-trip tests for saving (comments, key order, flow maps and quoting kept; adding a check is a one-line diff) in evals/tests/engine/suite-save.test.js
- [x] T043 [P] [US2] Runner tests (turns in order; extractions reach later turns; `on_fail`; repeat and pass rate counts; conversation checks; live and pinned history) in evals/tests/engine/runner.test.js

### Implementation for User Story 2

- [x] T044 [P] [US2] Implement rule checks in evals/engine/checks/ (path.js, text.js, status.js, latency.js, json.js)
- [x] T045 [US2] Implement the runner (tests, repeats, pass rate, extractions, `on_fail`, history modes, `expect_conversation`, stopping) in evals/engine/runner.js
- [x] T046 [US2] Implement saving with comment-keeping edits (add a test, turn or check; change fields; assign `t_` ids) in evals/engine/files/suite-file.js
- [x] T047 [P] [US2] Build the check badge (spec/design/components.md, Check badge) in evals/app/js/design/check-badge.jsx with its rules in evals/app/css/components.css; add it to the gallery
- [x] T048 [US2] Build the Suites section (tree, open folder or file) in evals/app/js/views/suites.jsx
- [x] T049 [US2] Build the Suite, Test, Turn and Check views and the JSON tree's Add check form in evals/app/js/views/panel.jsx
- [x] T050 [US2] Build the Checks section (palette cards) in evals/app/js/views/palette.jsx
- [x] T051 [US2] Implement Save as test (turns from the conversation, suggested checks) in evals/app/js/views/panel.jsx and evals/engine/files/suite-file.js
- [x] T052 [US2] Show test mode in the thread (badges not yet run, results after a run, the selected-message marker) and the message box's Add turn in evals/app/js/views/thread.jsx and composer.jsx
- [x] T053 [US2] Run and stop tests from the panel; results into the tree and thread; `html[data-running]`; in evals/app/js/state.js
- [ ] T054 [US2] Reload suites edited outside the app, asking which to keep when both changed, in evals/desktop/main.js and evals/app/js/state.js
- [x] T055 [US2] End-to-end test of quickstart §2 in evals/tests/browser/test-mode.spec.js

**Checkpoint**: a conversation becomes a saved, runnable multi-turn test with checks on every reply

---

## Phase 5: User Story 3 - Run the same tests in CI (Priority: P1)

**Goal**: the CLI runs suite files unchanged, with exit codes, reports and run files the app opens

**Independent Test**: quickstart §3

### Tests for User Story 3 ⚠️

- [x] T056 [P] [US3] CLI contract tests (run, validate, report; exit 0, 1, 2 and 3; a missing variable exits 2 with no requests; a newer `version` exits 2; SIGTERM writes partial reports and exits 3) in evals/tests/cli/run.test.js and evals/tests/cli/validate.test.js
- [x] T057 [P] [US3] Report tests (JUnit against its schema; Markdown; JSON) in evals/tests/cli/reports.test.js

### Implementation for User Story 3

- [x] T058 [US3] Implement `run` (finding suites, filters, environments, variables, concurrency, unsure, bail, timeout; the per-test lines and summary) in evals/cli/hafen.js
- [x] T059 [US3] Implement `validate` and `--env-check` with file, line and column messages in evals/cli/hafen.js
- [x] T060 [P] [US3] Implement reports in evals/engine/reports/ (junit.js, markdown.js, json.js), and `GITHUB_STEP_SUMMARY`
- [x] T061 [US3] Implement `--max-cost` and cancellation (exit 3, partial reports) in evals/engine/runner.js and evals/cli/hafen.js
- [x] T062 [US3] Build the Runs section, the Run view (facts, repeat and row pickers, tests, export JSON, run again) and read-only run mode in evals/app/js/views/runs.jsx, panel.jsx and thread.jsx
- [x] T063 [US3] Write runs to `<folder>/.hafen/runs/` with a `.gitignore` in evals/desktop/engine-host.js
- [x] T064 [US3] Add Copy CI command to the Suite and Test views in evals/app/js/views/panel.jsx
- [x] T065 [US3] Build the settings modal's panes (Storage → Runs, App → Appearance) in evals/app/js/views/settings.js
- [ ] T066 [US3] Check app and CLI agreement on a 50-test reference suite (SC-002) in evals/tests/cli/compare-app-cli.mjs and evals/tests/fixtures/suites/reference-50.hafen.yml
- [x] T067 [US3] Document the CLI, exit codes and the GitHub Actions example in evals/README.md

**Checkpoint**: P1 stories 1–3 work: explore, test, and run in CI

---

## Phase 6: User Story 4 - Judge replies with System One and LLM judges, with confidence (Priority: P1)

**Goal**: System One and rubric judges, with values, confidence and "unsure"

**Independent Test**: quickstart §4

### Tests for User Story 4 ⚠️

- [x] T068 [P] [US4] Add mock System One (`/systemone`, `/v1/models`) and LLM judge (`/judge`) endpoints, with controllable answers and confidence, in evals/tests/fixtures/mock-endpoint.mjs
- [x] T069 [P] [US4] Judge contract tests (noul, choice and score thresholds and confidence fallbacks; batching a turn's questions; unsure; rubric and sample agreement; an unparseable answer retried once then an error; unreachable and too-long inputs as errors; path-selected input) in evals/tests/engine/judges.test.js

### Implementation for User Story 4

- [x] T070 [US4] Implement the System One judge (endpoint, key, model; one request per turn and judge; confidence fallbacks), checking the API against TypeSafe's current docs (research §14), in evals/engine/judges/systemone.js
- [x] T071 [P] [US4] Implement the LLM judge (rubric prompt, JSON answers, samples, agreement, tokens and cost) in evals/engine/judges/llm.js
- [x] T072 [US4] Implement named judges and their defaults in evals/engine/judges/index.js
- [x] T073 [US4] Apply the unsure policy in the runner, reports and CLI summary in evals/engine/runner.js and evals/engine/reports/
- [x] T074 [US4] Show judged fields and the last result with the judge's answer in the Check view in evals/app/js/views/panel.jsx

**Checkpoint**: the MVP (all P1 stories) is complete

---

## Phase 7: User Story 5 - See every step on a timeline, with its metrics (Priority: P2)

**Independent Test**: quickstart §5

- [x] T075 [P] [US5] Metrics tests (time to first token, thinking, first answer, tokens/s, accuracy, lowest confidence, the span tree) in evals/tests/engine/metrics.test.js
- [x] T076 [US5] Compute metrics for spans, turns, tests and runs in evals/engine/spans.js
- [x] T077 [US5] Build the timeline dock (the console's frame, axis, rows, bars by status, durations, live growth, now line, drawing only rows in view, zoom, pan, fit, remembered height and label width) in evals/app/js/design/timeline.jsx with its rules in evals/app/css/components.css; add it to the gallery
- [x] T078 [US5] Link selection between the timeline, thread and panel, and build the Step view, in evals/app/js/state.js, views/thread.jsx and views/panel.jsx
- [ ] T079 [US5] Test bar placement within 5ms and a 50-turn draw under 1s (SC-004) in evals/tests/browser/timeline.spec.js

---

## Phase 8: User Story 6 - Check the model's thinking (Priority: P2)

**Independent Test**: quickstart §6

- [x] T080 [P] [US6] Tests (visibility labels; skipped or failed when required; thinking token limits; sequence order) in evals/tests/engine/thinking.test.js
- [x] T081 [US6] Implement `on: thinking | turn | events`, `thinking.present`, `tokens` on thinking, and `sequence` in evals/engine/checks/thinking.js and sequence.js
- [x] T082 [US6] Ask for readable thinking only when a test checks it, in evals/engine/providers/presets/ and providers/http.js
- [x] T083 [US6] Label thinking's visibility in the thread and the Turn view in evals/app/js/views/thread.jsx and panel.jsx

---

## Phase 9: User Story 7 - Data-driven tests, setup steps and variables (Priority: P2)

**Independent Test**: quickstart §7

- [x] T084 [P] [US7] Tests (CSV and JSON lines; rows and row accuracy; setup extractions; teardown always runs; environments) in evals/tests/engine/data-setup.test.js
- [x] T085 [US7] Implement data files, rows, setup and teardown steps, and environments in evals/engine/files/data.js and runner.js
- [x] T086 [US7] Add the row picker, data test sizes in the tree, and paging for 10,000 rows in evals/app/js/views/panel.jsx and suites.jsx
- [x] T087 [US7] Add the Connection → Secrets pane (`safeStorage` in the desktop app, localStorage in the browser build, said plainly) in evals/app/js/views/settings.js and evals/desktop/main.js

---

## Phase 10: User Story 8 - Check tool calls (Priority: P2)

**Independent Test**: quickstart §8

- [x] T088 [P] [US8] Tests (`tool.called` with arguments and times, `tool.not_called`, `tool.order` exact, in order and any order; mocked results round trip against `tools/ask`) in evals/tests/engine/tools.test.js
- [x] T089 [US8] Implement tool checks and tool mocks (send results back and continue the turn) in evals/engine/checks/tools.js, runner.js and the presets

---

## Phase 11: User Story 9 - Catch regressions against a baseline, and see trends (Priority: P2)

**Independent Test**: quickstart §9

- [x] T090 [P] [US9] Tests (comparison numbers, flipped checks, thresholds exit 1) in evals/tests/engine/compare.test.js and evals/tests/cli/compare.test.js
- [x] T091 [US9] Implement comparison, `compare`, `--baseline` and `--fail-on` in evals/engine/compare.js and evals/cli/hafen.js
- [x] T092 [US9] Build Compare with in the Run view, and the History charts in the Test view, in evals/app/js/views/panel.jsx and evals/app/js/design/chart.jsx (add the chart to the gallery)

---

## Phase 12: User Story 10 - Extend it with plugins (Priority: P2)

**Independent Test**: quickstart §10

- [ ] T093 [P] [US10] Tests (loading by path and package, version ranges, missing plugin exits 2, the worker bridge, secrets by name only, the hosts allowlist) in evals/tests/engine/plugins.test.js with plugins in evals/tests/fixtures/plugins/
- [ ] T094 [US10] Implement plugin loading and the worker bridge (Web Worker, `worker_threads`) with transports that add credentials by name in evals/engine/plugins.js
- [ ] T095 [US10] List plugin checks in the Checks section and plugin providers in Providers in evals/app/js/views/palette.jsx and providers.jsx

---

## Phase 13: User Story 11 - Measure performance under load (Priority: P3)

**Independent Test**: quickstart §11

- [ ] T096 [P] [US11] Tests (percentiles with `n`, concurrency and ramp, rate-limit counts, the saturation flag, refused in a browser) in evals/tests/engine/load.test.js
- [ ] T097 [US11] Implement load mode, `--load`, the app's confirmation with a cost estimate, and the load run view in evals/engine/load.js, evals/cli/hafen.js and evals/app/js/views/load.jsx

---

## Phase 14: User Story 12 - Simulate networks and users (Priority: P3)

**Independent Test**: quickstart §12

- [ ] T098 [P] [US12] Tests (network delay, bandwidth and drops; simulated users stopping on the condition or the turn limit) in evals/tests/engine/simulate.test.js
- [x] T099 [US12] Implement network profiles in the transport and `--network` in evals/engine/transport.js and evals/cli/hafen.js
- [ ] T100 [US12] Implement simulated users in evals/engine/simulate.js

---

## Phase 15: User Story 13 - Use it in a browser (Priority: P3)

**Independent Test**: quickstart §13

- [ ] T101 [P] [US13] Tests (the relay's allowlist, `Origin` check, streams passed through, the refused header; a blocked call's message in the app) in evals/tests/cli/relay.test.js and evals/tests/browser/web-mode.spec.js
- [x] T102 [US13] Implement `serve` (the browser build and the relay) in evals/cli/relay.js and evals/cli/hafen.js
- [x] T103 [US13] Implement the browser host (open and download suite files; runs in IndexedDB; the relay address; the blocked-call message) and the Connection → Relay pane in evals/app/js/host.js and evals/app/js/views/settings.js

---

## Phase 16: Remaining requirements (P3)

**Purpose**: requirements from the review's gaps that aren't a story of their own

- [ ] T104 [P] Write tests, then implement `reference` checks (by judge; by embeddings when named) (FR-029) in evals/tests/engine/reference.test.js and evals/engine/judges/reference.js
- [ ] T105 [P] Write tests (with a mock WebSocket scenario), then implement WebSocket providers (FR-001) in evals/tests/engine/provider-ws.test.js and evals/engine/stream/websocket.js
- [ ] T106 [P] Write tests, then implement attachments (FR-007) in evals/tests/engine/attachments.test.js and evals/engine/providers/
- [ ] T107 Add human review (Agree and Disagree in the Check view, reviews in runs, each judge's agreement) (FR-040) in evals/app/js/views/panel.jsx and evals/engine/reports/run-file.js
- [x] T108 [P] Write tests, then implement prices (`prices.yml`, provider prices, unknown cost never shown as 0) (FR-107) in evals/tests/engine/cost.test.js and evals/engine/spans.js

---

## Phase 17: Polish & Cross-Cutting Concerns

- [ ] T109 [P] Accessibility: every id and name in contracts/ui.md, keyboard paths, in evals/tests/browser/a11y.spec.js
- [x] T110 Final visual run of the gallery; update spec/design/ for anything changed on purpose, in evals/tests/visual/
- [x] T111 [P] Secret scan of every run file and report the fixtures produce (SC-007) in evals/tests/cli/no-secrets.test.js
- [ ] T112 [P] Engine overhead under 5ms at the median with 50 at a time (SC-009) in evals/tests/engine/overhead.test.js
- [x] T113 Package the desktop app (app id, name, icons, the engine's utility process) in evals/desktop/builder.json
- [ ] T114 Finish evals/README.md and walk through quickstart.md end to end

---

## Phase 18: The app keeps its work (constitution III, 3.0.0)

**Goal**: no folder to open: the app keeps its suites, providers, plugins and data files in its own
workspace; Import brings suites in, Export writes them (and everything they use) to a folder the CLI
runs as it is ([contracts/ui.md, The workspace](contracts/ui.md#the-workspace)).

- [x] T115 Write tests, then implement the engine's `dependencies` (what suites use, plugins' relative imports too), `suites`, `copyPlan` and `copy` commands in packages/hafen/tests/engine/dependencies.test.js, packages/hafen/engine/files/dependencies.js and packages/hafen/engine/serve-port.js
- [x] T116 Write tests, then let the CLI find a named folder's plugins/ (an exported folder runs from anywhere), and pack JSON Schemas, in packages/hafen/tests/cli/exported-folder.test.js, packages/hafen/cli/commands.js and packages/hafen/cli/pack.js
- [x] T117 The workspace in each host: the desktop app's data folder (desktop/main.js, desktop/engine-host.js), the browser's private file system (app/js/worker.js); folder mode removed
- [x] T118 Import, Export, Copy CI command from the last export, the one-time offer of the folder opened before, the first steps, and a new provider's kinds with the provider plugins, in app/js/transfer.js, app/js/lib/ci.js and app/js/views/; their Additions in spec/design/components.md first
- [x] T119 The browser tests start with the workspace filled (tests/browser/fixtures.js); the workspace, Import, Export and the desktop app's restart in tests/browser/workspace.spec.js; Getting started follows the new guide

## Dependencies & Execution Order

### Phase dependencies

- **Setup (1)** first. T004 and T005 (references and the copied design system, with the gallery
  passing) come before any UI task.
- **Foundational (2)** after Setup; blocks every story.
- **US1 → US2 → US3** in order: US2 tests what US1 sends; US3 runs what US2 saves. **US4** needs US2's
  checks and can run beside US3.
- **P2 stories (US5–US10)** after the MVP (US1–US4); independent of each other, except that US9's
  charts use US5's metrics.
- **P3 stories (US11–US13)** and Phase 16 after the stories they build on (US11 needs US5's
  metrics).
- **Polish (17)** last.

### Within each story

- Tests first, and seen failing.
- Engine before UI; contracts before the code that implements them.
- A story's checkpoint before the next story's merge.

### Parallel opportunities

- Setup: T002, T003, T006 and T007 together.
- Foundational: T009, T010, T012, T013, T014, T015, T018 and T021 together; then T016, T017, T011, T019.
- Within a story, every task marked [P].
- After the MVP, P2 stories in parallel by different people.

## Parallel Example: User Story 1

```text
Task: "Contract tests for the http provider in evals/tests/engine/provider-http.test.js"
Task: "Contract tests for the presets in evals/tests/engine/presets.test.js"
Task: "Tests for think tags split across chunks in evals/tests/engine/think-tags.test.js"

# then
Task: "Implement the tag splitter in evals/engine/stream/think-tags.js"
Task: "Implement the presets in evals/engine/providers/presets/"
Task: "Build the JSON tree in evals/app/js/design/json-tree.jsx"
```

## Implementation Strategy

### MVP first

1. Phase 1 and 2: the project, the copied design system passing its visual tests, the engine's
   core, the hosts, the app's frame.
2. US1: explore an endpoint. **Stop and validate** (quickstart §1); demo it.
3. US2: tests with checks. **Validate** (quickstart §2).
4. US3: CI. **Validate** (quickstart §3). This is the first release worth giving to a team.
5. US4: judges. **Validate** (quickstart §4). The MVP is complete.

### Then, in order of value

US5 (timeline) and US6 (thinking) next, since they're what the product is shown with; then US7 and
US8 (what QA teams hit first in real suites); then US9 and US10; then the P3 stories.

## Notes

- [P] means different files and no unfinished dependencies.
- Each story is complete and checkable on its own at its checkpoint.
- Commit after each task or small group; keep evals/README.md current as behaviour lands
  (constitution VII).
- A UI task that needs something the design system doesn't have stops and adds it to
  spec/design/components.md (Additions) first (constitution I).
