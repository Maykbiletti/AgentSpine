import { checkDelegation, createTask, deleteTask, grantDelegation, loadDelegationPolicy, revokeDelegation, taskContext, updateTask } from "./lib/coordination.js";
import { cancelJob, deleteJob, grantExecution, loadExecutionPolicy, registerJob, revokeExecution, selfstarterContext } from "./lib/selfstarter.js";
import { channelRuntimeContext, grantChannelBinding, loadChannelPolicy, revokeChannelBinding } from "./lib/channel-runtime.js";
import { personaContext, syncPersonaRosterFromEnvironment } from "./lib/persona-runtime.js";
import { assignGoal, gatewayContext, resolveGoalKnowledgeGap, setGatewayControl } from "./lib/gateway-runtime.js";
import { booleanFlag, goalPlanFlag, output } from "./cli-common.js";

export const agentCommands = new Set([
  "delegation-grant",
  "delegation-revoke",
  "delegation-check",
  "delegation-policy",
  "task-create",
  "task-update",
  "tasks",
  "task-delete",
  "execution-grant",
  "execution-revoke",
  "execution-policy",
  "job-register",
  "jobs",
  "job-cancel",
  "job-delete",
  "channel-bind",
  "channel-revoke",
  "channel-policy",
  "channel-events",
  "persona-sync",
  "personas",
  "goal-assign",
  "goal-clarify",
  "gateway-control",
  "gateway-status"
]);

