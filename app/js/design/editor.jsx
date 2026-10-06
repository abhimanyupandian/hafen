// A text field's maximize button: <MaxButton fieldRef fieldId label onSave /> opens the field's text
// in a large editor (`label` names it: a string, or a function for a field whose name changes).
// Save hands the edited text to onSave, which handles it as if it were typed, so the field's own
// handling saves and checks it; Cancel, Esc or a click outside leave the field as it was.
// ⌘/Ctrl+Enter saves.

import { useLayoutEffect, useRef, useState } from "react";
import { formatJs, highlightJs, newLine } from "./code.js";
import { Icon } from "./icons.jsx";
import { CloseButton, Modal } from "./modal.jsx";

const nameOf = (label) => (typeof label === "function" ? label() : label);

// Text put in a field as if typed (so ⌘Z undoes it): the selection, or [from, to], replaced
function typeIn(el, text, from = el.selectionStart, to = el.selectionEnd) {
  el.setSelectionRange(from, to);
  let done = false;
  try {
    done = document.execCommand("insertText", false, text);
  } catch {}
  if (!done) {
    el.setRangeText(text, from, to, "end");
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }
}

// A code field's keys (language: "javascript"): Tab indents (the selected lines, or two spaces),
// Shift+Tab outdents, Enter keeps the line's indent (a level more after an opening bracket), a closing
// bracket typed first on a line goes back a level. True when it handled the key.
function codeKey(e, el) {
  const { value, selectionStart: start, selectionEnd: end } = el;
  const lineStart = value.lastIndexOf("\n", start - 1) + 1;
  if (e.key === "Tab" && !e.metaKey && !e.ctrlKey && !e.altKey) {
    const many = value.slice(start, end).includes("\n");
    if (!e.shiftKey && !many) {
      typeIn(el, "  ");
      return true;
    }
    // The lines the selection touches, each a level in (or out)
    const blockEnd = value.indexOf("\n", Math.max(start, end - (end > start && value[end - 1] === "\n" ? 1 : 0)));
    const to = blockEnd === -1 ? value.length : blockEnd;
    const lines = value.slice(lineStart, to).split("\n");
    const next = lines.map((l) => (e.shiftKey ? l.replace(/^ {1,2}|^\t/, "") : l ? `  ${l}` : l)).join("\n");
    typeIn(el, next, lineStart, to);
    // (the lines stay selected; on one line, the caret moves with its text)
    const moved = next.length - (to - lineStart);
    if (many) el.setSelectionRange(lineStart, lineStart + next.length);
    else el.setSelectionRange(Math.max(lineStart, start + moved), Math.max(lineStart, end + moved));
    return true;
  }
  if (e.key === "Enter" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
    const { insert, caret } = newLine(value, start);
    typeIn(el, insert, start, end);
    el.setSelectionRange(start + caret, start + caret);
    return true;
  }
  if (["}", "]", ")"].includes(e.key) && start === end) {
    const indent = value.slice(lineStart, start);
    if (/^ {2,}$/.test(indent)) {
      typeIn(el, `${indent.slice(2)}${e.key}`, lineStart, start);
      return true;
    }
  }
  return false;
}

