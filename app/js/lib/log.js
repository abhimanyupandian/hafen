// say() writes to the console panel (components/console.js) once main.js attaches it.
// kind: "cmd" (shown with $), "out", "log" (llama.cpp's own logs) or "err". tag: what the line is
// about, for the console to hide on request ("fixture": a provider's fixture, or its HTTP calls).

let sink = null;

export const attachLog = (write) => { sink = write; };
export const say = (text, kind = "out", tag) => sink?.(text, kind, tag);
