#!/usr/bin/env node
import { createHash, createHmac } from "node:crypto";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkHosts } from "./check-hosts.js";

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function copyFilter(source) {
  const name = basename(source);
  return !new Set([".git", "node_modules"]).has(name) && !name.endsWith(".tgz");
}

async function copyBundle(source, target) {
  await cp(source, target, { recursive: true, filter: copyFilter });
}

async function removeTree(path, options = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rm(path, { recursive: true, ...options });
      return;
    } catch (error) {
      const transient = process.platform === "win32" && ["EACCES", "EBUSY", "EPERM"].includes(error?.code);
      if (!transient || attempt >= 7) throw error;
      await delay(10 * (attempt + 1));
    }
  }
}

async function makePreviousCache(target) {
  for (const path of ["package.json", ".claude-plugin/plugin.json", ".codex-plugin/plugin.json"]) {
    const file = join(target, path);
    const value = JSON.parse(await readFile(file, "utf8"));
    value.version = "0.8.0";
    await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  }
  const marketplacePath = join(target, ".claude-plugin/marketplace.json");
  const marketplace = JSON.parse(await readFile(marketplacePath, "utf8"));
  marketplace.plugins[0].version = "0.8.0";
  await writeFile(marketplacePath, `${JSON.stringify(marketplace, null, 2)}\n`, "utf8");
  const hookVersionPath = join(target, "hooks/version.json");
  const hookVersion = JSON.parse(await readFile(hookVersionPath, "utf8"));
  hookVersion.version = "0.8.0";
  await writeFile(hookVersionPath, `${JSON.stringify(hookVersion, null, 2)}\n`, "utf8");
}

