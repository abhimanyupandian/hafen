// Settings → Configurations → Plugins (contracts/ui.md, Settings): the plugins the app keeps
// (plugins/*.js, and any a suite names), each loaded to show what it is (a provider, a check, a judge
// or a fixture, its version, the hosts it may reach, the names a fixture gives and the lists it runs
// in, its phases) and which suites use it; a new one from a starting file (a provider one with a
// provider file, so it's in Providers, and in a new provider's kinds, at once); edited, its JavaScript
// in colour; deleted. Any suite may use them by name. A plugin runs in a worker of its own, and never
// holds a secret's value.
//
// showPlugin(name, { back }) opens it on one plugin, by its name: its code in the editor (a provider's
// fixture, or a plugin's call on the timeline, goes straight to what it runs). Closing that editor
// goes back where the link was: out of Settings, if it opened Settings; else `back` (a provider's
// fixtures, in Settings → Providers).

import { useEffect, useState } from "react";
import { FIXTURE_PHASES } from "hafen/engine/fixture-lists.js";
import { pluginTemplate, pluginUse, PLUGIN_KINDS } from "hafen/engine/plugin-templates.js";
import { ConfirmButton } from "../design/confirm.jsx";
import { Editor } from "../design/editor.jsx";
import { createStore, useStore } from "../design/hooks.js";
import { Select } from "../design/select.jsx";
import { closeSettings, openSettings, settingsOpen } from "../design/settings-modal.jsx";
import { notify } from "../design/toast.jsx";
import { app, createPluginProvider, deleteFile, engineCall, readFile, reload, writeFile } from "../state.js";

// The plugin to open when the pane shows (its name), once; and where its editor's closing goes back to
const pane = createStore({ open: null, back: null });

export function showPlugin(name, { back } = {}) {
  pane.set({ open: name, back: settingsOpen() ? back ?? null : closeSettings });
  openSettings("plugins");
}

