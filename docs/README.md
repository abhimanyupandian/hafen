# Hafen documentation

Hafen tests chat endpoints end to end: a desktop app to explore an endpoint and build tests, a
browser build of the same app, and a command-line runner for CI. All three run the same engine and
the same test files. The engine and the command line are the `hafen` package, which installs on its
own (`npm install hafen`); the app depends on it.

New to Hafen? Start with [Getting started](getting-started.md).

## Using Hafen

| Page | What's in it |
|---|---|
| [Getting started](getting-started.md) | Install, explore an endpoint, save your first test, run it from the command line |
| [The app](app.md) | The desktop app and the browser build: the layout, exploring, building tests, runs, the timeline, settings, shortcuts |
| [Running in CI](ci.md) | Installing the `hafen` package, a GitHub Actions workflow, a pack, environment and secrets files, baselines and regressions |

## Reference

| Page | What's in it |
|---|---|
| [Test files](test-files.md) | The suite format: tests, turns, variables, environments and secrets, data files, groups, validation |
| [Providers](providers.md) | Connecting to an endpoint: HTTP, streams, WebSocket, presets, A2A agents, logins, conversation history, thinking |
| [Checks and judges](checks.md) | Every check, its operators, System One and LLM judges, confidence and unsure results |
| [Plugins](plugins.md) | Your own providers, checks, judges and login fixtures, in JavaScript, importing any file or package |
| [Command line](cli.md) | `run`, `validate`, `report`, `compare`, `pack`: options, environments and secrets, exit codes, output, reports |

## Working on Hafen

| Page | What's in it |
|---|---|
| [Development](development.md) | How the project is built (the app, and the `hafen` package in `packages/hafen/`), its tests, and how to work on it |
