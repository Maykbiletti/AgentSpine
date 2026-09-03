export const MAX_SUBSTITUTION_DEPTH = 8;

function backtickEnd(command, start) {
  let escaped = false;
  for (let index = start + 1; index < command.length; index += 1) {
    const character = command[index];
    if (escaped) { escaped = false; continue; }
    if (character === "\\") { escaped = true; continue; }
    if (character === "`") return index;
  }
  return -1;
}

function substitutionEnd(command, start, depth) {
  if (depth >= MAX_SUBSTITUTION_DEPTH) return -1;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let parentheses = 0;
  for (let index = start + 2; index < command.length; index += 1) {
    const character = command[index];
    const next = command[index + 1];
    if (lineComment) {
      if (character === "\n") lineComment = false;
      continue;
    }
    if (escaped) { escaped = false; continue; }
    if (character === "\\" && quote !== "'") { escaped = true; continue; }
    if (quote === "'") {
      if (character === quote) quote = null;
      continue;
    }
    if (quote === '"') {
      if (character === quote) { quote = null; continue; }
      if (character === "$" && next === "(" && command[index + 2] !== "(") {
        const end = substitutionEnd(command, index, depth + 1);
        if (end < 0) return -1;
        index = end;
      } else if (character === "`") {
        const end = backtickEnd(command, index);
        if (end < 0) return -1;
        index = end;
      }
      continue;
    }
    if (character === "'" || character === '"') { quote = character; continue; }
    if (character === "#" && (index === 0 || /[\s;&|()]/.test(command[index - 1]))) {
      lineComment = true;
      continue;
    }
    if (character === "$" && next === "(" && command[index + 2] !== "(") {
      const end = substitutionEnd(command, index, depth + 1);
      if (end < 0) return -1;
      index = end;
      continue;
    }
    if (character === "`") {
      const end = backtickEnd(command, index);
      if (end < 0) return -1;
      index = end;
      continue;
    }
    if (character === "(") { parentheses += 1; continue; }
    if (character === ")") {
      if (parentheses === 0) return index;
      parentheses -= 1;
    }
  }
  return -1;
}

export function shellSubstitutions(command, depth) {
  const substitutions = [];
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
    if (quote === "'") {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"') { quote = quote === '"' ? null : '"'; continue; }
    if (!quote && character === "'") { quote = character; continue; }
    if (!quote && character === "#" && (index === 0 || /[\s;&|()]/.test(command[index - 1]))) {
      lineComment = true;
      continue;
    }
    if (character === "$" && next === "(" && command[index + 2] !== "(") {
      const end = substitutionEnd(command, index, depth);
      if (end < 0) continue;
      substitutions.push({ text: command.slice(index + 2, end), index: index + 2 });
      index = end;
      continue;
    }
    if (character === "`") {
      const end = backtickEnd(command, index);
      if (end < 0) continue;
      substitutions.push({ text: command.slice(index + 1, end), index: index + 1 });
      index = end;
    }
  }
  return substitutions;
}
