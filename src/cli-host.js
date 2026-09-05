import { fileURLToPath } from "node:url";
import { installCodexMcp } from "./lib/codex-installation.js";
import { output } from "./cli-common.js";

export const hostCommands = new Set(["host-install"]);

export async function runHostCommand({ command, flags, positional, json }) {
  if (command !== "host-install" || positional[0] !== "codex" || positional.length !== 1) {
    throw new Error("host-install requires exactly the host name codex");
  }
  if (flags["confirm-local-host-install"] !== true) {
    throw new Error("host-install requires --confirm-local-host-install from the local user");
  }
  const result = await installCodexMcp({
    codexHome: flags["codex-home"],
    skillsRoot: flags["skills-root"],
    packageRoot: flags["package-root"] || fileURLToPath(new URL("..", import.meta.url)),
    nodePath: flags["node-path"] || process.execPath
  });
  return output(result, json);
}
