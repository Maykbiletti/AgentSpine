import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const HOST_ROOTS = {
  blun: ["BLUN_PLUGIN_ROOT"],
  claude: ["CLAUDE_PLUGIN_ROOT"],
  codex: ["PLUGIN_ROOT", "CLAUDE_PLUGIN_ROOT"]
};
const HOST_ROOT_KEYS = ["BLUN_PLUGIN_ROOT", "CLAUDE_PLUGIN_ROOT", "PLUGIN_ROOT"];

export function installedHostEnvironment(host, pluginRoot, extraEnv = {}) {
  const rootKeys = HOST_ROOTS[host];
  if (!rootKeys) throw new Error(`unsupported installed host: ${host}`);
  const env = { ...process.env, ...extraEnv };
  for (const key of HOST_ROOT_KEYS) delete env[key];
  for (const key of rootKeys) env[key] = pluginRoot;
  return env;
}

function parseProtocol(stdout, host) {
  try {
    return JSON.parse(stdout.trim());
  } catch (error) {
    throw new Error(`${host} installed hook returned invalid protocol JSON: ${stdout.slice(0, 2048)}`, { cause: error });
  }
}

function parseContext(protocol, host, requireBriefing) {
  const raw = protocol.hookSpecificOutput?.additionalContext;
  if (typeof raw !== "string" || !raw) return null;
  try {
    return JSON.parse(raw);
  } catch (error) {
    if (!requireBriefing) return null;
    throw new Error(`${host} installed hook returned invalid briefing context JSON`, { cause: error });
  }
}

function protocolShape(protocol) {
  const specific = protocol.hookSpecificOutput;
  return {
    protocolKeys: Object.keys(protocol).sort(),
    hookSpecificKeys: specific && typeof specific === "object" ? Object.keys(specific).sort() : [],
    permissionDecision: specific?.permissionDecision || null,
    permissionDecisionReason: specific?.permissionDecisionReason || null
  };
}

export async function invokeInstalledHook(pluginRoot, projectRoot, stateRoot, host, payload = null,
  { requireBriefing = true, extraEnv = {} } = {}) {
  return await new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [join(pluginRoot, "src/hook.js")], {
      cwd: projectRoot,
      env: installedHostEnvironment(host, pluginRoot, {
        AGENTSPINE_HOST: host,
        AGENTSPINE_STATE_DIR: stateRoot,
        ...extraEnv
      }),
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
      if (code !== 0) {
        reject(new Error(`${host} installed hook exited with ${code}: ${stderr.slice(0, 2048)}`));
        return;
      }
      try {
        const protocol = parseProtocol(stdout, host);
        const context = parseContext(protocol, host, requireBriefing);
        if (requireBriefing && (context?.briefing?.host !== host
          || !Array.isArray(context?.briefing?.sources?.documents))) {
          throw new Error(`${host} installed hook did not inject a real session briefing: `
            + `${protocol.reason || context?.error || context?.sourceResolution?.reason || "missing context"}`);
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
          reason: protocol.reason || null,
          message: protocol.hookSpecificOutput?.message || null,
          ...protocolShape(protocol)
        });
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(`${JSON.stringify(payload || {
      hook_event_name: "SessionStart", cwd: projectRoot, host
    })}\n`);
  });
}

