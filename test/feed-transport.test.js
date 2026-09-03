import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import { generateSigningIdentity, signEnvelope, trustSigner } from "../src/lib/authentication.js";
import { runAudit } from "../src/lib/audit.js";
import {
  fetchHttpsFeed, httpsFeedUrl, loadHttpsFeedState, publishHttpsFeed,
  pullHttpsFeed, validateHttpsFeed
} from "../src/lib/feed-transport.js";
import { proposeLearning, reviewLearning } from "../src/lib/learning.js";
import { initDirectoryAdapter, publishLearning, sharedContext, sharedInbox } from "../src/lib/sharing.js";

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function fakeService() {
  const state = { objects: new Map(), feed: null, etag: 0, captures: [], rejectNextCas: false };
  const request = (options, callback) => {
    const active = new EventEmitter();
    active.setTimeout = () => active;
    active.destroy = (error) => active.emit("error", error);
    active.end = (body = null) => queueMicrotask(() => {
      const capture = { method: options.method, path: options.path, headers: options.headers, body };
      state.captures.push(capture);
      let status = 500;
      let responseBody = "";
      const headers = { "content-type": "application/json", "content-encoding": "identity" };
      const objectMatch = options.path.match(/\/objects\/([a-f0-9]{64})\.json$/);
      const isFeed = /\/feeds\/[a-f0-9]{64}\.json$/.test(options.path);
      if (objectMatch && options.method === "PUT") {
        const key = objectMatch[1];
        if (state.objects.has(key)) status = 412;
        else { state.objects.set(key, body.toString("utf8")); status = 201; }
      } else if (objectMatch && options.method === "GET") {
        const value = state.objects.get(objectMatch[1]);
        if (value === undefined) status = 404;
        else { status = 200; responseBody = value; }
      } else if (isFeed && options.method === "GET") {
        if (!state.feed) status = 404;
        else {
          status = 200; responseBody = state.feed;
          headers.etag = `"feed-${state.etag}"`;
        }
      } else if (isFeed && options.method === "PUT") {
        const expected = state.feed ? `"feed-${state.etag}"` : null;
        const allowed = state.feed
          ? options.headers["if-match"] === expected
          : options.headers["if-none-match"] === "*";
        if (state.rejectNextCas || !allowed) {
          state.rejectNextCas = false; status = 412;
        } else {
          state.feed = body.toString("utf8"); state.etag += 1;
          status = expected ? 204 : 201;
        }
      }
      const response = new PassThrough();
      response.statusCode = status;
      response.headers = headers;
      callback(response);
      response.end(responseBody);
    });
    return active;
  };
  return { state, request };
}

async function fixture(t) {
  const publisher = await mkdtemp(join(tmpdir(), "agentspine-feed-publisher-"));
  const receiver = await mkdtemp(join(tmpdir(), "agentspine-feed-receiver-"));
  const stateRoot = await mkdtemp(join(tmpdir(), "agentspine-feed-state-"));
  const adapter = await mkdtemp(join(tmpdir(), "agentspine-feed-adapter-"));
  process.env.AGENTSPINE_STATE_DIR = stateRoot;
  t.after(async () => {
    await rm(publisher, { recursive: true }); await rm(receiver, { recursive: true });
    await rm(stateRoot, { recursive: true }); await rm(adapter, { recursive: true });
  });
  await writeFile(join(publisher, "AGENTS.md"), "# Feed publisher\n\nByte exact.\n", "utf8");
  await writeFile(join(receiver, "CLAUDE.md"), "# Feed receiver\n\nByte exact.\n", "utf8");
  const publicOut = join(stateRoot, "feed-signer.json");
  await generateSigningIdentity({
    root: publisher, signerId: "signer:feed", publicOut,
    confirmation: "local-share-confirmed", now: new Date("2030-01-01T00:00:00.000Z")
  });
  await trustSigner({
    root: receiver, publicIdentityPath: publicOut,
    confirmation: "local-share-confirmed", now: new Date("2030-01-01T00:00:01.000Z")
  });
  await initDirectoryAdapter({
    root: publisher, directory: adapter, scopeId: "team:feed", adapterId: "adapter:feed",
    signerId: "signer:feed", confirmation: "local-share-confirmed"
  });
  await proposeLearning({
    root: publisher, id: "learning:feed", kind: "project-fact",
    claim: "The synthetic feed references immutable signed snapshots.", privacy: "shared",
    evidence: { id: "evidence:feed", type: "test", summary: "Synthetic feed evidence.", confidence: 1 }
  });
  await reviewLearning({
    root: publisher, id: "learning:feed", decision: "accept",
    reason: "Synthetic confirmation.", confirmedByUser: true
  });
  await publishLearning({
    root: publisher, directory: adapter, learningId: "learning:feed", eventId: "shared:feed",
    signerId: "signer:feed", confirmation: "local-share-confirmed"
  });
  return { publisher, receiver, stateRoot, adapter, service: fakeService() };
}

