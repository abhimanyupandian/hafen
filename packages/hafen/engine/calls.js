// A plugin's HTTP calls as steps (data-model.md, Span: kind "call"): each one a span under the step
// that made it (a provider plugin's turn, a fixture, a check or a judge), with the plugin that made it,
// its request as it was sent (headers and body: redacted with the run, as every span is) and its
// response (status, headers, the start of its body). A call the plugin wasn't allowed to make (a host
// it doesn't name) is a step too, an error saying why.
//
// callSteps(spans, parent, { hold }) → onCall(call), for a plugin call's options (engine/plugins.js,
// fetchFor). hold: requests and responses (headers and bodies; a response's status shows) are kept
// back until onCall.flush() (a fixture's: its login's answer holds the token it's about to give, and a
// call after it can send that token, which is redacted only once it's given)

export function callSteps(spans, parent, { hold = false } = {}) {
  const open = new Map();  // the call's id → its span's
  const held = new Map();  // span id → { request, response? }: kept back
  const onCall = (call) => {
    if (call?.phase === "start") {
      const id = spans.start("call", nameOf(call.request), { parent });
      if (hold) held.set(id, { request: call.request });
      spans.update(id, { plugin: call.plugin, ...(hold ? {} : { request: call.request }) });
      open.set(call.id, id);
    } else if (call?.phase === "end") {
      const id = open.get(call.id);
      if (!id) return;
      open.delete(call.id);
      const status = call.status !== undefined ? { status: call.status } : {};
      const response = { ...status, headers: call.headers ?? {}, ...(call.body !== undefined ? { body: call.body } : {}) };
      if (hold) held.set(id, { ...held.get(id), response });
      spans.update(id, { response: hold ? status : response, ...(call.error ? { error: call.error } : {}) });
      spans.end(id, call.error || call.status >= 400 ? "error" : "ok", call.status !== undefined ? { status: call.status } : undefined);
    } else if (call?.phase === "refused") {
      const id = spans.start("call", nameOf(call.request), { parent });
      if (hold) held.set(id, { request: call.request });
      spans.update(id, { plugin: call.plugin, ...(hold ? {} : { request: call.request }), error: call.error });
      spans.end(id, "error");
    }
  };
  // What was kept back, now on their steps
  onCall.flush = () => {
    for (const [id, kept] of held) spans.update(id, kept);
    held.clear();
  };
  return onCall;
}

// "POST api.acme.example/v1/chat": its method, host and path (no query: it can hold a token)
export function nameOf(request) {
  try {
    const url = new URL(request.url);
    return `${request.method ?? "GET"} ${url.host}${url.pathname}`;
  } catch {
    return `${request?.method ?? "GET"} ${request?.url ?? ""}`.trim();
  }
}
