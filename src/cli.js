import { resolve } from "node:path";
import { scanAndSave, verifyCatalog } from "./lib/catalog.js";
import { readDocument, resolveContext } from "./lib/context.js";
import { runAudit } from "./lib/audit.js";
import {
  attentionContext, configureAttention, deleteAttention, loadAttention,
  recordActivity, resolveAttention, upsertAttention
} from "./lib/attention.js";
import {
  addLearningEvidence, configureLearning, deleteLearning, evaluateLearning,
  learningContext, loadLearning, proposeLearning, reviewLearning, rollbackLearning
} from "./lib/learning.js";
import {
  checkDelegation, createTask, deleteTask, grantDelegation, loadDelegationPolicy,
  revokeDelegation, taskContext, updateTask
} from "./lib/coordination.js";
import {
  configureSharing, deleteShared, initDirectoryAdapter, publishLearning, pullShared,
  reviewShared, rollbackShared, sharedContext, sharedInbox
} from "./lib/sharing.js";
import {
  generateSigningIdentity, listSigningIdentities, revokeTrustedSigner,
  trustedSignerContext, trustSigner
} from "./lib/authentication.js";
import {
  annotateDocument, linkDocuments, linkEntities,
  relationshipContext, upsertEntity
} from "./lib/graph.js";

const VERSION = "0.1.0";

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

function help() {
  return `AgentSpine ${VERSION}

Usage:
  agentspine scan [root] [--json]
  agentspine context [root] [--cwd path] [--host codex|claude|generic] [--max-bytes n] [--json]
  agentspine read <relative-path> [--root path] [--offset n] [--length n] [--json]
  agentspine verify [root] [--json]
  agentspine link <from.md> <to.md> --relation related [--reason text] [--confidence 0.8]
  agentspine annotate <path.md> --layer soul [--reason text] [--confidence 0.8]
  agentspine entity <id> --kind person [--name text] [--privacy private]
  agentspine relate <from> <to> --relation works-with [--privacy private]
  agentspine relationships <entity-id> [--include-private] [--json]
  agentspine attention [root] [--group id] [--include-private] [--focus-active] [--mark-presented]
  agentspine attention-add [id] --kind promise --summary text [--entity id] [--group id] [--due date]
  agentspine attention-resolve <id> [--status completed|dismissed|open]
  agentspine attention-touch <entity-id> [--kind interaction] [--at date]
  agentspine attention-delete <signal-id>
  agentspine attention-purge <entity-id>
  agentspine attention-config [root] [--enabled true|false] [--quiet-start 22 --quiet-end 7 --utc-offset 120]
  agentspine learn-propose [id] --kind preference --claim text --evidence text
  agentspine learn-evidence <id> --summary text [--type interaction] [--source path.md]
  agentspine learn-review <id> --decision accept|reject --reason text [--confirmed-by-user]
  agentspine learn-context [root] [--group id] [--include-private] [--kind preference,goal]
  agentspine learn-evaluate [root]
  agentspine learn-rollback <id> --reason text
  agentspine learn-delete <id>
  agentspine learn-config [root] [--auto-promote true|false] [--min-confidence 0.85]
  agentspine delegation-grant <actor-id> --actions assign,manage --targets agent:id --reason text [--confirm-local-policy]
  agentspine delegation-revoke <grant-id> --reason text [--confirm-local-policy]
  agentspine delegation-check <actor-id> --action assign [--target agent:id]
  agentspine delegation-policy [root]
  agentspine task-create [id] --actor id --title text [--assignee id] [--kind task|open-thread|handoff] [--privacy private|shared|group]
  agentspine task-update <id> --actor id [--status in-progress] [--assignee id|--unassign]
  agentspine tasks [root] [--assignee id] [--project id] [--include-private] [--group id]
  agentspine task-delete <id> [--confirm-local-policy]
  agentspine share-keygen <signer-id> [--public-out signer.json] [--rotate] [--confirm-local-share]
  agentspine share-signers [root]
  agentspine share-trust <signer.json> [--root path] [--confirm-local-share]
  agentspine share-trust-revoke <key-id> --reason text [--root path] [--confirm-local-share]
  agentspine share-trust-list [root] [--include-revoked]
  agentspine share-init <directory> --scope team:id [--adapter adapter:id] [--signer signer:id] [--confirm-local-share]
  agentspine share-publish <directory> --learning id [--id shared:id] [--signer signer:id] [--supersedes shared:id] [--confirm-local-share]
  agentspine share-pull <directory> [--root path] [--require-authenticated]
  agentspine share-inbox [root] [--status pending|accepted|rejected|superseded|rolled-back]
  agentspine share-review <id> --decision accept|reject --reason text [--confirmed-by-user]
  agentspine share-context [root] [--scope team:id] [--group group:id] [--kind preference,goal]
  agentspine share-rollback <id> --reason text
  agentspine share-delete <id> [--confirm-local-share]
  agentspine share-config [root] --max-items 12
  agentspine audit [root] [--json]
  agentspine doctor [--json]
  agentspine mcp

AgentSpine reads existing Markdown in place. It never rewrites source documents.`;
}

export async function run(argv = process.argv.slice(2)) {
  const { command, flags, positional } = parse(argv);
  const json = Boolean(flags.json);
  if (command === "help" || command === "--help" || command === "-h") return output(help());
  if (command === "version" || command === "--version" || command === "-v") return output(VERSION);

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
      includePrivate: Boolean(flags["include-private"])
    }), json);
  }

  if (command === "attention") {
    return output(await attentionContext({
      root: positional[0] || process.cwd(),
      includePrivate: booleanFlag(flags["include-private"]),
      focusActive: booleanFlag(flags["focus-active"]),
      markPresented: booleanFlag(flags["mark-presented"]),
      groupId: flags.group || null,
      maxItems: flags["max-items"] === undefined ? null : Number(flags["max-items"])
    }), json);
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

  if (command === "attention-purge") {
    return output(await deleteAttention({ root: flags.root || process.cwd(), entityId: positional[0] }), json);
  }

  if (command === "attention-config") {
    const root = positional[0] || process.cwd();
    const config = {};
    if (flags.enabled !== undefined) config.enabled = booleanFlag(flags.enabled);
    if (flags["min-interval-hours"] !== undefined) config.minIntervalHours = Number(flags["min-interval-hours"]);
    if (flags["silence-days"] !== undefined) config.entitySilenceDays = Number(flags["silence-days"]);
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
      kinds: flags.kind ? String(flags.kind).split(",").filter(Boolean) : null,
      subjectIds: flags.subject ? String(flags.subject).split(",").filter(Boolean) : null,
      maxItems: flags["max-items"] === undefined ? null : Number(flags["max-items"])
    }), json);
  }

  if (command === "learn-evaluate") {
    return output(await evaluateLearning({ root: positional[0] || process.cwd() }), json);
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
    if (!Object.keys(config).length) return output((await loadLearning(root)).learning.config, json);
    return output(await configureLearning({ root, config }), json);
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
    const result = {
      ok: Number(process.versions.node.split(".")[0]) >= 20,
      version: VERSION,
      node: process.versions.node,
      platform: process.platform,
      preservationMode: "read-only-source-overlay",
      stateDirectory: process.env.AGENTSPINE_STATE_DIR || "platform-default"
    };
    output(result, json);
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (command === "audit") {
    const result = await runAudit(positional[0] || process.cwd());
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

if (process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href) {
  run().catch((error) => {
    process.stderr.write(`AgentSpine: ${error.message}\n`);
    process.exitCode = 1;
  });
}
