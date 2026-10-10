# Plugins

When configuration can't describe an endpoint, when an endpoint needs a login first, or when you need
a check or judge of your own, write a plugin: one JavaScript module. The same module runs in the
desktop app, the browser build and CI.

## Where plugins live

- **The folder's plugins:** `plugins/*.js` among the files the app keeps (Settings → Plugins), or,
  on the command line, in the current folder and in each folder it's given (`hafen run tests/` finds
  `tests/plugins/`). Every suite can use them by name, without listing them.
- **More plugins:** list them in a suite's `plugins`, as paths from the suite
  (`./plugins/acme.js`) or as package names.

Use a plugin by its name:

| Plugin | Used as |
|---|---|
| A provider | `kind: plugin:acme`, in a provider file or a suite |
| A check | `{ type: polite }`, in a turn's checks |
| A judge | `judges: { mine: { kind: plugin, plugin: house } }`, then `{ type: judge, judge: mine, rubric: … }` |
| A fixture | `fixtures: { beforeAll: [acme-login] }` (or `before`, `after`, `afterAll`), in a provider file ([Fixtures](#fixtures)) |

A suite can ask for a version range: `plugin:acme@^1` (or `fixtures: { beforeAll: [acme-login@^1] }`). A plugin that can't be found or loaded, or
whose `version` doesn't satisfy the range, is a setup error before anything is sent.

In the app, **Settings → Plugins** lists your plugins, shows which suites use each one, and opens
them in a code editor. **Add a plugin** writes `plugins/<name>.js` from a starting file that works as
it is. A new provider plugin also gets its provider file, `providers/<name>.yml`, so you can try it
in a conversation straight away, and is one of the kinds a new provider can be (`plugin:<name>`, in
Settings → Providers → **new provider**). Import and Export bring a suite's plugins with it, and the
files they import by a relative path.

## Trust, the network and secrets

A plugin is trusted code: run only plugins you'd run as any other script of your project. Hafen
keeps secrets out of its hands, and keeps its requests to its hosts, but it's no sandbox:

- Each plugin runs in a worker of its own: a Web Worker in the browser, a worker thread in Node,
  started with an empty environment, so `process.env` holds nothing.
- Its requests go through `transport.fetch`, and reach only the hosts it names in `hosts` (an exact
  name, or `*.example.com` for subdomains). No hosts named, none reached. `hosts` limits
  `transport.fetch`, and only it.
- The worker has no `fetch`, `WebSocket`, `XMLHttpRequest` or `EventSource` of its own: one used by
  mistake throws `a plugin has no fetch (use transport.fetch: it's the one that reaches the plugin's
  hosts)`, rather than going around `hosts` (and without the secrets Hafen fills in).
- In the desktop app and the CLI, a plugin runs in Node: it can import `node:fs` and read files, or
  `node:http` and reach the network its own way. Hafen doesn't stop that; `hosts` doesn't cover it.
- Every call gets `env`: the chosen environment's values (the app's scope, or `--env`, over the
  suite's `environments:` entry). Never a secret.
- It writes a secret into a request as `{{secret.NAME}}`: in its address, a header's value
  (`"Bearer {{secret.ACME_KEY}}"`) or any text in its body. Hafen fills it in as the request leaves,
  from the chosen scope's secrets (and what a fixture gave). The plugin never holds a secret's value.
  `{{env.NAME}}` is filled in the same way. Not inside what the call was given from elsewhere (a
  message, a reply, a check's value): a reply that says `{{secret.ACME_KEY}}` is sent on as it was.
- Each `{{secret.NAME}}` written out in its file must be set before a run sends anything, as a
  suite's must, and each `{{env.NAME}}` must be in the environment. One that isn't stops the run
  (exit `2`), and `validate --env-check` says so, at that line of the plugin's file:
  `plugins/acme-login.js:14:47  {{secret.ACME_PASSWORD}} isn't set (not in the --secret file or the environment) (the fixture plugin "acme-login" names it)`.
  A name a fixture gives counts as set. A name built as the plugin runs can't be seen, so it isn't
  checked until it's used.
- What it imports runs in the same worker, with the same limits: no environment variables.


The guarantee is that a plugin never holds a secret's value through Hafen: it's never given one, and
its requests have them filled in as they leave. The one exception is a fixture, which reads its
login's response, so it sees the values it gives. A fixture's names follow the one rule for names:
letters, digits, `_`, `.` and `-`, not starting with a digit (`provides: ["ACME_COOKIE",
"db.password"]`).

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

The plugin itself must be among the suites' files: in `plugins/`, or a path a suite names. On the
command line what it imports can be anywhere; Import and Export copy only what's in the folder (an
import that climbs out of it is said, and isn't copied). To use a plugin kept elsewhere, re-export it
from `plugins/`:

```js
// plugins/acme.js
export { default } from "../../shared/hafen-plugins/acme.js";
```

The browser build can't resolve imports from the files beside a plugin, so there a plugin must be
one file. A plugin that imports something says so when it loads; bundle it (with esbuild, say) to use
it there.

## Provider plugins

```js
// plugins/acme-provider.js
export default {
  kind: "provider",
  name: "acme",
  version: "1.0.0",
  hosts: ["chat.acme.example"],          // the only hosts its transport will reach

  // Send one turn. Yield events as they arrive; throw to report an error.
  async *send({ message, history, variables, env, settings, transport, signal }) {
    const res = await transport.fetch({
      url: `https://chat.acme.example/v2/turn`,
      method: "POST",
      headers: { authorization: "Bearer {{secret.ACME_KEY}}" },  // filled in by Hafen as it leaves
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
| `history` | Earlier turns: `{ user, reply, raw }[]`. `raw` is what the plugin yielded as `{ type: "raw", value }`, for replaying (a turn's thinking and tool calls, say: yield what you need back as `raw`) |
| `variables` | The test's variables. Never secrets |
| `env` | The chosen environment's values: those given, over the suite's `environments:` entry of its name. Never secrets |
| `settings` | The provider's other fields from its file, with `{{name}}`s and `{{env.NAME}}`s filled in. A `{{secret.NAME}}` stays as written: put it in a request, and Hafen fills it in there |
| `transport` | `fetch(request)` → `{ status, headers, body, json(), text(), lines(), sse() }` |
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
  async check({ value, turn, conversation, params, env, transport, signal }) {
    const rude = /\b(stupid|idiot)\b/i.test(String(value));
    return { status: rude ? "fail" : "pass", reason: rude ? "found an insult" : "no insults" };
  },
};
```

It returns `{ status, reason, value?, confidence?, actual?, expected? }`.

A judge plugin returns a value, and the check that uses it applies `min`, `max`, `confidence` and
`unsure_below` ([Confidence](checks.md#confidence): a check with `confidence` whose judge returns
none is an error):

```js
// plugins/house-judge.js
export default {
  kind: "judge",
  name: "house",
  version: "2.1.0",
  hosts: ["judge.acme.example"],
  async judge({ input, question, params, env, transport, signal }) {
    const res = await transport.fetch({ url: "https://judge.acme.example/v1", method: "POST",
      headers: { authorization: "Bearer {{secret.HOUSE_JUDGE_KEY}}" }, body: { input, question }, signal });
    const { score, certainty, why } = await res.json();
    return { value: score, confidence: certainty, reason: why, usage: { input: 0, output: 0 } };
  },
};
```

It returns `{ value, confidence?, reason, usage?, raw? }`.

Both get `env`, the chosen environment's values, as a provider plugin does. Never a secret.

## Fixtures

A fixture runs around a provider's requests: to log in first, reset a test account before each test,
or log out at the end. A provider file lists its fixtures by when they run, and each list runs in
its order:

```yaml
# providers/acme.yml
kind: plugin:acme
url: "{{env.base_url}}/chat"
login_url: "{{env.base_url}}/login"
user: qa-bot
fixtures:
  beforeAll: [acme-login]       # once per run, before the provider's first request
  before: [reset-cart]          # before each test that uses the provider
  after: [clear-cart]           # after each test, however it went
  afterAll: [acme-logout]       # once, when the run ends
```

| List | Runs |
|---|---|
| `beforeAll` | Once per run (and scope), at the start of the first suite whose tests use the provider, before that suite's setup steps. Every suite and test after that reuses what it gave |
| `before` | Before each test that uses the provider (each repeat and data row), before the test's setup steps |
| `after` | After each test, after its teardown steps, whether it passed, failed or errored |
| `afterAll` | Once per run (and scope), when the run ends, even when it was stopped |

In a conversation in the app, `beforeAll` and `before` run before the first message. `after` and
`afterAll` run when you start another conversation or open a different one.

In the app, open **Settings → Providers** and a provider (or press **edit** beside **Fixtures**,
under any provider picker). Its **Fixtures** has a list for each of the four, in plain words: *Once,
before the run*; *Before each test*; *After each test*; *Once, after the run*. Add as many fixtures
to each as you like, from the folder's fixtures (each shown with the names it gives, and offered
only in the lists its [`phases`](#writing-one) name). A list names
each fixture once: one already in it shows as *in this list already*, and a file that names one twice
in a list (by hand) is a problem that stops every run and message until the extra is taken out (×).
Another list can name it too: a fixture before each test and after it. Move them
earlier or later with ↑ and ↓ (they run top to bottom), and take one out with ×. Every change is
saved in the provider's file straight away, comments kept. Beside each provider picker, the
conversation, suite and test panels show the fixtures in order (`acme-login → reset-cart`). Each name
there opens the fixture's code (Settings → Plugins, in the editor), as **code** beside it in the
editor does, and as the fixture's step and a plugin's call do on the timeline.

The provider pickers list only providers: a provider file whose kind is a fixture (or a check or
judge) plugin isn't offered.

### Writing one

```js
// plugins/acme-login.js
export default {
  kind: "fixture",
  name: "acme-login",
  version: "1.0.0",
  hosts: ["auth.acme.example"],
  phases: ["beforeAll"],                    // the lists it can be in
  provides: ["ACME_COOKIE", "ACME_CSRF"],   // the names it gives

  async run({ settings, env, transport, signal }) {
    const res = await transport.fetch({
      url: settings.login_url,
      method: "POST",
      // A secret in the body: Hafen fills it in as it leaves, so the fixture never holds the password
      body: { user: settings.user, password: "{{secret.ACME_PASSWORD}}" },
      signal,
    });
    // Down for maintenance: stop the run, rather than fail every test
    if (res.status === 503) return false;
    if (res.status >= 400) throw new Error(`login failed: ${res.status}`);
    // One entry per cookie
    const cookies = [res.headers["set-cookie"] ?? []].flat().map((c) => c.split(";")[0]);
    const { csrf_token, region } = await res.json();
    // For the rest of the run: {{env.ACME_REGION}}
    if (region) env.set("ACME_REGION", region);
    return { ACME_COOKIE: cookies.join("; "), ACME_CSRF: csrf_token };
  },
};
```

**When it runs.** `phases` names the lists it can be in: any of `beforeAll`, `before`, `after` and
`afterAll` (all four when it doesn't say). Hafen calls `run()` only for those, so a login needs no
`if (phase === "after" || phase === "afterAll") return;`. A fixture that does two jobs, a login
and its logout, says both and looks at `phase`:

```js
phases: ["beforeAll", "afterAll"],
async run({ phase, transport, signal }) {
  if (phase === "afterAll") return logout(transport, signal);
  …
}
```

A provider that names a fixture in a list its phases leave out is a problem where the provider file
names it, before anything is sent (a run, `validate`, a conversation):

```
providers/acme.yml:7:13  the fixture "acme-login" runs only in beforeAll: it can't be in fixtures.after
```

`phases` that isn't a list of those four (or is empty) stops the plugin loading, saying why.

| `run` gets | What |
|---|---|
| `phase` | `beforeAll`, `before`, `after` or `afterAll`: one plugin can serve several lists |
| `settings` | The provider file's other fields, with `{{name}}`s and `{{env.NAME}}`s filled in (`login_url` above). Never secrets. An `{{env.NAME}}` a fixture sets with `env.set`, and that isn't set yet, stays as written |
| `variables` | The suite's variables |
| `env` | The chosen environment's values, as a provider plugin's, with what fixtures have set so far, and `env.set(NAME, value)` ([below](#setting-the-environments-values)) |
| `test` | In `before` and `after`: the test's `name`, `id`, `repeat` and `row` (and the row's name, `row_name`, when it has one: [Data rows](test-files.md#data-rows)); in `after`, its `status` too (`passed`, `failed`, `error`, `stopped`) |
| `transport` | As a provider plugin's. A request can also take `redirect: "manual"`, to read the cookies a redirect sets |
| `signal` | Aborts when the run stops, or after `timeout_ms` (the provider's, or 60 s) |

**What it returns:**

| `run()` returns | Then |
|---|---|
| nothing, or `true` | Go on |
| `{ NAME: "value" }` | Go on, with these values (`beforeAll` and `before`; see below) |
| `false` | Stop: in `beforeAll`, the run stops before the provider's tests are sent; in `before`, that test does (its run or row); in `after` and `afterAll`, nothing changes |

**What it gives.** In `beforeAll` and `before`, `run()` returns `{ NAME: "value" }`: every name in
`provides`, and no other (`true` or nothing is no names, so a fixture with `provides` must return
them). The values must be text: join several cookies into one, as above. They're kept as secrets,
for the run (`beforeAll`) or that one test (`before`, whose names win over `beforeAll`'s):

- **Provider files** use them as `{{secret.ACME_COOKIE}}`.
- **Provider plugins** write them the same way in a request, and Hafen fills them in:
  `headers: { cookie: "{{secret.ACME_COOKIE}}" }`.
- **Everywhere else** they're redacted: the run file, reports, the console and the app.

What `after` and `afterAll` return is ignored, but `false`, which is recorded. (A fixture written
before `run()` existed, with `setup()`, still works.)

**When it says to stop** (returns `false`), it's a step like any other, marked *said to stop*, and
the console says so without `--verbose`:
- **`beforeAll`:** the run stops before the provider's tests are sent, and the lists after it don't
  run. The run is *stopped* and the CLI exits `3`. Every test of the suite is skipped, with the reason
  `the fixture "acme-login" (beforeAll) said to stop` (a `<skipped>` in JUnit, and under *Skipped* in
  the Markdown), and a suite the run never reached is *not run*. The provider's `afterAll` fixtures
  still run.
- **`before`:** that test's run (or data row) is stopped with the same kind of reason: its setup and
  turns don't run, its `after` fixtures do, and the other tests go on. A test with a run stopped this
  way is *stopped* (skipped, in the reports), unless a run that went wrong already failed it.
- **`after` or `afterAll`:** nothing changes. It's recorded.
- **In a conversation:** `false` in `beforeAll` or `before` refuses the message: it's sent to no one,
  its turn says *Skipped* and why, and the fixtures run again with the next message.

**When it fails:**
- **`beforeAll`:** the suite stops with a setup error and the CLI exits `2`. Nothing else in the
  suite is sent, and the lists after it don't run. The provider's `afterAll` fixtures still run when
  the run ends, so a logout is still sent. (A secret the fixture names that isn't set never gets
  this far: the run stops before anything is sent.)
- **`before`:** that test is an error (its setup and turns don't run, but its `after` fixtures do),
  and the other tests go on.
- **`after` or `afterAll`:** no result changes, as with a teardown step. The failure is recorded and
  shown: on the timeline, in the console, in the CLI's output and in the reports.

**Checks before a run:** the names in `provides` of `beforeAll` and `before` fixtures count as set,
so `validate --env-check` and the pre-run check accept `{{secret.ACME_COOKIE}}` even though nothing
sets it until the run starts. List every name in `provides`. The secrets a fixture writes in its code
(`"{{secret.ACME_PASSWORD}}"`) are checked as every plugin's are ([Trust, the network and
secrets](#trust-the-network-and-secrets)). So are the environment's names they set
([below](#setting-the-environments-values)).

### Setting the environment's values

`env.set(NAME, value)` sets one of the environment's values for the rest of the run: the requests,
checks and fixtures after it have it as `{{env.NAME}}`, over the environment's own value of that
name. It's set in whichever environment (scope) the run is using, and it's temporary: never written
to a file, the app's store or the run's settings, and gone when the run ends (the next run starts
without it). In a conversation it lasts until the conversation is let go.

```js
async run({ env, transport, signal }) {
  const res = await transport.fetch({ url: `${env.base_url}/session`, method: "POST", signal });
  const { chat_url, tenant } = await res.json();
  env.set("chat_url", chat_url);     // the provider file: url: "{{env.chat_url}}"
  env.set("tenant", tenant);
}
```

- Any phase can set: a `before` fixture's value is there for the tests after it too. The `env`
  `run()` was given shows what it set, straight away.
- Names follow the [one rule for names](test-files.md#environments-and-secrets) (letters, digits,
  `_ . -`, not starting with a digit); a value is text (a number or `true`/`false` is made text).
  Anything else fails the fixture, saying why.
- What a fixture set is kept only once its `run()` returns: one that fails sets nothing.
- The values aren't secrets: they show as they are in the run, unless they're also a secret's value.
  For a token, return it as a secret instead ([What it gives](#writing-one)).
- The run record lists the names a fixture set (its `sets`), never their values.

**Checks before a run:** an `{{env.NAME}}` only a fixture sets counts as set when a `beforeAll` or
`before` fixture of the provider sets it. Hafen finds the names in the fixture's code, written as
`env.set("NAME", …)` (a name in quotes). For a name it builds as it runs, list it in `sets`:

```js
sets: ["tenant_eu", "tenant_us"],
async run({ env, settings }) { env.set(`tenant_${settings.region}`, "…"); }
```

A name nothing sets is still a problem where it's used:

```
providers/acme.yml:3:6  {{env.chat_url}} isn't set: the environment "staging" has no chat_url
```

A problem with a provider's fixture lists (a fixture that isn't there, or is another kind of plugin,
or is named twice in a list) is said at that name in the provider file's list:

```
providers/acme.yml:7:17  fixtures.before names reset-cart twice: a list runs each fixture once (another list can name it too)
```

**Cookies:** the desktop app and the CLI can read `Set-Cookie` and send `Cookie`. The browser build
can't, because browsers don't let a page do either. There, use a login that returns a token in its
body, and send the token in another header.

## Calls, on the timeline and elsewhere

Every HTTP call a plugin or fixture makes is recorded:

- **Timeline:** each fixture that ran is a step (`acme-login · beforeAll`), under the suite, the test's
  run, or the run itself. Each call is a step under whatever made it: the fixture, a provider
  plugin's turn, a check or a judge. Select a call to see what it sent (method, address, headers,
  body) and what came back (status, headers, the start of the body), with secrets shown as
  `[redacted]`.
- **Console:** a line for each fixture as it ends (`run.fixture name=acme-login phase=beforeAll … ok ·
  gave ACME_COOKIE, ACME_CSRF`), and each call's `http.request` line says who made it
  (`via=fixture:acme-login`, `via=provider:acme`).
- **Command line:** a failed fixture always gets a line. With `--verbose`, every fixture and every
  call does. The summary counts the fixtures that ran.
- **Reports:** the Markdown report has a Fixtures table. The JSON report lists every fixture and every
  call. JUnit puts each test's fixtures in its `<system-out>` (failed ones in `<system-err>`), and the
  run's own (`beforeAll`, `afterAll`) in each suite's.

**hide fixtures** (in the timeline's head, and the console's) hides the fixtures' steps and lines, and
**show fixtures** brings them back. The choice is remembered, and applies to both.
