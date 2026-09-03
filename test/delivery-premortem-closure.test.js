import test from "node:test";
import assert from "node:assert/strict";
import { createPremortemArtifact } from "../src/lib/delivery-premortem-closure.js";

const requirement = {
  requirementId: "premortem-requirement:synthetic",
  laneDigest: "a".repeat(64)
};

function items(check = "Compare the immutable synthetic baseline digest.") {
  return [
    { category: "baseline-environment",
      failure: "this delivery fails because the baseline is stale", check },
    { category: "contract-tests",
      failure: "this delivery fails because the contract regresses",
      check: "Run the focused synthetic regression test." },
    { category: "delivery-path",
      failure: "this delivery fails because the artifact is misplaced",
      check: "Verify the synthetic delivery path and digest." }
  ];
}

test("premortem rejects a whitespace-only concrete check", () => {
  assert.throws(() => createPremortemArtifact({
    requirement, items: items(" \t "), recordedAt: "2034-01-01T00:00:00.000Z"
  }), /baseline-environment check is invalid/);
});

test("premortem accepts a concrete non-whitespace check", () => {
  const artifact = createPremortemArtifact({
    requirement, items: items(), recordedAt: "2034-01-01T00:00:00.000Z"
  });
  assert.equal(artifact.items[0].check, "Compare the immutable synthetic baseline digest.");
});