// The large editor itself (also opened by a button of its own: the panel's "Edit as YAML"). A
// JavaScript field (language: "javascript", a plugin's) is shown in colour, keeps its indenting as it's
// typed, and has Format.
export function Editor({ field, label, onSave, onClose }) {
  const dialogRef = useRef(null);
  const textRef = useRef(null);
  const colorsRef = useRef(null);
  const js = field.language === "javascript";
  const [text, setText] = useState(field.value ?? "");
  const save = () => {
    if (field.value !== textRef.current.value) onSave(textRef.current.value);
    dialogRef.current.close();
  };
  // The colours under the text scroll with it
  const follow = () => {
    if (colorsRef.current) {
      colorsRef.current.scrollTop = textRef.current.scrollTop;
      colorsRef.current.scrollLeft = textRef.current.scrollLeft;
    }
  };
  useLayoutEffect(() => {
    const el = textRef.current;
    el.focus();
    el.setSelectionRange(js ? 0 : el.value.length, js ? 0 : el.value.length);
  }, []);
  useLayoutEffect(follow, [text]);
  const format = () => {
    const el = textRef.current;
    const next = formatJs(el.value);
    if (next === el.value) return;
    const line = el.value.slice(0, el.selectionStart).split("\n").length - 1;
    typeIn(el, next, 0, el.value.length);
    // (the caret stays on its line)
    const at = next.split("\n").slice(0, line).join("\n").length + (line ? 1 : 0);
    const indent = next.slice(at).match(/^[ \t]*/)[0].length;
    el.setSelectionRange(at + indent, at + indent);
    el.focus();
  };
  const keys = (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      save();
      return;
    }
    if (js && (e.key === "f" || e.key === "F") && e.shiftKey && e.altKey) {
      e.preventDefault();
      format();
      return;
    }
    if (js && codeKey(e, textRef.current)) e.preventDefault();
  };
  return (
    <Modal id="editor" label={`Edit ${label}`} className="editor" onClose={onClose} dialogRef={dialogRef}>
      <div className="modal-head">
        <span className="label" id="editorTitle">{label}</span>
        <CloseButton dialogRef={dialogRef} id="editorClose" />
      </div>
      <div className="editor-body">
        {js ? (
          <div className="code-edit" data-language="javascript">
            {/* (the text's colours, under the text itself, which is see-through) */}
            <pre className="code-edit-colors textarea-code" id="editorColors" aria-hidden="true" ref={colorsRef}
                 dangerouslySetInnerHTML={{ __html: `${highlightJs(text)}\n` }} />
            <textarea className="textarea textarea-code code-edit-text" id="editorText" defaultValue={field.value} wrap="off"
                      spellCheck={false} autoCapitalize="off" autoCorrect="off" aria-label={label} ref={textRef}
                      onInput={(e) => setText(e.currentTarget.value)} onScroll={follow} onKeyDown={keys} />
          </div>
        ) : (
          <textarea className={`textarea editor-text${field.code ? " textarea-code" : ""}`} id="editorText" defaultValue={field.value}
                    spellCheck={field.spellcheck || undefined} aria-label={label} placeholder={field.placeholder} ref={textRef}
                    onKeyDown={keys} />
        )}
      </div>
      <div className="modal-foot">
        <span className="hint">{js ? "Tab indents · ⇧⌥F formats · ⌘/Ctrl+Enter saves · Esc cancels" : "⌘/Ctrl+Enter saves · Esc cancels"}</span>
        {js && <button type="button" className="btn" id="editorFormat" onClick={format}>Format</button>}
        <button type="button" className="btn" id="editorCancel" onClick={() => dialogRef.current.close()}>Cancel</button>
        <button type="button" className="btn btn-primary" id="editorSave" onClick={save}>Save</button>
      </div>
    </Modal>
  );
}

export function MaxButton({ fieldRef, fieldId, label, onSave }) {
  const [open, setOpen] = useState(null);  // the field as the editor opened: {value, code, spellcheck, placeholder}
  // Named as it's drawn, and again when it's about to be used, for a field whose name changes
  const name = () => `Open ${nameOf(label).toLowerCase()} in a large editor`;
  const [ariaLabel, setAriaLabel] = useState(name);
  const rename = () => setAriaLabel(name());
  const openEditor = () => {
    const field = fieldRef.current;
    if (field.disabled || field.readOnly) return;
    setOpen({ value: field.value, code: field.classList.contains("textarea-code"), spellcheck: field.spellcheck, placeholder: field.placeholder });
  };
  return (
    <>
      <button type="button" className="btn btn-ghost btn-icon btn-max" id={`${fieldId}Max`} title="Open in a large editor"
              aria-label={ariaLabel} onFocus={rename} onMouseEnter={rename} onClick={openEditor}>
        <Icon name="maximize" size={14} />
      </button>
      {open && <Editor field={open} label={nameOf(label)} onSave={onSave} onClose={() => setOpen(null)} />}
    </>
  );
}
