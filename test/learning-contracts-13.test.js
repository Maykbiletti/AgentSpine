import {
  test, assert, readFile, writeFile, join,
  deleteLearning, learningContext, loadLearning, proposeLearning, purgeLearningBySubject,
  reviewLearning, upsertEntity, fixture, hash, scopedTurn
} from "./learning-fixture.js";
import { acceptContinuityLearning } from "../src/lib/learning.js";

function stated(id, summary, observedAt, confidence = 0.95) {
  return { id, type: "user-statement", summary, confidence, observedAt };
}

test("confirmed deletion suppresses old evidence without retaining memory content", async (t) => {
  const { root } = await fixture(t);
  const sourceBytes = await readFile(join(root, "AGENTS.md"));
  const start = "2045-01-01T00:00:00.000Z";
  const oldSummary = "The synthetic user explicitly asked to be called Karl.";
  await upsertEntity({ root, id: "person:deletion-a", kind: "person", privacy: "private" });
  await upsertEntity({ root, id: "person:deletion-b", kind: "person", privacy: "private" });

  await proposeLearning({
    root, id: "learning:deleted-name-a", kind: "preference", claim: "Call the synthetic user Karl.",
    subjectId: "person:deletion-a", scope: scopedTurn,
    evidence: stated("evidence:deleted-name-a", oldSummary, start), now: new Date(start)
  });
  await reviewLearning({
    root, id: "learning:deleted-name-a", decision: "accept", reason: "Synthetic explicit preference.",
    confirmedByUser: true, now: new Date("2045-01-01T00:01:00.000Z")
  });
  assert.deepEqual((await learningContext({ root, scope: scopedTurn, includePrivate: true,
    now: new Date("2045-01-01T00:02:00.000Z") })).items.map((item) => item.id),
  ["learning:deleted-name-a"]);

  await deleteLearning({
    root, id: "learning:deleted-name-a", confirmation: "local-user-purge-confirmed",
    now: new Date("2045-01-01T00:03:00.000Z")
  });
  let stored = await loadLearning(root);
  assert.equal(stored.learning.candidates.length, 0);
  assert.equal(stored.learning.deletionTombstones.length, 1);
  assert.doesNotMatch(JSON.stringify(stored.learning.deletionTombstones),
    /Karl|synthetic user explicitly|person:deletion-a|evidence:deleted-name-a|learning:deleted-name-a/);
  assert.deepEqual((await learningContext({ root, scope: scopedTurn, includePrivate: true,
    now: new Date("2045-01-01T00:04:00.000Z") })).items, []);

  await assert.rejects(proposeLearning({
    root, id: "learning:replayed-name-a", kind: "preference", claim: "Call the synthetic user Karl.",
    subjectId: "person:deletion-a", scope: scopedTurn,
    evidence: stated("evidence:renamed-replay", oldSummary, "2045-02-01T00:00:00.000Z", 0.99),
    now: new Date("2045-02-01T00:00:00.000Z")
  }), /deleted learning evidence cannot be reused/,
  "renaming or redating the same deleted evidence must not resurrect it");

  const revived = await proposeLearning({
    root, id: "learning:new-name-a", kind: "preference", claim: "Call the synthetic user Karl.",
    subjectId: "person:deletion-a", scope: scopedTurn,
    evidence: stated("evidence:new-name-a", "The preference was explicitly stated again in a later session.",
      "2045-03-01T00:00:00.000Z"), now: new Date("2045-03-01T00:00:00.000Z")
  });
  assert.equal(revived.candidate.requiresLocalReview, true,
    "new evidence for a deleted target must remain behind explicit local review");
  await assert.rejects(acceptContinuityLearning({
    root, id: revived.candidate.id,
    proof: {
      mode: "automatic-continuity-low-risk", localOptIn: true,
      minConfidence: 0.9, minEvidence: 1, minDirectness: 0.9, directness: 1
    },
    now: new Date("2045-03-01T00:00:30.000Z")
  }), /requires explicit local review/,
  "automatic continuity must not bypass deletion re-confirmation");
  await reviewLearning({
    root, id: revived.candidate.id, decision: "accept", reason: "Synthetic later confirmation.",
    confirmedByUser: true, now: new Date("2045-03-01T00:01:00.000Z")
  });

  const otherUser = await proposeLearning({
    root, id: "learning:name-b", kind: "preference", claim: "Call the synthetic user Karl.",
    subjectId: "person:deletion-b", scope: scopedTurn,
    evidence: stated("evidence:name-b", "A different synthetic user stated the same preferred name.",
      "2045-03-02T00:00:00.000Z"), now: new Date("2045-03-02T00:00:00.000Z")
  });
  assert.equal(otherUser.candidate.id, "learning:name-b");
  assert.equal(otherUser.unchanged, undefined, "same text for another subject must not alias the first user");

  const changed = await proposeLearning({
    root, id: "learning:changed-name-a", kind: "preference", claim: "Call the synthetic user Ada.",
    subjectId: "person:deletion-a", scope: scopedTurn, supersedesId: revived.candidate.id,
    evidence: stated("evidence:changed-name-a", "The synthetic user explicitly changed the preference to Ada.",
      "2045-03-03T00:00:00.000Z"), now: new Date("2045-03-03T00:00:00.000Z")
  });
  assert.deepEqual(changed.candidate.conflictsWith, [],
    "another subject with the same scope must not create a cross-user conflict");

  await purgeLearningBySubject({ root, subjectId: "person:deletion-b",
    now: new Date("2045-03-04T00:00:00.000Z") });
  await assert.rejects(proposeLearning({
    root, id: "learning:replayed-name-b", kind: "preference", claim: "Call the synthetic user Karl.",
    subjectId: "person:deletion-b", scope: scopedTurn,
    evidence: stated("evidence:renamed-b", "A different synthetic user stated the same preferred name.",
      "2045-04-01T00:00:00.000Z"), now: new Date("2045-04-01T00:00:00.000Z")
  }), /deleted learning evidence cannot be reused/,
  "subject purge must retain only the suppression proof needed to reject old evidence");

  stored = await loadLearning(root);
  const original = JSON.stringify(stored.learning);
  stored.learning.deletionTombstones[0].targetDigest = hash("tampered deletion target");
  await writeFile(stored.learningPath, `${JSON.stringify(stored.learning)}\n`, "utf8");
  await assert.rejects(loadLearning(root), /learning deletion tombstone state is invalid/);
  await writeFile(stored.learningPath, `${original}\n`, "utf8");
  assert.deepEqual(await readFile(join(root, "AGENTS.md")), sourceBytes);
});

test("learning state without deletion tombstones upgrades to an empty suppression set", async (t) => {
  const { root } = await fixture(t);
  await proposeLearning({
    root, id: "learning:legacy-no-tombstones", kind: "project-fact",
    claim: "The synthetic project keeps legacy learning state readable.", scope: scopedTurn,
    evidence: stated("evidence:legacy-no-tombstones", "Synthetic legacy state evidence.",
      "2045-05-01T00:00:00.000Z"), now: new Date("2045-05-01T00:00:00.000Z")
  });
  const stored = await loadLearning(root);
  delete stored.learning.deletionTombstones;
  await writeFile(stored.learningPath, `${JSON.stringify(stored.learning)}\n`, "utf8");
  assert.deepEqual((await loadLearning(root)).learning.deletionTombstones, []);
});
