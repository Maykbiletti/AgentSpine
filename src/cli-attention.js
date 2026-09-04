import { attentionContext, configureAttention, deleteAttention, loadAttention, recordActivity, resolveAttention, upsertAttention } from "./lib/attention.js";
import { booleanFlag, output } from "./cli-common.js";

export const attentionCommands = new Set([
  "attention",
  "attention-events",
  "attention-add",
  "attention-resolve",
  "attention-touch",
  "attention-delete",
  "attention-event-delete",
  "attention-purge",
  "attention-config"
]);

export async function runAttentionCommand({ command, flags, positional, json }) {
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
}
