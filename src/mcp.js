import { resolve } from "node:path";
import { scanAndSave, verifyCatalog } from "./lib/catalog.js";
import { readDocument, resolveContext } from "./lib/context.js";
import { annotateDocument, linkDocuments } from "./lib/graph.js";

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
  {
    name: "read_document",
    description: "Read an indexed Markdown source byte range with its SHA-256 provenance.",
    inputSchema: {
      type: "object", required: ["path"],
      properties: {
        root: { type: "string" }, path: { type: "string" },
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
        root: { type: "string" }, path: { type: "string" }, layer: { type: "string" },
        reason: { type: "string" }, confidence: { type: "number", minimum: 0, maximum: 1 }
      }
    }
  }
];

function textResult(value, isError = false) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], isError };
}

async function callTool(name, args = {}) {
  const root = args.root || process.cwd();
  if (name === "scan") return textResult(await scanAndSave(root));
  if (name === "resolve_context") return textResult(await resolveContext({
    root,
    cwd: args.cwd || root,
    host: args.host || "generic",
    maxBytes: args.maxBytes ?? 65536,
    includeContent: args.includeContent ?? true
  }));
  if (name === "read_document") return textResult(await readDocument({
    root, path: args.path, offset: args.offset ?? 0, length: args.length ?? 65536
  }));
  if (name === "verify") return textResult(await verifyCatalog(root));
  if (name === "link_documents") return textResult(await linkDocuments({ ...args, root }));
  if (name === "annotate_document") return textResult(await annotateDocument({ ...args, root }));
  throw new Error(`Unknown tool: ${name}`);
}

async function dispatch(message) {
  const { id, method, params = {} } = message;
  if (method === "initialize") {
    return {
      jsonrpc: "2.0", id,
      result: {
        protocolVersion: params.protocolVersion || "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "agent-spine", version: "0.1.0" }
      }
    };
  }
  if (method === "ping") return { jsonrpc: "2.0", id, result: {} };
  if (method === "tools/list") return { jsonrpc: "2.0", id, result: { tools } };
  if (method === "tools/call") {
    try {
      return { jsonrpc: "2.0", id, result: await callTool(params.name, params.arguments) };
    } catch (error) {
      return { jsonrpc: "2.0", id, result: textResult({ error: error.message }, true) };
    }
  }
  if (method?.startsWith("notifications/")) return null;
  return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
}

export function startMcpServer(input = process.stdin, output = process.stdout) {
  input.setEncoding("utf8");
  let buffer = "";
  input.on("data", async (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let response;
      try {
        response = await dispatch(JSON.parse(line));
      } catch (error) {
        response = { jsonrpc: "2.0", id: null, error: { code: -32700, message: error.message } };
      }
      if (response) output.write(`${JSON.stringify(response)}\n`);
    }
  });
}

if (process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href) {
  startMcpServer();
}
