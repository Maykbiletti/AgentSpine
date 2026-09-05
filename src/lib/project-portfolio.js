import { randomUUID } from "node:crypto";
import { lstat, readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  EVIDENCE_CLASSES, appendHistory, digest, loadAutonomy, modeAllows, mutateAutonomy,
  safeText, signedRecord, stableId, timestamp
} from "./autonomy-store.js";

const MAX_ENTRIES = 256;
const MAX_FILE_BYTES = 64 * 1024;
const KINDS = new Set(["ci", "error", "idea", "goal", "state"]);
const STATUSES = new Set(["open", "passed", "failed", "resolved", "unknown"]);

async function smallRegular(path) {
  try {
    const before = await lstat(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(MAX_FILE_BYTES)) return null;
    const content = await readFile(path);
    const after = await stat(path, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs) {
      throw new Error("project source changed during bounded read");
    }
    return { content, bytes: Number(after.size), sha256: digest([...content]) };
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "EACCES" || error.code === "EPERM") return null;
    throw error;
  }
}

function activeProject(state, registrationId, tenantId, groupId) {
  return state.projects.find((item) => item.id === registrationId && item.active
    && item.tenantId === tenantId && item.groupId === groupId);
}

function shouldNotify(observation) {
  return (observation.kind === "error" && ["open", "failed"].includes(observation.status))
    || (observation.kind === "ci" && observation.status === "failed")
    || (observation.kind === "idea" && observation.status === "open");
}

function addNotice(state, project, observation, at) {
  if (!modeAllows(project.mode, "advise") || !shouldNotify(observation)) return null;
  const identity = digest({ projectRegistrationId: project.id, observationId: observation.id });
  const existing = state.notices.find((item) => item.identityDigest === identity);
  if (existing) return existing;
  const notice = signedRecord({
    id: `notice:${identity.slice(0, 32)}`, identityDigest: identity, projectRegistrationId: project.id,
    observationId: observation.id, tenantId: project.tenantId, groupId: project.groupId,
    kind: observation.kind, summary: observation.summary, createdAt: at, presentedAt: null,
    authority: "context-only"
  });
  state.notices.push(notice);
  return notice;
}

export async function recordProjectObservation({
  root = process.cwd(), registrationId, tenantId, groupId = null, kind, status = "open",
  evidenceClass, summary, sourceDigest, observedAt = new Date(), expiresAt = null
}) {
  stableId(registrationId, "registrationId");
  stableId(tenantId, "tenantId");
  stableId(groupId, "groupId", true);
  if (!KINDS.has(kind)) throw new Error("unsupported observation kind");
  if (!STATUSES.has(status)) throw new Error("unsupported observation status");
  if (!EVIDENCE_CLASSES.includes(evidenceClass)) throw new Error("unsupported evidence class");
  if (["ci", "error"].includes(kind) && evidenceClass !== "objective") throw new Error("CI and error findings require objective evidence");
  if (!/^[a-f0-9]{64}$/.test(sourceDigest || "")) throw new Error("sourceDigest must be SHA-256");
  const at = timestamp(observedAt, "observedAt");
  const expiry = timestamp(expiresAt, "expiresAt", true);
  if (expiry && new Date(expiry) <= new Date(at)) throw new Error("expiresAt must follow observedAt");
  const cleanSummary = safeText(summary, "summary", 500);
  const identity = digest({ registrationId, kind, status, evidenceClass, summary: cleanSummary, sourceDigest });
  return mutateAutonomy(root, (state, paths) => {
    const project = activeProject(state, registrationId, tenantId, groupId);
    if (!project) throw new Error("project registration is unavailable in this exact scope");
    const previous = state.observations.find((item) => item.identityDigest === identity);
    if (previous) return { observation: previous, notice: state.notices.find((item) => item.observationId === previous.id) || null,
      duplicate: true, autonomyPath: paths.autonomyPath };
    const observation = signedRecord({
      id: `observation:${identity.slice(0, 32)}`, identityDigest: identity, projectRegistrationId: project.id,
      tenantId, groupId, kind, status, evidenceClass, summary: cleanSummary, sourceDigest,
      observedAt: at, expiresAt: expiry, authority: "context-only"
    });
    state.observations.push(observation);
    const notice = addNotice(state, project, observation, at);
    appendHistory(state, { kind: "observation-recorded", projectRegistrationId: project.id, observationId: observation.id, at });
    return { observation, notice, duplicate: false, autonomyPath: paths.autonomyPath };
  });
}

