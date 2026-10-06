// What an endpoint reported, normalised (data-model.md, TurnEvent): providers yield events as they
// arrive; the collector stamps their time, merges consecutive pieces of the same kind (a streamed
// reply becomes one text event, keeping when it started, `t`, and when its last piece came, `t_end`),
// and assembles what checks look at.

export const EVENT_TYPES = ["thinking", "text", "tool_call", "tool_result", "usage", "done", "error"];

export function createCollector({ now }) {
  const start = now();
  const events = [];
  let usage = null;

  const t = () => Math.round((now() - start) * 10) / 10;

  function add(event) {
    const at = t();
    const last = events.at(-1);
    if ((event.type === "text" || event.type === "thinking") && !event.text) {
      // An empty thinking piece still says thinking happened (omitted thinking arrives empty)
      if (event.type !== "thinking") return null;
    }
    if (event.type === "text" && last?.type === "text") {
      last.text += event.text;
      last.t_end = at;
      return last;
    }
    if (event.type === "thinking" && last?.type === "thinking" && last.visibility === (event.visibility ?? "full")) {
      last.text += event.text ?? "";
      last.t_end = at;
      return last;
    }
    if (event.type === "usage") {
      // Usage can come in parts (input at the start, output at the end): one event, fields merged
      usage = { ...(usage ?? { type: "usage", t: at }), ...strip(event), type: "usage", t: usage?.t ?? at, t_end: at };
      const existing = events.findIndex((e) => e.type === "usage");
      if (existing === -1) events.push(usage);
      else events[existing] = usage;
      return usage;
    }
    const record = { ...strip(event), type: event.type, t: at };
    if (event.type === "text" || event.type === "thinking") record.t_end = at;
    if (event.type === "thinking") record.visibility = event.visibility ?? "full";
    events.push(record);
    return record;
  }

  const of = (type) => events.filter((e) => e.type === type);

  return {
    add,
    events,
    elapsed: t,
    reply: () => of("text").map((e) => e.text).join(""),
    thinking: () => of("thinking").map((e) => ({ text: e.text, visibility: e.visibility })),
    toolCalls: () => {
      const results = new Map(of("tool_result").map((e) => [e.id, e.result]));
      return of("tool_call").map((e) => ({ id: e.id, name: e.name, args: e.args, ...(results.has(e.id) ? { result: results.get(e.id) } : {}) }));
    },
    usage: () => (usage ? { input: usage.input, output: usage.output, thinking: usage.thinking, cached: usage.cached } : null),
    finish: () => of("done").at(-1)?.finish,
    error: () => of("error").at(-1),
  };
}

const strip = (event) => {
  const { type, t, ...rest } = event;
  return rest;
};

// What `on: response` checks look at for a streamed reply (contracts/checks.md): the reply text,
// thinking, tool calls and usage gathered into one object, with the last chunk's fields as `last`.
export function assemble(collector, last) {
  return {
    text: collector.reply(),
    thinking: collector.thinking().map((t) => t.text).join(""),
    tool_calls: collector.toolCalls(),
    usage: collector.usage(),
    last: last ?? null,
  };
}
