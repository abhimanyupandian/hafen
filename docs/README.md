# Hafen documentation

Hafen tests chat endpoints end to end: a desktop app to explore an endpoint and build tests, a
browser build of the same app, and a command-line runner for CI. All three run the same engine and
the same test files.

New to Hafen? Start with [Getting started](getting-started.md).

## Using Hafen

| Page | What's in it |
|---|---|
| [Getting started](getting-started.md) | Install, explore an endpoint, save your first test, run it from the command line |
| [The app](app.md) | The desktop app and the browser build: the layout, exploring, building tests, runs, the timeline, settings, shortcuts |
| [Running in CI](ci.md) | A GitHub Actions workflow, secrets, baselines and regressions |

## Reference

| Page | What's in it |
|---|---|
| [Test files](test-files.md) | The suite format: tests, turns, variables, environments and scopes, data files, groups, validation |
| [Providers](providers.md) | Connecting to an endpoint: HTTP, streams, WebSocket, presets, conversation history, thinking |
| [Checks and judges](checks.md) | Every check, its operators, System One and LLM judges, confidence and unsure results |
| [Plugins](plugins.md) | Your own providers, checks and judges, in JavaScript |
| [Command line](cli.md) | `run`, `validate`, `report`, `compare`, `serve`: options, exit codes, output, reports |

## Working on Hafen

| Page | What's in it |
|---|---|
| [Development](development.md) | How the project is built, its tests, and how to work on it |
