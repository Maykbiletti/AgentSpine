const stableId = {
  type: "string",
  pattern: "^[a-z][a-z0-9-]{0,31}:[A-Za-z0-9][A-Za-z0-9._/-]{0,190}$"
};

const nullableStableId = { anyOf: [stableId, { type: "null" }] };

export const worldModelTools = [
  {
    name: "record_world_assertion",
    description: "Persist one provenance-bound world, user, relationship, or team assertion outside source files. Measurements and explicit user feedback become context-only facts; model output remains a proposal. Authority predicates are rejected.",
    inputSchema: {
      type: "object", additionalProperties: false,
      required: ["id", "subjectId", "predicate", "value", "evidenceKind", "evidenceId", "evidenceDigest", "observedAt"],
      properties: {
        root: { type: "string" }, id: stableId, subjectId: stableId,
        predicate: { type: "string", pattern: "^[a-z][a-z0-9.-]{0,127}$" },
        value: {},
        evidenceKind: { type: "string", enum: ["objective-measurement", "explicit-user-feedback", "model-suggestion"] },
        evidenceId: stableId,
        evidenceDigest: { type: "string", pattern: "^[a-f0-9]{64}$" },
        observedAt: { type: "string", format: "date-time" },
        expiresAt: { anyOf: [{ type: "string", format: "date-time" }, { type: "null" }] },
        projectId: nullableStableId, groupId: nullableStableId,
        privacy: { type: "string", enum: ["private", "shared", "group"] },
        supersedes: { type: "array", maxItems: 50, uniqueItems: true, items: stableId },
        reason: { type: "string", maxLength: 500 }
      }
    }
  },
  {
    name: "world_context",
    description: "Read durable world context with strict privacy and group filtering. Conflicting or expired assertions are withheld from facts and surfaced as uncertainty; model suggestions remain separate context-only proposals.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        root: { type: "string" }, subjectId: nullableStableId,
        projectId: nullableStableId, groupId: nullableStableId,
        includePrivate: { type: "boolean" }, maxItems: { type: "integer", minimum: 1, maximum: 500 },
        now: { type: "string", format: "date-time" }
      }
    }
  }
];
