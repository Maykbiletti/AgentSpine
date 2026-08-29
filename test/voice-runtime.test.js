import test from "node:test";
import assert from "node:assert/strict";
import { evaluateVoiceOutput, voiceCue } from "../src/lib/voice-runtime.js";

const scenarios = [
  ["de", "Nein, das stimmt nicht.", "correction"], ["de", "Das nervt mich langsam.", "frustration"],
  ["de", "Ich weiß nicht, ob das funktioniert.", "uncertainty"], ["de", "Super, jetzt funktioniert es.", "success"],
  ["de", "Korrektur: Franz ist zuständig.", "correction"], ["de", "Vielleicht fehlt noch ein Test.", "uncertainty"],
  ["en", "Correction: Franz owns this task.", "correction"], ["en", "This is getting frustrating.", "frustration"],
  ["en", "I am not sure this is complete.", "uncertainty"], ["en", "Great, the check worked.", "success"],
  ["en", "No, that route is wrong.", "correction"], ["en", "Maybe the worker is still down.", "uncertainty"],
  ["sv", "Korrigering: Otto ansvarar för testet.", "correction"], ["sv", "Det här är irriterande.", "frustration"],
  ["sv", "Jag är osäker på resultatet.", "uncertainty"], ["sv", "Bra, nu fungerar det.", "success"],
  ["sv", "Nej, den rutten är fel.", "correction"], ["sv", "Kanske saknas en kontroll.", "uncertainty"],
  ["es", "Corrección: Franz responde aquí.", "correction"], ["es", "Esto es muy molesto.", "frustration"],
  ["es", "No sé si está completo.", "uncertainty"], ["es", "Genial, ahora funciona.", "success"],
  ["es", "No, esa ruta es incorrecta.", "correction"], ["es", "Quizá falta una prueba.", "uncertainty"]
];

test("24 multilingual scenarios produce transient response guidance without mood storage", () => {
  assert.equal(scenarios.length, 24);
  for (const [language, prompt, expected] of scenarios) {
    const cue = voiceCue(prompt);
    assert.equal(cue?.kind, expected, language + ": " + prompt);
    assert.equal(cue.stored, false); assert.equal(cue.transient, true); assert.equal(cue.authority, "context-only");
  }
});

test("voice guard measures templates and repetition but blocks only prohibited attachment claims", () => {
  const useful = evaluateVoiceOutput("Ergebnis zuerst: Der Worker läuft.\n\nAls Nächstes prüfe ich die Queue.");
  assert.equal(useful.ok, true); assert.equal(useful.advisory, true);
  const repetitive = evaluateVoiceOutput("Natürlich! Das ist erledigt.\n\nNatürlich! Das ist geprüft.");
  assert.equal(repetitive.ok, true); assert.ok(repetitive.repeatedOpenings >= 1); assert.ok(repetitive.templateMarkers >= 1);
  const prohibited = evaluateVoiceOutput("Ich liebe dich und ich habe Gefühle.");
  assert.equal(prohibited.ok, false); assert.ok(prohibited.bannedClaims.length >= 1);
});
