import { createHash } from "node:crypto";

export const KNOWLEDGE_GAP_SCHEMA = "agentspine.knowledge-gap/v1";
export const SELF_HELP_REPORT_SCHEMA = "agentspine.self-help-report/v1";

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9:_.@/+~-]{0,255}$/;
const DIGEST_RE = /^[a-f0-9]{64}$/;
const COMMIT_RE = /^[a-f0-9]{40}$/;
const KNOWLEDGE_EVIDENCE = new Set(["owner-input", "objective-observation"]);
const REPOSITORY_KINDS = new Set(["current-tree", "documentation", "test", "history", "issue", "pull-request"]);
const EXTERNAL_KINDS = new Set(["official-documentation", "standard", "research-paper", "public-repository"]);
const SECRET_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk|gh[opusu])_[A-Za-z0-9_-]{20,}\b|\bBearer\s+[A-Za-z0-9._~+/-]{20,}|\b(?:api[-_ ]?key|token|password|secret)\s*[:=]\s*\S{8,}/i;
const AUTHORITY_RE = /\b(?:permission|rights?|roles?|owner|trusted|delegat|authorized|approval|production|payment|spending|tool capability|send capability)\b/i;

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }

function exactId(value, field) {
  if (typeof value !== "string" || !ID_RE.test(value) || value.includes("*")) {
    throw new Error(field + " must be an exact stable ID without wildcards");
  }
  return value;
}

function safeText(value, field, maximum) {
  if (typeof value !== "string" || !value.trim()) throw new Error(field + " is required");
  const text = value.trim().replace(/\s+/g, " ").slice(0, maximum);
  if (SECRET_RE.test(text)) throw new Error(field + " appears to contain a secret");
  return text;
}

function safeKnowledgeText(value, field, maximum) {
  const text = safeText(value, field, maximum);
  if (AUTHORITY_RE.test(text)) throw new Error(field + " cannot grant or describe authority");
  return text;
}

function timestamp(value, field = "timestamp") {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(field + " is invalid");
  return date.toISOString();
}

function knowledgeGapSubjectMaterial(gap) {
  return {
    goalId: gap.goalId, goalStepId: gap.goalStepId, planDefinitionsDigest: gap.planDefinitionsDigest,
    question: gap.question, reason: gap.reason, requiredEvidence: gap.requiredEvidence,
    authority: "context-only"
  };
}

function knowledgeGapRequestMaterial(gap) {
  return {
    subjectDigest: gap.subjectDigest, requestedAt: gap.requestedAt,
    requestedByQueueId: gap.requestedByQueueId, authority: "context-only"
  };
}

function knowledgeGapResolutionMaterial(gap) {
  return {
    requestDigest: gap.requestDigest, answer: gap.answer, answerSource: gap.answerSource,
    sourceDigest: gap.sourceDigest, resolvedAt: gap.resolvedAt,
    resolvedBySubjectId: gap.resolvedBySubjectId, authority: "context-only"
  };
}

