import { spawn as nodeSpawn } from "node:child_process";

export const DEFAULT_TEST_TIMEOUT_MS = 180_000;
export const TIMEOUT_EXIT_CODE = 124;

const MAX_CAPTURE_CHARS = 1_000_000;
const TASKKILL_TIMEOUT_MS = 5_000;

function running(child) {
  return child?.pid && child.exitCode === null && child.signalCode === null;
}

function waitForClose(child, timeoutMs) {
  if (!running(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let timer;
    const closed = () => {
      clearTimeout(timer);
      resolve(true);
    };
    timer = setTimeout(() => {
      child.off("close", closed);
      resolve(false);
    }, timeoutMs);
    child.once("close", closed);
  });
}

function runTaskkill(pid, spawnProcess) {
  return new Promise((resolve) => {
    let killer;
    let settled = false;
    let timer;
    const finish = (success) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(success);
    };
    try {
      killer = spawnProcess("taskkill.exe", ["/pid", String(pid), "/T", "/F"], {
        shell: false, stdio: "ignore", windowsHide: true
      });
    } catch {
      finish(false);
      return;
    }
    timer = setTimeout(() => {
      try { killer.kill(); } catch {}
      finish(false);
    }, TASKKILL_TIMEOUT_MS);
    killer.once("error", () => finish(false));
    killer.once("close", (code) => finish(code === 0));
  });
}

function signalUnixGroup(child, signal) {
  try {
    process.kill(-child.pid, signal);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return true;
    try { return child.kill(signal); } catch { return false; }
  }
}

export async function terminateProcessTree(child, {
  platform = process.platform,
  spawnProcess = nodeSpawn,
  graceMs = 1_000
} = {}) {
  if (!running(child)) return { terminated: true, method: "already-closed" };
  let method;
  if (platform === "win32") {
    method = await runTaskkill(child.pid, spawnProcess) ? "taskkill-tree" : "taskkill-fallback";
    if (running(child) && method === "taskkill-fallback") {
      try { child.kill("SIGKILL"); } catch {}
    }
  } else {
    method = "process-group";
    signalUnixGroup(child, "SIGTERM");
  }
  if (await waitForClose(child, graceMs)) return { terminated: true, method };
  if (platform === "win32") {
    try { child.kill("SIGKILL"); } catch {}
  } else {
    signalUnixGroup(child, "SIGKILL");
  }
  return { terminated: await waitForClose(child, graceMs), method };
}

function appendCaptured(current, chunk) {
  if (current.length >= MAX_CAPTURE_CHARS) return current;
  const next = current + chunk;
  if (next.length <= MAX_CAPTURE_CHARS) return next;
  return next.slice(0, MAX_CAPTURE_CHARS) + "\n[output truncated by hermetic runner]\n";
}

function progressLine(stream, label, status) {
  stream?.write(`[${label}] ${status}\n`);
}

export function configuredTestTimeout(environment = process.env) {
  const raw = environment.AGENTSPINE_TEST_FILE_TIMEOUT_MS;
  if (raw === undefined || raw === "") return DEFAULT_TEST_TIMEOUT_MS;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 900_000) {
    throw new Error("AGENTSPINE_TEST_FILE_TIMEOUT_MS must be an integer from 1000 to 900000");
  }
  return value;
}

export function runBoundedProcess({
  command,
  args = [],
  options = {},
  label,
  timeoutMs,
  terminationGraceMs = 1_000,
  progress = process.stdout,
  platform = process.platform,
  spawnProcess = nodeSpawn
}) {
  if (!command || !label || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("command, label, and a positive integer timeoutMs are required");
  }
  const startedAt = Date.now();
  progressLine(progress, label, "START");
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnProcess(command, args, {
        ...options,
        detached: platform !== "win32",
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      });
    } catch (error) {
      progressLine(progress, label, `FAIL spawn: ${error.message}`);
      resolve({ code: 1, signal: null, timedOut: false, stdout: "", stderr: error.message,
        durationMs: Date.now() - startedAt });
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => { stdout = appendCaptured(stdout, chunk); });
    child.stderr?.on("data", (chunk) => { stderr = appendCaptured(stderr, chunk); });

    const finish = (code, signal, error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const durationMs = Date.now() - startedAt;
      const finalCode = timedOut ? TIMEOUT_EXIT_CODE : (code ?? 1);
      if (timedOut) progressLine(progress, label, `TIMEOUT after ${timeoutMs}ms`);
      else if (finalCode === 0) progressLine(progress, label, `PASS in ${durationMs}ms`);
      else progressLine(progress, label, `FAIL with code ${finalCode}`);
      if (error) stderr = appendCaptured(stderr, error.message || String(error));
      if (timedOut) stderr = appendCaptured(stderr,
        `\nHermetic child timed out after ${timeoutMs}ms and its process tree was terminated.\n`);
      resolve({ code: finalCode, signal, timedOut, stdout, stderr, durationMs });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      void terminateProcessTree(child, {
        platform, spawnProcess, graceMs: terminationGraceMs
      }).finally(() => {
        if (!settled) {
          child.stdout?.destroy();
          child.stderr?.destroy();
          finish(TIMEOUT_EXIT_CODE, "SIGKILL");
        }
      });
    }, timeoutMs);
    child.once("error", (error) => finish(1, null, error));
    child.once("close", (code, signal) => finish(code, signal));
  });
}
