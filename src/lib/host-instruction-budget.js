const STANDARD = 8192;
export const KING_SOURCE_BYTES = 4194304;
const KING_TOTAL = 8388608;
export const isKingHost = (env = process.env) => !!(env.BLUN_PLUGIN_ROOT && env.BLUN_HOME);

export function instructionBudget(host, usedBytes = 0, env = process.env) {
  const hardLimitBytes = host === "codex" && isKingHost(env) ? KING_TOTAL
    : host === "claude" ? 16384 : host === "codex" ? 32768 : STANDARD;
  return { mode: usedBytes > STANDARD ? `${host}-required-overflow` : "standard",
    standardBytes: STANDARD, hardLimitBytes, usedBytes, overflowBytes: Math.max(0, usedBytes - STANDARD) };
}
