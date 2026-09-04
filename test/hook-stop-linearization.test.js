import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHook } from "../src/hook.js";
import { recordDeliveryPremortem } from "../src/lib/delivery-premortem.js";
import { recordDeliveryWriteIntent } from "../src/lib/delivery-verification.js";
import { verifyHookStopContracts } from "../src/lib/hook-stop-verification.js";
import { seedDeliveryAgentUse } from "./delivery-agent-use-fixture.js";

const PROJECT_ID = "project:stop-linearization";
const ITEMS = [
  {
    category: "baseline-environment",
    failure: "this delivery fails because the synthetic baseline moved",
    check: "Compare the synthetic baseline digest."
  },
  {
    category: "contract-tests",
    failure: "this delivery fails because the synthetic test contract regressed",
    check: "Run the focused synthetic test."
  },
  {
    category: "delivery-path",
    failure: "this delivery fails because the synthetic artifact is misplaced",
    check: "Verify the synthetic artifact path."
  }
];

async function fixture(t) {
  const workspace = await mkdtemp(join(tmpdir(), "agentspine-stop-linearization-"));
  const root = join(workspace, "project");
  const state = join(workspace, "state");
  await Promise.all([mkdir(join(root, ".git"), { recursive: true }), mkdir(state)]);
  await writeFile(join(root, "AGENTS.md"), "# Synthetic rules\n", "utf8");
  const previous = process.env.AGENTSPINE_STATE_DIR;
  process.env.AGENTSPINE_STATE_DIR = state;
  t.after(async () => {
    if (previous === undefined) delete process.env.AGENTSPINE_STATE_DIR;
    else process.env.AGENTSPINE_STATE_DIR = previous;
    await rm(workspace, { recursive: true, force: true });
  });
  return root;
}

function common(root, session) {
  return {
    host: "codex",
    cwd: root,
    session_id: session,
    agent_spine_scope: { project_id: PROJECT_ID }
  };
}

async function post(root, session, toolName, toolInput, toolUseId) {
  return runHook({
    ...common(root, session),
    hook_event_name: "PostToolUse",
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: toolUseId,
    success: true,
    tool_response: { exit_code: 0 }
  });
}

async function write(root, session, toolUseId, content, options = {}) {
  const toolInput = { file_path: "artifact.txt", content };
  const pre = await runHook({
    ...common(root, session),
    hook_event_name: "PreToolUse",
    tool_name: "Write",
    tool_input: toolInput,
    tool_use_id: toolUseId
  }, options);
  assert.equal(pre.blocked, false);
  await writeFile(join(root, "artifact.txt"), content, "utf8");
  return post(root, session, "Write", toolInput, toolUseId);
}

function closure(artifact, writeDigest) {
  return [
    `Premortem closure sha256 ${artifact.digest}`,
    `Premortem latest write sha256 ${writeDigest}`,
    ...artifact.items.map((item) =>
      `- ${item.category} ${item.checkId}: PASS — synthetic check passed`)
  ].join("\n");
}

async function preparedDelivery(t, session) {
  const root = await fixture(t);
  const prompt = await runHook({
    ...common(root, session),
    hook_event_name: "UserPromptSubmit",
    event_id: `prompt:${session}`,
    prompt: "Create the synthetic artifact."
  });
  const requirementId = prompt.preflight.premortem.requirementId;
  await seedDeliveryAgentUse(root, requirementId);
  const recorded = await recordDeliveryPremortem({ root, requirementId, items: ITEMS });
  const written = await write(root, session, `write:${session}:initial`, "initial\n");
  await post(root, session, "exec_command",
    { cmd: "node --test test/synthetic.test.js" }, `test:${session}:initial`);
  return {
    root,
    artifact: recorded.artifact,
    closure: closure(recorded.artifact, written.premortem.writeDigest)
  };
}

function barrier() {
  let enter;
  let release;
  const entered = new Promise((resolve) => { enter = resolve; });
  const blocked = new Promise((resolve) => { release = resolve; });
  return {
    entered,
    release,
    wait() {
      enter();
      return blocked;
    }
  };
}

function stopInput(root, session, finalMessage) {
  return {
    ...common(root, session),
    hook_event_name: "Stop",
    event_id: `stop:${session}`,
    final_assistant_message: finalMessage
  };
}

test("Stop rechecks test evidence after artifact verification", async (t) => {
  const session = "session:artifact-window:test-evidence";
  const delivery = await preparedDelivery(t, session);
  const gate = barrier();
  const stopping = runHook(stopInput(delivery.root, session, delivery.closure), {
    afterArtifactVerification: () => gate.wait()
  });
  await gate.entered;
  try {
    await write(delivery.root, session, `write:${session}:racing`, "racing\n");
  } finally {
    gate.release();
  }
  const stopped = await stopping;
  assert.equal(stopped.blocked, true);
  assert.equal(stopped.deliveryVerification.status, "blocked");
  assert.match(stopped.reason, /successful test after the latest write/);
  assert.equal(Object.hasOwn(stopped, "learningDelivery"), false);
  assert.equal(Object.hasOwn(stopped, "selfstarter"), false);
});

