// The panel on the right (contracts/ui.md, Panel): one view for what's selected, in the design
// system's panel (a 52px head with an icon and a label, the body, the foot with ids and Delete).
// Edits go to the suite's file through the engine, which keeps its comments.

import { Fragment } from "react";
import { useStore } from "../design/hooks.js";
import { app, runForTest, select, suiteRunFor, testOf } from "../state.js";
import { ConversationView } from "./panel/conversation.jsx";
import { RunView, StepView } from "./panel/run.jsx";
import { SuiteView } from "./panel/suite.jsx";
import { TestView } from "./panel/test.jsx";
import { CheckView, TurnView } from "./panel/turn.jsx";

export function Panel() {
  const state = useStore(app);
  const { selection, openRun: run, conversation, lives } = state;
  const close = () => select({ kind: "conversation" });
  let view;
  switch (selection.kind) {
    case "suite": view = <SuiteView file={selection.file} close={close} />; break;
    case "test": view = <TestView file={selection.file} index={selection.test} close={close} />; break;
    case "turn": view = selection.explore ? <ConversationView close={close} /> : <TurnView selection={selection} close={close} />; break;
    case "check": view = <CheckView selection={selection} close={close} />; break;
    case "run": view = <RunView close={close} />; break;
    case "step": {
      const source = selection.explore ? conversation?.run
        : selection.in === "suite" ? suiteRunFor(selection.file)
          : selection.run && run?._id === selection.run ? run
            : lives.find((l) => l.run?._id === selection.run)?.run ?? (selection.file !== undefined ? runForTest(selection.file, selection.test) : run);
      const span = source?.spans?.find((s) => s._id === selection.span);
      // Back: to the step's turn by default (else its test)
      const turnIndex = selection.turn ?? (span?.ref?.turn !== undefined ? source?.turns?.[span.ref.turn]?.index : undefined);
      const back = Number.isInteger(turnIndex)
        ? { label: "Back to its turn", go: () => select(selection.explore ? { kind: "turn", explore: true, turn: turnIndex, in: "explore" } : { kind: "turn", file: selection.file, test: selection.test, turn: turnIndex, in: selection.in, run: selection.run }) }
        : selection.file !== undefined && selection.test !== undefined ? { label: "Back to the test", go: () => select({ kind: "test", file: selection.file, test: selection.test }) } : null;
      view = <StepView span={span} run={source} back={back} close={() => select(selection.explore ? { kind: "conversation" } : selection.in === "suite" ? { kind: "suite", file: selection.file } : selection.file !== undefined && selection.test !== undefined ? { kind: "test", file: selection.file, test: selection.test } : { kind: "conversation" })} />;
      break;
    }
    default: view = <ConversationView close={close} />;
  }
  // One view per thing selected (by what it is, not where it sits), so nothing typed or picked in
  // one is carried to another
  const t = selection.file !== undefined && selection.test !== undefined ? testOf(selection.file, selection.test) : null;
  const viewKey = [selection.kind, selection.file, t ? t.id ?? t.name : selection.test, selection.turn, selection.check, selection.span, selection.run].join("|");
  // (`shown`: on a small screen it covers the thread only when something's selected, or it's asked for)
  return <aside className={`panel${state.panelOpen ? " shown" : ""}`} id="panel" aria-label="Details"><Fragment key={viewKey}>{view}</Fragment></aside>;
}
