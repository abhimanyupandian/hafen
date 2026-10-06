// The message box (contracts/ui.md, Message box): exploring, it sends the message live; with a test
// open, it adds the message as the test's next turn (saved to the file); with a run or a suite open,
// it's hidden.

import { useRef, useState } from "react";
import { useStore } from "../design/hooks.js";
import { autoGrow } from "../lib/dom.js";
import { emit } from "../lib/events.js";
import { ScopeProblem } from "./fields.jsx";
import { app, editSuite, select, sendMessage, stopSending, testOf, threadMode } from "../state.js";

export function Composer() {
  useStore(app);
  const mode = threadMode();
  // (Hidden, it's gone, with what was typed in it: shown again, it's empty, and so is what Send and the
  // field's {{scope}} check go by)
  if (mode === "run" || mode === "suite") return null;
  return <MessageBox mode={mode} />;
}

function MessageBox({ mode }) {
  const { selection, conversation, providers } = useStore(app);
  const inputRef = useRef(null);
  const [text, setText] = useState("");
  // (Sending belongs to the conversation: with a test open, the box adds turns whatever it's doing)
  const sending = mode === "explore" && !!conversation?.sending;
  const provider = providers.find((p) => p.file === conversation?.provider) ?? providers[0];
  const test = mode === "test" ? testOf(selection.file, selection.test) : null;
  const placeholder = mode === "test" ? `Add a turn to ${test?.name ?? "the test"}` : provider ? "Type a message" : "Add a provider to send messages";

  const submit = async () => {
    const message = inputRef.current.value.trim();
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
      if (!provider) return;
      inputRef.current.value = "";
      setText("");
      autoGrow(inputRef.current);
      await sendMessage(message).catch(() => {});
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
                  onInput={(e) => { setText(e.target.value); autoGrow(e.target); }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                      // With a test open, ⌘↵ / Ctrl+Enter runs it (main.jsx), rather than adding a turn
                      if ((e.metaKey || e.ctrlKey) && mode !== "explore") return;
                      e.preventDefault();
                      if (!sending) submit();
                    }
                  }} />
        <button className={"btn btn-primary btn-lg" + (sending ? " stop" : "")} id="send" type="submit" disabled={!sending && (!text.trim() || (mode === "explore" && !provider))}>
          {sending ? "Stop" : mode === "test" ? "Add turn" : "Send"}
        </button>
      </form>
      <ScopeProblem id="inputProblem" value={text} />
    </footer>
  );
}