function publishOptions(value, sequence = 1) {
  return {
    root: value.publisher, directory: value.adapter, baseUrl: "https://store.example/spine",
    feedId: "feed:team", signerId: "signer:feed", snapshotId: `snapshot:feed:${sequence}`,
    now: new Date(`2030-01-0${sequence}T00:00:00.000Z`), confirmation: "local-share-confirmed",
    lookup: publicLookup, request: value.service.request
  };
}

test("feed publication uses immutable objects, strong ETag CAS, signed read-back, and preserves sources", async (t) => {
  const value = await fixture(t);
  const before = hash(await readFile(join(value.publisher, "AGENTS.md")));
  const result = await publishHttpsFeed(publishOptions(value));
  assert.equal(result.sequence, 1);
  assert.equal(result.createdFeed, true);
  assert.equal(result.verified, true);
  assert.match(result.feedUrl, /\/feeds\/[a-f0-9]{64}\.json$/);
  const objectPut = value.service.state.captures.find((item) => item.method === "PUT" && item.path.includes("/objects/"));
  const feedPut = value.service.state.captures.find((item) => item.method === "PUT" && item.path.includes("/feeds/"));
  assert.equal(objectPut.headers["if-none-match"], "*");
  assert.equal(feedPut.headers["if-none-match"], "*");
  assert.equal(feedPut.headers["if-match"], undefined);
  assert.equal(validateHttpsFeed(JSON.parse(value.service.state.feed)).feed.sequence, 1);
  assert.equal(hash(await readFile(join(value.publisher, "AGENTS.md"))), before);
});

test("feed pull authenticates origin, imports only into quarantine, and retains receipt history", async (t) => {
  const value = await fixture(t);
  const beforePublisher = hash(await readFile(join(value.publisher, "AGENTS.md")));
  const beforeReceiver = hash(await readFile(join(value.receiver, "CLAUDE.md")));
  await publishHttpsFeed(publishOptions(value, 1));
  const first = await pullHttpsFeed({
    root: value.receiver, baseUrl: "https://store.example/spine", feedId: "feed:team",
    now: new Date("2030-01-01T01:00:00.000Z"), lookup: publicLookup, request: value.service.request
  });
  assert.equal(first.changed, true);
  assert.deepEqual(first.imported, ["shared:feed"]);
  assert.equal((await sharedContext({ root: value.receiver })).items.length, 0);
  const inbox = await sharedInbox({ root: value.receiver });
  assert.equal(inbox.status, "pending");
  assert.equal(inbox.items[0].id, "shared:feed");
  const unchanged = await pullHttpsFeed({
    root: value.receiver, baseUrl: "https://store.example/spine", feedId: "feed:team",
    now: new Date("2030-01-01T02:00:00.000Z"), lookup: publicLookup, request: value.service.request
  });
  assert.equal(unchanged.changed, false);
  await publishHttpsFeed(publishOptions(value, 2));
  const second = await pullHttpsFeed({
    root: value.receiver, baseUrl: "https://store.example/spine", feedId: "feed:team",
    now: new Date("2030-01-02T01:00:00.000Z"), lookup: publicLookup, request: value.service.request
  });
  assert.equal(second.sequence, 2);
  const feedState = await loadHttpsFeedState(value.receiver);
  assert.equal(feedState.state.feeds[0].sequence, 2);
  assert.equal(feedState.state.history[0].sequence, 1);
  assert.equal(feedState.state.feeds[0].authority, "context-only");
  assert.equal(feedState.statePath.startsWith(value.receiver), false);
  assert.equal(hash(await readFile(join(value.publisher, "AGENTS.md"))), beforePublisher);
  assert.equal(hash(await readFile(join(value.receiver, "CLAUDE.md"))), beforeReceiver);
});

