import { canonicalPath, statePathIsScanExcluded } from "./paths.js";
import { buildCatalog, saveCatalog, verifyCatalog } from "./catalog.js";
import { loadGraph } from "./graph.js";
import { attentionFindings, inspectAttention } from "./attention.js";
import { inspectLearning, learningFindings } from "./learning.js";
import { coordinationFindings, delegationPolicyFindings, inspectCoordination } from "./coordination.js";
import { inspectSharing, sharingAuthenticationFindings, sharingFindings } from "./sharing.js";
import { inspectSignerRegistry, inspectTrust, trustFindings } from "./authentication.js";
import { resolveContext } from "./context.js";
import { sessionBriefing } from "./briefing.js";
import { inspectHttpsFeedState } from "./feed-transport.js";
import { continuityFindings, inspectContinuity } from "./continuity.js";
import {
  executionPolicyFindings, inspectSelfstarter, selfstarterFindings
} from "./selfstarter.js";
import {
  channelPolicyFindings, channelRuntimeFindings, inspectChannelRuntime
} from "./channel-runtime.js";
import { inspectPersonaRuntime, personaRuntimeFindings } from "./persona-runtime.js";
import { gatewayHealthFindings, gatewayRuntimeFindings, inspectGatewayRuntime } from "./gateway-runtime.js";
import { fileURLToPath } from "node:url";
import { checkHosts } from "../../scripts/check-hosts.js";
import { resolveHostSourceCatalog } from "./source-roots.js";
import { preflightStatus } from "./preflight.js";

function gate(id, name, ok, detail, severity = "error") {
  return { id, name, ok, severity, detail };
}

