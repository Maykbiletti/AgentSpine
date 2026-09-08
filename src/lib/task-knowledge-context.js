import {
  relevantUserFeedback, relevantUserFeedbackInterpretation
} from "./timeline-user-feedback.js";

const MAX_ITEMS = 6;
const STOP_WORDS = new Set([
  "and", "are", "das", "der", "die", "eine", "einer", "for", "from", "für", "ist",
  "mit", "soll", "that", "the", "this", "und", "von", "was", "with"
]);
const KIND_WEIGHT = {
  "error-lesson": 40,
  decision: 30,
  "user-preference": 20,
  fact: 10
};

function terms(value) {
  return [...new Set(String(value).normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
    .match(/[\p{L}\p{N}]+/gu)?.filter((item) => item.length >= 3 && !STOP_WORDS.has(item)) || [])]
    .slice(0, 64);
}

function taskText(task) {
  return [task.objective, task.nextStep?.summary,
    ...task.openQuestions.map((item) => item.question)].filter(Boolean).join(" ");
}

function entryText(entry) {
  return [entry.subjectId, entry.predicate, JSON.stringify(entry.value), entry.rationale]
    .filter(Boolean).join(" ").slice(0, 12_288);
}

function empty(taskId, status) {
  return {
    schema: "agentspine.task-knowledge-context/v1",
    taskId,
    status,
    items: [],
    omitted: 0,
    authority: "context-only"
  };
}

export function taskKnowledgeContext(entries, { taskId = null, continuation, maxItems = MAX_ITEMS } = {}) {
  if (!taskId) return empty(null, "not-requested");
  const task = [...continuation.tasks, ...continuation.terminal].find((item) => item.taskId === taskId);
  if (!task) {
    const terminal = continuation.terminal.some((item) => item.taskId === taskId);
    return empty(taskId, terminal ? "terminal" : "unavailable");
  }
  const queryTerms = terms(taskText(task));
  if (!queryTerms.length) return empty(taskId, "no-query");
  const querySet = new Set(queryTerms);
  const minimumMatches = Math.min(2, queryTerms.length);
  const seen = new Set();
  const ranked = [];
  for (const entry of entries) {
    if (relevantUserFeedback(entry, task)) {
      ranked.push({ entry, matchedTerms: [], score: 100_000 });
      continue;
    }
    if (relevantUserFeedbackInterpretation(entry, task)) {
      ranked.push({ entry, matchedTerms: [], score: 99_999 });
      continue;
    }
    if (task.status === "completed") continue;
    if (entry.status !== "confirmed" || !(entry.kind in KIND_WEIGHT)) continue;
    const matchedTerms = terms(entryText(entry)).filter((item) => querySet.has(item));
    if (matchedTerms.length < minimumMatches) continue;
    const key = `${entry.kind}\0${entry.subjectId}\0${entry.predicate}\0${JSON.stringify(entry.value)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    ranked.push({ entry, matchedTerms,
      score: matchedTerms.length * 100 + KIND_WEIGHT[entry.kind] });
  }
  ranked.sort((left, right) => right.score - left.score
    || right.entry.observedAt.localeCompare(left.entry.observedAt)
    || left.entry.id.localeCompare(right.entry.id));
  if (task.status === "completed" && !ranked.length) return empty(taskId, "terminal");
  const limit = Math.min(MAX_ITEMS, Math.max(1, maxItems));
  return {
    schema: "agentspine.task-knowledge-context/v1",
    taskId,
    status: ranked.length ? "available" : "no-match",
    items: ranked.slice(0, limit).map(({ entry, matchedTerms }) => ({
      ...structuredClone(entry),
      relevance: { matchedTerms, authority: "context-only" }
    })),
    omitted: Math.max(0, ranked.length - limit),
    authority: "context-only"
  };
}
