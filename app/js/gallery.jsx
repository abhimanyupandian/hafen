// Every design-system component the app uses, on one page (spec/design/README.md, Checking it
// matches): the visual tests screenshot it in both themes, so a change to how any of them looks shows
// up as a difference. Static data only.

import { createRoot } from "react-dom/client";
import { GroupBadge, RepeatBadge, Spinner } from "./design/badges.jsx";
import { CheckBadge } from "./design/check-badge.jsx";
import { SearchField } from "./design/search.jsx";
import { Chart } from "./design/chart.jsx";
import { NavSection, SettingsGroup, SettingsSection } from "./design/collapsible.jsx";
import { ConfirmButton } from "./design/confirm.jsx";
import { Icon } from "./design/icons.jsx";
import { IdField } from "./design/id-field.jsx";
import { JsonTree } from "./design/json-tree.jsx";
import { List, ListRow } from "./design/list.jsx";
import { SegmentedChoice, Select } from "./design/select.jsx";
import { TimelineDock } from "./design/timeline.jsx";
import { renderMarkdown } from "./lib/markdown.js";
import { CheckCard } from "./views/check-card.jsx";
import { TurnIcon } from "./views/sections.jsx";

const SPANS = [
  { _id: "t1", parent: null, kind: "turn", name: "turn 1", start: 0, end: 2200, status: "pass" },
  { _id: "r1", parent: "t1", kind: "request", name: "POST /v1/chat", start: 2, end: 2190, status: "ok" },
  { _id: "h1", parent: "r1", kind: "thinking", name: "thinking (summary)", start: 640, end: 1820, status: "ok" },
  { _id: "c1", parent: "r1", kind: "tool_call", name: "lookup_order", start: 1830, end: 1835, status: "ok" },
  { _id: "a1", parent: "r1", kind: "answer", name: "answer", start: 1840, end: 2188, status: "ok" },
  { _id: "k1", parent: "t1", kind: "check", name: "contains 4417", start: 2191, end: 2192, status: "pass" },
  { _id: "k2", parent: "t1", kind: "check", name: "noul 0.58", start: 2191, end: 2209, status: "unsure" },
  { _id: "k3", parent: "t1", kind: "check", name: "latency ≤ 2.0 s", start: 2191, end: 2192, status: "fail" },
];