export function validKnowledgeGap(gap) {
  if (!(gap && gap.schema === KNOWLEDGE_GAP_SCHEMA && ID_RE.test(gap.gapId || "")
    && ID_RE.test(gap.goalId || "") && ID_RE.test(gap.goalStepId || "")
    && DIGEST_RE.test(gap.planDefinitionsDigest || "")
    && typeof gap.question === "string" && gap.question.length <= 500
    && typeof gap.reason === "string" && gap.reason.length <= 500
    && KNOWLEDGE_EVIDENCE.has(gap.requiredEvidence)
    && ID_RE.test(gap.requestedByQueueId || "")
    && Number.isFinite(new Date(gap.requestedAt).getTime())
    && DIGEST_RE.test(gap.subjectDigest || "") && DIGEST_RE.test(gap.requestDigest || "")
    && ["open", "resolved"].includes(gap.status) && gap.authority === "context-only")) return false;
  try {
    if (safeKnowledgeText(gap.question, "knowledgeGap.question", 500) !== gap.question
      || safeKnowledgeText(gap.reason, "knowledgeGap.reason", 500) !== gap.reason) return false;
  } catch { return false; }
  if (gap.subjectDigest !== sha256(JSON.stringify(knowledgeGapSubjectMaterial(gap)))
    || gap.gapId !== "knowledge-gap:" + gap.subjectDigest.slice(0, 32)
    || gap.requestDigest !== sha256(JSON.stringify(knowledgeGapRequestMaterial(gap)))) return false;
  if (gap.status === "open") return gap.answer === null && gap.answerSource === null && gap.sourceDigest === null
    && gap.resolvedAt === null && gap.resolvedBySubjectId === null && gap.resolutionDigest === null;
  if (!(typeof gap.answer === "string" && gap.answer.length <= 2000
    && gap.answerSource === gap.requiredEvidence
    && (gap.sourceDigest === null || DIGEST_RE.test(gap.sourceDigest))
    && Number.isFinite(new Date(gap.resolvedAt).getTime()) && ID_RE.test(gap.resolvedBySubjectId || "")
    && DIGEST_RE.test(gap.resolutionDigest || ""))) return false;
  if (new Date(gap.resolvedAt) < new Date(gap.requestedAt)) return false;
  if ((gap.answerSource === "objective-observation") !== (gap.sourceDigest !== null)) return false;
  try { if (safeKnowledgeText(gap.answer, "knowledgeGap.answer", 2000) !== gap.answer) return false; } catch { return false; }
  return gap.resolutionDigest === sha256(JSON.stringify(knowledgeGapResolutionMaterial(gap)));
}

export function createKnowledgeGap(goal, step, queueId, request, now) {
  const gap = {
    schema: KNOWLEDGE_GAP_SCHEMA, gapId: null, goalId: goal.goalId, goalStepId: step.stepId,
    planDefinitionsDigest: goal.plan.definitionsDigest,
    question: safeKnowledgeText(request?.question, "knowledgeGap.question", 500),
    reason: safeKnowledgeText(request?.reason, "knowledgeGap.reason", 500),
    requiredEvidence: request?.requiredEvidence,
    requestedAt: timestamp(now), requestedByQueueId: exactId(queueId, "requestedByQueueId"),
    subjectDigest: null, requestDigest: null, status: "open", answer: null, answerSource: null,
    sourceDigest: null, resolvedAt: null, resolvedBySubjectId: null, resolutionDigest: null,
    authority: "context-only"
  };
  if (!KNOWLEDGE_EVIDENCE.has(gap.requiredEvidence)) {
    throw new Error("knowledgeGap.requiredEvidence must be owner-input or objective-observation");
  }
  gap.subjectDigest = sha256(JSON.stringify(knowledgeGapSubjectMaterial(gap)));
  gap.gapId = "knowledge-gap:" + gap.subjectDigest.slice(0, 32);
  gap.requestDigest = sha256(JSON.stringify(knowledgeGapRequestMaterial(gap)));
  if (!validKnowledgeGap(gap)) throw new Error("knowledge gap request is invalid");
  return gap;
}

export function resolveKnowledgeGapCandidate(gap, { answer, answerSource, sourceDigest = null,
  resolvedAt, resolvedBySubjectId }) {
  answer = safeKnowledgeText(answer, "answer", 2000);
  if (!KNOWLEDGE_EVIDENCE.has(answerSource) || answerSource !== gap.requiredEvidence) {
    throw new Error("answer source does not satisfy the requested evidence class");
  }
  sourceDigest = sourceDigest === null || sourceDigest === undefined || sourceDigest === "" ? null : String(sourceDigest);
  if ((answerSource === "objective-observation") !== DIGEST_RE.test(sourceDigest || "")) {
    throw new Error("objective observation answers require one exact SHA-256 source digest");
  }
  const candidate = { ...gap, status: "resolved", answer, answerSource, sourceDigest,
    resolvedAt: timestamp(resolvedAt), resolvedBySubjectId: exactId(resolvedBySubjectId, "resolvedBySubjectId"),
    resolutionDigest: null };
  candidate.resolutionDigest = sha256(JSON.stringify(knowledgeGapResolutionMaterial(candidate)));
  if (!validKnowledgeGap(candidate)) throw new Error("knowledge gap resolution is invalid");
  return candidate;
}

