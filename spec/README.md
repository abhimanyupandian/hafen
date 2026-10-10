# hafen specs

Specs for **Hafen**, a standalone project, written in [Spec Kit](https://github.com/github/spec-kit)'s
format: a constitution, then one folder per feature with its spec, plan, research, data model,
contracts, quickstart and tasks. The design system it follows (hafen's UI, written down so other
projects can reuse it) is documented once, in `design/`.

These are design documents, written before the code. Some features they describe were cut later, to
keep Hafen small: the WebSocket and A2A providers, network simulation, load tests, simulated users,
attachments and images in a message, the design-system gallery, and support for the spellings and
data of earlier versions. The JSON schemas in `001-hafen/contracts/` match what Hafen reads today.

| Path | What it is |
|---|---|
| [memory/constitution.md](memory/constitution.md) | Hafen's principles: the UI matches the design system exactly, one engine, files as tests, local-first, honest results, standalone |
| [design/](design/README.md) | A reusable design system, written down from hafen's UI: tokens, layout, components and patterns, how to copy it into another project, and the additions eval needs |
| [001-hafen/](001-hafen/spec.md) | **Hafen**: end-to-end tests for chat endpoints, as a desktop app, a browser build and a CLI for CI. Send messages to any API, see the replies as a conversation, check them (rules, JSONPath, System One, LLM judges, thinking), see every step on a timeline, and run the same test files in CI |

## The Eval feature's files

| File | Spec Kit step | Contents |
|---|---|---|
| [spec.md](001-hafen/spec.md) | specify | User stories (P1–P3), functional requirements, success criteria, edge cases, assumptions |
| [checklists/requirements.md](001-hafen/checklists/requirements.md) | specify | The spec's quality checklist, with its results |
| [research.md](001-hafen/research.md) | plan, phase 0 | Every decision made so far, why, and what else was considered (a standalone project, Go vs JavaScript, Electron vs Wails vs Tauri, CORS and the relay, thinking across providers, …) |
| [data-model.md](001-hafen/data-model.md) | plan, phase 1 | Suites, tests, turns, checks, providers, runs, spans, events, results, and their states |
| [contracts/](001-hafen/contracts/) | plan, phase 1 | The test file (and its JSON Schema), providers and plugins, checks and judges, the CLI, the run file, and the app's UI |
| [plan.md](001-hafen/plan.md) | plan | Technical context, constitution check, where the code goes |
| [quickstart.md](001-hafen/quickstart.md) | plan, phase 1 | Scenarios that show the feature works, end to end |
| [tasks.md](001-hafen/tasks.md) | tasks | Tasks by user story, in order, with what can run in parallel |

## Using Spec Kit's commands with this folder

Spec Kit keeps its own files in `.specify/` and puts features under `specs/` by default. This
repository keeps them in `spec/` instead. To run Spec Kit's steps (clarify, plan, tasks, analyze,
implement) on these files, from the repository's root:

```sh
uv tool install specify-cli
specify init --here --integration claude     # asks before writing into a folder that isn't empty
mkdir -p .specify/memory && cp spec/memory/constitution.md .specify/memory/constitution.md
printf '{ "feature_directory": "spec/001-hafen" }\n' > .specify/feature.json
```

Then run the steps from your coding agent (in Claude Code: `/speckit-clarify`, `/speckit-plan`,
`/speckit-tasks`, `/speckit-analyze`, `/speckit-implement`; the names depend on the integration,
see Spec Kit's integrations reference). `.specify/feature.json` is where Spec Kit's scripts look
for the feature directory when it isn't under `specs/`. Edit the constitution here, in
`spec/memory/`, and copy it again: this copy is the one that's reviewed.
