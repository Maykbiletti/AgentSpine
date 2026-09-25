import { sameTimelineBinding } from "./session-timeline-contract.js";
import { resolvePrivateSessionTimelineContract } from "./session-timeline-enrollment.js";
import { validTimelineTransportDigest } from "./session-timeline-transport.js";

export async function timelineTransportEnrollmentMatches({
  root, binding, enrollmentDigest, transportDigest, hostHome = null
}) {
  if (!validTimelineTransportDigest(transportDigest) || !/^[a-f0-9]{64}$/.test(enrollmentDigest || "")) return false;
  const enrollment = await resolvePrivateSessionTimelineContract({
    root, host: binding?.host, sessionId: binding?.sessionId, hostHome,
    expectedTransportDigest: transportDigest
  });
  return enrollment.status === "enrolled" && enrollment.enrollmentDigest === enrollmentDigest
    && sameTimelineBinding(enrollment.binding, binding);
}
