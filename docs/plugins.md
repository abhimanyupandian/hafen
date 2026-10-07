# Plugins

When configuration can't describe an endpoint, when an endpoint needs a login first, or when you need
a check or judge of your own, write a plugin: one JavaScript module. The same module runs in the
desktop app, the browser build and CI.

## Where plugins live

- **The folder's plugins:** `plugins/*.js` in the app's opened folder, or the CLI's current folder.
  Every suite can use them by name, without listing them.
- **More plugins:** list them in a suite's `plugins`, as paths from the suite
  (`./plugins/acme.js`) or as package names.

Use a plugin by its name:

| Plugin | Used as |
|---|---|
| A provider | `kind: plugin:acme`, in a provider file or a suite |
| A check | `{ type: polite }`, in a turn's checks |
| A judge | `judges: { mine: { kind: plugin, plugin: house } }`, then `{ type: judge, judge: mine, rubric: … }` |
| A fixture | `fixture: acme-login`, in a provider file ([Fixtures](#fixtures)) |

A suite can ask for a version range: `plugin:acme@^1` (or `fixture: acme-login@^1`). A plugin that can't be found or loaded, or
whose `version` doesn't satisfy the range, is a setup error before anything is sent.

In the app, **Settings → Plugins** lists the folder's plugins, shows which suites use each one, and
opens them in a code editor. **Add a plugin** writes `plugins/<name>.js` from a starting file that
works as it is. A new provider plugin also gets its provider file, `providers/<name>.yml`, so you
can try it in a conversation straight away.

## Sandboxing and secrets

- Each plugin runs in a worker of its own: a Web Worker in the browser, a worker thread in Node,
  started with an empty environment, so `process.env` holds nothing.
- Its requests go through `transport`, and reach only the hosts it names in `hosts` (an exact name,
  or `*.example.com` for subdomains). No hosts named, none reached.
- It names secrets in headers, or as values in a JSON body: `{ secret: "NAME", prefix: "Bearer " }`.
  Hafen fills them in from the chosen scope's secrets (and what a fixture gave). The plugin never
  holds a secret's value. In a body, only an object with just `secret` (and `prefix`) is taken as
  one.
- What it imports runs in the same worker, with the same limits: no environment variables.

Plugins are trusted code. The guarantee is that they never hold secret values. The one exception is
a fixture, which reads its login's response, so it sees the values it gives.

## Imports

A plugin can import any other file or package, as any ES module can. In the desktop app and the CLI,
Hafen loads it from its own file, so imports resolve as Node resolves them:

```js
// plugins/acme.js
import { sign } from "../lib/acme-auth.js";          // a file anywhere in the project
import { parse } from "../../shared/protocol.js";    // or outside it
import { nanoid } from "nanoid";                     // a package, from node_modules
import limits from "./limits.json" with { type: "json" };
```

The plugin itself must be in the opened folder: in `plugins/`, or a path a suite names. What it
imports can be anywhere. To use a plugin kept elsewhere, re-export it from `plugins/`:

```js
// plugins/acme.js
export { default } from "../../shared/hafen-plugins/acme.js";
```

The browser build can't resolve imports from your folder, so there a plugin must be one file. A
plugin that imports something says so when it loads; bundle it (with esbuild, say) to use it there.

## Provider plugins

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
      headers: { authorization: { secret: "ACME_KEY", prefix: "Bearer " } },  // filled in by Hafen
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
| `message` | This turn's message, with variables resolved |
| `history` | Earlier turns: `{ user, reply, thinking, tool_calls, raw }[]`. `raw` is what the plugin yielded as `{ type: "raw", value }`, for replaying |
| `variables` | The test's variables, and the chosen scope's plain values as `scope`. Never secrets |
| `attachments` | `{ name, type, bytes }[]` |
| `settings` | The provider's other fields from its file, with `{{name}}`s filled in. Never secrets |
| `transport` | `fetch(request)` → `{ status, headers, body, json(), text(), lines(), sse() }`, and `websocket(url, options)` |
| `signal` | Aborts when the run stops or the turn times out |

It yields events: `text`, `thinking`, `tool_call`, `tool_result`, `usage`, `done`, `error`, and
`{ type: "raw", value }` for anything it needs back in `history`. Hafen stamps their times, keeps
each as a line of the raw stream, and assembles the reply from them for `on: response` checks.

## Check and judge plugins

A check plugin decides pass or fail itself:

```js
// plugins/polite.js
export default {
  kind: "check",
  name: "polite",
  version: "1.0.0",
  // params: the check's fields from the suite. value: what on/path selected.
  async check({ value, turn, conversation, params, transport, signal }) {
    const rude = /\b(stupid|idiot)\b/i.test(String(value));
    return { status: rude ? "fail" : "pass", reason: rude ? "found an insult" : "no insults" };
  },
};
```

It returns `{ status, reason, value?, confidence?, actual?, expected? }`.

A judge plugin returns a value, and the check that uses it applies `min`, `max` and `unsure_below`:

```js
// plugins/house-judge.js
export default {
  kind: "judge",
  name: "house",
  version: "2.1.0",
  hosts: ["judge.acme.example"],
  async judge({ input, question, params, transport, signal }) {
    const res = await transport.fetch({ url: "https://judge.acme.example/v1", method: "POST",
      headers: { authorization: { secret: "HOUSE_JUDGE_KEY", prefix: "Bearer " } }, body: { input, question }, signal });
    const { score, certainty, why } = await res.json();
    return { value: score, confidence: certainty, reason: why, usage: { input: 0, output: 0 } };
  },
};
```

It returns `{ value, confidence?, reason, usage?, raw? }`.

## Fixtures

A fixture runs before a provider's first request, usually to log in. It returns values by name,
such as a session cookie and a CSRF token. Hafen keeps them for that run only, as secrets:

- **Provider plugins** name them, and Hafen fills them in: `headers: { cookie: { secret: "ACME_COOKIE" } }`.
- **Provider files** use them as `${env:ACME_COOKIE}` or `{{scope.ACME_COOKIE}}`.
- **Everywhere else** they're redacted: the run file, reports, the console and the app.

Name the fixture in the provider file. Its other fields reach the fixture as `settings`:

```yaml
# providers/acme.yml
kind: plugin:acme
fixture: acme-login
url: "{{scope.base_url}}/chat"
login_url: "{{scope.base_url}}/login"
user: qa-bot
```

```js
// plugins/acme-login.js
export default {
  kind: "fixture",
  name: "acme-login",
  version: "1.0.0",
  hosts: ["auth.acme.example"],
  provides: ["ACME_COOKIE", "ACME_CSRF"],   // the names it gives

  async setup({ settings, variables, transport, signal }) {
    const res = await transport.fetch({
      url: settings.login_url,
      method: "POST",
      // A secret in the body: Hafen fills it in, so the fixture never holds the password
      body: { user: settings.user, password: { secret: "ACME_PASSWORD" } },
      signal,
    });
    if (res.status >= 400) throw new Error(`login failed: ${res.status}`);
    // One entry per cookie
    const cookies = [res.headers["set-cookie"] ?? []].flat().map((c) => c.split(";")[0]);
    const { csrf_token } = await res.json();
    return { ACME_COOKIE: cookies.join("; "), ACME_CSRF: csrf_token };
  },
};
```

Then the provider plugin sends them by name:

```js
const res = await transport.fetch({
  url: settings.url,
  method: "POST",
  headers: { cookie: { secret: "ACME_COOKIE" }, "x-csrf-token": { secret: "ACME_CSRF" } },
  body: { message },
  signal,
});
```

Or a plain HTTP provider uses them, with no provider plugin at all:

```yaml
# providers/acme-http.yml
kind: http
fixture: acme-login
url: "{{scope.base_url}}/chat"
login_url: "{{scope.base_url}}/login"
user: qa-bot
headers: { cookie: "${env:ACME_COOKIE}", x-csrf-token: "${env:ACME_CSRF}" }
body: { message: "{{user}}" }
response: { text: $.data.reply }
```

| `setup` gets | What |
|---|---|
| `settings` | The provider file's other fields, with `{{name}}`s filled in. Never secrets |
| `variables` | The suite's variables, and the chosen scope's plain values as `scope` |
| `transport` | As a provider plugin's. A request can also take `redirect: "manual"`, to read the cookies a redirect sets |
| `signal` | Aborts when the run stops, or after `timeout_ms` (the provider's, or 60 s) |

It returns `{ NAME: "value" }`. The values must be text: join several cookies into one, as above.

**When it runs:**
- **In a run** (the app or CLI): once per run and scope, at the start of the first suite whose tests
  use the provider, before that suite's setup steps, which can use the values too. Every suite and
  test after that reuses them. It runs with the settings of the first provider that names it.
- **In a conversation** (the app): before the first message. It runs again after it fails, or when
  you choose another scope.
- **On the timeline**, it shows as a `fixture` step, with the names it gave but not their values.

**When it fails:** if `setup()` throws, or doesn't return every name in `provides` (or returns one
that isn't listed), the suite stops with a setup error and the CLI exits `2`. Nothing else in the
suite is sent.

**Checks before a run:** the names in `provides` count as set, so `validate --env-check` and the
pre-run check accept `${env:ACME_COOKIE}` even though nothing sets it until the run starts. List
every name in `provides`.

**Cookies:** the desktop app and the CLI can read `Set-Cookie` and send `Cookie`. The browser build
can't, because browsers don't let a page do either. There, use a login that returns a token in its
body, and send the token in another header.
