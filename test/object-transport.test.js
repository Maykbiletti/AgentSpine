import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateSigningIdentity } from "../src/lib/authentication.js";
import { buildHttpsSnapshot } from "../src/lib/https-transport.js";
import { proposeLearning, reviewLearning } from "../src/lib/learning.js";
import {
  httpsObjectUrl, publishHttpsSnapshot, putHttpsSnapshot, validateHttpsObjectBase
} from "../src/lib/object-transport.js";
import { initDirectoryAdapter, publishLearning } from "../src/lib/sharing.js";

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];

function sha(value) {
  return createHash("sha256").update(value).digest("hex");
}

function fakeSequence(steps, captures = []) {
  return (options, callback) => {
    const step = steps.shift();
    if (!step) throw new Error("unexpected HTTPS request");
    const capture = { options, body: null };
    captures.push(capture);
    const active = new EventEmitter();
    active.setTimeout = () => active;
    active.destroy = (error) => active.emit("error", error);
    active.end = (body) => {
      capture.body = body ?? null;
      queueMicrotask(() => {
        const response = new PassThrough();
        response.statusCode = step.status ?? 200;
        response.headers = step.headers ?? { "content-type": "application/json" };
        callback(response);
        response.end(step.body ?? "");
      });
    };
    return active;
  };
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "agentspine-object-root-"));
  const state = await mkdtemp(join(tmpdir(), "agentspine-object-state-"));
  const adapter = await mkdtemp(join(tmpdir(), "agentspine-object-adapter-"));
  process.env.AGENTSPINE_STATE_DIR = state;
  t.after(async () => {
    await rm(root, { recursive: true });
    await rm(state, { recursive: true });
    await rm(adapter, { recursive: true });
  });
  await writeFile(join(root, "AGENTS.md"), "# Object publisher\n\nPreserve this exactly.\n", "utf8");
  await generateSigningIdentity({
    root, signerId: "signer:object", confirmation: "local-share-confirmed"
  });
  await initDirectoryAdapter({
    root, directory: adapter, scopeId: "team:object", adapterId: "adapter:object",
    signerId: "signer:object", confirmation: "local-share-confirmed"
  });
  await proposeLearning({
    root, id: "learning:object", kind: "project-fact",
    claim: "The synthetic object is immutable and content addressed.", privacy: "shared",
    evidence: { id: "evidence:object", type: "test", summary: "Synthetic object evidence.", confidence: 1 }
  });
  await reviewLearning({
    root, id: "learning:object", decision: "accept",
    reason: "Synthetic confirmation.", confirmedByUser: true
  });
  await publishLearning({
    root, directory: adapter, learningId: "learning:object", eventId: "shared:object",
    signerId: "signer:object", confirmation: "local-share-confirmed"
  });
  const snapshot = await buildHttpsSnapshot({
    root, directory: adapter, snapshotId: "snapshot:object",
    now: new Date("2030-01-01T00:00:00.000Z")
  });
  return { root, state, adapter, snapshot };
}

