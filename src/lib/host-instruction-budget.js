const STANDARD_BYTES = 8 * 1024;
export const KING_SOURCE_MAX_BYTES = 4 * 1024 * 1024;
export const KING_TOTAL_MAX_BYTES = 8 * 1024 * 1024;

export function isKingHost(env = process.env) {
  return Boolean(env.BLUN_PLUGIN_ROOT && env.BLUN_HOME);
}

export function instructionBudget(host, usedBytes = 0, env = process.env) {
  const hardLimitBytes = host === "codex" && isKingHost(env) ? KING_TOTAL_MAX_BYTES
    : host === "claude" ? 16 * 1024 : host === "codex" ? 32 * 1024 : STANDARD_BYTES;
  const overflowBytes = Math.max(0, usedBytes - STANDARD_BYTES);
  return {
    mode: overflowBytes ? `${host}-required-overflow` : "standard",
    standardBytes: STANDARD_BYTES, hardLimitBytes, usedBytes, overflowBytes
  };
}
