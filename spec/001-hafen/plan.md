# Implementation Plan: Hafen — end-to-end tests for chat endpoints

**Branch**: `001-hafen` | **Date**: 2026-10-05 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `spec/001-hafen/spec.md`

## Summary

Build Hafen as a standalone project in `evals/`: a desktop app, a browser build and a
command-line runner for CI, all running the same test files. One JavaScript engine with no DOM
sends turns to any endpoint (through configured or code providers, streaming or not), turns what
comes back into one event model, runs rule checks, JSONPath assertions and judges (System One
through its API; LLM judges with rubrics), and records every step as a timed span in a run file of
the project's own format. The UI draws what the engine reports, built from a copy of hafen's design
system: the suites tree on the left, the conversation in the centre, details in the panel, the
timeline and console at the bottom. In the desktop app the engine runs in an Electron utility
process (Node, as in CI); in the browser build, in a Web Worker, calling endpoints directly or
through the project's relay (`hafen serve`). Decisions and alternatives:
[research.md](research.md).

## Technical Context

**Language/Version**: JavaScript (ES2023 modules) and JSX; Node 22+ for the CLI, the relay and
tests

**Primary Dependencies**: React 19, Vite 8, Electron 44; `yaml` (comment-keeping YAML), an RFC
9535 JSONPath library chosen by the compliance suite ([research §9](research.md#9-jsonpath)), Ajv
(JSON Schema draft 2020-12); Playwright and electron-builder (development only)

**Storage**: suite, provider and data files in the user's folder; runs in IndexedDB (`hafen`,
store `runs`) and as run files (`.hafen/runs/`, CI report paths); secrets in Electron
`safeStorage` (desktop), the environment (CLI) or localStorage (browser build); UI state in
localStorage (`eval.*`)

**Testing**: `node --test` for the engine, CLI, relay and contracts; Playwright for the same engine
tests in a browser, the app end to end, and visual tests of the design-system gallery against
its baseline screenshots, and a parity test against hafen's stylesheets; a local mock endpoint (`evals/tests/fixtures/mock-endpoint.mjs`) for every
provider behaviour

**Target Platform**: the desktop app (macOS, Windows, Linux, via Electron), CI runners (Linux, macOS,
Windows with Node 22+), and current Chromium, Firefox and Safari for the browser build

**Project Type**: a standalone project: a desktop app, a web app, a library (the engine) and a CLI,
in one package

**Performance Goals**: the engine adds under 5ms to a request's median at 50 at a time (SC-009);
chunks are drawn as they arrive (at least 30 updates a second while streaming); a 50-turn run's
timeline draws in under 1s (SC-004); a 10,000-row data test's results page through without the UI
stalling

**Constraints**: the UI matches the design system exactly (constitution I; visual tests); one
engine (II); no secrets in files, runs or reports (IV); imports nothing from the rest of the
repository (constitution, Constraints); works without network access except to the endpoints and
judges a suite names; the CLI needs no build step

**Scale/Scope**: suites of up to hundreds of tests; runs of up to 10,000 data rows or 50,000 load
requests; about 10 sidebar, panel and dock views; 13 user stories, P1 to P3

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Check | Status |
|---|---|---|
| I. UI matches the design system | The app is built from the design system copied into `evals/app/`; new parts are written into `spec/design/components.md` (Additions) first; a parity test and the gallery's baseline screenshots catch drift (T004, T005) | ✅ |
| II. One engine | `evals/engine/` runs in a Web Worker, Electron's utility process and the CLI; the UI never parses, checks or times; platform differences enter only as a transport, a file store and a secret store | ✅ |
| III. The file is the test | Suites are files read and written in place, comment-keeping; the app keeps no state a test needs; schema versioned | ✅ |
| IV. Local-first and private | `${env:…}` references only; `safeStorage` in the desktop app; redaction before storing or writing; plugins get credentials by name, never values; no telemetry | ✅ |
| V. Honest results | Five result states; errors separate from failures; no truncation of judge input; sample counts on percentiles and pass rates; repeats built in | ✅ |
| VI. Contracts tested first | Contract tests for the schemas, providers (mock endpoint), checks, CLI exit codes and reports, run file and relay, written before the code in each phase; engine tests run in Node and a browser | ✅ |
| VII. Plain and simple | Plain JavaScript and React; three runtime dependencies beyond React, each justified in research; README updated as features land | ✅ (see Complexity Tracking) |
| Standalone | `evals/` has its own package, build, desktop app and CLI; no import reaches outside it (checked by T006) | ✅ |

**Re-check after Phase 1 design:** the contracts keep every principle. One limit is stated rather
than hidden: plugins are trusted code ([research §22](research.md#22-plugins)).

## Project Structure

### Documentation (this feature)

```text
spec/001-hafen/
├── spec.md              # the feature: stories, requirements, success criteria
├── plan.md              # this file
├── research.md          # decisions (phase 0)
├── data-model.md        # entities (phase 1)
├── quickstart.md        # validation scenarios (phase 1)
├── contracts/           # phase 1
│   ├── test-file.md         suite.schema.json
│   ├── provider.md          provider.schema.json
│   ├── checks.md
│   ├── cli.md
│   ├── run-file.md
│   └── ui.md
├── checklists/
│   └── requirements.md  # the spec's quality checklist
└── tasks.md             # phase 2
```

The design system the UI follows is [spec/design/](../design/README.md).

### Source Code

```text
evals/                                # the whole project; imports nothing from outside this folder
├── package.json                      # its dependencies and scripts: dev, build, app, app:build, test, test:browser, test:visual
├── vite.config.js                    # builds app/ into app/dist
├── README.md                         # what it is, the app, files, CLI, providers, checks
├── app/                              # the UI: the browser build, and the desktop app's window
│   ├── index.html                    # the skeleton from spec/design/README.md
│   ├── gallery.html                  # every design-system component the app uses, for visual tests
│   ├── public/icons/                 # the app's logo (light and dark tiles), favicon
│   ├── css/
│   │   ├── tokens.css                # copied from the design system, unchanged
│   │   ├── components.css            # copied, unchanged; + the Additions (check badge, reply parts, JSON tree, timeline, charts)
│   │   ├── frame.css                 # the frame rules, copied unchanged; + .work-area, .work
│   │   └── eval.css                  # the app's own rules (tokens only)
│   └── js/
│       ├── main.jsx                  # the frame, routes, start-up
│       ├── design/                   # the design system's components, copied: sidebar, collapsible, list, confirm,
│       │                             #   select, console, modal, editor, id-field, icons, logo, resizer, pan, zoom,
│       │                             #   tooltip, toast, hooks; + check-badge, json-tree, timeline, chart
│       ├── lib/                      # store (eval.* keys), events, dom, prefs, url, idb, clipboard, log, format, id
│       ├── views/                    # suites, runs, providers, palette, thread, composer, panel (its views), load, settings panes
│       ├── state.js                  # what's open and selected; talks to the engine host
│       └── host.js                   # starts the engine: a Web Worker (browser) or the desktop app's engine port
├── engine/                           # THE ENGINE: no DOM; runs in a Worker, Electron's utility process, Node
│   ├── index.js                      # run(suites, options, host) → events; explore(); validate()
│   ├── files/                        # suite-file.js (parse, validate, save keeping comments), schema/ (the two schemas), data.js (CSV, JSON lines)
│   ├── vars.js                       # {{…}}, ${env:…}, extraction, resolution order
│   ├── jsonpath.js                   # RFC 9535 (the chosen library, or ours)
│   ├── transport.js                  # the transport interface; retries; network simulation
│   ├── stream/                       # sse.js, ndjson.js, websocket.js, think-tags.js
│   ├── providers/                    # http.js (configuration), presets/ (openai-chat, openai-responses, anthropic-messages, gemini)
│   ├── events.js                     # TurnEvents; merging; the assembled response
│   ├── spans.js                      # the span recorder; metrics; percentiles; cost
│   ├── checks/                       # path.js, text.js, status.js, latency.js, json.js, thinking.js, tools.js, sequence.js, cost.js
│   ├── judges/                       # systemone.js (the System One API), llm.js, reference.js, index.js (named judges)
│   ├── runner.js                     # suites → tests → repeats/rows → turns; setup, teardown; stop; budget
│   ├── simulate.js                   # simulated users
│   ├── load.js                       # load mode
│   ├── compare.js                    # baselines
│   ├── redact.js
│   ├── plugins.js                    # loading, the worker bridge, transports by name
│   └── reports/                      # run-file.js, junit.js, markdown.js, json.js
├── cli/
│   ├── hafen.js                 # run, validate, report, compare, serve; exit codes; output
│   └── relay.js                      # serve: the browser build and the allowlisted relay
├── desktop/                          # the Electron app
│   ├── main.js                       # the window (no title bar), the engine's utility process, ports to the UI,
│   │                                 #   folders (open, watch, read, write), secrets (safeStorage), notifications
│   ├── engine-host.js                # the utility process's entry: the engine in Node, with the app's transport and files
│   ├── preload.cjs                   # passes the engine port and the platform to the UI
│   └── builder.json                  # electron-builder: app id, name, icons
└── tests/
    ├── fixtures/
    │   ├── mock-endpoint.mjs         # every provider behaviour, mock System One and LLM judges, an endpoint without CORS
    │   ├── suites/                   # reference suites used by tests and the quickstart
    │   ├── streams/                  # recorded provider streams for the presets' tests
    │   └── plugins/                  # test plugins
    ├── engine/                       # node --test: contracts and units
    ├── cli/                          # node --test: commands, exit codes, reports, relay
    ├── browser/                      # Playwright: the engine tests in a browser; the app end to end
    └── visual/                       # Playwright: the gallery against its baseline (tests/visual/snapshots/)
```

**Structure Decision**: one folder, one package, so the project can move to its own repository
unchanged. The engine is a plain folder of ES modules that Vite bundles for the UI and Node imports
directly for the CLI and the desktop app's utility process. The design system is copied into
`app/css/` and `app/js/design/` ([research §26](research.md#26-the-design-system-copied-in)).

## Complexity Tracking

| Addition | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| `yaml` dependency | Saving from the UI must keep comments (FR-061) | `js-yaml` and `JSON.stringify` drop comments and formatting |
| A JSONPath library | RFC 9535 behaviour that matches other tools (FR-023) | A home-grown dialect would surprise users; we write our own only if no library passes the compliance suite |
| Ajv | Validating files against the published schemas, in the app and CI alike | Hand-written validation would drift from the schema the editors use |
| Playwright (dev) | Visual tests are required (SC-008), and the engine must be tested in a browser (constitution VI) | Screenshots by hand don't catch regressions; Node-only tests miss browser stream and Worker behaviour |
| An Electron utility process | Desktop runs in the same runtime as CI, with no CORS, real concurrency for load tests, and secrets kept out of the UI | The engine in the UI would see secrets and share its thread with load tests; in the main process it would freeze the window |
| A copy of the design system | The app must look exactly like hafen while staying standalone | Importing from hafen's code would tie the projects together; a shared package can be extracted later |
