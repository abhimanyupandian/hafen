# Tests

The app's tests are here. The `hafen` package's (the engine and the CLI) are in its own folder,
[`packages/hafen/tests/`](../packages/hafen/tests/), so it's tested on its own: `npm test` runs both.

| Folder | What | Run |
|---|---|---|
| `../packages/hafen/tests/engine/` | The engine: schemas, variables, environments and secrets (`KEY=VALUE` files, `{{env.…}}`, `{{secret.…}}`), JSONPath (with the RFC 9535 compliance suite), streams, transport, spans, redaction, files, checks, providers and presets, the runner and judges; and that the package imports nothing from outside it | `npm test` (or `npm test -w hafen`) |
| `../packages/hafen/tests/cli/` | The CLI: exit codes, validate, `--env` and `--secret` files, reports, compare, cancelling, pack | `npm test` (or `npm test -w hafen`) |
| `../packages/hafen/tests/fixtures/` | The mock endpoint (`npm run mock`), suites and providers for it, recorded streams, the JSONPath compliance suite. The app's tests use them too | |
| `app/` | The app's own code (`node --test`): its helpers, what the page's bundle reaches, the relay and `npm run serve`; and that the app reaches the engine only as the `hafen` package | `npm test` |
| `browser/` | The app end to end in Chromium (through the relay, its workspace in the browser's private file system, filled before the app loads: `fixtures.js`), and the desktop app in Electron (its workspace in a data folder of the test's own, `HAFEN_LAB_DATA`). `getting-started.spec.js` follows [Getting started](../docs/getting-started.md) step by step: change the two together | `npm run test:browser` |

Everything runs against the mock endpoint: no keys, no network, no cost.