export async function scanProjectPortfolio({ root = process.cwd(), tenantId, groupId = null, now = new Date() } = {}) {
  stableId(tenantId, "tenantId");
  stableId(groupId, "groupId", true);
  const { state } = await loadAutonomy(root);
  const projects = state.projects.filter((item) => item.active && item.tenantId === tenantId && item.groupId === groupId);
  const results = [];
  for (const project of projects) {
    if (project.source.kind !== "local-root") {
      results.push({ registrationId: project.id, source: project.source, status: "registered-unfetched", authority: "context-only" });
      continue;
    }
    const entries = (await readdir(project.source.value, { withFileTypes: true }))
      .slice(0, MAX_ENTRIES).map((item) => ({ name: item.name.slice(0, 200), kind: item.isDirectory() ? "directory" : item.isFile() ? "file" : "other" }));
    const [pkg, agents, head] = await Promise.all([
      smallRegular(join(project.source.value, "package.json")), smallRegular(join(project.source.value, "AGENTS.md")),
      smallRegular(join(project.source.value, ".git", "HEAD"))
    ]);
    let packageInfo = null;
    let packageError = null;
    if (pkg) {
      try {
        const parsed = JSON.parse(pkg.content.toString("utf8"));
        packageInfo = { name: typeof parsed.name === "string" ? parsed.name.slice(0, 200) : null,
          version: typeof parsed.version === "string" ? parsed.version.slice(0, 80) : null, sha256: pkg.sha256 };
      } catch { packageError = "package.json is not valid JSON"; }
    }
    const snapshotBody = {
      id: `snapshot:${randomUUID()}`, projectRegistrationId: project.id, tenantId, groupId,
      observedAt: timestamp(now, "now"), entries, truncated: entries.length === MAX_ENTRIES,
      package: packageInfo, instructions: agents ? { bytes: agents.bytes, sha256: agents.sha256 } : null,
      gitHead: head ? { bytes: head.bytes, sha256: head.sha256 } : null,
      sourceDigest: digest({ entries, packageInfo, agents: agents?.sha256 || null, head: head?.sha256 || null }),
      authority: "context-only"
    };
    const saved = await mutateAutonomy(root, (current, paths) => {
      const currentProject = activeProject(current, project.id, tenantId, groupId);
      if (!currentProject || currentProject.source.value !== project.source.value) throw new Error("project registration changed during scan");
      const prior = current.snapshots.find((item) => item.projectRegistrationId === project.id && item.sourceDigest === snapshotBody.sourceDigest);
      if (prior) return { snapshot: prior, duplicate: true, autonomyPath: paths.autonomyPath };
      const snapshot = signedRecord(snapshotBody);
      current.snapshots.push(snapshot);
      if (current.snapshots.length > 256) current.snapshots.splice(0, current.snapshots.length - 256);
      appendHistory(current, { kind: "project-scanned", projectRegistrationId: project.id, snapshotId: snapshot.id, at: snapshot.observedAt });
      return { snapshot, duplicate: false, autonomyPath: paths.autonomyPath };
    });
    if (packageError) await recordProjectObservation({ root, registrationId: project.id, tenantId, groupId,
      kind: "error", status: "failed", evidenceClass: "objective", summary: packageError,
      sourceDigest: pkg.sha256, observedAt: now });
    results.push({ registrationId: project.id, source: project.source, status: "scanned", ...saved });
  }
  return { schema: "agentspine.project-portfolio-scan/v1", projects: results, boundedEntries: MAX_ENTRIES, authority: "context-only" };
}

function contextFromState(state, tenantId, groupId, now) {
  const projects = state.projects.filter((item) => item.active && item.tenantId === tenantId && item.groupId === groupId);
  const projectIds = new Set(projects.map((item) => item.id));
  const observations = state.observations.filter((item) => projectIds.has(item.projectRegistrationId)
    && (!item.expiresAt || new Date(item.expiresAt) > now)).slice(-50);
  const observationIds = new Set(observations.map((item) => item.id));
  const lastPresented = state.notices.filter((item) => item.tenantId === tenantId && item.groupId === groupId && item.presentedAt)
    .sort((a, b) => b.presentedAt.localeCompare(a.presentedAt))[0];
  const rateLimited = lastPresented && now - new Date(lastPresented.presentedAt) < 60 * 60 * 1000;
  const notice = rateLimited ? null : state.notices.find((item) => item.tenantId === tenantId && item.groupId === groupId
    && item.presentedAt === null && projectIds.has(item.projectRegistrationId) && observationIds.has(item.observationId)) || null;
  return { projects, observations, notice, rateLimited: Boolean(rateLimited) };
}

export async function projectPortfolioContext({ root = process.cwd(), tenantId, groupId = null, markPresented = false, now = new Date() } = {}) {
  stableId(tenantId, "tenantId");
  stableId(groupId, "groupId", true);
  const at = timestamp(now, "now");
  if (!markPresented) {
    const { state } = await loadAutonomy(root);
    return { schema: "agentspine.project-portfolio-context/v1", ...contextFromState(state, tenantId, groupId, new Date(at)), authority: "context-only" };
  }
  return mutateAutonomy(root, (state) => {
    const context = contextFromState(state, tenantId, groupId, new Date(at));
    if (context.notice) {
      const updated = signedRecord({ ...Object.fromEntries(Object.entries(context.notice).filter(([key]) => key !== "recordDigest")), presentedAt: at });
      state.notices = state.notices.map((item) => item.id === updated.id ? updated : item);
      appendHistory(state, { kind: "notice-presented", projectRegistrationId: updated.projectRegistrationId, noticeId: updated.id, at });
      context.notice = updated;
    }
    return { schema: "agentspine.project-portfolio-context/v1", ...context, authority: "context-only" };
  });
}
