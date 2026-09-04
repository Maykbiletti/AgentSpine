import { readFile } from "node:fs/promises";
import { configureContinuity, loadContinuity, purgeContinuity } from "./lib/continuity.js";
import { configurePreflightPolicy, confirmMustRemember, preflightStatus, proposeMustRemember, purgeMustRemember, rollbackMustRemember } from "./lib/preflight.js";
import { bindSourceRoot, inspectSourceRegistry, purgeSourceBinding, resolveHostSourceCatalog, rollbackSourceBinding } from "./lib/source-roots.js";
import { booleanFlag, output } from "./cli-common.js";

export const continuityCommands = new Set([
  "continuity-config",
  "continuity-status",
  "continuity-purge",
  "preflight-policy",
  "preflight-status",
  "remember-propose",
  "remember-confirm",
  "remember-rollback",
  "remember-purge",
  "source-status",
  "source-bind",
  "source-rollback",
  "source-purge"
]);

export async function runContinuityCommand({ command, flags, positional, json }) {
  if (command === "continuity-config") {
    const root = positional[0] || process.cwd();
    const config = {};
    if (flags.enabled !== undefined) config.enabled = booleanFlag(flags.enabled);
    if (flags.entity !== undefined) config.defaultEntityId = flags.entity === "none" ? null : flags.entity;
    if (flags.project !== undefined) config.defaultProjectId = flags.project === "none" ? null : flags.project;
    if (flags["min-confidence"] !== undefined) config.minConfidence = Number(flags["min-confidence"]);
    if (flags["min-directness"] !== undefined) config.minDirectness = Number(flags["min-directness"]);
    if (flags["min-evidence"] !== undefined) config.minEvidence = Number(flags["min-evidence"]);
    if (flags["max-prompt-bytes"] !== undefined) config.maxPromptBytes = Number(flags["max-prompt-bytes"]);
    if (flags["max-briefing-bytes"] !== undefined) config.maxBriefingBytes = Number(flags["max-briefing-bytes"]);
    if (!Object.keys(config).length) return output((await loadContinuity(root)).continuity.config, json);
    return output(await configureContinuity({
      root, config,
      confirmation: booleanFlag(flags["confirm-local-opt-in"]) ? "local-user-opt-in" : null
    }), json);
  }

  if (command === "continuity-status") {
    const { continuity, continuityPath } = await loadContinuity(positional[0] || process.cwd());
    return output({
      schema: continuity.schema, config: continuity.config,
      signals: continuity.signals.length, history: continuity.history.length,
      continuityPath, authority: "context-only"
    }, json);
  }

  if (command === "continuity-purge") {
    return output(await purgeContinuity({
      root: flags.root || process.cwd(), subjectId: positional[0],
      confirmation: booleanFlag(flags["confirm-local-purge"]) ? "local-user-confirmed" : null
    }), json);
  }

  if (command === "preflight-policy") {
    if (!positional[0]) throw new Error("preflight-policy requires one local JSON policy file");
    const profile = JSON.parse(await readFile(positional[0], "utf8"));
    return output(await configurePreflightPolicy({ profile,
      confirmation: booleanFlag(flags["confirm-local-policy"]) ? "local-owner-confirmed" : null }), json);
  }

  if (command === "preflight-status") return output(await preflightStatus(), json);

  if (command === "remember-propose") {
    return output(await proposeMustRemember({ claim: flags.claim, kind: flags.kind || "critical",
      userId: flags.user, tenantId: flags.tenant, projectId: flags.project || null,
      groupId: flags.group || null, taskId: flags.task || null, sourceDigest: flags["source-digest"] || null }), json);
  }

  if (command === "remember-confirm") {
    return output(await confirmMustRemember({ candidateId: positional[0], supersedes: flags.supersedes || null,
      confirmation: booleanFlag(flags["confirm-local-user"]) ? "local-user-confirmed" : null }), json);
  }

  if (command === "remember-rollback") {
    return output(await rollbackMustRemember({ id: positional[0],
      confirmation: booleanFlag(flags["confirm-local-user"]) ? "local-user-confirmed" : null }), json);
  }

  if (command === "remember-purge") {
    return output(await purgeMustRemember({ id: positional[0],
      confirmation: booleanFlag(flags["confirm-local-purge"]) ? "local-user-purge-confirmed" : null }), json);
  }

  if (command === "source-status") {
    const host = flags.host || process.env.AGENTSPINE_HOST;
    if (!["claude", "codex"].includes(host)) throw new Error("source-status requires --host claude or --host codex");
    const resolved = await resolveHostSourceCatalog({ host, cwd: flags.cwd || process.cwd() });
    const registry = await inspectSourceRegistry();
    return output({ diagnostics: resolved.diagnostics, sources: resolved.catalog.documents.map((item) => ({
      id: item.relativePath, scope: item.sourceScope, binding: item.sourceBinding, sha256: item.sha256,
      bytes: item.bytes, authority: item.authority
    })), bindings: registry.registry.bindings, authority: "context-only" }, json);
  }

  if (command === "source-bind") {
    return output(await bindSourceRoot({
      host: flags.host, hostHome: flags["host-home"] || process.env.CLAUDE_CONFIG_DIR || process.env.CODEX_HOME || process.cwd(),
      projectRoot: flags.project || process.cwd(), sourceRoot: positional[0], scope: flags.scope || "state-user",
      confirmation: booleanFlag(flags["confirm-local-binding"]) ? "local-user-confirmed" : null
    }), json);
  }

  if (command === "source-rollback") {
    return output(await rollbackSourceBinding({ id: positional[0],
      confirmation: booleanFlag(flags["confirm-local-binding"]) ? "local-user-confirmed" : null }), json);
  }

  if (command === "source-purge") {
    return output(await purgeSourceBinding({ id: positional[0],
      confirmation: booleanFlag(flags["confirm-local-binding"]) ? "local-user-confirmed" : null }), json);
  }
}
