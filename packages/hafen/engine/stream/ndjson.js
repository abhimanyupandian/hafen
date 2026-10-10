// Newline-delimited JSON from a body: one parsed value per non-empty line, however the network split
// it. A line that isn't JSON throws, saying which.

import { textChunks } from "../util.js";

export async function* ndjson(body, { onText } = {}) {
  let buffer = "";
  for await (const text of textChunks(body)) {
    onText?.(text);
    buffer += text;
    let at;
    while ((at = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      if (line) yield parseLine(line);
    }
  }
  if (buffer.trim()) yield parseLine(buffer.trim());
}

function parseLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    throw new Error(`A line of the stream isn't JSON: ${line.slice(0, 120)}`);
  }
}
