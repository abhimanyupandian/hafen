// Settings → Configurations → Plugins (contracts/ui.md, Settings): the folder's plugins (plugins/*.js,
// and any a suite names), each loaded to show what it is (a provider, a check, a judge or a fixture,
// its version, the hosts it may reach, the names a fixture gives) and which suites use it; a new one from a starting file (a provider one with
// a provider file, so it's in Providers at once); edited, its JavaScript in colour; deleted. Any suite
// in the folder may use the folder's plugins by name. A plugin runs in a worker of its own, and never
// holds a secret's value.

import { useEffect, useState } from "react";
import { pluginTemplate, pluginUse, PLUGIN_KINDS } from "../../../engine/plugin-templates.js";
import { ConfirmButton } from "../design/confirm.jsx";
import { Editor } from "../design/editor.jsx";
import { useStore } from "../design/hooks.js";
import { Select } from "../design/select.jsx";
import { notify } from "../design/toast.jsx";
import { app, createPluginProvider, deleteFile, engineCall, readFile, writeFile } from "../state.js";

export function PluginsPane() {
  const state = useStore(app);
  const [list, setList] = useState(null);
  const [error, setError] = useState("");
  const [kind, setKind] = useState("provider");
  const [name, setName] = useState("");
  const [editing, setEditing] = useState(null);  // { file, value }
  const refresh = async () => {
    try {
      setList(await engineCall("plugins", {}));
    } catch (err) {
      setError(err.message);
      setList([]);
    }
  };
  useEffect(() => { if (state.opened) refresh(); }, [state.opened, state.suites]);
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

  if (!state.opened || !state.canWrite) return <p className="note placeholder" id="pluginsClosed">Open a folder first: plugins are files in its plugins/ folder.</p>;
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
                  {p.meta?.kind === "fixture" && <span className="hint" id={`plugin-${id}-provides`}>{p.meta.provides?.length ? `Gives ${p.meta.provides.join(", ")}, for the run` : "Gives the values its setup() returns, for the run"}</span>}
                  {p.error && <span className="hint error" role="alert">{p.error}</span>}
                  {p.meta && <span className="hint">{`Any ${p.meta.kind === "fixture" ? "provider" : "suite"} in the folder can use it: ${pluginUse(p.meta.kind, p.meta.name)}`}</span>}
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
        })) setName("");
        return undefined;
      }}>
        <label className="select"><Select id="newPluginKind" value={kind} options={PLUGIN_KINDS.map((k) => [k.id, k.label])} onChange={(e) => setKind(e.target.value)} /></label>
        <input className="input grow" id="newPluginName" type="text" placeholder="its name: acme, polite…" autoComplete="off" spellCheck={false} value={name} onChange={(e) => setName(e.target.value)} />
        <button className="btn" type="submit" disabled={!name.trim()}>add</button>
      </form>
      <p className="hint">{"A plugin is an ES module, and can import any other file or package (in the desktop app and the CLI; in a browser it's one module). It runs in a worker of its own with no environment variables, reaches only the hosts it names, and names secrets in headers or a JSON body ({ secret: \"NAME\", prefix: \"Bearer \" }) for the engine to fill in, so it never holds their values."}</p>
      {editing && <Editor field={{ value: editing.value, code: true, spellcheck: false, language: "javascript" }} label={editing.file} onClose={() => setEditing(null)} onSave={async (next) => {
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
