// JSONPath, as RFC 9535 standardises it (json-p3, which passes the JSONPath Compliance Test Suite:
// tests/engine/jsonpath-compliance.test.js). Paths select values; operators then test them.

import { jsonpath } from "json-p3";

const compiled = new Map();

// A path, compiled once. Throws a readable error for one that doesn't parse.
function compile(path) {
  let query = compiled.get(path);
  if (!query) {
    try {
      query = jsonpath.compile(path);
    } catch (err) {
      throw new Error(`"${path}" isn't a valid JSONPath: ${err.message}`);
    }
    compiled.set(path, query);
  }
  return query;
}

// Every value `path` matches in `data`, in document order ([] for none).
export function select(path, data) {
  return Array.from(compile(path).query(data), (node) => node.value);
}

// The first value `path` matches, or undefined.
export function first(path, data) {
  return select(path, data)[0];
}

// Whether `path` parses (for validation): null when it does, else why not.
export function problem(path) {
  try {
    compile(path);
    return null;
  } catch (err) {
    return err.message;
  }
}
