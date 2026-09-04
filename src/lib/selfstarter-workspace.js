import { createHash } from "node:crypto";
import { lstat, opendir, readFile, realpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { isConfiguredHostProfileRoot, workspaceScanError } from "./selfstarter-core.js";

const MAX_WORKSPACE_FILES = 10000;
const MAX_WORKSPACE_BYTES = 64 * 1024 * 1024;
const EXCLUDED_NAMES = new Set([".git", "node_modules", ".DS_Store"]);

export function skippableTraversalError(error) {
  return ["EPERM", "EACCES", "ENOENT"].includes(error?.code);
}

export function skippedPath(skipped, path, error, operation) {
  skipped.push({ path, code: error.code, operation });
}

export async function collectWorkspaceFiles(root) {
  const files = [];
  const skipped = [];
  let totalBytes = 0;
  async function walk(directory) {
    let stream;
    try {
      stream = await opendir(directory);
    } catch (error) {
      if (!skippableTraversalError(error)) throw workspaceScanError(error);
      skippedPath(skipped, error.path || directory, error, "opendir");
      return;
    }
    const entries = [];
    try {
      for await (const entry of stream) entries.push(entry);
    } catch (error) {
      if (!skippableTraversalError(error)) throw workspaceScanError(error);
      skippedPath(skipped, directory, error, "readdir");
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (EXCLUDED_NAMES.has(entry.name)) continue;
      const path = join(directory, entry.name);
      let metadata;
      try {
        metadata = await lstat(path);
      } catch (error) {
        if (!skippableTraversalError(error)) throw workspaceScanError(error);
        skippedPath(skipped, error.path || path, error, "lstat");
        continue;
      }
      if (metadata.isSymbolicLink()) {
        try {
          await realpath(path);
        } catch (error) {
          if (!skippableTraversalError(error)) throw workspaceScanError(error);
          skippedPath(skipped, error.path || path, error, "realpath");
          continue;
        }
        throw new Error(`workspace fingerprint rejects symbolic link: ${relative(root, path)}`);
      }
      if (metadata.isDirectory()) await walk(path);
      else if (metadata.isFile()) {
        files.push({ path, relativePath: relative(root, path).split(sep).join("/"), size: metadata.size });
        totalBytes += metadata.size;
        if (files.length > MAX_WORKSPACE_FILES || totalBytes > MAX_WORKSPACE_BYTES) {
          throw new Error("workspace exceeds the self-starter fingerprint limit");
        }
      }
    }
  }
  await walk(root);
  return { files, skipped: skipped.sort((a, b) => a.path.localeCompare(b.path) || a.operation.localeCompare(b.operation)) };
}

export async function workspaceFingerprint(inputRoot = process.cwd()) {
  const root = resolve(inputRoot);
  if (isConfiguredHostProfileRoot(root)) {
    throw new Error("self-starter cannot fingerprint a host profile root");
  }
  const collected = await collectWorkspaceFiles(root);
  const files = [];
  const skipped = [...collected.skipped];
  const hash = createHash("sha256");
  for (const file of collected.files) {
    let content;
    try {
      content = await readFile(file.path);
    } catch (error) {
      if (!skippableTraversalError(error)) throw workspaceScanError(error);
      skippedPath(skipped, error.path || file.path, error, "readFile");
      continue;
    }
    files.push(file);
    hash.update(file.relativePath).update("\0").update(String(file.size)).update("\0");
    hash.update(content).update("\0");
  }
  return {
    digest: hash.digest("hex"), files: files.length, bytes: files.reduce((sum, file) => sum + file.size, 0),
    skipped: skipped.sort((a, b) => a.path.localeCompare(b.path) || a.operation.localeCompare(b.operation))
  };
}

export function incompleteWorkspaceScan(skipped) {
  const first = skipped[0];
  const error = new Error(`workspace scan skipped ${skipped.length} inaccessible path${skipped.length === 1 ? "" : "s"}: ${first.path}`);
  error.code = "AGENTSPINE_SCAN_INCOMPLETE";
  error.path = first.path;
  error.syscall = first.operation;
  error.skipped = skipped;
  return error;
}
