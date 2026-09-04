import { VERSION } from "./version.js";
import { isMainModule } from "./lib/runtime.js";
import { deliveryPremortemRecoveryTool, deliveryPremortemTool } from "./lib/mcp-premortem.js";
import { deliveryKnowledgeTool, sessionBriefingTool } from "./lib/mcp-delivery-tools.js";
import { worldModelTools } from "./lib/mcp-world-tools.js";
import { startMcpProtocol } from "./lib/mcp-runtime.js";

const tools = [
  {
    name: "scan",
    description: "Discover and fingerprint Markdown identity, rules, memory, soul, and reference files without modifying them.",
    inputSchema: { type: "object", properties: { root: { type: "string" } } }
  },
  {
    name: "resolve_context",
    description: "Resolve the relevant constitution, soul, memory index, and linked facts for a host and working directory.",
    inputSchema: {
      type: "object",
      properties: {
        root: { type: "string" }, cwd: { type: "string" },
        host: { type: "string", enum: ["codex", "claude", "generic"] },
        maxBytes: { type: "integer", minimum: 0 }, includeContent: { type: "boolean" }
      }
    }
  },
  sessionBriefingTool,
  deliveryKnowledgeTool,
  ...worldModelTools,
  {
    name: "read_document",
    description: "Read a bounded host-indexed Markdown source byte range with verified SHA-256 provenance; no broad home scan.",
    inputSchema: {
      type: "object", required: ["path"],
      properties: {
        root: { type: "string" }, path: { type: "string" },
        host: { type: "string", enum: ["codex", "claude", "generic"] },
        offset: { type: "integer", minimum: 0 }, length: { type: "integer", minimum: 1, maximum: 1048576 }
      }
    }
  },
  {
    name: "verify",
    description: "Compare current Markdown files with the last saved catalog and report additions, removals, or byte changes.",
    inputSchema: { type: "object", properties: { root: { type: "string" } } }
  },
  {
    name: "link_documents",
    description: "Record an agent-inferred relationship between two indexed documents in the external context graph. This never edits either document and never grants authority.",
    inputSchema: {
      type: "object", required: ["from", "to", "relation"],
      properties: {
        root: { type: "string" }, from: { type: "string" }, to: { type: "string" },
        relation: { type: "string", enum: ["loads", "belongs-to", "explains", "supports", "related", "contradicts", "supersedes-in-relevance"] },
        reason: { type: "string" }, confidence: { type: "number", minimum: 0, maximum: 1 }
      }
    }
  },
  {
    name: "annotate_document",
    description: "Store the agent's semantic classification of an indexed document as a reversible overlay annotation, never as a source rewrite.",
    inputSchema: {
      type: "object", required: ["path", "layer"],
      properties: {
        root: { type: "string" }, path: { type: "string" },
        layer: { type: "string", enum: ["soul", "memory-index", "memory-fact", "reference", "project-reference", "identity", "voice", "conduct", "history"] },
        reason: { type: "string" }, confidence: { type: "number", minimum: 0, maximum: 1 }
      }
    }
  },
  {
    name: "upsert_entity",
    description: "Create or update a person, agent, group, channel, or project in the local relationship graph. Authority fields are rejected.",
    inputSchema: {
      type: "object", required: ["id", "kind"],
      properties: {
        root: { type: "string" }, id: { type: "string" },
        kind: { type: "string", enum: ["person", "agent", "group", "channel", "project"] },
        displayName: { type: "string" }, aliases: { type: "array", items: { type: "string" } },
        attributes: { type: "object" }, sourceDocument: { anyOf: [{ type: "string" }, { type: "null" }] },
        confidence: { type: "number", minimum: 0, maximum: 1 },
        privacy: { type: "string", enum: ["private", "shared", "group"] }
      }
    }
  },
  {
    name: "link_entities",
    description: "Record a contextual relationship between known entities. Relationships never grant permissions or delegation authority.",
    inputSchema: {
      type: "object", required: ["from", "to", "relation"],
      properties: {
        root: { type: "string" }, from: { type: "string" }, to: { type: "string" },
        relation: { type: "string", enum: ["knows", "works-with", "member-of", "communicates-via", "responsible-for", "reports-to", "related"] },
        reason: { type: "string" }, confidence: { type: "number", minimum: 0, maximum: 1 },
        privacy: { type: "string", enum: ["private", "shared", "group"] }
      }
    }
  },
  {
    name: "relationship_context",
    description: "Return the privacy-filtered local relationship neighborhood for one entity. Private data is excluded unless explicitly requested.",
    inputSchema: {
      type: "object", required: ["entityId"],
      properties: {
        root: { type: "string" }, entityId: { type: "string" }, includePrivate: { type: "boolean" },
        groupId: { anyOf: [{ type: "string" }, { type: "null" }] }
      }
    }
  },
  {
    name: "upsert_attention",
    description: "Create or update a local attention cue for an unanswered question, promise, check-in, or meaningful change. Cues are context-only and never send messages.",
    inputSchema: {
      type: "object", required: ["kind", "summary"],
      properties: {
        root: { type: "string" }, id: { type: "string" },
        kind: { type: "string", enum: ["unanswered-question", "promise", "check-in", "meaningful-change"] },
        summary: { type: "string", maxLength: 500 }, entityId: { anyOf: [{ type: "string" }, { type: "null" }] },
        dueAt: { anyOf: [{ type: "string" }, { type: "null" }] }, priority: { type: "number", minimum: 0, maximum: 100 },
        privacy: { type: "string", enum: ["private", "shared", "group"] },
        groupId: { anyOf: [{ type: "string" }, { type: "null" }] },
        sourceDocument: { anyOf: [{ type: "string" }, { type: "null" }] },
        confidence: { type: "number", minimum: 0, maximum: 1 }
      }
    }
  },
  {
    name: "record_activity",
    description: "Record a minimal interaction timestamp for a known entity so check-in suggestions reflect recent contact without storing conversation content.",
    inputSchema: {
      type: "object", required: ["entityId"],
      properties: {
        root: { type: "string" }, entityId: { type: "string" },
        kind: { type: "string", enum: ["message", "interaction", "task", "check-in"] },
        at: { type: "string" }, privacy: { type: "string", enum: ["private", "shared", "group"] },
        groupId: { anyOf: [{ type: "string" }, { type: "null" }] }
      }
    }
  },
  {
    name: "attention_context",
    description: "Return a sparse, privacy-filtered list of due attention suggestions. Focus mode, quiet hours, and presentation throttling can suppress all output.",
    inputSchema: {
      type: "object",
      properties: {
        root: { type: "string" }, includePrivate: { type: "boolean" }, focusActive: { type: "boolean" },
        markPresented: { type: "boolean" }, maxItems: { type: "integer", minimum: 0, maximum: 20 },
        entityId: { anyOf: [{ type: "string" }, { type: "null" }] },
        groupId: { anyOf: [{ type: "string" }, { type: "null" }] },
        projectId: { anyOf: [{ type: "string" }, { type: "null" }] },
        currentTaskId: { anyOf: [{ type: "string" }, { type: "null" }] }, now: { type: "string" }
      }
    }
  },
  {
    name: "resolve_attention",
    description: "Mark an attention cue open, completed, or dismissed while retaining its previous state in private history.",
    inputSchema: {
      type: "object", required: ["id"],
      properties: {
        root: { type: "string" }, id: { type: "string" },
        status: { type: "string", enum: ["open", "completed", "dismissed"] }
      }
    }
  },
  {
    name: "configure_attention",
    description: "Configure local attention limits, silence threshold, quiet hours, or the global on/off switch.",
    inputSchema: {
      type: "object", required: ["config"],
      properties: {
        root: { type: "string" },
        config: {
          type: "object", additionalProperties: false,
          properties: {
            enabled: { type: "boolean" }, minIntervalHours: { type: "number", minimum: 1, maximum: 720 },
            entitySilenceDays: { type: "number", minimum: 1, maximum: 3650 },
            heartbeatStaleMinutes: { type: "integer", minimum: 1, maximum: 10080 },
            maxItems: { type: "integer", minimum: 1, maximum: 20 },
            quietHours: {
              anyOf: [
                { type: "null" },
                {
                  type: "object", required: ["start", "end"], additionalProperties: false,
                  properties: {
                    start: { type: "integer", minimum: 0, maximum: 23 }, end: { type: "integer", minimum: 0, maximum: 23 },
                    utcOffsetMinutes: { type: "integer", minimum: -720, maximum: 840 }
                  }
                }
              ]
            }
          }
        }
      }
    }
  },
  {
    name: "delete_attention",
    description: "Permanently delete one cue, one lifecycle event, or all attention data for one entity, including retained history, receipts, and presentation timestamps.",
    inputSchema: {
      type: "object",
      properties: {
        root: { type: "string" }, signalId: { type: "string" }, eventId: { type: "string" }, entityId: { type: "string" }
      },
      oneOf: [{ required: ["signalId"] }, { required: ["eventId"] }, { required: ["entityId"] }]
    }
  },
  {
    name: "propose_learning",
    description: "Create an evidence-backed learning candidate in external state. Candidates are invisible to learned context until explicitly accepted or safely auto-promoted.",
    inputSchema: {
      type: "object", required: ["kind", "claim", "evidence"],
      properties: {
        root: { type: "string" }, id: { type: "string" },
        kind: { type: "string", enum: ["preference", "no-go", "goal", "correction", "personal-fact", "project-fact", "reference", "behavior"] },
        claim: { type: "string", maxLength: 1000 }, subjectId: { anyOf: [{ type: "string" }, { type: "null" }] },
        privacy: { type: "string", enum: ["private", "shared", "group"] },
        groupId: { anyOf: [{ type: "string" }, { type: "null" }] },
        scope: {
          type: "object", additionalProperties: false,
          properties: {
            personaId: { anyOf: [{ type: "string" }, { type: "null" }] }, userId: { anyOf: [{ type: "string" }, { type: "null" }] },
            tenantId: { anyOf: [{ type: "string" }, { type: "null" }] }, projectId: { anyOf: [{ type: "string" }, { type: "null" }] },
            groupId: { anyOf: [{ type: "string" }, { type: "null" }] }, taskId: { anyOf: [{ type: "string" }, { type: "null" }] }
          }
        },
        supersedesId: { anyOf: [{ type: "string" }, { type: "null" }] },
        evidence: { "$ref": "#/$defs/evidence" }
      },
      "$defs": {
        evidence: {
          type: "object", required: ["summary"], additionalProperties: false,
          properties: {
            id: { type: "string" }, type: { type: "string", enum: ["user-statement", "document", "interaction", "test"] },
            summary: { type: "string", maxLength: 500 }, sourceDocument: { anyOf: [{ type: "string" }, { type: "null" }] },
            confidence: { type: "number", minimum: 0, maximum: 1 }, observedAt: { type: "string" }
          }
        }
      }
    }
  },
  {
    name: "add_learning_evidence",
    description: "Append distinct evidence to an unreviewed learning candidate while retaining the previous candidate version in history.",
    inputSchema: {
      type: "object", required: ["id", "evidence"],
      properties: {
        root: { type: "string" }, id: { type: "string" },
        evidence: {
          type: "object", required: ["summary"], additionalProperties: false,
          properties: {
            id: { type: "string" }, type: { type: "string", enum: ["user-statement", "document", "interaction", "test"] },
            summary: { type: "string", maxLength: 500 }, sourceDocument: { anyOf: [{ type: "string" }, { type: "null" }] },
            confidence: { type: "number", minimum: 0, maximum: 1 }, observedAt: { type: "string" }
          }
        }
      }
    }
  },
  {
    name: "review_learning",
    description: "Accept or reject one candidate. Acceptance requires an explicit user-confirmation marker and never grants authority.",
    inputSchema: {
      type: "object", required: ["id", "decision", "reason"],
      properties: {
        root: { type: "string" }, id: { type: "string" },
        decision: { type: "string", enum: ["accept", "reject"] }, reason: { type: "string", maxLength: 500 },
        confirmedByUser: { type: "boolean" }
      }
    }
  },
  {
    name: "learning_context",
    description: "Return accepted learning only, filtered by privacy, exact group audience, kind, subject, and context limit.",
    inputSchema: {
      type: "object",
      properties: {
        root: { type: "string" }, includePrivate: { type: "boolean" },
        groupId: { anyOf: [{ type: "string" }, { type: "null" }] },
        scope: {
          type: "object", additionalProperties: false,
          properties: {
            personaId: { anyOf: [{ type: "string" }, { type: "null" }] }, userId: { anyOf: [{ type: "string" }, { type: "null" }] },
            tenantId: { anyOf: [{ type: "string" }, { type: "null" }] }, projectId: { anyOf: [{ type: "string" }, { type: "null" }] },
            groupId: { anyOf: [{ type: "string" }, { type: "null" }] }, taskId: { anyOf: [{ type: "string" }, { type: "null" }] }
          }
        },
        kinds: { type: "array", items: { type: "string", enum: ["preference", "no-go", "goal", "correction", "personal-fact", "project-fact", "reference", "behavior"] } },
        subjectIds: { type: "array", items: { type: "string" } }, maxItems: { type: "integer", minimum: 0, maximum: 50 }
      }
    }
  },
  {
    name: "learning_outcome_status",
    description: "Read outcome receipt counts, contradiction state, and canary health for learned context. This read-only view is context-only and cannot record evidence, promote learning, or grant authority.",
    inputSchema: {
      type: "object",
      properties: {
        root: { type: "string" },
        scope: {
          type: "object", additionalProperties: false,
          properties: {
            personaId: { anyOf: [{ type: "string" }, { type: "null" }] },
            userId: { anyOf: [{ type: "string" }, { type: "null" }] },
            tenantId: { anyOf: [{ type: "string" }, { type: "null" }] },
            projectId: { anyOf: [{ type: "string" }, { type: "null" }] },
            groupId: { anyOf: [{ type: "string" }, { type: "null" }] },
            taskId: { anyOf: [{ type: "string" }, { type: "null" }] }
          }
        }
      }
    }
  },
  {
    name: "evaluate_learning",
    description: "Evaluate pending candidates against the opt-in low-risk auto-promotion policy. Auto-promotion is disabled by default and limited to project facts and references.",
    inputSchema: { type: "object", properties: { root: { type: "string" } } }
  },
  {
    name: "rollback_learning",
    description: "Roll back an accepted learning and restore the accepted fact it superseded, without deleting history.",
    inputSchema: {
      type: "object", required: ["id", "reason"],
      properties: { root: { type: "string" }, id: { type: "string" }, reason: { type: "string", maxLength: 500 } }
    }
  },
  {
    name: "configure_learning",
    description: "Configure the local learning context limit and the default-off, low-risk auto-promotion evidence thresholds.",
    inputSchema: {
      type: "object", required: ["config"],
      properties: {
        root: { type: "string" },
        config: {
          type: "object", additionalProperties: false,
          properties: {
            autoPromote: { type: "boolean" }, minConfidence: { type: "number", minimum: 0.5, maximum: 1 },
            minEvidence: { type: "integer", minimum: 1, maximum: 10 }, maxContextItems: { type: "integer", minimum: 1, maximum: 50 },
            minOutcomeReceipts: { type: "integer", minimum: 2, maximum: 10 },
            minImprovement: { type: "number", minimum: 0, maximum: 1 },
            regressionTolerance: { type: "number", minimum: 0, maximum: 1 },
            outcomeMaxAgeDays: { type: "integer", minimum: 1, maximum: 365 },
            canaryReceipts: { type: "integer", minimum: 1, maximum: 10 },
            canaryTtlDays: { type: "integer", minimum: 1, maximum: 90 }
          }
        }
      }
    }
  },
  {
    name: "delete_learning",
    description: "Permanently delete one candidate and its retained learning history. Superseding active facts must be rolled back first.",
    inputSchema: {
      type: "object", required: ["id"],
      properties: { root: { type: "string" }, id: { type: "string" } }
    }
  },
  {
    name: "check_delegation",
    description: "Check the dedicated default-deny local policy before coordinating work for another person or agent. Relationships, memory, learning, and Markdown never affect this decision or grant host permissions.",
    inputSchema: {
      type: "object", required: ["actorId", "action"], additionalProperties: false,
      properties: {
        root: { type: "string" }, actorId: { type: "string" },
        action: { type: "string", enum: ["assign", "reassign", "manage", "complete", "cancel"] },
        targetId: { anyOf: [{ type: "string" }, { type: "null" }] }
      }
    }
  },
  {
    name: "create_task",
    description: "Create a context-only task, open thread, or handoff. Cross-entity assignment fails closed unless a separate explicit local delegation policy allows it.",
    inputSchema: {
      type: "object", required: ["actorId", "title"], additionalProperties: false,
      properties: {
        root: { type: "string" }, id: { type: "string" }, actorId: { type: "string" },
        assigneeId: { anyOf: [{ type: "string" }, { type: "null" }] },
        kind: { type: "string", enum: ["task", "open-thread", "handoff"] },
        title: { type: "string", maxLength: 200 }, summary: { anyOf: [{ type: "string", maxLength: 1000 }, { type: "null" }] },
        projectId: { anyOf: [{ type: "string" }, { type: "null" }] },
        privacy: { type: "string", enum: ["private", "shared", "group"] },
        groupId: { anyOf: [{ type: "string" }, { type: "null" }] },
        priority: { type: "number", minimum: 0, maximum: 100 },
        dueAt: { anyOf: [{ type: "string" }, { type: "null" }] }
      }
    }
  },
  {
    name: "update_task",
    description: "Update a coordination task with append-only prior history. Reassignment and third-party management are checked against the separate default-deny policy.",
    inputSchema: {
      type: "object", required: ["id", "actorId", "patch"], additionalProperties: false,
      properties: {
        root: { type: "string" }, id: { type: "string" }, actorId: { type: "string" },
        patch: {
          type: "object", minProperties: 1, additionalProperties: false,
          properties: {
            status: { type: "string", enum: ["open", "in-progress", "blocked", "completed", "cancelled"] },
            assigneeId: { anyOf: [{ type: "string" }, { type: "null" }] },
            title: { type: "string", maxLength: 200 }, summary: { anyOf: [{ type: "string", maxLength: 1000 }, { type: "null" }] },
            priority: { type: "number", minimum: 0, maximum: 100 }, dueAt: { anyOf: [{ type: "string" }, { type: "null" }] },
            note: { anyOf: [{ type: "string", maxLength: 1000 }, { type: "null" }] }
          }
        }
      }
    }
  },
  {
    name: "task_context",
    description: "Return privacy-filtered coordination context without delegation snapshots. Tasks describe work only and never grant host, tool, file, network, production, or spending rights.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        root: { type: "string" }, includePrivate: { type: "boolean" },
        groupId: { anyOf: [{ type: "string" }, { type: "null" }] },
        actorId: { anyOf: [{ type: "string" }, { type: "null" }] },
        assigneeId: { anyOf: [{ type: "string" }, { type: "null" }] },
        projectId: { anyOf: [{ type: "string" }, { type: "null" }] }, includeClosed: { type: "boolean" },
        maxItems: { type: "integer", minimum: 0, maximum: 100 }
      }
    }
  },
  {
    name: "shared_context",
    description: "Return locally reviewed, privacy-filtered shared memory. This tool cannot connect adapters, import, publish, review, or grant authority.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        root: { type: "string" }, scopeId: { anyOf: [{ type: "string" }, { type: "null" }] },
        groupId: { anyOf: [{ type: "string" }, { type: "null" }] }, includePrivate: { type: "boolean" },
        kinds: { type: "array", items: { type: "string", enum: ["preference", "no-go", "goal", "correction", "personal-fact", "project-fact", "reference"] } },
        subjectIds: { type: "array", items: { type: "string" } }, maxItems: { type: "integer", minimum: 0, maximum: 50 }
      }
    }
  },
  {
    name: "audit",
    description: "Run AgentSpine's ten deterministic quality gates for discovery, hierarchy, links, authority, privacy, budget, and source preservation.",
    inputSchema: { type: "object", properties: { root: { type: "string" } } }
  },
  deliveryPremortemTool,
  deliveryPremortemRecoveryTool
];

export function startMcpServer(input = process.stdin, output = process.stdout) {
  return startMcpProtocol({ input, output, tools, version: VERSION });
}

if (isMainModule(import.meta.url)) {
  startMcpServer();
}
