// Thinking written in the text between tags (<think>…</think>, as Qwen3 and R1-style models write
// it when served raw). Feed text as it arrives; get back parts tagged thinking or text. A tag split
// across two pieces of text is still found: the end of a piece that could be the start of a tag is
// held back until the next piece says.

export function thinkTagSplitter([open, close] = ["<think>", "</think>"]) {
  let inside = false;
  let held = "";

  // How much of the end of `text` could be the start of `tag`
  const partial = (text, tag) => {
    for (let n = Math.min(tag.length - 1, text.length); n > 0; n--) if (tag.startsWith(text.slice(-n))) return n;
    return 0;
  };

  function feed(text) {
    const parts = [];
    let rest = held + text;
    held = "";
    for (;;) {
      const tag = inside ? close : open;
      const at = rest.indexOf(tag);
      if (at === -1) {
        const keep = partial(rest, tag);
        const out = rest.slice(0, rest.length - keep);
        held = rest.slice(rest.length - keep);
        if (out) parts.push({ type: inside ? "thinking" : "text", text: out });
        return parts;
      }
      if (at > 0) parts.push({ type: inside ? "thinking" : "text", text: rest.slice(0, at) });
      rest = rest.slice(at + tag.length);
      inside = !inside;
    }
  }

  // The end of the stream: whatever was held back is what it is
  function end() {
    const out = held ? [{ type: inside ? "thinking" : "text", text: held }] : [];
    held = "";
    return out;
  }

  return { feed, end, get inside() { return inside; } };
}
