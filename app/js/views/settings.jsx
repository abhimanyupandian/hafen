// The settings modal's panes (contracts/ui.md, Settings): Storage → Runs; Connection → Providers,
// System One, and Relay in the browser build; Configurations → Secrets; App → Appearance.

import { useEffect, useRef, useState } from "react";
import { useEvent, useStore } from "../design/hooks.js";
import { Select } from "../design/select.jsx";
import { isApp, invoke } from "../lib/app.js";
import { sec, when } from "../lib/format.js";
import * as idb from "../lib/idb.js";
import * as prefs from "../lib/prefs.js";
import { KEYS, store } from "../lib/store.js";
import { audit } from "../lib/audit.js";
import { askSystemPermission, notifySettings, onNotifySettings, setNotifySettings, systemPermission, tryNotification } from "../lib/notifications.js";
import { notify } from "../design/toast.jsx";
import { app, clearConversations, clearRuns, deleteConversation, deleteRun, reconfigure, refreshSecrets, scopeNames } from "../state.js";
import { EnvironmentsPane } from "./environments.jsx";
import { PluginsPane } from "./plugins.jsx";
import { ProvidersPane } from "./providers.jsx";

const bytes = (value) => new Blob([JSON.stringify(value)]).size;
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const JEV = "JEV_API_KEY";  // System One's key: its own pane, not Secrets
const DEFAULT_KEYS = { "openai-chat": "OPENAI_API_KEY", "openai-responses": "OPENAI_API_KEY", "anthropic-messages": "ANTHROPIC_API_KEY", gemini: "GEMINI_API_KEY" };

// Every ${env:NAME} the open suites and providers name, and the presets' default keys
function secretNames(suites, providers) {
  const names = new Set();
  const scan = (value) => { for (const m of JSON.stringify(value ?? {}).matchAll(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g)) names.add(m[1]); };
  for (const s of suites) {
    scan(s.data);
    for (const p of Object.values(s.providers ?? {})) {
      scan(p);
      if (DEFAULT_KEYS[p.kind] && p.api_key === undefined) names.add(DEFAULT_KEYS[p.kind]);
    }
  }
  for (const p of providers) {
    scan(p.config);
    if (DEFAULT_KEYS[p.config?.kind] && p.config?.api_key === undefined) names.add(DEFAULT_KEYS[p.config.kind]);
  }
  return [...names].sort();
}

// Which secret names have a value in `env` ("" holds values for every environment): { NAME: true }
async function storedNames(env) {
  if (isApp) return (await invoke("secrets_list", { env })) ?? {};
  return Object.fromEntries(Object.keys(store.getJSON(KEYS.secrets, {})[env] ?? {}).map((n) => [n, true]));
}

// Keep a secret's value ("" forgets it): encrypted by the desktop app, or in this browser's storage
async function keepSecret(env, name, value) {
  if (!NAME.test(name)) throw new Error("A secret's name is letters, digits and _, and doesn't start with a digit.");
  // (Its name and environment only: never its value)
  audit("config.secret", { name, env: env || "every", action: value ? "set" : "forget" });
  if (isApp) {
    await invoke("secrets_set", { env, name, value });
    await refreshSecrets();
    return;
  }
  const all = store.getJSON(KEYS.secrets, {});
  all[env] = { ...(all[env] ?? {}) };
  if (value) all[env][name] = value;
  else delete all[env][name];
  store.setJSON(KEYS.secrets, all);
  await reconfigure();
  await refreshSecrets();
}

