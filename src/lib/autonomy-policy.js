import { randomUUID } from "node:crypto";
import {
  AUTONOMY_CONFIRMATION, AUTONOMY_MODES, CAPABILITY_RE, PUBLISH_CONFIRMATION,
  appendHistory, canonicalLocalRoot, exactCapabilities, loadAutonomy, modeAllows,
  mutateAutonomy, publicRepository, safeText, signedRecord, stableId, timestamp
} from "./autonomy-store.js";
import { loadExecutionPolicy } from "./selfstarter.js";

function confirmation(value) {
  if (value !== AUTONOMY_CONFIRMATION) throw new Error("autonomy changes require explicit local-owner confirmation");
}

export async function configureAutonomyProject({
  root = process.cwd(), id = `autonomy-project:${randomUUID()}`, projectId, tenantId, groupId = null,
  localRoot = null, publicUrl = null, mode = "observe", capabilities = [], goal = "Maintain a bounded project overview.",
  confirmation: ownerConfirmation, publishConfirmation = null, now = new Date()
}) {
  confirmation(ownerConfirmation);
  if (!AUTONOMY_MODES.includes(mode)) throw new Error(`mode must be one of: ${AUTONOMY_MODES.join(", ")}`);
  if (Boolean(localRoot) === Boolean(publicUrl)) throw new Error("configure exactly one local root or public repository URL");
  const source = localRoot
    ? { kind: "local-root", value: await canonicalLocalRoot(localRoot) }
    : { kind: "public-repository", value: publicRepository(publicUrl) };
  const requestedCapabilities = exactCapabilities(capabilities);
  if (modeAllows(mode, "execute") && !requestedCapabilities.length) throw new Error("execute and publish modes require exact capabilities");
  if (mode === "publish" && publishConfirmation !== PUBLISH_CONFIRMATION) {
    throw new Error("publish mode requires a separate explicit local publish confirmation");
  }
  const at = timestamp(now, "now");
  const registrationId = stableId(id, "registrationId");
  return mutateAutonomy(root, (state, paths) => {
    const previous = state.projects.find((item) => item.id === registrationId);
    if (previous && (previous.projectId !== projectId || previous.tenantId !== tenantId || previous.groupId !== groupId
      || previous.source.kind !== source.kind || previous.source.value !== source.value)) {
      throw new Error("project registration identity and scope are immutable; create a new registration");
    }
    state.revision += 1;
    const body = {
      id: registrationId, projectId: stableId(projectId, "projectId"), tenantId: stableId(tenantId, "tenantId"),
      groupId: stableId(groupId, "groupId", true), source, mode, capabilities: requestedCapabilities,
      goal: safeText(goal, "goal", 500), active: true, revision: state.revision,
      createdAt: previous?.createdAt || at, updatedAt: at,
      publishConfirmedAt: mode === "publish" ? at : null,
      sourceAuthority: "explicit-local-owner-policy", authority: "explicit-local-autonomy-policy"
    };
    const project = signedRecord(body);
    if (previous) state.projects = state.projects.map((item) => item.id === registrationId ? project : item);
    else state.projects.push(project);
    state.projects.sort((a, b) => a.id.localeCompare(b.id));
    appendHistory(state, { kind: previous ? "project-updated" : "project-registered", projectRegistrationId: project.id, at });
    return { project, policyRevision: state.revision, autonomyPath: paths.autonomyPath };
  });
}

export async function revokeAutonomyProject({ root = process.cwd(), id, reason, confirmation: ownerConfirmation, now = new Date() }) {
  confirmation(ownerConfirmation);
  const registrationId = stableId(id, "registrationId");
  const at = timestamp(now, "now");
  const revokeReason = safeText(reason, "reason", 500);
  return mutateAutonomy(root, (state, paths) => {
    const previous = state.projects.find((item) => item.id === registrationId);
    if (!previous?.active) throw new Error("project registration is unknown or already inactive");
    state.revision += 1;
    const { recordDigest: ignored, ...body } = previous;
    const project = signedRecord({ ...body, active: false, updatedAt: at, revision: state.revision, revokedAt: at, revokeReason });
    state.projects = state.projects.map((item) => item.id === registrationId ? project : item);
    appendHistory(state, { kind: "project-revoked", projectRegistrationId: project.id, at });
    return { project, policyRevision: state.revision, autonomyPath: paths.autonomyPath };
  });
}

function exactGrant(policy, input, capability, now) {
  return policy.grants.find((grant) => grant.active && grant.actorId === input.actorId
    && grant.jobId === input.jobId && grant.taskId === input.taskId && grant.targetId === input.targetId
    && grant.projectId === input.projectId && grant.groupId === input.groupId && grant.host === input.host
    && grant.capabilities.includes(capability) && (!grant.expiresAt || new Date(grant.expiresAt) > now));
}

export async function evaluateAutonomyAction({
  root = process.cwd(), registrationId, tenantId, groupId = null, action, capability = null,
  actorId = null, jobId = null, taskId = null, targetId = null, projectId = null, host = null, now = new Date()
}) {
  if (!AUTONOMY_MODES.includes(action)) throw new Error(`action must be one of: ${AUTONOMY_MODES.join(", ")}`);
  const { state } = await loadAutonomy(root);
  const project = state.projects.find((item) => item.id === stableId(registrationId, "registrationId") && item.active);
  const base = { schema: "agentspine.autonomy-decision/v1", registrationId, action, allowed: false,
    reason: "project-registration-unavailable", grantsAuthority: false, authority: "additional-autonomy-gate" };
  if (!project || project.tenantId !== stableId(tenantId, "tenantId") || project.groupId !== stableId(groupId, "groupId", true)) return base;
  if (!modeAllows(project.mode, action)) return { ...base, reason: "autonomy-mode-insufficient", configuredMode: project.mode };
  if (!modeAllows(action, "execute")) return { ...base, allowed: true, reason: "configured-context-action", configuredMode: project.mode };
  if (project.projectId !== projectId) return { ...base, reason: "action-project-mismatch", configuredMode: project.mode };
  if (typeof capability !== "string" || !CAPABILITY_RE.test(capability) || !project.capabilities.includes(capability)) {
    return { ...base, reason: "capability-not-configured", configuredMode: project.mode };
  }
  if (action === "publish" && !project.publishConfirmedAt) return { ...base, reason: "publish-not-confirmed", configuredMode: project.mode };
  const scope = { actorId, jobId, taskId, targetId, projectId, groupId, host };
  if (Object.entries(scope).some(([key, value]) => key !== "groupId" && (typeof value !== "string" || !value))) {
    return { ...base, reason: "execution-scope-incomplete", configuredMode: project.mode };
  }
  const { policy } = await loadExecutionPolicy(root);
  const grant = exactGrant(policy, scope, capability, new Date(now));
  if (!grant) return { ...base, reason: "execution-grant-unavailable", configuredMode: project.mode };
  return { ...base, allowed: true, reason: "configured-and-explicitly-granted", configuredMode: project.mode, grantId: grant.id };
}

export async function autonomyStatus({ root = process.cwd(), tenantId = null, groupId = null } = {}) {
  const { state, autonomyPath } = await loadAutonomy(root);
  const projects = state.projects.filter((item) => (!tenantId || item.tenantId === tenantId) && item.groupId === groupId);
  return { schema: AUTONOMY_SCHEMA, projects, revision: state.revision, autonomyPath, authority: "context-only" };
}
