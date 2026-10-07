// A provider's fixtures (contracts/ui.md: Panel, Conversation, Suite, Test; Settings → Providers): its
// `fixtures`, by when they run, each list in its order.
//
//   FixturesEditor (Settings → Providers, a provider): a list for each of the four, in plain words
//     (once before the run, before each test, after each test, once after the run), each fixture
//     numbered in its place, moved up or down or taken out, more added from the folder's fixtures
//     (with what each gives); every change saved in the provider's file at once (comments kept)
//   FixturesSummary (beside each provider picker): what it runs, in order, each fixture's name
//     opening its code (Settings → Plugins), and `edit`, which opens the editor; by the conversation's
//     provider, what stops a message to it before it's sent (sendProblem), with `edit the provider`
//
// The file keeps its keys (beforeAll, before, after, afterAll), so the command line reads it as ever.

import { Fragment, useState } from "react";
import { FIXTURE_PHASES, fixturesOf } from "hafen/engine/fixture-lists.js";
import { useStore } from "../design/hooks.js";
import { Select } from "../design/select.jsx";
import { openSettings } from "../design/settings-modal.jsx";
import { app, contextSuite, providerInUse, setProviderFixtures, suiteOf } from "../state.js";
import { Facts, FieldHead } from "./fields.jsx";
import { showPlugin } from "./plugins.jsx";
import { showProvider } from "./providers.jsx";

// Each list: its key in the file, what it's called here, and when it runs
export const PHASES = [
  ["beforeAll", "Once, before the run", "before the provider's first request: a login, say"],
  ["before", "Before each test", "each repeat and data row, before its setup steps"],
  ["after", "After each test", "however it went, after its teardown steps"],
  ["afterAll", "Once, after the run", "when the run ends, even when it's stopped: a logout, say"],
];

// A provider's lists as the file has them (each entry as written: a name, or name@range), or why
// they can't be shown ({ problem }). A fixture a list names twice ({ duplicate }: why) still shows,
// so the extra can be taken out here.
function listsOf(value) {
  const read = fixturesOf({ fixtures: value });
  const other = read.problems.filter((p) => !read.duplicates.some((d) => d.message === p));
  if (other.length) return { problem: other[0] };
  return { ...Object.fromEntries(FIXTURE_PHASES.map((phase) => [phase, read[phase].map((ref) => ref.entry)])), duplicate: read.duplicates[0]?.message ?? null };
}
const nameOf = (entry) => entry.split("@")[0].trim();
const gives = (f) => (f?.provides?.length ? `gives ${f.provides.join(", ")}` : "gives nothing");

// What stops any message to a provider before it's sent, as the engine says it when it refuses one
// (engine/serve-port.js, send): its fixtures can't be read or name one twice, or a fixture (or its
// provider plugin) isn't one of the folder's plugins; "" when nothing does. plugins: the folder's
// (app.plugins). ownPlugins: the suite giving the context names plugins of its own, so a name the
// folder hasn't got may be one of those (it isn't said).
export function providerProblem(config, plugins = [], { ownPlugins = false } = {}) {
  if (!config) return "";
  const named = (name) => plugins.find((p) => p.name === name);
  // (a plugin file that didn't load: why, rather than "isn't there")
  const broken = (name) => plugins.find((p) => !p.name && p.error && p.file.split("/").pop().replace(/\.m?js$/i, "") === name);
  const wanted = typeof config.kind === "string" && config.kind.startsWith("plugin:") ? config.kind.slice("plugin:".length).split("@")[0] : null;
  if (wanted && !named(wanted) && !ownPlugins) return broken(wanted) ? `${broken(wanted).file}: ${broken(wanted).error}` : `the provider plugin "${wanted}" isn't in the folder's plugins, or the suite's`;
  const lists = fixturesOf(config);
  if (lists.problems.length) return lists.problems[0];
  for (const phase of FIXTURE_PHASES) {
    for (const ref of lists[phase]) {
      const plugin = named(ref.name);
      if (plugin && plugin.kind !== "fixture") return `the plugin "${ref.name}" (fixtures.${phase}) is a ${plugin.kind}, not a fixture`;
      if (!plugin && !ownPlugins) return broken(ref.name) ? `${broken(ref.name).file}: ${broken(ref.name).error}` : `the fixture "${ref.name}" (fixtures.${phase}) isn't in the folder's plugins/ or the suite's plugins`;
    }
  }
  return "";
}

