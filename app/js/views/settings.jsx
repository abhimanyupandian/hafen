// The settings modal's panes (contracts/ui.md, Settings): Storage → Runs; Connection → Providers,
// System One, and Relay in the browser build; Configurations → Environments, Secrets (environments.jsx,
// secrets.jsx) and Plugins; App → Appearance and Notifications.

import { useEffect, useState } from "react";
import { ConfirmButton } from "../design/confirm.jsx";
import { useEvent, useStore } from "../design/hooks.js";
import { SegmentedChoice, Select } from "../design/select.jsx";
import { SettingsGroup } from "../design/collapsible.jsx";
import { isApp } from "../lib/app.js";
import { sec, when } from "../lib/format.js";
import * as idb from "../lib/idb.js";
import * as prefs from "../lib/prefs.js";
import { KEYS, store } from "../lib/store.js";
import { audit } from "../lib/audit.js";
import { askSystemPermission, notifySettings, onNotifySettings, setNotifySettings, systemPermission, tryNotification } from "../lib/notifications.js";
import { notify } from "../design/toast.jsx";
import { app, clearConversations, clearRuns, deleteConversation, deleteRun, keepSecrets, reconfigure } from "../state.js";
import { secretNames as storedSecretNames, NAME, NAME_RULE } from "../lib/scope-store.js";
import { EnvironmentsPane } from "./environments.jsx";
import { JEV, SecretsPane } from "./secrets.jsx";
import { PluginsPane } from "./plugins.jsx";
import { runName, runOutcome } from "./derive.js";
import { ProvidersPane } from "./providers.jsx";

const bytes = (value) => new Blob([JSON.stringify(value)]).size;

// Which secret names have a value in `env` ("" holds Globals'): { NAME: true }
async function storedNames(env) {
  return Object.fromEntries((await storedSecretNames(env)).map((n) => [n, true]));
}

// Keep a secret's value ("" forgets it): encrypted by the desktop app, or in this browser's storage
async function keepSecret(env, name, value) {
  if (!NAME.test(name)) throw new Error(NAME_RULE);
  await keepSecrets(env, { [name]: value });
}

// System One (TypeSafe's Jev) judges replies for the systemone.* checks; its key (JEV) is kept like the
// other secrets, in Globals
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
        {isSet && <ConfirmButton className="btn btn-ghost" id="systemoneForget" label="forget" question="forget it?" onConfirm={() => save("")} />}
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
      setStatus({ ok: false, text: "No relay answers there. Start one in Hafen's folder: npm run serve -- --allow-endpoint <url>" });
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

// The theme: Light, System or Dark, side by side, the one chosen pressed (an Addition: Segmented choice)
const themeId = (value) => `theme${value[0].toUpperCase()}${value.slice(1)}`;
function AppearancePane() {
  useEvent("prefs:changed");
  return (
    <>
      <div className="field-head"><span className="hint" id="themeLabel">Theme</span></div>
      <div className="controls">
        <SegmentedChoice id="themeChoice" labelledBy="themeLabel" value={prefs.theme()} options={prefs.THEMES.map(([value, label, about]) => [value, label, about, themeId(value)])}
                         onChange={(value) => { prefs.setTheme(value); audit("config.theme", { theme: value }); }} />
      </div>
    </>
  );
}

