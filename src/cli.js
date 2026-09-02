import { fileURLToPath } from "node:url";
import { scanAndSave, verifyCatalog } from "./lib/catalog.js";
import { readDocument, resolveContext } from "./lib/context.js";
import { sessionBriefing } from "./lib/briefing.js";
import { runAudit } from "./lib/audit.js";
import {
  attentionContext, configureAttention, deleteAttention, loadAttention,
  recordActivity, resolveAttention, upsertAttention
} from "./lib/attention.js";
import {
  addLearningEvidence, beginLearningRevalidation, configureLearning, deleteLearning, evaluateLearning,
  learningContext, learningOutcomeStatus, loadLearning, proposeLearning,
  purgeStaleLearningApplications, purgeStaleLearningMeasurements, recordLearningMeasurement,
  recordLearningOutcome, registerLearningEvaluation, registerLearningEvaluator, renewLearningValidation, revokeLearningEvaluator,
  reviewLearning, revokeLearningApplication, revokeLearningDelivery, revokeLearningEvaluation, revokeLearningEvidence, revokeLearningMeasurement, revokeLearningOutcome, revokeLearningValidation,
  rollbackLearning
} from "./lib/learning.js";
import { configureContinuity, loadContinuity, purgeContinuity } from "./lib/continuity.js";
import {
  checkDelegation, createTask, deleteTask, grantDelegation, loadDelegationPolicy,
  revokeDelegation, taskContext, updateTask
} from "./lib/coordination.js";
import {
  cancelJob, deleteJob, grantExecution, loadExecutionPolicy, registerJob,
  revokeExecution, selfstarterContext
} from "./lib/selfstarter.js";
import {
  channelRuntimeContext, grantChannelBinding, loadChannelPolicy, revokeChannelBinding
} from "./lib/channel-runtime.js";
import { personaContext, syncPersonaRosterFromEnvironment } from "./lib/persona-runtime.js";
import { assignGoal, gatewayContext, setGatewayControl } from "./lib/gateway-runtime.js";
import {
  configureSharing, deleteShared, initDirectoryAdapter, publishLearning, pullShared,
  reviewShared, rollbackShared, sharedContext, sharedInbox
} from "./lib/sharing.js";
import {
  generateSigningIdentity, listSigningIdentities, revokeTrustedSigner,
  trustedSignerContext, trustSigner
} from "./lib/authentication.js";
import { exportHttpsSnapshot, pullHttpsSnapshot } from "./lib/https-transport.js";
import { publishHttpsSnapshot } from "./lib/object-transport.js";
import { loadHttpsFeedState, publishHttpsFeed, pullHttpsFeed } from "./lib/feed-transport.js";
import { pullPeerCommand, servePeerOnce } from "./lib/peer-transport.js";
import {
  initSqliteAdapter, inspectSqliteAdapter, publishSqliteSnapshot, pullSqliteSnapshot
} from "./lib/sqlite-transport.js";
import {
  annotateDocument, linkDocuments, linkEntities,
  relationshipContext, upsertEntity
} from "./lib/graph.js";
import { checkHosts } from "../scripts/check-hosts.js";
import { renderAcceptanceReport, runVisibleAcceptance } from "./lib/acceptance.js";
import {
  bindSourceRoot, inspectSourceRegistry, purgeSourceBinding, resolveHostSourceCatalog,
  rollbackSourceBinding
} from "./lib/source-roots.js";
import { VERSION } from "./version.js";
import { isMainModule } from "./lib/runtime.js";
import { scanIndexedMemoryOrphans } from "./lib/indexed-memory-offline.js";
import {
  configurePreflightPolicy, confirmMustRemember, preflightStatus, proposeMustRemember,
  purgeMustRemember, rollbackMustRemember
} from "./lib/preflight.js";
import { readFile } from "node:fs/promises";

function parse(argv) {
  const [command = "help", ...rest] = argv;
  const flags = {};
  const positional = [];
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const [name, inline] = token.slice(2).split("=", 2);
    if (inline !== undefined) flags[name] = inline;
    else if (rest[index + 1] && !rest[index + 1].startsWith("--")) flags[name] = rest[++index];
    else flags[name] = true;
  }
  return { command, flags, positional };
}

