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
  "await", "break", "case", "catch", "class", "const", "continue", "debugger", "default", "delete", "do",
  "else", "enum", "export", "extends", "false", "finally", "for", "function", "if", "import", "in",
  "instanceof", "let", "new", "null", "return", "super", "switch", "this", "throw", "true", "try",
  "typeof", "var", "void", "while", "with", "yield"
]);

const REGEX_PREFIXES = new Set([
  "(", "[", "{", "}", ",", ";", ":", "=", "=>", "!", "?", "&&", "||", "??", "return", "throw",
  "case", "delete", "typeof", "void", "in", "of", "await", "yield", "else", "do"
]);

const CONTROL_HEADS = new Set(["catch", "for", "if", "switch", "while", "with"]);
const IDENTIFIER_START = /^[$_\p{ID_Start}]$/u;
const IDENTIFIER_PART = /^[$_\u200C\u200D\p{ID_Continue}]$/u;

function codePoint(source, index) {
  return String.fromCodePoint(source.codePointAt(index));
}

function templateExpressionEnd(source, start) {
  let depth = 1;
  let index = start;
  const skipString = (quote) => {
    index += 1;
    while (index < source.length) {
      if (source[index] === "\\") index += 2;
      else if (source[index] === quote) { index += 1; return; }
      else index += 1;
    }
  };
  const skipTemplate = () => {
    index += 1;
    while (index < source.length) {
      if (source[index] === "\\") { index += 2; continue; }
      if (source[index] === "`") { index += 1; return; }
      if (source.startsWith("${", index)) {
        const end = templateExpressionEnd(source, index + 2);
        index = end < 0 ? source.length : end + 1;
      } else index += 1;
    }
  };
  while (index < source.length) {
    if (["'", "\""].includes(source[index])) { skipString(source[index]); continue; }
    if (source[index] === "`") { skipTemplate(); continue; }
    if (source.startsWith("//", index)) {
      const newline = source.indexOf("\n", index + 2);
      index = newline < 0 ? source.length : newline + 1;
      continue;
    }
    if (source.startsWith("/*", index)) {
      const end = source.indexOf("*/", index + 2);
      index = end < 0 ? source.length : end + 2;
      continue;
    }
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}" && --depth === 0) return index;
    index += 1;
  }
  return -1;
}

