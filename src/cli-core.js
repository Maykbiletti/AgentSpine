import { scanAndSave, verifyCatalog } from "./lib/catalog.js";
import { readDocument, resolveContext } from "./lib/context.js";
import { sessionBriefing } from "./lib/briefing.js";
import { annotateDocument, linkDocuments, linkEntities, relationshipContext, upsertEntity } from "./lib/graph.js";
import { renderAcceptanceReport, runVisibleAcceptance } from "./lib/acceptance.js";
import { booleanFlag, output } from "./cli-common.js";

export const coreCommands = new Set([
  "acceptance",
  "scan",
  "context",
  "briefing",
  "read",
  "verify",
  "link",
  "annotate",
  "entity",
  "relate",
  "relationships"
]);

export async function runCoreCommand({ command, flags, positional, json }) {
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
}
