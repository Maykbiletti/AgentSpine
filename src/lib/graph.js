import { readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildCatalog } from "./catalog.js";
import { projectStateDir } from "./paths.js";

const RELATIONS = new Set([
  "loads", "belongs-to", "explains", "supports", "related",
  "contradicts", "supersedes-in-relevance"
]);

const ENTITY_KINDS = new Set(["person", "agent", "group", "channel", "project"]);
const ENTITY_RELATIONS = new Set([
  "knows", "works-with", "member-of", "communicates-via",
  "responsible-for", "reports-to", "related"
]);
const ANNOTATION_LAYERS = new Set([
  "soul", "memory-index", "memory-fact", "reference", "project-reference",
  "identity", "voice", "conduct", "history"
]);
const FORBIDDEN_ATTRIBUTE_KEYS = /^(permissions?|rights?|authorization|credentials?|secrets?|tokens?|api[-_]?keys?)$/i;

function emptyGraph(root) {
  return {
    schema: "agentspine.graph/v1",
    root,
    edges: [],
    annotations: [],
    entities: [],
    entityEdges: [],
    history: []
  };
}

function normalizeGraph(value, root) {
  const graph = value && typeof value === "object" ? value : emptyGraph(root);
  graph.schema = "agentspine.graph/v1";
  graph.root = root;
  for (const key of ["edges", "annotations", "entities", "entityEdges", "history"]) {
    if (!Array.isArray(graph[key])) graph[key] = [];
  }
  return graph;
}

function preservePrevious(graph, kind, value) {
  if (!value) return;
  graph.history.push({
    kind,
    supersededAt: new Date().toISOString(),
    value: { ...value, authority: "context-only" },
    privacy: value.privacy || "private",
    authority: "context-only"
  });
}

function normalizeRelativePath(value, field) {
  if (!value || typeof value !== "string") throw new Error(`${field} is required`);
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  if (normalized.startsWith("/") || normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new Error(`${field} must be a project-relative path`);
  }
  return normalized;
}

function normalizeConfidence(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error("confidence must be a finite number");
  return Math.max(0, Math.min(1, number));
}

function validateAttributes(value, path = "attributes") {
  if (value === null || value === undefined) return {};
  if (Array.isArray(value)) return value.map((item, index) => validateAttributes(item, `${path}[${index}]`));
  if (typeof value !== "object") return value;
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_ATTRIBUTE_KEYS.test(key)) {
      throw new Error(`${path}.${key} is authority data and cannot be stored in relationship memory`);
    }
    result[key] = validateAttributes(item, `${path}.${key}`);
  }
  if (Buffer.byteLength(JSON.stringify(result)) > 16384) throw new Error("attributes exceed 16 KiB");
  return result;
}

export async function loadGraph(root, providedCatalog = null) {
  const catalog = providedCatalog || await buildCatalog(root);
  const directory = await projectStateDir(catalog.root);
  const path = join(directory, "graph.json");
  try {
    const metadata = await stat(path);
    if (metadata.size > 5 * 1024 * 1024) throw new Error("relationship graph exceeds the 5 MiB read limit");
    return { graph: normalizeGraph(JSON.parse(await readFile(path, "utf8")), catalog.root), graphPath: path, catalog };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return {
      graph: emptyGraph(catalog.root),
      graphPath: path,
      catalog
    };
  }
}

async function saveGraph(graph, path) {
  const temporary = `${path}.${process.pid}.tmp`;
  const content = `${JSON.stringify(graph, null, 2)}\n`;
  if (Buffer.byteLength(content) > 5 * 1024 * 1024) throw new Error("relationship graph exceeds 5 MiB; archive or compact old observations first");
  await writeFile(temporary, content, { mode: 0o600 });
  await rename(temporary, path);
}

