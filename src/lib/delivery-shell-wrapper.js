const WRAPPER_NAMES = new Set(["sudo", "env", "command", "builtin", "exec", "timeout", "nice"]);
const VALUE_OPTIONS = {
  sudo: new Set([
    "-C", "--close-from", "-D", "--chdir", "-g", "--group", "-h", "--host",
    "-p", "--prompt", "-r", "--role", "-t", "--type", "-u", "--user"
  ]),
  env: new Set(["-C", "--chdir", "-u", "--unset", "-S", "--split-string"]),
  exec: new Set(["-a"]),
  timeout: new Set(["-k", "--kill-after", "-s", "--signal"]),
  nice: new Set(["-n", "--adjustment"])
};

export function shellExecutableName(value) {
  if (typeof value !== "string") return "";
  return value.replace(/^.*[\\/]/, "").replace(/\.exe$/i, "").toLowerCase();
}

function wrapperName(value) {
  const base = shellExecutableName(value);
  return WRAPPER_NAMES.has(base) ? base : null;
}

function optionDetails(value, valueOptions) {
  if (value.includes("=")) return { option: value.slice(0, value.indexOf("=")), attached: true, payload: value.slice(value.indexOf("=") + 1) };
  const short = value.slice(0, 2);
  if (value.length > 2 && !value.startsWith("--") && valueOptions.has(short)) {
    return { option: short, attached: true, payload: value.slice(2) };
  }
  return { option: value, attached: false, payload: null };
}

function replaceSplitString(tokens, payload, tokenize) {
  if (!payload || typeof tokenize !== "function") return;
  tokens.unshift(...tokenize(payload));
}

function discardOptions(tokens, kind, tokenize) {
  const valueOptions = VALUE_OPTIONS[kind] ?? new Set();
  while (tokens[0]) {
    const value = tokens[0].value;
    if (value === "--") { tokens.shift(); return; }
    if (kind === "env" && /^[A-Za-z_][A-Za-z0-9_]*=/.test(value)) { tokens.shift(); continue; }
    if (!value.startsWith("-") || value === "-") return;
    tokens.shift();
    const { option, attached, payload } = optionDetails(value, valueOptions);
    if (!valueOptions.has(option)) continue;
    const splitString = kind === "env" && ["-S", "--split-string"].includes(option);
    if (attached) {
      if (splitString) replaceSplitString(tokens, payload, tokenize);
      continue;
    }
    const argument = tokens.shift();
    if (splitString) replaceSplitString(tokens, argument?.value, tokenize);
  }
}

export function unwrapLeadingShellWrapper(tokens, tokenize) {
  const kind = wrapperName(tokens[0]?.value);
  if (!kind) return false;
  tokens.shift();
  discardOptions(tokens, kind, tokenize);
  if (kind === "timeout" && tokens[0]) tokens.shift();
  return true;
}
