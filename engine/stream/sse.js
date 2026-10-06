// Server-sent events from a body: { event, data } for each event, however the network split it.
// Lines end with \n, \r\n or \r; an event ends at a blank line; `data:` lines are joined with \n;
// comments (`:`) are skipped. A stream that ends without a blank line still yields its last event.

import { textChunks } from "../util.js";

export async function* sse(body, { onText } = {}) {
  let buffer = "";
  let event = "";
  let data = [];
  const flush = function* () {
    if (data.length || event) yield { event: event || "message", data: data.join("\n") };
    event = "";
    data = [];
  };
  for await (const text of textChunks(body)) {
    onText?.(text);
    buffer += text;
    let at;
    while ((at = buffer.search(/\r\n|\r|\n/)) !== -1) {
      // A lone \r at the end may be the start of \r\n: wait for more
      if (buffer[at] === "\r" && at === buffer.length - 1) break;
      const line = buffer.slice(0, at);
      buffer = buffer.slice(buffer[at] === "\r" && buffer[at + 1] === "\n" ? at + 2 : at + 1);
      if (line === "") {
        yield* flush();
        continue;
      }
      if (line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") event = value;
      else if (field === "data") data.push(value);
    }
  }
  if (buffer) {
    const line = buffer.replace(/\r$/, "");
    if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    else if (line.startsWith("event:")) event = line.slice(6).trim();
  }
  yield* flush();
}
