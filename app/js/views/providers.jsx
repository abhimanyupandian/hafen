// Settings → Providers (contracts/ui.md, Settings): the open folder's providers, listed; one opened to
// edit (its name, its YAML, Try it, Delete); and a new one, from the kinds a provider can start as.
// Each provider is a file in the folder's providers/ folder, so the CLI and CI use them as they are.
// A provider plugin (plugins/*.js) is a provider too: listed by its provider file (kind: plugin:acme),
// or, with none yet, by itself, with a button that makes its file.

import { useEffect, useState } from "react";
import { parse as parseYaml } from "yaml";
import { kindOf, PROVIDER_KINDS, providerTemplate } from "../../../engine/providers/templates.js";
import { ConfirmButton } from "../design/confirm.jsx";
import { createStore, useStore } from "../design/hooks.js";
import { Select } from "../design/select.jsx";
import { closeSettings, openSettings } from "../design/settings-modal.jsx";
import { notify } from "../design/toast.jsx";
import { app, chooseProvider, createPluginProvider, createProvider, deleteFile, engineCall, readFile, renameProvider, select, writeFile } from "../state.js";
import { Facts, FieldHead, Problems, ScopeProblem, TextField } from "./fields.jsx";

// What the pane shows: the list (null), a new provider ("new"), or a provider's file
const pane = createStore({ open: null });

// Open Settings on Providers: the list, a provider (its file), or "new"
export function showProvider(open = null) {
  pane.set({ open });
  openSettings("providers");
}

export function ProvidersPane() {
  const { open } = useStore(pane);
  const { providers } = useStore(app);
  // Leaving the pane (another option, or closing Settings) goes back to the list
  useEffect(() => () => pane.set({ open: null }), []);
  if (open === "new") return <NewProvider />;
  if (open && providers.some((p) => p.file === open)) return <ProviderEditor file={open} />;
  return <ProviderList />;
}

const back = () => pane.set({ open: null });
const Back = () => (
  <div className="settings-back">
    <button className="btn btn-ghost" id="providersBack" type="button" onClick={back}>‹ all providers</button>
  </div>
);

// The folder's provider plugins that no provider file uses yet ([{ name, file }]), read when the list
// shows (and again when the folder's files change)
function useLoosePlugins() {
  const { providers, opened, canWrite, suites } = useStore(app);
  const [plugins, setPlugins] = useState([]);
  useEffect(() => {
    let alive = true;
    if (!opened || !canWrite) return setPlugins([]);
    engineCall("plugins", {}).then((list) => { if (alive) setPlugins(list); }, () => {});
    return () => { alive = false; };
  }, [opened, canWrite, providers, suites]);
  const used = new Set(providers.map((p) => String(p.config?.kind ?? "").match(/^plugin:([^@]+)/)?.[1]).filter(Boolean));
  return plugins.filter((p) => p.meta?.kind === "provider" && !p.package && !used.has(p.meta.name)).map((p) => ({ name: p.meta.name, file: p.file }));
}

