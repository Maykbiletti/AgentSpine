import { MAX_SUBSTITUTION_DEPTH, shellSubstitutions } from "./delivery-shell-substitutions.js";
import { maskHeredocBodies } from "./delivery-shell-heredoc.js";
import { shellExecutableName, unwrapLeadingShellWrapper } from "./delivery-shell-wrapper.js";

const WRITE_TOOLS = /(^|__)(apply_patch|edit|write|delete|move|rename)(_|$)/i;
const SHELL_TOOLS = /(^|__)(bash|exec_command|shell|powershell|pwsh)(_|$)/i;
const MAX_COMMAND_CHARS = 64 * 1024;
const SHELL_CONTROL_PREFIXES = new Set([
  "!", "{", "if", "then", "elif", "else", "while", "until", "do", "time", "coproc", "nohup"
]);
const SHELL_STDIN_EXECUTORS = new Set(["bash", "sh", "zsh"]);
const MUTATION_COMMANDS = new Set([
  "apply_patch", "rm", "mv", "cp", "install", "mkdir", "rmdir", "touch", "truncate", "tee", "patch",
  "set-content", "add-content", "out-file", "new-item", "remove-item", "move-item", "copy-item",
  "rename-item", "clear-content"
]);
const TEST_COMMANDS = [
  { family: "node-test", expression: /^node\s+--test(?:\s+[^;&|\n]+)?$/i },
  { family: "npm-test", expression: /^npm\s+(?:run\s+)?test(?:[\s:][^;&|\n]*)?$/i },
  { family: "npm-check", expression: /^npm\s+run\s+check(?:\s+[^;&|\n]+)?$/i },
  { family: "pytest", expression: /^(?:python(?:3)?\s+-m\s+)?pytest(?:\s+[^;&|\n]+)?$/i }
];

export function commandFromInput(input) {
  const toolInput = input?.tool_input ?? input?.tool_args;
  if (typeof toolInput === "string") return toolInput;
  if (!toolInput || typeof toolInput !== "object" || Array.isArray(toolInput)) return "";
  for (const key of ["command", "cmd", "script"]) {
    if (typeof toolInput[key] === "string") return toolInput[key];
  }
  return "";
}

export function isSuccessMarkerClause(value) {
  return [
    "printf AGENTSPINE_TEST_OK", "printf 'AGENTSPINE_TEST_OK\\n'",
    "printf \"AGENTSPINE_TEST_OK\\n\"", "node -e \"console.log('AGENTSPINE_TEST_OK')\"",
    "node -e 'console.log(\"AGENTSPINE_TEST_OK\")'"
  ].includes(value.trim());
}

function shellSegments(command) {
  const segments = [];
  let quote = null;
  let escaped = false;
  let start = 0;
  let separatorBefore = "";
  const push = (end) => {
    const raw = command.slice(start, end);
    const left = raw.search(/\S/);
    if (left >= 0) segments.push({ text: raw.slice(left), index: start + left, separatorBefore });
  };
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (escaped) { escaped = false; continue; }
    if (character === "\\" && quote !== "'") { escaped = true; continue; }
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"') { quote = character; continue; }
    if (character === ";" || character === "\n" || character === "|" || character === "&") {
      push(index);
      const separatorStart = index;
      while (command[index + 1] === character) index += 1;
      separatorBefore = command.slice(separatorStart, index + 1);
      start = index + 1;
    }
  }
  push(command.length);
  return segments;
}

function shellTokens(segment) {
  const tokens = [];
  let value = "";
  let start = -1;
  let plain = true;
  let quote = null;
  let escaped = false;
  const push = (end) => {
    if (start >= 0) tokens.push({ value, index: start, end, plain });
    value = "";
    start = -1;
    plain = true;
  };
  for (let index = 0; index < segment.length; index += 1) {
    const character = segment[index];
    if (escaped) { value += character; escaped = false; continue; }
    if (character === "\\" && quote !== "'") {
      if (start < 0) start = index;
      plain = false;
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      else value += character;
      continue;
    }
    if (character === "'" || character === '"') {
      if (start < 0) start = index;
      plain = false;
      quote = character;
    } else if (/\s/.test(character)) push(index);
    else {
      if (start < 0) start = index;
      value += character;
    }
  }
  push(segment.length);
  return tokens;
}