function tokenize(source) {
  const tokens = [];
  let index = 0;
  let line = 1;
  const push = (value, kind = "punctuator", atLine = line) => tokens.push({ value, line: atLine, kind });
  const skipQuoted = (quote) => {
    push("<literal>", "literal");
    index += 1;
    while (index < source.length) {
      if (source[index] === "\n") line += 1;
      if (source[index] === "\\") index += 2;
      else if (source[index] === quote) { index += 1; break; }
      else index += 1;
    }
  };
  const skipTemplate = () => {
    index += 1;
    while (index < source.length) {
      if (source[index] === "\n") { line += 1; index += 1; continue; }
      if (source[index] === "\\") { index += 2; continue; }
      if (source[index] === "`") { index += 1; return; }
      if (source.startsWith("${", index)) {
        const startLine = line;
        const start = index + 2;
        const end = templateExpressionEnd(source, start);
        if (end < 0) { index = source.length; return; }
        for (const token of tokenize(source.slice(start, end))) {
          push(token.value, token.kind, startLine + token.line - 1);
        }
        line += (source.slice(start, end).match(/\n/g) || []).length;
        index = end + 1;
      } else index += 1;
    }
  };
  const skipRegex = () => {
    const previous = tokens.at(-1)?.value;
    let allowed = !previous || REGEX_PREFIXES.has(previous);
    if (!allowed && previous === ")") {
      const open = matchingOpen(tokens, tokens.length - 1);
      allowed = open > 0 && CONTROL_HEADS.has(tokens[open - 1].value);
    }
    if (!allowed) return false;
    let cursor = index + 1;
    let characterClass = false;
    while (cursor < source.length) {
      const current = source[cursor];
      if (current === "\n" || current === "\r") return false;
      if (current === "\\") { cursor += 2; continue; }
      if (current === "[") characterClass = true;
      else if (current === "]") characterClass = false;
      else if (current === "/" && !characterClass) {
        cursor += 1;
        while (/[A-Za-z]/.test(source[cursor] || "")) cursor += 1;
        index = cursor;
        return true;
      }
      cursor += 1;
    }
    return false;
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
    if (character === "/" && skipRegex()) continue;
    if (["'", "\""].includes(character)) { skipQuoted(character); continue; }
    if (character === "`") { skipTemplate(); continue; }
    const first = codePoint(source, index);
    if (IDENTIFIER_START.test(first)) {
      const start = index;
      index += first.length;
      while (index < source.length) {
        const next = codePoint(source, index);
        if (!IDENTIFIER_PART.test(next)) break;
        index += next.length;
      }
      push(source.slice(start, index), "word");
      continue;
    }
    if (/\d/.test(character)) {
      const match = source.slice(index).match(/^(?:0[xob])?[\da-f._]+/i)[0];
      push(match, "number");
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
  return Boolean(token?.kind === "word" && !KEYWORDS.has(token.value));
}

function matchingOpen(tokens, closeIndex) {
  let depth = 0;
  for (let index = closeIndex; index >= 0; index -= 1) {
    if (tokens[index].value === ")") depth += 1;
    else if (tokens[index].value === "(" && --depth === 0) return index;
  }
  return -1;
}

function matchingClose(tokens, openIndex) {
  const pairs = { "(": ")", "[": "]", "{": "}" };
  const open = tokens[openIndex]?.value;
  const close = pairs[open];
  if (!close) return -1;
  let depth = 0;
  for (let index = openIndex; index < tokens.length; index += 1) {
    if (tokens[index].value === open) depth += 1;
    else if (tokens[index].value === close && --depth === 0) return index;
  }
  return -1;
}

function skipExpression(tokens, start, end, stops = new Set([","])) {
  let depth = 0;
  for (let index = start; index < tokens.length; index += 1) {
    if (index >= end) return end;
    const value = tokens[index].value;
    if (depth === 0 && stops.has(value)) return index;
    if (["(", "[", "{"].includes(value)) depth += 1;
    else if ([")", "]", "}"].includes(value)) depth -= 1;
  }
  return end;
}

function collectBindingPattern(tokens, start, end, declared) {
  let index = start;
  if (tokens[index]?.value === "...") index += 1;
  if (index >= end) return index;
  if (identifier(tokens[index])) {
    declared.add(tokens[index].value);
    return index + 1;
  }
  const open = tokens[index]?.value;
  if (!["[", "{"].includes(open)) return index + 1;
  const close = matchingClose(tokens, index);
  if (close < 0 || close > end) return end;
  let cursor = index + 1;
  while (cursor < close) {
    if (tokens[cursor].value === ",") { cursor += 1; continue; }
    let bindingHandled = false;
    if (open === "{" && tokens[cursor].value !== "...") {
      if (tokens[cursor].value === "[") {
        const computedClose = matchingClose(tokens, cursor);
        cursor = computedClose < 0 || computedClose >= close ? close : computedClose + 1;
        if (tokens[cursor]?.value === ":") cursor += 1;
      } else {
        const key = tokens[cursor];
        cursor += 1;
        if (tokens[cursor]?.value === ":") cursor += 1;
        else if (identifier(key)) {
          declared.add(key.value);
          bindingHandled = true;
        }
      }
    }
    if (!bindingHandled) {
      const next = collectBindingPattern(tokens, cursor, close, declared);
      if (next > cursor) cursor = next;
    }
    if (tokens[cursor]?.value === "=") cursor = skipExpression(tokens, cursor + 1, close);
    else cursor = skipExpression(tokens, cursor, close);
    if (tokens[cursor]?.value === ",") cursor += 1;
  }
  return close + 1;
}

function collectBindingList(tokens, start, end, declared) {
  let cursor = start;
  while (cursor < end) {
    if (tokens[cursor].value === ",") { cursor += 1; continue; }
    const next = collectBindingPattern(tokens, cursor, end, declared);
    cursor = next > cursor ? next : cursor + 1;
    if (tokens[cursor]?.value === "=") cursor = skipExpression(tokens, cursor + 1, end);
    else cursor = skipExpression(tokens, cursor, end);
    if (tokens[cursor]?.value === ",") cursor += 1;
  }
}

function collectVariableBindings(tokens, start, declared) {
  let end = start;
  let depth = 0;
  let initializerSeen = false;
  const declaration = start - 1;
  const inForHeader = tokens[declaration - 1]?.value === "("
    && (tokens[declaration - 2]?.value === "for"
      || (tokens[declaration - 2]?.value === "await" && tokens[declaration - 3]?.value === "for"));
  while (end < tokens.length) {
    const value = tokens[end].value;
    if (depth === 0 && (value === ";"
      || (inForHeader && !initializerSeen && ["of", "in"].includes(value)))) break;
    if (depth === 0 && value === "=") initializerSeen = true;
    if (["(", "[", "{"].includes(value)) depth += 1;
    else if ([")", "]", "}"].includes(value)) {
      if (depth === 0) break;
      depth -= 1;
    }
    end += 1;
  }
  collectBindingList(tokens, start, end, declared);
  return end;
}

function collectImportBindings(tokens, start, declared) {
  if (tokens[start]?.value === "(") return;
  if (tokens[start]?.kind === "literal") return;
  let end = start;
  while (end < tokens.length && !["from", ";"].includes(tokens[end].value)) end += 1;
  let cursor = start;
  if (identifier(tokens[cursor])) {
    declared.add(tokens[cursor].value);
    cursor += 1;
    if (tokens[cursor]?.value === ",") cursor += 1;
  }
  if (tokens[cursor]?.value === "*" && tokens[cursor + 1]?.value === "as"
    && identifier(tokens[cursor + 2])) declared.add(tokens[cursor + 2].value);
  if (tokens[cursor]?.value !== "{") return;
  const close = Math.min(matchingClose(tokens, cursor), end);
  let itemStart = cursor + 1;
  for (let index = itemStart; index <= close; index += 1) {
    if (index < close && tokens[index].value !== ",") continue;
    const item = tokens.slice(itemStart, index);
    const alias = item.findIndex((token) => token.value === "as");
    const local = alias >= 0
      ? item.slice(alias + 1).find(identifier)
      : [...item].reverse().find(identifier);
    if (local) declared.add(local.value);
    itemStart = index + 1;
  }
}

function classBodyOpens(tokens) {
  const openings = new Set();
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].value !== "class" || tokens[index + 1]?.value === "("
      || [".", "?."].includes(tokens[index - 1]?.value)) continue;
    let parentheses = 0;
    let brackets = 0;
    for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
      const value = tokens[cursor].value;
      if (value === "(") parentheses += 1;
      else if (value === ")") parentheses -= 1;
      else if (value === "[") brackets += 1;
      else if (value === "]") brackets -= 1;
      else if (value === "{" && parentheses === 0 && brackets === 0) {
        openings.add(cursor);
        break;
      }
    }
  }
  return openings;
}

