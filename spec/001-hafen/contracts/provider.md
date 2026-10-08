# Contract: providers and plugins

A provider says how to talk to one endpoint: what to send, how the reply comes back, and where
things are in it. Most endpoints are described by configuration alone
([provider.schema.json](provider.schema.json)); the rest by a code plugin. Either way, the engine
turns what comes back into [TurnEvents](../data-model.md#turnevent).

## Kinds

| `kind` | For |
|---|---|
| `http` | Any HTTP endpoint: one JSON reply, an SSE stream, or a newline-delimited JSON stream |
| `websocket` | Endpoints that chat over a WebSocket |
| `openai-chat`, `openai-responses`, `anthropic-messages`, `gemini`, `ollama` | Presets: an `http` provider filled in for that API |
| `a2a` | An agent speaking the A2A protocol over JSON-RPC, version 1.0 or 0.3 ([A2A agents](#a2a-agents)) |
| `plugin:<name>` | A code plugin |

Any kind can list [fixtures](#fixtures) (`fixtures: { beforeAll: [acme-login] }`): plugins that run
around its requests, to log in first, say.

## An HTTP provider

```yaml
# providers/acme-support.yml
kind: http
url: "{{env.base_url}}/v1/chat"
method: POST
headers:
  Authorization: "Bearer {{secret.ACME_KEY}}"
  X-Client: hafen
body:
  session_id: "{{session}}"
  message: "{{user}}"
history: session              # messages | session | none
session:
  extract: $.session_id       # read from each reply
stream: none                  # none | sse | ndjson
response:
  text: $.reply.text
  thinking: $.reply.reasoning
  tool_calls:
    path: "$.reply.tool_calls[*]"
    name: $.name
    args: $.arguments
    id: $.id
  usage: { input: $.usage.input_tokens, output: $.usage.output_tokens }
  error: $.error.message      # when this matches, the turn is an error with that message
price: { input: 0.5, output: 1.5 }
```

### Request

| Key | Meaning |
|---|---|
| `url`, `method` (default `POST`), `query` | Templated ([variables](test-file.md#variables): `{{env.NAME}}` the environment's, `{{secret.NAME}}` a secret) |
| `headers` | Templated. `{{secret.NAME}}` values are secrets: redacted everywhere |
| `body` | Any value; every string in it is templated. A string that is exactly `{{messages}}` is replaced by the history as a list |
| `secret_headers` | More header names to redact |
| `timeout_ms`, `retries` | Override the test's |

Variables the provider can use besides the test's: `{{user}}` (this turn's message text),
`{{messages}}` (the history in `messages_format`), `{{history}}` (the earlier turns as
`[{ query, response }]`: each turn's message and the reply's text, nothing else), `{{session}}`
(the session value), `{{turn.index}}`. A string that is exactly `{{messages}}` or `{{history}}`
becomes the list itself:

```yaml
body:
  query: "{{user}}"
  history: "{{history}}"    # [{ "query": "my name is ronaldo", "response": "Nice to meet you!" }]
```

### History

| `history` | Sends |
|---|---|
| `messages` | The whole conversation each turn, as `{{messages}}`, shaped by `messages_format`: `openai` (`[{role, content}]`: each earlier turn as its query and its reply's text, not the provider's whole assistant message), `anthropic` (`[{role, content: [blocks]}]`, with earlier blocks replayed unchanged), `gemini` (`[{role, parts}]`) or `text` (one string, `User: …\nAssistant: …`) |
| `session` | Only this turn's message; the endpoint keeps the conversation. `session.extract` reads the session from each reply; `session.send` puts it back (`body`, the default, via `{{session}}`; `header` with `session.name`; or `cookie`) |
| `none` | Only this turn's message; no conversation: `{{messages}}` is this message alone, `{{history}}` is `[]`, the presets and A2A send it alone, and no session goes back (`{{session}}` empty, no `contextId` or `taskId`). In a run and in a conversation (Try it) alike |

The presets in the OpenAI shape (`openai-chat`, `ollama`) send earlier turns the same way: the
user's message and the reply's text, without the thinking or tool calls the reply came with.
`anthropic-messages` and `gemini` replay their own blocks (signed thinking), which their APIs
need for multi-turn tool use; `openai-responses` continues from the last response.

In pinned history (`history: pinned` on a test), the earlier turns' `reply` values stand in for the
endpoint's replies, as plain text, with no thinking or other provider blocks.

### Response, not streamed (`stream: none`)

The body is parsed as JSON when its content type says JSON (or it parses); otherwise it's text,
and `text` defaults to the whole body.

| `response.` | Path to |
|---|---|
| `text` | The reply text (a string, or an array of strings joined) |
| `thinking` | Thinking text; `thinking_visibility` says what kind (default `full`) |
| `tool_calls` | `{ path, name, args, id }`: each call, and its fields relative to it |
| `usage` | `{ input, output, thinking, cached }` token counts |
| `session` | (or `session.extract`) |
| `finish` | Why it ended (`stop`, `length`, …) |
| `error` | When it matches anything, the turn is an error with that value as its message |

### Response, streamed (`stream: sse` or `ndjson`)

Each SSE event's `data` (or each NDJSON line) is parsed as JSON and matched against `events`
rules, in order; the first rule whose `when` matches maps it. An event no rule matches is kept in
the raw response and otherwise ignored. A stream whose events arrived but gave no text, thinking or
tool call (no rule matched, or only usage, done or session rules did) is the turn's error, saying how
many arrived, which rules matched and the first unmatched event, never a blank reply that passes.

```yaml
stream: sse
done_marker: "[DONE]"            # SSE data that ends the stream (else: the connection closing)
events:
  - when: { event: thinking }      # the SSE event name, or { $.type: reasoning_delta }
    thinking: $.delta
  - when: { $.type: text_delta }
    text: $.delta
  - when: { $.type: tool_call }
    tool_call: { name: $.name, args: $.args, id: $.id }
  - when: { $.type: usage }
    usage: { input: $.input_tokens, output: $.output_tokens }
  - when: { $.type: error }
    error: $.message
```

Rule keys: `when` (an SSE `event` name and/or `{ <path>: <value> }` pairs, all of which must
match), then what to read: `text`, `thinking` (+ `thinking_visibility`), `tool_call`,
`tool_result`, `usage`, `session`, `finish`, `error`, `done: true`. Tool-call arguments streamed in
pieces are joined by `id` and parsed when the call ends.

Parsing handles an event or a JSON line split across network chunks, and a stream that ends
without a done marker (it ends when the connection closes; a connection that drops mid-reply is an
error, keeping what arrived).

### Thinking in the text

```yaml
think_tags: ["<think>", "</think>"]
```

Text between the tags becomes thinking (`full`); the rest is the reply. A tag split across chunks
is still found.

### Asking for thinking

```yaml
thinking:
  request: { thinking: { type: adaptive, display: summarized } }   # merged into the body
  visibility: summary
```

Merged into the request body only when the test has a check on thinking, so tests that don't look
at thinking don't pay for it.

### Attachments

```yaml
attachments:
  as: openai-image-url     # openai-image-url | anthropic-blocks | gemini-inline | multipart
  field: files             # for multipart
```

A turn with attachments on a provider without `attachments` is a setup error.

## A WebSocket provider

```yaml
kind: websocket
url: "wss://chat.acme.example/ws?token={{token}}"
protocols: [acme-chat-v2]
send: { type: message, text: "{{user}}", session: "{{session}}" }
events:
  - when: { $.type: delta }
    text: $.text
  - when: { $.type: end }
    done: true
end: { idle_ms: 5000 }     # or a rule with done: true
```

`headers` are sent with the opening handshake on the command line and in the desktop app. In a
browser a WebSocket can't carry headers (and the relay carries only HTTP): a provider with `headers`
fails the turn there, saying so, before it connects; put credentials in the address or a subprotocol.

## Presets

A preset is an `http` provider filled in for a known API, with a few options. Anything a preset
sets can be overridden.

| Preset | Options | Notes |
|---|---|---|
| `openai-chat` | `base_url` (default `https://api.openai.com/v1`), `model`, `api_key` (default `"{{secret.OPENAI_API_KEY}}"`), `params` | Chat Completions, SSE; reads `reasoning_content` / `reasoning` deltas when present (DeepSeek, OpenRouter, vLLM, llama.cpp server). Works with any OpenAI-compatible server |
| `openai-responses` | same | Responses API; thinking is a summary; replays with `previous_response_id` |
| `anthropic-messages` | `model`, `api_key` (default `"{{secret.ANTHROPIC_API_KEY}}"`), `params` | Messages API, SSE; thinking blocks replayed unchanged in live history; asks for `display: "summarized"` when a test checks thinking |
| `gemini` | `model`, `api_key` (default `"{{secret.GEMINI_API_KEY}}"`), `params` | `streamGenerateContent`; asks for `includeThoughts` when a test checks thinking |
| `ollama` | `base_url` (default `http://localhost:11434`), `model`, `api_key` (none by default; sent as a bearer token when set, for ollama.com or a proxy), `params` (`options`, `think`, `format`, `keep_alive`, `tools`) | `POST /api/chat`, newline-delimited JSON; `message.thinking` pieces are full thinking (asks for `think: true` when a test checks thinking); tool calls arrive whole; tokens from `prompt_eval_count` / `eval_count`. In the browser build Ollama refuses web pages unless `OLLAMA_ORIGINS` allows the app's origin, or the relay is used |

```yaml
provider:
  kind: anthropic-messages
  model: claude-opus-5-5
  params: { max_tokens: 4096 }
```

```yaml
# providers/ollama.yml
kind: ollama
model: gemma4
params: { options: { temperature: 0 } }
```

The presets' event mappings are listed in [research §11](../research.md#11-one-event-model-for-every-provider)
and checked against each API's current documentation when written.

## A2A agents

`kind: a2a`: an agent speaking the [A2A protocol](https://a2a-protocol.org) (Agent2Agent) over its
JSON-RPC binding, in version 1.0 (the spec's v1.0.0; `A2A-Version: 1.0` on every request; methods
`SendMessage` and `SendStreamingMessage`; `ROLE_USER`, `TASK_STATE_…`; parts told apart by their
field, `{ text }`; results wrapped: `{ task }`, `{ message }`, `{ statusUpdate }`, `{ artifactUpdate }`)
or 0.3 (no version header; `message/send` and `message/stream`; `kind` on every object; `user`,
`completed`; `final: true` on the last status update).

| Key | Meaning |
|---|---|
| `card` | Where the agent card is: an address (`/.well-known/agent-card.json` is read there) or the card's URL. Read once per provider. 1.0: the first of `supportedInterfaces` whose `protocolBinding` is `JSONRPC` (its `url`, its `protocolVersion`); 0.3: `url` when `preferredTransport` is `JSONRPC` (or absent), else `additionalInterfaces`' `JSONRPC` one, and `protocolVersion`. `capabilities.streaming` says whether it streams. A card with no JSON-RPC interface is an error saying so |
| `url` | The JSON-RPC endpoint; with it, no card is read |
| `version` | `1.0` (default) or `0.3` (any `0.x`); with a card and no `version`, the card's |
| `streaming` | `true`: the streaming method (an SSE response; each `data:` a JSON-RPC response); `false`: the other. Default: the card's `capabilities.streaming`, else `true`. A streaming request answered with JSON (an error) is read as one answer |
| `headers` | Templated; sent with every request (the card's too) |
| `configuration`, `metadata` | Sent as `params.configuration` and `params.metadata` |

Each turn sends one message: `{ messageId, role, parts: [text part] }`, with the `contextId` the agent
gave last (the agent makes one when it's missing) and, while its task is `input-required` or
`auth-required`, that task's `taskId`. Earlier turns aren't sent: the agent keeps the conversation.

As TurnEvents: an artifact's text parts are `text` (a new artifact after earlier text starts with a
blank line; `append` adds to the artifact); a Message's text parts are `text`; a status update whose
state is `working` or `submitted`, with a message, is `thinking` (visibility `progress`, one line each).
When the task ends, the last status message is text too when it's interrupted (the agent's question),
or when nothing else was said. `failed`, `rejected` and `canceled` are an `error` (`the task failed:
<its message>`); a JSON-RPC error is an `error` naming its code (`A2A error -32001 (TaskNotFound): …`);
an answer with no task or message is an `error`. `done`'s `finish` is the state (`completed`,
`input-required`, …), or `message`. The assembled response's `last` is the final Task (its last
status, its artifacts gathered by `artifactId`) or Message, as the agent spelled it. File and data
parts aren't part of the reply; they're in `last`.

Not built: the gRPC and HTTP+JSON bindings, file parts in what's sent, push notifications, the
authenticated extended card, `SubscribeToTask` / `tasks/resubscribe`.

## Code plugins

For endpoints configuration can't describe. A plugin is an ES module whose default export is:

```js
// plugins/acme-provider.js
export default {
  kind: "provider",
  name: "acme",
  version: "1.0.0",
  hosts: ["chat.acme.example"],          // the only hosts its transport will reach

  // Send one turn. Yield events as they arrive; throw to report an error.
  async *send({ message, history, variables, env, attachments, settings, transport, signal }) {
    const res = await transport.fetch({
      url: `https://chat.acme.example/v2/turn`,
      method: "POST",
      headers: { authorization: "Bearer {{secret.ACME_KEY}}" },  // filled in by the engine as it leaves
      body: { text: message, history: history.map((t) => ({ q: t.user, a: t.reply })) },
      signal,
    });
    for await (const line of res.lines()) {
      const data = JSON.parse(line);
      if (data.kind === "token") yield { type: "text", text: data.value };
      if (data.kind === "end") yield { type: "usage", output: data.tokens };
    }
    yield { type: "done" };
  },
};
```

| `send` gets | What |
|---|---|
| `message` | This turn's message, variables resolved |
| `history` | Earlier turns: `{ user, reply, thinking, tool_calls, raw }[]` (`raw`: what the plugin yielded as `{ type: "raw", value }`, for replay) |
| `variables` | The test's variables as they are (the suite's environment's, the suite's, `--var`'s, the data row's as `row`, extractions, `run`/`test`/`repeat`): no secrets (a `{{secret.…}}` in one stays as written) |
| `env` | The chosen environment's values (the values passed, over the suite's `environments.<name>`), as written: never a secret |
| `attachments` | `{ name, type, bytes }[]` |
| `settings` | The provider's configuration from the suite, its `{{name}}`s filled from those variables and `{{env.NAME}}` from the environment (`url: "{{env.base_url}}/chat"`; a whole `{{name}}` keeps its type; an `{{env.NAME}}` the environment hasn't is an error). Never a secret: a `{{secret.NAME}}` stays as written, and is filled in when a request has it (below) |
| `transport` | `fetch(request)` → `{ status, headers, body, json(), text(), lines(), sse() }`; `websocket(url, options)`. The engine fills in each `{{secret.NAME}}` and `{{env.NAME}}` in a request's address, its headers' values and its body (every text in it, deeply) as it leaves, from the turn's scope (a fixture's values first); the plugin never sees a secret's value. Not inside what the call was given from elsewhere (a message, the history, a reply, a check's value, an extraction or a data row's value): a reply that says `{{secret.ACME_KEY}}` is sent on as it was. One that isn't set fails the request, saying which (`{{secret.ACME_KEY}} isn't set for the scope "stage"`). (The old way, a header or a JSON body's value naming one, `{ secret: "ACME_KEY", prefix: "Bearer " }`, is a problem where the plugin's code writes it; one it builds as it runs fails the request, saying the new way.) Requests outside `hosts` are refused |
| `signal` | Aborts when the run stops or the turn times out |

