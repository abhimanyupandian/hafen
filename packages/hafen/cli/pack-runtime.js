// A packed run (hafen pack, cli/pack.js): the command line, bundled into one file with the suites it
// was packed with and everything they need, run with Node alone (no hafen, no npm install, no project
// folder). Its files are the pack's: suites, providers, data files, prices, and plugins (each
// bundled with what it imports). An environment's values and the secrets aren't in it:
// they're given where it runs, as the command line's are (--env <file>, --secret <file>, or the
// secrets as environment variables), the files read from the disk there (their names are in the
// .env.example and .secret.example pack writes next to it). Reports and run files are written where
// it runs.
//
//   node refunds.hafen-pack.mjs run [suites…] [options]   (the suites: all of them, or some by path)
//   node refunds.hafen-pack.mjs run --env ./staging.env --secret ./staging.secrets.env
//   node refunds.hafen-pack.mjs validate | report | compare | info | --version | --help
//
// The pack's file is also its plugins' worker: started again in a worker thread (with no environment),
// it serves one plugin instead of running a command.

import { createHash } from "node:crypto";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { servePlugin } from "../engine/plugin-worker-core.js";
import { fetchTransport } from "../engine/transport.js";
import { err, main } from "./commands.js";
import { VERSION } from "./node-host.js";

// pack: { name, created, hafen, from, suites: [paths], files: { path: text }, packages: { name: path },
//         plugins: { path: { kind, name, version, files } }, environment: [names], secrets: [names] }
export function runPack(pack) {
  if (!isMainThread && workerData?.hafen === "plugin") return servePluginHere();
  const argv = process.argv.slice(2);
  if (argv[0] === "info") {
    process.stdout.write(`${info(pack)}\n`);
    return;
  }
  if (argv[0] === "--version" || argv[0] === "-v") {
    process.stdout.write(`${VERSION} (pack ${pack.name}, packed ${pack.created} with hafen ${pack.hafen})\n`);
    return;
  }
  main(argv, { host: packHost(pack), help: help(pack) }).then(
    (code) => { if (code !== null) process.exitCode = code; },
    (e) => {
      err(e?.stack ?? String(e));
      process.exitCode = 2;
    },
  );
}

// In a plugin's worker thread: serve the plugin it's sent (bundled into one module, so loaded from its text)
function servePluginHere() {
  servePlugin({
    receive: (handler) => parentPort.on("message", handler),
    send: (message) => parentPort.postMessage(message),
    importSource: (source) => import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`),
  });
}

const normal = (p) => String(p ?? "").replace(/\\/g, "/").replace(/^(\.\/)+/, "").replace(/\/+$/, "").replace(/^\.$/, "");

// The command line's host, over the pack's files
function packHost(pack) {
  const files = new Map(Object.entries(pack.files));
  const has = (p) => files.has(normal(p));
  const under = (dir) => [...files.keys()].filter((f) => !normal(dir) || f.startsWith(`${normal(dir)}/`));
  const refuse = async (p) => { throw new Error(`${p}: a pack's files can't be changed`); };
  return {
    root: pack.name,
    packed: true,
    transport: fetchTransport(),
    // (with --secret, the command line's: its file's, then the environment's)
    secrets: (name) => process.env[name],
    now: () => performance.now(),
    clock: () => Date.now(),
    where: { app: "cli", version: VERSION, os: process.platform, node: process.versions.node, pack: pack.name },
    sha256: async (text) => createHash("sha256").update(text).digest("hex"),
    files: {
      read: async (p) => {
        if (!has(p)) throw new Error(`${p} isn't in the pack`);
        return files.get(normal(p));
      },
      exists: async (p) => has(p) || under(p).length > 0,
      outside: (p) => !has(p),
      write: refuse,
      remove: refuse,
    },
    list: async (dir) => under(dir),
    saveRun: undefined,
    // A plugin's worker: this file again, in a thread with no environment
    pluginWorker: () => {
      const worker = new Worker(new URL(import.meta.url), { workerData: { hafen: "plugin" }, env: {}, execArgv: [...process.execArgv, "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON"] });
      return {
        post: (message) => worker.postMessage(message),
        onMessage: (handler) => worker.on("message", handler),
        onError: (handler) => worker.on("error", handler),
        terminate: () => worker.terminate(),
      };
    },
    // The secrets its plugins name in their code ({{secret.NAME}}): NAME → the plugin
    pluginSecrets: pack.pluginSecrets ?? {},
    // A plugin package a suite names: bundled into the pack
    resolvePackage: async (name) => {
      if (!pack.packages?.[name]) throw new Error(`the package ${name} wasn't packed`);
      return pack.packages[name];
    },
    // The suites to run: all the pack's, or the ones named (a suite's path, or a folder it's in)
    findSuites: async (paths) => {
      if (!paths.length) return [...pack.suites];
      const found = [];
      for (const p of paths) {
        const at = normal(p);
        const these = pack.suites.filter((s) => s === at || !at || s.startsWith(`${at}/`));
        if (!these.length) throw Object.assign(new Error(`${p} isn't a suite in the pack (it has ${pack.suites.join(", ")})`), { setup: true });
        found.push(...these);
      }
      return [...new Set(found)].sort();
    },
  };
}