function enclosingBrace(tokens, index) {
  let depth = 0;
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (tokens[cursor].value === "}") depth += 1;
    else if (tokens[cursor].value === "{") {
      if (depth === 0) return cursor;
      depth -= 1;
    }
  }
  return -1;
}

function methodContainer(tokens, index, classBodies) {
  const open = enclosingBrace(tokens, index);
  if (classBodies.has(open)) return true;
  if (open < 0) return false;
  const previous = tokens[open - 1]?.value;
  return ![undefined, "{", "}", ";", ")", "else", "try", "finally", "do", "=>", "static"]
    .includes(previous);
}

function collectMethod(tokens, index, declared, nonCalls, classBodies) {
  const name = tokens[index];
  const propertyName = name?.kind === "word" || name?.kind === "literal" || name?.kind === "number";
  if (!propertyName || tokens[index + 1]?.value !== "(" || tokens[index - 1]?.value === "extends"
    || !methodContainer(tokens, index, classBodies)) return;
  const close = matchingClose(tokens, index + 1);
  if (close < 0 || tokens[close + 1]?.value !== "{") return;
  nonCalls.add(index);
  collectBindingList(tokens, index + 2, close, declared);
}

function collectComputedMethod(tokens, index, declared, classBodies) {
  if (tokens[index]?.value !== "[") return;
  const propertyClose = matchingClose(tokens, index);
  if (propertyClose < 0 || tokens[propertyClose + 1]?.value !== "(") return;
  const parametersClose = matchingClose(tokens, propertyClose + 1);
  if (parametersClose < 0 || tokens[parametersClose + 1]?.value !== "{"
    || !methodContainer(tokens, index, classBodies)) return;
  collectBindingList(tokens, propertyClose + 2, parametersClose, declared);
}

