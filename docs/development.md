# Development

Hafen is plain JavaScript (ES modules) with React for the UI, Vite to build it, and Electron for
the desktop app. It needs Node 22 or newer.

```sh
npm ci
npm run app            # build the UI and start the desktop app
npm run dev            # the UI in Vite's dev server
npm run mock           # the mock endpoint on :8791, for trying things out
```

## How it's built

One engine, with no DOM, runs everywhere: in Node for the CLI, in Electron's utility process for
the desktop app, and in a Web Worker for the browser build.

| Path | What |
|---|---|
| `engine/` | Everything about running tests: files and schemas, variables, JSONPath (RFC 9535, json-p3), transports and retries, stream parsers, providers and presets, checks, judges, the runner, spans and metrics, redaction, reports. Runs unchanged in Node, a Web Worker and Electron's utility process |
| `cli/` | The command-line runner, its Node host, and the relay (`serve`) |
| `app/` | The UI (React). `design/` is Hafen's design system and its additions (check badge, JSON tree, timeline, charts); `views/`; `state.js`; `host.js` connects to the engine; `worker.js` runs it in a browser |
| `desktop/` | Electron: the window, the engine's utility process, folders and secrets |
| `tests/` | Engine and CLI tests (`node --test`); browser, desktop and visual tests (Playwright); fixtures and the mock endpoint |
| `spec/` | The product spec: user stories, data model, contracts, research, and the design system |

## Tests

```sh
npm test               # engine and CLI tests (Node)
npm run test:browser   # the app end to end in Chromium, and the desktop app in Electron
npm run test:visual    # the design-system gallery against its baseline screenshots
```

The mock endpoint (`tests/fixtures/mock-endpoint.mjs`) answers deterministically, one scenario per
path, so tests are fast, free and repeatable. Its header comment lists every scenario.
`tests/fixtures/suites/` holds reference suites and providers that use it.

## Packaging

```sh
npm run app:build      # packages in release/: a .app on macOS, an NSIS installer on Windows, an AppImage on Linux
npm run icons          # icon.png, icon.icns and icon.ico from desktop/icons/source.svg
```

The app is called **Hafen** wherever it's seen. Inside, it's **Hafen Lab**: the name of its data
folder, its keychain entry and its package id (`dev.hafen.lab`).

## The spec

The product is specified in [`spec/`](../spec/README.md), in [Spec Kit](https://github.com/github/spec-kit)'s
format:

- [`spec/001-hafen/spec.md`](../spec/001-hafen/spec.md): user stories, requirements and success
  criteria.
- [`spec/001-hafen/contracts/`](../spec/001-hafen/contracts/): the exact contracts for the test file
  (and its JSON Schema), providers and plugins, checks and judges, the CLI, the run file, and the UI.
- [`spec/001-hafen/data-model.md`](../spec/001-hafen/data-model.md) and
  [`research.md`](../spec/001-hafen/research.md): the data model, and why each decision was made.
- [`spec/design/`](../spec/design/README.md): the design system the UI is built from (tokens,
  layout, components, patterns).

The engine's JSON Schemas (`engine/files/schema/`) are kept identical to the spec's
`suite.schema.json` and `provider.schema.json`, and a test checks it.
