// Every step of a run as a span (data-model.md, Span): when it started and ended, in milliseconds
// from the run's start on a clock that can't go backwards, the span it's part of, its status and
// its metrics. The timeline draws these; reports count them.

import { uid } from "./util.js";

// offset: where this clock starts (ms), for spans that follow earlier ones (a conversation carried on)
export function createSpans({ now, onChange, offset = 0 } = {}) {
  const origin = now() - offset;
  const list = [];
  const byId = new Map();
  const at = () => Math.round((now() - origin) * 10) / 10;

  function start(kind, name, { parent = null, ref, start: startAt } = {}) {
    const parentSpan = parent ? byId.get(parent) : null;
    let begin = startAt ?? at();
    // A child never starts before its parent
    if (parentSpan && begin < parentSpan.start) begin = parentSpan.start;
    const span = { _id: uid(10), parent, kind, name, start: begin, status: "running" };
    if (ref) span.ref = ref;
    list.push(span);
    byId.set(span._id, span);
    onChange?.("start", span);
    return span._id;
  }

  function end(id, status = "ok", metrics, { end: endAt } = {}) {
    const span = byId.get(id);
    if (!span || span.end !== undefined) return span;
    span.end = Math.max(span.start, endAt ?? at());
    span.status = status;
    if (metrics) span.metrics = { ms: Math.round((span.end - span.start) * 10) / 10, ...metrics };
    else span.metrics = { ms: Math.round((span.end - span.start) * 10) / 10 };
    onChange?.("end", span);
    return span;
  }

  // A finished span in one go (steps known after the fact: thinking, an answer)
  function record(kind, name, { parent, ref, start: s, end: e, status = "ok", metrics } = {}) {
    const id = start(kind, name, { parent, ref, start: s });
    return end(id, status, metrics, { end: e });
  }

  // More about a span as it goes (a check's name with its value; what a judge call sent): passed on,
  // as a start and an end are, so a run being watched shows it at once
  const update = (id, fields) => {
    const span = byId.get(id);
    if (span) {
      Object.assign(span, fields);
      onChange?.("update", span);
    }
    return span;
  };

  // Earlier spans, as they were (copies), ahead of the ones to come
  function adopt(spans = []) {
    for (const s of spans) {
      const copy = structuredClone(s);
      list.push(copy);
      byId.set(copy._id, copy);
    }
  }

  return { start, end, record, update, adopt, at, get: (id) => byId.get(id), list, origin };
}

// End every span still running (a run that stopped or broke): their status is what the run's is.
export function closeAll(spans, status) {
  for (const span of spans.list) if (span.end === undefined) spans.end(span._id, status);
}
