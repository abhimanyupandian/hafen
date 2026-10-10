// The panel for the conversation being explored: its provider, totals, response tree and Save as test.

import { useState } from "react";
import { ConfirmButton } from "../../design/confirm.jsx";
import { useStore } from "../../design/hooks.js";
import { IdField } from "../../design/id-field.jsx";
import { Select } from "../../design/select.jsx";
import { notify } from "../../design/toast.jsx";
import { money, sec, tokens as tokenText } from "../../lib/format.js";
import { app, chooseProvider, providerChoices, deleteConversation, freeSuiteFile, renameConversation, saveConversation } from "../../state.js";
import { Facts, FieldHead, TextField } from "../fields.jsx";
import { showProvider } from "../providers.jsx";
import { FixturesSummary, sendProblem } from "../fixtures-field.jsx";
import { Head } from "./parts.jsx";
import { TurnRecord } from "./turn.jsx";

export function ConversationView({ close }) {
  const state = useStore(app);
  const { conversation, providers, suites, selection } = state;
  const choices = providerChoices(state);
  const [chosenSuite, setSuiteFile] = useState("");
  const suiteFile = suites.some((s) => s.file === chosenSuite) ? chosenSuite : "";
  const [name, setName] = useState("");
  // A new suite's name (its file's, without .hafen.yml: smoke, or support/refunds), else the next free
  const [suiteName, setSuiteName] = useState("");
  const typed = suiteName.trim().replace(/\.hafen\.(ya?ml|json)$/i, "");
  const badName = typed !== "" && !/^[A-Za-z0-9][\w.-]*(\/[A-Za-z0-9][\w.-]*)*$/.test(typed);
  const newFile = typed && !badName ? `${typed}.hafen.yml` : freeSuiteFile();
  const run = conversation?.run;
  const turns = run?.turns ?? [];
  const selected = selection.explore && selection.turn !== undefined ? turns[selection.turn] : turns.at(-1);
  // Totals from the turns it has now (a deleted turn isn't counted)
  const metrics = turns.filter(Boolean).map((t) => t.metrics ?? {});
  const times = metrics.map((m) => m.ms).filter(Number.isFinite).sort((a, b) => a - b);
  const totals = {
    tokens: metrics.some((m) => m.tokens) ? { input: metrics.reduce((n, m) => n + (m.tokens?.input ?? 0), 0), output: metrics.reduce((n, m) => n + (m.tokens?.output ?? 0), 0) } : undefined,
    cost: metrics.length && metrics.every((m) => m.cost !== undefined) ? metrics.reduce((n, m) => n + m.cost, 0) : undefined,
    p50: times.length ? times[Math.ceil(times.length / 2) - 1] : undefined,
  };
  return (
    <>
      <Head icon="provider" label="Conversation" onClose={close} />
      <div className="panel-body">
        <FieldHead label="Provider" htmlFor="convProvider" actions={
          <button className="btn btn-ghost" id="convProviders" type="button" title="Settings → Providers" onClick={() => showProvider(providers.length ? conversation?.provider ?? null : "new")}>{providers.length ? "manage" : "add one"}</button>
        } />
        <label className="select">
          <Select id="convProvider" value={conversation?.provider ?? ""} options={[["", providers.length ? "Choose a provider" : "No providers yet", true], ...choices.map((p) => [p.file, p.name])]}
                  disabled={!!conversation?.sending} title={conversation?.sending ? "Wait for the reply (or stop it) to change the provider" : undefined}
                  onChange={(e) => chooseProvider(e.target.value, { keep: true })} />
        </label>
        {turns.length > 0 && <p className="hint">Another provider carries this conversation on: the turns so far are its history.</p>}
        {/* (what stops a message to the provider, known before sending, is said here, by it: not at the box) */}
        <FixturesSummary id="convFixtures" providerFile={conversation?.provider ?? null} problem={sendProblem(state.plugins)} />
        {turns.length > 0 && (
          <TextField key={conversation.id} id="convTitle" label="Name" single value={conversation.title ?? ""} placeholder={String(turns.find(Boolean)?.user ?? "").replace(/\s+/g, " ").slice(0, 60)}
                     onSave={(v) => renameConversation(v)} />
        )}
        {conversation?.error && <p className="hint error panel-note" role="alert">{conversation.error}</p>}
        <Facts className="panel-facts" id="convFacts" facts={[
          ["turns", turns.length ? String(turns.length) : undefined],
          ["tokens", tokenText(totals.tokens) || undefined],
          ["cost", totals.cost !== undefined ? money(totals.cost) : undefined],
          ["p50", totals.p50 !== undefined ? sec(totals.p50) : undefined],
        ]} />
        {selected && <TurnRecord record={selected} index={turns.indexOf(selected)} />}
        <FieldHead label="Save as test" />
        <label className="select">
          <Select id="saveSuite" value={suiteFile} options={[["", `New suite (${newFile})`], ...suites.map((s) => [s.file, s.file])]} onChange={(e) => setSuiteFile(e.target.value)} />
        </label>
        {!suiteFile && (
          <>
            <div className="field-head"><label className="hint" htmlFor="saveSuiteName">Suite name</label></div>
            <input className="input" id="saveSuiteName" type="text" placeholder={freeSuiteFile().replace(/\.hafen\.yml$/, "")} value={suiteName} onChange={(e) => setSuiteName(e.target.value)} autoComplete="off" spellCheck={false} />
            {badName && <p className="hint error" id="saveSuiteNameProblem" role="alert">A suite's name is letters, digits, '.', '-' and '_' (and '/' for a folder).</p>}
            {!badName && suites.some((s) => s.file === newFile) && <p className="hint" id="saveSuiteNameNote">{`${newFile} is there already: the test goes into it.`}</p>}
          </>
        )}
        <div className="field-head"><label className="hint" htmlFor="saveName">Test name</label></div>
        <input className="input" id="saveName" type="text" placeholder="What this conversation tests" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
        <div className="controls">
          <button className="btn btn-primary" id="saveTest" type="button" disabled={!turns.length || !name.trim() || (!suiteFile && badName)} onClick={async () => {
            try {
              await saveConversation({ file: suiteFile || newFile, name: name.trim() });
              setName("");
              setSuiteName("");
            } catch (err) {
              notify({ title: "Couldn't save the test", text: err.message, kind: "error" });
            }
          }}>Save as test</button>
        </div>
        {run && (
          <div className="panel-foot">
            <div className="panel-ids"><IdField id="convRunId" label="Run _id" value={run._id ?? ""} /></div>
            {turns.length > 0 && <ConfirmButton className="btn btn-ghost panel-delete" id="convDelete" label="Delete conversation" question="delete it?" onConfirm={() => deleteConversation(conversation.id)} />}
          </div>
        )}
      </div>
    </>
  );
}
