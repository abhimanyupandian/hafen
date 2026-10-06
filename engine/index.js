// Hafen's engine: everything about running tests, with no DOM. It runs unchanged in a Web Worker
// (the browser build), in the desktop app's utility process and in Node (the CLI): constitution II.
// Whatever is platform-specific comes in as a host (runner.js says what a host has).

export { loadSuite, editText, newSuiteText, parseText, SUITE_FILE, VERSION } from "./files/suite-file.js";
export { parseData } from "./files/data.js";
export { runSuites, newRun, summarize, countChecks, RUN_KIND, RUN_VERSION } from "./runner.js";
export { createConversation, conversationToTest } from "./explore.js";
export { executeTurn } from "./turn.js";
export { createProvider, describeKind, PRESETS, KINDS } from "./providers/index.js";
export { describe as describeCheck, typeOf as checkType, isJudged, JUDGED } from "./checks/index.js";
export { OPERATORS } from "./checks/operators.js";
export { fetchTransport, withRetries, withNetwork } from "./transport.js";
export { select as selectPath, problem as pathProblem } from "./jsonpath.js";
export { junit } from "./reports/junit.js";
export { markdown } from "./reports/markdown.js";
export { jsonSummary } from "./reports/json.js";
export { serializeRun, parseRun, runFileName, RUN_FILE, LEGACY_RUN_KIND } from "./reports/run-file.js";
export { compareRuns } from "./compare.js";
export { servePort } from "./serve-port.js";
export { uid, testId, percentiles } from "./util.js";
