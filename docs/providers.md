# Providers

A provider says how to talk to one endpoint: what to send, how the reply comes back, and where
things are in it. Most endpoints need only a few lines of YAML. For the rest, write a
[plugin](plugins.md).

Providers are usually files in `providers/`, named by suites (`provider: providers/acme.yml`). The
app's Settings → Providers lists them, makes new ones from a starting file, and lets you **Try it**
in a conversation.

| `kind` | For |
|---|---|
| `http` | Any HTTP endpoint: one JSON reply, an SSE stream, or a newline-delimited JSON stream |
| `openai-chat`, `openai-responses`, `anthropic-messages`, `gemini`, `ollama` | [Presets](#presets) for those APIs |
| `plugin:<name>` | A [provider plugin](plugins.md#provider-plugins) |

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
price: { input: 0.5, output: 1.5 }   # USD per million tokens
```

### The request

| Key | Meaning |
|---|---|
| `url`, `method` (default `POST`), `query` | Templated with [variables](test-files.md#variables): `{{env.NAME}}` is a value of the environment, `{{secret.NAME}}` a secret |
| `headers` | Templated. A `{{secret.NAME}}` in one is a secret, redacted everywhere |
| `body` | Any value. Every string in it is templated |
| `secret_headers` | More header names to redact (`Authorization`, `Cookie`, `X-Api-Key` and the like always are). The value is hidden wherever it shows, as a secret's is: in a reply that echoes it too |
| `timeout_ms`, `retries` | This provider's turns' timeout and retries. A suite's `defaults` and a test's own settings win over them ([Test keys](test-files.md#test-keys)) |

A secret is redacted in the forms it takes on the way, too: escaped in the JSON `body`, form-encoded
in the `query` (`q k&v` as `q+k%26v`), percent-encoded in an address, in base64 (`Basic …`). So is a
reply or a raw stream that echoes it in one of them, even split across the stream's chunks. Every
secret kept for the run's scope is, whether this provider sends it or not (the app's for the scope,
the command line's `--secret` files'). (A value shorter than 4 characters isn't redacted: it would
be cut out of ordinary words and numbers.)


A provider can also use:

| Variable | Is |
|---|---|
| `{{user}}` | This turn's message |
| `{{messages}}` | The conversation so far, shaped by `messages_format` (with `history: messages`; with `history: none`, this turn's message alone) |
| `{{history}}` | The earlier turns as `[{ query, response }]`: each message and its reply's text (`[]` with `history: none`) |
| `{{session}}` | The session value |
| `{{turn.index}}` | The turn's number |

A string that is exactly `{{messages}}` or `{{history}}` becomes the list itself:

```yaml
body:
  query: "{{user}}"
  history: "{{history}}"    # [{ "query": "my name is ronaldo", "response": "Nice to meet you!" }]
```

### Conversation history

| `history` | Each turn sends |
|---|---|
| `messages` | The whole conversation, as `{{messages}}`, shaped by `messages_format`: `openai` (`[{role, content}]`), `anthropic` (`[{role, content: [blocks]}]`), `gemini` (`[{role, parts}]`) or `text` (one string, `User: …\nAssistant: …`) |
| `session` | Only this turn's message; the endpoint keeps the conversation. `session.extract` reads the session from each reply, and `session.send` puts it back: in the `body` (the default, via `{{session}}`), a `header` (with `session.name`), or a `cookie` |
| `none` | Only this turn's message, with no conversation: `{{messages}}` is that message alone, `{{history}}` is `[]`, and no session goes back (`{{session}}` is empty). The presets send it alone too, and so does a conversation in the app |

### Responses (not streamed)

With `stream: none`, the body is parsed as JSON when it is JSON; otherwise it's text, and the reply
text is the whole body.

| `response.` | Path to |
|---|---|
| `text` | The reply text (a string, or an array of strings, joined) |
| `thinking` | Thinking text. `thinking_visibility` says what kind (`full` by default, or `summary`, `omitted`, `redacted`) |
| `tool_calls` | `{ path, name, args, id }`: each call, and its fields relative to it |
| `usage` | `{ input, output, thinking, cached }` token counts |
| `session` | The session value (or use `session.extract`) |
| `finish` | Why it ended (`stop`, `length`, …) |
| `error` | When it matches anything, the turn is an error with that value as its message |

### Streamed responses

With `stream: sse` or `stream: ndjson`, each SSE event's `data` (or each JSON line) is parsed and
matched against the `events` rules, in order. The first rule whose `when` matches maps it.

```yaml
stream: sse
done_marker: "[DONE]"              # SSE data that ends the stream (else: the connection closing)
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

A rule's `when` takes an SSE `event` name and/or `{ <path>: <value> }` pairs, all of which must
match. Then it says what to read: `text`, `thinking` (with `thinking_visibility`), `tool_call`,
`tool_result`, `usage`, `session`, `finish`, `error`, or `done: true`. An event no rule matches is
kept in the raw stream and otherwise ignored. But when events arrive and no rule matches any of
them, the turn is an error rather than a blank reply, saying how many came and showing the first:

```
12 events arrived, and none matched the provider's events rules (the first: {"type":"text_delta","delta":"Sure, "}): check events[].when
```

So is a stream whose rules matched only events that don't give the reply (a `usage` or `done`
rule's) when the provider has a rule for `text`, `thinking` or `tool_call`: that rule's `when` or
path is wrong. The error says what matched and shows the first event that didn't:

```
12 events arrived; the rules matched 1 (usage) but none gave text, thinking or a tool call (the first unmatched: {"type":"text_delta","delta":"Sure, "}): check the text rule's when (events[].when)
```

A reply that is only a tool call, or only thinking, is fine; so is an empty text that the rule's
path found (`"content": ""`).

Tool-call arguments streamed in pieces are joined by `id`. Events split across network chunks are
put back together. A stream that ends without a done marker ends when the connection closes; a
connection that drops mid-reply is an error that keeps what arrived.

### Thinking

When thinking comes inside the text, between tags, split it out:

```yaml
think_tags: ["<think>", "</think>"]
```

To ask the endpoint for thinking only when a test checks it (so other tests don't pay for it):

```yaml
thinking:
  request: { thinking: { type: adaptive, display: summarized } }   # merged into the body
  visibility: summary
```

## Logging in first

For an endpoint behind a login, list a [fixture](plugins.md#fixtures) in the provider file: a small
plugin that logs in before the provider's first request, and gives cookies or tokens by name for
the run. The provider's headers then use them like any secret:

```yaml
kind: http
fixtures: { beforeAll: [acme-login], afterAll: [acme-logout] }
url: "{{env.base_url}}/chat"
login_url: "{{env.base_url}}/login"     # the provider's other fields reach the fixture as settings
headers: { cookie: "{{secret.ACME_COOKIE}}", x-csrf-token: "{{secret.ACME_CSRF}}" }
body: { message: "{{user}}" }
response: { text: $.data.reply }
```

A provider plugin writes them the same way in its requests, `headers: { cookie: "{{secret.ACME_COOKIE}}" }`,
and Hafen fills them in as the request leaves. Either way the values are redacted wherever they'd
show, and so is the credential in one given as `Bearer <token>`: the token in the login's own answer
too (`{"access_token":"[redacted]"}`, on its call's step). `before`, `after` and `afterAll` lists run around each
test and at the end of the run ([Fixtures](plugins.md#fixtures)). A fixture says which lists it can be
in (its `phases`), can stop the run before the provider's tests are sent by returning `false` (the
service is down, say), and can set the environment's values for the rest of the run, as
`env.set("chat_url", …)` for a provider whose `url: "{{env.chat_url}}"`
([Setting the environment's values](plugins.md#setting-the-environments-values)).

## Presets

A preset is an HTTP provider already filled in for a known API. Anything it sets can be overridden.

| Preset | Options | Notes |
|---|---|---|
| `openai-chat` | `base_url` (default `https://api.openai.com/v1`), `model`, `api_key` (default `"{{secret.OPENAI_API_KEY}}"`), `params` | Chat Completions, streamed. Reads `reasoning_content` / `reasoning` when present (DeepSeek, OpenRouter, vLLM, llama.cpp server). Works with any OpenAI-compatible server |
| `openai-responses` | the same | The Responses API. Thinking is a summary; continues with `previous_response_id` |
| `anthropic-messages` | `model`, `api_key` (default `"{{secret.ANTHROPIC_API_KEY}}"`), `params` | The Messages API, streamed. Thinking blocks are replayed unchanged in the conversation; asks for summarized thinking when a test checks thinking |
| `gemini` | `model`, `api_key` (default `"{{secret.GEMINI_API_KEY}}"`), `params` | `streamGenerateContent`. Asks for thoughts when a test checks thinking |
| `ollama` | `base_url` (default `http://localhost:11434`), `model`, `api_key` (only for ollama.com or a proxy), `params` (`options`, `think`, `format`, `keep_alive`, `tools`) | `POST /api/chat`, JSON lines. Asks for `think: true` when a test checks thinking |

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

The presets stream, read thinking the way each API returns it, replay what a live conversation
needs (signed thinking blocks, response ids), and answer tool calls with a test's mocked results
(`tools:` on a turn). Their mappings follow each API's documentation as of October 2026.

In the browser build, Ollama refuses web pages unless `OLLAMA_ORIGINS` allows the app's address. Use
the desktop app, or the relay.

## Prices

Give a provider a `price` (USD per million tokens) to see each turn's cost, use `cost` checks and
`--max-cost`:

```yaml
price: { input: 0.5, output: 1.5 }
```

Or give a suite `prices`, a file or a map by model: `{ <model>: { input, output, cached_input? } }`.