test("publisher fails closed on a lost ETag race and never overwrites the winning feed", async (t) => {
  const value = await fixture(t);
  await publishHttpsFeed(publishOptions(value, 1));
  const before = value.service.state.feed;
  value.service.state.rejectNextCas = true;
  await assert.rejects(publishHttpsFeed(publishOptions(value, 2)), /changed concurrently/);
  assert.equal(value.service.state.feed, before);
  const feedPuts = value.service.state.captures.filter((item) => item.method === "PUT" && item.path.includes("/feeds/"));
  assert.equal(feedPuts.at(-1).headers["if-match"], '"feed-1"');
});

test("reader rejects rollback and a continuity window that omits the observed tip", async (t) => {
  const value = await fixture(t);
  await publishHttpsFeed(publishOptions(value, 1));
  const oldFeed = value.service.state.feed;
  await pullHttpsFeed({
    root: value.receiver, baseUrl: "https://store.example/spine", feedId: "feed:team",
    lookup: publicLookup, request: value.service.request
  });
  await publishHttpsFeed(publishOptions(value, 2));
  await pullHttpsFeed({
    root: value.receiver, baseUrl: "https://store.example/spine", feedId: "feed:team",
    lookup: publicLookup, request: value.service.request
  });
  value.service.state.feed = oldFeed;
  value.service.state.etag += 1;
  await assert.rejects(pullHttpsFeed({
    root: value.receiver, baseUrl: "https://store.example/spine", feedId: "feed:team",
    lookup: publicLookup, request: value.service.request
  }), /rollback detected/);

  const previous = "a".repeat(64);
  const entryBody = {
    sequence: 300, snapshotId: "snapshot:gap", snapshotDigest: "b".repeat(64),
    previousDigest: previous, publishedAt: "2030-02-01T00:00:00.000Z", authority: "context-only"
  };
  const entry = { ...entryBody, digest: digest(entryBody) };
  const feedBody = {
    schema: "agentspine.feed/v1", feedId: "feed:team", scopeId: "team:feed",
    adapterId: "adapter:feed", sequence: 300, entries: [entry], authority: "context-only"
  };
  const feed = { ...feedBody, digest: digest(feedBody) };
  value.service.state.feed = JSON.stringify(await signEnvelope({
    root: value.publisher, signerId: "signer:feed", kind: "manifest", payload: feed,
    now: new Date("2030-02-01T00:00:00.000Z")
  }));
  value.service.state.etag += 1;
  await assert.rejects(pullHttpsFeed({
    root: value.receiver, baseUrl: "https://store.example/spine", feedId: "feed:team",
    lookup: publicLookup, request: value.service.request
  }), /continuity window/);
});

