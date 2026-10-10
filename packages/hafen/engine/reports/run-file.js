// The run file (contracts/run-file.md): one JSON document per run, the same from the app and CI.

import { RUN_KIND, RUN_VERSION } from "../run-kind.js";

export const RUN_FILE = /\.hafen-run\.json$/i;
export const runFileName = (run) => `${run._id}.hafen-run.json`;

export const serializeRun = (run) => `${JSON.stringify(run, null, 2)}\n`;

// Read a run file's text: the run, or an error saying why it can't be read.
export function parseRun(text) {
  let run;
  try {
    run = JSON.parse(text);
  } catch (err) {
    throw new Error(`not a run file: ${err.message}`);
  }
  if (run?.kind !== RUN_KIND) throw new Error(`not a Hafen run file (kind is ${JSON.stringify(run?.kind)})`);
  if (typeof run.version !== "number" || run.version > RUN_VERSION) throw new Error(`this run file is version ${run.version}, made by a newer Hafen; this one reads version ${RUN_VERSION}`);
  return run;
}
