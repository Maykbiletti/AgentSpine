import { claimGatewayWork, markGatewayHostStarted } from "../src/lib/gateway-runtime.js";

export async function claimReadOnlyGatewayWork(options) {
  return claimGatewayWork({ ...options, executionMode: "read-only" });
}

export async function markTestGatewayHostStarted(root, claim, now) {
  return markGatewayHostStarted({ root, queueId: claim.item.queueId, workerId: claim.item.lease.workerId,
    claimedAt: claim.item.lease.claimedAt, attempt: claim.item.attempts, now });
}