export function sameKnowledgeGapResolution(gap, resolution) {
  const repeated = resolveKnowledgeGapCandidate(gap, { ...resolution,
    resolvedAt: gap.resolvedAt, resolvedBySubjectId: gap.resolvedBySubjectId });
  return gap.resolutionDigest === repeated.resolutionDigest;
}

function safeRelativePath(value, field) {
  const path = safeText(value, field, 500).replaceAll("\\", "/");
  if (path.startsWith("/") || /^[A-Za-z]:\//.test(path) || path.split("/").includes("..")) {
    throw new Error(field + " must stay inside the researched repository");
  }
  return path;
}

function publicHttpsUrl(value, field) {
  let url;
  try { url = new URL(value); } catch { throw new Error(field + " must be an HTTPS URL"); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || host === "localhost"
    || host.endsWith(".local") || /^\d+(?:\.\d+){3}$/.test(host) || host.includes(":")) {
    throw new Error(field + " must be a public HTTPS URL without credentials");
  }
  return url.toString();
}

function evidenceTime(value, field, completedAt) {
  const observedAt = timestamp(value, field);
  const completed = new Date(completedAt);
  const observed = new Date(observedAt);
  if (observed > completed || completed.getTime() - observed.getTime() > 86400000) {
    throw new Error(field + " must be fresh and no later than the report");
  }
  return observedAt;
}

function normalizeRepositorySource(source, index, completedAt) {
  const field = `selfHelp.repositorySources[${index}]`;
  if (!REPOSITORY_KINDS.has(source?.kind)) throw new Error(field + ".kind is unsupported");
  if (!DIGEST_RE.test(source?.sourceDigest || "")) throw new Error(field + ".sourceDigest must be SHA-256");
  if (!COMMIT_RE.test(source?.commit || "")) throw new Error(field + ".commit must be an exact Git commit");
  return { kind: source.kind, path: safeRelativePath(source.path, field + ".path"), commit: source.commit,
    sourceDigest: source.sourceDigest, observedAt: evidenceTime(source.observedAt, field + ".observedAt", completedAt),
    relevance: safeKnowledgeText(source.relevance, field + ".relevance", 500) };
}

function normalizeExternalSource(source, index, completedAt) {
  const field = `selfHelp.externalSources[${index}]`;
  if (!EXTERNAL_KINDS.has(source?.kind)) throw new Error(field + ".kind is unsupported");
  if (!DIGEST_RE.test(source?.sourceDigest || "")) throw new Error(field + ".sourceDigest must be SHA-256");
  return { kind: source.kind, url: publicHttpsUrl(source.url, field + ".url"),
    version: safeText(source.version, field + ".version", 200),
    license: safeText(source.license, field + ".license", 200), sourceDigest: source.sourceDigest,
    observedAt: evidenceTime(source.observedAt, field + ".observedAt", completedAt),
    relevance: safeKnowledgeText(source.relevance, field + ".relevance", 500), untrusted: true };
}

function selfHelpMaterial(report) {
  return { goalId: report.goalId, goalStepId: report.goalStepId,
    planDefinitionsDigest: report.planDefinitionsDigest, question: report.question, reason: report.reason,
    repositorySufficient: report.repositorySufficient, repositorySources: report.repositorySources,
    externalSources: report.externalSources, conclusion: report.conclusion, completedAt: report.completedAt,
    authority: "context-only-research" };
}

export function validSelfHelpReport(report) {
  if (!(report && report.schema === SELF_HELP_REPORT_SCHEMA && ID_RE.test(report.reportId || "")
    && ID_RE.test(report.goalId || "") && ID_RE.test(report.goalStepId || "")
    && DIGEST_RE.test(report.planDefinitionsDigest || "") && typeof report.repositorySufficient === "boolean"
    && Array.isArray(report.repositorySources) && report.repositorySources.length >= 1 && report.repositorySources.length <= 16
    && Array.isArray(report.externalSources) && report.externalSources.length <= 8
    && typeof report.conclusion === "string" && report.conclusion.length <= 2000
    && Number.isFinite(new Date(report.completedAt).getTime()) && DIGEST_RE.test(report.reportDigest || "")
    && report.authority === "context-only-research")) return false;
  try {
    const normalized = createSelfHelpReport({ goal: { goalId: report.goalId,
      plan: { definitionsDigest: report.planDefinitionsDigest } }, step: { stepId: report.goalStepId },
      report, now: report.completedAt });
    return JSON.stringify(normalized) === JSON.stringify(report);
  } catch { return false; }
}