test("object URLs are HTTPS-only, credential-free, unambiguous, and content addressed", () => {
  assert.throws(() => validateHttpsObjectBase("http://store.example/spine"), /https:\/\//);
  assert.throws(() => validateHttpsObjectBase("https://user:pass@store.example/spine"), /embedded/);
  assert.throws(() => validateHttpsObjectBase("https://store.example/spine?token=x"), /query or fragment/);
  assert.throws(() => validateHttpsObjectBase("https://store.example/a%2Fb"), /ambiguous/);
  const digest = "a".repeat(64);
  assert.equal(
    httpsObjectUrl("https://store.example/team/", digest),
    `https://store.example/team/objects/${digest}.json`
  );
});

test("publish uses create-only PUT, pinned DNS, exact bytes, and verified read-back", async (t) => {
  const { root, adapter, snapshot } = await fixture(t);
  const before = sha(await readFile(join(root, "AGENTS.md")));
  const captures = [];
  const request = fakeSequence([
    { status: 201 },
    { status: 200, body: JSON.stringify(snapshot) }
  ], captures);
  const result = await publishHttpsSnapshot({
    root, directory: adapter, baseUrl: "https://store.example/spine",
    snapshotId: "snapshot:object", now: new Date("2030-01-01T00:00:00.000Z"),
    tokenEnv: "AGENTSPINE_OBJECT_TOKEN",
    environment: { AGENTSPINE_OBJECT_TOKEN: "synthetic-object-token-value" },
    confirmation: "local-share-confirmed", lookup: publicLookup, request
  });
  assert.equal(result.created, true);
  assert.equal(result.verified, true);
  assert.equal(result.authenticatedWrite, true);
  assert.equal(result.objectUrl, httpsObjectUrl("https://store.example/spine", snapshot.digest));
  assert.equal(captures[0].options.method, "PUT");
  assert.equal(captures[0].options.headers["if-none-match"], "*");
  assert.equal(captures[0].options.headers.authorization, "Bearer synthetic-object-token-value");
  assert.equal(captures[0].options.headers["x-agentspine-digest"], `sha256:${snapshot.digest}`);
  assert.equal(Number(captures[0].options.headers["content-length"]), captures[0].body.length);
  assert.deepEqual(JSON.parse(captures[0].body.toString("utf8")), snapshot);
  assert.equal(captures[1].options.method, "GET");
  assert.equal(JSON.stringify(result).includes("synthetic-object-token-value"), false);
  assert.equal(sha(await readFile(join(root, "AGENTS.md"))), before);
});

test("precondition failure is idempotent only when read-back matches exactly", async (t) => {
  const { snapshot } = await fixture(t);
  const result = await putHttpsSnapshot({
    baseUrl: "https://store.example/spine", snapshot,
    confirmation: "local-share-confirmed", lookup: publicLookup,
    request: fakeSequence([
      { status: 412 },
      { status: 200, body: JSON.stringify(snapshot) }
    ])
  });
  assert.equal(result.created, false);
  assert.equal(result.alreadyExisted, true);
  assert.equal(result.verified, true);
});

test("mismatched read-back fails even after a successful upload", async (t) => {
  const { root, adapter, snapshot } = await fixture(t);
  const other = await buildHttpsSnapshot({
    root, directory: adapter, snapshotId: "snapshot:other",
    now: new Date("2030-01-01T00:00:01.000Z")
  });
  await assert.rejects(putHttpsSnapshot({
    baseUrl: "https://store.example/spine", snapshot,
    confirmation: "local-share-confirmed", lookup: publicLookup,
    request: fakeSequence([
      { status: 201 },
      { status: 200, body: JSON.stringify(other) }
    ])
  }), /read-back does not match/);
});

test("every remote write requires local confirmation and private networks remain explicit", async (t) => {
  const { snapshot } = await fixture(t);
  await assert.rejects(putHttpsSnapshot({
    baseUrl: "https://store.example/spine", snapshot,
    lookup: publicLookup, request: fakeSequence([])
  }), /explicit local owner confirmation/);
  await assert.rejects(putHttpsSnapshot({
    baseUrl: "https://internal.example/spine", snapshot,
    confirmation: "local-share-confirmed",
    lookup: async () => [{ address: "10.0.0.8", family: 4 }], request: fakeSequence([])
  }), /private, local, reserved/);
  const result = await putHttpsSnapshot({
    baseUrl: "https://internal.example/spine", snapshot,
    allowPrivateNetwork: true, confirmation: "local-share-confirmed",
    lookup: async () => [{ address: "10.0.0.8", family: 4 }],
    request: fakeSequence([
      { status: 204 },
      { status: 200, body: JSON.stringify(snapshot) }
    ])
  });
  assert.equal(result.verified, true);
});

test("publish rejects redirects, overwrite-like success codes, oversized responses, and bad tokens", async (t) => {
  const { snapshot } = await fixture(t);
  const base = {
    baseUrl: "https://store.example/spine", snapshot,
    confirmation: "local-share-confirmed", lookup: publicLookup
  };
  await assert.rejects(putHttpsSnapshot({
    ...base, request: fakeSequence([{ status: 302, headers: { location: "https://other.example/x" } }])
  }), /redirects are not followed/);
  await assert.rejects(putHttpsSnapshot({
    ...base, request: fakeSequence([{ status: 200 }])
  }), /status 200/);
  await assert.rejects(putHttpsSnapshot({
    ...base, request: fakeSequence([{ status: 201, body: "x".repeat(16 * 1024 + 1) }])
  }), /16 KiB/);
  await assert.rejects(putHttpsSnapshot({
    ...base, tokenEnv: "lowercase", environment: {}, request: fakeSequence([])
  }), /uppercase environment variable/);
  await assert.rejects(putHttpsSnapshot({ ...base, timeoutMs: 50, request: fakeSequence([]) }), /between 1000 and 30000/);
});

test("CLI exposes publishing but rejects it before network access without confirmation", async (t) => {
  const { root, state, adapter } = await fixture(t);
  const cli = fileURLToPath(new URL("../bin/agentspine.js", import.meta.url));
  const result = spawnSync(process.execPath, [cli,
    "share-https-publish", adapter, "--root", root,
    "--base", "https://store.example/spine", "--id", "snapshot:cli", "--json"
  ], { encoding: "utf8", env: { ...process.env, AGENTSPINE_STATE_DIR: state } });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /explicit local owner confirmation/);
});
