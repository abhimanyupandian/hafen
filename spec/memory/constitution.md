# Hafen Constitution

Hafen is a standalone project: end-to-end tests for chat endpoints, as a desktop app, a
command-line runner for CI, and a browser build. These principles govern it.

## Core Principles

### I. The UI matches the design system exactly (NON-NEGOTIABLE)

The app looks and behaves exactly as the design system in [`spec/design/`](../design/README.md)
says, which is hafen's UI written down. It is the only source of colours, type, sizes, spacing,
components and interaction patterns.

- The app is built from the design system's tokens and components, copied as
  [its README](../design/README.md#reusing-it-in-another-project) says. No new colours, fonts, font
  sizes, radii, shadows or control heights.
- A component the system doesn't have is added to `spec/design/components.md` (under Additions)
  before it's used, built only from existing tokens, and reviewed against the components beside it.
- Every rule the copied stylesheets keep stays hafen's, declaration for declaration (a parity test
  checks it), and a gallery page
  renders every component the app uses, compared with its baseline screenshots on every change; a
  difference fails unless the design spec was changed on purpose.

### II. One engine everywhere

Running a test (sending requests, reading streams, running checks and judges, timing every step)
has exactly one implementation: a module with no DOM that runs unchanged in the browser build, in
the desktop app and on the command line (CI).

- The UI only draws what the engine reports. It never re-implements parsing, checking or timing.
- A test gives the same results in the app and in CI, given the same responses.
- Anything platform-specific (how a request reaches the network, where files live, where secrets
  come from) is passed into the engine, never inside it.

### III. The file is the test

Tests are plain YAML or JSON files, in the user's repository, with a published schema.

- The app reads and writes those files directly. Nothing needed to run a test lives only in the
  app's storage, and there is no separate "export" step.
- Saving from the app keeps the file's comments, key order and formatting, so a one-field change
  is a one-line diff.
- A file states its schema version. Readers refuse versions they don't understand, and say so.

### IV. Local-first and private

Keys, prompts, responses and results stay on the user's machine unless the user sends them
somewhere.

- Secrets never go in test files: files reference them (`${env:NAME}`), and the app keeps their
  values in the system's keychain or a git-ignored local file.
- Run files and reports are redacted (authorization headers, known secret values) before they're
  saved or written.
- No telemetry. The only network requests are the ones the user's tests and settings ask for.
- Third-party plugin code never receives raw secrets: it gets a transport that adds them.

### V. Honest results

A result says exactly what happened.

- A check is `pass`, `fail`, `unsure`, `skipped` or `error`, never collapsed into pass or fail.
  An error (the endpoint or a judge broke) is not a failure of the thing being tested.
- Nothing is cut short silently: input too long for a judge is reported, not truncated.
- Numbers that depend on sample size show the sample size (`2/3`, `p99 of 40 requests`).
- Non-determinism is expected: repeats and pass rates are built in, not bolted on.

### VI. Contracts are tested first

The engine and its interfaces are covered by tests written before the code they test.

- Contract tests for the test file schema, provider mappings (streaming and not), each built-in
  check, the CLI's exit codes and reports, and the run file.
- A local mock endpoint (JSON, SSE, NDJSON, WebSocket, thinking, tool calls, errors, slow and
  cut-off streams, mock judges) stands in for real providers, so tests are fast, free and
  repeatable.
- The same engine test suite runs in Node and in a browser.

### VII. Plain and simple

- Plain JavaScript ES modules and React. The engine has no DOM; components and views draw. New
  dependencies and frameworks need a reason, recorded in the feature's research.
- Code comments explain what something is for and why, in plain sentences.
- User-facing behaviour is documented in the project's README as it lands.

## Constraints

- **Standalone:** the project lives in its own folder (`evals/`) with its own package, build,
  desktop app and CLI. It imports nothing from any other project in this repository and shares no
  storage, settings, processes or data with another app; it could move to its own repository
  unchanged. The design system is copied in, not imported.
- **Stack:** React 19 and Vite for the UI; Electron for the desktop app; Node 22 or newer for the
  CLI, the relay and tests.
- **Default environments:** the desktop app and CI. The browser build is supported where the
  endpoints allow it (CORS), or through the project's own relay (`hafen serve`).
- **Accessibility and automation:** every control has an `id` and an accessible name; rows and
  regions have ids made from what they show; state that matters (running, selected, status) is in
  the DOM as attributes.
- **Remembered state:** what the user opened, resized or collapsed is remembered, under `eval.*`
  keys.

## Development Workflow

- Each feature goes spec → plan → tasks → implementation, in its own folder under `spec/`.
- A pull request that changes the UI runs the visual tests. One that changes the engine or a
  contract runs the contract tests in Node and in a browser.
- A pull request that changes user-facing behaviour updates the README in the same change.
- Complexity that a principle would reject is justified in the plan's Complexity Tracking table, or
  removed.

## Governance

This constitution takes precedence over other practices in this project. Amending it takes a pull
request that changes this file, says why, and updates any spec or plan it affects. Versions follow
semantic versioning: a removed or redefined principle is a major change, a new principle or section
a minor one, wording a patch. Reviews check that a change follows these principles.

**Version**: 2.0.0 | **Ratified**: 2026-10-05 | **Last Amended**: 2026-10-05
