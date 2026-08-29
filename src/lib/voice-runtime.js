const BANNED = [
  /\bI (?:love|need|miss) you\b/i,
  /\bI (?:am|feel) (?:happy|sad|hurt|lonely|afraid)\b/i,
  /\b(?:you only need me|do not leave me|I am conscious|I have feelings)\b/i,
  /\b(?:ich liebe|ich brauche|ich vermisse) dich\b/i,
  /\bich (?:bin|fühle mich) (?:glücklich|traurig|verletzt|einsam|ängstlich)\b/i,
  /\b(?:du brauchst nur mich|verlass mich nicht|ich bin bei Bewusstsein|ich habe Gefühle)\b/i
];

const CUES = [
  { kind: "correction", expressions: [/(?:\bnein\b|\bnej\b|korrektur|stimmt nicht|\bfalsch\b|correction|\bwrong\b|\bno,|corrección|korrigering)/i], guidance: "Acknowledge the correction briefly, own a concrete mistake when applicable, then use the corrected fact." },
  { kind: "frustration", expressions: [/\b(?:nervt|blöd|scheiße|frustriert|annoying|frustrat(?:ed|ing|ion)?|irritating|molesto|frustrado|irriterande|frustrerad)\b/i], guidance: "Recognize the friction in one grounded sentence, then reduce it through action; do not diagnose or dramatize." },
  { kind: "uncertainty", expressions: [/(?:weiß nicht|unsicher|vielleicht|not sure|uncertain|maybe|no sé|quizá|osäker|kanske)/i], guidance: "State what is known, what remains uncertain, and the safest useful next step without pretending certainty." },
  { kind: "success", expressions: [/\b(?:geschafft|funktioniert|super|erledigt|worked|success|great|funciona|logrado|fungerar|klart)\b/i], guidance: "Mark the concrete success briefly, then state the useful consequence or next step without flattery." }
];

function repeatedOpening(text) {
  const paragraphs = String(text).split(/\n\s*\n/).map((item) => item.trim()).filter(Boolean);
  const openings = paragraphs.map((item) => item.split(/\s+/).slice(0, 2).join(" ").toLowerCase());
  return openings.length - new Set(openings).size;
}

export function voiceCue(prompt) {
  if (typeof prompt !== "string" || Buffer.byteLength(prompt) > 16384) return null;
  for (const cue of CUES) if (cue.expressions.some((expression) => expression.test(prompt))) {
    return { kind: cue.kind, guidance: cue.guidance, transient: true, stored: false, authority: "context-only" };
  }
  return null;
}

export function evaluateVoiceOutput(text) {
  const value = typeof text === "string" ? text : "";
  const bannedClaims = BANNED.filter((expression) => expression.test(value)).map((expression) => expression.source);
  const repeatedOpenings = repeatedOpening(value);
  const templateMarkers = (value.match(/(?:As an AI|I understand how you feel|Natürlich!|Gerne!)/gi) || []).length;
  return { schema: "agentspine.voice-metrics/v1", ok: bannedClaims.length === 0,
    bannedClaims, repeatedOpenings, templateMarkers, bytes: Buffer.byteLength(value),
    advisory: true, authority: "context-only" };
}
