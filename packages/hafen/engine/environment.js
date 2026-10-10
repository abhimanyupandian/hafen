// The environment a suite runs with (contracts/test-file.md, Environments and secrets), and the
// secrets a host keeps for it, hidden wherever they show.

import { noteSecret } from "./redact.js";
import { isObject } from "./util.js";

// The environment a suite runs with (contracts/test-file.md, Environments and secrets): { envName,
// environment: { name, values, suite } (null: none chosen) }. A run and a conversation's message
// choose it the same way (serve-port.js, send):
//   options.environment passed: that one ({ name, values }; name "" for the app's "no scope"), or
//     null, none (env's name with no values, when there's one); of the suite's environments, only
//     the one of its name, never another
//   passed nothing: env's name (--env <name>), else the suite's first environment (the CLI with no --env)
// values: the ones passed (none passed, none: nothing is read from the folder); suite: the suite's own
// environments.<name>.
export function environmentOf(suite, options = {}) {
  const environments = isObject(suite?.data?.environments) ? suite.data.environments : {};
  const passed = options.environment !== undefined;
  const given = isObject(options.environment) ? options.environment : null;
  const named = given ? (typeof given.name === "string" ? given.name : "") : options.env;
  const envName = named || (passed ? null : Object.keys(environments)[0]) || null;
  if (!envName && !given) return { envName: null, environment: null };
  const values = isObject(given?.values) ? given.values : {};
  const own = envName && Object.prototype.hasOwnProperty.call(environments, envName) ? environments[envName] : null;
  // (secretsFrom: where the host looks for secrets, said when one isn't set: the CLI's)
  return { envName, environment: { name: envName ?? "", values, suite: isObject(own) ? own : {}, ...(options.secretsFrom ? { secretsFrom: options.secretsFrom } : {}) } };
}

// The secrets the host keeps for these scopes (host.knownSecrets(envName) → [values], each scope's
// asked once), added to `into` (a run's or a conversation's, for redaction) and to what the HTTP log
// hides
export async function knownSecrets(host, envNames, into) {
  if (!host.knownSecrets) return;
  for (const envName of new Set(envNames)) {
    for (const value of (await host.knownSecrets(envName)) ?? []) {
      if (typeof value !== "string" || !value) continue;
      into.add(value);
      noteSecret(value);
    }
  }
}

// The name --env (or the app's scope) gives, when it's none of a suite's environments: a problem,
// unless values are passed for it (they're the environment, whatever the suite's are called) or the
// host keeps secrets for it (a scope that has only secrets is one: host.secretScopes(), the app's).
// The message, or null.
export async function unknownEnvironment(suite, options, host) {
  const environments = Object.keys(suite.data?.environments ?? {});
  const passed = !!options.environment && typeof options.environment === "object";
  if (passed || !options.env || !environments.length || environments.includes(options.env)) return null;
  if ((await host.secretScopes?.())?.includes(options.env)) return null;
  return `there's no environment or scope "${options.env}" (${environments.join(", ")})`;
}
