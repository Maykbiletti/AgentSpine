import { channelRuntimeFindings, claimChannelEvent, completeChannelEvent, loadChannelPolicy, loadChannelRuntime } from "./channel-runtime.js";
import { loadGraph } from "./graph.js";
import { emptyPolicy, emptyRuntime, exactId, sha256, timestamp } from "./gateway-common.js";
import { assertActivePersona, exactReplyBinding } from "./gateway-runtime-identity.js";
import { appendReceipt } from "./gateway-runtime-records.js";
import { normalizePolicy, normalizeRuntime, pathsFor, readJson, withLock } from "./gateway-state.js";
import { loadPersonaRuntime } from "./persona-runtime.js";

const SCHEMA = "agentspine.group-response/v1";
const CONTRIBUTIONS = new Set(["idea", "error", "improvement"]);

// This is a host result contract, not a permission or an objective evaluation.
export function groupResponseContract(event) {
  if (!event?.groupId) return null;
  return { schema: SCHEMA, defaultKind: "silence", kinds: ["silence", "answer", ...CONTRIBUTIONS],
    eventId: event.eventId, sessionKey: event.sessionKey, groupId: event.groupId,
    authority: "context-only", directAddressVerified: false,
    instruction: "Without a direct request, stay silent unless contributing a relevant idea, concrete error, or improvement. Return groupResponse with this schema and kind; silence has no text. Contributions need a stable subjectId. Answer direct requests normally. Suggestions are not verified facts. Do not echo bot status messages." };
}

export function reviewGroupResponse({ result, text, event, item, runtime, current }) {
  if (result?.groupResponse === undefined) return null; // Preserve the legacy reply contract.
  const response = result.groupResponse;
  if (!event?.groupId || event.privacy !== "group" || event.groupId !== item.groupId
    || event.projectId !== item.projectId || event.agentId !== item.agentId) {
    throw new Error("group response requires the exact group channel work item");
  }
  if (!response || Array.isArray(response) || response.schema !== SCHEMA
    || !["silence", "answer", ...CONTRIBUTIONS].includes(response.kind)) {
    throw new Error("unknown group response contract or kind");
  }
  const contribution = CONTRIBUTIONS.has(response.kind);
  const keys = contribution ? ["schema", "kind", "subjectId"] : ["schema", "kind"];
  if (Object.keys(response).length !== keys.length || Object.keys(response).some((key) => !keys.includes(key))) {
    throw new Error("group response fields do not match its kind");
  }
  if (response.kind === "silence" && result.text !== undefined && result.text !== null && result.text !== "") {
    throw new Error("silent group response must not contain text or a visible placeholder");
  }
  if (response.kind !== "silence" && !text) throw new Error("group contribution or answer requires text");
  let contributionDigest = null;
  let duplicate = false;
  if (contribution) {
    const subjectId = exactId(response.subjectId, "groupResponse.subjectId");
    // The gateway derives the digest. Changing an event ID cannot repeat the same
    // contribution; different private routes and sessions never share dedupe state.
    contributionDigest = sha256(JSON.stringify([event.provider, event.tenantId, event.accountId,
      event.bindingId, event.agentId, event.projectId, event.groupId, event.chatId, event.threadId,
      event.sessionKey, subjectId, text]));
    duplicate = runtime.receipts.some((receipt) => receipt.kind === "group-contribution-prepared"
      && receipt.details.schema === SCHEMA && receipt.details.contributionDigest === contributionDigest);
  }
  const suppressed = response.kind === "silence" || duplicate;
  if (suppressed || contribution) appendReceipt(runtime,
    suppressed ? "group-response-suppressed" : "group-contribution-prepared", item.queueId, current,
    { schema: SCHEMA, eventId: event.eventId, bindingId: event.bindingId,
      kind: response.kind, reason: duplicate ? "duplicate" : response.kind,
      contributionDigest, deliveryConfirmed: false, completionVerified: false });
  return { schema: SCHEMA, kind: response.kind, suppressed, duplicate,
    deliveryConfirmed: false, completionVerified: false };
}

// Recover the local acknowledgement after the gateway transaction commits.
// No adapter, outbox or delivery receipt is involved. A crash between claim and
// completion resumes the same lease, or reacquires it after its original expiry.
export async function settleSuppressedGroupEvents({ root = process.cwd(), now = new Date() } = {}) {
  const paths = await pathsFor(root);
  return withLock(paths, async () => {
    const [policy, runtime, channelPolicy, channel, personas] = await Promise.all([
      readJson(paths.gatewayPolicyPath, paths.catalog.root, normalizePolicy, emptyPolicy),
      readJson(paths.gatewayRuntimePath, paths.catalog.root, normalizeRuntime, emptyRuntime),
      loadChannelPolicy(paths.catalog.root, paths.catalog), loadChannelRuntime(paths.catalog.root, paths.catalog),
      loadPersonaRuntime(paths.catalog.root, paths.catalog)
    ]);
    if (!policy.enabled || policy.killSwitch) return { settled: 0 };
    const current = timestamp(now);
    let settled = 0; let deferred = 0;
    const pending = runtime.receipts.filter((receipt) => receipt.kind === "group-response-suppressed"
      && channel.runtime.events.some((event) => event.eventId === receipt.details.eventId
        && !["completed", "cancelled"].includes(event.status)));
    if (pending.length) {
      const { graph } = await loadGraph(paths.catalog.root, paths.catalog);
      if (channelRuntimeFindings(channel.runtime, channelPolicy.policy, graph).length) {
        throw new Error("suppressed channel event integrity mismatch");
      }
    }
    for (const receipt of pending) {
      if (settled >= 20) break;
      if (receipt.details.schema !== SCHEMA) throw new Error("unknown group response receipt version");
      const item = runtime.queue.find((entry) => entry.queueId === receipt.objectId);
      const event = channel.runtime.events.find((entry) => entry.eventId === receipt.details.eventId);
      if (!item || item.status !== "completed" || item.channelEventId !== event.eventId
        || item.groupId !== event.groupId || item.agentId !== event.agentId || item.projectId !== event.projectId
        || !event.groupId || receipt.details.bindingId !== event.bindingId
        || runtime.outbox.some((entry) => entry.queueId === item.queueId)) {
        throw new Error("suppressed group response lost its exact no-delivery binding");
      }
      try {
        assertActivePersona(personas.policy, personas.runtime, item.agentId, item.projectId, item.groupId);
        exactReplyBinding(channelPolicy.policy, event);
      } catch {
        // Revocation keeps this event untouched, without stopping other work.
        deferred += 1;
        continue;
      }
      const workerId = "group-silence:" + sha256(item.queueId).slice(0, 32);
      try {
        if (event.status === "leased" && new Date(event.lease.expiresAt) > new Date(current)) {
          if (event.lease.workerId !== workerId) { deferred += 1; continue; }
        } else {
          const claim = await claimChannelEvent({ root: paths.catalog.root, agentId: event.agentId,
            projectId: event.projectId, groupId: event.groupId, provider: event.provider,
            eventId: event.eventId, workerId, now: current, catalog: paths.catalog });
          if (!claim.event) { deferred += 1; continue; }
        }
        await completeChannelEvent({ root: paths.catalog.root, eventId: event.eventId,
          workerId, status: "completed", now: current });
        settled += 1;
      } catch {
        // Local acknowledgement is recoverable bookkeeping, not a new work gate.
        // Keep the durable suppression and do not claim acknowledgement succeeded.
        deferred += 1;
        break; // Do not repeat the same unavailable channel service in this tick.
      }
    }
    return { settled, deferred };
  });
}
