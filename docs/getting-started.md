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

Press **Open a folder** in the middle of the window (or the folder icon beside **+** under
**Suites**). Pick an empty folder, or the folder in your repository where your tests will live. Hafen reads and writes plain files there: suites
(`*.hafen.yml`), providers (`providers/*.yml`), and runs (`.hafen/runs/`, which you can git-ignore).

## Add a provider

A provider tells Hafen how to talk to one endpoint. Open **Settings** (the gear at the bottom of the
sidebar) → **Providers** → **new provider**. Choose the kind **HTTP endpoint · one JSON reply**, name
it `mock`, and add it. Then replace its YAML with this (it's saved when you click outside the box):

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

With the conversation open, in the panel under **Save as test**: leave **Suite** on *New suite*, set
**Suite name** to `smoke` and **Test name** to `refund`, and press **Save as test**. `smoke.hafen.yml`
appears in your folder and in the Suites tree, with your two messages as the test's turns, each
starting with one check: `type: status, equals: 200`. The test opens.

## Run it

Press **▷** at the top (or press `⌘↵` on macOS, `Ctrl+Enter` elsewhere). Each turn is sent again, and
a badge appears under each reply, one per check. Both pass.

## Add checks

A turn's response is there once the test has run. Click turn 1's reply. In the panel's **Response**,
click the value `4417` (beside `order.id`), keep `equals`, and press **Add check**. Your file gains
the check under that turn:

```yaml
          - path: $.data.order.id
            equals: 4417
```

It's written in the style of the checks beside it. Comments, key order and formatting in the rest of
the file stay as they were, so `git diff` shows just those lines.

Now click turn 2's reply, open **Checks** in the sidebar, and click **Text**. Turn 2 gains
`contains: text`, and the panel shows it: change its YAML to `contains: refund`.

## Run it again

Press **▷**. The `contains: refund` check on turn 2 fails, because the mock's second reply doesn't say
"refund", and the test shows `failed` in the tree. Click the badge to see why: what it expected,
what the reply was, and the reason (`didn't find refund`).

## Keep the address in a scope

A scope holds the values that change between places you test, such as an address and a key, so the
same files run against each. Click the scope button at the top of the sidebar (greyed out, with a
small **!**: no scope is chosen yet): **Settings → Environments** opens. Type `local` and press **add
scope**, add the value `base_url` = `http://localhost:8791`, and press **choose it**. Then change the
provider's `url` to:

```yaml
url: "{{env.base_url}}/json"
```

Press **▷**: the test runs as before, its address now from the scope. Add a `staging` scope with
another `base_url`, and the scope button swaps between them. A key goes in **Settings → Secrets** the
same way, for a scope (or for every scope), and a provider uses it as `{{secret.NAME}}`: it's kept
encrypted by the system, never in your files. A name the scope hasn't got stops the run before it
sends anything, and says which.

## Run it from the command line

The same file runs unchanged in a terminal or in CI. The provider's address is in the `local` scope
now, so give the command line that scope too: in Settings → Environments, **Export .env** writes
`local.env` (give its path wherever you saved it). Then, from Hafen's folder (where `npm ci` linked
the `hafen` command; anywhere else, `npm install hafen` first):

```sh
npx hafen validate path/to/your/folder --env local.env
npx hafen run path/to/your/folder --env local.env
echo "exit $?"
```

`validate` checks the files without sending anything. `run` prints a line per test and a summary,
and exits `1` here, because a check failed. Without `--env`, both stop before anything is sent (exit
`2`) and say why:

```
providers/mock.yml:3:7  {{env.base_url}} isn't set: no environment is chosen (the app's scope, or --env <file> in the CLI)
```

A scope's secrets go the same way: Settings → Secrets' **Export .env** writes `local.secret.env`
(plain text: keep it out of version control), and `--secret local.secret.env` reads it. A suite's
panel has **Copy CI command**, which names both for the scope chosen.

With no `--report` options, `run` writes a run file to `.hafen/runs/<id>.hafen-run.json` in the
current folder. Open it in the app (**Runs** → open) to see the same conversation, results and
timeline. In CI you'll usually ask for reports instead, such as
`--report junit:results/junit.xml --report md:-` (see [Command line](cli.md#reports)).

## Next

- [Test files](test-files.md): repeats and pass rates, data files, variables, environments.
- [Checks and judges](checks.md): JSONPath operators, tool calls, thinking, and judged checks.
- [Providers](providers.md): connect to your own endpoint, or to OpenAI, Anthropic, Gemini or Ollama.
- [Running in CI](ci.md): run your suites on every pull request.
