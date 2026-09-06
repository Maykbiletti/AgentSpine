import test from "node:test";
import assert from "node:assert/strict";
import * as attention from "../src/lib/attention.js";

const EXPECTED_EXPORTS = [
  "attentionContext",
  "attentionFindings",
  "configureAttention",
  "deleteAttention",
  "inspectAttention",
  "loadAttention",
  "recordActivity",
  "recordAttentionEvent",
  "resolveAttention",
  "upsertAttention"
];

test("attention compatibility surface retains exact export ownership", () => {
  assert.deepEqual(Object.keys(attention), EXPECTED_EXPORTS);
});
