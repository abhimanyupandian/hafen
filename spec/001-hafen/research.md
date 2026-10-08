# Research: Hafen

Phase 0 of the [plan](plan.md). Each section is one decision: what was chosen, why, and what else
was considered. Facts about other products and provider APIs were checked on 2026-10-05; the ones
marked **verify** are re-checked against the provider's current docs when the code that depends on
them is written.

## 1. What the product is, and for whom

- **Decision:** "Postman for AI endpoints": end-to-end tests of chat endpoints, built for QA and
  test engineers and for developers who ship chat features. The endpoint is a black box; the unit
  is a scripted conversation with checks on every reply.
- **Rationale:** Most evaluation tools are built for ML engineers testing prompts and models, and
  are code-first or hosted. QA teams test AI features with the habits of API testing (requests,
  JSONPath, assertions, collections, CI) and have no tool shaped that way.
- **Alternatives and neighbours:**
  - **Postman** has AI requests: chat with OpenAI-compatible models, where each message and reply
    is added to the open conversation, with response time and token counts. Its docs don't show
    saving such a conversation as a test with checks per turn, running AI requests in the
    Collection Runner or Postman CLI, or judges. Postman users can chain ordinary HTTP requests
    with scripts to fake multi-turn tests, which runs in CI but is hand-written JavaScript that
    shows raw JSON. Postman is moving fast (its "AI Engineer" agent, June 2026; Agent Mode writes
    tests), so this is re-checked before positioning against it.
  - **Promptfoo:** open source, YAML configs, CI-native, can call any HTTP endpoint, rule and LLM
    rubric assertions. The closest competitor; config-first, with a viewer rather than a place to
    explore and build tests.
  - **Braintrust, LangSmith, Langfuse:** platforms for ML engineers: tracing, datasets,
    experiments, hosted.
  - **Google ADK's evaluation:** criteria worth matching: tool trajectory (exact, in order, any
    order), response match (ROUGE and LLM-judged), rubric-based quality for responses, tool use and
    multi-turn trajectories, hallucination and safety judges, a user simulator, and always-on
    efficiency metrics (tool calls, model calls, tokens, duration).
  - **Bruno:** an API client that keeps collections as plain files in the repository; precedent
    for decision 6.

## 2. A standalone project

