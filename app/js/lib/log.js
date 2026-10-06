// say() writes to the console panel (components/console.js) once main.js attaches it.
// kind: "cmd" (shown with $), "out", "log" (llama.cpp's own logs) or "err".

let sink = null;

export const attachLog = (write) => { sink = write; };
export const say = (text, kind = "out") => sink?.(text, kind);
