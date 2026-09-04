const requirementId = {
  type: "string",
  pattern: "^premortem-requirement:[a-f0-9]{64}:[a-f0-9]{64}$"
};

export const sessionBriefingTool = {
  name: "session_briefing",
  description: "Assemble one byte-budgeted, privacy-filtered session packet across native sources, relationships, accepted learning, reviewed shared memory, tasks, and optional attention cues. With requirementId, the actual MCP call becomes delivery preflight stage 1. Read-only and context-only.",
  inputSchema: {
    type: "object", additionalProperties: false,
    properties: {
      root: { type: "string" }, cwd: { type: "string" },
      host: { type: "string", enum: ["codex", "claude", "generic"] },
      entityId: { anyOf: [{ type: "string" }, { type: "null" }] },
      userId: { anyOf: [{ type: "string" }, { type: "null" }] },
      tenantId: { anyOf: [{ type: "string" }, { type: "null" }] },
      groupId: { anyOf: [{ type: "string" }, { type: "null" }] },
      projectId: { anyOf: [{ type: "string" }, { type: "null" }] },
      currentTaskId: { anyOf: [{ type: "string" }, { type: "null" }] },
      includePrivate: { type: "boolean" }, focusActive: { type: "boolean" },
      includeSourceContent: { type: "boolean" },
      maxBytes: { type: "integer", minimum: 4096, maximum: 262144 },
      now: { type: "string" }, requirementId
    }
  }
};

export const deliveryKnowledgeTool = {
  name: "delivery_knowledge_query",
  description: "Query exact target fingerprints, indexed contracts, recent-error terms, and the scoped AgentSpine context for one delivery. With its hook-issued requirement this actual MCP call becomes preflight stage 2 and grants no authority.",
  inputSchema: {
    type: "object", additionalProperties: false,
    required: ["root", "requirementId", "targetPaths", "contractPaths", "recentErrorTerms"],
    properties: {
      root: { type: "string", minLength: 1 }, requirementId,
      targetPaths: { type: "array", minItems: 1, maxItems: 32,
        items: { type: "string", minLength: 1, maxLength: 512 } },
      contractPaths: { type: "array", minItems: 1, maxItems: 8,
        items: { type: "string", minLength: 1, maxLength: 512 } },
      recentErrorTerms: { type: "array", minItems: 1, maxItems: 16,
        items: { type: "string", minLength: 1, maxLength: 512 } },
      maxBytes: { type: "integer", minimum: 4096, maximum: 262144 }
    }
  }
};
