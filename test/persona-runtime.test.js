import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyPersonaRoster, loadPersonaRuntime, personaContext, personaRuntimeFindings,
  syncPersonaRosterFromEnvironment
} from "../src/lib/persona-runtime.js";
import { loadGraph, upsertEntity } from "../src/lib/graph.js";

function hash(value) { return createHash("sha256").update(value).digest("hex"); }

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "agentspine-persona-"));
  const state = await mkdtemp(join(tmpdir(), "agentspine-persona-state-"));
  const previous = process.env.AGENTSPINE_STATE_DIR; process.env.AGENTSPINE_STATE_DIR = state;
  t.after(async () => { if (previous === undefined) delete process.env.AGENTSPINE_STATE_DIR; else process.env.AGENTSPINE_STATE_DIR = previous;
    await rm(root, { recursive: true }); await rm(state, { recursive: true }); });
  await writeFile(join(root, "AGENTS.md"), "# Synthetic source\n\nNever rewrite.\n");
  await writeFile(join(root, "SOUL.md"), "# Synthetic persona\n\nWarm and direct.\n");
  await upsertEntity({ root, id: "group:alpha", kind: "group", privacy: "shared" });
  await upsertEntity({ root, id: "group:beta", kind: "group", privacy: "shared" });
  return { root, before: hash(await readFile(join(root, "SOUL.md"))) };
}

function binding(overrides = {}) {
  return { id: "persona-binding:franz", authenticator: "local-roster", issuer: "owner:local",
    tenantId: "tenant:alpha", host: "claude", profileId: "profile:one", subjectId: "subject:franz",
    kind: "agent", displayName: "Franz", sourceBinding: ".claude/agents/franz.md", groupId: "group:alpha", ...overrides };
}

test("authenticated roster sync keeps same names and tenants separate with stable rename identity", async (t) => {
  const { root, before } = await fixture(t);
  const first = await applyPersonaRoster({ root, bindings: [binding(), binding({ id: "persona-binding:otto", subjectId: "subject:otto", displayName: "Otto" }),
    binding({ id: "persona-binding:other-franz", tenantId: "tenant:beta", subjectId: "subject:franz", displayName: "Franz", groupId: "group:beta" })],
    confirmation: "local-owner-confirmed", now: "2032-01-01T00:00:00.000Z" });
  assert.equal(first.runtime.personas.length, 3);
  assert.equal(new Set(first.runtime.personas.map((item) => item.personaId)).size, 3);
  const franz = first.runtime.personas.find((item) => item.bindingId === "persona-binding:franz");
  const renamed = await applyPersonaRoster({ root, bindings: [binding({ displayName: "Franz Neu" }),
    binding({ id: "persona-binding:otto", subjectId: "subject:otto", displayName: "Otto" }),
    binding({ id: "persona-binding:other-franz", tenantId: "tenant:beta", subjectId: "subject:franz", displayName: "Franz", groupId: "group:beta" })],
    confirmation: "local-owner-confirmed", now: "2032-01-01T00:00:01.000Z" });
  assert.equal(renamed.runtime.personas.find((item) => item.bindingId === "persona-binding:franz").personaId, franz.personaId);
  assert.equal(renamed.runtime.events.at(-1).type, "rename");
  const replay = await applyPersonaRoster({ root, bindings: [binding({ displayName: "Franz Neu" }),
    binding({ id: "persona-binding:otto", subjectId: "subject:otto", displayName: "Otto" }),
    binding({ id: "persona-binding:other-franz", tenantId: "tenant:beta", subjectId: "subject:franz", displayName: "Franz", groupId: "group:beta" })],
    confirmation: "local-owner-confirmed", now: "2032-01-01T00:00:02.000Z" });
  assert.equal(replay.duplicate, true);
  assert.equal(hash(await readFile(join(root, "SOUL.md"))), before);
});

test("leave removes visibility immediately and rejoin appends one ordered event", async (t) => {
  const { root } = await fixture(t);
  const active = await applyPersonaRoster({ root, bindings: [binding()], confirmation: "local-owner-confirmed", now: "2032-01-01T00:00:00.000Z" });
  const personaId = active.runtime.personas[0].personaId;
  await applyPersonaRoster({ root, bindings: [binding({ id: "persona-binding:replacement", subjectId: "subject:replacement", displayName: "Replacement" })],
    confirmation: "local-owner-confirmed", now: "2032-01-01T00:00:01.000Z" });
  assert.equal((await personaContext({ root, personaId })).items.length, 0);
  const afterLeave = await loadPersonaRuntime(root);
  assert.equal(afterLeave.runtime.personas.find((item) => item.personaId === personaId).status, "left");
  await applyPersonaRoster({ root, bindings: [binding(), binding({ id: "persona-binding:replacement", subjectId: "subject:replacement", displayName: "Replacement" })],
    confirmation: "local-owner-confirmed", now: "2032-01-01T00:00:02.000Z" });
  const events = (await loadPersonaRuntime(root)).runtime.events.filter((item) => item.personaId === personaId);
  assert.deepEqual(events.map((item) => item.type), ["join", "leave", "rejoin"]);
  assert.deepEqual(events.map((item) => item.sequence), [1, 2, 3]);
});