function ProviderList() {
  const { providers, opened, conversation } = useStore(app);
  const loose = useLoosePlugins();
  const [error, setError] = useState("");
  return (
    <>
      <div className="controls">
        <button className="btn" id="newProvider" type="button" disabled={!opened} onClick={() => pane.set({ open: "new" })}>new provider</button>
      </div>
      {!opened && <p className="note placeholder" id="providersClosed">Open a folder first: providers are files in its providers/ folder.</p>}
      {opened && !providers.length && !loose.length && <p className="note placeholder" id="providersEmpty">No providers yet. Add one: Ollama, OpenAI, Anthropic, Gemini, or your own endpoint.</p>}
      <p className="hint error" id="providersError" role="alert" hidden={!error}>{error}</p>
      {(providers.length > 0 || loose.length > 0) && (
        <ul className="list settings-list" id="providerList" aria-label="Providers">
          {providers.map((p) => (
            <li key={p.file} className="settings-row" id={`provider-${p.name}`}>
              <div className="settings-row-text">
                <span className="settings-row-name">{p.name}</span>
                <span className={`hint${p.errors?.length ? " error" : ""}`}>
                  {[p.kind, p.file, p.errors?.length ? "has problems" : "", conversation?.provider === p.file ? "in use" : ""].filter(Boolean).join(" · ")}
                </span>
              </div>
              <button className="btn" id={`provider-${p.name}-open`} type="button" onClick={() => pane.set({ open: p.file })}>edit</button>
              <ConfirmButton className="btn btn-ghost list-del" id={`provider-${p.name}-delete`} aria-label={`Delete ${p.name}`}
                             label="×" question="delete file?" onConfirm={() => deleteFile(p.file).catch(() => {})} />
            </li>
          ))}
          {loose.map((p) => {
            const id = p.name.replace(/[^A-Za-z0-9_-]/g, "-");
            return (
              <li key={p.file} className="settings-row" id={`provider-plugin-${id}`}>
                <div className="settings-row-text">
                  <span className="settings-row-name">{p.name}</span>
                  <span className="hint">{`plugin:${p.name} · ${p.file} · no provider file yet`}</span>
                </div>
                <button className="btn" id={`provider-plugin-${id}-add`} type="button" onClick={async () => {
                  setError("");
                  try {
                    pane.set({ open: await createPluginProvider(p.name, p.file) });
                  } catch (err) {
                    setError(err.message);
                  }
                }}>add provider</button>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

function ProviderEditor({ file }) {
  const { providers, conversation } = useStore(app);
  const p = providers.find((x) => x.file === file);
  const [text, setText] = useState("");
  const [tries, setTries] = useState(0);  // a rename that didn't happen puts the name back
  useEffect(() => { readFile(file).then(setText).catch(() => setText("")); }, [file, providers]);
  const tryIt = () => {
    if (conversation?.provider !== file) chooseProvider(file);
    select({ kind: "conversation" });
    closeSettings();
    setTimeout(() => document.getElementById("input")?.focus(), 0);
  };
  return (
    <>
      <Back />
      <TextField key={`${file}-${tries}`} id="providerName" label="Name" single value={p.name} onSave={async (v) => {
        const to = v.trim() ? await renameProvider(file, v) : null;
        if (to) pane.set({ open: to });
        else setTries((n) => n + 1);
      }} />
      <Facts id="providerFacts" facts={[["kind", p.kind], ["file", p.file], ["url", p.config?.url ?? p.config?.base_url], ["model", p.config?.model]]} />
      <Problems problems={p.errors} />
      <TextField id="providerYaml" label="The provider (YAML)" code rows={12} value={text} onSave={async (v) => {
        try {
          parseYaml(v);
          await writeFile(file, v);
          setText(v);
        } catch (err) {
          notify({ title: "That isn't valid YAML", text: err.message, kind: "error" });
        }
      }} />
      <div className="controls">
        <button className="btn btn-primary" id="providerTry" type="button" onClick={tryIt}>Try it</button>
        <ConfirmButton className="btn btn-ghost" id="providerDelete" label="Delete provider" question="delete this file?"
                       onConfirm={() => deleteFile(file).then(back, () => {})} />
      </div>
    </>
  );
}

// A new provider: the kinds to start from, listed, and what the file needs to be useful at once
function NewProvider() {
  const { providers } = useStore(app);
  const [id, setId] = useState("ollama");
  const kind = kindOf(id);
  const free = (name) => {
    let n = 1;
    let out = name;
    while (providers.some((p) => p.file === `providers/${out}.yml`)) out = `${name}-${++n}`;
    return out;
  };
  const [name, setName] = useState(() => free(kind.name));
  const [named, setNamed] = useState(false);  // a name you typed stays when the kind changes
  const [model, setModel] = useState("");
  const [base, setBase] = useState("");
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const choose = (next) => {
    setId(next);
    setError("");
    if (!named) setName(free(kindOf(next).name));
  };
  const create = async (e) => {
    e.preventDefault();
    setError("");
    try {
      const file = await createProvider(name, providerTemplate(id, { model: model.trim(), base: base.trim(), url: url.trim() }));
      pane.set({ open: file });
    } catch (err) {
      setError(err.message);
    }
  };
  return (
    <>
      <Back />
      <form className="settings-form" id="newProviderForm" onSubmit={create}>
        <FieldHead label="Kind" htmlFor="newProviderKind" />
        <label className="select"><Select id="newProviderKind" value={id} options={PROVIDER_KINDS.map((k) => [k.id, k.label])} onChange={(e) => choose(e.target.value)} /></label>
        <p className="hint" id="newProviderAbout">{kind.about}</p>
        <FieldHead label="Name" htmlFor="newProviderName" />
        <input className="input" id="newProviderName" type="text" autoComplete="off" spellCheck={false} value={name} onChange={(e) => { setName(e.target.value); setNamed(true); }} />
        <p className="hint">{`providers/${name.trim() || "…"}.yml`}</p>
        {kind.preset ? (
          <>
            <FieldHead label="Model" htmlFor="newProviderModel" />
            <input className="input" id="newProviderModel" type="text" autoComplete="off" spellCheck={false} placeholder={kind.model ?? "the model's id"} value={model} onChange={(e) => setModel(e.target.value)} />
            <ScopeProblem id="newProviderModelProblem" value={model} />
            <FieldHead label="Address" htmlFor="newProviderBase" />
            <input className="input" id="newProviderBase" type="url" autoComplete="off" placeholder={kind.base} value={base} onChange={(e) => setBase(e.target.value)} />
            <ScopeProblem id="newProviderBaseProblem" value={base} />
            <p className="hint">{kind.key ? `Its key is \${env:${kind.key}}: set it in Secrets.` : "No key: a local Ollama doesn't need one."}</p>
          </>
        ) : (
          <>
            <FieldHead label="URL" htmlFor="newProviderUrl" />
            <input className="input" id="newProviderUrl" type="text" autoComplete="off" spellCheck={false} placeholder={id === "websocket" ? "wss://chat.example.com/ws" : "{{base_url}}/chat"} value={url} onChange={(e) => setUrl(e.target.value)} />
            <ScopeProblem id="newProviderUrlProblem" value={url} />
            <p className="hint">Then say where the reply is, in the file it makes.</p>
          </>
        )}
        <p className="hint error" id="newProviderError" role="alert" hidden={!error}>{error}</p>
        <div className="controls">
          <button className="btn btn-primary" id="newProviderCreate" type="submit" disabled={!name.trim()}>Add provider</button>
        </div>
      </form>
    </>
  );
}
