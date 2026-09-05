import {
  autonomyStatus, configureAutonomyProject, evaluateAutonomyAction,
  projectPortfolioContext, recordProjectObservation, revokeAutonomyProject, scanProjectPortfolio
} from "./lib/autonomy.js";
import { booleanFlag, output } from "./cli-common.js";

export const autonomyCommands = new Set([
  "autonomy-project-set", "autonomy-project-revoke", "autonomy-scan",
  "autonomy-observe", "autonomy-status", "autonomy-check", "portfolio"
]);

function capabilities(value) { return String(value || "").split(",").filter(Boolean); }

export async function runAutonomyCommand({ command, flags, positional, json }) {
  const root = flags.root || process.cwd();
  if (command === "autonomy-project-set") return output(await configureAutonomyProject({
    root, id: positional[0], projectId: flags.project, tenantId: flags.tenant, groupId: flags.group || null,
    localRoot: flags["local-root"] || null, publicUrl: flags["public-url"] || null,
    mode: flags.mode || "observe", capabilities: capabilities(flags.capabilities), goal: flags.goal,
    confirmation: flags["confirm-local-autonomy"] ? "local-owner-confirmed" : null,
    publishConfirmation: flags["confirm-local-publish"] ? "local-owner-publish-confirmed" : null
  }), json);
  if (command === "autonomy-project-revoke") return output(await revokeAutonomyProject({ root, id: positional[0],
    reason: flags.reason, confirmation: flags["confirm-local-autonomy"] ? "local-owner-confirmed" : null }), json);
  if (command === "autonomy-scan") return output(await scanProjectPortfolio({ root, tenantId: flags.tenant, groupId: flags.group || null }), json);
  if (command === "autonomy-observe") return output(await recordProjectObservation({ root, registrationId: positional[0],
    tenantId: flags.tenant, groupId: flags.group || null, kind: flags.kind, status: flags.status || "open",
    evidenceClass: flags.evidence, summary: flags.summary, sourceDigest: flags["source-digest"], expiresAt: flags.expires || null }), json);
  if (command === "autonomy-status") return output(await autonomyStatus({ root, tenantId: flags.tenant || null, groupId: flags.group || null }), json);
  if (command === "autonomy-check") return output(await evaluateAutonomyAction({ root, registrationId: positional[0],
    tenantId: flags.tenant, groupId: flags.group || null, action: flags.action, capability: flags.capability || null,
    actorId: flags.actor || null, jobId: flags.job || null, taskId: flags.task || null, targetId: flags.target || null,
    projectId: flags.project || null, host: flags.host || null }), json);
  if (command === "portfolio") return output(await projectPortfolioContext({ root, tenantId: flags.tenant,
    groupId: flags.group || null, markPresented: booleanFlag(flags["mark-presented"]) }), json);
}
