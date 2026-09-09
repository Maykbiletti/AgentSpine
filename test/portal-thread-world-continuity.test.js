import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { runHook } from "../src/hook.js";
import { startMcpServer } from "../src/mcp.js";
import { channelTimelineContinuity } from "../src/lib/channel-continuity.js";
import { upsertEntity } from "../src/lib/graph.js";
import { recordWorldAssertion, worldContext, worldModelStatePath } from "../src/lib/world-model.js";

const PROJECT = "project:portal-world";
const TASK = "task:portal-world";
const NOW = "2026-09-07T03:00:00.000Z";
const SESSION_REF = "session-ref:0123456789abcdef0123456789abcdef";
const ENV_NAMES = [
  "AGENTSPINE_STATE_DIR", "AGENTSPINE_GATEWAY_CONTEXT", "AGENTSPINE_ENTITY_ID",
  "AGENTSPINE_USER_ID", "AGENTSPINE_TENANT_ID", "AGENTSPINE_PROJECT_ID",
  "AGENTSPINE_TASK_ID", "AGENTSPINE_HOST", "AGENTSPINE_PORTAL_REF", "AGENTSPINE_THREAD_REF"
];

function digest(value) {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
}

function route(threadId) {
  return channelTimelineContinuity({
    provider: "blun", tenantId: "tenant:portal-world", accountId: "account:portal-world",
    bindingId: "binding:portal-world", chatId: "chat:synthetic", threadId,
    sessionKey: "portal:synthetic:work", agentId: "agent:portal-world", projectId: PROJECT,
    groupId: null
  });
}

function gatewayEnvironment(binding) {
  return {
    ...process.env,
    AGENTSPINE_GATEWAY_CONTEXT: "agentspine.gateway-start/v1",
    AGENTSPINE_ENTITY_ID: "agent:portal-world",
    AGENTSPINE_USER_ID: "person:portal-world",
    AGENTSPINE_TENANT_ID: "tenant:portal-world",
    AGENTSPINE_PROJECT_ID: PROJECT,
    AGENTSPINE_TASK_ID: TASK,
    AGENTSPINE_HOST: "claude",
    AGENTSPINE_PORTAL_REF: binding.portalRef,
    AGENTSPINE_THREAD_REF: binding.threadRef
  };
}

function setGateway(binding) {
  Object.assign(process.env, gatewayEnvironment(binding));
}

