import assert from "node:assert/strict";
import { test } from "node:test";

import { SCRIBE_OP_NAMES, SCRIBE_SCHEMA } from "./scribe.js";

interface OpVariant {
  type: string;
  additionalProperties: boolean;
  required: string[];
  properties: Record<string, unknown> & { op?: { const?: string } };
}

function variants(): OpVariant[] {
  const props = SCRIBE_SCHEMA["properties"] as Record<string, Record<string, unknown>>;
  const ops = props["ops"] as { items: { anyOf: OpVariant[] } };
  return ops.items.anyOf;
}

test("schema variants match the ScribeOp union exactly", () => {
  const inSchema = variants()
    .map((v) => v.properties.op?.const)
    .filter((name): name is string => typeof name === "string")
    .sort();

  assert.deepEqual(inSchema, Object.keys(SCRIBE_OP_NAMES).sort());
});

test("every op variant is closed and fully required", () => {
  for (const variant of variants()) {
    const name = variant.properties.op?.const ?? "(unnamed)";

    // The API rejects a json_schema object without additionalProperties: false.
    assert.equal(variant.additionalProperties, false, `${name} must set additionalProperties: false`);

    // applyOps reads these fields without fallbacks, so the schema has to
    // guarantee all of them are present — not just the discriminator.
    assert.deepEqual(
      variant.required.slice().sort(),
      Object.keys(variant.properties).sort(),
      `${name} must require every property it declares`,
    );
  }
});

test("root schema is closed and requires both fields", () => {
  assert.equal(SCRIBE_SCHEMA["type"], "object");
  assert.equal(SCRIBE_SCHEMA["additionalProperties"], false);
  assert.deepEqual((SCRIBE_SCHEMA["required"] as string[]).slice().sort(), ["ops", "summary"]);
});