function SecretsPane() {
  const { suites, providers } = useStore(app);
  const state = useStore(app);
  const envs = scopeNames(state);
  const [env, setEnv] = useState("");  // every scope, unless one is chosen
  const [set, setSet] = useState({});  // name -> "here" (a value for this environment) or "all" (for every one)
  const [error, setError] = useState("");
  const referenced = secretNames(suites, providers);
  // The names the files use, and every name that has a value (your own ones included)
  // (System One's key is in its own pane, Connection → System One)
  const names = [...new Set([...referenced, ...Object.keys(set)])].filter((n) => n !== JEV).sort();
  const read = async () => {
    try {
      const all = env ? await storedNames("") : {};
      const here = await storedNames(env);
      setSet({ ...Object.fromEntries(Object.keys(all).map((n) => [n, "all"])), ...Object.fromEntries(Object.keys(here).map((n) => [n, "here"])) });
    } catch (err) {
      setError(err.message);
    }
  };
  useEffect(() => { read(); }, [env]);
  const save = async (name, value) => {
    setError("");
    try {
      if (name === JEV) throw new Error("JEV_API_KEY is System One's key: set it in Connection → System One.");
      await keepSecret(env, name, value);
      await read();
      return true;
    } catch (err) {
      setError(err.message);
      return false;
    }
  };
  return (
    <>
      <p className="note">{isApp
        ? "The values your suites reference as ${env:NAME}, kept encrypted by the system (the keychain on macOS). They never go in your files, runs or reports. A name with no value here uses the environment variable the app was started with, if there is one."
        : "The values your suites reference as ${env:NAME}. In the browser build they're kept in this browser's storage, unencrypted: use the desktop app for keys that matter."}</p>
      {envs.length > 0 && (
        <>
          <div className="field-head"><label className="hint" htmlFor="secretsEnv">Scope</label></div>
          <label className="select"><Select id="secretsEnv" value={env} options={[["", "every scope"], ...envs.map((e) => [e, e])]} onChange={(e) => setEnv(e.target.value)} /></label>
        </>
      )}
      <p className="hint error" id="secretsError" role="alert" hidden={!error}>{error}</p>
      {names.length ? (
        <ul className="list settings-list" id="secretsList" aria-label="Secrets">
          {names.map((name) => <SecretRow key={`${env}-${name}`} name={name} kept={set[name]} used={referenced.includes(name)} onSave={(v) => save(name, v)} />)}
        </ul>
      ) : <p className="note placeholder" id="secretsEmpty">The open suites don't reference any secrets yet.</p>}
      <AddSecret onSave={save} />
      <p className="hint">{"Use one in a suite or provider as ${env:NAME}. In CI, set them as the job's environment variables."}</p>
    </>
  );
}

// kept: "here" (this environment has a value), "all" (every environment's value applies), or nothing
function SecretRow({ name, kept, used, onSave }) {
  const isSet = !!kept;
  const [value, setValue] = useState("");
  return (
    <li className="settings-row" id={`secret-${name}`}>
      <div className="settings-row-text">
        <span className="settings-row-name">{name}</span>
        <span className={`hint${isSet ? "" : " error"}`}>{isSet ? [kept === "all" ? "set for every scope" : "set", !used && "not used by the open files"].filter(Boolean).join(" · ") : "not set"}</span>
      </div>
      <input className="input" type="password" aria-label={`Value of ${name}`} placeholder={isSet ? "a new value" : "its value"} value={value} onChange={(e) => setValue(e.target.value)} style={{ width: 200 }} />
      <button className="btn" type="button" disabled={!value} onClick={async () => { if (await onSave(value)) setValue(""); }}>save</button>
      {kept === "here" && <button className="btn btn-ghost" type="button" onClick={() => onSave("")}>forget</button>}
    </li>
  );
}

// A secret under a name of your own; the form stays, so you can add as many as you need
function AddSecret({ onSave }) {
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const nameRef = useRef(null);
  return (
    <>
      <div className="field-head"><label className="hint" htmlFor="secretName">Add a secret</label></div>
      <form className="controls" id="secretAdd" onSubmit={async (e) => {
        e.preventDefault();
        if (!(await onSave(name.trim(), value))) return;
        setName("");
        setValue("");
        nameRef.current?.focus();
      }}>
        <input className="input grow" id="secretName" type="text" placeholder="NAME" aria-label="Name" autoComplete="off" spellCheck={false}
               ref={nameRef} value={name} onChange={(e) => setName(e.target.value)} />
        <input className="input grow" id="secretValue" type="password" placeholder="its value" aria-label="Value" autoComplete="off"
               value={value} onChange={(e) => setValue(e.target.value)} />
        <button className="btn" type="submit" disabled={!name.trim() || !value}>add</button>
      </form>
    </>
  );
}

// System One (TypeSafe's Jev) judges replies for the systemone.* checks; its key (JEV, above) is kept
// like the other secrets, for every environment
function SystemOnePane() {
  const [isSet, setIsSet] = useState(false);
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const read = async () => {
    try {
      setIsSet(!!(await storedNames(""))[JEV]);
    } catch (err) {
      setError(err.message);
    }
  };
  useEffect(() => { read(); }, []);
  const save = async (next) => {
    setError("");
    try {
      await keepSecret("", JEV, next);
      setValue("");
      await read();
    } catch (err) {
      setError(err.message);
    }
  };
  return (
    <>
      <div className="field-head">
        <label className="hint" htmlFor="systemoneKey">API key · JEV_API_KEY</label>
        <span className={`hint${isSet ? "" : " error"}`} id="systemoneKeyState">{isSet ? "set" : "not set"}</span>
      </div>
      <form className="controls" id="systemoneForm" onSubmit={(e) => { e.preventDefault(); if (value) save(value); }}>
        <input className="input grow" id="systemoneKey" type="password" autoComplete="off" placeholder={isSet ? "a new key" : "your System One key"} value={value} onChange={(e) => setValue(e.target.value)} />
        <button className="btn" id="systemoneSave" type="submit" disabled={!value}>save</button>
        {isSet && <button className="btn btn-ghost" id="systemoneForget" type="button" onClick={() => save("")}>forget</button>}
      </form>
      <p className="hint error" id="systemoneError" role="alert" hidden={!error}>{error}</p>
      <p className="hint">{"The systemone.noul, systemone.choice and systemone.score checks use it in every environment, unless a suite's judge names another key. They call https://api.typesafe.ai with the model jev-latest, unless the judge says otherwise. In CI, set JEV_API_KEY as the job's environment variable."}</p>
      <p className="hint"><a href="https://docs.typesafe.ai/introduction" target="_blank" rel="noreferrer">System One's documentation</a></p>
    </>
  );
}

function RelayPane() {
  const { relay } = useStore(app);
  const [value, setValue] = useState(relay ?? "");
  const [status, setStatus] = useState(null);
  const check = async (address) => {
    if (!address) return setStatus(null);
    try {
      const res = await fetch(`${address.replace(/\/+$/, "")}/relay/ping`);
      const body = await res.json();
      setStatus({ ok: true, text: `The relay answers, allowing ${body.endpoints} endpoint prefix${body.endpoints === 1 ? "" : "es"}.` });
    } catch {
      setStatus({ ok: false, text: "No relay answers there. Start one: npx hafen serve --allow-endpoint <url>" });
    }
  };
  useEffect(() => { check(relay); }, [relay]);
  return (
    <>
      <div className="field-head"><label className="hint" htmlFor="relayAddress">Address</label></div>
      <form className="controls" onSubmit={async (e) => {
        e.preventDefault();
        const address = value.trim().replace(/\/+$/, "");
        if (address) store.set(KEYS.relay, address);
        else store.remove(KEYS.relay);
        audit("config.relay", { relay: address || "none" });
        app.set({ relay: address || null });
        await reconfigure();
      }}>
        <input className="input grow" id="relayAddress" type="url" placeholder="http://127.0.0.1:8790" value={value} onChange={(e) => setValue(e.target.value)} />
        <button className="btn" type="submit">save</button>
      </form>
      {status && <p className={`server-status${status.ok ? " ok" : " error"}`}>{status.text}</p>}
    </>
  );
}

function AppearancePane() {
  useEvent("prefs:changed");
  return (
    <>
      <div className="field-head"><label className="hint" htmlFor="themeSelect">Theme</label></div>
      <label className="select">
        <Select id="themeSelect" value={prefs.theme()} options={prefs.THEMES} onChange={(e) => { prefs.setTheme(e.target.value); audit("config.theme", { theme: e.target.value }); }} />
      </label>
    </>
  );
}

// When a run ends (lib/notifications.js): a sound, when; for which outcomes; the system's notification
function NotificationsPane() {
  const [settings, setSettings] = useState(notifySettings);
  const [permission, setPermission] = useState(systemPermission);
  useEffect(() => onNotifySettings(setSettings), []);
  const change = (changes) => {
    setNotifySettings(changes);
    audit("config.notifications", changes);
  };
  const turnSystem = async (on) => {
    // (a browser asks its permission first; refused, it stays off)
    if (on && !isApp) {
      const answer = await askSystemPermission();
      setPermission(answer);
      if (answer !== "granted") return;
    }
    change({ system: on });
  };
  return (
    <>
      <p className="hint">When a run ends, its notification shows at the top right; click it to open what ran.</p>
      <div className="field-head"><span className="hint">Sound</span></div>
      <label className="check"><input type="checkbox" id="notifySound" checked={settings.sound} onChange={(e) => change({ sound: e.target.checked })} /> Play a sound when a run ends</label>
      <div className="field-head"><label className="hint" htmlFor="notifyWhen">When it sounds</label></div>
      <label className="select">
        <Select id="notifyWhen" value={settings.when} disabled={!settings.sound}
                options={[["away", "only when I'm not looking at what ran"], ["always", "after every run"]]} onChange={(e) => change({ when: e.target.value })} />
      </label>
      <p className="hint">Not looking: another suite or test is open, or the window is in the background.</p>
      <div className="field-head"><span className="hint">For runs that</span></div>
      <div className="notify-outcomes">
        <label className="check"><input type="checkbox" id="notifyPassed" checked={settings.passed} onChange={(e) => change({ passed: e.target.checked })} /> passed</label>
        <label className="check"><input type="checkbox" id="notifyFailed" checked={settings.failed} onChange={(e) => change({ failed: e.target.checked })} /> failed, or couldn't run</label>
      </div>
      <p className="hint">A run you stopped makes no sound.</p>
      <div className="field-head"><span className="hint">System notifications</span>
        {!isApp && <span className="hint" id="notifySystemState">{{ granted: "allowed", denied: "blocked by the browser", default: "asks the browser when turned on", unsupported: "this browser has none" }[permission]}</span>}
      </div>
      <label className="check"><input type="checkbox" id="notifySystem" checked={settings.system && permission === "granted"} disabled={permission === "denied" || permission === "unsupported"}
                                       onChange={(e) => turnSystem(e.target.checked)} /> Also show the system's notification when Hafen isn't in front</label>
      {permission === "denied" && <p className="hint">Allow notifications for this page in the browser's settings, then turn this on.</p>}
      <div className="controls">
        <button className="btn" id="notifyTry" type="button" onClick={() => { tryNotification(); notify({ title: "Passed: a sample run", text: "5/5 checks · 1.2 s", kind: "ok", system: false }); }}>Try it</button>
      </div>
    </>
  );
}

export function panes() {
  return [
    {
      id: "runs", group: "Storage", label: "Runs", title: "Runs",
      description: isApp ? "Runs kept by the app, with their conversations, results and timings. Runs of an open folder are also written to its .hafen/runs folder." : "Runs kept in this browser, with their conversations, results and timings.",
      async items() {
        // (a run kept part way, or written by something else, may lack its tests or suites)
        return (await idb.all("runs")).sort((a, b) => (b.started ?? 0) - (a.started ?? 0)).map((r) => ({
          _id: r._id, name: (r.tests ?? []).length === 1 ? r.tests[0].name : (r.suites ?? []).map((s) => s.name ?? s.file).join(", ") || "run",
          detail: `${when(r.started)} · ${r.status === "done" ? r.verdict : r.status} · ${sec(r.ms)}`, size: bytes(r),
        }));
      },
      remove: (item) => deleteRun(item._id),
      clear: () => clearRuns(),
      clearQuestion: "delete every run?",
      redrawOn: "runs:changed",
    },
    {
      id: "conversations", group: "Storage", label: "Conversations", title: "Conversations",
      description: isApp ? "Conversations kept by the app, as Conversations lists them: each message, its reply and its steps." : "Conversations kept in this browser, as Conversations lists them: each message, its reply and its steps.",
      async items() {
        return (await idb.all("conversations")).sort((a, b) => b.updated - a.updated).map((c) => ({
          _id: c._id, name: c.title, detail: `${when(c.updated)} · ${c.run?.turns?.length ?? 0} turns`, size: bytes(c),
        }));
      },
      remove: (item) => deleteConversation(item._id),
      clear: () => clearConversations(),
      clearQuestion: "delete every conversation?",
      redrawOn: "conversations:changed",
    },
    {
      id: "providers", group: "Connection", label: "Providers", title: "Providers", Body: ProvidersPane,
      description: "The endpoints your tests talk to. Each is a file in the open folder's providers/ folder, which suites name, and which the command line uses as it is.",
    },
    {
      id: "systemone", group: "Connection", label: "System One", title: "System One", Body: SystemOnePane,
      description: isApp
        ? "TypeSafe's System One (Jev) judges replies against your questions. Its key is kept encrypted by the system, with your other secrets, and never goes in your files, runs or reports."
        : "TypeSafe's System One (Jev) judges replies against your questions. In the browser build its key is kept in this browser's storage, unencrypted: use the desktop app for keys that matter.",
    },
    !isApp && { id: "relay", group: "Connection", label: "Relay", title: "Relay", description: "In a browser, an endpoint that doesn't allow web pages to call it can be reached through Hafen's relay (npx hafen serve). When the app is served by the relay, it's used by itself.", Body: RelayPane },
    {
      id: "environments", group: "Configurations", label: "Environments", title: "Environments", Body: EnvironmentsPane,
      description: "Each scope's plain variables (stage, prod…), kept as plain YAML in the open folder: environments/<scope>.yml. Any field takes one as {{scope.NAME}}, for the scope chosen here: the scope button at the top of the sidebar opens this pane.",
    },
    { id: "secrets", group: "Configurations", label: "Secrets", title: "Secrets", Body: SecretsPane },
    {
      id: "plugins", group: "Configurations", label: "Plugins", title: "Plugins", Body: PluginsPane,
      description: "Plugins add a provider, a check or a judge that configuration can't describe: an ES module in the folder's plugins/, named by the suites that use it (plugins: [./plugins/acme.js]). The command line runs them as the app does.",
    },
    { id: "appearance", group: "App", label: "Appearance", title: "Appearance", Body: AppearancePane },
    { id: "notifications", group: "App", label: "Notifications", title: "Notifications", Body: NotificationsPane },
  ].filter(Boolean);
}

// The storage the app's runs and conversations use ("2.7 MB"); how many of each, on hover
export async function usage() {
  try {
    const est = await navigator.storage?.estimate?.();
    const runs = await idb.all("runs");
    const conversations = await idb.all("conversations");
    const size = [...runs, ...conversations].reduce((s, r) => s + bytes(r), 0);
    const counts = `${runs.length} run${runs.length === 1 ? "" : "s"} · ${conversations.length} conversation${conversations.length === 1 ? "" : "s"}`;
    return { value: `${(size / 1e6).toFixed(1)} MB`, title: [counts, est ? `this ${isApp ? "app" : "browser"}'s storage: ${(est.usage / 1e6).toFixed(0)} MB in all` : ""].filter(Boolean).join(" · ") };
  } catch {
    return null;
  }
}