- **Decision:** Hafen is its own project in `evals/`: its own `package.json`, build, desktop
  app, CLI, relay, storage and settings. It imports nothing from the rest of this repository and
  could move to its own repository unchanged. It shares only a look: the design system is copied
  in ([decision 26](#26-the-design-system-copied-in)).
- **Rationale:** Evaluating chat endpoints is a different product from the rest of the repository,
  with different users. Keeping it separate means neither constrains the other's releases, storage
  or settings, and nothing about one leaks into the other's concepts.
- **Alternatives:** a page inside the existing web app (shared storage, settings, navigation and
  release cycle, and its concepts mixed with the app's); a shared package between them (extract
  later if both keep evolving the same components).

## 3. The engine's language: JavaScript

- **Decision:** One engine in plain JavaScript ES modules with no DOM, in `evals/engine/`, run
  unchanged in a Web Worker (browser build), in the desktop app's utility process (Node: decision
  5) and in the CLI (Node).
- **Rationale:** The browser can only run JavaScript (or WebAssembly), so a browser build means a
  JavaScript engine; with one engine, the app and CI can't drift (constitution II). The design
  system's components are plain JavaScript and React, so the project stays in one language.
- **Alternatives:**
  - **A Go runner** (single binary, good concurrency): rejected once the browser was required. It
    would be a second engine for the browser, and the two would disagree on stream parsing and
    checks.
  - **TypeScript:** better types, but a build step for the CLI and the copied components. Types are
    carried by the JSON Schemas and [data-model.md](data-model.md). Revisit if the engine grows
    past what that keeps clear.

## 4. The desktop shell: Electron

- **Decision:** An Electron app of the project's own (`evals/desktop/`), with its own app id, name,
  data folder and window.
- **Rationale:** Its bundled Chromium behaves the same on every OS and matches the browser build;
  its Node side runs the engine without CORS; the design system already has rules for an Electron
  window without a title bar.
- **Alternatives:** **Wails** (Go, system webview) only made sense with a Go engine. **Tauri**
  (Rust, system webview) would add Rust while the work is done in JavaScript. Both render with
  WebKit on macOS and Linux, so the app would look and behave slightly differently per OS.

## 5. Where the engine runs, and how calls reach the network

- **Decision:**
  - **Desktop app:** the engine runs in an Electron utility process (`utilityProcess.fork`), which
    is Node, like the CLI. The UI and that process talk over a `MessageChannelMain` port: the UI
    sends commands (run, stop, send a message), the engine streams events back. The main process
    owns secrets (`safeStorage`) and files, and hands them to the engine as it asks.
  - **CLI:** the engine runs in Node, calling endpoints directly.
  - **Browser build:** the engine runs in a Web Worker. Calls go directly where the endpoint allows
    it (CORS), or through the project's relay (decision 25).
  - **Everywhere:** the engine never calls `fetch` itself; it's given a transport
    (`send(request) → response with a body stream`). Network simulation (decision 18) wraps the
    transport.
- **Rationale:** Running the desktop engine in Node makes the desktop app and CI the same runtime,
  the strongest parity there is; it also removes CORS, allows real concurrency for load tests, and
  reaches files and secrets without the UI holding them. A utility process keeps long runs off
  the main process, which serves the window.
- **Alternatives:** the engine in the UI with each request proxied through the main process over
  IPC (every chunk crosses two process boundaries, load tests would share the UI's thread, and the
  UI would see secrets); the engine in the main process (would freeze the window during load
  tests).
- **The port to the UI:** a `MessagePort` can't pass through `contextBridge`; the preload script
  receives it (`ipcRenderer.on(…, (e) => …e.ports[0])`) and forwards it with
  `window.postMessage(…, [port])`, the pattern Electron documents for isolated pages.

## 6. The app keeps the tests; Export writes the files

- **Decision:** Suites are YAML or JSON files with one schema ([contracts/test-file.md](contracts/test-file.md)),
  kept by the app in its own workspace (the desktop app's data folder, `workspace/`; the browser's
  Origin Private File System, `workspace/`), laid out as the engine reads a folder, and edited there
  in place. Import copies suites in from files or a folder; Export writes them to a folder, with
  everything they use (the engine's `dependencies` command), as plain files the CLI runs unchanged.
- **Rationale:** Asking for a folder before anything else was the first thing a new user met, and a
  browser can't keep one between visits. Kept by the app, a provider, a conversation and a suite can
  be made from the first start. Drift between the app's copy and the repository's is kept visible
  rather than prevented: Export writes the same text, lists the files that would change and asks
  first, remembers where each suite went (Copy CI command runs that folder), and `git diff` shows the
  change; Import brings the repository's back, asking about the app's own it would change.
- **Alternatives:** working on a folder the user opens (replaced: a step before anything can be
  done, and the browser build couldn't keep it); a sync that writes the folder on every save
  (surprising writes into a repository, and no browser equivalent); JSON only (no comments, harder to
  edit by hand).

## 7. YAML that keeps comments

- **Decision:** The `yaml` npm package (eemeli/yaml), editing through its Document API so comments,
  key order and formatting survive a save; JSON files are rewritten with 2-space indentation and
  their key order kept.
- **Rationale:** If saving from the UI drops comments, people stop editing in the UI.
- **Alternatives:** `js-yaml` (doesn't keep comments).

## 8. Schema and versions

- **Decision:** JSON Schema (draft 2020-12) for suite and provider files
  ([suite.schema.json](contracts/suite.schema.json), [provider.schema.json](contracts/provider.schema.json)),
  and `version: 1` in each file. YAML files can point editors at the schema with
  `# yaml-language-server: $schema=…`. A reader refuses a higher major version (exit 2 in CI).
- **Rationale:** Editors autocomplete and check the files; CI fails fast on a file it can't read.
- **Validator:** Ajv (its draft 2020-12 build), in the engine, so the app and CI report the same
  problems; errors are mapped back to the YAML's lines and columns through the `yaml` package's
  source positions.
- **Alternatives:** hand-written validation (would drift from the schema editors use).

## 9. JSONPath

- **Decision:** RFC 9535 JSONPath. The library is chosen by running the JSONPath Compliance Test
  Suite (`jsonpath-standard/jsonpath-compliance-test-suite`) against the candidates when the code
  is written; if none passes, implement the RFC's syntax ourselves (it's small), tested with that
  suite. A path matching several values passes an operator if any value passes, unless the check
  says `all: true`.
- **Rationale:** JSONPath dialects disagree on edge cases; users coming from other tools need one
  documented behaviour, and the app and CI share it through the engine.

## 10. Variables and secrets in files

- **Decision:** `{{name}}` for test variables (set by environments, data rows, extractions and
  setup steps) and `${env:NAME}` only for the process's environment (secrets and CI settings).
- **Rationale:** `{{…}}` is what Postman users know. Keeping secrets in a separate syntax makes
  them easy to spot, easy to redact (every resolved `${env:…}` value is redacted), and impossible to
  set from a response.
- **Resolution order** for `{{name}}`: extractions and setup steps (latest wins) → the data row
  (`{{row.col}}`) → the suite's variables → the environment's variables. A name not found is a
  setup error before anything is sent.

## 11. One event model for every provider

- **Decision:** Providers turn whatever an endpoint sends into one ordered list of events
  ([data-model.md](data-model.md#turnevent)): `thinking`, `text`, `tool_call`, `tool_result`,
  `usage`, `done`, `error`, each with its time. Raw provider blocks are kept beside them for replay.
- **Mappings** (**verify** each when its preset is written):

| Source | Text | Thinking | Tools | Usage |
|---|---|---|---|---|
| OpenAI-compatible chat (SSE) | `choices[0].delta.content` | `choices[0].delta.reasoning_content` or `reasoning` (DeepSeek, OpenRouter, vLLM, llama.cpp server) | `choices[0].delta.tool_calls` | final chunk's `usage`, with `completion_tokens_details.reasoning_tokens` |
| OpenAI Responses (SSE) | `response.output_text.delta` | `response.reasoning_summary_text.delta` (summary only) | function call items | `usage.output_tokens_details.reasoning_tokens` |
| Anthropic Messages (SSE) | `content_block_delta` with `text_delta` | `thinking` blocks, `thinking_delta`; `signature_delta`; `redacted_thinking` | `tool_use` blocks, `input_json_delta` | `message_delta` usage; thinking is counted in output tokens, not reported apart |
| Gemini | `candidates[0].content.parts[].text` | parts with `thought: true` (when `includeThoughts` is on) | `functionCall` parts | `usageMetadata`, with `thoughtsTokenCount` |
| Text with tags (Qwen3 and R1-style models served raw) | text outside the tags | `<think>…</think>`, split by a parser that handles a tag cut across chunks | (none) | (whatever the endpoint reports) |

## 12. Thinking: what's visible, and replaying it

- **Decision:** Every thinking event carries its visibility: `full`, `summary`, `progress`,
  `omitted` or `redacted`. Checks on omitted or redacted thinking are skipped unless required.
  Providers ask for readable thinking when a test checks it. Raw blocks are sent back unchanged in
  live mode; pinned turns are sent as plain text without thinking.
- **Rationale and provider facts:**
  - Current Claude models return `thinking` blocks with empty text unless the request sets
    `thinking.display: "summarized"`; the raw chain of thought is never returned. Some return
    progress notes between tool calls as thinking blocks (`display: "updates"`). Thinking blocks
    must be sent back unchanged when continuing on the same model, and current models reject a
    conversation whose earlier turns were edited. So the Anthropic preset requests summaries when a
    test checks thinking, labels them `summary` (or `progress`), keeps blocks for replay, and never
    sends a pinned (edited) turn with thinking blocks.
  - OpenAI returns reasoning summaries only, and reasoning token counts; continuing a conversation
    needs `previous_response_id` or encrypted reasoning items.
  - Gemini returns thought summaries when asked (`includeThoughts`), and counts thinking tokens.
  - Open models (DeepSeek, Qwen, others served raw) usually return full thinking, in a field or in
    tags.
- **Alternatives:** treating thinking as text (checks would fail for the wrong reason when it's
  hidden).

## 13. Confidence, "unsure", accuracy

- **Decision:**

| Measure | Definition |
|---|---|
| Confidence, System One | The API's own `confidence` when it reports one; otherwise the probability of the answer it chose (choice), or of the score it gave (score); for noul, how far the value is from 0.5, doubled (0.95 and 0.05 are both 0.9) |
| Confidence, LLM judge | The share of the N samples that agree with the majority verdict (`2/3` → 0.67) |
| Confidence, rule check | None (shown as —) |
| Unsure | A judged check whose value passes, but whose confidence is below its `unsure_below` (default 0.6); it counts as failed unless the unsure policy says warn or pass |
| Turn accuracy | Checks passed ÷ checks run (skipped ones aren't run; errors count as not passed) |
| Test pass rate | Repeats that passed ÷ repeats |
| Data accuracy | Rows that passed ÷ rows |
| Turn confidence | The lowest confidence among its judged checks |

- **Rationale:** Each number means one thing, and none is shown where it doesn't apply. A test can
  pass and still show a shaky check.

## 14. System One judges by API endpoint

- **Decision:** A System One judge is an endpoint, a key and a model: TypeSafe's hosted Jev by
  default, or any self-hosted endpoint serving the same API (`POST <endpoint>/v1/systemone` with
  `{state, model, questions}` → `{model, answers, usage}`; `GET <endpoint>/v1/models`; the key as a
  Bearer token). **Verify** the hosted endpoint's address and the request shape against
  [TypeSafe's docs](https://docs.typesafe.ai/introduction) when the judge is written.
- **Rationale:** TypeSafe's primitives (choice, score, noul) answer typed questions with
  probabilities, evaluated independently in one request; that's what gives checks a confidence.
  Treating it as an API keeps the project standalone and works the same in the app and CI.
- **Batching:** the checks on one turn that use the same judge are sent as one request (one
  question each), as the API evaluates them independently.

## 15. The run file: a format of the project's own

- **Decision:** A run is a JSON document of the project's own format, `kind: "hafen-run"`,
  `version: 1` ([contracts/run-file.md](contracts/run-file.md)): the run, its spans, its turns, its
  results and its summary. The app keeps runs in its own IndexedDB database and exports them as
  `<_id>.hafen-run.json`; the CLI writes the same file.
- **Rationale:** One format for the app and CI, so a CI run opens in the app as it was.
- **Alternatives:** an existing trace format from elsewhere (couples the project to another app's
  storage and versions).

## 16. The timeline is drawn with the design system's CSS

- **Decision:** Absolutely positioned bars in a scrolling area, styled with the tokens
  ([design additions](../design/components.md#timeline)), rows drawn only when in view.
- **Rationale:** A charting library would bring its own look; this is a few hundred lines and stays
  inside the design system.
- **Alternatives:** vis-timeline, d3 (rejected for look and weight).

## 17. Trend charts

- **Decision:** Small SVG line charts (pass rate, latency p50/p95, cost over runs), drawn with the
  tokens ([design additions](../design/components.md#small-charts)).
- **Rationale:** Same as 16.

## 18. Network simulation in the transport

- **Decision:** Delay, bandwidth limits (pacing the body's chunks) and dropped connections are
  applied by a wrapper around the transport.
- **Rationale:** It works the same in the app, the browser and CI; browser throttling can't be set
  from a page and doesn't exist in CI.
- **Devices:** the tool tests endpoints, so a "weaker device" is a property of wherever the
  endpoint runs. To test an endpoint under CPU or memory limits, run it in a container with those
  limits (`docker run --cpus … --memory …`); the quickstart shows how. The tool records the
  network profile with the run; it doesn't simulate devices.

## 19. Load tests run in Node

- **Decision:** Load tests run only in the desktop app's engine process or the CLI. Results show
  p50, p95, p99 with their sample count; the runner watches its own event-loop delay and CPU and
  flags results when it was the bottleneck.
- **Rationale:** Browsers allow about six connections per host over HTTP/1.1, which would cap
  concurrency without saying so; a saturated client measures itself, not the endpoint; a p99 of 40
  samples is the slowest request.

## 20. Secrets

- **Decision:** Files reference `${env:NAME}`. The desktop app keeps values encrypted with
  Electron's `safeStorage` in its data folder, per environment, and passes them to the engine
  process; the CLI reads the process environment; the browser build keeps them in localStorage, and
  its Settings say so plainly.
- **Rationale:** Secrets never enter the repository; the desktop app uses the system's keychain
  through `safeStorage`.

## 21. Redaction

- **Decision:** Before a span is saved or a report written: these headers are replaced with
  `[redacted]`: `authorization`, `proxy-authorization`, `x-api-key`, `api-key`, `cookie`,
  `set-cookie`, and any header a provider marks secret; every resolved `${env:…}` value is replaced
  wherever it appears; optional patterns (emails, card numbers, phone numbers) when the suite turns
  them on.
- **Rationale:** CI artifacts can be public; run files get shared.

## 22. Plugins

- **Decision:**
  - **Providers by configuration** (YAML or JSON) cover most endpoints and need no code.
  - **Code plugins** are ES modules with a default export `{ kind, name, version, … }`
    ([contracts/provider.md](contracts/provider.md#code-plugins), [contracts/checks.md](contracts/checks.md#plugins)),
    loaded from paths in the repository or npm packages.
  - They run in a worker (a Web Worker in the browser, `worker_threads` in Node) and talk to the
    engine by messages. They make requests through a transport that adds credentials by name; the
    values never enter the worker.
- **Rationale:** The same plugin runs everywhere the engine does.
- **Limits, stated plainly:** a worker isn't a security boundary. Plugins are trusted code: the
  guarantee is that they never hold secrets, not that they can't misbehave.

## 23. The CLI: Node 22, in the project first

- **Decision:** `evals/cli/hafen.js`, run with `node evals/cli/hafen.js` (or `npx
  hafen` once published), needing Node 22 or newer. Publishing it as an npm package, and a
  single executable (`bun build --compile` or `deno compile`), come after the first release; the
  published name is decided then.
- **Since:** the engine and the CLI are the `hafen` package, an npm workspace
  (`evals/packages/hafen/`, bin `hafen`: `cli/hafen.js`), which installs on its own for CI with no
  Electron, React or Playwright; the app depends on it. Publishing it is still to decide.
- **Rationale:** Node 20 reached end of life in April 2026; Node 22 has `fetch`, `WebSocket`,
  `worker_threads` and the test runner built in, so the CLI needs no extra dependencies for them.

## 24. WebSocket endpoints

- **Decision:** A provider kind `websocket`: the address, the message to send (a template), how to
  read each message (paths, as for streams), and when the reply is over (a message type, or a quiet
  time). In the browser, where a WebSocket can't carry headers, credentials go in the address or a
  subprotocol, or the call goes through the relay.

## 25. The relay: `hafen serve`, now `npm run serve`

- **Since:** it's the app's (`evals/server/serve.js`, `npm run serve`, same options), not the hafen
  package's: it serves the app's build, and the package doesn't depend on the app. `hafen serve`
  says so (exit `2`).
- **Decision:** The CLI's `serve` command serves the browser build and relays the browser's calls
  to endpoints on an allowlist (`--allow-endpoint`, repeatable, or `HAFEN_ENDPOINTS`), only for
  its own pages (checked by `Origin`), streaming responses through unchanged. It listens on
  127.0.0.1 by default.
- **Rationale:** The browser build needs a way past CORS that the project owns, with nothing else to
  install.
- **Alternatives:** asking users to run a generic CORS proxy (an open relay is a security problem);
  no browser build (the user asked for one).

## 26. The design system, copied in

- **Decision:** The project copies the design system's CSS and generic components from hafen into
  `evals/app/` as [the design README](../design/README.md#reusing-it-in-another-project) lists,
  changing only the storage prefix (`eval.`), the logo and the head's controls. A gallery page
  (`evals/app/gallery.html`) renders every component the app uses.
- **Rationale:** The app must look exactly like hafen without depending on it. Copying keeps the
  project standalone; the parity test and the gallery's baseline catch drift (§28).
- **Alternatives:** importing from hafen's `web/` (the project would no longer be standalone); a
  shared package (worth extracting later if both projects keep changing the same components).

## 27. Tests: Node's runner, Playwright, a mock endpoint

- **Decision:**
  - Engine and CLI tests use Node's built-in test runner (`node --test`), no new dependency.
  - Playwright (a development dependency) runs the same engine tests in a browser, the app's
    end-to-end tests, and the visual tests.
  - `evals/packages/hafen/tests/fixtures/mock-endpoint.mjs` is a local HTTP and WebSocket server with a scenario
    per path: JSON, SSE and NDJSON replies, thinking (full, summary, omitted, tags), tool calls,
    model APIs that ask for tool results, errors, rate limits, slow and cut-off streams, sessions,
    an endpoint without CORS, a mock System One API and a mock LLM judge.
- **Rationale:** Fast, free, repeatable tests (constitution VI).

## 28. Keeping the look exact: parity with hafen's source, and a gallery baseline

- **Decision:** Two tests. A parity test checks that every rule the copied stylesheets keep is
  hafen's, declaration for declaration (their comments are the project's own, and rules for hafen's
  own features are left out, so none of its concepts appear), that the logo files are hafen's byte for
  byte, and that every frame rule the two share has the same declarations (it runs while hafen's
  `web/` is beside this project). The gallery page (every component the app uses) is screenshotted in
  both themes and compared with its committed baseline on every change.
- **Rationale:** "The UI must match exactly" needs a test, not a promise (constitution I). Copying
  the CSS unchanged makes the components identical by construction; the parity test keeps them so; the
  baseline catches any change to how they render.
- **Alternatives:** reference screenshots captured from hafen's pages (rejected: hafen has no page
  showing each component alone, so screenshots of its pages can't be compared with the gallery's).

## 29. Reference answers

- **Decision:** Compare by meaning with a judge by default (as ADK's LLM-judged response match);
  with embeddings when the suite names an embeddings provider and a similarity threshold.

## 30. Human review

- **Decision:** A judged result can be marked agree or disagree in the panel; marks are saved in
  the run (`reviews`), and each judge's agreement is computed across runs in the history.

## 31. Prices

- **Decision:** Prices per model (USD per million tokens in and out, optionally cached input) in a
  provider's `price`, or in a shared `prices.yml` beside the suites. No built-in price list: they
  change too often.

## 32. Runs in the app and on disk

- **Decision:** The Runs section lists runs from the app's IndexedDB database (`hafen`, store
  `runs`). In the desktop app with a folder open, each run is also written to
  `<folder>/.hafen/runs/<_id>.hafen-run.json`, which the app puts in a `.gitignore`
  there; CI writes its run files wherever `--report run:` says. Opening a run file adds it to the
  list.
- **Baselines:** `--baseline <run file>` in CI; teams keep the main branch's last run file as a CI
  artifact or cache, and the CLI contract shows how.
