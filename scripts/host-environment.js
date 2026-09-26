const HOST_ROOTS = {
  blun: ["BLUN_PLUGIN_ROOT"],
  claude: ["CLAUDE_PLUGIN_ROOT"],
  codex: ["PLUGIN_ROOT", "CLAUDE_PLUGIN_ROOT"]
};
const HOST_ROOT_KEYS = ["BLUN_PLUGIN_ROOT", "CLAUDE_PLUGIN_ROOT", "PLUGIN_ROOT"];

export function installedHostEnvironment(host, pluginRoot, extraEnv = {}) {
  const rootKeys = HOST_ROOTS[host];
  if (!rootKeys) throw new Error(`unsupported installed host: ${host}`);
  const env = { ...process.env, ...extraEnv };
  for (const key of HOST_ROOT_KEYS) delete env[key];
  for (const key of rootKeys) env[key] = pluginRoot;
  return env;
}