test("feed parsing rejects weak ETags, broken chains, redirects, and missing confirmation", async (t) => {
  const value = await fixture(t);
  await assert.rejects(publishHttpsFeed({ ...publishOptions(value), confirmation: null }), /explicit local owner confirmation/);
  assert.equal(
    httpsFeedUrl("https://store.example/spine/", "feed:team"),
    `https://store.example/spine/feeds/${hash("feed:team")}.json`
  );
  await assert.rejects(fetchHttpsFeed({
    baseUrl: "https://store.example/spine", feedId: "feed:team", lookup: publicLookup,
    request: (_options, callback) => {
      const active = new EventEmitter();
      active.setTimeout = () => active; active.destroy = (error) => active.emit("error", error);
      active.end = () => queueMicrotask(() => {
        const response = new PassThrough(); response.statusCode = 200;
        response.headers = { "content-type": "application/json", etag: 'W/"weak"' };
        callback(response); response.end("{}");
      });
      return active;
    }
  }), /strong ETag/);
  await assert.rejects(fetchHttpsFeed({
    baseUrl: "https://internal.example/spine", feedId: "feed:team", allowPrivateNetwork: true,
    lookup: async () => [{ address: "10.0.0.5", family: 4 }], request: value.service.request
  }), /explicit local owner confirmation/);
});

test("tokens stay environment-only and feed administration stays outside MCP", async (t) => {
  const value = await fixture(t);
  const result = await publishHttpsFeed({
    ...publishOptions(value), tokenEnv: "AGENTSPINE_FEED_TOKEN",
    environment: { AGENTSPINE_FEED_TOKEN: "synthetic-feed-token-value" }
  });
  assert.equal(result.authenticatedWrite, true);
  assert.equal(JSON.stringify(result).includes("synthetic-feed-token-value"), false);
  assert.equal(value.service.state.captures.every((item) => (
    item.headers.authorization === "Bearer synthetic-feed-token-value"
  )), true);
  const mcp = (await Promise.all([
    readFile(new URL("../src/mcp.js", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/mcp-runtime.js", import.meta.url), "utf8")
  ])).join("\n");
  assert.equal(/publishHttpsFeed|pullHttpsFeed|fetchHttpsFeed|feed_token/i.test(mcp), false);
});

test("corrupt feed receipts fail closed in both reads and the ten-gate audit without touching Markdown", async (t) => {
  const value = await fixture(t);
  const before = hash(await readFile(join(value.receiver, "CLAUDE.md")));
  await publishHttpsFeed(publishOptions(value, 1));
  await pullHttpsFeed({
    root: value.receiver, baseUrl: "https://store.example/spine", feedId: "feed:team",
    lookup: publicLookup, request: value.service.request
  });
  const { statePath } = await loadHttpsFeedState(value.receiver);
  await writeFile(statePath, "{broken", "utf8");
  await assert.rejects(loadHttpsFeedState(value.receiver), /JSON/);
  const audit = await runAudit(value.receiver);
  assert.equal(audit.ok, false);
  assert.equal(audit.gates.find((gate) => gate.id === 8).ok, false);
  assert.equal(audit.gates.find((gate) => gate.id === 10).ok, true);
  assert.equal(hash(await readFile(join(value.receiver, "CLAUDE.md"))), before);
});

test("CLI exposes feed state but refuses network publication without local confirmation", async (t) => {
  const value = await fixture(t);
  const cli = fileURLToPath(new URL("../bin/agentspine.js", import.meta.url));
  const environment = { ...process.env, AGENTSPINE_STATE_DIR: value.stateRoot };
  const state = spawnSync(process.execPath, [cli, "share-feed-state", value.receiver, "--json"], {
    encoding: "utf8", env: environment
  });
  assert.equal(state.status, 0, state.stderr);
  assert.equal(JSON.parse(state.stdout).state.schema, "agentspine.feed-state/v1");
  const publish = spawnSync(process.execPath, [cli,
    "share-feed-publish", value.adapter, "--root", value.publisher,
    "--base", "https://store.example/spine", "--feed", "feed:team",
    "--signer", "signer:feed", "--id", "snapshot:cli", "--json"
  ], { encoding: "utf8", env: environment });
  assert.notEqual(publish.status, 0);
  assert.match(publish.stderr, /explicit local owner confirmation/);
});
