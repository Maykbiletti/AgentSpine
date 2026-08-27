import { isInside } from "./paths.js";
import { buildCatalog, saveCatalog, verifyCatalog } from "./catalog.js";
import { loadGraph } from "./graph.js";
import { resolveContext } from "./context.js";

function gate(id, name, ok, detail, severity = "error") {
  return { id, name, ok, severity, detail };
}

function authorityViolations(graph) {
  const records = [
    ...graph.edges,
    ...graph.annotations,
    ...graph.entities,
    ...graph.entityEdges,
    ...graph.history,
    ...graph.history.map((entry) => entry.value).filter(Boolean)
  ];
  return records.filter((record) => record.authority !== "context-only");
}

function forbiddenEntityKeys(graph) {
  const forbidden = /"(?:permissions?|rights?|authorization|credentials?|secrets?|tokens?|api[-_]?keys?)"\s*:/i;
  const historicalEntities = graph.history
    .filter((entry) => entry.kind === "entity")
    .map((entry) => entry.value);
  return [...graph.entities, ...historicalEntities].filter((entity) => forbidden.test(JSON.stringify(entity?.attributes || {})));
}

export async function runAudit(root = process.cwd()) {
  const before = await buildCatalog(root);
  const catalog = before;
  const catalogPath = await saveCatalog(catalog);
  const { graph, graphPath } = await loadGraph(before.root, catalog);
  const context = await resolveContext({ root: before.root, cwd: before.root, host: "generic", maxBytes: 16384, includeContent: true, catalog });
  const verification = await verifyCatalog(before.root);
  const after = await buildCatalog(before.root);
  const beforeHashes = new Map(before.documents.map((document) => [document.relativePath, document.sha256]));
  const byteStable = after.documents.length === before.documents.length && after.documents.every((document) => beforeHashes.get(document.relativePath) === document.sha256);
  const brokenLinks = catalog.conflicts.filter((conflict) => conflict.type === "broken-link");
  const reviewConflicts = catalog.conflicts.filter((conflict) => conflict.type !== "broken-link");
  const authority = authorityViolations(graph);
  const forbidden = forbiddenEntityKeys(graph);
  const privacyValues = new Set(["private", "shared", "group"]);
  const privateRecords = [
    ...graph.entities,
    ...graph.entityEdges,
    ...graph.history,
    ...graph.history.map((entry) => entry.value).filter((value) => value && "privacy" in value)
  ];
  const privacyInvalid = privateRecords.filter((record) => !privacyValues.has(record.privacy));
  const nativeMapped = catalog.documents.filter((document) => document.hosts.some((host) => host !== "generic"));
  const loadedBytes = context.documents.filter((document) => document.loaded).reduce((sum, document) => sum + document.bytes, 0);

  const gates = [
    gate(1, "Runtime", Number(process.versions.node.split(".")[0]) >= 20, `Node ${process.versions.node}`),
    gate(2, "Discovery", catalog.schema === "agentspine.catalog/v1", `${catalog.documents.length} Markdown documents indexed`),
    gate(3, "External state", !isInside(catalog.root, catalogPath) && !isInside(catalog.root, graphPath), `State remains outside ${catalog.root}`),
    gate(4, "Native hierarchy", nativeMapped.every((document) => document.hosts.length > 0), `${nativeMapped.length} host-native documents mapped`),
    gate(5, "Link integrity", brokenLinks.length === 0, brokenLinks.length ? `${brokenLinks.length} broken Markdown links` : "All indexed Markdown links resolve"),
    gate(6, "Conflict visibility", Array.isArray(catalog.conflicts), `${reviewConflicts.length} precedence or classification findings exposed`, "warning"),
    gate(7, "Authority boundary", authority.length === 0 && forbidden.length === 0, `${authority.length} authority violations; ${forbidden.length} forbidden entity records`),
    gate(8, "Relationship privacy", privacyInvalid.length === 0, `${graph.entities.length} entities and ${graph.entityEdges.length} relationships checked`),
    gate(9, "Context budget", loadedBytes <= context.budget.maxBytes, `${loadedBytes}/${context.budget.maxBytes} bytes loaded`),
    gate(10, "Byte preservation", byteStable && verification.ok, verification.ok ? "Sources remained byte-for-byte unchanged" : "Source drift detected")
  ];
  return {
    schema: "agentspine.audit/v1",
    root: catalog.root,
    ok: gates.every((item) => item.ok || item.severity === "warning"),
    passed: gates.filter((item) => item.ok).length,
    total: gates.length,
    gates,
    catalogPath,
    graphPath
  };
}
