// A new plugin's file (Settings → Plugins): a provider, a check or a judge that works as it is, to
// change into your own. Each loads (tests/engine/plugins-scopes.test.js checks it).

const PROVIDER = (name) => `// A provider plugin, run in a worker of its own. Use it in a provider file or a suite as
// kind: plugin:${name}  (its other fields, url and model say, reach it as settings).
export default {
  kind: "provider",
  name: "${name}",
  version: "1.0.0",
  // The only hosts it may reach
  hosts: ["api.example.com"],
  async *send({ message, history, settings, transport, signal }) {
    const res = await transport.fetch({
      url: settings.url ?? "https://api.example.com/chat",
      method: "POST",
      // A secret by its name: the engine fills it in, so the plugin never holds its value
      headers: { authorization: { secret: "EXAMPLE_API_KEY", prefix: "Bearer " } },
      body: { message, history: history.map((t) => ({ user: t.user, reply: t.reply })) },
      signal,
    });
    if (res.status >= 400) throw new Error(\`\${res.status}: \${await res.text()}\`);
    const data = await res.json();
    // What it yields: text, thinking, tool_call, tool_result, usage, done, error
    yield { type: "text", text: String(data.reply ?? "") };
    yield { type: "done" };
  },
};
`;

const CHECK = (name) => `// A check plugin, run in a worker of its own. Use it in a turn's checks as
// { type: ${name}, word: please }  (its fields reach it as params).
export default {
  kind: "check",
  name: "${name}",
  version: "1.0.0",
  // value: what the check's on/path selects (the reply's text by default)
  async check({ value, params }) {
    const word = String(params.word ?? "please");
    const found = String(value ?? "").toLowerCase().includes(word.toLowerCase());
    return { status: found ? "pass" : "fail", reason: found ? \`says "\${word}"\` : \`doesn't say "\${word}"\` };
  },
};
`;

const JUDGE = (name) => `// A judge plugin, run in a worker of its own. Name it in a suite's judges as
// mine: { kind: plugin, plugin: ${name} }, then use it in a check:
// { type: judge, judge: mine, rubric: "…" }. Its value is from 0 to 1 (the check's min and max apply).
export default {
  kind: "judge",
  name: "${name}",
  version: "1.0.0",
  // The hosts it may reach (none here: this one doesn't call out)
  hosts: [],
  async judge({ input, question }) {
    // A stand-in: replace it with a call to your judge (through transport.fetch, to its hosts)
    const value = String(input ?? "").length > 40 ? 0.8 : 0.3;
    return { value, confidence: 0.5, reason: \`a stand-in score for "\${question}"\` };
  },
};
`;

const FIXTURE = (name) => `// A fixture plugin, run in a worker of its own before a provider's first request: a login, say.
// Name it in a provider file as  fixture: ${name}  and what setup() returns is kept for the run, as
// secrets: a provider plugin names them ({ secret: "EXAMPLE_COOKIE" }), a provider file uses
// \${env:EXAMPLE_COOKIE}. Each is redacted wherever it would show.
export default {
  kind: "fixture",
  name: "${name}",
  version: "1.0.0",
  // The only hosts it may reach
  hosts: ["auth.example.com"],
  // The names it gives
  provides: ["EXAMPLE_COOKIE", "EXAMPLE_CSRF"],
  // settings: the provider file's fields (login_url and user, say)
  async setup({ settings, transport, signal }) {
    const res = await transport.fetch({
      url: settings.login_url ?? "https://auth.example.com/login",
      method: "POST",
      // A secret by its name, in a body too: the engine fills it in, so the fixture never holds it
      body: { user: settings.user ?? "qa-bot", password: { secret: "EXAMPLE_PASSWORD" } },
      signal,
    });
    if (res.status >= 400) throw new Error(\`login failed: \${res.status}\`);
    // One entry per cookie (the desktop app and the CLI: a browser doesn't let a page read them)
    const cookies = [res.headers["set-cookie"] ?? []].flat().map((c) => c.split(";")[0]);
    const { csrf_token } = await res.json();
    return { EXAMPLE_COOKIE: cookies.join("; "), EXAMPLE_CSRF: csrf_token };
  },
};
`;

export const PLUGIN_KINDS = [
  { id: "provider", label: "Provider", template: PROVIDER, use: (name) => `kind: plugin:${name}` },
  { id: "check", label: "Check", template: CHECK, use: (name) => `{ type: ${name} }` },
  { id: "judge", label: "Judge", template: JUDGE, use: (name) => `judges: { mine: { kind: plugin, plugin: ${name} } }` },
  { id: "fixture", label: "Fixture", template: FIXTURE, use: (name) => `fixture: ${name}` },
];

export const pluginTemplate = (kind, name) => PLUGIN_KINDS.find((k) => k.id === kind).template(name);
export const pluginUse = (kind, name) => PLUGIN_KINDS.find((k) => k.id === kind)?.use(name) ?? "";
