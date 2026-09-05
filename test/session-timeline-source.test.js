import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathMatchesSource, sourcePath } from "../src/lib/session-timeline-source.js";

test("post-compaction source validation uses the sealed profile root, never ambient configuration", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "agentspine-timeline-source-"));
  const profile = join(workspace, "profile");
  const foreignProfile = join(workspace, "foreign-profile");
  const transcript = join(profile, "projects", "synthetic", "session.jsonl");
  await Promise.all([
    mkdir(join(profile, "projects", "synthetic"), { recursive: true }),
    mkdir(join(foreignProfile, "projects"), { recursive: true })
  ]);
  await writeFile(transcript, "{\"timestamp\":\"2026-09-04T12:40:00.000Z\"}\n", "utf8");
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = foreignProfile;
  t.after(async () => {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
    await rm(workspace, { recursive: true, force: true, maxRetries: 3 });
  });

  const source = await sourcePath(transcript, profile);
  assert.equal(source.status, "registered");
  assert.equal(await pathMatchesSource(source), true);
  assert.equal(await pathMatchesSource(source, foreignProfile), false);
});