// When a run ends (lib/notifications.js): a sound, when; for which outcomes; the system's notification,
// each a group of its own
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
      <SettingsGroup id="notifySoundGroup" label="Sound">
        <label className="check"><input type="checkbox" id="notifySound" checked={settings.sound} onChange={(e) => change({ sound: e.target.checked })} /> Play a sound when a run ends</label>
        <div className="field-head"><label className="hint" htmlFor="notifyWhen">When it sounds</label></div>
        <label className="select">
          <Select id="notifyWhen" value={settings.when} disabled={!settings.sound}
                  options={[["away", "only when I'm not looking at what ran"], ["always", "after every run"]]} onChange={(e) => change({ when: e.target.value })} />
        </label>
        <p className="hint">Not looking: another suite or test is open, or the window is in the background.</p>
      </SettingsGroup>
      <SettingsGroup id="notifyRunsGroup" label="For runs that">
        <div className="notify-outcomes">
          <label className="check"><input type="checkbox" id="notifyPassed" checked={settings.passed} onChange={(e) => change({ passed: e.target.checked })} /> passed</label>
          <label className="check"><input type="checkbox" id="notifyFailed" checked={settings.failed} onChange={(e) => change({ failed: e.target.checked })} /> failed, or couldn't run</label>
        </div>
        <p className="hint">A run you stopped makes no sound.</p>
      </SettingsGroup>
      <SettingsGroup id="notifySystemGroup" label="System notifications"
                     state={!isApp && <span className="hint" id="notifySystemState">{{ granted: "allowed", denied: "blocked by the browser", default: "asks the browser when turned on", unsupported: "this browser has none" }[permission]}</span>}>
        <label className="check"><input type="checkbox" id="notifySystem" checked={settings.system && permission === "granted"} disabled={permission === "denied" || permission === "unsupported"}
                                         onChange={(e) => turnSystem(e.target.checked)} /> Also show the system's notification when Hafen isn't in front</label>
        {permission === "denied" && <p className="hint">Allow notifications for this page in the browser's settings, then turn this on.</p>}
      </SettingsGroup>
      <div className="settings-block">
        <div className="controls">
          <button className="btn" id="notifyTry" type="button" onClick={() => { tryNotification(); notify({ title: "Passed: a sample run", text: "5/5 checks · 1.2 s", kind: "ok", system: false }); }}>Try it</button>
        </div>
      </div>
    </>
  );
}

export function panes() {
  return [
    {
      id: "runs", group: "Storage", label: "Runs", title: "Runs",
      description: isApp ? "Runs kept by the app, with their conversations, results and timings." : "Runs kept in this browser, with their conversations, results and timings.",
      async items() {
        // (a run kept part way, or written by something else, may lack its tests or suites)
        return (await idb.all("runs")).sort((a, b) => (b.started ?? 0) - (a.started ?? 0)).map((r) => ({
          _id: r._id, name: runName(r, app.get().suites),
          detail: `${when(r.started)} · ${runOutcome(r)?.text ?? r.status} · ${sec(r.ms)}`, size: bytes(r),
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
      description: "The endpoints your tests talk to, kept by the app. Each is a provider file, which suites name; Export writes it with the suites that use it, for the command line to use as it is.",
    },
    {
      id: "systemone", group: "Connection", label: "System One", title: "System One", Body: SystemOnePane,
      description: isApp
        ? "TypeSafe's System One (Jev) judges replies against your questions. Its key is kept encrypted by the system, with your other secrets, and never goes in your files, runs or reports."
        : "TypeSafe's System One (Jev) judges replies against your questions. In the browser build its key is kept in this browser's storage, unencrypted: use the desktop app for keys that matter.",
    },
    !isApp && { id: "relay", group: "Connection", label: "Relay", title: "Relay", description: "In a browser, an endpoint that doesn't allow web pages to call it can be reached through Hafen's relay (npm run serve, in Hafen's folder). When the app is served by the relay, it's used by itself.", Body: RelayPane },
    // (no description: scope panes explain nothing in words; spec/design/components.md, Scope panes)
    { id: "environments", group: "Configurations", label: "Environments", title: "Environments", Body: EnvironmentsPane },
    { id: "secrets", group: "Configurations", label: "Secrets", title: "Secrets", Body: SecretsPane },
    {
      id: "plugins", group: "Configurations", label: "Plugins", title: "Plugins", Body: PluginsPane,
      description: "Plugins add what configuration can't describe: a provider, a check, a judge, or a fixture that logs in first. The app keeps them as files in plugins/, and Export writes the ones a suite uses with it.",
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
