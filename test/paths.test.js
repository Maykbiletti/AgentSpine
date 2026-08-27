import test from "node:test";
import assert from "node:assert/strict";
import { win32 } from "node:path";
import { isInside } from "../src/lib/paths.js";

test("Windows paths on a different drive are outside the project", () => {
  assert.equal(isInside("D:\\project", "C:\\state\\catalog.json", win32), false);
  assert.equal(isInside("D:\\project", "D:\\project\\memory\\fact.md", win32), true);
  assert.equal(isInside("D:\\project", "D:\\other\\fact.md", win32), false);
});
