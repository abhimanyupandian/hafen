// The engine in the desktop app: an Electron utility process running hafen/engine/serve-port.js in Node, as
// the CLI does (research §5). The main process sends it a port to the page (one per page load), with
// the app's workspace (<the app's data folder>/workspace: its suites, providers, plugins and data
// files, where the engine reads and writes them), the secrets it keeps, and each folder the user picked
// in its dialogs to import from or export to (only those: the page names one by its id).

import { nodeHost } from "hafen/cli/node-host.js";
import { servePort } from "hafen/engine/serve-port.js";
import { setPluginsWhere } from "hafen/engine/plugin-place.js";

// (the app keeps its plugins: a problem naming one that isn't there says where to add it)
setPluginsWhere("your plugins (Settings → Plugins) or the suite's plugins");

let secrets = {};  // env -> {NAME: value}; "" holds Globals', for every scope
// The values come only when they're needed (reading them can ask the user to allow the system's
// keychain): the first run or message asks the main process for them, and waits
const NEED_SECRETS = new Set(["run", "send"]);
let given;
const secretsGiven = new Promise((resolve) => { given = resolve; });
let asked = false;
const askSecrets = () => {
  if (!asked) process.parentPort.postMessage({ type: "unlock" });
  asked = true;
  return secretsGiven;
};
const places = new Map();  // id → { root, write }: a folder picked in a dialog

// A secret: the scope's own (none chosen: "", Globals' alone), else Globals', else the environment
// variable the app was started with. Only own text values count: {{secret.constructor}} is a secret
// nobody set, not what every object inherits. (The browser build's host looks them up the same way:
// app/js/worker.js.)
const own = (map, key) => (map && typeof map === "object" && Object.hasOwn(map, key) ? map[key] : undefined);
const text = (value) => (typeof value === "string" ? value : undefined);
const secretOf = (name, { env } = {}) => text(own(own(secrets, env || ""), name)) ?? text(own(own(secrets, ""), name)) ?? text(own(process.env, name));
// Every secret value the scope and Globals hold: the engine hides each one in what it keeps (a run
// file), whether a file used it or not
const knownSecrets = (env) => [...new Set([env || "", ""])].flatMap((e) => Object.values(own(secrets, e) ?? {}).filter((v) => typeof v === "string" && v !== ""));
const hostAt = async (root) => Object.assign(await nodeHost({ root, app: "desktop", secrets: secretOf }), { knownSecrets });

process.parentPort.on("message", (e) => {
  const message = e.data;
  if (message?.type === "secrets") {
    secrets = message.values ?? {};
    asked = true;
    given();
    return;
  }
  if (message?.type === "place") {
    places.set(message.id, { root: message.root, write: !!message.write });
    return;
  }
  if (message?.type === "port" && e.ports?.[0]) {
    const port = e.ports[0];
    const workspace = message.workspace;
    servePort(
      {
        // (in order: one that needs the secrets waits for them, and what came after it waits too)
        receive: (handler) => {
          let ready = Promise.resolve();
          port.on("message", (event) => {
            if (NEED_SECRETS.has(event.data?.cmd)) ready = ready.then(askSecrets);
            ready.then(() => handler(event.data));
          });
        },
        send: (m) => port.postMessage(m),
      },
      async () => hostAt(workspace),
      async ({ place }, { write }) => {
        const picked = places.get(place);
        if (!picked) throw new Error("that folder wasn't picked here: pick it again");
        if (write && !picked.write) throw new Error(`${picked.root} was picked to import from, not to export to`);
        return hostAt(picked.root);
      },
    );
    port.start();
  }
});
