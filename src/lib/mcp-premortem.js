const failure = {
  type: "string",
  minLength: 29,
  maxLength: 500,
  pattern: "^this delivery fails because\\s+\\S"
};

const check = { type: "string", minLength: 1, maxLength: 500 };

function premortemItem(category) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["category", "failure", "check"],
    properties: {
      category: { const: category },
      failure,
      check
    }
  };
}

export const deliveryPremortemTool = {
  name: "record_delivery_premortem",
  description: "Record the three required, context-only delivery failure checks before the first write. This audited receipt grants no permissions or tool access.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["root", "requirementId", "items"],
    properties: {
      root: { type: "string", minLength: 1 },
      requirementId: {
        type: "string",
        pattern: "^premortem-requirement:[a-f0-9]{64}:[a-f0-9]{64}$"
      },
      items: {
        type: "array",
        minItems: 3,
        maxItems: 3,
        items: {
          oneOf: [
            premortemItem("baseline-environment"),
            premortemItem("contract-tests"),
            premortemItem("delivery-path")
          ]
        }
      }
    }
  }
};

export const deliveryPremortemRecoveryTool = {
  name: "recover_delivery_premortem",
  description: "Create a fresh assignment-bound requirement from a preserved legacy conflict. The predecessor, rejection history, and all checks remain immutable; this grants no authority.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["root", "predecessorRequirementId"],
    properties: {
      root: { type: "string", minLength: 1 },
      predecessorRequirementId: {
        type: "string",
        pattern: "^premortem-requirement:[a-f0-9]{64}:[a-f0-9]{64}$"
      },
      taskId: { anyOf: [{ type: "string", minLength: 1, maxLength: 512 }, { type: "null" }] }
    }
  }
};