function Gallery() {
  return (
    <div className="gallery">
      <section id="g-buttons">
        <h2 className="label">Buttons</h2>
        <div className="row">
          <button className="btn" type="button">export JSON</button>
          <button className="btn btn-primary" type="button">Run</button>
          <button className="btn btn-primary stop" type="button">Stop</button>
          <button className="btn btn-ghost" type="button">clear all</button>
          <ConfirmButton className="btn btn-ghost" label="×" question="delete" onConfirm={() => {}} />
          <button className="btn btn-icon" type="button" aria-label="Add"><Icon name="plus" /></button>
          <button className="btn btn-ghost btn-icon" type="button" aria-label="Settings"><Icon name="settings" /></button>
          <button className="btn btn-ghost scope-button" type="button" aria-label="Scope: stage"><span className="scope-icon"><Icon name="scope" /></span><span className="scope-name">stage</span></button>
          <button className="btn btn-ghost scope-button none" type="button" aria-label="No scope chosen: choose one"><span className="scope-icon"><Icon name="scope" /><span className="scope-alert" aria-hidden="true">!</span></span></button>
          <button className="btn" type="button" disabled>disabled</button>
        </div>
      </section>
      <section id="g-fields">
        <h2 className="label">Fields</h2>
        <div className="field-head"><label className="hint" htmlFor="gInput">Name</label></div>
        <input className="input" id="gInput" defaultValue="refund for a broken item" />
        <div className="field-head"><label className="hint" htmlFor="gSelect">History</label></div>
        <label className="select"><Select id="gSelect" value="live" options={[["live", "live"], ["pinned", "pinned"]]} /></label>
        <textarea className="textarea textarea-code" rows={3} defaultValue={"session: $.session_id\norder: $.data.order.id"} aria-label="Code" />
        <label className="check"><input type="checkbox" defaultChecked /> Stop on failure</label>
        <SearchField id="gSearch" label="Search" value="refund oct" onChange={() => {}} />
        <IdField id="gId" label="Test id" value="t_8f2k1q9z" />
      </section>
      <section id="g-badges">
        <h2 className="label">Badges</h2>
        <div className="row">
          <button className="btn badge on" type="button"><span className="badge-dot"></span><span className="badge-text">acme-support</span></button>
          <button className="btn badge off" type="button"><span className="badge-dot"></span><span className="badge-text">No provider</span></button>
        </div>
        <div className="msg-checks">
          <CheckBadge status="pass" name="status 200" />
          <CheckBadge status="fail" name="contains refund" />
          <CheckBadge status="unsure" name="noul 0.58" />
          <CheckBadge status="running" name="judge: asks why" />
          <CheckBadge status="skipped" name="thinking contains window" />
          <CheckBadge status="error" name="noul" />
          <CheckBadge status="" name="latency ≤ 3.0 s" />
          <CheckBadge status="off" name="cost ≤ $0.01" />
          <CheckBadge status="pass" name="tool.called lookup_order" selected />
        </div>
        <div className="row" id="g-group-badges">
          {[1, 2, 3, 4, 5, 6, 7, 8].map((g) => <GroupBadge key={g} group={g} />)}
          <RepeatBadge times={3} />
          <span className="turn-icon" data-status="running"><Spinner /></span>
        </div>
        <nav className="segmented"><a aria-current="page">One</a><a>Two</a></nav>
      </section>
      <section id="g-list" style={{ padding: 0 }}>
        <div className="section collapsible open" style={{ borderTop: 0 }}>
          <NavSection id="gSection" name="gSection" label="Runs" bodyId="gSectionBody" defaultOpen actions={<button className="btn btn-ghost when-open" type="button">clear all</button>}>
            <List id="gList" aria-label="Runs">
              <ListRow id="g-row-1" label="refund for a broken item" detail="14:02:11 · 4.1 s" size="passed" data={{ status: "passed" }} active onOpen={() => {}} onDelete={() => {}} />
              <ListRow id="g-row-2" label="refund questions" detail="13:58:40 · 1 min 12 s" size="failed" data={{ status: "failed" }} onOpen={() => {}} onDelete={() => {}} />
              <ListRow id="g-row-3" label="proration" size="unsure" data={{ status: "unsure" }} onOpen={() => {}} onDelete={() => {}} />
              {[["passed", "4/4"], ["failed", "0/1"], ["unsure", "1/2"], ["running", "running…"], ["", "2 checks"], ["unchecked", "0 checks"]].map(([status, size], i) => (
                <ListRow key={i} id={`g-turn-${i}`} label={["Hi, I want a refund", "It arrived broken", "Can I keep it?", "Thanks", "Bye", "Anything else?"][i]} icon={<TurnIcon status={status} />}
                         size={size} data={{ status }} before={<span className="tree-toggle" aria-hidden="true"></span>} onOpen={() => {}} onDelete={() => {}} />
              ))}
            </List>
          </NavSection>
        </div>
      </section>
      <section id="g-facts">
        <h2 className="label">Facts and output</h2>
        <dl className="trace-facts"><dt>first token</dt><dd>0.62 s</dd><dt>tokens</dt><dd>412 in · 96 out · 210 thinking</dd><dt>cost</dt><dd>$0.0041</dd></dl>
        <pre className="panel-output">{"{\n  \"status\": 200\n}"}</pre>
        <pre className="panel-output error">500: the endpoint is having a bad day</pre>
        <details className="panel-template" open><summary>Request</summary><pre className="panel-output">POST /v1/chat</pre></details>
        <details className="panel-template"><summary>Raw stream · 12 chunks</summary><pre className="panel-output">data: …</pre></details>
      </section>
      <section id="g-json">
        <h2 className="label">JSON tree</h2>
        <JsonTree id="gJson" value={{ data: { reply: "Could you tell me why?", order: { id: 4417 }, actions: [{ type: "refund" }] }, session_id: "sess_1" }} selected="$.data.order.id" />
      </section>
      <section id="g-palette">
        <h2 className="label">Palette cards</h2>
        <div className="palette-group">
          <p className="palette-heading">System One</p>
          <div className="palette">
            <div className="palette-item" tabIndex={0}><span className="block-label"><Icon name="check" size={16} /><span className="label">Noul</span></span><span className="palette-text">Is a statement about the reply true?</span></div>
            <div className="palette-item" tabIndex={0}><span className="block-label"><Icon name="check" size={16} /><span className="label">Path</span></span><span className="palette-text">A field of the response, by JSONPath, against a value</span></div>
          </div>
        </div>
        <div className="row">{["suite", "test", "check", "fail", "provider", "timeline", "run", "plus", "copy", "maximize", "settings", "scope", "sidebar", "menu", "close", "back", "more"].map((n) => <Icon key={n} name={n} />)}</div>
      </section>
      <section id="g-check-cards">
        <h2 className="label">Check cards</h2>
        <ul className="check-cards">
          <CheckCard id="g-card-1" check={{ type: "status", equals: 200 }} result={{ status: "pass", reason: "200 = 200" }} onOpen={() => {}} onToggle={() => {}} onDelete={() => {}} />
          <CheckCard id="g-card-2" check={{ contains: "refund" }} result={{ status: "fail", reason: "doesn't contain \"refund\"" }} onOpen={() => {}} onToggle={() => {}} onDelete={() => {}} />
          <CheckCard id="g-card-3" check={{ type: "systemone.noul", question: "Does it ask why?" }} result={{ status: "unsure", name: "noul 0.58", reason: "half the samples agree", confidence: 0.5 }} onOpen={() => {}} onToggle={() => {}} onDelete={() => {}} />
          <CheckCard id="g-card-4" check={{ type: "cost", max_cost: 0.01, enabled: false }} result={null} onOpen={() => {}} onToggle={() => {}} onDelete={() => {}} />
        </ul>
      </section>
      <section id="g-thread">
        <h2 className="label">Messages</h2>
        <div className="thread" style={{ padding: 0 }}>
          <section className="run-error" data-status="error" aria-label="The run: couldn't run">
            <div className="turn-head"><span className="label">Run</span><span className="hint turn-summary" data-status="error">couldn't run · nothing was sent · just now</span></div>
            <div className="msg-body error">{"providers/acme.yml:2: {{env.base_url}} isn't set: no environment is chosen"}</div>
          </section>
          <div className="turn-group selected">
          <article className="msg user"><div className="msg-body">I want a refund for order 4417</div></article>
          <article className="msg bot">
            <details className="msg-sent msg-thinking" open><summary>thinking · summary · 1.18 s</summary><pre>Check the refund window first.</pre></details>
            <button type="button" className="hint msg-tool">{"↳ lookup_order {\"order_id\":4417} · answered"}</button>
            <div className="msg-body md" dangerouslySetInnerHTML={{ __html: renderMarkdown("I'm sorry it arrived **broken**. Order `4417`:\n\n- a refund, or\n- a new one") }} />
            <div className="msg-foot">
              <span className="msg-stats">0.62 s to first token · 2.2 s · 412 in · 96 out · 48.2 tok/s · $0.0041</span>
              <button type="button" className="btn btn-ghost msg-copy" aria-label="Copy the reply"><Icon name="copy" size={12} /><span>copy</span></button>
            </div>
            <div className="msg-checks"><CheckBadge status="pass" name="contains 4417" /><CheckBadge status="unsure" name="noul 0.58" /></div>
          </article>
          </div>
        </div>
      </section>
      <section id="g-chart">
        <h2 className="label">Charts</h2>
        <Chart id="gChart" label="Pass rate" points={[0.9, 1, 0.8, 1, 0.6, 1, 1].map((v, i) => ({ value: v, failed: i === 4 }))} format={(v) => `${Math.round(v * 100)}%`} />
      </section>
      <section id="g-scopes" style={{ gridColumn: "1 / -1" }}>
        <h2 className="label">Scope panes</h2>
        <div className="scope-panes" style={{ width: 620 }}>
          <nav className="scope-list" aria-label="Environments">
            <div className="scope-list-head"><span className="label">Globals</span></div>
            <List aria-label="Globals"><ListRow id="g-globals" label="Globals" onOpen={() => {}} /></List>
            <div className="scope-list-line" role="separator"></div>
            <div className="scope-list-head"><span className="label">Scopes</span><button className="btn btn-icon" type="button" aria-label="Add a scope" aria-expanded="true"><Icon name="plus" size={14} /></button></div>
            <form className="controls new-scope-form" onSubmit={(e) => e.preventDefault()}><input className="input grow" placeholder="stage, prod…" aria-label="A new scope's name" defaultValue="" /><button className="btn" type="submit">add</button></form>
            <List aria-label="Scopes">
              <ListRow id="g-scope-stage" label="stage" active extra={<span title="Chosen now"><Icon name="check" size={14} /></span>} onOpen={() => {}}
                       actions={<button className="btn btn-icon list-more" type="button" aria-label="More for stage"><Icon name="more" size={14} /></button>} />
              <ListRow id="g-scope-prod" label="prod" size="2 not set" data={{ status: "error" }} onOpen={() => {}}
                       actions={<button className="btn btn-icon list-more" type="button" aria-label="More for prod"><Icon name="more" size={14} /></button>} />
            </List>
          </nav>
          <section className="scope-main" aria-label="The scope stage">
            <div className="scope-head">
              <input className="input scope-name-field" aria-label="Scope name" defaultValue="stage" />
              <button className="btn" type="button" disabled>chosen now</button>
              <button className="btn btn-icon" type="button" aria-label="More for stage"><Icon name="more" size={14} /></button>
            </div>
            <div className="scope-tools">
              <button className="btn" type="button">import .env</button>
              <button className="btn" type="button">export .env</button>
              <button className="btn" type="button">edit as .env</button>
              <SearchField id="gVarsSearch" label="Search variables" placeholder="Search variables" value="" onChange={() => {}} />
            </div>
            <div className="vars" role="table" aria-label="Values of stage">
              <div className="vars-head" role="row"><span className="label" role="columnheader">Variable</span><span role="columnheader"><span className="label">Value</span></span><span className="label" role="columnheader">Source</span></div>
              {[["base_url", "https://stage.acme.example", "override", "overrides Globals"], ["who", "stage-team", "own", "this scope"], ["model", "", "unset", "not set"], ["region", "eu-west-1", "globals", "from Globals"]].map(([name, value, source, text]) => (
                <div key={name} className="vars-row" role="row" data-source={source}>
                  <span className="vars-key" role="cell"><span className="vars-name">{name}</span><span className="hint vars-use">{`{{env.${name}}}`}</span></span>
                  <span className="vars-cell" role="cell">
                    {source === "globals" ? <span className="vars-value">{value}</span> : <input className="input" aria-label={`Value of ${name}`} defaultValue={value} placeholder={source === "unset" ? "its value" : undefined} />}
                    {source === "globals" ? <button className="btn" type="button">override</button> : source !== "unset" && <button className="btn btn-icon" type="button" aria-label={`Delete ${name}`}>×</button>}
                  </span>
                  <span className="hint vars-source" role="cell">{text}</span>
                </div>
              ))}
              <form className="vars-row vars-add" role="row" onSubmit={(e) => e.preventDefault()}>
                <span role="cell"><input className="input" placeholder="New variable" aria-label="Name" /></span>
                <span role="cell"><input className="input" placeholder="its value, then Enter" aria-label="Value" /></span>
                <span role="cell"></span>
              </form>
            </div>
            <div className="vars" role="table" aria-label="Secrets of stage">
              <div className="vars-head" role="row"><span className="label" role="columnheader">Name</span><span role="columnheader"><span className="label">Value</span><button className="btn" type="button">show all</button></span><span className="label" role="columnheader">Source</span></div>
              {[["API_KEY", "", "own", "this scope", false], ["ALIAS", "a-every", "globals", "from Globals", true]].map(([name, value, source, text, shown]) => (
                <div key={name} className="vars-row" role="row" data-source={source}>
                  <span className="vars-key" role="cell"><span className="vars-name">{name}</span><span className="hint vars-use">{`{{secret.${name}}}`}</span></span>
                  <span className="vars-cell" role="cell">
                    {source === "globals" ? <span className="vars-value">{shown ? value : "••••••••"}</span> : <input className="input" type="password" aria-label={`Value of ${name}`} placeholder="••••••••" />}
                    <button className="btn vars-reveal" type="button">{shown ? "hide" : "show"}</button>
                    {source === "globals" ? <button className="btn" type="button">override</button> : <button className="btn" type="button">forget</button>}
                  </span>
                  <span className="hint vars-source" role="cell">{text}</span>
                </div>
              ))}
            </div>
            <div className="panel-foot"><button className="btn" type="button">Delete scope</button></div>
          </section>
        </div>
      </section>
      <section id="g-timeline" style={{ gridColumn: "1 / -1", padding: 0 }}>
        <div className="frame" style={{ flexDirection: "column", justifyContent: "flex-end" }}>
          <TimelineDock spans={SPANS} selected="h1" />
        </div>
      </section>
      <section id="g-settings" style={{ gridColumn: "1 / -1" }}>
        <h2 className="label">Settings parts</h2>
        <div className="row" style={{ alignItems: "flex-start" }}>
          <div className="frame" style={{ width: 620, height: "auto" }}>
            <div className="settings-content">
              <div className="field-head"><span className="hint" id="gThemeLabel">Theme</span></div>
              <div className="controls">
                <SegmentedChoice id="gTheme" labelledBy="gThemeLabel" value="system" onChange={() => {}}
                                 options={[["light", "Light", "Always light", "gThemeLight"], ["system", "System", "As the system's", "gThemeSystem"], ["dark", "Dark", "Always dark", "gThemeDark"]]} />
              </div>
              <div className="settings-sections">
                <SettingsSection id="gSectionOpen" name="gSectionOpen" label="Fixtures" defaultOpen summary="acme-login → reset-cart">
                  <p className="hint fixtures-hint">Plugins that run around this provider's requests, each list in its order.</p>
                  <textarea className="textarea textarea-code" rows={2} defaultValue={"fixtures:\n  beforeAll: [acme-login]"} aria-label="Code" />
                </SettingsSection>
                <SettingsSection id="gSectionClosed" name="gSectionClosed" label="YAML" summary="kind: http · 12 lines">…</SettingsSection>
                <SettingsSection id="gSectionProblem" name="gSectionProblem" label="Headers" problem summary="line 3, column 1: Missing closing }. Not saved.">…</SettingsSection>
              </div>
              <div className="controls"><button className="btn btn-primary" type="button">Try it</button></div>
            </div>
          </div>
          <div className="frame" style={{ width: 620, height: "auto" }}>
            <div className="settings-content">
              <p className="hint">When a run ends, its notification shows at the top right.</p>
              <SettingsGroup id="gGroupSound" label="Sound">
                <label className="check"><input type="checkbox" defaultChecked /> Play a sound when a run ends</label>
                <p className="hint">Not looking: another suite or test is open.</p>
              </SettingsGroup>
              <SettingsGroup id="gGroupSystem" label="System notifications" state={<span className="hint">allowed</span>}>
                <label className="check"><input type="checkbox" /> Also show the system's notification</label>
              </SettingsGroup>
              <div className="settings-block"><div className="controls"><button className="btn" type="button">Try it</button></div></div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

createRoot(document.getElementById("gallery")).render(<Gallery />);
