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
  // env: the chosen environment's values (base_url, say: never a secret)
  async *send({ message, history, settings, env, transport, signal }) {
    const res = await transport.fetch({
      url: settings.url ?? \`\${env.base_url ?? "https://api.example.com"}/chat\`,
      method: "POST",
      // A secret, written {{secret.…}}: the engine fills it in as the request leaves, so the plugin
      // never holds its value
      headers: { authorization: "Bearer {{secret.EXAMPLE_API_KEY}}" },
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

const FIXTURE = (name) => `// A fixture plugin, run in a worker of its own around a provider's requests: a login, say. Name it
// in a provider file's fixtures, by when it runs:  fixtures: { beforeAll: [${name}] }  (its phases
// say which of the lists it can be in). What run() returns before the provider's requests is kept,
// as secrets of these names (for the run, or the test): a provider file, or a provider plugin's
// request, uses each as {{secret.…}}. Each is redacted wherever it would show. Its HTTP calls are
// steps on the timeline.
export default {
  kind: "fixture",
  name: "${name}",
  version: "1.0.0",
  // The only hosts it may reach
  hosts: ["auth.example.com"],
  // When it runs: any of beforeAll, before, after and afterAll (all four when it doesn't say). A
  // provider can list it only there, so run() needn't check its phase.
  phases: ["beforeAll"],
  // The names it gives
  provides: ["EXAMPLE_COOKIE", "EXAMPLE_CSRF"],
  // settings: the provider file's fields (login_url and user, say). env: the chosen environment's
  // values, and env.set(NAME, value), which sets one for the rest of the run ({{env.NAME}} from then
  // on; never saved anywhere). phase, and test (before and after): the test's name, its run and row,
  // and after it, its status.
  // It returns the values it gives ({ NAME: "…" }), true or nothing to go on, or false to stop: in
  // beforeAll the run stops before the provider's tests are sent; in before, that test does; after
  // and afterAll, nothing changes.
  async run({ settings, env, transport, signal }) {
    const res = await transport.fetch({
      url: settings.login_url ?? \`\${env.auth_url ?? "https://auth.example.com"}/login\`,
      method: "POST",
      // A secret in a body too: the engine fills it in as the request leaves, so the fixture never holds it
      body: { user: settings.user ?? "qa-bot", password: "{{secret.EXAMPLE_PASSWORD}}" },
      signal,
    });
    // (the service is down for maintenance: stop the run, rather than fail every test)
    if (res.status === 503) return false;
    if (res.status >= 400) throw new Error(\`login failed: \${res.status}\`);
    // One entry per cookie (the desktop app and the CLI: a browser doesn't let a page read them)
    const cookies = [res.headers["set-cookie"] ?? []].flat().map((c) => c.split(";")[0]);
    const { csrf_token, region } = await res.json();
    // For the rest of the run: {{env.EXAMPLE_REGION}} in the provider file, the checks, other fixtures
    if (region) env.set("EXAMPLE_REGION", region);
    return { EXAMPLE_COOKIE: cookies.join("; "), EXAMPLE_CSRF: csrf_token };
  },
};
`;

export const PLUGIN_KINDS = [
  { id: "provider", label: "Provider", template: PROVIDER, use: (name) => `kind: plugin:${name}` },
  { id: "check", label: "Check", template: CHECK, use: (name) => `{ type: ${name} }` },
  { id: "judge", label: "Judge", template: JUDGE, use: (name) => `judges: { mine: { kind: plugin, plugin: ${name} } }` },
  { id: "fixture", label: "Fixture", template: FIXTURE, use: (name) => `fixtures: { beforeAll: [${name}] }` },
];

export const pluginTemplate = (kind, name) => PLUGIN_KINDS.find((k) => k.id === kind).template(name);
export const pluginUse = (kind, name) => PLUGIN_KINDS.find((k) => k.id === kind)?.use(name) ?? "";
