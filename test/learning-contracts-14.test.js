import {
  test, assert, readFile, writeFile, join,
  deleteLearning, loadLearning, proposeLearning, reviewLearning, upsertEntity,
  fixture, hash, scopedTurn
} from "./learning-fixture.js";
import {
  deletionEvidenceDigest, deletionTargetDigest
} from "../src/lib/learning-deletions.js";

function documented(id, summary, sourceDocument, observedAt) {
  return { id, type: "document", summary, sourceDocument, confidence: 0.96, observedAt };
}

test("deleted document evidence cannot return through a paraphrase or renamed source", async (t) => {
  const { root } = await fixture(t);
  const agentBytes = await readFile(join(root, "AGENTS.md"));
  const sourceBytes = await readFile(join(root, "REFERENCE.md"));
  const claim = "The synthetic user prefers compact status reports.";
  await upsertEntity({ root, id: "person:source-replay", kind: "person", privacy: "private" });

  await proposeLearning({
    root, id: "learning:source-replay", kind: "preference", claim,
    subjectId: "person:source-replay", scope: scopedTurn,
    evidence: documented("evidence:source-replay", "The reference records a compact-report preference.",
      "REFERENCE.md", "2046-01-01T00:00:00.000Z"),
    now: new Date("2046-01-01T00:00:00.000Z")
  });
  await reviewLearning({
    root, id: "learning:source-replay", decision: "accept", reason: "Synthetic local review.",
    confirmedByUser: true, now: new Date("2046-01-01T00:01:00.000Z")
  });
  await deleteLearning({
    root, id: "learning:source-replay", confirmation: "local-user-purge-confirmed",
    now: new Date("2046-01-01T00:02:00.000Z")
  });

  const stored = await loadLearning(root);
  const tombstone = stored.learning.deletionTombstones[0];
  assert.equal(tombstone.schema, "agentspine.learning-deletion/v2");
  assert.equal(tombstone.sourceDigests.length, 1);
  assert.doesNotMatch(JSON.stringify(tombstone),
    /compact status|compact-report|REFERENCE|person:source-replay|learning:source-replay|evidence:source-replay/);
  const intactState = JSON.stringify(stored.learning);
  tombstone.sourceDigests[0] = hash("tampered source digest");
  await writeFile(stored.learningPath, `${JSON.stringify(stored.learning)}\n`, "utf8");
  await assert.rejects(loadLearning(root), /learning deletion tombstone state is invalid/);
  await writeFile(stored.learningPath, `${intactState}\n`, "utf8");

  await writeFile(join(root, "REFERENCE-COPY.md"), sourceBytes);
  await assert.rejects(proposeLearning({
    root, id: "learning:source-paraphrase", kind: "preference", claim,
    subjectId: "person:source-replay", scope: scopedTurn,
    evidence: documented("evidence:source-paraphrase", "A differently worded summary of the same source.",
      "REFERENCE-COPY.md", "2046-02-01T00:00:00.000Z"),
    now: new Date("2046-02-01T00:00:00.000Z")
  }), /deleted learning evidence cannot be reused/,
  "renaming an unchanged source and paraphrasing its summary must not bypass deletion");

  await writeFile(join(root, "REFERENCE-UPDATED.md"), "# Synthetic reference\n\nNew explicit evidence.\n", "utf8");
  const fresh = await proposeLearning({
    root, id: "learning:source-updated", kind: "preference", claim,
    subjectId: "person:source-replay", scope: scopedTurn,
    evidence: documented("evidence:source-updated", "A changed source records the preference again.",
      "REFERENCE-UPDATED.md", "2046-03-01T00:00:00.000Z"),
    now: new Date("2046-03-01T00:00:00.000Z")
  });
  assert.equal(fresh.candidate.requiresLocalReview, true,
    "changed source bytes may create a candidate but cannot silently restore deleted memory");
  assert.deepEqual(await readFile(join(root, "AGENTS.md")), agentBytes);
  assert.deepEqual(await readFile(join(root, "REFERENCE.md")), sourceBytes);
});

test("version-one deletion tombstones remain valid and suppress exact evidence replay", async (t) => {
  const { root } = await fixture(t);
  const sourceBytes = await readFile(join(root, "AGENTS.md"));
  const claim = "The synthetic project keeps legacy deletion suppression.";
  await proposeLearning({
    root, id: "learning:legacy-deletion", kind: "project-fact", claim, scope: scopedTurn,
    evidence: {
      id: "evidence:legacy-deletion", type: "user-statement", summary: "Legacy deletion evidence.",
      confidence: 0.95, observedAt: "2046-04-01T00:00:00.000Z"
    }, now: new Date("2046-04-01T00:00:00.000Z")
  });
  const stored = await loadLearning(root);
  const candidate = stored.learning.candidates[0];
  const payload = {
    schema: "agentspine.learning-deletion/v1",
    id: `learning-deletion:${hash("legacy deletion tombstone")}`,
    targetDigest: deletionTargetDigest(candidate),
    evidenceDigests: [deletionEvidenceDigest(candidate.evidence[0])],
    deletedAt: "2046-04-01T00:01:00.000Z",
    authority: "context-only"
  };
  stored.learning.candidates = [];
  stored.learning.history = [];
  stored.learning.deletionTombstones = [{ ...payload, digest: hash(JSON.stringify(payload)) }];
  await writeFile(stored.learningPath, `${JSON.stringify(stored.learning)}\n`, "utf8");
  assert.equal((await loadLearning(root)).learning.deletionTombstones[0].schema,
    "agentspine.learning-deletion/v1");

  await assert.rejects(proposeLearning({
    root, id: "learning:legacy-replay", kind: "project-fact", claim, scope: scopedTurn,
    evidence: {
      id: "evidence:legacy-renamed", type: "user-statement", summary: "Legacy deletion evidence.",
      confidence: 0.99, observedAt: "2046-05-01T00:00:00.000Z"
    }, now: new Date("2046-05-01T00:00:00.000Z")
  }), /deleted learning evidence cannot be reused/);
  assert.deepEqual(await readFile(join(root, "AGENTS.md")), sourceBytes);
});
