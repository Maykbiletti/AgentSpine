import {
  test, assert, readFile, join,
  loadLearning, proposeLearning, upsertEntity, fixture, scopedTurn
} from "./learning-fixture.js";
import {
  purgeLearningBySubject as publicSubjectPurge
} from "../src/lib/learning.js";

test("public subject purge requires local confirmation before deleting learning", async (t) => {
  const { root } = await fixture(t);
  const sourceBytes = await readFile(join(root, "AGENTS.md"));
  await upsertEntity({ root, id: "person:subject-purge", kind: "person", privacy: "private" });
  await proposeLearning({
    root, id: "learning:subject-purge-gate", kind: "preference",
    claim: "The synthetic user prefers a concise response.",
    subjectId: "person:subject-purge", scope: scopedTurn,
    evidence: {
      id: "evidence:subject-purge-gate", type: "user-statement",
      summary: "Synthetic explicit preference evidence.", confidence: 0.96,
      observedAt: "2047-01-01T00:00:00.000Z"
    }, now: new Date("2047-01-01T00:00:00.000Z")
  });
  const before = await loadLearning(root);
  const stateBytes = await readFile(before.learningPath);

  await assert.rejects(publicSubjectPurge({ root, subjectId: null }),
    /explicit local user confirmation/,
    "confirmation must be checked before exposing whether a subject exists");
  await assert.rejects(publicSubjectPurge({
    root, subjectId: "person:subject-purge", confirmation: "local-user-confirmed"
  }), /explicit local user confirmation/,
  "a weaker continuity confirmation token must not authorize permanent learning deletion");
  assert.deepEqual(await readFile(before.learningPath), stateBytes,
    "unconfirmed public purge must not change learning state bytes");

  const purged = await publicSubjectPurge({
    root, subjectId: "person:subject-purge", confirmation: "local-user-purge-confirmed",
    now: new Date("2047-01-01T00:01:00.000Z")
  });
  assert.equal(purged.deleted, 1);
  const after = await loadLearning(root);
  assert.equal(after.learning.candidates.length, 0);
  assert.equal(after.learning.deletionTombstones.length, 1);
  assert.deepEqual(await readFile(join(root, "AGENTS.md")), sourceBytes);
});
