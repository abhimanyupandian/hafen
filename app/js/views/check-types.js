// The kinds of check (contracts/checks.md), as the app shows them: grouped (what the reply says, its
// metrics, its thinking and tools, System One, LLM judges), each with its name, what it does, and the
// check a click adds. The sidebar's Checks lists them by group; a turn's checks are cards named by
// their kind.

import { typeOf } from "hafen/engine/checks/names.js";

export const CHECK_GROUPS = [
  { id: "response", label: "Response" },
  { id: "metrics", label: "Metrics" },
  { id: "behaviour", label: "Thinking and tools" },
  { id: "systemone", label: "System One" },
  { id: "llm", label: "LLM judges" },
];

// id: the palette card's (#palette-<id>); short: its name under its group's heading; name: its name
// anywhere else; types: the check types it stands for (typeOf)
export const CHECK_TYPES = [
  { id: "path", group: "response", name: "Path", text: "A field of the response, by JSONPath, against a value", check: { path: "$", exists: true }, types: ["path"] },
  { id: "text", group: "response", name: "Text", text: "The reply contains or matches some text", check: { contains: "text" }, types: ["text", "contains", "not_contains", "matches"] },
  { id: "status", group: "response", name: "Status", text: "The HTTP status", check: { type: "status", equals: 200 }, types: ["status"] },
  { id: "json", group: "response", name: "JSON", text: "The reply is JSON (and matches a schema)", check: { type: "json" }, types: ["json"] },
  { id: "latency", group: "metrics", name: "Latency", text: "How long the reply took", check: { type: "latency", max_ms: 5000 }, types: ["latency"] },
  { id: "length", group: "metrics", name: "Length", text: "How long the reply is", check: { type: "length", max_length: 2000 }, types: ["length"] },
  { id: "tokens", group: "metrics", name: "Tokens", text: "Output (or thinking) tokens within a limit", check: { type: "tokens", max_tokens: 1000 }, types: ["tokens"] },
  { id: "cost", group: "metrics", name: "Cost", text: "The turn's cost within a limit", check: { type: "cost", max_cost: 0.01 }, types: ["cost"] },
  { id: "thinking", group: "behaviour", name: "Thinking", text: "The model thought before answering", check: { on: "thinking", type: "present" }, types: ["thinking.present"] },
  { id: "tool-called", group: "behaviour", name: "Tool called", text: "A tool was called, with these arguments", check: { type: "tool.called", tool: "tool_name" }, types: ["tool.called"] },
  { id: "tool-not-called", group: "behaviour", name: "Tool not called", text: "A tool wasn't called", check: { type: "tool.not_called", tool: "tool_name" }, types: ["tool.not_called"] },
  { id: "tool-order", group: "behaviour", name: "Tool order", text: "Tools were called in this order", check: { type: "tool.order", order: ["first", "second"], match: "in_order" }, types: ["tool.order"] },
  { id: "sequence", group: "behaviour", name: "Sequence", text: "Thinking, tools and the answer came in this order", check: { type: "sequence", value: ["thinking", "text"] }, types: ["sequence"] },
  { id: "system-one-noul", group: "systemone", short: "Noul", name: "System One · noul", text: "Is a statement about the reply true?", check: { type: "systemone.noul", question: "Does the reply answer the question?", min: 0.8 }, types: ["systemone.noul"] },
  { id: "system-one-choice", group: "systemone", short: "Choice", name: "System One · choice", text: "Which of these does the reply do?", check: { type: "systemone.choice", question: "What does the reply do?", options: ["answers", "asks", "refuses"], equals: "answers" }, types: ["systemone.choice"] },
  { id: "system-one-score", group: "systemone", short: "Score", name: "System One · score", text: "How good is the reply, on a scale?", check: { type: "systemone.score", question: "How helpful is the reply?", rubric: ["poor", "fair", "good", "excellent"], min: 2 }, types: ["systemone.score"] },
  { id: "judge", group: "llm", name: "Judge", text: "An LLM grades the reply against a rubric", check: { type: "judge", rubric: ["Answers the question"] }, types: ["judge"] },
  { id: "reference", group: "llm", name: "Reference", text: "The reply means the same as an expected answer", check: { type: "reference", reference: "The expected answer" }, types: ["reference"] },
];

// A check's kind, as its card names it: one of the kinds above, or (a plugin's check, or one this
// app doesn't know) its type as it's written
export function kindOf(check) {
  const type = check && typeof check === "object" ? typeOf(check) : null;
  return CHECK_TYPES.find((k) => k.types.includes(type)) ?? { id: "other", group: "other", name: type ?? "check", text: "" };
}

// Whether a check runs: a check can be turned off (enabled: false), and is then skipped
export const isOn = (check) => check?.enabled !== false;