It yields [TurnEvents](../data-model.md#turnevent) (without `t`: the engine stamps the time) and
`{ type: "raw", value }` for anything it needs back in `history`.

Plugins run in a worker of their own (a Web Worker in the browser build; `worker_threads` in Node,
started with an empty environment, so `process.env` holds nothing) and talk to the engine by
messages (`engine/plugin-worker-core.js`); the same module runs in the app and in CI. Where the host
loads a plugin from its file (Node: the desktop app and the CLI), it imports other files and packages
as any module does, wherever they are (only the plugin's own file must be among the suites' files), and
what it imports runs in its worker; in the browser build a plugin is one module, and one that imports
anything says so when it loads ("use the desktop app or the CLI, or bundle it"). Its `transport.fetch` requests
are made by the engine: to the plugin's `hosts` only (an exact name, or `*.example.com` for its
subdomains; none named, none reached; an address's `{{env.NAME}}` is filled in first); a
`{{secret.NAME}}` in one is filled in by the engine from the chosen scope's secrets (and redacted
wherever it shows), so the plugin never holds the value. Before a run, each `{{secret.NAME}}` and
`{{env.NAME}}` a plugin's code writes is checked as the files' are, said where its file has it (each
`{ secret: "NAME" }`, the old way, is a problem there, saying the new way:
[test-file.md](test-file.md#old-spellings)); a name it builds as it runs can't be, and is said when its request fails. A provider plugin's events are its stream: each is kept as a raw JSON line, and the reply
is assembled from them for `on: response` checks. They are trusted code: the guarantee is that they
never hold secret values ([research §22](../research.md#22-plugins)). It's no sandbox: `hosts` limits
`transport.fetch` only. The worker's own `fetch`, `WebSocket`, `XMLHttpRequest` and `EventSource`
are taken away (`engine/plugin-worker-core.js`), so one used by mistake throws `a plugin has no fetch
(use transport.fetch: it's the one that reaches the plugin's hosts)` rather than going around
`hosts`; but in Node (the desktop app and the CLI) a plugin can still import `node:fs` and read files,
or `node:http` and reach the network its own way.

Settings → Plugins (in the app) lists the folder's plugins, and makes a new one from a starting file;
a new provider plugin comes with its provider file (`providers/<name>.yml`, `kind: plugin:<name>`, its
other fields given to the plugin as `settings`), so it's in Settings → Providers at once, and used as
any provider is: tried in a conversation, named by a suite or a test. A provider plugin with no
provider file is listed in Providers too, with `add provider`, which makes one.

The folder's plugins (`plugins/*.js`: the app's workspace; the CLI's current folder, and each folder it's given) are there for
every suite, used by name: `kind: plugin:acme` (in a suite, or a provider file it names), a judge's
`plugin: acme`, a check's `type: acme`. They're loaded only for a run that uses one. A suite can
name more, in `plugins: [./plugins/acme-provider.js]` (a path from the suite) or as a package name.
A plugin that can't be found or loaded, or whose `version` doesn't satisfy a suite's
`plugin:acme@^1`, is a setup error.

## Fixtures

A provider can list fixtures: plugins (`kind: "fixture"`) that run around its requests, by when, each
list in its order. Any kind of provider can list them.

```yaml
# providers/acme.yml
kind: plugin:acme          # or http, websocket, a preset, a2a
url: "{{env.base_url}}/chat"
login_url: "{{env.base_url}}/login"
fixtures:
  beforeAll: [acme-login]  # a name may take a version range: acme-login@^1
  before: [reset-cart]
  after: [clear-cart]
  afterAll: [acme-logout]
```

| List | Runs |
|---|---|
| `beforeAll` | Once per run and scope: at the start of the first suite whose chosen tests use the provider, before that suite's setup steps (a `fixture` span under the suite). Later suites reuse it |
| `before` | Before each instance of a test that uses the provider (each repeat and data row), before its setup steps (a span under the instance) |
| `after` | After each instance, after its teardown steps, however it ended; given the instance's status (a span under the instance) |
| `afterAll` | Once per run and scope, for each provider the run used, when the run ends (done, stopped or broken): a span under the run |

In a conversation: `beforeAll` and `before` run before the first message (spans under that turn);
`beforeAll` again for another scope, and either again after it failed (that message's turn is an error
saying why) or said to stop (that message is refused: below); `after` and `afterAll` when the
conversation is let go (another opened or started).

The key `fixture:` (one name, before the lists) is no longer read: a provider that has it has a
problem saying to use `fixtures: { beforeAll: [name] }`. A list that isn't one of the four, a list
that isn't names, a name that isn't a plugin in the folder's or the suite's plugins, a plugin that
isn't a fixture, a version outside its range, a fixture a list names twice (`acme-login` and
`acme-login@^1` are one; another list can name it), or a fixture in a list its `phases` leave out
(`the fixture "acme-login" runs only in beforeAll and afterAll: it can't be in fixtures.after`): a
setup error before anything's sent, said of the provider's file at that name in its list
(`fixtures.<list>[i]`).

```js
// plugins/acme-login.js
export default {
  kind: "fixture",
  name: "acme-login",
  version: "1.0.0",
  hosts: ["auth.acme.example"],
  phases: ["beforeAll"],
  provides: ["ACME_COOKIE", "ACME_CSRF"],
  async run({ phase, settings, variables, env, test, transport, signal }) {
    const res = await transport.fetch({ url: settings.login_url, method: "POST",
      body: { user: "qa-bot", password: "{{secret.ACME_PASSWORD}}" }, signal });
    if (res.status === 503) return false;
    const cookies = [res.headers["set-cookie"] ?? []].flat().map((c) => c.split(";")[0]);
    const { csrf_token, region } = await res.json();
    if (region) env.set("ACME_REGION", region);
    return { ACME_COOKIE: cookies.join("; "), ACME_CSRF: csrf_token };
  },
};
```

Its method is `run()` (`setup()`, its first name, is still read).

| Field | What |
|---|---|
| `phases` | The lists it can be in: a non-empty list of `beforeAll`, `before`, `after`, `afterAll` (default all four). Anything else (not a list, empty, another name) fails its load: `its phases is a list of when it runs: any of beforeAll, before, after, afterAll, and "beforeEach" isn't one`. Its meta has them in the lists' order, each once. The engine calls `run()` only for these |
| `provides` | The names it gives (below) |
| `sets` | The environment's names it sets with `env.set` that its code doesn't write as `env.set("NAME", …)` (a name it builds): for the check before a run. Names, by the one rule |

Its meta (the worker's `loaded`, and serve-port's `load` and `plugins` lists) is `{ kind, name,
version, hosts, provides, phases, sets }`; the lists' `sets` are its own `sets` and the names its code
writes as `env.set("NAME", …)` (`env?.set`, any quotes), found in its text.

| `run` gets | What |
|---|---|
| `phase` | `beforeAll`, `before`, `after` or `afterAll` (one of its `phases`) |
| `settings` | The provider's other fields (not `fixtures`), as a provider plugin's `settings` are: `{{name}}`s filled in, never a secret; an `{{env.NAME}}` not set (yet: one a fixture sets) stays as written |
| `variables` | As a provider plugin's |
| `env` | The environment's values as a provider plugin's `env`, with what fixtures have set so far over them, and a method `set(NAME, value)` (not enumerable; a value of the environment named `set` is behind it) |
| `test` | `before` and `after`: `{ name, id?, repeat, row?, row_name? }` (`row_name`: the data row's name, [test-file.md](test-file.md#data-rows)), and in `after` its `status` |
| `transport` | As a provider plugin's. A request's `redirect` (`follow`, `manual`, `error`) is passed on; a response's `set-cookie` is a list, one per cookie, where the platform lets it be read (Node: the desktop app and the CLI; a browser doesn't) |
| `signal` | Aborts when the run stops, or after the provider's `timeout_ms` (default 60 s) |

What it returns: nothing (`undefined`, `null`) or `true`, go on; `false`, stop (below); `{ NAME: text }`,
go on with those values. In `beforeAll` and `before` the values are every name in `provides`, and no
other (with no `provides`, any names; nothing returned, or `true`, is no names). Names follow the one
rule for names (`engine/env-file.js`, `NAME`): letters, digits, `_`, `.` and `-`, not starting with a
digit; a value is text (or a number or boolean, made text), never empty. Anything else (a string, a
list) fails it: `its run() returns the values it gives, by name ({ ACME_COOKIE: "…" }), true or
nothing to go on, or false to stop`. What `after` and `afterAll` return is ignored, but `false`,
which is recorded.

`false` (its reason: `the fixture "acme-login" (beforeAll) said to stop`):
- `beforeAll`: the fixtures after it in the list don't run, and the run stops (`status: "stopped"`,
  `stopped` that reason; the CLI exits `3`) before this suite's setup steps: each of its chosen tests
  is `skipped` with `reason` that reason (JUnit's `<skipped message>`, the Markdown's Skipped), and
  the suites the run hadn't reached are `(not run)` cases (`not run: <reason>`). The suite's span is
  `skipped`; `afterAll` fixtures run as ever.
- `before`: the fixtures after it don't run; that instance is `stopped` with that `reason` (its setup
  steps and turns don't run: each turn `skipped` with that reason, its checks too; its `after`
  fixtures run, told `status: "stopped"`), the other instances and tests go on. The test is `stopped`
  (its `reason` the instance's) unless what went wrong already rules out its pass rate.
- `after`, `afterAll`: nothing changes.
- A conversation: `false` in `beforeAll` or `before` refuses the message: nothing is sent, its turn
  is `{ user, skipped: <reason>, reply: "" }` (its span `skipped`), it isn't part of the history the
  next message goes with, and they run again with the next message.

`env.set(NAME, value)` (any phase) sets one of the environment's values for the rest of the run, in
its scope (`{{env.NAME}}`: before the values passed and the suite's `environments.<name>`; with no
environment chosen too), and in a conversation for that conversation and scope until it's let go.
Requests, checks, judges, plugins' `env` and later fixtures have it. It's kept by the run's fixtures
(engine/fixtures.js) as an overlay on its scopes, applied only when `run()` returns (one that throws
sets nothing), never written (not to a file, the host's store, the environment passed, or
run.settings), and gone when the run ends. A value set isn't a template (its `{{…}}` aren't filled)
and isn't a secret (redacted only when it's one's value). The `env` run() was given shows what it set
at once. A name that breaks the rule, or a value that isn't text, number or boolean, fails the fixture:
`env.set: "1x" isn't a name (…)`, `env.set("x", …) takes text (a number or true/false is made text)`.

