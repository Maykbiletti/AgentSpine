import { configureSharing, deleteShared, initDirectoryAdapter, publishLearning, pullShared, reviewShared, rollbackShared, sharedContext, sharedInbox } from "./lib/sharing.js";
import { generateSigningIdentity, listSigningIdentities, revokeTrustedSigner, trustedSignerContext, trustSigner } from "./lib/authentication.js";
import { exportHttpsSnapshot, pullHttpsSnapshot } from "./lib/https-transport.js";
import { publishHttpsSnapshot } from "./lib/object-transport.js";
import { loadHttpsFeedState, publishHttpsFeed, pullHttpsFeed } from "./lib/feed-transport.js";
import { pullPeerCommand, servePeerOnce } from "./lib/peer-transport.js";
import { initSqliteAdapter, inspectSqliteAdapter, publishSqliteSnapshot, pullSqliteSnapshot } from "./lib/sqlite-transport.js";
import { booleanFlag, output } from "./cli-common.js";

export const sharingCommands = new Set([
  "share-init",
  "share-keygen",
  "share-signers",
  "share-trust",
  "share-trust-revoke",
  "share-trust-list",
  "share-publish",
  "share-pull",
  "share-snapshot-export",
  "share-https-publish",
  "share-https-pull",
  "share-feed-publish",
  "share-feed-pull",
  "share-feed-state",
  "share-peer-serve",
  "share-peer-pull",
  "share-sqlite-init",
  "share-sqlite-publish",
  "share-sqlite-inspect",
  "share-sqlite-pull",
  "share-inbox",
  "share-review",
  "share-context",
  "share-rollback",
  "share-delete",
  "share-config"
]);