function executableTokens(segment) {
  const tokens = shellTokens(segment);
  let subshellDepth = 0;
  while (tokens[0]) {
    const first = tokens[0];
    const lower = first.value.toLowerCase();
    if (first.plain && lower === "(") {
      subshellDepth += 1;
      tokens.shift();
      continue;
    }
    if (first.plain && /^[A-Za-z_][A-Za-z0-9_]*=/.test(first.value)) {
      tokens.shift();
      continue;
    }
    if (unwrapLeadingShellWrapper(tokens, shellTokens)) continue;
    if (first.plain && SHELL_CONTROL_PREFIXES.has(lower)) {
      tokens.shift();
      continue;
    }
    if (first.plain && first.value.startsWith("(") && !first.value.startsWith("((")) {
      tokens[0] = { ...first, value: first.value.slice(1), index: first.index + 1 };
      subshellDepth += 1;
      if (!tokens[0].value) tokens.shift();
      continue;
    }
    break;
  }
  for (let index = tokens.length - 1; index >= 0 && subshellDepth > 0; index -= 1) {
    while (tokens[index].value.endsWith(")") && subshellDepth > 0) {
      tokens[index] = { ...tokens[index], value: tokens[index].value.slice(0, -1) };
      subshellDepth -= 1;
    }
  }
  return tokens;
}

function bodyAfterCasePattern(segment, start) {
  let quote = null;
  let escaped = false;
  let parentheses = 0;
  for (let index = start; index < segment.length; index += 1) {
    const character = segment[index];
    if (escaped) { escaped = false; continue; }
    if (character === "\\" && quote !== "'") { escaped = true; continue; }
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      continue;
    }
    if (character === "$" && segment[index + 1] === "(") {
      parentheses += segment[index + 2] === "(" ? 2 : 1;
      index += segment[index + 2] === "(" ? 2 : 1;
      continue;
    }
    if (character === "(") { parentheses += 1; continue; }
    if (character !== ")") continue;
    if (parentheses > 0) { parentheses -= 1; continue; }
    return segment.slice(index + 1);
  }
  return null;
}

function caseClauseBody(segment, separatorBefore) {
  const tokens = shellTokens(segment);
  if (separatorBefore === ";;") return bodyAfterCasePattern(segment, 0);
  if (!(tokens[0]?.plain && tokens[0].value.toLowerCase() === "case"
    && tokens[2]?.plain && tokens[2].value.toLowerCase() === "in")) return null;
  return bodyAfterCasePattern(segment, tokens[2].end);
}

function optionTokens(tokens, start = 1) {
  const values = tokens.slice(start).map((token) => token.value);
  const separator = values.indexOf("--");
  return separator < 0 ? values : values.slice(0, separator);
}

function isInspectionOnly(executable, tokens) {
  const options = optionTokens(tokens);
  if (options.some((value) => value === "--help" || value === "--version")) return true;
  if (executable === "git" && tokens[1]?.value.toLowerCase() === "apply") {
    return optionTokens(tokens, 2).includes("--check");
  }
  return executable === "npm" && tokens[1]?.value.toLowerCase() === "install"
    && optionTokens(tokens, 2).includes("--dry-run");
}

function maskCodeLiterals(code, language) {
  const output = [...code];
  let quote = null;
  let triple = false;
  let lineComment = false;
  let blockComment = false;
  let escaped = false;
  for (let index = 0; index < code.length; index += 1) {
    const character = code[index];
    const next = code[index + 1];
    if (lineComment) {
      if (character === "\n") lineComment = false;
      else output[index] = " ";
      continue;
    }
    if (blockComment) {
      output[index] = " ";
      if (character === "*" && next === "/") { output[index + 1] = " "; index += 1; blockComment = false; }
      continue;
    }
    if (quote) {
      output[index] = " ";
      if (escaped) { escaped = false; continue; }
      if (character === "\\") { escaped = true; continue; }
      if (triple && character === quote && next === quote && code[index + 2] === quote) {
        output[index + 1] = output[index + 2] = " ";
        index += 2;
        quote = null;
        triple = false;
      } else if (!triple && character === quote) quote = null;
      continue;
    }
    if (language === "javascript" && character === "/" && next === "/") {
      output[index] = output[index + 1] = " "; index += 1; lineComment = true; continue;
    }
    if (language === "javascript" && character === "/" && next === "*") {
      output[index] = output[index + 1] = " "; index += 1; blockComment = true; continue;
    }
    if (language === "python" && character === "#") {
      output[index] = " "; lineComment = true; continue;
    }
    const quotes = language === "javascript" ? new Set(["'", '"', "`"]) : new Set(["'", '"']);
    if (quotes.has(character)) {
      quote = character;
      triple = language === "python" && next === character && code[index + 2] === character;
      output[index] = " ";
      if (triple) { output[index + 1] = output[index + 2] = " "; index += 2; }
    }
  }
  return output.join("");
}