export async function linkDocuments({ root = process.cwd(), from, to, relation = "related", reason = "", confidence = 0.5 }) {
  if (!RELATIONS.has(relation)) throw new Error(`unsupported relation: ${relation}`);
  const { graph, graphPath, catalog } = await loadGraph(root);
  from = normalizeRelativePath(from, "from");
  to = normalizeRelativePath(to, "to");
  const known = new Set(catalog.documents.map((document) => document.relativePath));
  if (!known.has(from)) throw new Error(`unknown source document: ${from}`);
  if (!known.has(to)) throw new Error(`unknown target document: ${to}`);
  const edge = {
    from,
    to,
    relation,
    reason: String(reason).slice(0, 1000),
    confidence: normalizeConfidence(confidence),
    updatedAt: new Date().toISOString(),
    authority: "context-only"
  };
  const key = (item) => `${item.from}\0${item.to}\0${item.relation}`;
  preservePrevious(graph, "document-edge", graph.edges.find((item) => key(item) === key(edge)));
  graph.edges = graph.edges.filter((item) => key(item) !== key(edge));
  graph.edges.push(edge);
  graph.edges.sort((a, b) => key(a).localeCompare(key(b)));
  await saveGraph(graph, graphPath);
  return { edge, graphPath };
}

export async function annotateDocument({ root = process.cwd(), path, layer, reason = "", confidence = 0.5 }) {
  if (!ANNOTATION_LAYERS.has(layer)) throw new Error(`unsupported context-only layer: ${layer}`);
  const { graph, graphPath, catalog } = await loadGraph(root);
  path = normalizeRelativePath(path, "path");
  if (!catalog.documents.some((document) => document.relativePath === path)) {
    throw new Error(`unknown document: ${path}`);
  }
  const annotation = {
    path,
    layer,
    reason: String(reason).slice(0, 1000),
    confidence: normalizeConfidence(confidence),
    updatedAt: new Date().toISOString(),
    authority: "context-only"
  };
  preservePrevious(graph, "document-annotation", graph.annotations.find((item) => item.path === path));
  graph.annotations = graph.annotations.filter((item) => item.path !== path);
  graph.annotations.push(annotation);
  graph.annotations.sort((a, b) => a.path.localeCompare(b.path));
  await saveGraph(graph, graphPath);
  return { annotation, graphPath };
}

export async function upsertEntity({
  root = process.cwd(), id, kind, displayName = "", aliases = [],
  attributes = {}, sourceDocument = null, confidence = 0.5, privacy = "private"
}) {
  if (!id || !/^[A-Za-z0-9][A-Za-z0-9:_.@/-]{0,127}$/.test(id)) throw new Error("id must be a stable, whitespace-free identifier");
  if (!ENTITY_KINDS.has(kind)) throw new Error(`unsupported entity kind: ${kind}`);
  if (!["private", "shared", "group"].includes(privacy)) throw new Error(`unsupported privacy scope: ${privacy}`);
  if (!attributes || Array.isArray(attributes) || typeof attributes !== "object") throw new Error("attributes must be an object");
  const { graph, graphPath, catalog } = await loadGraph(root);
  if (sourceDocument !== null) {
    sourceDocument = normalizeRelativePath(sourceDocument, "sourceDocument");
    if (!catalog.documents.some((document) => document.relativePath === sourceDocument)) {
      throw new Error(`unknown source document: ${sourceDocument}`);
    }
  }
  const entity = {
    id,
    kind,
    displayName: String(displayName).slice(0, 200),
    aliases: [...new Set((Array.isArray(aliases) ? aliases : []).map((alias) => String(alias).slice(0, 200)))].slice(0, 20),
    attributes: validateAttributes(attributes),
    sourceDocument,
    confidence: normalizeConfidence(confidence),
    privacy,
    updatedAt: new Date().toISOString(),
    authority: "context-only"
  };
  preservePrevious(graph, "entity", graph.entities.find((item) => item.id === id));
  graph.entities = graph.entities.filter((item) => item.id !== id);
  graph.entities.push(entity);
  graph.entities.sort((a, b) => a.id.localeCompare(b.id));
  await saveGraph(graph, graphPath);
  return { entity, graphPath };
}

