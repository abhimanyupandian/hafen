// The command CI runs an exported suite with (Copy CI command, contracts/ui.md, The workspace), and the
// files Export writes beside it for the scope chosen. No DOM: the app's tests run it in Node.

// An entry's files ("" is Globals'): its values (<scope>.env, what --env reads) and its secrets
// (<scope>.secret.env, what --secret reads), each its own only. No scope is named globals (lib/scopes.js),
// nor ends .secret, so no two entries' files are ever the same file.
export const envFile = (scope) => `${scope || "globals"}.env`;
export const secretFile = (scope) => `${scope || "globals"}.secret.env`;

// The files Export would write for the scope chosen (none: Globals' alone), in the order CI reads them
// (a later file's names over an earlier one's: the scope's over Globals', as in the app), each only when
// it has something in it: { env: [globals.env, <scope>.env], secret: [globals.secret.env,
// <scope>.secret.env] }. state: the app's ({ env, globals, scopes, scopeSecrets: scope → secret names }).
export function ciFiles({ env, globals = {}, scopes = [], scopeSecrets = {} }) {
  const own = env ? scopes.find((s) => s.name === env)?.values ?? {} : {};
  return {
    env: [Object.keys(globals).length > 0 && envFile(""), !!env && Object.keys(own).length > 0 && envFile(env)].filter(Boolean),
    secret: [scopeSecrets[""]?.length > 0 && secretFile(""), !!env && scopeSecrets[env]?.length > 0 && secretFile(env)].filter(Boolean),
  };
}

// What an export wrote, as it was remembered: a list (a record from before it was one: the file, or none)
export const written = (files) => (Array.isArray(files) ? files : files ? [files] : []);

const quoted = (path) => (/^[\w./@:+-]+$/.test(path) ? path : JSON.stringify(path));

// The command CI runs a suite (or one of its tests, `test`) with: the folder it was last exported to
// (state.exports), with exactly the .env and secrets files that export wrote there, in the order they
// were written; never one it didn't. Null when it hasn't been exported yet.
export function ciCommand(file, test, state) {
  const where = state.exports?.[file];
  if (!where) return null;
  const inside = (name) => quoted(where.ci === "." ? name : `${where.ci}/${name}`);
  return [
    "npx hafen run", JSON.stringify(where.ci),
    ...written(where.env).map((f) => `--env ${inside(f)}`),
    ...written(where.secret).map((f) => `--secret ${inside(f)}`),
    test && `--test ${JSON.stringify(test.name)}`,
    "--report junit:results/junit.xml", "--report run:results/run.hafen-run.json",
  ].filter(Boolean).join(" ");
}
