import test from "node:test";
import assert from "node:assert/strict";
import { runChecks } from "../scripts/run-checks.js";

test("check runner stops at the failing phase and emits one GitHub annotation", async () => {
  const invoked = []; let output = "";
  const code = await runChecks({
    checks: [{ title: "Syntax check", script: "lint" }, { title: "Hermetic test suite", script: "test" }, { title: "Smoke", script: "smoke" }],
    runCommand: async (script) => { invoked.push(script); return script === "test" ? 7 : 0; },
    githubActions: true,
    output: { write(value) { output += value; } }
  });
  assert.equal(code, 7);
  assert.deepEqual(invoked, ["lint", "test"]);
  assert.equal(output, "::error title=Hermetic test suite::npm run test exited with code 7\n");
});

test("check runner completes every phase without CI-only output", async () => {
  const invoked = []; let output = "";
  const code = await runChecks({
    checks: [{ title: "Syntax", script: "lint" }, { title: "Smoke", script: "smoke" }],
    runCommand: async (script) => { invoked.push(script); return 0; },
    githubActions: false,
    output: { write(value) { output += value; } }
  });
  assert.equal(code, 0);
  assert.deepEqual(invoked, ["lint", "smoke"]);
  assert.equal(output, "");
});
