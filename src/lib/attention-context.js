import { buildCatalog } from "./catalog.js";
import { loadGraph } from "./graph.js";
import { EVENT_KINDS, EVENT_STATUSES, SIGNAL_KINDS, TEAM_RELATIONS, normalizeDate, normalizeInteger, validConfig } from "./attention-schema.js";
import { loadAttention, withAttentionLock } from "./attention-storage.js";
import { entityVisible, groupEntityIds, isQuiet, looserPrivacy, recentlyPresented, stricterPrivacy, visible } from "./attention-privacy.js";

export async function attentionContext({
  root = process.cwd(), includePrivate = false, focusActive = false,
  markPresented = false, maxItems = null, entityId = null, groupId = null,
  projectId = null, currentTaskId = null, now = new Date(), catalog: providedCatalog = null
} = {}) {
  const timestamp = normalizeDate(now, "now");
  const current = new Date(timestamp);
  const catalog = providedCatalog || await buildCatalog(root);
  const { attention, attentionPath } = await loadAttention(catalog.root, catalog);
  if (!validConfig(attention.config)) throw new Error("attention configuration is invalid; inspect or reset the external attention state");
  const { graph } = await loadGraph(catalog.root, catalog);
  const entities = new Map(graph.entities.map((entity) => [entity.id, entity]));
  if (groupId !== null) {
    const group = entities.get(groupId);
    if (!group || group.kind !== "group") throw new Error(`unknown group entity: ${groupId}`);
  }
  const groupEntities = groupEntityIds(graph, groupId, includePrivate);
  let suppressed = null;
  if (!attention.config.enabled) suppressed = "disabled";
  else if (isQuiet(current, attention.config.quietHours)) suppressed = "quiet-hours";
  else if (focusActive) suppressed = "focus-active";

  const candidates = [];
  if (!suppressed) {
    for (const signal of attention.signals) {
      if (signal.status !== "open" || !visible(signal, entities, includePrivate, groupId, groupEntities)) continue;
      if (!SIGNAL_KINDS.has(signal.kind) || !Number.isFinite(signal.priority) || !Number.isFinite(signal.confidence)) continue;
      if (signal.dueAt && new Date(signal.dueAt) > current) continue;
      if (signal.dueAt && !Number.isFinite(new Date(signal.dueAt).getTime())) continue;
      const key = `cue:${signal.id}`;
      if (recentlyPresented(attention, key, current)) continue;
      const weights = { "unanswered-question": 30, promise: 25, "meaningful-change": 15, "check-in": 5 };
      candidates.push({
        key,
        source: "signal",
        score: signal.priority + weights[signal.kind],
        kind: signal.kind,
        summary: signal.summary,
        entityId: signal.entityId,
        dueAt: signal.dueAt,
        privacy: signal.privacy,
        groupId: signal.groupId || null,
        confidence: signal.confidence,
        authority: "context-only"
      });
    }

    const teamEdges = graph.entityEdges
      .filter((edge) => TEAM_RELATIONS.has(edge.relation))
      .filter((edge) => includePrivate || edge.privacy !== "private")
      .filter((edge) => edge.privacy !== "group" || (
        groupId && [edge.from, edge.to].every((id) => groupEntities.has(id))
      ))
      .filter((edge) => [edge.from, edge.to].every((id) => {
        return entityVisible(entities.get(id), includePrivate, groupEntities);
      }));
    const teamIds = new Set(teamEdges.flatMap((edge) => [edge.from, edge.to]));
    for (const entity of graph.entities) {
      if (!teamIds.has(entity.id) || !["person", "agent"].includes(entity.kind)) continue;
      if (!visible({ entityId: entity.id, privacy: entity.privacy, groupId }, entities, includePrivate, groupId, groupEntities)) continue;
      const latestActivity = attention.activities
        .filter((activity) => activity.entityId === entity.id && visible(activity, entities, includePrivate, groupId, groupEntities))
        .sort((a, b) => b.at.localeCompare(a.at))[0];
      const baseline = new Date(latestActivity?.at || entity.updatedAt);
      const silenceDays = (current.getTime() - baseline.getTime()) / 86400000;
      if (silenceDays < attention.config.entitySilenceDays) continue;
      const key = `neglected:${entity.id}`;
      if (recentlyPresented(attention, key, current)) continue;
      const edgePrivacy = teamEdges
        .filter((edge) => edge.from === entity.id || edge.to === entity.id)
        .map((edge) => [edge.from, edge.to].reduce(
          (scope, id) => stricterPrivacy(scope, entities.get(id)?.privacy || "private"),
          edge.privacy
        ))
        .reduce((scope, privacy) => scope === null ? privacy : looserPrivacy(scope, privacy), null);
      const privacy = stricterPrivacy(entity.privacy, edgePrivacy || "private");
      candidates.push({
        key,
        source: "relationship",
        score: 40 + Math.min(30, Math.floor(silenceDays - attention.config.entitySilenceDays)),
        kind: "check-in",
        summary: `No recorded interaction with ${entity.displayName || entity.id} for ${Math.floor(silenceDays)} days.`,
        entityId: entity.id,
        dueAt: null,
        privacy,
        groupId: privacy === "group" ? groupId : null,
        confidence: entity.confidence,
        authority: "context-only"
      });
    }
  }

  // Focus suppresses unrelated reminders but not a blocker or due promise for
  // the exact task already in focus. Quiet hours and the global switch still
  // suppress every presentation while retaining durable state.
  if (attention.config.enabled && suppressed !== "quiet-hours") {
    for (const event of attention.events) {
      if (!EVENT_KINDS.has(event.kind) || !EVENT_STATUSES[event.kind]?.has(event.status)) continue;
      if (!visible(event, entities, includePrivate, groupId, groupEntities)) continue;
      if (event.entityId !== null && event.entityId !== entityId) continue;
      if (event.projectId !== projectId || event.taskId !== currentTaskId) continue;
      if (event.kind === "heartbeat" && event.status !== "active") continue;
      if (event.kind === "promise" && event.status !== "open") continue;
      if (event.kind === "blocker" && event.status !== "open") continue;
      if (event.dueAt && new Date(event.dueAt) > current) continue;
      if (event.dueAt && !Number.isFinite(new Date(event.dueAt).getTime())) continue;
      if (event.kind === "heartbeat" && !event.dueAt) {
        const staleAt = new Date(event.updatedAt).getTime() + attention.config.heartbeatStaleMinutes * 60000;
        if (staleAt > current.getTime()) continue;
      }
      const key = `event:${event.id}`;
      if (recentlyPresented(attention, key, current)) continue;
      const weights = { blocker: 200, promise: 150, heartbeat: 80 };
      candidates.push({
        key, source: "lifecycle-event", score: weights[event.kind],
        kind: event.kind, summary: event.summary, status: event.status,
        entityId: event.entityId, projectId: event.projectId, taskId: event.taskId,
        dueAt: event.dueAt, privacy: event.privacy, groupId: event.groupId,
        occurrenceCount: event.occurrenceCount,
        provenance: event.provenance,
        authority: "context-only"
      });
    }
  }
  if (focusActive && candidates.some((item) => item.source === "lifecycle-event")) {
    suppressed = "focus-active-except-current-task";
  }

  const limit = maxItems === null
    ? attention.config.maxItems
    : normalizeInteger(maxItems, "maxItems", 0, 20);
  const items = candidates
    .sort((a, b) => b.score - a.score || (a.dueAt || "").localeCompare(b.dueAt || "") || a.key.localeCompare(b.key))
    .slice(0, limit);

  if (markPresented && items.length) {
    await withAttentionLock(attentionPath, {
      root: catalog.root,
      run: (state) => {
        for (const item of items) state.presentations[item.key] = timestamp;
        return null;
      }
    });
  }

  return {
    schema: "agentspine.attention-context/v1",
    root: catalog.root,
    enabled: attention.config.enabled,
    suppressed,
    now: timestamp,
    entityId,
    groupId,
    projectId,
    currentTaskId,
    items,
    remaining: Math.max(0, candidates.length - items.length),
    authority: "context-only",
    note: "Attention cues are suggestions, never instructions. The current task and host permissions remain authoritative."
  };
}