// What stops a message in the conversation before it's sent: the provider it would go to
// (providerInUse) and its problem (providerProblem), or null. The panel says it, by the provider, and
// Send is off while it's there (spec/design/components.md, Additions: Message box problems).
export function sendProblem(plugins) {
  const provider = providerInUse();
  const problem = provider ? providerProblem(provider.config, plugins, { ownPlugins: !!suiteOf(contextSuite(provider.file))?.data?.plugins?.length }) : "";
  return problem ? { provider, problem } : null;
}

export function FixturesEditor({ id, providerFile }) {
  const { providers, plugins } = useStore(app);
  const provider = providers.find((p) => p.file === providerFile);
  const fixtures = plugins.filter((p) => p.kind === "fixture" && p.name);
  const byName = new Map(fixtures.map((f) => [f.name, f]));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!provider) return null;
  const lists = listsOf(provider.config?.fixtures);
  // One list changed: the four written back (the empty ones left out; none, the key goes)
  const save = async (phase, next) => {
    const all = Object.fromEntries(FIXTURE_PHASES.map((p) => [p, p === phase ? next : lists[p]]));
    const kept = Object.fromEntries(FIXTURE_PHASES.filter((p) => all[p].length).map((p) => [p, all[p]]));
    setBusy(true);
    setError("");
    try {
      await setProviderFixtures(providerFile, Object.keys(kept).length ? kept : null);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  const moved = (list, i, by) => {
    const next = [...list];
    [next[i], next[i + by]] = [next[i + by], next[i]];
    return next;
  };
  return (
    <>
      <FieldHead label="Fixtures" />
      <p className="hint fixtures-hint" id={`${id}Hint`}>{`Plugins that run around this provider's requests, each list in its order. Kept in ${provider.file}: every suite using it runs them.`}</p>
      {lists.problem ? (
        <p className="hint error fixtures-hint" id={`${id}Problem`} role="alert">{`Its fixtures can't be shown here (${lists.problem}): fix them in the YAML below.`}</p>
      ) : PHASES.map(([phase, label, about]) => (
        <section className="fixture-phase" key={phase} id={`${id}-${phase}`} aria-label={label}>
          <div className="fixture-phase-head">
            <span className="label">{label}</span>
            <span className="hint">{about}</span>
          </div>
          {lists[phase].length > 0 && (
            <ol className="list settings-list fixture-list" aria-label={`${label}, in order`}>
              {lists[phase].map((entry, i) => {
                const name = nameOf(entry);
                const known = byName.get(name);
                // (named earlier in this list: the one to take out)
                const again = lists[phase].slice(0, i).some((e) => nameOf(e) === name);
                return (
                  <li className="settings-row fixture-row" key={`${i}-${entry}`} id={`${id}-${phase}-${i}`}>
                    <span className="fixture-order" aria-hidden="true">{i + 1}</span>
                    <div className="settings-row-text">
                      <span className="settings-row-name">{entry}</span>
                      <span className={`hint${known && !again ? "" : " error"}`}>{again ? "in this list already: take it out" : known ? gives(known) : "isn't a fixture in the folder's plugins/"}</span>
                    </div>
                    {known && <button className="btn btn-ghost" type="button" id={`${id}-${phase}-${i}-code`} aria-label={`Open ${name}'s code`} title="Its code (Settings → Plugins)"
                                      onClick={() => showPlugin(name, { back: () => showProvider(providerFile) })}>code</button>}
                    <button className="btn btn-ghost" type="button" id={`${id}-${phase}-${i}-up`} aria-label={`Move ${name} earlier`} title="Earlier"
                            disabled={busy || i === 0} onClick={() => save(phase, moved(lists[phase], i, -1))}>↑</button>
                    <button className="btn btn-ghost" type="button" id={`${id}-${phase}-${i}-down`} aria-label={`Move ${name} later`} title="Later"
                            disabled={busy || i === lists[phase].length - 1} onClick={() => save(phase, moved(lists[phase], i, 1))}>↓</button>
                    <button className="btn btn-ghost list-del" type="button" id={`${id}-${phase}-${i}-remove`} aria-label={`Take ${name} out`} title="Take it out"
                            disabled={busy} onClick={() => save(phase, lists[phase].filter((_, j) => j !== i))}>×</button>
                  </li>
                );
              })}
            </ol>
          )}
          <label className="select fixture-add">
            <Select id={`${id}-${phase}-add`} value="" disabled={busy || !fixtures.length} aria-label={`Add a fixture: ${label.toLowerCase()}`}
                    options={[["", fixtures.length ? "+ add a fixture" : "No fixtures in the folder yet", true], ...fixtures.map((f) => {
                      const listed = lists[phase].some((e) => nameOf(e) === f.name);
                      return [f.name, `${f.name} (${listed ? "in this list already" : gives(f)})`, listed];
                    })]}
                    onChange={(e) => { if (e.target.value) save(phase, [...lists[phase], e.target.value]); }} />
          </label>
        </section>
      ))}
      {lists.duplicate && <p className="hint error fixtures-hint" id={`${id}Duplicate`} role="alert">{`${lists.duplicate}. Nothing runs with this provider until one is taken out.`}</p>}
      {error && <p className="hint error fixtures-hint" id={`${id}Error`} role="alert">{error}</p>}
      {!fixtures.length && (
        <p className="hint fixtures-hint" id={`${id}NoneYet`}>
          {"A fixture is a plugin: "}
          <button className="btn btn-ghost" type="button" id={`${id}NewPlugin`} onClick={() => openSettings("plugins")}>add one in Plugins</button>
        </p>
      )}
    </>
  );
}

// Beside a provider picker: what its fixtures are, in order, and `edit` (the editor, in Settings).
// problem (the conversation's: sendProblem): what stops a message to its provider before it's sent,
// said under them with `edit the provider`, in place of what it says too (a list that names one twice,
// or can't be read)
export function FixturesSummary({ id, providerFile, problem = null }) {
  const { providers, plugins } = useStore(app);
  const provider = providers.find((p) => p.file === providerFile);
  const known = new Set(plugins.filter((p) => p.kind === "fixture").map((p) => p.name));
  const lists = provider ? listsOf(provider.config?.fixtures) : null;
  // (each fixture there is, a link to its code)
  const facts = lists && !lists.problem
    ? PHASES.filter(([phase]) => lists[phase].length).map(([phase, label]) => [label.toLowerCase(), lists[phase].map((e, i) => (
      <Fragment key={i}>
        {i > 0 && " → "}
        {known.has(nameOf(e))
          ? <button className="btn btn-ghost inline-link" type="button" id={`${id}-${phase}-${i}`} title={`Open ${nameOf(e)}'s code (Settings → Plugins)`} onClick={() => showPlugin(nameOf(e))}>{e}</button>
          : `${e} (missing)`}
      </Fragment>
    ))])
    : [];
  const said = problem && (
    <p className="hint error fixtures-hint" id={`${id}Problem`} role="alert">
      {`${problem.provider.name}: ${problem.problem}`}
      {" · "}
      <button className="btn btn-ghost inline-link" id={`${id}Fix`} type="button" title="Settings → Providers" onClick={() => showProvider(problem.provider.file)}>edit the provider</button>
    </p>
  );
  return (
    <>
      <FieldHead label="Fixtures" actions={provider ? (
        <button className="btn btn-ghost" id={`${id}Edit`} type="button" title="Settings → Providers" onClick={() => showProvider(provider.file)}>edit</button>
      ) : null} />
      {!provider
        ? <><p className="hint fixtures-hint" id={`${id}None`}>Choose a provider file to give it fixtures.</p>{said}</>
        : lists.problem
          ? said || <p className="hint error fixtures-hint" id={`${id}None`}>{`Its fixtures can't be read: ${lists.problem}`}</p>
          : facts.length
            ? <>
                <Facts className="panel-facts fixtures-facts" id={id} facts={facts} />
                {said || (lists.duplicate && <p className="hint error fixtures-hint" id={`${id}Duplicate`}>{lists.duplicate}</p>)}
              </>
            : <><p className="hint fixtures-hint" id={`${id}None`}>None yet: edit adds some (a login before the run, say).</p>{said}</>}
    </>
  );
}