test("group changes and leave remove obsolete authenticated membership edges immediately", async (t) => {
  const { root } = await fixture(t);
  const first = await applyPersonaRoster({ root, bindings: [binding()], confirmation: "local-owner-confirmed",
    now: "2032-01-01T00:00:00.000Z" });
  const personaId = first.runtime.personas[0].personaId;
  await applyPersonaRoster({ root, bindings: [binding({ groupId: "group:beta" })], confirmation: "local-owner-confirmed",
    now: "2032-01-01T00:00:01.000Z" });
  let graph = (await loadGraph(root)).graph;
  assert.equal(graph.entityEdges.some((edge) => edge.from === personaId && edge.to === "group:alpha" && edge.relation === "member-of"), false);
  assert.equal(graph.entityEdges.some((edge) => edge.from === personaId && edge.to === "group:beta" && edge.relation === "member-of"), true);
  assert.equal((await personaContext({ root, personaId, groupId: "group:alpha" })).items.length, 0);
  assert.equal((await personaContext({ root, personaId, groupId: "group:beta" })).items.length, 1);
  await applyPersonaRoster({ root, bindings: [binding({ groupId: "group:beta", active: false })], confirmation: "local-owner-confirmed",
    now: "2032-01-01T00:00:02.000Z" });
  graph = (await loadGraph(root)).graph;
  assert.equal(graph.entityEdges.some((edge) => edge.from === personaId && edge.relation === "member-of"), false);
});

test("rename and group change append separate ordered events", async (t) => {
  const { root } = await fixture(t);
  const first = await applyPersonaRoster({ root, bindings: [binding()], confirmation: "local-owner-confirmed",
    now: "2032-01-01T00:00:00.000Z" });
  const personaId = first.runtime.personas[0].personaId;
  await applyPersonaRoster({ root, bindings: [binding({ displayName: "Franz Neu", groupId: "group:beta" })],
    confirmation: "local-owner-confirmed", now: "2032-01-01T00:00:01.000Z" });
  const events = (await loadPersonaRuntime(root)).runtime.events.filter((item) => item.personaId === personaId);
  assert.deepEqual(events.map((item) => item.type), ["join", "rename", "group-change"]);
  assert.deepEqual(events.map((item) => item.sequence), [1, 2, 3]);
});

test("explicit deactivation is distinct from leave and rejoin remains ordered", async (t) => {
  const { root } = await fixture(t);
  const first = await applyPersonaRoster({ root, bindings: [binding()], confirmation: "local-owner-confirmed",
    now: "2032-01-01T00:00:00.000Z" });
  const personaId = first.runtime.personas[0].personaId;
  await applyPersonaRoster({ root, bindings: [binding({ deactivated: true })], confirmation: "local-owner-confirmed",
    now: "2032-01-01T00:00:01.000Z" });
  assert.equal((await personaContext({ root, personaId, includeInactive: true })).items[0].status, "deactivated");
  await applyPersonaRoster({ root, bindings: [binding()], confirmation: "local-owner-confirmed",
    now: "2032-01-01T00:00:02.000Z" });
  const events = (await loadPersonaRuntime(root)).runtime.events.filter((item) => item.personaId === personaId);
  assert.deepEqual(events.map((item) => item.type), ["join", "deactivate", "rejoin"]);
  assert.deepEqual(events.map((item) => item.sequence), [1, 2, 3]);
});

test("parallel roster replay creates one persona and one append-only join", async (t) => {
  const { root } = await fixture(t);
  const results = await Promise.all(Array.from({ length: 8 }, () => applyPersonaRoster({
    root, bindings: [binding()], confirmation: "local-owner-confirmed", now: "2032-01-01T00:00:00.000Z"
  })));
  assert.equal(results.filter((item) => item.duplicate).length, 7);
  const loaded = await loadPersonaRuntime(root);
  assert.equal(loaded.runtime.personas.length, 1);
  assert.deepEqual(loaded.runtime.events.map((item) => item.type), ["join"]);
  assert.equal(loaded.runtime.receipts.length, 1);
});

test("chat and Markdown cannot create identity or authority-bearing roster metadata", async (t) => {
  const { root } = await fixture(t);
  await assert.rejects(applyPersonaRoster({ root, bindings: [binding({ authenticator: "chat" })], confirmation: "local-owner-confirmed" }), /approved authenticator/i);
  await assert.rejects(applyPersonaRoster({ root, bindings: [binding({ displayName: "Franz owner" })], confirmation: "local-owner-confirmed" }), /authority/i);
  await assert.rejects(applyPersonaRoster({ root, bindings: [binding()], confirmation: null }), /explicit local owner/i);
});