function mcpClient(environment) {
  const input = new PassThrough();
  const output = new PassThrough();
  output.setEncoding("utf8");
  let sequence = 0;
  let buffer = "";
  const pending = new Map();
  output.on("data", (chunk) => {
    buffer += chunk;
    while (buffer.includes("\n")) {
      const end = buffer.indexOf("\n");
      const message = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      pending.get(message.id)?.(message.result);
      pending.delete(message.id);
    }
  });
  startMcpServer(input, output, { environment });
  return (name, args) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => reject(new Error(`MCP ${name} timed out`)), 4_000);
    pending.set(id, (result) => {
      clearTimeout(timer);
      resolve({ ...result, value: JSON.parse(result.content[0].text) });
    });
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call",
      params: { name, arguments: args } })}\n`);
  });
}

function continuation(next, status = "active") {
  const completed = status === "completed";
  return {
    schema: "agentspine.task-continuation/v1",
    taskId: TASK,
    status,
    objective: "Verify the portal backup contract and publish its measured result.",
    lastVerifiedStep: {
      id: completed ? "step:foreign-finished" : "step:baseline",
      summary: completed ? "Verified the foreign thread result." : "Verified the portal baseline.",
      result: "passed",
      evidenceId: completed ? "measurement:foreign-finished" : "measurement:baseline",
      evidenceDigest: digest(completed ? "foreign-finished" : "baseline"),
      observedAt: "2026-09-07T01:00:00.000Z",
      sessionRef: SESSION_REF,
      messageRef: completed ? "timeline-event:foreign-finished" : "timeline-event:baseline"
    },
    openQuestions: completed ? [] : [{
      id: "question:checksum", question: "Does the portal backup checksum match?"
    }],
    nextStep: completed ? null : { id: `step:${next}`, summary: `Run the portal backup ${next} verification.` }
  };
}

function assertion(root, id, value, extra = {}) {
  return {
    root, id, subjectId: TASK, predicate: "task.continuation", value,
    evidenceKind: "objective-measurement", evidenceId: `measurement:${id.split(":")[1]}`,
    evidenceDigest: digest(value), observedAt: "2026-09-07T02:00:00.000Z",
    projectId: PROJECT, privacy: "private", knowledgeKind: "task-state",
    sessionRef: SESSION_REF, messageRef: `timeline-event:${id.split(":")[1]}`, now: NOW,
    ...extra
  };
}

function decision(root, id, instruction, extra = {}) {
  const value = { instruction };
  return {
    root, id, subjectId: TASK, predicate: "decision.portal-backup", value,
    evidenceKind: "explicit-user-feedback", evidenceId: `user-turn:${id.split(":")[1]}`,
    evidenceDigest: digest(value), observedAt: "2026-09-07T02:10:00.000Z",
    projectId: PROJECT, privacy: "private", knowledgeKind: "decision",
    sessionRef: SESSION_REF, messageRef: `timeline-event:${id.split(":")[1]}`,
    reason: "The user corrected the portal backup verification step.", now: NOW,
    ...extra
  };
}

async function fixture(t) {
  const workspace = await mkdtemp(join(tmpdir(), "agentspine-portal-world-"));
  const state = join(workspace, "state");
  const project = join(workspace, "project");
  const legacy = join(workspace, "legacy");
  await Promise.all([mkdir(state), mkdir(join(project, ".git"), { recursive: true }),
    mkdir(join(legacy, ".git"), { recursive: true })]);
  const source = Buffer.from("# Synthetic portal knowledge\n\nThese source bytes remain unchanged.\n");
  await Promise.all([writeFile(join(project, "AGENTS.md"), source),
    writeFile(join(legacy, "AGENTS.md"), source)]);
  const previous = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
  process.env.AGENTSPINE_STATE_DIR = state;
  await upsertEntity({ root: project, id: "agent:portal-world", kind: "agent",
    displayName: "Synthetic Portal Agent", privacy: "private" });
  t.after(async () => {
    for (const name of ENV_NAMES) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
    await rm(workspace, { recursive: true, force: true, maxRetries: 3 });
  });
  return { project, legacy, state, source };
}

async function writeThroughGateway(call, input) {
  const result = await call("record_world_assertion", input);
  assert.equal(result.isError, false, JSON.stringify(result.value));
  return result.value.assertion;
}

function freshMcpContext(item, binding) {
  const request = { jsonrpc: "2.0", id: 1, method: "tools/call", params: {
    name: "world_context", arguments: {
      root: item.project, projectId: PROJECT, includePrivate: true, now: NOW
    }
  } };
  const child = spawnSync(process.execPath, ["src/mcp.js"], {
    cwd: process.cwd(), encoding: "utf8", timeout: 5_000, input: `${JSON.stringify(request)}\n`,
    env: { ...gatewayEnvironment(binding), AGENTSPINE_STATE_DIR: item.state }
  });
  assert.equal(child.status, 0, child.stderr);
  const response = JSON.parse(child.stdout.trim());
  assert.equal(response.result.isError, false, response.result.content[0].text);
  return JSON.parse(response.result.content[0].text);
}

test("authenticated portal threads resume only their own task knowledge across lifecycle boundaries", async (t) => {
  const item = await fixture(t);
  const routeA = route("thread:work");
  const routeB = route("thread:other");
  const sourceBefore = await readFile(join(item.project, "AGENTS.md"));

  await recordWorldAssertion(assertion(item.legacy, "assertion:legacy-a", continuation("checksum")));
  await recordWorldAssertion(assertion(item.legacy, "assertion:legacy-b", continuation("release"), {
    observedAt: "2026-09-07T02:01:00.000Z"
  }));
  const before = await worldContext({ root: item.legacy, projectId: PROJECT, includePrivate: true,
    continuationTaskId: TASK, now: NOW });
  assert.equal(before.knowledge.continuation.tasks.length, 0);
  assert.equal(before.uncertainty.conflicts, 1,
    "Before: the same task in two unbound threads becomes an unusable conflict");

  const callA = mcpClient(gatewayEnvironment(routeA));
  const callB = mcpClient(gatewayEnvironment(routeB));
  const completedB = continuation("unused", "completed");
  const [checkpointA] = await Promise.all([
    writeThroughGateway(callA, assertion(item.project, "assertion:route-a", continuation("checksum"))),
    writeThroughGateway(callB, assertion(item.project, "assertion:route-b", completedB, {
      evidenceId: completedB.lastVerifiedStep.evidenceId,
      evidenceDigest: completedB.lastVerifiedStep.evidenceDigest,
      observedAt: completedB.lastVerifiedStep.observedAt,
      sessionRef: completedB.lastVerifiedStep.sessionRef,
      messageRef: completedB.lastVerifiedStep.messageRef
    }))
  ]);
  const oldDecisionA = await writeThroughGateway(callA, decision(item.project,
    "assertion:decision-a-old", "Run the portal backup release verification."));
  await writeThroughGateway(callB, decision(item.project,
    "assertion:decision-b", "Do not reuse the foreign completed thread."));
  await writeThroughGateway(callA, decision(item.project,
    "assertion:decision-a-new", "Run the portal backup checksum verification.", {
      observedAt: "2026-09-07T02:20:00.000Z", supersedes: [oldDecisionA.id]
    }));

  assert.equal(checkpointA.portalRef, routeA.portalRef);
  assert.equal(checkpointA.threadRef, routeA.threadRef);
  const contextA = (await callA("world_context", {
    root: item.project, projectId: PROJECT, includePrivate: true, now: NOW
  })).value;
  assert.equal(contextA.knowledge.continuation.tasks.length, 1);
  assert.equal(contextA.knowledge.continuation.tasks[0].nextStep.id, "step:checksum");
  assert.equal(contextA.knowledge.continuation.tasks[0].scope.threadRef, routeA.threadRef);
  assert.deepEqual(contextA.knowledge.taskContext.items.map((entry) => entry.id),
    ["assertion:decision-a-new"]);
  assert.doesNotMatch(JSON.stringify(contextA), /decision-b|foreign completed|thread:other/);
  const mcpBriefing = (await callA("session_briefing", {
    root: item.project, cwd: item.project, includePrivate: true,
    includeSourceContent: false, maxBytes: 8_192, now: NOW
  })).value;
  assert.equal(mcpBriefing.focus.currentTaskId, TASK,
    "the authenticated gateway task is used without a model-provided task claim");
  assert.equal(mcpBriefing.world.knowledge.continuation.tasks[0].nextStep.id, "step:checksum");

  const contextB = (await callB("world_context", {
    root: item.project, projectId: PROJECT, includePrivate: true, now: NOW
  })).value;
  assert.equal(contextB.knowledge.continuation.tasks.length, 0);
  assert.equal(contextB.knowledge.continuation.terminal[0].assertionId, "assertion:route-b");
  assert.doesNotMatch(JSON.stringify(contextB), /route-a|decision-a|checksum verification/);
  const unbound = await worldContext({ root: item.project, projectId: PROJECT, includePrivate: true,
    continuationTaskId: TASK, now: NOW });
  assert.equal(unbound.knowledge.current.length, 0,
    "an unbound reader cannot see gateway-bound private task knowledge");

  const crossRoute = await callB("record_world_assertion", decision(item.project,
    "assertion:cross-route", "Replace another thread.", { supersedes: [oldDecisionA.id] }));
  assert.equal(crossRoute.isError, true);
  assert.match(crossRoute.value.error, /same portal and thread scope/);
  const claimed = await callA("world_context", { root: item.project, projectId: PROJECT,
    includePrivate: true, portalRef: routeB.portalRef, threadRef: routeB.threadRef, now: NOW });
  assert.equal(claimed.isError, true);
  assert.match(claimed.value.error, /authenticated gateway/);
  const claimedBriefing = await callA("session_briefing", { root: item.project,
    portalRef: routeB.portalRef, threadRef: routeB.threadRef, now: NOW });
  assert.equal(claimedBriefing.isError, true);
  assert.match(claimedBriefing.value.error, /unsupported internal source argument/);
  const wrongTask = await callA("world_context", { root: item.project, projectId: PROJECT,
    includePrivate: true, continuationTaskId: "task:other", now: NOW });
  assert.equal(wrongTask.isError, true);
  assert.match(wrongTask.value.error, /authenticated gateway task/);
  await assert.rejects(worldContext({ root: item.project, projectId: PROJECT,
    portalRef: routeA.portalRef, continuationTaskId: TASK, now: NOW }), /provided together/);

  setGateway(routeA);
  const lifecycle = {
    host: "claude", cwd: item.project, session_id: "session:portal-world", timestamp: NOW,
    entity_id: "agent:portal-world", user_id: "person:portal-world",
    tenant_id: "tenant:portal-world", project_id: PROJECT, task_id: TASK
  };
  const startedAt = performance.now();
  const started = await runHook({ hook_event_name: "SessionStart", ...lifecycle });
  const elapsedMs = performance.now() - startedAt;
  const contextBytes = Buffer.byteLength(started.context);
  assert.equal(started.blocked, false, started.reason);
  assert.ok(contextBytes <= 9_500, `portal briefing exceeded its context budget: ${contextBytes}`);
  assert.equal(started.briefing.world.knowledge.continuation.tasks[0].nextStep.id, "step:checksum");
  assert.equal(started.briefing.world.knowledge.taskContext.items[0].id, "assertion:decision-a-new");
  assert.equal(started.briefing.scope.threadRef, routeA.threadRef);
  const compacted = await runHook({ hook_event_name: "PostCompact", ...lifecycle });
  assert.equal(compacted.blocked, false, compacted.reason);
  assert.equal(compacted.briefing.world.knowledge.continuation.tasks[0].nextStep.id, "step:checksum");

  const restarted = freshMcpContext(item, routeA);
  assert.equal(restarted.knowledge.continuation.tasks[0].nextStep.id, "step:checksum");
  assert.equal(restarted.knowledge.taskContext.items[0].id, "assertion:decision-a-new");

  const portableValue = { strategy: "Keep a measured backup before replacing generated files." };
  const portable = await writeThroughGateway(callA, {
    root: item.project, id: "assertion:portable-lesson", subjectId: PROJECT,
    predicate: "lesson.measured-backup", value: portableValue,
    evidenceKind: "objective-measurement", evidenceId: "measurement:portable-lesson",
    evidenceDigest: digest(portableValue), observedAt: "2026-09-07T02:30:00.000Z",
    projectId: PROJECT, privacy: "shared", knowledgeKind: "error-lesson",
    sessionRef: SESSION_REF, messageRef: "timeline-event:portable-lesson"
  });
  assert.equal(portable.portalRef, undefined,
    "project-level measured lessons remain deliberately portable across threads");
  const portableInB = (await callB("world_context", {
    root: item.project, projectId: PROJECT, includePrivate: true, now: NOW
  })).value.knowledge.current.find((entry) => entry.id === portable.id);
  assert.equal(portableInB.value.strategy, portableValue.strategy);
  assert.deepEqual(await readFile(join(item.project, "AGENTS.md")), sourceBefore);
  assert.deepEqual(sourceBefore, item.source);
  t.diagnostic(JSON.stringify({ beforeCorrectContinuations: 0, afterCorrectContinuations: 1,
    beforeUnnecessaryQuestions: 1, afterUnnecessaryQuestions: 0,
    repeatedErrors: 0, contextBytes, elapsedMs,
    tokens: null, realModelRuns: 0 }));
});

test("damaged route-bound knowledge stays advisory outside the current answer path", async (t) => {
  const item = await fixture(t);
  const routeA = route("thread:work");
  const callA = mcpClient(gatewayEnvironment(routeA));
  await writeThroughGateway(callA, assertion(item.project,
    "assertion:damage-probe", continuation("checksum")));
  const statePath = await worldModelStatePath(item.project);
  const state = JSON.parse(await readFile(statePath, "utf8"));
  state.assertions[0].threadRef = "thread-ref:tampered";
  await writeFile(statePath, `${JSON.stringify(state)}\n`);
  setGateway(routeA);
  const result = await runHook({
    hook_event_name: "PostCompact", host: "claude", cwd: item.project,
    session_id: "session:damaged-world", timestamp: NOW,
    entity_id: "agent:portal-world", user_id: "person:portal-world",
    tenant_id: "tenant:portal-world", project_id: PROJECT, task_id: TASK
  });
  assert.equal(result.blocked, false, "a memory service failure must not block ordinary host work");
  assert.equal(result.failedClosed, true);
  assert.match(result.error, /world model state is invalid/);
  assert.deepEqual(await readFile(join(item.project, "AGENTS.md")), item.source);
});
