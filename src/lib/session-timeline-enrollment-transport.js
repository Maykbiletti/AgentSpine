import { sameTimelineBinding } from "./session-timeline-contract.js";
import { resolvePrivateSessionTimelineEnrollment } from "./session-timeline-enrollment.js";
import { validTimelineTransportDigest } from "./session-timeline-transport.js";

// Keep the digest inside the signed enrollment record. This verifier returns
// only a boolean so neither the transport value nor its digest reaches cards.
export async function timelineTransportEnrollmentMatches({
  root, binding, enrollmentDigest, transportDigest, hostHome = null
}) {
  if (!validTimelineTransportDigest(transportDigest) || !/^[a-f0-9]{64}$/.test(enrollmentDigest || "")) return false;
  const enrollment = await resolvePrivateSessionTimelineEnrollment({
    root, host: binding?.host, sessionId: binding?.sessionId, hostHome,
    expectedTransportDigest: transportDigest
  });
  return enrollment.status === "enrolled" && enrollment.enrollmentDigest === enrollmentDigest
    && sameTimelineBinding(enrollment.binding, binding);
}
