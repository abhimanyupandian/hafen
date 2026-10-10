# Development

Hafen is plain JavaScript (ES modules) with React for the UI, Vite to build it, and Electron for
the desktop app. It needs Node 22 or newer.

```sh
npm ci
npm run app            # build the UI and start the desktop app
npm run dev            # the UI in Vite's dev server
npm run mock           # the mock endpoint on :8791, for trying things out
npm run serve          # the browser build (npm run build first) with its relay, on :8790
npx hafen --help       # the command line (the workspace's), or node packages/hafen/cli/hafen.js
```

## How it's built

One engine, with no DOM, runs everywhere: in Node for the CLI, in Electron's utility process for
the desktop app, and in a Web Worker for the browser build.

The repository is two npm workspaces. **`packages/hafen/`** is the `hafen` package: the engine and
the command line, which installs on its own for CI (`npm install hafen`: its dependencies are Ajv,
json-p3 and yaml, and rolldown, optional, for `pack`). **The root** is the app (`hafen-app`, private):
the UI, the desktop app and the browser build's server, which depends on `hafen`. `npm ci` at the
root links `packages/hafen` as `node_modules/hafen`, and the app imports the engine by the package's
name, never by a path into it: `hafen/engine/<module>.js` (Vite resolves them through
`node_modules/hafen` for the page, the engine's Web Worker and the plugin worker) and
`hafen/cli/node-host.js` (the desktop app's engine process). The package imports nothing of the
app's.

| Path | What |
|---|---|
| `packages/hafen/engine/` | Everything about running tests: files and schemas, variables, JSONPath (RFC 9535, json-p3), transports and retries, stream parsers, providers and presets, checks, judges, the runner, spans and metrics, redaction, reports. Runs unchanged in Node, a Web Worker and Electron's utility process |
| `packages/hafen/cli/` | The command-line runner (`hafen`, `cli/hafen.js`), its Node host, and `pack` |
| `packages/hafen/tests/` | The package's tests (`node --test`): `engine/`, `cli/`, and `fixtures/` (the mock endpoint, suites and providers for it, the JSONPath compliance suite) |
| `app/` | The UI (React). `design/` is Hafen's design system and its additions (check badge, JSON tree, timeline, charts); `views/`; `state.js`; `transfer.js` imports and exports suites; `host.js` connects to the engine; `worker.js` runs it in a browser, on the app's workspace in the browser's private file system |
| `desktop/` | Electron: the window, the engine's utility process, the app's workspace (`<data folder>/workspace`), the dialogs that pick what to import and where to export, and secrets |
| `server/` | The browser build's server (`npm run serve`, `serve.js`) and its relay (`relay.js`), which calls only the endpoints it's allowed |
| `tests/` | The app's tests: `app/` (`node --test`: the app's helpers, the page's bundle, design parity, the relay and `npm run serve`, the desktop app's data carried over); `browser/` and `visual/` (Playwright) |
| `spec/` | The product spec: user stories, data model, contracts, research, and the design system |

## Tests

```sh
npm test               # the package's tests (npm test -w hafen), then the app's (tests/app/)
npm run test:browser   # the app end to end in Chromium, and the desktop app in Electron
npm run test:visual    # the design-system gallery against its baseline screenshots
npm test -w hafen      # only the package's: engine and CLI
```

The mock endpoint (`packages/hafen/tests/fixtures/mock-endpoint.mjs`) answers deterministically, one
scenario per path, so tests are fast, free and repeatable. Its header comment lists every scenario.
`packages/hafen/tests/fixtures/suites/` holds reference suites and providers that use it; the app's
tests use them too.

To check the package installs on its own, pack it and install the file somewhere else:

```sh
npm pack -w hafen                   # hafen-0.1.0.tgz: engine/, cli/ and the README, not the tests
cd /some/empty/folder && npm install /path/to/hafen-0.1.0.tgz && npx hafen --version
```

## Packaging

```sh
npm run app:build      # packages in release/: a .app on macOS, an NSIS installer on Windows, an AppImage on Linux
npm run icons          # icon.png, icon.icns and icon.ico from desktop/icons/source.svg
```

## Screenshots

The README's screenshots are in `docs/screenshots/`, each in light and dark. After a change to the UI,
make them again:

```sh
npm run screenshots
```

This builds the app, runs it in Chromium against a demo support bot and the mock endpoint's judges,
and saves each screen in both themes. It needs no keys and makes no network calls.

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

The engine's JSON Schemas (`packages/hafen/engine/files/schema/`) are kept identical to the spec's
`suite.schema.json` and `provider.schema.json`, and a test checks it.
