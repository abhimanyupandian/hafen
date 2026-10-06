// What the presets share: sending a JSON request, reading a failed response, and the API key.

import { textChunks } from "../../util.js";
import { tryJSON } from "../http.js";

// The preset's API key: its `api_key` (usually ${env:…}), else its default environment variable.
// An explicit empty `api_key` means none (local OpenAI-compatible servers).
export function apiKey(config, scope, envName) {
  if (config.api_key === "") return "";
  return scope.resolve(config.api_key ?? `\${env:${envName}}`);
}

// Send `body` as JSON. Yields the request and response records, and returns the response.
export async function* post({ url, headers, body, transport, signal }) {
  const request = { url, method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) };
  yield { type: "request", request };
  const res = await transport.send(request, { signal });
  yield { type: "response", status: res.status, headers: res.headers };
  return res;
}

// A failed response: its body for the record, and the error the API gave
export async function* failed(res) {
  let raw = "";
  for await (const text of textChunks(res.body)) raw += text;
  const body = tryJSON(raw);
  yield { type: "body", body, text: raw };
  const message = body?.error?.message ?? body?.error ?? body?.message ?? raw.slice(0, 300);
  yield { type: "error", message: `${res.status}: ${typeof message === "string" ? message : JSON.stringify(message)}`, status: res.status };
}

export const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== undefined ? Number(v) : undefined);
