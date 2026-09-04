import { recoverDeliveryPremortem } from "./lib/delivery-premortem-correction.js";
import { output } from "./cli-common.js";

export const premortemCommands = new Set(["premortem-recover"]);

export async function runPremortemCommand({ command, flags, positional, json }) {
  if (command !== "premortem-recover") throw new Error(`Unknown premortem command: ${command}`);
  const predecessorRequirementId = positional[0];
  if (!predecessorRequirementId) throw new Error("premortem-recover requires a predecessor requirementId");
  const result = await recoverDeliveryPremortem({
    root: flags.root || process.cwd(), predecessorRequirementId,
    taskId: flags.task || null
  });
  output(result, json);
  if (result.blocked) process.exitCode = 1;
}
