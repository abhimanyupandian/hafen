// A2A agents (the Agent2Agent protocol, https://a2a-protocol.org; contracts/provider.md, Presets):
// a message sent over JSON-RPC, streamed (SendStreamingMessage, server-sent events) or not
// (SendMessage), in the protocol's version 1.0 (`A2A-Version: 1.0`; ROLE_USER, TASK_STATE_…, results
// wrapped as { task } / { statusUpdate } …) or 0.3 (message/stream; `kind` on every object). The
// endpoint is the provider's `url`, or the JSON-RPC interface its agent card names (`card`).
//
// The agent keeps the conversation: its contextId goes with the next turn, and so does its task when
// it's waiting for more (input-required, auth-required). A working task's status messages are its
// progress (thinking, shown as progress); its artifacts' text is the reply, else its last message's.
// A task that fails, is rejected or canceled ends the turn as an error. Checks on the response see
// `last`: the agent's final Task (or Message), as it sent it. Verify against the spec when it changes.

import { sse } from "../../stream/sse.js";
import { textChunks } from "../../util.js";
import { tryJSON } from "../http.js";
import { failed, post } from "./common.js";

const ERRORS = {
  "-32700": "JSONParseError", "-32600": "InvalidRequest", "-32601": "MethodNotFound", "-32602": "InvalidParams", "-32603": "InternalError",
  "-32001": "TaskNotFound", "-32002": "TaskNotCancelable", "-32003": "PushNotificationNotSupported", "-32004": "UnsupportedOperation",
  "-32005": "ContentTypeNotSupported", "-32006": "InvalidAgentResponse", "-32007": "ExtendedAgentCardNotConfigured",
  "-32008": "ExtensionSupportRequired", "-32009": "VersionNotSupported",
};
const INTERRUPTED = new Set(["input-required", "auth-required"]);
const ENDED_BADLY = new Set(["failed", "rejected", "canceled"]);

// A state as either version writes it ("TASK_STATE_INPUT_REQUIRED", "input-required") → "input-required"
export const stateOf = (s) => String(s ?? "").replace(/^TASK_STATE_/, "").toLowerCase().replace(/_/g, "-");
// The text of a message's or an artifact's parts (a text part is { text } in 1.0, { kind: "text", text } in 0.3)
const textOf = (parts) => (Array.isArray(parts) ? parts.map((p) => (typeof p?.text === "string" ? p.text : "")).join("") : "");
const version = (v) => (String(v ?? "1.0").startsWith("0.") ? "0.3" : "1.0");
const rpcError = (e) => `A2A error ${e?.code ?? "?"}${ERRORS[String(e?.code)] ? ` (${ERRORS[String(e.code)]})` : ""}: ${e?.message ?? JSON.stringify(e)}`;

// What a JSON-RPC result is, in either version: { kind: task | message | status | artifact, value }
function resultOf(r) {
  if (!r || typeof r !== "object") return null;
  if (r.task) return { kind: "task", value: r.task };
  if (r.statusUpdate) return { kind: "status", value: r.statusUpdate };
  if (r.artifactUpdate) return { kind: "artifact", value: r.artifactUpdate };
  if (r.message && !r.kind) return { kind: "message", value: r.message };
  const kind = { task: "task", message: "message", "status-update": "status", "artifact-update": "artifact" }[r.kind];
  return kind ? { kind, value: r } : null;
}

