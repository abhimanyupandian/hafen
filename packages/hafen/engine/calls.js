// A plugin's HTTP calls as steps (data-model.md, Span: kind "call"): each one a span under the step
// that made it (a provider plugin's turn, a fixture, a check or a judge), with the plugin that made it,
// its request as it was sent (headers and body: redacted with the run, as every span is) and its
// response (status, headers, the start of its body). A call the plugin wasn't allowed to make (a host
// it doesn't name) is a step too, an error saying why.
//
// callSteps(spans, parent, { hold }) → onCall(call), for a plugin call's options (engine/plugins.js,
// fetchFor). hold: response bodies are kept back until onCall.flush() (a fixture's: its login's answer
// holds the token it's about to give, which is redacted only once it's given)

export function callSteps(spans, parent, { hold = false } = {}) {
  const open = new Map();  // the call's id → its span's
  const held = [];         // [span id, response]: bodies kept back
  const onCall = (call) => {
    if (call?.phase === "start") {
      const id = spans.start("call", nameOf(call.request), { parent });
      spans.update(id, { plugin: call.plugin, request: call.request });
      open.set(call.id, id);
    } else if (call?.phase === "end") {
      const id = open.get(call.id);
      if (!id) return;
      open.delete(call.id);
      const response = { ...(call.status !== undefined ? { status: call.status } : {}), headers: call.headers ?? {} };
      if (hold && call.body !== undefined) held.push([id, { ...response, body: call.body }]);
      spans.update(id, {
        response: hold || call.body === undefined ? response : { ...response, body: call.body },
        ...(call.error ? { error: call.error } : {}),
      });
      spans.end(id, call.error || call.status >= 400 ? "error" : "ok", call.status !== undefined ? { status: call.status } : undefined);
    } else if (call?.phase === "refused") {
      const id = spans.start("call", nameOf(call.request), { parent });
      spans.update(id, { plugin: call.plugin, request: call.request, error: call.error });
      spans.end(id, "error");
    }
  };
  // The bodies kept back, now on their steps
  onCall.flush = () => {
    for (const [id, response] of held.splice(0)) spans.update(id, { response });
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