export async function runAgentCommand({ command, flags, positional, json }) {
  if (command === "delegation-grant") {
    return output(await grantDelegation({
      root: flags.root || process.cwd(), actorId: positional[0],
      id: flags.id, actions: String(flags.actions || "").split(",").filter(Boolean),
      targetIds: String(flags.targets || "*").split(",").filter(Boolean), reason: flags.reason,
      confirmation: booleanFlag(flags["confirm-local-policy"]) ? "local-owner-confirmed" : null
    }), json);
  }

  if (command === "delegation-revoke") {
    return output(await revokeDelegation({
      root: flags.root || process.cwd(), id: positional[0], reason: flags.reason,
      confirmation: booleanFlag(flags["confirm-local-policy"]) ? "local-owner-confirmed" : null
    }), json);
  }

  if (command === "delegation-check") {
    return output(await checkDelegation({
      root: flags.root || process.cwd(), actorId: positional[0], action: flags.action,
      targetId: flags.target || null
    }), json);
  }

  if (command === "delegation-policy") {
    return output((await loadDelegationPolicy(positional[0] || process.cwd())).policy, json);
  }

  if (command === "task-create") {
    return output(await createTask({
      root: flags.root || process.cwd(), id: positional[0], actorId: flags.actor,
      assigneeId: flags.assignee || null, kind: flags.kind || "task", title: flags.title,
      summary: flags.summary || null, projectId: flags.project || null,
      privacy: flags.privacy || "private", groupId: flags.group || null,
      priority: Number(flags.priority ?? 50), dueAt: flags.due || null
    }), json);
  }

  if (command === "task-update") {
    const patch = {};
    if (flags.status !== undefined) patch.status = flags.status;
    if (flags.assignee !== undefined) patch.assigneeId = flags.assignee;
    if (flags.unassign !== undefined) patch.assigneeId = null;
    if (flags.title !== undefined) patch.title = flags.title;
    if (flags.summary !== undefined) patch.summary = flags.summary;
    if (flags.priority !== undefined) patch.priority = Number(flags.priority);
    if (flags.due !== undefined) patch.dueAt = flags.due;
    if (flags["clear-due"] !== undefined) patch.dueAt = null;
    if (flags.note !== undefined) patch.note = flags.note;
    return output(await updateTask({
      root: flags.root || process.cwd(), id: positional[0], actorId: flags.actor, patch
    }), json);
  }

  if (command === "tasks") {
    return output(await taskContext({
      root: positional[0] || process.cwd(), includePrivate: booleanFlag(flags["include-private"]),
      groupId: flags.group || null, actorId: flags.actor || null, assigneeId: flags.assignee || null,
      projectId: flags.project || null, includeClosed: booleanFlag(flags.closed),
      maxItems: Number(flags["max-items"] ?? 20)
    }), json);
  }

  if (command === "task-delete") {
    return output(await deleteTask({
      root: flags.root || process.cwd(), id: positional[0],
      confirmation: booleanFlag(flags["confirm-local-policy"]) ? "local-owner-confirmed" : null
    }), json);
  }

  if (command === "execution-grant") {
    return output(await grantExecution({
      root: flags.root || process.cwd(), id: flags.id, jobId: positional[0], actorId: flags.actor,
      taskId: flags.task, targetId: flags.target, projectId: flags.project, groupId: flags.group || null,
      host: flags.host, capabilities: String(flags.capabilities || "").split(",").filter(Boolean),
      reason: flags.reason, expiresAt: flags.expires || null,
      confirmation: booleanFlag(flags["confirm-local-execution"]) ? "local-owner-confirmed" : null
    }), json);
  }

  if (command === "execution-revoke") {
    return output(await revokeExecution({
      root: flags.root || process.cwd(), id: positional[0], reason: flags.reason,
      confirmation: booleanFlag(flags["confirm-local-execution"]) ? "local-owner-confirmed" : null
    }), json);
  }

  if (command === "execution-policy") {
    return output((await loadExecutionPolicy(positional[0] || process.cwd())).policy, json);
  }

  if (command === "job-register") {
    return output(await registerJob({
      root: flags.root || process.cwd(), id: positional[0], grantId: flags.grant,
      maxRetries: Number(flags["max-retries"] ?? 3), leaseSeconds: Number(flags["lease-seconds"] ?? 120),
      baseRetrySeconds: Number(flags["retry-seconds"] ?? 5),
      confirmation: booleanFlag(flags["confirm-local-execution"]) ? "local-owner-confirmed" : null
    }), json);
  }

  if (command === "jobs") {
    return output(await selfstarterContext({
      root: positional[0] || process.cwd(), actorId: flags.actor || null,
      projectId: flags.project || null, taskId: flags.task || null,
      includeTerminal: booleanFlag(flags["include-terminal"])
    }), json);
  }

  if (command === "job-cancel") {
    return output(await cancelJob({
      root: flags.root || process.cwd(), id: positional[0], reason: flags.reason,
      confirmation: booleanFlag(flags["confirm-local-execution"]) ? "local-owner-confirmed" : null
    }), json);
  }

  if (command === "job-delete") {
    return output(await deleteJob({
      root: flags.root || process.cwd(), id: positional[0],
      confirmation: booleanFlag(flags["confirm-local-execution"]) ? "local-owner-confirmed" : null
    }), json);
  }

  if (command === "channel-bind") {
    return output(await grantChannelBinding({
      root: flags.root || process.cwd(), id: positional[0], provider: flags.provider,
      tenantId: flags.tenant, accountId: flags.account, chatId: flags.chat,
      threadId: flags.thread || null,
      senderIds: String(flags.senders || "").split(",").filter(Boolean),
      agentId: flags.agent, projectId: flags.project, groupId: flags.group || null,
      sessionKey: flags.session, secretEnv: flags["secret-env"], outboundSecretEnv: flags["outbound-secret-env"] || null,
      capabilities: String(flags.capabilities || "receive,reply").split(",").filter(Boolean),
      confirmation: booleanFlag(flags["confirm-local-channel"]) ? "local-owner-confirmed" : null
    }), json);
  }

  if (command === "channel-revoke") {
    return output(await revokeChannelBinding({
      root: flags.root || process.cwd(), id: positional[0], reason: flags.reason,
      confirmation: booleanFlag(flags["confirm-local-channel"]) ? "local-owner-confirmed" : null
    }), json);
  }

  if (command === "channel-policy") {
    return output((await loadChannelPolicy(positional[0] || process.cwd())).policy, json);
  }

  if (command === "channel-events") {
    return output(await channelRuntimeContext({
      root: positional[0] || process.cwd(), agentId: flags.agent || null,
      projectId: flags.project || null,
      ...(flags.group !== undefined ? { groupId: flags.group || null } : {}),
      provider: flags.provider || null,
      includeTerminal: booleanFlag(flags["include-terminal"]),
      maxItems: Number(flags["max-items"] ?? 20)
    }), json);
  }

  if (command === "persona-sync") {
    if (!booleanFlag(flags["confirm-local-persona"])) throw new Error("persona synchronization requires --confirm-local-persona");
    return output(await syncPersonaRosterFromEnvironment({
      root: positional[0] || process.cwd(), env: { ...process.env, AGENTSPINE_PERSONA_ROSTER_FILE: flags.roster }
    }), json);
  }

  if (command === "personas") {
    return output(await personaContext({
      root: positional[0] || process.cwd(), personaId: flags.persona || null,
      ...(flags.group !== undefined ? { groupId: flags.group || null } : {}),
      includeInactive: booleanFlag(flags["include-inactive"])
    }), json);
  }

  if (command === "goal-assign") {
    return output(await assignGoal({
      root: flags.root || process.cwd(), goalId: positional[0], agentId: flags.agent,
      ownerSubjectId: flags.owner, projectId: flags.project, groupId: flags.group || null,
      priority: Number(flags.priority ?? 70), successCriterion: flags.success,
      nextSafeStep: flags["next-step"] || null, steps: await goalPlanFlag(flags.plan), deadline: flags.deadline || null,
      confirmation: booleanFlag(flags["confirm-local-goal"]) ? "local-owner-confirmed" : null
    }), json);
  }

  if (command === "goal-clarify") {
    return output(await resolveGoalKnowledgeGap({
      root: flags.root || process.cwd(), goalId: positional[0], gapId: flags.gap,
      answer: flags.answer, answerSource: flags.source || "owner-input",
      sourceDigest: flags["source-digest"] || null,
      confirmation: booleanFlag(flags["confirm-local-goal"]) ? "local-owner-confirmed" : null
    }), json);
  }

  if (command === "gateway-control") {
    return output(await setGatewayControl({
      root: positional[0] || process.cwd(),
      ...(flags.enabled !== undefined ? { enabled: booleanFlag(flags.enabled) } : {}),
      ...(flags["kill-switch"] !== undefined ? { killSwitch: booleanFlag(flags["kill-switch"]) } : {}),
      confirmation: booleanFlag(flags["confirm-local-gateway"]) ? "local-owner-confirmed" : null
    }), json);
  }

  if (command === "gateway-status") {
    return output(await gatewayContext({ root: positional[0] || process.cwd(), agentId: flags.agent || null }), json);
  }
}