function help(pack) {
  const environment = pack.environment ?? [];
  return `${pack.name}: ${pack.suites.length} suite${pack.suites.length === 1 ? "" : "s"}, packed ${pack.created} with hafen ${pack.hafen}

  node ${pack.name} run [suites…] [options]   run its suites (all, or some: tests/refunds.hafen.yml, tests/)
  node ${pack.name} validate [suites…]        check them; sends nothing (--env-check: every secret set)
  node ${pack.name} report <run-file> --report <format>:<path>
  node ${pack.name} compare <run-file> --baseline <run-file>
  node ${pack.name} info                      what's in it, and the values and secrets it needs

The options are the command line's (hafen --help): --env, --secret, --var, --test, --tag, --report,
--baseline, --max-cost, --bail, --verbose…
Environment values ({{env.NAME}}), from --env <file> (KEY=VALUE): ${environment.length ? `${environment.join(", ")}.` : "it uses none."}
Secrets, from --secret <file> (KEY=VALUE, never committed), else the environment's variables: ${pack.secrets.length ? `${pack.secrets.join(", ")}.` : "it needs none."}${environment.length || pack.secrets.length ? `
  node ${pack.name} run${environment.length ? " --env ./staging.env" : ""}${pack.secrets.length ? " --secret ./staging.secrets.env" : ""}` : ""}`;
}

function info(pack) {
  const sha = (text) => createHash("sha256").update(text).digest("hex").slice(0, 12);
  const files = Object.entries(pack.files);
  const lines = [
    `${pack.name}: packed ${pack.created} with hafen ${pack.hafen}, from ${pack.from}`,
    "",
    `suites (${pack.suites.length}):`, ...pack.suites.map((s) => `  ${s}  ${sha(pack.files[s])}`),
  ];
  const plugins = Object.entries(pack.plugins ?? {});
  if (plugins.length) lines.push("", `plugins (${plugins.length}, each bundled with what it imports):`, ...plugins.map(([p, m]) => `  ${p}  ${m.kind} ${m.name} ${m.version} · ${m.files} file${m.files === 1 ? "" : "s"}  ${sha(pack.files[p])}`));
  const rest = files.filter(([p]) => !pack.suites.includes(p) && !pack.plugins?.[p]);
  if (rest.length) lines.push("", `files (${rest.length}):`, ...rest.map(([p, text]) => `  ${p}  ${sha(text)}`));
  lines.push("", `environment values it uses, from --env <file>: ${pack.environment?.length ? pack.environment.join(", ") : "none"}`);
  lines.push(`secrets it needs, from --secret <file> or the environment: ${pack.secrets.length ? pack.secrets.join(", ") : "none"}`);
  return lines.join("\n");
}
