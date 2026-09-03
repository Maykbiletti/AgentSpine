function delimiterWord(line, start) {
  let value = "";
  let quote = null;
  let escaped = false;
  let cursor = start;
  for (; cursor < line.length; cursor += 1) {
    const character = line[cursor];
    if (escaped) { value += character; escaped = false; continue; }
    if (character === "\\" && quote !== "'") { escaped = true; continue; }
    if (quote) {
      if (character === quote) quote = null;
      else value += character;
      continue;
    }
    if (character === "'" || character === '"') { quote = character; continue; }
    if (/\s/.test(character) || /[;&|<>()]/.test(character)) break;
    value += character;
  }
  return !quote && value ? { delimiter: value, end: cursor } : null;
}

function lineDeclarations(line) {
  const declarations = [];
  let quote = null;
  let escaped = false;
  let arithmeticDepth = 0;
  let commandStart = 0;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    const next = line[index + 1];
    if (escaped) { escaped = false; continue; }
    if (character === "\\" && quote !== "'") { escaped = true; continue; }
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"') { quote = character; continue; }
    if (character === "#" && (index === 0 || /[\s;&|()]/.test(line[index - 1]))) break;
    if (character === "$" && next === "(" && line[index + 2] === "(") {
      arithmeticDepth += 1; index += 2; continue;
    }
    if (character === "(" && next === "(") { arithmeticDepth += 1; index += 1; continue; }
    if (arithmeticDepth && character === ")" && next === ")") {
      arithmeticDepth -= 1; index += 1; continue;
    }
    if (!arithmeticDepth && /[;&|]/.test(character)) {
      commandStart = index + 1;
      continue;
    }
    if (arithmeticDepth || character !== "<" || next !== "<") continue;
    if (line[index + 2] === "<") { index += 2; continue; }
    let cursor = index + 2;
    let stripTabs = false;
    if (line[cursor] === "-") { stripTabs = true; cursor += 1; }
    while (line[cursor] === " " || line[cursor] === "\t") cursor += 1;
    const word = delimiterWord(line, cursor);
    if (!word) continue;
    declarations.push({
      delimiter: word.delimiter,
      stripTabs,
      opener: line.slice(commandStart, index)
    });
    index = word.end - 1;
  }
  return declarations;
}

function nextLine(command, start) {
  const newline = command.indexOf("\n", start);
  return { end: newline < 0 ? command.length : newline, next: newline < 0 ? command.length : newline + 1 };
}

function maskLine(output, start, end) {
  for (let index = start; index < end; index += 1) output[index] = " ";
}

export function maskHeredocBodies(command) {
  if (!command.includes("<<") || !command.includes("\n")) return { command, bodies: [] };
  const output = [...command];
  const bodies = [];
  let cursor = 0;
  while (cursor < command.length) {
    const opener = nextLine(command, cursor);
    const declarations = lineDeclarations(command.slice(cursor, opener.end));
    if (!declarations.length) { cursor = opener.next; continue; }
    let bodyStart = opener.next;
    for (const declaration of declarations) {
      let found = false;
      const contentStart = bodyStart;
      let contentEnd = bodyStart;
      while (bodyStart <= command.length) {
        const lineStart = bodyStart;
        const bodyLine = nextLine(command, bodyStart);
        const raw = command.slice(bodyStart, bodyLine.end).replace(/\r$/, "");
        const candidate = declaration.stripTabs ? raw.replace(/^\t+/, "") : raw;
        maskLine(output, bodyStart, bodyLine.end);
        bodyStart = bodyLine.next;
        if (candidate === declaration.delimiter) {
          found = true;
          contentEnd = lineStart;
          break;
        }
        if (bodyLine.end === command.length) break;
      }
      if (!found) return { command: output.join(""), bodies };
      bodies.push({
        text: command.slice(contentStart, contentEnd),
        index: contentStart,
        opener: declaration.opener
      });
    }
    cursor = bodyStart;
  }
  return { command: output.join(""), bodies };
}