function authorityViolations(graph, attention, learning, continuity, coordination, sharing, trust, registry, feedState) {
  const records = [
    ...graph.edges,
    ...graph.annotations,
    ...graph.entities,
    ...graph.entityEdges,
    ...graph.history,
    ...graph.history.map((entry) => entry.value).filter(Boolean),
    ...attention.signals,
    ...attention.activities,
    ...attention.events,
    ...attention.receipts,
    ...attention.history,
    ...attention.history.map((entry) => entry.value).filter(Boolean),
    ...learning.candidates,
    ...learning.candidates.flatMap((candidate) => [
      ...(candidate.evidence || []), candidate.review, candidate.rollback
    ]).filter(Boolean),
    ...(learning.outcomes || []),
    ...(learning.outcomes || []).map((outcome) => outcome.measurement).filter(Boolean),
    ...(learning.measurements || []),
    ...(learning.measurements || []).map((measurement) => measurement.measurement).filter(Boolean),
    ...(learning.measurementLineage || []),
    ...(learning.applications || []),
    ...(learning.evaluations || []),
    ...(learning.evaluatorRegistry || []),
    ...(learning.evaluationBindings || []),
    ...(learning.validationLeases || []),
    ...(learning.trialFailures || []),
    ...(learning.evidenceRevocations || []),
    ...(learning.measurementRevocations || []),
    ...(learning.applicationRevocations || []),
    ...(learning.deliveryRevocations || []),
    ...(learning.outcomeRevocations || []),
    ...learning.history,
    ...learning.history.map((entry) => entry.value).filter(Boolean),
    ...continuity.signals,
    ...continuity.history,
    ...coordination.tasks,
    ...coordination.history,
    ...coordination.history.map((entry) => entry.value).filter(Boolean),
    ...sharing.records.flatMap((record) => [record, record.event, record.review, record.rollback]).filter(Boolean),
    ...sharing.history,
    ...sharing.history.flatMap((entry) => [entry.value, entry.value?.event, entry.value?.review, entry.value?.rollback]).filter(Boolean),
    ...trust.records.flatMap((record) => [record, record.publicIdentity]).filter(Boolean),
    ...trust.history.flatMap((entry) => [entry, entry.value, entry.value?.publicIdentity]).filter(Boolean),
    ...registry.signers.flatMap((record) => [record, record.publicIdentity]).filter(Boolean),
    ...registry.history.flatMap((entry) => [entry, entry.value]).filter(Boolean),
    ...feedState.feeds,
    ...feedState.history
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

export async function runAudit(root = process.cwd(), { host = null } = {}) {
  let preflight = null;
  let preflightError = null;
  try { preflight = await preflightStatus(); } catch (error) { preflightError = error.message; }
  let sourceResolution = null;
  let sourceResolutionError = null;
  let resolvedHostSources = null;
  if (["claude", "codex"].includes(host)) {
    try {
      resolvedHostSources = await resolveHostSourceCatalog({ host, cwd: root });
      sourceResolution = resolvedHostSources.diagnostics;
    }
    catch (error) { sourceResolutionError = error.message; }
  }
  let hostIntegration = null;
  let hostIntegrationError = null;
  try {
    hostIntegration = await checkHosts(fileURLToPath(new URL("../..", import.meta.url)));
  } catch (error) {
    hostIntegrationError = error.message;
  }
  const before = resolvedHostSources?.catalog || (sourceResolutionError
    ? {
      schema: "agentspine.catalog/v1", generatedAt: new Date().toISOString(), root: await canonicalPath(root),
      preservation: "source-files-are-read-only", documents: [], conflicts: [],
      summary: { total: 0, protected: 0, conflicts: 0, byLayer: {} }
    }
    : await buildCatalog(root));
  const catalog = before;
  const catalogPath = await saveCatalog(catalog);
  const { graph, graphPath } = await loadGraph(before.root, catalog);
  const { attention, attentionPath, error: attentionLoadError } = await inspectAttention(before.root, catalog);
  const { learning, learningPath, error: learningLoadError } = await inspectLearning(before.root, catalog);
  const { continuity, continuityPath, error: continuityLoadError } = await inspectContinuity(before.root, catalog);
  const {
    policy, coordination, policyPath, coordinationPath, errors: coordinationLoadErrors
  } = await inspectCoordination(before.root, catalog);
  const {
    policy: executionPolicy, state: selfstarter, executionPolicyPath, selfstarterPath,
    errors: selfstarterLoadErrors
  } = await inspectSelfstarter(before.root, catalog);
  const {
    policy: channelPolicy, runtime: channelRuntime, channelPolicyPath, channelRuntimePath,
    errors: channelLoadErrors
  } = await inspectChannelRuntime(before.root, catalog);
  const {
    policy: personaPolicy, runtime: personaRuntime, personaPolicyPath, personaRuntimePath,
    errors: personaLoadErrors
  } = await inspectPersonaRuntime(before.root, catalog);
  const {
    policy: gatewayPolicy, runtime: gatewayRuntime, gatewayPolicyPath, gatewayRuntimePath,
    errors: gatewayLoadErrors
  } = await inspectGatewayRuntime(before.root, catalog);
  const { sharing, sharingPath, error: sharingLoadError } = await inspectSharing(before.root, catalog);
  const { trust, trustPath, error: trustLoadError } = await inspectTrust(before.root, catalog);
  const { registry, registryPath, signerDirectory, errors: signerErrors } = await inspectSignerRegistry(before.root, catalog);
  const { state: feedState, statePath: feedStatePath, error: feedStateError } = await inspectHttpsFeedState(before.root);
  const context = await resolveContext({ root: before.root, cwd: before.root, host: "generic", maxBytes: 16384, includeContent: true, catalog });
  let briefing = null;
  let briefingError = null;
  try {
    briefing = await sessionBriefing({
      root: before.root, cwd: before.root, host: host || "generic", maxBytes: 16384,
      includePrivate: false, focusActive: true, includeSourceContent: true,
      catalog: resolvedHostSources?.catalog || null, sourceDiagnostics: sourceResolution
    });
  } catch (error) {
    briefingError = error.message;
  }
  const verification = ["claude", "codex"].includes(host)
    ? { ok: !sourceResolutionError, reason: sourceResolutionError ? "host-native-resolution-failed" : "host-native-rescan" }
    : await verifyCatalog(before.root);
  const after = resolvedHostSources
    ? (await resolveHostSourceCatalog({ host, cwd: root })).catalog
    : sourceResolutionError ? before : await buildCatalog(before.root);
  const beforeHashes = new Map(before.documents.map((document) => [document.relativePath, document.sha256]));
  const byteStable = after.documents.length === before.documents.length && after.documents.every((document) => beforeHashes.get(document.relativePath) === document.sha256);
  const brokenLinks = catalog.conflicts.filter((conflict) => conflict.type === "broken-link");
  const reviewConflicts = catalog.conflicts.filter((conflict) => conflict.type !== "broken-link");
  const authority = authorityViolations(graph, attention, learning, continuity, coordination, sharing, trust, registry, feedState);
  const forbidden = forbiddenEntityKeys(graph);
  const privacyValues = new Set(["private", "shared", "group"]);
  const privateRecords = [
    ...graph.entities,
    ...graph.entityEdges,
    ...graph.history,
    ...graph.history.map((entry) => entry.value).filter((value) => value && "privacy" in value),
    ...attention.signals,
    ...attention.activities,
    ...attention.events,
    ...attention.history,
    ...attention.history.map((entry) => entry.value).filter((value) => value && "privacy" in value),
    ...learning.candidates,
    ...learning.history,
    ...learning.history.map((entry) => entry.value).filter((value) => value && "privacy" in value),
    ...coordination.tasks,
    ...coordination.history,
    ...coordination.history.map((entry) => entry.value).filter((value) => value && "privacy" in value),
    ...sharing.records.map((record) => ({ ...record, privacy: record.event?.privacy })),
    ...sharing.history,
    ...sharing.history.map((entry) => entry.value).filter(Boolean).map((record) => ({ ...record, privacy: record.event?.privacy }))
  ];
  const privacyInvalid = privateRecords.filter((record) => !privacyValues.has(record.privacy));
  const knownGroups = new Set(graph.entities.filter((entity) => entity.kind === "group").map((entity) => entity.id));
  const isKnownGroupMember = (record) => !record.entityId || record.entityId === record.groupId || graph.entityEdges.some((edge) => (
    edge.relation === "member-of" && edge.privacy !== "private" && (
      (edge.from === record.entityId && edge.to === record.groupId)
      || (edge.to === record.entityId && edge.from === record.groupId)
    )
  ));
  const attentionGroupInvalid = [
    ...attention.signals,
    ...attention.activities,
    ...attention.events,
    ...attention.history.map((entry) => entry.value).filter(Boolean)
  ].filter((record) => record.privacy === "group" && (!knownGroups.has(record.groupId) || !isKnownGroupMember(record)));
  const attentionConfigValid = typeof attention.config.enabled === "boolean"
    && Number.isFinite(attention.config.minIntervalHours) && attention.config.minIntervalHours >= 1 && attention.config.minIntervalHours <= 720
    && Number.isFinite(attention.config.entitySilenceDays) && attention.config.entitySilenceDays >= 1 && attention.config.entitySilenceDays <= 3650
    && Number.isInteger(attention.config.heartbeatStaleMinutes) && attention.config.heartbeatStaleMinutes >= 1 && attention.config.heartbeatStaleMinutes <= 10080
    && Number.isInteger(attention.config.maxItems) && attention.config.maxItems >= 1 && attention.config.maxItems <= 20
    && (attention.config.quietHours === null || (
      Number.isInteger(attention.config.quietHours?.start) && attention.config.quietHours.start >= 0 && attention.config.quietHours.start <= 23
      && Number.isInteger(attention.config.quietHours?.end) && attention.config.quietHours.end >= 0 && attention.config.quietHours.end <= 23
      && Number.isFinite(attention.config.quietHours?.utcOffsetMinutes)
      && attention.config.quietHours.utcOffsetMinutes >= -720 && attention.config.quietHours.utcOffsetMinutes <= 840
    ));
  const learningIssues = learningFindings(learning, graph);
  const attentionIssues = attentionFindings(attention);
  if (attentionLoadError) attentionIssues.push(`unreadable-state:${attentionLoadError}`);
  if (learningLoadError) learningIssues.push(`unreadable-state:${learningLoadError}`);
  const continuityIssues = continuityFindings(continuity);
  if (continuityLoadError) continuityIssues.push(`unreadable-state:${continuityLoadError}`);
  const policyIssues = delegationPolicyFindings(policy, graph);
  const coordinationIssues = coordinationFindings(coordination, policy, graph);
  for (const error of coordinationLoadErrors) {
    if (error.startsWith("policy:")) policyIssues.push(`unreadable-state:${error}`);
    else coordinationIssues.push(`unreadable-state:${error}`);
  }
  const coordinationAuthorityIssues = coordinationIssues.filter((issue) => /assignment|policy-snapshot/.test(issue));
  const coordinationContextIssues = coordinationIssues.filter((issue) => !coordinationAuthorityIssues.includes(issue));
  const executionPolicyIssues = executionPolicyFindings(executionPolicy, graph, coordination);
  const selfstarterIssues = selfstarterFindings(selfstarter, executionPolicy, graph, coordination);
  for (const error of selfstarterLoadErrors) {
    if (error.startsWith("policy:")) executionPolicyIssues.push(`unreadable-state:${error}`);
    else selfstarterIssues.push(`unreadable-state:${error}`);
  }
  const selfstarterAuthorityIssues = selfstarterIssues.filter((issue) => /grant|policy|task-mismatch/.test(issue));
  const selfstarterStateIssues = selfstarterIssues.filter((issue) => !selfstarterAuthorityIssues.includes(issue));
  const channelPolicyIssues = channelPolicyFindings(channelPolicy, graph);
  const channelRuntimeIssues = channelRuntimeFindings(channelRuntime, channelPolicy, graph)
    .filter((issue) => !channelPolicyIssues.includes(issue));
  for (const error of channelLoadErrors) {
    if (error.startsWith("policy:")) channelPolicyIssues.push(`unreadable-state:${error}`);
    else channelRuntimeIssues.push(`unreadable-state:${error}`);
  }
  const personaIssues = personaRuntimeFindings(personaPolicy, personaRuntime, graph);
  const personaPolicyIssues = personaIssues.filter((issue) => /binding/.test(issue));
  const personaStateIssues = personaIssues.filter((issue) => !personaPolicyIssues.includes(issue));
  for (const error of personaLoadErrors) {
    if (error.startsWith("policy:")) personaPolicyIssues.push(`unreadable-state:${error}`);
    else personaStateIssues.push(`unreadable-state:${error}`);
  }
  const gatewayIssues = [...gatewayRuntimeFindings(gatewayPolicy, gatewayRuntime),
    ...gatewayHealthFindings(gatewayPolicy, gatewayRuntime)];
  const gatewayPolicyIssues = gatewayIssues.filter((issue) => /goal/.test(issue));
  const gatewayStateIssues = gatewayIssues.filter((issue) => !gatewayPolicyIssues.includes(issue));
  for (const error of gatewayLoadErrors) {
    if (error.startsWith("policy:")) gatewayPolicyIssues.push(`unreadable-state:${error}`);
    else gatewayStateIssues.push(`unreadable-state:${error}`);
  }
  const sharingIssues = sharingFindings(sharing, graph);
  if (sharingLoadError) sharingIssues.push(`unreadable-state:${sharingLoadError}`);
  const authenticationIssues = [
    ...trustFindings(trust),
    ...sharingAuthenticationFindings(sharing, trust)
  ];
  if (trustLoadError) authenticationIssues.push(`unreadable-trust:${trustLoadError}`);
  authenticationIssues.push(...signerErrors);
  if (feedStateError) authenticationIssues.push(`unreadable-feed-state:${feedStateError}`);
  const sharingAuthorityIssues = sharingIssues.filter((issue) => /authority|unsafe/.test(issue));
  const sharingContextIssues = sharingIssues.filter((issue) => !sharingAuthorityIssues.includes(issue));
  const nativeMapped = catalog.documents.filter((document) => document.hosts.some((host) => host !== "generic"));
  const loadedBytes = context.documents.filter((document) => document.loaded).reduce((sum, document) => sum + document.bytes, 0);
  const briefingBytes = briefing ? Buffer.byteLength(JSON.stringify(briefing)) : null;
  const briefingBudgetValid = briefing !== null && briefingBytes === briefing.budget.usedBytes
    && briefingBytes <= briefing.budget.maxBytes;

  const gates = [
    gate(1, "Runtime", Number(process.versions.node.split(".")[0]) >= 20 && hostIntegration?.ok === true, hostIntegrationError
      ? `Node ${process.versions.node}; host integration failed closed: ${hostIntegrationError}`
      : `Node ${process.versions.node}; one versioned MCP server and lifecycle hook set per host`),
    gate(2, "Discovery", catalog.schema === "agentspine.catalog/v1"
      && (!host || (sourceResolution?.status === "loaded" && !sourceResolutionError)), sourceResolutionError
      ? `${catalog.documents.length} project documents; host-native source resolution failed closed: ${sourceResolutionError}`
      : sourceResolution ? `${sourceResolution.scopes.user} user, ${sourceResolution.scopes.project} project, and ${sourceResolution.scopes["project-memory"]} memory sources; broad home scan disabled`
        : `${catalog.documents.length} Markdown documents indexed`),
    gate(3, "State isolation", [catalogPath, graphPath, attentionPath, learningPath, continuityPath,
      policyPath, coordinationPath, executionPolicyPath, selfstarterPath, channelPolicyPath,
      channelRuntimePath, personaPolicyPath, personaRuntimePath, gatewayPolicyPath, gatewayRuntimePath,
      sharingPath, trustPath, registryPath, signerDirectory, feedStatePath]
      .every((path) => statePathIsScanExcluded(catalog, path)),
    catalog.scanPolicy?.stateRoot === "excluded"
      ? `Authenticated state is excluded from the home-root source scan for ${catalog.root}`
      : `State remains outside ${catalog.root}`),
    gate(4, "Native hierarchy", nativeMapped.every((document) => document.hosts.length > 0), `${nativeMapped.length} host-native documents mapped`),
    gate(5, "Link integrity", brokenLinks.length === 0, brokenLinks.length ? `${brokenLinks.length} broken Markdown links` : "All indexed Markdown links resolve"),
    gate(6, "Conflict visibility", Array.isArray(catalog.conflicts), `${reviewConflicts.length} precedence or classification findings exposed`, "warning"),
    gate(7, "Authority boundary", authority.length === 0 && forbidden.length === 0 && policyIssues.length === 0 && coordinationAuthorityIssues.length === 0 && executionPolicyIssues.length === 0 && selfstarterAuthorityIssues.length === 0 && channelPolicyIssues.length === 0 && personaPolicyIssues.length === 0 && gatewayPolicyIssues.length === 0 && sharingAuthorityIssues.length === 0 && !preflightError, preflightError
      ? `preflight policy or receipt state failed closed: ${preflightError}`
      : `${authority.length} context authority violations; ${forbidden.length} forbidden entity records; ${policyIssues.length} delegation policy findings; ${coordinationAuthorityIssues.length} assignment findings; ${executionPolicyIssues.length} execution policy findings; ${selfstarterAuthorityIssues.length} self-starter authority findings; ${channelPolicyIssues.length} channel policy findings; ${personaPolicyIssues.length} persona policy findings; ${gatewayPolicyIssues.length} gateway policy findings; ${sharingAuthorityIssues.length} shared authority findings; preflight ${preflight.status}`),
    gate(8, "Context privacy", privacyInvalid.length === 0 && attentionGroupInvalid.length === 0 && attentionConfigValid && attentionIssues.length === 0 && learningIssues.length === 0 && continuityIssues.length === 0 && coordinationContextIssues.length === 0 && selfstarterStateIssues.length === 0 && channelRuntimeIssues.length === 0 && personaStateIssues.length === 0 && gatewayStateIssues.length === 0 && sharingContextIssues.length === 0 && authenticationIssues.length === 0, `${graph.entities.length} entities, ${graph.entityEdges.length} relationships, ${attention.signals.length} attention cues, ${attention.events.length} lifecycle events, ${learning.candidates.length} learning records, ${(learning.evaluations || []).length} immutable evaluation contracts, ${(learning.evaluations || []).filter((item) => ["agentspine.learning-evaluation/v9", "agentspine.learning-evaluation/v10"].includes(item.schema)).length} exact-target contracts, ${(learning.evaluations || []).filter((item) => ["agentspine.learning-evaluation/v8", "agentspine.learning-evaluation/v9", "agentspine.learning-evaluation/v10"].includes(item.schema)).length} precommitted initial-trial contracts, ${(learning.evaluations || []).filter((item) => item.schema === "agentspine.learning-evaluation/v10").length} deadline-bound contracts, ${(learning.applications || []).filter((item) => ["agentspine.learning-application/v5", "agentspine.learning-application/v6", "agentspine.learning-application/v7"].includes(item.schema)).length} immutable initial-trial admissions, ${(learning.applications || []).filter((item) => ["agentspine.learning-application/v6", "agentspine.learning-application/v7"].includes(item.schema)).length} exact-target admissions, ${(learning.applications || []).filter((item) => item.schema === "agentspine.learning-application/v7").length} deadline-bound admissions, ${(learning.trialFailures || []).length} blocking trial-failure receipts, ${(learning.evaluatorRegistry || []).length} locally confirmed evaluator roots, ${(learning.evaluationBindings || []).length} evaluator-registry bindings, ${(learning.validationLeases || []).length} immutable validation leases, ${(learning.measurements || []).length} immutable measurement runs, ${(learning.applications || []).length} turn-bound projections, ${(learning.deliveries || []).length} completed model-turn deliveries, ${(learning.evidenceRevocations || []).length} evidence revocations, ${(learning.measurementRevocations || []).length} measurement revocations, ${(learning.applicationRevocations || []).length} application revocations, ${(learning.deliveryRevocations || []).length} delivery revocations, ${(learning.outcomeRevocations || []).length} outcome revocations, ${(learning.outcomes || []).length} outcome receipts, ${(learning.outcomes || []).filter((item) => ["agentspine.learning-outcome/v5", "agentspine.learning-outcome/v6", "agentspine.learning-outcome/v7", "agentspine.learning-outcome/v8", "agentspine.learning-outcome/v9"].includes(item.schema)).length} case-coverage receipts, ${(learning.outcomes || []).filter((item) => ["agentspine.learning-outcome/v6", "agentspine.learning-outcome/v7", "agentspine.learning-outcome/v8", "agentspine.learning-outcome/v9"].includes(item.schema)).length} provenance-bound receipts, ${(learning.outcomes || []).filter((item) => ["agentspine.learning-outcome/v7", "agentspine.learning-outcome/v8", "agentspine.learning-outcome/v9"].includes(item.schema)).length} lineage-bound receipts, ${(learning.outcomes || []).filter((item) => ["agentspine.learning-outcome/v8", "agentspine.learning-outcome/v9"].includes(item.schema)).length} paired-evaluator receipts and ${(learning.outcomes || []).filter((item) => item.schema === "agentspine.learning-outcome/v9").length} evaluator-root-bound receipts, ${continuity.signals.length} continuity signals, ${coordination.tasks.length} coordination items, ${selfstarter.jobs.length} self-starter jobs, ${channelRuntime.events.length} channel events, ${personaRuntime.personas.length} authenticated personas, ${gatewayRuntime.queue.length} gateway queue items, ${gatewayRuntime.outbox.length} delivery records, ${sharing.records.length} shared records, ${trust.records.length} trusted keys, ${registry.signers.length} local signers, and ${feedState.feeds.length} feed receipts checked`),
    gate(9, "Context budget", loadedBytes <= context.budget.maxBytes && briefingBudgetValid, briefingError
      ? `${loadedBytes}/${context.budget.maxBytes} source bytes; briefing failed closed: ${briefingError}`
      : `${loadedBytes}/${context.budget.maxBytes} source bytes; ${briefingBytes}/${briefing.budget.maxBytes} briefing bytes`),
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
    graphPath,
    attentionPath,
    learningPath,
    continuityPath,
    policyPath,
    coordinationPath,
    executionPolicyPath,
    selfstarterPath,
    channelPolicyPath,
    channelRuntimePath,
    personaPolicyPath,
    personaRuntimePath,
    gatewayPolicyPath,
    gatewayRuntimePath,
    sharingPath,
    trustPath,
    registryPath,
    feedStatePath,
    sourceResolution,
    preflight
  };
}
