import { createHash } from "node:crypto";
import { comparablePath } from "./paths.js";

export function sessionTimelineRootPath(root) {
  if (typeof root !== "string" || !root) throw new Error("session timeline root is invalid");
  return comparablePath(root);
}

export function sessionTimelineRootDigest(root) {
  return createHash("sha256").update(sessionTimelineRootPath(root)).digest("hex");
}
