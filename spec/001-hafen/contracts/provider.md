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
| `plugin:<name>` | A code plugin |

Any kind can name a [fixture](#fixtures) (`fixture: acme-login`): a plugin that runs first, to log in.

## An HTTP provider

```yaml
# providers/acme-support.yml
kind: http
url: "{{base_url}}/v1/chat"
method: POST
headers:
  Authorization: "Bearer {{token}}"
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
| `url`, `method` (default `POST`), `query` | Templated |
| `headers` | Templated. `${env:…}` values are secrets: redacted everywhere |
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
| `none` | Only this turn's message; no conversation |

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
the raw response and otherwise ignored.

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

In a browser a WebSocket can't carry headers: put credentials in the address or a subprotocol, or
use the relay.

## Presets

A preset is an `http` provider filled in for a known API, with a few options. Anything a preset
sets can be overridden.

| Preset | Options | Notes |
|---|---|---|
| `openai-chat` | `base_url` (default `https://api.openai.com/v1`), `model`, `api_key` (default `${env:OPENAI_API_KEY}`), `params` | Chat Completions, SSE; reads `reasoning_content` / `reasoning` deltas when present (DeepSeek, OpenRouter, vLLM, llama.cpp server). Works with any OpenAI-compatible server |
| `openai-responses` | same | Responses API; thinking is a summary; replays with `previous_response_id` |
| `anthropic-messages` | `model`, `api_key` (default `${env:ANTHROPIC_API_KEY}`), `params` | Messages API, SSE; thinking blocks replayed unchanged in live history; asks for `display: "summarized"` when a test checks thinking |
| `gemini` | `model`, `api_key` (default `${env:GEMINI_API_KEY}`), `params` | `streamGenerateContent`; asks for `includeThoughts` when a test checks thinking |
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
  async *send({ message, history, variables, attachments, settings, transport, signal }) {
    const res = await transport.fetch({
      url: `https://chat.acme.example/v2/turn`,
      method: "POST",
      headers: { authorization: { secret: "ACME_KEY", prefix: "Bearer " } },  // added by the host
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
| `variables` | The test's variables as they are (the environment's, the suite's, `--var`'s, the data row's as `row`, extractions, `run`/`test`/`repeat`), and the chosen scope's plain values as `scope`: no secrets (a `${env:…}` in one stays as written) |
| `attachments` | `{ name, type, bytes }[]` |
| `settings` | The provider's configuration from the suite, its `{{name}}`s filled from those variables (`url: "{{base_url}}/chat"`, `{{scope.region}}`; a whole `{{name}}` keeps its type). Never a secret: a `${env:…}` or a scope's secret stays as written (a header names a secret instead: below) |
| `transport` | `fetch(request)` → `{ status, headers, body, json(), text(), lines(), sse() }`; `websocket(url, options)`. Headers, and values in a JSON body (an object with only `secret` and `prefix?`), can name a secret (`{ secret, prefix? }`), which the host fills in from the turn's scope (a fixture's values first); the plugin never sees its value. Requests outside `hosts` are refused |
| `signal` | Aborts when the run stops or the turn times out |

It yields [TurnEvents](../data-model.md#turnevent) (without `t`: the engine stamps the time) and
`{ type: "raw", value }` for anything it needs back in `history`.

Plugins run in a worker of their own (a Web Worker in the browser build; `worker_threads` in Node,
started with an empty environment, so `process.env` holds nothing) and talk to the engine by
messages (`engine/plugin-worker-core.js`); the same module runs in the app and in CI. A plugin is
one module: it can't import other files (bundle it if it needs to). Its `transport.fetch` requests
are made by the engine: to the plugin's `hosts` only (an exact name, or `*.example.com` for its
subdomains; none named, none reached); a header given as `{ secret, prefix? }` is filled in by the
engine from the chosen scope's secrets (and redacted wherever it shows), so the plugin never holds
the value. A provider plugin's events are its stream: each is kept as a raw JSON line, and the reply
is assembled from them for `on: response` checks. They are trusted code: the guarantee is that they
never hold secret values ([research §22](../research.md#22-plugins)).

Settings → Plugins (in the app) lists the folder's plugins, and makes a new one from a starting file;
a new provider plugin comes with its provider file (`providers/<name>.yml`, `kind: plugin:<name>`, its
other fields given to the plugin as `settings`), so it's in Settings → Providers at once, and used as
any provider is: tried in a conversation, named by a suite or a test. A provider plugin with no
provider file is listed in Providers too, with `add provider`, which makes one.

The folder's plugins (`plugins/*.js`: the app's opened folder, the CLI's current folder) are there for
every suite, used by name: `kind: plugin:acme` (in a suite, or a provider file it names), a judge's
`plugin: acme`, a check's `type: acme`. They're loaded only for a run that uses one. A suite can
name more, in `plugins: [./plugins/acme-provider.js]` (a path from the suite) or as a package name.
A plugin that can't be found or loaded, or whose `version` doesn't satisfy a suite's
`plugin:acme@^1`, is a setup error.

## Fixtures

A provider can name a fixture: a plugin (`kind: "fixture"`) that runs before the provider's first
request, to log in, say, and gives values by name (a session cookie, a CSRF token). Any kind of
provider can name one.

```yaml
# providers/acme.yml
kind: plugin:acme          # or http, websocket, a preset
fixture: acme-login        # or acme-login@^1
url: "{{scope.base_url}}/chat"
login_url: "{{scope.base_url}}/login"
```

```js
// plugins/acme-login.js
export default {
  kind: "fixture",
  name: "acme-login",
  version: "1.0.0",
  hosts: ["auth.acme.example"],
  provides: ["ACME_COOKIE", "ACME_CSRF"],
  async setup({ settings, variables, transport, signal }) {
    const res = await transport.fetch({ url: settings.login_url, method: "POST",
      body: { user: "qa-bot", password: { secret: "ACME_PASSWORD" } }, signal });
    const cookies = [res.headers["set-cookie"] ?? []].flat().map((c) => c.split(";")[0]);
    return { ACME_COOKIE: cookies.join("; "), ACME_CSRF: (await res.json()).csrf_token };
  },
};
```

| `setup` gets | What |
|---|---|
| `settings` | The provider's other fields, as a provider plugin's `settings` are: `{{name}}`s filled in, never a secret |
| `variables` | As a provider plugin's |
| `transport` | As a provider plugin's. A request's `redirect` (`follow`, `manual`, `error`) is passed on; a response's `set-cookie` is a list, one per cookie, where the platform lets it be read (Node: the desktop app and the CLI; a browser doesn't) |
| `signal` | Aborts when the run stops, or after the provider's `timeout_ms` (default 60 s) |

It returns `{ NAME: text }`: every name in `provides`, and no other (with no `provides`, any names).
Names are letters, digits and `_`, not starting with a digit; a value is text (or a number or
boolean, made text), never empty.

What it gives is kept for the run (or the conversation), as secrets of the scope it ran for: files
use them as `${env:NAME}` and `{{scope.NAME}}` (before the host's secrets of the same name), plugins
name them (`{ secret: "NAME" }`, in a header or a JSON body), and each value is redacted wherever it
would show. Nothing is written: the next run logs in again.

- **A run:** each fixture runs once per run and scope, at the start of the first suite whose chosen
  tests use a provider naming it, before that suite's setup steps; it's a `fixture` span under the
  suite. It fails (it throws, times out, or gives the wrong names) as a setup step does: the suite is
  a setup error, nothing more of it is sent, and the CLI exits `2`. Every suite using it after that
  fails the same way.
- **A conversation:** it runs before the first message (a `fixture` span under that turn), again for
  another scope, and again after it failed (that message's turn is an error saying why).
- **Before a run:** the names in a fixture's `provides` count as set (`validate --env-check`, and the
  checks before anything is sent). A fixture that isn't in the folder's or the suite's plugins, a
  plugin that isn't a fixture, or a version outside the range, is a setup error.

A fixture holds what it reads from its login's response: the one place a plugin sees a secret's
value. Like any plugin, it reaches only its `hosts`, and the secrets it sends (a password) it names.