export async function linkEntities({ root = process.cwd(), from, to, relation = "related", reason = "", confidence = 0.5, privacy = "private" }) {
  if (!ENTITY_RELATIONS.has(relation)) throw new Error(`unsupported entity relation: ${relation}`);
  if (!["private", "shared", "group"].includes(privacy)) throw new Error(`unsupported privacy scope: ${privacy}`);
  const { graph, graphPath } = await loadGraph(root);
  const known = new Set(graph.entities.map((entity) => entity.id));
  if (!known.has(from)) throw new Error(`unknown source entity: ${from}`);
  if (!known.has(to)) throw new Error(`unknown target entity: ${to}`);
  const edge = {
    from,
    to,
    relation,
    reason: String(reason).slice(0, 1000),
    confidence: normalizeConfidence(confidence),
    privacy,
    updatedAt: new Date().toISOString(),
    authority: "context-only"
  };
  const key = (item) => `${item.from}\0${item.to}\0${item.relation}`;
  preservePrevious(graph, "entity-edge", graph.entityEdges.find((item) => key(item) === key(edge)));
  graph.entityEdges = graph.entityEdges.filter((item) => key(item) !== key(edge));
  graph.entityEdges.push(edge);
  graph.entityEdges.sort((a, b) => key(a).localeCompare(key(b)));
  await saveGraph(graph, graphPath);
  return { edge, graphPath };
}

export async function unlinkEntities({ root = process.cwd(), from, to, relation = "related" }) {
  if (!ENTITY_RELATIONS.has(relation)) throw new Error(`unsupported entity relation: ${relation}`);
  const { graph, graphPath } = await loadGraph(root);
  const previous = graph.entityEdges.find((item) => item.from === from && item.to === to && item.relation === relation);
  if (!previous) return { removed: null, duplicate: true, graphPath };
  preservePrevious(graph, "entity-edge", previous);
  graph.entityEdges = graph.entityEdges.filter((item) => !(item.from === from && item.to === to && item.relation === relation));
  await saveGraph(graph, graphPath);
  return { removed: previous, duplicate: false, graphPath };
}

function relationshipAudience(graph, groupId) {
  const ids = new Set([groupId]);
  for (const edge of graph.entityEdges) {
    if (edge.relation !== "member-of" || edge.privacy === "private") continue;
    if (edge.from === groupId) ids.add(edge.to);
    if (edge.to === groupId) ids.add(edge.from);
  }
  return ids;
}

export async function relationshipContext({
  root = process.cwd(), entityId, includePrivate = false, groupId = null, catalog: providedCatalog = null
}) {
  if (!entityId) throw new Error("entityId is required");
  const { graph } = await loadGraph(root, providedCatalog);
  if (groupId !== null) {
    const group = graph.entities.find((item) => item.id === groupId && item.kind === "group");
    if (!group) throw new Error(`unknown group entity: ${groupId}`);
    if (includePrivate) throw new Error("private relationship context cannot be assembled for a group audience");
  }
  const entity = graph.entities.find((item) => item.id === entityId);
  if (!entity) throw new Error(`unknown entity: ${entityId}`);
  const audience = groupId === null ? null : relationshipAudience(graph, groupId);
  if (audience && !audience.has(entityId)) throw new Error(`entity is not a visible member of group: ${groupId}`);
  const visible = (item) => {
    if (item.privacy === "private") return includePrivate && groupId === null;
    if (item.privacy === "group" && !audience) return false;
    if (audience && item.id && !audience.has(item.id)) return false;
    return true;
  };
  if (!visible(entity)) throw new Error(`private relationship context requires includePrivate: ${entityId}`);
  const entities = new Map(graph.entities.map((item) => [item.id, item]));
  const visibleEdge = (edge) => visible(edge)
    && (!audience || [edge.from, edge.to].every((id) => audience.has(id)))
    && [edge.from, edge.to].every((id) => !entities.has(id) || visible(entities.get(id)));
  const edges = graph.entityEdges.filter((edge) => (edge.from === entityId || edge.to === entityId) && visibleEdge(edge));
  const ids = new Set(edges.flatMap((edge) => [edge.from, edge.to]));
  ids.add(entityId);
  return {
    entity,
    relatedEntities: graph.entities.filter((item) => ids.has(item.id) && visible(item)),
    edges,
    history: graph.history.filter((entry) => {
      if (!visible(entry)) return false;
      const value = entry.value || {};
      if (value.id && entities.has(value.id) && !visible(entities.get(value.id))) return false;
      if ((value.from || value.to) && !visibleEdge(value)) return false;
      return value.id === entityId || value.from === entityId || value.to === entityId;
    }),
    groupId,
    authority: "context-only"
  };
}
