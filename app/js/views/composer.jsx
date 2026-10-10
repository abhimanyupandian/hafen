// The message box (contracts/ui.md, Message box): exploring, it sends the message live; with a test
// open, it adds the message as the test's next turn (saved to the file); with a run or a suite open,
// it's hidden. What's typed is never lost: a message the engine refused before sending it (no turn
// of it in the thread) comes back in the box, with why under it. A problem the provider is known to
// have (a fixture that isn't there) is said in the panel, by the provider, not here: Send is off
// meanwhile, its title saying why (spec/design/components.md, Additions: Message box problems).

import { useRef, useState } from "react";
import { useStore } from "../design/hooks.js";
import { autoGrow } from "../lib/dom.js";
import { emit } from "../lib/events.js";
import { ScopeProblem } from "./fields.jsx";
import { sendProblem } from "./fixtures-field.jsx";
import { app, editSuite, providerInUse, select, sendMessage, stopSending, testOf, threadMode } from "../state.js";

export function Composer() {
  useStore(app);
  const mode = threadMode();
  // (Hidden, it's gone, with what was typed in it: shown again, it's empty, and so is what Send and the
  // field's scope check go by)
  if (mode === "run" || mode === "suite") return null;
  return <MessageBox mode={mode} />;
}

function MessageBox({ mode }) {
  const { selection, conversation, plugins } = useStore(app);
  const inputRef = useRef(null);
  const [text, setText] = useState("");
  // (Sending belongs to the conversation: with a test open, the box adds turns whatever it's doing)
  const sending = mode === "explore" && !!conversation?.sending;
  const provider = providerInUse();
  const test = mode === "test" ? testOf(selection.file, selection.test) : null;
  const placeholder = mode === "test" ? `Add a turn to ${test?.name ?? "the test"}` : provider ? "Type a message" : "Add a provider to send messages";
  // What stops any message to the provider (its fixtures), known before sending: the panel says it,
  // by the provider, and Send is off. Else why the last message was refused (it's back in the box).
  const known = mode === "explore" ? sendProblem(plugins)?.problem ?? "" : "";
  const problem = mode !== "explore" || known ? "" : conversation?.error ?? "";

  const submit = async () => {
    const typed = inputRef.current.value;
    const message = typed.trim();
    if (!message) return;
    if (mode === "test") {
      const path = ["tests", selection.test, "turns"];
      const turns = test?.turns ?? [];
      try {
        await editSuite(selection.file, [turns.length ? { op: "add", path, value: { user: message } } : { op: "set", path, value: [{ user: message }] }]);
      } catch {
        return;  // (editSuite has said why; the message stays in the box)
      }
      select({ kind: "turn", file: selection.file, test: selection.test, turn: turns.length });
      emit("thread:bottom");
    } else {
      if (!provider || known) return;
      inputRef.current.value = "";
      setText("");
      autoGrow(inputRef.current);
      try {
        await sendMessage(message);
      } catch {
        // Refused before it was sent (a sent message is a turn, whatever became of it): it's put back,
        // unless something else has been typed since, and why is said under it
        const box = inputRef.current;
        if (box && !box.value.trim()) {
          box.value = typed;
          setText(typed);
          autoGrow(box);
        }
      }
      return;
    }
    inputRef.current.value = "";
    setText("");
    autoGrow(inputRef.current);
  };

  return (
    <footer className="composer" id="composer">
      <form className="controls" id="form" aria-label={mode === "test" ? "Add a turn" : "Send a message"} onSubmit={(e) => {
        e.preventDefault();
        if (sending) stopSending();
        else submit();
      }}>
        <textarea className="textarea textarea-lg grow" id="input" rows="1" placeholder={placeholder} aria-label="Message" ref={inputRef}
                  aria-describedby={problem ? "sendProblem" : undefined}
                  onInput={(e) => { setText(e.target.value); autoGrow(e.target); }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                      // With a test open, ⌘↵ / Ctrl+Enter runs it (main.jsx), rather than adding a turn
                      if ((e.metaKey || e.ctrlKey) && mode !== "explore") return;
                      e.preventDefault();
                      if (!sending) submit();
                    }
                  }} />
        <button className={"btn btn-primary btn-lg" + (sending ? " stop" : "")} id="send" type="submit"
                disabled={!sending && (!text.trim() || (mode === "explore" && (!provider || !!known)))}
                title={!sending && known ? `Can't send: ${known}` : undefined}>
          {sending ? "Stop" : mode === "test" ? "Add turn" : "Send"}
        </button>
      </form>
      {problem && <p className="hint error field-problem" id="sendProblem" role="alert">{problem}</p>}
      <ScopeProblem id="inputProblem" value={text} />
    </footer>
  );
}
