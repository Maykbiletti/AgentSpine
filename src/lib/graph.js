import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildCatalog } from "./catalog.js";
import { projectStateDir } from "./paths.js";

const RELATIONS = new Set([
  "loads", "belongs-to", "explains", "supports", "related",
  "contradicts", "supersedes-in-relevance"
]);

export async function loadGraph(root) {
  const catalog = await buildCatalog(root);
  const directory = await projectStateDir(catalog.root);
  const path = join(directory, "graph.json");
  try {
    return { graph: JSON.parse(await readFile(path, "utf8")), graphPath: path, catalog };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return {
      graph: { schema: "agentspine.graph/v1", root: catalog.root, edges: [], annotations: [] },
      graphPath: path,
      catalog
    };
  }
}

async function saveGraph(graph, path) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(graph, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

export async function linkDocuments({ root = process.cwd(), from, to, relation = "related", reason = "", confidence = 0.5 }) {
  if (!RELATIONS.has(relation)) throw new Error(`unsupported relation: ${relation}`);
  const { graph, graphPath, catalog } = await loadGraph(root);
  const known = new Set(catalog.documents.map((document) => document.relativePath));
  if (!known.has(from)) throw new Error(`unknown source document: ${from}`);
  if (!known.has(to)) throw new Error(`unknown target document: ${to}`);
  const edge = {
    from,
    to,
    relation,
    reason: String(reason).slice(0, 1000),
    confidence: Math.max(0, Math.min(1, Number(confidence))),
    updatedAt: new Date().toISOString(),
    authority: "context-only"
  };
  const key = (item) => `${item.from}\0${item.to}\0${item.relation}`;
  graph.edges = graph.edges.filter((item) => key(item) !== key(edge));
  graph.edges.push(edge);
  graph.edges.sort((a, b) => key(a).localeCompare(key(b)));
  await saveGraph(graph, graphPath);
  return { edge, graphPath };
}

export async function annotateDocument({ root = process.cwd(), path, layer, reason = "", confidence = 0.5 }) {
  if (!layer || typeof layer !== "string") throw new Error("layer is required");
  const { graph, graphPath, catalog } = await loadGraph(root);
  if (!catalog.documents.some((document) => document.relativePath === path)) {
    throw new Error(`unknown document: ${path}`);
  }
  const annotation = {
    path,
    layer,
    reason: String(reason).slice(0, 1000),
    confidence: Math.max(0, Math.min(1, Number(confidence))),
    updatedAt: new Date().toISOString(),
    authority: "context-only"
  };
  graph.annotations = graph.annotations.filter((item) => item.path !== path);
  graph.annotations.push(annotation);
  graph.annotations.sort((a, b) => a.path.localeCompare(b.path));
  await saveGraph(graph, graphPath);
  return { annotation, graphPath };
}
