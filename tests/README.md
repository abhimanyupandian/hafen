# Tests

| Folder | What | Run |
|---|---|---|
| `engine/` | The engine: schemas, variables, JSONPath (with the RFC 9535 compliance suite), streams, transport, spans, redaction, files, checks, providers and presets, the runner and judges; and parity with hafen's design system | `npm test` |
| `cli/` | The CLI: exit codes, validate, reports, compare, cancelling, the relay | `npm test` |
| `browser/` | The app end to end in Chromium (through the relay, with a folder in the browser's private file system), and the desktop app in Electron | `npm run test:browser` |
| `visual/` | The design-system gallery, in both themes, against `visual/snapshots/` | `npm run test:visual` (`--update-snapshots` after a change made on purpose) |
| `fixtures/` | The mock endpoint (`npm run mock`), suites and providers for it, recorded streams, the JSONPath compliance suite | |

Everything runs against the mock endpoint: no keys, no network, no cost.
