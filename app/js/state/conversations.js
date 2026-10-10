// Exploring an endpoint: the conversation going on (its provider, its messages sent through the
// engine), and the conversations kept in this browser's storage.

import { newToken } from "../host.js";
import { emit } from "../lib/events.js";
import * as idb from "../lib/idb.js";
import { say } from "../lib/log.js";
import { audit, auditEvent } from "../lib/audit.js";
import { KEYS, store } from "../lib/store.js";
import { setRoute } from "../lib/url.js";
import { engine, get, providerChoices, reload, scopeArgs, select, set, threadMode } from "../state.js";
import { createLiveRun } from "./runs.js";

/* ---------- exploring ---------- */

// Choose a provider: for a new conversation, or (keep) for the one going on, which then carries on
// with it (its turns so far are the history the next message goes with)
// (While a message is on its way, the conversation's provider isn't changed: its reply would be lost,
// and the conversation left sending. The picker is off meanwhile.)
export function chooseProvider(providerFile, { keep = false } = {}) {
  const c = get().conversation;
  if (keep && c?.sending) return;
  store.set(KEYS.provider, providerFile);
  audit("config.provider", { provider: providerFile, for: keep ? "the conversation going on" : "a new conversation" });
  if (keep && c?.run?.turns?.length) {
    letGo(c.token);
    set({ conversation: { ...c, token: newToken(), provider: providerFile, error: null } });
    return;
  }
  resetConversation();
  set({ conversation: { id: newToken(), token: newToken(), provider: providerFile, run: null, sending: false, error: null } });
}

// A new conversation (the one going on is kept, under Conversations, if it has any turns)
export function resetConversation() {
  const c = get().conversation;
  letGo(c?.token);
  set({ conversation: c ? { id: newToken(), token: newToken(), provider: c.provider, run: null, error: null, sending: false } : null });
}

// A conversation let go in the engine (another opened, a new one started, its provider changed): its
// provider's after and afterAll fixtures run then, and their lines go in the console, as a message's
// fixtures' do (they come with its token, after its messages)
export function letGo(token) {
  if (!token || !engine) return;
  const off = engine.on(token, (event) => auditEvent("conversation", event));
  engine.call("reset", { token }).catch(() => {}).finally(off);
}

/* ---------- conversations kept here ---------- */

const conversationSummary = (c) => ({ _id: c._id, title: c.title, provider: c.provider, started: c.started ?? c.run?.started, updated: c.updated, turns: c.run?.turns?.length ?? 0, size: new Blob([JSON.stringify(c)]).size });
const titleOf = (c) => c.title || String(c.run?.turns?.find(Boolean)?.user ?? "Conversation").replace(/\s+/g, " ").trim().slice(0, 60) || "Conversation";

export async function loadConversations() {
  try {
    const all = await idb.all("conversations");
    set({ conversations: all.map(conversationSummary).sort((a, b) => b.updated - a.updated) });
  } catch (err) {
    say(`couldn't read the conversations kept here: ${err.message}`, "err");
  }
}

// Keep the conversation going on (after each message, a rename, a deleted turn); one with no turns
// left isn't kept
async function keepConversation() {
  const c = get().conversation;
  if (!c?.id) return;
  if (!c.run?.turns?.length) {
    await idb.remove("conversations", c.id).catch(() => {});
  } else {
    const kept = { _id: c.id, title: titleOf(c), provider: c.provider ?? null, started: c.run.started, updated: Date.now(), run: c.run };
    await idb.put("conversations", kept);
  }
  await loadConversations();
  emit("conversations:changed");
}

// Open a kept conversation: shown as it was, and the next message carries it on
export async function openConversation(id) {
  const kept = await idb.get("conversations", id);
  if (!kept) {
    say(`there's no conversation ${id}`, "err");
    return;
  }
  const c = get().conversation;
  letGo(c?.token);
  const provider = get().providers.some((p) => p.file === kept.provider) ? kept.provider : null;
  set({ conversation: { id: kept._id, token: newToken(), provider, run: kept.run, title: kept.title, sending: false, error: null } });
  audit("conversation.open", { conversation: kept.title, turns: kept.run?.turns?.length ?? 0 });
  select({ kind: "conversation" }, { route: false });
  setRoute("conversations", kept._id);
}

export async function renameConversation(title) {
  const c = get().conversation;
  if (!c?.run?.turns?.length) return;
  set({ conversation: { ...c, title: title.trim() || undefined } });
  await keepConversation();
}

export async function deleteConversation(id) {
  await idb.remove("conversations", id);
  audit("conversation.delete", { id });
  if (get().conversation?.id === id) {
    resetConversation();
    if (threadMode() === "explore") select({ kind: "conversation" });
  }
  await loadConversations();
  emit("conversations:changed");
}

export async function clearConversations() {
  await idb.clear("conversations");
  audit("conversation.clear", {});
  if (get().conversation?.run) resetConversation();
  await loadConversations();
  emit("conversations:changed");
}

