import { lstat, opendir, realpath } from "node:fs/promises";
import { join, relative } from "node:path";

export const SOURCE_SCAN_INCOMPLETE = "AGENTSPINE_SCAN_INCOMPLETE";

const SKIP_EXTRA_DIRS = new Set([
  ".git", ".hg", ".svn", ".claude", ".codex", "node_modules", "vendor", "dist", "build", "coverage"
]);

export function sourceScanError(error) {
  error.agentSpineScan = true;
  return error;
}

export async function existingRegular(path) {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) return null;
    return realpath(path);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw sourceScanError(error);
  }
}

export async function existingDirectory(path) {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) return null;
    return realpath(path);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw sourceScanError(error);
  }
}

function skippedExtraDirectory(name) {
  const lower = name.toLowerCase();
  return SKIP_EXTRA_DIRS.has(name) || SKIP_EXTRA_DIRS.has(lower)
    || lower.includes("dropbox") || lower === "onedrive" || lower.startsWith("onedrive - ");
}

function skippableTraversalError(error) {
  return ["EPERM", "EACCES", "ENOENT"].includes(error?.code);
}

function recordSkippedPath(skipped, path, error, operation) {
  skipped.push({ path, code: error.code, operation });
}

function recordIncomplete(skipped, { path, operation, message, limit, retained }) {
  skipped.push({
    path, code: SOURCE_SCAN_INCOMPLETE, operation, message, limit, retained,
    authority: "diagnostic-only"
  });
}

async function containsProjectMarker(directory) {
  try {
    await lstat(join(directory, ".git"));
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function containsEmbeddedHostProfile(directory) {
  return Boolean(
    await existingDirectory(join(directory, ".runtime-private"))
    && await existingRegular(join(directory, "config.toml"))
  );
}

function limitMessage(label, detail) {
  return `Host-native ${label} context is incomplete: ${detail}; remaining files were skipped.`;
}

export async function boundedMarkdownTree(directory, prefix, host, scope, precedenceStart, deadline, {
  projectBoundary = false,
  maxFiles,
  maxDirectoryEntries,
  skipped = [],
  truncateOnLimit = false,
  excludedNames = new Set(),
  label = "rule-tree",
  timeoutMs
} = {}) {
  let root;
  try {
    root = await existingDirectory(directory);
  } catch (error) {
    if (!skippableTraversalError(error)) throw sourceScanError(error);
    recordSkippedPath(skipped, directory, error, "inspect-directory");
    return [];
  }
  if (!root) return [];
  const output = [];
  let visitedEntries = 0;

  function stopForLimit(path, operation, message, limit) {
    if (!truncateOnLimit) throw new Error(message);
    recordIncomplete(skipped, { path, operation,
      message: limitMessage(label, message), limit, retained: output.length });
    return false;
  }

  function checkDeadline(path) {
    if (Date.now() <= deadline) return true;
    const message = `source resolution exceeded ${timeoutMs} ms`;
    if (!truncateOnLimit) throw new Error(`host-native ${message}`);
    recordIncomplete(skipped, { path, operation: "deadline",
      message: limitMessage(label, message), limit: timeoutMs, retained: output.length });
    return false;
  }

  async function walk(current) {
    if (!checkDeadline(current)) return false;
    try {
      if (projectBoundary && current !== root
        && (await containsProjectMarker(current) || await containsEmbeddedHostProfile(current))) return true;
    } catch (error) {
      if (!skippableTraversalError(error)) throw sourceScanError(error);
      recordSkippedPath(skipped, current, error, "inspect-directory-boundary");
      return true;
    }
    const entries = [];
    let stream;
    try {
      stream = await opendir(current);
    } catch (error) {
      if (!skippableTraversalError(error)) throw sourceScanError(error);
      recordSkippedPath(skipped, error.path || current, error, "opendir");
      return true;
    }
    let stopAfterDirectory = false;
    try {
      for await (const entry of stream) {
        if (truncateOnLimit && !checkDeadline(current)) return false;
        visitedEntries += 1;
        if (visitedEntries > maxDirectoryEntries) {
          const message = `source tree exceeds ${maxDirectoryEntries} directory entries`;
          if (!truncateOnLimit) throw new Error(`host-native ${message}`);
          recordIncomplete(skipped, { path: current, operation: "directory-entry-limit",
            message: limitMessage(label, message), limit: maxDirectoryEntries, retained: output.length });
          stopAfterDirectory = true;
          break;
        }
        entries.push(entry);
      }
    } catch (error) {
      if (!skippableTraversalError(error)) throw sourceScanError(error);
      recordSkippedPath(skipped, current, error, "readdir");
      return true;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (truncateOnLimit && !checkDeadline(current)) return false;
      if (entry.isSymbolicLink()) continue;
      const path = join(current, entry.name);
      if (entry.isDirectory() && !stopAfterDirectory && !entry.name.startsWith(".")
        && !skippedExtraDirectory(entry.name)) {
        if (!await walk(path)) return false;
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")
        && !excludedNames.has(entry.name)) {
        if (output.length >= maxFiles) {
          return stopForLimit(root, "file-limit", `rule tree exceeds ${maxFiles} files`, maxFiles);
        }
        output.push({ path, id: `${prefix}/${relative(root, path).replaceAll("\\", "/")}`, host, scope,
          binding: "host-native-rule-tree", precedence: precedenceStart + output.length });
      }
    }
    return !stopAfterDirectory;
  }

  await walk(root);
  return output;
}
