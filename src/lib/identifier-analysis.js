const STATIC_GLOBALS = new Set([
  "AbortController", "AbortSignal", "Array", "ArrayBuffer", "Atomics", "BigInt", "BigInt64Array",
  "BigUint64Array", "Blob", "Boolean", "Buffer", "console", "crypto", "CustomEvent", "DataView", "Date",
  "decodeURI", "decodeURIComponent", "document", "DOMException", "encodeURI", "encodeURIComponent",
  "Error", "escape", "eval", "EvalError", "Event", "EventTarget", "exports", "fetch", "File",
  "FinalizationRegistry", "Float32Array", "Float64Array", "FormData", "Function", "global", "globalThis",
  "Headers", "history", "Infinity", "Int16Array", "Int32Array", "Int8Array", "Intl", "isFinite", "isNaN",
  "JSON", "location", "Map", "Math", "MessageChannel", "MessageEvent", "MessagePort", "module", "NaN",
  "navigator", "Number", "Object", "parseFloat", "parseInt", "performance", "process", "Promise", "Proxy",
  "queueMicrotask", "RangeError", "ReadableStream", "ReferenceError", "Reflect", "RegExp", "Request",
  "require", "Response", "self", "Set", "setImmediate", "setInterval", "setTimeout", "SharedArrayBuffer",
  "String", "structuredClone", "Symbol", "SyntaxError", "TextDecoder", "TextEncoder", "TransformStream",
  "TypeError", "Uint16Array", "Uint32Array", "Uint8Array", "Uint8ClampedArray", "undefined", "unescape",
  "URIError", "URL", "URLSearchParams", "WeakMap", "WeakRef", "WeakSet", "WebAssembly", "window",
  "WritableStream", "clearImmediate", "clearInterval", "clearTimeout", "__dirname", "__filename"
]);

const KEYWORDS = new Set([
  "as", "async", "await", "break", "case", "catch", "class", "const", "continue", "debugger", "default",
  "delete", "do", "else", "export", "extends", "false", "finally", "for", "from", "function", "get", "if",
  "import", "in", "instanceof", "let", "new", "null", "of", "return", "set", "static", "super", "switch",
  "this", "throw", "true", "try", "typeof", "var", "void", "while", "with", "yield"
]);

function tokenize(source) {
  const tokens = [];
  let index = 0;
  let line = 1;
  const push = (value) => tokens.push({ value, line });
  const skipQuoted = (quote) => {
    index += 1;
    while (index < source.length) {
      if (source[index] === "\n") line += 1;
      if (source[index] === "\\") index += 2;
      else if (source[index] === quote) { index += 1; break; }
      else index += 1;
    }
  };
  while (index < source.length) {
    const character = source[index];
    if (character === "\n") { line += 1; index += 1; continue; }
    if (/\s/.test(character)) { index += 1; continue; }
    if (source.startsWith("//", index)) {
      index = source.indexOf("\n", index);
      if (index < 0) break;
      continue;
    }
    if (source.startsWith("/*", index)) {
      const end = source.indexOf("*/", index + 2);
      const stop = end < 0 ? source.length : end + 2;
      line += (source.slice(index, stop).match(/\n/g) || []).length;
      index = stop;
      continue;
    }
    if (["'", "\"", "`"].includes(character)) { skipQuoted(character); continue; }
    if (/[A-Za-z_$]/.test(character)) {
      const match = source.slice(index).match(/^[A-Za-z_$][\w$]*/)[0];
      push(match);
      index += match.length;
      continue;
    }
    if (/\d/.test(character)) {
      const match = source.slice(index).match(/^(?:0[xob])?[\da-f._]+/i)[0];
      push(match);
      index += match.length;
      continue;
    }
    const operator = ["=>", "?.", "...", "===", "!==", "==", "!=", "<=", ">=", "&&", "||", "??"]
      .find((value) => source.startsWith(value, index));
    push(operator || character);
    index += (operator || character).length;
  }
  return tokens;
}

