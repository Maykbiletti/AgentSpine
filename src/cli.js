import { resolve } from "node:path";
import { scanAndSave, verifyCatalog } from "./lib/catalog.js";
import { readDocument, resolveContext } from "./lib/context.js";
import { runAudit } from "./lib/audit.js";
import {
  attentionContext, configureAttention, deleteAttention, loadAttention,
  recordActivity, resolveAttention, upsertAttention
} from "./lib/attention.js";
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
