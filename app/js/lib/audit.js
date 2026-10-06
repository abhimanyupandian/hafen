// The console as an audit log (contracts/ui.md, Console): one line per thing that happened, in an
// OpenTelemetry-like shape: when, what (a dotted name), its attributes as key=value, how it ended
// and how long it took. Never a request's or reply's body, a header, or a secret's value.
//
//   14:02:03.123  engine.edit  file=smoke.hafen.yml op=set:tests.0.name  ok 12 ms
//   14:02:04.551  http.request  method=POST url=http://127.0.0.1:8791/json  200 · 0.42 s · 1.2 kB
//   14:02:05.010  config.secret  name=OPENAI_API_KEY env=every action=set

import { say } from "./log.js";

const time = (d = new Date()) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}.${String(d.getMilliseconds()).padStart(3, "0")}`;
const value = (v) => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  const one = String(s).replace(/\s+/g, " ");
  const cut = one.length > 120 ? `${one.slice(0, 119)}…` : one;
  // Quoted when it has spaces or quotes in it (an address's = and & don't need it)
  return /[\s"]/.test(cut) ? JSON.stringify(cut) : cut;
};
export const ms = (n) => (n === undefined ? "" : n < 1000 ? `${Math.round(n)} ms` : `${(n / 1000).toFixed(2)} s`);
export const bytes = (n) => (n === undefined ? "" : n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} kB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

// audit("engine.edit", { file, op }, { status: "ok", ms: 12 }); an error (status "error") is red
export function audit(name, attrs = {}, { status, ms: took, extra, error = false } = {}) {
  const parts = Object.entries(attrs).filter(([, v]) => v !== undefined && v !== null && v !== "").map(([k, v]) => `${k}=${value(v)}`);
  const end = [status, took !== undefined ? ms(took) : "", extra].filter(Boolean).join(" · ");
  say(`${time()}  ${name}${parts.length ? `  ${parts.join(" ")}` : ""}${end ? `  ${end}` : ""}`, error ? "err" : "log");
}

// An engine command, as the page sent it: what it was about (never a file's text, a message, or a
// secret), and how it ended
export function auditCall(cmd, args = {}, { ok, error, value: out, ms: took }) {
  const a = {};
  switch (cmd) {
    case "open":
      a.folder = args.root ?? args.handle?.name ?? (args.files ? `${Object.keys(args.files).length} files` : undefined);
      if (ok) a.found = `${out?.suites?.length ?? 0} suites, ${out?.providers?.length ?? 0} providers`;
      break;
    case "load":
      if (ok) a.found = `${out?.suites?.length ?? 0} suites, ${out?.providers?.length ?? 0} providers`;
      break;
    case "edit":
      a.file = args.file;
      a.op = (args.edits ?? []).map((e) => `${e.op}:${e.path.join(".")}`).join(",");
      break;
    case "create": case "write": case "read": case "remove":
      a.file = args.file;
      break;
    case "rename":
      a.file = args.file;
      a.to = args.to;
      break;
    case "validate":
      a.files = (args.files ?? []).join(",");
      break;
    case "run":
      a.files = (args.files ?? []).join(",");
      a.tests = [...(args.options?.ids ?? []), ...(args.options?.tests ?? [])].join(",") || "all";
      if (args.options?.untilTurn !== undefined) a.until_turn = args.options.untilTurn + 1;
      if (args.options?.onlyTurn !== undefined) a.only_turn = args.options.onlyTurn + 1;
      if (ok) a.result = `${out?.status === "done" ? out.verdict : out?.status} ${out?.summary?.tests?.passed ?? 0}/${out?.summary?.tests?.total ?? 0}`;
      break;
    case "send":
      a.provider = args.providerFile;
      a.seeded = args.seed ? `${args.seed.turns?.length ?? 0} turns` : undefined;
      if (ok) a.turn = (out?.record?.index ?? 0) + 1;
      break;
    case "saveConversation":
      a.file = args.file;
      a.test = args.name;
      break;
    case "configure":
      a.secrets = args.secrets ? Object.values(args.secrets).reduce((n, names) => n + Object.keys(names ?? {}).length, 0) : undefined;
      a.relay = args.relay ?? undefined;
      break;
    default:
      break;
  }
  audit(`engine.${cmd}`, a, { status: ok ? "ok" : `error: ${error}`, ms: took, error: !ok });
}

// A log the engine sent: its HTTP calls
export function auditEngineLog(entry) {
  if (entry?.name === "http.request") {
    audit("http.request", { method: entry.method, url: entry.url }, {
      status: entry.error ? `error: ${entry.error}` : String(entry.status),
      ms: entry.ms,
      extra: entry.bytes !== undefined ? bytes(entry.bytes) : undefined,
      error: !!entry.error || entry.status >= 400,
    });
  }
}

// A run's or a conversation's events as they come: each test and turn as it ends
export function auditEvent(where, event) {
  if (event?.type === "test:end") {
    const t = event.test ?? {};
    audit(`${where}.test`, { test: t.name }, { status: `${t.status} ${t.passed ?? 0}/${t.total ?? 0}`, error: t.status === "failed" || t.status === "error" });
  } else if (event?.type === "turn:end") {
    const r = event.record ?? {};
    const results = r.results ?? [];
    audit(`${where}.turn`, { test: r.test, turn: (r.index ?? 0) + 1, checks: results.length ? `${results.filter((x) => x.status === "pass").length}/${results.length}` : undefined },
      { status: r.error ? `error: ${r.error}` : r.skipped ? "skipped" : "ok", ms: r.metrics?.ms, error: !!r.error });
  }
}
