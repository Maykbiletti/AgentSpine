import { createHash } from "node:crypto";
import { timelineTerms } from "./session-timeline-query.js";

const MAX_LINE_BYTES = 1024 * 1024;
const TEXT_KEY_RE = /^(?:content|text|result|output|error|message)$/i;
const SENSITIVE_KEY_RE = /^(?:api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|token|secret|client[_-]?secret|password|passwort|credential|authorization|proxy[_-]?authorization|cookie|set[_-]?cookie|private[_-]?key|aws[_-]?secret[_-]?access[_-]?key)$/i;
const SECRET_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)|\b(?:aspt|astp|astc)_[A-Za-z0-9_.-]{40,}\b|\b(?:sk[-_](?:proj[-_])?|gh[opusu]_)[A-Za-z0-9_-]{20,}\b|\b(?:xox[bapcrs]-|github_pat_|glpat-|npm_)[A-Za-z0-9_-]{12,}\b|\bAKIA[0-9A-Z]{16}\b|\b[a-z][a-z0-9+.-]{0,31}:\/\/[^\s\/@:]+:[^\s\/@]+@|https?:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9_/-]+|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/i;
const CREDENTIAL_VALUE_RE = /["'](?:api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|token|secret|client[_-]?secret|password|passwort|credential|authorization|proxy[_-]?authorization|cookie|set[_-]?cookie|private[_-]?key|aws[_-]?secret[_-]?access[_-]?key)["']\s*:\s*(?:["'][^"'\r\n]*["']|[^,}\]\s]+)|\b(?:api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|token|secret|client[_-]?secret|password|passwort|credential|aws[_-]?secret[_-]?access[_-]?key)\s*[:=]\s*(?:["'][^"'\r\n]*["']|\S+)/i;
const AUTHORIZATION_RE = /\b(?:authorization|proxy-authorization)\s*:\s*(?:bearer|basic|digest|token|apikey|api-key|aws4-hmac-sha256)\b|\b(?:bearer|basic|digest|token|apikey|api-key|aws4-hmac-sha256)\s+[A-Za-z0-9._~+\/=:-]+/i;
const INSTRUCTION_RE = /(?:\b(?:ignore|disregard|override|bypass|forget)\b[\s\S]{0,180}\b(?:previous|prior|system|developer|instruction|instructions|prompt|prompts|rule|rules|safeguard|safeguards)\b|\b(?:ignoriere|missachte|übergehe|umgehe|vergesse)\b[\s\S]{0,180}\b(?:vorherige|frühere|system|entwickler|anweisung|anweisungen|prompt|prompts|regel|regeln|schutzmaßnahme|schutzmaßnahmen)\b|<\s*\/?\s*(?:system|developer|assistant|instructions?|prompt)\b[^>]*>)/i;
const OBJECTIVE_RE = /\b(?:measur(?:e|ed|ement)|gemessen|benchmark|test(?:ed|ing)?|suite|assert(?:ion)?|ci\b|prüfung|durchlauf|ergebnis)\b/i;
const OUTCOME_PATTERNS = [
  ["pass", /\b(?:pass(?:ed|ing)?|green|success(?:ful)?|ok|bestanden|erfolgreich)\b/gi],
  ["fail", /\b(?:fail(?:ed|ure)?|red|fehlgeschlagen)\b/gi],
  ["blocked", /\b(?:blocked|blockiert)\b/gi],
  ["timeout", /\b(?:timeout|zeitüberschreitung)\b/gi],
  ["error", /\b(?:error|fehler)\b/gi],
  ["skipped", /\b(?:skipped|übersprungen)\b/gi]
];

function digest(value) { return createHash("sha256").update(value).digest("hex"); }

export function extractTimelineTimestamp(value) {
  for (const key of ["timestamp", "created_at", "createdAt"]) {
    const current = value?.[key];
    if (typeof current !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(current)) continue;
    const parsed = new Date(current);
    if (Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 19) === current.slice(0, 19)) return parsed.toISOString();
  }
  return null;
}

function isToolResult(value) {
  const type = String(value?.type || value?.kind || "").toLowerCase().replaceAll("_", "-");
  return value?.role === "tool" || ["tool-result", "toolresult", "command-result", "runner-result"].includes(type);
}

