import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAudit } from "./audit.js";
import { deleteAttention, loadAttention } from "./attention.js";
import { configureContinuity, purgeContinuity } from "./continuity.js";
import { createTask } from "./coordination.js";
import { linkEntities, upsertEntity } from "./graph.js";
import { loadLearning, rollbackLearning } from "./learning.js";
import {
  grantExecution, loadSelfstarter, registerJob
} from "./selfstarter.js";
import { runHook } from "../hook.js";
import { VERSION } from "../version.js";

const SCHEMA = "agentspine.acceptance/v1";
const SCENARIO = "acceptance:multilingual-team-v1";
const FIXED_TIME = "2031-04-05T09:00:00.000Z";

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function packet(result) {
  return JSON.parse(result.context);
}

function requireCondition(condition, detail) {
  if (!condition) throw new Error(detail);
}

function receipt(id, evidence) {
  return digest(`${SCHEMA}\0${id}\0${JSON.stringify(evidence)}`);
}

function addCheck(checks, id, label, detail, evidence) {
  checks.push({ id, label, status: "PASS", detail, receipt: receipt(id, evidence) });
}

function sourceHashes(sources) {
  return Object.fromEntries(Object.entries(sources).map(([name, content]) => [name, digest(content)]));
}

async function currentSourceHashes(root, names) {
  return Object.fromEntries(await Promise.all(names.map(async (name) => [name, digest(await readFile(join(root, name)))])));
}

function styleClaims(context) {
  return context.briefing.learning.map((item) => item.claim);
}

function attentionKinds(context) {
  return context.briefing.attention.items.map((item) => item.kind);
}

export function renderAcceptanceReport(report) {
  const lines = report.checks.map((check) => `[${check.status}] ${check.label} — ${check.detail} · receipt=${check.receipt.slice(0, 16)}`);
  lines.push(`[PASS] Gesamt — ${report.passed}/${report.total} Gates · receipt=${report.receiptDigest}`);
  return `${lines.join("\n")}\n`;
}