function pythonOpenWrites(code, masked) {
  for (const match of masked.matchAll(/\bopen\s*\(/g)) {
    const open = masked.indexOf("(", match.index);
    let depth = 0;
    let end = -1;
    for (let index = open; index < masked.length; index += 1) {
      if (masked[index] === "(") depth += 1;
      else if (masked[index] === ")" && --depth === 0) { end = index; break; }
    }
    if (end < 0) continue;
    const args = code.slice(open + 1, end);
    const mode = args.match(/(?:^|,)\s*(?:mode\s*=\s*)?([rubf]*)(['"])([wax][bt+]{0,3})\2\s*(?:,|$)/i);
    if (mode) return true;
  }
  return false;
}

function inlineProgramWrites(executable, code) {
  if (/^node(?:\.exe)?$/i.test(executable)) {
    return /\b(?:writeFileSync|appendFileSync|writeFile|appendFile)\s*\(/.test(maskCodeLiterals(code, "javascript"));
  }
  if (/^(?:python(?:3(?:\.\d+)?)?|py)(?:\.exe)?$/i.test(executable)) {
    const masked = maskCodeLiterals(code, "python");
    return /\.(?:write_text|write_bytes)\s*\(/.test(masked) || pythonOpenWrites(code, masked);
  }
  return false;
}

function segmentWrites(segment) {
  const caseBody = caseClauseBody(segment.text, segment.separatorBefore);
  if (caseBody !== null && segmentWrites({ text: caseBody })) return true;
  const tokens = executableTokens(segment.text);
  const executable = shellExecutableName(tokens[0]?.value);
  if (!executable) return false;
  if (isInspectionOnly(executable, tokens)) return false;
  if (MUTATION_COMMANDS.has(executable)) return true;
  if (new Set(["sed", "perl"]).has(executable)) return tokens.slice(1).some((token) => /^-.*i/.test(token.value));
  if (executable === "git") return /^(?:apply|checkout|restore|reset|merge|rebase|cherry-pick)$/i.test(tokens[1]?.value || "");
  if (new Set(["npm", "pnpm", "yarn"]).has(executable)) {
    return /^(?:install|update|add|remove)$/i.test(tokens[1]?.value || "");
  }
  if (executable === "dd") return tokens.slice(1).some((token) => /^of=/.test(token.value));
  if (new Set(["bash", "sh", "zsh", "pwsh", "powershell"]).has(executable)
    && new Set(["-c", "-command"]).has(tokens[1]?.value.toLowerCase()) && tokens[2]) {
    return commandWriteActions(tokens[2].value).length > 0;
  }
  if (executable === "eval" && tokens[1]) {
    return commandWriteActions(tokens.slice(1).map((token) => token.value).join(" ")).length > 0;
  }
  const inlineFlag = tokens.findIndex((token, index) => index > 0 && new Set(["-e", "--eval", "-c"]).has(token.value));
  if (inlineFlag > 0 && tokens[inlineFlag + 1]) return inlineProgramWrites(executable, tokens[inlineFlag + 1].value);
  return false;
}

function startsShellCommand(command, index) {
  return index === 0 || /[\s;&|(!{}]/.test(command[index - 1]);
}

function structuredComparisonIndexes(command) {
  const indexes = new Set();
  const frames = [];
  let quote = null;
  let escaped = false;
  let lineComment = false;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    const next = command[index + 1];
    if (lineComment) {
      if (character === "\n") lineComment = false;
      continue;
    }
    if (escaped) { escaped = false; continue; }
    if (character === "\\" && quote !== "'") { escaped = true; continue; }
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"') { quote = character; continue; }
    if (character === "#" && (index === 0 || /[\s;&|()]/.test(command[index - 1]))) {
      lineComment = true;
      continue;
    }
    const top = frames.at(-1);
    if (top?.type === "conditional" && character === "]" && next === "]") {
      frames.pop(); index += 1; continue;
    }
    if (top?.type === "arithmetic" && character === ")" && next === ")") {
      if (top.depth <= 1) frames.pop();
      else top.depth -= 2;
      index += 1;
      continue;
    }
    if (top?.type === "command" && character === ")") {
      if (top.depth === 0) frames.pop();
      else top.depth -= 1;
      continue;
    }
    if (top?.type === "backtick" && character === "`") {
      frames.pop();
      continue;
    }
    if (character === "[" && next === "[" && startsShellCommand(command, index)
      && /\s/.test(command[index + 2] || "")) {
      frames.push({ type: "conditional", depth: 0 }); index += 1; continue;
    }
    if (character === "$" && next === "(" && command[index + 2] === "(") {
      frames.push({ type: "arithmetic", depth: 0 }); index += 2; continue;
    }
    if (character === "(" && next === "(" && startsShellCommand(command, index)) {
      frames.push({ type: "arithmetic", depth: 0 }); index += 1; continue;
    }
    if (character === "$" && next === "(") {
      frames.push({ type: "command", depth: 0 }); index += 1; continue;
    }
    if (character === "`") { frames.push({ type: "backtick", depth: 0 }); continue; }
    if (top?.type === "command" && character === "(") { top.depth += 1; continue; }
    if (top?.type === "arithmetic" && character === "(") { top.depth += 1; continue; }
    if (character === ">" && ["conditional", "arithmetic"].includes(frames.at(-1)?.type)) {
      indexes.add(index);
    }
  }
  return indexes;
}

function redirectionActions(command) {
  const actions = [];
  const comparisons = structuredComparisonIndexes(command);
  let quote = null;
  let lineComment = false;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (lineComment) {
      if (character === "\n") lineComment = false;
      continue;
    }
    if (character === "\\" && quote !== "'") { index += 1; continue; }
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"') { quote = character; continue; }
    if (character === "#" && (index === 0 || /[\s;&|()]/.test(command[index - 1]))) {
      lineComment = true;
      continue;
    }
    if (character !== ">") continue;
    if (comparisons.has(index)) continue;
    const next = command[index + 1];
    if (next === ">") index += 1;
    let target = index + 1;
    while (/\s/.test(command[target] || "")) target += 1;
    if (!["&", "="].includes(command[target])) actions.push({ kind: "write", family: null, index });
  }
  return actions;
}

function commandWriteActions(command, depth = 0) {
  const heredocs = maskHeredocBodies(command);
  const analyzable = heredocs.command;
  const actions = shellSegments(analyzable).filter(segmentWrites)
    .map((segment) => ({ kind: "write", family: null, index: segment.index }));
  actions.push(...redirectionActions(analyzable));
  if (depth < MAX_SUBSTITUTION_DEPTH) {
    for (const heredoc of heredocs.bodies) {
      const executable = shellExecutableName(executableTokens(heredoc.opener)[0]?.value);
      if (!SHELL_STDIN_EXECUTORS.has(executable)) continue;
      actions.push(...commandWriteActions(heredoc.text, depth + 1)
        .map((action) => ({ ...action, index: heredoc.index + action.index })));
    }
    for (const substitution of shellSubstitutions(analyzable, depth)) {
      actions.push(...commandWriteActions(substitution.text, depth + 1)
        .map((action) => ({ ...action, index: substitution.index + action.index })));
    }
  }
  return actions;
}

function trailingTestAction(command) {
  if (typeof command !== "string" || /\|\||[;|\n]/.test(command)) return null;
  const parts = command.split(/\s*&&\s*/);
  const tail = parts.at(-1)?.trim() || "";
  const candidate = (isSuccessMarkerClause(tail) ? parts.at(-2) : tail)?.trim() || "";
  const match = TEST_COMMANDS.find(({ expression }) => expression.test(candidate));
  return match ? { kind: "test", family: match.family, index: command.lastIndexOf(candidate) } : null;
}

export function deliveryToolActions(input) {
  const toolName = String(input?.tool_name || "").slice(0, 128);
  if (WRITE_TOOLS.test(toolName)) return [{ kind: "write", family: null, index: 0 }];
  if (!SHELL_TOOLS.test(toolName)) return [];
  const command = commandFromInput(input);
  if (command.length > MAX_COMMAND_CHARS) return [];
  const actions = commandWriteActions(command);
  const test = trailingTestAction(command);
  if (test) actions.push(test);
  return actions.sort((left, right) => left.index - right.index || left.kind.localeCompare(right.kind));
}