Before a run, an `{{env.NAME}}` a provider's `beforeAll` or `before` fixture sets counts as set (in the
suite's files and its plugins' code): the names its code writes as `env.set("NAME", …)`, and its
`sets`.

What `beforeAll` gives is kept for the run, as secrets of the scope it ran for; what `before` gives,
for that instance (its names over `beforeAll`'s). Files and plugins' requests use them as
`{{secret.NAME}}` (before the host's secrets of the same name), and each value is redacted wherever it would show: from the
moment it's given (a fixture's calls' requests and responses, headers and bodies, are kept back until
then, the status shown as each ends: so the token a login answered with is redacted in its own call's
step, and in a call the fixture made with it). A value written `<scheme> <credential>` (`Bearer
tok_…`) is two secrets: itself, and the credential, as the login's answer has it
(`{"access_token":"[redacted]"}`). Nothing is written: the next run runs them again.

When one fails (it throws, times out, or gives the wrong names):
- `beforeAll`: the suite is a setup error (`<suite>: the fixture "acme-login" (beforeAll) failed: …`),
  nothing more of it is sent, and the CLI exits `2`. The lists after it don't run; every suite using
  it after that fails the same way.
- `before`: that instance is an error (its setup steps and turns don't run; its `after` fixtures do);
  the other tests go on.
- `after`, `afterAll`: no result changes (as a teardown step's); it's in the instance's
  `after_errors`, and in run.fixtures, the timeline, the console, the CLI's output and the reports.

Before a run, the names in `provides` of a provider's `beforeAll` and `before` fixtures count as set
(`validate --env-check`, and the checks before anything is sent).

Each fixture that runs is recorded in the run (run.fixtures: `{ name, phase, provider?, test?,
status: "ok" | "error", ms, provides: [names], sets?: [names it set with env.set], stop?: true (it
returned false), calls, error? }`), told as it ends (`fixture:end`), and is a `fixture` span (its
`fixture: { name, phase, provider }`, its metrics' `provides`, `sets`, `stop` and `calls`, its
`error`). The console says one that failed or said to stop without `--verbose`; JUnit's and the
Markdown's fixture lines add `said to stop` and `set NAMES`.

A fixture holds what it reads from its login's response: the one place a plugin sees a secret's
value. Like any plugin, it reaches only its `hosts`, and the secrets it sends (a password) it names.

## Plugins' calls

Every HTTP call a plugin makes through `transport` (a provider's, a fixture's, a check's, a judge's)
is a `call` span under what made it (the turn's request, the fixture, the check, the judge call): its
`plugin` (`fixture acme-login`), its `request` (`{ method, url, headers, body? }`, as sent: secrets
filled in, so redacted with the run), its `response` (`{ status, headers, body? }`: the body's first
64 kB) or its `error`. A call to a host the plugin doesn't name is a `call` span too, an error saying
so. The request the engine makes is tagged with its plugin (`via: "fixture:acme-login"`) for the app's
log.