// The JSON-RPC endpoint an agent card names: 1.0's supportedInterfaces (the first JSON-RPC one), or
// 0.3's url with its preferredTransport, or additionalInterfaces. { url, version, streaming }
async function discover(where, { headers, transport, signal }) {
  const url = /\.json(\?|$)/.test(where) ? where : `${where.replace(/\/+$/, "")}/.well-known/agent-card.json`;
  const res = await transport.send({ url, method: "GET", headers }, { signal });
  let raw = "";
  for await (const t of textChunks(res.body)) raw += t;
  if (res.status >= 400) throw new Error(`the agent card at ${url} answered ${res.status}`);
  const card = tryJSON(raw);
  if (!card || typeof card !== "object") throw new Error(`the agent card at ${url} isn't JSON`);
  const streaming = card.capabilities?.streaming === true;
  const rpc = (card.supportedInterfaces ?? []).find((i) => /^json-?rpc$/i.test(i?.protocolBinding ?? ""));
  if (rpc?.url) return { url: rpc.url, version: version(rpc.protocolVersion ?? card.protocolVersion ?? "1.0"), streaming };
  const legacy = card.url && (!card.preferredTransport || /^json-?rpc$/i.test(card.preferredTransport))
    ? card.url
    : (card.additionalInterfaces ?? []).find((i) => /^json-?rpc$/i.test(i?.transport ?? ""))?.url;
  if (legacy) return { url: legacy, version: version(card.protocolVersion ?? "0.3"), streaming };
  throw new Error(`the agent card at ${url} names no JSON-RPC interface (this provider speaks A2A over JSON-RPC)`);
}