function identifier(token) {
  return Boolean(token && /^[A-Za-z_$][\w$]*$/.test(token.value) && !KEYWORDS.has(token.value));
}

function matchingOpen(tokens, closeIndex) {
  let depth = 0;
  for (let index = closeIndex; index >= 0; index -= 1) {
    if (tokens[index].value === ")") depth += 1;
    else if (tokens[index].value === "(" && --depth === 0) return index;
  }
  return -1;
}

function addBindings(tokens, start, end, declared) {
  for (let index = start; index < end; index += 1) {
    if (!identifier(tokens[index])) continue;
    if (tokens[index + 1]?.value === ":" && tokens[index - 1]?.value !== "...") continue;
    declared.add(tokens[index].value);
  }
}

function collectVariableBindings(tokens, start, declared) {
  let bindingStart = start;
  let inInitializer = false;
  let depth = 0;
  for (let index = start; index < tokens.length; index += 1) {
    const value = tokens[index].value;
    if (["(", "[", "{"].includes(value)) depth += 1;
    else if ([")", "]", "}"].includes(value)) depth -= 1;
    if (!inInitializer && value === "=" && depth === 0) {
      addBindings(tokens, bindingStart, index, declared);
      inInitializer = true;
    }
    if (depth === 0 && [",", ";", "of", "in"].includes(value)) {
      if (!inInitializer) addBindings(tokens, bindingStart, index, declared);
      if (value !== ",") return index;
      bindingStart = index + 1;
      inInitializer = false;
    }
  }
  return tokens.length;
}

function collectDeclarations(tokens, declared) {
  for (let index = 0; index < tokens.length; index += 1) {
    const value = tokens[index].value;
    if (["const", "let", "var"].includes(value)) {
      collectVariableBindings(tokens, index + 1, declared);
    } else if (["function", "class"].includes(value)) {
      let cursor = index + 1;
      if (tokens[cursor]?.value === "*") cursor += 1;
      if (identifier(tokens[cursor])) declared.add(tokens[cursor++].value);
      if (value === "function" && tokens[cursor]?.value === "(") {
        let end = cursor + 1;
        let depth = 1;
        for (; end < tokens.length && depth; end += 1) {
          if (tokens[end].value === "(") depth += 1;
          else if (tokens[end].value === ")") depth -= 1;
        }
        addBindings(tokens, cursor + 1, end - 1, declared);
      }
    } else if (value === "catch" && tokens[index + 1]?.value === "(") {
      const end = tokens.findIndex((token, candidate) => candidate > index && token.value === ")");
      if (end > index) addBindings(tokens, index + 2, end, declared);
    } else if (value === "import") {
      let end = index + 1;
      while (end < tokens.length && !["from", ";"].includes(tokens[end].value)) end += 1;
      addBindings(tokens, index + 1, end, declared);
    } else if (value === "=>") {
      if (tokens[index - 1]?.value === ")") {
        const open = matchingOpen(tokens, index - 1);
        if (open >= 0) addBindings(tokens, open + 1, index - 1, declared);
      } else if (identifier(tokens[index - 1])) declared.add(tokens[index - 1].value);
    }
  }
}

export function undeclaredCalls(source, { allowlist = [] } = {}) {
  const tokens = tokenize(source);
  const declared = new Set([...STATIC_GLOBALS, ...Object.getOwnPropertyNames(globalThis), ...allowlist]);
  collectDeclarations(tokens, declared);
  const findings = [];
  const seen = new Set();
  for (let index = 0; index < tokens.length - 1; index += 1) {
    const token = tokens[index];
    if (!identifier(token) || tokens[index + 1].value !== "(" || [".", "?."].includes(tokens[index - 1]?.value)) continue;
    const key = `${token.line}\0${token.value}`;
    if (declared.has(token.value) || seen.has(key)) continue;
    seen.add(key);
    findings.push({ name: token.value, line: token.line });
  }
  return findings;
}