async function invokeInstalledHook(pluginRoot, projectRoot, stateRoot, host, payload = null, { requireBriefing = true, extraEnv = {} } = {}) {
  return await new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [join(pluginRoot, "src/hook.js")], {
      cwd: projectRoot,
      env: {
        ...process.env,
        AGENTSPINE_HOST: host,
        AGENTSPINE_STATE_DIR: stateRoot,
        CLAUDE_PLUGIN_ROOT: pluginRoot,
        PLUGIN_ROOT: pluginRoot,
        ...extraEnv
      },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${host} installed hook timed out`));
    }, 5000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`${host} installed hook exited with ${code}: ${stderr.slice(0, 2048)}`));
      try {
        const protocol = JSON.parse(stdout.trim());
        const context = JSON.parse(protocol.hookSpecificOutput?.additionalContext || "null");
        if (requireBriefing && (context?.briefing?.host !== host || !Array.isArray(context?.briefing?.sources?.documents))) {
          throw new Error(`${host} installed hook did not inject a real session briefing: ${protocol.reason || context?.error || context?.sourceResolution?.reason || "missing context"}`);
        }
        resolveResult({
          event: protocol.hookSpecificOutput?.hookEventName || payload?.hook_event_name || null, host,
          sources: context?.briefing?.sources?.documents?.length ?? null,
          sourceIds: context?.briefing?.sources?.documents?.map((item) => item.path) || [],
          sourceContents: context?.briefing?.sources?.documents?.map((item) => item.content).filter(Boolean) || [],
          sourceResolution: context?.sourceResolution || null,
          learningClaims: context?.briefing?.learning?.map((item) => item.claim) || [],
          attentionKinds: context?.briefing?.attention?.items?.map((item) => item.kind) || [],
          capturedAttentionKind: context?.attentionEvent?.kind || null,
          selfstarter: context?.selfstarter || null,
          channelEvent: context?.channelEvent || null,
          voiceBrief: context?.briefing?.voiceBrief || null,
          preflight: context?.preflight || null,
          decision: protocol.decision || null,
          reason: protocol.reason || null
        });
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(`${JSON.stringify(payload || { hook_event_name: "SessionStart", cwd: projectRoot, host })}\n`);
  });
}

async function invokeInstalledLiveRoots(pluginRoot, workspace, stateRoot) {
  const home = join(workspace, "live-home");
  const claudeHome = join(home, ".claude-live");
  const codexHome = join(home, ".codex-live");
  const projectA = join(home, "AgentSpine");
  const projectB = join(home, "other-project");
  const nestedB = join(projectB, "api");
  const loose = join(workspace, "foreign-cwd");
  const memory = join(claudeHome, "projects", "project-a", "memory");
  for (const path of [claudeHome, codexHome, projectA, nestedB, loose, memory]) await mkdir(path, { recursive: true });
  await mkdir(join(projectA, ".git"));
  await mkdir(join(projectB, ".git"));
  const protectedSources = new Map([
    [join(claudeHome, "CLAUDE.md"), "# Installed user style\n\nBe calm and humane.\n"],
    [join(projectA, "CLAUDE.md"), "# Installed project A\n"],
    [join(projectB, "CLAUDE.md"), "# Installed project B\n"],
    [join(memory, "MEMORY.md"), "# Installed project A memory\n\n- [Communication style](style.md) <!-- agentspine:always -->\n"],
    [join(memory, "style.md"), "# Installed indexed style\n\nKeep answers calm and direct.\n"],
    [join(memory, "unindexed.md"), "# Installed unindexed private note\n\nThis must never enter the live hook.\n"],
    [join(codexHome, "AGENTS.override.md"), "# Installed Codex user style\n"],
    [join(projectA, "AGENTS.md"), "# Installed Codex A\n"],
    [join(projectB, "TEAM_GUIDE.md"), "# Installed Codex B\n"],
    [join(nestedB, "AGENTS.override.md"), "# Installed Codex API override\n"],
    [join(home, "PRIVATE.md"), "# Never scan this home file\n"]
  ]);
  for (const [path, content] of protectedSources) await writeFile(path, content, "utf8");
  const transcript = join(claudeHome, "projects", "project-a", "session.jsonl");
  await writeFile(transcript, "{}\n", "utf8");
  await writeFile(join(loose, "CLAUDE.md"), "# Installed loose cwd\n", "utf8");
  await writeFile(join(codexHome, "config.toml"), [
    'project_doc_fallback_filenames = ["TEAM_GUIDE.md"]', 'project_root_markers = [".git"]', ""
  ].join("\n"), "utf8");
  const before = new Map(await Promise.all([...protectedSources.keys()].map(async (path) => [path, hash(await readFile(path))])));
  const claudeEnv = { HOME: home, CLAUDE_CONFIG_DIR: claudeHome };
  const codexEnv = { HOME: home, CODEX_HOME: codexHome };
  const claudeA = await invokeInstalledHook(pluginRoot, projectA, stateRoot, "claude", {
    hook_event_name: "SessionStart", host: "claude", cwd: projectA, transcript_path: transcript
  }, { extraEnv: claudeEnv });
  const claudeRestart = await invokeInstalledHook(pluginRoot, projectA, stateRoot, "claude", {
    hook_event_name: "PostCompact", host: "claude", cwd: projectA
  }, { extraEnv: claudeEnv });
  const claudeLoose = await invokeInstalledHook(pluginRoot, loose, stateRoot, "claude", {
    hook_event_name: "SessionStart", host: "claude", cwd: loose
  }, { extraEnv: claudeEnv });
  const codexA = await invokeInstalledHook(pluginRoot, projectA, stateRoot, "codex", {
    hook_event_name: "SessionStart", host: "codex", cwd: projectA
  }, { extraEnv: codexEnv });
  const codexB = await invokeInstalledHook(pluginRoot, nestedB, stateRoot, "codex", {
    hook_event_name: "PostCompact", host: "codex", cwd: nestedB
  }, { extraEnv: codexEnv });
  if (!claudeA.sourceIds.includes("claude:user/CLAUDE.md") || !claudeA.sourceIds.includes("claude:memory/MEMORY.md")
    || !claudeA.sourceIds.includes("claude:memory/style.md") || claudeA.sourceIds.includes("claude:memory/unindexed.md")
    || !claudeRestart.sourceIds.includes("claude:memory/MEMORY.md") || !claudeRestart.sourceIds.includes("claude:memory/style.md")
    || claudeRestart.sourceIds.includes("claude:memory/unindexed.md") || claudeLoose.sourceIds.some((id) => id.startsWith("claude:memory/"))) {
    throw new Error("installed Claude hook did not preserve exact user/project/memory source scope across restart and foreign cwd");
  }
  for (const result of [claudeA, claudeRestart]) {
    const diagnostic = result.sourceResolution?.memory;
    if (diagnostic?.indexed !== 1 || diagnostic.loaded !== 1 || diagnostic.directoryEnumeration !== 0) {
      throw new Error("installed Claude hook did not use bounded indexed-memory resolution");
    }
  }
  if (claudeA.sourceContents.some((content) => content.includes("Never scan this"))
    || claudeLoose.sourceContents.some((content) => content.includes("Installed project A"))) {
    throw new Error("installed Claude hook leaked a broad-home or foreign-project source");
  }
  const codexAIds = codexA.sourceIds.filter((id) => id.startsWith("codex:"));
  const codexBIds = codexB.sourceIds.filter((id) => id.startsWith("codex:"));
  if (JSON.stringify(codexAIds) !== JSON.stringify(["codex:user/AGENTS.override.md", "codex:project/AGENTS.md"])
    || JSON.stringify(codexBIds) !== JSON.stringify(["codex:user/AGENTS.override.md", "codex:project/TEAM_GUIDE.md", "codex:project/api/AGENTS.override.md"])) {
    throw new Error("installed Codex hook did not preserve native override and fallback precedence");
  }
  for (const [path, expected] of before) {
    if (hash(await readFile(path)) !== expected) throw new Error(`installed live-root hook changed a protected source: ${basename(path)}`);
  }
  return {
    claude: { project: claudeA.sourceIds, restart: claudeRestart.sourceIds, foreign: claudeLoose.sourceIds,
      indexedMemory: claudeA.sourceResolution.memory },
    codex: { projectA: codexAIds, projectB: codexBIds }, broadHomeScan: false, mcpCalls: 0
  };
}

async function prepareInstalledSelfstarter(pluginRoot, projectRoot, stateRoot, host) {
  const previous = process.env.AGENTSPINE_STATE_DIR;
  process.env.AGENTSPINE_STATE_DIR = stateRoot;
  try {
    const graph = await import(pathToFileURL(join(pluginRoot, "src/lib/graph.js")).href);
    const coordination = await import(pathToFileURL(join(pluginRoot, "src/lib/coordination.js")).href);
    const selfstarter = await import(pathToFileURL(join(pluginRoot, "src/lib/selfstarter.js")).href);
    for (const [id, kind] of [
      ["person:install-owner", "person"], ["agent:install-worker", "agent"], ["project:install-runtime", "project"]
    ]) await graph.upsertEntity({ root: projectRoot, id, kind, privacy: "shared" });
    await coordination.createTask({
      root: projectRoot, id: `task:install-${host}`, actorId: "agent:install-worker", assigneeId: "agent:install-worker",
      projectId: "project:install-runtime", title: `Installed ${host} self-starter check`, privacy: "private"
    });
    await selfstarter.grantExecution({
      root: projectRoot, id: `execution-grant:install-${host}`, jobId: `job:install-${host}`,
      actorId: "agent:install-worker", taskId: `task:install-${host}`, targetId: "person:install-owner",
      projectId: "project:install-runtime", host, capabilities: ["tool:Write"],
      reason: `Owner approved the exact installed ${host} synthetic write.`, confirmation: "local-owner-confirmed"
    });
    await selfstarter.registerJob({
      root: projectRoot, id: `job:install-${host}`, grantId: `execution-grant:install-${host}`,
      confirmation: "local-owner-confirmed"
    });
  } finally {
    if (previous === undefined) delete process.env.AGENTSPINE_STATE_DIR;
    else process.env.AGENTSPINE_STATE_DIR = previous;
  }
}

async function invokeInstalledSelfstarter(pluginRoot, projectRoot, stateRoot, host) {
  await prepareInstalledSelfstarter(pluginRoot, projectRoot, stateRoot, host);
  const session = `session:install-${host}-one`;
  const nextSession = `session:install-${host}-two`;
  const toolUseId = `tool:install-${host}`;
  const taskId = `task:install-${host}`;
  const artifact = join(projectRoot, `installed-${host}-artifact.txt`);
  const shared = {
    cwd: projectRoot, host, entity_id: "agent:install-worker", project_id: "project:install-runtime",
    task_id: taskId
  };
  const started = await invokeInstalledHook(pluginRoot, projectRoot, stateRoot, host, {
    ...shared, hook_event_name: "SessionStart", session_id: session
  });
  if (!started.selfstarter?.active || started.selfstarter.action !== "start") {
    throw new Error(`${host} installed hook did not start the exact authorized job`);
  }
  const authorized = await invokeInstalledHook(pluginRoot, projectRoot, stateRoot, host, {
    ...shared, hook_event_name: "PreToolUse", session_id: session,
    tool_name: "Write", tool_use_id: toolUseId,
    tool_input: { file_path: artifact, content: `installed ${host} checkpoint\n` }
  }, { requireBriefing: false });
  if (authorized.decision === "block") throw new Error(`${host} installed PreToolUse denied the exact authorized effect: ${authorized.reason}`);
  await writeFile(artifact, `installed ${host} checkpoint\n`, "utf8");
  await invokeInstalledHook(pluginRoot, projectRoot, stateRoot, host, {
    ...shared, hook_event_name: "PostToolUse", session_id: session,
    tool_name: "Write", tool_use_id: toolUseId, success: true, tool_result: { ok: true }
  }, { requireBriefing: false });
  await invokeInstalledHook(pluginRoot, projectRoot, stateRoot, host, {
    ...shared, hook_event_name: "Stop", session_id: session
  }, { requireBriefing: false });
  const resumed = await invokeInstalledHook(pluginRoot, projectRoot, stateRoot, host, {
    ...shared, hook_event_name: "SessionStart", session_id: nextSession
  });
  if (!resumed.selfstarter?.active || resumed.selfstarter.action !== "resume" || resumed.selfstarter.checkpointSequence !== 1) {
    throw new Error(`${host} installed hook did not resume the durable checkpoint`);
  }
  return {
    started: started.selfstarter.action, resumed: resumed.selfstarter.action,
    checkpointSequence: resumed.selfstarter.checkpointSequence, mcpCalls: 0
  };
}

async function invokeInstalledAcceptance(pluginRoot) {
  const acceptance = await import(pathToFileURL(join(pluginRoot, "src/lib/acceptance.js")).href);
  const report = await acceptance.runVisibleAcceptance();
  if (!report.ok || report.passed !== report.total || report.mcpCalls !== 0) {
    throw new Error("installed bundle did not pass visible lifecycle acceptance");
  }
  return {
    passed: report.passed,
    total: report.total,
    receiptDigest: report.receiptDigest,
    hosts: report.hosts,
    languages: report.languages,
    mcpCalls: report.mcpCalls
  };
}

async function prepareInstalledAttention(pluginRoot, projectRoot, stateRoot) {
  const previous = process.env.AGENTSPINE_STATE_DIR;
  process.env.AGENTSPINE_STATE_DIR = stateRoot;
  try {
    const graph = await import(pathToFileURL(join(pluginRoot, "src/lib/graph.js")).href);
    const coordination = await import(pathToFileURL(join(pluginRoot, "src/lib/coordination.js")).href);
    const continuity = await import(pathToFileURL(join(pluginRoot, "src/lib/continuity.js")).href);
    await graph.upsertEntity({ root: projectRoot, id: "person:install", kind: "person", privacy: "shared" });
    await graph.upsertEntity({ root: projectRoot, id: "project:install", kind: "project", privacy: "shared" });
    await coordination.createTask({
      root: projectRoot, id: "task:install", actorId: "person:install", assigneeId: "person:install",
      projectId: "project:install", title: "Installed lifecycle check", privacy: "private"
    });
    await continuity.configureContinuity({
      root: projectRoot, config: { enabled: true }, confirmation: "local-user-opt-in"
    });
  } finally {
    if (previous === undefined) delete process.env.AGENTSPINE_STATE_DIR;
    else process.env.AGENTSPINE_STATE_DIR = previous;
  }
}

async function invokeInstalledAttention(pluginRoot, projectRoot, stateRoot, host) {
  await prepareInstalledAttention(pluginRoot, projectRoot, stateRoot);
  const shared = {
    cwd: projectRoot, host, entity_id: "person:install",
    project_id: "project:install", task_id: "task:install", session_id: `session:installed-${host}-attention`
  };
  const captured = await invokeInstalledHook(pluginRoot, projectRoot, stateRoot, host, {
    ...shared, hook_event_name: "UserPromptSubmit", event_id: "install:promise",
    prompt: "I promise to verify the installed lifecycle."
  });
  const restarted = await invokeInstalledHook(pluginRoot, projectRoot, stateRoot, host, {
    ...shared, hook_event_name: "SessionStart", session_id: "install:restart"
  });
  if (captured.capturedAttentionKind !== "promise" || !restarted.attentionKinds.includes("promise")) {
    throw new Error(`${host} installed hooks did not persist and inject an attention event`);
  }
  return { captured: captured.capturedAttentionKind, restarted: restarted.attentionKinds,
    preflight: captured.preflight ? { schema: captured.preflight.schema,
      receiptId: captured.preflight.receiptId, instructions: captured.preflight.briefing?.instructions?.length || 0 } : null };
}

async function prepareInstalledChannelWake(pluginRoot, projectRoot, stateRoot) {
  const previous = process.env.AGENTSPINE_STATE_DIR;
  process.env.AGENTSPINE_STATE_DIR = stateRoot;
  try {
    const graph = await import(pathToFileURL(join(pluginRoot, "src/lib/graph.js")).href);
    const channel = await import(pathToFileURL(join(pluginRoot, "src/lib/channel-runtime.js")).href);
    await graph.upsertEntity({
      root: projectRoot, id: "agent:install-channel", kind: "agent", displayName: "Franz",
      attributes: { language: "de-DE", voice: { warmth: "warm", directness: "clear", length: "concise" } },
      privacy: "shared"
    });
    await graph.upsertEntity({ root: projectRoot, id: "project:install-channel", kind: "project", privacy: "shared" });
    await graph.upsertEntity({ root: projectRoot, id: "group:install-channel", kind: "group", privacy: "shared" });
    await graph.linkEntities({
      root: projectRoot, from: "agent:install-channel", to: "group:install-channel",
      relation: "member-of", privacy: "group"
    });
    await channel.grantChannelBinding({
      root: projectRoot, id: "channel-binding:install", provider: "telegram",
      tenantId: "tenant:install", accountId: "bot:install", chatId: "chat:install", threadId: "topic:install",
      senderIds: ["user:install"], agentId: "agent:install-channel", projectId: "project:install-channel",
      groupId: "group:install-channel", sessionKey: "session:install-channel",
      secretEnv: "AGENTSPINE_INSTALL_CHANNEL_SECRET", outboundSecretEnv: "AGENTSPINE_INSTALL_CHANNEL_SECRET", capabilities: ["receive", "reply"],
      confirmation: "local-owner-confirmed", now: "2032-01-01T00:00:00.000Z"
    });
    const event = {
      schema: channel.CHANNEL_EVENT_SCHEMA, eventId: "telegram:update:install", provider: "telegram",
      tenantId: "tenant:install", accountId: "bot:install", chatId: "chat:install", threadId: "topic:install",
      senderId: "user:install", replyTo: "message:install", observedAt: "2032-01-01T00:00:01.000Z",
      privacy: "group", text: "Bitte antworte im gebundenen Telegram-Thema."
    };
    const secret = "synthetic-installed-channel-secret-32-bytes";
    const signature = `sha256=${createHmac("sha256", secret).update(channel.channelEventSigningPayload(event)).digest("hex")}`;
    await channel.ingestChannelEvent({
      root: projectRoot, event, signature, env: { AGENTSPINE_INSTALL_CHANNEL_SECRET: secret },
      now: "2032-01-01T00:00:02.000Z"
    });
    return { event, secret };
  } finally {
    if (previous === undefined) delete process.env.AGENTSPINE_STATE_DIR;
    else process.env.AGENTSPINE_STATE_DIR = previous;
  }
}

async function invokeInstalledChannelWake(pluginRoot, projectRoot, stateRoot, host) {
  const { event, secret } = await prepareInstalledChannelWake(pluginRoot, projectRoot, stateRoot);
  const result = await invokeInstalledHook(pluginRoot, projectRoot, stateRoot, host, {
    hook_event_name: "SessionStart", cwd: projectRoot, host,
    entity_id: "agent:install-channel", project_id: "project:install-channel",
    group_id: "group:install-channel", session_id: `session:installed-${host}-channel`,
    agent_spine_channel_event: { event_id: event.eventId, provider: event.provider }
  }, { extraEnv: { AGENTSPINE_INSTALL_CHANNEL_SECRET: secret } });
  if (result.channelEvent?.eventId !== event.eventId || result.channelEvent?.chatId !== event.chatId
    || result.channelEvent?.threadId !== event.threadId || result.voiceBrief?.displayName !== "Franz"
    || result.voiceBrief?.profile?.warmth !== "warm") {
    throw new Error(`${host} installed hook did not inject the exact channel event and voice brief`);
  }
  return {
    eventId: result.channelEvent.eventId, provider: result.channelEvent.provider,
    route: [result.channelEvent.chatId, result.channelEvent.threadId],
    voice: { displayName: result.voiceBrief.displayName, profile: result.voiceBrief.profile },
    mcpCalls: 0
  };
}

async function invokeInstalledGateway(pluginRoot, projectRoot, stateRoot) {
  const previous = process.env.AGENTSPINE_STATE_DIR;
  process.env.AGENTSPINE_STATE_DIR = stateRoot;
  try {
    const graph = await import(pathToFileURL(join(pluginRoot, "src/lib/graph.js")).href);
    const persona = await import(pathToFileURL(join(pluginRoot, "src/lib/persona-runtime.js")).href);
    const channel = await import(pathToFileURL(join(pluginRoot, "src/lib/channel-runtime.js")).href);
    const gateway = await import(pathToFileURL(join(pluginRoot, "src/lib/gateway-runtime.js")).href);
    const worker = await import(pathToFileURL(join(pluginRoot, "src/worker.js")).href);
    await graph.upsertEntity({ root: projectRoot, id: "project:installed-gateway", kind: "project", privacy: "shared" });
    await graph.upsertEntity({ root: projectRoot, id: "group:installed-gateway", kind: "group", privacy: "shared" });
    const roster = await persona.applyPersonaRoster({
      root: projectRoot,
      bindings: [{
        id: "persona-binding:installed-gateway", authenticator: "host-manifest", issuer: "host:installed",
        tenantId: "tenant:installed-gateway", host: "codex", profileId: "profile:installed-gateway",
        subjectId: "subject:installed-gateway", kind: "agent", displayName: "Installed Franz",
        sourceBinding: ".codex/agents/installed-franz.md", groupId: "group:installed-gateway"
      }],
      confirmation: "local-owner-confirmed", now: "2032-01-02T00:00:00.000Z"
    });
    const agentId = roster.runtime.personas[0].personaId;
    await gateway.setGatewayControl({
      root: projectRoot, enabled: true, killSwitch: false,
      confirmation: "local-owner-confirmed", now: "2032-01-02T00:00:00.500Z"
    });
    await channel.grantChannelBinding({
      root: projectRoot, id: "channel-binding:installed-gateway", provider: "telegram",
      tenantId: "tenant:installed-gateway", accountId: "123456789", chatId: "-1001234567890", threadId: "77",
      senderIds: ["888"], agentId, projectId: "project:installed-gateway", groupId: "group:installed-gateway",
      sessionKey: "session:installed-gateway", secretEnv: "AGENTSPINE_INSTALLED_GATEWAY_SECRET",
      outboundSecretEnv: "AGENTSPINE_INSTALLED_GATEWAY_TOKEN", capabilities: ["receive", "reply"],
      confirmation: "local-owner-confirmed", now: "2032-01-02T00:00:01.000Z"
    });
    const event = {
      schema: channel.CHANNEL_EVENT_SCHEMA, eventId: "telegram:update:installed-gateway", provider: "telegram",
      tenantId: "tenant:installed-gateway", accountId: "123456789", chatId: "-1001234567890", threadId: "77",
      senderId: "888", replyTo: "990", observedAt: "2032-01-02T00:00:02.000Z", privacy: "group",
      text: "Bitte führe den installierten Gateway-Test aus."
    };
    const secret = "synthetic-installed-gateway-secret-32-bytes";
    await channel.ingestChannelEvent({
      root: projectRoot, event,
      signature: `sha256=${createHmac("sha256", secret).update(channel.channelEventSigningPayload(event)).digest("hex")}`,
      env: { AGENTSPINE_INSTALLED_GATEWAY_SECRET: secret }, now: "2032-01-02T00:00:03.000Z"
    });
    let hostStart = null; let delivered = null;
    const result = await worker.runWorkerTick({
      root: projectRoot, workerId: "gateway-worker:installed", now: "2032-01-02T00:00:04.000Z",
      env: { AGENTSPINE_STATE_DIR: stateRoot },
      hostRunner: async (item) => { hostStart = item.channelStart; return { text: "Installierter Gateway-Test bestanden." }; },
      adapter: { send: async (outbox) => { delivered = outbox; return { ok: true, receipt: "telegram-message:991" }; } }
    });
    const channelState = await channel.loadChannelRuntime(projectRoot);
    if (result.status !== "delivered" || channelState.runtime.events.at(-1)?.status !== "completed"
      || hostStart?.agent_spine_channel_event?.event_id !== event.eventId
      || delivered?.chatId !== event.chatId || delivered?.threadId !== event.threadId || delivered?.replyTo !== event.replyTo) {
      throw new Error("installed gateway did not complete the exact channel wake and delivery path: " + JSON.stringify({
        result, channelStatus: channelState.runtime.events.at(-1)?.status || null,
        hostEvent: hostStart?.agent_spine_channel_event?.event_id || null,
        route: delivered ? [delivered.chatId, delivered.threadId, delivered.replyTo] : null
      }));
    }
    return { status: result.status, eventId: event.eventId, agentId,
      route: [delivered.chatId, delivered.threadId, delivered.replyTo], mcpCalls: 0 };
  } finally {
    if (previous === undefined) delete process.env.AGENTSPINE_STATE_DIR;
    else process.env.AGENTSPINE_STATE_DIR = previous;
  }
}

export async function checkInstall(root = process.cwd()) {
  root = resolve(root);
  const currentVersion = JSON.parse(await readFile(join(root, "package.json"), "utf8")).version;
  const workspace = await mkdtemp(join(tmpdir(), "agentspine-install-check-"));
  try {
    const userProject = join(workspace, "user-project");
    const source = join(userProject, "SOUL.md");
    await mkdir(userProject, { recursive: true });
    await writeFile(source, "# Existing soul\n\nNever modify me.\n", "utf8");
    await writeFile(join(userProject, "CLAUDE.md"), "# Installed Claude rules\n\nLoad this before every answer.\n", "utf8");
    await writeFile(join(userProject, "AGENTS.md"), "# Installed Codex rules\n\nLoad this before every answer.\n", "utf8");
    const protectedInstallSources = [source, join(userProject, "CLAUDE.md"), join(userProject, "AGENTS.md")];
    const sourceHashes = new Map(await Promise.all(protectedInstallSources.map(async (path) => [path, hash(await readFile(path))])));

    const fresh = join(workspace, "fresh", "agent-spine");
    await copyBundle(root, fresh);
    const freshResult = await checkHosts(fresh);
    const aliasRoot = join(workspace, "fresh-alias");
    await symlink(join(workspace, "fresh"), aliasRoot, process.platform === "win32" ? "junction" : "dir");
    const aliasResult = await checkHosts(join(aliasRoot, "agent-spine"));
    const freshState = join(workspace, "state-fresh");
    const freshHook = await invokeInstalledHook(fresh, userProject, freshState, "claude");
    const freshAttention = await invokeInstalledAttention(fresh, userProject, freshState, "claude");
    const freshSelfstarter = await invokeInstalledSelfstarter(fresh, userProject, freshState, "claude");
    const freshChannelWake = await invokeInstalledChannelWake(fresh, userProject, freshState, "claude");
    const freshGateway = await invokeInstalledGateway(fresh, userProject, freshState);
    const freshAcceptance = await invokeInstalledAcceptance(fresh);
    const freshLiveRoots = await invokeInstalledLiveRoots(fresh, workspace, join(workspace, "state-live-fresh"));

    const installed = join(workspace, "cache", "agent-spine");
    await copyBundle(root, installed);
    await makePreviousCache(installed);
    let legacyFailed = false;
    try {
      const legacy = await checkHosts(installed);
      if (legacy.version !== currentVersion) legacyFailed = true;
    } catch { legacyFailed = true; }
    if (!legacyFailed) throw new Error("legacy cache unexpectedly passed the current host inventory");

    const staging = `${installed}.${currentVersion}.staging`;
    await copyBundle(root, staging);
    await removeTree(installed);
    await rename(staging, installed);
    const upgraded = await checkHosts(installed);
    const upgradeState = join(workspace, "state-upgrade");
    const upgradedHook = await invokeInstalledHook(installed, userProject, upgradeState, "codex");
    const upgradedAttention = await invokeInstalledAttention(installed, userProject, upgradeState, "codex");
    const upgradedSelfstarter = await invokeInstalledSelfstarter(installed, userProject, upgradeState, "codex");
    const upgradedChannelWake = await invokeInstalledChannelWake(installed, userProject, upgradeState, "codex");
    const upgradedGateway = await invokeInstalledGateway(installed, userProject, upgradeState);
    const upgradedAcceptance = await invokeInstalledAcceptance(installed);
    const upgradedLiveRoots = await invokeInstalledLiveRoots(installed, join(workspace, "upgrade-live"), join(workspace, "state-live-upgrade"));

    await removeTree(fresh);
    await removeTree(installed);
    for (const [path, expected] of sourceHashes) {
      if (hash(await readFile(path)) !== expected) throw new Error("install or uninstall changed an existing source Markdown file");
    }
    return {
      ok: true,
      version: upgraded.version,
      fresh: freshResult.exactlyOnce,
      upgrade: upgraded.exactlyOnce,
      automaticBriefing: { fresh: freshHook, upgrade: upgradedHook },
      automaticAttention: { fresh: freshAttention, upgrade: upgradedAttention },
      automaticSelfstarter: { fresh: freshSelfstarter, upgrade: upgradedSelfstarter },
      automaticChannelWake: { fresh: freshChannelWake, upgrade: upgradedChannelWake },
      automaticGateway: { fresh: freshGateway, upgrade: upgradedGateway },
      visibleAcceptance: { fresh: freshAcceptance, upgrade: upgradedAcceptance },
      liveRootResolution: { fresh: freshLiveRoots, upgrade: upgradedLiveRoots },
      canonicalAliasLaunch: aliasResult.ok,
      previousCacheRejected: legacyFailed,
      uninstallPreservedSources: true,
      authority: "installation-check-only"
    };
  } finally {
    await removeTree(workspace, { force: true });
  }
}

async function main() {
  const args = process.argv.slice(2);
  let root = process.cwd();
  let pretty = false;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--root") root = args[++index];
    else if (args[index] === "--json") pretty = true;
    else throw new Error(`unknown install-check argument: ${args[index]}`);
  }
  process.stdout.write(`${JSON.stringify(await checkInstall(root), null, pretty ? 2 : 0)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    process.stderr.write(`AgentSpine install check failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
