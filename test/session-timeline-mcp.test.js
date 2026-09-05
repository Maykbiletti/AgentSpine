import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { runHook } from "../src/hook.js";
import { createTask } from "../src/lib/coordination.js";
import { upsertEntity } from "../src/lib/graph.js";
import { startMcpServer } from "../src/mcp.js";
import {
  authorizeSessionTimelineInvocation, indexSessionTimeline,
  refreshSessionTimelineTail, registerSessionTimelineSource, searchSessionTimeline,
  sessionTimelineLifecycleHint, sessionTimelineStatus
} from "../src/lib/session-timeline.js";
import { sessionTimelineStatePaths } from "../src/lib/session-timeline-auth.js";
import { boundTimelineInvocation, enrollTimelineWithHostReceipt } from "./session-timeline-invocation-support.js";

function hash(value) { return createHash("sha256").update(value).digest("hex"); }

function client() {
  const input = new PassThrough();
  const output = new PassThrough();
  output.setEncoding("utf8");
  let id = 0;
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
  startMcpServer(input, output);
  return (name, args) => new Promise((resolve, reject) => {
    const requestId = ++id;
    const timer = setTimeout(() => reject(new Error(`MCP ${name} timeout`)), 2_000);
    pending.set(requestId, (value) => { clearTimeout(timer); resolve(value); });
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: requestId,
      method: "tools/call", params: { name, arguments: args } })}\n`);
  });
}

function result(response) {
  assert.equal(response.isError, false);
  return JSON.parse(response.content[0].text);
}

function scope(overrides = {}) {
  return {
    entityId: "agent:synthetic", userId: "person:synthetic", tenantId: "tenant:synthetic",
    projectId: "project:timeline", currentTaskId: "task:css-archive", goalId: "goal:f79",
    goalStepId: "step:measure", groupId: null, timelineVisibility: "private-verified", ...overrides
  };
}

function mcpScope(overrides = {}) {
  const value = scope(overrides);
  return {
    entityId: value.entityId, userId: value.userId, tenantId: value.tenantId, projectId: value.projectId,
    taskId: value.currentTaskId, goalId: value.goalId, goalStepId: value.goalStepId
  };
}

async function fixture(t) {
  const workspace = await mkdtemp(join(tmpdir(), "agentspine-session-timeline-mcp-"));
  const state = join(workspace, "state");
  const profile = join(workspace, "profile");
  const project = join(workspace, "project");
  const session = join(profile, "projects", "timeline-project", "session.jsonl");
  await Promise.all([
    mkdir(state), mkdir(join(project, ".git"), { recursive: true }),
    mkdir(join(profile, "projects", "timeline-project"), { recursive: true })
  ]);
  await Promise.all([
    writeFile(join(project, "AGENTS.md"), "# Synthetic project\n"),
    writeFile(session, `${[
      { timestamp: "2026-09-04T12:38:00.000Z", message: { role: "user", content: "I claim Suite 0 PASS." } },
      { timestamp: "2026-09-04T12:39:00.000Z", message: { role: "user", content: "openai_api_key=sk-proj-synthetic-secret-value-1234567890; slack=xoxb-synthetic-secret-value-1234567890." } },
      { timestamp: "2026-09-04T12:40:11.000Z", message: { role: "tool", content: "Measured CSS archive Suite 0; result: PASS 15/15." } },
      { timestamp: "2026-09-04T12:42:00.000Z", message: { role: "tool", content: "Measured unrelated latency; result: FAIL 0/1." } }
    ].map((line) => JSON.stringify(line)).join("\n")}\n`)
  ]);
  const names = ["AGENTSPINE_STATE_DIR", "CLAUDE_CONFIG_DIR", "AGENTSPINE_TIMELINE_SESSION_CAPABILITY", "AGENTSPINE_TIMELINE_TRANSPORT_SESSION_ID"];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  process.env.AGENTSPINE_STATE_DIR = state;
  process.env.CLAUDE_CONFIG_DIR = profile;
  process.env.AGENTSPINE_TIMELINE_SESSION_CAPABILITY = `astc_${randomBytes(32).toString("base64url")}`;
  process.env.AGENTSPINE_TIMELINE_TRANSPORT_SESSION_ID = "session:timeline";
  await upsertEntity({ root: project, id: "agent:synthetic", kind: "agent", privacy: "private" });
  await upsertEntity({ root: project, id: "project:timeline", kind: "project", privacy: "private" });
  await createTask({ root: project, id: "task:css-archive", actorId: "agent:synthetic",
    assigneeId: "agent:synthetic", projectId: "project:timeline", title: "Synthetic CSS archive" });
  t.after(async () => {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
    await rm(workspace, { recursive: true, force: true, maxRetries: 3 });
  });
  return { workspace, state, profile, project, session };
}

async function enrollAndRegister({ project, profile, session }, scoped = scope(), sessionId = "session:timeline") {
  const enrolled = await enrollTimelineWithHostReceipt({
    root: project, sessionId, scope: scoped, transcriptPath: session, hostHome: profile
  });
  assert.equal(enrolled.status, "enrolled");
  return enrolled;
}

async function directPermit({ project, profile }, tool, fields, toolUseId, sessionId = "session:timeline") {
  const permit = await boundTimelineInvocation({
    root: project, sessionId, hostHome: profile, tool, fields, toolUseId
  });
  assert.ok(permit, `expected ${tool} invocation permit`);
  return permit;
}

async function directIndex(item, scoped, toolUseId = "tool:direct:index") {
  const fields = { maxBytes: 65_536 };
  const permit = await directPermit(item, "index", fields, toolUseId);
  return indexSessionTimeline({
    root: item.project, host: "claude", sessionId: "session:timeline", scope: scoped, ...fields,
    hostHome: item.profile, invocationRequest: permit.invocationRequest,
    transportDigest: permit.transportDigest, enrollmentDigest: permit.enrollmentDigest
  });
}

test("compaction creates bounded redacted evidence that a host-bound MCP permit can retrieve", async (t) => {
  const item = await fixture(t);
  await enrollAndRegister(item);
  const before = hash(await readFile(item.session));
  const call = client();
  const raw = result(await call("session_timeline_search", {
    root: item.project, sessionId: "session:timeline", ...mcpScope(),
    at: "2026-09-04T12:40:00.000Z", query: "Suite PASS"
  }));
  assert.equal(raw.blocked, true, "a direct MCP query has no host invocation permit");

  const preCompact = await runHook({ hook_event_name: "PreCompact", host: "claude", cwd: item.project,
    transcript_path: item.session, session_id: "session:timeline", ...scope() });
  assert.equal(preCompact.failedClosed, undefined, preCompact.error || preCompact.reason);
  const compacted = JSON.parse(preCompact.context).sourceResolution.timeline;
  assert.equal(compacted.status, "partial");
  assert.equal(compacted.freshness, "source-not-read");
  assert.equal(compacted.continuation.goalStepId, "step:measure");
  assert.equal(compacted.continuation.outcomeStatus, "awaiting-objective-outcome");
  assert.equal("accessProof" in compacted, false);

  const indexArgs = await guardedArgs(item, "session_timeline_index", { root: item.project, maxBytes: 65_536 }, "tool:mcp:index");
  assert.equal(result(await call("session_timeline_index", indexArgs)).status, "indexed");
  const searchArgs = await guardedArgs(item, "session_timeline_search", {
    root: item.project, at: "2026-09-04T12:40:11.000Z", query: "Suite PASS", windowSeconds: 0
  }, "tool:mcp:search");
  const found = result(await call("session_timeline_search", searchArgs));
  assert.equal(found.status, "found");
  assert.equal(found.events.length, 1);
  assert.equal(found.events[0].outcome, "pass");
  assert.deepEqual(found.events[0].count, { value: 15, total: 15 });
  assert.equal(found.events[0].testLabel, "suite-0");
  assert.match(found.events[0].roomId, /^room:[a-f0-9]{24}:1$/);
  assert.equal(found.events[0].authority, "context-only");
  assert.equal(found.events[0].trust, "untrusted-session-history");
  assert.equal("summary" in found.events[0], false);
  assert.equal("offset" in found.events[0], false);
  assert.equal("bytes" in found.events[0], false);

  const postCompact = await runHook({ hook_event_name: "PostCompact", host: "claude", cwd: item.project,
    session_id: "session:timeline", ...scope() });
  assert.equal(postCompact.failedClosed, undefined, postCompact.error || postCompact.reason);
  const postTimeline = JSON.parse(postCompact.context).sourceResolution.timeline;
  assert.equal(postTimeline.status, "indexed");
  assert.equal(postTimeline.freshness, "source-not-read");
  assert.equal((await sessionTimelineStatus({ root: item.project, host: "claude", sessionId: "session:timeline", scope: scope() })).status, "indexed");
  const sidecar = await readFile((await sessionTimelineStatePaths(item.project)).path, "utf8");
  assert.doesNotMatch(sidecar, /synthetic-secret|sk-proj-|xoxb-|I claim Suite/);
  assert.equal(hash(await readFile(item.session)), before, "all capture and recall paths preserve transcript bytes");
  assert.equal(await readFile(join(item.project, "AGENTS.md"), "utf8"), "# Synthetic project\n");
});

test("receipt-backed bootstrap lets MCP index without a lifecycle registration read", async (t) => {
  const item = await fixture(t);
  const before = hash(await readFile(item.session));
  await enrollAndRegister(item);
  const statePath = (await sessionTimelineStatePaths(item.project)).path;
  const beforeIndex = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(beforeIndex.sources[0].indexedBytes, 0);
  assert.deepEqual(beforeIndex.sources[0].events, []);
  assert.doesNotMatch(JSON.stringify(beforeIndex), /Suite 0; result: PASS/);

  const call = client();
  const args = await guardedArgs(item, "session_timeline_index", { root: item.project, maxBytes: 65_536 }, "tool:bootstrap:index");
  const indexed = result(await call("session_timeline_index", args));
  assert.equal(indexed.status, "indexed");
  assert.equal(indexed.added, 2);
  assert.equal(hash(await readFile(item.session)), before, "bootstrap and index preserve host source bytes");
});

test("timestamp-only recall is exact unless the caller explicitly requests a bounded window", async (t) => {
  const item = await fixture(t);
  const scoped = scope();
  await enrollAndRegister(item, scoped);
  assert.equal((await directIndex(item, scoped, "tool:exact:index")).status, "indexed");

  const exactPermit = await directPermit(item, "search", {
    at: "2026-09-04T12:40:11.000Z"
  }, "tool:exact:timestamp");
  assert.equal(exactPermit.invocationRequest.windowSeconds, 0);
  const exact = await searchSessionTimeline({
    root: item.project, host: "claude", sessionId: "session:timeline", scope: scoped,
    at: "2026-09-04T12:40:11.000Z", hostHome: item.profile,
    invocationRequest: exactPermit.invocationRequest, transportDigest: exactPermit.transportDigest,
    enrollmentDigest: exactPermit.enrollmentDigest
  });
  assert.equal(exact.status, "found");
  assert.deepEqual(exact.events.map((event) => event.at), ["2026-09-04T12:40:11.000Z"]);

  const rangedPermit = await directPermit(item, "search", {
    at: "2026-09-04T12:40:11.000Z", windowSeconds: 120
  }, "tool:exact:range");
  const ranged = await searchSessionTimeline({
    root: item.project, host: "claude", sessionId: "session:timeline", scope: scoped,
    at: "2026-09-04T12:40:11.000Z", windowSeconds: 120, hostHome: item.profile,
    invocationRequest: rangedPermit.invocationRequest, transportDigest: rangedPermit.transportDigest,
    enrollmentDigest: rangedPermit.enrollmentDigest
  });
  assert.equal(ranged.status, "found");
  assert.deepEqual(ranged.events.map((event) => event.at), [
    "2026-09-04T12:40:11.000Z", "2026-09-04T12:42:00.000Z"
  ]);
});

test("raw API and MCP claims cannot bypass enrollment, scope binding, group isolation, or immutable snapshots", async (t) => {
  const item = await fixture(t);
  const scoped = scope();
  const before = hash(await readFile(item.session));
  const beforeEnrollment = await registerSessionTimelineSource({
    root: item.project, host: "claude", hostHome: item.profile,
    input: { transcript_path: item.session, session_id: "session:timeline" }, scope: scoped
  });
  assert.equal(beforeEnrollment.status, "unavailable", "raw source registration has no transcript route");
  assert.equal(beforeEnrollment.reason, "timeline-enrollment-bootstrap-required");
  assert.equal(hash(await readFile(item.session)), before, "raw registration never reads or mutates the transcript");
  await enrollAndRegister(item, scoped);
  const afterEnrollment = await registerSessionTimelineSource({
    root: item.project, host: "claude", hostHome: item.profile,
    input: { transcript_path: item.session, session_id: "session:timeline" }, scope: scoped
  });
  assert.equal(afterEnrollment.status, "unavailable", "enrollment cannot re-enable a raw source route");
  assert.equal(afterEnrollment.reason, "timeline-enrollment-bootstrap-required");
  const rawRefresh = await refreshSessionTimelineTail({
    root: item.project, host: "claude", hostHome: item.profile,
    input: { transcript_path: item.session, session_id: "session:timeline" }, scope: scoped
  });
  assert.equal(rawRefresh.status, "unavailable");
  assert.equal(rawRefresh.reason, "timeline-mcp-index-required");
  assert.equal(hash(await readFile(item.session)), before, "raw registration remains source-blind after enrollment");
  const call = client();
  const rawProof = result(await call("session_timeline_search", {
    root: item.project, sessionId: "session:timeline", ...mcpScope(), accessProof: `aspt_${"x".repeat(80)}.${"y".repeat(43)}`,
    at: "2026-09-04T12:40:11.000Z", query: "Suite PASS"
  }));
  assert.equal(rawProof.blocked, true);
  assert.equal(rawProof.events, undefined);
  const rawIndex = await indexSessionTimeline({
    root: item.project, host: "claude", sessionId: "session:timeline", scope: scoped, maxBytes: 65_536
  });
  assert.equal(rawIndex.reason, "timeline-invocation-unavailable");
  const rawSearch = await searchSessionTimeline({
    root: item.project, host: "claude", sessionId: "session:timeline", scope: scoped,
    at: "2026-09-04T12:40:11.000Z", query: "Suite PASS"
  });
  assert.equal(rawSearch.blocked, true);
  assert.equal(rawSearch.events, undefined);

  const grouped = result(await call("session_timeline_search", {
    root: item.project, sessionId: "session:timeline", ...mcpScope(), groupId: "group:synthetic",
    at: "2026-09-04T12:40:11.000Z", query: "Suite PASS"
  }));
  assert.equal(grouped.reason, "timeline-group-suppressed");
  const foreignGuard = await runHook({ hook_event_name: "PreToolUse", host: "claude", cwd: item.project,
    transcript_path: item.session, session_id: "session:timeline", tool_use_id: "tool:foreign",
    tool_name: "mcp__plugin_agent-spine_agent-spine__session_timeline_search",
    tool_input: { root: item.project, at: "2026-09-04T12:40:11.000Z", query: "Suite PASS" },
    ...scope({ entityId: "agent:foreign" }) });
  assert.equal(foreignGuard.blocked, true);

  const staleArgs = await guardedArgs(item, "session_timeline_search", {
    root: item.project, at: "2026-09-04T12:40:11.000Z", query: "Suite PASS", windowSeconds: 0
  }, "tool:stale");
  await writeFile(item.session, `${await readFile(item.session, "utf8")}${JSON.stringify({
    timestamp: "2026-09-04T12:43:00.000Z", message: { role: "tool", content: "Measured renewal Suite; result: PASS 1/1." }
  })}\n`);
  const stale = result(await call("session_timeline_search", staleArgs));
  assert.equal(stale.blocked, true);
  assert.equal(stale.events, undefined);
  const renewal = await enrollAndRegister(item, scoped);
  assert.equal(renewal.status, "enrolled");
  assert.equal((await directIndex(item, scoped, "tool:renewal:index")).status, "indexed");
  const renewed = await directPermit(item, "search", {
    at: "2026-09-04T12:43:00.000Z", query: "Measurement PASS", windowSeconds: 0
  }, "tool:renewal:search");
  const found = await searchSessionTimeline({
    root: item.project, host: "claude", sessionId: "session:timeline", scope: scoped, hostHome: item.profile,
    at: "2026-09-04T12:43:00.000Z", query: "Measurement PASS", windowSeconds: 0,
    invocationRequest: renewed.invocationRequest, transportDigest: renewed.transportDigest,
    enrollmentDigest: renewed.enrollmentDigest
  });
  assert.equal(found.status, "found");
});

test("timeline core requires an explicit private group binding before every entrypoint", async (t) => {
  const item = await fixture(t);
  await enrollAndRegister(item);
  const input = { transcript_path: item.session, session_id: "session:timeline" };
  for (const [label, groupId] of [["absent", undefined], ["empty", ""], ["foreign", "group:synthetic"]]) {
    const scoped = scope({ groupId });
    const registration = await registerSessionTimelineSource({
      root: item.project, host: "claude", hostHome: item.profile, input, scope: scoped
    });
    assert.equal(registration.status, "unavailable", label);
    assert.equal(registration.reason, "timeline-enrollment-bootstrap-required", label);
    const current = await sessionTimelineStatus({
      root: item.project, host: "claude", sessionId: "session:timeline", hostHome: item.profile, scope: scoped
    });
    assert.equal(current.status, "group-suppressed", label);
    assert.equal("sourceDigest" in current, false, label);
    const indexed = await indexSessionTimeline({
      root: item.project, host: "claude", sessionId: "session:timeline", scope: scoped, maxBytes: 65_536
    });
    assert.equal(indexed.status, "group-suppressed", label);
    const lifecycle = await sessionTimelineLifecycleHint({
      root: item.project, host: "claude", sessionId: "session:timeline", scope: scoped
    });
    assert.equal(lifecycle.status, "group-suppressed", label);
    assert.equal("sourceDigest" in lifecycle, false, label);
    const authorized = await authorizeSessionTimelineInvocation({
      root: item.project, host: "claude", sessionId: "session:timeline", scope: scoped, tool: "search"
    });
    assert.equal(authorized, null, label);
    const searched = await searchSessionTimeline({
      root: item.project, host: "claude", sessionId: "session:timeline", scope: scoped,
      at: "2026-09-04T12:40:11.000Z"
    });
    assert.equal(searched.blocked, true, label);
    assert.equal(searched.events, undefined, label);
  }
});

test("one-use direct invocation permits serialize bounded indexing and fail closed on a tampered sidecar", async (t) => {
  const item = await fixture(t);
  const scoped = scope();
  const before = hash(await readFile(item.session));
  await enrollAndRegister(item, scoped);
  const permits = await Promise.all(Array.from({ length: 8 }, (_, index) => directPermit(item, "index", {
    maxBytes: 65_536
  }, `tool:parallel:${index}`)));
  const outcomes = await Promise.all(permits.map((permit) => indexSessionTimeline({
    root: item.project, host: "claude", sessionId: "session:timeline", scope: scoped, maxBytes: 65_536,
    hostHome: item.profile, invocationRequest: permit.invocationRequest, transportDigest: permit.transportDigest,
    enrollmentDigest: permit.enrollmentDigest
  })));
  assert.equal(outcomes.every((entry) => ["indexed", "partial"].includes(entry.status)), true);
  const status = await sessionTimelineStatus({
    root: item.project, host: "claude", sessionId: "session:timeline", scope: scoped, hostHome: item.profile
  });
  assert.equal(status.status, "indexed");
  assert.equal(status.events, 2);
  assert.equal(new Set(status.continuation.roomIds).size, status.continuation.roomIds.length);
  const statePath = (await sessionTimelineStatePaths(item.project)).path;
  const state = JSON.parse(await readFile(statePath, "utf8"));
  state.sources[0].events = [];
  await writeFile(statePath, `${JSON.stringify(state)}\n`);
  const blockedPermit = await directPermit(item, "search", {
    at: "2026-09-04T12:40:11.000Z", query: "Suite PASS", windowSeconds: 0
  }, "tool:tampered:search").catch(() => null);
  assert.equal(blockedPermit, null, "a tampered index cannot issue a direct retrieval permit");
  assert.equal(hash(await readFile(item.session)), before);
});

async function guardedArgs(item, name, args, toolUseId) {
  const guarded = await runHook({ hook_event_name: "PreToolUse", host: "claude", cwd: item.project,
    transcript_path: item.session, session_id: "session:timeline", tool_use_id: toolUseId,
    tool_name: `mcp__plugin_agent-spine_agent-spine__${name}`, tool_input: args, ...scope() });
  assert.equal(guarded.blocked, false, guarded.reason);
  assert.equal("accessProof" in guarded.updatedInput, false);
  assert.equal("transportDigest" in guarded.updatedInput, false);
  return guarded.updatedInput;
}
