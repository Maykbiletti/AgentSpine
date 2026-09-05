import { createHash, randomBytes } from "node:crypto";
import { completeTimelineBinding, sameTimelineBinding, validTimelineBinding } from "./session-timeline-contract.js";
import { sameTimelineTransportDigest, validTimelineTransportDigest } from "./session-timeline-transport.js";
import { sessionTimelineRootDigest } from "./session-timeline-root.js";
import { validSessionTimelineSourceMetadata } from "./session-timeline-source.js";

export const PRIVATE_TIMELINE_HOST_RECEIPT_SCHEMA = "agentspine.session-timeline-host-receipt/v1";
export const PRIVATE_TIMELINE_HOST_RECEIPT_ORIGIN = "claude-user-prompt-v1";
export const HOST_RECEIPT_TTL_MS = 15 * 60 * 1000;
export const MAX_PENDING_RECEIPTS = 32;

const AUTHORITY = "context-only";
const HOST_RECEIPT_RE = /^asthr_[A-Za-z0-9_-]{43}$/;

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value) { return createHash("sha256").update(value).digest("hex"); }

function sourceMetadata(source) {
  return {
    path: source?.path, profileRoot: source?.profileRoot, projectsRoot: source?.projectsRoot,
    pathDigest: source?.pathDigest, identity: source?.identity, size: source?.size,
    mtimeNs: source?.mtimeNs, ctimeNs: source?.ctimeNs,
    prefixBytes: source?.prefixBytes, prefixDigest: source?.prefixDigest
  };
}

function validSourceSnapshot(source) {
  return validSessionTimelineSourceMetadata(source)
    && Number.isSafeInteger(source?.prefixBytes) && source.prefixBytes >= 0 && source.prefixBytes <= 4096
    && source.prefixBytes <= source.size && /^[a-f0-9]{64}$/.test(source.prefixDigest || "");
}

function sameSourceSnapshot(left, right) {
  const first = sourceMetadata(left);
  const second = sourceMetadata(right);
  return validSourceSnapshot(first) && validSourceSnapshot(second)
    && ["path", "profileRoot", "projectsRoot", "pathDigest", "identity", "size", "mtimeNs", "ctimeNs", "prefixBytes", "prefixDigest"]
      .every((key) => first[key] === second[key]);
}

function eventDigest(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 256 ? digest(value) : null;
}

function receiptDigest(root, value) {
  return digest(canonical({ schema: value.schema, id: value.id, rootDigest: sessionTimelineRootDigest(root), binding: value.binding,
    source: sourceMetadata(value.source), transportDigest: value.transportDigest, origin: value.origin,
    eventDigest: value.eventDigest, issuedAt: value.issuedAt, expiresAt: value.expiresAt, authority: value.authority }));
}

export function validHostTranscriptReceipt(value, root) {
  const issuedAt = new Date(value?.issuedAt).getTime();
  const expiresAt = new Date(value?.expiresAt).getTime();
  return value && value.schema === PRIVATE_TIMELINE_HOST_RECEIPT_SCHEMA && HOST_RECEIPT_RE.test(value.id || "")
    && value.rootDigest === sessionTimelineRootDigest(root) && validTimelineBinding(value.binding) && completeTimelineBinding(value.binding)
    && value.binding.groupId === null && validSourceSnapshot(value.source)
    && validTimelineTransportDigest(value.transportDigest) && value.origin === PRIVATE_TIMELINE_HOST_RECEIPT_ORIGIN
    && (value.eventDigest === null || /^[a-f0-9]{64}$/.test(value.eventDigest || "")) && Number.isFinite(issuedAt)
    && Number.isFinite(expiresAt) && expiresAt > issuedAt && expiresAt - issuedAt <= HOST_RECEIPT_TTL_MS + 1000
    && value.authority === AUTHORITY && /^[a-f0-9]{64}$/.test(value.receiptDigest || "")
    && value.receiptDigest === receiptDigest(root, value);
}

export function hostReceiptResult(receipt) {
  return { schema: PRIVATE_TIMELINE_HOST_RECEIPT_SCHEMA, status: "pending", receipt: receipt.id,
    expiresAt: receipt.expiresAt, authority: AUTHORITY };
}

export function hostReceiptUnavailable(reason) {
  return { schema: PRIVATE_TIMELINE_HOST_RECEIPT_SCHEMA, status: "unavailable", reason,
    receipt: null, expiresAt: null, authority: AUTHORITY };
}

export function purgeExpiredHostReceipts(state, current) {
  const retained = state.pendingReceipts.filter((item) => new Date(item.expiresAt).getTime() > current.getTime());
  const changed = retained.length !== state.pendingReceipts.length;
  state.pendingReceipts = retained;
  return changed;
}

export function makeHostTranscriptReceipt({ root, binding, source, transportDigest, current, eventId }) {
  const receipt = {
    schema: PRIVATE_TIMELINE_HOST_RECEIPT_SCHEMA, id: `asthr_${randomBytes(32).toString("base64url")}`,
    rootDigest: sessionTimelineRootDigest(root), binding: { ...binding }, source: sourceMetadata(source), transportDigest,
    origin: PRIVATE_TIMELINE_HOST_RECEIPT_ORIGIN, eventDigest: eventDigest(eventId),
    issuedAt: current.toISOString(), expiresAt: new Date(current.getTime() + HOST_RECEIPT_TTL_MS).toISOString(),
    authority: AUTHORITY
  };
  receipt.receiptDigest = receiptDigest(root, receipt);
  return receipt;
}

export function sameIssuedHostTranscriptEvent(left, right) {
  return left.eventDigest === right.eventDigest
    && (left.eventDigest !== null || right.eventDigest === null)
    && sameTimelineBinding(left.binding, right.binding) && sameSourceSnapshot(left.source, right.source)
    && sameTimelineTransportDigest(left.transportDigest, right.transportDigest)
    && left.origin === right.origin;
}

export function sameHostReceiptSource(left, right) {
  return sameSourceSnapshot(left?.source ?? left, right?.source ?? right);
}

export function hostReceiptId(value) { return typeof value === "string" && HOST_RECEIPT_RE.test(value); }
