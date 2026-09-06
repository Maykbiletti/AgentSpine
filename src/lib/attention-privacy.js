export function isGroupMember(graph, groupId, entityId) {
  if (!entityId || entityId === groupId) return true;
  return graph.entityEdges.some((edge) => edge.relation === "member-of" && edge.privacy !== "private" && (
    (edge.from === entityId && edge.to === groupId) || (edge.to === entityId && edge.from === groupId)
  ));
}

export function validateGroupScope(privacy, groupId, graph, entityId = null) {
  if (privacy === "group") {
    if (!groupId) throw new Error("group privacy requires groupId");
    const group = graph.entities.find((entity) => entity.id === groupId);
    if (!group || group.kind !== "group") throw new Error(`unknown group entity: ${groupId}`);
    if (!isGroupMember(graph, groupId, entityId)) throw new Error(`entity is not a visible member of group: ${groupId}`);
  } else if (groupId !== null && groupId !== undefined) {
    throw new Error("groupId is only valid with group privacy");
  }
}

export function isQuiet(now, quietHours) {
  if (!quietHours) return false;
  const shifted = new Date(now.getTime() + quietHours.utcOffsetMinutes * 60000);
  const hour = shifted.getUTCHours();
  if (quietHours.start === quietHours.end) return true;
  if (quietHours.start < quietHours.end) return hour >= quietHours.start && hour < quietHours.end;
  return hour >= quietHours.start || hour < quietHours.end;
}

export function recentlyPresented(state, key, now) {
  const value = state.presentations[key];
  if (!value) return false;
  return now.getTime() - new Date(value).getTime() < state.config.minIntervalHours * 3600000;
}

export function groupEntityIds(graph, groupId, includePrivate) {
  const ids = new Set();
  if (!groupId) return ids;
  ids.add(groupId);
  for (const edge of graph.entityEdges) {
    if (edge.relation !== "member-of" || (!includePrivate && edge.privacy === "private")) continue;
    if (edge.to === groupId) ids.add(edge.from);
    if (edge.from === groupId) ids.add(edge.to);
  }
  return ids;
}

export function entityVisible(entity, includePrivate, groupEntities) {
  if (!entity) return true;
  if (entity.privacy === "group") return groupEntities.has(entity.id);
  if (entity.privacy === "private") return includePrivate;
  return true;
}

export function visible(record, entities, includePrivate, groupId, groupEntities) {
  if (!includePrivate && record.privacy === "private") return false;
  if (record.privacy === "group" && (!groupId || record.groupId !== groupId)) return false;
  if (record.privacy === "group" && record.entityId && !groupEntities.has(record.entityId)) return false;
  if (record.entityId) {
    const entity = entities.get(record.entityId);
    if (!entityVisible(entity, includePrivate, groupEntities)) return false;
  }
  return true;
}

export function stricterPrivacy(left, right) {
  const rank = { shared: 0, group: 1, private: 2 };
  return rank[left] >= rank[right] ? left : right;
}

export function looserPrivacy(left, right) {
  const rank = { shared: 0, group: 1, private: 2 };
  return rank[left] <= rank[right] ? left : right;
}
