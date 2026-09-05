const scope = {
  registrationId: { type: "string" }, tenantId: { type: "string" },
  groupId: { anyOf: [{ type: "string" }, { type: "null" }] }
};

export const autonomyTools = [
  {
    name: "project_portfolio",
    description: "Return a bounded, exact-scope overview of explicitly registered projects and at most one deduplicated proactive notice. Context only; grants no authority.",
    inputSchema: { type: "object", additionalProperties: false, required: ["tenantId"],
      properties: { root: { type: "string" }, tenantId: scope.tenantId, groupId: scope.groupId,
        markPresented: { type: "boolean" }, now: { type: "string" } } }
  },
  {
    name: "record_project_observation",
    description: "Record one evidence-classified project observation for an existing exact-scope registration. It may create a context-only notice, never authority.",
    inputSchema: { type: "object", additionalProperties: false,
      required: ["registrationId", "tenantId", "kind", "evidenceClass", "summary", "sourceDigest"],
      properties: { root: { type: "string" }, ...scope,
        kind: { type: "string", enum: ["ci", "error", "idea", "goal", "state"] },
        status: { type: "string", enum: ["open", "passed", "failed", "resolved", "unknown"] },
        evidenceClass: { type: "string", enum: ["objective", "user-feedback", "model-suggestion"] },
        summary: { type: "string", maxLength: 500 }, sourceDigest: { type: "string", pattern: "^[a-f0-9]{64}$" },
        observedAt: { type: "string" }, expiresAt: { anyOf: [{ type: "string" }, { type: "null" }] } } }
  },
  {
    name: "evaluate_autonomy_action",
    description: "Evaluate an action against the configured autonomy level and any separately required exact execution grant. This gate never grants a capability.",
    inputSchema: { type: "object", additionalProperties: false,
      required: ["registrationId", "tenantId", "action"],
      properties: { root: { type: "string" }, ...scope,
        action: { type: "string", enum: ["observe", "advise", "execute", "publish"] },
        capability: { anyOf: [{ type: "string" }, { type: "null" }] }, actorId: { type: "string" },
        jobId: { type: "string" }, taskId: { type: "string" }, targetId: { type: "string" },
        projectId: { type: "string" }, host: { type: "string", enum: ["claude", "codex"] }, now: { type: "string" } } }
  }
];
