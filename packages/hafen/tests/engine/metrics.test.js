// A turn's metrics (data-model.md, Metrics): time to first token, thinking, first answer, and tokens
// per second while it generated: over the thinking and the answer when the thinking is shown (output
// tokens count it; Gemini's apart), the answer's own when it's hidden.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { metricsOf } from "../../engine/turn.js";

describe("a turn's metrics", () => {
  it("times the first token, the thinking and the first answer token", () => {
    const m = metricsOf([{ type: "thinking", t: 400, t_end: 2400 }, { type: "text", t: 2500, t_end: 3000 }], { ms: 3100 });
    assert.equal(m.ttft_ms, 400);
    assert.equal(m.first_thinking_ms, 400);
    assert.equal(m.thinking_ms, 2000);
    assert.equal(m.first_answer_ms, 2500);
    assert.equal(m.tokens_per_s, undefined);  // (no usage reported)
  });

  it("with no thinking: the output tokens over the answer's time", () => {
    const m = metricsOf([{ type: "text", t: 500, t_end: 2500 }], { ms: 2500, usage: { output: 100 }, provider: { kind: "openai-chat" } });
    assert.equal(m.tokens_per_s, 50);
  });

  it("with the thinking shown: every output token over the thinking and the answer, not the answer's time alone", () => {
    // 525 tokens (Ollama counts the thinking in them): 16.5 s of thinking, then a short answer
    const events = [{ type: "thinking", t: 1100, t_end: 17600 }, { type: "text", t: 17800, t_end: 18300 }];
    const m = metricsOf(events, { ms: 18300, usage: { input: 425, output: 525 }, provider: { kind: "ollama" } });
    assert.equal(m.tokens_per_s, 30.5);
  });

  it("with the thinking hidden (counted, not shown): the answer's own tokens over its time", () => {
    const m = metricsOf([{ type: "text", t: 9000, t_end: 11000 }], { ms: 11000, usage: { output: 500, thinking: 400 }, provider: { kind: "openai-responses" } });
    assert.equal(m.tokens_per_s, 50);
  });

  it("Gemini reports its thinking tokens apart: they're added (shown) or not taken away (hidden)", () => {
    const shown = metricsOf([{ type: "thinking", t: 1000, t_end: 5000 }, { type: "text", t: 5000, t_end: 6000 }], { ms: 6000, usage: { output: 100, thinking: 300 }, provider: { kind: "gemini" } });
    assert.equal(shown.tokens_per_s, 80);
    const hidden = metricsOf([{ type: "text", t: 5000, t_end: 7000 }], { ms: 7000, usage: { output: 100, thinking: 300 }, provider: { kind: "gemini" } });
    assert.equal(hidden.tokens_per_s, 50);
  });

  it("says nothing for a reply too quick to time, or with no tokens left to count", () => {
    assert.equal(metricsOf([{ type: "text", t: 100, t_end: 120 }], { ms: 120, usage: { output: 5 } }).tokens_per_s, undefined);
    assert.equal(metricsOf([{ type: "text", t: 100, t_end: 2100 }], { ms: 2100, usage: { output: 300, thinking: 300 } }).tokens_per_s, undefined);
  });

  it("keeps only the token counts reported", () => {
    const m = metricsOf([{ type: "text", t: 100, t_end: 2100 }], { ms: 2100, usage: { input: 10, output: 20, thinking: undefined, cached: undefined } });
    assert.deepEqual(m.tokens, { input: 10, output: 20 });
  });
});
