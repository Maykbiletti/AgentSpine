import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { invokeInstalledHook } from "./check-install-hook.js";

export async function invokeInstalledKingInstructions(pluginRoot, workspace) {
  const results = [];
  for (const [name, projectBytes, userBytes, fill] of [
    ["large", 44000, 0, "x"], ["combined", 25000, 19000, "x"], ["escaped", 32768, 0, '"']
  ]) {
    const root = join(workspace, name, "project"), home = join(workspace, name, "home");
    await mkdir(join(root, ".git"), { recursive: true });
    await mkdir(home, { recursive: true });
    const sources = new Map();
    for (const [path, bytes] of [[join(root, "AGENTS.md"), projectBytes], [join(home, "AGENTS.md"), userBytes]]) {
      if (!bytes) continue;
      const header = "# Synthetic installed King instructions\n\n";
      const content = Buffer.from(header + fill.repeat(bytes - Buffer.byteLength(header)));
      await writeFile(path, content); sources.set(path, content);
    }
    const output = await invokeInstalledHook(pluginRoot, root, join(workspace, name, "state"), "blun", {
      hook_event_name: "UserPromptSubmit", host: "codex", cwd: root,
      session_id: `session:king-${name}`, event_id: `turn:king-${name}`,
      prompt: "Inspect the complete synthetic instructions."
    }, { requireBriefing: false, extraEnv: { BLUN_HOME: home, CODEX_HOME: home } });
    const bytes = Buffer.byteLength(output.additionalContext || "");
    if (output.decision || output.message || !bytes || bytes > 1200
      || JSON.stringify(output.hookSpecificKeys) !== JSON.stringify(["additionalContext", "hookEventName"])) {
      throw new Error(`installed King ${name} must accept full instructions through quiet bounded context: ${output.reason}`);
    }
    for (const [path, original] of sources) {
      if (!(await readFile(path)).equals(original)) throw new Error("installed King changed source instructions");
    }
    results.push({ name, instructionBytes: projectBytes + userBytes, contextBytes: bytes,
      contextField: "additionalContext", sourcePreserved: true });
  }
  return results;
}