export function createSelfHelpReport({ goal, step, report, now }) {
  const completedAt = timestamp(now);
  const repositorySources = (report?.repositorySources || []).map((source, index) =>
    normalizeRepositorySource(source, index, completedAt));
  const externalSources = (report?.externalSources || []).map((source, index) =>
    normalizeExternalSource(source, index, completedAt));
  if (repositorySources.length < 1 || repositorySources.length > 16) {
    throw new Error("self-help requires 1-16 repository evidence sources before escalation");
  }
  if (externalSources.length > 8) throw new Error("self-help external research exceeds eight sources");
  const repositorySufficient = report?.repositorySufficient === true;
  if (repositorySufficient && externalSources.length) {
    throw new Error("self-help cannot use external sources when repository evidence is sufficient");
  }
  if (!repositorySufficient) {
    const origins = new Set(externalSources.map((source) => new URL(source.url).origin));
    if (externalSources.length < 2 || origins.size < 2) {
      throw new Error("insufficient repository evidence requires two independent public primary sources");
    }
  }
  const lastRepositoryRead = repositorySources.reduce((latest, source) =>
    source.observedAt > latest ? source.observedAt : latest, repositorySources[0].observedAt);
  if (externalSources.some((source) => source.observedAt < lastRepositoryRead)) {
    throw new Error("self-help must inspect the repository before external research");
  }
  const result = { schema: SELF_HELP_REPORT_SCHEMA, reportId: null,
    goalId: exactId(goal.goalId, "goalId"), goalStepId: exactId(step.stepId, "goalStepId"),
    planDefinitionsDigest: goal.plan.definitionsDigest,
    question: safeKnowledgeText(report?.question, "selfHelp.question", 500),
    reason: safeKnowledgeText(report?.reason, "selfHelp.reason", 500), repositorySufficient,
    repositorySources, externalSources, conclusion: safeKnowledgeText(report?.conclusion, "selfHelp.conclusion", 2000),
    completedAt, reportDigest: null, authority: "context-only-research" };
  result.reportDigest = sha256(JSON.stringify(selfHelpMaterial(result)));
  result.reportId = "self-help-report:" + result.reportDigest.slice(0, 32);
  return result;
}

export function createSelfHelpResolution({ goal, step, queueId, report, agentId, now }) {
  const evidence = createSelfHelpReport({ goal, step, report, now });
  const gap = createKnowledgeGap(goal, step, queueId, { question: evidence.question,
    reason: evidence.reason, requiredEvidence: "objective-observation" }, now);
  return { report: evidence, gap: resolveKnowledgeGapCandidate(gap, {
    answer: evidence.conclusion, answerSource: "objective-observation", sourceDigest: evidence.reportDigest,
    resolvedAt: now, resolvedBySubjectId: agentId
  }) };
}

export function selfHelpPolicyForWorkItem() {
  return { schema: "agentspine.self-help-policy/v1", order: ["repository", "public-primary-sources"],
    repositoryFirst: true, externalOnlyWhenRepositoryInsufficient: true, maxRepositorySources: 16,
    maxExternalSources: 8, externalContentTrust: "untrusted", reportSchema: SELF_HELP_REPORT_SCHEMA,
    reportFields: ["question", "reason", "repositorySufficient", "repositorySources", "externalSources", "conclusion"],
    repositorySourceFields: ["kind", "path", "commit", "sourceDigest", "observedAt", "relevance"],
    externalSourceFields: ["kind", "url", "version", "license", "sourceDigest", "observedAt", "relevance"],
    repositoryKinds: [...REPOSITORY_KINDS], externalKinds: [...EXTERNAL_KINDS],
    mayGrantAuthority: false, authority: "context-only-research" };
}
