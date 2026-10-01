import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { processCall } from "./mcp-bounded-fixture.js";

test("processCall settles on the first complete response without waiting for child close", async () => {
  let spawnCalls = 0;
  let killCalls = 0;
  const spawnProcess = () => {
    spawnCalls += 1;
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => { killCalls += 1; return true; };
    queueMicrotask(() => child.stdout.write(`${JSON.stringify({ result: {
      content: [{ text: JSON.stringify({ status: "synthetic-response" }) }], isError: false
    } })}\n`));
    return child;
  };

  const result = await processCall(process.cwd(), "synthetic_tool", {}, {
    spawnProcess, responseTimeoutMs: 25
  });

  assert.equal(spawnCalls, 1);
  assert.equal(killCalls, 1);
  assert.deepEqual(result, { status: "synthetic-response", isError: false });
});