function unsafeText(value) {
  return SECRET_RE.test(value) || CREDENTIAL_VALUE_RE.test(value) || AUTHORIZATION_RE.test(value) || INSTRUCTION_RE.test(value);
}

function unsafeObject(value) {
  const pending = [{ value, depth: 0 }];
  let visited = 0;
  while (pending.length && visited < 128) {
    const current = pending.pop();
    visited += 1;
    if (typeof current.value === "string") {
      if (unsafeText(current.value)) return true;
      continue;
    }
    if (!current.value || typeof current.value !== "object" || current.depth > 5) continue;
    for (const [key, item] of Object.entries(current.value).slice(0, 64)) {
      if (SENSITIVE_KEY_RE.test(key)) return true;
      pending.push({ value: item, depth: current.depth + 1 });
    }
  }
  return visited >= 128;
}

function objectiveText(value) {
  const values = [];
  const visit = (item, key = "", depth = 0) => {
    if (depth > 5 || values.length >= 12) return;
    if (typeof item === "string") {
      if (TEXT_KEY_RE.test(key)) values.push(item.slice(0, 4096));
      return;
    }
    if (!item || typeof item !== "object") return;
    for (const [name, current] of Object.entries(item).slice(0, 48)) visit(current, name, depth + 1);
  };
  visit(value);
  return values.join("\n");
}

function normalizedOutcome(value) {
  const found = OUTCOME_PATTERNS.filter(([, pattern]) => {
    pattern.lastIndex = 0;
    return pattern.test(value);
  }).map(([outcome]) => outcome);
  return found.length === 1 ? found[0] : null;
}

function normalizedCount(value) {
  const matches = [...value.matchAll(/\b(\d{1,6})\s*\/\s*(\d{1,6})\b/g)].map((match) => ({
    value: Number(match[1]), total: Number(match[2])
  })).filter((item) => item.value <= item.total && item.total > 0);
  if (!matches.length) return null;
  const first = matches[0];
  return matches.every((item) => item.value === first.value && item.total === first.total) ? first : null;
}

function normalizedTestLabel(value) {
  const suite = value.match(/\b(?:suite|test(?:\s+suite)?|testlauf|prüfung)\s*(?:#|nr\.?|nummer)?\s*(\d{1,4})\b/i);
  if (suite) return `suite-${Number(suite[1])}`;
  if (/\bacceptance\b/i.test(value)) return "acceptance";
  if (/\baudit\b/i.test(value)) return "audit";
  if (/\bnpm\s+run\s+check\b/i.test(value)) return "npm-check";
  if (/\bci\b/i.test(value)) return "ci";
  if (/\b(?:test|prüfung|durchlauf)\b/i.test(value)) return "test";
  return null;
}

function structuredTerms({ outcome, count, testLabel }) {
  return timelineTerms(["objective", "measurement", "messung", "result", "ergebnis", outcome, testLabel || "",
    count ? String(count.value) : "", count ? String(count.total) : ""].join(" "));
}

function candidateFromToolResult(value) {
  if (!isToolResult(value) || unsafeObject(value)) return null;
  const body = objectiveText(value);
  if (!body || !OBJECTIVE_RE.test(body)) return null;
  const outcome = normalizedOutcome(body);
  if (!outcome) return null;
  const count = normalizedCount(body);
  const testLabel = normalizedTestLabel(body);
  return { kind: "objective-result", outcome, count, testLabel, terms: structuredTerms({ outcome, count, testLabel }) };
}

export function eventFromTimelineLine(line, offset, authority = "context-only") {
  const source = Buffer.from(line);
  if (source.byteLength > MAX_LINE_BYTES) return null;
  let parsed;
  try { parsed = JSON.parse(line.trim()); } catch { return null; }
  const at = extractTimelineTimestamp(parsed);
  if (!at || unsafeObject(parsed)) return null;
  const candidate = candidateFromToolResult(parsed) || candidateFromToolResult(parsed.message);
  if (!candidate) return null;
  const stable = JSON.stringify({ at, ...candidate });
  return { id: `timeline-event:${digest(`${offset}\0${stable}`).slice(0, 32)}`, at, offset, bytes: source.byteLength,
    sha256: digest(source), ...candidate, authority };
}
