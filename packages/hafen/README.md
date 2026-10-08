# hafen

End-to-end tests for chat endpoints, from the command line: the engine and the CLI of
[Hafen](https://github.com/abhimanyupandian/hafen). It runs the suite files the Hafen app builds
(`*.hafen.yml`) unchanged, so the tests you build in the app run in CI. No Electron, React or
browser: Node 22 or newer, and three small dependencies.

## Install

**TODO: not published to npm yet.** Until it is, make the package from a clone of Hafen's
repository (`npm pack -w hafen` there gives `hafen-0.1.0.tgz`) and install that file:

```sh
npm install --save-dev ./hafen-0.1.0.tgz     # once published: npm install --save-dev hafen
npx hafen --help
```

`rolldown` is an optional dependency, used only by `pack`. Leave it out with `--omit=optional` for
the smallest install: everything else works without it.

## Run

```sh
npx hafen run tests/ --env staging.env --secret staging.secret.env \
  --report junit:results/junit.xml --report run:results/run.hafen-run.json
```

| Command | What it does |
|---|---|
| `hafen run [paths…]` | Runs suites (files, or folders searched for `*.hafen.yml`), prints a line per test, writes reports (`junit`, `run`, `md`, `json`), compares with a `--baseline` |
| `hafen validate [paths…]` | Checks suites without sending anything (`--env-check`: every value and secret set) |
| `hafen report <run-file>` | Writes reports from a run file |
| `hafen compare <run-file> --baseline <run-file>` | Compares two runs; exit `1` on a regression |
| `hafen pack [paths…] -o <file.mjs>` | Packs suites and everything they need into one file that runs them with Node alone |

Exit codes: `0` passed · `1` a test failed (or regressed) · `2` a setup error (nothing was sent) ·
`3` stopped early (`--max-cost`, `--bail`, cancelled).

## Environments and secrets

`{{env.NAME}}` in a suite or provider file is a value of the environment, `{{secret.NAME}}` a
secret. Both come from `KEY=VALUE` files you name, anywhere on the disk:

- `--env staging.env`: the environment's values (fine to commit). Its name, `staging`, picks each
  suite's environment of that name.
- `--secret staging.secret.env`: the secrets (never commit it). A name it hasn't comes from the
  environment variable of that name, so CI's secrets work as environment variables too.

Both can be given as often as you like: the files' values are merged in order, a later file's
winning, and the last `--env` names the environment. Values every environment shares go first:

```sh
npx hafen run tests/ --env globals.env --env staging.env \
  --secret globals.secret.env --secret staging.secret.env
```

`--env staging` (a name, no file) picks each suite's environment of that name, with no values: a
folder's `environments/staging.yml` isn't read. The old spellings, `${env:NAME}`, `{{scope.NAME}}`
and a plugin's `{ secret: "NAME" }`, are problems (exit `2`, nothing sent), each saying what to write
instead: `{{secret.NAME}}`, or `{{env.NAME}}` for a value of the environment.

Secrets are redacted from the output, every report and every run file: every value in the
`--secret` files, used or not. In the app, a suite's
**Copy CI command** gives the `npx hafen run …` line, and Settings → Environments and Secrets export
the two files.

## Documentation

In Hafen's repository: [Command line](https://github.com/abhimanyupandian/hafen/blob/master/docs/cli.md),
[Running in CI](https://github.com/abhimanyupandian/hafen/blob/master/docs/ci.md),
[Test files](https://github.com/abhimanyupandian/hafen/blob/master/docs/test-files.md),
[Providers](https://github.com/abhimanyupandian/hafen/blob/master/docs/providers.md),
[Checks and judges](https://github.com/abhimanyupandian/hafen/blob/master/docs/checks.md),
[Plugins](https://github.com/abhimanyupandian/hafen/blob/master/docs/plugins.md).

The engine is importable too (`import { loadSuite, runSuites } from "hafen"`, or a module by its
path, `hafen/engine/<module>.js`): it's what the Hafen app runs.