export async function runVisibleAcceptance() {
  const projectRoot = await mkdtemp(join(tmpdir(), "agentspine-visible-acceptance-project-"));
  const stateRoot = await mkdtemp(join(tmpdir(), "agentspine-visible-acceptance-state-"));
  const previousState = process.env.AGENTSPINE_STATE_DIR;
  process.env.AGENTSPINE_STATE_DIR = stateRoot;
  const checks = [];
  const sources = {
    "AGENTS.md": "# Team rules\n\nThe current request and explicit stops win.\n",
    "CLAUDE.md": "# Claude host\n\nKeep the native host hierarchy.\n",
    "SOUL.md": "# Soul\n\nBe warm, precise, and honest.\n"
  };
  const expectedSources = sourceHashes(sources);
  try {
    for (const [name, content] of Object.entries(sources)) await writeFile(join(projectRoot, name), content, "utf8");
    const entities = [
      ["person:freja", "person", "Freja Åström"],
      ["person:lucia", "person", "Lucía Ortega"],
      ["group:nord", "group", "Nordgruppen"],
      ["group:sol", "group", "Equipo Sol"],
      ["project:aurora", "project", "Aurora"],
      ["project:brisa", "project", "Brisa"]
    ];
    for (const [id, kind, displayName] of entities) {
      await upsertEntity({ root: projectRoot, id, kind, displayName, privacy: "shared", confidence: 1 });
    }
    await linkEntities({ root: projectRoot, from: "person:freja", to: "group:nord", relation: "member-of", privacy: "group", confidence: 1 });
    await linkEntities({ root: projectRoot, from: "person:lucia", to: "group:sol", relation: "member-of", privacy: "group", confidence: 1 });
    for (const task of [
      { id: "task:aurora", actorId: "person:freja", assigneeId: "person:freja", projectId: "project:aurora", title: "Verifiera Aurora", privacy: "private" },
      { id: "task:brisa", actorId: "person:lucia", assigneeId: "person:lucia", projectId: "project:brisa", title: "Revisar Brisa", privacy: "private" },
      { id: "task:nord", actorId: "person:freja", assigneeId: "person:freja", projectId: "project:aurora", groupId: "group:nord", title: "Granska nordisk leverans", privacy: "group" },
      { id: "task:sol", actorId: "person:lucia", assigneeId: "person:lucia", projectId: "project:brisa", groupId: "group:sol", title: "Revisar entrega del equipo", privacy: "group" }
    ]) await createTask({ root: projectRoot, ...task });
    addCheck(checks, "identity", "Kanonische Identitäten", "Freja und Lucía sowie beide Gruppen besitzen getrennte stabile IDs.", entities.map(([id]) => id));

    await configureContinuity({ root: projectRoot, config: { enabled: true }, confirmation: "local-user-opt-in", now: FIXED_TIME });
    const swedish = await runHook({
      hook_event_name: "UserPromptSubmit", host: "claude", cwd: projectRoot,
      entity_id: "person:freja", project_id: "project:aurora", task_id: "task:aurora",
      session_id: "session:freja:prompt", event_id: "prompt:freja:style", timestamp: FIXED_TIME,
      prompt: "Svara alltid kortfattat och varmt."
    });
    const spanish = await runHook({
      hook_event_name: "UserPromptSubmit", host: "codex", cwd: projectRoot,
      entity_id: "person:lucia", project_id: "project:brisa", task_id: "task:brisa",
      session_id: "session:lucia:prompt", event_id: "prompt:lucia:style", timestamp: FIXED_TIME,
      prompt: "Responde siempre de forma clara y breve."
    });
    requireCondition(swedish.signal?.accepted && spanish.signal?.accepted, "multilingual style signals were not accepted");
    addCheck(checks, "languages", "Mehrsprachige Stilkontinuität", "Schwedische und spanische Stilwünsche wurden nach Opt-in minimal und belegt angenommen.", [swedish.signal.learningId, spanish.signal.learningId]);

    await runHook({
      hook_event_name: "UserPromptSubmit", host: "claude", cwd: projectRoot,
      entity_id: "person:freja", project_id: "project:aurora", task_id: "task:aurora",
      session_id: "session:freja:promise", event_id: "prompt:freja:promise", timestamp: "2031-04-05T09:01:00.000Z",
      prompt: "Jag lovar att kontrollera den synliga leveransen."
    });
    await runHook({
      hook_event_name: "PostToolUse", host: "claude", cwd: projectRoot,
      entity_id: "person:freja", project_id: "project:aurora", task_id: "task:aurora",
      session_id: "session:freja:heartbeat", tool_use_id: "tool:heartbeat:freja", timestamp: "2031-04-05T09:02:00.000Z"
    });
    await runHook({
      hook_event_name: "PostToolUse", host: "codex", cwd: projectRoot,
      entity_id: "person:freja", group_id: "group:nord", project_id: "project:aurora", task_id: "task:nord",
      session_id: "session:nord:blocker", tool_use_id: "tool:blocker:nord", timestamp: "2031-04-05T09:03:00.000Z",
      agent_spine_attention: { id: "event:blocker:nord", kind: "blocker", summary: "Blockerad av den syntetiska granskningen.", privacy: "group" }
    });
    const attentionState = (await loadAttention(projectRoot)).attention;
    requireCondition(new Set(attentionState.events.map((item) => item.kind)).size === 3, "heartbeat, promise, and blocker were not all retained");
    addCheck(checks, "attention", "Heartbeat, Zusage und Blocker", "Alle drei Ereignisarten sind dauerhaft, dedupliziert und mit Provenienz gespeichert.", attentionState.events.map((item) => [item.id, item.kind, item.provenance.digest]));

    const frejaRestart = packet(await runHook({
      hook_event_name: "SessionStart", host: "claude", cwd: projectRoot,
      entity_id: "person:freja", project_id: "project:aurora", task_id: "task:aurora",
      session_id: "session:freja:restart", timestamp: "2031-04-05T09:04:00.000Z"
    }));
    const luciaCompact = packet(await runHook({
      hook_event_name: "PostCompact", host: "codex", cwd: projectRoot,
      entity_id: "person:lucia", project_id: "project:brisa", task_id: "task:brisa",
      session_id: "session:lucia:compact", timestamp: "2031-04-05T09:04:00.000Z"
    }));
    requireCondition(styleClaims(frejaRestart).some((claim) => claim.includes("kortfattat och varmt")), "Swedish style did not survive restart");
    requireCondition(styleClaims(luciaCompact).some((claim) => claim.includes("clara y breve")), "Spanish style did not survive compaction");
    requireCondition(attentionKinds(frejaRestart).includes("promise"), "promise did not survive restart");
    addCheck(checks, "restart", "Echter Neustart", "Claude erhielt Frejas Stil und Zusage automatisch ohne MCP-Aufruf.", [frejaRestart.event, styleClaims(frejaRestart), attentionKinds(frejaRestart)]);
    addCheck(checks, "compaction", "Echte Kompaktierungsgrenze", "Codex erhielt Lucías spanischen Stil automatisch nach PostCompact.", [luciaCompact.event, styleClaims(luciaCompact)]);

    const wrongPerson = packet(await runHook({
      hook_event_name: "SessionStart", host: "claude", cwd: projectRoot,
      entity_id: "person:lucia", project_id: "project:brisa", task_id: "task:brisa",
      session_id: "session:wrong-person", timestamp: "2031-04-05T09:05:00.000Z"
    }));
    const correctGroup = packet(await runHook({
      hook_event_name: "SessionStart", host: "codex", cwd: projectRoot,
      entity_id: "person:freja", group_id: "group:nord", project_id: "project:aurora", task_id: "task:nord",
      session_id: "session:group:nord", timestamp: "2031-04-05T09:05:00.000Z"
    }));
    const wrongGroup = packet(await runHook({
      hook_event_name: "SessionStart", host: "codex", cwd: projectRoot,
      entity_id: "person:lucia", group_id: "group:sol", project_id: "project:brisa", task_id: "task:sol",
      session_id: "session:group:sol", timestamp: "2031-04-05T09:05:00.000Z"
    }));
    requireCondition(!styleClaims(wrongPerson).some((claim) => claim.includes("kortfattat")), "person isolation leaked Freja's style");
    requireCondition(correctGroup.briefing.attention.items.some((item) => item.key === "event:event:blocker:nord"), "exact group did not receive its blocker");
    requireCondition(!wrongGroup.briefing.attention.items.some((item) => item.key === "event:event:blocker:nord"), "group isolation leaked the Nordic blocker");
    addCheck(checks, "isolation", "Personen- und Gruppenisolation", "Fremde Personen und Equipo Sol sahen weder Frejas Stil noch den Nordgruppen-Blocker.", [styleClaims(wrongPerson), correctGroup.briefing.attention.items.map((item) => item.key), wrongGroup.briefing.attention.items.map((item) => item.key)]);

    const correction = await runHook({
      hook_event_name: "UserPromptSubmit", host: "claude", cwd: projectRoot,
      entity_id: "person:freja", project_id: "project:aurora", task_id: "task:aurora",
      session_id: "session:freja:correction", event_id: "prompt:freja:correction", timestamp: "2031-04-05T09:06:00.000Z",
      prompt: "Korrigering: Vid säkerhetsfrågor ska svaret vara utförligt."
    });
    const corrected = packet(await runHook({
      hook_event_name: "PostCompact", host: "claude", cwd: projectRoot,
      entity_id: "person:freja", project_id: "project:aurora", task_id: "task:aurora",
      session_id: "session:freja:corrected", timestamp: "2031-04-05T09:07:00.000Z"
    }));
    requireCondition(styleClaims(corrected).some((claim) => claim.includes("säkerhetsfrågor")), "correction was not applied after compaction");
    await rollbackLearning({ root: projectRoot, id: correction.signal.learningId, reason: "Reproduzierbarer synthetischer Rollback.", now: "2031-04-05T09:08:00.000Z" });
    const rolledBack = packet(await runHook({
      hook_event_name: "SessionStart", host: "claude", cwd: projectRoot,
      entity_id: "person:freja", project_id: "project:aurora", task_id: "task:aurora",
      session_id: "session:freja:rollback", timestamp: "2031-04-05T09:09:00.000Z"
    }));
    requireCondition(!styleClaims(rolledBack).some((claim) => claim.includes("säkerhetsfrågor")), "rolled-back correction remained active");
    requireCondition(styleClaims(rolledBack).some((claim) => claim.includes("kortfattat")), "prior style was not restored after rollback");
    addCheck(checks, "correction", "Korrektur und Historie", "Die schwedische Korrektur wirkte nach Kompaktierung und ersetzte keine frühere Antwort oder Historie.", correction.signal.learningId);
    addCheck(checks, "rollback", "Atomarer Rollback", "Rollback entfernte die Korrektur aus aktivem Kontext und stellte den vorherigen Stil wieder her.", styleClaims(rolledBack));

    await grantExecution({
      root: projectRoot, id: "execution-grant:acceptance", jobId: "job:acceptance", actorId: "person:freja",
      taskId: "task:aurora", targetId: "person:lucia", projectId: "project:aurora", host: "claude",
      capabilities: ["tool:Write"], reason: "Owner approved one exact synthetic acceptance artifact.",
      confirmation: "local-owner-confirmed", now: "2031-04-05T09:10:00.000Z"
    });
    await registerJob({
      root: projectRoot, id: "job:acceptance", grantId: "execution-grant:acceptance",
      confirmation: "local-owner-confirmed", now: "2031-04-05T09:10:01.000Z"
    });
    const executionScope = {
      cwd: projectRoot, host: "claude", entity_id: "person:freja",
      project_id: "project:aurora", task_id: "task:aurora"
    };
    const started = packet(await runHook({
      ...executionScope, hook_event_name: "SessionStart", session_id: "session:job:one", timestamp: "2031-04-05T09:10:02.000Z"
    }));
    requireCondition(started.selfstarter?.action === "start", "authorized job did not start");
    const authorized = await runHook({
      ...executionScope, hook_event_name: "PreToolUse", session_id: "session:job:one",
      tool_name: "Write", tool_use_id: "tool:acceptance:one", timestamp: "2031-04-05T09:10:03.000Z",
      tool_input: { file_path: join(projectRoot, "acceptance-output.txt"), content: "checkpointed\n" }
    });
    requireCondition(!authorized.blocked && authorized.selfstarter?.allowed, "current exact effect was denied");
    await writeFile(join(projectRoot, "acceptance-output.txt"), "checkpointed\n", "utf8");
    await runHook({
      ...executionScope, hook_event_name: "PostToolUse", session_id: "session:job:one",
      tool_name: "Write", tool_use_id: "tool:acceptance:one", timestamp: "2031-04-05T09:10:04.000Z",
      success: true, tool_result: { ok: true }
    });
    await runHook({
      ...executionScope, hook_event_name: "Stop", session_id: "session:job:one", event_id: "stop:job:one",
      timestamp: "2031-04-05T09:10:05.000Z"
    });
    const resumed = packet(await runHook({
      ...executionScope, hook_event_name: "SessionStart", session_id: "session:job:two", timestamp: "2031-04-05T09:10:06.000Z"
    }));
    requireCondition(resumed.selfstarter?.action === "resume" && resumed.selfstarter.checkpointSequence === 1, "durable checkpoint did not resume");
    const denied = await runHook({
      ...executionScope, hook_event_name: "PreToolUse", entity_id: "person:lucia", session_id: "session:job:two",
      tool_name: "Write", tool_use_id: "tool:acceptance:denied", timestamp: "2031-04-05T09:10:07.000Z",
      tool_input: { file_path: join(projectRoot, "denied.txt"), content: "must not exist\n" }
    });
    requireCondition(denied.blocked && /actor scope mismatch/.test(denied.reason), "wrong actor was not visibly denied");
    await runHook({
      ...executionScope, hook_event_name: "Stop", session_id: "session:job:two", event_id: "stop:job:two",
      timestamp: "2031-04-05T09:10:08.000Z"
    });
    const durable = (await loadSelfstarter(projectRoot)).state;
    const job = durable.jobs.find((item) => item.id === "job:acceptance");
    requireCondition(job.checkpoint.sequence === 1 && durable.receipts.some((item) => item.event === "effect-succeeded"), "checkpoint receipt was not durable");
    addCheck(checks, "authorized-resume", "Berechtigtes Resume", "Der zweite Claude-Hoststart nahm Checkpoint 1 ohne MCP-Aufruf wieder auf.", [resumed.selfstarter.receiptId, job.checkpoint.workspaceDigest]);
    addCheck(checks, "denied-resume", "Verweigerte Fremdwirkung", "Lucía konnte Frejas laufende Lease trotz bekannter Aufgabe nicht verwenden.", denied.reason);
    addCheck(checks, "checkpoint", "Dauerhaftes Checkpointing", "Effekt, Ergebnis-Digest, Stop und Resume besitzen idempotente externe Receipts.", durable.receipts.map((item) => [item.id, item.event, item.digest]));

    await purgeContinuity({ root: projectRoot, subjectId: "person:lucia", confirmation: "local-user-confirmed", now: "2031-04-05T09:11:00.000Z" });
    await deleteAttention({ root: projectRoot, entityId: "person:lucia" });
    const purged = packet(await runHook({
      hook_event_name: "SessionStart", host: "codex", cwd: projectRoot,
      entity_id: "person:lucia", project_id: "project:brisa", task_id: "task:brisa",
      session_id: "session:lucia:purged", timestamp: "2031-04-05T09:12:00.000Z"
    }));
    const remainingLearning = (await loadLearning(projectRoot)).learning.candidates.filter((item) => item.subjectId === "person:lucia");
    requireCondition(remainingLearning.length === 0 && styleClaims(purged).length === 0, "person purge left accepted context behind");
    addCheck(checks, "purge", "Vollständiger Personen-Purge", "Lucías Stil-, Signal- und Aufmerksamkeitszustand blieb nach neuem Codex-Start gelöscht.", [remainingLearning.length, styleClaims(purged).length]);

    const actualSources = await currentSourceHashes(projectRoot, Object.keys(sources));
    requireCondition(JSON.stringify(actualSources) === JSON.stringify(expectedSources), "protected source bytes changed during acceptance");
    requireCondition((await readFile(join(projectRoot, "acceptance-output.txt"), "utf8")) === "checkpointed\n", "authorized checkpoint artifact is missing");
    let deniedExists = true;
    try { await readFile(join(projectRoot, "denied.txt")); } catch (error) { if (error.code === "ENOENT") deniedExists = false; else throw error; }
    requireCondition(!deniedExists, "denied effect changed the workspace");
    addCheck(checks, "source-bytes", "Bytegenaue Quellerhaltung", "AGENTS.md, CLAUDE.md und SOUL.md blieben über alle Hooks unverändert.", actualSources);

    const audit = await runAudit(projectRoot);
    requireCondition(audit.ok && audit.passed === audit.total, "final ten-gate audit failed");
    addCheck(checks, "audit", "Abschluss-Audit", "Alle zehn Sicherheits-, Privacy-, Authority- und Erhaltungsgates sind grün.", [audit.passed, audit.total]);

    const report = {
      schema: SCHEMA,
      version: VERSION,
      scenarioId: SCENARIO,
      ok: true,
      passed: checks.length,
      total: checks.length,
      hosts: ["claude", "codex"],
      languages: ["sv-SE", "es-ES"],
      mcpCalls: 0,
      checks,
      sourceHashes: actualSources,
      receiptDigest: digest(checks.map((check) => `${check.id}:${check.receipt}`).join("\n")),
      authority: "acceptance-evidence-only"
    };
    return report;
  } finally {
    if (previousState === undefined) delete process.env.AGENTSPINE_STATE_DIR;
    else process.env.AGENTSPINE_STATE_DIR = previousState;
    await rm(projectRoot, { recursive: true, force: true });
    await rm(stateRoot, { recursive: true, force: true });
  }
}
