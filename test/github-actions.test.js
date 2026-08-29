import test from "node:test";
import assert from "node:assert/strict";
import { githubErrorCommand } from "../scripts/github-actions.js";

test("GitHub error commands escape workflow data and properties", () => {
  assert.equal(
    githubErrorCommand("empty, attention:test", "line 1\nline 2: 50%"),
    "::error title=empty%2C attention%3Atest::line 1%0Aline 2: 50%25"
  );
});

test("GitHub error commands collapse carriage-return line endings exactly once", () => {
  assert.equal(
    githubErrorCommand("cleanup", "first\r\nsecond\rthird"),
    "::error title=cleanup::first%0D%0Asecond%0Dthird"
  );
});