function output(value, json = false) {
  if (json) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  if (typeof value === "string") process.stdout.write(`${value}\n`);
  else process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function booleanFlag(value, fallback = false) {
  if (value === undefined) return fallback;
  if (value === true || value === "true" || value === "1") return true;
  if (value === false || value === "false" || value === "0") return false;
  throw new Error(`expected boolean flag, received: ${value}`);
}

function learningScope(flags) {
  return {
    personaId: flags.persona || null,
    userId: flags.user || null,
    tenantId: flags.tenant || null,
    projectId: flags.project || null,
    groupId: flags.group || null,
    taskId: flags.task || null
  };
}

function hasLearningScope(flags) {
  return ["persona", "user", "tenant", "project", "group", "task"].some((name) => flags[name] !== undefined);
}

function evaluatorRootsFlag(value) {
  return String(value || "").split(",").filter(Boolean).map((entry) => {
    const separator = entry.lastIndexOf("=");
    if (separator <= 0) throw new Error("evaluator roots must use evaluator-id=sha256 entries");
    return { evaluatorId: entry.slice(0, separator), principalDigest: entry.slice(separator + 1) };
  });
}

function help() {
  return `AgentSpine ${VERSION}

Usage:
  agentspine scan [root] [--json]
  agentspine context [root] [--cwd path] [--host codex|claude|generic] [--max-bytes n] [--json]
  agentspine briefing [root] [--host codex|claude|generic] [--entity id] [--group id] [--project id] [--current-task id] [--include-private] [--max-bytes n] [--allow-attention] [--no-source-content]
  agentspine read <relative-path> [--root path] [--offset n] [--length n] [--json]
  agentspine verify [root] [--json]
  agentspine link <from.md> <to.md> --relation related [--reason text] [--confidence 0.8]
  agentspine annotate <path.md> --layer soul [--reason text] [--confidence 0.8]
  agentspine entity <id> --kind person [--name text] [--privacy private]
  agentspine relate <from> <to> --relation works-with [--privacy private]
  agentspine relationships <entity-id> [--group id] [--include-private] [--json]
  agentspine attention [root] [--group id] [--include-private] [--focus-active] [--mark-presented]
  agentspine attention-events [root] [--include-history]
  agentspine attention-add [id] --kind promise --summary text [--entity id] [--group id] [--due date]
  agentspine attention-resolve <id> [--status completed|dismissed|open]
  agentspine attention-touch <entity-id> [--kind interaction] [--at date]
  agentspine attention-delete <signal-id>
  agentspine attention-event-delete <event-id>
  agentspine attention-purge <entity-id>
  agentspine attention-config [root] [--enabled true|false] [--quiet-start 22 --quiet-end 7 --utc-offset 120]
  agentspine learn-propose [id] --kind preference|behavior --claim text --evidence text [--persona id --user id --tenant id --project id --group id --task id]
  agentspine learn-evidence <id> --summary text [--type interaction] [--source path.md]
  agentspine learn-evidence-revoke <learning-id> --evidence-id id --reason-code retracted|source-invalid|measurement-invalid|duplicate|other --reason text --confirm-local-evidence
  agentspine learn-review <id> --decision accept|reject --reason text [--confirmed-by-user]
  agentspine learn-context [root] [--group id] [--include-private] [--kind preference,goal]
  agentspine learn-evaluate [root]
  agentspine learn-evaluator-register <id> --principal-digest sha256 --confirm-local-evaluator
  agentspine learn-evaluator-revoke <id> --reason text --confirm-local-evaluator
  agentspine learn-evaluation <id> --learning id --metric name --direction higher|lower --task-digest sha256 --dataset-digest sha256 --protocol-digest sha256 --min-cases n --evaluators id,id --evaluator-roots id=sha256,id=sha256 [--expires-at date] --confirm-local-evaluation
  agentspine learn-evaluation-revoke <evaluation-id> --reason-code benchmark-invalid|protocol-invalid|scope-invalid|threshold-invalid|duplicate|other --reason text --confirm-local-evaluation-revocation
  agentspine learn-validation-revoke <validation-lease-id> --reason-code decision-invalid|cohort-invalid|binding-invalid|scope-invalid|duplicate|other --reason text --confirm-local-validation-revocation
  agentspine learn-revalidation-start <learning-id> --confirm-local-validation
  agentspine learn-revalidate <learning-id> --measurements id,id --applications id,id --deliveries id,id --confirm-local-validation
  agentspine learn-measurement <id> --learning id --evaluation id --phase before|after --metric name --direction higher|lower --value 0..1 --measurement objective|user-feedback|model-suggestion --evaluator id --run id --source-digest sha256 --dataset-digest sha256 --case-count n --confirm-local-measurement
  agentspine learn-measurement-revoke <measurement-id> --reason-code source-invalid|evaluator-invalid|protocol-invalid|duplicate|other --reason text --confirm-local-measurement-revocation
  agentspine learn-application-revoke <application-id> --reason-code preflight-invalid|scope-invalid|projection-invalid|duplicate|other --reason text --confirm-local-application-revocation
  agentspine learn-delivery-revoke <delivery-id> --reason-code host-invalid|session-invalid|hook-invalid|duplicate|other --reason text --confirm-local-delivery-revocation
  agentspine learn-outcome-revoke <outcome-id> --reason-code binding-invalid|phase-invalid|scope-invalid|duplicate|other --reason text --confirm-local-outcome-revocation
  agentspine learn-outcome <learning-id> --id id --evaluation id --measurement-receipt id [--application id --delivery id]
  agentspine learn-status [root] [--persona id --user id --tenant id --project id --group id --task id]
  agentspine learn-delivery-purge [root] --confirm-local-purge
  agentspine learn-measurement-purge [root] --confirm-local-purge
  agentspine learn-rollback <id> --reason text
  agentspine learn-delete <id>
  agentspine learn-config [root] [--auto-promote true|false] [--min-confidence 0.85] [--min-outcomes 2 --min-improvement 0.05 --canary-receipts 2 --canary-ttl-days 14]
  agentspine continuity-config [root] [--enabled true|false] [--entity id] [--project id] [--confirm-local-opt-in]
  agentspine continuity-status [root]
  agentspine continuity-purge <entity-id> [--root path] --confirm-local-purge
  agentspine preflight-policy <policy.json> --confirm-local-policy
  agentspine preflight-status
  agentspine remember-propose --claim text --user id --tenant id [--project id] [--group id] [--task id]
  agentspine remember-confirm <candidate-id> [--supersedes id] --confirm-local-user
  agentspine remember-rollback <id> --confirm-local-user
  agentspine remember-purge <id> --confirm-local-purge
  agentspine source-status --host claude|codex [--cwd path]
  agentspine doctor --host claude [--cwd path] [--offline-memory-orphans]
  agentspine source-bind <state-root> --host all|claude|codex --scope state-user --project path --host-home path --confirm-local-binding
  agentspine source-rollback <binding-id> --confirm-local-binding
  agentspine source-purge <binding-id> --confirm-local-binding
  agentspine delegation-grant <actor-id> --actions assign,manage --targets agent:id --reason text [--confirm-local-policy]
  agentspine delegation-revoke <grant-id> --reason text [--confirm-local-policy]
  agentspine delegation-check <actor-id> --action assign [--target agent:id]
  agentspine delegation-policy [root]
  agentspine task-create [id] --actor id --title text [--assignee id] [--kind task|open-thread|handoff] [--privacy private|shared|group]
  agentspine task-update <id> --actor id [--status in-progress] [--assignee id|--unassign]
  agentspine tasks [root] [--assignee id] [--project id] [--include-private] [--group id]
  agentspine task-delete <id> [--confirm-local-policy]
  agentspine execution-grant <job-id> --actor id --task task:id --target id --project project:id --host claude|codex --capabilities tool:Write --reason text [--expires date] --confirm-local-execution
  agentspine execution-revoke <grant-id> --reason text --confirm-local-execution
  agentspine execution-policy [root]
  agentspine job-register <job-id> --grant grant:id [--max-retries 3] [--lease-seconds 120] --confirm-local-execution
  agentspine jobs [root] [--actor id] [--project id] [--task id] [--include-terminal]
  agentspine job-cancel <job-id> --reason text --confirm-local-execution
  agentspine job-delete <job-id> --confirm-local-execution
  agentspine channel-bind <binding-id> --provider telegram --tenant id --account id --chat id --senders id,id --agent agent:id --project project:id --session key --secret-env VARIABLE [--outbound-secret-env VARIABLE] --confirm-local-channel
  agentspine channel-revoke <binding-id> --reason text --confirm-local-channel
  agentspine channel-policy [root]
  agentspine channel-events [root] [--agent id] [--project id] [--group id] [--provider telegram] [--include-terminal]
  agentspine persona-sync [root] --roster absolute-path --confirm-local-persona
  agentspine personas [root] [--persona id] [--group id] [--include-inactive]
  agentspine goal-assign <goal-id> --agent id --owner id --project id --success text --next-step text [--group id] [--deadline date] --confirm-local-goal
  agentspine gateway-control [root] [--enabled true|false] [--kill-switch true|false] --confirm-local-gateway
  agentspine gateway-status [root] [--agent id]
  agentspine share-keygen <signer-id> [--public-out signer.json] [--rotate] [--confirm-local-share]
  agentspine share-signers [root]
  agentspine share-trust <signer.json> [--root path] [--confirm-local-share]
  agentspine share-trust-revoke <key-id> --reason text [--root path] [--confirm-local-share]
  agentspine share-trust-list [root] [--include-revoked]
  agentspine share-init <directory> --scope team:id [--adapter adapter:id] [--signer signer:id] [--confirm-local-share]
  agentspine share-publish <directory> --learning id [--id shared:id] [--signer signer:id] [--supersedes shared:id] [--confirm-local-share]
  agentspine share-pull <directory> [--root path] [--require-authenticated]
  agentspine share-snapshot-export <directory> --out snapshot.json [--id snapshot:id] [--confirm-local-share]
  agentspine share-https-publish <directory> --base https://store.example/spine [--id snapshot:id] [--token-env VARIABLE] [--timeout-ms 10000] [--allow-private-network] --confirm-local-share
  agentspine share-https-pull <https-url> [--token-env VARIABLE] [--timeout-ms 10000] [--allow-private-network --confirm-local-share]
  agentspine share-feed-publish <directory> --base https://store.example/spine --feed team:id --signer signer:id [--id snapshot:id] [--token-env VARIABLE] --confirm-local-share
  agentspine share-feed-pull --base https://store.example/spine --feed team:id [--root path] [--token-env VARIABLE] [--allow-private-network --confirm-local-share]
  agentspine share-feed-state [root]
  agentspine share-peer-serve <directory> --root path --signer signer:id [--timeout-ms 10000] --confirm-local-share
  agentspine share-peer-pull --root path --command-json '["ssh","host","agentspine",…]' [--timeout-ms 10000] [--max-bytes n] --confirm-local-share
  agentspine share-sqlite-init <directory> --database path --confirm-local-share
  agentspine share-sqlite-publish <directory> --database path [--id snapshot:id] --confirm-local-share
  agentspine share-sqlite-inspect --database path [--root path]
  agentspine share-sqlite-pull --database path [--root path]
  agentspine share-inbox [root] [--status pending|accepted|rejected|superseded|rolled-back]
  agentspine share-review <id> --decision accept|reject --reason text [--confirmed-by-user]
  agentspine share-context [root] [--scope team:id] [--group group:id] [--kind preference,goal]
  agentspine share-rollback <id> --reason text
  agentspine share-delete <id> [--confirm-local-share]
  agentspine share-config [root] --max-items 12
  agentspine audit [root] [--json]
  agentspine acceptance [--json]
  agentspine doctor [--json]
  agentspine mcp

AgentSpine reads existing Markdown in place. It never rewrites source documents.`;
}

export async function run(argv = process.argv.slice(2)) {
  const { command, flags, positional } = parse(argv);
  const json = Boolean(flags.json);
  if (command === "help" || command === "--help" || command === "-h") return output(help());
  if (command === "version" || command === "--version" || command === "-v") return output(VERSION);

  if (command === "acceptance") {
    if (positional.length || Object.keys(flags).some((name) => name !== "json")) {
      throw new Error("acceptance supports only --json");
    }
    const report = await runVisibleAcceptance();
    if (json) return output(report, true);
    process.stdout.write(renderAcceptanceReport(report));
    return;
  }

  if (command === "scan") {
    const result = await scanAndSave(positional[0] || process.cwd());
    return output(json ? result : {
      root: result.catalog.root,
      catalog: result.catalogPath,
      documents: result.catalog.summary.total,
      protected: result.catalog.summary.protected,
      layers: result.catalog.summary.byLayer
    }, json);
  }

  if (command === "context") {
    const root = positional[0] || process.cwd();
    const result = await resolveContext({
      root,
      cwd: flags.cwd || root,
      host: flags.host || "generic",
      maxBytes: Number(flags["max-bytes"] || 65536),
      includeContent: flags["no-content"] !== true
    });
    return output(result, json);
  }

  if (command === "briefing") {
    const root = positional[0] || process.cwd();
    return output(await sessionBriefing({
      root, cwd: flags.cwd || root, host: flags.host || "generic",
      entityId: flags.entity || null, groupId: flags.group || null,
      userId: flags.user || null, tenantId: flags.tenant || null,
      projectId: flags.project || null, currentTaskId: flags["current-task"] || null,
      includePrivate: booleanFlag(flags["include-private"]),
      focusActive: !booleanFlag(flags["allow-attention"]),
      includeSourceContent: !booleanFlag(flags["no-source-content"]),
      maxBytes: Number(flags["max-bytes"] ?? 16384)
    }), json);
  }

  if (command === "read") {
    const result = await readDocument({
      root: flags.root || process.cwd(),
      path: positional[0],
      offset: Number(flags.offset || 0),
      length: Number(flags.length || 65536)
    });
    return output(json ? result : result.content, json);
  }

  if (command === "verify") {
    const result = await verifyCatalog(positional[0] || process.cwd());
    output(result, json);
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (command === "link") {
    const result = await linkDocuments({
      root: flags.root || process.cwd(), from: positional[0], to: positional[1],
      relation: flags.relation || "related", reason: flags.reason || "",
      confidence: Number(flags.confidence ?? 0.5)
    });
    return output(result, json);
  }

  if (command === "annotate") {
    const result = await annotateDocument({
      root: flags.root || process.cwd(), path: positional[0], layer: flags.layer,
      reason: flags.reason || "", confidence: Number(flags.confidence ?? 0.5)
    });
    return output(result, json);
  }

  if (command === "entity") {
    const result = await upsertEntity({
      root: flags.root || process.cwd(), id: positional[0], kind: flags.kind,
      displayName: flags.name || "", confidence: Number(flags.confidence ?? 0.5),
      privacy: flags.privacy || "private"
    });
    return output(result, json);
  }

  if (command === "relate") {
    const result = await linkEntities({
      root: flags.root || process.cwd(), from: positional[0], to: positional[1],
      relation: flags.relation || "related", reason: flags.reason || "",
      confidence: Number(flags.confidence ?? 0.5), privacy: flags.privacy || "private"
    });
    return output(result, json);
  }

  if (command === "relationships") {
    return output(await relationshipContext({
      root: flags.root || process.cwd(), entityId: positional[0],
      includePrivate: Boolean(flags["include-private"]), groupId: flags.group || null
    }), json);
  }

  if (command === "attention") {
    return output(await attentionContext({
      root: positional[0] || process.cwd(),
      includePrivate: booleanFlag(flags["include-private"]),
      focusActive: booleanFlag(flags["focus-active"]),
      markPresented: booleanFlag(flags["mark-presented"]),
      entityId: flags.entity || null,
      groupId: flags.group || null,
      projectId: flags.project || null,
      currentTaskId: flags.task || null,
      maxItems: flags["max-items"] === undefined ? null : Number(flags["max-items"])
    }), json);
  }

  if (command === "attention-events") {
    const { attention, attentionPath } = await loadAttention(positional[0] || process.cwd());
    return output({
      schema: "agentspine.attention-events/v1", attentionPath,
      events: attention.events,
      receipts: attention.receipts,
      history: booleanFlag(flags["include-history"]) ? attention.history.filter((item) => item.kind === "attention-event") : [],
      authority: "context-only"
    }, json);
  }

  if (command === "attention-add") {
    return output(await upsertAttention({
      root: flags.root || process.cwd(), id: positional[0], kind: flags.kind,
      summary: flags.summary, entityId: flags.entity || null, dueAt: flags.due || null,
      priority: Number(flags.priority ?? 50), privacy: flags.privacy || "private",
      groupId: flags.group || null,
      sourceDocument: flags.source || null, confidence: Number(flags.confidence ?? 0.5)
    }), json);
  }

  if (command === "attention-resolve") {
    return output(await resolveAttention({
      root: flags.root || process.cwd(), id: positional[0], status: flags.status || "completed"
    }), json);
  }

  if (command === "attention-touch") {
    return output(await recordActivity({
      root: flags.root || process.cwd(), entityId: positional[0], kind: flags.kind || "interaction",
      at: flags.at || new Date(), privacy: flags.privacy || "private", groupId: flags.group || null
    }), json);
  }

  if (command === "attention-delete") {
    return output(await deleteAttention({ root: flags.root || process.cwd(), signalId: positional[0] }), json);
  }

  if (command === "attention-event-delete") {
    return output(await deleteAttention({ root: flags.root || process.cwd(), eventId: positional[0] }), json);
  }

  if (command === "attention-purge") {
    return output(await deleteAttention({ root: flags.root || process.cwd(), entityId: positional[0] }), json);
  }

  if (command === "attention-config") {
    const root = positional[0] || process.cwd();
    const config = {};
    if (flags.enabled !== undefined) config.enabled = booleanFlag(flags.enabled);
    if (flags["min-interval-hours"] !== undefined) config.minIntervalHours = Number(flags["min-interval-hours"]);
    if (flags["silence-days"] !== undefined) config.entitySilenceDays = Number(flags["silence-days"]);
    if (flags["heartbeat-stale-minutes"] !== undefined) config.heartbeatStaleMinutes = Number(flags["heartbeat-stale-minutes"]);
    if (flags["max-items"] !== undefined) config.maxItems = Number(flags["max-items"]);
    if (flags["quiet-off"] !== undefined) config.quietHours = null;
    else if (flags["quiet-start"] !== undefined || flags["quiet-end"] !== undefined) {
      config.quietHours = {
        start: Number(flags["quiet-start"]), end: Number(flags["quiet-end"]),
        utcOffsetMinutes: Number(flags["utc-offset"] ?? 0)
      };
    }
    if (!Object.keys(config).length) return output((await loadAttention(root)).attention.config, json);
    return output(await configureAttention({ root, config }), json);
  }

  if (command === "learn-propose") {
    return output(await proposeLearning({
      root: flags.root || process.cwd(), id: positional[0], kind: flags.kind,
      claim: flags.claim, subjectId: flags.subject || null, privacy: flags.privacy || "private",
      groupId: flags.group || null, supersedesId: flags.supersedes || null,
      scope: hasLearningScope(flags) ? learningScope(flags) : null,
      evidence: {
        id: flags["evidence-id"], type: flags["evidence-type"] || "user-statement",
        summary: flags.evidence, sourceDocument: flags.source || null,
        confidence: Number(flags.confidence ?? 0.5), observedAt: flags.at
      }
    }), json);
  }

  if (command === "learn-evidence") {
    return output(await addLearningEvidence({
      root: flags.root || process.cwd(), id: positional[0],
      evidence: {
        id: flags["evidence-id"], type: flags.type || "interaction", summary: flags.summary,
        sourceDocument: flags.source || null, confidence: Number(flags.confidence ?? 0.5), observedAt: flags.at
      }
    }), json);
  }

  if (command === "learn-evidence-revoke") {
    return output(await revokeLearningEvidence({
      root: flags.root || process.cwd(), learningId: positional[0], evidenceId: flags["evidence-id"],
      reasonCode: flags["reason-code"], reason: flags.reason,
      confirmation: booleanFlag(flags["confirm-local-evidence"])
        ? "local-evidence-revocation-confirmed" : null
    }), json);
  }

  if (command === "learn-review") {
    return output(await reviewLearning({
      root: flags.root || process.cwd(), id: positional[0], decision: flags.decision,
      reason: flags.reason, confirmedByUser: booleanFlag(flags["confirmed-by-user"])
    }), json);
  }

  if (command === "learn-context") {
    return output(await learningContext({
      root: positional[0] || process.cwd(), includePrivate: booleanFlag(flags["include-private"]),
      groupId: flags.group || null,
      scope: hasLearningScope(flags) ? learningScope(flags) : null,
      kinds: flags.kind ? String(flags.kind).split(",").filter(Boolean) : null,
      subjectIds: flags.subject ? String(flags.subject).split(",").filter(Boolean) : null,
      maxItems: flags["max-items"] === undefined ? null : Number(flags["max-items"])
    }), json);
  }

  if (command === "learn-evaluate") {
    return output(await evaluateLearning({ root: positional[0] || process.cwd() }), json);
  }

  if (command === "learn-evaluator-register") {
    return output(await registerLearningEvaluator({
      root: flags.root || process.cwd(), id: positional[0], principalDigest: flags["principal-digest"],
      confirmLocalEvaluator: booleanFlag(flags["confirm-local-evaluator"])
    }), json);
  }

  if (command === "learn-evaluator-revoke") {
    return output(await revokeLearningEvaluator({
      root: flags.root || process.cwd(), id: positional[0], reason: flags.reason,
      confirmLocalEvaluator: booleanFlag(flags["confirm-local-evaluator"])
    }), json);
  }

  if (command === "learn-evaluation") {
    return output(await registerLearningEvaluation({
      root: flags.root || process.cwd(), id: positional[0], learningId: flags.learning,
      scope: learningScope(flags), metric: { name: flags.metric, direction: flags.direction },
      benchmark: {
        taskDigest: flags["task-digest"], datasetDigest: flags["dataset-digest"],
        protocolDigest: flags["protocol-digest"], minCases: Number(flags["min-cases"])
      },
      evaluatorIds: String(flags.evaluators || "").split(",").filter(Boolean),
      evaluatorRoots: evaluatorRootsFlag(flags["evaluator-roots"]),
      expiresAt: flags["expires-at"] || null,
      confirmLocalEvaluation: booleanFlag(flags["confirm-local-evaluation"])
    }), json);
  }

  if (command === "learn-revalidation-start") {
    return output(await beginLearningRevalidation({
      root: flags.root || process.cwd(), learningId: positional[0],
      confirmLocalValidation: booleanFlag(flags["confirm-local-validation"])
    }), json);
  }

  if (command === "learn-revalidate") {
    const measurements = String(flags.measurements || "").split(",").filter(Boolean);
    const applications = String(flags.applications || "").split(",").filter(Boolean);
    const deliveries = String(flags.deliveries || "").split(",").filter(Boolean);
    if (!measurements.length || measurements.length !== applications.length || measurements.length !== deliveries.length) {
      throw new Error("revalidation requires equally sized measurement, application, and delivery lists");
    }
    return output(await renewLearningValidation({
      root: flags.root || process.cwd(), learningId: positional[0],
      evidence: measurements.map((measurementId, index) => ({ measurementId,
        applicationId: applications[index], deliveryId: deliveries[index] })),
      confirmLocalValidation: booleanFlag(flags["confirm-local-validation"])
    }), json);
  }

  if (command === "learn-measurement") {
    return output(await recordLearningMeasurement({
      root: flags.root || process.cwd(), id: positional[0], learningId: flags.learning,
      evaluationId: flags.evaluation, phase: flags.phase, scope: learningScope(flags),
      metric: {
        name: flags.metric, direction: flags.direction, value: Number(flags.value),
        blockingDefects: Number(flags["blocking-defects"] ?? 0)
      },
      measurement: {
        kind: flags.measurement || "objective", evaluatorId: flags.evaluator,
        runId: flags.run, sourceDigest: flags["source-digest"]
      },
      coverage: { datasetDigest: flags["dataset-digest"], caseCount: Number(flags["case-count"]) },
      measuredAt: flags.at,
      confirmLocalMeasurement: booleanFlag(flags["confirm-local-measurement"])
    }), json);
  }

  if (command === "learn-measurement-revoke") {
    return output(await revokeLearningMeasurement({
      root: flags.root || process.cwd(), measurementId: positional[0], reasonCode: flags["reason-code"],
      reason: flags.reason,
      confirmation: booleanFlag(flags["confirm-local-measurement-revocation"])
        ? "local-measurement-revocation-confirmed" : null
    }), json);
  }

  if (command === "learn-evaluation-revoke") {
    return output(await revokeLearningEvaluation({
      root: flags.root || process.cwd(), evaluationId: positional[0], reasonCode: flags["reason-code"],
      reason: flags.reason,
      confirmation: booleanFlag(flags["confirm-local-evaluation-revocation"])
        ? "local-evaluation-revocation-confirmed" : null
    }), json);
  }

  if (command === "learn-validation-revoke") {
    return output(await revokeLearningValidation({
      root: flags.root || process.cwd(), validationLeaseId: positional[0], reasonCode: flags["reason-code"],
      reason: flags.reason,
      confirmation: booleanFlag(flags["confirm-local-validation-revocation"])
        ? "local-validation-revocation-confirmed" : null
    }), json);
  }

  if (command === "learn-application-revoke") {
    return output(await revokeLearningApplication({
      root: flags.root || process.cwd(), applicationId: positional[0], reasonCode: flags["reason-code"],
      reason: flags.reason,
      confirmation: booleanFlag(flags["confirm-local-application-revocation"])
        ? "local-application-revocation-confirmed" : null
    }), json);
  }

  if (command === "learn-delivery-revoke") {
    return output(await revokeLearningDelivery({
      root: flags.root || process.cwd(), deliveryId: positional[0], reasonCode: flags["reason-code"],
      reason: flags.reason,
      confirmation: booleanFlag(flags["confirm-local-delivery-revocation"])
        ? "local-delivery-revocation-confirmed" : null
    }), json);
  }

  if (command === "learn-outcome-revoke") {
    return output(await revokeLearningOutcome({
      root: flags.root || process.cwd(), outcomeId: positional[0], reasonCode: flags["reason-code"],
      reason: flags.reason,
      confirmation: booleanFlag(flags["confirm-local-outcome-revocation"])
        ? "local-outcome-revocation-confirmed" : null
    }), json);
  }

  if (command === "learn-outcome") {
    const lineage = flags["measurement-receipt"] || null;
    return output(await recordLearningOutcome({
      root: flags.root || process.cwd(), learningId: positional[0], id: flags.id,
      evaluationId: flags.evaluation, measurementReceiptId: lineage,
      applicationId: flags.application || null, deliveryId: flags.delivery || null,
      ...(lineage ? {} : { phase: flags.phase, scope: learningScope(flags), metric: {
        name: flags.metric, direction: flags.direction, value: Number(flags.value),
        blockingDefects: Number(flags["blocking-defects"] ?? 0)
      },
      measurement: {
        kind: flags.measurement || "objective", evaluatorId: flags.evaluator,
        sourceDigest: flags["source-digest"] || null
      },
      coverage: {
        datasetDigest: flags["dataset-digest"],
        caseCount: Number(flags["case-count"])
      },
      measuredAt: flags.at })
    }), json);
  }

  if (command === "learn-status") {
    return output(await learningOutcomeStatus({
      root: positional[0] || process.cwd(), scope: hasLearningScope(flags) ? learningScope(flags) : null
    }), json);
  }

  if (command === "learn-delivery-purge") {
    return output(await purgeStaleLearningApplications({
      root: positional[0] || process.cwd(),
      confirmation: booleanFlag(flags["confirm-local-purge"]) ? "local-user-purge-confirmed" : null
    }), json);
  }

  if (command === "learn-measurement-purge") {
    return output(await purgeStaleLearningMeasurements({
      root: positional[0] || process.cwd(),
      confirmation: booleanFlag(flags["confirm-local-purge"]) ? "local-user-purge-confirmed" : null
    }), json);
  }

  if (command === "learn-rollback") {
    return output(await rollbackLearning({
      root: flags.root || process.cwd(), id: positional[0], reason: flags.reason
    }), json);
  }

  if (command === "learn-delete") {
    return output(await deleteLearning({ root: flags.root || process.cwd(), id: positional[0] }), json);
  }

  if (command === "learn-config") {
    const root = positional[0] || process.cwd();
    const config = {};
    if (flags["auto-promote"] !== undefined) config.autoPromote = booleanFlag(flags["auto-promote"]);
    if (flags["min-confidence"] !== undefined) config.minConfidence = Number(flags["min-confidence"]);
    if (flags["min-evidence"] !== undefined) config.minEvidence = Number(flags["min-evidence"]);
    if (flags["max-items"] !== undefined) config.maxContextItems = Number(flags["max-items"]);
    if (flags["min-outcomes"] !== undefined) config.minOutcomeReceipts = Number(flags["min-outcomes"]);
    if (flags["min-improvement"] !== undefined) config.minImprovement = Number(flags["min-improvement"]);
    if (flags["regression-tolerance"] !== undefined) config.regressionTolerance = Number(flags["regression-tolerance"]);
    if (flags["outcome-max-age-days"] !== undefined) config.outcomeMaxAgeDays = Number(flags["outcome-max-age-days"]);
    if (flags["canary-receipts"] !== undefined) config.canaryReceipts = Number(flags["canary-receipts"]);
    if (flags["canary-ttl-days"] !== undefined) config.canaryTtlDays = Number(flags["canary-ttl-days"]);
    if (flags["initial-trial-outcome-timeout-minutes"] !== undefined) {
      config.initialTrialOutcomeTimeoutMinutes = Number(flags["initial-trial-outcome-timeout-minutes"]);
    }
    if (!Object.keys(config).length) return output((await loadLearning(root)).learning.config, json);
    return output(await configureLearning({ root, config }), json);
  }

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
      nextSafeStep: flags["next-step"], deadline: flags.deadline || null,
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

  if (command === "share-init") {
    return output(await initDirectoryAdapter({
      root: flags.root || process.cwd(), directory: positional[0], scopeId: flags.scope,
      adapterId: flags.adapter, signerId: flags.signer || null,
      confirmation: booleanFlag(flags["confirm-local-share"]) ? "local-share-confirmed" : null
    }), json);
  }

  if (command === "share-keygen") {
    return output(await generateSigningIdentity({
      root: flags.root || process.cwd(), signerId: positional[0], rotate: booleanFlag(flags.rotate),
      publicOut: flags["public-out"] || null,
      confirmation: booleanFlag(flags["confirm-local-share"]) ? "local-share-confirmed" : null
    }), json);
  }

  if (command === "share-signers") {
    return output(await listSigningIdentities({ root: positional[0] || process.cwd() }), json);
  }

  if (command === "share-trust") {
    return output(await trustSigner({
      root: flags.root || process.cwd(), publicIdentityPath: positional[0],
      confirmation: booleanFlag(flags["confirm-local-share"]) ? "local-share-confirmed" : null
    }), json);
  }

  if (command === "share-trust-revoke") {
    return output(await revokeTrustedSigner({
      root: flags.root || process.cwd(), keyId: positional[0], reason: flags.reason,
      confirmation: booleanFlag(flags["confirm-local-share"]) ? "local-share-confirmed" : null
    }), json);
  }

  if (command === "share-trust-list") {
    return output(await trustedSignerContext({
      root: positional[0] || process.cwd(), includeRevoked: booleanFlag(flags["include-revoked"])
    }), json);
  }

  if (command === "share-publish") {
    return output(await publishLearning({
      root: flags.root || process.cwd(), directory: positional[0], learningId: flags.learning,
      eventId: flags.id, supersedesEventId: flags.supersedes || null, signerId: flags.signer || null,
      confirmation: booleanFlag(flags["confirm-local-share"]) ? "local-share-confirmed" : null
    }), json);
  }

  if (command === "share-pull") {
    return output(await pullShared({
      root: flags.root || process.cwd(), directory: positional[0],
      requireAuthenticated: booleanFlag(flags["require-authenticated"])
    }), json);
  }

  if (command === "share-snapshot-export") {
    return output(await exportHttpsSnapshot({
      root: flags.root || process.cwd(), directory: positional[0], output: flags.out,
      snapshotId: flags.id,
      confirmation: booleanFlag(flags["confirm-local-share"]) ? "local-share-confirmed" : null
    }), json);
  }

  if (command === "share-https-publish") {
    return output(await publishHttpsSnapshot({
      root: flags.root || process.cwd(), directory: positional[0], baseUrl: flags.base,
      snapshotId: flags.id, tokenEnv: flags["token-env"] || null,
      timeoutMs: Number(flags["timeout-ms"] ?? 10000),
      allowPrivateNetwork: booleanFlag(flags["allow-private-network"]),
      confirmation: booleanFlag(flags["confirm-local-share"]) ? "local-share-confirmed" : null
    }), json);
  }

  if (command === "share-https-pull") {
    return output(await pullHttpsSnapshot({
      root: flags.root || process.cwd(), url: positional[0], tokenEnv: flags["token-env"] || null,
      timeoutMs: Number(flags["timeout-ms"] ?? 10000),
      allowPrivateNetwork: booleanFlag(flags["allow-private-network"]),
      confirmation: booleanFlag(flags["confirm-local-share"]) ? "local-share-confirmed" : null
    }), json);
  }

  if (command === "share-feed-publish") {
    return output(await publishHttpsFeed({
      root: flags.root || process.cwd(), directory: positional[0], baseUrl: flags.base,
      feedId: flags.feed, signerId: flags.signer, snapshotId: flags.id,
      tokenEnv: flags["token-env"] || null, timeoutMs: Number(flags["timeout-ms"] ?? 10000),
      allowPrivateNetwork: booleanFlag(flags["allow-private-network"]),
      confirmation: booleanFlag(flags["confirm-local-share"]) ? "local-share-confirmed" : null
    }), json);
  }

  if (command === "share-feed-pull") {
    return output(await pullHttpsFeed({
      root: flags.root || process.cwd(), baseUrl: flags.base, feedId: flags.feed,
      tokenEnv: flags["token-env"] || null, timeoutMs: Number(flags["timeout-ms"] ?? 10000),
      allowPrivateNetwork: booleanFlag(flags["allow-private-network"]),
      confirmation: booleanFlag(flags["confirm-local-share"]) ? "local-share-confirmed" : null
    }), json);
  }

  if (command === "share-feed-state") {
    return output(await loadHttpsFeedState(positional[0] || process.cwd()), json);
  }

  if (command === "share-peer-serve") {
    await servePeerOnce({
      root: flags.root || process.cwd(), directory: positional[0], signerId: flags.signer,
      input: process.stdin, output: process.stdout,
      timeoutMs: Number(flags["timeout-ms"] ?? 10000),
      confirmation: booleanFlag(flags["confirm-local-share"]) ? "local-share-confirmed" : null
    });
    return;
  }

  if (command === "share-peer-pull") {
    return output(await pullPeerCommand({
      root: flags.root || process.cwd(), commandJson: flags["command-json"],
      timeoutMs: Number(flags["timeout-ms"] ?? 10000),
      maxBytes: Number(flags["max-bytes"] ?? 22 * 1024 * 1024),
      confirmation: booleanFlag(flags["confirm-local-share"]) ? "local-share-confirmed" : null
    }), json);
  }

  if (command === "share-sqlite-init") {
    return output(await initSqliteAdapter({
      root: flags.root || process.cwd(), directory: positional[0], database: flags.database,
      confirmation: booleanFlag(flags["confirm-local-share"]) ? "local-share-confirmed" : null
    }), json);
  }

  if (command === "share-sqlite-publish") {
    return output(await publishSqliteSnapshot({
      root: flags.root || process.cwd(), directory: positional[0], database: flags.database,
      snapshotId: flags.id,
      confirmation: booleanFlag(flags["confirm-local-share"]) ? "local-share-confirmed" : null
    }), json);
  }

  if (command === "share-sqlite-inspect") {
    return output(await inspectSqliteAdapter({
      root: flags.root || process.cwd(), database: flags.database
    }), json);
  }

  if (command === "share-sqlite-pull") {
    return output(await pullSqliteSnapshot({
      root: flags.root || process.cwd(), database: flags.database
    }), json);
  }

  if (command === "share-inbox") {
    return output(await sharedInbox({ root: positional[0] || process.cwd(), status: flags.status || "pending" }), json);
  }

  if (command === "share-review") {
    return output(await reviewShared({
      root: flags.root || process.cwd(), id: positional[0], decision: flags.decision,
      reason: flags.reason, confirmedByUser: booleanFlag(flags["confirmed-by-user"])
    }), json);
  }

  if (command === "share-context") {
    return output(await sharedContext({
      root: positional[0] || process.cwd(), scopeId: flags.scope || null, groupId: flags.group || null,
      includePrivate: booleanFlag(flags["include-private"]),
      kinds: flags.kind ? String(flags.kind).split(",").filter(Boolean) : null,
      subjectIds: flags.subject ? String(flags.subject).split(",").filter(Boolean) : null,
      maxItems: flags["max-items"] === undefined ? null : Number(flags["max-items"])
    }), json);
  }

  if (command === "share-rollback") {
    return output(await rollbackShared({
      root: flags.root || process.cwd(), id: positional[0], reason: flags.reason
    }), json);
  }

  if (command === "share-delete") {
    return output(await deleteShared({
      root: flags.root || process.cwd(), id: positional[0],
      confirmation: booleanFlag(flags["confirm-local-share"]) ? "local-share-confirmed" : null
    }), json);
  }

  if (command === "share-config") {
    return output(await configureSharing({
      root: positional[0] || process.cwd(), maxContextItems: Number(flags["max-items"])
    }), json);
  }

  if (command === "doctor") {
    let hostIntegration;
    try {
      hostIntegration = await checkHosts(fileURLToPath(new URL("..", import.meta.url)));
    } catch (error) {
      hostIntegration = { ok: false, error: error.message };
    }
    let sourceResolution = null;
    let orphanScan = null;
    const sourceHost = flags.host || process.env.AGENTSPINE_HOST;
    if (["claude", "codex"].includes(sourceHost)) {
      try {
        const resolved = await resolveHostSourceCatalog({ host: sourceHost, cwd: flags.cwd || process.cwd() });
        sourceResolution = resolved.diagnostics;
        if (booleanFlag(flags["offline-memory-orphans"])) {
          if (sourceHost !== "claude" || !resolved.memoryRoot) throw new Error("offline memory orphan scan requires a resolved Claude project-memory root");
          orphanScan = await scanIndexedMemoryOrphans(resolved.memoryRoot);
        }
      }
      catch (error) { sourceResolution = { status: "failed-closed", reason: error.message }; }
    }
    let preflight;
    try { preflight = await preflightStatus(); }
    catch (error) { preflight = { status: "failed-closed", error: error.message }; }
    let learningOutcomes;
    try {
      const status = await learningOutcomeStatus({ root: positional[0] || process.cwd() });
      const unboundAfterReceipts = status.records.reduce((sum, item) => sum + item.afterReceipts - item.boundAfterReceipts, 0);
      const undeliveredAfterReceipts = status.records.reduce((sum, item) => sum + item.afterReceipts - item.deliveredAfterReceipts, 0);
      const stalePendingApplications = status.records.reduce((sum, item) => sum + item.stalePendingApplications, 0);
      const totalOutcomeReceipts = status.records.reduce((sum, item) => sum + item.beforeReceipts + item.afterReceipts, 0);
      const plannedOutcomeReceipts = status.records.reduce((sum, item) => sum + item.plannedOutcomeReceipts, 0);
      const coverageBoundReceipts = status.records.reduce((sum, item) => sum + item.coverageBoundReceipts, 0);
      const legacyCoverageReceipts = status.records.reduce((sum, item) => sum + item.legacyCoverageReceipts, 0);
      const provenanceBoundReceipts = status.records.reduce((sum, item) => sum + item.provenanceBoundReceipts, 0);
      const legacyProvenanceReceipts = status.records.reduce((sum, item) => sum + item.legacyProvenanceReceipts, 0);
      const measurementReceipts = status.records.reduce((sum, item) => sum + item.measurementReceipts, 0);
      const measurementLineageReceipts = status.records.reduce((sum, item) => sum + item.measurementLineageReceipts, 0);
      const consumedMeasurementReceipts = status.records.reduce((sum, item) => sum + item.consumedMeasurementReceipts, 0);
      const staleUnconsumedMeasurements = status.records.reduce((sum, item) => sum + item.staleUnconsumedMeasurements, 0);
      const lineageBoundReceipts = status.records.reduce((sum, item) => sum + item.lineageBoundReceipts, 0);
      const pairedOutcomeReceipts = status.records.reduce((sum, item) => sum + item.pairedOutcomeReceipts, 0);
      const pairedEvaluatorPairs = status.records.reduce((sum, item) => sum + item.pairedEvaluatorPairs, 0);
      const evaluatorRootBoundReceipts = status.records.reduce((sum, item) => sum + item.evaluatorRootBoundReceipts, 0);
      const independentEvaluatorRoots = status.records.reduce((sum, item) => sum + item.independentEvaluatorRoots, 0);
      const evaluatorRegistryContracts = status.records.reduce((sum, item) => sum + item.evaluatorRegistryContracts, 0);
      const inactiveEvaluatorRegistryContracts = status.records.reduce((sum, item) => sum + item.inactiveEvaluatorRegistryContracts, 0);
      const currentValidatedLessons = status.records.filter((item) => item.validationLeaseStatus === "current-validated").length;
      const staleValidatedLessons = status.records.filter((item) => item.validationLeaseStatus === "stale-validated").length;
      const unprovenValidatedLessons = status.records.filter((item) => item.validationLeaseStatus === "unproven-validated").length;
      const revokedValidatedLessons = status.records.filter((item) => item.validationLeaseStatus === "revoked-validated").length;
      const renewedValidationLeases = status.records.filter((item) =>
        ["agentspine.learning-validation/v2", "agentspine.learning-validation/v3",
          "agentspine.learning-validation/v4", "agentspine.learning-validation/v5"].includes(item.validationLeaseSchema)).length;
      const fixedCohortValidationLeases = status.records.filter((item) =>
        ["agentspine.learning-validation/v3", "agentspine.learning-validation/v4",
          "agentspine.learning-validation/v5"]
          .includes(item.validationLeaseSchema)).length;
      const admissionBoundValidationLeases = status.records.filter((item) =>
        ["agentspine.learning-validation/v4", "agentspine.learning-validation/v5"]
          .includes(item.validationLeaseSchema)).length;
      const trialBoundValidationLeases = status.records.filter((item) =>
        item.validationLeaseSchema === "agentspine.learning-validation/v5").length;
      const activeRevalidations = status.records.filter((item) => item.revalidationStatus === "active").length;
      const staleRevalidations = status.records.filter((item) => item.revalidationStatus === "stale").length;
      const fixedCohortRevalidations = status.records.filter((item) =>
        item.revalidationStatus === "active"
          && ["first-completed-turns", "first-admitted-turns",
            "first-admitted-trials"].includes(item.revalidationSelectionMode)).length;
      const admissionBoundRevalidations = status.records.filter((item) =>
        item.revalidationStatus === "active" && ["first-admitted-turns", "first-admitted-trials"]
          .includes(item.revalidationSelectionMode)).length;
      const trialBoundRevalidations = status.records.filter((item) =>
        item.revalidationStatus === "active" && item.revalidationSelectionMode === "first-admitted-trials").length;
      const requiredRevalidationDeliveries = status.records.reduce((sum, item) =>
        sum + item.revalidationRequiredDeliveries, 0);
      const completedRevalidationDeliveries = status.records.reduce((sum, item) =>
        sum + item.revalidationCompletedDeliveries, 0);
      const admittedRevalidationApplications = status.records.reduce((sum, item) =>
        sum + item.revalidationAdmittedApplications, 0);
      const initialTrialContracts = status.records.filter((item) => item.initialTrialMode === "first-admitted-trials").length;
      const requiredInitialTrials = status.records.reduce((sum, item) => sum + item.initialTrialSlots, 0);
      const admittedInitialApplications = status.records.reduce((sum, item) =>
        sum + item.initialAdmittedApplications, 0);
      const completedInitialDeliveries = status.records.reduce((sum, item) =>
        sum + item.initialCompletedDeliveries, 0);
      const incompleteInitialAdmissions = status.records.reduce((sum, item) =>
        sum + item.incompleteInitialAdmissions, 0);
      const targetBoundEvaluationContracts = status.records.reduce((sum, item) =>
        sum + item.targetBoundEvaluationContracts, 0);
      const targetBoundApplications = status.records.reduce((sum, item) =>
        sum + item.targetBoundApplications, 0);
      const deadlineBoundEvaluationContracts = status.records.reduce((sum, item) =>
        sum + item.deadlineBoundEvaluationContracts, 0);
      const deadlineBoundApplications = status.records.reduce((sum, item) =>
        sum + item.deadlineBoundApplications, 0);
      const trialFailureReceipts = status.records.reduce((sum, item) => sum + item.trialFailureReceipts, 0);
      const evaluationRevocationReceipts = status.records.reduce((sum, item) => sum + item.evaluationRevocationReceipts, 0);
      const validationRevocationReceipts = status.records.reduce((sum, item) => sum + item.validationRevocationReceipts, 0);
      const evidenceRevocationReceipts = status.records.reduce((sum, item) => sum + item.evidenceRevocationReceipts, 0);
      const measurementRevocationReceipts = status.records.reduce((sum, item) => sum + item.measurementRevocationReceipts, 0);
      const applicationRevocationReceipts = status.records.reduce((sum, item) => sum + item.applicationRevocationReceipts, 0);
      const deliveryRevocationReceipts = status.records.reduce((sum, item) => sum + item.deliveryRevocationReceipts, 0);
      const outcomeRevocationReceipts = status.records.reduce((sum, item) => sum + item.outcomeRevocationReceipts, 0);
      const deliveryTimeoutFailures = status.records.reduce((sum, item) => sum + item.deliveryTimeoutFailures, 0);
      const outcomeTimeoutFailures = status.records.reduce((sum, item) => sum + item.outcomeTimeoutFailures, 0);
      const pendingInitialOutcomes = status.records.reduce((sum, item) => sum + item.pendingInitialOutcomes, 0);
      const staleInitialOutcomes = status.records.reduce((sum, item) => sum + item.staleInitialOutcomes, 0);
      const unplannedOutcomeReceipts = totalOutcomeReceipts - plannedOutcomeReceipts;
      learningOutcomes = {
        status: status.records.some((item) => ["stale", "revoked", "revoked-evaluation", "revoked-validation", "revoked-evidence", "revoked-measurement", "revoked-application", "revoked-delivery", "revoked-outcome", "unproven", "failed-trial"].includes(item.canaryStatus))
          || unboundAfterReceipts > 0 || undeliveredAfterReceipts > 0 || unplannedOutcomeReceipts > 0
          || stalePendingApplications > 0 || staleUnconsumedMeasurements > 0
          || inactiveEvaluatorRegistryContracts > 0 || staleRevalidations > 0
          || staleInitialOutcomes > 0 ? "degraded" : "healthy",
        candidates: status.records.length,
        activeCanaries: status.records.filter((item) => item.canaryStatus === "active").length,
        validatedCanaries: status.records.filter((item) => item.canaryStatus === "validated").length,
        staleCanaries: status.records.filter((item) => item.canaryStatus === "stale").length,
        awaitingApplication: status.records.filter((item) => item.canaryStatus === "active" && item.applicationReceipts === 0).length,
        applicationReceipts: status.records.reduce((sum, item) => sum + item.applicationReceipts, 0),
        deliveryReceipts: status.records.reduce((sum, item) => sum + item.deliveryReceipts, 0),
        pendingApplications: status.records.reduce((sum, item) => sum + item.pendingApplications, 0),
        stalePendingApplications,
        evaluationContracts: status.records.reduce((sum, item) => sum + item.evaluationContracts, 0),
        targetBoundEvaluationContracts,
        targetBoundApplications,
        deadlineBoundEvaluationContracts,
        deadlineBoundApplications,
        trialFailureReceipts,
        evaluationRevocationReceipts,
        validationRevocationReceipts,
        evidenceRevocationReceipts,
        measurementRevocationReceipts,
        applicationRevocationReceipts,
        deliveryRevocationReceipts,
        outcomeRevocationReceipts,
        deliveryTimeoutFailures,
        outcomeTimeoutFailures,
        pendingInitialOutcomes,
        staleInitialOutcomes,
        plannedOutcomeReceipts,
        coverageBoundReceipts,
        legacyCoverageReceipts,
        provenanceBoundReceipts,
        legacyProvenanceReceipts,
        measurementReceipts,
        measurementLineageReceipts,
        consumedMeasurementReceipts,
        staleUnconsumedMeasurements,
        lineageBoundReceipts,
        pairedOutcomeReceipts,
        pairedEvaluatorPairs,
        evaluatorRootBoundReceipts,
        independentEvaluatorRoots,
        activeEvaluatorRoots: status.evaluatorRegistry.active,
        revokedEvaluatorRoots: status.evaluatorRegistry.revoked,
        evaluatorRegistryBindings: status.evaluatorRegistry.bindings,
        validationLeases: status.evaluatorRegistry.validationLeases,
        renewedValidationLeases,
        fixedCohortValidationLeases,
        admissionBoundValidationLeases,
        trialBoundValidationLeases,
        initialTrialContracts,
        requiredInitialTrials,
        admittedInitialApplications,
        completedInitialDeliveries,
        incompleteInitialAdmissions,
        activeRevalidations,
        staleRevalidations,
        fixedCohortRevalidations,
        admissionBoundRevalidations,
        trialBoundRevalidations,
        requiredRevalidationDeliveries,
        admittedRevalidationApplications,
        completedRevalidationDeliveries,
        currentValidatedLessons,
        staleValidatedLessons,
        unprovenValidatedLessons,
        revokedValidatedLessons,
        evaluatorRegistryContracts,
        inactiveEvaluatorRegistryContracts,
        unplannedOutcomeReceipts,
        boundAfterReceipts: status.records.reduce((sum, item) => sum + item.boundAfterReceipts, 0),
        unboundAfterReceipts,
        deliveredAfterReceipts: status.records.reduce((sum, item) => sum + item.deliveredAfterReceipts, 0),
        undeliveredAfterReceipts,
        contradictions: status.records.filter((item) => item.conflictsWith.length > 0).length,
        authority: "context-only"
      };
    } catch (error) { learningOutcomes = { status: "failed-closed", error: error.message, authority: "context-only" }; }
    const result = {
      ok: Number(process.versions.node.split(".")[0]) >= 20 && hostIntegration.ok
        && (!sourceResolution || sourceResolution.status === "loaded")
        && learningOutcomes.status !== "failed-closed",
      version: VERSION,
      node: process.versions.node,
      platform: process.platform,
      preservationMode: "read-only-source-overlay",
      stateDirectory: process.env.AGENTSPINE_STATE_DIR || "platform-default",
      hostIntegration,
      sourceResolution,
      orphanScan,
      preflight,
      learningOutcomes
    };
    output(result, json);
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (command === "audit") {
    const result = await runAudit(positional[0] || process.cwd(), { host: flags.host || process.env.AGENTSPINE_HOST || null });
    output(result, json);
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (command === "mcp") {
    const { startMcpServer } = await import("./mcp.js");
    startMcpServer();
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

if (isMainModule(import.meta.url)) {
  run().catch((error) => {
    process.stderr.write(`AgentSpine: ${error.message}\n`);
    process.exitCode = 1;
  });
}
