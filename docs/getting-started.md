# Getting started

This walk-through connects Hafen to a local mock endpoint, sends a few messages, turns them into a
test with checks, and runs that test from the command line. It needs no API keys and costs nothing.

## Install

You need Node 22 or newer, and npm. From Hafen's folder:

```sh
npm ci
```

## Start the mock endpoint

Hafen comes with a small chat endpoint for trying things out. Start it in its own terminal:

```sh
npm run mock          # http://localhost:8791
```

It answers deterministically. A message about a refund gets *"I'm sorry it arrived broken. Could
you tell me why you want a refund for order 4417?"*; anything else gets *"You said: …"*. Each path is
a scenario: `/json` (one JSON reply), `/sse` and `/ndjson` (streams), `/thinking/full`, `/tools`,
`/session`, `/slow?ms=…`, `/error/500`, `/cut` (a stream that stops mid-reply), and more.

## Open the app

```sh
npm run app
```

In the sidebar, open **Suites** and choose **open a folder**. Pick an empty folder, or the folder in
your repository where your tests will live. Hafen reads and writes plain files there: suites
(`*.hafen.yml`), providers (`providers/*.yml`), and runs (`.hafen/runs/`, which you can git-ignore).

## Add a provider

A provider tells Hafen how to talk to one endpoint. Open **Settings** (the gear at the bottom of the
sidebar) → **Providers** → **new provider**. Choose the kind **HTTP endpoint · one JSON reply**, name
it `mock`, and add it. Then replace its YAML with this:

```yaml
# providers/mock.yml
kind: http
url: http://localhost:8791/json
body: { message: "{{user}}", session_id: "{{session}}" }
history: session              # the endpoint keeps the conversation
session:
  extract: $.session_id       # read the session from each reply, send it back next turn
response:
  text: $.data.reply          # where the reply text is
  usage: { input: $.usage.input_tokens, output: $.usage.output_tokens }
```

Press **Try it**. Settings closes and the message box is ready.

## Explore

Send `I want a refund for order 4417`, then `It arrived broken`.

Each reply appears as a message with a stats line under it (time to first token, total time,
tokens). Click a reply: the panel on the right shows the request that was sent and the response as
a JSON tree. The **Timeline** below shows each step of the conversation as a bar.

Try the other scenarios by changing the provider's `url`. For a stream, use `/sse` with
`stream: sse` and an event mapping (see [Providers](providers.md#streamed-responses)); for thinking
and tool calls, `/thinking/full` and `/tools`. Thinking shows collapsed, with its time, and tool
calls show as `↳ lookup_order · …`, in the order they happened.

## Save it as a test

With the conversation open, in the panel: set **Suite** to *New suite…*, name it `smoke`, and press
**Save as test**. `smoke.hafen.yml` appears in your folder and in the Suites tree, with your two
messages as the test's turns.

## Add checks

Select turn 1. In the panel's **Response**, click `order.id`, choose `equals`, keep `4417`, and press
**Add check**. Your file gains one line under that turn:

```yaml
- { path: $.data.order.id, equals: 4417 }
```

Comments, key order and formatting in the file stay as they were, so `git diff` shows just that
line.

Now open **Checks** in the sidebar and click **Text** to add a `contains` check to turn 2. Set it to
`refund`.

## Run it

Press **▷** on the test (or select it and press `⌘↵` on macOS, `Ctrl+Enter` elsewhere). A badge
appears under each reply, one per check. The `contains: refund` check on turn 2 fails, because the
mock's second reply doesn't say "refund", and the test shows `failed` in the tree. Click the badge to
see why.

## Run it from the command line

The same file runs unchanged in a terminal or in CI:

```sh
node cli/hafen.js validate path/to/your/folder
node cli/hafen.js run path/to/your/folder
echo "exit $?"
```

`validate` checks the files without sending anything. `run` prints a line per test and a summary,
and exits `1` here, because a check failed.

With no `--report` options, `run` writes a run file to `.hafen/runs/<id>.hafen-run.json` in the
current folder. Open it in the app (**Runs** → open) to see the same conversation, results and
timeline. In CI you'll usually ask for reports instead, such as
`--report junit:results/junit.xml --report md:-` (see [Command line](cli.md#reports)).

## Next

- [Test files](test-files.md): repeats and pass rates, data files, variables, environments.
- [Checks and judges](checks.md): JSONPath operators, tool calls, thinking, and judged checks.
- [Providers](providers.md): connect to your own endpoint, or to OpenAI, Anthropic, Gemini or Ollama.
- [Running in CI](ci.md): run your suites on every pull request.
