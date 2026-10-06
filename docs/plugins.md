# Plugins

When configuration can't describe an endpoint, or you need a check or judge of your own, write a
plugin: one JavaScript module. The same module runs in the desktop app, the browser build and CI.

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

A suite can ask for a version range: `plugin:acme@^1`. A plugin that can't be found or loaded, or
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
- It names secrets in headers, `{ secret: "NAME", prefix: "Bearer " }`, and Hafen fills them in from
  the chosen scope's secrets. The plugin never holds a secret's value.
- A plugin is one module: it can't import other files. Bundle it if it needs to.

Plugins are trusted code. The guarantee is that they never hold secret values.

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
