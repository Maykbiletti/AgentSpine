import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { linkEntities, relationshipContext, upsertEntity } from "../src/lib/graph.js";

test("agents build private relationship context without gaining authority", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agentspine-rel-"));
  const state = await mkdtemp(join(tmpdir(), "agentspine-rel-state-"));
  process.env.AGENTSPINE_STATE_DIR = state;
  t.after(async () => { await rm(root, { recursive: true }); await rm(state, { recursive: true }); });
  await writeFile(join(root, "SOUL.md"), "# Soul\n", "utf8");
  await upsertEntity({ root, id: "agent:builder", kind: "agent", displayName: "Builder", privacy: "shared", attributes: { traits: ["direct"] } });
  await upsertEntity({ root, id: "person:owner", kind: "person", displayName: "Owner", privacy: "private", attributes: { preferences: ["large milestones"] } });
  const linked = await linkEntities({ root, from: "agent:builder", to: "person:owner", relation: "works-with", privacy: "private", confidence: 0.9 });
  assert.equal(linked.edge.authority, "context-only");
  const publicView = await relationshipContext({ root, entityId: "agent:builder", includePrivate: false });
  assert.equal(publicView.edges.length, 0);
  await assert.rejects(
    relationshipContext({ root, entityId: "person:owner", includePrivate: false }),
    /requires includePrivate/
  );
  const privateView = await relationshipContext({ root, entityId: "agent:builder", includePrivate: true });
  assert.equal(privateView.edges.length, 1);
  assert.equal(privateView.authority, "context-only");

  await upsertEntity({ root, id: "person:owner", kind: "person", displayName: "Owner", privacy: "private", attributes: { preferences: ["coherent releases"] } });
  const learned = await relationshipContext({ root, entityId: "person:owner", includePrivate: true });
  assert.equal(learned.entity.attributes.preferences[0], "coherent releases");
  assert.equal(learned.history.some((entry) => entry.kind === "entity" && entry.value.attributes.preferences[0] === "large milestones"), true);
  assert.equal(learned.history.every((entry) => entry.authority === "context-only"), true);
});

test("relationship memory rejects permission and credential fields", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agentspine-rel-"));
  const state = await mkdtemp(join(tmpdir(), "agentspine-rel-state-"));
  process.env.AGENTSPINE_STATE_DIR = state;
  t.after(async () => { await rm(root, { recursive: true }); await rm(state, { recursive: true }); });
  await assert.rejects(
    upsertEntity({ root, id: "agent:test", kind: "agent", attributes: { permissions: ["admin"] } }),
    /authority data/
  );
  await assert.rejects(
    upsertEntity({ root, id: "agent:test", kind: "agent", attributes: { rights: ["delegate"] } }),
    /authority data/
  );
  await assert.rejects(
    upsertEntity({ root, id: "person:test", kind: "person", attributes: { profile: { apiKey: "secret" } } }),
    /authority data/
  );
});