function collectDeclarations(tokens, declared, nonCalls) {
  const classBodies = classBodyOpens(tokens);
  for (let index = 0; index < tokens.length; index += 1) {
    const value = tokens[index].value;
    if (["const", "let", "var"].includes(value)) {
      collectVariableBindings(tokens, index + 1, declared);
    } else if (["function", "class"].includes(value)) {
      let cursor = index + 1;
      if (tokens[cursor]?.value === "*") cursor += 1;
      if (identifier(tokens[cursor])) declared.add(tokens[cursor++].value);
      if (value === "function" && tokens[cursor]?.value === "(") {
        const end = matchingClose(tokens, cursor);
        if (end >= 0) collectBindingList(tokens, cursor + 1, end, declared);
      }
    } else if (value === "catch" && tokens[index + 1]?.value === "(") {
      const end = matchingClose(tokens, index + 1);
      if (end > index) collectBindingList(tokens, index + 2, end, declared);
    } else if (value === "import") {
      collectImportBindings(tokens, index + 1, declared);
    } else if (value === "=>") {
      if (tokens[index - 1]?.value === ")") {
        const open = matchingOpen(tokens, index - 1);
        if (open >= 0) collectBindingList(tokens, open + 1, index - 1, declared);
      } else if (identifier(tokens[index - 1])) declared.add(tokens[index - 1].value);
    }
    if (value === "async" && tokens[index + 1]?.value === "(") {
      const close = matchingClose(tokens, index + 1);
      if (close >= 0 && tokens[close + 1]?.value === "=>") nonCalls.add(index);
    }
    collectMethod(tokens, index, declared, nonCalls, classBodies);
    collectComputedMethod(tokens, index, declared, classBodies);
  }
}

export function undeclaredCalls(source, { allowlist = [] } = {}) {
  const tokens = tokenize(source);
  const declared = new Set([...STATIC_GLOBALS, ...Object.getOwnPropertyNames(globalThis), ...allowlist]);
  const nonCalls = new Set();
  collectDeclarations(tokens, declared, nonCalls);
  const findings = [];
  const seen = new Set();
  for (let index = 0; index < tokens.length - 1; index += 1) {
    const token = tokens[index];
    const call = tokens[index + 1].value === "("
      || (tokens[index + 1].value === "?." && tokens[index + 2]?.value === "(");
    if (!identifier(token) || nonCalls.has(index) || !call
      || [".", "?."].includes(tokens[index - 1]?.value)) continue;
    const key = `${token.line}\0${token.value}`;
    if (declared.has(token.value) || seen.has(key)) continue;
    seen.add(key);
    findings.push({ name: token.value, line: token.line });
  }
  return findings;
}