export function a2a(config) {
  let found = null;  // what the agent card said, read once
  return {
    kind: "a2a",
    config,
    async *send({ message, scope, transport, signal, session }) {
      const headers = scope.resolve(config.headers ?? {});
      let url = config.url ? scope.resolve(config.url) : null;
      let v = config.version !== undefined ? version(scope.resolve(String(config.version))) : null;
      let streaming = config.streaming;
      if (!url) {
        if (!config.card) {
          yield { type: "error", message: "an A2A provider needs its url (the JSON-RPC endpoint), or its card (where its agent card is)" };
          return;
        }
        try {
          found ??= await discover(scope.resolve(config.card), { headers, transport, signal });
        } catch (err) {
          yield { type: "error", message: err.message };
          return;
        }
        url = found.url;
        v ??= found.version;
        streaming ??= found.streaming;
      }
      v ??= "1.0";
      streaming ??= true;
      const v1 = v === "1.0";
      const id = globalThis.crypto.randomUUID();
      const sent = v1
        ? { messageId: id, role: "ROLE_USER", parts: [{ text: message }] }
        : { kind: "message", messageId: id, role: "user", parts: [{ kind: "text", text: message }] };
      if (session?.contextId) sent.contextId = session.contextId;
      if (session?.taskId) sent.taskId = session.taskId;
      const params = {
        message: sent,
        ...(config.configuration ? { configuration: scope.resolve(config.configuration) } : {}),
        ...(config.metadata ? { metadata: scope.resolve(config.metadata) } : {}),
      };
      const method = v1 ? (streaming ? "SendStreamingMessage" : "SendMessage") : streaming ? "message/stream" : "message/send";
      const res = yield* post({
        url,
        headers: { ...(v1 ? { "A2A-Version": "1.0" } : {}), ...(streaming ? { accept: "text/event-stream" } : {}), ...headers },
        body: { jsonrpc: "2.0", id, method, params },
        transport,
        signal,
      });
      if (res.status >= 400) return yield* failed(res);

      // What the agent has said so far
      const seen = { taskId: session?.taskId ?? null, contextId: session?.contextId ?? null, task: null, status: null, message: null, artifacts: new Map(), lastArtifact: null, wrote: false, progress: false };
      // One result: its text (artifacts, a message), its progress (a working task's status messages)
      const take = function* (result) {
        const r = resultOf(result);
        if (!r) return;
        const x = r.value;
        if (x.contextId) seen.contextId = x.contextId;
        if (r.kind === "task") {
          seen.task = x;
          seen.taskId = x.id ?? seen.taskId;
          if (x.status) seen.status = x.status;
          for (const a of x.artifacts ?? []) yield* artifact(a, false);
        } else if (r.kind === "message") {
          seen.message = x;
          const text = textOf(x.parts);
          if (text) {
            if (seen.wrote) yield { type: "text", text: "\n\n" };
            yield { type: "text", text };
            seen.wrote = true;
          }
        } else if (r.kind === "status") {
          if (x.taskId) seen.taskId = x.taskId;
          seen.status = x.status ?? seen.status;
          const state = stateOf(x.status?.state);
          const text = textOf(x.status?.message?.parts);
          if (text && (state === "working" || state === "submitted")) {
            yield { type: "thinking", text: `${seen.progress ? "\n" : ""}${text}`, visibility: "progress" };
            seen.progress = true;
          }
        } else if (r.kind === "artifact") {
          if (x.taskId) seen.taskId = x.taskId;
          yield* artifact(x.artifact, x.append === true);
        }
      };
      const artifact = function* (a, append) {
        if (!a) return;
        const key = a.artifactId ?? a.name ?? "";
        const kept = seen.artifacts.get(key);
        seen.artifacts.set(key, append && kept ? { ...kept, parts: [...(kept.parts ?? []), ...(a.parts ?? [])] } : a);
        const text = textOf(a.parts);
        if (!text) return;
        if (seen.wrote && seen.lastArtifact !== key) yield { type: "text", text: "\n\n" };
        yield { type: "text", text };
        seen.wrote = true;
        seen.lastArtifact = key;
      };

      const contentType = String(res.headers?.["content-type"] ?? "");
      let raw = null;
      if (streaming && contentType.includes("text/event-stream")) {
        const chunks = [];
        for await (const item of sse(res.body, { onText: (t) => chunks.push(t) })) {
          while (chunks.length) yield { type: "chunk", text: chunks.shift() };
          const data = tryJSON(item.data);
          if (!data || typeof data !== "object") continue;
          if (data.error) {
            yield { type: "error", message: rpcError(data.error) };
            return;
          }
          yield* take(data.result);
          // (0.3: the last event says so; 1.0 closes the stream)
          if (data.result?.kind === "status-update" && data.result.final === true) break;
        }
        while (chunks.length) yield { type: "chunk", text: chunks.shift() };
      } else {
        // SendMessage's one answer (or a streaming request the agent answered with an error)
        raw = "";
        for await (const t of textChunks(res.body)) raw += t;
        yield { type: "chunk", text: raw };
        const data = tryJSON(raw);
        if (data?.error) {
          yield { type: "error", message: rpcError(data.error) };
          return;
        }
        yield* take(data?.result);
      }

      // How it ended: the reply, the error, what goes with the next turn
      const state = stateOf(seen.status?.state);
      const said = textOf(seen.status?.message?.parts);
      if (said && (INTERRUPTED.has(state) || (!seen.wrote && !ENDED_BADLY.has(state) && state !== "working" && state !== "submitted"))) {
        if (seen.wrote) yield { type: "text", text: "\n\n" };
        yield { type: "text", text: said };
        seen.wrote = true;
      }
      const last = seen.task || seen.status
        ? { ...(seen.task ?? {}), id: seen.taskId ?? seen.task?.id, ...(seen.contextId ? { contextId: seen.contextId } : {}), status: seen.status ?? seen.task?.status, ...(seen.artifacts.size ? { artifacts: [...seen.artifacts.values()] } : {}) }
        : seen.message;
      yield { type: "body", body: last ?? null, ...(raw !== null ? { text: raw } : {}) };
      if (seen.contextId || seen.taskId) {
        yield { type: "session", value: { ...(seen.contextId ? { contextId: seen.contextId } : {}), ...(INTERRUPTED.has(state) && seen.taskId ? { taskId: seen.taskId } : {}) } };
      }
      if (!last) {
        yield { type: "error", message: "the agent answered with no task and no message" };
        return;
      }
      if (ENDED_BADLY.has(state)) {
        yield { type: "error", message: `the task ${state}${said ? `: ${said}` : ""}` };
        return;
      }
      yield { type: "done", finish: state || "message" };
    },
  };
}