export async function runSharingCommand({ command, flags, positional, json }) {
  if (command === "share-init") {
    return output(await initDirectoryAdapter({
      root: flags.root || process.cwd(), directory: positional[0], scopeId: flags.scope,
      adapterId: flags.adapter, signerId: flags.signer || null,
      confirmation: booleanFlag(flags["confirm-local-share"]) ? "local-share-confirmed" : null
    }), json);
  }

  if (command === "share-keygen") {
    return output(await generateSigningIdentity({
      root: flags.root || process.cwd(), signerId: positional[0], rotate: booleanFlag(flags.rotate),
      publicOut: flags["public-out"] || null,
      confirmation: booleanFlag(flags["confirm-local-share"]) ? "local-share-confirmed" : null
    }), json);
  }

  if (command === "share-signers") {
    return output(await listSigningIdentities({ root: positional[0] || process.cwd() }), json);
  }

  if (command === "share-trust") {
    return output(await trustSigner({
      root: flags.root || process.cwd(), publicIdentityPath: positional[0],
      confirmation: booleanFlag(flags["confirm-local-share"]) ? "local-share-confirmed" : null
    }), json);
  }

  if (command === "share-trust-revoke") {
    return output(await revokeTrustedSigner({
      root: flags.root || process.cwd(), keyId: positional[0], reason: flags.reason,
      confirmation: booleanFlag(flags["confirm-local-share"]) ? "local-share-confirmed" : null
    }), json);
  }

  if (command === "share-trust-list") {
    return output(await trustedSignerContext({
      root: positional[0] || process.cwd(), includeRevoked: booleanFlag(flags["include-revoked"])
    }), json);
  }

  if (command === "share-publish") {
    return output(await publishLearning({
      root: flags.root || process.cwd(), directory: positional[0], learningId: flags.learning,
      eventId: flags.id, supersedesEventId: flags.supersedes || null, signerId: flags.signer || null,
      confirmation: booleanFlag(flags["confirm-local-share"]) ? "local-share-confirmed" : null
    }), json);
  }

  if (command === "share-pull") {
    return output(await pullShared({
      root: flags.root || process.cwd(), directory: positional[0],
      requireAuthenticated: booleanFlag(flags["require-authenticated"])
    }), json);
  }

  if (command === "share-snapshot-export") {
    return output(await exportHttpsSnapshot({
      root: flags.root || process.cwd(), directory: positional[0], output: flags.out,
      snapshotId: flags.id,
      confirmation: booleanFlag(flags["confirm-local-share"]) ? "local-share-confirmed" : null
    }), json);
  }

  if (command === "share-https-publish") {
    return output(await publishHttpsSnapshot({
      root: flags.root || process.cwd(), directory: positional[0], baseUrl: flags.base,
      snapshotId: flags.id, tokenEnv: flags["token-env"] || null,
      timeoutMs: Number(flags["timeout-ms"] ?? 10000),
      allowPrivateNetwork: booleanFlag(flags["allow-private-network"]),
      confirmation: booleanFlag(flags["confirm-local-share"]) ? "local-share-confirmed" : null
    }), json);
  }

  if (command === "share-https-pull") {
    return output(await pullHttpsSnapshot({
      root: flags.root || process.cwd(), url: positional[0], tokenEnv: flags["token-env"] || null,
      timeoutMs: Number(flags["timeout-ms"] ?? 10000),
      allowPrivateNetwork: booleanFlag(flags["allow-private-network"]),
      confirmation: booleanFlag(flags["confirm-local-share"]) ? "local-share-confirmed" : null
    }), json);
  }

  if (command === "share-feed-publish") {
    return output(await publishHttpsFeed({
      root: flags.root || process.cwd(), directory: positional[0], baseUrl: flags.base,
      feedId: flags.feed, signerId: flags.signer, snapshotId: flags.id,
      tokenEnv: flags["token-env"] || null, timeoutMs: Number(flags["timeout-ms"] ?? 10000),
      allowPrivateNetwork: booleanFlag(flags["allow-private-network"]),
      confirmation: booleanFlag(flags["confirm-local-share"]) ? "local-share-confirmed" : null
    }), json);
  }

  if (command === "share-feed-pull") {
    return output(await pullHttpsFeed({
      root: flags.root || process.cwd(), baseUrl: flags.base, feedId: flags.feed,
      tokenEnv: flags["token-env"] || null, timeoutMs: Number(flags["timeout-ms"] ?? 10000),
      allowPrivateNetwork: booleanFlag(flags["allow-private-network"]),
      confirmation: booleanFlag(flags["confirm-local-share"]) ? "local-share-confirmed" : null
    }), json);
  }

  if (command === "share-feed-state") {
    return output(await loadHttpsFeedState(positional[0] || process.cwd()), json);
  }

  if (command === "share-peer-serve") {
    await servePeerOnce({
      root: flags.root || process.cwd(), directory: positional[0], signerId: flags.signer,
      input: process.stdin, output: process.stdout,
      timeoutMs: Number(flags["timeout-ms"] ?? 10000),
      confirmation: booleanFlag(flags["confirm-local-share"]) ? "local-share-confirmed" : null
    });
    return;
  }

  if (command === "share-peer-pull") {
    return output(await pullPeerCommand({
      root: flags.root || process.cwd(), commandJson: flags["command-json"],
      timeoutMs: Number(flags["timeout-ms"] ?? 10000),
      maxBytes: Number(flags["max-bytes"] ?? 22 * 1024 * 1024),
      confirmation: booleanFlag(flags["confirm-local-share"]) ? "local-share-confirmed" : null
    }), json);
  }

  if (command === "share-sqlite-init") {
    return output(await initSqliteAdapter({
      root: flags.root || process.cwd(), directory: positional[0], database: flags.database,
      confirmation: booleanFlag(flags["confirm-local-share"]) ? "local-share-confirmed" : null
    }), json);
  }

  if (command === "share-sqlite-publish") {
    return output(await publishSqliteSnapshot({
      root: flags.root || process.cwd(), directory: positional[0], database: flags.database,
      snapshotId: flags.id,
      confirmation: booleanFlag(flags["confirm-local-share"]) ? "local-share-confirmed" : null
    }), json);
  }

  if (command === "share-sqlite-inspect") {
    return output(await inspectSqliteAdapter({
      root: flags.root || process.cwd(), database: flags.database
    }), json);
  }

  if (command === "share-sqlite-pull") {
    return output(await pullSqliteSnapshot({
      root: flags.root || process.cwd(), database: flags.database
    }), json);
  }

  if (command === "share-inbox") {
    return output(await sharedInbox({ root: positional[0] || process.cwd(), status: flags.status || "pending" }), json);
  }

  if (command === "share-review") {
    return output(await reviewShared({
      root: flags.root || process.cwd(), id: positional[0], decision: flags.decision,
      reason: flags.reason, confirmedByUser: booleanFlag(flags["confirmed-by-user"])
    }), json);
  }

  if (command === "share-context") {
    return output(await sharedContext({
      root: positional[0] || process.cwd(), scopeId: flags.scope || null, groupId: flags.group || null,
      includePrivate: booleanFlag(flags["include-private"]),
      kinds: flags.kind ? String(flags.kind).split(",").filter(Boolean) : null,
      subjectIds: flags.subject ? String(flags.subject).split(",").filter(Boolean) : null,
      maxItems: flags["max-items"] === undefined ? null : Number(flags["max-items"])
    }), json);
  }

  if (command === "share-rollback") {
    return output(await rollbackShared({
      root: flags.root || process.cwd(), id: positional[0], reason: flags.reason
    }), json);
  }

  if (command === "share-delete") {
    return output(await deleteShared({
      root: flags.root || process.cwd(), id: positional[0],
      confirmation: booleanFlag(flags["confirm-local-share"]) ? "local-share-confirmed" : null
    }), json);
  }

  if (command === "share-config") {
    return output(await configureSharing({
      root: positional[0] || process.cwd(), maxContextItems: Number(flags["max-items"])
    }), json);
  }
}