export function PluginsPane() {
  const state = useStore(app);
  const { open } = useStore(pane);
  const [list, setList] = useState(null);
  const [error, setError] = useState("");
  const [kind, setKind] = useState("provider");
  const [name, setName] = useState("");
  const [editing, setEditing] = useState(null);  // { file, value, back }: back, where closing it goes
  const refresh = async () => {
    try {
      setList(await engineCall("plugins", {}));
    } catch (err) {
      setError(err.message);
      setList([]);
    }
  };
  useEffect(() => { if (state.ready) refresh(); }, [state.ready, state.suites]);
  // One asked for (showPlugin): shown, and its code opened (a package's can't be edited here)
  useEffect(() => {
    if (!open || list === null) return;
    const { back } = pane.get();
    pane.set({ open: null, back: null });
    const plugin = list.find((p) => p.meta?.name === open);
    if (!plugin) return setError(`There's no plugin named "${open}" in your plugins/ or the suites' plugins.`);
    document.getElementById(`plugin-${open.replace(/[^A-Za-z0-9_-]/g, "-")}`)?.scrollIntoView({ block: "nearest" });
    if (!plugin.package) readFile(plugin.file).then((value) => setEditing({ file: plugin.file, value, back }), (err) => setError(err.message));
    return undefined;
  }, [open, list]);
  const act = async (work) => {
    setError("");
    try {
      await work();
      await refresh();
      return true;
    } catch (err) {
      setError(err.message);
      return false;
    }
  };

  return (
    <>
      <p className="hint error" id="pluginsError" role="alert" hidden={!error}>{error}</p>
      {list === null ? <p className="note placeholder">Loading the plugins…</p> : list.length === 0 ? <p className="note placeholder" id="pluginsEmpty">No plugins yet: add one below.</p> : (
        <ul className="list settings-list" id="pluginList" aria-label="Plugins">
          {list.map((p) => {
            const id = (p.meta?.name ?? p.file).replace(/[^A-Za-z0-9_-]/g, "-");
            return (
              <li key={p.file} className="settings-row plugin-row" id={`plugin-${id}`}>
                <div className="settings-row-text">
                  <span className="settings-row-name">{p.meta ? `${p.meta.name} · ${p.meta.kind} · ${p.meta.version}` : p.file}</span>
                  <span className="hint">{[p.file, p.meta?.hosts?.length ? `reaches ${p.meta.hosts.join(", ")}` : p.meta ? "reaches no hosts" : null].filter(Boolean).join(" · ")}</span>
                  {p.meta?.kind === "fixture" && <span className="hint" id={`plugin-${id}-provides`}>{p.meta.provides?.length ? `Gives ${p.meta.provides.join(", ")}, for the run` : "Gives the values its run() returns, for the run"}</span>}
                  {/* (the lists a provider can name it in: its phases, all four when it doesn't say) */}
                  {p.meta?.kind === "fixture" && <span className="hint" id={`plugin-${id}-phases`}>{`Runs in ${(Array.isArray(p.meta.phases) ? p.meta.phases : FIXTURE_PHASES).join(", ")}`}</span>}
                  {p.error && <span className="hint error" role="alert">{p.error}</span>}
                  {p.meta && <span className="hint">{`Any ${p.meta.kind === "fixture" ? "provider" : "suite"} can use it: ${pluginUse(p.meta.kind, p.meta.name)}`}</span>}
                  <span className="hint plugin-used" id={`plugin-${id}-used`}>{p.usedBy.length ? `Used by ${p.usedBy.join(", ")}` : "Used by no suite yet"}</span>
                </div>
                {!p.package && <button className="btn" type="button" id={`plugin-${id}-edit`} onClick={async () => setEditing({ file: p.file, value: await readFile(p.file) })}>edit</button>}
                {!p.package && <ConfirmButton className="btn btn-ghost list-del" id={`plugin-${id}-delete`} aria-label={`Delete ${p.file}`} label="×" question="delete file?" onConfirm={() => act(() => deleteFile(p.file))} />}
              </li>
            );
          })}
        </ul>
      )}
      <div className="field-head"><label className="hint" htmlFor="newPluginName">Add a plugin</label></div>
      <form className="controls" id="newPluginForm" onSubmit={async (e) => {
        e.preventDefault();
        const next = name.trim();
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(next)) return setError("A plugin's name is letters, digits, '.', '-' and '_'.");
        // (a provider one with its provider file, so it's in Providers at once)
        if (await act(async () => {
          await engineCall("create", { file: `plugins/${next}.js`, text: pluginTemplate(kind, next) });
          if (kind === "provider") await createPluginProvider(next, `plugins/${next}.js`);
          // (the files read again: a provider's fixtures field, and the message box, know of it now)
          else await reload();
        })) setName("");
        return undefined;
      }}>
        <label className="select"><Select id="newPluginKind" value={kind} options={PLUGIN_KINDS.map((k) => [k.id, k.label])} onChange={(e) => setKind(e.target.value)} /></label>
        <input className="input grow" id="newPluginName" type="text" placeholder="its name: acme, polite…" autoComplete="off" spellCheck={false} value={name} onChange={(e) => setName(e.target.value)} />
        <button className="btn" type="submit" disabled={!name.trim()}>add</button>
      </form>
      <p className="hint">{"A plugin is an ES module, and can import any other file or package (in the desktop app and the CLI; in a browser it's one module). It runs in a worker of its own with no environment variables, reaches only the hosts it names, and writes a secret in a request's headers or JSON body as {{secret.NAME}} (\"Bearer {{secret.NAME}}\") for the engine to fill in as it leaves, so it never holds their values."}</p>
      {editing && <Editor field={{ value: editing.value, code: true, spellcheck: false, language: "javascript" }} label={editing.file} onClose={() => { setEditing(null); editing.back?.(); }} onSave={async (next) => {
        try {
          await writeFile(editing.file, next);
          await refresh();
        } catch (err) {
          notify({ title: `Couldn't save ${editing.file}`, text: err.message, kind: "error" });
        }
      }} />}
    </>
  );
}