// A turn deleted from the conversation going on: the turns after it move up, and the next message
// goes without it (the engine starts the conversation again from what's left)
export async function deleteConversationTurn(index) {
  const c = get().conversation;
  if (!c?.run?.turns?.[index]) return;
  if (c.sending) stopSending();
  letGo(c.token);
  set({ conversation: { ...c, token: newToken(), run: withoutTurn(c.run, index), error: null } });
  audit("conversation.turn.delete", { turn: index + 1 });
  const sel = get().selection;
  if (sel.explore && sel.turn !== undefined) select(sel.turn === index ? { kind: "conversation" } : sel.turn > index ? { ...sel, turn: sel.turn - 1 } : sel, { route: false });
  await keepConversation();
}

// A run without one of its turns: its spans (the turn's and everything under it) go, and the turns
// after it, and their spans' references, move up one
export function withoutTurn(run, index) {
  const turnSpan = (run.spans ?? []).find((s) => s.kind === "turn" && s.ref?.turn === index);
  const gone = new Set(turnSpan ? [turnSpan._id] : []);
  for (let grew = true; grew;) {
    grew = false;
    for (const s of run.spans ?? []) if (!gone.has(s._id) && s.parent && gone.has(s.parent)) { gone.add(s._id); grew = true; }
  }
  const spans = (run.spans ?? []).filter((s) => !gone.has(s._id)).map((s) => (s.ref?.turn > index ? { ...s, ref: { ...s.ref, turn: s.ref.turn - 1 }, name: s.kind === "turn" ? `turn ${s.ref.turn}` : s.name } : s));
  const turns = run.turns.filter((_, i) => i !== index).map((t, i) => (t ? { ...t, index: i } : t));
  return { ...run, turns, spans };
}

// The suite whose environments and variables an exploring provider uses: the selected one, else the
// first that uses this provider, else the first
export function contextSuite(providerFile) {
  const { selection, suites } = get();
  if (selection.file && suites.some((s) => s.file === selection.file)) return selection.file;
  const using = suites.find((s) => Object.values(s.providerFiles ?? {}).includes(providerFile));
  return (using ?? suites[0])?.file;
}

// The provider a message goes to (and a new suite uses): the conversation's, else the one used last,
// else the first the pickers offer
export function providerInUse() {
  const { conversation, providers } = get();
  const file = conversation?.provider ?? store.get(KEYS.provider);
  return providers.find((p) => p.file === file) ?? providerChoices(get())[0] ?? null;
}

export async function sendMessage(text) {
  let c = get().conversation;
  if (!c?.provider) {
    const first = providerInUse()?.file;
    if (!first) throw new Error("add a provider first");
    chooseProvider(first, { keep: true });
    c = get().conversation;
  }
  if (!c.id) set({ conversation: (c = { ...c, id: newToken() }) });
  const token = c.token;
  const live = createLiveRun({ mode: "explore" }, c.run);
  const off = engine.on(token, (event) => {
    auditEvent("conversation", event);
    live.take(event, (run) => {
      if (get().conversation?.token === token) set({ conversation: { ...get().conversation, run } });
    });
  });
  set({ conversation: { ...c, sending: true, error: null } });
  // The thread goes to the bottom, to the message and its reply
  emit("thread:bottom");
  try {
    // (A kept conversation's turns so far: the engine carries on from them when the token is new to it)
    const seed = c.run?.turns?.length ? c.run : undefined;
    const call = engine.call("send", { token, providerFile: c.provider, suiteFile: contextSuite(c.provider), ...scopeArgs(), message: text, history: "live", seed });
    inFlight = call.catch(() => {});
    const out = await call;
    // (the live copy's last redraw, if one is waiting, doesn't come after the engine's own run)
    live.stop();
    if (get().conversation?.token === token) {
      set({ conversation: { ...get().conversation, run: out.run, sending: false } });
      await keepConversation().catch((err) => say(`couldn't keep the conversation: ${err.message}`, "err"));
    }
    return out.record;
  } catch (err) {
    live.stop();
    // (a conversation let go meanwhile, another opened, isn't this one's to report)
    if (get().conversation?.token === token) {
      set({ conversation: { ...get().conversation, sending: false, error: err.message } });
      say(err.message, "err");
    }
    throw err;
  } finally {
    off();
  }
}

// The message being sent (saving the conversation waits for it)
let inFlight = Promise.resolve();

export function stopSending() {
  const c = get().conversation;
  if (c?.sending) engine.call("stop", { token: c.token });
}

export async function saveConversation({ file, name }) {
  // A message on its way: the test has its reply too
  await inFlight;
  const c = get().conversation;
  if (!c?.run?.turns?.length) throw new Error("send a message first");
  const provider = get().providers.find((p) => p.file === c.provider);
  const providerPath = provider ? relativePath(file, provider.file) : undefined;
  const suite = await engine.call("saveConversation", { token: c.token, file, name, providerPath, run: c.run });
  await reload();
  const index = (suite.data?.tests ?? []).length - 1;
  // Deleting this test (or its suite) clears the conversation too
  if (get().conversation?.token === c.token) set({ conversation: { ...get().conversation, savedTo: { file, id: suite.data?.tests?.[index]?.id } } });
  select({ kind: "test", file, test: index });
  return suite;
}

// `target` as a path relative to `from`'s folder
export function relativePath(from, target) {
  const a = from.split("/").slice(0, -1);
  const b = target.split("/");
  let i = 0;
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
  return [...a.slice(i).map(() => ".."), ...b.slice(i)].join("/");
}