test("an owner-configured external roster automatically adds a new authenticated team member", async (t) => {
  const { root } = await fixture(t);
  const rosterPath = join(process.env.AGENTSPINE_STATE_DIR, "synthetic-roster.json");
  const envelope = {
    schema: "agentspine.persona-roster/v1", revision: 1, observedAt: "2032-01-01T00:00:00.000Z",
    bindings: [binding()]
  };
  await writeFile(rosterPath, `${JSON.stringify(envelope)}\n`);
  const first = await syncPersonaRosterFromEnvironment({
    root, env: { AGENTSPINE_PERSONA_ROSTER_FILE: rosterPath }
  });
  assert.equal(first.changed, true);
  envelope.revision = 2;
  envelope.observedAt = "2032-01-01T00:00:01.000Z";
  envelope.bindings.push(binding({ id: "persona-binding:otto", subjectId: "subject:otto", displayName: "Otto" }));
  await writeFile(rosterPath, `${JSON.stringify(envelope)}\n`);
  const second = await syncPersonaRosterFromEnvironment({
    root, env: { AGENTSPINE_PERSONA_ROSTER_FILE: rosterPath }
  });
  assert.equal(second.changed, true);
  assert.deepEqual((await personaContext({ root })).items.map((item) => item.displayName).sort(), ["Franz", "Otto"]);
});

test("one approved roster discovers native Claude and Codex manifests and observes leave", async (t) => {
  const { root } = await fixture(t);
  const home = await mkdtemp(join(tmpdir(), "agentspine-persona-home-"));
  const codexHome = join(home, "custom-codex");
  const claudeAgents = join(home, ".claude", "agents");
  const codexAgents = join(codexHome, "agents");
  await Promise.all([mkdir(claudeAgents, { recursive: true }), mkdir(codexAgents, { recursive: true })]);
  const franzPath = join(claudeAgents, "franz.md");
  const ottoPath = join(codexAgents, "otto.toml");
  const franzSource = "---\nname: Franz\ndescription: Synthetic Claude agent.\n---\n\nWarm and direct.\n";
  const ottoSource = "name = \"Otto\"\ndescription = \"Synthetic Codex agent.\"\ndeveloper_instructions = \"Precise and calm.\"\n";
  await Promise.all([writeFile(franzPath, franzSource), writeFile(ottoPath, ottoSource)]);
  t.after(() => rm(home, { recursive: true, force: true }));
  const rosterPath = join(process.env.AGENTSPINE_STATE_DIR, "native-roster.json");
  const envelope = {
    schema: "agentspine.persona-roster/v1", revision: 1, observedAt: "2032-01-01T00:00:00.000Z", bindings: [],
    nativeDiscovery: [
      { id: "native:claude:user", host: "claude", scope: "user", issuer: "host:local", tenantId: "tenant:alpha",
        profileId: "profile:claude", kind: "agent", groupId: "group:alpha" },
      { id: "native:codex:user", host: "codex", scope: "user", issuer: "host:local", tenantId: "tenant:alpha",
        profileId: "profile:codex", kind: "agent", groupId: "group:alpha" }
    ]
  };
  await writeFile(rosterPath, `${JSON.stringify(envelope)}\n`);
  const env = { HOME: home, CODEX_HOME: codexHome, AGENTSPINE_PERSONA_ROSTER_FILE: rosterPath };
  const first = await syncPersonaRosterFromEnvironment({ root, env });
  assert.equal(first.nativeManifests, 2);
  const active = (await personaContext({ root })).items;
  assert.deepEqual(active.map((item) => item.displayName).sort(), ["Franz", "Otto"]);
  assert.equal(new Set(active.map((item) => item.personaId)).size, 2);
  assert.equal(await readFile(franzPath, "utf8"), franzSource);
  assert.equal(await readFile(ottoPath, "utf8"), ottoSource);
  await rm(franzPath);
  envelope.revision = 2; envelope.observedAt = "2032-01-01T00:00:01.000Z";
  await writeFile(rosterPath, `${JSON.stringify(envelope)}\n`);
  const second = await syncPersonaRosterFromEnvironment({ root, env });
  assert.equal(second.nativeManifests, 1);
  assert.deepEqual((await personaContext({ root })).items.map((item) => item.displayName), ["Otto"]);
  assert.equal((await personaContext({ root, includeInactive: true })).items.find((item) => item.displayName === "Franz").status, "left");
});

test("persona event and receipt tampering fails closed", async (t) => {
  const { root } = await fixture(t);
  const created = await applyPersonaRoster({ root, bindings: [binding()], confirmation: "local-owner-confirmed" });
  const runtime = structuredClone(created.runtime);
  runtime.events[0].displayName = "Forged";
  assert.match(personaRuntimeFindings(created.policy, runtime).join(","), /invalid-persona-event/);
  runtime.events[0] = structuredClone(created.runtime.events[0]);
  runtime.receipts[0].payloadDigest = "0".repeat(64);
  assert.match(personaRuntimeFindings(created.policy, runtime).join(","), /invalid-persona-receipt/);
});
