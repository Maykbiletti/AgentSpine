import assert from "node:assert/strict";
import test from "node:test";
import { checkLineBudget, sourceMetrics } from "../scripts/check-line-budget.js";

test("line budget rejects single-line minification as a separate readability boundary", async () => {
  const compact = sourceMetrics("x".repeat(2001));
  assert.deepEqual(compact, { lines: 1, maxLineBytes: 2001 });

  const report = await checkLineBudget();
  assert.equal(report.defaultMaxLineBytes, 2000);
  assert.deepEqual(report.lineLengthFailures, []);
  assert.equal(report.ok, true);
});
