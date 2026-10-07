// The engine in the desktop app: an Electron utility process running hafen/engine/serve-port.js in Node, as
// the CLI does (research §5). The main process sends it a port to the page (one per page load) and the
// secrets it keeps; files are read and written here, under the folder the page opened, and each run is
// also written to <folder>/.hafen/runs/ (git-ignored).

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { nodeHost } from "hafen/cli/node-host.js";
import { servePort } from "hafen/engine/serve-port.js";
import { runFileName, serializeRun } from "hafen/engine/reports/run-file.js";

let secrets = {};  // env -> {NAME: value}; "" holds values for every environment

const secretOf = (name, { env } = {}) => secrets[env ?? ""]?.[name] ?? secrets[""]?.[name] ?? process.env[name];

async function saveRun(root, run) {
  if (!root || run.mode === "explore") return;
  const dir = join(root, ".hafen", "runs");
  await mkdir(dir, { recursive: true });
  const ignore = join(root, ".hafen", ".gitignore");
  try { await readFile(ignore); } catch { await writeFile(ignore, "# Hafen's runs: kept out of version control\n*\n"); }
  await writeFile(join(dir, runFileName(run)), serializeRun(run));
}

process.parentPort.on("message", (e) => {
  const message = e.data;
  if (message?.type === "secrets") {
    secrets = message.values ?? {};
    return;
  }
  if (message?.type === "port" && e.ports?.[0]) {
    const port = e.ports[0];
    servePort(
      {
        receive: (handler) => port.on("message", (event) => handler(event.data)),
        send: (m) => port.postMessage(m),
      },
      async ({ root }) => {
        if (!root) throw new Error("choose a folder");
        return nodeHost({ root, app: "desktop", secrets: secretOf, saveRun: (run) => saveRun(root, run) });
      },
    );
    port.start();
  }
});
