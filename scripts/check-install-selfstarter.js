import { pathToFileURL } from "node:url";
import { join } from "node:path";

const PREMORTEM_ITEMS = [
  {
    category: "baseline-environment",
    failure: "this delivery fails because the installed synthetic baseline is stale",
    check: "Compare the installed synthetic project and state roots."
  },
  {
    category: "contract-tests",
    failure: "this delivery fails because the installed hook contract regresses",
    check: "Run the installed hook lifecycle check."
  },
  {
    category: "delivery-path",
    failure: "this delivery fails because the installed artifact path is wrong",
    check: "Verify the installed synthetic artifact path."
  }
];

async function withStateRoot(stateRoot, action) {
  const previous = process.env.AGENTSPINE_STATE_DIR;
  process.env.AGENTSPINE_STATE_DIR = stateRoot;
  try {
    return await action();
  } finally {
    if (previous === undefined) delete process.env.AGENTSPINE_STATE_DIR;
    else process.env.AGENTSPINE_STATE_DIR = previous;
  }
}

async function prepareRuntime(pluginRoot, projectRoot, stateRoot, host) {
  await withStateRoot(stateRoot, async () => {
    const graph = await import(pathToFileURL(join(pluginRoot, "src/lib/graph.js")).href);
    const coordination = await import(pathToFileURL(join(pluginRoot, "src/lib/coordination.js")).href);
    const selfstarter = await import(pathToFileURL(join(pluginRoot, "src/lib/selfstarter.js")).href);
    for (const [id, kind] of [
      ["person:install-owner", "person"],
      ["agent:install-worker", "agent"],
      ["project:install-runtime", "project"]
    ]) await graph.upsertEntity({ root: projectRoot, id, kind, privacy: "shared" });
    await coordination.createTask({
      root: projectRoot,
      id: `task:install-${host}`,
      actorId: "agent:install-worker",
      assigneeId: "agent:install-worker",
      projectId: "project:install-runtime",
      title: `Installed ${host} self-starter check`,
      privacy: "private"
    });
    await selfstarter.grantExecution({
      root: projectRoot,
      id: `execution-grant:install-${host}`,
      jobId: `job:install-${host}`,
      actorId: "agent:install-worker",
      taskId: `task:install-${host}`,
      targetId: "person:install-owner",
      projectId: "project:install-runtime",
      host,
      capabilities: ["tool:Write"],
      reason: `Owner approved the exact installed ${host} synthetic write.`,
      confirmation: "local-owner-confirmed"
    });
    await selfstarter.registerJob({
      root: projectRoot,
      id: `job:install-${host}`,
      grantId: `execution-grant:install-${host}`,
      confirmation: "local-owner-confirmed"
    });
  });
}

async function registerPremortem(pluginRoot, projectRoot, stateRoot, requirementId) {
  if (!/^premortem-requirement:[a-f0-9]{64}:[a-f0-9]{64}$/.test(requirementId || "")) {
    throw new Error("installed UserPromptSubmit did not inject an exact premortem requirement");
  }
  return withStateRoot(stateRoot, async () => {
    const premortem = await import(pathToFileURL(join(pluginRoot,
      "src/lib/delivery-premortem.js")).href);
    const usage = await import(pathToFileURL(join(pluginRoot,
      "src/lib/delivery-agent-usage.js")).href);
    await usage.recordDeliveryBriefingUse({ root: projectRoot, requirementId,
      input: { root: projectRoot }, result: { schema: "synthetic-installed-briefing" } });
    await usage.recordDeliveryKnowledgeUse({ root: projectRoot, requirementId,
      input: { targets: ["AGENTS.md"] }, result: { schema: "synthetic-installed-knowledge" } });
    const recorded = await premortem.recordDeliveryPremortem({
      root: projectRoot,
      requirementId,
      items: PREMORTEM_ITEMS
    });
    if (recorded.blocked) throw new Error(`installed premortem registration failed: ${recorded.reason}`);
  });
}

export async function invokeInstalledSelfstarter({
  pluginRoot, projectRoot, stateRoot, host, invokeInstalledHook, writeFile
}) {
  await prepareRuntime(pluginRoot, projectRoot, stateRoot, host);
  const session = `session:install-${host}-one`;
  const nextSession = `session:install-${host}-two`;
  const toolUseId = `tool:install-${host}`;
  const taskId = `task:install-${host}`;
  const artifact = join(projectRoot, `installed-${host}-artifact.txt`);
  const toolInput = { file_path: artifact, content: `installed ${host} checkpoint\n` };
  const shared = {
    cwd: projectRoot,
    host,
    entity_id: "agent:install-worker",
    project_id: "project:install-runtime",
    task_id: taskId
  };
  const started = await invokeInstalledHook(pluginRoot, projectRoot, stateRoot, host, {
    ...shared, hook_event_name: "SessionStart", session_id: session
  });
  if (!started.selfstarter?.active || started.selfstarter.action !== "start") {
    throw new Error(`${host} installed hook did not start the exact authorized job`);
  }
  const prompted = await invokeInstalledHook(pluginRoot, projectRoot, stateRoot, host, {
    ...shared, hook_event_name: "UserPromptSubmit", session_id: session,
    event_id: `prompt:install-${host}`, prompt: "Write the installed synthetic checkpoint."
  });
  await registerPremortem(pluginRoot, projectRoot, stateRoot,
    prompted.preflight?.premortem?.requirementId);
  const authorized = await invokeInstalledHook(pluginRoot, projectRoot, stateRoot, host, {
    ...shared, hook_event_name: "PreToolUse", session_id: session,
    tool_name: "Write", tool_use_id: toolUseId, tool_input: toolInput
  }, { requireBriefing: false });
  if (authorized.decision === "block") {
    throw new Error(`${host} installed PreToolUse denied the exact authorized effect: ${authorized.reason}`);
  }
  await writeFile(artifact, toolInput.content, "utf8");
  await invokeInstalledHook(pluginRoot, projectRoot, stateRoot, host, {
    ...shared, hook_event_name: "PostToolUse", session_id: session,
    tool_name: "Write", tool_use_id: toolUseId, tool_input: toolInput,
    success: true, tool_result: { ok: true }
  }, { requireBriefing: false });
  await invokeInstalledHook(pluginRoot, projectRoot, stateRoot, host, {
    ...shared, hook_event_name: "Stop", session_id: session
  }, { requireBriefing: false });
  const resumed = await invokeInstalledHook(pluginRoot, projectRoot, stateRoot, host, {
    ...shared, hook_event_name: "SessionStart", session_id: nextSession
  });
  if (!resumed.selfstarter?.active || resumed.selfstarter.action !== "resume"
    || resumed.selfstarter.checkpointSequence !== 1) {
    throw new Error(`${host} installed hook did not resume the durable checkpoint`);
  }
  return {
    started: started.selfstarter.action,
    resumed: resumed.selfstarter.action,
    checkpointSequence: resumed.selfstarter.checkpointSequence,
    mcpCalls: 0
  };
}
