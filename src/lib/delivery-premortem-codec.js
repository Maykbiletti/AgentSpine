import { createHash } from "node:crypto";

const DIGEST_RE = /^[a-f0-9]{64}$/;

export function canonicalPremortem(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalPremortem).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalPremortem(value[key])}`).join(",")}}`;
}

export function premortemSha256(value) {
  return createHash("sha256").update(typeof value === "string"
    ? value : canonicalPremortem(value)).digest("hex");
}

export function premortemTime(value) {
  const parsed = new Date(value ?? Date.now());
  if (!Number.isFinite(parsed.getTime())) throw new Error("premortem timestamp is invalid");
  return parsed.toISOString();
}

export function sealPremortem(value, digestKey = "digest") {
  const material = { ...value };
  delete material[digestKey];
  return { ...material, [digestKey]: premortemSha256(material) };
}

export function validPremortemSeal(value, key = "digest") {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !DIGEST_RE.test(value[key] || "")) return false;
  const material = { ...value };
  delete material[key];
  return value[key] === premortemSha256(material);
}

export function validPremortemTime(value) {
  return typeof value === "string" && Number.isFinite(new Date(value).getTime());
}

export function premortemMismatchError(message) {
  const error = new Error(message);
  error.code = "AGENTSPINE_PREMORTEM_MISMATCH";
  return error;
}
