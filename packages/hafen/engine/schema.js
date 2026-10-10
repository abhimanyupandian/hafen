// JSON Schema validation (Ajv, draft 2020-12): the suite and provider files' own schemas, and the
// schemas checks name (`schema:`). One Ajv for the whole engine, so the app and CI report the same.

import Ajv2020 from "ajv/dist/2020.js";
import providerSchema from "./files/schema/provider.js";
import suiteSchema from "./files/schema/suite.js";

const ajv = new Ajv2020({ allErrors: true, strict: false, allowUnionTypes: true });
ajv.addSchema({ ...providerSchema, $id: "provider.schema.json" });
ajv.addSchema({ ...suiteSchema, $id: "suite.schema.json" });

export const validateSuiteSchema = ajv.getSchema("suite.schema.json");
export const validateProviderSchema = ajv.getSchema("provider.schema.json");

const compiled = new WeakMap();
// Validate `value` against a JSON Schema object: null when it's valid, else why not.
export function schemaProblem(schema, value) {
  let validate = compiled.get(schema);
  if (!validate) {
    validate = ajv.compile(schema);
    compiled.set(schema, validate);
  }
  if (validate(value)) return null;
  return (validate.errors ?? []).map((e) => `${e.instancePath || "the value"} ${e.message}`).join("; ");
}
