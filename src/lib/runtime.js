import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function isMainModule(importMetaUrl, argvPath = process.argv[1]) {
  if (!argvPath) return false;
  const modulePath = fileURLToPath(importMetaUrl);
  try {
    return realpathSync(argvPath) === realpathSync(modulePath);
  } catch {
    return resolve(argvPath) === resolve(modulePath);
  }
}