test("Stop rechecks premortem after a tested write races artifact verification", async (t) => {
  const session = "session:artifact-window:premortem";
  const delivery = await preparedDelivery(t, session);
  const gate = barrier();
  const stopping = runHook(stopInput(delivery.root, session, delivery.closure), {
    afterArtifactVerification: () => gate.wait()
  });
  await gate.entered;
  try {
    await write(delivery.root, session, `write:${session}:racing`, "racing\n");
    await post(delivery.root, session, "exec_command",
      { cmd: "node --test test/synthetic.test.js" }, `test:${session}:racing`);
  } finally {
    gate.release();
  }
  const stopped = await stopping;
  assert.equal(stopped.blocked, true);
  assert.equal(stopped.deliveryVerification.status, "verified");
  assert.equal(stopped.premortem.status, "unchecked");
  assert.match(stopped.reason, /latest-write-digest/);
  assert.equal(Object.hasOwn(stopped, "learningDelivery"), false);
});

test("the final delivery fence catches an intent between delivery and premortem checks", async (t) => {
  const session = "session:final-fence";
  const delivery = await preparedDelivery(t, session);
  const stopGate = barrier();
  const writeGate = barrier();
  const stopping = runHook(stopInput(delivery.root, session, delivery.closure), {
    afterFinalDeliveryVerification: () => stopGate.wait()
  });
  await stopGate.entered;

  const writing = write(delivery.root, session, `write:${session}:racing`, "racing\n", {
    afterDeliveryWriteIntent: () => writeGate.wait()
  });
  await writeGate.entered;
  stopGate.release();
  const stopped = await stopping;
  writeGate.release();
  await writing;

  assert.equal(stopped.blocked, true);
  assert.equal(stopped.deliveryVerification.status, "blocked");
  assert.match(stopped.reason, /write intent/);
  assert.equal(stopped.premortem.status, "closed");
  assert.equal(Object.hasOwn(stopped, "learningDelivery"), false);
});

test("the final state digest catches a Post-only compound write and test", async (t) => {
  const session = "session:compound-post";
  const delivery = await preparedDelivery(t, session);
  const gate = barrier();
  const stopping = runHook(stopInput(delivery.root, session, delivery.closure), {
    afterFinalPremortemVerification: () => gate.wait()
  });
  await gate.entered;
  try {
    const raced = await post(delivery.root, session, "exec_command",
      { cmd: "touch artifact.txt && npm test" }, `compound:${session}`);
    assert.equal(raced.deliveryVerification.status, "write-recorded");
    assert.equal(raced.deliveryVerification.pending, false);
  } finally {
    gate.release();
  }
  const stopped = await stopping;
  assert.equal(stopped.blocked, true);
  assert.equal(stopped.deliveryVerification.status, "changed");
  assert.match(stopped.reason, /delivery evidence changed during Stop/);
  assert.equal(stopped.premortem.status, "closed");
  assert.equal(Object.hasOwn(stopped, "learningDelivery"), false);
});

test("an unfinished job remains a pause instead of entering the completion fence", async (t) => {
  const session = "session:paused-job";
  const delivery = await preparedDelivery(t, session);
  await write(delivery.root, session, `write:${session}:unfinished`, "unfinished\n");
  const input = stopInput(delivery.root, session, "");
  const scope = {
    host: "codex",
    projectId: PROJECT_ID,
    entityId: null,
    groupId: null,
    currentTaskId: null
  };
  const initial = await verifyHookStopContracts({
    input,
    root: delivery.root,
    scope,
    recordPause: true
  });
  const final = await verifyHookStopContracts({
    input,
    root: delivery.root,
    scope,
    recordPause: true
  });
  assert.equal(initial.blocked, false);
  assert.equal(final.blocked, false);
  assert.equal(final.deliveryVerification.status, "paused-job");
  assert.equal(final.premortem.status, "paused-job");
});

test("a timestamp without a host event id cannot preserve a pause into completion", async (t) => {
  const session = "session:timestamp-is-not-event";
  const delivery = await preparedDelivery(t, session);
  const input = {
    ...common(delivery.root, session),
    hook_event_name: "Stop",
    timestamp: "2035-03-04T05:06:07.000Z",
    final_assistant_message: delivery.closure
  };
  const scope = {
    host: "codex",
    projectId: PROJECT_ID,
    entityId: null,
    groupId: null,
    currentTaskId: null
  };

  const paused = await verifyHookStopContracts({ input, root: delivery.root, scope, recordPause: true });
  assert.equal(paused.blocked, false);
  assert.equal(paused.deliveryVerification.status, "paused-job");

  const intent = await recordDeliveryWriteIntent({
    root: delivery.root,
    host: "codex",
    sessionId: session,
    scope,
    input: {
      tool_name: "Write",
      tool_use_id: "tool:timestamp-is-not-event",
      tool_input: { file_path: "artifact.txt", content: "later synthetic write\\n" }
    }
  });
  assert.equal(intent.status, "intent-recorded");

  const completion = await verifyHookStopContracts({ input, root: delivery.root, scope });
  assert.equal(completion.blocked, true);
  assert.equal(completion.deliveryVerification.status, "blocked");
  assert.match(completion.reason, /write intent\(s\).*no auditable PostToolUse result/);
});