export async function invokeInstalledBlunPostWriteDigest(pluginRoot, projectRoot, stateRoot) {
  const sessionId = `session:installed-blun-post-${stateRoot.split(/[\\/]/).at(-1)}`;
  const shared = {
    hook_event_name: "UserPromptSubmit", cwd: projectRoot, host: "blun",
    project_id: "project:installed-blun-protocol", session_id: sessionId,
    event_id: `prompt:${sessionId}`, prompt: "Change the synthetic installed BLUN artifact safely."
  };
  const prompted = await invokeInstalledHook(pluginRoot, projectRoot, stateRoot, "blun", shared,
    { requireBriefing: false });
  const requirementId = prompted.message?.match(
    /Requirement: (premortem-requirement:[a-f0-9]{64}:[a-f0-9]{64})/
  )?.[1];
  if (!requirementId) throw new Error("installed BLUN prompt did not expose its premortem requirement");
  const previousStateRoot = process.env.AGENTSPINE_STATE_DIR;
  try {
    process.env.AGENTSPINE_STATE_DIR = stateRoot;
    const premortem = await import(pathToFileURL(join(pluginRoot, "src/lib/delivery-premortem.js")).href);
    const usage = await import(pathToFileURL(join(pluginRoot, "src/lib/delivery-agent-usage.js")).href);
    await usage.recordDeliveryBriefingUse({ root: projectRoot, requirementId,
      input: { root: projectRoot }, result: { schema: "synthetic-installed-briefing" } });
    await usage.recordDeliveryKnowledgeUse({ root: projectRoot, requirementId,
      input: { targets: ["AGENTS.md"] }, result: { schema: "synthetic-installed-knowledge" } });
    const recorded = await premortem.recordDeliveryPremortem({
      root: projectRoot, requirementId, items: [
        { category: "baseline-environment", failure: "this delivery fails because the installed baseline is stale",
          check: "Compare the installed synthetic snapshot digest." },
        { category: "contract-tests", failure: "this delivery fails because the installed contract regresses",
          check: "Run the installed synthetic Node test." },
        { category: "delivery-path", failure: "this delivery fails because the installed artifact is misplaced",
          check: "Verify the installed synthetic artifact path and digest." }
      ]
    });
    if (recorded.blocked) throw new Error(`installed BLUN premortem registration failed: ${recorded.reason}`);
  } finally {
    if (previousStateRoot === undefined) delete process.env.AGENTSPINE_STATE_DIR;
    else process.env.AGENTSPINE_STATE_DIR = previousStateRoot;
  }
  const filePath = join(projectRoot, "installed-blun-post-write.txt");
  const tool = { tool_name: "Write", tool_use_id: `write:${sessionId}`,
    tool_input: { file_path: filePath, content: "synthetic installed BLUN write\n" } };
  const pre = await invokeInstalledHook(pluginRoot, projectRoot, stateRoot, "blun", {
    ...shared, ...tool, hook_event_name: "PreToolUse"
  }, { requireBriefing: false });
  if (pre.decision === "block" || pre.permissionDecision === "deny") {
    throw new Error(`installed BLUN PreToolUse denied its registered premortem: ${pre.reason}`);
  }
  await writeFile(filePath, tool.tool_input.content, "utf8");
  const post = await invokeInstalledHook(pluginRoot, projectRoot, stateRoot, "blun", {
    ...shared, ...tool, hook_event_name: "PostToolUse", success: true, tool_response: { ok: true }
  }, { requireBriefing: false });
  const digest = post.message?.match(/Premortem latest write sha256 ([a-f0-9]{64})/)?.[1];
  if (!digest || !exactKeys(post.protocolKeys, ["hookSpecificOutput"])
    || !exactKeys(post.hookSpecificKeys, ["hookEventName", "message"])) {
    throw new Error("installed BLUN PostToolUse did not return its latest-write digest through message");
  }
  return { contextField: "message", latestWriteDigest: digest };
}

function exactKeys(value, expected) {
  return JSON.stringify(value) === JSON.stringify([...expected].sort());
}

export async function invokeInstalledBlockingProtocols(pluginRoot, projectRoot, stateRoot) {
  const writePayload = (host) => ({
    hook_event_name: "PreToolUse", cwd: projectRoot, host,
    project_id: "project:installed-protocol",
    session_id: `session:installed-${host}-protocol`, tool_name: "Write",
    tool_use_id: `tool:installed-${host}-protocol`,
    tool_input: { file_path: `installed-${host}-protocol.txt`, content: "synthetic\n" }
  });
  const claudePreTool = await invokeInstalledHook(
    pluginRoot, projectRoot, stateRoot, "claude", writePayload("claude"), { requireBriefing: false }
  );
  const claudeStop = await invokeInstalledHook(pluginRoot, projectRoot, stateRoot, "claude", {
    hook_event_name: "Stop", cwd: projectRoot, host: "claude",
    project_id: "project:installed-protocol",
    session_id: "session:installed-claude-stop-protocol",
    agent_spine_exchange_directory: projectRoot,
    final_assistant_message: "missing-installed-artifact.txt sha256 0000000000000000"
  }, { requireBriefing: false });
  const codexPreTool = await invokeInstalledHook(
    pluginRoot, projectRoot, stateRoot, "codex", writePayload("codex"), { requireBriefing: false }
  );
  if (claudePreTool.decision !== null || claudePreTool.permissionDecision !== "deny"
    || !claudePreTool.permissionDecisionReason?.includes("premortem")
    || !exactKeys(claudePreTool.protocolKeys, ["hookSpecificOutput"])
    || !exactKeys(claudePreTool.hookSpecificKeys,
      ["hookEventName", "permissionDecision", "permissionDecisionReason"])) {
    throw new Error("installed Claude PreToolUse denial did not use its nested permissionDecision schema");
  }
  if (claudeStop.decision !== "block" || !claudeStop.reason?.includes("delivery artifact verification")
    || claudeStop.permissionDecision !== null
    || !exactKeys(claudeStop.protocolKeys, ["decision", "reason"])) {
    throw new Error("installed Claude Stop block did not use its top-level decision/reason schema");
  }
  if (codexPreTool.decision !== "block" || !codexPreTool.reason?.includes("premortem")
    || codexPreTool.permissionDecision !== null
    || !exactKeys(codexPreTool.protocolKeys, ["decision", "reason"])) {
    const observed = {
      decision: codexPreTool.decision, reason: codexPreTool.reason,
      protocolKeys: codexPreTool.protocolKeys, hookSpecificKeys: codexPreTool.hookSpecificKeys,
      permissionDecision: codexPreTool.permissionDecision,
      sourceResolution: codexPreTool.sourceResolution, preflight: codexPreTool.preflight,
      selfstarter: codexPreTool.selfstarter
    };
    throw new Error("installed Codex denial did not preserve its strict top-level decision/reason schema: "
      + JSON.stringify(observed).slice(0, 8192));
  }
  return {
    claude: { preTool: "nested-permission-deny", stop: "top-level-block" },
    codex: { preTool: "top-level-block" }
  };
}
